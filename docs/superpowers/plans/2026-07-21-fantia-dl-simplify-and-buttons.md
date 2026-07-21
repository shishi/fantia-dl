# fantia-dl 履歴撤去・一覧ボタン・slash 中和 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** fantia-dl から DL 履歴機構(job-store/dedup)を全撤去して fire-and-forget 化し、`/fanclubs/{id}/posts` の投稿カードに DL ボタンを追加し、テンプレートのプレースホルダ展開値に含まれる `/` を中和する(spec: `docs/superpowers/specs/2026-07-21-fantia-dl-simplify-and-buttons-design.md` の変更 A/B/C 全部)。

**Architecture:** MV3 Chrome 拡張。content script(isolated world)が fantia API を直接 fetch して投稿を解析し、SW へ enqueue メッセージを送る。SW は render→validate→`chrome.downloads.download`(uniquify 固定・投げっぱなし)。photo ギャラリーは content script が直列化キュー+ソースバジェット下で zip 化し、Port 経由で SW→offscreen document→blob DL する(失敗時は個別 DL へフォールバック)。既存の page-script(MAIN world)+ postMessage ブリッジは無認証チャネルのため丸ごと廃止する。

**Tech Stack:** TypeScript (strict) / esbuild / vitest (globals:true, node env) / fflate / Chrome Extension MV3 (downloads, storage, offscreen)。パッケージマネージャ・ランナーは bun。

## Global Constraints

- **対象リポジトリ**: WSL 内 `/home/shishi/dev/src/github.com/shishi/fantia-dl`、ブランチ `feat/simplify-and-list-buttons`。作業前に `git status` で clean を確認する。
- **WSL 操作ルール(Windows ホストの Claude Code から実行する場合)**:
  - WSL 内パス(`/home/...`)への Read/Write/Edit/Glob/Grep ツールの直接使用は**絶対禁止**(`C:\home\...` への decoy 書き込み事故が起きる)。
  - 読み取り/編集: UNC パス `\\wsl.localhost\Ubuntu\home\shishi\dev\src\github.com\shishi\fantia-dl\...` なら Read/Edit/Grep 可。
  - シェル操作: Bash ツールで `wsl.exe -e bash -lc '...'`。
  - 新規ファイル作成: Windows 一時ファイル(`C:\Users\shishi\AppData\Local\Temp\`)に Write → `cat /mnt/c/Users/shishi/AppData/Local/Temp/<file> | sed "s/\r$//" > <wsl path>` のパイプ方式(CRLF 除去必須)。
- **コマンド**(すべて `wsl.exe -e bash -lc 'export PATH=$HOME/.npm-global/bin:$PATH && cd /home/shishi/dev/src/github.com/shishi/fantia-dl && <cmd>'` の形で実行):
  - テスト: `bun run test`(= `vitest run`。テストは globals:true なので describe/it の import 不要)
  - 型検査: `bun run typecheck`(= `tsc --noEmit`)
  - ビルド: `bun run build`(= esbuild → `dist/`)
- **core/ を触ってよい範囲**: `src/core/template-engine.ts`(slash 中和)、`src/core/settings.ts`(定数化・allowlist merge・クランプ)、`src/core/sanitizer.ts`(`isSafeReplacement` 追加)、`src/core/url-allowlist.ts`(新設)、`src/core/types.ts`(`Settings.conflictAction` 削除・`FileItem.idemKey`/`refetch` 削除)のみ。`src/core/path-validator.ts` と `src/core/base64.ts` は**変更禁止**。
- **参照実装**: `/home/shishi/dev/src/github.com/shishi/fanbox-dl` は**読み取り専用**。一切変更しない。
- **conflictAction**: 常に `DOWNLOAD_CONFLICT_ACTION` 定数(`"uniquify"`)。overwrite を表現可能にする設定キー・メッセージフィールド・UI を再導入しない(`validatePath` / `checkTemplate` の検証モード引数としての `"uniquify" | "overwrite"` は例外 — これは設定ではなく検証パラメータ)。
- **git**: Conventional Commits(WHY-focused body、git-commit skill 準拠)。`docs/superpowers/` 配下は global gitignore に入っているため、docs 配下のファイルは **`git add -f`** が必要。structural change と behavioral change は別コミット(Tidy First)。
- **hard gate(Task 5)は一覧ボタン(Task 8)有効化の前提条件**。gate 失敗時は Task 8 を実施せず spec 改訂へ(Task 5 内の分岐参照)。
- **手動ゲート以外に実 fantia.jp へのアクセスは不要**。単体テストはすべてネットワーク非依存。

## File Structure(最終形)

- 削除: `src/background/job-store.ts`、`src/content/page-script.ts`
- 新設: `src/content/dom-helpers.ts`(純粋関数: postId 抽出・一覧判定・注入 dedup・isTrusted ゲート)、`src/content/fantia-api.ts`(isolated world fetch: fetchPost / resolveUrl / fetchBinary)、`src/content/zip-support.ts`(バジェット定数・直列化キュー・非同期 zip)、`src/core/url-allowlist.ts`(DL 前 URL 検証)、`src/options/validate-templates.ts`(options 検証の純粋関数)
- 変更: `src/core/{template-engine,settings,sanitizer,types}.ts`、`src/content/{content-script,messages}.ts`、`src/background/service-worker.ts`、`src/fantia/parse.ts`、`src/options/options.ts`、`public/manifest.json`、`public/options/options.html`、`scripts/build.mjs`
- テスト: 新設 `tests/{dom-helpers,fantia-api,url-allowlist,zip-support,options-validate-templates}.test.ts`、更新 `tests/{template-engine,settings,sanitizer,parse}.test.ts`

---

### Task 1: テンプレート値の slash 中和(変更 C-本体)

**Files:**
- Modify: `src/core/template-engine.ts`
- Test: `tests/template-engine.test.ts`

**Interfaces:**
- Consumes: なし(先頭タスク)
- Produces: `renderTemplate(template: string, ctx: RenderContext, opts: { replacement: string; segmentMaxLen: number }): string` — **公開シグネチャ不変**。挙動変更: `$date`/`$today` を除く全プレースホルダの展開値に含まれる `/` を `opts.replacement` に置換する。テンプレート literal の `/` と `$date{}`/`$today{}` 出力の `/` は separator として不変。

- [ ] **Step 1: 失敗するテストを書く**

`tests/template-engine.test.ts` の末尾(最後の `});` の直前)に追加:

```ts
  describe("slash 中和(プレースホルダ展開値の / を replacement に置換)", () => {
    it("サーバ由来値(postTitle 等)の / は置換される", () => {
      expect(renderTemplate("$creator/$postTitle/$filename.$ext", { ...base, postTitle: "お知らせ 1/2" }, O))
        .toBe("sample_creator/お知らせ 1_2/foo.png");
    });
    it("filename の / も置換される(zipEntryTemplate 相当)", () => {
      expect(renderTemplate("[$seq{3}_]$filename.$ext", { ...base, filename: "a/b" }, O)).toBe("001_a_b.png");
    });
    it("テンプレート literal の / は separator として不変", () => {
      expect(renderTemplate("a/b/$filename.$ext", base, O)).toBe("a/b/foo.png");
    });
    it("$date{YYYY/MM} の / は不変(ユーザー自身のフォーマット文字列由来)", () => {
      expect(renderTemplate("$date{YYYY/MM}", base, O)).toBe("2026/01");
    });
    it("$today{YYYY/MM} の / も不変", () => {
      expect(renderTemplate("$today{YYYY/MM}", base, O)).toBe("2026/07");
    });
    it("オプショナルグループ内の値も中和される", () => {
      expect(renderTemplate("a[/$contentTitle]b", { ...base, contentTitle: "x/y" }, O)).toBe("a/x_yb");
    });
    it("置換文字は opts.replacement に従う", () => {
      expect(renderTemplate("$postTitle", { ...base, postTitle: "a/b" }, { replacement: "-", segmentMaxLen: 200 }))
        .toBe("a-b");
    });
  });
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `wsl.exe -e bash -lc 'export PATH=$HOME/.npm-global/bin:$PATH && cd /home/shishi/dev/src/github.com/shishi/fantia-dl && bun run test'`
Expected: FAIL — 「サーバ由来値(postTitle 等)の / は置換される」等が `"sample_creator/お知らせ 1/2/foo.png"`(中和されない値)で失敗する。

- [ ] **Step 3: 実装**

`src/core/template-engine.ts` の `render` 関数と `renderTemplate` を次に差し替える(`parse`/`fmtDate`/`evalPh` は不変):

```ts
// プレースホルダ展開値の / は replacement に中和する(spec 変更 C)。
// - 対象: $date / $today を除く全プレースホルダ。サーバ由来値にたまたま含まれる
//   / が意図しないディレクトリを切るのを防ぐ。除外リスト方式なので、将来の
//   プレースホルダ追加時は安全側(中和される)に倒れる。
// - 非対象: テンプレート literal の /(separator)と、$date{}/$today{} の出力
//   (options ヘルプが「$date{} 内の非トークン文字はそのまま出力」と明記しており、
//   $date{YYYY/MM} の / はユーザー自身が書いた意図された区切りのため)。
const NEUTRALIZE_EXEMPT = new Set(["date", "today"]);

function render(nodes: Node[], ctx: RenderContext, replacement: string): { text: string; hadPh: boolean; anyEmpty: boolean } {
  let text = ""; let hadPh = false; let anyEmpty = false;
  for (const n of nodes) {
    if (n.t === "lit") text += n.v;
    else if (n.t === "ph") {
      let v = evalPh(n.name, n.arg, ctx);
      if (!NEUTRALIZE_EXEMPT.has(n.name)) v = v.split("/").join(replacement);
      hadPh = true; if (v === "") anyEmpty = true; text += v;
    }
    else {
      const r = render(n.children, ctx, replacement);
      hadPh = hadPh || r.hadPh; anyEmpty = anyEmpty || r.anyEmpty;
      if (!(r.hadPh && r.anyEmpty)) text += r.text;
    }
  }
  return { text, hadPh, anyEmpty };
}

export function renderTemplate(
  template: string,
  ctx: RenderContext,
  opts: { replacement: string; segmentMaxLen: number }
): string {
  const raw = render(parse(template), ctx, opts.replacement).text;
  const segs = raw.split("/");
  return segs
    .map((s, idx) => sanitizeSegment(s, { replacement: opts.replacement, maxLen: opts.segmentMaxLen, preserveExt: idx === segs.length - 1 }))
    .join("/");
}
```

- [ ] **Step 4: テストと型検査が通ることを確認**

Run: `wsl.exe -e bash -lc 'export PATH=$HOME/.npm-global/bin:$PATH && cd /home/shishi/dev/src/github.com/shishi/fantia-dl && bun run test && bun run typecheck'`
Expected: 全テスト PASS、tsc エラーなし。

- [ ] **Step 5: コミット**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fantia-dl && git add src/core/template-engine.ts tests/template-engine.test.ts && git commit -m "feat: neutralize slashes in placeholder expansion values

Server-derived values (post titles etc.) containing / used to create
unintended directories. Literals and \$date/\$today output keep / as
separator because those slashes are user-authored (spec change C)."'
```

---

### Task 2: uniquify 固定と settings/options の検証強化(変更 A-3 + C-ガード)

**Files:**
- Modify: `src/core/types.ts`(`Settings` から `conflictAction` 削除)
- Modify: `src/core/settings.ts`(`DOWNLOAD_CONFLICT_ACTION` 定数、allowlist merge、replacement クランプ)
- Modify: `src/core/sanitizer.ts`(`isSafeReplacement` 追加)
- Modify: `src/content/messages.ts`(`ZipStartMessage.conflictAction` 削除)
- Modify: `src/background/service-worker.ts`(定数参照へ差し替え)
- Modify: `src/content/content-script.ts`(`sendZipOverPort` から conflictAction 除去)
- Create: `src/options/validate-templates.ts`
- Modify: `src/options/options.ts`、`public/options/options.html`(conflict select 削除、保存ガード)
- Test: `tests/settings.test.ts`(書き直し)、`tests/sanitizer.test.ts`(追記)、`tests/options-validate-templates.test.ts`(新設)

**Interfaces:**
- Consumes: `renderTemplate`(Task 1 のシグネチャ)、`validatePath(relPath, { fullPathMaxLen, uniquifyHeadroom, conflictAction: "uniquify" | "overwrite", segmentMaxLen })`(既存・変更禁止)
- Produces:
  - `export const DOWNLOAD_CONFLICT_ACTION = "uniquify" as const;`(settings.ts)
  - `mergeSettings(stored: Partial<Settings> | undefined): Settings` — 既知キー allowlist 方式
  - `isSafeReplacement(rep: string): boolean`(sanitizer.ts)
  - `checkTemplate(input: TemplateCheckInput): TemplateCheckResult`、`hasBlockingTemplateError(main: TemplateCheckInput, zip: { zipModeActive: boolean; zipPath: TemplateCheckInput; zipEntry: TemplateCheckInput }): boolean`、`illegalReplacementError(rep: string): string | null`(validate-templates.ts)
  - `ZipStartMessage { kind: "start"; filename: string; totalBytes: number }`
  - content-script 内 `sendZipOverPort(filename: string, bytes: Uint8Array): Promise<ZipPortResult>`

- [ ] **Step 1: 失敗するテストを書く(settings)**

`tests/settings.test.ts` を全置換:

```ts
import { DEFAULT_SETTINGS, mergeSettings, DOWNLOAD_CONFLICT_ACTION } from "../src/core/settings";

describe("mergeSettings", () => {
  it("undefined なら既定値", () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });
  it("部分上書きをマージする", () => {
    const m = mergeSettings({ pathTemplate: "x/$filename.$ext" });
    expect(m.pathTemplate).toBe("x/$filename.$ext");
    expect(m.zipGalleries).toBe(true);
  });
  it("contentTypes をネストマージする", () => {
    const m = mergeSettings({ contentTypes: { photo: false } as any });
    expect(m.contentTypes).toEqual({ photo: false, file: true, video: true });
  });
  it("保存済みの conflictAction(旧キー)は無視され、結果に含まれない", () => {
    const m = mergeSettings({ conflictAction: "overwrite" } as any);
    expect((m as any).conflictAction).toBeUndefined();
  });
  it("未知キーは持ち込まれない(blind spread の廃止)", () => {
    const m = mergeSettings({ evil: 1 } as any);
    expect((m as any).evil).toBeUndefined();
  });
  it("型が合わない保存値は既定値に落ちる", () => {
    const m = mergeSettings({ segmentMaxLen: "200", zipGalleries: "yes" } as any);
    expect(m.segmentMaxLen).toBe(200);
    expect(m.zipGalleries).toBe(true);
  });
  it("DOWNLOAD_CONFLICT_ACTION 定数は uniquify", () => {
    expect(DOWNLOAD_CONFLICT_ACTION).toBe("uniquify");
  });
  it("不正な illegalCharReplacement は既定値 _ にクランプされる(読み込み時ガード)", () => {
    expect(mergeSettings({ illegalCharReplacement: "/" }).illegalCharReplacement).toBe("_");
    expect(mergeSettings({ illegalCharReplacement: "\\" }).illegalCharReplacement).toBe("_");
    expect(mergeSettings({ illegalCharReplacement: "a/b" }).illegalCharReplacement).toBe("_");
    expect(mergeSettings({ illegalCharReplacement: "\x00" }).illegalCharReplacement).toBe("_");
    expect(mergeSettings({ illegalCharReplacement: "-" }).illegalCharReplacement).toBe("-");
  });
  it("既定テンプレは連番オプショナルグループを含む", () => {
    expect(DEFAULT_SETTINGS.pathTemplate).toContain("[$seq{3}_]");
  });
  it("既定は zip モード ON", () => {
    expect(DEFAULT_SETTINGS.zipGalleries).toBe(true);
    expect(DEFAULT_SETTINGS.zipPathTemplate).toContain(".zip");
  });
});
```

`tests/sanitizer.test.ts` の末尾に追加:

```ts
describe("isSafeReplacement(illegalCharReplacement として安全か)", () => {
  it("通常の置換文字と空文字は safe", () => {
    expect(isSafeReplacement("_")).toBe(true);
    expect(isSafeReplacement("-")).toBe(true);
    expect(isSafeReplacement("")).toBe(true);
  });
  it("パス区切り・Windows 禁止文字・制御文字は unsafe", () => {
    for (const c of ["/", "\\", ":", "*", "?", '"', "<", ">", "|", "\x00", "\x1f", "\x7f", "a/b"]) {
      expect(isSafeReplacement(c)).toBe(false);
    }
  });
});
```

同ファイル先頭の import を `import { sanitizeSegment, isSafeReplacement } from "../src/core/sanitizer";` に変更(現行 import に `isSafeReplacement` を追加)。

- [ ] **Step 2: 失敗するテストを書く(options 検証)**

`tests/options-validate-templates.test.ts` を新設:

```ts
import { checkTemplate, hasBlockingTemplateError, illegalReplacementError, type TemplateCheckInput } from "../src/options/validate-templates";
import type { RenderContext } from "../src/core/types";

