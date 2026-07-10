import { loadSettings } from "../core/settings";
import { renderTemplate, TemplateError } from "../core/template-engine";
import { validatePath } from "../core/path-validator";
import type { RenderContext, Settings } from "../core/types";
import type { EnqueueMessage, EnqueueItem, PostMeta } from "../content/messages";
import { getAllJobs, putJobs, updateJob, findByDownloadId, type JobRecord } from "./job-store";

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
