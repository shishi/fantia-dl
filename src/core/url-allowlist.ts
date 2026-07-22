// src/core/url-allowlist.ts
// DL 前 URL allowlist(spec 変更 B round15)。photo の signed URL や resolveUrl の
// 解決先はクロスオリジンの CDN URL であり、無検証で chrome.downloads.download /
// zip 用 fetch に渡さない。不合格アイテムは呼び出し側が errors に積んで除外する
// (fail-closed)。fanbox-dl の validateMediaUrl の翻案(fantia は postId をパスに
// 含まない CDN 形式のため、ホスト+スキーム検証のみの軽量版)。
//
// ALLOWED_CDN_HOSTS は hard gate(docs/superpowers/plans/2026-07-21-hard-gate-results.md)
// の実測結果だけを書く(推測ホスト禁止)。manifest.json の host_permissions と
// 常に同じホスト集合を指すこと(spec round20: これが一覧ボタンの有効化条件)。
export const ALLOWED_CDN_HOSTS: readonly string[] = [
  "cc.fantia.jp",
];

function isAllowedHost(host: string): boolean {
  if (host === "fantia.jp" || host.endsWith(".fantia.jp")) return true;
  return ALLOWED_CDN_HOSTS.includes(host);
}

export function validateDownloadUrl(url: string): { ok: true } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: `URL として不正: ${url}` };
  }
  if (u.protocol !== "https:") return { ok: false, error: `https 以外: ${url}` };
  if (!isAllowedHost(u.host)) return { ok: false, error: `許可外ホスト: ${u.host}` };
  return { ok: true };
}

// resolveUrl の入力(download_uri)検証(spec round16): 解決の fetch 自体が
// credentials 付きの実リクエストのため、出力だけでなく入力も fetch 実行前に
// 「fantia.jp 同一オリジンの相対パスまたは fantia.jp URL」であることを検証する。
// リダイレクト中間ホップは構造的に検証不可(受容済み残余。spec round16)。
export function validateResolveInput(downloadUri: string): { ok: true; url: string } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(downloadUri, "https://fantia.jp");
  } catch {
    return { ok: false, error: `download_uri が不正: ${downloadUri}` };
  }
  if (u.protocol !== "https:" || u.host !== "fantia.jp") {
    return { ok: false, error: `fantia.jp 以外への download_uri: ${downloadUri}` };
  }
  return { ok: true, url: u.toString() };
}
