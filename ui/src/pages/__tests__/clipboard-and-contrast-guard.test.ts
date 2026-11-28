// GEM-2861 & GEM-2882: Bảo vệ 2 lớp cho Paperclip UI:
// (1) Mọi lời gọi `navigator.clipboard.writeText(...)` phải bọc `try { await ... } catch` trong cùng function hoặc chuỗi `.catch(...)` / `.then(ok, err)`.
// (2) Mọi class chữ sáng `text-(17 họ màu sắc tố)-(100|200|300|400)` trên surface theo theme phải có tiền tố `dark:` (tránh mất tương phản trên Light Mode).
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import baseline from "./clipboard-and-contrast-guard.baseline.json";

const SRC = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

function isInTryCatchSameFn(node: ts.Node): boolean {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isFunctionLike(cur)) return false;
    if (ts.isTryStatement(cur) && cur.catchClause) {
      let c: ts.Node | undefined = node;
      while (c && c !== cur) {
        if (c === cur.tryBlock) return true;
        c = c.parent;
      }
    }
    cur = cur.parent;
  }
  return false;
}

function hasPromiseCatch(callExpr: ts.CallExpression): boolean {
  let cur: ts.Node = callExpr;
  while (cur.parent) {
    const p = cur.parent;
    if (
      ts.isPropertyAccessExpression(p) &&
      p.expression === cur &&
      ts.isCallExpression(p.parent) &&
      p.parent.expression === p
    ) {
      const method = p.name.text;
      const outerCall = p.parent;
      if (method === "catch") return true;
      if (method === "then" && outerCall.arguments.length >= 2) return true;
      if (method === "then" || method === "finally") {
        cur = outerCall;
        continue;
      }
    }
    break;
  }
  return false;
}

/** Trả về danh sách dòng (1-based) có `navigator.clipboard.writeText(...)` chưa bọc `try { await ... } catch` hoặc `.catch()`. */
export function findUnguardedClipboardWrites(source: string, fileName = "test.tsx"): number[] {
  if (!source.includes("clipboard") || !source.includes("writeText")) return [];
  const kind = fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const bad: number[] = [];

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const exprText = node.expression.getText(sf).replace(/\s+/g, "");
      if (/(?:^|[^.\w$])navigator\??\.clipboard\??\.writeText$/.test(exprText)) {
        const awaitedInTry = ts.isAwaitExpression(node.parent) && isInTryCatchSameFn(node);
        if (!awaitedInTry && !hasPromiseCatch(node)) {
          const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          bad.push(pos.line + 1);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return bad;
}

function stripJsCommentsPreserveLines(src: string): string {
  const out: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      out.push(ch);
      i++;
      while (i < n) {
        const c = src[i];
        out.push(c);
        i++;
        if (c === "\\" && i < n) {
          out.push(src[i]);
          i++;
        } else if (c === q) {
          break;
        }
      }
    } else if (src[i] === "/" && src[i + 1] === "*") {
      const j = src.indexOf("*/", i + 2);
      const end = j === -1 ? n : j + 2;
      out.push(src.slice(i, end).replace(/[^\n]/g, " "));
      i = end;
    } else if (src[i] === "/" && src[i + 1] === "/") {
      const j = src.indexOf("\n", i + 2);
      const end = j === -1 ? n : j;
      out.push(" ".repeat(end - i));
      i = end;
    } else {
      out.push(ch);
      i++;
    }
  }
  return out.join("");
}

const CHROMATIC_LIGHT_COLORS =
  "emerald|amber|red|green|yellow|blue|cyan|sky|rose|violet|pink|indigo|purple|teal|orange|lime|fuchsia";

