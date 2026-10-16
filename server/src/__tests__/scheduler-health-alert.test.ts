import { describe, expect, it } from "vitest";
import {
  ALERT_COOLDOWN_MS,
  RESTART_QUIET_MS,
  createSchedulerHealthAlerts,
} from "../services/scheduler-health-alert.ts";

function setup(processStartMs = 0) {
  let t = processStartMs;
  const sent: string[] = [];
  const alerts = createSchedulerHealthAlerts({
    processStartMs,
    now: () => t,
    send: async (text) => {
      sent.push(text);
    },
  });
  return { alerts, sent, advance: (ms: number) => (t += ms) };
}

describe("scheduler health alerts (GEM-1443)", () => {
  it("2 timeouts in 30 min → no alert; 3rd → alert", () => {
    const { alerts, sent, advance } = setup();
    expect(alerts.recordTickTimeout()).toBe(false);
    advance(60_000);
    expect(alerts.recordTickTimeout()).toBe(false);
    advance(60_000);
    expect(alerts.recordTickTimeout()).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("timeouts spread over > 30 min do not alert", () => {
    const { alerts, sent, advance } = setup();
    alerts.recordTickTimeout();
    advance(20 * 60_000);
    alerts.recordTickTimeout();
    advance(20 * 60_000);
    alerts.recordTickTimeout();
    expect(sent).toHaveLength(0);
  });

  it("a long outage sends one message per cooldown", () => {
    const { alerts, sent, advance } = setup();
    for (let i = 0; i < 20; i++) {
      alerts.recordTickTimeout();
      advance(60_000);
    }
    expect(sent).toHaveLength(1);
    advance(ALERT_COOLDOWN_MS);
    alerts.recordTickTimeout();
    alerts.recordTickTimeout();
    alerts.recordTickTimeout();
    expect(sent).toHaveLength(2);
  });

  it("stale skip right after restart is expected → no alert", () => {
    const { alerts, sent, advance } = setup(1_000_000);
    advance(30_000);
    expect(alerts.recordStaleSkip(3)).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("stale skip long after start → alert", () => {
    const { alerts, sent, advance } = setup(1_000_000);
    advance(RESTART_QUIET_MS + 1);
    expect(alerts.recordStaleSkip(2)).toBe(true);
    expect(alerts.recordStaleSkip(0)).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it("send failure never throws into the scheduler", () => {
    const alerts = createSchedulerHealthAlerts({
      processStartMs: 0,
      now: () => RESTART_QUIET_MS * 2,
      send: async () => {
        throw new Error("boom");
      },
    });
    expect(() => alerts.recordStaleSkip(1)).not.toThrow();
  });
});
