/**
 * Company-wide (fleet) pause/resume — GEMRAL 2026-10-26.
 *
 * Dashboard button "Tạm dừng / Chạy lại toàn đội" pauses every agent that runs on a
 * heartbeat schedule. Pause tags rows with pauseReason = "fleet"; resume ONLY flips
 * rows carrying that tag, so agents paused for another reason (manual quota pause,
 * budget hard-stop, system) stay paused.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
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
    };
  }

  return {
    status,
    /** Ids of agents the pause button should pause right now. */
    pausableAgentIds: async (companyId: string) =>
      (await listCompanyAgents(companyId)).filter(isFleetPausable).map((a) => a.id),
    /** Ids of agents paused by the button. */
    fleetPausedAgentIds: async (companyId: string) =>
      (await listCompanyAgents(companyId))
        .filter((a) => a.status === "paused" && a.pauseReason === "fleet")
        .map((a) => a.id),
  };
}
