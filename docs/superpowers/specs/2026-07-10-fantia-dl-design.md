# Fantia カスタムダウンローダー 設計書

- 日付: 2026-07-10
- リポジトリ: github.com/shishi/fantia-dl
- 参考: [mnao305/fantia-dl-tool](https://github.com/mnao305/fantia-dl-tool)（MIT / 参考利用可）
- 種別: Chrome 拡張機能（Manifest V3, TypeScript）

## 1. 目的

Fantia の投稿から画像・添付ファイル・動画をダウンロードする Chrome 拡張。
既存ツールとの差分は次の 2 点:

1. 保存パスをプレースホルダ・テンプレートで自由に構成できる。
2. 保存ダイアログを出さず、デフォルトダウンロードフォルダへ自動保存する。

## 2. スコープ

### DL 対象
- 画像（photo gallery）
- 添付ファイル（zip / psd / pdf など）
- 動画（入手方法は実装時に要検証）

### 対象外
- サムネイル画像、テキスト本文の保存

## 3. アーキテクチャ

Manifest V3。責務を 4 モジュールに分離する。

| モジュール | 責務 | テスト |
|---|---|---|
| content script | 投稿ページに DL ボタン注入 / postId 検出 | 手動 |
| background (service worker) | 投稿データ取得 → テンプレート展開 → chrome.downloads 実行 | 統合（手動 + 一部） |
| template engine（純粋関数） | context + テンプレ文字列 → 相対パス生成 | TDD |
| sanitizer（純粋関数） | Windows 禁止文字の除去・整形 | TDD |

データソースは Fantia の JSON API（`https://fantia.jp/api/v1/posts/{postId}` 系）を第一候補、
DOM スクレイピングをフォールバックとする。エンドポイント仕様・認証（X-CSRF-Token / セッション cookie）は
**実装時に要検証**。

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

### テンプレート例
```
fantia/$creator/$date{YYYYMMDD}_$postTitle/$contentTitle/$seq{3}_$filename.$ext
```

## 5. 連番 $seq の条件付きルール

- 採番単位: **コンテンツブロックごと**（別ブロックでリセット）。
- **同一ブロック内に対象が 2 つ以上あるときのみ採番**する。
- 対象が 1 つだけのとき: `$seq` は空文字になり、さらに **直後（なければ直前）の区切り文字 1 つ**
  （`_` `-` `.` 空白 のいずれか）も一緒に削除する。
  - 例 `$seq{3}_$filename.$ext`: 複数 → `001_foo.jpg` / 単一 → `foo.jpg`
- この分岐は template engine の責務。TDD で「単一/複数」両ケースを必ずテストする。

## 6. データフロー

1. content script が投稿ページで postId を検出し、DL ボタンを注入。
2. クリックで background へ postId を送信。
3. background が投稿データを取得し、ファイルごとに context を組み立てる。
4. template engine がパス生成 → sanitizer が各セグメントを整形。
   - `/` は階層区切りとして保持。
   - 各プレースホルダ値の中の `/ \ : * ? " < > |` は置換文字（既定 `_`）へ。
5. `chrome.downloads.download({ url, filename, saveAs: false, conflictAction: "uniquify" })`。

## 7. 保存ダイアログ抑制

- `saveAs: false` + `conflictAction: "uniquify"`（実ファイル衝突時に自動で (1)(2) 付与）。
- **注意（事実）**: Chrome 本体設定「ダウンロード前に各ファイルの保存場所を確認する」が ON の場合、
  `saveAs: false` でも保存ダイアログが出得る。README にこの設定を OFF にする旨を明記する。

## 8. 設定（options page / chrome.storage.sync）

- `pathTemplate` … パステンプレート本体
- `illegalCharReplacement` … 禁止文字の置換文字（既定 `_`）
- `conflictAction` … `uniquify` / `overwrite`（既定 `uniquify`）
- `contentTypes` … photo / file / video の有効化トグル
- ライブプレビュー … サンプルデータでテンプレ展開結果を即時表示

## 9. テスト方針（TDD）

- template engine / sanitizer は純粋関数 → Vitest で TDD。
  - 書式展開（各トークン）
  - 連番ゼロ詰め・条件付き $seq（単一/複数）
  - 禁止文字の置換
  - 未知プレースホルダの扱い
- content / background は最小限。拡張ロードと実 DL は手動確認。

## 10. 技術スタック

- TypeScript + Vite（`@crxjs/vite-plugin` を候補、MV3 対応状況を実装時に検証）
- Vitest（純粋モジュールの単体テスト）
- 参考コードは Webpack だが、新規のため Vite を採用。

## 11. 未検証事項（実装フェーズで確認）

- Fantia JSON API の正確なエンドポイントと認証方式。
- 動画コンテンツの取得方法。
- `$plan`（支援プラン名）の取得可否。
- `@crxjs/vite-plugin` の MV3 対応状況。
- Chrome の保存場所確認設定との相互作用の実挙動。
