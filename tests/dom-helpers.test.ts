import { postIdFromPathname, postIdFromHref, isFanclubPostListPage, selectPostAnchorIndicesToInject, shouldHandleDlClick, beginDownloadAttempt, endDownloadAttempt } from "../src/content/dom-helpers";

describe("postIdFromPathname", () => {
  it("/posts/{id} から抽出(末尾スラッシュ許容)", () => {
    expect(postIdFromPathname("/posts/1234567")).toBe("1234567");
    expect(postIdFromPathname("/posts/1234567/")).toBe("1234567");
  });
  it("投稿ページ以外は null", () => {
    expect(postIdFromPathname("/")).toBeNull();
    expect(postIdFromPathname("/fanclubs/123/posts")).toBeNull();
    expect(postIdFromPathname("/posts/abc")).toBeNull();
    expect(postIdFromPathname("/mypage/posts/123")).toBeNull();
  });
});

describe("postIdFromHref", () => {
  it("相対 / 絶対どちらの href からも postId を取る", () => {
    expect(postIdFromHref("/posts/1234567")).toBe("1234567");
    expect(postIdFromHref("https://fantia.jp/posts/1234567")).toBe("1234567");
  });
  it("外部ホストの /posts/{id} は null(一覧ページの外部リンク誤認防止)", () => {
    expect(postIdFromHref("https://example.com/posts/123")).toBeNull();
    expect(postIdFromHref("https://twitter.com/posts/456")).toBeNull();
  });
  it("fantia.jp のサブドメインも null(spec: 絶対 URL は fantia.jp ホストのみ許可。投稿ページは fantia.jp 直下にしか無い)", () => {
    expect(postIdFromHref("https://sub.fantia.jp/posts/123")).toBeNull();
    expect(postIdFromHref("https://c.fantia.jp/posts/123")).toBeNull();
  });
  it("投稿リンクでない href は null", () => {
    expect(postIdFromHref("/fanclubs/123")).toBeNull();
    expect(postIdFromHref("#")).toBeNull();
  });
});

describe("isFanclubPostListPage(/fanclubs/{id}/posts のみ true)", () => {
  it("投稿一覧は true(末尾スラッシュ許容。?page=N はクエリのため pathname 判定に影響しない)", () => {
    expect(isFanclubPostListPage("/fanclubs/123/posts")).toBe(true);
    expect(isFanclubPostListPage("/fanclubs/123/posts/")).toBe(true);
  });
  it("ファンクラブトップ・ホーム・投稿詳細・下位パスは false", () => {
    expect(isFanclubPostListPage("/fanclubs/123")).toBe(false);
    expect(isFanclubPostListPage("/")).toBe(false);
    expect(isFanclubPostListPage("/posts/123")).toBe(false);
    expect(isFanclubPostListPage("/fanclubs/123/posts/456")).toBe(false);
  });
});

describe("selectPostAnchorIndicesToInject(postId 単位 dedup。fanbox-dl と同一契約)", () => {
  it("同一 postId の複数 anchor は文書順で最後の 1 件だけを選ぶ(入れ子 anchor 対策)", () => {
    expect(selectPostAnchorIndicesToInject(["1", "1", "2"], new Set())).toEqual([1, 2]);
  });
  it("postId を抽出できない(null の)anchor は無視する", () => {
    expect(selectPostAnchorIndicesToInject([null, "1"], new Set())).toEqual([1]);
  });
  it("既にボタンが実在する postId には何も選ばない", () => {
    expect(selectPostAnchorIndicesToInject(["1", "1"], new Set(["1"]))).toEqual([]);
  });
  it("ボタンが DOM から消えていれば(集計 Set に居なければ)再注入する", () => {
    expect(selectPostAnchorIndicesToInject(["1"], new Set())).toEqual([0]);
  });
});

describe("shouldHandleDlClick(信頼クリックゲート: 合成クリックで拡張の権限を無断駆動させない)", () => {
  it("実ユーザー操作(isTrusted: true)は処理する", () => {
    expect(shouldHandleDlClick({ isTrusted: true })).toBe(true);
  });
  it("スクリプト合成クリック(isTrusted: false)は無視する", () => {
    expect(shouldHandleDlClick({ isTrusted: false })).toBe(false);
  });
});

describe("beginDownloadAttempt / endDownloadAttempt(in-flight ガードのコア判定。spec round25)", () => {
  it("未登録の postId は true を返し Set に追加する", () => {
    const s = new Set<string>();
    expect(beginDownloadAttempt(s, "1")).toBe(true);
    expect(s.has("1")).toBe(true);
  });
  it("in-flight 中の多重起動は false(dedup 撤去後の同一タブ内二重 DL 防止)", () => {
    const s = new Set<string>();
    beginDownloadAttempt(s, "1");
    expect(beginDownloadAttempt(s, "1")).toBe(false);
    expect(s.size).toBe(1);
  });
  it("end 後は同じ postId を再び開始できる(復旧はユーザーの再クリック)", () => {
    const s = new Set<string>();
    beginDownloadAttempt(s, "1");
    endDownloadAttempt(s, "1");
    expect(s.has("1")).toBe(false);
    expect(beginDownloadAttempt(s, "1")).toBe(true);
  });
  it("別 postId の in-flight には影響しない", () => {
    const s = new Set<string>();
    beginDownloadAttempt(s, "1");
    expect(beginDownloadAttempt(s, "2")).toBe(true);
  });
});
