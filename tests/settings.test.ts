import { DEFAULT_SETTINGS, mergeSettings, DOWNLOAD_CONFLICT_ACTION } from "../src/core/settings";

describe("mergeSettings", () => {
  it("undefined なら既定値", () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });
  it("部分上書きをマージする", () => {
    const m = mergeSettings({ pathTemplate: "x/$filename.$ext" });
    expect(m.pathTemplate).toBe("x/$filename.$ext");
    expect(m.zipGalleries).toBe(true);
  });
  it("contentTypes をネストマージする", () => {
    const m = mergeSettings({ contentTypes: { photo: false } as any });
    expect(m.contentTypes).toEqual({ photo: false, file: true, video: true });
  });
  it("保存済みの conflictAction(旧キー)は無視され、結果に含まれない", () => {
    const m = mergeSettings({ conflictAction: "overwrite" } as any);
    expect((m as any).conflictAction).toBeUndefined();
  });
  it("未知キーは持ち込まれない(blind spread の廃止)", () => {
    const m = mergeSettings({ evil: 1 } as any);
    expect((m as any).evil).toBeUndefined();
  });
  it("型が合わない保存値は既定値に落ちる", () => {
    const m = mergeSettings({ segmentMaxLen: "200", zipGalleries: "yes" } as any);
    expect(m.segmentMaxLen).toBe(200);
    expect(m.zipGalleries).toBe(true);
  });
  it("DOWNLOAD_CONFLICT_ACTION 定数は uniquify", () => {
    expect(DOWNLOAD_CONFLICT_ACTION).toBe("uniquify");
  });
  it("不正な illegalCharReplacement は既定値 _ にクランプされる(読み込み時ガード)", () => {
    expect(mergeSettings({ illegalCharReplacement: "/" }).illegalCharReplacement).toBe("_");
    expect(mergeSettings({ illegalCharReplacement: "\\" }).illegalCharReplacement).toBe("_");
    expect(mergeSettings({ illegalCharReplacement: "a/b" }).illegalCharReplacement).toBe("_");
    expect(mergeSettings({ illegalCharReplacement: "\x00" }).illegalCharReplacement).toBe("_");
    expect(mergeSettings({ illegalCharReplacement: "-" }).illegalCharReplacement).toBe("-");
  });
  it("既定テンプレは連番オプショナルグループを含む", () => {
    expect(DEFAULT_SETTINGS.pathTemplate).toContain("[$seq{3}_]");
  });
  it("既定は zip モード ON", () => {
    expect(DEFAULT_SETTINGS.zipGalleries).toBe(true);
    expect(DEFAULT_SETTINGS.zipPathTemplate).toContain(".zip");
  });
});
