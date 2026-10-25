import { describe, expect, it } from "vitest";
import { hasHeartbeatSchedule, isFleetPausable } from "../services/fleet-pause.js";

describe("fleet pause eligibility", () => {
  it("counts cron or interval schedules, skips disabled/unscheduled", () => {
    expect(hasHeartbeatSchedule({ heartbeat: { cronExpression: "0 9 * * *" } })).toBe(true);
    expect(hasHeartbeatSchedule({ heartbeat: { intervalSec: 3600 } })).toBe(true);
    expect(hasHeartbeatSchedule({ heartbeat: { enabled: false, intervalSec: 3600 } })).toBe(false);
    expect(hasHeartbeatSchedule({ heartbeat: {} })).toBe(false);
    expect(hasHeartbeatSchedule(null)).toBe(false);
  });

  it("never pauses already-paused, terminated or pending agents", () => {
    const scheduled = { heartbeat: { intervalSec: 600 } };
    expect(isFleetPausable({ status: "idle", runtimeConfig: scheduled })).toBe(true);
    expect(isFleetPausable({ status: "running", runtimeConfig: scheduled })).toBe(true);
    expect(isFleetPausable({ status: "paused", runtimeConfig: scheduled })).toBe(false);
    expect(isFleetPausable({ status: "terminated", runtimeConfig: scheduled })).toBe(false);
    expect(isFleetPausable({ status: "pending_approval", runtimeConfig: scheduled })).toBe(false);
  });
});
