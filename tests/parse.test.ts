import { parsePost } from "../src/fantia/parse";
import photoJson from "./fixtures/post-photo.json";
import fileJson from "./fixtures/post-file.json";

describe("parsePost", () => {
  it("photo_gallery を解析する", () => {
    const p = parsePost(photoJson);
    expect(p.postId).toBe("1234567");
    expect(p.creator).toBe("sample_creator");
    expect(p.creatorId).toBe("1234");
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
    expect(c.files[0].idemKey).toBe("1234567:42:0");
  });
  it("file(.mp4) を video として解析する", () => {
    const p = parsePost(fileJson);
    const f = p.contents[0].files[0];
    expect(p.contents[0].contentType).toBe("video");
    expect(f.filename).toBe("video_a");
    expect(f.ext).toBe("mp4");
    expect(f.downloadUri).toBe("/posts/2345678/download/43");
    expect(f.total).toBe(1);
  });
  it("file(.mkv) も video として解析する", () => {
    const json = {
      post: {
        id: 3456789,
        title: "サンプル動画10",
        posted_at: "2026-07-08T10:00:00+09:00",
        fanclub: { id: 5678, creator_name: "video_creator", fanclub_name: "サンプルクラブ" },
        post_contents: [
          {
            id: 44, title: "", category: "file", visible_status: "visible",
            plan: { name: "無料プラン", price: 0 },
            filename: "video_b.mkv",
            download_uri: "/posts/3456789/download/44",
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
        id: 3456790,
        title: "サンプル資料11",
        posted_at: "2026-07-08T10:00:00+09:00",
        fanclub: { id: 5678, creator_name: "video_creator", fanclub_name: "サンプルクラブ" },
        post_contents: [
          {
            id: 45, title: "", category: "file", visible_status: "visible",
            plan: { name: "無料プラン", price: 0 },
            filename: "archive_a.zip",
            download_uri: "/posts/3456790/download/45",
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
        id: 3456791,
        title: "サンプル投稿12",
        posted_at: "2026-07-08T10:00:00+09:00",
        fanclub: { id: 5678, creator_name: "video_creator", fanclub_name: "サンプルクラブ" },
        post_contents: [
          {
            id: 46, title: "", category: "photo_gallery", visible_status: "visible",
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
