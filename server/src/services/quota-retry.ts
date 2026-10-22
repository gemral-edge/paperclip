/**
 * Quota-exhausted run → scheduled retry instead of a hard agent `error` (GEM-1004).
 *
 * A provider quota wall (Antigravity Ultra 429, Claude weekly cap, Gemini 429) is a
 * TIME problem, not an agent problem: the same run succeeds once the window resets.
 * Before this, the run failed, `finalizeAgentStatus` flipped the agent to `error`,
 * and a daily-cron agent simply lost that day's slot.
 *
 * Pure policy only — heartbeat.ts persists the plan in
 * `agent_runtime_state.state_json.quotaRetry` (survives a server restart) and
 * `tickTimers` fires it when due.
 */

export const QUOTA_RETRY_ERROR_CODES: ReadonlySet<string> = new Set([
  "antigravity_quota_exhausted",
  "claude_weekly_limit",
  "gemini_quota_exhausted",
]);

/** Backoff per attempt when the provider gives no reset time (minutes). */
export const QUOTA_RETRY_BACKOFF_MIN = [30, 60, 120] as const;
export const QUOTA_RETRY_MAX_ATTEMPTS = QUOTA_RETRY_BACKOFF_MIN.length;

/**
 * Transient transport failures (agent stream dropped mid-response) — not a quota wall,
 * so retry SHORT: slot-window agents (Yinyang 09:30 wake, window closes 10:00) must land
 * the retry inside the window (GEM-1017: 09:40 fail + 10 min = 09:50 still in-window).
 */
export const TRANSIENT_RETRY_ERROR_CODES: ReadonlySet<string> = new Set([
  "antigravity_transient_disconnect",
  // GEM-1307: model printed its plan then ended the turn without acting — a stall,
  // not an agent bug; a fresh turn usually completes. Short backoff keeps slot agents
  // (Yinyang 16:15) inside their window. Capped at 2 attempts like any transient.
  "antigravity_no_action",
  // GEM-1307 tái phát 22/10: turn ended on a promise to continue, 0 file writes.
  "antigravity_unfinished_turn",
]);
export const TRANSIENT_RETRY_BACKOFF_MIN = [10, 20] as const;

function backoffFor(errorCode: string): readonly number[] | null {
  if (QUOTA_RETRY_ERROR_CODES.has(errorCode)) return QUOTA_RETRY_BACKOFF_MIN;
  if (TRANSIENT_RETRY_ERROR_CODES.has(errorCode)) return TRANSIENT_RETRY_BACKOFF_MIN;
  return null;
}

const MIN_DELAY_MS = 5 * 60_000;
const MAX_DELAY_MS = 7 * 24 * 60 * 60_000;
const RESET_SLACK_MS = 2 * 60_000;
/**
 * De-synchronise retries (GEM-1009): agents that hit the same 429 wall at the same
 * minute would otherwise all retry at the same +30 min mark and hit it together again.
 * Additive only (never earlier than the base delay): backoff +0..20%, resetsAt +0..3 min.
 * Transient 10 min → ≤12 min keeps a 09:41 slot-window retry before 10:00.
 */
export const RETRY_JITTER_FRACTION = 0.2;
const RESET_JITTER_MS = 3 * 60_000;

export type QuotaRetryPlan = {
  retryAt: string;
  attempt: number;
  errorCode: string;
  retryOfRunId: string;
  issueId: string | null;
  /** Wake source for the retry: a timer run retries as timer (honours heartbeat.enabled). */
  source: "timer" | "automation";
};

function readResetsAt(errorMeta: Record<string, unknown> | null | undefined, now: Date): number | null {
  const raw = errorMeta?.resetsAt;
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms) || ms <= now.getTime()) return null;
  return ms;
}

/**
 * Returns the retry plan for a failed run, or null when the failure is not a quota
 * wall or the retry budget is spent (→ caller keeps the normal failed/error path so
 * a quota that never resets stays visible instead of looping silently).
 *
 * `priorAttempts` = how many quota retries already led to this run
 * (contextSnapshot.quotaRetryAttempt of the run that just failed).
 */
export function planQuotaRetry(input: {
  errorCode: string | null | undefined;
  errorMeta?: Record<string, unknown> | null;
  priorAttempts: number;
  runId: string;
  issueId: string | null;
  fromTimer: boolean;
  now: Date;
  /** [0,1) source for jitter — injectable for deterministic tests. */
  random?: () => number;
}): QuotaRetryPlan | null {
  const { errorCode, now } = input;
  const r = Math.min(0.999999, Math.max(0, (input.random ?? Math.random)()));
  const backoff = errorCode ? backoffFor(errorCode) : null;
  if (!errorCode || !backoff) return null;
  const prior = Number.isFinite(input.priorAttempts) && input.priorAttempts > 0 ? Math.floor(input.priorAttempts) : 0;
  if (prior >= backoff.length) return null;

  const resetsAtMs = readResetsAt(input.errorMeta, now);
  const rawDelay =
    resetsAtMs !== null
      ? resetsAtMs - now.getTime() + RESET_SLACK_MS + r * RESET_JITTER_MS
      : backoff[prior] * 60_000 * (1 + r * RETRY_JITTER_FRACTION);
  const delay = Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, rawDelay));

  return {
    retryAt: new Date(now.getTime() + delay).toISOString(),
    attempt: prior + 1,
    errorCode,
    retryOfRunId: input.runId,
    issueId: input.issueId,
    source: input.fromTimer ? "timer" : "automation",
  };
}

/** Narrow an unknown `state_json.quotaRetry` value back to a plan (null if malformed). */
export function readQuotaRetryPlan(value: unknown): QuotaRetryPlan | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.retryAt !== "string" || !Number.isFinite(Date.parse(v.retryAt))) return null;
  if (typeof v.retryOfRunId !== "string" || typeof v.errorCode !== "string") return null;
  const attempt = typeof v.attempt === "number" && v.attempt > 0 ? Math.floor(v.attempt) : 1;
  const issueId = typeof v.issueId === "string" && v.issueId ? v.issueId : null;
  const source = v.source === "timer" ? "timer" : "automation";
  return { retryAt: v.retryAt, attempt, errorCode: v.errorCode, retryOfRunId: v.retryOfRunId, issueId, source };
}
