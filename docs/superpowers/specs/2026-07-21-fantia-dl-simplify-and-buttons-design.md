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
   **ただし 2 点だけ変更する**:
   - **プロトコル(adversarial レビュー round3 指摘)**: `ZipStartMessage` の
     `conflictAction` フィールドを削除する。zip は Port 経由で conflictAction を独自に
     運んでおり(content-script → SW → downloads.download)、ここを残すと settings から
     消しても overwrite が表現可能なままになる。SW の zip DL も
     `DOWNLOAD_CONFLICT_ACTION` 定数を直接使う(フィールド削除により型レベルで封鎖)。
   - **パス検証(adversarial レビュー round4 指摘)**: 現行の zip 経路は
     `zipPathTemplate` / `zipEntryTemplate` の render 結果を **`validatePath` に通さず**
     そのまま使っており、通常 DL(render → validatePath → download)とガード水準が
     揃っていない。古い synced テンプレートが空セグメント・`.`/`..`・長すぎるパスを
     生んでも素通りする。fanbox-dl が zip 実装で entry ごとの検証を足したのと同様に、
     content-script の zip 生成時に **zip ファイル名(zipPath)と各 entry 名の両方を
     `validatePath` で検証**する。
     **検証モードの使い分け(adversarial レビュー round5 指摘)**: zipPath は実際に
     `chrome.downloads.download` を通るため uniquify 前提(`uniquifyHeadroom` 減算あり)で
     検証する。一方 **entry 名はアーカイブ内部の名前**で uniquify サフィックスが付かないため、
     headroom 減算を無効にして検証する(fanbox-dl の zip 実装と同じく
     `conflictAction: "overwrite"` 相当で validatePath を呼ぶ)。uniquify 扱いで entry を
     検証すると `(segmentMaxLen - uniquifyHeadroom, segmentMaxLen]` の長さの正当な entry 名が
     誤って拒否され、zip 全体が不当に中断される。
   - **zip ソースバジェット(adversarial レビュー round9/round10 指摘)**: 現行の zip
     組み立ては全ファイルをメモリに保持して同期 `zipSync` する上限なしの経路であり、
     一覧ボタン(B)はこれを高密度な面から連打しやすくする。fanbox-dl の zip 実装が持つ
     **ソース総バイト数とファイル件数のバジェット**を移植する。上限値は fanbox-dl の
     実装値を初期値として流用する。
   - **zip の直列化と非同期圧縮(adversarial レビュー round21 指摘)**: バジェットは
     1 ギャラリー単位のため、一覧面でカードを連打すると click ごとに独立の zip 収集が
     並走し `N × バジェット` のメモリ増幅と、同期 `zipSync` によるメインスレッド凍結が
     起きる。対策として (a) **ページ内の zip 組み立ては同時 1 件に直列化**する
     (2 件目以降のギャラリー zip はキューに積み、順に処理する。in-flight メモリは常に
     最大 1 バジェットに有界)、(b) **`zipSync` を fflate の非同期 `zip()`(worker ベース)に
     置き換え**、圧縮中もページの操作性を保つ。fanbox-dl 式の「zip を background へ移す」
     全面移植は本変更のスコープ外(実行位置は変えず、並行度と同期性だけを直す)。
     fantia のギャラリーは「zip 排他分岐」で、zip が失敗するとそのギャラリーが丸ごと
     未保存になる。fanbox-dl(orchestrator)と同じく、**enqueue 前のあらゆる zip 失敗
     (バジェット超過・zipPath/entry の validatePath 不合格・offscreen 障害・Port 切断・
     `downloads.download()` 呼び出し自体の失敗)で、そのギャラリーを個別ファイル DL
     (既存の非 zip enqueue 経路)へフォールバック**する。個別 DL をスキップしてよいのは
     zip の enqueue が実際に成功したときだけ(fanbox-dl 原設計 §7b と同じ意味論。ユーザーの
     目的は保存であって zip 形式ではないため)。
     **通知チャネルの分離(round13 指摘)**: 現行 fantia は `error` 1 本しか持たず、
     フォールバック成功を error に畳むと「エラー表示なのにボタンは N 件開始」という
     混乱シグナルになり、dedup 撤去後は再クリックによる重複 DL を誘発する。fanbox-dl と
     同じく応答に **`notices[]`(情報通知)を `errors` と別チャネルで追加**し、
     フォールバック発生は notice(「zip を中止し個別ダウンロードに切り替えました」)として
     表示する。error は本当に保存できなかったものだけに使う。
     **範囲の限定(round12 指摘)**: enqueue 成功**後**に blob DL が `onChanged` で
     interrupted になるケースは対象外(fanbox-dl と同じ。blob revoke のクリーンアップのみ
     行い、復旧はユーザーの再クリック。post-queue 中断はローカル要因で稀であり、
     fire-and-forget の設計上ここに追跡を持ち込まない)。
     **執行位置(round10 指摘)**: fantia の `fetchBinary` は本文を丸ごと `ArrayBuffer` に
     確保してから返すため、取得後にバジェット判定しても一時スパイクは防げない。そこで
     `fetchBinary` に **`maxBytes` 引数を追加し、`Content-Length` ヘッダによる事前ゲート**
     (超過確定なら本文を読まず `body.cancel()` して `{ok:false, tooLarge:true}`)を行う。
     content-script 側は残バジェットを `maxBytes` として渡す。`Content-Length` が無い
     応答は取得後判定の best-effort に留まる(single-file の一時確保は残るが、蓄積は
     バジェットで常に有界)。この spec はストリーミング化までは要求しない(パイプライン
     全面改修は本変更のスコープ外。バジェットの効果は「蓄積の有界化+ヘッダあり応答の
     事前遮断」であり、ヘッダ無し応答の単発スパイクまでは解消しない、と正直に限定する)。
     **options のプレビュー/検証も同じ使い分けに従う(adversarial レビュー round6 指摘)**:
     現行の options は 3 テンプレ共通の 1 検証経路が conflictAction select に依存している。
     select 削除後は、`pathTemplate` と `zipPathTemplate` のプレビュー検証は uniquify 前提
     (headroom 減算あり)、`zipEntryTemplate` のプレビュー検証は headroom 無効、と
     テンプレートごとにパラメータ化する(実行時検証と常に同じモードで判定されるようにし、
     「options では通るのに実行時に落ちる」/その逆の食い違いを作らない)。
