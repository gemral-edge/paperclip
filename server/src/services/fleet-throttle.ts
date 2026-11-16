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
 *  5. Fair order (GEM-1996): a non-timer claim yields free slots to OLDER claimable
 *     non-timer runs of OTHER agents. Without it, an agent finishing a run drained its
 *     own next queued run into the freed slot (startNextQueuedRunForAgent) ahead of
 *     runs that had waited for hours — measured 11/11: an on_demand run waited 230 min
 *     while 2 engineering agents ran back-to-back chains. "Claimable" = agent invokable
 *     and not already running, so a busy agent's backlog never blocks the fleet; the
 *     30 s recovery tick (oldest first) then claims the older run.
 *
 * Config (single place, read at call time so ops can change env + restart):
 *   PAPERCLIP_FLEET_MAX_RUNNING            default 4   (<=0 disables rule 1; 3→4 GEM-1996 16/11:
 *                                                     24h đo 388′ đủ 3 chỗ + 194′ chỗ timer bỏ trống)
 *   PAPERCLIP_FLEET_MIN_FREE_MEM_MB        default 2048 (<=0 disables; rule 1b memory guard)
 *   PAPERCLIP_FLEET_STARTS_PER_10MIN       default 2   (<=0 disables rule 2)
 *   PAPERCLIP_FLEET_TIMER_WAKES_PER_HOUR   default 3   (<=0 disables rule 3)
 *   PAPERCLIP_FLEET_TIMER_EXEMPT_AGENTS    default ""  (comma list of agent id or name;
 *                                                     exempt from rule 3 only)
 *   PAPERCLIP_FLEET_TIMER_PRIORITY         default 1   (<=0 disables rule 4)
 *   PAPERCLIP_FLEET_TIMER_RESERVED_SLOTS   default 1   (<=0 disables the reserved slot;
 *                                                     ignored unless maxRunning > it)
 *   PAPERCLIP_HEARTBEAT_JITTER_MAX_SEC     default 30  (<=0 disables per-agent hash jitter, GEM-1500)
 *   PAPERCLIP_FLEET_FAIR_ORDER             default 1   (<=0 disables rule 5)
 *   PAPERCLIP_FLEET_FAIR_WAIT_MAX_MIN      default 60  (<=0 disables starvation ceiling override, GEM-2211)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const FLEET_MAX_RUNNING_DEFAULT = 4;
/** GEM-1996 rule 1b: no new run starts while the host has less free RAM than this (MB). */
export const FLEET_MIN_FREE_MEM_MB_DEFAULT = 2048;
export const FLEET_STARTS_PER_WINDOW_DEFAULT = 2;
export const FLEET_START_WINDOW_MS = 10 * 60 * 1000;
export const FLEET_TIMER_WAKES_PER_HOUR_DEFAULT = 3;
export const FLEET_TIMER_RESERVED_SLOTS_DEFAULT = 1;
export const FLEET_TIMER_WINDOW_MS = 60 * 60 * 1000;
export const FLEET_HEARTBEAT_JITTER_MAX_SEC_DEFAULT = 30;
/** GEM-2211: trần chờ tối đa (phút) cho lượt non-timer khi agent đích rảnh trước khi được ưu tiên chống đói. */
export const FLEET_FAIR_WAIT_MAX_MIN_DEFAULT = 60;
export const FLEET_POST_RESTART_JITTER_WINDOW_MS = 60 * 60 * 1000;
/** Stagger offsets (ms) between the 4 scheduler tick jobs inside each interval so they do not hit PgBouncer on the same millisecond. */
export const SCHEDULER_TICK_JOB_STAGGER_MS: Readonly<
  Record<"timers" | "wakeups" | "routines" | "recovery", number>
> = {
  timers: 0,
  wakeups: 2_500,
  routines: 5_000,
  recovery: 7_500,
};
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
  heartbeatJitterMaxSec: number;
  fairOrder: boolean;
  fairWaitMaxMin: number;
  minFreeMemMb: number;
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
    heartbeatJitterMaxSec: Math.max(
      0,
      readIntEnv(env, "PAPERCLIP_HEARTBEAT_JITTER_MAX_SEC", FLEET_HEARTBEAT_JITTER_MAX_SEC_DEFAULT),
    ),
    fairOrder: readIntEnv(env, "PAPERCLIP_FLEET_FAIR_ORDER", 1) > 0,
    fairWaitMaxMin: Math.max(
      0,
      readIntEnv(env, "PAPERCLIP_FLEET_FAIR_WAIT_MAX_MIN", FLEET_FAIR_WAIT_MAX_MIN_DEFAULT),
    ),
    minFreeMemMb: Math.max(0, readIntEnv(env, "PAPERCLIP_FLEET_MIN_FREE_MEM_MB", FLEET_MIN_FREE_MEM_MB_DEFAULT)),
  };
}

