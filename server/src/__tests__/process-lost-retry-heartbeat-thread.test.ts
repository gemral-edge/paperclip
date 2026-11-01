import { describe, expect, it } from "vitest";
import { shouldSkipProcessLostRetryForIssue } from "../services/heartbeat.js";

// GEM-1764: lượt timer gắn Heartbeat Thread bị Process lost phải được chạy bù dù thread đang done/cancelled.
describe("shouldSkipProcessLostRetryForIssue", () => {
  it("skips retry when a real work issue is done or cancelled", () => {
    expect(shouldSkipProcessLostRetryForIssue({ status: "done", originId: null })).toBe(true);
    expect(shouldSkipProcessLostRetryForIssue({ status: "cancelled", originId: "audit:x" })).toBe(true);
  });

  it("does not skip when the work issue is still open", () => {
    expect(shouldSkipProcessLostRetryForIssue({ status: "in_progress", originId: null })).toBe(false);
    expect(shouldSkipProcessLostRetryForIssue(null)).toBe(false);
  });

  it("never skips for evergreen Heartbeat Thread issues, whatever their status", () => {
    const originId = "heartbeat-thread:d53989f7-3eca-4497-a53d-27350ac14769";
    expect(shouldSkipProcessLostRetryForIssue({ status: "done", originId })).toBe(false);
    expect(shouldSkipProcessLostRetryForIssue({ status: "cancelled", originId })).toBe(false);
  });
});
