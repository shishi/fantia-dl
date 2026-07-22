import { parsePost } from "../fantia/parse";
import type { EnqueueItem, EnqueueMessage, EnqueueResponse, DownloadResult, PostMeta, ZipPortResult, ZipStartMessage, ZipChunkMessage, ZipEndMessage } from "./messages";
import { ZIP_PORT_NAME } from "./messages";
import { loadSettings, DOWNLOAD_CONFLICT_ACTION } from "../core/settings";
import { renderTemplate, TemplateError } from "../core/template-engine";
import { bytesToBase64 } from "../core/base64";
import { validatePath } from "../core/path-validator";
import type { ContentBlock, FileItem, PostData, RenderContext, Settings } from "../core/types";
import { fetchPost, resolveUrl, fetchBinary } from "./fantia-api";
import { createSerialQueue, zipAsync, collectZipSources, ZIP_FALLBACK_NOTICE } from "./zip-support";

const postIdFromUrl = () => location.pathname.match(/posts\/(\d+)/)?.[1] ?? null;

const ZIP_CHUNK_BYTES = 4 * 1024 * 1024; // 1 メッセージ上限を避けるためのチャンクサイズ

// zip バイト列を Port の start -> chunk* -> end で background に送る
// (1 メッセージで送ると runtime messaging のサイズ上限に引っかかるため)。
function sendZipOverPort(
  filename: string,
  bytes: Uint8Array,
): Promise<ZipPortResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: ZipPortResult) => { if (!settled) { settled = true; resolve(r); } };
    const port = chrome.runtime.connect({ name: ZIP_PORT_NAME });
    port.onMessage.addListener((res: ZipPortResult) => { finish(res); port.disconnect(); });
    port.onDisconnect.addListener(() => finish({ queued: 0, error: "background との接続が切れました" }));
    port.postMessage({ kind: "start", filename, totalBytes: bytes.byteLength } as ZipStartMessage);
    for (let off = 0; off < bytes.byteLength; off += ZIP_CHUNK_BYTES) {
      const slice = bytes.subarray(off, Math.min(off + ZIP_CHUNK_BYTES, bytes.byteLength));
      port.postMessage({ kind: "chunk", data: bytesToBase64(slice) } as ZipChunkMessage);
    }
    port.postMessage({ kind: "end" } as ZipEndMessage);
  });
}

// --- zip 組み立て(spec 変更 A-4 / B) ---------------------------------------
// fantia のギャラリーは「zip 排他分岐」で、zip が失敗するとそのギャラリーが丸ごと
// 未保存になる。enqueue 前のあらゆる zip 失敗(バジェット超過・validatePath 不合格・
// offscreen 障害・Port 切断・downloads.download 失敗)は ok:false を返し、呼び出し側が
// 個別ファイル DL へフォールバックする。個別 DL をスキップしてよいのは zip の enqueue が
// 実際に成功したときだけ(ユーザーの目的は保存であって zip 形式ではない)。
// enqueue 成功後に blob DL が interrupted になるケースは対象外(復旧は再クリック)。
type GalleryZipResult = { ok: true } | { ok: false; reason: string };

// ページ内の zip 組み立ては同時 1 件に直列化(round21)。per-document 状態のため
// リロード/遷移でキューは消えるが、復旧は再クリックで良い(round26 residual 受容済み)。
const enqueueZipJob = createSerialQueue();

function tryZipGallery(block: ContentBlock, post: PostData, s: Settings): Promise<GalleryZipResult> {
  return enqueueZipJob(() => tryZipGalleryInner(block, post, s))
    .catch((e) => ({ ok: false as const, reason: String(e) }));
}

