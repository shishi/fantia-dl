import { loadSettings } from "../core/settings";
import { renderTemplate, TemplateError } from "../core/template-engine";
import { validatePath } from "../core/path-validator";
import type { RenderContext, Settings } from "../core/types";
import type { EnqueueMessage, EnqueueItem, PostMeta, ZipPortMessage, ZipPortResult } from "../content/messages";
import { ZIP_PORT_NAME } from "../content/messages";
import { getAllJobs, putJobs, updateJob, findByDownloadId, removeJobsByPostId, sweepOldDoneJobs, clearAllJobs, type JobRecord } from "./job-store";
import { OFFSCREEN_TARGET } from "../offscreen/protocol";
import type {
  OffscreenAbortMessage,
  OffscreenChunkMessage,
  OffscreenDoneMessage,
  OffscreenRevokeMessage,
  OffscreenResult,
} from "../offscreen/protocol";

function ctxOf(post: PostMeta, it: EnqueueItem): RenderContext {
  return {
    creator: post.creator, creatorId: post.creatorId, postTitle: post.postTitle, postId: post.postId,
    postedAt: new Date(post.postedAtIso), now: new Date(),
    contentTitle: it.contentTitle, contentId: it.contentId, contentType: it.contentType, plan: it.plan,
    filename: it.filename, ext: it.ext, seq: it.seq, total: it.total,
  };
}

async function handleEnqueue(msg: EnqueueMessage): Promise<{ queued: number; error?: string }> {
  const s: Settings = await loadSettings();
  if (msg.force) {
    await removeJobsByPostId(msg.post.postId);
  }
  const enabled = (t: string) => (s.contentTypes as any)[t] !== false;
  const jobs: JobRecord[] = [];
  const seenPaths = new Set<string>();
  const errors: string[] = [];

  for (const it of msg.items) {
    if (!enabled(it.contentType)) continue;
    if (!it.url) { errors.push(`${it.idemKey}: url 未解決`); continue; }
    let relPath: string;
    try {
      relPath = renderTemplate(s.pathTemplate, ctxOf(msg.post, it), { replacement: s.illegalCharReplacement, segmentMaxLen: s.segmentMaxLen });
    } catch (e) {
      errors.push(e instanceof TemplateError ? `テンプレートエラー: ${e.message}` : String(e));
      break; // テンプレ不正は全体中断
    }
    const v = validatePath(relPath, { fullPathMaxLen: s.fullPathMaxLen, uniquifyHeadroom: s.uniquifyHeadroom, conflictAction: s.conflictAction, segmentMaxLen: s.segmentMaxLen });
    if (!v.ok) { errors.push(`${relPath}: ${v.error}`); continue; }
    if (seenPaths.has(relPath)) { errors.push(`バッチ内パス重複: ${relPath}`); continue; }
    seenPaths.add(relPath);
    jobs.push({ idemKey: it.idemKey, relPath, url: it.url, downloadUri: it.downloadUri, contentType: it.contentType, refetch: it.refetch, state: "pending" });
  }

  if (errors.length) return { queued: 0, error: errors.slice(0, 5).join(" / ") };
  const existing = await getAllJobs();
  const toStart = jobs.filter((j) => {
    const prev = existing[j.idemKey];
    return !(prev && (prev.state === "done" || prev.state === "requested"));
  });
  await putJobs(toStart);
  for (const j of toStart) await startDownload(j, s);
  return { queued: toStart.length };
}

async function startDownload(j: JobRecord, s: Settings): Promise<void> {
  try {
    const downloadId = await chrome.downloads.download({ url: j.url, filename: j.relPath, saveAs: false, conflictAction: s.conflictAction });
    await updateJob(j.idemKey, { state: "requested", downloadId });
  } catch (e) {
    await updateJob(j.idemKey, { state: "error", error: String(e) });
  }
}

