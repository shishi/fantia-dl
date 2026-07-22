// src/content/zip-support.ts
// zip 組み立ての資源制御(spec 変更 A-4 / B round9/10/21)。
import { zip } from "fflate";
import { validateDownloadUrl } from "../core/url-allowlist";

// ソース総バイト数とファイル件数のバジェット。fanbox-dl の実装値を初期値として流用。
// バジェットはソースバイトのみ計上し、zip 全体のメモリは ~3x 程度になり得る
// (ソース+アーカイブ+base64。既知の residual、round26 で受容済み)。
export const ZIP_SOURCE_BUDGET_BYTES = 100 * 1024 * 1024;
export const ZIP_MAX_FILES = 100;

// フォールバック発生は notices(情報通知)チャネルで表示する(round13:
// error に畳むと「エラー表示なのにボタンは N 件開始」という混乱シグナルになる)。
export const ZIP_FALLBACK_NOTICE = "zip を中止し個別ダウンロードに切り替えました";

// ページ内の zip 組み立てを同時 1 件に直列化する(round21: 一覧面での連打で
// click ごとに独立の zip 収集が並走すると N×バジェットのメモリ増幅が起きる。
// 直列化により in-flight メモリはタブごとに最大 1 バジェットに有界。複数タブ分は
// タブごとの明示的なユーザー操作に比例するため受容する — round22)。
export function createSerialQueue(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.catch(() => { /* 前段の失敗はここで吸収し、次のジョブは必ず実行する */ }).then(() => job());
    tail = run.catch(() => { /* 自分の失敗も後続に伝播させない */ });
    return run;
  };
}

// zipSync(メインスレッド同期圧縮)の代わりに fflate の非同期 zip()(worker ベース)を
// 使い、圧縮中もページの操作性を保つ(round21)。
//
// fix: zip hang guard — fflate 内部の Worker ヘルパー wk() は w.onmessage のみ購読し
// w.onerror を購読していない。Worker コンストラクタの同期 throw は zip() 側で
// reject に変換されるため既存の try/catch で個別 DL フォールバックに落ちるが、
// Worker 生成後の非同期失敗(CSP 違反の非同期エラー、OOM、その他)は受け皿がなく
// コールバックが二度と呼ばれない = Promise が永久 pending になり得る。
// createSerialQueue でタブ内 zip を直列化しているため、1 件でも pending のまま
// 固まると以後の全 zip ジョブが恒久ハングする(ページリロードでしか復旧しない)。
// タイムアウトガードで必ず reject させ、呼び出し側の個別 DL フォールバック +
// ZIP_FALLBACK_NOTICE に落とす。タイムアウト値の根拠は
// .superpowers/sdd/task-7-report.md の "Fix: zip hang guard" セクション参照。
export const ZIP_ASYNC_TIMEOUT_MS = 90 * 1000;

// fflate の zip() と同じコールバック形状。テスト用に差し替え可能にする
// (実運用は fflate の zip をデフォルト採用)。
type ZipImpl = (
  data: Record<string, Uint8Array>,
  opts: Record<string, unknown>,
  cb: (err: Error | null, data: Uint8Array) => void,
) => void;

export function zipAsync(
  entries: Record<string, Uint8Array>,
  opts: { timeoutMs?: number; zipImpl?: ZipImpl } = {},
): Promise<Uint8Array> {
  const timeoutMs = opts.timeoutMs ?? ZIP_ASYNC_TIMEOUT_MS;
  const zipFn: ZipImpl = opts.zipImpl ?? zip;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`zipAsync: ${timeoutMs}ms 経過しても worker から応答がないためタイムアウトしました`));
    }, timeoutMs);
    zipFn(entries, {}, (err, data) => {
      if (settled) return; // タイムアウト側で既に確定済み。二重 settle を防ぐ
      settled = true;
      clearTimeout(timer);
      err ? reject(err) : resolve(data);
    });
  });
}

export type BinaryFetch = (url: string, opts: { maxBytes: number }) =>
  Promise<{ ok: true; buffer: ArrayBuffer } | { ok: false; error: string; tooLarge?: boolean }>;

// zip ソース収集: 各 URL を DL 前 allowlist(spec 変更 B round15 の適用点 b)で検証してから
// fetch し、残バジェットを maxBytes として渡して累積を有界化する(round9/10)。
// どれか 1 つでも失敗したら全体を失敗として返し、呼び出し側(tryZipGallery)が
// ギャラリーごと個別 DL にフォールバックする(黙った欠落の禁止)。
// fetchFn は注入可能(単体テストのため。実運用は fantia-api の fetchBinary)。
export async function collectZipSources(
  urls: string[],
  fetchFn: BinaryFetch,
  limits: { budget?: number; maxFiles?: number } = {},
): Promise<{ ok: true; buffers: Map<string, Uint8Array> } | { ok: false; reason: string }> {
  const budget = limits.budget ?? ZIP_SOURCE_BUDGET_BYTES;
  const maxFiles = limits.maxFiles ?? ZIP_MAX_FILES;
  if (urls.length > maxFiles) return { ok: false, reason: `zip 件数上限(${maxFiles})超過` };
  const buffers = new Map<string, Uint8Array>();
  let used = 0;
  for (const url of urls) {
    const uv = validateDownloadUrl(url);
    if (!uv.ok) return { ok: false, reason: uv.error };
    const res = await fetchFn(url, { maxBytes: budget - used });
    if (!res.ok) {
      return { ok: false, reason: res.tooLarge ? `zip ソースバジェット超過: ${res.error}` : `fetchBinary 失敗: ${res.error}` };
    }
    used += res.buffer.byteLength;
    buffers.set(url, new Uint8Array(res.buffer));
  }
  return { ok: true, buffers };
}
