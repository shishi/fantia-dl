import { parsePost } from "../fantia/parse";
import type { EnqueueItem, EnqueueMessage, PostMeta } from "./messages";

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

async function runDownload(force: boolean): Promise<{ queued?: number; error?: string } | null> {
  const postId = postIdFromUrl();
  if (!postId) { alert("[fantia-dl] postId 不明"); return null; }
  const fetched = await call("fetchPost", { postId });
  if (!fetched.ok) { alert(`[fantia-dl] 取得失敗: ${fetched.error}`); return null; }
  const post = parsePost(fetched.json);

  const meta: PostMeta = {
    creator: post.creator, creatorId: post.creatorId, postTitle: post.postTitle,
    postId: post.postId, postedAtIso: post.postedAt.toISOString(),
  };
  const items: EnqueueItem[] = [];
  for (const c of post.contents) {
    for (const f of c.files) {
      let url = f.directUrl ?? "";
      if (!url && f.downloadUri) {
        const resolved = await call("resolveUrl", { downloadUri: f.downloadUri });
        if (!resolved.ok) { console.warn("[fantia-dl] resolve 失敗", f.idemKey); continue; }
        url = resolved.url;
      }
      items.push({
        idemKey: f.idemKey, contentId: c.contentId, contentTitle: c.contentTitle ?? "",
        contentType: f.contentType, plan: c.plan ?? "", filename: f.filename ?? "",
        ext: f.ext, seq: f.seq, total: f.total, url, downloadUri: f.downloadUri, refetch: f.refetch,
      });
    }
  }
  const res: { queued?: number; error?: string } | null =
    await chrome.runtime.sendMessage({ kind: "enqueue", post: meta, items, pageUrl: location.href, force } as EnqueueMessage);
  if (res?.error) alert(`[fantia-dl] エラー: ${res.error}`);
  return res ?? null;
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
  btn.title = "ダウンロード(履歴があれば済んだ分はスキップ)";
  styleBtn(btn);
  btn.addEventListener("click", () => {
    btn.disabled = true;
    runDownload(false).then((r) => {
      if (r && typeof r.queued === "number") swapText(btn, `⬇ ${r.queued} 件開始`);
      else btn.disabled = false;
    }).catch(() => { btn.disabled = false; });
  });

  const retryBtn = document.createElement("button");
  retryBtn.id = "fdl-retry-btn"; retryBtn.type = "button"; retryBtn.textContent = "🔄";
  retryBtn.title = "やり直し(この投稿の履歴を消して再ダウンロード)";
  styleBtn(retryBtn);
  retryBtn.addEventListener("click", () => {
    if (!confirm("この投稿の DL 履歴を消して再ダウンロードします。よろしいですか?")) return;
    retryBtn.disabled = true;
    runDownload(true).then((r) => {
      if (r && typeof r.queued === "number") swapText(retryBtn, `🔄 ${r.queued} 件`);
      else retryBtn.disabled = false;
    }).catch(() => { retryBtn.disabled = false; });
  });

  container.appendChild(btn);
  container.appendChild(retryBtn);

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