const ctx: RenderContext = {
  creator: "c", creatorId: "1", postTitle: "t", postId: "1",
  postedAt: new Date("2026-01-01T00:00:00+09:00"), now: new Date(),
  contentTitle: "", contentId: "1", contentType: "photo", plan: "0",
  filename: "image", ext: "png", seq: 1, total: 1,
};
const base: Omit<TemplateCheckInput, "tpl"> = {
  ctx, replacement: "_", segmentMaxLen: 200, fullPathMaxLen: 180, uniquifyHeadroom: 16, conflictAction: "uniquify",
};

describe("checkTemplate(options プレビュー/保存ガードの純粋ロジック)", () => {
  it("正常なテンプレはエラーなし", () => {
    const r = checkTemplate({ ...base, tpl: "$creatorId/$filename.$ext" });
    expect(r.error).toBe("");
    expect(r.rel).toBe("1/image.png");
  });
  it("未定義プレースホルダはテンプレートエラー", () => {
    expect(checkTemplate({ ...base, tpl: "$doesNotExist" }).error).toContain("テンプレートエラー");
  });
  it("実効上限を超えるパスは検証エラー(テンプレートエラーとは区別)", () => {
    const r = checkTemplate({ ...base, tpl: "$creatorId/$filename.$ext", fullPathMaxLen: 3, uniquifyHeadroom: 0 });
    expect(r.error).toContain("検証エラー");
  });
  it("検証モードの差: uniquify は headroom を減算、overwrite(zip entry 用)はしない", () => {
    // 長さ 14 の "1/image....png" 相当を fullPathMaxLen=14, headroom=16 で判定すると
    // uniquify では実効 -2 で必ず落ち、overwrite では 14 <= 14 で通る
    const tpl = "$creatorId/$filename.$ext"; // rel = "1/image.png" (11 文字)
    expect(checkTemplate({ ...base, tpl, fullPathMaxLen: 11, uniquifyHeadroom: 16, conflictAction: "uniquify" }).error).toContain("検証エラー");
    expect(checkTemplate({ ...base, tpl, fullPathMaxLen: 11, uniquifyHeadroom: 16, conflictAction: "overwrite" }).error).toBe("");
  });
});

describe("hasBlockingTemplateError(zip 未使用時は zip テンプレのエラーで保存をブロックしない)", () => {
  const ok: TemplateCheckInput = { ...base, tpl: "$creatorId/$filename.$ext" };
  const bad: TemplateCheckInput = { ...base, tpl: "$doesNotExist" };
  it("メインテンプレのエラーは zip モードに関係なく常にブロック", () => {
    expect(hasBlockingTemplateError(bad, { zipModeActive: false, zipPath: ok, zipEntry: ok })).toBe(true);
  });
  it("zip モード無効時は zip テンプレのエラーをブロックに数えない", () => {
    expect(hasBlockingTemplateError(ok, { zipModeActive: false, zipPath: bad, zipEntry: bad })).toBe(false);
  });
  it("zip モード有効時は zip テンプレのエラーもブロック", () => {
    expect(hasBlockingTemplateError(ok, { zipModeActive: true, zipPath: bad, zipEntry: ok })).toBe(true);
    expect(hasBlockingTemplateError(ok, { zipModeActive: true, zipPath: ok, zipEntry: bad })).toBe(true);
  });
  it("すべて正常ならブロックしない", () => {
    expect(hasBlockingTemplateError(ok, { zipModeActive: true, zipPath: ok, zipEntry: ok })).toBe(false);
  });
});

describe("illegalReplacementError(保存時バリデーション)", () => {
  it("/ や \\ を含む置換文字列はエラー", () => {
    expect(illegalReplacementError("a/b")).not.toBeNull();
    expect(illegalReplacementError("\\")).not.toBeNull();
  });
  it("ILLEGAL 相当(: * ? など)や制御文字もエラー", () => {
    expect(illegalReplacementError(":")).not.toBeNull();
    expect(illegalReplacementError("*")).not.toBeNull();
    expect(illegalReplacementError("\x1f")).not.toBeNull();
  });
  it("通常の置換文字は OK(null)。空文字は options 側で _ にフォールバックする契約のため OK", () => {
    expect(illegalReplacementError("_")).toBeNull();
    expect(illegalReplacementError("-")).toBeNull();
    expect(illegalReplacementError("")).toBeNull();
  });
});
```

- [ ] **Step 3: テストが落ちることを確認**

Run: `wsl.exe -e bash -lc 'export PATH=$HOME/.npm-global/bin:$PATH && cd /home/shishi/dev/src/github.com/shishi/fantia-dl && bun run test'`
Expected: FAIL — `DOWNLOAD_CONFLICT_ACTION` / `isSafeReplacement` / `../src/options/validate-templates` が存在しないため import エラー、および mergeSettings の conflictAction/クランプ系ケースが失敗。

- [ ] **Step 4: core を実装**

`src/core/sanitizer.ts` の末尾に追加:

```ts
// illegalCharReplacement として安全な文字列か(spec 変更 C: replacement 自体のガード)。
// / や \ を許すと sanitizeSegment の置換「後」にパス区切りが新生して中和が無効化され、
// ILLEGAL 相当・制御文字を許すと置換結果自体が不正ファイル名になる。
const UNSAFE_REPLACEMENT = /[\/\\:*?"<>|\x00-\x1f\x7f]/;
export function isSafeReplacement(rep: string): boolean {
  return !UNSAFE_REPLACEMENT.test(rep);
}
```

`src/core/types.ts` の `Settings` から `conflictAction: "uniquify" | "overwrite";` の行を削除する(他は不変)。

`src/core/settings.ts` を全置換:

```ts
import type { Settings } from "./types";
import { isSafeReplacement } from "./sanitizer";

// spec 変更 A-3: dedup 撤去後の耐久性は uniquify の「無言上書きが構造的に起きない」
// 性質に依存する。設定値ではなく定数。どの保存値もこれを変えられない
// (Settings 型から conflictAction を消したので、読み残しはコンパイルエラーになる)。
export const DOWNLOAD_CONFLICT_ACTION = "uniquify" as const;

export const DEFAULT_SETTINGS: Settings = {
  pathTemplate: "fantia/$creator/$date{YYYYMMDD}_$postTitle/$contentTitle/[$seq{3}_]$filename.$ext",
  illegalCharReplacement: "_",
  contentTypes: { photo: true, file: true, video: true },
  segmentMaxLen: 200,
  fullPathMaxLen: 180,
  uniquifyHeadroom: 16,
  zipGalleries: true,
  zipPathTemplate: "fantia/$creator/$date{YYYYMMDD}_$postTitle/$contentTitle.zip",
  zipEntryTemplate: "[$seq{3}_]$filename.$ext",
};

// 既知キーだけを拾う allowlist merge。旧 conflictAction や未知キーを結果に持ち込まない
// (blind spread だと `s.conflictAction` の読み残しが 1 箇所でも生き残れば保存済み
// "overwrite" が復活し得るため、構造的に閉じる。spec 変更 A-3 round2)。
export function mergeSettings(stored: Partial<Settings> | undefined): Settings {
  const s = (stored ?? {}) as Record<string, unknown>;
  const out: Settings = { ...DEFAULT_SETTINGS, contentTypes: { ...DEFAULT_SETTINGS.contentTypes } };
  if (typeof s.pathTemplate === "string") out.pathTemplate = s.pathTemplate;
  // 読み込み時クランプ(spec 変更 C): バリデーション導入前に保存された synced 設定への防御。
  // SW と content-script(zip 経路)の両方が loadSettings 経由のため単一点で効く。
  if (typeof s.illegalCharReplacement === "string" && isSafeReplacement(s.illegalCharReplacement)) {
    out.illegalCharReplacement = s.illegalCharReplacement;
  }
  if (typeof s.segmentMaxLen === "number") out.segmentMaxLen = s.segmentMaxLen;
  if (typeof s.fullPathMaxLen === "number") out.fullPathMaxLen = s.fullPathMaxLen;
  if (typeof s.uniquifyHeadroom === "number") out.uniquifyHeadroom = s.uniquifyHeadroom;
  if (typeof s.zipGalleries === "boolean") out.zipGalleries = s.zipGalleries;
  if (typeof s.zipPathTemplate === "string") out.zipPathTemplate = s.zipPathTemplate;
  if (typeof s.zipEntryTemplate === "string") out.zipEntryTemplate = s.zipEntryTemplate;
  const ct = s.contentTypes as Record<string, unknown> | undefined;
  if (ct) {
    out.contentTypes = {
      photo: typeof ct.photo === "boolean" ? ct.photo : true,
      file: typeof ct.file === "boolean" ? ct.file : true,
      video: typeof ct.video === "boolean" ? ct.video : true,
    };
  }
  return out;
}

export async function loadSettings(): Promise<Settings> {
  const raw = await chrome.storage.sync.get("settings");
  return mergeSettings(raw?.settings as Partial<Settings> | undefined);
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.sync.set({ settings: s });
}
```

`src/options/validate-templates.ts` を新設(fanbox-dl の同名ファイルの翻案。検証モードをテンプレートごとにパラメータ化):

```ts
// src/options/validate-templates.ts
// Options 画面のテンプレ/パス検証を DOM から切り離した純粋関数。
// save ボタンのガード(検証エラーがある間は保存拒否)がロジックとしてテストできるよう、
// options.ts のプレビュー計算とここを共有する(fanbox-dl の validate-templates.ts の翻案)。
import { renderTemplate, TemplateError } from "../core/template-engine";
import { validatePath } from "../core/path-validator";
import { isSafeReplacement } from "../core/sanitizer";
import type { RenderContext } from "../core/types";

export interface TemplateCheckInput {
  tpl: string;
  ctx: RenderContext;
  replacement: string;
  segmentMaxLen: number;
  fullPathMaxLen: number;
  uniquifyHeadroom: number;
  // 検証モード(spec 変更 A-4 round6): "uniquify" = downloads.download を通るパス
  // (pathTemplate / zipPathTemplate。uniquify サフィックス分の headroom を減算)、
  // "overwrite" = zip アーカイブ内部名(zipEntryTemplate。uniquify サフィックスが
  // 付かないため headroom 無効)。実行時検証と常に同じモードで判定し、
  // 「options では通るのに実行時に落ちる」(逆も)の食い違いを作らない。
  conflictAction: "uniquify" | "overwrite";
}

export interface TemplateCheckResult {
  rel: string;   // 検証成功時のプレビュー用パス(失敗時は "")
  error: string; // 空文字ならエラーなし
}

export function checkTemplate(input: TemplateCheckInput): TemplateCheckResult {
  try {
    const rel = renderTemplate(input.tpl, input.ctx, {
      replacement: input.replacement, segmentMaxLen: input.segmentMaxLen,
    });
    const v = validatePath(rel, {
      fullPathMaxLen: input.fullPathMaxLen, uniquifyHeadroom: input.uniquifyHeadroom,
      conflictAction: input.conflictAction, segmentMaxLen: input.segmentMaxLen,
    });
    return { rel, error: v.ok ? "" : `検証エラー: ${v.error}` };
  } catch (e) {
    return { rel: "", error: e instanceof TemplateError ? `テンプレートエラー: ${e.message}` : String(e) };
  }
}

// save ガード: メインテンプレのエラーは常にブロックするが、zip 系テンプレは
// zip モード(zipGalleries + contentTypes.photo)が有効な場合に限りブロック対象にする。
// zip を使っていないユーザーが無関係な設定変更を保存できなくなる regression を防ぐ
// (fanbox-dl の codex レビュー P2 round3 と同じ判断)。
export function hasBlockingTemplateError(
  main: TemplateCheckInput,
  zip: { zipModeActive: boolean; zipPath: TemplateCheckInput; zipEntry: TemplateCheckInput },
): boolean {
  if (checkTemplate(main).error !== "") return true;
  if (!zip.zipModeActive) return false;
  return checkTemplate(zip.zipPath).error !== "" || checkTemplate(zip.zipEntry).error !== "";
}

// 保存時バリデーション(spec 変更 C): replacement に / \ 等の ILLEGAL 相当や制御文字を
// 保存できると slash 中和が無効化・逆用されるため保存前に拒否する。
// 空文字は options.ts 側で "_" にフォールバックする契約のためエラー扱いにしない。
export function illegalReplacementError(rep: string): string | null {
  if (rep === "") return null;
  if (!isSafeReplacement(rep)) {
    return '置換文字に / \\ : * ? " < > | や制御文字は使えません';
  }
  return null;
}
```

- [ ] **Step 5: core のテストが通ることを確認**

Run: `wsl.exe -e bash -lc 'export PATH=$HOME/.npm-global/bin:$PATH && cd /home/shishi/dev/src/github.com/shishi/fantia-dl && bun run test'`
Expected: settings / sanitizer / options-validate-templates の新テストが PASS(typecheck はまだ通らない — SW/CS/options が `s.conflictAction` を読んでいるため。次 Step で解消)。

- [ ] **Step 6: conflictAction の読み残しを全部 DOWNLOAD_CONFLICT_ACTION に置き換える**

`src/content/messages.ts`: `ZipStartMessage` から `conflictAction: "uniquify" | "overwrite";` の行を削除し、interface を次にする(コメントも spec round3 の理由で更新):

```ts
// zip は Port 経由で conflictAction を独自に運ばない(spec 変更 A-4 round3:
// フィールドが残ると settings から消しても overwrite が表現可能なままになる)。
// SW 側は DOWNLOAD_CONFLICT_ACTION 定数を直接使う。
export interface ZipStartMessage {
  kind: "start";
  filename: string;
  totalBytes: number;
}
```

`src/background/service-worker.ts`:
1. import に追加: `import { loadSettings, DOWNLOAD_CONFLICT_ACTION } from "../core/settings";`(既存の loadSettings import を置換)
2. `handleEnqueue` 内の `validatePath(...)` 呼び出しの `conflictAction: s.conflictAction` → `conflictAction: DOWNLOAD_CONFLICT_ACTION`
3. `startDownload` 内の `conflictAction: s.conflictAction` → `conflictAction: DOWNLOAD_CONFLICT_ACTION`
4. `finishZipDownload` のシグネチャを `async function finishZipDownload(jobId: string, filename: string): Promise<ZipPortResult>` に変更し、`chrome.downloads.download({ url: blobUrl, filename, saveAs: false, conflictAction: DOWNLOAD_CONFLICT_ACTION })` にする
5. `chrome.runtime.onConnect` リスナーから `let conflictAction: "uniquify" | "overwrite" = "uniquify";` と `conflictAction = msg.conflictAction;` を削除し、`finishZipDownload(jobId, filename)` 呼び出しに合わせる

`src/content/content-script.ts`:
1. `sendZipOverPort` のシグネチャを `function sendZipOverPort(filename: string, bytes: Uint8Array): Promise<ZipPortResult>` にし、start 送信を `port.postMessage({ kind: "start", filename, totalBytes: bytes.byteLength } as ZipStartMessage);` にする
2. `makeAndDownloadZipInner` 末尾を `return sendZipOverPort(zipPath, zipped);` にする

- [ ] **Step 7: options を書き換える**

`public/options/options.html` から次の 2 行を削除:

```html
<label>衝突時の挙動</label>
<select id="conflict"><option value="uniquify">uniquify(連番付与・推奨)</option><option value="overwrite">overwrite(上書き・注意)</option></select>
```

`src/options/options.ts` を全置換(clearHistory ハンドラは Task 3 で削除するまで現行のまま残す):

```ts
// src/options/options.ts
import { loadSettings, saveSettings, DOWNLOAD_CONFLICT_ACTION } from "../core/settings";
import { checkTemplate, hasBlockingTemplateError, illegalReplacementError, type TemplateCheckInput } from "./validate-templates";
import type { RenderContext, Settings } from "../core/types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const singleSample: RenderContext = {
  creator: "sample_creator", creatorId: "1234", postTitle: "サンプル投稿", postId: "1234567",
  postedAt: new Date("2026-01-15T12:30:00+09:00"), now: new Date(),
  contentTitle: "ギャラリー", contentId: "42", contentType: "photo", plan: "無料プラン",
  filename: "image", ext: "png", seq: 2, total: 4,
};

