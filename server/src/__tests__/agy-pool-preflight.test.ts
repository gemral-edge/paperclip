import { describe, expect, it } from "vitest";
import {
  checkAntigravityPoolPreflight,
  type AntigravityPoolAccount,
} from "@paperclipai/adapter-antigravity-local/server";
import { planQuotaRetry } from "../services/quota-retry.js";

// GEM-1594 — pre-flight: pool agy hết sạch quota thì không spawn agy (chỉ NGỪNG gọi, không đổi model/provider).
const NOW = new Date("2026-11-06T06:00:00Z");
const cooldown = (email: string, plan: string, until: string): AntigravityPoolAccount => ({
  email,
  plan,
  status: "cooldown",
  cooldownUntil: until,
});

describe("GEM-1594 checkAntigravityPoolPreflight", () => {
  it("chặn khi MỌI tài khoản đang hồi quota, trả giờ hồi sớm nhất", () => {
    const r = checkAntigravityPoolPreflight(
      [
        cooldown("u1@x.com", "ultra", "2026-11-06T09:00:00Z"),
        cooldown("u2@x.com", "ultra", "2026-11-06T07:30:00Z"),
        cooldown("p1@x.com", "pro", "2026-11-13T00:00:00Z"),
      ],
      NOW,
    );
    expect(r).toEqual({
      blocked: true,
      totalAccounts: 3,
      readyAccounts: 0,
      earliestCooldownUntil: "2026-11-06T07:30:00.000Z",
    });
  });

  it("KHÔNG chặn khi còn ≥1 tài khoản sẵn sàng (vòng xoay giữ nguyên model tự lo)", () => {
    const r = checkAntigravityPoolPreflight(
      [
        cooldown("u1@x.com", "ultra", "2026-11-06T09:00:00Z"),
        { email: "p1@x.com", plan: "pro", status: "ready", cooldownUntil: null },
      ],
      NOW,
    );
    expect(r.blocked).toBe(false);
    expect(r.readyAccounts).toBe(1);
  });

  it("giờ hồi đã qua = tài khoản sẵn sàng lại → không chặn", () => {
    const r = checkAntigravityPoolPreflight([cooldown("u1@x.com", "ultra", "2026-11-06T05:59:00Z")], NOW);
    expect(r.blocked).toBe(false);
  });

  it("pool rỗng / không có giờ hồi → không chặn (không biết thì để agy tự báo lỗi thật)", () => {
    expect(checkAntigravityPoolPreflight([], NOW).blocked).toBe(false);
    expect(
      checkAntigravityPoolPreflight(
        [{ email: "d@x.com", plan: "pro", status: "disabled", cooldownUntil: null }],
        NOW,
      ).blocked,
    ).toBe(false);
  });

  it("kết quả chặn đi đúng đường quota-retry: hẹn chạy lại lúc pool hồi, không phải lỗi agent", () => {
    const pre = checkAntigravityPoolPreflight([cooldown("u1@x.com", "ultra", "2026-11-06T07:30:00Z")], NOW);
    const plan = planQuotaRetry({
      errorCode: "antigravity_quota_exhausted",
      errorMeta: { resetsAt: pre.earliestCooldownUntil, preflight: true },
      priorAttempts: 0,
      runId: "run-1",
      issueId: null,
      fromTimer: true,
      now: NOW,
    });
    expect(plan).not.toBeNull();
    expect(Date.parse(plan!.retryAt)).toBeGreaterThanOrEqual(Date.parse("2026-11-06T07:30:00Z"));
  });
});
