export type JobState = "pending" | "requested" | "done" | "error" | "needs_page";
export interface JobRecord {
  idemKey: string; relPath: string; url: string; downloadUri?: string; contentType: string;
  refetch: { postId: string; contentId: string; index: number };
  state: JobState; downloadId?: number; error?: string;
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
