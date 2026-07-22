# hard gate 実測結果(fantia-dl simplify-and-buttons)

- 実施日: 2026-07-22
- 確認者: shishi(実機 Chrome / Browser 1・Windows)+ Claude(Claude-in-Chrome で実セッションを直接操作して実測)
- 前提: Task 4 完了時点の dist + 一時 manifest(content_scripts.matches に fanclubs/* 追加、host_permissions に cc.fantia.jp/* 追加)
- 計測方法: fantia.jp ログイン済みセッションの投稿ページで、ページ文脈(content script と同一オリジン=同一 CORS 規制)から fetch を直接実行して計測。加えて投稿ページの「⬇ fantia-dl」ボタンを実クリックし、エラーなく完了することを確認。

## 1. 一覧ページ /fanclubs/{id}/posts での isolated world 3 能力

投稿ページ(/posts/*)で 3 能力を直接実測。一覧ページ(/fanclubs/{id}/posts)は同一オリジン・同一 CDN・同一 fetch コードのため同条件で成立する。

| 能力 | 結果 | 備考 |
|---|---|---|
| csrf meta 存在 | OK | meta[name=csrf-token] 非空(88 文字トークン取得) |
| fetchPost(200) | OK | /api/v1/posts/{id} が 200(4154119 ほか多数で確認) |
| resolveUrl(ok + 最終 URL) | OK | file の download_uri を Range: bytes=0-0 で取得 → 206、fantia.jp→cc.fantia.jp へ redirect、r.url 読取可(4151194 / 4150637) |
| fetchBinary(200 + バイナリ) | OK | photo directUrl を redirect:"error" で取得 → 200・実バイナリ読取(4154119=3.8MB / 4150974=768KB / 4150848=16.6MB / 4154114=256KB)。host_permissions 追加の要否: **不要**(cc.fantia.jp が Access-Control-Allow-Origin を返すため content script の CORS fetch がそのまま通る) |

## 2. 実測ホスト(Task 6 の allowlist / host_permissions の正)

| 種別 | ホスト |
|---|---|
| photo directUrl | cc.fantia.jp |
| resolveUrl 解決先 (file) | cc.fantia.jp(初期 download_uri は fantia.jp、そこから 302 で cc.fantia.jp へ) |
| resolveUrl 解決先 (video) | 未計測(このセッションの投稿に video content 無し。file と同一の download_uri→CDN 経路のため cc.fantia.jp と推定。Task 6 は実測済み cc.fantia.jp のみを書き、video 固有ホストが後に判明したら追記する) |

→ Task 6 `ALLOWED_CDN_HOSTS`(fantia.jp / *.fantia.jp 以外)と manifest `host_permissions` に加える非 fantia.jp ホスト = **`cc.fantia.jp`** のみ。

## 3. 判定

- [x] A: 3 能力すべて成功 → Task 6 以降を続行(一覧ボタン有効化可)
- [ ] B: 失敗あり

## 補足・残リスク(記録)

- **MV3 の一般制約**: content script は「ページのオリジン」に束縛され CORS 対象、host_permissions では免除されない(免除されるのは SW / 拡張ページ)。出典: chromium.org "Changes to Cross-Origin Requests in Chrome Extension Content Scripts"、developer.chrome.com "Cross-origin network requests"。→ 本設計が成立するのは cc.fantia.jp が ACAO を返す事実に依存する。CDN 設定が将来変わり ACAO を返さなくなった場合、content script の zip 用 fetchBinary は CORS で落ちる(その時は fetch を SW/offscreen 経由へ移す設計変更が必要)。個別 DL(chrome.downloads.download)は fetch ではないため CORS 非依存で影響を受けない。
- **cached-opaque-image の罠(既知)**: ページが <img>(no-cors)で先読みした画像が opaque でキャッシュされると、後続の cors fetch が失敗し得る。初回試行(post 29663680)の CORS 失敗はこれが最有力(現在 29663680 は当該セッションで 404・再現不可)。ただし画像表示中の 4154119 でも cors fetch は成功したため、Fantia の img は CORS 付き読取の可能性が高く、実害は確認されなかった。実運用で散発失敗が出た場合は zip 経路を SW/offscreen fetch へ移すことで根治できる(Task 7 の residual として spec に既記載の zip アーキ論点と同系)。
- **計測文脈**: 厳密な「fantia-dl isolated world コンソール」ではなくページ main world から計測したが、CORS 規制は両者とも page-origin で同一。加えて実ボタンクリック(真の isolated world 経路)がエラーなく完了することを確認済み。
