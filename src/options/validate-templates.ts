// src/options/validate-templates.ts
// Options 画面のテンプレ/パス検証を DOM から切り離した純粋関数。
// save ボタンのガード(検証エラーがある間は保存拒否)がロジックとしてテストできるよう、
// options.ts のプレビュー計算とここを共有する(fanbox-dl の validate-templates.ts の翻案)。
import { renderTemplate, TemplateError } from "../core/template-engine";
import { validatePath } from "../core/path-validator";
import { isSafeReplacement } from "../core/sanitizer";
import type { RenderContext } from "../core/types";

export interface TemplateCheckInput {
  tpl: string;
  ctx: RenderContext;
  replacement: string;
  segmentMaxLen: number;
  fullPathMaxLen: number;
  uniquifyHeadroom: number;
  // 検証モード(spec 変更 A-4 round6): "uniquify" = downloads.download を通るパス
  // (pathTemplate / zipPathTemplate。uniquify サフィックス分の headroom を減算)、
  // "overwrite" = zip アーカイブ内部名(zipEntryTemplate。uniquify サフィックスが
  // 付かないため headroom 無効)。実行時検証と常に同じモードで判定し、
  // 「options では通るのに実行時に落ちる」(逆も)の食い違いを作らない。
  conflictAction: "uniquify" | "overwrite";
}

export interface TemplateCheckResult {
  rel: string;   // 検証成功時のプレビュー用パス(失敗時は "")
  error: string; // 空文字ならエラーなし
}

export function checkTemplate(input: TemplateCheckInput): TemplateCheckResult {
  try {
    const rel = renderTemplate(input.tpl, input.ctx, {
      replacement: input.replacement, segmentMaxLen: input.segmentMaxLen,
    });
    const v = validatePath(rel, {
      fullPathMaxLen: input.fullPathMaxLen, uniquifyHeadroom: input.uniquifyHeadroom,
      conflictAction: input.conflictAction, segmentMaxLen: input.segmentMaxLen,
    });
    return { rel, error: v.ok ? "" : `検証エラー: ${v.error}` };
  } catch (e) {
    return { rel: "", error: e instanceof TemplateError ? `テンプレートエラー: ${e.message}` : String(e) };
  }
}

// save ガード: メインテンプレのエラーは常にブロックするが、zip 系テンプレは
// zip モード(zipGalleries + contentTypes.photo)が有効な場合に限りブロック対象にする。
// zip を使っていないユーザーが無関係な設定変更を保存できなくなる regression を防ぐ
// (fanbox-dl の codex レビュー P2 round3 と同じ判断)。
export function hasBlockingTemplateError(
  main: TemplateCheckInput,
  zip: { zipModeActive: boolean; zipPath: TemplateCheckInput; zipEntry: TemplateCheckInput },
): boolean {
  if (checkTemplate(main).error !== "") return true;
  if (!zip.zipModeActive) return false;
  return checkTemplate(zip.zipPath).error !== "" || checkTemplate(zip.zipEntry).error !== "";
}

// 保存時バリデーション(spec 変更 C): replacement に / \ 等の ILLEGAL 相当や制御文字を
// 保存できると slash 中和が無効化・逆用されるため保存前に拒否する。
// 空文字は options.ts 側で "_" にフォールバックする契約のためエラー扱いにしない。
export function illegalReplacementError(rep: string): string | null {
  if (rep === "") return null;
  if (!isSafeReplacement(rep)) {
    return '置換文字に / \\ : * ? " < > | や制御文字は使えません';
  }
  return null;
}
