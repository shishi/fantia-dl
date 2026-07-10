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
  it("file(.mkv) も video として解析する", () => {
    const json = {
      post: {
        id: 4140986,
        title: "進捗10",
        posted_at: "2026-07-08T10:00:00+09:00",
        fanclub: { id: 999, creator_name: "blendy", fanclub_name: "テストFC" },
        post_contents: [
          {
            id: 7564700, title: "", category: "file", visible_status: "visible",
            plan: { name: "無料プラン", price: 0 },
            filename: "進捗10F.mkv",
            download_uri: "/posts/4140986/download/7564700",
          },
        ],
      },
    };
    const p = parsePost(json);
    const f = p.contents[0].files[0];
    expect(p.contents[0].contentType).toBe("video");
    expect(f.ext).toBe("mkv");
  });
  it("file(.zip) は video ではなく file として解析する", () => {
    const json = {
      post: {
        id: 4140987,
        title: "進捗11",
        posted_at: "2026-07-08T10:00:00+09:00",
        fanclub: { id: 999, creator_name: "blendy", fanclub_name: "テストFC" },
        post_contents: [
          {
            id: 7564701, title: "", category: "file", visible_status: "visible",
            plan: { name: "無料プラン", price: 0 },
            filename: "資料11.zip",
            download_uri: "/posts/4140987/download/7564701",
          },
        ],
      },
    };
    const p = parsePost(json);
    const f = p.contents[0].files[0];
    expect(p.contents[0].contentType).toBe("file");
    expect(f.ext).toBe("zip");
  });
  it("visible だが post_content_photos が空の photo_gallery はスキップする", () => {
    const json = {
      post: {
        id: 4140988,
        title: "進捗12",
        posted_at: "2026-07-08T10:00:00+09:00",
        fanclub: { id: 999, creator_name: "blendy", fanclub_name: "テストFC" },
        post_contents: [
          {
            id: 7564702, title: "", category: "photo_gallery", visible_status: "visible",
            plan: { name: "無料プラン", price: 0 },
            post_content_photos: [],
          },
        ],
      },
    };
    const p = parsePost(json);
    expect(p.contents).toHaveLength(0);
  });
});
