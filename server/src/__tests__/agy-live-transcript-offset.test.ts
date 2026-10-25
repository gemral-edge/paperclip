import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findAntigravityRunByTurnMarker,
  readAntigravityRunEntries,
  turnLineOffset,
} from "@paperclipai/adapter-antigravity-local/server";

// GEMRAL 26/10 — Paperclip DB pool wedged 05:43-06:01: the agy live poller re-read and
// JSON-parsed whole multi-MB resumed-brain transcripts every 1.2s. The poller now reads
// from this run's turn offset; the result must equal a full read.
const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;
const oldTurns = Array.from({ length: 200 }, (_, i) =>
  line({ type: "USER_INPUT", content: `old turn ${i} prompt-old-${i}.md` }) +
  line({ type: "PLANNER_RESPONSE", source: "MODEL", thinking: "x".repeat(500), content: `old reply ${i}` }),
).join("");
const MARKER = "paperclip-agy-prompt-run42.md";
const ourTurn =
  line({ type: "USER_INPUT", content: `Làm việc này. ${MARKER}` }) +
  line({ type: "PLANNER_RESPONSE", source: "MODEL", thinking: "nghĩ", tool_calls: [{ name: "run_command", args: { cmd: "ls" } }] });

let home: string;
let file: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-offset-"));
  vi.spyOn(os, "homedir").mockReturnValue(home);
  const dir = path.join(home, ".gemini", "antigravity-cli", "brain", "brain-1", ".system_generated", "logs");
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(file, oldTurns + ourTurn);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("agy live transcript offset", () => {
  it("turnLineOffset points at the start of the marker line", () => {
    const buf = fs.readFileSync(file);
    const off = turnLineOffset(buf, MARKER);
    expect(buf.subarray(off).toString("utf8").startsWith('{"type":"USER_INPUT"')).toBe(true);
    expect(off).toBe(Buffer.byteLength(oldTurns));
    expect(turnLineOffset(buf, "absent-marker")).toBe(0);
  });

  it("reading from the turn offset gives the same entries as a full read, and follows appends", async () => {
    const full = await readAntigravityRunEntries("brain-1", MARKER);
    expect(full.found).toBe(true);
    expect(full.turnOffset).toBe(Buffer.byteLength(oldTurns));

    fs.appendFileSync(file, line({ type: "PLANNER_RESPONSE", source: "MODEL", content: "Xong ạ." }));
    const sliced = await readAntigravityRunEntries("brain-1", MARKER, full.turnOffset);
    const fullAgain = await readAntigravityRunEntries("brain-1", MARKER);
    expect(sliced.entries).toEqual(fullAgain.entries);
    expect(sliced.reply).toBe("Xong ạ.");
    expect(sliced.turnOffset).toBe(full.turnOffset);
  });

  it("falls back to a full read when the offset no longer holds the turn", async () => {
    // Offset past the start of our USER_INPUT line (e.g. transcript rewritten) → slice lacks the turn.
    const pastTurnStart = Buffer.byteLength(oldTurns) + 10;
    const r = await readAntigravityRunEntries("brain-1", MARKER, pastTurnStart);
    expect(r.found).toBe(true);
    expect(r.turnOffset).toBe(Buffer.byteLength(oldTurns));
    const beyondEof = await readAntigravityRunEntries("brain-1", MARKER, 10_000_000);
    expect(beyondEof.turnOffset).toBe(Buffer.byteLength(oldTurns));
  });

  it("find skips brains not written since the run started", async () => {
    const future = Date.now() + 60_000;
    const miss = await findAntigravityRunByTurnMarker(MARKER, { attempts: 1, modifiedSinceMs: future });
    expect(miss.found).toBe(false);
    const hit = await findAntigravityRunByTurnMarker(MARKER, { attempts: 1, modifiedSinceMs: Date.now() - 60_000 });
    expect(hit.found).toBe(true);
    expect(hit.brainId).toBe("brain-1");
  });
});
