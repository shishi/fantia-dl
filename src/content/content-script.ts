import { parsePost } from "../fantia/parse";
import type { ContentBlock, FileItem, PostData, RenderContext, Settings } from "../core/types";
import type { DownloadResult, EnqueueItem, EnqueueMessage, EnqueueResponse, PostMeta, ZipPortResult, ZipStartMessage, ZipChunkMessage, ZipEndMessage } from "./messages";
import { ZIP_PORT_NAME } from "./messages";
import { loadSettings, DOWNLOAD_CONFLICT_ACTION } from "../core/settings";
import { renderTemplate, TemplateError } from "../core/template-engine";
import { validatePath } from "../core/path-validator";
import { bytesToBase64 } from "../core/base64";
import { fetchPost, resolveUrl, fetchBinary } from "./fantia-api";
import { postIdFromPathname, postIdFromHref, isFanclubPostListPage, selectPostAnchorIndicesToInject, shouldHandleDlClick, beginDownloadAttempt, endDownloadAttempt } from "./dom-helpers";
import { createSerialQueue, zipAsync, collectZipSources, ZIP_FALLBACK_NOTICE } from "./zip-support";

// --- zip 転送(Port: start -> chunk* -> end) --------------------------------
const ZIP_CHUNK_BYTES = 4 * 1024 * 1024; // 1 メッセージ上限を避けるためのチャンクサイズ

function sendZipOverPort(filename: string, bytes: Uint8Array): Promise<ZipPortResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: ZipPortResult) => { if (!settled) { settled = true; resolve(r); } };
    const port = chrome.runtime.connect({ name: ZIP_PORT_NAME });
    port.onMessage.addListener((res: ZipPortResult) => { finish(res); port.disconnect(); });
    port.onDisconnect.addListener(() => finish({ queued: 0, error: "background との接続が切れました" }));
    port.postMessage({ kind: "start", filename, totalBytes: bytes.byteLength } as ZipStartMessage);
    for (let off = 0; off < bytes.byteLength; off += ZIP_CHUNK_BYTES) {
      const slice = bytes.subarray(off, Math.min(off + ZIP_CHUNK_BYTES, bytes.byteLength));
      port.postMessage({ kind: "chunk", data: bytesToBase64(slice) } as ZipChunkMessage);
    }
    port.postMessage({ kind: "end" } as ZipEndMessage);
  });
}

// --- zip 組み立て(直列化 + バジェット + フォールバック判定。Task 7 と同一実装) ---
type GalleryZipResult = { ok: true } | { ok: false; reason: string };
const enqueueZipJob = createSerialQueue();

function tryZipGallery(block: ContentBlock, post: PostData, s: Settings): Promise<GalleryZipResult> {
  return enqueueZipJob(() => tryZipGalleryInner(block, post, s))
    .catch((e) => ({ ok: false as const, reason: String(e) }));
}

