# Fantia カスタムダウンローダー 設計書

- 日付: 2026-07-10
- リポジトリ: github.com/shishi/fantia-dl
- 参考: [mnao305/fantia-dl-tool](https://github.com/mnao305/fantia-dl-tool)（MIT / 参考利用可）
- 種別: Chrome 拡張機能（Manifest V3, TypeScript）
- 改訂: v6（codex adversarial review 5 巡反映）

## 1. 目的

Fantia の投稿から画像・添付ファイル・動画をダウンロードする Chrome 拡張。
既存ツールとの差分は次の 2 点:

1. 保存パスをプレースホルダ・テンプレートで自由に構成できる。
2. **可能な限り**保存ダイアログを出さずデフォルトダウンロードフォルダへ自動保存する
   （Chrome 本体設定に依存。§7 参照）。

## 2. スコープ

### DL 対象
- 画像（photo gallery）
- 添付ファイル（zip / psd / pdf など）
- 動画（**experimental**。§12 の PoC 完了までは既定 OFF）

### 対象外
- サムネイル画像、テキスト本文の保存

## 3. アーキテクチャ

Manifest V3。責務を 5 モジュールに分離する。

| モジュール | 責務 | テスト |
|---|---|---|
| content script | 投稿ページに DL ボタン注入 / postId 検出 / CSRF トークン抽出 / **認証付き fetch でデータ取得** | 手動 |
| background (service worker) | ジョブ永続化・オーケストレーション → テンプレート展開 → 検証 → chrome.downloads 実行 | 統合（手動 + 一部） |
| template engine（純粋関数） | context + テンプレ文字列 → 相対パス生成 | TDD |
| sanitizer（純粋関数） | セグメント単位の文字整形・予約名回避・長さ制限 | TDD |
| path validator（純粋関数） | 展開後の相対パス全体を MV3 制約で検証 | TDD |

データソースは Fantia の JSON API（`https://fantia.jp/api/v1/posts/{postId}` 系）を第一候補、
DOM スクレイピングをフォールバックとする。認証の詳細は §11、実装前の検証は §12。

## 4. プレースホルダ・カタログ

### 投稿・クリエイター単位
- `$creator` … クリエイター（ファンクラブ）名
- `$creatorId` … ファンクラブ ID
- `$postTitle` … 記事タイトル
- `$postId` … 記事 ID
- `$date{FORMAT}` … 投稿日（例: `$date{YYYYMMDD}` → 20260709）
- `$today{FORMAT}` … DL 実行日（今日）

### コンテンツブロック単位
- `$contentTitle` … コンテンツタイトル
- `$contentId` … コンテンツ ID
- `$contentType` … `photo` / `file` / `video`

### ファイル単位
- `$filename` … 元ファイル名（拡張子なし）
- `$ext` … 拡張子（ドットなし）
- `$seq` / `$seq{N}` … コンテンツブロック内連番、N 桁ゼロ詰め（例: `$seq{3}` → 001）
- `$total` … ブロック内総数

### 追加候補（実装時に取得可否を検証）
- `$plan` … 支援プラン名

### 日付書式トークン
`$date{}` / `$today{}` 内で使用可能: `YYYY YY MM M DD D HH mm ss`

### オプショナルグループ `[...]`
`[` と `]` で囲んだ範囲は、**その中の全プレースホルダが非空に解決したときだけ**出力される。
1 つでも空なら範囲ごと（囲んだリテラル文字も含めて）削除される。決定的で、連番以外の
「あるときだけ付けたい」区切りにも使える。

### テンプレート例
```
fantia/$creator/$date{YYYYMMDD}_$postTitle/$contentTitle/[$seq{3}_]$filename.$ext
```

## 5. 連番 $seq の条件付きルール

- 採番単位: **コンテンツブロックごと**（別ブロックでリセット）。
- **同一ブロック内に対象が 2 つ以上あるときのみ採番**する。1 つだけなら `$seq` は空文字。
- 「対象 1 つなら連番を付けない」は §4 のオプショナルグループで実現する（決定的）。
  - 例 `[$seq{3}_]$filename.$ext`: 複数 → `001_foo.jpg` / 単一 → `foo.jpg`
- 局所的な「隣接区切り文字を消す」ルールは非決定的なため**採用しない**（オプショナルグループに一本化）。
- TDD で「単一/複数」「グループ内に空プレースホルダ混在」ケースを必ずテストする。

## 6. データフロー

1. content script が投稿ページで postId・CSRF トークンを検出し、DL ボタンを注入。
2. クリックで content script が Fantia API を**認証付き fetch**で叩き、投稿データを取得（§11）。
3. content script が取得データを background へ送信。
4. background がジョブを `chrome.storage.local` に永続化（§13a）し、ファイルごとに context を組み立てる。
5. template engine がパス生成 → sanitizer が各セグメントを整形 → path validator が全体検証。
6. **DL 前にバッチ内でパス重複を検出**（§8）。重複や検証失敗があれば実行せずエラー提示。
7. `chrome.downloads.download({ url, filename, saveAs: false, conflictAction })` を冪等キー単位で実行。

## 7. 保存ダイアログ抑制（保証範囲を明示）

- `saveAs: false` + `conflictAction`（既定 `uniquify`）で、Chrome 本体設定
  「ダウンロード前に各ファイルの保存場所を確認する」が **OFF のときは**ダイアログを出さない。
- **この設定が ON のときは拡張から強制できずダイアログが出る**（Chrome の仕様）。
  - 要件文言は「可能な限り抑制」に修正済み（§1）。
  - README にこの設定を OFF にする手順を明記。
  - 拡張からこの設定値を読む API は無いため、options ページに「ダイアログが出る場合は
    Chrome 設定を確認」という注意を常時表示する。

## 8. 衝突・重複の扱い

- `conflictAction`: `uniquify`（既定）/ `overwrite`。`overwrite` は無言上書きの危険オプション
  として options に警告表示し、既定では選ばせない。
- `uniquify` に頼り切らず、**DL 実行前にバッチ内の生成パス集合で重複検出**する。
  重複があればテンプレート不備の可能性が高いため、実行を止めて該当パスを提示する。
- **strict mode（任意・既定 OFF）**: 過去実行との衝突検出。
  - **主機構**: 拡張が「正規化済み相対パスの DL 履歴」を `chrome.storage.local` に自前保存し、
    生成パスと照合する。`chrome.downloads.search` は `filename` が絶対パス前提で相対パスでは
    取りこぼすため、**依存しない**（補助情報としてのみ利用可）。
  - あれば警告して確認を求める。
  - 限界: 履歴削除・外部移動・別プロファイルは検出できない（options に明記）。

## 9. sanitizer 仕様（セグメント単位・純粋関数）

各パスセグメント（`/` で区切られた 1 階層分）に対して:

- 禁止文字 `/ \ : * ? " < > |` と制御文字を置換文字（既定 `_`）へ。
- **Windows 予約名**（`CON PRN AUX NUL COM1..9 LPT1..9`、拡張子付きも含む）を回避（接尾辞付与等）。
- **先頭・末尾の両方のドット・空白を除去**（Windows で不正／隠しファイル化を防止）。
- **空セグメントのフォールバック名**（例: `untitled`）。
- **Unicode 正規化**（NFC）。
- **長さ制限（具体値で固定）**:
  - 計測単位: Unicode コードポイント数。
  - セグメント上限: 200。超過時は末尾を切り詰め、`$ext` に相当する拡張子は保持。
  - フォールバック名適用後も上限を満たすこと。
- **処理順（厳密に固定）**: (1) Unicode 正規化(NFC) → (2) 禁止文字・制御文字の置換 →
  (3) 先頭/末尾のドット・空白除去 → (4) 空ならフォールバック名 → (5) 長さ切り詰め(拡張子保持) →
  (6) **全変換後に予約名を再チェック**して回避。予約名チェックは切り詰め等の後に必ず再実行する
  （`con` + `.txt` 化のような後段生成ケースを防ぐ）。

## 10. path validator 仕様（全体パス・純粋関数）

sanitize 後の相対パス全体に対し、chrome.downloads の制約を満たすか検証:

- 先頭スラッシュ・絶対パス（ドライブレター含む）を reject。
- `..` セグメント・`.` セグメント・空セグメントを reject。
- 正規化してルート外へ逸脱しないことを確認。
- **全体パス長の上限**: 相対パス全体を既定 180 コードポイント以下とする（設定可能）。
  - 注意: コードポイント数は実 OS のパス長制限（Windows は基準 Downloads フォルダ絶対パスも
    加算、UTF-16/バイト計測）と一致しないため「この値で安全」とは断言しない。保守的な初期値であり、
    §12 の PoC で OS 別に実測して最終上限を確定する。基準フォルダが深い環境向けに下限側へ調整可能。
- **uniquify の余白予約**: `conflictAction: "uniquify"` 有効時、Chrome が末尾へ ` (NNN)`
  （最大目安 6 コードポイント）を付与して OS 上限を超え得る。validator はファイル名セグメント・
  全体パスの両方でこの分の**余白を差し引いた上限**で判定する（あるいは §8 のとおり拡張側で
  決定的に suffix を付けてから検証し、`download()` は `overwrite` 明示時のみ）。
- 検証失敗時は chrome.downloads.download を呼ばず、ユーザーへエラー提示。

## 11. 認証設計（経路を一本化）

- **canonical 経路**: **content script から認証付き fetch**（`credentials: "include"`）を行う。
  - 理由: Fantia の session cookie と `meta[name=csrf-token]` が同一ページ文脈で自然に得られ、
    background からの cross-context な cookie/CSRF 取り回しを避けられる。
  - 注意: content script は isolated world で動くため、Fantia API が Origin/Referer を厳格に
    見る場合、期待どおりのページオリジン扱いにならない可能性がある（§12 で実挙動を検証）。
- **フォールバック経路（一級）**: 上記が Origin/Referer で弾かれる場合、`world: "MAIN"` の
  注入 page script（実ページ文脈で fetch）＋ message bridge でデータ取得する方式を用意する。
  - PoC で content script 直 fetch と page-script 経由の両方を試し、通る方を canonical に確定する。
- `host_permissions`: `https://fantia.jp/*`。
- CSRF トークンは content script が `meta[name=csrf-token]` 等から抽出し、API 呼び出し時に
  `X-CSRF-Token`（要否は §12 で確定）として付与。fetch は `credentials: "include"`。
- 失敗時リトライ: 401/403 の場合、content script が CSRF トークンを DOM から**再取得して 1 回だけ**
  リトライ。再失敗ならユーザーへ明示エラー（background 側では認証 fetch を行わない）。

## 12. 実装前 PoC（リリースブロッキング・ゲート）

以下は「実装時に確認」では遅く、**プランに着手する前に spike で確定**する:

1. Fantia 投稿データの取得: JSON API の正確なエンドポイント・必要ヘッダ・cookie/CSRF 要否。
   - content script 直 fetch と `world:"MAIN"` page-script 経由の両方で Origin/Referer/Cookie の
     実挙動を検証し、通る方を canonical 認証経路に確定する（§11）。
   - API が使えなければ DOM 抽出を主経路に確定する。
2. 動画の取得方式: 直リンク URL か / 署名付き期限あり URL か / ストリーミングのみか。
   - chrome.downloads で保存可能な形式でなければ動画はスコープ外へ。
3. chrome.downloads.download の filename 制約の実挙動（非 ASCII・長いパス）を最小拡張で確認し、
   OS 別のパス長上限を実測して §10 の上限を確定する。
4. **end-to-end 実 DL spike**: photo と file を各 1 件、content script が取得した URL を
   SW の `chrome.downloads.download` に渡して実保存できるか検証する。cookie 以外の
   必要ヘッダ/referrer の要否、URL 有効期限（署名付き期限切れ）と期限切れ時の再取得方針を確定する。
   - メタデータ取得の成功だけでは不十分。実ファイル DL の成立条件をここで gate する。

PoC の結果を本設計書に追記してからプラン作成へ進む。

## 13. service worker ライフサイクル / ジョブ永続化

MV3 の service worker はアイドルで停止・再起動され得るため、バッチ状態をメモリに持たない。

- **ジョブ永続化**: DL バッチ（対象ファイル一覧・生成パス・状態）を `chrome.storage.local` に保存。
- **冪等キー**: 期限で変わらない**安定した論理キー**を使う。第一に `postId + contentId + fileId`、
  `fileId` が無い場合も URL ハッシュは使わず（署名付き URL は再取得で変わり重複/dedupe を壊す）、
  `postId + contentId + ブロック内インデックス` 等の**構造的キー**で代替する。
  同一キーの重複 `download()` を防ぎ、各ファイルの状態（pending / requested / done / error）を記録。
- **downloadId 永続化**: `download()` が返す `downloadId` を実行キーに紐付けて保存する。
- **resume（起動時 reconcile）**: service worker 起動時に未完了ジョブを読み、
  - `pending`（未投入）: 再投入する。
  - `requested`（投入済み・SW 停止中に終端した可能性）: 保存した `downloadId` で
    `chrome.downloads.search({ id })` を照会し、`complete` → done、`interrupted` → error、
    `in_progress` → requested 維持、へ reconcile する。`downloadId` 不明なら冪等キーで再投入。
  - `chrome.downloads.onChanged` も購読し、SW 稼働中の終端遷移を随時反映する。
- `download()` 呼出後はブラウザ側が DL を管理するため SW 停止でも当該 DL は継続する。
  リスク窓は「バッチ投入ループ途中の SW 停止」に限定され、上記 reconcile で吸収する。
- 完了・全エラー確定後はジョブレコードを掃除する。
- **URL 再取得（一級市民）**: 署名付き期限ありメディア URL の失効に備え、各ファイルに
  再取得用の識別子（`postId / contentId / fileId`）を永続化する。
  - `interrupted`（期限切れ等）や resume 時に URL が古い可能性がある場合:
    生きた content script との handshake で**新しい URL を再取得**して再投入する。
  - Fantia タブが無い/開けず再取得できない場合: ジョブを `needs_page`（ページ再オープン要）
    状態へ退避し、options/バッジで「該当投稿ページを開いて再開」を促す明示的な resume UX を出す。
  - 認証 fetch は §11 のとおり content script 側でのみ行い、background は URL 再取得を直接行わない。

## 14. 設定（options page / chrome.storage.sync）

- `pathTemplate` … パステンプレート本体
- `illegalCharReplacement` … 禁止文字の置換文字（既定 `_`）
- `conflictAction` … `uniquify`（既定）/ `overwrite`（警告付き）
- `strictCollisionCheck` … 過去 DL 履歴との衝突警告（既定 OFF、§8）
- `contentTypes` … photo / file / video（video は PoC 完了まで無効）の有効化トグル
- ライブプレビュー … サンプルデータでテンプレ展開＋sanitize＋検証結果を即時表示
- ダイアログ設定・strict mode の限界に関する注意書きの常時表示
- `needs_page` ジョブの再開導線（該当ページを開いて再取得→再投入）

## 15. テスト方針（TDD）

- template engine / sanitizer / path validator は純粋関数 → Vitest で TDD。
  - 書式展開（各トークン）
  - オプショナルグループ（空/非空、ネスト、連番との組合せ）
  - 連番ゼロ詰め・単一/複数分岐
  - 禁止文字・予約名・先頭/末尾ドット/空白・空値フォールバック・Unicode 正規化・長さ制限（境界値）
  - path validator（`..`・絶対・空セグメント・全体長超過・正常系）
  - 未知プレースホルダの扱い
- content / background は最小限。ジョブ永続化/resume は一部単体化、拡張ロードと実 DL は手動確認。

## 16. 技術スタック

- TypeScript + Vite（`@crxjs/vite-plugin` を候補、MV3 対応状況を §12 と併せて検証）
- Vitest（純粋モジュールの単体テスト）
- 参考コードは Webpack だが、新規のため Vite を採用。

## 17. 未確定事項（PoC 対象は §12）

- `$plan`（支援プラン名）の取得可否。
- `@crxjs/vite-plugin` の MV3 対応状況。
- Fantia API の正確なエンドポイント・CSRF 要否（§12-1）。