async function tryZipGalleryInner(block: ContentBlock, post: PostData, s: Settings): Promise<GalleryZipResult> {
  const files = block.files.filter((f): f is FileItem & { directUrl: string } => !!f.directUrl);
  if (files.length === 0) return { ok: false, reason: "directUrl のある photo がありません" };

  // ソース収集: 各 URL の allowlist 検証(適用点 b)・件数上限・残バジェットの
  // maxBytes 伝搬は collectZipSources(単体テスト対象)が行う。
  const collected = await collectZipSources(files.map((f) => f.directUrl), (url, opts) => fetchBinary(url, opts));
  if (!collected.ok) return { ok: false, reason: collected.reason };

  const entries: Record<string, Uint8Array> = {};
  const usedNames = new Set<string>();
  const now = new Date();
  for (const f of files) {
    const buf = collected.buffers.get(f.directUrl);
    if (!buf) return { ok: false, reason: `zip ソース欠落: ${f.directUrl}` };

    const ctx: RenderContext = {
      creator: post.creator, creatorId: post.creatorId,
      postTitle: post.postTitle, postId: post.postId,
      postedAt: post.postedAt, now,
      contentTitle: block.contentTitle ?? "", contentId: block.contentId,
      contentType: f.contentType, plan: block.plan ?? "",
      filename: f.filename ?? "", ext: f.ext, seq: f.seq, total: f.total,
    };
    let entryPath: string;
    try {
      entryPath = renderTemplate(s.zipEntryTemplate, ctx,
        { replacement: s.illegalCharReplacement, segmentMaxLen: s.segmentMaxLen });
    } catch (e) {
      return { ok: false, reason: e instanceof TemplateError ? `テンプレートエラー: ${e.message}` : String(e) };
    }
    // テンプレが $seq を含まない等で衝突しうる -> 静かな上書き(データ消失)を防ぐため連番を付与。
    if (usedNames.has(entryPath)) {
      const dot = entryPath.lastIndexOf(".");
      const stem = dot > 0 ? entryPath.slice(0, dot) : entryPath;
      const ext = dot > 0 ? entryPath.slice(dot) : "";
      let n = 2;
      let candidate = `${stem} (${n})${ext}`;
      while (usedNames.has(candidate)) { n++; candidate = `${stem} (${n})${ext}`; }
      entryPath = candidate;
    }
    // entry 名はアーカイブ内部の名前で uniquify サフィックスが付かないため、
    // headroom 減算を無効("overwrite" 相当)にして検証する(spec round5:
    // uniquify 扱いだと正当な entry 名が誤って拒否され zip 全体が不当に中断される)。
    const pv = validatePath(entryPath, { fullPathMaxLen: s.fullPathMaxLen, uniquifyHeadroom: s.uniquifyHeadroom, conflictAction: "overwrite", segmentMaxLen: s.segmentMaxLen });
    if (!pv.ok) return { ok: false, reason: `zip entry 名不正: ${entryPath}: ${pv.error}` };
    usedNames.add(entryPath);
    entries[entryPath] = buf;
  }

  const firstFile = files[0];
  const zipCtx: RenderContext = {
    creator: post.creator, creatorId: post.creatorId,
    postTitle: post.postTitle, postId: post.postId,
    postedAt: post.postedAt, now,
    contentTitle: block.contentTitle ?? "", contentId: block.contentId,
    contentType: "photo", plan: block.plan ?? "",
    filename: firstFile?.filename ?? "", ext: "zip",
    seq: 1, total: 1,
  };
  let zipPath: string;
  try {
    zipPath = renderTemplate(s.zipPathTemplate, zipCtx,
      { replacement: s.illegalCharReplacement, segmentMaxLen: s.segmentMaxLen });
  } catch (e) {
    return { ok: false, reason: e instanceof TemplateError ? `テンプレートエラー: ${e.message}` : String(e) };
  }
  // zipPath は実際に chrome.downloads.download を通るため uniquify 前提
  // (headroom 減算あり)で検証する(spec round4/5: 通常 DL とガード水準を揃える)。
  const zv = validatePath(zipPath, { fullPathMaxLen: s.fullPathMaxLen, uniquifyHeadroom: s.uniquifyHeadroom, conflictAction: DOWNLOAD_CONFLICT_ACTION, segmentMaxLen: s.segmentMaxLen });
  if (!zv.ok) return { ok: false, reason: `zip ファイル名不正: ${zipPath}: ${zv.error}` };

  let zipped: Uint8Array;
  try {
    zipped = await zipAsync(entries);
  } catch (e) {
    return { ok: false, reason: `zip 圧縮失敗: ${String(e)}` };
  }
  const r = await sendZipOverPort(zipPath, zipped);
  if (r.queued !== 1) return { ok: false, reason: r.error ?? "zip の enqueue に失敗" };
  return { ok: true };
}