/**
 * GEM-1500: Deterministic per-agent heartbeat jitter in seconds (`0 .. maxJitterSec - 1`).
 * Uses FNV-1a 32-bit hash of the normalized agent ID so each agent keeps a stable phase
 * offset across restarts while spreading fleet wakeups across a 30s window.
 */
export function computeAgentHeartbeatJitterSec(
  agentId: string,
  maxJitterSec: number = FLEET_HEARTBEAT_JITTER_MAX_SEC_DEFAULT,
): number {
  const cap = Math.floor(maxJitterSec);
  if (!agentId || !Number.isFinite(cap) || cap <= 0) return 0;
  const normalized = agentId.trim().toLowerCase();
  if (!normalized) return 0;
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % cap;
}

export function computeAgentHeartbeatJitterMs(
  agentId: string,
  maxJitterSec: number = FLEET_HEARTBEAT_JITTER_MAX_SEC_DEFAULT,
): number {
  return computeAgentHeartbeatJitterSec(agentId, maxJitterSec) * 1000;
}

/**
 * GEM-1500: Compute the effective due timestamp (ms) for an agent's schedule slot,
 * applying deterministic per-agent hash jitter (`hash(agent_id) % maxJitterSec` seconds)
 * on BOTH recurring ticks AND the first tick after a server restart.
 *
 * When PM2/watchdog restarts the server at `processStartMs`, any slot `baseDueAtMs` that
 * fell shortly before `processStartMs` (within `postRestartWindowMs`, default 1h) would
 * otherwise already satisfy `now >= baseDueAtMs + jitterMs` on the very first tick for
 * every agent, causing a post-restart thundering herd. Anchoring recent pre-boot slots
 * to `Math.max(baseDueAtMs + jitterMs, processStartMs + jitterMs)` preserves each agent's
 * deterministic `0..29s` offset on the first tick after restart as well.
 */
export function computeJitteredDueAtMs(input: {
  baseDueAtMs: number;
  agentId: string;
  maxJitterSec?: number;
  processStartMs?: number;
  postRestartWindowMs?: number;
}): number {
  const jitterMs = computeAgentHeartbeatJitterMs(
    input.agentId,
    input.maxJitterSec ?? FLEET_HEARTBEAT_JITTER_MAX_SEC_DEFAULT,
  );
  const scheduledDueAtMs = input.baseDueAtMs + jitterMs;
  if (
    typeof input.processStartMs === "number" &&
    Number.isFinite(input.processStartMs) &&
    input.baseDueAtMs <= input.processStartMs
  ) {
    const windowMs = input.postRestartWindowMs ?? FLEET_POST_RESTART_JITTER_WINDOW_MS;
    if (windowMs <= 0 || input.processStartMs - input.baseDueAtMs <= windowMs) {
      return Math.max(scheduledDueAtMs, input.processStartMs + jitterMs);
    }
  }
  return scheduledDueAtMs;
}

/**
 * GEM-1500: Deterministic initial delay (ms) before the first scheduler tick loop after
 * server startup so a PM2 restart does not fire periodic tick queries at t=0 concurrently
 * with startup orphan-reap and queue recovery.
 */
export function computeSchedulerInitialTickDelayMs(
  intervalMs: number,
  instanceSeed: string,
  maxJitterSec: number = FLEET_HEARTBEAT_JITTER_MAX_SEC_DEFAULT,
): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || maxJitterSec <= 0) return 0;
  const jitterMs = computeAgentHeartbeatJitterMs(instanceSeed || "paperclip-scheduler", maxJitterSec);
  const bounded = Math.max(1_000, jitterMs);
  return Math.min(Math.floor(intervalMs), bounded);
}

