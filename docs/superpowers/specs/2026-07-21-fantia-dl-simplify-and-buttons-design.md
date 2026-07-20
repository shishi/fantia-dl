# fantia-dl 変更設計書: 履歴撤去・一覧ボタン・テンプレート値の slash 中和

- 日付: 2026-07-21
- ステータス: 承認済み(shishi、同日・A/B/C 全セクション)
- 位置づけ: fanbox-dl で実証済みの改善(2026-07-20 の同名 spec)を fantia-dl へ逆輸入する変更 spec。
  実装パターンは fanbox-dl のレビュー 6 巡 + 実 E2E を耐えた形を移植し、fantia の構造に馴染ませる。

## 背景

fanbox-dl で次の 3 つが実証された:
1. dedup/DL 履歴は価値に対して複雑さが見合わず、fire-and-forget で十分
2. 投稿一覧のカードごと DL ボタンは有用(重複注入・stale 束縛・視認性の罠と対策も判明済み)
3. テンプレート値に `/` が含まれると意図しないディレクトリが切られる(fanbox は adapter で中和)

これらを fantia-dl(本家)へ还元する。shishi 確認済みの決定:
- dedup は **全撤去**(resume/needs_page も含む。photo の署名 URL は再クリックで取り直せるため)
- 一覧ボタンは **`/fanclubs/{id}/posts` のみ**(ファンクラブトップ・ホーム・検索は対象外)
- slash 中和は **サーバ由来のプレースホルダ展開値の `/` を置換**。テンプレート literal と
  `$date`/`$today` の出力は不変(adversarial レビュー指摘 1 の反映。詳細は変更 C)
- `conflictAction` は **uniquify 固定にし、overwrite 設定を廃止**(adversarial レビュー指摘 3 の
  反映。dedup 撤去後は誤った再クリックが確認なしの上書き事故に直結するため。fanbox-dl と同じ判断)

## 変更 A: 履歴機構の全撤去(fire-and-forget 化)

### 削除するもの
- `src/background/job-store.ts` 全体(JobRecord / pending/requested/done/error/needs_page 状態)
- service-worker の: dedup フィルタ(`done`/`requested` スキップ)、`updateJob` 系呼び出し、
  `onChanged` の通常 DL 分岐(done/needs_page/error 記録)、起動時 reconcile の通常 DL 分、
  `sweepOldDoneJobs`(1 年 sweep)、`clearHistory` メッセージハンドラ
- options の「DL 履歴の管理」セクション(options.html + options.ts の clearHistory UI)と
  `conflictAction` 選択 UI(uniquify 固定化に伴い。上記フロー 3 参照)
- content-script の 🔄(再ダウンロード)ボタンと `force` フラグ(`EnqueueMessage.force` ごと廃止)
- `EnqueueItem` の `idemKey` / `refetch` フィールドと、parse(`src/fantia/parse.ts`)での付与

### 撤去後のダウンロードフロー(normative)
1. content script が page-script(MAIN world)経由で post API を fetch し、
   `{kind:"enqueue", post, items}` を SW へ送る(従来どおり。`force` のみ廃止)。
2. SW: 各 item について renderTemplate → validatePath → バッチ内 `seenPaths` 重複チェック
   (すべて既存の検証を維持)→ 通過分を `chrome.downloads.download({url, filename, saveAs:false,
   conflictAction: "uniquify"})` で**投げっぱなし**(結果を永続追跡しない)。
3. 同名衝突は **uniquify 固定**(`foo (1).ext`)に委ねる。adversarial レビュー指摘 3:
   dedup 撤去で「同じ投稿の二重実行を止める最後のガード」が消えるため、overwrite 選択が
   残っていると一覧ボタンの誤クリック・再注入競合・一覧→詳細の二重発火が**確認なしの
   アーカイブ上書き**に直結する。
   **構造的に閉じる(adversarial レビュー round2 指摘)**: 値の強制だけでは、現行の
   settings merge が unknown キーを温存する blind spread(`{...defaults, ...saved}`)のため、
   リファクタ後に `s.conflictAction` の読み残しが 1 箇所でも生き残ると保存済み
   `"overwrite"` が復活する。fanbox-dl と同じく:
   - `conflictAction` を `Settings` 型から削除し、`DOWNLOAD_CONFLICT_ACTION = "uniquify"`
     定数に置き換える(通常 DL と zip の両経路がこの定数を参照。型消滅により読み残しは
     コンパイルエラーになる)
   - `loadSettings` の merge を **既知キーの allowlist 方式**に変え、保存済みの unknown キー
     (旧 `conflictAction` 含む)を結果に含めない。options の保存(`{...cur, ...}`)も
     同様に既知キーのみ書き戻す
