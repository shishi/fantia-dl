// src/content/dom-helpers.ts
// content script のボタン配置に使う純粋関数(DOM 非依存・単体テスト対象)。
// fanbox-dl の dom-helpers.ts を fantia の URL 構造に翻案。

export function postIdFromPathname(pathname: string): string | null {
  return pathname.match(/^\/posts\/(\d+)(?:$|\/)/)?.[1] ?? null;
}

// href(相対 or 絶対)から postId を抽出。投稿リンクでなければ null。
// 絶対 URL は fantia.jp ホスト**完全一致**のみ許可(spec 変更 B の文言どおり。
// 投稿ページは fantia.jp 直下にしか無く、サブドメイン(CDN 等)への /posts/ リンクを
// 投稿と誤認しないため。外部リンク誤認防止も兼ねる)。
export function postIdFromHref(href: string): string | null {
  try {
    const u = new URL(href, "https://fantia.jp");
    if (u.host !== "fantia.jp") return null;
    return postIdFromPathname(u.pathname);
  } catch {
    return null;
  }
}

// ファンクラブ投稿一覧か。対象は /fanclubs/{id}/posts のみ(末尾スラッシュ許容)。
// ファンクラブトップ /fanclubs/{id}・ホーム・検索は対象外(spec YAGNI)。
// ページング ?page=N はクエリのため pathname 判定に影響しない。
export function isFanclubPostListPage(pathname: string): boolean {
  return /^\/fanclubs\/\d+\/posts\/?$/.test(pathname);
}

// postId 単位の注入 dedup(fanbox-dl と同一契約)。
// 「既にボタンがあるか」は anchor 側マーカーではなく、呼び出し側が実際に生きている
// ボタン要素(data-fdl-for)を数え上げた結果として渡す — マーカーと実体が別ノードに
// あると DOM の部分再レンダリングで乖離するため、独立した状態を一切持たない。
// 同一 postId の複数 anchor は文書順で最後を採用する(入れ子 anchor では祖先が先に
// querySelectorAll に現れるため、「最後」を選べば常により深い=カード固有の方になる)。
export function selectPostAnchorIndicesToInject(postIds: (string | null)[], alreadyInjectedPostIds: Set<string>): number[] {
  const lastIndexForId = new Map<string, number>();
  for (let i = 0; i < postIds.length; i++) {
    const id = postIds[i];
    if (!id || alreadyInjectedPostIds.has(id)) continue;
    lastIndexForId.set(id, i);
  }
  return Array.from(lastIndexForId.values()).sort((a, b) => a - b);
}

// 信頼クリックゲート(spec round18): DL ボタンの click は実ユーザー操作
// (event.isTrusted === true)の場合のみ処理する。ページ上のスクリプトが .click() や
// dispatchEvent で click を合成すると拡張の権限(credentials 付き fetch + downloads)を
// 無断駆動でき、dedup 無しでは無制限の重複 DL に直結するため、この経路を封じる。
export function shouldHandleDlClick(ev: { isTrusted: boolean }): boolean {
  return ev.isTrusted;
}

// in-flight ガードのコア判定(spec round25)。click 中の disabled 状態はボタン DOM
// ノード上にしか無く、サイトのカード再レンダリングで消えると再注入された新品ボタンが
// 重複クリックを許す(dedup 撤去後は吸収されない)。Set はタブ内・揮発で、同一タブ内の
// 同時多重起動だけを防ぐ(永続化しない = dedup の復活ではない)。
// DL 開始を試みる: 既に in-flight なら false、そうでなければ Set に追加して true。
export function beginDownloadAttempt(inFlight: Set<string>, postId: string): boolean {
  if (inFlight.has(postId)) return false;
  inFlight.add(postId);
  return true;
}

// DL の完了/失敗時に必ず呼ぶ(finally で)。以後、同じ postId を再び開始できる。
export function endDownloadAttempt(inFlight: Set<string>, postId: string): void {
  inFlight.delete(postId);
}
