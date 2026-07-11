export type JobState = "pending" | "requested" | "done" | "error" | "needs_page";
export interface JobRecord {
  idemKey: string; relPath: string; url: string; downloadUri?: string; contentType: string;
  refetch: { postId: string; contentId: string; index: number };
  state: JobState; downloadId?: number; error?: string; doneAt?: number;
}
const KEY = "jobs";
export async function getAllJobs(): Promise<Record<string, JobRecord>> {
  const r = await chrome.storage.local.get(KEY);
  return (r?.[KEY] as Record<string, JobRecord>) ?? {};
}
export async function putJobs(jobs: JobRecord[]): Promise<void> {
  const all = await getAllJobs();
  for (const j of jobs) all[j.idemKey] = j;
  await chrome.storage.local.set({ [KEY]: all });
}
export async function updateJob(idemKey: string, patch: Partial<JobRecord>): Promise<void> {
  const all = await getAllJobs();
  if (all[idemKey]) { all[idemKey] = { ...all[idemKey], ...patch }; await chrome.storage.local.set({ [KEY]: all }); }
}
export async function findByDownloadId(id: number): Promise<JobRecord | undefined> {
  return Object.values(await getAllJobs()).find((j) => j.downloadId === id);
}
export async function removeJobsByPostId(postId: string): Promise<void> {
  const all = await getAllJobs();
  const keep: Record<string, JobRecord> = {};
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith(`${postId}:`)) keep[k] = v;
  }
  await chrome.storage.local.set({ [KEY]: keep });
}

// state: "done" のジョブは同じ投稿の再ダウンロード判定 (dedup) に使われるが、
// 際限なく chrome.storage.local に溜まり続けると 10MB 上限を圧迫する。
// doneAt から maxAgeMs 以上経過した done ジョブだけを間引く。
// doneAt を持たない (この変更より前に書かれた) レガシー done ジョブは対象外
// のまま残り続ける — 手動クリアでしか消せないが、誤って寿命を延ばすよりは安全。
export async function sweepOldDoneJobs(maxAgeMs: number, now = Date.now()): Promise<number> {
  const all = await getAllJobs();
  let removed = 0;
  for (const [k, v] of Object.entries(all)) {
    if (v.state === "done" && typeof v.doneAt === "number" && now - v.doneAt > maxAgeMs) {
      delete all[k];
      removed++;
    }
  }
  if (removed > 0) await chrome.storage.local.set({ [KEY]: all });
  return removed;
}

export async function clearAllJobs(): Promise<void> {
  await chrome.storage.local.set({ [KEY]: {} });
}