/**
 * GEM-1764 (13/11): restart drain hold. `safe_restart_paperclip.py` waits for running runs
 * to finish before `pm2 restart`, but new runs kept starting during the wait, so the
 * 900 s cap expired and the restart cut 2-3 runs each time (11/11 11:51, 18:58; 13/11
 * 00:54, 12:01). While the restart worker keeps this flag file fresh, no queued run is
 * claimed: runs stay `queued` (never cancelled) and start on the new server. The worker
 * touches the file every poll, so a stale file (worker died) stops holding after the TTL.
 */
export const RESTART_DRAIN_FLAG_TTL_SEC_DEFAULT = 120;

export function restartDrainFlagPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PAPERCLIP_RESTART_DRAIN_FLAG?.trim();
  return override || path.join(os.homedir(), ".paperclip", "restart-drain.flag");
}

export function isRestartDrainActive(
  nowMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
  statMtimeMs: (file: string) => number = (file) => fs.statSync(file).mtimeMs,
): boolean {
  const ttlMs = readIntEnv(env, "PAPERCLIP_RESTART_DRAIN_FLAG_TTL_SEC", RESTART_DRAIN_FLAG_TTL_SEC_DEFAULT) * 1000;
  if (ttlMs <= 0) return false;
  try {
    const age = nowMs - statMtimeMs(restartDrainFlagPath(env));
    // Small negative age tolerated (clock skew between writer and server); far-future mtime is ignored.
    return age >= -60_000 && age < ttlMs;
  } catch {
    return false;
  }
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
      reason: "max_running" | "memory_low" | "start_window" | "timer_priority" | "timer_reserved" | "fair_order";
      running: number;
      startsInWindow: number;
      pendingTimerRuns?: number;
      olderClaimableRuns?: number;
    };

