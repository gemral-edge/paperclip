import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { and, count, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, instanceUserRoles, invites } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { readPersistedDevServerStatus, toDevServerHealthStatus } from "../dev-server-status.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { serverVersion } from "../version.js";
import { getLivenessSnapshot, getActionableStaleness } from "../services/liveness-tracker.js";

// Resilience trước Supabase pooler stall (plan 2026-08-16, Codex R1-R3 + Buoc 5.5):
// Trước fix, `/api/health` chạy `SELECT 1` với statement_timeout mặc định (2min) và
// KHÔNG bound client-side → khi pooler stall, mỗi health-check giữ 1 connection trong
// runtime pool (max:10) tới 2min → pool cạn → wedge tự duy trì → chỉ pm2 restart mới gỡ
// (531 crash + watcher 8s treo). Fix: (1) 1 deadline wall-clock tổng cho cả handler
// (< 8s watcher SLA), (2) `SELECT 1` là gate liveness DUY NHẤT, chạy trong transaction
// với `SET LOCAL statement_timeout` để server TỰ HỦY nhanh + nhả connection, (3)
// single-flight coalescing để nhiều health-check đồng thời KHÔNG mở nhiều probe (chống
// tích luỹ connection — Codex F1), (4) enrichment chỉ chạy với budget còn dư (Codex F4).
const HEALTH_DEADLINE_MS = 5000; // tổng cả handler, < 8s HEALTH_TIMEOUT_SEC của watcher
const LIVENESS_PROBE_TIMEOUT_MS = 4000; // SET LOCAL statement_timeout cho SELECT 1
const ENRICHMENT_MIN_BUDGET_MS = 1500; // dưới ngưỡng này thì bỏ enrichment

function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`health_deadline_exceeded:${label}`)), Math.max(0, ms));
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