const zipPathSample: RenderContext = {
  ...singleSample,
  filename: "gallery", ext: "zip", seq: 1, total: 1,
};

const zipEntrySample: RenderContext = { ...singleSample };

let cur: Settings;

// 検証モードは実行時と常に同じにする(spec 変更 A-4 round6):
// pathTemplate / zipPathTemplate は downloads.download を通る → uniquify(headroom 減算あり)。
// zipEntryTemplate はアーカイブ内部名 → overwrite 相当(headroom 無効)。
function templateInput(tpl: string, ctx: RenderContext, conflictAction: "uniquify" | "overwrite"): TemplateCheckInput {
  return {
    tpl, ctx,
    replacement: ($("repl") as HTMLInputElement).value || "_",
    segmentMaxLen: cur.segmentMaxLen,
    fullPathMaxLen: cur.fullPathMaxLen,
    uniquifyHeadroom: cur.uniquifyHeadroom,
    conflictAction,
  };
}

function renderPreview(input: TemplateCheckInput, previewEl: string, errEl: string): void {
  const { rel, error } = checkTemplate(input);
  $(previewEl).textContent = rel;
  $(errEl).textContent = error;
}

function updateAllPreviews(): void {
  renderPreview(templateInput(($("tpl") as HTMLInputElement).value, singleSample, DOWNLOAD_CONFLICT_ACTION), "preview", "tplErr");
  renderPreview(templateInput(($("zip_path_tpl") as HTMLInputElement).value, zipPathSample, DOWNLOAD_CONFLICT_ACTION), "zip_path_preview", "zipPathErr");
  renderPreview(templateInput(($("zip_entry_tpl") as HTMLInputElement).value, zipEntrySample, "overwrite"), "zip_entry_preview", "zipEntryErr");
}

async function init() {
  cur = await loadSettings();
  ($("tpl") as HTMLInputElement).value = cur.pathTemplate;
  ($("zip_path_tpl") as HTMLInputElement).value = cur.zipPathTemplate;
  ($("zip_entry_tpl") as HTMLInputElement).value = cur.zipEntryTemplate;
  ($("repl") as HTMLInputElement).value = cur.illegalCharReplacement;
  ($("ct_photo") as HTMLInputElement).checked = cur.contentTypes.photo;
  ($("ct_file") as HTMLInputElement).checked = cur.contentTypes.file;
  ($("ct_video") as HTMLInputElement).checked = cur.contentTypes.video;
  ($("zip_galleries") as HTMLInputElement).checked = cur.zipGalleries;

  ["tpl", "zip_path_tpl", "zip_entry_tpl", "repl"].forEach((id) =>
    $(id).addEventListener("input", updateAllPreviews),
  );
  updateAllPreviews();

  $("save").addEventListener("click", async () => {
    // クリック時点で再計算した結果で保存可否を判定する(古い DOM の textContent は見ない)
    updateAllPreviews();
    const zipModeActive = ($("zip_galleries") as HTMLInputElement).checked && ($("ct_photo") as HTMLInputElement).checked;
    const blocking = hasBlockingTemplateError(
      templateInput(($("tpl") as HTMLInputElement).value, singleSample, DOWNLOAD_CONFLICT_ACTION),
      {
        zipModeActive,
        zipPath: templateInput(($("zip_path_tpl") as HTMLInputElement).value, zipPathSample, DOWNLOAD_CONFLICT_ACTION),
        zipEntry: templateInput(($("zip_entry_tpl") as HTMLInputElement).value, zipEntrySample, "overwrite"),
      },
    );
    if (blocking) {
      alert("テンプレートにエラーがあります。修正してください");
      return;
    }
    const replError = illegalReplacementError(($("repl") as HTMLInputElement).value);
    if (replError) {
      alert(replError);
      return;
    }
    // 既知キーのみ明示的に書き戻す(blind spread の廃止。spec 変更 A-3 round2)
    cur = {
      pathTemplate: ($("tpl") as HTMLInputElement).value,
      zipPathTemplate: ($("zip_path_tpl") as HTMLInputElement).value,
      zipEntryTemplate: ($("zip_entry_tpl") as HTMLInputElement).value,
      illegalCharReplacement: ($("repl") as HTMLInputElement).value || "_",
      contentTypes: {
        photo: ($("ct_photo") as HTMLInputElement).checked,
        file: ($("ct_file") as HTMLInputElement).checked,
        video: ($("ct_video") as HTMLInputElement).checked,
      },
      zipGalleries: ($("zip_galleries") as HTMLInputElement).checked,
      segmentMaxLen: cur.segmentMaxLen,
      fullPathMaxLen: cur.fullPathMaxLen,
      uniquifyHeadroom: cur.uniquifyHeadroom,
    };
    await saveSettings(cur);
    $("saved").textContent = "保存しました";
    setTimeout(() => ($("saved").textContent = ""), 2000);
  });

  $("clearHistory").addEventListener("click", async () => {
    if (!confirm("DL 履歴を全部クリアしますか?(同じ投稿を再度クリックすると再ダウンロードされるようになります)")) return;
    const btn = $("clearHistory") as HTMLButtonElement;
    btn.disabled = true;
    try {
      const res = await chrome.runtime.sendMessage({ kind: "clearHistory" });
      if (res?.ok) {
        $("clearedNotice").textContent = "履歴をクリアしました";
      } else {
        $("clearedNotice").textContent = `エラー: ${res?.error ?? "不明"}`;
      }
      setTimeout(() => { ($("clearedNotice") as HTMLElement).textContent = ""; }, 3000);
    } finally {
      btn.disabled = false;
    }
  });
}

init();
```

- [ ] **Step 8: 読み残しゼロを確認**

Run: `wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fantia-dl && grep -rn "conflictAction" src/'`
Expected: ヒットは次のみ — `src/core/path-validator.ts`(検証モード引数)、`src/core/settings.ts`(DOWNLOAD_CONFLICT_ACTION 定義とコメント)、`src/options/validate-templates.ts`(検証モード引数)、`src/options/options.ts` と `src/background/service-worker.ts` の `conflictAction: DOWNLOAD_CONFLICT_ACTION` / `"overwrite"` モード指定。`s.conflictAction` / `msg.conflictAction` のヒットが 1 件でもあれば直す。

Run: `wsl.exe -e bash -lc 'export PATH=$HOME/.npm-global/bin:$PATH && cd /home/shishi/dev/src/github.com/shishi/fantia-dl && bun run test && bun run typecheck && bun run build'`
Expected: 全テスト PASS、tsc エラーなし、build 成功。

- [ ] **Step 9: コミット**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fantia-dl && git add -A src public tests && git commit -m "feat: pin conflictAction to uniquify and harden settings/options

After dedup removal (upcoming), overwrite would turn accidental
re-clicks into silent archive destruction. Delete the setting from the
Settings type and the zip port protocol so leftovers fail to compile,
switch mergeSettings to a known-key allowlist so a saved \"overwrite\"
can never resurface, clamp unsafe illegalCharReplacement on load, and
validate templates per execution mode (uniquify vs zip-entry) on save."'
```

---

### Task 3: 履歴機構の全撤去と fire-and-forget 化(変更 A)

**Files:**
- Delete: `src/background/job-store.ts`
- Modify: `src/background/service-worker.ts`、`src/content/messages.ts`、`src/content/content-script.ts`、`src/core/types.ts`、`src/fantia/parse.ts`、`src/options/options.ts`、`public/options/options.html`
- Test: `tests/parse.test.ts`

**Interfaces:**
- Consumes: `DOWNLOAD_CONFLICT_ACTION`(Task 2)、`renderTemplate` / `validatePath`(既存)
- Produces(messages.ts、以後のタスクはこの形を前提にする):
  - `EnqueueItem { contentId: string; contentTitle: string; contentType: string; plan: string; filename: string; ext: string; seq: number; total: number; url: string }`(idemKey / refetch / downloadUri 廃止)
  - `EnqueueMessage { kind: "enqueue"; post: PostMeta; items: EnqueueItem[]; pageUrl: string }`(force 廃止)
  - `EnqueueResponse { queued: number; errors: string[] }`(SW の応答)
  - `DownloadResult { queued: number; errors: string[]; notices: string[] }`(content script 側の統一応答契約。notices は Task 7 まで常に空)
  - `FileItem`(types.ts)から `idemKey` / `refetch` を削除

- [ ] **Step 1: parse のテストを新契約に更新**

`tests/parse.test.ts` から次の 1 行を削除:

```ts
    expect(c.files[0].idemKey).toBe("1234567:42:0");
```

- [ ] **Step 2: types / parse から idemKey・refetch を削除**

`src/core/types.ts` の `FileItem` を次にする:

```ts
export interface FileItem {
  contentType: ContentType;
  directUrl?: string;        // photo: url.original(署名済み)
  downloadUri?: string;      // file/video: /posts/{postId}/download/{contentId}
  filename: string | null;   // file: 元名(拡張子除く) / photo: URL basename(UUID)
  ext: string;               // 拡張子(ドットなし)
  seq: number;               // ブロック内 1-based index
  total: number;             // ブロック内総数
}
```

`src/fantia/parse.ts` の photo 分岐・file 分岐・forEach を次にする(他は不変):

```ts
      files = photos.map((url: string) => ({
        contentType, directUrl: url, filename: baseNoExt(url), ext: extFromUrl(url),
        seq: 0, total: 0,
      }));
```

```ts
        files = [{
          contentType, downloadUri: String(c.download_uri), filename: base, ext,
          seq: 0, total: 0,
        }];
```

```ts
    files.forEach((f, i) => { f.seq = i + 1; f.total = files.length; });
```

Run: `wsl.exe -e bash -lc 'export PATH=$HOME/.npm-global/bin:$PATH && cd /home/shishi/dev/src/github.com/shishi/fantia-dl && bun run test'`
Expected: parse テスト PASS(typecheck は SW/CS が旧フィールドを参照しているためまだ落ちる)。

- [ ] **Step 3: messages.ts を新契約に書き換える**

`src/content/messages.ts` を全置換:

```ts
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
```

- [ ] **Step 4: service-worker を fire-and-forget に書き換え、job-store を削除**

`src/background/job-store.ts` を削除: `wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fantia-dl && git rm src/background/job-store.ts'`

`src/background/service-worker.ts` に次の変更を加える(**zip 関連のコード — `zipDownloads` Map / `persistZipDownloads` / `loadZipDownloads` / `ensureOffscreenDocument` / `sendChunkToOffscreen` / `finishZipDownload` / `revokeOffscreenUrl` / `discardOffscreenJob` / `chrome.runtime.onConnect` リスナー / zip の起動時 reconcile IIFE — はコメント含め一切変更しない**。dedup と無関係の資源管理のため維持する。spec 変更 A-4):

1. import を次にする(job-store import の削除、`EnqueueResponse` の追加):

```ts
import { loadSettings, DOWNLOAD_CONFLICT_ACTION } from "../core/settings";
import { renderTemplate, TemplateError } from "../core/template-engine";
import { validatePath } from "../core/path-validator";
import type { RenderContext } from "../core/types";
import type { EnqueueMessage, EnqueueItem, EnqueueResponse, PostMeta, ZipPortMessage, ZipPortResult } from "../content/messages";
import { ZIP_PORT_NAME } from "../content/messages";
import { OFFSCREEN_TARGET } from "../offscreen/protocol";
import type {
  OffscreenAbortMessage,
  OffscreenChunkMessage,
  OffscreenDoneMessage,
  OffscreenRevokeMessage,
  OffscreenResult,
} from "../offscreen/protocol";
```

2. `handleEnqueue` と `startDownload` を次の 1 関数に置き換える(`ctxOf` は不変):

```ts
// fire-and-forget(spec 変更 A): 検証を通過した item を downloads.download に
// 投げっぱなしにし、結果を永続追跡しない。同名衝突は uniquify 固定に委ね、
// 失敗した DL の復旧はユーザーの再クリック(photo の署名 URL もそのとき取り直される)。
// アイテム単位の失敗は黙って落とさず errors に積む(統一応答契約)。
async function handleEnqueue(msg: EnqueueMessage): Promise<EnqueueResponse> {
  const s = await loadSettings();
  const enabled = (t: string) => (s.contentTypes as Record<string, boolean>)[t] !== false;
  const seenPaths = new Set<string>();
  const errors: string[] = [];
  let queued = 0;

  for (const it of msg.items) {
    if (!enabled(it.contentType)) continue;
    if (!it.url) { errors.push(`${it.filename || it.contentId}.${it.ext}: url 未解決`); continue; }
    let relPath: string;
    try {
      relPath = renderTemplate(s.pathTemplate, ctxOf(msg.post, it), { replacement: s.illegalCharReplacement, segmentMaxLen: s.segmentMaxLen });
    } catch (e) {
      errors.push(e instanceof TemplateError ? `テンプレートエラー: ${e.message}` : String(e));
      break; // テンプレ不正は全 item が同じ理由で失敗するため全体中断
    }
    const v = validatePath(relPath, { fullPathMaxLen: s.fullPathMaxLen, uniquifyHeadroom: s.uniquifyHeadroom, conflictAction: DOWNLOAD_CONFLICT_ACTION, segmentMaxLen: s.segmentMaxLen });
    if (!v.ok) { errors.push(`${relPath}: ${v.error}`); continue; }
    if (seenPaths.has(relPath)) { errors.push(`バッチ内パス重複: ${relPath}`); continue; }
    seenPaths.add(relPath);
    try {
      await chrome.downloads.download({ url: it.url, filename: relPath, saveAs: false, conflictAction: DOWNLOAD_CONFLICT_ACTION });
      queued++;
    } catch (e) {
      errors.push(`${relPath}: ${String(e)}`);
    }
  }
  return { queued, errors };
}
```

3. `chrome.runtime.onMessage` リスナーを次に置き換える(clearHistory 分岐の削除):

```ts
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.kind === "enqueue") {
    handleEnqueue(msg as EnqueueMessage)
      .then(sendResponse)
      .catch((e) => sendResponse({ queued: 0, errors: [String(e)] } satisfies EnqueueResponse));
    return true;
  }
  return false;
});
```

4. `chrome.downloads.onChanged` リスナーを次に置き換える(通常 DL 分岐 — done/needs_page/error 記録 — の削除。zip の revoke は維持):

```ts
chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state) return;
  const cur = delta.state.current;
  if (cur !== "complete" && cur !== "interrupted") return;

  const zipUrl = zipDownloads.get(delta.id);
  if (zipUrl === undefined) return; // 通常 DL は追跡しない(fire-and-forget)
  zipDownloads.delete(delta.id);
  await persistZipDownloads();
  await revokeOffscreenUrl(zipUrl);
});
```

5. ファイル末尾の「起動時 reconcile (通常 DL)」IIFE(`sweepOldDoneJobs` 呼び出しを含む方)を丸ごと削除し、代わりに migration を置く:

```ts
// migration(fantia 固有): 既存ユーザーの chrome.storage.local に残る旧履歴
// (jobs キー)を除去する。冪等・毎起動実行で害なし(spec 変更 A)。
void chrome.storage.local.remove("jobs");
```

- [ ] **Step 5: content-script から force / 🔄 を撤去し統一応答契約にする**

`src/content/content-script.ts` に次の変更を加える(page-script ブリッジ `injectPageScript`/`call` は Task 4 で廃止するため、このタスクでは現状維持):

1. import の型リストを更新: `import type { EnqueueItem, EnqueueMessage, EnqueueResponse, DownloadResult, PostMeta, ZipPortResult, ZipStartMessage, ZipChunkMessage, ZipEndMessage } from "./messages";`
2. `makeAndDownloadZip(block, post, s, _force)` の第 4 引数 `_force` を削除(呼び出し側も合わせる)。
3. `runDownload(force: boolean)` を次に置き換える:

