import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

// ── Output parsing ──────────────────────────────────────────────────────────
// Antigravity CLI (`agy`) prints the assistant reply as PLAIN TEXT on stdout in
// print mode (`-p`), NOT stream-json (unlike Gemini CLI). So the reply is simply
// the stdout text. We still strip a few known banner/diagnostic lines that agy
// may emit (MCP warnings, "Loaded ... brain", etc.) so the summary stays clean.

// Lines agy may print around the actual answer that are noise, not reply content.
const AGY_NOISE_LINE_RE =
  /^(?:\[?(?:info|warn|warning|debug)\]?[:\s]|loaded\s|using\s+conversation\b|mcp\s+issues\s+detected|connecting\s+to\s+mcp|starting\s+antigravity|✦\s*$)/i;

export interface AntigravityParseResult {
  summary: string;
  leaked: boolean;
}

export function parseAntigravityStdout(stdout: string): AntigravityParseResult {
  const lines = (stdout ?? "").split(/\r?\n/);
  const kept: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim().length === 0) {
      kept.push("");
      continue;
    }
    if (AGY_NOISE_LINE_RE.test(line.trim())) continue;
    kept.push(line);
  }
  const summary = kept.join("\n").trim();
  return { summary, leaked: looksLikeSystemPromptLeak(summary) };
}

// Leak-guard: if agy echoes the injected context file back (instead of acting on
// it), the reply will contain these unmistakable internal markers. The heartbeat
// runtime can use `leaked` to avoid posting raw system context as a comment.
const SYSTEM_PROMPT_LEAK_MARKERS = [
  "QUAN TRỌNG: KỸ NĂNG PAPERCLIP",
  "BỐI CẢNH BẮT BUỘC PHẢI GREP",
  "MEMORY CONTEXT (auto-injected",
  "CÁCH GỌI MCP TOOLS (QUAN TRỌNG",
  "Paperclip runtime note:",
];

export function looksLikeSystemPromptLeak(text: string): boolean {
  if (!text) return false;
  return SYSTEM_PROMPT_LEAK_MARKERS.some((marker) => text.includes(marker));
}

// ── Usage / cost (best-effort, optional) ────────────────────────────────────
// agy does not stream usage. After the run it writes a transcript to
//   ~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl
// We read that file (if present) and tolerantly accumulate token usage. Any
// failure → zero usage (usage is optional, never fails the run).

export interface AntigravityUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

function accumulateUsage(target: AntigravityUsage, usageRaw: unknown): void {
  const usage = parseObject(usageRaw);
  const usageMetadata = parseObject(usage.usageMetadata);
  const source = Object.keys(usageMetadata).length > 0 ? usageMetadata : usage;
  target.inputTokens += asNumber(
    source.input_tokens,
    asNumber(source.inputTokens, asNumber(source.promptTokenCount, 0)),
  );
  target.cachedInputTokens += asNumber(
    source.cached_input_tokens,
    asNumber(source.cachedInputTokens, asNumber(source.cachedContentTokenCount, 0)),
  );
  target.outputTokens += asNumber(
    source.output_tokens,
    asNumber(source.outputTokens, asNumber(source.candidatesTokenCount, 0)),
  );
}

export function antigravityTranscriptPath(conversationId: string): string {
  return path.join(
    os.homedir(),
    ".gemini",
    "antigravity-cli",
    "brain",
    conversationId,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );
}

