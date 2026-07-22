import { unzipSync } from "fflate";
import { createSerialQueue, zipAsync, collectZipSources, ZIP_SOURCE_BUDGET_BYTES, ZIP_MAX_FILES, ZIP_FALLBACK_NOTICE, type BinaryFetch } from "../src/content/zip-support";

describe("createSerialQueue(ページ内 zip 組み立ての直列化)", () => {
  it("ジョブを投入順に直列実行する(並走しない)", async () => {
    const q = createSerialQueue();
    const order: string[] = [];
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const p1 = q(async () => { order.push("a-start"); await sleep(30); order.push("a-end"); return 1; });
    const p2 = q(async () => { order.push("b-start"); order.push("b-end"); return 2; });
    expect(await p1).toBe(1);
    expect(await p2).toBe(2);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });
  it("前段の失敗は後続ジョブを妨げない", async () => {
    const q = createSerialQueue();
    await expect(q(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await q(async () => "ok")).toBe("ok");
  });
});

describe("zipAsync(fflate 非同期 zip)", () => {
  it("entries を zip 化し、展開すると元のバイト列が得られる", async () => {
    const data = await zipAsync({ "a.txt": new TextEncoder().encode("hello"), "dir/b.txt": new TextEncoder().encode("world") });
    const un = unzipSync(data);
    expect(new TextDecoder().decode(un["a.txt"])).toBe("hello");
    expect(new TextDecoder().decode(un["dir/b.txt"])).toBe("world");
  });
});

describe("collectZipSources(zip ソース収集: allowlist 適用点 b + バジェット)", () => {
  it("許可外 URL の file は fetch されず失敗する(→ 呼び出し側で個別 DL フォールバック)", async () => {
    let fetched = 0;
    const fetchFn: BinaryFetch = async () => { fetched++; return { ok: true, buffer: new ArrayBuffer(1) }; };
    const r = await collectZipSources(["https://evil.example.com/a.png"], fetchFn);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("許可外ホスト");
    expect(fetched).toBe(0);
  });
  it("許可 URL は残バジェットを maxBytes として渡しながら順に収集する", async () => {
    const seenMaxBytes: number[] = [];
    const fetchFn: BinaryFetch = async (_u, opts) => { seenMaxBytes.push(opts.maxBytes); return { ok: true, buffer: new Uint8Array(10).buffer }; };
    const r = await collectZipSources(["https://c.fantia.jp/a.png", "https://c.fantia.jp/b.png"], fetchFn, { budget: 25 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.buffers.size).toBe(2);
      expect(r.buffers.get("https://c.fantia.jp/a.png")!.byteLength).toBe(10);
    }
    expect(seenMaxBytes).toEqual([25, 15]);
  });
  it("fetch 側の tooLarge(バジェット超過)は失敗として返る", async () => {
    const fetchFn: BinaryFetch = async () => ({ ok: false, error: "too big", tooLarge: true });
    const r = await collectZipSources(["https://c.fantia.jp/a.png"], fetchFn, { budget: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("バジェット超過");
  });
  it("件数上限超過は 1 バイトも fetch せず失敗する", async () => {
    let fetched = 0;
    const fetchFn: BinaryFetch = async () => { fetched++; return { ok: true, buffer: new ArrayBuffer(1) }; };
    const urls = ["https://c.fantia.jp/0.png", "https://c.fantia.jp/1.png", "https://c.fantia.jp/2.png"];
    const r = await collectZipSources(urls, fetchFn, { maxFiles: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("件数上限");
    expect(fetched).toBe(0);
  });
});

describe("バジェット定数とフォールバック文言", () => {
  it("fanbox-dl の実装値を初期値として流用する(spec 変更 A-4)", () => {
    expect(ZIP_SOURCE_BUDGET_BYTES).toBe(100 * 1024 * 1024);
    expect(ZIP_MAX_FILES).toBe(100);
  });
  it("フォールバックは notice(情報通知)であり error ではない", () => {
    expect(ZIP_FALLBACK_NOTICE).toBe("zip を中止し個別ダウンロードに切り替えました");
  });
});
