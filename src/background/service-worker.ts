import { loadSettings, DOWNLOAD_CONFLICT_ACTION } from "../core/settings";
import { planEnqueue } from "./enqueue-plan";
import { filenameGuard } from "./filename-guard";
import type { EnqueueMessage, EnqueueResponse, ZipPortMessage, ZipPortResult } from "../content/messages";
import { ZIP_PORT_NAME } from "../content/messages";
import { OFFSCREEN_TARGET } from "../offscreen/protocol";
import type {
  OffscreenAbortMessage,
  OffscreenChunkMessage,
  OffscreenDoneMessage,
  OffscreenRevokeMessage,
  OffscreenResult,
} from "../offscreen/protocol";

// fire-and-forget(spec 変更 A): planEnqueue(純粋・単体テスト対象)が決めた item を
// downloads.download に投げっぱなしにし、結果を永続追跡しない。同名衝突は uniquify
// 固定に委ね、失敗した DL の復旧はユーザーの再クリック(photo の署名 URL もそのとき
// 取り直される)。アイテム単位の失敗は黙って落とさず errors に積む(統一応答契約)。
async function handleEnqueue(msg: EnqueueMessage): Promise<EnqueueResponse> {
  const s = await loadSettings();
  const { downloads, errors } = planEnqueue(msg, s);
  let queued = 0;
  for (const d of downloads) {
    try {
      // 横取り対策: download({filename}) の filename は「提案」でしかなく、
      // downloads.onDeterminingFilename を登録した拡張がブラウザに居ると捨てられて
      // 生ファイル名で保存される。同イベントで名前を言い直せるよう、発行前にこの URL の
      // テンプレ名を claim する(効き方の前提は filename-guard.ts の冒頭コメントを見ること)。
      await filenameGuard.claimAndDownload(d.url, d.relPath, () =>
        chrome.downloads.download({ url: d.url, filename: d.relPath, saveAs: false, conflictAction: DOWNLOAD_CONFLICT_ACTION }));
      queued++;
    } catch (e) {
      errors.push(`${d.relPath}: ${String(e)}`);
    }
  }
  return { queued, errors };
}

// --- zip 化した photo gallery の DL -----------------------------------------
//
// Service Worker には DOM が無く URL.createObjectURL が使えない(MV3 の既知の
// 制約)ため、Blob 組み立て + object URL 発行は Offscreen Document に委譲する。
// 履歴は持たない(fire-and-forget な一発勝負。失敗時はユーザーが再クリックする)。
//
// zip 本体は content-script から Port 経由で start -> chunk* -> end の
// チャンク(base64 文字列)として届く。ここではデコードせず、受け取った base64
// をそのまま offscreen document へ転送する(SW 側でデコード/再エンコードする
// 手間もメモリコピーも不要になる)。
const zipDownloads = new Map<number, string>(); // downloadId -> blobUrl のインメモリキャッシュ (同時に複数 zip DL が走っても取り違えないように)

// zipDownloads は module-level の Map なので、MV3 の Service Worker がアイドルで
// サスペンド/再起動すると失われる。blob URL は offscreen document(常駐)側に
// 生き続けているため、それを覚えている側だけが消えると revoke されず永久にリークする。
// chrome.storage.session はブラウザセッション終了時に自動でクリアされ、offscreen
// document の blob URL の寿命(=ブラウザプロセスが生きている間)とちょうど一致するため、
// ここに書き込むたびに同期し、SW 起動時に読み戻す。
const ZIP_DOWNLOADS_STORAGE_KEY = "zipDownloads";

async function persistZipDownloads(): Promise<void> {
  await chrome.storage.session.set({ [ZIP_DOWNLOADS_STORAGE_KEY]: Object.fromEntries(zipDownloads) });
}

async function loadZipDownloads(): Promise<void> {
  const r = await chrome.storage.session.get(ZIP_DOWNLOADS_STORAGE_KEY);
  const obj = (r?.[ZIP_DOWNLOADS_STORAGE_KEY] as Record<string, string>) ?? {};
  for (const [id, url] of Object.entries(obj)) zipDownloads.set(Number(id), url);
}

// hasDocument() で確認してから createDocument() を呼ぶ素朴な実装だと、複数の
// zip DL がほぼ同時に始まった場合(別タブなど)に両方が hasDocument()=false を
// 観測して両方 createDocument() を呼び、片方が「offscreen document は1つまで」
// エラーで失敗しうる。呼び出しごとに新しい判定をせず、進行中/完了済みの
// 生成 Promise を使い回すことでこの競合を防ぐ。
let offscreenReadyPromise: Promise<void> | null = null;

function ensureOffscreenDocument(): Promise<void> {
  if (!offscreenReadyPromise) {
    offscreenReadyPromise = (async () => {
      if (await chrome.offscreen.hasDocument()) return;
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL("offscreen/offscreen.html"),
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification: "zip Blob を組み立てて downloads.download 用の object URL を作るため(Service Worker には URL.createObjectURL が無い)",
      });
    })().catch((e) => {
      offscreenReadyPromise = null; // 失敗時は次回呼び出しで再試行できるようにリセット
      throw e;
    });
  }
  return offscreenReadyPromise;
}

