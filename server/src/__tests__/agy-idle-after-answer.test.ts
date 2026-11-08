import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ANTIGRAVITY_IDLE_AFTER_ANSWER_DEFAULT_SEC,
  normalizeProcessExitCode,
  shouldReapAntigravityIdleAfterAnswer,
} from "@paperclipai/adapter-antigravity-local/server";

// GEM-1892 — run 1d6ead3f (Giám Sát Hệ Thống, 07/11): final answer 16:52Z, then agy sat on
// "waiting up to 24h0m0s for 1 background task(s)" until it was killed 04:42Z next day
// (exit 4294967295 → finalize write failed "out of range for type integer").
const T0 = Date.parse("2026-11-07T16:52:02.711Z");
const min = 60_000;

describe("shouldReapAntigravityIdleAfterAnswer", () => {
  it("default ngưỡng = 30 phút", () => {
    expect(ANTIGRAVITY_IDLE_AFTER_ANSWER_DEFAULT_SEC).toBe(1800);
  });
  it("1d6ead3f: câu trả lời cuối + im 30 phút → cắt", () => {
    expect(
      shouldReapAntigravityIdleAfterAnswer({ lastEntryKind: "assistant", lastActivityMs: T0, nowMs: T0 + 30 * min, idleSec: 1800 }),
    ).toBe(true);
  });
  it("cùng lượt 16:10: 'đang chờ tác vụ nền' rồi chờ 2 phút → KHÔNG cắt", () => {
    expect(
      shouldReapAntigravityIdleAfterAnswer({ lastEntryKind: "assistant", lastActivityMs: T0, nowMs: T0 + 2 * min, idleSec: 1800 }),
    ).toBe(false);
  });
  it("đang chạy tool (entry cuối là tool_call/thinking) dù lâu → KHÔNG cắt", () => {
    for (const kind of ["tool_call", "thinking", "user", null]) {
      expect(
        shouldReapAntigravityIdleAfterAnswer({ lastEntryKind: kind, lastActivityMs: T0, nowMs: T0 + 5 * 60 * min, idleSec: 1800 }),
      ).toBe(false);
    }
  });
  it("idleSec = 0 → tắt watchdog", () => {
    expect(
      shouldReapAntigravityIdleAfterAnswer({ lastEntryKind: "assistant", lastActivityMs: T0, nowMs: T0 + 24 * 60 * min, idleSec: 0 }),
    ).toBe(false);
  });
});

describe("normalizeProcessExitCode", () => {
  it("taskkill /F trên Windows 4294967295 → -1 (vừa int4)", () => {
    expect(normalizeProcessExitCode(4294967295)).toBe(-1);
  });
  it("giữ nguyên mã thường và null", () => {
    expect(normalizeProcessExitCode(0)).toBe(0);
    expect(normalizeProcessExitCode(1)).toBe(1);
    expect(normalizeProcessExitCode(-1)).toBe(-1);
    expect(normalizeProcessExitCode(null)).toBeNull();
    expect(normalizeProcessExitCode(undefined)).toBeNull();
  });
});

describe("wiring (chống gỡ)", () => {
  const exec = readFileSync(
    fileURLToPath(new URL("../../../packages/adapters/antigravity-local/src/server/execute.ts", import.meta.url)),
    "utf-8",
  );
  const hb = readFileSync(fileURLToPath(new URL("../services/heartbeat.ts", import.meta.url)), "utf-8");
  it("poller gọi watchdog và cắt cây tiến trình", () => {
    expect(exec).toMatch(/reapIfIdleAfterAnswer\(\);/);
    expect(exec).toMatch(/shouldReapAntigravityIdleAfterAnswer\(/);
    expect(exec).toMatch(/terminateProcessTree\(running\.child/);
  });
  it("lượt bị cắt sau câu trả lời báo exit 0, lượt khác chuẩn hoá mã thoát", () => {
    expect(exec).toMatch(/idleReapedAfterAnswer\s*\?\s*\{ \.\.\.rawProc, exitCode: 0/);
    expect(exec).toMatch(/normalizeProcessExitCode\(rawProc\.exitCode\)/);
  });
  it("setRunStatus chuẩn hoá exitCode trước khi ghi DB", () => {
    expect(hb).toMatch(/exitCode: Math\.trunc\(patch\.exitCode\) \| 0/);
  });
});
