// src/options/options.ts
import { loadSettings, saveSettings, DOWNLOAD_CONFLICT_ACTION } from "../core/settings";
import { checkTemplate, hasBlockingTemplateError, illegalReplacementError, type TemplateCheckInput } from "./validate-templates";
import type { RenderContext, Settings } from "../core/types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const singleSample: RenderContext = {
  creator: "sample_creator", creatorId: "1234", postTitle: "サンプル投稿", postId: "1234567",
  postedAt: new Date("2026-01-15T12:30:00+09:00"), now: new Date(),
  contentTitle: "ギャラリー", contentId: "42", contentType: "photo", plan: "無料プラン",
  filename: "image", ext: "png", seq: 2, total: 4,
};

const zipPathSample: RenderContext = {
  ...singleSample,
  filename: "gallery", ext: "zip", seq: 1, total: 1,
};

const zipEntrySample: RenderContext = { ...singleSample };

let cur: Settings;

// 検証モードは実行時と常に同じにする(spec 変更 A-4 round6):
// pathTemplate / zipPathTemplate は downloads.download を通る → uniquify(headroom 減算あり)。
// zipEntryTemplate はアーカイブ内部名 → overwrite 相当(headroom 無効)。
function templateInput(tpl: string, ctx: RenderContext, conflictAction: "uniquify" | "overwrite"): TemplateCheckInput {
  return {
    tpl, ctx,
    replacement: ($("repl") as HTMLInputElement).value || "_",
    segmentMaxLen: cur.segmentMaxLen,
    fullPathMaxLen: cur.fullPathMaxLen,
    uniquifyHeadroom: cur.uniquifyHeadroom,
    conflictAction,
  };
}

function renderPreview(input: TemplateCheckInput, previewEl: string, errEl: string): void {
  const { rel, error } = checkTemplate(input);
  $(previewEl).textContent = rel;
  $(errEl).textContent = error;
}

function updateAllPreviews(): void {
  renderPreview(templateInput(($("tpl") as HTMLInputElement).value, singleSample, DOWNLOAD_CONFLICT_ACTION), "preview", "tplErr");
  renderPreview(templateInput(($("zip_path_tpl") as HTMLInputElement).value, zipPathSample, DOWNLOAD_CONFLICT_ACTION), "zip_path_preview", "zipPathErr");
  renderPreview(templateInput(($("zip_entry_tpl") as HTMLInputElement).value, zipEntrySample, "overwrite"), "zip_entry_preview", "zipEntryErr");
}

async function init() {
  cur = await loadSettings();
  ($("tpl") as HTMLInputElement).value = cur.pathTemplate;
  ($("zip_path_tpl") as HTMLInputElement).value = cur.zipPathTemplate;
  ($("zip_entry_tpl") as HTMLInputElement).value = cur.zipEntryTemplate;
  ($("repl") as HTMLInputElement).value = cur.illegalCharReplacement;
  ($("ct_photo") as HTMLInputElement).checked = cur.contentTypes.photo;
  ($("ct_file") as HTMLInputElement).checked = cur.contentTypes.file;
  ($("ct_video") as HTMLInputElement).checked = cur.contentTypes.video;
  ($("zip_galleries") as HTMLInputElement).checked = cur.zipGalleries;

  ["tpl", "zip_path_tpl", "zip_entry_tpl", "repl"].forEach((id) =>
    $(id).addEventListener("input", updateAllPreviews),
  );
  updateAllPreviews();

  $("save").addEventListener("click", async () => {
    // クリック時点で再計算した結果で保存可否を判定する(古い DOM の textContent は見ない)
    updateAllPreviews();
    const zipModeActive = ($("zip_galleries") as HTMLInputElement).checked && ($("ct_photo") as HTMLInputElement).checked;
    const blocking = hasBlockingTemplateError(
      templateInput(($("tpl") as HTMLInputElement).value, singleSample, DOWNLOAD_CONFLICT_ACTION),
      {
        zipModeActive,
        zipPath: templateInput(($("zip_path_tpl") as HTMLInputElement).value, zipPathSample, DOWNLOAD_CONFLICT_ACTION),
        zipEntry: templateInput(($("zip_entry_tpl") as HTMLInputElement).value, zipEntrySample, "overwrite"),
      },
    );
    if (blocking) {
      alert("テンプレートにエラーがあります。修正してください");
      return;
    }
    const replError = illegalReplacementError(($("repl") as HTMLInputElement).value);
    if (replError) {
      alert(replError);
      return;
    }
    // 既知キーのみ明示的に書き戻す(blind spread の廃止。spec 変更 A-3 round2)
    cur = {
      pathTemplate: ($("tpl") as HTMLInputElement).value,
      zipPathTemplate: ($("zip_path_tpl") as HTMLInputElement).value,
      zipEntryTemplate: ($("zip_entry_tpl") as HTMLInputElement).value,
      illegalCharReplacement: ($("repl") as HTMLInputElement).value || "_",
      contentTypes: {
        photo: ($("ct_photo") as HTMLInputElement).checked,
        file: ($("ct_file") as HTMLInputElement).checked,
        video: ($("ct_video") as HTMLInputElement).checked,
      },
      zipGalleries: ($("zip_galleries") as HTMLInputElement).checked,
      segmentMaxLen: cur.segmentMaxLen,
      fullPathMaxLen: cur.fullPathMaxLen,
      uniquifyHeadroom: cur.uniquifyHeadroom,
    };
    await saveSettings(cur);
    $("saved").textContent = "保存しました";
    setTimeout(() => ($("saved").textContent = ""), 2000);
  });
}

init();