async function tryZipGalleryInner(block: ContentBlock, post: PostData, s: Settings): Promise<GalleryZipResult> {
  const files = block.files.filter((f): f is FileItem & { directUrl: string } => !!f.directUrl);
  if (files.length === 0) return { ok: false, reason: "directUrl のある photo がありません" };

  // ソース収集: 各 URL の allowlist 検証(適用点 b)・件数上限・残バジェットの
  // maxBytes 伝搬は collectZipSources(単体テスト対象)が行う。
  const collected = await collectZipSources(files.map((f) => f.directUrl), (url, opts) => fetchBinary(url, opts));
  if (!collected.ok) return { ok: false, reason: collected.reason };

  const entries: Record<string, Uint8Array> = {};
  const usedNames = new Set<string>();
  const now = new Date();
  for (const f of files) {
    const buf = collected.buffers.get(f.directUrl);
    if (!buf) return { ok: false, reason: `zip ソース欠落: ${f.directUrl}` };

    const ctx: RenderContext = {
      creator: post.creator, creatorId: post.creatorId,
      postTitle: post.postTitle, postId: post.postId,
      postedAt: post.postedAt, now,
      contentTitle: block.contentTitle ?? "", contentId: block.contentId,
      contentType: f.contentType, plan: block.plan ?? "",
      filename: f.filename ?? "", ext: f.ext, seq: f.seq, total: f.total,
    };
    let entryPath: string;
    try {
      entryPath = renderTemplate(s.zipEntryTemplate, ctx,
        { replacement: s.illegalCharReplacement, segmentMaxLen: s.segmentMaxLen });
    } catch (e) {
      return { ok: false, reason: e instanceof TemplateError ? `テンプレートエラー: ${e.message}` : String(e) };
    }
    if (usedNames.has(entryPath)) {
      const dot = entryPath.lastIndexOf(".");
      const stem = dot > 0 ? entryPath.slice(0, dot) : entryPath;
      const ext = dot > 0 ? entryPath.slice(dot) : "";
      let n = 2;
      let candidate = `${stem} (${n})${ext}`;
      while (usedNames.has(candidate)) { n++; candidate = `${stem} (${n})${ext}`; }
      entryPath = candidate;
    }
    const pv = validatePath(entryPath, { fullPathMaxLen: s.fullPathMaxLen, uniquifyHeadroom: s.uniquifyHeadroom, conflictAction: "overwrite", segmentMaxLen: s.segmentMaxLen });
    if (!pv.ok) return { ok: false, reason: `zip entry 名不正: ${entryPath}: ${pv.error}` };
    usedNames.add(entryPath);
    entries[entryPath] = buf;
  }

  const firstFile = files[0];
  const zipCtx: RenderContext = {
    creator: post.creator, creatorId: post.creatorId,
    postTitle: post.postTitle, postId: post.postId,
    postedAt: post.postedAt, now,
    contentTitle: block.contentTitle ?? "", contentId: block.contentId,
    contentType: "photo", plan: block.plan ?? "",
    filename: firstFile?.filename ?? "", ext: "zip",
    seq: 1, total: 1,
  };
  let zipPath: string;
  try {
    zipPath = renderTemplate(s.zipPathTemplate, zipCtx,
      { replacement: s.illegalCharReplacement, segmentMaxLen: s.segmentMaxLen });
  } catch (e) {
    return { ok: false, reason: e instanceof TemplateError ? `テンプレートエラー: ${e.message}` : String(e) };
  }
  const zv = validatePath(zipPath, { fullPathMaxLen: s.fullPathMaxLen, uniquifyHeadroom: s.uniquifyHeadroom, conflictAction: DOWNLOAD_CONFLICT_ACTION, segmentMaxLen: s.segmentMaxLen });
  if (!zv.ok) return { ok: false, reason: `zip ファイル名不正: ${zipPath}: ${zv.error}` };

  let zipped: Uint8Array;
  try {
    zipped = await zipAsync(entries);
  } catch (e) {
    return { ok: false, reason: `zip 圧縮失敗: ${String(e)}` };
  }
  const r = await sendZipOverPort(zipPath, zipped);
  if (r.queued !== 1) return { ok: false, reason: r.error ?? "zip の enqueue に失敗" };
  return { ok: true };
}

// --- DL 本体(投稿ページ・一覧カード共通のフロー) ----------------------------
// in-flight ガード(spec round25)のコア判定は dom-helpers の
// beginDownloadAttempt / endDownloadAttempt(純粋関数・単体テスト済み)。
// ここはタブ内・揮発の Set を握って配線するだけ(永続化しない = dedup の復活ではない)。
const inFlightPostIds = new Set<string>();

async function runDownloadFor(postId: string): Promise<DownloadResult | null> {
  if (!beginDownloadAttempt(inFlightPostIds, postId)) return null; // 多重起動は無視
  try {
    return await runDownloadInner(postId);
  } finally {
    endDownloadAttempt(inFlightPostIds, postId);
  }
}

