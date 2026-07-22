import { parsePost } from "../fantia/parse";
import type { EnqueueItem, EnqueueMessage, EnqueueResponse, DownloadResult, PostMeta, ZipPortResult, ZipStartMessage, ZipChunkMessage, ZipEndMessage } from "./messages";
import { ZIP_PORT_NAME } from "./messages";
import { zipSync } from "fflate";
import { loadSettings } from "../core/settings";
import { renderTemplate, TemplateError } from "../core/template-engine";
import { bytesToBase64 } from "../core/base64";
import type { ContentBlock, PostData, RenderContext, Settings } from "../core/types";

const csrf = () => document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? "";
const postIdFromUrl = () => location.pathname.match(/posts\/(\d+)/)?.[1] ?? null;

function injectPageScript(): Promise<void> {
  return new Promise((res) => {
    const onReady = (ev: MessageEvent) => {
      if (ev.source !== window) return;
      if (ev.data?.__fdl === "ready") { window.removeEventListener("message", onReady); res(); }
    };
    window.addEventListener("message", onReady);
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("content/page-script.js");
    (document.head || document.documentElement).appendChild(s);
  });
}

let reqSeq = 0;
function call(kind: string, extra: Record<string, unknown>): Promise<any> {
  const reqId = ++reqSeq;
  return new Promise((res) => {
    const on = (ev: MessageEvent) => {
      if (ev.source !== window) return;
      if (ev.data?.__fdl === "res" && ev.data.reqId === reqId) {
        window.removeEventListener("message", on);
        res(ev.data);
      }
    };
    window.addEventListener("message", on);
    window.postMessage({ __fdl: "req", reqId, kind, csrf: csrf(), ...extra }, "*");
  });
}

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

// photo_gallery を zip にまとめ、background 経由で chrome.downloads.download する。
// 履歴は持たない(zip は一発勝負。失敗したら再クリックでやり直す)。
async function makeAndDownloadZip(
  block: ContentBlock,
  post: PostData,
  s: Settings,
): Promise<{ queued: number; error?: string }> {
  try {
    return await makeAndDownloadZipInner(block, post, s);
  } catch (e) {
    return { queued: 0, error: e instanceof TemplateError ? `テンプレートエラー: ${e.message}` : String(e) };
  }
}

async function makeAndDownloadZipInner(
  block: ContentBlock,
  post: PostData,
  s: Settings,
): Promise<{ queued: number; error?: string }> {
  const entries: Record<string, Uint8Array> = {};
  const usedNames = new Set<string>();
  const now = new Date();
  for (const f of block.files) {
    if (!f.directUrl) continue;
    const res = await call("fetchBinary", { url: f.directUrl });
    if (!res.ok) return { queued: 0, error: `fetchBinary failed: ${res.error}` };
    const ctx: RenderContext = {
      creator: post.creator, creatorId: post.creatorId,
      postTitle: post.postTitle, postId: post.postId,
      postedAt: post.postedAt, now,
      contentTitle: block.contentTitle ?? "", contentId: block.contentId,
      contentType: f.contentType, plan: block.plan ?? "",
      filename: f.filename ?? "", ext: f.ext, seq: f.seq, total: f.total,
    };
    let entryPath = renderTemplate(s.zipEntryTemplate, ctx,
      { replacement: s.illegalCharReplacement, segmentMaxLen: s.segmentMaxLen });
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
    usedNames.add(entryPath);
    entries[entryPath] = new Uint8Array(res.buffer);
  }
  const zipped = zipSync(entries);

  const firstFile = block.files[0];
  const zipCtx: RenderContext = {
    creator: post.creator, creatorId: post.creatorId,
    postTitle: post.postTitle, postId: post.postId,
    postedAt: post.postedAt, now,
    contentTitle: block.contentTitle ?? "", contentId: block.contentId,
    contentType: "photo", plan: block.plan ?? "",
    filename: firstFile?.filename ?? "", ext: "zip",
    seq: 1, total: 1,
  };
  const zipPath = renderTemplate(s.zipPathTemplate, zipCtx,
    { replacement: s.illegalCharReplacement, segmentMaxLen: s.segmentMaxLen });

  // content-script は chrome.downloads にアクセスできない(拡張ページ/SW 限定)ため、
  // zip バイト列を background に渡して Blob 化 + downloads.download させる。
  return sendZipOverPort(zipPath, zipped);
}

async function runDownload(): Promise<DownloadResult | null> {
  const postId = postIdFromUrl();
  if (!postId) { alert("[fantia-dl] postId 不明"); return null; }
  const fetched = await call("fetchPost", { postId });
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
      const r = await makeAndDownloadZip(c, post, s);
      if (r.error) errors.push(r.error); else zipQueued += r.queued;
      continue;
    }
    for (const f of c.files) {
      let url = f.directUrl ?? "";
      if (!url && f.downloadUri) {
        const resolved = await call("resolveUrl", { downloadUri: f.downloadUri });
        // 統一応答契約: アイテム単位の失敗は黙って落とさず、識別可能な文言で errors に積む
        if (!resolved.ok) { errors.push(`${f.filename ?? ""}.${f.ext}: URL 解決失敗(${resolved.error ?? "不明"})`); continue; }
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

(async () => { await injectPageScript(); addButton(); })();