5. 失敗した DL の復旧はユーザーの再クリック(そのとき photo の署名 URL も新規取得される)。

### migration(fantia 固有)
既存ユーザーの `chrome.storage.local` に `jobs` キーの履歴が残るため、SW 起動時に
`chrome.storage.local.remove("jobs")` を実行する(冪等・毎起動実行で害なし)。

### 文言
投稿ページのボタン title を「ダウンロード(履歴があれば済んだ分はスキップ)」→
「この投稿をダウンロード」に更新。

## 変更 B: ファンクラブ投稿一覧に DL ボタン

### manifest
- `content_scripts.matches` を `https://fantia.jp/posts/*` + `https://fantia.jp/fanclubs/*` に拡大
  (全域常駐はしない)。
- `web_accessible_resources` の page-script エントリは **page-script 廃止に伴い削除**
  (round19 参照)。
- **`host_permissions` に実測 CDN ホストを追加(adversarial レビュー round20 指摘)**:
  isolated world の fetch はページと同じ CORS 制約を受けるため、`fetchBinary` が叩く
  CDN ホスト(hard gate で実測したもの。URL allowlist と同一の集合)を `host_permissions` に
  束縛して CORS 免除を確保する。allowlist・host_permissions・実測結果の 3 つが常に同じ
  ホスト集合を指すことを B の有効化条件とする。

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
- **信頼クリックゲート(adversarial レビュー round18 指摘)**: すべての DL ボタン
  (一覧カード・投稿ページ共通)の click ハンドラは `event.isTrusted` が true の場合のみ
  実行する。ページ上のスクリプト(第一者・侵害済みを問わず)が `.click()` を合成して
  拡張の権限(credentials 付き fetch + downloads)を無断駆動する経路を封じる。dedup 撤去後は
  合成連打が無制限の重複 DL に直結するため、B で面を広げる前提条件とする。
