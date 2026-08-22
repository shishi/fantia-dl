import { DOWNLOAD_CONFLICT_ACTION } from "../core/settings";

// downloads.onDeterminingFilename の横取り対策。
//
// chrome.downloads.download({ filename }) の filename は「提案」に過ぎない。
// downloads.onDeterminingFilename リスナーを登録した拡張がブラウザに居ると、
// こちらのテンプレ名が捨てられ、URL / Content-Disposition 由来の生ファイル名で
// 保存される。同じイベントに出て名前を言い直す以外に手が無い。
//
// 経緯 ── 事実と推論を分けて書く:
// - [実測・姉妹 repo fanbox-dl] 2026-08-18 に MarkSnip(同イベントを service worker
//   のトップレベルで永続登録する拡張)を入れて以降、fanbox-dl の DL が全て生ファイル名に
//   なった。同じ guard を入れて直ることも実ブラウザで確認済み。
// - [実測・本拡張] `onDeterminingFilename` の登録が src・dist ともに 0 件で、
//   `chrome.downloads.download({filename})` の発行が 2 箇所ある。権限も同じ。
// - [推論・未観測] 上記より、本拡張も同じ条件下では同じ症状になるはず。ただし
//   **本拡張で生ファイル名になる現象は観測していない**(MarkSnip 導入前日の
//   2026-08-17 を最後に Fantia から DL していなかったため)。この guard の効果も
//   本拡張では未検証。
//
// 効き方の前提(誤解すると障害対応で迷うので明記する):
// - 同イベントに複数の拡張が出て、いずれも suggest を返した場合、Chrome は
//   後からインストールされた拡張の suggest を採る。つまりこのリスナーを足せば
//   常に勝てるわけではない。
// - [実測 2026-08-22 / MarkSnip 5.2.0] MarkSnip は自分が発行した DL 以外に
//   suggest を返さない(shared/download-tracker.js の handleFilenameConflict が
//   false を返す)。そのため本拡張が唯一の suggester になり、fanbox-dl では実際に
//   通った。本拡張でも同条件なので通る見込みだが未検証。なお MarkSnip 側が
//   更新されればこの前提は黙って崩れる。
// - 将来「全 DL に suggest する拡張」を本拡張より後にインストールすると再び負ける。
//   そのときの症状は「テンプレが効かない」で、今回の症状と区別が付かない。
//   切り分け: 疑わしい拡張を一時無効化してから 1 件 DL し直す。それでテンプレ名に
//   戻るならその拡張が競合相手。
//
// また「全ての DL に suggest する」実装は他拡張を同じやり方で壊す加害側に回る。
// 自分が発行したと積極的に同定できた DL にだけ suggest し、それ以外は suggest を
// 呼ばずに false を返す。
export interface DeterminingFilenameSuggestion {
  filename: string;
  conflictAction: typeof DOWNLOAD_CONFLICT_ACTION;
}

export interface FilenameGuard {
  // claim → download →(失敗なら claim 取り消し)を閉じ込めた発行口。
  // onDeterminingFilename と download() の解決の前後関係は保証されていない
  // (未実測)ため downloadId では紐付けられない。キーにできるのは URL だけ。
  // 呼び出し側が claim を書き漏らす余地を残さないよう、chrome.downloads.download
  // を直接呼ばずに必ずここを通す(通常 DL と zip の blob DL の両方)。
  claimAndDownload(url: string, filename: string, download: () => Promise<number>): Promise<number>;
  handleDeterminingFilename(
    item: { url?: string },
    suggest: (s: DeterminingFilenameSuggestion) => void,
  ): boolean;
}

