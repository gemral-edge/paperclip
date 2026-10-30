import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectAntigravityQuotaExhausted,
  detectAntigravityZeroTokenBudget,
  shouldAntigravityFallback,
} from "@paperclipai/adapter-antigravity-local/server";

// GEM-1741 — stderr nguyên văn run ab3de379 (Profile Jennie Caption, 30/10 20:00).
const REAL_STDERR =
  'error: agent executor error: generating and executing: serializing trajectory: maxMessageTokens must be positive, got 0\n' +
  'AGY_ERROR: {"short_error":"agent executor error: generating and executing: serializing trajectory: maxMessageTokens must be positive, got 0","status":"UNKNOWN","error_code":2,"code_kind":"grpc","retryable":false,"error_id":"2beb700f-90f5-4350-9aa3-8a5baa0b9bd9-176"}\n';

describe("detectAntigravityZeroTokenBudget (GEM-1741)", () => {
  it("nhận đúng stderr thật của lượt hỏng", () => {
    expect(detectAntigravityZeroTokenBudget({ stderr: REAL_STDERR }).zeroBudget).toBe(true);
  });

  it("không phải hết quota → không xoay tài khoản, không đổi model", () => {
    expect(detectAntigravityQuotaExhausted({ stdout: "", stderr: REAL_STDERR }).exhausted).toBe(false);
    expect(shouldAntigravityFallback({ stderr: REAL_STDERR })).toBe(false);
  });

  it("bỏ qua dòng [paperclip] tự ghi và stderr bình thường", () => {
    expect(
      detectAntigravityZeroTokenBudget({
        stderr: "[paperclip] agy hỏng trước khi bắt đầu (serializing trajectory: maxMessageTokens must be positive, got 0)\n",
      }).zeroBudget,
    ).toBe(false);
    expect(detectAntigravityZeroTokenBudget({ stderr: "error: RESOURCE_EXHAUSTED (code 429)" }).zeroBudget).toBe(false);
    expect(detectAntigravityZeroTokenBudget({ stderr: "" }).zeroBudget).toBe(false);
  });

  it("execute() chạy lại 1 lần cùng model + cùng phiên khi gặp lỗi này", () => {
    const src = readFileSync(
      resolve(__dirname, "../../..", "packages/adapters/antigravity-local/src/server/execute.ts"),
      "utf8",
    );
    const block = src.slice(src.indexOf("detectAntigravityZeroTokenBudget({ stderr: attempt.proc.stderr"));
    expect(block.length).toBeGreaterThan(0);
    expect(block.slice(0, 700)).toMatch(/attempt = await runAttempt\(conversationId, attemptModel\);/);
  });
});
