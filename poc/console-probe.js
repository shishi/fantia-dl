// fantia-dl Phase-0 PoC probe (§12-1)
// 使い方: ログイン済みで Fantia の投稿ページ (fantia.jp/posts/XXXX) を開き、
// DevTools Console に貼り付けて実行。出力 JSON を報告する。
// 出力の URL はクエリ文字列を redact 済み(署名やトークンは含まれない)。
(async () => {
  const out = { probeVersion: 1, page: location.origin + location.pathname };
  const postId = (location.pathname.match(/posts\/(\d+)/) || [])[1] || null;
  out.postId = postId;
  const csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || null;
  out.csrfMetaPresent = !!csrf;

  const redact = (u) => {
    try {
      const x = new URL(u, location.origin);
      const qk = [...x.searchParams.keys()];
      return x.origin + x.pathname + (qk.length ? "?<params:" + qk.join(",") + ">" : "");
    } catch { return "(unparsable)"; }
  };

  const probe = async (headers) => {
    try {
      const r = await fetch(`/api/v1/posts/${postId}`, { credentials: "include", headers });
      let body = null;
      try { body = await r.clone().json(); } catch (e) {}
      return { status: r.status, ok: r.ok, hasJson: !!body, body };
    } catch (e) { return { error: String(e) }; }
  };

  if (!postId) { console.log(JSON.stringify(out, null, 2)); return; }

  const withCsrf = await probe(csrf
    ? { "X-CSRF-Token": csrf, "X-Requested-With": "XMLHttpRequest" }
    : { "X-Requested-With": "XMLHttpRequest" });
  const bare = await probe({});

  out.withCsrf = { status: withCsrf.status, ok: withCsrf.ok, hasJson: withCsrf.hasJson, error: withCsrf.error || null };
  out.bare = { status: bare.status, ok: bare.ok, hasJson: bare.hasJson, error: bare.error || null };

  const root = (withCsrf.body || bare.body) || null;
  out.rootKeys = root ? Object.keys(root) : null;
  const post = root && root.post;

  if (post) {
    const contents = post.post_contents || [];
    out.postSummary = {
      postKeys: Object.keys(post),
      title: post.title || null,
      postedAt: post.posted_at || null,
      convertedAt: post.converted_at || null,
      fanclub: post.fanclub ? {
        keys: Object.keys(post.fanclub),
        id: post.fanclub.id,
        creatorName: post.fanclub.creator_name || null,
        fanclubName: post.fanclub.fanclub_name || post.fanclub.name || null
      } : null,
      contentsCount: contents.length,
      contents: contents.map((c) => ({
        id: c.id,
        category: c.category || null,
        title: c.title || null,
        keys: Object.keys(c),
        visibleStatus: c.visible_status || null,
        plan: c.plan ? { name: c.plan.name || null, price: c.plan.price } : null,
        photoCount: (c.post_content_photos || []).length,
        firstPhoto: (c.post_content_photos || [])[0] ? {
          keys: Object.keys(c.post_content_photos[0]),
          urlKeys: c.post_content_photos[0].url ? Object.keys(c.post_content_photos[0].url) : null,
          urlSample: (() => {
            const u = c.post_content_photos[0].url;
            if (!u) return null;
            const v = u.original || u.main || Object.values(u)[0];
            return v ? redact(v) : null;
          })()
        } : null,
        downloadUri: c.download_uri ? redact(c.download_uri) : null,
        filename: c.filename || null,
        embedUrl: c.embed_url ? redact(c.embed_url) : null,
        commentCount: undefined
      }))
    };
  } else {
    out.postSummary = null;
    out.note = "post not present in JSON (check auth/status)";
  }
  console.log("=== fantia-dl probe result ===");
  console.log(JSON.stringify(out, null, 2));
})();
