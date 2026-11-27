// GEM-2861 (UX-1127-S3-06-a9692b): Bảo vệ 2 lớp cho Paperclip UI:
// (1) Mọi lời gọi `navigator.clipboard.writeText(...)` phải bọc `try { await ... } catch` trong cùng function hoặc chuỗi `.catch(...)` / `.then(ok, err)`.
// (2) Mọi class chữ sáng `text-emerald-(200|300|400)` trên surface theo theme phải có tiền tố `dark:` (tránh mất tương phản trên Light Mode).
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

/** Trả về danh sách dòng (1-based) dùng `text-emerald-(200|300|400)` mà thiếu tiền tố `dark:`. */
export function findBareLightEmerald(source: string): number[] {
  if (!source.includes("text-emerald-")) return [];
  const rawLines = source.split("\n");
  const cleanedLines = stripJsCommentsPreserveLines(source).split("\n");
  const rx = /(?<![:\w-])((?:[a-z0-9[\]_-]+:)*)text-emerald-(?:200|300|400)(?![\w-])/g;
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

  it("findBareLightEmerald bắt đúng class sáng thiếu dark: và thả dạng có dark:/nền tối", () => {
    expect(findBareLightEmerald('<span className="text-emerald-400">ok</span>')).toEqual([1]);
    expect(findBareLightEmerald('<span className="text-emerald-300">ok</span>')).toEqual([1]);
    expect(findBareLightEmerald('<span className="hover:text-emerald-400">ok</span>')).toEqual([1]);
    expect(findBareLightEmerald('<span className="text-emerald-400/80">ok</span>')).toEqual([1]);
    expect(findBareLightEmerald('<span className="text-emerald-400 dark:text-emerald-400">ok</span>')).toEqual([1]);

    expect(findBareLightEmerald('<span className="text-emerald-600 dark:text-emerald-400">ok</span>')).toEqual([]);
    expect(findBareLightEmerald('<span className="dark:hover:text-emerald-400">ok</span>')).toEqual([]);
    expect(findBareLightEmerald('<span className="bg-emerald-400">ok</span>')).toEqual([]);
    expect(findBareLightEmerald('<span className="text-emerald-400">ok</span> // dark-surface-ok')).toEqual([]);
    expect(findBareLightEmerald('// <span className="text-emerald-400">ok</span>')).toEqual([]);
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

  it("không có file theo theme nào vượt trần text-emerald-(200|300|400) thiếu tiền tố dark:", () => {
    const darkOnly = new Set(baseline.darkOnlySurfaceFiles as string[]);
    const emeraldLegacy = (baseline.lightEmeraldLegacy ?? {}) as Record<string, number>;
    const offenders: string[] = [];
    for (const f of walkUiSrc(SRC)) {
      const rel = relative(SRC, f).replace(/\\/g, "/");
      if (darkOnly.has(rel)) continue;
      const lines = findBareLightEmerald(readFileSync(f, "utf8"));
      const allowed = emeraldLegacy[rel] ?? 0;
      if (lines.length > allowed) {
        offenders.push(`${rel}:${lines.join(",")} (actual=${lines.length} > allowed=${allowed})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
