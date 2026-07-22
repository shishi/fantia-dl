export interface PostMeta {
  creator: string;
  creatorId: string;
  postTitle: string;
  postId: string;
  postedAtIso: string;
}

// fire-and-forget 化(spec 変更 A)に伴い idemKey / refetch / force / downloadUri を廃止。
// SW は item を検証して downloads.download に投げっぱなすだけで、履歴を持たない。
export interface EnqueueItem {
  contentId: string;
  contentTitle: string;
  contentType: string;
  plan: string;
  filename: string;
  ext: string;
  seq: number;
  total: number;
  url: string;
}

export interface EnqueueMessage {
  kind: "enqueue";
  post: PostMeta;
  items: EnqueueItem[];
  pageUrl: string;
}

// SW の応答。アイテム単位の失敗は黙って落とさず、どのアイテムか識別できる文言で
// errors に積む(spec 統一応答契約)。部分成功は queued > 0 かつ errors あり。
export interface EnqueueResponse {
  queued: number;
  errors: string[];
}

// content script 側の統一応答契約(fanbox-dl の DownloadResponse と同型。spec round13/14)。
// notices は情報通知(zip フォールバック等)、errors は「実際に保存できなかったもの」だけ。
export interface DownloadResult {
  queued: number;
  errors: string[];
  notices: string[];
}

// zip 化した photo gallery を background に渡して chrome.downloads.download させる。
// content-script は downloads API にアクセスできない(拡張ページ/SW 限定)ため、
// Blob 生成 + downloads.download 呼び出しは background 側で行う。
//
// zip 全体を 1 メッセージで送ると runtime messaging の 1 メッセージあたりサイズ上限に
// 引っかかる(大きい gallery で失敗する)ため、chrome.runtime.connect の Port 上で
// start -> chunk* -> end のチャンク転送にする(ポート内メッセージ順序は保証される)。
export const ZIP_PORT_NAME = "zipDownload";

// zip は Port 経由で conflictAction を運ばない(spec 変更 A-4 round3)。
// SW 側は DOWNLOAD_CONFLICT_ACTION 定数を直接使う。
export interface ZipStartMessage {
  kind: "start";
  filename: string;
  totalBytes: number;
}
export interface ZipChunkMessage {
  kind: "chunk";
  // runtime messaging は既定で JSON 直列化のみ(ArrayBuffer は運べない)ため base64 文字列で運ぶ。
  data: string;
}
export interface ZipEndMessage {
  kind: "end";
}
export type ZipPortMessage = ZipStartMessage | ZipChunkMessage | ZipEndMessage;

export interface ZipPortResult {
  queued: number;
  error?: string;
}