export function createFilenameGuard(): FilenameGuard {
  // URL -> その URL で待っているテンプレ名の FIFO。
  // 同じ URL の DL が重なる(同じ投稿を続けてクリックする・2 タブで開く)と、
  // 1 URL = 1 スロットでは後勝ちの上書きになり、片方の determining イベントで
  // claim が引けず、その 1 本だけ生ファイル名で保存されてしまう。キューにして
  // 発行順に消費する。
  const claims = new Map<string, string[]>();

  // claim 時に渡す URL 文字列と、イベントで届く DownloadItem.url は表記がズレ得る
  // ため、両側を同じ関数に通して突き合わせる。claim 側だけ・照合側だけを通す
  // 非対称な変更を入れると引き当てに失敗するので、必ず両方に適用すること。
  const keyOf = (url: string): string => {
    try {
      return new URL(url).href;
    } catch {
      return url;
    }
  };

  function claim(url: string, filename: string): void {
    if (!url) return;
    const key = keyOf(url);
    const queue = claims.get(key);
    if (queue) queue.push(filename);
    else claims.set(key, [filename]);
  }

  // 自分が積んだ claim 1 件だけを取り消す。
  //
  // 「キューの末尾を落とす」実装にしてはいけない。claim() と download() の間で
  // 制御が移るため、こちらが await している隙に同一 URL の別の DL が claim を
  // 積める。末尾を落とすと、その別の DL の claim を巻き込んで消してしまい、
  // 巻き込まれた側だけが生ファイル名で保存される(= 本モジュールが直している
  // 症状そのものを、より分かりにくい形で再現してしまう)。
  // 値一致で消し、既に determining イベントに消費されていれば何もしない。
  function release(url: string, filename: string): void {
    if (!url) return;
    const key = keyOf(url);
    const queue = claims.get(key);
    if (!queue) return;
    const at = queue.indexOf(filename);
    if (at < 0) return; // 既に消費済み: 他の DL の claim には手を出さない
    queue.splice(at, 1);
    if (queue.length === 0) claims.delete(key);
  }

  return {
    async claimAndDownload(url, filename, download) {
      claim(url, filename);
      try {
        return await download();
      } catch (e) {
        release(url, filename);
        throw e;
      }
    },
    handleDeterminingFilename(item, suggest) {
      const url = item?.url;
      if (!url) return false;
      const key = keyOf(url);
      const queue = claims.get(key);
      if (!queue || queue.length === 0) return false; // 自分の DL ではない: 干渉しない
      const filename = queue.shift() as string;
      if (queue.length === 0) claims.delete(key);
      suggest({ filename, conflictAction: DOWNLOAD_CONFLICT_ACTION });
      return true;
    },
  };
}

// service-worker が参照する SW 単一インスタンス。
// storage には持たせない(SW を跨いだ復元はしない)。MV3 の SW は idle で終了し、
// その時点でこの Map ごと消えるため、消費されずに残った claim も SW の生存期間に閉じる。
// zipDownloads が storage.session + 起動時復元を持つのは、DL 完了時まで生き延びて
// blob URL を revoke する必要があるからで、要件が異なる。
//
// 既知の残存リスク(承知のうえで対処していない):
// claim が消費されるのは determining イベントが来たときだけで、取り消されるのは
// download() 自体が失敗したときだけ。「download() は解決したのに determining が
// 来ない」DL があると claim が残る。本拡張ではこれが起き得る経路として、署名 URL の
// 失効による中断がある(service-worker.ts の handleEnqueue のコメント参照。復旧は
// ユーザーの再クリックで、そのとき署名 URL も取り直される)。残った claim は
// **同一 URL** の後続 DL に引き当てられる。実害は 2 通り:
//   (a) 別の主体(ユーザーの右クリック保存・他拡張)が同じ URL を落とすと、その DL に
//       本拡張のテンプレ名が付く。署名が変われば別 URL になるので成立域は狭い。
//   (b) 同一 URL が別のテンプレパスで 2 回発行される(同じ画像が別ブロック・別投稿に
//       現れる)と、後発が先発のパスで保存され、後発のパスのファイルが欠ける。
//       planEnqueue の重複排除は relPath 単位で、URL 単位ではない。
// 復旧: 拡張をリロードすれば claim は消える(SW が idle 終了しても同じ)。
//
// 対処していない理由: 塞ぐには DownloadItem.byExtensionId での照合か、claim に
// 寿命を持たせるかだが、前者は determining 時点で byExtensionId が入っているかが
// 未実測で、入っていなければ全ての suggest が止まり修正ごと無効になる。
// 入れるなら先に実測すること(拡張をリロードし、1 件 DL して determining の
// item.byExtensionId を SW の console に出す)。姉妹 repo fanbox-dl も同じ判断で
// 揃えてあるので、変えるなら両方同時に変えること。
export const filenameGuard = createFilenameGuard();