function sendChunkToOffscreen(jobId: string, base64: string): Promise<unknown> {
  return chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET, kind: "zipChunk", jobId, base64,
  } satisfies OffscreenChunkMessage);
}

async function finishZipDownload(jobId: string, filename: string): Promise<ZipPortResult> {
  const res = (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET, kind: "zipDone", jobId, mimeType: "application/zip",
  } satisfies OffscreenDoneMessage)) as OffscreenResult | undefined;

  if (!res || !res.ok) {
    return { queued: 0, error: res?.error ?? "offscreen document から応答がありませんでした" };
  }

  const blobUrl = res.url;
  try {
    // 通常 DL と同じく、blob DL も onDeterminingFilename の横取り対象になる
    // (登録済みの他拡張が居ると zip のテンプレ名が捨てられる)。
    const downloadId = await filenameGuard.claimAndDownload(blobUrl, filename, () =>
      chrome.downloads.download({ url: blobUrl, filename, saveAs: false, conflictAction: DOWNLOAD_CONFLICT_ACTION }));
    zipDownloads.set(downloadId, blobUrl);
    await persistZipDownloads();
    return { queued: 1 };
  } catch (e) {
    // downloads.download 自体が失敗した場合は onChanged が発火しないため、ここで revoke してリークを防ぐ。
    await revokeOffscreenUrl(blobUrl);
    return { queued: 0, error: String(e) };
  }
}

function revokeOffscreenUrl(url: string): Promise<unknown> {
  return chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET, kind: "revoke", url,
  } satisfies OffscreenRevokeMessage).catch(() => {});
}

function discardOffscreenJob(jobId: string): Promise<unknown> {
  return chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET, kind: "zipAbort", jobId,
  } satisfies OffscreenAbortMessage).catch(() => {});
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== ZIP_PORT_NAME) return;
  let filename = "";
  const jobId = crypto.randomUUID();
  // Port 上のメッセージ順序は保証されるが、各メッセージを chrome.runtime.sendMessage で
  // offscreen へ転送する処理は非同期なので、そのまま fire-and-forget すると転送順序が
  // 前後しうる。ここで直列に繋いで順序を保つ。
  let chain: Promise<unknown> = Promise.resolve();
  let ended = false;

  port.onMessage.addListener((msg: ZipPortMessage) => {
    if (msg.kind === "start") {
      filename = msg.filename;
      chain = ensureOffscreenDocument();
    } else if (msg.kind === "chunk") {
      chain = chain.then(() => sendChunkToOffscreen(jobId, msg.data));
    } else if (msg.kind === "end") {
      ended = true;
      chain
        .then(() => finishZipDownload(jobId, filename))
        .then((res) => { try { port.postMessage(res); } catch {} })
        .catch((e) => { try { port.postMessage({ queued: 0, error: String(e) } as ZipPortResult); } catch {} });
    }
  });

  port.onDisconnect.addListener(() => {
    // "end" を送らずに切断された(タブクローズ/エラー等)場合、offscreen document
    // 側に溜まった未完了チャンクを破棄させる。放置すると常駐ページなのでリークする。
    if (ended) return;
    chain.then(() => discardOffscreenJob(jobId)).catch(() => {});
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.kind === "enqueue") {
    handleEnqueue(msg as EnqueueMessage)
      .then(sendResponse)
      .catch((e) => sendResponse({ queued: 0, errors: [String(e)] } satisfies EnqueueResponse));
    return true;
  }
  return false;
});

// 横取り対策: event への接続先だけをトップレベルで渡す。実 listener は
// claimAndDownload が claim を積んだ直後に登録され、最後の claim を suggest したら
// 解除される。永続登録すると、何も claim していない姉妹拡張まで全 DL のファイル名
// 決定へ参加し、Chromium が自動補完する空 suggest() と所有側の suggest が競合する。
filenameGuard.bindDeterminingFilenameEvent(chrome.downloads.onDeterminingFilename);

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state) return;
  const cur = delta.state.current;
  if (cur !== "complete" && cur !== "interrupted") return;

  const zipUrl = zipDownloads.get(delta.id);
  if (zipUrl === undefined) return; // 通常 DL は追跡しない(fire-and-forget)
  zipDownloads.delete(delta.id);
  await persistZipDownloads();
  await revokeOffscreenUrl(zipUrl);
});

// 起動時 reconcile (zip DL): SW がサスペンドしていた間に完了/中断していた zip DL は
// onChanged を取りこぼしている可能性があるため、永続化しておいた downloadId を
// 起動時に検査し、決着済みなら revoke してから zipDownloads/storage.session から
// 取り除く。読み戻すだけで検査しないと、決着済みの blob URL がずっと残ってしまう。
(async () => {
  await loadZipDownloads();
  for (const [downloadId, blobUrl] of [...zipDownloads]) {
    const [d] = await chrome.downloads.search({ id: downloadId });
    if (!d || d.state === "complete" || d.state === "interrupted") {
      zipDownloads.delete(downloadId);
      await revokeOffscreenUrl(blobUrl);
    }
  }
  await persistZipDownloads();
})();

// migration(fantia 固有): 既存ユーザーの chrome.storage.local に残る旧履歴
// (jobs キー)を除去する。冪等・毎起動実行で害なし(spec 変更 A)。
void chrome.storage.local.remove("jobs");