4. **zip 経路の資源管理は無傷**: Port(start→chunk*→end)、offscreen document、blob URL の
   `zipDownloads` Map + storage.session 同期、zip の onChanged 分岐(revoke)、zip の
   起動時 reconcile。これらは dedup と無関係の資源管理(blob リーク防止)のため維持する。
   **ただし 1 点だけプロトコルを変更する(adversarial レビュー round3 指摘)**:
   `ZipStartMessage` の `conflictAction` フィールドを削除する。zip は Port 経由で
   conflictAction を独自に運んでおり(content-script → SW → downloads.download)、ここを
   残すと settings から消しても overwrite が表現可能なままになる。SW の zip DL も
   `DOWNLOAD_CONFLICT_ACTION` 定数を直接使う(フィールド削除により型レベルで封鎖)。
5. 失敗した DL の復旧はユーザーの再クリック(そのとき photo の署名 URL も新規取得される)。

### migration(fantia 固有)
既存ユーザーの `chrome.storage.local` に `jobs` キーの履歴が残るため、SW 起動時に
`chrome.storage.local.remove("jobs")` を実行する(冪等・毎起動実行で害なし)。

### 文言
投稿ページのボタン title を「ダウンロード(履歴があれば済んだ分はスキップ)」→
「この投稿をダウンロード」に更新。

## 変更 B: ファンクラブ投稿一覧に DL ボタン

### manifest
`content_scripts.matches` を `https://fantia.jp/posts/*` + `https://fantia.jp/fanclubs/*` に拡大
(全域常駐はしない)。`web_accessible_resources` の page-script matches は既に `https://fantia.jp/*`。

### ページ判定
`isFanclubPostListPage(pathname)`: `/fanclubs/{id}/posts`(末尾スラッシュ許容)のみ true。
ファンクラブトップ `/fanclubs/{id}` は false。ページング `?page=N` はクエリのため pathname 判定に
影響しない。投稿詳細 `/posts/{id}` は従来どおり別扱い。

### 注入(fanbox-dl 実証パターンの移植)
- `src/content/dom-helpers.ts` を新設し、純粋関数を置く(すべて単体テスト対象):
  - `postIdFromPathname(pathname)`: `/posts/{id}` から postId 抽出
  - `postIdFromHref(href)`: 相対/絶対 href から postId 抽出。絶対 URL は fantia.jp ホストのみ許可
    (外部リンク誤認防止)
  - `isFanclubPostListPage(pathname)`
  - `selectPostAnchorIndicesToInject(postIds, alreadyInjectedPostIds)`: postId 単位 dedup、
    同一 postId 複数アンカーは文書順で最後を採用(入れ子アンカー対策。fanbox-dl と同一契約)
- 注入ガードは「ボタン要素の実在」ベース(anchor 側マーカー不使用)。ボタンに
  `data-fdl-for={postId}` を付け、走査ごとに実在ボタンを数え上げて判定する。
- host(anchor の親)再利用で href だけ差し替わった場合の stale ボタンは、走査時に
  `data-fdl-for` と現 href の postId を突き合わせて除去(`:scope >` で直接の子のみ)。
- ボタンは host に `position:relative` を敷いて右上に absolute 配置。スタイルは fanbox-dl の
  視認性知見を適用: 濃色半透明背景 + 白文字 + 影(白背景小ボタンはサムネイルに埋没する)。
- クリックは `preventDefault()` + `stopPropagation()` でカード遷移を抑止。
- watch: 1s interval + MutationObserver(一覧ページのときのみ注入)。fantia は Rails の
  フルロード遷移が基本のため、これで無限スクロール・動的追加も拾える。

### click フロー
既存 `runDownload()` を `runDownloadFor(postId)` に一般化(投稿ページは
`postIdFromUrl()` の結果を、一覧カードは束縛した postId を渡す。トリガが違うだけで同一フロー)。
一覧カードのボタンはカード固有の postId をクロージャで持つ(fanbox-dl と同じ判断:
カードは postId とボタンが 1:1 対応するため。投稿ページボタンはクリック時に URL から読む)。

### 実装前 hard gate(オリジン/csrf 確認)
一覧ページ `/fanclubs/{id}/posts` に `meta[name="csrf-token"]` が存在し、そのページに注入した
page-script の `fetchPost` が任意 postId で 200 を返すことを実機で確認してから一覧ボタンを
有効化する。確認できない場合、一覧ボタン機能は見送り(A/C のみ実装)とし spec を改訂する。

### 対象外(YAGNI)
ファンクラブトップ/ホーム/検索/マイページ系への展開。投稿ページのボタン配置変更
(`h1.post-title` は安定クラスのため現行の title 直後で問題ない)。

## 変更 C: テンプレート値の slash 中和