async function runDownloadInner(postId: string): Promise<DownloadResult | null> {
  const fetched = await fetchPost(postId);
  if (!fetched.ok) { alert(`[fantia-dl] 取得失敗: ${fetched.error}`); return null; }
  const post = parsePost(fetched.json);
  const s = await loadSettings();

  const meta: PostMeta = {
    creator: post.creator, creatorId: post.creatorId, postTitle: post.postTitle,
    postId: post.postId, postedAtIso: post.postedAt.toISOString(),
  };
  const items: EnqueueItem[] = [];
  let zipQueued = 0;
  const errors: string[] = [];
  const notices: string[] = [];
  for (const c of post.contents) {
    if (c.contentType === "photo" && c.files.length >= 2 && s.zipGalleries && s.contentTypes.photo) {
      const zr = await tryZipGallery(c, post, s);
      if (zr.ok) { zipQueued += 1; continue; }
      // enqueue 前の zip 失敗 → このギャラリーを個別ファイル DL へフォールバック
      notices.push(`${ZIP_FALLBACK_NOTICE}(${zr.reason})`);
    }
    for (const f of c.files) {
      let url = f.directUrl ?? "";
      if (!url && f.downloadUri) {
        const resolved = await resolveUrl(f.downloadUri);
        if (!resolved.ok) { errors.push(`${f.filename ?? ""}.${f.ext}: URL 解決失敗(${resolved.error})`); continue; }
        url = resolved.url;
      }
      items.push({
        contentId: c.contentId, contentTitle: c.contentTitle ?? "",
        contentType: f.contentType, plan: c.plan ?? "", filename: f.filename ?? "",
        ext: f.ext, seq: f.seq, total: f.total, url,
      });
    }
  }

  let queued = zipQueued;
  if (items.length > 0) {
    const res = (await chrome.runtime.sendMessage({ kind: "enqueue", post: meta, items, pageUrl: location.href } satisfies EnqueueMessage)) as EnqueueResponse | undefined;
    if (!res) errors.push("background から応答がありません");
    else { queued += res.queued; errors.push(...res.errors); }
  }
  if (errors.length) alert(`[fantia-dl] エラー: ${errors.join(" / ")}`);
  if (notices.length) alert(`[fantia-dl] お知らせ:\n${notices.join("\n")}`);
  return { queued, errors, notices };
}

// --- ボタン共通 ---------------------------------------------------------------
function styleBtn(b: HTMLButtonElement, small = false) {
  if (small) {
    // カード上に重なる小ボタン: 明るいサムネでも暗いサムネでも視認できるよう
    // 濃い半透明背景 + 白文字 + 影でコントラストを確保(白背景の小ボタンは
    // サムネイルに埋没する — fanbox-dl の実運用での見落とし報告に基づく知見)。
    Object.assign(b.style, {
      padding: "4px 10px", borderRadius: "6px", cursor: "pointer",
      fontSize: "14px", fontWeight: "700", border: "1px solid rgba(255,255,255,.65)",
      background: "rgba(0,0,0,.72)", color: "#fff", lineHeight: "1.4",
      boxShadow: "0 1px 5px rgba(0,0,0,.5)",
    });
  } else {
    Object.assign(b.style, {
      padding: "6px 12px", borderRadius: "6px", cursor: "pointer", fontSize: "14px",
    });
  }
}

function swapText(b: HTMLButtonElement, temp: string, ms = 2500) {
  const orig = b.dataset.origText ?? b.textContent ?? "";
  if (!b.dataset.origText) b.dataset.origText = orig;
  b.textContent = temp;
  setTimeout(() => { b.textContent = b.dataset.origText || orig; b.disabled = false; }, ms);
}

// postId はクリック時に取得する(getPostId)。一覧カードはカード固有の postId を
// クロージャで返し(カードは postId とボタンが 1:1)、投稿ページボタンはクリック
// 時点の location.pathname から読む。トリガが違うだけで DL フローは同一。
function makeDlButton(label: string, small: boolean, getPostId: () => string | null): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button"; b.textContent = label; b.title = "この投稿をダウンロード";
  styleBtn(b, small);
  b.addEventListener("click", (ev) => {
    // 信頼クリックゲート(spec round18): 合成クリックは無視する
    if (!shouldHandleDlClick(ev)) return;
    ev.preventDefault(); ev.stopPropagation(); // カード遷移を抑止
    const postId = getPostId();
    if (!postId || inFlightPostIds.has(postId)) return;
    b.disabled = true;
    runDownloadFor(postId).then((r) => {
      if (r) swapText(b, `⬇ ${r.queued} 件開始`);
      else b.disabled = false;
    }).catch(() => { b.disabled = false; });
  });
  return b;
}

// --- 投稿ページ: h1.post-title 直後(fallback 固定右下) -----------------------
// (配置は現行踏襲。h1.post-title は安定クラスのため fanbox-dl 式の日付行探索は不要 — spec YAGNI)
function findTitleAnchor(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>(".the-post .post-header h1.post-title") ||
    document.querySelector<HTMLElement>(".post-header h1.post-title") ||
    document.querySelector<HTMLElement>("h1.post-title")
  );
}

