/**
 * GEM-1443: decide what to do with an overdue cron slot.
 *
 * The 2026-06-10 staleness guard skipped any slot overdue beyond `catchUpGraceSec`
 * so a 07:00 brief would not run at 14:00 after a long restart. But the same guard
 * also dropped slots when the server was UP the whole time and only the scheduler
 * tick was failing (DB starvation → "timer tick timed out" for 2h on 14/10): the
 * slot passed while ticks failed, then the first successful tick saw it as stale.
 *
 * Rule: a slot that fell while THIS process was running was missed by us (failing
 * ticks, tick time budget, hourly fleet cap) → fire it, flagged late so the agent can
 * judge its own time window. Only slots that passed before the process started
 * (server down / restart) keep the old grace rule.
 *
 * Why process start and not "last successful tick": a fire deferred by the tick
 * budget or the fleet cap is re-evaluated on a LATER tick, after a successful tick
 * has already moved that marker past the slot — it would then be dropped as stale.
 */
export type CronCatchUpDecision = "fire" | "fire_late" | "skip_stale";

export function classifyCronCatchUp(input: {
  nextMs: number;
  nowMs: number;
  graceMs: number;
  /** when the scheduler process started (slots before it passed while the server was down) */
  processStartMs: number;
}): CronCatchUpDecision {
  const { nextMs, nowMs, graceMs, processStartMs } = input;
  const lateMs = nowMs - nextMs;
  if (graceMs <= 0 || lateMs <= graceMs) return "fire";
  if (nextMs >= processStartMs) return "fire_late";
  return "skip_stale";
}

/**
 * GEM-1443: wall-clock budget for the enqueue loop of one tick. The 2s stagger between
 * enqueues (Gemini burst guard) made a tick with N due agents last 2·(N-1)s on top of
 * DB time — after an outage ~18 agents are due at once → 34s+ and the 60s job timeout
 * fired. Stop enqueuing once the budget is spent; the rest stay due (baseline untouched)
 * and are picked up by the next tick 30s later.
 */
export const TIMER_TICK_ENQUEUE_BUDGET_MS = 6_000;

export function shouldDeferForTickBudget(input: {
  enqueuedInThisTick: number;
  loopStartedAtMs: number;
  nowMs: number;
  budgetMs?: number;
}): boolean {
  const budget = input.budgetMs ?? TIMER_TICK_ENQUEUE_BUDGET_MS;
  // Always allow the first enqueue so a slow DB can never starve the loop entirely.
  if (input.enqueuedInThisTick === 0) return false;
  return input.nowMs - input.loopStartedAtMs >= budget;
}
