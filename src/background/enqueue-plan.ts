// src/background/enqueue-plan.ts
// SW enqueue の純粋部分(render → validatePath → バッチ内 dedup)。chrome API に
// 触らないため単体テスト対象。downloads.download の実行は service-worker 側。
// Task 6 で DL 前 URL allowlist(spec 変更 B round15 の適用点 a)がここに加わる。
import { renderTemplate, TemplateError } from "../core/template-engine";
import { validatePath } from "../core/path-validator";
import { DOWNLOAD_CONFLICT_ACTION } from "../core/settings";
import type { RenderContext, Settings } from "../core/types";
import type { EnqueueItem, EnqueueMessage, PostMeta } from "../content/messages";

export interface PlannedDownload {
  url: string;
  relPath: string;
}

function ctxOf(post: PostMeta, it: EnqueueItem): RenderContext {
  return {
    creator: post.creator, creatorId: post.creatorId, postTitle: post.postTitle, postId: post.postId,
    postedAt: new Date(post.postedAtIso), now: new Date(),
    contentTitle: it.contentTitle, contentId: it.contentId, contentType: it.contentType, plan: it.plan,
    filename: it.filename, ext: it.ext, seq: it.seq, total: it.total,
  };
}

// アイテム単位の失敗は黙って落とさず errors に積む(統一応答契約)。
export function planEnqueue(msg: EnqueueMessage, s: Settings): { downloads: PlannedDownload[]; errors: string[] } {
  const enabled = (t: string) => (s.contentTypes as Record<string, boolean>)[t] !== false;
  const seenPaths = new Set<string>();
  const errors: string[] = [];
  const downloads: PlannedDownload[] = [];

  for (const it of msg.items) {
    if (!enabled(it.contentType)) continue;
    if (!it.url) { errors.push(`${it.filename || it.contentId}.${it.ext}: url 未解決`); continue; }
    let relPath: string;
    try {
      relPath = renderTemplate(s.pathTemplate, ctxOf(msg.post, it), { replacement: s.illegalCharReplacement, segmentMaxLen: s.segmentMaxLen });
    } catch (e) {
      errors.push(e instanceof TemplateError ? `テンプレートエラー: ${e.message}` : String(e));
      break; // テンプレ不正は全 item が同じ理由で失敗するため全体中断
    }
    const v = validatePath(relPath, { fullPathMaxLen: s.fullPathMaxLen, uniquifyHeadroom: s.uniquifyHeadroom, conflictAction: DOWNLOAD_CONFLICT_ACTION, segmentMaxLen: s.segmentMaxLen });
    if (!v.ok) { errors.push(`${relPath}: ${v.error}`); continue; }
    if (seenPaths.has(relPath)) { errors.push(`バッチ内パス重複: ${relPath}`); continue; }
    seenPaths.add(relPath);
    downloads.push({ url: it.url, relPath });
  }
  return { downloads, errors };
}
