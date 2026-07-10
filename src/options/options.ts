// src/options/options.ts
import { loadSettings, saveSettings } from "../core/settings";
import { renderTemplate, TemplateError } from "../core/template-engine";
import { validatePath } from "../core/path-validator";
import type { RenderContext, Settings } from "../core/types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sample: RenderContext = {
  creator: "C-Low", creatorId: "1736", postTitle: "サンプル投稿", postId: "4135924",
  postedAt: new Date("2026-07-07T00:32:13+09:00"), now: new Date(),
  contentTitle: "ギャラリー", contentId: "7554167", contentType: "photo", plan: "無料プラン",
  filename: "aaa", ext: "png", seq: 2, total: 4,
};

let cur: Settings;

function updatePreview() {
  const tpl = ($("tpl") as HTMLInputElement).value;
  try {
    const rel = renderTemplate(tpl, sample, { replacement: ($("repl") as HTMLInputElement).value || "_", segmentMaxLen: cur.segmentMaxLen });
    const v = validatePath(rel, { fullPathMaxLen: cur.fullPathMaxLen, uniquifyHeadroom: cur.uniquifyHeadroom, conflictAction: (($("conflict") as HTMLSelectElement).value as any), segmentMaxLen: cur.segmentMaxLen });
    $("preview").textContent = rel;
    $("tplErr").textContent = v.ok ? "" : `検証エラー: ${v.error}`;
  } catch (e) {
    $("preview").textContent = "";
    $("tplErr").textContent = e instanceof TemplateError ? `テンプレートエラー: ${e.message}` : String(e);
  }
}

async function init() {
  cur = await loadSettings();
  ($("tpl") as HTMLInputElement).value = cur.pathTemplate;
  ($("repl") as HTMLInputElement).value = cur.illegalCharReplacement;
  ($("conflict") as HTMLSelectElement).value = cur.conflictAction;
  ($("ct_photo") as HTMLInputElement).checked = cur.contentTypes.photo;
  ($("ct_file") as HTMLInputElement).checked = cur.contentTypes.file;
  ($("ct_video") as HTMLInputElement).checked = cur.contentTypes.video;
  ["tpl", "repl", "conflict"].forEach((id) => $(id).addEventListener("input", updatePreview));
  updatePreview();
  $("save").addEventListener("click", async () => {
    cur = {
      ...cur,
      pathTemplate: ($("tpl") as HTMLInputElement).value,
      illegalCharReplacement: ($("repl") as HTMLInputElement).value || "_",
      conflictAction: ($("conflict") as HTMLSelectElement).value as any,
      contentTypes: { photo: ($("ct_photo") as HTMLInputElement).checked, file: ($("ct_file") as HTMLInputElement).checked, video: ($("ct_video") as HTMLInputElement).checked },
    };
    await saveSettings(cur);
    $("saved").textContent = "保存しました";
    setTimeout(() => ($("saved").textContent = ""), 2000);
  });
}
init();
