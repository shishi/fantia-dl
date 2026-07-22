import { fetchPost, resolveUrl, fetchBinary, type ApiResponse } from "../src/content/fantia-api";

function makeRes(over: Partial<ApiResponse>): ApiResponse {
  const status = over.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    url: "https://fantia.jp/x",
    headers: { get: () => null },
    json: async () => ({}),
    arrayBuffer: async () => new ArrayBuffer(0),
    body: null,
    ...over,
  };
}

describe("fetchPost", () => {
  it("200 なら json を返す(credentials/csrf ヘッダ付き)", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return makeRes({ json: async () => ({ post: { id: 1 } }) });
    };
    const r = await fetchPost("1", { fetchFn, csrf: () => "tok" });
    expect(r).toEqual({ ok: true, json: { post: { id: 1 } } });
    expect(calls[0].url).toBe("https://fantia.jp/api/v1/posts/1");
    expect((calls[0].init!.headers as Record<string, string>)["X-CSRF-Token"]).toBe("tok");
    expect((calls[0].init!.headers as Record<string, string>)["X-Requested-With"]).toBe("XMLHttpRequest");
    expect(calls[0].init!.credentials).toBe("include");
  });
  it("401 は csrf を読み直して 1 回だけリトライする", async () => {
    let tok = "old";
    const seen: string[] = [];
    const fetchFn = async (_url: string, init?: RequestInit) => {
      seen.push((init!.headers as Record<string, string>)["X-CSRF-Token"]);
      return seen.length === 1 ? makeRes({ status: 401 }) : makeRes({});
    };
    const r = await fetchPost("1", { fetchFn, csrf: () => { const t = tok; tok = "new"; return t; } });
    expect(r.ok).toBe(true);
    expect(seen).toEqual(["old", "new"]);
  });
  it("リトライ後も失敗なら fail(2 回で打ち止め)", async () => {
    let n = 0;
    const r = await fetchPost("1", { fetchFn: async () => { n++; return makeRes({ status: 422 }); }, csrf: () => "t" });
    expect(r).toEqual({ ok: false, error: "status 422" });
    expect(n).toBe(2);
  });
  it("404 は即 fail(リトライしない)", async () => {
    let n = 0;
    const r = await fetchPost("1", { fetchFn: async () => { n++; return makeRes({ status: 404 }); }, csrf: () => "" });
    expect(r).toEqual({ ok: false, error: "status 404" });
    expect(n).toBe(1);
  });
});

describe("resolveUrl", () => {
  it("Range: bytes=0-0 で fetch し本文を即 cancel、最終 URL を返す(全ファイルを転送しない契約)", async () => {
    let cancelled = false;
    let init: RequestInit | undefined;
    let url = "";
    const fetchFn = async (u: string, i?: RequestInit) => {
      url = u; init = i;
      return makeRes({ url: "https://cc.fantia.jp/uploads/file.mp4", body: { cancel: async () => { cancelled = true; } } });
    };
    const r = await resolveUrl("/posts/1/download/2", { fetchFn, csrf: () => "t" });
    expect(r).toEqual({ ok: true, url: "https://cc.fantia.jp/uploads/file.mp4" });
    expect(url).toBe("https://fantia.jp/posts/1/download/2"); // 相対 uri は fantia.jp に解決
    expect((init!.headers as Record<string, string>)["Range"]).toBe("bytes=0-0");
    expect(cancelled).toBe(true);
  });
  it("!ok は fail-closed(旧実装はエラーページ URL を成功として返す fail-open だった)", async () => {
    const r = await resolveUrl("/posts/1/download/2", { fetchFn: async () => makeRes({ status: 404 }), csrf: () => "t" });
    expect(r).toEqual({ ok: false, error: "status 404" });
  });
});

describe("fetchBinary", () => {
  it("200 なら buffer を返し、redirect:'error' で fetch する(zip への任意バイト列混入防止)", async () => {
    let init: RequestInit | undefined;
    const r = await fetchBinary("https://c.fantia.jp/a.png", {}, {
      fetchFn: async (_u, i) => { init = i; return makeRes({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }); },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.buffer.byteLength).toBe(3);
    expect(init!.redirect).toBe("error");
  });
  it("Content-Length が maxBytes 超過なら本文を読まず cancel して tooLarge(事前ゲート)", async () => {
    let cancelled = false;
    let bodyRead = false;
    const r = await fetchBinary("https://c.fantia.jp/a.png", { maxBytes: 10 }, {
      fetchFn: async () => makeRes({
        headers: { get: (n: string) => (n.toLowerCase() === "content-length" ? "11" : null) },
        arrayBuffer: async () => { bodyRead = true; return new ArrayBuffer(11); },
        body: { cancel: async () => { cancelled = true; } },
      }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.tooLarge).toBe(true);
    expect(cancelled).toBe(true);
    expect(bodyRead).toBe(false);
  });
  it("Content-Length 無し応答は取得後判定(best-effort)で tooLarge", async () => {
    const r = await fetchBinary("https://c.fantia.jp/a.png", { maxBytes: 2 }, {
      fetchFn: async () => makeRes({ arrayBuffer: async () => new ArrayBuffer(3) }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.tooLarge).toBe(true);
  });
  it("ネットワーク例外(redirect:'error' による遮断含む)は ok:false", async () => {
    const r = await fetchBinary("https://c.fantia.jp/a.png", {}, { fetchFn: async () => { throw new TypeError("Failed to fetch"); } });
    expect(r.ok).toBe(false);
  });
  it("status 失敗は ok:false", async () => {
    const r = await fetchBinary("https://c.fantia.jp/a.png", {}, { fetchFn: async () => makeRes({ status: 403 }) });
    expect(r).toEqual({ ok: false, error: "status 403" });
  });
});
