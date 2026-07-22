import { validateDownloadUrl, validateResolveInput } from "../src/core/url-allowlist";

describe("validateDownloadUrl(DL 前 URL allowlist)", () => {
  it("fantia.jp とそのサブドメインの https URL を許可", () => {
    expect(validateDownloadUrl("https://fantia.jp/x").ok).toBe(true);
    expect(validateDownloadUrl("https://c.fantia.jp/uploads/a.png").ok).toBe(true);
    expect(validateDownloadUrl("https://cc.fantia.jp/uploads/a.mp4").ok).toBe(true);
  });
  it("外部ホストを拒否(類似ドメイン偽装含む)", () => {
    expect(validateDownloadUrl("https://example.com/a.png").ok).toBe(false);
    expect(validateDownloadUrl("https://evil-fantia.jp/a.png").ok).toBe(false);
    expect(validateDownloadUrl("https://fantia.jp.evil.com/a.png").ok).toBe(false);
  });
  it("https 以外・URL でないものを拒否", () => {
    expect(validateDownloadUrl("http://fantia.jp/a.png").ok).toBe(false);
    expect(validateDownloadUrl("data:image/png;base64,AAAA").ok).toBe(false);
    expect(validateDownloadUrl("blob:https://fantia.jp/xxxx").ok).toBe(false);
    expect(validateDownloadUrl("not a url").ok).toBe(false);
  });
  // 注意: Task 5 の実測で fantia.jp 系以外の CDN ホスト(S3/CloudFront 等)が出た場合は、
  // その実ホストの許可テストをここに追加する。例(実測が "cdn.example-s3.amazonaws.com" の場合):
  //   expect(validateDownloadUrl("https://cdn.example-s3.amazonaws.com/a.png").ok).toBe(true);
  // 実測に無いホストのテストを書いてはならない(推測ホスト禁止)。
});

describe("validateResolveInput(resolveUrl の入力ガード: fetch 自体が credentials 付き実リクエスト)", () => {
  it("相対 download_uri は fantia.jp 絶対 URL に解決して許可", () => {
    expect(validateResolveInput("/posts/1/download/2")).toEqual({ ok: true, url: "https://fantia.jp/posts/1/download/2" });
  });
  it("fantia.jp 絶対 URL は許可", () => {
    expect(validateResolveInput("https://fantia.jp/posts/1/download/2").ok).toBe(true);
  });
  it("外部ホスト・protocol-relative・サブドメインを拒否(同一オリジンのみ)", () => {
    expect(validateResolveInput("https://evil.com/x").ok).toBe(false);
    expect(validateResolveInput("//evil.com/x").ok).toBe(false);
    expect(validateResolveInput("https://c.fantia.jp/x").ok).toBe(false);
  });
});
