import { describe, expect, it } from "vitest";
import {
  checkAntigravityPoolPreflight,
  detectAntigravityAccountDisabled,
  detectAntigravityAuthRequired,
  findReadyAntigravityAccountByPlan,
  shouldAntigravityFallback,
  type AntigravityPoolAccount,
} from "@paperclipai/adapter-antigravity-local/server";

// GEM-2265 — stderr nguyên văn 44 lượt hỏng 15/11 08:56→13:05 (tài khoản jesspham9378@, 14 agent).
const REAL_STDERR =
  "error: This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product.\n";
const NOW = new Date("2026-11-15T06:00:00Z");

describe("GEM-2265 tài khoản Antigravity bị Google khoá (Terms of Service)", () => {
  it("nhận ra lỗi khoá tài khoản từ stderr thật", () => {
    const r = detectAntigravityAccountDisabled({ stderr: REAL_STDERR });
    expect(r.disabled).toBe(true);
    expect(r.line).toContain("Terms of Service");
  });

  it("không nhầm với hết quota / đăng nhập / dòng [paperclip] của chính adapter", () => {
    expect(
      detectAntigravityAccountDisabled({ stderr: "error: RESOURCE_EXHAUSTED (code 429): Resource has been exhausted\n" }).disabled,
    ).toBe(false);
    expect(
      detectAntigravityAccountDisabled({ stderr: "[paperclip] Tài khoản bị khoá (violation of Terms of Service)\n" }).disabled,
    ).toBe(false);
    expect(detectAntigravityAuthRequired({ stdout: "", stderr: REAL_STDERR }).requiresAuth).toBe(false);
  });

  it("lỗi khoá KHÔNG kích hoạt vòng xoay tài khoản, kể cả khi stderr có thêm chữ quota", () => {
    expect(shouldAntigravityFallback({ stderr: REAL_STDERR })).toBe(false);
    expect(shouldAntigravityFallback({ stderr: `${REAL_STDERR}warn: quota check skipped\n` })).toBe(false);
  });

  it("tài khoản banned không bao giờ được chọn làm tài khoản ULTRA sẵn sàng", () => {
    const pool: AntigravityPoolAccount[] = [
      { email: "banned@x.com", plan: "ultra", status: "banned", cooldownUntil: null },
      { email: "pro@x.com", plan: "pro", status: "ready", cooldownUntil: null },
    ];
    expect(findReadyAntigravityAccountByPlan("ultra", { accounts: pool, now: NOW }).email).toBeNull();
    const ok: AntigravityPoolAccount[] = [
      ...pool,
      { email: "ultra2@x.com", plan: "ultra", status: "ready", cooldownUntil: null },
    ];
    expect(findReadyAntigravityAccountByPlan("ultra", { accounts: ok, now: NOW }).email).toBe("ultra2@x.com");
  });

  it("preflight không đếm tài khoản banned là sẵn sàng", () => {
    const r = checkAntigravityPoolPreflight(
      [
        { email: "banned@x.com", plan: "ultra", status: "banned", cooldownUntil: null },
        { email: "u1@x.com", plan: "ultra", status: "cooldown", cooldownUntil: "2026-11-15T09:00:00Z" },
      ],
      NOW,
    );
    expect(r.readyAccounts).toBe(0);
    expect(r.blocked).toBe(true);
  });
});