- **page-script ブリッジの廃止(adversarial レビュー round19 指摘)**: isTrusted だけでは
  不十分 ―― 現行の `window.postMessage` ブリッジ(`__fdl` プロトコル)は無認証で、ページ JS が
  本物のクリックに便乗して偽応答を競り勝たせられる(偽 post JSON・偽解決 URL・最悪は
  `fetchBinary` への**任意バイト列**注入 → そのまま zip 化されて保存される)。チャネルを
  守るのではなく**チャネルごと削除**する: `fetchPost` / `resolveUrl` / `fetchBinary` を
  isolated world の content script 直接 fetch に移行し、`page-script.ts`・postMessage
  ブリッジ・`web_accessible_resources` の page-script エントリを全削除する。
  MV3 の isolated world fetch はページと同じ CORS/cookie 挙動で、csrf meta も DOM から
  読めるため機能は等価(fanbox-dl は当初から isolated fetch で、このクラスの脆弱性が
  構造的に存在しない)。**hard gate に追加**: isolated world からの 3 能力
  (fetchPost / resolveUrl / fetchBinary)が投稿ページ・一覧ページの両方で実機動作すること
  (万一 CDN fetch が isolated world でのみ失敗する場合は spec を改訂して再設計する)。
- watch: 1s interval + MutationObserver(一覧ページのときのみ注入)。fantia は Rails の
  フルロード遷移が基本のため、これで無限スクロール・動的追加も拾える。

### click フロー
既存 `runDownload()` を `runDownloadFor(postId)` に一般化(投稿ページは
`postIdFromUrl()` の結果を、一覧カードは束縛した postId を渡す。トリガが違うだけで同一フロー)。
一覧カードのボタンはカード固有の postId をクロージャで持つ(fanbox-dl と同じ判断:
カードは postId とボタンが 1:1 対応するため。投稿ページボタンはクリック時に URL から読む)。

### 実装前 hard gate(オリジン/csrf 確認)
一覧ページ `/fanclubs/{id}/posts` で次の**両方**を実機確認してから一覧ボタンを有効化する
(adversarial レビュー round7 指摘: fetchPost だけでは photo 以外の DL 経路を保証しない):
1. `meta[name="csrf-token"]` が存在し、page-script の `fetchPost` が任意 postId で 200 を返す
2. `resolveUrl`(file/video 系の `download_uri` 解決)が一覧ページから正しい最終 URL を返す
3. `fetchBinary`(photo ギャラリーの signed URL 取得。`zipGalleries` デフォルト true のため
   ギャラリー投稿の既定経路)が一覧ページから 200 でバイナリを返す(round8 指摘:
   page-script の全 3 能力を gate で網羅する)
確認できない場合、一覧ボタン機能は見送り(A/C のみ実装)とし spec を改訂する。

### resolveUrl の fail-closed 化(adversarial レビュー round7 指摘)
現行 page-script の `resolveUrl` は `r.ok` を確認せず `{ok:true, url:r.url}` を返す fail-open
(403/404/422 でもエラーページ URL などが「解決成功」として enqueue され得る)。
`fetchPost`/`fetchBinary` と同様に `r.ok` でなければ `{ok:false, error:"status N"}` を返すよう
修正する(B の一覧ボタンに限らず投稿ページ経路も同じ関数を通るため、共通の堅牢化)。

### DL 前 URL allowlist(adversarial レビュー round15 指摘、shishi 承認で今回スコープ入り)
従来 spec は「fantia は同一オリジン API 由来 URL のみ」を理由に URL 検証を対象外としていたが、
この前提は事実と異なる: photo の signed URL や `resolveUrl` の解決先は**クロスオリジンの
CDN URL** であり、現行実装はそれを無検証で `chrome.downloads.download` / zip 用 fetch に
渡している。B で起動面が広がるため、fanbox-dl の `validateMediaUrl` に相当する
**軽量 allowlist を導入**する:
- `src/core/url-allowlist.ts`(新設・純粋関数・単体テスト対象): https であること、
  ホストが `fantia.jp` / `*.fantia.jp` または**実測した fantia の CDN ホスト**
  (下記 hard gate で確定。例: `c.fantia.jp` 系や S3/CloudFront 系が想定される)で
  あることを検証する。