// Single-flight liveness probe: chỉ 1 `SELECT 1` in-flight tại 1 thời điểm. Các request
// health đồng thời share cùng promise → tối đa 1 connection runtime pool bị health dùng.
// SET LOCAL statement_timeout → server hủy query nếu pooler stall → connection nhả ~4s
// thay vì 2min. Transaction pooler (:6543) hỗ trợ SET LOCAL (transaction-scoped).
let inflightLiveness: Promise<void> | null = null;
function livenessProbe(db: Db): Promise<void> {
  if (!inflightLiveness) {
    // Self-bound: dù transaction có treo mãi (connect black-hole runtime pool không có
    // connect_timeout), withDeadline vẫn reject sau ~probe-timeout+1s → `.finally` LUÔN
    // clear cờ → health tự mở probe mới sau khi pooler hồi phục (KHÔNG kẹt 503 vĩnh viễn).
    inflightLiveness = withDeadline(
      db
        .transaction(async (tx) => {
          await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${LIVENESS_PROBE_TIMEOUT_MS}`));
          await tx.execute(sql`SELECT 1`);
        })
        .then(() => undefined),
      LIVENESS_PROBE_TIMEOUT_MS + 1000,
      "liveness-probe",
    ).finally(() => {
      inflightLiveness = null;
    });
  }
  return inflightLiveness;
}

export function healthRoutes(
  db?: Db,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    authReady: boolean;
    companyDeletionEnabled: boolean;
  } = {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    authReady: true,
    companyDeletionEnabled: true,
  },
) {
  const router = Router();

  router.get("/", async (_req, res) => {
    if (!db) {
      res.json({ status: "ok", version: serverVersion });
      return;
    }

    // Wall-clock deadline cho CẢ handler (< 8s watcher SLA). Mọi await share budget này.
    const startedAt = Date.now();
    const remainingMs = () => HEALTH_DEADLINE_MS - (Date.now() - startedAt);

    // Liveness gate DUY NHẤT: `SELECT 1` qua single-flight + SET LOCAL statement_timeout.
    // Timeout/lỗi → 503 (giữ nguyên contract cũ), KHÔNG treo, KHÔNG giữ connection lâu.
    try {
      await withDeadline(
        livenessProbe(db),
        Math.min(LIVENESS_PROBE_TIMEOUT_MS + 500, remainingMs()),
        "liveness",
      );
    } catch {
      res.status(503).json({
        status: "unhealthy",
        version: serverVersion,
        error: "database_unreachable",
      });
      return;
    }

    // Enrichment (bootstrap + dev-server) = BEST-EFFORT: chỉ chạy nếu còn budget, và mọi
    // lỗi/timeout → BỎ phần đó (KHÔNG fail health). Liveness đã xác nhận ở trên là gate thật.
    let bootstrapStatus: "ready" | "bootstrap_pending" = "ready";
    let bootstrapInviteActive = false;
    if (opts.deploymentMode === "authenticated" && remainingMs() > ENRICHMENT_MIN_BUDGET_MS) {
      try {
        await withDeadline(
          (async () => {
            const roleCount = await db
              .select({ count: count() })
              .from(instanceUserRoles)
              .where(sql`${instanceUserRoles.role} = 'instance_admin'`)
              .then((rows) => Number(rows[0]?.count ?? 0));
            bootstrapStatus = roleCount > 0 ? "ready" : "bootstrap_pending";

            if (bootstrapStatus === "bootstrap_pending") {
              const now = new Date();
              const inviteCount = await db
                .select({ count: count() })
                .from(invites)
                .where(
                  and(
                    eq(invites.inviteType, "bootstrap_ceo"),
                    isNull(invites.revokedAt),
                    isNull(invites.acceptedAt),
                    gt(invites.expiresAt, now),
                  ),
                )
                .then((rows) => Number(rows[0]?.count ?? 0));
              bootstrapInviteActive = inviteCount > 0;
            }
          })(),
          remainingMs(),
          "bootstrap",
        );
      } catch {
        // best-effort: giữ default (ready), không fail health vì enrichment chậm
      }
    }

    const persistedDevServerStatus = readPersistedDevServerStatus();
    let devServer: ReturnType<typeof toDevServerHealthStatus> | undefined;
    if (persistedDevServerStatus && remainingMs() > ENRICHMENT_MIN_BUDGET_MS) {
      try {
        devServer = await withDeadline(
          (async () => {
            const instanceSettings = instanceSettingsService(db);
            const experimentalSettings = await instanceSettings.getExperimental();
            const activeRunCount = await db
              .select({ count: count() })
              .from(heartbeatRuns)
              .where(inArray(heartbeatRuns.status, ["queued", "running"]))
              .then((rows) => Number(rows[0]?.count ?? 0));

            return toDevServerHealthStatus(persistedDevServerStatus, {
              autoRestartEnabled: experimentalSettings.autoRestartDevServerWhenIdle ?? false,
              activeRunCount,
            });
          })(),
          remainingMs(),
          "dev-server",
        );
      } catch {
        // best-effort: bỏ devServer enrichment, vẫn trả status core
      }
    }

    // Background setInterval loops (ZaloListener ping, Zalo health-check,
    // heartbeat scheduler tick) can silently stop while HTTP+DB stay healthy
    // (incident 2026-08-09: watcher never noticed for ~6.5h). Only
    // non-connection-gated loops drive `degraded` — Zalo loops go stale
    // whenever the channel is legitimately disconnected, which must NOT
    // trigger a restart loop that fixes nothing.
    const livenessLoops = getLivenessSnapshot();
    const staleActionable = getActionableStaleness();
    const status = staleActionable.length > 0 ? "degraded" : "ok";

    res.json({
      status,
      version: serverVersion,
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      bootstrapStatus,
      bootstrapInviteActive,
      features: {
        companyDeletionEnabled: opts.companyDeletionEnabled,
      },
      livenessLoops,
      ...(devServer ? { devServer } : {}),
    });
  });

  return router;
}