export function evaluateFleetClaim(
  config: FleetThrottleConfig,
  counts: { running: number; startsInWindow: number; runningNonTimer?: number; freeMemMb?: number },
  claim?: {
    invocationSource: string | null | undefined;
    pendingTimerRuns: number;
    /** Rule 5: queued non-timer runs of OTHER claimable agents created before this one. */
    olderClaimableRuns?: number;
  },
): FleetClaimVerdict {
  if (config.maxRunning > 0 && counts.running >= config.maxRunning) {
    return { ok: false, reason: "max_running", ...counts };
  }
  // Rule 1b memory guard (GEM-1996): with maxRunning raised to 4 the host must not be pushed
  // into swap. Low free RAM holds every new start unless nothing is running (never deadlock).
  if (
    config.minFreeMemMb > 0 &&
    counts.freeMemMb !== undefined &&
    counts.running > 0 &&
    counts.freeMemMb < config.minFreeMemMb
  ) {
    return { ok: false, reason: "memory_low", ...counts };
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
  if (!claim || claim.invocationSource === "timer") return { ok: true };
  const free = Math.min(
    config.maxRunning > 0 ? config.maxRunning - counts.running : Infinity,
    config.startsPerWindow > 0 ? config.startsPerWindow - counts.startsInWindow : Infinity,
  );
  // Rule 4: keep the free slots for claimable queued timer runs.
  const pendingTimerRuns = config.timerPriority ? claim.pendingTimerRuns : 0;
  if (pendingTimerRuns > 0 && pendingTimerRuns >= free) {
    return { ok: false, reason: "timer_priority", ...counts, pendingTimerRuns };
  }
  // Rule 5: after the timers, older claimable non-timer runs of other agents go first.
  const olderClaimableRuns = config.fairOrder ? (claim.olderClaimableRuns ?? 0) : 0;
  if (olderClaimableRuns > 0 && pendingTimerRuns + olderClaimableRuns >= free) {
    return { ok: false, reason: "fair_order", ...counts, pendingTimerRuns, olderClaimableRuns };
  }
  return { ok: true };
}

/**
 * GEM-1515: a timer wake that coalesces into a QUEUED non-timer run (e.g. a
 * process_lost_retry) must carry its timer priority onto that run. Otherwise the
 * merged run keeps `automation`, stays held by `timer_reserved` / `timer_priority`,
 * and every later timer slot coalesces into it too — the scheduled post is lost.
 * Running targets are left alone (they already hold a slot).
 */
export function coalescedTimerPromotion(
  target: { status: string; invocationSource: string | null },
  wakeSource: string,
): { invocationSource: "timer" } | null {
  if (wakeSource !== "timer") return null;
  if (target.status !== "queued" || target.invocationSource === "timer") return null;
  return { invocationSource: "timer" };
}

export interface QueuedRunFairCandidate {
  invocationSource: string | null;
  createdAt: Date | string;
  agentLastStartedAt?: Date | string | null;
  agentLastFinishedAt?: Date | string | null;
}

function toTimestampMs(value: Date | string | null | undefined, fallback: number): number {
  if (value == null) return fallback;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : fallback;
}

/**
 * GEM-2211: Thời điểm xếp hàng hiệu dụng của một lượt chạy non-timer.
 * Khi 1 agent nhận 1 chùm (batch) N lượt lúc t1..tN và vừa chạy lượt 1 tới `finishedAt`
 * (hoặc bắt đầu lúc `startedAt`), các lượt 2..N chỉ thực sự chờ rảnh từ
 * `max(createdAt, agentLastStartedAt, agentLastFinishedAt)`. Nhờ vậy agent vừa chạy xong
 * phải nhường slot cho agent khác đã chờ trước khi lượt vừa rồi bắt đầu/kết thúc (round-robin).
 */
export function effectiveQueuedRunTimestampMs(run: Pick<QueuedRunFairCandidate, "createdAt" | "agentLastStartedAt" | "agentLastFinishedAt">): number {
  const createdMs = toTimestampMs(run.createdAt, 0);
  const lastStartedMs = toTimestampMs(run.agentLastStartedAt, -Infinity);
  const lastFinishedMs = toTimestampMs(run.agentLastFinishedAt, -Infinity);
  return Math.max(createdMs, lastStartedMs, lastFinishedMs);
}

export function isQueuedRunStarved(
  run: Pick<QueuedRunFairCandidate, "createdAt" | "agentLastStartedAt" | "agentLastFinishedAt">,
  config: Pick<FleetThrottleConfig, "fairWaitMaxMin">,
  nowMs: number = Date.now(),
): boolean {
  if (config.fairWaitMaxMin <= 0) return false;
  const ceilingMs = config.fairWaitMaxMin * 60_000;
  return nowMs - effectiveQueuedRunTimestampMs(run) >= ceilingMs;
}

/** Claim order for queued runs: timer runs first (rule 4), then fair round-robin + starvation ceiling (rule 5 / GEM-2211). */
export function orderQueuedRunsForClaim<T extends QueuedRunFairCandidate>(
  config: Pick<FleetThrottleConfig, "timerPriority" | "fairOrder" | "fairWaitMaxMin">,
  runs: T[],
  nowMs: number = Date.now(),
): T[] {
  const rank = (run: T) => (config.timerPriority && run.invocationSource === "timer" ? 0 : 1);
  return runs
    .map((run, index) => ({ run, index }))
    .sort((a, b) => {
      const rankDiff = rank(a.run) - rank(b.run);
      if (rankDiff !== 0) return rankDiff;

      const aIsTimer = rank(a.run) === 0;
      if (!config.fairOrder || aIsTimer) {
        return (
          toTimestampMs(a.run.createdAt, 0) - toTimestampMs(b.run.createdAt, 0) ||
          a.index - b.index
        );
      }

      const aStarved = isQueuedRunStarved(a.run, config, nowMs);
      const bStarved = isQueuedRunStarved(b.run, config, nowMs);
      if (aStarved !== bStarved) return aStarved ? -1 : 1;

      const aEffective = effectiveQueuedRunTimestampMs(a.run);
      const bEffective = effectiveQueuedRunTimestampMs(b.run);
      const aLastStarted = toTimestampMs(a.run.agentLastStartedAt, -Infinity);
      const bLastStarted = toTimestampMs(b.run.agentLastStartedAt, -Infinity);

      if (aStarved && bStarved) {
        if (aLastStarted !== bLastStarted) return aLastStarted - bLastStarted;
        if (aEffective !== bEffective) return aEffective - bEffective;
      } else {
        if (aEffective !== bEffective) return aEffective - bEffective;
        if (aLastStarted !== bLastStarted) return aLastStarted - bLastStarted;
      }

      return (
        toTimestampMs(a.run.createdAt, 0) - toTimestampMs(b.run.createdAt, 0) ||
        a.index - b.index
      );
    })
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
