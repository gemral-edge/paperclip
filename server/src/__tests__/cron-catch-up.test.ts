import { describe, expect, it } from "vitest";
import { classifyCronCatchUp, shouldDeferForTickBudget } from "../services/cron-catch-up.ts";

const H = 3_600_000;
const GRACE = H;

describe("classifyCronCatchUp (GEM-1443)", () => {
  it("fires on time when within grace", () => {
    expect(classifyCronCatchUp({ nextMs: 0, nowMs: 30_000, graceMs: GRACE, processStartMs: 0 })).toBe("fire");
  });

  it("long restart: slot before process start, overdue beyond grace → still skipped", () => {
    // slot 07:00, server down until 12:00, first tick 12:00:30
    const next = 7 * H;
    const processStart = 12 * H;
    expect(
      classifyCronCatchUp({ nextMs: next, nowMs: processStart + 30_000, graceMs: GRACE, processStartMs: processStart }),
    ).toBe("skip_stale");
  });

  it("ticks blocked 70 minutes while server up → slot still fires (late when beyond grace)", () => {
    const processStart = 2 * H;
    // last good tick 10:43, slot 11:00, ticks fail until 11:53 → 53 min late, within grace
    expect(
      classifyCronCatchUp({ nextMs: 11 * H, nowMs: 11 * H + 53 * 60_000, graceMs: GRACE, processStartMs: processStart }),
    ).toBe("fire");
    // slot 10:50, ticks fail until 12:00 (70 min outage, late 70 min > grace) → fire_late, not dropped
    expect(
      classifyCronCatchUp({ nextMs: 10 * H + 50 * 60_000, nowMs: 12 * H, graceMs: GRACE, processStartMs: processStart }),
    ).toBe("fire_late");
  });

  it("fire deferred by fleet cap / tick budget past grace while server up → fire_late", () => {
    expect(
      classifyCronCatchUp({ nextMs: 9 * H, nowMs: 10.5 * H, graceMs: GRACE, processStartMs: 1 * H }),
    ).toBe("fire_late");
  });

  it("grace 0 disables the guard", () => {
    expect(classifyCronCatchUp({ nextMs: 0, nowMs: 10 * H, graceMs: 0, processStartMs: 5 * H })).toBe("fire");
  });
});

describe("shouldDeferForTickBudget (GEM-1443)", () => {
  it("never defers the first enqueue, even when the budget is already spent", () => {
    expect(shouldDeferForTickBudget({ enqueuedInThisTick: 0, loopStartedAtMs: 0, nowMs: 60_000 })).toBe(false);
  });

  it("defers once the budget is spent", () => {
    expect(shouldDeferForTickBudget({ enqueuedInThisTick: 3, loopStartedAtMs: 0, nowMs: 6_000, budgetMs: 6_000 })).toBe(true);
  });

  it("keeps enqueuing within the budget", () => {
    expect(shouldDeferForTickBudget({ enqueuedInThisTick: 2, loopStartedAtMs: 0, nowMs: 4_100, budgetMs: 6_000 })).toBe(false);
  });
});
