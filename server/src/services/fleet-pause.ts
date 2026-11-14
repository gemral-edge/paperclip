/**
 * Company-wide (fleet) pause/resume — GEMRAL 2026-10-26.
 *
 * Dashboard button "Tạm dừng / Chạy lại toàn đội" pauses every agent that runs on a
 * heartbeat schedule. Pause tags rows with pauseReason = "fleet"; resume ONLY flips
 * rows carrying that tag, so agents paused for another reason (manual quota pause,
 * budget hard-stop, system) stay paused.
 *
 * 2026-11-14: resume also re-hands the work the pause cut off. Pausing cancels every
 * queued/running run with error FLEET_PAUSE_CANCEL_REASON; on resume we pick those
 * runs (one per issue), keep only issues still open and still assigned to the same
 * agent, and enqueue a fresh wakeup with the original context. Runs with no issue
 * (plain timer beats) are not replayed: the schedule picks them up again.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issues } from "@paperclipai/db";
import { parseObject, asBoolean, asNumber, asString } from "../adapters/utils.js";
import { readFleetThrottleConfig } from "./fleet-throttle.js";

type AgentRow = typeof agents.$inferSelect;

/** Same rule as heartbeat parseHeartbeatPolicy: enabled AND (cron OR intervalSec > 0). */
export function hasHeartbeatSchedule(runtimeConfig: unknown): boolean {
  const heartbeat = parseObject(parseObject(runtimeConfig).heartbeat);
  if (!asBoolean(heartbeat.enabled, true)) return false;
  const cron = asString(heartbeat.cronExpression ?? heartbeat.cron, "").trim();
  return cron.length > 0 || asNumber(heartbeat.intervalSec, 0) > 0;
}

/** Agents the pause button acts on: scheduled + currently able to run. */
export function isFleetPausable(agent: Pick<AgentRow, "status" | "runtimeConfig">): boolean {
  if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") {
    return false;
  }
  return hasHeartbeatSchedule(agent.runtimeConfig);
}

export interface FleetStatus {
  /** Scheduled agents that would be paused by the button now. */
  pausable: number;
  /** Agents paused by the button (would be resumed). */
  fleetPaused: number;
  /** Agents paused for another reason — the button never touches them. */
  otherPaused: number;
  running: number;
  queued: number;
  oldestQueuedAt: string | null;
  maxRunning: number;
  /** Issues whose run the pause cancelled and that resume would hand back. */
  pendingRequeue: number;
}

/** Error text heartbeat.cancelActiveForAgent writes on runs cut by a pause. */
export const FLEET_PAUSE_CANCEL_REASON = "Cancelled due to agent pause";
/** Cancels land right after pausedAt is stamped; allow clock slack before and a long loop after. */
const PAUSE_SLACK_BEFORE_MS = 2 * 60 * 1000;
const PAUSE_WINDOW_AFTER_MS = 60 * 60 * 1000;
const CLOSED_ISSUE_STATUSES = new Set(["done", "cancelled"]);

export interface PauseCancelledRun {
  id: string;
  agentId: string;
  invocationSource: string;
  error: string | null;
  finishedAt: Date | null;
  contextSnapshot: Record<string, unknown> | null;
}

export interface RequeueIssueState {
  status: string;
  assigneeAgentId: string | null;
}

export function runIssueId(run: Pick<PauseCancelledRun, "contextSnapshot">): string | null {
  const raw = run.contextSnapshot?.issueId;
  return typeof raw === "string" && raw.trim().length > 0 ? raw : null;
}

/**
 * Pure selection of runs to replay after a fleet resume. One run per issue (latest wins);
 * skips runs outside the pause window, issues closed or re-assigned since, and issues
 * that already have a queued/running run.
 */