// --- zip 化した photo gallery の DL -----------------------------------------
//
// Service Worker には DOM が無く URL.createObjectURL が使えない(MV3 の既知の
// 制約)ため、Blob 組み立て + object URL 発行は Offscreen Document に委譲する。
// job-store は通さない(dedup/reconcile 対象外の一発勝負。失敗時はユーザーが
// 🔄 で再実行する)。
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

async function finishZipDownload(jobId: string, filename: string, conflictAction: "uniquify" | "overwrite"): Promise<ZipPortResult> {
  const res = (await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET, kind: "zipDone", jobId, mimeType: "application/zip",
  } satisfies OffscreenDoneMessage)) as OffscreenResult | undefined;

  if (!res || !res.ok) {
    return { queued: 0, error: res?.error ?? "offscreen document から応答がありませんでした" };
  }

  const blobUrl = res.url;
  try {
    const downloadId = await chrome.downloads.download({ url: blobUrl, filename, saveAs: false, conflictAction });
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
  let conflictAction: "uniquify" | "overwrite" = "uniquify";
  const jobId = crypto.randomUUID();
  // Port 上のメッセージ順序は保証されるが、各メッセージを chrome.runtime.sendMessage で
  // offscreen へ転送する処理は非同期なので、そのまま fire-and-forget すると転送順序が
  // 前後しうる。ここで直列に繋いで順序を保つ。
  let chain: Promise<unknown> = Promise.resolve();
  let ended = false;

  port.onMessage.addListener((msg: ZipPortMessage) => {
    if (msg.kind === "start") {
      filename = msg.filename;
      conflictAction = msg.conflictAction;
      chain = ensureOffscreenDocument();
    } else if (msg.kind === "chunk") {
      chain = chain.then(() => sendChunkToOffscreen(jobId, msg.data));
    } else if (msg.kind === "end") {
      ended = true;
      chain
        .then(() => finishZipDownload(jobId, filename, conflictAction))
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
      .catch((e) => sendResponse({ queued: 0, error: String(e) }));
    return true;
  } else if (msg?.kind === "clearHistory") {
    clearAllJobs()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  return false;
});

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state) return;
  const cur = delta.state.current;
  if (cur !== "complete" && cur !== "interrupted") return;

  const zipUrl = zipDownloads.get(delta.id);
  if (zipUrl !== undefined) {
    zipDownloads.delete(delta.id);
    await persistZipDownloads();
    await revokeOffscreenUrl(zipUrl);
    return;
  }

  const j = await findByDownloadId(delta.id);
  if (!j) return;
  if (cur === "complete") await updateJob(j.idemKey, { state: "done", doneAt: Date.now() });
  else {
    // photo は署名 URL 失効の可能性 -> needs_page で退避。file は download_uri 安定なので error 記録。
    await updateJob(j.idemKey, { state: j.contentType === "photo" ? "needs_page" : "error", error: "interrupted" });
  }
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

// 起動時 reconcile (通常 DL)
(async () => {
  const s = await loadSettings();
  const all = await getAllJobs();
  for (const j of Object.values(all)) {
    if (j.state === "pending") { await startDownload(j, s); continue; }
    if (j.state !== "requested") continue;
    if (j.downloadId == null) { await startDownload(j, s); continue; }
    const [d] = await chrome.downloads.search({ id: j.downloadId });
    if (!d) { await startDownload(j, s); continue; }
    if (d.state === "complete") await updateJob(j.idemKey, { state: "done", doneAt: Date.now() });
    else if (d.state === "interrupted") await updateJob(j.idemKey, { state: j.contentType === "photo" ? "needs_page" : "error" });
  }
  // 完了から 1 年以上経過した done ジョブを間引く(chrome.storage.local の肥大化防止)。
  // doneAt を持たないレガシー done ジョブはここでは触らない(job-store.ts 参照)。
  await sweepOldDoneJobs(365 * 24 * 60 * 60 * 1000);
})();
