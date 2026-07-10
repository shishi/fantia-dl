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
}
