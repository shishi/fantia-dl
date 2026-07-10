// src/content/content-script.ts
import { parsePost } from "../fantia/parse";
import type { EnqueueItem, EnqueueMessage, PostMeta } from "./messages";

const csrf = () => document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? "";
const postIdFromUrl = () => location.pathname.match(/posts\/(\d+)/)?.[1] ?? null;

function injectPageScript(): Promise<void> {
  return new Promise((res) => {
    const onReady = (ev: MessageEvent) => { if (ev.source !== window) return; if (ev.data?.__fdl === "ready") { window.removeEventListener("message", onReady); res(); } };
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
    const on = (ev: MessageEvent) => { if (ev.source !== window) return; if (ev.data?.__fdl === "res" && ev.data.reqId === reqId) { window.removeEventListener("message", on); res(ev.data); } };
    window.addEventListener("message", on);
    window.postMessage({ __fdl: "req", reqId, kind, csrf: csrf(), ...extra }, "*");
  });
}

async function runDownload(force: boolean) {
  const postId = postIdFromUrl();
  if (!postId) return alert("[fantia-dl] postId 不明");
  const fetched = await call("fetchPost", { postId });
  if (!fetched.ok) return alert(`[fantia-dl] 取得失敗: ${fetched.error}`);
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
  const res = await chrome.runtime.sendMessage({ kind: "enqueue", post: meta, items, pageUrl: location.href, force } as EnqueueMessage);
  alert(`[fantia-dl] ${res?.queued ?? 0} 件をダウンロード開始` + (res?.error ? `\nエラー: ${res.error}` : ""));
}

function addButton() {
  if (document.getElementById("fdl-btn")) return;
  const container = document.createElement("div");
  Object.assign(container.style, {
    position: "fixed", right: "16px", bottom: "16px", zIndex: "99999",
    display: "flex", gap: "8px",
  });

  const btn = document.createElement("button");
  btn.id = "fdl-btn"; btn.textContent = "⬇ fantia-dl";
  btn.title = "ダウンロード(履歴があれば済んだ分はスキップ)";
  Object.assign(btn.style, { padding: "10px 14px", borderRadius: "8px", cursor: "pointer" });
  btn.addEventListener("click", () => { btn.disabled = true; runDownload(false).finally(() => (btn.disabled = false)); });

  const retryBtn = document.createElement("button");
  retryBtn.id = "fdl-retry-btn"; retryBtn.textContent = "🔄";
  retryBtn.title = "やり直し(この投稿の履歴を消して再ダウンロード)";
  Object.assign(retryBtn.style, { padding: "10px 12px", borderRadius: "8px", cursor: "pointer" });
  retryBtn.addEventListener("click", () => {
    if (!confirm("この投稿の DL 履歴を消して再ダウンロードします。よろしいですか?")) return;
    retryBtn.disabled = true;
    runDownload(true).finally(() => (retryBtn.disabled = false));
  });

  container.appendChild(btn);
  container.appendChild(retryBtn);
  document.body.appendChild(container);
}

(async () => { await injectPageScript(); addButton(); })();
