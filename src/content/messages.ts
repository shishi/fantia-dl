// page-script との call() ブリッジは kind: string で汎用化されているため、
// "fetchBinary"(zip 用画像取得)を送っても型定義の追加は不要。
export interface PostMeta {
  creator: string;
  creatorId: string;
  postTitle: string;
  postId: string;
  postedAtIso: string;
}

export interface EnqueueItem {
  idemKey: string;
  contentId: string;
  contentTitle: string;
  contentType: string;
  plan: string;
  filename: string;
  ext: string;
  seq: number;
  total: number;
  url: string;
  downloadUri?: string;
  refetch: { postId: string; contentId: string; index: number };
}

export interface EnqueueMessage {
  kind: "enqueue";
  post: PostMeta;
  items: EnqueueItem[];
  pageUrl: string;
  force?: boolean;
}

// options ページから SW へ「DL 履歴を全部クリア」を依頼するメッセージ。
// jobs キーへの書き込みは SW だけが行う不変条件を保つため、options.ts は
// chrome.storage.local を直接叩かずこのメッセージ経由で SW に処理させる。
export interface ClearHistoryMessage {
  kind: "clearHistory";
}

// zip 化した photo gallery を background に渡して chrome.downloads.download させる。
// content-script は downloads API にアクセスできない(拡張ページ/SW 限定)ため、
// Blob 生成 + downloads.download 呼び出しは background 側で行う。
//
// zip 全体を 1 メッセージで送ると runtime messaging の 1 メッセージあたりサイズ上限に
// 引っかかる(大きい gallery で失敗する)ため、chrome.runtime.connect の Port 上で
// start -> chunk* -> end のチャンク転送にする(ポート内メッセージ順序は保証される)。
export const ZIP_PORT_NAME = "zipDownload";

export interface ZipStartMessage {
  kind: "start";
  filename: string;
  conflictAction: "uniquify" | "overwrite";
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
