import { describe, expect, it } from "vitest";
import {
  computeMaxAccountRotations,
  detectAntigravityQuotaExhausted,
  detectAntigravityTransientDisconnect,
  rotateAntigravityAccountOnQuota,
} from "@paperclipai/adapter-antigravity-local/server";
import {
  QUOTA_RETRY_MAX_ATTEMPTS,
  planQuotaRetry,
  readQuotaRetryPlan,
} from "../services/quota-retry.js";

// GEM-1004 — real agy stderr seen on 16/09 (7/7 genuine quota hits).
const REAL_QUOTA_STDERR = "error: RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).";

describe("detectAntigravityQuotaExhausted", () => {
  it("flags the real agy RESOURCE_EXHAUSTED stderr line", () => {
    expect(detectAntigravityQuotaExhausted({ stdout: "", stderr: REAL_QUOTA_STDERR }).exhausted).toBe(true);
  });

  it("flags the Gemini 3.8 Flash credits wall (GEM-1178, 8 real runs 03/10 02:30-03:50)", () => {
    const stderr = "error: Your AI credits balance is too low to continue.";
    expect(detectAntigravityQuotaExhausted({ stdout: "", stderr }).exhausted).toBe(true);
    expect(planQuotaRetry({ runId: "r", issueId: null, fromTimer: true, now: new Date(), random: () => 0, errorCode: "antigravity_quota_exhausted", priorAttempts: 0 })).not.toBeNull();
  });

  it("does not flag the same words when only the agent's stdout says them", () => {
    const stdout = "Dạ chị, lỗi 'AI credits balance is too low' hôm qua đã tự hồi phục.";
    expect(detectAntigravityQuotaExhausted({ stdout, stderr: "" }).exhausted).toBe(false);
  });

  it("ignores quota / rate-limit words in the agent's own stdout prose (71/78 false positives)", () => {
    const stdout = [
      "Dạ chị, Reddit đang giãn cách đăng bài (rate limit 285 giây).",
      "| 5 | Pha 3: tuân thủ quota target caps | ✅ |",
      "- **2x Antigravity Ultra quota exhausted** (Gem Người Dùng).",
    ].join("\n");
    const stderr = "root agent idle; waiting up to 24h0m0s for 1 background task(s)";
    expect(detectAntigravityQuotaExhausted({ stdout, stderr }).exhausted).toBe(false);
  });

  it("ignores the adapter's own [paperclip] diagnostic lines on stderr", () => {
    const stderr = "[paperclip] Antigravity quota fallback note: rate limit handled upstream";
    expect(detectAntigravityQuotaExhausted({ stdout: "", stderr }).exhausted).toBe(false);
  });
});

