import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectAntigravityEmptyConversationId,
  detectAntigravityQuotaExhausted,
  detectAntigravityZeroTokenBudget,
  shouldAntigravityFallback,
} from "@paperclipai/adapter-antigravity-local/server";

// GEM-2389 — stderr nguyên văn heartbeat_runs 22ec7a2e (18/11 11:38 giờ VN), giống hệt 5 lượt khác.
const REAL_STDERR = "error: failed to start conversation: backend returned an empty conversation id\n";

describe("detectAntigravityEmptyConversationId (GEM-2389)", () => {
  it("chiều 1: nhận đúng stderr thật của lượt hỏng → thử lại", () => {
    expect(detectAntigravityEmptyConversationId({ stderr: REAL_STDERR }).emptyConversationId).toBe(true);
  });

  it("không phải hết quota → không xoay tài khoản, không đổi model", () => {
    expect(detectAntigravityQuotaExhausted({ stdout: "", stderr: REAL_STDERR }).exhausted).toBe(false);
    expect(shouldAntigravityFallback({ stderr: REAL_STDERR })).toBe(false);
  });

  it("chiều 2: lỗi khác / dòng [paperclip] tự ghi / stdout của agent → KHÔNG thử lại", () => {
    const others = [
      "error: RESOURCE_EXHAUSTED (code 429)",
      "error: agent executor error: generating and executing: serializing trajectory: maxMessageTokens must be positive, got 0",
      'warning: conversation "abc" not found',
      "error: failed to start conversation: context deadline exceeded",
      "[paperclip] agy không mở được hội thoại (failed to start conversation: backend returned an empty conversation id)",
      "",
    ];
    for (const stderr of others) {
      expect(detectAntigravityEmptyConversationId({ stderr }).emptyConversationId).toBe(false);
    }
    expect(detectAntigravityEmptyConversationId({ stderr: null }).emptyConversationId).toBe(false);
    // lỗi zero-budget vẫn do nhánh riêng của nó bắt, không lẫn
    expect(detectAntigravityZeroTokenBudget({ stderr: REAL_STDERR }).zeroBudget).toBe(false);
  });

  it("execute() chạy lại đúng 1 lần, cùng model + cùng phiên, chờ 5–15 giây, chỉ khi exit ≠ 0", () => {
    const src = readFileSync(
      resolve(__dirname, "../../..", "packages/adapters/antigravity-local/src/server/execute.ts"),
      "utf8",
    );
    const start = src.indexOf("detectAntigravityEmptyConversationId({ stderr: attempt.proc.stderr");
    expect(start).toBeGreaterThan(0);
    const before = src.slice(start - 120, start);
    expect(before).toMatch(/\(attempt\.proc\.exitCode \?\? 0\) !== 0 &&/);
    const block = src.slice(start, start + 900);
    const end = block.indexOf("// GEM-1763");
    const body = end > 0 ? block.slice(0, end) : block;
    const delay = /setTimeout\(resolve, (\d[\d_]*)\)/.exec(body);
    expect(delay).not.toBeNull();
    const ms = Number(delay![1].replace(/_/g, ""));
    expect(ms).toBeGreaterThanOrEqual(5_000);
    expect(ms).toBeLessThanOrEqual(15_000);
    expect(body.match(/attempt = await runAttempt\(conversationId, attemptModel\);/g)?.length).toBe(1);
    expect(body).not.toMatch(/rotateAntigravityAccountOnQuota|useAntigravityAccount|modelChain/);
  });
});