// CRITICAL (Windows TTY trap — lesson evolution-log/08-windows.md, 2026-06-15):
// agy is a TTY-engine CLI; on Windows it prints the reply straight to CONOUT$,
// BYPASSING the subprocess stdout pipe → proc.stdout is EMPTY. The real reply
// MUST be read from the brain transcript (PLANNER_RESPONSE from the MODEL).
//
// The brain is REUSED across turns, so we must return ONLY this run's answer, not
// a stale prior turn. We locate the USER_INPUT whose content contains `turnMarker`
// (the unique per-run temp prompt filename, e.g. agy_prompt_<runId>.md) and gather
// every non-empty MODEL/PLANNER_RESPONSE AFTER it. If that USER_INPUT is not in the
// file yet (agy still flushing), found=false → the caller polls/retries.
function parseReplyOnce(
  raw: string,
  turnMarker: string,
): { reply: string; found: boolean } {
  const entries: Array<{ type: string; source: string; content: string }> = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const data = parseJson(line);
    if (!data) continue;
    entries.push({
      type: asString(data.type, "").trim(),
      source: asString(data.source, "").trim(),
      content: asString(data.content, ""),
    });
  }

  // Index of the USER_INPUT that belongs to this run.
  let startIdx = -1;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.type !== "USER_INPUT") continue;
    if (turnMarker ? e.content.includes(turnMarker) : true) startIdx = i;
  }
  if (startIdx < 0) return { reply: "", found: false };

  const responses: string[] = [];
  for (let i = startIdx + 1; i < entries.length; i++) {
    const e = entries[i];
    // A later USER_INPUT means our turn ended — stop (defensive; shouldn't happen
    // when turnMarker matches the latest run).
    if (e.type === "USER_INPUT") break;
    if (e.source === "MODEL" && e.type === "PLANNER_RESPONSE") {
      const content = e.content.trim();
      if (content) responses.push(content);
    }
  }
  return { reply: responses.join("\n\n").trim(), found: responses.length > 0 };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ── Full run transcript (turns / thinking / tool calls / tool results) ───────
// To render a rich transcript like the gemini/claude adapters, we extract EVERY
// agy brain entry for THIS run (after the turnMarker USER_INPUT) and normalize it
// into a compact line the UI parser (parseAntigravityStdoutLine) maps to a
// TranscriptEntry. agy entry types: USER_INPUT · PLANNER_RESPONSE (thinking +
// tool_calls + optional content) · VIEW_FILE / RUN_COMMAND / CODE_ACTION (tool
// results) · EPHEMERAL_MESSAGE / SYSTEM_MESSAGE / CONVERSATION_HISTORY (skipped).

export interface AntigravityNormEntry {
  agyKind: "user" | "thinking" | "tool_call" | "tool_result" | "assistant";
  text?: string;
  name?: string;
  input?: unknown;
  content?: string;
  isError?: boolean;
}

