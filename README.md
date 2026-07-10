# fantia-dl

Fantia の投稿(自分がアクセス権を持つコンテンツ)をテンプレート命名で自動ダウンロードする Chrome 拡張。個人アーカイブ用。参考: mnao305/fantia-dl-tool(MIT)。

## ビルド / インストール
1. `npm install && npm run build`
2. `chrome://extensions` → デベロッパーモード ON → `dist/` を読み込む

## 使い方
Fantia の投稿ページ右下「⬇ fantia-dl」をクリック。保存先はオプションのテンプレートで決まる。

## 保存ダイアログについて(重要)
Chrome 設定「ダウンロード前に各ファイルの保存場所を確認する」が ON だと、拡張からは抑制できずダイアログが出ます。OFF にしてください。

## テンプレート
`$creator $creatorId $postTitle $postId $date{YYYYMMDD} $today{} $contentTitle $contentId $contentType $plan $filename $ext $seq $seq{3} $total` とオプショナルグループ `[ ... ]`(中の placeholder が空なら丸ごと消える)。
例: `fantia/$creator/$date{YYYYMMDD}_$postTitle/$contentTitle/[$seq{3}_]$filename.$ext`
