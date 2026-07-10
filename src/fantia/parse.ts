import type { PostData, ContentBlock, FileItem, ContentType } from "../core/types";

const VIDEO_EXT = new Set(["mp4", "mov", "m4v", "webm", "avi", "mkv"]);

function extFromUrl(url: string): string {
  const path = url.split("?")[0];
  const base = path.substring(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}
function extFromName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}
function baseNoExt(url: string): string {
  const path = url.split("?")[0];
  const base = path.substring(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

export function parsePost(json: any): PostData {
  const post = json.post;
  const postId = String(post.id);
  const fc = post.fanclub || {};
  const contents: ContentBlock[] = [];

  for (const c of post.post_contents || []) {
    if (c.visible_status && c.visible_status !== "visible") continue;
    const contentId = String(c.id);
    let files: FileItem[] = [];
    let contentType: ContentType = "file";

    if (c.category === "photo_gallery") {
      contentType = "photo";
      const photos = (c.post_content_photos || [])
        .map((ph: any) => ph?.url?.original || ph?.url?.main)
        .filter((u: any): u is string => typeof u === "string");
      files = photos.map((url: string) => ({
        contentType, directUrl: url, filename: baseNoExt(url), ext: extFromUrl(url),
        seq: 0, total: 0, idemKey: "", refetch: { postId, contentId, index: 0 },
      }));
    } else if (c.category === "file") {
      if (c.filename && c.download_uri) {
        const ext = extFromName(c.filename);
        const dot = c.filename.lastIndexOf(".");
        const base = dot > 0 ? c.filename.slice(0, dot) : c.filename;
        contentType = VIDEO_EXT.has(ext) ? "video" : "file";
        files = [{
          contentType, downloadUri: String(c.download_uri), filename: base, ext,
          seq: 0, total: 0, idemKey: "", refetch: { postId, contentId, index: 0 },
        }];
      }
    }

    if (!files.length) continue;
    files.forEach((f, i) => { f.seq = i + 1; f.total = files.length; f.idemKey = `${postId}:${contentId}:${i}`; f.refetch = { postId, contentId, index: i }; });
    contents.push({ contentId, contentTitle: c.title || null, contentType, plan: c.plan?.name ?? null, files });
  }

  return {
    postId, postTitle: post.title || "",
    creator: fc.creator_name || "", creatorId: String(fc.id ?? ""),
    fanclubName: fc.fanclub_name || fc.name || null,
    postedAt: new Date(post.posted_at), contents,
  };
}
