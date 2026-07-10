import { loadSettings } from "../core/settings";
import { renderTemplate, TemplateError } from "../core/template-engine";
import { validatePath } from "../core/path-validator";
import type { RenderContext, Settings } from "../core/types";
import type { EnqueueMessage, EnqueueItem, PostMeta, ZipPortMessage, ZipPortResult } from "../content/messages";
import { ZIP_PORT_NAME } from "../content/messages";
import { base64ToBytes } from "../core/base64";
import { getAllJobs, putJobs, updateJob, findByDownloadId, removeJobsByPostId, type JobRecord } from "./job-store";

function ctxOf(post: PostMeta, it: EnqueueItem): RenderContext {
  return {
    creator: post.creator, creatorId: post.creatorId, postTitle: post.postTitle, postId: post.postId,
    postedAt: new Date(post.postedAtIso), now: new Date(),
    contentTitle: it.contentTitle, contentId: it.contentId, contentType: it.contentType, plan: it.plan,
    filename: it.filename, ext: it.ext, seq: it.seq, total: it.total,
  };
}

async function handleEnqueue(msg: EnqueueMessage): Promise<{ queued: number; error?: string }> {
  const s: Settings = await loadSettings();
  if (msg.force) {
    await removeJobsByPostId(msg.post.postId);
  }
  const enabled = (t: string) => (s.contentTypes as any)[t] !== false;
  const jobs: JobRecord[] = [];
  const seenPaths = new Set<string>();
  const errors: string[] = [];

  for (const it of msg.items) {
    if (!enabled(it.contentType)) continue;
    if (!it.url) { errors.push(`${it.idemKey}: url 未解決`); continue; }
    let relPath: string;
    try {
      relPath = renderTemplate(s.pathTemplate, ctxOf(msg.post, it), { replacement: s.illegalCharReplacement, segmentMaxLen: s.segmentMaxLen });
    } catch (e) {
      errors.push(e instanceof TemplateError ? `テンプレートエラー: ${e.message}` : String(e));
      break; // テンプレ不正は全体中断
    }
    const v = validatePath(relPath, { fullPathMaxLen: s.fullPathMaxLen, uniquifyHeadroom: s.uniquifyHeadroom, conflictAction: s.conflictAction, segmentMaxLen: s.segmentMaxLen });
    if (!v.ok) { errors.push(`${relPath}: ${v.error}`); continue; }
    if (seenPaths.has(relPath)) { errors.push(`バッチ内パス重複: ${relPath}`); continue; }
    seenPaths.add(relPath);
    jobs.push({ idemKey: it.idemKey, relPath, url: it.url, downloadUri: it.downloadUri, contentType: it.contentType, refetch: it.refetch, state: "pending" });
  }

  if (errors.length) return { queued: 0, error: errors.slice(0, 5).join(" / ") };
  const existing = await getAllJobs();
  const toStart = jobs.filter((j) => {
    const prev = existing[j.idemKey];
    return !(prev && (prev.state === "done" || prev.state === "requested"));
  });
  await putJobs(toStart);
  for (const j of toStart) await startDownload(j, s);
  return { queued: toStart.length };
}

async function startDownload(j: JobRecord, s: Settings): Promise<void> {
  try {
    const downloadId = await chrome.downloads.download({ url: j.url, filename: j.relPath, saveAs: false, conflictAction: s.conflictAction });
    await updateJob(j.idemKey, { state: "requested", downloadId });
  } catch (e) {
    await updateJob(j.idemKey, { state: "error", error: String(e) });
  }
}

// zip 化した photo gallery の DL。content-script は downloads API を持たないため
// ここで Blob 化 + chrome.downloads.download を行う。job-store は通さない
// (dedup/reconcile 対象外の一発勝負。失敗時はユーザーが 🔄 で再実行する)。
//
// zip 本体は Port 経由で start -> chunk* -> end のチャンクとして届く
// (1 メッセージに収めると runtime messaging のサイズ上限で大きい gallery が落ちるため)。
async function finishZipDownload(filename: string, conflictAction: "uniquify" | "overwrite", chunks: Uint8Array<ArrayBuffer>[]): Promise<ZipPortResult> {
  const blob = new Blob(chunks, { type: "application/zip" });
  const blobUrl = URL.createObjectURL(blob);
  try {
    const downloadId = await chrome.downloads.download({
      url: blobUrl, filename, saveAs: false, conflictAction,
    });
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== downloadId) return;
      const cur = delta.state?.current;
      // "in_progress" 段階で revoke すると転送中の大きい zip が中断されうるため、
      // 終端状態(complete/interrupted)になってから revoke する。
      if (cur === "complete" || cur === "interrupted") {
        URL.revokeObjectURL(blobUrl);
        chrome.downloads.onChanged.removeListener(onChanged);
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
    return { queued: 1 };
  } catch (e) {
    // downloads.download 自体が失敗した場合は onChanged が発火しないため、ここで revoke してリークを防ぐ。
    URL.revokeObjectURL(blobUrl);
    return { queued: 0, error: String(e) };
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== ZIP_PORT_NAME) return;
  let filename = "";
  let conflictAction: "uniquify" | "overwrite" = "uniquify";
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  port.onMessage.addListener((msg: ZipPortMessage) => {
    if (msg.kind === "start") {
      filename = msg.filename;
      conflictAction = msg.conflictAction;
    } else if (msg.kind === "chunk") {
      chunks.push(base64ToBytes(msg.data));
    } else if (msg.kind === "end") {
      finishZipDownload(filename, conflictAction, chunks)
        .then((res) => { try { port.postMessage(res); } catch {} })
        .catch((e) => { try { port.postMessage({ queued: 0, error: String(e) } as ZipPortResult); } catch {} });
    }
  });
});


chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.kind === "enqueue") {
    handleEnqueue(msg as EnqueueMessage)
      .then(sendResponse)
      .catch((e) => sendResponse({ queued: 0, error: String(e) }));
    return true;
  }
  return false;
});

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state) return;
  const j = await findByDownloadId(delta.id);
  if (!j) return;
  if (delta.state.current === "complete") await updateJob(j.idemKey, { state: "done" });
  else if (delta.state.current === "interrupted") {
    // photo は署名 URL 失効の可能性 -> needs_page で退避。file は download_uri 安定なので error 記録。
    await updateJob(j.idemKey, { state: j.contentType === "photo" ? "needs_page" : "error", error: "interrupted" });
  }
});

// 起動時 reconcile
(async () => {
  const s = await loadSettings();
  const all = await getAllJobs();
  for (const j of Object.values(all)) {
    if (j.state === "pending") { await startDownload(j, s); continue; }
    if (j.state !== "requested") continue;
    if (j.downloadId == null) { await startDownload(j, s); continue; }
    const [d] = await chrome.downloads.search({ id: j.downloadId });
    if (!d) { await startDownload(j, s); continue; }
    if (d.state === "complete") await updateJob(j.idemKey, { state: "done" });
    else if (d.state === "interrupted") await updateJob(j.idemKey, { state: j.contentType === "photo" ? "needs_page" : "error" });
  }
})();