```ts
async function runDownload(): Promise<DownloadResult | null> {
  const postId = postIdFromUrl();
  if (!postId) { alert("[fantia-dl] postId 不明"); return null; }
  const fetched = await call("fetchPost", { postId });
  if (!fetched.ok) { alert(`[fantia-dl] 取得失敗: ${fetched.error}`); return null; }
  const post = parsePost(fetched.json);
  const s = await loadSettings();

  const meta: PostMeta = {
    creator: post.creator, creatorId: post.creatorId, postTitle: post.postTitle,
    postId: post.postId, postedAtIso: post.postedAt.toISOString(),
  };
  const items: EnqueueItem[] = [];
  let zipQueued = 0;
  const errors: string[] = [];
  const notices: string[] = []; // zip フォールバック通知用(Task 7 で使用開始)
  for (const c of post.contents) {
    if (c.contentType === "photo" && c.files.length >= 2 && s.zipGalleries && s.contentTypes.photo) {
      const r = await makeAndDownloadZip(c, post, s);
      if (r.error) errors.push(r.error); else zipQueued += r.queued;
      continue;
    }
    for (const f of c.files) {
      let url = f.directUrl ?? "";
      if (!url && f.downloadUri) {
        const resolved = await call("resolveUrl", { downloadUri: f.downloadUri });
        // 統一応答契約: アイテム単位の失敗は黙って落とさず、識別可能な文言で errors に積む
        if (!resolved.ok) { errors.push(`${f.filename ?? ""}.${f.ext}: URL 解決失敗(${resolved.error ?? "不明"})`); continue; }
        url = resolved.url;
      }
      items.push({
        contentId: c.contentId, contentTitle: c.contentTitle ?? "",
        contentType: f.contentType, plan: c.plan ?? "", filename: f.filename ?? "",
        ext: f.ext, seq: f.seq, total: f.total, url,
      });
    }
  }

  let queued = zipQueued;
  if (items.length > 0) {
    const res = (await chrome.runtime.sendMessage({ kind: "enqueue", post: meta, items, pageUrl: location.href } satisfies EnqueueMessage)) as EnqueueResponse | undefined;
    if (!res) errors.push("background から応答がありません");
    else { queued += res.queued; errors.push(...res.errors); }
  }
  if (errors.length) alert(`[fantia-dl] エラー: ${errors.join(" / ")}`);
  if (notices.length) alert(`[fantia-dl] お知らせ:\n${notices.join("\n")}`);
  return { queued, errors, notices };
}
```

4. `addButton` から `retryBtn` 一式(生成・リスナー・`container.appendChild(retryBtn)`)を削除し、メインボタンを次にする(title 文言変更が spec の normative 要件):

```ts
  const btn = document.createElement("button");
  btn.id = "fdl-btn"; btn.type = "button"; btn.textContent = "⬇ fantia-dl";
  btn.title = "この投稿をダウンロード";
  styleBtn(btn);
  btn.addEventListener("click", () => {
    btn.disabled = true;
    runDownload().then((r) => {
      if (r) swapText(btn, `⬇ ${r.queued} 件開始`);
      else btn.disabled = false;
    }).catch(() => { btn.disabled = false; });
  });
```

- [ ] **Step 6: options から DL 履歴 UI を削除**

`public/options/options.html` から `<hr style="margin: 24px 0; ...">` から `</p>`(`clearedNotice` を含む段落)までの「DL 履歴の管理」セクション全体(現行 115〜124 行目)を削除する。

`src/options/options.ts` から `$("clearHistory").addEventListener(...)` ブロック全体を削除する。

- [ ] **Step 7: 検証**

Run: `wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fantia-dl && grep -rn "idemKey\|refetch\|clearHistory\|force\|job-store\|JobRecord" src/ public/ | grep -v "\.map"'`
Expected: ヒット 0 件(あれば読み残し。直す)。

Run: `wsl.exe -e bash -lc 'export PATH=$HOME/.npm-global/bin:$PATH && cd /home/shishi/dev/src/github.com/shishi/fantia-dl && bun run test && bun run typecheck && bun run build'`
Expected: 全テスト PASS、tsc エラーなし、build 成功。

- [ ] **Step 8: コミット**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fantia-dl && git add -A src public tests && git commit -m "feat!: remove download-history dedup, go fire-and-forget

The job-store bought dedup at the cost of state machines, reconcile
loops, sweeps and a clear-history UI. fanbox-dl proved fire-and-forget
plus uniquify is enough: recovery is a re-click (which also refreshes
signed photo URLs). Per-item failures now surface in the unified
{queued, errors, notices} response instead of console.warn. Old jobs
key is removed from storage.local on every SW start (idempotent)."'
```

---

### Task 4: page-script ブリッジの廃止と isolated world fetch への移行(変更 B round19/23)

**Files:**
- Create: `src/content/fantia-api.ts`
- Delete: `src/content/page-script.ts`
- Modify: `src/content/content-script.ts`、`public/manifest.json`、`scripts/build.mjs`
- Test: `tests/fantia-api.test.ts`(新設)

**Interfaces:**
- Consumes: なし(独立モジュール)
- Produces(fantia-api.ts、Task 6/7/8 が使用):
  - `ApiResponse { ok: boolean; status: number; url: string; headers: { get(name: string): string | null }; json(): Promise<any>; arrayBuffer(): Promise<ArrayBuffer>; body: { cancel(): Promise<void> } | null }`
  - `ApiFetch = (url: string, init?: RequestInit) => Promise<ApiResponse>`
  - `csrfToken(): string`
  - `fetchPost(postId: string, deps?: { fetchFn?: ApiFetch; csrf?: () => string }): Promise<{ ok: true; json: any } | { ok: false; error: string }>`
  - `resolveUrl(downloadUri: string, deps?: { fetchFn?: ApiFetch; csrf?: () => string }): Promise<{ ok: true; url: string } | { ok: false; error: string }>`
  - `fetchBinary(url: string, opts?: { maxBytes?: number }, deps?: { fetchFn?: ApiFetch }): Promise<{ ok: true; buffer: ArrayBuffer } | { ok: false; error: string; tooLarge?: boolean }>`

- [ ] **Step 1: 失敗するテストを書く**

`tests/fantia-api.test.ts` を新設:

```ts
import { fetchPost, resolveUrl, fetchBinary, type ApiResponse } from "../src/content/fantia-api";

function makeRes(over: Partial<ApiResponse>): ApiResponse {
  const status = over.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    url: "https://fantia.jp/x",
    headers: { get: () => null },
    json: async () => ({}),
    arrayBuffer: async () => new ArrayBuffer(0),
    body: null,
    ...over,
  };
}

describe("fetchPost", () => {
  it("200 なら json を返す(credentials/csrf ヘッダ付き)", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return makeRes({ json: async () => ({ post: { id: 1 } }) });
    };
    const r = await fetchPost("1", { fetchFn, csrf: () => "tok" });
    expect(r).toEqual({ ok: true, json: { post: { id: 1 } } });
    expect(calls[0].url).toBe("https://fantia.jp/api/v1/posts/1");
    expect((calls[0].init!.headers as Record<string, string>)["X-CSRF-Token"]).toBe("tok");
    expect((calls[0].init!.headers as Record<string, string>)["X-Requested-With"]).toBe("XMLHttpRequest");
    expect(calls[0].init!.credentials).toBe("include");
  });
  it("401 は csrf を読み直して 1 回だけリトライする", async () => {
    let tok = "old";
    const seen: string[] = [];
    const fetchFn = async (_url: string, init?: RequestInit) => {
      seen.push((init!.headers as Record<string, string>)["X-CSRF-Token"]);
      return seen.length === 1 ? makeRes({ status: 401 }) : makeRes({});
    };
    const r = await fetchPost("1", { fetchFn, csrf: () => { const t = tok; tok = "new"; return t; } });
    expect(r.ok).toBe(true);
    expect(seen).toEqual(["old", "new"]);
  });
  it("リトライ後も失敗なら fail(2 回で打ち止め)", async () => {
    let n = 0;
    const r = await fetchPost("1", { fetchFn: async () => { n++; return makeRes({ status: 422 }); }, csrf: () => "t" });
    expect(r).toEqual({ ok: false, error: "status 422" });
    expect(n).toBe(2);
  });
  it("404 は即 fail(リトライしない)", async () => {
    let n = 0;
    const r = await fetchPost("1", { fetchFn: async () => { n++; return makeRes({ status: 404 }); }, csrf: () => "" });
    expect(r).toEqual({ ok: false, error: "status 404" });
    expect(n).toBe(1);
  });
});

describe("resolveUrl", () => {
  it("Range: bytes=0-0 で fetch し本文を即 cancel、最終 URL を返す(全ファイルを転送しない契約)", async () => {
    let cancelled = false;
    let init: RequestInit | undefined;
    let url = "";
    const fetchFn = async (u: string, i?: RequestInit) => {
      url = u; init = i;
      return makeRes({ url: "https://cc.fantia.jp/uploads/file.mp4", body: { cancel: async () => { cancelled = true; } } });
    };
    const r = await resolveUrl("/posts/1/download/2", { fetchFn, csrf: () => "t" });
    expect(r).toEqual({ ok: true, url: "https://cc.fantia.jp/uploads/file.mp4" });
    expect(url).toBe("https://fantia.jp/posts/1/download/2"); // 相対 uri は fantia.jp に解決
    expect((init!.headers as Record<string, string>)["Range"]).toBe("bytes=0-0");
    expect(cancelled).toBe(true);
  });
  it("!ok は fail-closed(旧実装はエラーページ URL を成功として返す fail-open だった)", async () => {
    const r = await resolveUrl("/posts/1/download/2", { fetchFn: async () => makeRes({ status: 404 }), csrf: () => "t" });
    expect(r).toEqual({ ok: false, error: "status 404" });
  });
});