const TRUNC_CONTENT = 4000;
const TRUNC_THINK = 6000;
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n…[+${s.length - n} ký tự bị cắt]` : s;
}

function parseAntigravityRunEntries(
  raw: string,
  turnMarker: string,
): { entries: AntigravityNormEntry[]; reply: string; found: boolean } {
  const objs: Array<Record<string, unknown>> = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const d = parseJson(line);
    if (d) objs.push(d);
  }
  let startIdx = -1;
  for (let i = 0; i < objs.length; i++) {
    if (asString(objs[i].type, "").trim() === "USER_INPUT" && asString(objs[i].content, "").includes(turnMarker)) {
      startIdx = i;
    }
  }
  if (startIdx < 0) return { entries: [], reply: "", found: false };

  const entries: AntigravityNormEntry[] = [];
  const replies: string[] = [];
  const userText = asString(objs[startIdx].content, "").trim();
  if (userText) entries.push({ agyKind: "user", text: truncate(userText, TRUNC_CONTENT) });

  for (let i = startIdx + 1; i < objs.length; i++) {
    const d = objs[i];
    const type = asString(d.type, "").trim();
    if (type === "USER_INPUT") break; // our turn ended
    const source = asString(d.source, "").trim();
    if (type === "PLANNER_RESPONSE" && source === "MODEL") {
      const thinking = asString(d.thinking, "").trim();
      if (thinking) entries.push({ agyKind: "thinking", text: truncate(thinking, TRUNC_THINK) });
      const tcs = Array.isArray(d.tool_calls) ? d.tool_calls : [];
      for (const tcRaw of tcs) {
        const tc = parseObject(tcRaw);
        entries.push({ agyKind: "tool_call", name: asString(tc.name, "tool"), input: tc.args ?? tc.input ?? {} });
      }
      const content = asString(d.content, "").trim();
      if (content) {
        entries.push({ agyKind: "assistant", text: content });
        replies.push(content);
      }
    } else if (source === "MODEL" && (type === "VIEW_FILE" || type === "RUN_COMMAND" || type === "CODE_ACTION")) {
      entries.push({
        agyKind: "tool_result",
        name: type.toLowerCase(),
        content: truncate(asString(d.content, "").trim(), TRUNC_CONTENT),
        isError: asString(d.status, "").toLowerCase() === "error",
      });
    }
    // EPHEMERAL_MESSAGE / SYSTEM_MESSAGE / CONVERSATION_HISTORY → skip (noise)
  }
  return { entries, reply: replies.join("\n\n").trim(), found: true };
}

// GEM-1307 — agy tools that only READ (no side effect). A heartbeat run whose every
// tool_call is in this set "planned but never acted" (run d5ca8b44 07/10: Yinyang
// read its prompt, printed the SPEC-LOCK table, ended the turn → slot left empty yet
// marked succeeded). Unknown tool names count as ACTION (fail-open toward success:
// a new agy write tool must never make real work look like a no-op).
export const ANTIGRAVITY_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "view_file",
  "read_file", // agy ≥1.4 name for view_file (GEM-1307 tái phát 22/10, run 2f7855e4)
  "view_file_outline",
  "view_code_item",
  "view_content_chunk",
  "list_dir",
  "find_by_name",
  "grep_search",
  "codebase_search",
  "read_url_content",
  "search_web",
  "read_resource",
  "list_resources",
]);

export function countAntigravityActionCalls(entries: AntigravityNormEntry[]): number {
  let n = 0;
  for (const e of entries ?? []) {
    if (e.agyKind !== "tool_call") continue;
    const name = (e.name ?? "").trim().toLowerCase();
    if (!ANTIGRAVITY_READ_ONLY_TOOLS.has(name)) n++;
  }
  return n;
}

// GEM-1307 (tái phát 22/10) — run 2f7855e4 (Kiểm Định UX): 23 run_command chỉ đo/đọc
// (grep, Test-Path, eslint) nên countAntigravityActionCalls > 0, nhưng model in SPEC-LOCK
// rồi kết thúc lượt bằng "Bây giờ em tiến hành tự sửa từng file…" — 0 file được ghi.
// run_command không phân biệt đọc/ghi được, nên bắt theo CÂU HỨA ở đoạn cuối + 0 tool ghi.
// File-mutation tools = allowlist ngược lại: chỉ tool ghi file / gọi MCP rõ ràng.
export const ANTIGRAVITY_MUTATION_TOOL_RE =
  /^(?:write_file|write_to_file|replace_file_content|multi_replace_file_content|edit_file|call_mcp_tool|mcp_.+)$/;

export function countAntigravityMutationCalls(entries: AntigravityNormEntry[]): number {
  let n = 0;
  for (const e of entries ?? []) {
    if (e.agyKind !== "tool_call") continue;
    if (ANTIGRAVITY_MUTATION_TOOL_RE.test((e.name ?? "").trim().toLowerCase())) n++;
  }
  return n;
}

// Promise-to-continue phrasing, matched ONLY against the closing paragraph of the reply.
export const ANTIGRAVITY_UNFINISHED_PROMISE_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:bây\s+giờ|tiếp\s+theo|sau\s+đây|giờ\s+đây|ngay\s+bây\s+giờ)\s*,?\s*em\s+(?:sẽ\s+|xin\s+phép\s+)?(?:tiến\s+hành|bắt\s+đầu|bắt\s+tay|thực\s+hiện|chuyển\s+sang|đi\s+vào|làm\s+tiếp|sửa)/i,
  /\bem\s+(?:sẽ|xin\s+phép)\s+(?:tiến\s+hành|bắt\s+đầu|bắt\s+tay\s+vào|thực\s+hiện\s+ngay)/i,
  /\b(?:now|next),?\s+I(?:'ll|\s+will|\s+am\s+going\s+to|'m\s+going\s+to)\s+(?:proceed|start|begin|implement|fix|apply|edit|write|make)/i,
  /\blet\s+me\s+(?:now\s+)?(?:proceed|start|begin)\b/i,
  /\bI(?:'ll|\s+will)\s+now\s+(?:proceed|start|begin|implement|fix|apply|edit|write)/i,
];

export function closingParagraph(reply: string | null | undefined): string {
  const blocks = (reply ?? "")
    .trim()
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  return blocks.length ? blocks[blocks.length - 1].slice(-400) : "";
}

export function isAntigravityUnfinishedPromise(reply: string | null | undefined): boolean {
  const tail = closingParagraph(reply);
  if (!tail) return false;
  return ANTIGRAVITY_UNFINISHED_PROMISE_PATTERNS.some((p) => p.test(tail));
}

// GEM-1316 — Clean-exit prose patterns. When an agent wakes up via timer / heartbeat / retry
// and finds that its slot has already posted (idempotency gate), is outside the active time window,
// or has no actionable tasks in the backlog, it MUST exit cleanly without calling side-effect tools
// (doing so would cause duplicate posts or unwanted mutations).
// Such runs have countAntigravityActionCalls === 0, but are legitimate successes, NOT antigravity_no_action bugs.
export const ANTIGRAVITY_CLEAN_EXIT_PATTERNS: ReadonlyArray<RegExp> = [
  // 1. Thoát sạch (tiếng Việt phổ biến nhất trong hệ)
  /thoát\s+sạch/i,
  // 2. Không có task / issue / việc cần làm → thoát
  /(?:không\s+có\s+(?:task|issue|việc|backlog)|0\s+(?:task|issue|việc)|chưa\s+có\s+(?:task|issue)).*?(?:thoát|kết\s+thúc|dừng|exit)/i,
  // 3. Idempotency / chống đăng đôi / đã đăng
  /(?:idempotent|idempotency(?:\s+gate)?|chống\s+đăng\s+đôi|tránh\s+đăng\s+đôi|không\s+đăng\s+đôi)/i,
  /(?:slot\s+.*?đã\s+(?:đăng|posted|xong)|đã\s+đăng\s+đủ\s+slot|mọi\s+slot\s+.*?đã)/i,
  // 4. Khung giờ / cửa sổ thời gian
  /(?:ngoài\s+khung\s+giờ|chưa\s+(?:tới|đến)\s+khung\s+giờ|ngoài\s+cửa\s+sổ|chưa\s+(?:tới|đến)\s+giờ)/i,
  // 5. English clean exit / no assigned task
  /\b(?:clean\s+exit|exit(?:ing)?\s+cleanly|idempotent\s+exit)\b/i,
  /\bno\s+(?:assigned\s+)?(?:tasks?|issues?).*?\b(?:exit|done|stop)\b/i,
  /\balready\s+posted\b/i,
];

export function isAntigravityCleanExitProse(reply: string | null | undefined): boolean {
  if (!reply) return false;
  const text = reply.trim();
  if (!text) return false;
  return ANTIGRAVITY_CLEAN_EXIT_PATTERNS.some((pattern) => pattern.test(text));
}

// Synthesize a concise work-summary for a run that did real work (tool calls /
// reasoning) but produced NO closing prose PLANNER_RESPONSE.content — common for
// heartbeat WORK runs that end on a tool action. Returns "" when there is nothing
// meaningful to report, so a genuinely empty run still surfaces as a failure.
export function summarizeAntigravityWork(entries: AntigravityNormEntry[]): string {
  if (!entries || entries.length === 0) return "";
  const toolCounts = new Map<string, number>();
  let lastThinking = "";
  for (const e of entries) {
    if (e.agyKind === "tool_call") {
      const name = (e.name ?? "tool").trim() || "tool";
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
    } else if (e.agyKind === "thinking" && e.text) {
      lastThinking = e.text;
    }
  }
  const tally = [...toolCounts.entries()].map(([name, count]) => `${name} ×${count}`).join(", ");
  if (!tally && !lastThinking) return "";
  const head = tally
    ? `⚙️ agy đã hoàn thành phiên làm việc (không có tóm tắt prose). Hành động: ${tally}.`
    : `⚙️ agy đã chạy nhưng chỉ suy luận, chưa thực thi hành động nào.`;
  // Only attach the raw reasoning when there are NO tool actions — when a tool tally
  // exists it already tells the story and the chain-of-thought is just noise.
  const note = !tally && lastThinking
    ? `\n\nGhi chú: ${lastThinking.replace(/\s+/g, " ").trim().slice(0, 300)}`
    : "";
  return `${head}${note}`;
}

// Scan brains (newest first) for the one holding THIS run's turnMarker and return
// its full normalized run entries + reply + the real brain id.
// GEMRAL 26/10 (Paperclip DB-pool wedge): brains are resumed across heartbeats, so
// transcripts grow to several MB; the live poller called this every 1.2s and JSON-parsed
// up to 30 whole transcripts per tick, starving the event loop until postgres.js timed
// out. `modifiedSinceMs` keeps only brains written since the run started, and a plain
// `includes(turnMarker)` check skips files that cannot hold this run before any parsing.
export async function findAntigravityRunByTurnMarker(
  turnMarker: string,
  opts: {
    attempts?: number;
    delayMs?: number;
    scanLimit?: number;
    modifiedSinceMs?: number;
    knownBrainId?: string;
    fromOffset?: number;
  } = {},
): Promise<{ brainId: string; entries: AntigravityNormEntry[]; reply: string; found: boolean; turnOffset: number }> {
  if (!turnMarker) return { brainId: "", entries: [], reply: "", found: false, turnOffset: 0 };
  const attempts = opts.attempts ?? 8;
  const delayMs = opts.delayMs ?? 700;
  const scanLimit = opts.scanLimit ?? 25;
  const root = antigravityBrainRoot();
  // A heartbeat WORK run (e.g. "run the full SOP") frequently ends on a tool action
  // with NO closing prose PLANNER_RESPONSE.content → r.reply is empty even though the
  // run did real work. We keep retrying so a prose reply has time to flush, but if it
  // never appears we must still return the brain we DID match by turnMarker (with its
  // entries) instead of "not found" — otherwise the caller misreports a successful
  // work run as an empty-reply failure. Lesson: evolution-log/01-paperclip.md.
  let matchedNoReply: { brainId: string; entries: AntigravityNormEntry[]; turnOffset: number } | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const pinnedBrainId: string = matchedNoReply?.brainId || opts.knownBrainId || "";
    const pinnedOffset: number = matchedNoReply ? matchedNoReply.turnOffset : (opts.fromOffset ?? 0);
    if (pinnedBrainId) {
      const direct = await readAntigravityRunEntries(pinnedBrainId, turnMarker, pinnedOffset);
      if (direct.found && direct.reply) {
        return {
          brainId: pinnedBrainId,
          entries: direct.entries,
          reply: direct.reply,
          found: true,
          turnOffset: direct.turnOffset,
        };
      }
      if (direct.found) {
        matchedNoReply = { brainId: pinnedBrainId, entries: direct.entries, turnOffset: direct.turnOffset };
        if (attempt < attempts - 1) await sleep(delayMs);
        continue;
      }
    }
    try {
      const dirs = (await fs.readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      const withMtime: Array<{ name: string; mtime: number }> = [];
      for (const name of dirs) {
        try {
          const st = await fs.stat(path.join(root, name, ".system_generated", "logs", "transcript.jsonl"));
          if (opts.modifiedSinceMs && st.mtimeMs < opts.modifiedSinceMs) continue;
          withMtime.push({ name, mtime: st.mtimeMs });
        } catch { /* no transcript */ }
      }
      withMtime.sort((a, b) => b.mtime - a.mtime);
      for (const { name } of withMtime.slice(0, scanLimit)) {
        try {
          const buf = await fs.readFile(
            path.join(root, name, ".system_generated", "logs", "transcript.jsonl"),
          );
          if (!buf.includes(turnMarker)) continue;
          const turnOffset = turnLineOffset(buf, turnMarker);
          const slice = buf.subarray(turnOffset).toString("utf8");
          const r = parseAntigravityRunEntries(slice, turnMarker);
          if (r.found && r.reply) {
            return { brainId: name, entries: r.entries, reply: r.reply, found: true, turnOffset };
          }
          // turnMarker matched but no prose yet — remember the freshest entries in case
          // no prose ever arrives (work run). Overwrite each pass for the fullest set.
          if (r.found) matchedNoReply = { brainId: name, entries: r.entries, turnOffset };
        } catch { /* skip */ }
      }
    } catch { /* brain root missing */ }
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  // No brain ever produced a prose reply. If we DID match the turnMarker (work run
  // with no prose), return that brain + its entries so the caller can synthesize a
  // work-summary. Only a never-matched turnMarker is a genuine "not found".
  if (matchedNoReply) {
    return {
      brainId: matchedNoReply.brainId,
      entries: matchedNoReply.entries,
      reply: "",
      found: true,
      turnOffset: matchedNoReply.turnOffset,
    };
  }
  return { brainId: "", entries: [], reply: "", found: false, turnOffset: 0 };
}

// Read + normalize ONE known brain's run entries (used by the live transcript poller
// once the run's brain id is resolved, so it doesn't rescan every brain each tick).
//
// `fromOffset` (GEMRAL 26/10): byte offset of the line that starts THIS run's turn, as
// returned in `turnOffset` by a previous call. When given, only the bytes from there to
// EOF are read and parsed (this run's turn), instead of the whole multi-MB transcript of
// a resumed brain. Falls back to a full read if the slice no longer holds the turn.
export async function readAntigravityRunEntries(
  brainId: string,
  turnMarker: string,
  fromOffset = 0,
): Promise<{ brainId: string; entries: AntigravityNormEntry[]; reply: string; found: boolean; turnOffset: number }> {
  if (!brainId) return { brainId: "", entries: [], reply: "", found: false, turnOffset: 0 };
  const file = path.join(antigravityBrainRoot(), brainId, ".system_generated", "logs", "transcript.jsonl");
  try {
    if (fromOffset > 0) {
      const slice = await readFrom(file, fromOffset);
      if (slice !== null) {
        const r = parseAntigravityRunEntries(slice, turnMarker);
        if (r.found) return { brainId, entries: r.entries, reply: r.reply, found: true, turnOffset: fromOffset };
      }
    }
    const buf = await fs.readFile(file);
    const r = parseAntigravityRunEntries(buf.toString("utf8"), turnMarker);
    return { brainId, entries: r.entries, reply: r.reply, found: r.found, turnOffset: r.found ? turnLineOffset(buf, turnMarker) : 0 };
  } catch {
    return { brainId: "", entries: [], reply: "", found: false, turnOffset: 0 };
  }
}

/** Bytes from `offset` to EOF as utf8, or null when the file is not longer than `offset`. */
async function readFrom(file: string, offset: number): Promise<string | null> {
  const fh = await fs.open(file, "r");
  try {
    const { size } = await fh.stat();
    if (size <= offset) return null;
    const buf = Buffer.alloc(size - offset);
    await fh.read(buf, 0, buf.length, offset);
    return buf.toString("utf8");
  } finally {
    await fh.close();
  }
}

/** Start of the line holding the first occurrence of `turnMarker` (unique per run). */
export function turnLineOffset(buf: Buffer, turnMarker: string): number {
  const idx = buf.indexOf(turnMarker);
  if (idx < 0) return 0;
  const nl = buf.lastIndexOf(0x0a, idx);
  return nl < 0 ? 0 : nl + 1;
}

function antigravityBrainRoot(): string {
  return path.join(os.homedir(), ".gemini", "antigravity-cli", "brain");
}

// CRITICAL (verified 2026-06-16): agy `-p --conversation <id>` does NOT honour the
// id we pass when that brain does NOT exist — it silently CREATES a brand-new brain
// with ITS OWN auto-generated id and runs there. So reading the transcript at the
// id we passed returns empty. Instead we SCAN the brain dirs (newest first) and find
// the brain whose transcript's USER_INPUT contains THIS run's turnMarker → that is
// the real brain agy used. Returns the real brain id + the reply so the caller can
// persist the correct id for the next resume.
export async function findAntigravityReplyByTurnMarker(
  turnMarker: string,
  opts: { attempts?: number; delayMs?: number; scanLimit?: number } = {},
): Promise<{ brainId: string; reply: string; found: boolean }> {
  if (!turnMarker) return { brainId: "", reply: "", found: false };
  const attempts = opts.attempts ?? 8;
  const delayMs = opts.delayMs ?? 700;
  const scanLimit = opts.scanLimit ?? 25;
  const root = antigravityBrainRoot();

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      // sort by transcript mtime desc (newest brains first) — the run that just
      // finished is almost certainly at/near the top.
      const withMtime: Array<{ name: string; mtime: number }> = [];
      for (const name of dirs) {
        try {
          const st = await fs.stat(path.join(root, name, ".system_generated", "logs", "transcript.jsonl"));
          withMtime.push({ name, mtime: st.mtimeMs });
        } catch {
          // no transcript — skip
        }
      }
      withMtime.sort((a, b) => b.mtime - a.mtime);
      for (const { name } of withMtime.slice(0, scanLimit)) {
        try {
          const buf = await fs.readFile(
            path.join(root, name, ".system_generated", "logs", "transcript.jsonl"),
          );
          if (!buf.includes(turnMarker)) continue;
          const slice = buf.subarray(turnLineOffset(buf, turnMarker)).toString("utf8");
          const result = parseReplyOnce(slice, turnMarker);
          if (result.found) return { brainId: name, reply: result.reply, found: true };
        } catch {
          // unreadable — skip
        }
      }
    } catch {
      // brain root missing — fall through to retry
    }
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  return { brainId: "", reply: "", found: false };
}

export async function readAntigravityReplyFromTranscript(
  conversationId: string,
  turnMarker: string,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<{ reply: string; found: boolean }> {
  if (!conversationId) return { reply: "", found: false };
  const attempts = opts.attempts ?? 8;
  const delayMs = opts.delayMs ?? 700;
  const transcriptPath = antigravityTranscriptPath(conversationId);
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const buf = await fs.readFile(transcriptPath);
      const slice = turnMarker && buf.includes(turnMarker)
        ? buf.subarray(turnLineOffset(buf, turnMarker)).toString("utf8")
        : buf.toString("utf8");
      const result = parseReplyOnce(slice, turnMarker);
      if (result.found) return result;
    } catch {
      // transcript not written yet — fall through to retry.
    }
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  return { reply: "", found: false };
}

export async function readAntigravityTranscriptUsage(
  conversationId: string,
  fromOffset = 0,
): Promise<{ usage: AntigravityUsage; costUsd: number | null }> {
  const usage: AntigravityUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  let costUsd: number | null = null;
  if (!conversationId) return { usage, costUsd };
  const file = antigravityTranscriptPath(conversationId);
  try {
    let raw: string | null = null;
    if (fromOffset > 0) {
      raw = await readFrom(file, fromOffset);
    }
    if (raw === null) {
      raw = await fs.readFile(file, "utf8");
    }
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (!line.includes("usage") && !line.includes("cost")) continue;
      const event = parseJson(line);
      if (!event) continue;
      if (event.usage || event.usageMetadata) {
        accumulateUsage(usage, event.usage ?? event.usageMetadata);
      }
      const cost = asNumber(
        event.total_cost_usd,
        asNumber(event.cost_usd, asNumber(event.cost, Number.NaN)),
      );
      if (Number.isFinite(cost) && cost > 0) costUsd = (costUsd ?? 0) + cost;
    }
  } catch {
    // transcript missing/unreadable — usage stays zero (optional).
  }
  return { usage, costUsd };
}

// ── Error / auth / quota detection (text-based, provider-agnostic enough) ────
// agy auth + quota errors surface as plain text on stdout/stderr.

const AUTH_REQUIRED_RE =
  /(?:not\s+authenticated|please\s+authenticate|authentication\s+required|unauthorized|invalid\s+credentials|not\s+logged\s+in|login\s+required|consent\s+could\s+not\s+be\s+obtained|invalid\s+authorization\s+code|requires\s+authentication)/i;
// `credits balance is too low` = Gemini 3.8 Flash prepaid-credit wall (GEM-1178: 8 runs of 5
// agents failed 02:30-03:50 on 03/10, window reopened by itself; no 429/quota word in the line).
const QUOTA_EXHAUSTED_RE =
  /(?:resource_exhausted|quota|rate[-\s]?limit|too many requests|\b429\b|billing details|no capacity available|usage limit|credits? balance (?:is )?too low)/i;
// agy's streaming link to its agent dropped mid-response ("the connection to the agent
// was interrupted … subscriber fell behind updates, stalled for 10s"). Same prompt
// succeeds on a fresh run minutes later (GEM-1017: 11 runs/day by 27/09).
const TRANSIENT_DISCONNECT_RE =
  /(?:connection to the agent was interrupted|subscriber fell behind updates|stalled for \d+s)/i;

function scanLines(stdout: string, stderr: string): string[] {
  return `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function detectAntigravityAuthRequired(input: {
  stdout: string;
  stderr: string;
}): { requiresAuth: boolean } {
  const requiresAuth = scanLines(input.stdout, input.stderr).some((line) => AUTH_REQUIRED_RE.test(line));
  return { requiresAuth };
}

