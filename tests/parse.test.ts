import { parsePost } from "../src/fantia/parse";
import photoJson from "./fixtures/post-photo.json";
import fileJson from "./fixtures/post-file.json";

describe("parsePost", () => {
  it("photo_gallery を解析する", () => {
    const p = parsePost(photoJson);
    expect(p.postId).toBe("4135924");
    expect(p.creator).toBe("C-Low");
    expect(p.creatorId).toBe("1736");
    expect(p.postedAt.getFullYear()).toBe(2026);
    expect(p.contents).toHaveLength(1); // catchable はスキップ
    const c = p.contents[0];
    expect(c.contentType).toBe("photo");
    expect(c.plan).toBe("無料プラン");
    expect(c.files).toHaveLength(2);
    expect(c.files[0].directUrl).toContain("aaa.png");
    expect(c.files[0].ext).toBe("png");
    expect(c.files[0].filename).toBe("aaa");
    expect(c.files[0].seq).toBe(1);
    expect(c.files[1].seq).toBe(2);
    expect(c.files[0].total).toBe(2);
    expect(c.files[0].idemKey).toBe("4135924:7554167:0");
  });
  it("file(.mp4) を video として解析する", () => {
    const p = parsePost(fileJson);
    const f = p.contents[0].files[0];
    expect(p.contents[0].contentType).toBe("video");
    expect(f.filename).toBe("進捗9F");
    expect(f.ext).toBe("mp4");
    expect(f.downloadUri).toBe("/posts/4140985/download/7564699");
    expect(f.total).toBe(1);
  });
});
