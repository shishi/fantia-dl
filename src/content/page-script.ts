// src/content/page-script.ts
// world:MAIN で実行。content-script から postMessage で命令を受ける。
const RETRY = new Set([401, 403, 422]);
const AUTH = (csrf: string) => ({ "X-CSRF-Token": csrf, "X-Requested-With": "XMLHttpRequest" });
const csrfNow = (fallback: string) =>
  document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content || fallback;

// 401/403/422 のとき CSRF を読み直して 1 回だけリトライ。
async function fetchRetry(url: string, csrf: string, extra: Record<string, string> = {}): Promise<Response> {
  let r = await fetch(url, { credentials: "include", headers: { ...AUTH(csrf), ...extra } });
  if (RETRY.has(r.status)) {
    r = await fetch(url, { credentials: "include", headers: { ...AUTH(csrfNow(csrf)), ...extra } });
  }
  return r;
}

window.addEventListener("message", async (ev) => {
  if (ev.source !== window) return;
  const msg = ev.data;
  if (!msg || msg.__fdl !== "req") return;
  const reply = (payload: any) => window.postMessage({ __fdl: "res", reqId: msg.reqId, ...payload }, "*");
  try {
    if (msg.kind === "fetchPost") {
      const r = await fetchRetry(`/api/v1/posts/${msg.postId}`, msg.csrf);
      if (!r.ok) return reply({ ok: false, error: `status ${r.status}` });
      reply({ ok: true, json: await r.json() });
    } else if (msg.kind === "resolveUrl") {
      const r = await fetchRetry(msg.downloadUri, msg.csrf, { Range: "bytes=0-0" });
      const url = r.url;
      try { await r.body?.cancel(); } catch {}
      reply({ ok: true, url });
    }
  } catch (e) { reply({ ok: false, error: String(e) }); }
});
window.postMessage({ __fdl: "ready" }, "*");