// Quota is read from agy's STDERR only. stdout carries the run transcript (the
// agent's own prose + tool output as JSONL) — an agent that WRITES "Reddit rate
// limit 45s" or "quota target caps" is not out of quota. Scanning stdout marked
// 71/78 exit-0 successful runs as antigravity_quota_exhausted (GEM-1004, measured
// 26/09); every real hit (7/7) was an stderr line `error: RESOURCE_EXHAUSTED
// (code 429)`. `stdout` stays in the signature for caller compatibility.
export function detectAntigravityQuotaExhausted(input: {
  stdout: string;
  stderr: string;
}): { exhausted: boolean } {
  const exhausted = scanLines("", input.stderr)
    .filter((line) => !line.startsWith("[paperclip]"))
    .some((line) => QUOTA_EXHAUSTED_RE.test(line));
  return { exhausted };
}

/** STDERR-only, like quota: stdout is the agent's own transcript prose. */
export function detectAntigravityTransientDisconnect(input: { stderr: string }): { transient: boolean } {
  const transient = scanLines("", input.stderr)
    .filter((line) => !line.startsWith("[paperclip]"))
    .some((line) => TRANSIENT_DISCONNECT_RE.test(line));
  return { transient };
}

// GEM-1741 (31/10/2026): agy ≥1.4.9 (lần đầu 29/10 00:25, 0 lần trong log 22–28/10) đôi khi chết
// ngay bước tuần tự hoá trajectory đầu tiên của cascade: "maxMessageTokens must be positive, got 0"
// (agentexecutor.go:387, binary Google). Đo 7 ngày: 4/371 lượt agy; trajectory cho thấy lỗi nổ TRƯỚC
// khi gọi model hay chạy công cụ (0 token, 0 tool) và lượt kế tiếp trên CÙNG phiên luôn chạy được.
const ZERO_TOKEN_BUDGET_RE = /serializing trajectory: maxMessageTokens must be positive, got 0/i;

/** STDERR-only: agy hỏng trước khi làm gì (ngân sách token = 0) → chạy lại an toàn cùng model/phiên. */
export function detectAntigravityZeroTokenBudget(input: { stderr: string }): { zeroBudget: boolean } {
  const zeroBudget = scanLines("", input.stderr)
    .filter((line) => !line.startsWith("[paperclip]"))
    .some((line) => ZERO_TOKEN_BUDGET_RE.test(line));
  return { zeroBudget };
}

/** Lượt chạy hỏng vì hết credits/quota (stderr) và KHÔNG phải lỗi đăng nhập → đáng thử model kế. */
export function shouldAntigravityFallback(input: { stdout?: string; stderr: string }): boolean {
  if (!detectAntigravityQuotaExhausted({ stdout: "", stderr: input.stderr }).exhausted) return false;
  return !detectAntigravityAuthRequired({ stdout: "", stderr: input.stderr }).requiresAuth;
}
