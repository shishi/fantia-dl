import { checkTemplate, hasBlockingTemplateError, illegalReplacementError, type TemplateCheckInput } from "../src/options/validate-templates";
import type { RenderContext } from "../src/core/types";

const ctx: RenderContext = {
  creator: "c", creatorId: "1", postTitle: "t", postId: "1",
  postedAt: new Date("2026-01-01T00:00:00+09:00"), now: new Date(),
  contentTitle: "", contentId: "1", contentType: "photo", plan: "0",
  filename: "image", ext: "png", seq: 1, total: 1,
};
const base: Omit<TemplateCheckInput, "tpl"> = {
  ctx, replacement: "_", segmentMaxLen: 200, fullPathMaxLen: 180, uniquifyHeadroom: 16, conflictAction: "uniquify",
};

describe("checkTemplate(options プレビュー/保存ガードの純粋ロジック)", () => {
  it("正常なテンプレはエラーなし", () => {
    const r = checkTemplate({ ...base, tpl: "$creatorId/$filename.$ext" });
    expect(r.error).toBe("");
    expect(r.rel).toBe("1/image.png");
  });
  it("未定義プレースホルダはテンプレートエラー", () => {
    expect(checkTemplate({ ...base, tpl: "$doesNotExist" }).error).toContain("テンプレートエラー");
  });
  it("実効上限を超えるパスは検証エラー(テンプレートエラーとは区別)", () => {
    const r = checkTemplate({ ...base, tpl: "$creatorId/$filename.$ext", fullPathMaxLen: 3, uniquifyHeadroom: 0 });
    expect(r.error).toContain("検証エラー");
  });
  it("検証モードの差: uniquify は headroom を減算、overwrite(zip entry 用)はしない", () => {
    // 長さ 14 の "1/image....png" 相当を fullPathMaxLen=14, headroom=16 で判定すると
    // uniquify では実効 -2 で必ず落ち、overwrite では 14 <= 14 で通る
    const tpl = "$creatorId/$filename.$ext"; // rel = "1/image.png" (11 文字)
    expect(checkTemplate({ ...base, tpl, fullPathMaxLen: 11, uniquifyHeadroom: 16, conflictAction: "uniquify" }).error).toContain("検証エラー");
    expect(checkTemplate({ ...base, tpl, fullPathMaxLen: 11, uniquifyHeadroom: 16, conflictAction: "overwrite" }).error).toBe("");
  });
});

describe("hasBlockingTemplateError(zip 未使用時は zip テンプレのエラーで保存をブロックしない)", () => {
  const ok: TemplateCheckInput = { ...base, tpl: "$creatorId/$filename.$ext" };
  const bad: TemplateCheckInput = { ...base, tpl: "$doesNotExist" };
  it("メインテンプレのエラーは zip モードに関係なく常にブロック", () => {
    expect(hasBlockingTemplateError(bad, { zipModeActive: false, zipPath: ok, zipEntry: ok })).toBe(true);
  });
  it("zip モード無効時は zip テンプレのエラーをブロックに数えない", () => {
    expect(hasBlockingTemplateError(ok, { zipModeActive: false, zipPath: bad, zipEntry: bad })).toBe(false);
  });
  it("zip モード有効時は zip テンプレのエラーもブロック", () => {
    expect(hasBlockingTemplateError(ok, { zipModeActive: true, zipPath: bad, zipEntry: ok })).toBe(true);
    expect(hasBlockingTemplateError(ok, { zipModeActive: true, zipPath: ok, zipEntry: bad })).toBe(true);
  });
  it("すべて正常ならブロックしない", () => {
    expect(hasBlockingTemplateError(ok, { zipModeActive: true, zipPath: ok, zipEntry: ok })).toBe(false);
  });
});

describe("illegalReplacementError(保存時バリデーション)", () => {
  it("/ や \\ を含む置換文字列はエラー", () => {
    expect(illegalReplacementError("a/b")).not.toBeNull();
    expect(illegalReplacementError("\\")).not.toBeNull();
  });
  it("ILLEGAL 相当(: * ? など)や制御文字もエラー", () => {
    expect(illegalReplacementError(":")).not.toBeNull();
    expect(illegalReplacementError("*")).not.toBeNull();
    expect(illegalReplacementError("\x1f")).not.toBeNull();
  });
  it("通常の置換文字は OK(null)。空文字は options 側で _ にフォールバックする契約のため OK", () => {
    expect(illegalReplacementError("_")).toBeNull();
    expect(illegalReplacementError("-")).toBeNull();
    expect(illegalReplacementError("")).toBeNull();
  });
});
