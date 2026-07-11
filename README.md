# fantia-dl

Fantia の投稿(自分がアクセス権を持つコンテンツ)をテンプレート命名で自動ダウンロードする Chrome 拡張。個人アーカイブ用。参考: mnao305/fantia-dl-tool(MIT)。

## セットアップ

拡張本体は Chrome の V8 で動くので **開発 OS は問わない**(Windows / macOS / Linux で開発可能)。
ビルドツール(esbuild / vitest / tsc)だけ Bun ランタイムが必要。Node.js は不要 —— ツールチェーンは Bun 専用。

### 選択肢A: Bun

前提: Bun がインストール済み

```
bun install && bun scripts/build.mjs
```

### 選択肢B: Nix(flake + direnv)

前提: nix (flakes 有効) と direnv

```
echo "use flake" > .envrc  # 既に含まれる
direnv allow                # 初回だけ
bun install && bun scripts/build.mjs
```

`nix develop` で手動で shell に入っても同じ。Bun のみの環境が立ち上がる。

### 拡張のインストール

1. `dist/` フォルダを Chrome の `chrome://extensions` から「パッケージ化されていない拡張機能を読み込む」で指定
2. Chrome 設定「ダウンロード前に各ファイルの保存場所を確認する」を **OFF** にする(拡張から強制できない、spec §7 参照)

## 使い方
Fantia の投稿ページ右下「⬇ fantia-dl」をクリック。保存先はオプションのテンプレートで決まる。

- **⬇ fantia-dl**: 通常のダウンロード。既に DL 済みの項目は履歴でスキップされる。
- **🔄**: この投稿の DL 履歴(chrome.storage.local に保存されている job レコード)を消してから再ダウンロード。テンプレを修正したときの「やり直し」用。既存ファイルは自動では消えないので、必要なら手動で削除してから押す。

## DL 履歴の保存と自動削除

個別ファイル(photo 単体・file・video)の DL 履歴は `chrome.storage.local` に
保存され、同じ投稿の再クリック時の重複防止 (dedup) に使われます。

- 完了状態(done)の履歴は **1 年経過で自動削除**(SW 起動時 sweep)
- **options で「DL 履歴を全部クリア」ボタン**からいつでも一括削除可能
- zip モードの DL は 1 回きり扱いで履歴に残りません

storage.local の上限は 10 MB。1 job ≈ 1 KB のため通常運用で問題ありません。

## 保存ダイアログについて(重要)
Chrome 設定「ダウンロード前に各ファイルの保存場所を確認する」が ON だと、拡張からは抑制できずダイアログが出ます。OFF にしてください。

## テンプレート
`$creator $creatorId $postTitle $postId $date{YYYYMMDD} $today{} $contentTitle $contentId $contentType $plan $filename $ext $seq $seq{3} $total` とオプショナルグループ `[ ... ]`(中の placeholder が空なら丸ごと消える)。
例: `fantia/$creator/$date{YYYYMMDD}_$postTitle/$contentTitle/[$seq{3}_]$filename.$ext`

## 依存関係の自動更新

Nix flake / Bun / npm / GitHub Actions のバージョン管理は **Renovate**(`.github/renovate.json`)で自動化しています。

- 週次(月曜朝、JST)に Renovate が新バージョンを検出して PR を送信
- GitHub Actions は commit SHA 固定(コメントでタグを併記)。Renovate が SHA を自動更新
- lockFileMaintenance で flake.lock / bun.lock を週次リフレッシュ
- リポジトリの Issues に「Dependency Dashboard」が立つ
- automerge は無効、shishi が確認して merge

初回セットアップ(いずれか片方):

- **Renovate app を初めて使う場合**: [Renovate をインストール](https://github.com/apps/renovate/installations/new) → 選択画面で `fantia-dl` を選ぶ
- **既に他リポで使っている場合**: [Installed GitHub Apps](https://github.com/settings/installations) から Renovate を開いて "Repository access" に `fantia-dl` を追加

いずれも 1 クリック程度の手動作業(GitHub App の install は仕様上 UI 承認が必要で、完全自動化はできません)。