async function runDownload(): Promise<DownloadResult | null> {
  const postId = postIdFromUrl();
  if (!postId) { alert("[fantia-dl] postId 不明"); return null; }
  const fetched = await fetchPost(postId);
  if (!fetched.ok) { alert(`[fantia-dl] 取得失敗: ${fetched.error}`); return null; }
  const post = parsePost(fetched.json);
  const s = await loadSettings();

  const meta: PostMeta = {
    creator: post.creator, creatorId: post.creatorId, postTitle: post.postTitle,
    postId: post.postId, postedAtIso: post.postedAt.toISOString(),
  };
  const items: EnqueueItem[] = [];
  let zipQueued = 0;
  const errors: string[] = [];
  const notices: string[] = []; // zip フォールバック通知用(Task 7 で使用開始)
  for (const c of post.contents) {
    if (c.contentType === "photo" && c.files.length >= 2 && s.zipGalleries && s.contentTypes.photo) {
      const zr = await tryZipGallery(c, post, s);
      if (zr.ok) { zipQueued += 1; continue; }
      // enqueue 前の zip 失敗 → このギャラリーを個別ファイル DL へフォールバック
      // (下の通常ループに落とす)。通知は notices(情報)チャネルで表示する。
      notices.push(`${ZIP_FALLBACK_NOTICE}(${zr.reason})`);
    }
    for (const f of c.files) {
      let url = f.directUrl ?? "";
      if (!url && f.downloadUri) {
        const resolved = await resolveUrl(f.downloadUri);
        // 統一応答契約: アイテム単位の失敗は黙って落とさず、識別可能な文言で errors に積む
        if (!resolved.ok) { errors.push(`${f.filename ?? ""}.${f.ext}: URL 解決失敗(${resolved.error})`); continue; }
        url = resolved.url;
      }
      items.push({
        contentId: c.contentId, contentTitle: c.contentTitle ?? "",
        contentType: f.contentType, plan: c.plan ?? "", filename: f.filename ?? "",
        ext: f.ext, seq: f.seq, total: f.total, url,
      });
    }
  }

  let queued = zipQueued;
  if (items.length > 0) {
    const res = (await chrome.runtime.sendMessage({ kind: "enqueue", post: meta, items, pageUrl: location.href } satisfies EnqueueMessage)) as EnqueueResponse | undefined;
    if (!res) errors.push("background から応答がありません");
    else { queued += res.queued; errors.push(...res.errors); }
  }
  if (errors.length) alert(`[fantia-dl] エラー: ${errors.join(" / ")}`);
  if (notices.length) alert(`[fantia-dl] お知らせ:\n${notices.join("\n")}`);
  return { queued, errors, notices };
}

function findTitleAnchor(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>(".the-post .post-header h1.post-title") ||
    document.querySelector<HTMLElement>(".post-header h1.post-title") ||
    document.querySelector<HTMLElement>("h1.post-title")
  );
}

function whenTitleReady(cb: (title: HTMLElement | null) => void, timeoutMs = 5000): void {
  const found = findTitleAnchor();
  if (found) { cb(found); return; }
  const obs = new MutationObserver(() => {
    const t = findTitleAnchor();
    if (t) {
      obs.disconnect();
      clearTimeout(tid);
      cb(t);
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
  const tid = setTimeout(() => { obs.disconnect(); cb(null); }, timeoutMs);
}

function addButton() {
  if (document.getElementById("fdl-btn-container")) return;

  const container = document.createElement("div");
  container.id = "fdl-btn-container";
  Object.assign(container.style, {
    display: "flex", gap: "8px", margin: "8px 0",
  });

  const styleBtn = (b: HTMLButtonElement) => {
    Object.assign(b.style, {
      padding: "6px 12px", borderRadius: "6px", cursor: "pointer", fontSize: "14px",
    });
  };

  const swapText = (b: HTMLButtonElement, temp: string, ms = 2500) => {
    const orig = b.dataset.origText ?? b.textContent ?? "";
    if (!b.dataset.origText) b.dataset.origText = orig;
    b.textContent = temp;
    setTimeout(() => { b.textContent = b.dataset.origText || orig; b.disabled = false; }, ms);
  };

  const btn = document.createElement("button");
  btn.id = "fdl-btn"; btn.type = "button"; btn.textContent = "⬇ fantia-dl";
  btn.title = "この投稿をダウンロード";
  styleBtn(btn);
  btn.addEventListener("click", () => {
    btn.disabled = true;
    runDownload().then((r) => {
      if (r) swapText(btn, `⬇ ${r.queued} 件開始`);
      else btn.disabled = false;
    }).catch(() => { btn.disabled = false; });
  });

  container.appendChild(btn);

  whenTitleReady((title) => {
    if (document.getElementById("fdl-btn-container") && document.getElementById("fdl-btn-container") !== container) return;
    if (title && title.parentElement) {
      title.parentElement.insertBefore(container, title.nextSibling);
    } else {
      Object.assign(container.style, {
        position: "fixed", right: "16px", bottom: "16px", zIndex: "99999",
      });
      document.body.appendChild(container);
    }
  });
}

addButton();