`src/core/template-engine.ts` の `render()` で、プレースホルダ展開値(`evalPh` の戻り)に含まれる
`/` を `opts.replacement` に置換する。テンプレート literal の `/` は separator として不変。
`renderTemplate` は `render` に opts を渡す形にシグネチャを内部変更する(公開 API 不変)。

### 中和の対象(normative)
中和するのは **`$date` / `$today` を除く全プレースホルダ**の展開値。
- adversarial レビュー指摘 1: options のヘルプは「`$date{}` / `$today{}` 内の非トークン文字は
  そのまま出力される」と明記しており、`$date{YYYY/MM}` で年/月ディレクトリを掘る使い方が
  公式にできる。この `/` の出所はサーバ値ではなく**ユーザー自身のフォーマット文字列**
  (= 意図された区切り)なので中和してはならない。全出力を中和すると既存ユーザーの保存パスが
  黙って変わり、uniquify では重複ツリー生成につながる。
- それ以外のプレースホルダ(creator / creatorId / postTitle / postId / contentTitle /
  contentId / contentType / plan / filename / ext / seq / total)の値はサーバ由来
  (または数値・拡張子)であり、そこに現れる `/` は常に「データがたまたま含んでいた文字」
  なので中和する。数値系に `/` は実際には現れないが、除外リスト方式
  (date/today のみ除外)にすることで将来のプレースホルダ追加時に安全側へ倒す。
- この意味論は fanbox-dl の render-adapter(ctx のサーバ由来文字列のみ事前中和、date は
  core 内計算のため対象外)と一致する。

### replacement 自体のガード(adversarial レビュー指摘 2)
`illegalCharReplacement` に `/` や `\` を設定できると中和が無効化・逆用される。
fanbox-dl と同じ二段ガードを移植する:
1. **保存時バリデーション**: options 保存時に replacement が `/` `\` などの不正文字
   (sanitizer の ILLEGAL 相当)や制御文字を含む場合は保存を拒否しエラー表示する
   (fanbox-dl の `validate-templates.ts` 相当を移植)。
2. **読み込み時クランプ**: `loadSettings` で保存済み値を検証し、不正なら `_` に強制する
   (バリデーション導入前に保存された synced 設定への防御)。SW と content-script(zip 経路)の
   両方が loadSettings 経由のため単一点で効く。

### 例・適用範囲
- テンプレ `$creator/$postTitle/$filename`、postTitle=`お知らせ 1/2` →
  従来 `creator/お知らせ 1/2/file.jpg`(意図しないディレクトリ)→ 修正後 `creator/お知らせ 1_2/file.jpg`
- `$date{YYYY/MM}` → 従来どおり `2026/07`(年/月ディレクトリ)のまま(挙動不変)
- 適用範囲: `pathTemplate` / `zipPathTemplate` / `zipEntryTemplate`(全て同一 renderTemplate 経路)
- `\` は後段 `sanitizeSegment` の ILLEGAL 置換で除去済みのため値レベルの追加対応不要
- 既存ユーザー影響: literal と date/today が不変のためパス構造は変わらない。サーバ値に `/` を
  含む投稿のみ挙動が変わる(= 本修正の目的)

## テスト方針

fantia-dl の既存方針(純粋関数のみ単体テスト、SW/DOM 配線は手動ゲート)を踏襲する。
- `tests/dom-helpers.test.ts` 新設: fanbox-dl のテストを fantia の URL 構造に翻案
  (postIdFromPathname / postIdFromHref の外部ホスト拒否 / isFanclubPostListPage /
  selectPostAnchorIndicesToInject の後勝ち・dedup・再注入契約)
- `tests/template-engine.test.ts` に slash 中和ケース追加(値の `/` 置換、literal `/` 不変、
  **`$date{YYYY/MM}` / `$today{YYYY/MM}` の `/` 不変**、グループ `[...]` 内の値、
  zipEntryTemplate 相当のケース)
- replacement ガードのテスト: 保存時バリデーション(`/` `\` 拒否)と loadSettings クランプ
  (不正保存値 → `_` 強制)
- settings テスト: allowlist merge が unknown キー(旧 `conflictAction` 含む)を落とすこと、
  `DOWNLOAD_CONFLICT_ACTION` が uniquify であること
- `tests/parse.test.ts`: idemKey / refetch 削除に合わせて期待値更新
- 手動ゲート: 一覧ボタン表示・クリック DL・投稿ページ従来動作・zip・options
  (履歴 UI / conflictAction UI の消滅)

## スコープ外(YAGNI)
- fanbox-dl の finalUrl リダイレクト再検証や URL allowlist の fantia への導入
  (fantia は同一オリジン API 由来の URL のみで、元々この機構を持たない。必要になったら別 spec)
- $date のタイムゾーン扱い(fanbox-dl の backlog と同件。core の挙動は両者で共通のまま)
- 2 リポジトリ間の共通ライブラリ化