- 適用点: (a) SW の enqueue で `downloads.download` 呼び出し前、(b) content-script の
  zip 用 `fetchBinary` 呼び出し前、(c) **`resolveUrl` の入力(`download_uri`)**
  ―― fetch 実行前に「fantia.jp 同一オリジンの相対パスまたは fantia.jp URL」であることを
  検証する(round16 指摘: 解決の fetch 自体が credentials 付きの実リクエストのため、
  出力だけ検証しても未検証の外部リクエストが先に飛ぶ)、(d) `resolveUrl` の解決結果。
  いずれも不合格ならそのアイテムを `errors` に積んで除外する(fail-closed)。
- **zip ソース fetch はリダイレクト禁止(round17 指摘)**: `fetchBinary` は
  `redirect: "error"` で fetch する(fanbox-dl の zip 実装と同じ)。allowlist を通過した
  CDN URL が非許可ホストへリダイレクトして任意バイト列を zip に混入させる経路を封じる。
  signed URL は正規にはリダイレクトしないため正常系への影響は無い。
- **受容する残余(round16 指摘の明示化)**: resolveUrl のリダイレクト**中間ホップ**は
  検証できない(ブラウザの `redirect:"manual"` は Location を露出しないため構造的に不可)。
  入力が fantia.jp 同一オリジンに検証済みである以上、中間ホップは fantia サーバーの
  リダイレクト先であり、この 1 ホップ分の信頼は fantia 自体への信頼と同等として受容する。
- **hard gate 追加**: 実投稿(photo / file / video)で directUrl・resolveUrl 解決先の
  実ホストを採取し、allowlist に反映してから有効化する(推測ホストで実装しない)。
- fanbox-dl の finalUrl リダイレクト再検証(DL 完了時の再チェック)は今回は**移植しない**
  (スコープ外に明記。downloads API はリダイレクトを追うため残余リスクはあるが、
  DL 前検証で信頼境界は現行より明確に改善する。必要になったら別 spec)。

### 統一応答契約(adversarial レビュー round13/round14 指摘)
`runDownloadFor(postId)` の結果は fanbox-dl の `DownloadResponse` と同じ
**`{ queued: number, errors: string[], notices: string[] }`** に統一する(zip 分と通常 DL 分を
呼び出し側で合算)。normative な要点:
- **個別アイテムの失敗は黙って落とさない**: 現行は `resolveUrl` 失敗を `console.warn` で
  スキップし成功カウントだけ表示するため、一覧ボタン経由では無通知のデータ欠落になる
  (dedup 撤去後は後から気づく手段も無い)。resolveUrl 失敗・enqueue 検証落ち等の
  アイテム単位の失敗は、どのアイテムか識別できる文言で `errors` に積み、alert で表示する。
- `notices` は情報通知(zip フォールバック等)、`errors` は「実際に保存できなかったもの」
  だけに使う(round13 の分離)。`queued > 0` かつ errors ありの部分成功は両方表示する。

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
- `tests/url-allowlist.test.ts` 新設: fantia.jp / サブドメイン / 実測 CDN ホストの許可、
  外部ホスト・http・data: 等の拒否
- zip パス検証は純粋部分(validatePath 自体)は既存テストがあるため、zip 経路への配線は
  手動ゲートで確認(不正テンプレートで zip が個別 DL にフォールバックすること)
- `tests/parse.test.ts`: idemKey / refetch 削除に合わせて期待値更新
- 手動ゲート: 一覧ボタン表示・クリック DL・投稿ページ従来動作・zip・options
  (履歴 UI / conflictAction UI の消滅)

## スコープ外(YAGNI)
- fanbox-dl の finalUrl リダイレクト再検証(DL 完了時の再チェック)の移植
  (DL 前 allowlist は round15 指摘で今回スコープ入りした。完了時再検証のみ backlog。
  必要になったら別 spec)
- $date のタイムゾーン扱い(fanbox-dl の backlog と同件。core の挙動は両者で共通のまま)
- 2 リポジトリ間の共通ライブラリ化
