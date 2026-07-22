// src/content/fantia-api.ts
// isolated world(content script)から fantia API / CDN を直接 fetch する。
// 旧 page-script(MAIN world)+ postMessage ブリッジは無認証チャネルで、ページ JS が
// 偽 post JSON・偽解決 URL・fetchBinary への任意バイト列を注入できたため、チャネルを
// 守るのではなくチャネルごと削除した(spec 変更 B round19)。MV3 の isolated world
// fetch はページと同じ CORS/cookie 挙動で、csrf meta も DOM から読めるため機能は等価。

import { validateDownloadUrl, validateResolveInput } from "../core/url-allowlist";

export interface ApiResponse {
  ok: boolean;
  status: number;
  url: string;
  headers: { get(name: string): string | null };
  json(): Promise<any>;
  arrayBuffer(): Promise<ArrayBuffer>;
  body: { cancel(): Promise<void> } | null;
}
export type ApiFetch = (url: string, init?: RequestInit) => Promise<ApiResponse>;

const realFetch: ApiFetch = (url, init) => fetch(url, init);

const RETRY_STATUS = new Set([401, 403, 422]);
const AUTH = (csrf: string) => ({ "X-CSRF-Token": csrf, "X-Requested-With": "XMLHttpRequest" });

export function csrfToken(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? "";
}

// 401/403/422 のとき csrf meta を読み直して 1 回だけリトライする
// (旧 page-script の契約を維持。落とすと stale token での間欠失敗が全て手動リトライに退行する)。
async function fetchWithCsrfRetry(
  url: string, extra: Record<string, string>, fetchFn: ApiFetch, csrf: () => string,
): Promise<ApiResponse> {
  let r = await fetchFn(url, { credentials: "include", headers: { ...AUTH(csrf()), ...extra } });
  if (RETRY_STATUS.has(r.status)) {
    r = await fetchFn(url, { credentials: "include", headers: { ...AUTH(csrf()), ...extra } });
  }
  return r;
}

export async function fetchPost(
  postId: string,
  deps: { fetchFn?: ApiFetch; csrf?: () => string } = {},
): Promise<{ ok: true; json: any } | { ok: false; error: string }> {
  const fetchFn = deps.fetchFn ?? realFetch;
  const csrf = deps.csrf ?? csrfToken;
  try {
    const r = await fetchWithCsrfRetry(`https://fantia.jp/api/v1/posts/${postId}`, {}, fetchFn, csrf);
    if (!r.ok) return { ok: false, error: `status ${r.status}` };
    return { ok: true, json: await r.json() };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// download_uri(/posts/{postId}/download/{contentId})の最終 URL を解決する。
// Range: bytes=0-0 で fetch し本文を即 cancel(解決のために全ファイルを転送しない
// normative 契約。落とすと「解決で 1 回 + DL で 1 回」の二重転送になる)。
// r.ok でなければ fail-closed(旧実装は 403/404 でもエラーページ URL を
// 「解決成功」として返す fail-open だった。spec round7)。
export async function resolveUrl(
  downloadUri: string,
  deps: { fetchFn?: ApiFetch; csrf?: () => string } = {},
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const fetchFn = deps.fetchFn ?? realFetch;
  const csrf = deps.csrf ?? csrfToken;
  const input = validateResolveInput(downloadUri);
  if (!input.ok) return { ok: false, error: input.error };
  try {
    const r = await fetchWithCsrfRetry(input.url, { Range: "bytes=0-0" }, fetchFn, csrf);
    try { await r.body?.cancel(); } catch { /* 既読/クローズ済みは無視 */ }
    if (!r.ok) return { ok: false, error: `status ${r.status}` };
    const out = validateDownloadUrl(r.url);
    if (!out.ok) return { ok: false, error: `解決先が許可外: ${out.error}` };
    return { ok: true, url: r.url };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// zip ソース(photo の signed URL)取得。
// - redirect:"error": 許可ホストを通過した URL が非許可ホストへリダイレクトして
//   任意バイト列を zip に混入させる経路を封じる(spec round17。signed URL は
//   正規にはリダイレクトしないため正常系への影響は無い)。
// - maxBytes: Content-Length ヘッダによる事前ゲート(超過確定なら本文を読まず
//   cancel して tooLarge)+ 取得後の実サイズ判定(Content-Length 無し応答の
//   best-effort。spec round10: 単発スパイクは残るが蓄積はバジェットで有界)。
// - signed URL は CSRF 不要 → AUTH ヘッダなし・cookie も付けない単純 fetch。
export async function fetchBinary(
  url: string,
  opts: { maxBytes?: number } = {},
  deps: { fetchFn?: ApiFetch } = {},
): Promise<{ ok: true; buffer: ArrayBuffer } | { ok: false; error: string; tooLarge?: boolean }> {
  const fetchFn = deps.fetchFn ?? realFetch;
  try {
    const r = await fetchFn(url, { redirect: "error" });
    if (!r.ok) return { ok: false, error: `status ${r.status}` };
    if (opts.maxBytes !== undefined) {
      const len = Number(r.headers.get("content-length"));
      if (Number.isFinite(len) && len > opts.maxBytes) {
        try { await r.body?.cancel(); } catch { /* 無視 */ }
        return { ok: false, tooLarge: true, error: `Content-Length ${len} がバジェット残 ${opts.maxBytes} を超過` };
      }
    }
    const buffer = await r.arrayBuffer();
    if (opts.maxBytes !== undefined && buffer.byteLength > opts.maxBytes) {
      return { ok: false, tooLarge: true, error: `取得サイズ ${buffer.byteLength} がバジェット残 ${opts.maxBytes} を超過` };
    }
    return { ok: true, buffer };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