/** Trả về danh sách dòng (1-based) dùng `text-(17 họ màu sắc tố)-(100|200|300|400)` mà thiếu tiền tố `dark:`. */
export function findBareLightStatusText(source: string): number[] {
  if (!new RegExp(`text-(?:${CHROMATIC_LIGHT_COLORS})-`).test(source)) return [];
  const rawLines = source.split("\n");
  const cleanedLines = stripJsCommentsPreserveLines(source).split("\n");
  const rx = new RegExp(
    `(?<![:\\w-])((?:[a-z0-9\\[\\]_-]+:)*)text-(?:${CHROMATIC_LIGHT_COLORS})-(?:100|200|300|400)(?![\\w-])`,
    "g",
  );
  const bad: number[] = [];

  for (let idx = 0; idx < cleanedLines.length; idx++) {
    if (rawLines[idx]?.includes("dark-surface-ok")) continue;
    const line = cleanedLines[idx] ?? "";
    rx.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(line))) {
      const prefix = m[1] || "";
      if (!/(?:^|:)dark:$/.test(prefix) && !prefix.includes("dark:")) {
        bad.push(idx + 1);
        break;
      }
    }
  }
  return bad;
}

/** Giữ tương thích ngược cho caller cũ. */
export const findBareLightEmerald = findBareLightStatusText;

/** Trả về danh sách dòng (1-based) dùng nền tối cứng `bg-[#0A0B1A]` hoặc `bg-[rgba(15,16,48,...)]` thiếu tiền tố `dark:`. */
export function findHardcodedDarkPageBg(source: string): number[] {
  if (!/bg-\[(?:#0a0b1a|rgba\(\s*15\s*,\s*16\s*,\s*48)/i.test(source)) return [];
  const rawLines = source.split("\n");
  const cleanedLines = stripJsCommentsPreserveLines(source).split("\n");
  const rx =
    /(?<![:\w-])((?:[a-z0-9[\]_-]+:)*)bg-\[(?:#0a0b1a|rgba\(\s*15\s*,\s*16\s*,\s*48(?:\s*,\s*[\d.]+)?\s*\))\](?:\/[0-9.[\]]+)?(?![\w-])/gi;
  const bad: number[] = [];

  for (let idx = 0; idx < cleanedLines.length; idx++) {
    if (rawLines[idx]?.includes("dark-surface-ok")) continue;
    const line = cleanedLines[idx] ?? "";
    rx.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(line))) {
      const prefix = m[1] || "";
      if (!prefix.includes("dark:")) {
        bad.push(idx + 1);
        break;
      }
    }
  }
  return bad;
}

const SOLID_DARK_BG_RX =
  /(?<![:\w-])(?:(?:hover|focus|active|group-hover|disabled|data-\[[^\]]+\]):)*bg-(?:black|destructive|primary|success|cyan|gradient-|(?:red|green|emerald|amber|violet|indigo|blue|sky|teal|purple|pink|rose|orange|yellow)-(?:500|600|700|800|900|950)|(?:zinc|slate|gray|neutral|stone)-(?:700|800|900|950))(?:\/(?:[5-9]\d|100))?(?![\w-/])/;

/** Trả về danh sách dòng (1-based) dùng `text-white` / `text-white/<opacity>` trần trên surface theo theme. */
export function findBareTextWhite(source: string): number[] {
  if (!source.includes("text-white")) return [];
  const rawLines = source.split("\n");
  const cleanedLines = stripJsCommentsPreserveLines(source).split("\n");
  const rx = /(?<![:\w-])((?:[a-z0-9[\]_-]+:)*)text-white(?:\/(\d+|\[[^\]]+\]))?(?![\w-])/g;
  const bad: number[] = [];

  for (let idx = 0; idx < cleanedLines.length; idx++) {
    if (rawLines[idx]?.includes("dark-surface-ok")) continue;
    const line = cleanedLines[idx] ?? "";
    const hasSolidBg = SOLID_DARK_BG_RX.test(line);
    rx.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(line))) {
      const prefix = m[1] || "";
      const opacity = m[2];
      if (prefix.includes("dark:")) continue;
      if (opacity !== undefined || !hasSolidBg) {
        bad.push(idx + 1);
        break;
      }
    }
  }
  return bad;
}