describe("planQuotaRetry", () => {
  const now = new Date("2026-09-26T18:00:00.000Z");
  const base = { runId: "run-1", issueId: null, fromTimer: true, now, random: () => 0 };

  it("schedules a backoff retry for antigravity_quota_exhausted", () => {
    const plan = planQuotaRetry({ ...base, errorCode: "antigravity_quota_exhausted", priorAttempts: 0 });
    expect(plan).not.toBeNull();
    expect(plan!.attempt).toBe(1);
    expect(plan!.source).toBe("timer");
    expect(Date.parse(plan!.retryAt) - now.getTime()).toBe(30 * 60_000);
  });

  it("backs off further on each attempt and gives up after the cap", () => {
    const second = planQuotaRetry({ ...base, errorCode: "antigravity_quota_exhausted", priorAttempts: 1 });
    expect(Date.parse(second!.retryAt) - now.getTime()).toBe(60 * 60_000);
    const spent = planQuotaRetry({
      ...base,
      errorCode: "antigravity_quota_exhausted",
      priorAttempts: QUOTA_RETRY_MAX_ATTEMPTS,
    });
    expect(spent).toBeNull();
  });

  it("uses the provider resetsAt when given (Claude weekly cap)", () => {
    const resetsAt = "2026-09-27T02:00:00.000Z";
    const plan = planQuotaRetry({
      ...base,
      errorCode: "claude_weekly_limit",
      errorMeta: { resetsAt },
      priorAttempts: 0,
      fromTimer: false,
    });
    expect(Date.parse(plan!.retryAt)).toBe(Date.parse(resetsAt) + 2 * 60_000);
    expect(plan!.source).toBe("automation");
  });

  it("does not retry non-quota failures", () => {
    expect(planQuotaRetry({ ...base, errorCode: "adapter_failed", priorAttempts: 0 })).toBeNull();
    expect(planQuotaRetry({ ...base, errorCode: null, priorAttempts: 0 })).toBeNull();
  });

  it("round-trips through state_json and rejects malformed plans", () => {
    const plan = planQuotaRetry({ ...base, errorCode: "antigravity_quota_exhausted", priorAttempts: 0 });
    expect(readQuotaRetryPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    expect(readQuotaRetryPlan({ retryAt: "not-a-date", retryOfRunId: "x", errorCode: "y" })).toBeNull();
    expect(readQuotaRetryPlan(null)).toBeNull();
  });
});

// GEM-1017 — real agy stderr of Yinyang Caption 27/09 09:40 (slot window 09:00-10:00 lost).
const REAL_STALL_STDERR = [
  'warning: conversation "7e9a932f-bec1-44a5-924d-ab095af733f0" not found',
  "error: the connection to the agent was interrupted before the response finished: subscriber fell behind updates, stalled for 10s",
].join("\n");

describe("detectAntigravityTransientDisconnect", () => {
  it("flags the real agy stream-stall stderr", () => {
    expect(detectAntigravityTransientDisconnect({ stderr: REAL_STALL_STDERR }).transient).toBe(true);
  });

  it("does not flag quota walls, schema errors or adapter diagnostics", () => {
    for (const stderr of [
      REAL_QUOTA_STDERR,
      "error: INVALID_ARGUMENT (code 400): * GenerateContentRequest.tools[110] enum[0]: cannot be empty",
      "[paperclip] connection to the agent was interrupted (diagnostic)",
    ]) {
      expect(detectAntigravityTransientDisconnect({ stderr }).transient).toBe(false);
    }
  });
});

describe("planQuotaRetry — transient disconnect (slot-window agents)", () => {
  // 09:41 HCM = 02:41Z; Yinyang morning window closes 10:00 HCM = 03:00Z.
  const failAt = new Date("2026-09-27T02:41:00.000Z");
  const windowClose = Date.parse("2026-09-27T03:00:00.000Z");
  const base = { runId: "run-yy", issueId: null, fromTimer: true, now: failAt, random: () => 0 };

  it("retries a 09:41 failure INSIDE the 09:00-10:00 window", () => {
    const plan = planQuotaRetry({ ...base, errorCode: "antigravity_transient_disconnect", priorAttempts: 0 });
    expect(plan).not.toBeNull();
    expect(Date.parse(plan!.retryAt)).toBeLessThan(windowClose);
    expect(plan!.retryAt).toBe("2026-09-27T02:51:00.000Z");
  });

  it("stops after 2 transient attempts (stays visible instead of looping)", () => {
    expect(planQuotaRetry({ ...base, errorCode: "antigravity_transient_disconnect", priorAttempts: 1 })?.attempt).toBe(2);
    expect(planQuotaRetry({ ...base, errorCode: "antigravity_transient_disconnect", priorAttempts: 2 })).toBeNull();
  });

  it("keeps plain adapter_failed non-retryable", () => {
    expect(planQuotaRetry({ ...base, errorCode: "adapter_failed", priorAttempts: 0 })).toBeNull();
  });
});

describe("planQuotaRetry — jitter (GEM-1009 retry herd)", () => {
  const now = new Date("2026-09-26T13:00:00.000Z");
  const base = { runId: "run-j", issueId: null, fromTimer: true, now, priorAttempts: 0 };
  const delayMin = (p: ReturnType<typeof planQuotaRetry>) => (Date.parse(p!.retryAt) - now.getTime()) / 60_000;

  it("spreads quota retries over +0..20% of the base backoff, never earlier", () => {
    expect(delayMin(planQuotaRetry({ ...base, errorCode: "antigravity_quota_exhausted", random: () => 0 }))).toBe(30);
    expect(delayMin(planQuotaRetry({ ...base, errorCode: "antigravity_quota_exhausted", random: () => 0.5 }))).toBe(33);
    expect(delayMin(planQuotaRetry({ ...base, errorCode: "antigravity_quota_exhausted", random: () => 0.9999 }))).toBeLessThan(36);
  });

  it("two agents failing the same minute get different retry times", () => {
    const a = planQuotaRetry({ ...base, errorCode: "antigravity_quota_exhausted", random: () => 0.1 });
    const b = planQuotaRetry({ ...base, errorCode: "antigravity_quota_exhausted", random: () => 0.7 });
    expect(a!.retryAt).not.toBe(b!.retryAt);
  });

  it("worst-case jitter still lands a 09:41 transient retry before the 10:00 window close", () => {
    const failAt = new Date("2026-09-27T02:41:00.000Z");
    const plan = planQuotaRetry({ ...base, now: failAt, errorCode: "antigravity_transient_disconnect", random: () => 0.9999 });
    expect(Date.parse(plan!.retryAt)).toBeLessThan(Date.parse("2026-09-27T03:00:00.000Z"));
  });

  it("jitters provider resetsAt by at most 3 min after the 2 min slack", () => {
    const resetsAt = new Date(now.getTime() + 60 * 60_000).toISOString();
    const d = delayMin(planQuotaRetry({ ...base, errorCode: "claude_weekly_limit", errorMeta: { resetsAt }, random: () => 0.9999 }));
    expect(d).toBeGreaterThanOrEqual(62);
    expect(d).toBeLessThan(65);
  });
});

describe("rotateAntigravityAccountOnQuota & computeMaxAccountRotations (AGY-SW-003)", () => {
  it("caps per-run account rotations to Math.min(10, totalAccounts - 1)", () => {
    expect(computeMaxAccountRotations(0)).toBe(0);
    expect(computeMaxAccountRotations(1)).toBe(0);
    expect(computeMaxAccountRotations(2)).toBe(1);
    expect(computeMaxAccountRotations(10)).toBe(9);
    expect(computeMaxAccountRotations(15)).toBe(10);
  });

  it("rotates to the next ready Google account on 5h quota limit", async () => {
    const res = await rotateAntigravityAccountOnQuota({
      failedEmail: "acc1@gmail.com",
      stderr: REAL_QUOTA_STDERR,
      runId: "run-5h",
      runner: async (_cmd, args) => {
        expect(args).toContain("rotate-on-quota");
        expect(args).toContain("--failed-email");
        expect(args).toContain("acc1@gmail.com");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            rotated: true,
            already_rotated_by_peer: false,
            previous_email: "acc1@gmail.com",
            new_email: "acc2@gmail.com",
            label: "tk-02",
            tier: "g1-ultra-tier",
            limit_type: "5h",
            previous_cooldown_until: "2026-10-26T22:00:00Z",
            total_accounts: 10,
            ready_accounts: 9,
          }),
          stderr: "",
        };
      },
    });
    expect(res.rotated).toBe(true);
    expect(res.newEmail).toBe("acc2@gmail.com");
    expect(res.limitType).toBe("5h");
    expect(res.totalAccounts).toBe(10);
    expect(res.readyAccounts).toBe(9);
  });

  it("handles weekly quota limit and returns rotated=false when all accounts are in cooldown", async () => {
    const res = await rotateAntigravityAccountOnQuota({
      failedEmail: "acc10@gmail.com",
      stderr: "error: RESOURCE_EXHAUSTED: weekly usage limit reached",
      runId: "run-weekly",
      runner: async () => ({
        exitCode: 2,
        stdout: JSON.stringify({
          rotated: false,
          reason: "all_accounts_in_cooldown",
          previous_email: "acc10@gmail.com",
          limit_type: "weekly",
          cooldown_until: "2026-11-02T10:00:00Z",
          earliest_cooldown_until: "2026-10-26T20:00:00Z",
          total_accounts: 10,
          ready_accounts: 0,
        }),
        stderr: "",
      }),
    });
    expect(res.rotated).toBe(false);
    expect(res.exitCode).toBe(2);
    expect(res.limitType).toBe("weekly");
    expect(res.reason).toBe("all_accounts_in_cooldown");
    expect(res.earliestCooldownUntil).toBe("2026-10-26T20:00:00Z");
  });

  it("recognizes concurrent rotation already performed by a peer worker", async () => {
    const res = await rotateAntigravityAccountOnQuota({
      failedEmail: "acc1@gmail.com",
      stderr: REAL_QUOTA_STDERR,
      runner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          rotated: true,
          already_rotated_by_peer: true,
          previous_email: "acc1@gmail.com",
          new_email: "acc3@gmail.com",
          label: "tk-03",
          total_accounts: 10,
          ready_accounts: 8,
        }),
        stderr: "",
      }),
    });
    expect(res.rotated).toBe(true);
    expect(res.alreadyRotatedByPeer).toBe(true);
    expect(res.newEmail).toBe("acc3@gmail.com");
  });
});
