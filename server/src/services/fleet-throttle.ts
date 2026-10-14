/**
 * Company-wide (fleet) heartbeat throttle — GEMRAL 2026-10-05.
 *
 * Why: per-agent `maxConcurrentRuns` does not bound the whole fleet; ~8 local agent
 * CLIs running at once exhausted RAM on the single host. Three company-wide rules:
 *
 *  1. At most `maxRunning` runs in status `running` at once. Extra runs stay `queued`
 *     and start when a slot frees (never cancelled).
 *  2. At most `startsPerWindow` runs may START per wall-clock window of `startWindowMs`
 *     (default 10 min: hh:00, hh:10, ...). Extra runs wait for the next window.
 *  3. At most `timerWakesPerHour` wakes with invocationSource = "timer" per wall-clock
 *     hour. Over-cap timer wakes are NOT queued: the tick skips them and re-evaluates
 *     later. Fair pick: agent whose last finished run is oldest goes first.
 *     Assignment / on_demand / automation wakes are exempt from rule 3 (not from 1–2).
 *  4. Timer priority (GEM-1413): a queued timer run (scheduled posting slot) is claimed
 *     before a backlog of automation/retry runs. Agents with a queued timer run are
 *     drained first, and a non-timer claim is held while it would take the last free
 *     slot that a claimable queued timer run is waiting for. Rule 3 caps timer wakes,
 *     so automation cannot be starved for long.
 *     Plus a reserved slot: non-timer runs may occupy at most
 *     `maxRunning - timerReservedSlots` running slots, so a multi-hour engineering run
 *     can never leave a scheduled posting slot waiting (measured 14/10: 8/12 late timer
 *     runs sat behind a long non-timer run that started before them).
 *
 * Config (single place, read at call time so ops can change env + restart):
 *   PAPERCLIP_FLEET_MAX_RUNNING            default 2   (<=0 disables rule 1)
 *   PAPERCLIP_FLEET_STARTS_PER_10MIN       default 2   (<=0 disables rule 2)
 *   PAPERCLIP_FLEET_TIMER_WAKES_PER_HOUR   default 3   (<=0 disables rule 3)
 *   PAPERCLIP_FLEET_TIMER_EXEMPT_AGENTS    default ""  (comma list of agent id or name;
 *                                                     exempt from rule 3 only)
 *   PAPERCLIP_FLEET_TIMER_PRIORITY         default 1   (<=0 disables rule 4)
 *   PAPERCLIP_FLEET_TIMER_RESERVED_SLOTS   default 1   (<=0 disables the reserved slot;
 *                                                     ignored unless maxRunning > it)
 */

export const FLEET_MAX_RUNNING_DEFAULT = 2;
export const FLEET_STARTS_PER_WINDOW_DEFAULT = 2;
export const FLEET_START_WINDOW_MS = 10 * 60 * 1000;
export const FLEET_TIMER_WAKES_PER_HOUR_DEFAULT = 3;
export const FLEET_TIMER_RESERVED_SLOTS_DEFAULT = 1;
export const FLEET_TIMER_WINDOW_MS = 60 * 60 * 1000;
/** Windows are aligned to Asia/Ho_Chi_Minh wall clock (UTC+7, no DST). */
export const FLEET_TZ_OFFSET_MS = 7 * 60 * 60 * 1000;

export interface FleetThrottleConfig {
  maxRunning: number;
  startsPerWindow: number;
  startWindowMs: number;
  timerWakesPerHour: number;
  timerWindowMs: number;
  timerExemptAgents: Set<string>;
  timerPriority: boolean;
  timerReservedSlots: number;
}