export function selectRunsToRequeue(
  runs: PauseCancelledRun[],
  pausedAtByAgent: Map<string, Date | null>,
  issueById: Map<string, RequeueIssueState>,
  busyIssueIds: Set<string>,
): PauseCancelledRun[] {
  const sorted = [...runs].sort(
    (a, b) => (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0),
  );
  const seen = new Set<string>();
  const picked: PauseCancelledRun[] = [];
  for (const run of sorted) {
    if (run.error !== FLEET_PAUSE_CANCEL_REASON || !run.finishedAt) continue;
    const pausedAt = pausedAtByAgent.get(run.agentId);
    if (!pausedAt) continue;
    const t = run.finishedAt.getTime();
    if (t < pausedAt.getTime() - PAUSE_SLACK_BEFORE_MS || t > pausedAt.getTime() + PAUSE_WINDOW_AFTER_MS) continue;
    const issueId = runIssueId(run);
    if (!issueId || seen.has(issueId) || busyIssueIds.has(issueId)) continue;
    const issue = issueById.get(issueId);
    if (!issue || CLOSED_ISSUE_STATUSES.has(issue.status) || issue.assigneeAgentId !== run.agentId) continue;
    seen.add(issueId);
    picked.push(run);
  }
  return picked;
}

export function fleetPauseService(db: Db) {
  async function listCompanyAgents(companyId: string) {
    return db.select().from(agents).where(eq(agents.companyId, companyId));
  }

  async function status(companyId: string): Promise<FleetStatus> {
    const rows = await listCompanyAgents(companyId);
    const live = await db
      .select({ status: heartbeatRuns.status, createdAt: heartbeatRuns.createdAt })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "running"])));

    const queuedRuns = live.filter((r) => r.status === "queued");
    const oldest = queuedRuns.reduce<Date | null>(
      (min, r) => (min === null || r.createdAt < min ? r.createdAt : min),
      null,
    );

    return {
      pausable: rows.filter(isFleetPausable).length,
      fleetPaused: rows.filter((a) => a.status === "paused" && a.pauseReason === "fleet").length,
      otherPaused: rows.filter((a) => a.status === "paused" && a.pauseReason !== "fleet").length,
      running: live.filter((r) => r.status === "running").length,
      queued: queuedRuns.length,
      oldestQueuedAt: oldest ? oldest.toISOString() : null,
      maxRunning: readFleetThrottleConfig().maxRunning,
      pendingRequeue: (await runsToRequeue(rows.filter((a) => a.status === "paused" && a.pauseReason === "fleet"))).length,
    };
  }

  async function runsToRequeue(pausedAgents: AgentRow[]): Promise<PauseCancelledRun[]> {
    if (pausedAgents.length === 0) return [];
    const agentIds = pausedAgents.map((a) => a.id);
    const pausedAtByAgent = new Map(pausedAgents.map((a) => [a.id, a.pausedAt ?? null]));
    const runs = await db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        invocationSource: heartbeatRuns.invocationSource,
        error: heartbeatRuns.error,
        finishedAt: heartbeatRuns.finishedAt,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(
        and(
          inArray(heartbeatRuns.agentId, agentIds),
          eq(heartbeatRuns.status, "cancelled"),
          eq(heartbeatRuns.error, FLEET_PAUSE_CANCEL_REASON),
        ),
      );
    const issueIds = [...new Set(runs.map(runIssueId).filter((id): id is string => id !== null))];
    if (issueIds.length === 0) return [];
    const issueRows = await db
      .select({ id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(inArray(issues.id, issueIds));
    const live = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(and(inArray(heartbeatRuns.agentId, agentIds), inArray(heartbeatRuns.status, ["queued", "running"])));
    const busy = new Set(live.map(runIssueId).filter((id): id is string => id !== null));
    return selectRunsToRequeue(
      runs,
      pausedAtByAgent,
      new Map(issueRows.map((r) => [r.id, { status: r.status, assigneeAgentId: r.assigneeAgentId }])),
      busy,
    );
  }

  return {
    status,
    /** Ids of agents the pause button should pause right now. */
    pausableAgentIds: async (companyId: string) =>
      (await listCompanyAgents(companyId)).filter(isFleetPausable).map((a) => a.id),
    /** Ids of agents paused by the button. */
    /** Runs the pause cut off that resume should hand back (call BEFORE resume clears pausedAt). */
    runsToRequeue: async (companyId: string) =>
      runsToRequeue(
        (await listCompanyAgents(companyId)).filter((a) => a.status === "paused" && a.pauseReason === "fleet"),
      ),
    fleetPausedAgentIds: async (companyId: string) =>
      (await listCompanyAgents(companyId))
        .filter((a) => a.status === "paused" && a.pauseReason === "fleet")
        .map((a) => a.id),
  };
}
