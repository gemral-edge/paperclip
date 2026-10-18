import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  SCHEDULER_TICK_JOB_STAGGER_MS,
  computeAgentHeartbeatJitterMs,
  computeAgentHeartbeatJitterSec,
  computeJitteredDueAtMs,
  coalescedTimerPromotion,
  computeSchedulerInitialTickDelayMs,
  evaluateFleetClaim,
  fleetWindowStart,
  orderQueuedRunsForClaim,
  orderTimerCandidatesFairly,
  readFleetThrottleConfig,
} from "../services/fleet-throttle.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const FLEET_ENV_KEYS = [
  "PAPERCLIP_FLEET_MAX_RUNNING",
  "PAPERCLIP_FLEET_STARTS_PER_10MIN",
  "PAPERCLIP_FLEET_TIMER_WAKES_PER_HOUR",
  "PAPERCLIP_FLEET_TIMER_EXEMPT_AGENTS",
  "PAPERCLIP_FLEET_TIMER_PRIORITY",
  "PAPERCLIP_FLEET_TIMER_RESERVED_SLOTS",
  "PAPERCLIP_HEARTBEAT_JITTER_MAX_SEC",
] as const;

function setFleetEnv(values: Partial<Record<(typeof FLEET_ENV_KEYS)[number], string>>) {
  for (const key of FLEET_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
}

describe("fleet throttle pure helpers", () => {
  it("defaults to 2 running / 2 starts per 10 min / 3 timer wakes per hour / 30s jitter", () => {
    const cfg = readFleetThrottleConfig({});
    expect(cfg.maxRunning).toBe(2);
    expect(cfg.startsPerWindow).toBe(2);
    expect(cfg.timerWakesPerHour).toBe(3);
    expect(cfg.timerExemptAgents.size).toBe(0);
    expect(cfg.heartbeatJitterMaxSec).toBe(30);
  });

  it("aligns windows to Asia/Ho_Chi_Minh wall clock", () => {
    // 2026-10-05 17:47:13 +07:00 → 10-min window 17:40 local, hour window 17:00 local
    const now = new Date("2026-10-05T10:47:13.000Z");
    expect(fleetWindowStart(now, 10 * 60 * 1000).toISOString()).toBe("2026-10-05T10:40:00.000Z");
    expect(fleetWindowStart(now, 60 * 60 * 1000).toISOString()).toBe("2026-10-05T10:00:00.000Z");
  });

  it("blocks on running cap before start-window cap", () => {
    const cfg = readFleetThrottleConfig({});
    expect(evaluateFleetClaim(cfg, { running: 1, startsInWindow: 1 }).ok).toBe(true);
    expect(evaluateFleetClaim(cfg, { running: 2, startsInWindow: 0 })).toMatchObject({ ok: false, reason: "max_running" });
    expect(evaluateFleetClaim(cfg, { running: 0, startsInWindow: 2 })).toMatchObject({ ok: false, reason: "start_window" });
    const off = readFleetThrottleConfig({ PAPERCLIP_FLEET_MAX_RUNNING: "0", PAPERCLIP_FLEET_STARTS_PER_10MIN: "0" });
    expect(evaluateFleetClaim(off, { running: 50, startsInWindow: 50 }).ok).toBe(true);
  });

  it("rule 4: non-timer claim yields the last free slot to a waiting timer run, timer claim never does", () => {
    const cfg = readFleetThrottleConfig({});
    expect(cfg.timerPriority).toBe(true);
    const counts = { running: 1, startsInWindow: 0 };
    expect(evaluateFleetClaim(cfg, counts, { invocationSource: "automation", pendingTimerRuns: 1 })).toMatchObject({
      ok: false,
      reason: "timer_priority",
    });
    expect(evaluateFleetClaim(cfg, counts, { invocationSource: "timer", pendingTimerRuns: 3 }).ok).toBe(true);
    // Two free slots, one timer waiting → the automation run may take the other slot.
    expect(evaluateFleetClaim(cfg, { running: 0, startsInWindow: 0 }, { invocationSource: "automation", pendingTimerRuns: 1 }).ok).toBe(true);
    expect(evaluateFleetClaim(cfg, counts, { invocationSource: "automation", pendingTimerRuns: 0 }).ok).toBe(true);
    const off = readFleetThrottleConfig({ PAPERCLIP_FLEET_TIMER_PRIORITY: "0" });
    expect(evaluateFleetClaim(off, counts, { invocationSource: "automation", pendingTimerRuns: 1 }).ok).toBe(true);
  });

  it("rule 4: reserved slot keeps non-timer runs to maxRunning - 1, timers may use it", () => {
    const cfg = readFleetThrottleConfig({});
    expect(cfg.timerReservedSlots).toBe(1);
    const oneLongEngineerRun = { running: 1, startsInWindow: 0, runningNonTimer: 1 };
    expect(evaluateFleetClaim(cfg, oneLongEngineerRun, { invocationSource: "automation", pendingTimerRuns: 0 })).toMatchObject({
      ok: false,
      reason: "timer_reserved",
    });
    expect(evaluateFleetClaim(cfg, oneLongEngineerRun, { invocationSource: "timer", pendingTimerRuns: 0 }).ok).toBe(true);
    // A timer holding one slot does not count against the non-timer share.
    expect(
      evaluateFleetClaim(cfg, { running: 1, startsInWindow: 0, runningNonTimer: 0 }, { invocationSource: "automation", pendingTimerRuns: 0 }).ok,
    ).toBe(true);
    // maxRunning 1 → nothing to reserve; 0 → disabled.
    const single = readFleetThrottleConfig({ PAPERCLIP_FLEET_MAX_RUNNING: "1" });
    expect(evaluateFleetClaim(single, { running: 0, startsInWindow: 0, runningNonTimer: 0 }, { invocationSource: "automation", pendingTimerRuns: 0 }).ok).toBe(true);
    const off = readFleetThrottleConfig({ PAPERCLIP_FLEET_TIMER_RESERVED_SLOTS: "0" });
    expect(evaluateFleetClaim(off, oneLongEngineerRun, { invocationSource: "automation", pendingTimerRuns: 0 }).ok).toBe(true);
  });

  it("GEM-1515: a timer wake coalescing into a queued non-timer run promotes it to timer", () => {
    expect(coalescedTimerPromotion({ status: "queued", invocationSource: "automation" }, "timer")).toEqual({
      invocationSource: "timer",
    });
    expect(coalescedTimerPromotion({ status: "running", invocationSource: "automation" }, "timer")).toBeNull();
    expect(coalescedTimerPromotion({ status: "queued", invocationSource: "timer" }, "timer")).toBeNull();
    expect(coalescedTimerPromotion({ status: "queued", invocationSource: "automation" }, "assignment")).toBeNull();
  });

  it("rule 4: claim order puts timer runs first, then oldest first", () => {
    const cfg = readFleetThrottleConfig({});
    const runs = [
      { id: "auto-old", invocationSource: "automation", createdAt: new Date("2026-10-13T04:25:00Z") },
      { id: "timer-new", invocationSource: "timer", createdAt: new Date("2026-10-13T06:00:00Z") },
      { id: "auto-mid", invocationSource: "automation", createdAt: new Date("2026-10-13T05:00:00Z") },
    ];
    expect(orderQueuedRunsForClaim(cfg, runs).map((r) => r.id)).toEqual(["timer-new", "auto-old", "auto-mid"]);
    const off = readFleetThrottleConfig({ PAPERCLIP_FLEET_TIMER_PRIORITY: "0" });
    expect(orderQueuedRunsForClaim(off, runs).map((r) => r.id)).toEqual(["auto-old", "auto-mid", "timer-new"]);
  });

  it("orders timer candidates oldest-finished first, never-finished before all", () => {
    const ordered = orderTimerCandidatesFairly(
      [
        { id: "recent", at: new Date("2026-10-05T10:00:00Z") },
        { id: "never", at: null },
        { id: "old", at: new Date("2026-10-04T10:00:00Z") },
      ],
      (c) => c.at,
    );
    expect(ordered.map((c) => c.id)).toEqual(["never", "old", "recent"]);
  });

  it("GEM-1500: computes deterministic per-agent hash jitter in 0..29s across restarts and spreads fleet IDs", () => {
    const idA = "99841cec-b00c-4305-a2b8-efb53562c780";
    const sec1 = computeAgentHeartbeatJitterSec(idA, 30);
    const sec2 = computeAgentHeartbeatJitterSec(`  ${idA.toUpperCase()}  `, 30);
    expect(sec1).toBe(sec2);
    expect(sec1).toBeGreaterThanOrEqual(0);
    expect(sec1).toBeLessThan(30);
    expect(computeAgentHeartbeatJitterMs(idA, 30)).toBe(sec1 * 1000);
    expect(computeAgentHeartbeatJitterMs(idA, 0)).toBe(0);
    expect(computeAgentHeartbeatJitterMs("", 30)).toBe(0);

    // Check distribution across 24 distinct agent UUIDs: must occupy multiple distinct second buckets.
    const sampleIds = Array.from({ length: 24 }, (_, idx) =>
      `00000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`,
    );
    const distinctBuckets = new Set(sampleIds.map((id) => computeAgentHeartbeatJitterSec(id, 30)));
    expect(distinctBuckets.size).toBeGreaterThanOrEqual(10);
  });

  it("GEM-1500: offsets BOTH recurring slots AND the first post-restart catch-up slot by agent hash jitter", () => {
    // Pick an agent ID that hashes to a non-zero offset in 0..29s.
    const agentId = "99841cec-b00c-4305-a2b8-efb53562c780";
    const jitterMs = computeAgentHeartbeatJitterMs(agentId, 30);
    expect(jitterMs).toBeGreaterThan(0);

    const processStartMs = Date.parse("2026-10-18T09:00:40.000Z");
    // 1. Recurring slot AFTER process start (09:30:00Z): due at 09:30:00Z + jitterMs.
    const recurringSlotMs = Date.parse("2026-10-18T09:30:00.000Z");
    expect(
      computeJitteredDueAtMs({
        baseDueAtMs: recurringSlotMs,
        agentId,
        maxJitterSec: 30,
        processStartMs,
      }),
    ).toBe(recurringSlotMs + jitterMs);

    // 2. First slot AFTER restart where baseDueAtMs (09:00:00Z) fell while server was restarting:
    // Without post-restart anchoring, 09:00:00Z + jitterMs (<= 09:00:29Z) would already be <= processStartMs (09:00:40Z),
    // firing every agent on the very first tick at 09:00:40Z. With post-restart anchoring, it waits until processStartMs + jitterMs.
    const preRestartSlotMs = Date.parse("2026-10-18T09:00:00.000Z");
    expect(
      computeJitteredDueAtMs({
        baseDueAtMs: preRestartSlotMs,
        agentId,
        maxJitterSec: 30,
        processStartMs,
      }),
    ).toBe(processStartMs + jitterMs);

    // 3. Staggers initial scheduler tick delay and 4 periodic tick jobs.
    const initialDelay = computeSchedulerInitialTickDelayMs(30_000, "paperclip-prod-1", 30);
    expect(initialDelay).toBeGreaterThanOrEqual(1_000);
    expect(initialDelay).toBeLessThanOrEqual(30_000);
    expect(SCHEDULER_TICK_JOB_STAGGER_MS).toEqual({
      timers: 0,
      wakeups: 2_500,
      routines: 5_000,
      recovery: 7_500,
    });
  });
});

describeEmbeddedPostgres("heartbeat fleet throttle (company-wide)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let svc!: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-fleet-");
    db = createDb(tempDb.connectionString);
    svc = heartbeatService(db);
  }, 240_000);

  afterEach(async () => {
    const live = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.status, "running"));
    for (const run of live) {
      await svc.cancelRun(run.id).catch(() => undefined);
    }
    runningProcesses.clear();
    // Executed runs create side rows (company_skills, workspaces...) — cascade wipes all.
    // Cancelled runs still finalize in the background; their writes can deadlock the
    // truncate (40P01), so retry instead of failing an unrelated test.
    for (let attempt = 0; ; attempt++) {
      try {
        await db.execute(sql`truncate table companies cascade`);
        break;
      } catch (err) {
        if ((err as { code?: string }).code !== "40P01" || attempt >= 4) throw err;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    setFleetEnv({});
  }, 60_000);

  afterAll(async () => {
    setFleetEnv({});
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Fleet",
      issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string, heartbeat: Record<string, unknown> = {}) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "process",
      // Long sleeper so claimed runs stay `running` for the duration of the assertion.
      adapterConfig: { command: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"] },
      runtimeConfig: { heartbeat: { enabled: true, catchUpGraceSec: 0, ...heartbeat } },
      permissions: {},
      lastHeartbeatAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    return agentId;
  }

  async function seedQueuedRun(
    companyId: string,
    agentId: string,
    invocationSource = "assignment",
    createdAt?: Date,
  ) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource,
      ...(createdAt ? { createdAt } : {}),
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: {},
    });
    return runId;
  }

  async function statusCounts(companyId: string) {
    const rows = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId));
    return {
      running: rows.filter((r) => r.status === "running").length,
      queued: rows.filter((r) => r.status === "queued").length,
    };
  }

  it("rule 1: 5 agents due at once → only 2 running, the rest stay queued (even with racing claimers)", async () => {
    setFleetEnv({
      PAPERCLIP_FLEET_MAX_RUNNING: "2",
      PAPERCLIP_FLEET_STARTS_PER_10MIN: "0",
      PAPERCLIP_FLEET_TIMER_RESERVED_SLOTS: "0",
    });
    const companyId = await seedCompany();
    for (let i = 0; i < 5; i++) {
      const agentId = await seedAgent(companyId, `Agent ${i}`);
      await seedQueuedRun(companyId, agentId);
    }

    await Promise.all([svc.resumeQueuedRuns(), svc.resumeQueuedRuns(), svc.resumeQueuedRuns()]);

    expect(await statusCounts(companyId)).toEqual({ running: 2, queued: 3 });
  }, 60_000);

  it("rule 2: third start inside the same 10-minute window is deferred", async () => {
    setFleetEnv({ PAPERCLIP_FLEET_MAX_RUNNING: "0", PAPERCLIP_FLEET_STARTS_PER_10MIN: "2" });
    const companyId = await seedCompany();
    const agentIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const agentId = await seedAgent(companyId, `Starter ${i}`);
      agentIds.push(agentId);
      await seedQueuedRun(companyId, agentId);
    }

    await svc.resumeQueuedRuns();
    expect(await statusCounts(companyId)).toEqual({ running: 2, queued: 1 });

    // Simulate the window rolling over: the two earlier starts move to the previous window.
    const previousWindow = new Date(fleetWindowStart(new Date(), 10 * 60 * 1000).getTime() - 60_000);
    await db
      .update(heartbeatRuns)
      .set({ startedAt: previousWindow })
      .where(eq(heartbeatRuns.status, "running"));
    await svc.resumeQueuedRuns();
    expect(await statusCounts(companyId)).toEqual({ running: 3, queued: 0 });
  }, 60_000);

  it("rule 3: 4 timer wakes due in one hour → 4th is skipped (not queued) and oldest-finished agents win", async () => {
    setFleetEnv({
      PAPERCLIP_FLEET_MAX_RUNNING: "0",
      PAPERCLIP_FLEET_STARTS_PER_10MIN: "0",
      PAPERCLIP_FLEET_TIMER_WAKES_PER_HOUR: "3",
    });
    const companyId = await seedCompany();
    const finishedAt = [
      new Date("2026-10-01T00:00:00Z"),
      new Date("2026-10-02T00:00:00Z"),
      new Date("2026-10-03T00:00:00Z"),
      new Date("2026-10-04T00:00:00Z"), // most recently finished → loses the fair pick
    ];
    const agentIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const agentId = await seedAgent(companyId, `Timer ${i}`, { cronExpression: "* * * * *" });
      agentIds.push(agentId);
      await db.insert(heartbeatRuns).values({
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "succeeded",
        contextSnapshot: {},
        startedAt: finishedAt[i],
        finishedAt: finishedAt[i],
      });
    }

    const first = await svc.tickTimers(new Date());
    expect(first.enqueued).toBe(3);
    expect(first.deferredByFleet).toBe(1);

    const timerRuns = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.invocationSource, "timer"));
    expect(timerRuns.map((r) => r.agentId).sort()).toEqual(agentIds.slice(0, 3).sort());

    // Skipped agent keeps its old baseline (re-evaluated later), and a second tick in the
    // same hour still does not let it through — nothing is stacked in the queue.
    const [skipped] = await db.select().from(agents).where(eq(agents.id, agentIds[3]!));
    expect(skipped?.lastHeartbeatAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    const second = await svc.tickTimers(new Date());
    expect(second.enqueued).toBe(0);
    const timerRunsAfter = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.invocationSource, "timer"));
    expect(timerRunsAfter).toHaveLength(3);
  }, 60_000);

  it("rule 4: a timer run queued behind 5 older automation runs is claimed first", async () => {
    setFleetEnv({ PAPERCLIP_FLEET_MAX_RUNNING: "1", PAPERCLIP_FLEET_STARTS_PER_10MIN: "0" });
    const companyId = await seedCompany();
    const backlog = await seedAgent(companyId, "Backlog Engineer", { maxConcurrentRuns: 5 });
    const poster = await seedAgent(companyId, "Timer Poster");
    for (let i = 0; i < 5; i++) {
      await seedQueuedRun(companyId, backlog, "automation", new Date(Date.now() - (180 - i) * 60_000));
    }
    const timerRunId = await seedQueuedRun(companyId, poster, "timer", new Date());

    await svc.resumeQueuedRuns();

    const running = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "running"));
    expect(running.map((r) => r.id)).toEqual([timerRunId]);
    expect(await statusCounts(companyId)).toEqual({ running: 1, queued: 5 });
  }, 60_000);

  it("rule 4: a backlog run finishing cannot hand its freed slot to its own automation run while a timer waits", async () => {
    setFleetEnv({ PAPERCLIP_FLEET_MAX_RUNNING: "1", PAPERCLIP_FLEET_STARTS_PER_10MIN: "0" });
    const companyId = await seedCompany();
    const backlog = await seedAgent(companyId, "Backlog Engineer");
    const poster = await seedAgent(companyId, "Timer Poster");
    await seedQueuedRun(companyId, backlog, "automation", new Date(Date.now() - 120 * 60_000));
    const timerRunId = await seedQueuedRun(companyId, poster, "timer", new Date());

    // The backlog agent's own drain path (what runs when its previous run finishes)
    // must hold its automation run instead of taking the only free slot.
    await svc.wakeup(backlog, { source: "automation", triggerDetail: "system" }).catch(() => undefined);
    const afterOwnDrain = await db
      .select({ id: heartbeatRuns.id, source: heartbeatRuns.invocationSource })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "running"));
    expect(afterOwnDrain.filter((r) => r.source !== "timer")).toEqual([]);

    await svc.resumeQueuedRuns();
    const running = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "running"));
    expect(running.map((r) => r.id)).toEqual([timerRunId]);
  }, 60_000);

  it("rule 4: with one long engineering run in flight, a second one waits and the timer gets the free slot", async () => {
    setFleetEnv({ PAPERCLIP_FLEET_MAX_RUNNING: "2", PAPERCLIP_FLEET_STARTS_PER_10MIN: "0" });
    const companyId = await seedCompany();
    const engineerA = await seedAgent(companyId, "Engineer A");
    const engineerB = await seedAgent(companyId, "Engineer B");
    const poster = await seedAgent(companyId, "Timer Poster");
    await seedQueuedRun(companyId, engineerA, "assignment", new Date(Date.now() - 90 * 60_000));
    await svc.resumeQueuedRuns();
    expect(await statusCounts(companyId)).toEqual({ running: 1, queued: 0 });

    const engineerBRun = await seedQueuedRun(companyId, engineerB, "automation", new Date(Date.now() - 60 * 60_000));
    await svc.resumeQueuedRuns();
    const [held] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, engineerBRun));
    expect(held?.status).toBe("queued");

    const timerRunId = await seedQueuedRun(companyId, poster, "timer", new Date());
    await svc.resumeQueuedRuns();
    const [timer] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, timerRunId));
    expect(timer?.status).toBe("running");
    expect(await statusCounts(companyId)).toEqual({ running: 2, queued: 1 });
  }, 60_000);

  it("GEM-1515: a timer wake coalesced into a held process_lost_retry run takes the reserved slot", async () => {
    setFleetEnv({ PAPERCLIP_FLEET_MAX_RUNNING: "2", PAPERCLIP_FLEET_STARTS_PER_10MIN: "0" });
    const companyId = await seedCompany();
    const engineer = await seedAgent(companyId, "Engineer");
    const poster = await seedAgent(companyId, "Edge Threads");
    await seedQueuedRun(companyId, engineer, "assignment", new Date(Date.now() - 90 * 60_000));
    await svc.resumeQueuedRuns();
    expect(await statusCounts(companyId)).toEqual({ running: 1, queued: 0 });

    // Retry from a lost child process: non-timer, attached to the agent's evergreen
    // heartbeat thread (as in prod), so the reserved timer slot holds it.
    const threadIssueId = randomUUID();
    await db.insert(issues).values({
      id: threadIssueId,
      companyId,
      title: "Heartbeat Thread — Edge Threads",
      status: "in_progress",
      priority: "low",
      assigneeAgentId: poster,
    });
    await db.update(agents).set({ heartbeatThreadIssueId: threadIssueId }).where(eq(agents.id, poster));
    const retryRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: retryRunId,
      companyId,
      agentId: poster,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      createdAt: new Date(Date.now() - 7 * 60 * 60_000),
      contextSnapshot: { issueId: threadIssueId, taskId: threadIssueId, taskKey: threadIssueId, heartbeatThread: true },
    });
    await svc.resumeQueuedRuns();
    const [held] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, retryRunId));
    expect(held?.status).toBe("queued");

    // The 19:20 timer slot coalesces into the held retry — it must not be swallowed.
    await svc.wakeup(poster, { source: "timer", triggerDetail: "system", reason: "heartbeat_timer" });
    const [promoted] = await db
      .select({ status: heartbeatRuns.status, source: heartbeatRuns.invocationSource })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, retryRunId));
    expect(promoted).toEqual({ status: "running", source: "timer" });
    expect(await statusCounts(companyId)).toEqual({ running: 2, queued: 0 });
  }, 60_000);

  it("rule 4: a timer whose agent is paused does not block the fleet", async () => {
    setFleetEnv({ PAPERCLIP_FLEET_MAX_RUNNING: "1", PAPERCLIP_FLEET_STARTS_PER_10MIN: "0" });
    const companyId = await seedCompany();
    const backlog = await seedAgent(companyId, "Backlog Engineer");
    const poster = await seedAgent(companyId, "Paused Poster");
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, poster));
    const autoRunId = await seedQueuedRun(companyId, backlog, "automation", new Date(Date.now() - 60 * 60_000));
    await seedQueuedRun(companyId, poster, "timer", new Date());

    await svc.resumeQueuedRuns();
    const [auto] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, autoRunId));
    expect(auto?.status).toBe("running");
  }, 60_000);

  it("rule 3: exempt agents bypass the hourly timer cap", async () => {
    const companyId = await seedCompany();
    setFleetEnv({
      PAPERCLIP_FLEET_MAX_RUNNING: "0",
      PAPERCLIP_FLEET_STARTS_PER_10MIN: "0",
      PAPERCLIP_FLEET_TIMER_WAKES_PER_HOUR: "1",
      PAPERCLIP_FLEET_TIMER_EXEMPT_AGENTS: "VIP Bot",
    });
    await seedAgent(companyId, "Plain A", { cronExpression: "* * * * *" });
    await seedAgent(companyId, "Plain B", { cronExpression: "* * * * *" });
    await seedAgent(companyId, "VIP Bot", { cronExpression: "* * * * *" });

    const result = await svc.tickTimers(new Date());
    expect(result.enqueued).toBe(2);
    expect(result.deferredByFleet).toBe(1);
  }, 60_000);

  it("GEM-1500: tickTimers delays the FIRST tick after restart by each agent's deterministic hash jitter", async () => {
    const companyId = await seedCompany();
    setFleetEnv({
      PAPERCLIP_FLEET_MAX_RUNNING: "0",
      PAPERCLIP_FLEET_STARTS_PER_10MIN: "0",
      PAPERCLIP_FLEET_TIMER_WAKES_PER_HOUR: "0",
      PAPERCLIP_HEARTBEAT_JITTER_MAX_SEC: "30",
    });
    // Create an agent whose deterministic hash jitter is > 0s (retry UUID until jitterSec >= 5).
    let agentId = await seedAgent(companyId, "Jittered Agent", { cronExpression: "* * * * *", catchUpGraceSec: 3600 });
    while (computeAgentHeartbeatJitterSec(agentId, 30) < 5) {
      agentId = await seedAgent(companyId, "Jittered Agent", { cronExpression: "* * * * *", catchUpGraceSec: 3600 });
    }
    // Keep only the chosen agent in this company.
    await db.execute(sql`delete from agents where company_id = ${companyId} and id <> ${agentId}`);
    const jitterMs = computeAgentHeartbeatJitterMs(agentId, 30);

    // Baseline at 08:59:00Z → next cron tick is 09:00:00Z; server restarts at 09:00:40Z.
    await db
      .update(agents)
      .set({ lastHeartbeatAt: new Date("2026-10-18T08:59:00.000Z") })
      .where(eq(agents.id, agentId));
    const processStartMs = Date.parse("2026-10-18T09:00:40.000Z");

    // Immediately at server boot + 1s (before processStartMs + jitterMs): MUST NOT fire yet.
    const tooEarly = await svc.tickTimers(new Date(processStartMs + 1_000), { processStartMs });
    expect(tooEarly.enqueued).toBe(0);

    // At processStartMs + jitterMs: fires on the first eligible post-restart tick.
    const onOffset = await svc.tickTimers(new Date(processStartMs + jitterMs), { processStartMs });
    expect(onOffset.enqueued).toBe(1);
  }, 60_000);
});