function readIntEnv(env: NodeJS.ProcessEnv, key: string, fallback: number) {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Math.floor(Number(raw));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function readFleetThrottleConfig(env: NodeJS.ProcessEnv = process.env): FleetThrottleConfig {
  const exempt = (env.PAPERCLIP_FLEET_TIMER_EXEMPT_AGENTS ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return {
    maxRunning: readIntEnv(env, "PAPERCLIP_FLEET_MAX_RUNNING", FLEET_MAX_RUNNING_DEFAULT),
    startsPerWindow: readIntEnv(env, "PAPERCLIP_FLEET_STARTS_PER_10MIN", FLEET_STARTS_PER_WINDOW_DEFAULT),
    startWindowMs: FLEET_START_WINDOW_MS,
    timerWakesPerHour: readIntEnv(env, "PAPERCLIP_FLEET_TIMER_WAKES_PER_HOUR", FLEET_TIMER_WAKES_PER_HOUR_DEFAULT),
    timerWindowMs: FLEET_TIMER_WINDOW_MS,
    timerExemptAgents: new Set(exempt),
    timerPriority: readIntEnv(env, "PAPERCLIP_FLEET_TIMER_PRIORITY", 1) > 0,
    timerReservedSlots: Math.max(
      0,
      readIntEnv(env, "PAPERCLIP_FLEET_TIMER_RESERVED_SLOTS", FLEET_TIMER_RESERVED_SLOTS_DEFAULT),
    ),
  };
}

export function isFleetClaimGateEnabled(config: FleetThrottleConfig) {
  return config.maxRunning > 0 || config.startsPerWindow > 0;
}

export function isTimerExempt(config: FleetThrottleConfig, agent: { id: string; name?: string | null }) {
  if (config.timerExemptAgents.size === 0) return false;
  return (
    config.timerExemptAgents.has(agent.id.toLowerCase()) ||
    (agent.name ? config.timerExemptAgents.has(agent.name.trim().toLowerCase()) : false)
  );
}

/** Start of the wall-clock window (aligned to UTC+7) that contains `now`. */
export function fleetWindowStart(now: Date, windowMs: number, tzOffsetMs = FLEET_TZ_OFFSET_MS) {
  const local = now.getTime() + tzOffsetMs;
  return new Date(Math.floor(local / windowMs) * windowMs - tzOffsetMs);
}

export type FleetClaimVerdict =
  | { ok: true }
  | {
      ok: false;
      reason: "max_running" | "start_window" | "timer_priority" | "timer_reserved";
      running: number;
      startsInWindow: number;
      pendingTimerRuns?: number;
    };

export function evaluateFleetClaim(
  config: FleetThrottleConfig,
  counts: { running: number; startsInWindow: number; runningNonTimer?: number },
  claim?: { invocationSource: string | null | undefined; pendingTimerRuns: number },
): FleetClaimVerdict {
  if (config.maxRunning > 0 && counts.running >= config.maxRunning) {
    return { ok: false, reason: "max_running", ...counts };
  }
  if (config.startsPerWindow > 0 && counts.startsInWindow >= config.startsPerWindow) {
    return { ok: false, reason: "start_window", ...counts };
  }
  // Rule 4 reserved slot: non-timer runs never fill the last `timerReservedSlots` slots.
  if (
    claim &&
    claim.invocationSource !== "timer" &&
    config.timerReservedSlots > 0 &&
    config.maxRunning > config.timerReservedSlots &&
    (counts.runningNonTimer ?? 0) >= config.maxRunning - config.timerReservedSlots
  ) {
    return { ok: false, reason: "timer_reserved", ...counts };
  }
  // Rule 4: keep the free slots for claimable queued timer runs.
  if (config.timerPriority && claim && claim.invocationSource !== "timer" && claim.pendingTimerRuns > 0) {
    const free = Math.min(
      config.maxRunning > 0 ? config.maxRunning - counts.running : Infinity,
      config.startsPerWindow > 0 ? config.startsPerWindow - counts.startsInWindow : Infinity,
    );
    if (claim.pendingTimerRuns >= free) {
      return { ok: false, reason: "timer_priority", ...counts, pendingTimerRuns: claim.pendingTimerRuns };
    }
  }
  return { ok: true };
}

/** Claim order for queued runs: timer runs first (rule 4), then oldest first. */
export function orderQueuedRunsForClaim<T extends { invocationSource: string | null; createdAt: Date }>(
  config: FleetThrottleConfig,
  runs: T[],
): T[] {
  const rank = (run: T) => (config.timerPriority && run.invocationSource === "timer" ? 0 : 1);
  return runs
    .map((run, index) => ({ run, index }))
    .sort((a, b) =>
      rank(a.run) - rank(b.run) ||
      a.run.createdAt.getTime() - b.run.createdAt.getTime() ||
      a.index - b.index,
    )
    .map((entry) => entry.run);
}

/**
 * Fair order for over-subscribed timer wakes: agent whose last finished run is the
 * oldest (never-finished first) goes first; ties keep input order.
 */
export function orderTimerCandidatesFairly<T>(
  candidates: T[],
  lastFinishedAt: (candidate: T) => Date | null | undefined,
): T[] {
  return candidates
    .map((candidate, index) => ({ candidate, index, at: lastFinishedAt(candidate)?.getTime() ?? -Infinity }))
    .sort((a, b) => (a.at === b.at ? a.index - b.index : a.at - b.at))
    .map((entry) => entry.candidate);
}

/** In-process serialization per key (single server process); DB advisory lock covers the rest. */
const keyedLocks = new Map<string, Promise<void>>();
export const KEYED_LOCK_WAIT_TIMEOUT_MS = 20_000;

export async function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = keyedLocks.get(key) ?? Promise.resolve();
  // GEM-1368: Chống kẹt in-memory lock chain khi previous promise bị treo > 20s.
  const waitPrevious = Promise.race([
    previous,
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, KEYED_LOCK_WAIT_TIMEOUT_MS);
      t.unref?.();
    }),
  ]);
  const run = waitPrevious.then(fn);
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  keyedLocks.set(key, marker);
  try {
    return await run;
  } finally {
    if (keyedLocks.get(key) === marker) keyedLocks.delete(key);
  }
}