function walkUiSrc(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "__tests__") continue;
    if (statSync(p).isDirectory()) walkUiSrc(p, out);
    else if (/\.(ts|tsx|js|jsx)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

describe("GEM-2861: clipboard.writeText error handling & Light Mode text-emerald contrast", () => {
  it("findUnguardedClipboardWrites bắt đúng các dạng thiếu guard và thả dạng hợp lệ", () => {
    expect(findUnguardedClipboardWrites("navigator.clipboard.writeText(x);")).toEqual([1]);
    expect(findUnguardedClipboardWrites("navigator.clipboard.writeText(x).then(() => ok());")).toEqual([1]);
    expect(findUnguardedClipboardWrites("async function f() { await navigator.clipboard.writeText(x); }")).toEqual([1]);
    expect(findUnguardedClipboardWrites("try { navigator.clipboard.writeText(x); } catch {}")).toEqual([1]);
    expect(
      findUnguardedClipboardWrites(
        "async function f() { try { const fn = () => navigator.clipboard.writeText(x); fn(); } catch {} }",
      ),
    ).toEqual([1]);
    expect(findUnguardedClipboardWrites("async function f() { try { await navigator.clipboard.writeText(x); } finally {} }")).toEqual([1]);

    expect(findUnguardedClipboardWrites("async function f() { try { await navigator.clipboard.writeText(x); } catch {} }")).toEqual([]);
    expect(findUnguardedClipboardWrites("navigator.clipboard.writeText(x).then(() => ok()).catch(() => {});")).toEqual([]);
    expect(findUnguardedClipboardWrites("navigator.clipboard.writeText(x).catch(() => {});")).toEqual([]);
    expect(findUnguardedClipboardWrites("navigator.clipboard.writeText(x).then(() => ok(), () => err());")).toEqual([]);
    expect(findUnguardedClipboardWrites("if (typeof navigator.clipboard?.writeText === 'function') {}")).toEqual([]);
  });

  it("findBareLightStatusText bắt đúng 17 họ màu sắc tố sáng thiếu dark: và thả dạng có dark:/nền tối", () => {
    expect(findBareLightStatusText('<span className="text-emerald-200">ok</span>')).toEqual([1]);
    expect(findBareLightStatusText('<span className="text-amber-300">ok</span>')).toEqual([1]);
    expect(findBareLightStatusText('<span className="text-red-100/70">ok</span>')).toEqual([1]);
    expect(findBareLightStatusText('<span className="text-green-400">ok</span>')).toEqual([1]);
    expect(findBareLightStatusText('<span className="text-yellow-400">ok</span>')).toEqual([1]);
    expect(findBareLightStatusText('<span className="hover:text-red-400">ok</span>')).toEqual([1]);
    expect(findBareLightStatusText('<span className="text-amber-400 dark:text-amber-400">ok</span>')).toEqual([1]);
    expect(findBareLightStatusText('<span className="text-blue-400">ok</span>')).toEqual([1]);
    expect(findBareLightStatusText('<span className="text-cyan-400">ok</span>')).toEqual([1]);
    expect(findBareLightStatusText('<span className="text-sky-300">ok</span>')).toEqual([1]);
    expect(findBareLightStatusText('<a className="hover:text-sky-200">ok</a>')).toEqual([1]);
    expect(findBareLightStatusText('<span className="text-rose-400">ok</span>')).toEqual([1]);
    expect(findBareLightStatusText('<span className="text-violet-400">ok</span>')).toEqual([1]);
    expect(findBareLightStatusText('<button className="hover:text-pink-400">ok</button>')).toEqual([1]);
    expect(findBareLightStatusText('<span className="text-purple-300">ok</span>')).toEqual([1]);
    expect(findBareLightStatusText('<span className="text-indigo-300">ok</span>')).toEqual([1]);
    expect(findBareLightStatusText('<span className="text-teal-400">ok</span>')).toEqual([1]);
    expect(findBareLightStatusText('<span className="text-orange-300">ok</span>')).toEqual([1]);
    expect(findBareLightStatusText('<span className="text-lime-400">ok</span>')).toEqual([1]);
    expect(findBareLightStatusText('<span className="text-fuchsia-300">ok</span>')).toEqual([1]);

    expect(findBareLightStatusText('<span className="text-emerald-700 dark:text-emerald-200">ok</span>')).toEqual([]);
    expect(findBareLightStatusText('<span className="text-amber-700 dark:text-amber-400">ok</span>')).toEqual([]);
    expect(findBareLightStatusText('<span className="text-blue-700 dark:text-blue-400">ok</span>')).toEqual([]);
    expect(findBareLightStatusText('<span className="text-rose-700 dark:text-rose-400">ok</span>')).toEqual([]);
    expect(findBareLightStatusText('<span className="text-sky-300">ok</span> // dark-surface-ok')).toEqual([]);
    expect(findBareLightStatusText('<span className="dark:hover:text-amber-400">ok</span>')).toEqual([]);
    expect(findBareLightStatusText('<span className="bg-red-600/90 text-red-50">ok</span>')).toEqual([]);
    expect(findBareLightStatusText('<span className="text-green-400">ok</span> {/* dark-surface-ok */}')).toEqual([]);
    expect(findBareLightStatusText('// <span className="text-red-400">ok</span>')).toEqual([]);
  });

  it("baseline.clipboardWriteTextLegacy đã dọn sạch 0 và không có file nào vượt trần", () => {
    const legacy = baseline.clipboardWriteTextLegacy as Record<string, number>;
    expect(Object.keys(legacy)).toEqual([]);
    for (const rel of Object.keys(legacy)) {
      expect(existsSync(join(SRC, rel)), `File trong baseline không tồn tại: ${rel}`).toBe(true);
    }

    const offenders: string[] = [];
    for (const f of walkUiSrc(SRC)) {
      const rel = relative(SRC, f).replace(/\\/g, "/");
      const lines = findUnguardedClipboardWrites(readFileSync(f, "utf8"), f);
      const allowed = legacy[rel] ?? 0;
      if (lines.length > allowed) {
        offenders.push(`${rel}:${lines.join(",")} (actual=${lines.length} > allowed=${allowed})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("không có file theo theme nào vượt trần text-(emerald|amber|red|green|yellow)-(100|200|300|400) thiếu tiền tố dark:", () => {
    const darkOnly = new Set(baseline.darkOnlySurfaceFiles as string[]);
    const emeraldLegacy = (baseline.lightEmeraldLegacy ?? {}) as Record<string, number>;
    expect(Object.keys(emeraldLegacy)).toEqual([]);
    const offenders: string[] = [];
    for (const f of walkUiSrc(SRC)) {
      const rel = relative(SRC, f).replace(/\\/g, "/");
      if (darkOnly.has(rel)) continue;
      const lines = findBareLightStatusText(readFileSync(f, "utf8"));
      const allowed = emeraldLegacy[rel] ?? 0;
      if (lines.length > allowed) {
        offenders.push(`${rel}:${lines.join(",")} (actual=${lines.length} > allowed=${allowed})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("findHardcodedDarkPageBg bắt đúng bg-[#0A0B1A]/bg-[rgba(15,16,48,...)] và thả dạng có dark:/comment", () => {
    expect(findHardcodedDarkPageBg('<div className="bg-[#0A0B1A]">x</div>')).toEqual([1]);
    expect(findHardcodedDarkPageBg('<div className="bg-[#0a0b1a]/90">x</div>')).toEqual([1]);
    expect(findHardcodedDarkPageBg('<div className="bg-[rgba(15,16,48,0.35)]">x</div>')).toEqual([1]);

    expect(findHardcodedDarkPageBg('<div className="bg-background dark:bg-[#0A0B1A]">x</div>')).toEqual([]);
    expect(findHardcodedDarkPageBg('<div className="bg-[#0A0B1A]">x</div> {/* dark-surface-ok */}')).toEqual([]);
    expect(findHardcodedDarkPageBg('// <div className="bg-[#0A0B1A]">x</div>')).toEqual([]);
  });

  it("findBareTextWhite bắt đúng text-white trần & text-white/XX, thả dạng có dark: hoặc nền đậm cùng dòng", () => {
    expect(findBareTextWhite('<span className="text-white">x</span>')).toEqual([1]);
    expect(findBareTextWhite('<button className="hover:text-white">x</button>')).toEqual([1]);
    expect(findBareTextWhite('<p className="text-white/40">x</p>')).toEqual([1]);
    expect(findBareTextWhite('<span className="bg-red-500/20 text-white">x</span>')).toEqual([1]);
    expect(findBareTextWhite('<div className="bg-black/60 text-white/40">x</div>')).toEqual([1]);
    expect(findBareTextWhite('<input className="bg-white/[0.04] text-white" />')).toEqual([1]);

    expect(findBareTextWhite('<span className="text-foreground dark:text-white">x</span>')).toEqual([]);
    expect(findBareTextWhite('<button className="dark:hover:text-white">x</button>')).toEqual([]);
    expect(findBareTextWhite('<span className="bg-red-600 text-white">x</span>')).toEqual([]);
    expect(findBareTextWhite('<button className="bg-green-700 text-white">x</button>')).toEqual([]);
    expect(findBareTextWhite('<div className="bg-black/60 text-white">x</div>')).toEqual([]);
    expect(findBareTextWhite('<button className="bg-destructive text-white">x</button>')).toEqual([]);
    expect(findBareTextWhite('<span className="bg-zinc-900 text-white">x</span>')).toEqual([]);
    expect(findBareTextWhite('<span className="text-white/70">x</span> {/* dark-surface-ok */}')).toEqual([]);
    expect(findBareTextWhite('// <span className="text-white">x</span>')).toEqual([]);
  });

  it("không có file theo theme nào dùng bg-[#0A0B1A] hoặc bg-[rgba(15,16,48,...)]", () => {
    const darkOnly = new Set(baseline.darkOnlySurfaceFiles as string[]);
    const darkBgLegacy = (baseline.hardcodedDarkBgLegacy ?? {}) as Record<string, number>;
    expect(Object.keys(darkBgLegacy)).toEqual([]);
    const offenders: string[] = [];
    for (const f of walkUiSrc(SRC)) {
      const rel = relative(SRC, f).replace(/\\/g, "/");
      if (darkOnly.has(rel)) continue;
      const lines = findHardcodedDarkPageBg(readFileSync(f, "utf8"));
      const allowed = darkBgLegacy[rel] ?? 0;
      if (lines.length > allowed) {
        offenders.push(`${rel}:${lines.join(",")} (actual=${lines.length} > allowed=${allowed})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("baseline.bareTextWhitePagesLegacy trong pages/ không vượt trần và không có entry stale/dangling", () => {
    const darkOnly = new Set(baseline.darkOnlySurfaceFiles as string[]);
    const legacy = (baseline.bareTextWhitePagesLegacy ?? {}) as Record<string, number>;
    for (const rel of Object.keys(legacy)) {
      expect(existsSync(join(SRC, rel)), `File trong bareTextWhitePagesLegacy không tồn tại: ${rel}`).toBe(true);
    }

    const actualCounts: Record<string, number> = {};
    const offenders: string[] = [];
    for (const f of walkUiSrc(join(SRC, "pages"))) {
      const rel = relative(SRC, f).replace(/\\/g, "/");
      if (darkOnly.has(rel)) continue;
      const lines = findBareTextWhite(readFileSync(f, "utf8"));
      actualCounts[rel] = lines.length;
      const allowed = legacy[rel] ?? 0;
      if (lines.length > allowed) {
        offenders.push(`${rel}:${lines.join(",")} (actual=${lines.length} > allowed=${allowed})`);
      }
    }
    expect(offenders).toEqual([]);

    const stale: string[] = [];
    for (const [rel, allowed] of Object.entries(legacy)) {
      const actual = actualCounts[rel] ?? 0;
      if (allowed > actual) {
        stale.push(`${rel} (allowed=${allowed} > actual=${actual})`);
      }
    }
    expect(stale).toEqual([]);
  });
});
