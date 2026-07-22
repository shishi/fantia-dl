import type { Settings } from "./types";
import { isSafeReplacement } from "./sanitizer";

// spec 変更 A-3: dedup 撤去後の耐久性は uniquify の「無言上書きが構造的に起きない」
// 性質に依存する。設定値ではなく定数。どの保存値もこれを変えられない
// (Settings 型から conflictAction を消したので、読み残しはコンパイルエラーになる)。
export const DOWNLOAD_CONFLICT_ACTION = "uniquify" as const;

export const DEFAULT_SETTINGS: Settings = {
  pathTemplate: "fantia/$creator/$date{YYYYMMDD}_$postTitle/$contentTitle/[$seq{3}_]$filename.$ext",
  illegalCharReplacement: "_",
  contentTypes: { photo: true, file: true, video: true },
  segmentMaxLen: 200,
  fullPathMaxLen: 180,
  uniquifyHeadroom: 16,
  zipGalleries: true,
  zipPathTemplate: "fantia/$creator/$date{YYYYMMDD}_$postTitle/$contentTitle.zip",
  zipEntryTemplate: "[$seq{3}_]$filename.$ext",
};

// 既知キーだけを拾う allowlist merge。旧 conflictAction や未知キーを結果に持ち込まない
// (blind spread だと `s.conflictAction` の読み残しが 1 箇所でも生き残れば保存済み
// "overwrite" が復活し得るため、構造的に閉じる。spec 変更 A-3 round2)。
export function mergeSettings(stored: Partial<Settings> | undefined): Settings {
  const s = (stored ?? {}) as Record<string, unknown>;
  const out: Settings = { ...DEFAULT_SETTINGS, contentTypes: { ...DEFAULT_SETTINGS.contentTypes } };
  if (typeof s.pathTemplate === "string") out.pathTemplate = s.pathTemplate;
  // 読み込み時クランプ(spec 変更 C): バリデーション導入前に保存された synced 設定への防御。
  // SW と content-script(zip 経路)の両方が loadSettings 経由のため単一点で効く。
  if (typeof s.illegalCharReplacement === "string" && isSafeReplacement(s.illegalCharReplacement)) {
    out.illegalCharReplacement = s.illegalCharReplacement;
  }
  if (typeof s.segmentMaxLen === "number") out.segmentMaxLen = s.segmentMaxLen;
  if (typeof s.fullPathMaxLen === "number") out.fullPathMaxLen = s.fullPathMaxLen;
  if (typeof s.uniquifyHeadroom === "number") out.uniquifyHeadroom = s.uniquifyHeadroom;
  if (typeof s.zipGalleries === "boolean") out.zipGalleries = s.zipGalleries;
  if (typeof s.zipPathTemplate === "string") out.zipPathTemplate = s.zipPathTemplate;
  if (typeof s.zipEntryTemplate === "string") out.zipEntryTemplate = s.zipEntryTemplate;
  const ct = s.contentTypes as Record<string, unknown> | undefined;
  if (ct) {
    out.contentTypes = {
      photo: typeof ct.photo === "boolean" ? ct.photo : true,
      file: typeof ct.file === "boolean" ? ct.file : true,
      video: typeof ct.video === "boolean" ? ct.video : true,
    };
  }
  return out;
}

export async function loadSettings(): Promise<Settings> {
  const raw = await chrome.storage.sync.get("settings");
  return mergeSettings(raw?.settings as Partial<Settings> | undefined);
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.sync.set({ settings: s });
}
