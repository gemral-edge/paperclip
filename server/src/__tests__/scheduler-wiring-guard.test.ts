import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// GEM-1443: the helpers are unit-tested, but a refactor of tickTimers / startServer could
// silently stop calling them (old behaviour: cron slots missed during a tick outage were
// dropped as stale, nobody was told). These checks fail if the wiring disappears.
const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

describe("scheduler wiring guard (GEM-1443)", () => {
  it("tickTimers decides overdue cron slots with classifyCronCatchUp, not a bare grace check", () => {
    const hb = src("services/heartbeat.ts");
    expect(hb).toMatch(/classifyCronCatchUp\(\{/);
    expect(hb).toMatch(/processStartMs:\s*SCHEDULER_PROCESS_STARTED_AT_MS/);
    expect(hb).toMatch(/decision === "skip_stale"/);
    expect(hb).not.toMatch(/if \(graceMs > 0 && lateMs > graceMs\)/);
  });

  it("tickTimers returns durationMs + phases and stale-skip count for the alert", () => {
    const hb = src("services/heartbeat.ts");
    expect(hb).toMatch(/staleSkipped:\s*staleResyncIds\.length/);
    expect(hb).toMatch(/durationMs,\s*\r?\n\s*phases,/);
  });

  it("startServer feeds tick timeouts and stale skips into the scheduler health alert", () => {
    const idx = src("index.ts");
    expect(idx).toMatch(/createSchedulerHealthAlerts\(/);
    expect(idx).toMatch(/schedulerAlerts\.recordStaleSkip\(/);
    expect(idx).toMatch(/schedulerAlerts\.recordTickTimeout\(\)/);
    expect(idx).toMatch(/"heartbeat timer tick slow"/);
  });

  it("GEM-1500: tickTimers and startServer wire per-agent hash jitter (including first post-restart tick) and tick job stagger", () => {
    const hb = src("services/heartbeat.ts");
    expect(hb).toMatch(/computeJitteredDueAtMs\(\{/);
    expect(hb).toMatch(/heartbeatJitterMs:\s*computeAgentHeartbeatJitterMs\(/);
    const idx = src("index.ts");
    expect(idx).toMatch(/computeSchedulerInitialTickDelayMs\(/);
    expect(idx).toMatch(/SCHEDULER_TICK_JOB_STAGGER_MS/);
  });
});