function whenTitleReady(cb: (title: HTMLElement | null) => void, timeoutMs = 5000): void {
  const found = findTitleAnchor();
  if (found) { cb(found); return; }
  const obs = new MutationObserver(() => {
    const t = findTitleAnchor();
    if (t) {
      obs.disconnect();
      clearTimeout(tid);
      cb(t);
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
  const tid = setTimeout(() => { obs.disconnect(); cb(null); }, timeoutMs);
}

function addPostPageButton() {
  if (document.getElementById("fdl-btn-container")) return;

  const container = document.createElement("div");
  container.id = "fdl-btn-container";
  Object.assign(container.style, { display: "flex", gap: "8px", margin: "8px 0" });

  const btn = makeDlButton("⬇ fantia-dl", false, () => postIdFromPathname(location.pathname));
  btn.id = "fdl-btn";
  container.appendChild(btn);

  whenTitleReady((title) => {
    if (document.getElementById("fdl-btn-container") && document.getElementById("fdl-btn-container") !== container) return;
    if (title && title.parentElement) {
      title.parentElement.insertBefore(container, title.nextSibling);
    } else {
      Object.assign(container.style, {
        position: "fixed", right: "16px", bottom: "16px", zIndex: "99999",
      });
      document.body.appendChild(container);
    }
  });
}

// --- 一覧ページ: 各カードに ⬇ --------------------------------------------------
// 注入ガードは「ボタン要素の実在」ベース(anchor 側マーカー不使用。fanbox-dl 実証
// パターン): ボタン自身に data-fdl-for={postId} を記録し、「既にあるか」は走査ごとに
// 現在の DOM に実在するボタンを数え上げて判定する。ボタンノードが消えれば次回走査で
// 自動的に「無い」ことになり、マーカーと実体の乖離が構造的に起きない。
const INJECTED_BUTTON_SELECTOR = "[data-fdl-for]";

function injectListButtons() {
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/posts/"]'));
  const postIds = anchors.map((a) => postIdFromHref(a.getAttribute("href") || ""));

  // stale 検出: host(anchor の親)が再利用され href の postId だけ差し替わった場合、
  // host に残る既存ボタンは古い postId を束縛したまま。現在の postId と食い違う
  // ボタンはここで除去する(":scope >" で host の直接の子だけを見る — 深い探索だと
  // 入れ子 anchor 構造で別カードのボタンを stale と誤判定して除去してしまう)。
  for (let i = 0; i < anchors.length; i++) {
    const postId = postIds[i];
    if (!postId) continue;
    const host = anchors[i].parentElement ?? anchors[i];
    const existingBtn = host.querySelector<HTMLElement>(`:scope > ${INJECTED_BUTTON_SELECTOR}`);
    if (existingBtn && existingBtn.dataset.fdlFor && existingBtn.dataset.fdlFor !== postId) {
      existingBtn.remove();
    }
  }

  const alreadyInjectedPostIds = new Set(
    Array.from(document.querySelectorAll<HTMLElement>(INJECTED_BUTTON_SELECTOR))
      .map((el) => el.dataset.fdlFor)
      .filter((id): id is string => !!id)
  );
  const indices = selectPostAnchorIndicesToInject(postIds, alreadyInjectedPostIds);
  for (const i of indices) {
    const anchor = anchors[i];
    const postId = postIds[i];
    if (!postId) continue;
    const host = anchor.parentElement ?? anchor;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    const btn = makeDlButton("⬇", true, () => postId);
    btn.dataset.fdlFor = postId; // このボタンがどの postId 用かを記録(実在ベースの dedup に使う)
    // in-flight 中の postId の再注入は disabled で生成(spec round25: 再レンダリングで
    // disabled なノードごと消えた場合に新品有効ボタンが重複クリックを許すのを防ぐ)
    if (inFlightPostIds.has(postId)) btn.disabled = true;
    Object.assign(btn.style, { position: "absolute", top: "6px", right: "6px", zIndex: "9999" });
    host.appendChild(btn);
  }
}

// --- watch --------------------------------------------------------------------
// fantia は Rails のフルロード遷移が基本のため、1s interval + MutationObserver で
// 無限スクロール・動的追加も拾える(spec 変更 B)。
function sync() {
  if (postIdFromPathname(location.pathname)) addPostPageButton();
  if (isFanclubPostListPage(location.pathname)) injectListButtons();
}

function watch() {
  setInterval(sync, 1000);
  new MutationObserver(() => {
    if (isFanclubPostListPage(location.pathname)) injectListButtons();
  }).observe(document.body, { childList: true, subtree: true });
  sync();
}

watch();
