import { planEnqueue } from "../src/background/enqueue-plan";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import type { EnqueueMessage } from "../src/content/messages";

const msg = (items: Partial<EnqueueMessage["items"][number]>[]): EnqueueMessage => ({
  kind: "enqueue",
  post: { creator: "c", creatorId: "1", postTitle: "t", postId: "9", postedAtIso: "2026-01-15T03:30:00.000Z" },
  items: items.map((it) => ({
    contentId: "42", contentTitle: "g", contentType: "photo", plan: "p",
    filename: "img", ext: "png", seq: 1, total: 1, url: "https://c.fantia.jp/a.png",
    ...it,
  })),
  pageUrl: "https://fantia.jp/posts/9",
});

describe("planEnqueue(SW enqueue の純粋部分: render→validate→dedup)", () => {
  it("有効な item は downloads に載る(url と relPath)", () => {
    const r = planEnqueue(msg([{}]), DEFAULT_SETTINGS);
    expect(r.errors).toEqual([]);
    expect(r.downloads).toHaveLength(1);
    expect(r.downloads[0].url).toBe("https://c.fantia.jp/a.png");
    expect(r.downloads[0].relPath).toContain("fantia/c/");
  });
  it("無効化された contentType はスキップ(エラーにもしない)", () => {
    const s = { ...DEFAULT_SETTINGS, contentTypes: { ...DEFAULT_SETTINGS.contentTypes, photo: false } };
    const r = planEnqueue(msg([{}]), s);
    expect(r.downloads).toHaveLength(0);
    expect(r.errors).toEqual([]);
  });
  it("url 未解決の item は errors に積む", () => {
    const r = planEnqueue(msg([{ url: "" }]), DEFAULT_SETTINGS);
    expect(r.downloads).toHaveLength(0);
    expect(r.errors[0]).toContain("url 未解決");
  });
  it("バッチ内パス重複は 2 件目を errors に積む", () => {
    const r = planEnqueue(msg([{}, {}]), DEFAULT_SETTINGS);
    expect(r.downloads).toHaveLength(1);
    expect(r.errors[0]).toContain("バッチ内パス重複");
  });
  it("テンプレート不正は全体中断(downloads 空)", () => {
    const s = { ...DEFAULT_SETTINGS, pathTemplate: "$doesNotExist" };
    const r = planEnqueue(msg([{}]), s);
    expect(r.downloads).toHaveLength(0);
    expect(r.errors[0]).toContain("テンプレートエラー");
  });
  it("allowlist 外 URL の item は downloads に載らず errors に積まれる(DL 前 allowlist 適用点 a)", () => {
    const r = planEnqueue(msg([{ url: "https://evil.example.com/a.png" }]), DEFAULT_SETTINGS);
    expect(r.downloads).toHaveLength(0);
    expect(r.errors[0]).toContain("許可外ホスト");
  });
});
