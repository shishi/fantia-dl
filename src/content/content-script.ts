// src/content/content-script.ts
import { parsePost } from "../fantia/parse";
import type { EnqueueItem, EnqueueMessage, PostMeta } from "./messages";

const csrf = () => document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? "";
const postIdFromUrl = () => location.pathname.match(/posts\/(\d+)/)?.[1] ?? null;

function injectPageScript(): Promise<void> {
  return new Promise((res) => {
    const onReady = (ev: MessageEvent) => { if (ev.data?.__fdl === "ready") { window.removeEventListener("message", onReady); res(); } };
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
    const on = (ev: MessageEvent) => { if (ev.data?.__fdl === "res" && ev.data.reqId === reqId) { window.removeEventListener("message", on); res(ev.data); } };
    window.addEventListener("message", on);
    window.postMessage({ __fdl: "req", reqId, kind, csrf: csrf(), ...extra }, "*");
  });
}

async function runDownload() {
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
  const res = await chrome.runtime.sendMessage({ kind: "enqueue", post: meta, items, pageUrl: location.href } as EnqueueMessage);
  alert(`[fantia-dl] ${res?.queued ?? 0} 件をダウンロード開始` + (res?.error ? `\nエラー: ${res.error}` : ""));
}

function addButton() {
  if (document.getElementById("fdl-btn")) return;
  const btn = document.createElement("button");
  btn.id = "fdl-btn"; btn.textContent = "⬇ fantia-dl";
  Object.assign(btn.style, { position: "fixed", right: "16px", bottom: "16px", zIndex: "99999", padding: "10px 14px", borderRadius: "8px", cursor: "pointer" });
  btn.addEventListener("click", () => { btn.disabled = true; runDownload().finally(() => (btn.disabled = false)); });
  document.body.appendChild(btn);
}

(async () => { await injectPageScript(); addButton(); })();