describe("fetchBinary", () => {
  it("200 なら buffer を返し、redirect:'error' で fetch する(zip への任意バイト列混入防止)", async () => {
    let init: RequestInit | undefined;
    const r = await fetchBinary("https://c.fantia.jp/a.png", {}, {
      fetchFn: async (_u, i) => { init = i; return makeRes({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }); },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.buffer.byteLength).toBe(3);
    expect(init!.redirect).toBe("error");
  });
  it("Content-Length が maxBytes 超過なら本文を読まず cancel して tooLarge(事前ゲート)", async () => {
    let cancelled = false;
    let bodyRead = false;
    const r = await fetchBinary("https://c.fantia.jp/a.png", { maxBytes: 10 }, {
      fetchFn: async () => makeRes({
        headers: { get: (n: string) => (n.toLowerCase() === "content-length" ? "11" : null) },
        arrayBuffer: async () => { bodyRead = true; return new ArrayBuffer(11); },
        body: { cancel: async () => { cancelled = true; } },
      }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.tooLarge).toBe(true);
    expect(cancelled).toBe(true);
    expect(bodyRead).toBe(false);
  });
  it("Content-Length 無し応答は取得後判定(best-effort)で tooLarge", async () => {
    const r = await fetchBinary("https://c.fantia.jp/a.png", { maxBytes: 2 }, {
      fetchFn: async () => makeRes({ arrayBuffer: async () => new ArrayBuffer(3) }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.tooLarge).toBe(true);
  });
  it("ネットワーク例外(redirect:'error' による遮断含む)は ok:false", async () => {
    const r = await fetchBinary("https://c.fantia.jp/a.png", {}, { fetchFn: async () => { throw new TypeError("Failed to fetch"); } });
    expect(r.ok).toBe(false);
  });
  it("status 失敗は ok:false", async () => {
    const r = await fetchBinary("https://c.fantia.jp/a.png", {}, { fetchFn: async () => makeRes({ status: 403 }) });
    expect(r).toEqual({ ok: false, error: "status 403" });
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `wsl.exe -e bash -lc 'export PATH=$HOME/.npm-global/bin:$PATH && cd /home/shishi/dev/src/github.com/shishi/fantia-dl && bun run test'`
Expected: FAIL — `../src/content/fantia-api` が存在しない。

- [ ] **Step 3: fantia-api.ts を実装**

`src/content/fantia-api.ts` を新設:

```ts
// src/content/fantia-api.ts
// isolated world(content script)から fantia API / CDN を直接 fetch する。
// 旧 page-script(MAIN world)+ postMessage ブリッジは無認証チャネルで、ページ JS が
// 偽 post JSON・偽解決 URL・fetchBinary への任意バイト列を注入できたため、チャネルを
// 守るのではなくチャネルごと削除した(spec 変更 B round19)。MV3 の isolated world
// fetch はページと同じ CORS/cookie 挙動で、csrf meta も DOM から読めるため機能は等価。

export interface ApiResponse {
  ok: boolean;
  status: number;
  url: string;
  headers: { get(name: string): string | null };
  json(): Promise<any>;
  arrayBuffer(): Promise<ArrayBuffer>;
  body: { cancel(): Promise<void> } | null;
}
export type ApiFetch = (url: string, init?: RequestInit) => Promise<ApiResponse>;

const realFetch: ApiFetch = (url, init) => fetch(url, init);

const RETRY_STATUS = new Set([401, 403, 422]);
const AUTH = (csrf: string) => ({ "X-CSRF-Token": csrf, "X-Requested-With": "XMLHttpRequest" });

export function csrfToken(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? "";
}

// 401/403/422 のとき csrf meta を読み直して 1 回だけリトライする
// (旧 page-script の契約を維持。落とすと stale token での間欠失敗が全て手動リトライに退行する)。
async function fetchWithCsrfRetry(
  url: string, extra: Record<string, string>, fetchFn: ApiFetch, csrf: () => string,
): Promise<ApiResponse> {
  let r = await fetchFn(url, { credentials: "include", headers: { ...AUTH(csrf()), ...extra } });
  if (RETRY_STATUS.has(r.status)) {
    r = await fetchFn(url, { credentials: "include", headers: { ...AUTH(csrf()), ...extra } });
  }
  return r;
}

export async function fetchPost(
  postId: string,
  deps: { fetchFn?: ApiFetch; csrf?: () => string } = {},
): Promise<{ ok: true; json: any } | { ok: false; error: string }> {
  const fetchFn = deps.fetchFn ?? realFetch;
  const csrf = deps.csrf ?? csrfToken;
  try {
    const r = await fetchWithCsrfRetry(`https://fantia.jp/api/v1/posts/${postId}`, {}, fetchFn, csrf);
    if (!r.ok) return { ok: false, error: `status ${r.status}` };
    return { ok: true, json: await r.json() };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// download_uri(/posts/{postId}/download/{contentId})の最終 URL を解決する。
// Range: bytes=0-0 で fetch し本文を即 cancel(解決のために全ファイルを転送しない
// normative 契約。落とすと「解決で 1 回 + DL で 1 回」の二重転送になる)。
// r.ok でなければ fail-closed(旧実装は 403/404 でもエラーページ URL を
// 「解決成功」として返す fail-open だった。spec round7)。
export async function resolveUrl(
  downloadUri: string,
  deps: { fetchFn?: ApiFetch; csrf?: () => string } = {},
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const fetchFn = deps.fetchFn ?? realFetch;
  const csrf = deps.csrf ?? csrfToken;
  let target: string;
  try {
    target = new URL(downloadUri, "https://fantia.jp").toString();
  } catch {
    return { ok: false, error: `download_uri が不正: ${downloadUri}` };
  }
  try {
    const r = await fetchWithCsrfRetry(target, { Range: "bytes=0-0" }, fetchFn, csrf);
    try { await r.body?.cancel(); } catch { /* 既読/クローズ済みは無視 */ }
    if (!r.ok) return { ok: false, error: `status ${r.status}` };
    return { ok: true, url: r.url };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// zip ソース(photo の signed URL)取得。
// - redirect:"error": 許可ホストを通過した URL が非許可ホストへリダイレクトして
//   任意バイト列を zip に混入させる経路を封じる(spec round17。signed URL は
//   正規にはリダイレクトしないため正常系への影響は無い)。
// - maxBytes: Content-Length ヘッダによる事前ゲート(超過確定なら本文を読まず
//   cancel して tooLarge)+ 取得後の実サイズ判定(Content-Length 無し応答の
//   best-effort。spec round10: 単発スパイクは残るが蓄積はバジェットで有界)。
// - signed URL は CSRF 不要 → AUTH ヘッダなし・cookie も付けない単純 fetch。
export async function fetchBinary(
  url: string,
  opts: { maxBytes?: number } = {},
  deps: { fetchFn?: ApiFetch } = {},
): Promise<{ ok: true; buffer: ArrayBuffer } | { ok: false; error: string; tooLarge?: boolean }> {
  const fetchFn = deps.fetchFn ?? realFetch;
  try {
    const r = await fetchFn(url, { redirect: "error" });
    if (!r.ok) return { ok: false, error: `status ${r.status}` };
    if (opts.maxBytes !== undefined) {
      const len = Number(r.headers.get("content-length"));
      if (Number.isFinite(len) && len > opts.maxBytes) {
        try { await r.body?.cancel(); } catch { /* 無視 */ }
        return { ok: false, tooLarge: true, error: `Content-Length ${len} がバジェット残 ${opts.maxBytes} を超過` };
      }
    }
    const buffer = await r.arrayBuffer();
    if (opts.maxBytes !== undefined && buffer.byteLength > opts.maxBytes) {
      return { ok: false, tooLarge: true, error: `取得サイズ ${buffer.byteLength} がバジェット残 ${opts.maxBytes} を超過` };
    }
    return { ok: true, buffer };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `wsl.exe -e bash -lc 'export PATH=$HOME/.npm-global/bin:$PATH && cd /home/shishi/dev/src/github.com/shishi/fantia-dl && bun run test'`
Expected: tests/fantia-api.test.ts 全 PASS。

- [ ] **Step 5: content-script をブリッジから直接呼び出しに切り替え、page-script を削除**

`src/content/content-script.ts`:
1. import に追加: `import { fetchPost, resolveUrl, fetchBinary } from "./fantia-api";`
2. `injectPageScript` 関数・`csrf` 定数・`reqSeq` 変数・`call` 関数を丸ごと削除。
3. `runDownload` 内の `const fetched = await call("fetchPost", { postId });` → `const fetched = await fetchPost(postId);`
4. `runDownload` 内の `const resolved = await call("resolveUrl", { downloadUri: f.downloadUri });` → `const resolved = await resolveUrl(f.downloadUri);`(失敗時の errors 文言は `resolved.error ?? "不明"` → `resolved.error` に単純化してよい — 新 API は error 必須)
5. `makeAndDownloadZipInner` 内の `const res = await call("fetchBinary", { url: f.directUrl });` と後続を次にする:

```ts
    const res = await fetchBinary(f.directUrl);
    if (!res.ok) return { queued: 0, error: `fetchBinary failed: ${res.error}` };
```

6. ファイル末尾の `(async () => { await injectPageScript(); addButton(); })();` → `addButton();`

`src/content/page-script.ts` を削除: `wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fantia-dl && git rm src/content/page-script.ts'`

`public/manifest.json` から `web_accessible_resources` キーを丸ごと削除(page-script エントリしか無いため):

```json
  "web_accessible_resources": [
    { "resources": ["content/page-script.js"], "matches": ["https://fantia.jp/*"] }
  ],
```

`scripts/build.mjs` の entries から次の 1 行を削除:

```js
  { in: "src/content/page-script.ts",       out: "dist/content/page-script.js",       format: "iife" },
```

- [ ] **Step 6: 検証**

Run: `wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fantia-dl && grep -rn "__fdl\|page-script\|postMessage" src/ public/ scripts/'`
Expected: ヒット 0 件(port.postMessage は `port.` 付きなので該当しない。素の `window.postMessage`/`__fdl` が残っていれば削除漏れ)。

Run: `wsl.exe -e bash -lc 'export PATH=$HOME/.npm-global/bin:$PATH && cd /home/shishi/dev/src/github.com/shishi/fantia-dl && bun run test && bun run typecheck && bun run build'`
Expected: 全テスト PASS、tsc エラーなし、build 成功(dist/content/page-script.js が生成されないこと)。

- [ ] **Step 7: コミット**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fantia-dl && git add -A src public scripts tests && git commit -m "feat!: replace MAIN-world page-script bridge with isolated-world fetch

The postMessage bridge was an unauthenticated channel: page JS could
race fake responses into fetchPost/resolveUrl and inject arbitrary
bytes into fetchBinary (then zipped and saved). Deleting the channel
removes the vulnerability class structurally (spec round19). Kept
contracts: Range bytes=0-0 + immediate cancel for resolveUrl, single
CSRF-reload retry on 401/403/422, and resolveUrl is now fail-closed on
non-ok status (round7). fetchBinary gains redirect:error and a
Content-Length pre-gate for the upcoming zip budget."'
```

---

### Task 5: 手動 hard gate — isolated world 3 能力の実機確認と CDN ホスト実測

これは**実装タスクではなく手動ゲート**。shishi の実機 Chrome + fantia.jp ログイン済みセッションで実施する。**このゲートの完了(判定 A)が Task 6 のホスト確定と Task 8 の一覧ボタン有効化の前提条件**(spec: allowlist・host_permissions・実測結果の 3 つが常に同じホスト集合を指すことを B の有効化条件とする)。

**Files:**
- Create: `docs/superpowers/plans/2026-07-21-hard-gate-results.md`(実測記録)

**Interfaces:**
- Consumes: Task 4 の成果物(dist/ ビルド)
- Produces: 実測 CDN ホスト集合(Task 6 の `ALLOWED_CDN_HOSTS` と manifest `host_permissions` の入力)、一覧ページでの 3 能力の合否

- [ ] **Step 1: ゲート用一時ビルドを作る(コミットしない)**

`public/manifest.json` の `content_scripts.matches` に **一時的に** `"https://fantia.jp/fanclubs/*"` を追加して `bun run build` する(一覧ページに isolated world を出現させ、DevTools のコンソールコンテキスト選択で拡張の isolated world から実測するため)。この変更は**コミットせず**、ゲート後に `git checkout -- public/manifest.json` で戻す(恒久追加は Task 8)。

Run: `wsl.exe -e bash -lc 'export PATH=$HOME/.npm-global/bin:$PATH && cd /home/shishi/dev/src/github.com/shishi/fantia-dl && bun run build'`
Chrome の `chrome://extensions` で「パッケージ化されていない拡張機能を読み込む」→ `\\wsl.localhost\Ubuntu\home\shishi\dev\src\github.com\shishi\fantia-dl\dist` を指定(読込済みならリロード)。

- [ ] **Step 2: 投稿ページの回帰確認(3 能力の投稿ページ側)**

fantia.jp にログインした状態で、photo ギャラリー投稿と file/video 投稿をそれぞれ 1 件開き、「⬇ fantia-dl」ボタンで DL する。
Expected: photo ギャラリー → zip が 1 件保存される(fetchPost + fetchBinary の実機動作)。file/video → 個別ファイルが保存される(resolveUrl の実機動作)。ボタン title が「この投稿をダウンロード」であること。

- [ ] **Step 3: 一覧ページで 3 能力を実測(isolated world から)**

`https://fantia.jp/fanclubs/{購読中クラブの id}/posts` を開き、DevTools → Console → 上部のコンテキストセレクタで **fantia-dl**(isolated world)を選択し、以下を順に実行して結果を記録する(`POSTID` はそのクラブの閲覧可能な投稿 ID に置き換える):

```js
// (1) csrf meta の存在
document.querySelector('meta[name="csrf-token"]')?.content   // → 非空文字列であること

// (2) fetchPost 相当: 200 が返ること
const auth = { "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]').content, "X-Requested-With": "XMLHttpRequest" };
const pr = await fetch("https://fantia.jp/api/v1/posts/POSTID", { credentials: "include", headers: auth });
pr.status   // → 200

// (3) 実測対象 URL の採取(photo の directUrl と file/video の download_uri)
const pj = await pr.json();
pj.post.post_contents.map(c => ({ cat: c.category, uri: c.download_uri, photos: (c.post_content_photos || []).map(p => p.url.original) }))

// (4) resolveUrl 相当: 最終 URL とホストを記録((3) の uri を使う)
const rr = await fetch("https://fantia.jp" + "DOWNLOAD_URI", { credentials: "include", headers: { ...auth, Range: "bytes=0-0" } });
[rr.ok, rr.status, new URL(rr.url).host]   // → ok=true、ホストを記録

// (5) fetchBinary 相当: photo directUrl((3) の photos の 1 つ)から 200 でバイナリが取れること
const du = "DIRECT_URL";
new URL(du).host   // → ホストを記録
const br = await fetch(du, { redirect: "error" });
[br.status, (await br.arrayBuffer()).byteLength]   // → [200, 正のサイズ]
```

(5) が CORS エラーで失敗した場合: 実測済みホスト(手順 (3)(4)(5) で記録したもの)を `public/manifest.json` の `host_permissions` に **一時的に** `"https://<host>/*"` 形式で追加 → rebuild → 拡張リロード → (5) を再実行する。host_permissions 追加後に成功すればゲート通過(Task 6 で恒久化されるため)。追加しても失敗する場合のみ不合格。

- [ ] **Step 4: 実測結果を記録してコミット**

`docs/superpowers/plans/2026-07-21-hard-gate-results.md` を新規作成し(Global Constraints のパイプ方式で配置)、次のテンプレートを実測値で埋める:

```markdown
# hard gate 実測結果(fantia-dl simplify-and-buttons)

- 実施日: 2026-MM-DD
- 確認者: shishi
- 前提: Task 4 完了時点の dist + 一時 manifest(fanclubs matches / 必要なら host_permissions 追加)

## 1. 一覧ページ /fanclubs/{id}/posts での isolated world 3 能力

| 能力 | 結果 | 備考 |
|---|---|---|
| csrf meta 存在 | OK / NG | |
| fetchPost(200) | OK / NG | |
| resolveUrl(ok + 最終 URL) | OK / NG | |
| fetchBinary(200 + バイナリ) | OK / NG | host_permissions 追加の要否: |

## 2. 実測ホスト(Task 6 の allowlist / host_permissions の正)

| 種別 | ホスト |
|---|---|
| photo directUrl | |
| resolveUrl 解決先 (file) | |
| resolveUrl 解決先 (video) | |

## 3. 判定

- [ ] A: 3 能力すべて成功 → Task 6 以降を続行(一覧ボタン有効化可)
- [ ] B: 失敗あり → Task 8(一覧ボタン)と manifest の fanclubs matches 拡大は見送り。
      spec を改訂し(A/C のみ実装)、Task 6 の allowlist は投稿ページ実測ホストのみで適用、
      Task 7 はそのまま実施する。
```

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fantia-dl && git checkout -- public/manifest.json && git add -f docs/superpowers/plans/2026-07-21-hard-gate-results.md && git commit -m "docs: record hard-gate measurements for list-page fetch capabilities

Spec change B requires measured (not guessed) CDN hosts and proof that
fetchPost/resolveUrl/fetchBinary work from the isolated world on both
post and fanclub-list pages before enabling list buttons."'
```

- [ ] **Step 5: ゲート判定に従って分岐**

- **判定 A(全部成功)**: Task 6 へ進む。実測ホストのうち fantia.jp / *.fantia.jp 以外のものを Task 6 の `ALLOWED_CDN_HOSTS` と manifest `host_permissions` に反映する。
- **判定 B(失敗あり)**: spec(`docs/superpowers/specs/2026-07-21-fantia-dl-simplify-and-buttons-design.md`)を改訂して一覧ボタンを見送りにし(spec の hard gate 節が定める分岐)、本プランの Task 8 を実施しない。Task 6(allowlist は投稿ページで実測できたホストで構成)と Task 7 は fire-and-forget 化後の堅牢化としてそのまま実施する。改訂はユーザー(shishi)に報告して承認を得てから行う。

---

### Task 6: DL 前 URL allowlist(変更 B round15/16/17)

**Files:**
- Create: `src/core/url-allowlist.ts`
- Modify: `src/content/fantia-api.ts`(resolveUrl の入出力検証)、`src/background/service-worker.ts`(enqueue 前検証)、`src/content/content-script.ts`(zip 用 fetchBinary 前検証)、`public/manifest.json`(host_permissions)
- Test: `tests/url-allowlist.test.ts`(新設)、`tests/fantia-api.test.ts`(追記)

**Interfaces:**
- Consumes: Task 5 の実測ホスト集合(hard-gate-results.md)、Task 4 の `resolveUrl`
- Produces(url-allowlist.ts):
  - `ALLOWED_CDN_HOSTS: readonly string[]`
  - `validateDownloadUrl(url: string): { ok: true } | { ok: false; error: string }`
  - `validateResolveInput(downloadUri: string): { ok: true; url: string } | { ok: false; error: string }`

- [ ] **Step 1: 失敗するテストを書く**

`tests/url-allowlist.test.ts` を新設:

```ts
import { validateDownloadUrl, validateResolveInput } from "../src/core/url-allowlist";

describe("validateDownloadUrl(DL 前 URL allowlist)", () => {
  it("fantia.jp とそのサブドメインの https URL を許可", () => {
    expect(validateDownloadUrl("https://fantia.jp/x").ok).toBe(true);
    expect(validateDownloadUrl("https://c.fantia.jp/uploads/a.png").ok).toBe(true);
    expect(validateDownloadUrl("https://cc.fantia.jp/uploads/a.mp4").ok).toBe(true);
  });
  it("外部ホストを拒否(類似ドメイン偽装含む)", () => {
    expect(validateDownloadUrl("https://example.com/a.png").ok).toBe(false);
    expect(validateDownloadUrl("https://evil-fantia.jp/a.png").ok).toBe(false);
    expect(validateDownloadUrl("https://fantia.jp.evil.com/a.png").ok).toBe(false);
  });
  it("https 以外・URL でないものを拒否", () => {
    expect(validateDownloadUrl("http://fantia.jp/a.png").ok).toBe(false);
    expect(validateDownloadUrl("data:image/png;base64,AAAA").ok).toBe(false);
    expect(validateDownloadUrl("blob:https://fantia.jp/xxxx").ok).toBe(false);
    expect(validateDownloadUrl("not a url").ok).toBe(false);
  });
  // 注意: Task 5 の実測で fantia.jp 系以外の CDN ホスト(S3/CloudFront 等)が出た場合は、
  // その実ホストの許可テストをここに追加する。例(実測が "cdn.example-s3.amazonaws.com" の場合):
  //   expect(validateDownloadUrl("https://cdn.example-s3.amazonaws.com/a.png").ok).toBe(true);
  // 実測に無いホストのテストを書いてはならない(推測ホスト禁止)。
});

describe("validateResolveInput(resolveUrl の入力ガード: fetch 自体が credentials 付き実リクエスト)", () => {
  it("相対 download_uri は fantia.jp 絶対 URL に解決して許可", () => {
    expect(validateResolveInput("/posts/1/download/2")).toEqual({ ok: true, url: "https://fantia.jp/posts/1/download/2" });
  });
  it("fantia.jp 絶対 URL は許可", () => {
    expect(validateResolveInput("https://fantia.jp/posts/1/download/2").ok).toBe(true);
  });
  it("外部ホスト・protocol-relative・サブドメインを拒否(同一オリジンのみ)", () => {
    expect(validateResolveInput("https://evil.com/x").ok).toBe(false);
    expect(validateResolveInput("//evil.com/x").ok).toBe(false);
    expect(validateResolveInput("https://c.fantia.jp/x").ok).toBe(false);
  });
});
```

`tests/fantia-api.test.ts` の resolveUrl describe に追加:

```ts
  it("外部ホストへの download_uri は fetch せず拒否する(入力ガード)", async () => {
    let fetched = false;
    const r = await resolveUrl("https://evil.com/x", { fetchFn: async () => { fetched = true; return makeRes({}); }, csrf: () => "t" });
    expect(r.ok).toBe(false);
    expect(fetched).toBe(false);
  });
  it("解決先が許可外ホストなら fail-closed(出力ガード)", async () => {
    const r = await resolveUrl("/posts/1/download/2", {
      fetchFn: async () => makeRes({ url: "https://evil.example.com/file.mp4", body: { cancel: async () => {} } }),
      csrf: () => "t",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("許可外");
  });
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `wsl.exe -e bash -lc 'export PATH=$HOME/.npm-global/bin:$PATH && cd /home/shishi/dev/src/github.com/shishi/fantia-dl && bun run test'`
Expected: FAIL — `../src/core/url-allowlist` が存在しない、resolveUrl の新 2 ケースが失敗。

- [ ] **Step 3: url-allowlist.ts を実装**

`src/core/url-allowlist.ts` を新設(**`ALLOWED_CDN_HOSTS` には Task 5 の hard-gate-results.md「2. 実測ホスト」のうち fantia.jp / *.fantia.jp 以外のホストだけを書く。実測に無いホストを書いてはならない**):

```ts
// src/core/url-allowlist.ts
// DL 前 URL allowlist(spec 変更 B round15)。photo の signed URL や resolveUrl の
// 解決先はクロスオリジンの CDN URL であり、無検証で chrome.downloads.download /
// zip 用 fetch に渡さない。不合格アイテムは呼び出し側が errors に積んで除外する
// (fail-closed)。fanbox-dl の validateMediaUrl の翻案(fantia は postId をパスに
// 含まない CDN 形式のため、ホスト+スキーム検証のみの軽量版)。
//
// ALLOWED_CDN_HOSTS は hard gate(docs/superpowers/plans/2026-07-21-hard-gate-results.md)
// の実測結果だけを書く(推測ホスト禁止)。manifest.json の host_permissions と
// 常に同じホスト集合を指すこと(spec round20: これが一覧ボタンの有効化条件)。
export const ALLOWED_CDN_HOSTS: readonly string[] = [
  // Task 5 の実測で fantia.jp / *.fantia.jp 以外のホストが出た場合のみここに追加する。
];

function isAllowedHost(host: string): boolean {
  if (host === "fantia.jp" || host.endsWith(".fantia.jp")) return true;
  return ALLOWED_CDN_HOSTS.includes(host);
}

export function validateDownloadUrl(url: string): { ok: true } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: `URL として不正: ${url}` };
  }
  if (u.protocol !== "https:") return { ok: false, error: `https 以外: ${url}` };
  if (!isAllowedHost(u.host)) return { ok: false, error: `許可外ホスト: ${u.host}` };
  return { ok: true };
}

// resolveUrl の入力(download_uri)検証(spec round16): 解決の fetch 自体が
// credentials 付きの実リクエストのため、出力だけでなく入力も fetch 実行前に
// 「fantia.jp 同一オリジンの相対パスまたは fantia.jp URL」であることを検証する。
// リダイレクト中間ホップは構造的に検証不可(受容済み残余。spec round16)。
export function validateResolveInput(downloadUri: string): { ok: true; url: string } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(downloadUri, "https://fantia.jp");
  } catch {
    return { ok: false, error: `download_uri が不正: ${downloadUri}` };
  }
  if (u.protocol !== "https:" || u.host !== "fantia.jp") {
    return { ok: false, error: `fantia.jp 以外への download_uri: ${downloadUri}` };
  }
  return { ok: true, url: u.toString() };
}
```

- [ ] **Step 4: 適用点を配線する**

`src/content/fantia-api.ts` の `resolveUrl` を次に置き換える(入力・出力の両ガード。import に `import { validateDownloadUrl, validateResolveInput } from "../core/url-allowlist";` を追加):

```ts
export async function resolveUrl(
  downloadUri: string,
  deps: { fetchFn?: ApiFetch; csrf?: () => string } = {},
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const fetchFn = deps.fetchFn ?? realFetch;
  const csrf = deps.csrf ?? csrfToken;
  const input = validateResolveInput(downloadUri);
  if (!input.ok) return { ok: false, error: input.error };
  try {
    const r = await fetchWithCsrfRetry(input.url, { Range: "bytes=0-0" }, fetchFn, csrf);
    try { await r.body?.cancel(); } catch { /* 既読/クローズ済みは無視 */ }
    if (!r.ok) return { ok: false, error: `status ${r.status}` };
    const out = validateDownloadUrl(r.url);
    if (!out.ok) return { ok: false, error: `解決先が許可外: ${out.error}` };
    return { ok: true, url: r.url };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
```

`src/background/service-worker.ts` の `handleEnqueue` に適用(import に `import { validateDownloadUrl } from "../core/url-allowlist";` を追加し、`if (!it.url) {...}` の直後に挿入):

```ts
    const uv = validateDownloadUrl(it.url);
    if (!uv.ok) { errors.push(`${it.filename || it.contentId}.${it.ext}: ${uv.error}`); continue; }
```

`src/content/content-script.ts` の `makeAndDownloadZipInner` に適用(import に `import { validateDownloadUrl } from "../core/url-allowlist";` を追加し、`fetchBinary` 呼び出しの直前に挿入):

```ts
    const uv = validateDownloadUrl(f.directUrl);
    if (!uv.ok) return { queued: 0, error: uv.error };
```

`public/manifest.json` の `host_permissions` を更新(isolated world fetch の CORS 免除。spec round20。**実測で fantia.jp 系以外のホストが出た場合は `"https://<実測ホスト>/*"` を追加する** — hard-gate-results.md と同一集合):

```json
  "host_permissions": ["https://fantia.jp/*", "https://*.fantia.jp/*"],
```

- [ ] **Step 5: 検証**

Run: `wsl.exe -e bash -lc 'export PATH=$HOME/.npm-global/bin:$PATH && cd /home/shishi/dev/src/github.com/shishi/fantia-dl && bun run test && bun run typecheck && bun run build'`
Expected: 全テスト PASS、tsc エラーなし、build 成功。

- [ ] **Step 6: コミット**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fantia-dl && git add -A src public tests && git commit -m "feat: gate all download/zip/resolve URLs through a host allowlist

Signed photo URLs and resolveUrl results are cross-origin CDN URLs that
were passed unverified to downloads.download and zip fetch. Validate
before every network use (enqueue, zip source fetch, resolve input and
output) against fantia.jp/*.fantia.jp plus hosts measured in the hard
gate; host_permissions is kept to the same set for isolated-world CORS
exemption (spec round15/16/20). Fail-closed: rejected items go to
errors, never silently dropped."'
```

---

### Task 7: zip 経路の強化 — パス検証・バジェット・直列化・非同期圧縮・個別 DL フォールバック(変更 A-4 / B round9-13,17,21)

**Files:**
- Create: `src/content/zip-support.ts`
- Modify: `src/content/content-script.ts`
- Test: `tests/zip-support.test.ts`(新設)

**Interfaces:**
- Consumes: `fetchBinary`(Task 4/6)、`validateDownloadUrl`(Task 6)、`validatePath`(既存)、`DOWNLOAD_CONFLICT_ACTION`(Task 2)、`sendZipOverPort(filename, bytes)`(Task 2)、`DownloadResult`(Task 3)
- Produces(zip-support.ts):
  - `ZIP_SOURCE_BUDGET_BYTES = 100 * 1024 * 1024`、`ZIP_MAX_FILES = 100`(fanbox-dl の実装値を初期値として流用)
  - `ZIP_FALLBACK_NOTICE = "zip を中止し個別ダウンロードに切り替えました"`
  - `createSerialQueue(): <T>(job: () => Promise<T>) => Promise<T>`
  - `zipAsync(entries: Record<string, Uint8Array>): Promise<Uint8Array>`
  - content-script 内 `tryZipGallery(block: ContentBlock, post: PostData, s: Settings): Promise<{ ok: true } | { ok: false; reason: string }>`

- [ ] **Step 1: 失敗するテストを書く**

`tests/zip-support.test.ts` を新設:

```ts
import { unzipSync } from "fflate";
import { createSerialQueue, zipAsync, ZIP_SOURCE_BUDGET_BYTES, ZIP_MAX_FILES, ZIP_FALLBACK_NOTICE } from "../src/content/zip-support";

describe("createSerialQueue(ページ内 zip 組み立ての直列化)", () => {
  it("ジョブを投入順に直列実行する(並走しない)", async () => {
    const q = createSerialQueue();
    const order: string[] = [];
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const p1 = q(async () => { order.push("a-start"); await sleep(30); order.push("a-end"); return 1; });
    const p2 = q(async () => { order.push("b-start"); order.push("b-end"); return 2; });
    expect(await p1).toBe(1);
    expect(await p2).toBe(2);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });
  it("前段の失敗は後続ジョブを妨げない", async () => {
    const q = createSerialQueue();
    await expect(q(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await q(async () => "ok")).toBe("ok");
  });
});

describe("zipAsync(fflate 非同期 zip)", () => {
  it("entries を zip 化し、展開すると元のバイト列が得られる", async () => {
    const data = await zipAsync({ "a.txt": new TextEncoder().encode("hello"), "dir/b.txt": new TextEncoder().encode("world") });
    const un = unzipSync(data);
    expect(new TextDecoder().decode(un["a.txt"])).toBe("hello");
    expect(new TextDecoder().decode(un["dir/b.txt"])).toBe("world");
  });
});

describe("バジェット定数とフォールバック文言", () => {
  it("fanbox-dl の実装値を初期値として流用する(spec 変更 A-4)", () => {
    expect(ZIP_SOURCE_BUDGET_BYTES).toBe(100 * 1024 * 1024);
    expect(ZIP_MAX_FILES).toBe(100);
  });
  it("フォールバックは notice(情報通知)であり error ではない", () => {
    expect(ZIP_FALLBACK_NOTICE).toBe("zip を中止し個別ダウンロードに切り替えました");
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `wsl.exe -e bash -lc 'export PATH=$HOME/.npm-global/bin:$PATH && cd /home/shishi/dev/src/github.com/shishi/fantia-dl && bun run test'`
Expected: FAIL — `../src/content/zip-support` が存在しない。

- [ ] **Step 3: zip-support.ts を実装**

`src/content/zip-support.ts` を新設:

```ts
// src/content/zip-support.ts
// zip 組み立ての資源制御(spec 変更 A-4 / B round9/10/21)。
import { zip } from "fflate";

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
export function zipAsync(entries: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(entries, {}, (err, data) => (err ? reject(err) : resolve(data)));
  });
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `wsl.exe -e bash -lc 'export PATH=$HOME/.npm-global/bin:$PATH && cd /home/shishi/dev/src/github.com/shishi/fantia-dl && bun run test'`
Expected: tests/zip-support.test.ts 全 PASS(zipAsync のテストが環境要因で落ちる場合は fflate の worker 初期化を疑い、原因を particular に調査する — 黙って skip しない)。

- [ ] **Step 5: content-script の zip 経路を書き換える(検証・バジェット・直列化・フォールバック)**

`src/content/content-script.ts` で `makeAndDownloadZip` / `makeAndDownloadZipInner` を削除し、次に置き換える(import 変更: `import { validatePath } from "../core/path-validator";` と `import { createSerialQueue, zipAsync, ZIP_SOURCE_BUDGET_BYTES, ZIP_MAX_FILES, ZIP_FALLBACK_NOTICE } from "./zip-support";` を追加、loadSettings の import 行を `import { loadSettings, DOWNLOAD_CONFLICT_ACTION } from "../core/settings";` に変更、types の import に `FileItem` を追加、`import { zipSync } from "fflate";` を削除):

```ts
// --- zip 組み立て(spec 変更 A-4 / B) ---------------------------------------
// fantia のギャラリーは「zip 排他分岐」で、zip が失敗するとそのギャラリーが丸ごと
// 未保存になる。enqueue 前のあらゆる zip 失敗(バジェット超過・validatePath 不合格・
// offscreen 障害・Port 切断・downloads.download 失敗)は ok:false を返し、呼び出し側が
// 個別ファイル DL へフォールバックする。個別 DL をスキップしてよいのは zip の enqueue が
// 実際に成功したときだけ(ユーザーの目的は保存であって zip 形式ではない)。
// enqueue 成功後に blob DL が interrupted になるケースは対象外(復旧は再クリック)。
type GalleryZipResult = { ok: true } | { ok: false; reason: string };

// ページ内の zip 組み立ては同時 1 件に直列化(round21)。per-document 状態のため
// リロード/遷移でキューは消えるが、復旧は再クリックで良い(round26 residual 受容済み)。
const enqueueZipJob = createSerialQueue();

function tryZipGallery(block: ContentBlock, post: PostData, s: Settings): Promise<GalleryZipResult> {
  return enqueueZipJob(() => tryZipGalleryInner(block, post, s))
    .catch((e) => ({ ok: false as const, reason: String(e) }));
}

async function tryZipGalleryInner(block: ContentBlock, post: PostData, s: Settings): Promise<GalleryZipResult> {
  const files = block.files.filter((f): f is FileItem & { directUrl: string } => !!f.directUrl);
  if (files.length === 0) return { ok: false, reason: "directUrl のある photo がありません" };
  if (files.length > ZIP_MAX_FILES) return { ok: false, reason: `zip 件数上限(${ZIP_MAX_FILES})超過` };

  const entries: Record<string, Uint8Array> = {};
  const usedNames = new Set<string>();
  const now = new Date();
  let used = 0; // 累積ソースバイト(タブ内のバジェット計上)
  for (const f of files) {
    const uv = validateDownloadUrl(f.directUrl);
    if (!uv.ok) return { ok: false, reason: uv.error };
    const res = await fetchBinary(f.directUrl, { maxBytes: ZIP_SOURCE_BUDGET_BYTES - used });
    if (!res.ok) {
      return { ok: false, reason: res.tooLarge ? `zip ソースバジェット超過: ${res.error}` : `fetchBinary 失敗: ${res.error}` };
    }
    used += res.buffer.byteLength;

    const ctx: RenderContext = {
      creator: post.creator, creatorId: post.creatorId,
      postTitle: post.postTitle, postId: post.postId,
      postedAt: post.postedAt, now,
      contentTitle: block.contentTitle ?? "", contentId: block.contentId,
      contentType: f.contentType, plan: block.plan ?? "",
      filename: f.filename ?? "", ext: f.ext, seq: f.seq, total: f.total,
    };
    let entryPath: string;
    try {
      entryPath = renderTemplate(s.zipEntryTemplate, ctx,
        { replacement: s.illegalCharReplacement, segmentMaxLen: s.segmentMaxLen });
    } catch (e) {
      return { ok: false, reason: e instanceof TemplateError ? `テンプレートエラー: ${e.message}` : String(e) };
    }
    // テンプレが $seq を含まない等で衝突しうる -> 静かな上書き(データ消失)を防ぐため連番を付与。
    if (usedNames.has(entryPath)) {
      const dot = entryPath.lastIndexOf(".");
      const stem = dot > 0 ? entryPath.slice(0, dot) : entryPath;
      const ext = dot > 0 ? entryPath.slice(dot) : "";
      let n = 2;
      let candidate = `${stem} (${n})${ext}`;
      while (usedNames.has(candidate)) { n++; candidate = `${stem} (${n})${ext}`; }
      entryPath = candidate;
    }
    // entry 名はアーカイブ内部の名前で uniquify サフィックスが付かないため、
    // headroom 減算を無効("overwrite" 相当)にして検証する(spec round5:
    // uniquify 扱いだと正当な entry 名が誤って拒否され zip 全体が不当に中断される)。
    const pv = validatePath(entryPath, { fullPathMaxLen: s.fullPathMaxLen, uniquifyHeadroom: s.uniquifyHeadroom, conflictAction: "overwrite", segmentMaxLen: s.segmentMaxLen });
    if (!pv.ok) return { ok: false, reason: `zip entry 名不正: ${entryPath}: ${pv.error}` };
    usedNames.add(entryPath);
    entries[entryPath] = new Uint8Array(res.buffer);
  }

  const firstFile = files[0];
  const zipCtx: RenderContext = {
    creator: post.creator, creatorId: post.creatorId,
    postTitle: post.postTitle, postId: post.postId,
    postedAt: post.postedAt, now,
    contentTitle: block.contentTitle ?? "", contentId: block.contentId,
    contentType: "photo", plan: block.plan ?? "",
    filename: firstFile?.filename ?? "", ext: "zip",
    seq: 1, total: 1,
  };
  let zipPath: string;
  try {
    zipPath = renderTemplate(s.zipPathTemplate, zipCtx,
      { replacement: s.illegalCharReplacement, segmentMaxLen: s.segmentMaxLen });
  } catch (e) {
    return { ok: false, reason: e instanceof TemplateError ? `テンプレートエラー: ${e.message}` : String(e) };
  }
  // zipPath は実際に chrome.downloads.download を通るため uniquify 前提
  // (headroom 減算あり)で検証する(spec round4/5: 通常 DL とガード水準を揃える)。
  const zv = validatePath(zipPath, { fullPathMaxLen: s.fullPathMaxLen, uniquifyHeadroom: s.uniquifyHeadroom, conflictAction: DOWNLOAD_CONFLICT_ACTION, segmentMaxLen: s.segmentMaxLen });
  if (!zv.ok) return { ok: false, reason: `zip ファイル名不正: ${zipPath}: ${zv.error}` };

  let zipped: Uint8Array;
  try {
    zipped = await zipAsync(entries);
  } catch (e) {
    return { ok: false, reason: `zip 圧縮失敗: ${String(e)}` };
  }
  const r = await sendZipOverPort(zipPath, zipped);
  if (r.queued !== 1) return { ok: false, reason: r.error ?? "zip の enqueue に失敗" };
  return { ok: true };
}
```

(Task 6 で `makeAndDownloadZipInner` に挿入した `validateDownloadUrl` の検証行は、この `tryZipGalleryInner` 内の同位置に引き継がれている。)

`runDownload` の zip 分岐を次に置き換える(Task 3 で入れた notices をここで使用開始):

```ts
    if (c.contentType === "photo" && c.files.length >= 2 && s.zipGalleries && s.contentTypes.photo) {
      const zr = await tryZipGallery(c, post, s);
      if (zr.ok) { zipQueued += 1; continue; }
      // enqueue 前の zip 失敗 → このギャラリーを個別ファイル DL へフォールバック
      // (下の通常ループに落とす)。通知は notices(情報)チャネルで表示する。
      notices.push(`${ZIP_FALLBACK_NOTICE}(${zr.reason})`);
    }
```

(`continue;` が `zr.ok` の場合のみになり、失敗時はそのまま直後の `for (const f of c.files)` ループに到達して個別 enqueue される構造にする。)

- [ ] **Step 6: 検証**

Run: `wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fantia-dl && grep -rn "zipSync" src/'`
Expected: ヒット 0 件。

Run: `wsl.exe -e bash -lc 'export PATH=$HOME/.npm-global/bin:$PATH && cd /home/shishi/dev/src/github.com/shishi/fantia-dl && bun run test && bun run typecheck && bun run build'`
Expected: 全テスト PASS、tsc エラーなし、build 成功。

- [ ] **Step 7: コミット**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fantia-dl && git add -A src tests && git commit -m "feat: bound, serialize and validate the zip path with individual-DL fallback

The zip pipeline held unbounded sources in memory, froze the main
thread in zipSync, and skipped validatePath entirely. Now: per-tab
serial queue + 100MiB/100-file source budget with Content-Length
pre-gating, async fflate zip(), zipPath validated in uniquify mode and
entry names in headroom-free mode, and any pre-enqueue failure falls
back to individual downloads reported via the notices channel so a
failed zip never silently loses a whole gallery (spec A-4, B r9-13/21)."'
```

---

### Task 8: ファンクラブ投稿一覧の DL ボタン(変更 B 本体)+ 最終手動ゲート

**前提: Task 5 の判定が A であること。** 判定 B の場合このタスクは実施しない(spec 改訂へ)。

**Files:**
- Create: `src/content/dom-helpers.ts`
- Modify: `src/content/content-script.ts`(全面再構成)、`public/manifest.json`(matches 拡大)
- Test: `tests/dom-helpers.test.ts`(新設)

**Interfaces:**
- Consumes: `DownloadResult`(Task 3)、`fetchPost`/`resolveUrl`/`fetchBinary`(Task 4/6)、`tryZipGallery` ほか zip 経路(Task 7)
- Produces(dom-helpers.ts):
  - `postIdFromPathname(pathname: string): string | null`
  - `postIdFromHref(href: string): string | null`
  - `isFanclubPostListPage(pathname: string): boolean`
  - `selectPostAnchorIndicesToInject(postIds: (string | null)[], alreadyInjectedPostIds: Set<string>): number[]`
  - `shouldHandleDlClick(ev: { isTrusted: boolean }): boolean`
  - content-script 内 `runDownloadFor(postId: string): Promise<DownloadResult | null>`

- [ ] **Step 1: 失敗するテストを書く**

`tests/dom-helpers.test.ts` を新設(fanbox-dl の tests/dom-helpers.test.ts を fantia の URL 構造に翻案):

```ts
import { postIdFromPathname, postIdFromHref, isFanclubPostListPage, selectPostAnchorIndicesToInject, shouldHandleDlClick } from "../src/content/dom-helpers";

describe("postIdFromPathname", () => {
  it("/posts/{id} から抽出(末尾スラッシュ許容)", () => {
    expect(postIdFromPathname("/posts/1234567")).toBe("1234567");
    expect(postIdFromPathname("/posts/1234567/")).toBe("1234567");
  });
  it("投稿ページ以外は null", () => {
    expect(postIdFromPathname("/")).toBeNull();
    expect(postIdFromPathname("/fanclubs/123/posts")).toBeNull();
    expect(postIdFromPathname("/posts/abc")).toBeNull();
    expect(postIdFromPathname("/mypage/posts/123")).toBeNull();
  });
});

describe("postIdFromHref", () => {
  it("相対 / 絶対どちらの href からも postId を取る", () => {
    expect(postIdFromHref("/posts/1234567")).toBe("1234567");
    expect(postIdFromHref("https://fantia.jp/posts/1234567")).toBe("1234567");
  });
  it("外部ホストの /posts/{id} は null(一覧ページの外部リンク誤認防止)", () => {
    expect(postIdFromHref("https://example.com/posts/123")).toBeNull();
    expect(postIdFromHref("https://twitter.com/posts/456")).toBeNull();
  });
  it("投稿リンクでない href は null", () => {
    expect(postIdFromHref("/fanclubs/123")).toBeNull();
    expect(postIdFromHref("#")).toBeNull();
  });
});

describe("isFanclubPostListPage(/fanclubs/{id}/posts のみ true)", () => {
  it("投稿一覧は true(末尾スラッシュ許容。?page=N はクエリのため pathname 判定に影響しない)", () => {
    expect(isFanclubPostListPage("/fanclubs/123/posts")).toBe(true);
    expect(isFanclubPostListPage("/fanclubs/123/posts/")).toBe(true);
  });
  it("ファンクラブトップ・ホーム・投稿詳細・下位パスは false", () => {
    expect(isFanclubPostListPage("/fanclubs/123")).toBe(false);
    expect(isFanclubPostListPage("/")).toBe(false);
    expect(isFanclubPostListPage("/posts/123")).toBe(false);
    expect(isFanclubPostListPage("/fanclubs/123/posts/456")).toBe(false);
  });
});

describe("selectPostAnchorIndicesToInject(postId 単位 dedup。fanbox-dl と同一契約)", () => {
  it("同一 postId の複数 anchor は文書順で最後の 1 件だけを選ぶ(入れ子 anchor 対策)", () => {
    expect(selectPostAnchorIndicesToInject(["1", "1", "2"], new Set())).toEqual([1, 2]);
  });
  it("postId を抽出できない(null の)anchor は無視する", () => {
    expect(selectPostAnchorIndicesToInject([null, "1"], new Set())).toEqual([1]);
  });
  it("既にボタンが実在する postId には何も選ばない", () => {
    expect(selectPostAnchorIndicesToInject(["1", "1"], new Set(["1"]))).toEqual([]);
  });
  it("ボタンが DOM から消えていれば(集計 Set に居なければ)再注入する", () => {
    expect(selectPostAnchorIndicesToInject(["1"], new Set())).toEqual([0]);
  });
});

describe("shouldHandleDlClick(信頼クリックゲート: 合成クリックで拡張の権限を無断駆動させない)", () => {
  it("実ユーザー操作(isTrusted: true)は処理する", () => {
    expect(shouldHandleDlClick({ isTrusted: true })).toBe(true);
  });
  it("スクリプト合成クリック(isTrusted: false)は無視する", () => {
    expect(shouldHandleDlClick({ isTrusted: false })).toBe(false);
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `wsl.exe -e bash -lc 'export PATH=$HOME/.npm-global/bin:$PATH && cd /home/shishi/dev/src/github.com/shishi/fantia-dl && bun run test'`
Expected: FAIL — `../src/content/dom-helpers` が存在しない。

- [ ] **Step 3: dom-helpers.ts を実装**

`src/content/dom-helpers.ts` を新設:

```ts
// src/content/dom-helpers.ts
// content script のボタン配置に使う純粋関数(DOM 非依存・単体テスト対象)。
// fanbox-dl の dom-helpers.ts を fantia の URL 構造に翻案。

export function postIdFromPathname(pathname: string): string | null {
  return pathname.match(/^\/posts\/(\d+)(?:$|\/)/)?.[1] ?? null;
}

// href(相対 or 絶対)から postId を抽出。投稿リンクでなければ null。
// 絶対 URL は fantia.jp ホストのみ許可(一覧に混ざる外部リンクの誤認防止)。
export function postIdFromHref(href: string): string | null {
  try {
    const u = new URL(href, "https://fantia.jp");
    if (u.host !== "fantia.jp" && !u.host.endsWith(".fantia.jp")) return null;
    return postIdFromPathname(u.pathname);
  } catch {
    return null;
  }
}

// ファンクラブ投稿一覧か。対象は /fanclubs/{id}/posts のみ(末尾スラッシュ許容)。
// ファンクラブトップ /fanclubs/{id}・ホーム・検索は対象外(spec YAGNI)。
// ページング ?page=N はクエリのため pathname 判定に影響しない。
export function isFanclubPostListPage(pathname: string): boolean {
  return /^\/fanclubs\/\d+\/posts\/?$/.test(pathname);
}

// postId 単位の注入 dedup(fanbox-dl と同一契約)。
// 「既にボタンがあるか」は anchor 側マーカーではなく、呼び出し側が実際に生きている
// ボタン要素(data-fdl-for)を数え上げた結果として渡す — マーカーと実体が別ノードに
// あると DOM の部分再レンダリングで乖離するため、独立した状態を一切持たない。
// 同一 postId の複数 anchor は文書順で最後を採用する(入れ子 anchor では祖先が先に
// querySelectorAll に現れるため、「最後」を選べば常により深い=カード固有の方になる)。
export function selectPostAnchorIndicesToInject(postIds: (string | null)[], alreadyInjectedPostIds: Set<string>): number[] {
  const lastIndexForId = new Map<string, number>();
  for (let i = 0; i < postIds.length; i++) {
    const id = postIds[i];
    if (!id || alreadyInjectedPostIds.has(id)) continue;
    lastIndexForId.set(id, i);
  }
  return Array.from(lastIndexForId.values()).sort((a, b) => a - b);
}

// 信頼クリックゲート(spec round18): DL ボタンの click は実ユーザー操作
// (event.isTrusted === true)の場合のみ処理する。ページ上のスクリプトが .click() や
// dispatchEvent で click を合成すると拡張の権限(credentials 付き fetch + downloads)を
// 無断駆動でき、dedup 無しでは無制限の重複 DL に直結するため、この経路を封じる。
export function shouldHandleDlClick(ev: { isTrusted: boolean }): boolean {
  return ev.isTrusted;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `wsl.exe -e bash -lc 'export PATH=$HOME/.npm-global/bin:$PATH && cd /home/shishi/dev/src/github.com/shishi/fantia-dl && bun run test'`
Expected: tests/dom-helpers.test.ts 全 PASS。

- [ ] **Step 5: content-script を全面再構成する(一覧ボタン・in-flight ガード・isTrusted ゲート)**

`src/content/content-script.ts` を次の内容で**全置換**する(Task 7 までの成果を統合した最終形。`tryZipGallery` / `tryZipGalleryInner` / `sendZipOverPort` は Task 7 / Task 2 で確定した実装をそのまま含む):

```ts
import { parsePost } from "../fantia/parse";
import type { ContentBlock, FileItem, PostData, RenderContext, Settings } from "../core/types";
import type { DownloadResult, EnqueueItem, EnqueueMessage, EnqueueResponse, PostMeta, ZipPortResult, ZipStartMessage, ZipChunkMessage, ZipEndMessage } from "./messages";
import { ZIP_PORT_NAME } from "./messages";
import { loadSettings, DOWNLOAD_CONFLICT_ACTION } from "../core/settings";
import { renderTemplate, TemplateError } from "../core/template-engine";
import { validatePath } from "../core/path-validator";
import { validateDownloadUrl } from "../core/url-allowlist";
import { bytesToBase64 } from "../core/base64";
import { fetchPost, resolveUrl, fetchBinary } from "./fantia-api";
import { postIdFromPathname, postIdFromHref, isFanclubPostListPage, selectPostAnchorIndicesToInject, shouldHandleDlClick } from "./dom-helpers";
import { createSerialQueue, zipAsync, ZIP_SOURCE_BUDGET_BYTES, ZIP_MAX_FILES, ZIP_FALLBACK_NOTICE } from "./zip-support";

// --- zip 転送(Port: start -> chunk* -> end) --------------------------------
const ZIP_CHUNK_BYTES = 4 * 1024 * 1024; // 1 メッセージ上限を避けるためのチャンクサイズ

function sendZipOverPort(filename: string, bytes: Uint8Array): Promise<ZipPortResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: ZipPortResult) => { if (!settled) { settled = true; resolve(r); } };
    const port = chrome.runtime.connect({ name: ZIP_PORT_NAME });
    port.onMessage.addListener((res: ZipPortResult) => { finish(res); port.disconnect(); });
    port.onDisconnect.addListener(() => finish({ queued: 0, error: "background との接続が切れました" }));
    port.postMessage({ kind: "start", filename, totalBytes: bytes.byteLength } as ZipStartMessage);
    for (let off = 0; off < bytes.byteLength; off += ZIP_CHUNK_BYTES) {
      const slice = bytes.subarray(off, Math.min(off + ZIP_CHUNK_BYTES, bytes.byteLength));
      port.postMessage({ kind: "chunk", data: bytesToBase64(slice) } as ZipChunkMessage);
    }
    port.postMessage({ kind: "end" } as ZipEndMessage);
  });
}

// --- zip 組み立て(直列化 + バジェット + フォールバック判定。Task 7 と同一実装) ---
type GalleryZipResult = { ok: true } | { ok: false; reason: string };
const enqueueZipJob = createSerialQueue();

function tryZipGallery(block: ContentBlock, post: PostData, s: Settings): Promise<GalleryZipResult> {
  return enqueueZipJob(() => tryZipGalleryInner(block, post, s))
    .catch((e) => ({ ok: false as const, reason: String(e) }));
}

async function tryZipGalleryInner(block: ContentBlock, post: PostData, s: Settings): Promise<GalleryZipResult> {
  const files = block.files.filter((f): f is FileItem & { directUrl: string } => !!f.directUrl);
  if (files.length === 0) return { ok: false, reason: "directUrl のある photo がありません" };
  if (files.length > ZIP_MAX_FILES) return { ok: false, reason: `zip 件数上限(${ZIP_MAX_FILES})超過` };

  const entries: Record<string, Uint8Array> = {};
  const usedNames = new Set<string>();
  const now = new Date();
  let used = 0;
  for (const f of files) {
    const uv = validateDownloadUrl(f.directUrl);
    if (!uv.ok) return { ok: false, reason: uv.error };
    const res = await fetchBinary(f.directUrl, { maxBytes: ZIP_SOURCE_BUDGET_BYTES - used });
    if (!res.ok) {
      return { ok: false, reason: res.tooLarge ? `zip ソースバジェット超過: ${res.error}` : `fetchBinary 失敗: ${res.error}` };
    }
    used += res.buffer.byteLength;

    const ctx: RenderContext = {
      creator: post.creator, creatorId: post.creatorId,
      postTitle: post.postTitle, postId: post.postId,
      postedAt: post.postedAt, now,
      contentTitle: block.contentTitle ?? "", contentId: block.contentId,
      contentType: f.contentType, plan: block.plan ?? "",
      filename: f.filename ?? "", ext: f.ext, seq: f.seq, total: f.total,
    };
    let entryPath: string;
    try {
      entryPath = renderTemplate(s.zipEntryTemplate, ctx,
        { replacement: s.illegalCharReplacement, segmentMaxLen: s.segmentMaxLen });
    } catch (e) {
      return { ok: false, reason: e instanceof TemplateError ? `テンプレートエラー: ${e.message}` : String(e) };
    }
    if (usedNames.has(entryPath)) {
      const dot = entryPath.lastIndexOf(".");
      const stem = dot > 0 ? entryPath.slice(0, dot) : entryPath;
      const ext = dot > 0 ? entryPath.slice(dot) : "";
      let n = 2;
      let candidate = `${stem} (${n})${ext}`;
      while (usedNames.has(candidate)) { n++; candidate = `${stem} (${n})${ext}`; }
      entryPath = candidate;
    }
    const pv = validatePath(entryPath, { fullPathMaxLen: s.fullPathMaxLen, uniquifyHeadroom: s.uniquifyHeadroom, conflictAction: "overwrite", segmentMaxLen: s.segmentMaxLen });
    if (!pv.ok) return { ok: false, reason: `zip entry 名不正: ${entryPath}: ${pv.error}` };
    usedNames.add(entryPath);
    entries[entryPath] = new Uint8Array(res.buffer);
  }

  const firstFile = files[0];
  const zipCtx: RenderContext = {
    creator: post.creator, creatorId: post.creatorId,
    postTitle: post.postTitle, postId: post.postId,
    postedAt: post.postedAt, now,
    contentTitle: block.contentTitle ?? "", contentId: block.contentId,
    contentType: "photo", plan: block.plan ?? "",
    filename: firstFile?.filename ?? "", ext: "zip",
    seq: 1, total: 1,
  };
  let zipPath: string;
  try {
    zipPath = renderTemplate(s.zipPathTemplate, zipCtx,
      { replacement: s.illegalCharReplacement, segmentMaxLen: s.segmentMaxLen });
  } catch (e) {
    return { ok: false, reason: e instanceof TemplateError ? `テンプレートエラー: ${e.message}` : String(e) };
  }
  const zv = validatePath(zipPath, { fullPathMaxLen: s.fullPathMaxLen, uniquifyHeadroom: s.uniquifyHeadroom, conflictAction: DOWNLOAD_CONFLICT_ACTION, segmentMaxLen: s.segmentMaxLen });
  if (!zv.ok) return { ok: false, reason: `zip ファイル名不正: ${zipPath}: ${zv.error}` };

  let zipped: Uint8Array;
  try {
    zipped = await zipAsync(entries);
  } catch (e) {
    return { ok: false, reason: `zip 圧縮失敗: ${String(e)}` };
  }
  const r = await sendZipOverPort(zipPath, zipped);
  if (r.queued !== 1) return { ok: false, reason: r.error ?? "zip の enqueue に失敗" };
  return { ok: true };
}

// --- DL 本体(投稿ページ・一覧カード共通のフロー) ----------------------------
// in-flight ガード(spec round25): click 中の disabled 状態はボタン DOM ノード上に
// しか無く、サイトのカード再レンダリングで消えると watch の再注入が同じ postId の
// 新品有効ボタンを作り、in-flight 中の重複クリックが可能になる(dedup 撤去後は
// 吸収されない)。タブ内・揮発の Set で同一タブ内の同時多重起動だけを防ぐ
// (永続化しない = dedup の復活ではない)。
const inFlightPostIds = new Set<string>();

async function runDownloadFor(postId: string): Promise<DownloadResult | null> {
  if (inFlightPostIds.has(postId)) return null;
  inFlightPostIds.add(postId);
  try {
    return await runDownloadInner(postId);
  } finally {
    inFlightPostIds.delete(postId);
  }
}

async function runDownloadInner(postId: string): Promise<DownloadResult | null> {
  const fetched = await fetchPost(postId);
  if (!fetched.ok) { alert(`[fantia-dl] 取得失敗: ${fetched.error}`); return null; }
  const post = parsePost(fetched.json);
  const s = await loadSettings();

  const meta: PostMeta = {
    creator: post.creator, creatorId: post.creatorId, postTitle: post.postTitle,
    postId: post.postId, postedAtIso: post.postedAt.toISOString(),
  };
  const items: EnqueueItem[] = [];
  let zipQueued = 0;
  const errors: string[] = [];
  const notices: string[] = [];
  for (const c of post.contents) {
    if (c.contentType === "photo" && c.files.length >= 2 && s.zipGalleries && s.contentTypes.photo) {
      const zr = await tryZipGallery(c, post, s);
      if (zr.ok) { zipQueued += 1; continue; }
      // enqueue 前の zip 失敗 → このギャラリーを個別ファイル DL へフォールバック
      notices.push(`${ZIP_FALLBACK_NOTICE}(${zr.reason})`);
    }
    for (const f of c.files) {
      let url = f.directUrl ?? "";
      if (!url && f.downloadUri) {
        const resolved = await resolveUrl(f.downloadUri);
        if (!resolved.ok) { errors.push(`${f.filename ?? ""}.${f.ext}: URL 解決失敗(${resolved.error})`); continue; }
        url = resolved.url;
      }
      items.push({
        contentId: c.contentId, contentTitle: c.contentTitle ?? "",
        contentType: f.contentType, plan: c.plan ?? "", filename: f.filename ?? "",
        ext: f.ext, seq: f.seq, total: f.total, url,
      });
    }
  }

  let queued = zipQueued;
  if (items.length > 0) {
    const res = (await chrome.runtime.sendMessage({ kind: "enqueue", post: meta, items, pageUrl: location.href } satisfies EnqueueMessage)) as EnqueueResponse | undefined;
    if (!res) errors.push("background から応答がありません");
    else { queued += res.queued; errors.push(...res.errors); }
  }
  if (errors.length) alert(`[fantia-dl] エラー: ${errors.join(" / ")}`);
  if (notices.length) alert(`[fantia-dl] お知らせ:\n${notices.join("\n")}`);
  return { queued, errors, notices };
}

// --- ボタン共通 ---------------------------------------------------------------
function styleBtn(b: HTMLButtonElement, small = false) {
  if (small) {
    // カード上に重なる小ボタン: 明るいサムネでも暗いサムネでも視認できるよう
    // 濃い半透明背景 + 白文字 + 影でコントラストを確保(白背景の小ボタンは
    // サムネイルに埋没する — fanbox-dl の実運用での見落とし報告に基づく知見)。
    Object.assign(b.style, {
      padding: "4px 10px", borderRadius: "6px", cursor: "pointer",
      fontSize: "14px", fontWeight: "700", border: "1px solid rgba(255,255,255,.65)",
      background: "rgba(0,0,0,.72)", color: "#fff", lineHeight: "1.4",
      boxShadow: "0 1px 5px rgba(0,0,0,.5)",
    });
  } else {
    Object.assign(b.style, {
      padding: "6px 12px", borderRadius: "6px", cursor: "pointer", fontSize: "14px",
    });
  }
}

function swapText(b: HTMLButtonElement, temp: string, ms = 2500) {
  const orig = b.dataset.origText ?? b.textContent ?? "";
  if (!b.dataset.origText) b.dataset.origText = orig;
  b.textContent = temp;
  setTimeout(() => { b.textContent = b.dataset.origText || orig; b.disabled = false; }, ms);
}

// postId はクリック時に取得する(getPostId)。一覧カードはカード固有の postId を
// クロージャで返し(カードは postId とボタンが 1:1)、投稿ページボタンはクリック
// 時点の location.pathname から読む。トリガが違うだけで DL フローは同一。
function makeDlButton(label: string, small: boolean, getPostId: () => string | null): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button"; b.textContent = label; b.title = "この投稿をダウンロード";
  styleBtn(b, small);
  b.addEventListener("click", (ev) => {
    // 信頼クリックゲート(spec round18): 合成クリックは無視する
    if (!shouldHandleDlClick(ev)) return;
    ev.preventDefault(); ev.stopPropagation(); // カード遷移を抑止
    const postId = getPostId();
    if (!postId || inFlightPostIds.has(postId)) return;
    b.disabled = true;
    runDownloadFor(postId).then((r) => {
      if (r) swapText(b, `⬇ ${r.queued} 件開始`);
      else b.disabled = false;
    }).catch(() => { b.disabled = false; });
  });
  return b;
}

// --- 投稿ページ: h1.post-title 直後(fallback 固定右下) -----------------------
// (配置は現行踏襲。h1.post-title は安定クラスのため fanbox-dl 式の日付行探索は不要 — spec YAGNI)
function findTitleAnchor(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>(".the-post .post-header h1.post-title") ||
    document.querySelector<HTMLElement>(".post-header h1.post-title") ||
    document.querySelector<HTMLElement>("h1.post-title")
  );
}

function whenTitleReady(cb: (title: HTMLElement | null) => void, timeoutMs = 5000): void {
  const found = findTitleAnchor();
  if (found) { cb(found); return; }
  const obs = new MutationObserver(() => {
    const t = findTitleAnchor();
    if (t) {
      obs.disconnect();
      clearTimeout(tid);
      cb(t);
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
  const tid = setTimeout(() => { obs.disconnect(); cb(null); }, timeoutMs);
}

function addPostPageButton() {
  if (document.getElementById("fdl-btn-container")) return;

  const container = document.createElement("div");
  container.id = "fdl-btn-container";
  Object.assign(container.style, { display: "flex", gap: "8px", margin: "8px 0" });

  const btn = makeDlButton("⬇ fantia-dl", false, () => postIdFromPathname(location.pathname));
  btn.id = "fdl-btn";
  container.appendChild(btn);

  whenTitleReady((title) => {
    if (document.getElementById("fdl-btn-container") && document.getElementById("fdl-btn-container") !== container) return;
    if (title && title.parentElement) {
      title.parentElement.insertBefore(container, title.nextSibling);
    } else {
      Object.assign(container.style, {
        position: "fixed", right: "16px", bottom: "16px", zIndex: "99999",
      });
      document.body.appendChild(container);
    }
  });
}

// --- 一覧ページ: 各カードに ⬇ --------------------------------------------------
// 注入ガードは「ボタン要素の実在」ベース(anchor 側マーカー不使用。fanbox-dl 実証
// パターン): ボタン自身に data-fdl-for={postId} を記録し、「既にあるか」は走査ごとに
// 現在の DOM に実在するボタンを数え上げて判定する。ボタンノードが消えれば次回走査で
// 自動的に「無い」ことになり、マーカーと実体の乖離が構造的に起きない。
const INJECTED_BUTTON_SELECTOR = "[data-fdl-for]";

function injectListButtons() {
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/posts/"]'));
  const postIds = anchors.map((a) => postIdFromHref(a.getAttribute("href") || ""));

  // stale 検出: host(anchor の親)が再利用され href の postId だけ差し替わった場合、
  // host に残る既存ボタンは古い postId を束縛したまま。現在の postId と食い違う
  // ボタンはここで除去する(":scope >" で host の直接の子だけを見る — 深い探索だと
  // 入れ子 anchor 構造で別カードのボタンを stale と誤判定して除去してしまう)。
  for (let i = 0; i < anchors.length; i++) {
    const postId = postIds[i];
    if (!postId) continue;
    const host = anchors[i].parentElement ?? anchors[i];
    const existingBtn = host.querySelector<HTMLElement>(`:scope > ${INJECTED_BUTTON_SELECTOR}`);
    if (existingBtn && existingBtn.dataset.fdlFor && existingBtn.dataset.fdlFor !== postId) {
      existingBtn.remove();
    }
  }

  const alreadyInjectedPostIds = new Set(
    Array.from(document.querySelectorAll<HTMLElement>(INJECTED_BUTTON_SELECTOR))
      .map((el) => el.dataset.fdlFor)
      .filter((id): id is string => !!id)
  );
  const indices = selectPostAnchorIndicesToInject(postIds, alreadyInjectedPostIds);
  for (const i of indices) {
    const anchor = anchors[i];
    const postId = postIds[i];
    if (!postId) continue;
    const host = anchor.parentElement ?? anchor;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    const btn = makeDlButton("⬇", true, () => postId);
    btn.dataset.fdlFor = postId; // このボタンがどの postId 用かを記録(実在ベースの dedup に使う)
    // in-flight 中の postId の再注入は disabled で生成(spec round25: 再レンダリングで
    // disabled なノードごと消えた場合に新品有効ボタンが重複クリックを許すのを防ぐ)
    if (inFlightPostIds.has(postId)) btn.disabled = true;
    Object.assign(btn.style, { position: "absolute", top: "6px", right: "6px", zIndex: "9999" });
    host.appendChild(btn);
  }
}

// --- watch --------------------------------------------------------------------
// fantia は Rails のフルロード遷移が基本のため、1s interval + MutationObserver で
// 無限スクロール・動的追加も拾える(spec 変更 B)。
function sync() {
  if (postIdFromPathname(location.pathname)) addPostPageButton();
  if (isFanclubPostListPage(location.pathname)) injectListButtons();
}

function watch() {
  setInterval(sync, 1000);
  new MutationObserver(() => {
    if (isFanclubPostListPage(location.pathname)) injectListButtons();
  }).observe(document.body, { childList: true, subtree: true });
  sync();
}

watch();
```

- [ ] **Step 6: manifest の matches を拡大する**

`public/manifest.json` の content_scripts を次にする(全域常駐はしない):

```json
  "content_scripts": [
    { "matches": ["https://fantia.jp/posts/*", "https://fantia.jp/fanclubs/*"], "js": ["content/content-script.js"], "run_at": "document_idle" }
  ],
```

- [ ] **Step 7: 検証(自動)**

Run: `wsl.exe -e bash -lc 'export PATH=$HOME/.npm-global/bin:$PATH && cd /home/shishi/dev/src/github.com/shishi/fantia-dl && bun run test && bun run typecheck && bun run build'`
Expected: 全テスト PASS、tsc エラーなし、build 成功。

- [ ] **Step 8: 最終手動ゲート(実機受入確認)**

`bun run build` 済みの dist を Chrome にリロードし、以下を確認して結果をユーザーに報告する:

1. **一覧ボタン表示**: `/fanclubs/{id}/posts` で各投稿カードの右上に「⬇」(濃色半透明背景・白文字)が 1 カード 1 個だけ表示される。ページングや無限スクロール後の追加カードにも表示される。
2. **一覧クリック DL**: カードの ⬇ クリックで DL が始まり、カード遷移が起きない。ボタンが「⬇ N 件開始」表示になる。連打しても 2 重 DL にならない(in-flight ガード)。
3. **投稿ページ従来動作**: `/posts/{id}` のタイトル直後ボタンで従来どおり DL できる。🔄 ボタンが存在しない。
4. **zip**: 複数枚 photo ギャラリーが zip 1 件で保存される。圧縮中もページ操作が固まらない。
5. **zip フォールバック**: options の zipPathTemplate を一時的に不正値(例: `..`)にして保存を試みる → 保存が拒否される。さらに chrome.storage.sync に古い不正テンプレが入っているケースの代替として、DevTools で `chrome.storage.sync.set({settings: {...現設定, zipPathTemplate: ".."}})` を実行してからギャラリーを DL → 「zip を中止し個別ダウンロードに切り替えました」の notice が出て個別ファイルが保存される。確認後は options から正しい値を保存し直す。
6. **options**: 「DL 履歴の管理」セクションと「衝突時の挙動」select が消えている。3 プレビューが動く。replacement に `/` を入れると保存が拒否される。
7. **合成クリック無視**: 一覧ページの DevTools(fantia-dl コンテキスト)で `document.querySelector('[data-fdl-for]').click()` を実行 → 何も起きない(isTrusted ゲート)。
8. **migration**: DevTools(SW コンソール)で `chrome.storage.local.get("jobs")` → `{}`(キーが無い)。

- [ ] **Step 9: コミット**

```bash
wsl.exe -e bash -lc 'cd /home/shishi/dev/src/github.com/shishi/fantia-dl && git add -A src public tests && git commit -m "feat: add per-card download buttons on fanclub post lists

Inject a button per post card on /fanclubs/{id}/posts using the
fanbox-dl-proven pattern: liveness-based dedup via data-fdl-for on the
button itself, stale-host cleanup with :scope-scoped lookup, last-anchor
selection for nested anchors, high-contrast overlay styling, and a 1s
interval + MutationObserver watch. All DL buttons now require
event.isTrusted and share a volatile per-tab in-flight guard, the
preconditions the spec sets for widening the trigger surface without
dedup (rounds 18/25). Gated on the measured hard-gate results."'
```

---

## 完了後: レビューゲート

全タスク完了後(および ≥5 ファイル規模の Task 3 / Task 8 直後)、CLAUDE.md の Review gate に従い codex-review skill(native モード)で review→fix→re-review を clean まで反復する。codex CLI が使えない場合は `/code-review` を subagent で代替する。レビュー完了までこのブランチを merge しない。
