/// <reference path="./types/express.d.ts" />

// Global safety net for socket-layer unhandled errors (Zalo TLS WS, Telegram bot,
// outbound webhooks). Without this, a single unhandled 'error' event on any socket
// → process exit code 1 → pm2 restart loop. Pattern 2026-05-05: "Error: write EOF
// at WriteWrap.onWriteComplete" crashed paperclip-server 6+ times until this guard.
// Per-socket listeners (commits 465139ba + 8fbc92d3) cover most cases but Node still
// emits 'error' on the raw TCP socket layer in some peer-RST race paths that bypass
// per-socket handlers.
process.on('uncaughtException', (err: Error & { code?: string }) => {
  console.error('[uncaughtException]', err.code || '', err.message);
  if (err.stack) console.error(err.stack);
  // Swallow benign peer-disconnect codes — non-fatal, should NOT crash server.
  // Real bugs (DB corruption, OOM) still crash via setImmediate re-throw below.
  const benignSocketCodes = new Set(['EOF', 'EPIPE', 'ECONNRESET', 'ENOTCONN', 'EBADF']);
  if (err.code && benignSocketCodes.has(err.code)) return;
  setImmediate(() => { throw err; });
});

process.on('unhandledRejection', (reason: unknown) => {
  console.error('[unhandledRejection]', reason);
});

import { existsSync, readFileSync, rmSync } from "node:fs";
import { createSchedulerHealthAlerts, sendSchedulerAlertTelegram } from "./services/scheduler-health-alert.js";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import type { Request as ExpressRequest, RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import {
  createDb,
  ensurePostgresDatabase,
  formatEmbeddedPostgresError,
  getPostgresDataDirectory,
  inspectMigrations,
  applyPendingMigrations,
  createEmbeddedPostgresLogBuffer,
  reconcilePendingMigrationHistory,
  formatDatabaseBackupResult,
  runDatabaseBackup,
  authUsers,
  companies,
  companyMemberships,
  instanceUserRoles,
} from "@paperclipai/db";
import detectPort from "detect-port";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { logger, redirectStdioToServerLog } from "./middleware/logger.js";
import { setupLiveEventsWebSocketServer } from "./realtime/live-events-ws.js";
import { trainingRouter, setupTrainingWebSocket } from "./training/training-routes.js";
import { heartbeatService, reconcilePersistedRuntimeServicesOnStartup, routineService, scheduledIssueWakeupService } from "./services/index.js";
import {
  SCHEDULER_TICK_JOB_STAGGER_MS,
  computeSchedulerInitialTickDelayMs,
  readFleetThrottleConfig,
} from "./services/fleet-throttle.js";
import { markAlive } from "./services/liveness-tracker.js";
import { startEventLoopMonitor } from "./services/event-loop-monitor.js";
import { configureBreakerPersistence } from "./channels/agy-timeout-fallback.js";
import { resolvePaperclipInstanceRoot } from "./home-paths.js";
import { createStorageServiceFromConfig } from "./storage/index.js";
import { printStartupBanner } from "./startup-banner.js";
import { getBoardClaimWarningUrl, initializeBoardClaimChallenge } from "./board-claim.js";
import { maybePersistWorktreeRuntimePorts } from "./worktree-config.js";

type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;


export interface StartedServer {
  server: ReturnType<typeof createServer>;
  host: string;
  listenPort: number;
  apiUrl: string;
  databaseUrl: string;
}

export async function startServer(): Promise<StartedServer> {
  if (process.env.PAPERCLIP_LOG_STDOUT !== "true" && !process.env.VITEST) {
    redirectStdioToServerLog();
  }
  let config = loadConfig();
  // GEM-1094: trạng thái circuit-breaker provider AI sống qua restart (mạch đang mở thì giữ mở tới hết cooldown).
  configureBreakerPersistence(resolve(resolvePaperclipInstanceRoot(), "data", "provider-breakers.json"));
  if (process.env.PAPERCLIP_SECRETS_PROVIDER === undefined) {
    process.env.PAPERCLIP_SECRETS_PROVIDER = config.secretsProvider;
  }
  if (process.env.PAPERCLIP_SECRETS_STRICT_MODE === undefined) {
    process.env.PAPERCLIP_SECRETS_STRICT_MODE = config.secretsStrictMode ? "true" : "false";
  }
  if (process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE === undefined) {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = config.secretsMasterKeyFilePath;
  }
  
  type MigrationSummary =
    | "skipped"
    | "already applied"
    | "applied (empty database)"
    | "applied (pending migrations)";
  
  function formatPendingMigrationSummary(migrations: string[]): string {
    if (migrations.length === 0) return "none";
    return migrations.length > 3
      ? `${migrations.slice(0, 3).join(", ")} (+${migrations.length - 3} more)`
      : migrations.join(", ");
  }
  
  async function promptApplyMigrations(migrations: string[]): Promise<boolean> {
    if (process.env.PAPERCLIP_MIGRATION_AUTO_APPLY === "true") return true;
    if (process.env.PAPERCLIP_MIGRATION_PROMPT === "never") return false;
    if (!stdin.isTTY || !stdout.isTTY) return true;
  
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      const answer = (await prompt.question(
        `Apply pending migrations (${formatPendingMigrationSummary(migrations)}) now? (y/N): `,
      )).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } finally {
      prompt.close();
    }
  }
  
  type EnsureMigrationsOptions = {
    autoApply?: boolean;
  };
  
  // Startup crash-loop resilience (2026-08-16, plan pooler-stall). Đo thực tế: startup fail
  // NHANH (5-8s) rồi PM2 tự lên lại; retry biến 1 blip-restart thành 1 in-app retry cho stall
  // NGẮN. CHỈ retry lỗi TRANSIENT (pooler stall) — KHÔNG retry lỗi logic (stale schema =
  // từ chối cố ý). connect_timeout ở createUtilitySql lo bound bước connect; PM2
  // exp_backoff_restart_delay+max_restarts lo stall dài. KHÔNG per-attempt-deadline/dispose
  // (Codex F5/F6) vì đo chứng minh multi-minute-hang không xảy ra (Buoc 5.5 scope-cut).
  function isTransientDbError(err: unknown): boolean {
    const e = err as { code?: string; message?: string } | undefined;
    const code = e?.code ?? "";
    if (code === "57014") return true; // canceling statement due to statement timeout
    if (code.startsWith("08")) return true; // connection exception class (08xxx)
    const msg = (e?.message ?? "").toLowerCase();
    return (
      msg.includes("econnreset") ||
      msg.includes("etimedout") ||
      msg.includes("connect_timeout") ||
      msg.includes("connection terminated") ||
      msg.includes("timeout")
    );
  }

  async function retryTransient<T>(
    fn: () => Promise<T>,
    label: string,
    backoffMs: number[] = [3000, 8000],
  ): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (attempt >= backoffMs.length || !isTransientDbError(err)) throw err;
        const delay = backoffMs[attempt];
        attempt += 1;
        logger.warn({ err, label, attempt, delay }, "transient DB error at startup; retrying");
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async function ensureMigrations(
    connectionString: string,
    label: string,
    opts?: EnsureMigrationsOptions,
  ): Promise<MigrationSummary> {
    const autoApply = opts?.autoApply === true;
    let state = await inspectMigrations(connectionString);
    if (state.status === "needsMigrations" && state.reason === "pending-migrations") {
      const repair = await reconcilePendingMigrationHistory(connectionString);
      if (repair.repairedMigrations.length > 0) {
        logger.warn(
          { repairedMigrations: repair.repairedMigrations },
          `${label} had drifted migration history; repaired migration journal entries from existing schema state.`,
        );
        state = await inspectMigrations(connectionString);
        if (state.status === "upToDate") return "already applied";
      }
    }
    if (state.status === "upToDate") return "already applied";
    if (state.status === "needsMigrations" && state.reason === "no-migration-journal-non-empty-db") {
      logger.warn(
        { tableCount: state.tableCount },
        `${label} has existing tables but no migration journal. Run migrations manually to sync schema.`,
      );
      const apply = autoApply ? true : await promptApplyMigrations(state.pendingMigrations);
      if (!apply) {
        throw new Error(
          `${label} has pending migrations (${formatPendingMigrationSummary(state.pendingMigrations)}). ` +
            "Refusing to start against a stale schema. Run pnpm db:migrate or set PAPERCLIP_MIGRATION_AUTO_APPLY=true.",
        );
      }
  
      logger.info({ pendingMigrations: state.pendingMigrations }, `Applying ${state.pendingMigrations.length} pending migrations for ${label}`);
      await applyPendingMigrations(connectionString);
      return "applied (pending migrations)";
    }
  
    const apply = autoApply ? true : await promptApplyMigrations(state.pendingMigrations);
    if (!apply) {
      throw new Error(
        `${label} has pending migrations (${formatPendingMigrationSummary(state.pendingMigrations)}). ` +
          "Refusing to start against a stale schema. Run pnpm db:migrate or set PAPERCLIP_MIGRATION_AUTO_APPLY=true.",
      );
    }
  
    logger.info({ pendingMigrations: state.pendingMigrations }, `Applying ${state.pendingMigrations.length} pending migrations for ${label}`);
    await applyPendingMigrations(connectionString);
    return "applied (pending migrations)";
  }
  
  function isLoopbackHost(host: string): boolean {
    const normalized = host.trim().toLowerCase();
    return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
  }

  function rewriteLocalUrlPort(rawUrl: string | undefined, port: number): string | undefined {
    if (!rawUrl) return undefined;
    try {
      const parsed = new URL(rawUrl);
      if (!isLoopbackHost(parsed.hostname)) return rawUrl;
      parsed.port = String(port);
      return parsed.toString();
    } catch {
      return rawUrl;
    }
  }
  
  const LOCAL_BOARD_USER_ID = "local-board";
  const LOCAL_BOARD_USER_EMAIL = "local@paperclip.local";
  const LOCAL_BOARD_USER_NAME = "Board";
  
  async function ensureLocalTrustedBoardPrincipal(db: any): Promise<void> {
    const now = new Date();
    const existingUser = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.id, LOCAL_BOARD_USER_ID))
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
  
    if (!existingUser) {
      await db.insert(authUsers).values({
        id: LOCAL_BOARD_USER_ID,
        name: LOCAL_BOARD_USER_NAME,
        email: LOCAL_BOARD_USER_EMAIL,
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      });
    }
  
    const role = await db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
    if (!role) {
      await db.insert(instanceUserRoles).values({
        userId: LOCAL_BOARD_USER_ID,
        role: "instance_admin",
      });
    }
  
    const companyRows = await db.select({ id: companies.id }).from(companies);
    for (const company of companyRows) {
      const membership = await db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, company.id),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, LOCAL_BOARD_USER_ID),
          ),
        )
        .then((rows: Array<{ id: string }>) => rows[0] ?? null);
      if (membership) continue;
      await db.insert(companyMemberships).values({
        companyId: company.id,
        principalType: "user",
        principalId: LOCAL_BOARD_USER_ID,
        status: "active",
        membershipRole: "owner",
      });
    }
  }
  
  let db;
  let embeddedPostgres: EmbeddedPostgresInstance | null = null;
  let embeddedPostgresStartedByThisProcess = false;
  let migrationSummary: MigrationSummary = "skipped";
  let activeDatabaseConnectionString: string;
  let resolvedEmbeddedPostgresPort: number | null = null;
  let startupDbInfo:
    | { mode: "external-postgres"; connectionString: string }
    | { mode: "embedded-postgres"; dataDir: string; port: number };
  if (config.databaseUrl) {
    const externalDbUrl = config.databaseUrl;
    migrationSummary = await retryTransient(
      () => ensureMigrations(externalDbUrl, "PostgreSQL"),
      "ensureMigrations(external)",
    );

    db = createDb(config.databaseUrl);
    logger.info("Using external PostgreSQL via DATABASE_URL/config");
    activeDatabaseConnectionString = config.databaseUrl;
    startupDbInfo = { mode: "external-postgres", connectionString: config.databaseUrl };
  } else {
    const moduleName = "embedded-postgres";
    let EmbeddedPostgres: EmbeddedPostgresCtor;
    try {
      const mod = await import(moduleName);
      EmbeddedPostgres = mod.default as EmbeddedPostgresCtor;
    } catch {
      throw new Error(
        "Embedded PostgreSQL mode requires dependency `embedded-postgres`. Reinstall dependencies (without omitting required packages), or set DATABASE_URL for external Postgres.",
      );
    }
  
    const dataDir = resolve(config.embeddedPostgresDataDir);
    const configuredPort = config.embeddedPostgresPort;
    let port = configuredPort;
    const logBuffer = createEmbeddedPostgresLogBuffer(120);
    const verboseEmbeddedPostgresLogs = process.env.PAPERCLIP_EMBEDDED_POSTGRES_VERBOSE === "true";
    const appendEmbeddedPostgresLog = (message: unknown) => {
      logBuffer.append(message);
      if (!verboseEmbeddedPostgresLogs) {
        return;
      }
      const lines = typeof message === "string"
        ? message.split(/\r?\n/)
        : message instanceof Error
          ? [message.message]
          : [String(message ?? "")];
      for (const lineRaw of lines) {
        const line = lineRaw.trim();
        if (!line) continue;
        logger.info({ embeddedPostgresLog: line }, "embedded-postgres");
      }
    };
    const logEmbeddedPostgresFailure = (phase: "initialise" | "start", err: unknown) => {
      const recentLogs = logBuffer.getRecentLogs();
      if (recentLogs.length > 0) {
        logger.error(
          {
            phase,
            recentLogs,
            err,
          },
          "Embedded PostgreSQL failed; showing buffered startup logs",
        );
      }
    };
  
    if (config.databaseMode === "postgres") {
      logger.warn("Database mode is postgres but no connection string was set; falling back to embedded PostgreSQL");
    }
  
    const clusterVersionFile = resolve(dataDir, "PG_VERSION");
    const clusterAlreadyInitialized = existsSync(clusterVersionFile);
    const postmasterPidFile = resolve(dataDir, "postmaster.pid");
    const isPidRunning = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
  
    const getRunningPid = (): number | null => {
      if (!existsSync(postmasterPidFile)) return null;
      try {
        const pidLine = readFileSync(postmasterPidFile, "utf8").split("\n")[0]?.trim();
        const pid = Number(pidLine);
        if (!Number.isInteger(pid) || pid <= 0) return null;
        if (!isPidRunning(pid)) return null;
        return pid;
      } catch {
        return null;
      }
    };
  
    const runningPid = getRunningPid();
    if (runningPid) {
      logger.warn(`Embedded PostgreSQL already running; reusing existing process (pid=${runningPid}, port=${port})`);
    } else {
      const configuredAdminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${configuredPort}/postgres`;
      try {
        const actualDataDir = await getPostgresDataDirectory(configuredAdminConnectionString);
        if (
          typeof actualDataDir !== "string" ||
          resolve(actualDataDir) !== resolve(dataDir)
        ) {
          throw new Error("reachable postgres does not use the expected embedded data directory");
        }
        await ensurePostgresDatabase(configuredAdminConnectionString, "paperclip");
        logger.warn(
          `Embedded PostgreSQL appears to already be reachable without a pid file; reusing existing server on configured port ${configuredPort}`,
        );
      } catch {
        const detectedPort = await detectPort(configuredPort);
        if (detectedPort !== configuredPort) {
          logger.warn(`Embedded PostgreSQL port is in use; using next free port (requestedPort=${configuredPort}, selectedPort=${detectedPort})`);
        }
        port = detectedPort;
        logger.info(`Using embedded PostgreSQL because no DATABASE_URL set (dataDir=${dataDir}, port=${port})`);
        embeddedPostgres = new EmbeddedPostgres({
          databaseDir: dataDir,
          user: "paperclip",
          password: "paperclip",
          port,
          persistent: true,
          initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
          onLog: appendEmbeddedPostgresLog,
          onError: appendEmbeddedPostgresLog,
        });

        if (!clusterAlreadyInitialized) {
          try {
            await embeddedPostgres.initialise();
          } catch (err) {
            logEmbeddedPostgresFailure("initialise", err);
            throw formatEmbeddedPostgresError(err, {
              fallbackMessage: `Failed to initialize embedded PostgreSQL cluster in ${dataDir} on port ${port}`,
              recentLogs: logBuffer.getRecentLogs(),
            });
          }
        } else {
          logger.info(`Embedded PostgreSQL cluster already exists (${clusterVersionFile}); skipping init`);
        }

        if (existsSync(postmasterPidFile)) {
          logger.warn("Removing stale embedded PostgreSQL lock file");
          rmSync(postmasterPidFile, { force: true });
        }
        try {
          await embeddedPostgres.start();
        } catch (err) {
          logEmbeddedPostgresFailure("start", err);
          throw formatEmbeddedPostgresError(err, {
            fallbackMessage: `Failed to start embedded PostgreSQL on port ${port}`,
            recentLogs: logBuffer.getRecentLogs(),
          });
        }
        embeddedPostgresStartedByThisProcess = true;
      }
    }
  
    const embeddedAdminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    const dbStatus = await ensurePostgresDatabase(embeddedAdminConnectionString, "paperclip");
    if (dbStatus === "created") {
      logger.info("Created embedded PostgreSQL database: paperclip");
    }
  
    const embeddedConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    const shouldAutoApplyFirstRunMigrations = !clusterAlreadyInitialized || dbStatus === "created";
    if (shouldAutoApplyFirstRunMigrations) {
      logger.info("Detected first-run embedded PostgreSQL setup; applying pending migrations automatically");
    }
    migrationSummary = await ensureMigrations(embeddedConnectionString, "Embedded PostgreSQL", {
      autoApply: shouldAutoApplyFirstRunMigrations,
    });
  
    db = createDb(embeddedConnectionString);
    logger.info("Embedded PostgreSQL ready");
    activeDatabaseConnectionString = embeddedConnectionString;
    resolvedEmbeddedPostgresPort = port;
    startupDbInfo = { mode: "embedded-postgres", dataDir, port };
  }
  
  if (config.deploymentMode === "local_trusted" && !isLoopbackHost(config.host)) {
    throw new Error(
      `local_trusted mode requires loopback host binding (received: ${config.host}). ` +
        "Use authenticated mode for non-loopback deployments.",
    );
  }
  
  if (config.deploymentMode === "local_trusted" && config.deploymentExposure !== "private") {
    throw new Error("local_trusted mode only supports private exposure");
  }
  
  if (config.deploymentMode === "authenticated") {
    if (config.authBaseUrlMode === "explicit" && !config.authPublicBaseUrl) {
      throw new Error("auth.baseUrlMode=explicit requires auth.publicBaseUrl");
    }
    if (config.deploymentExposure === "public") {
      if (config.authBaseUrlMode !== "explicit") {
        throw new Error("authenticated public exposure requires auth.baseUrlMode=explicit");
      }
      if (!config.authPublicBaseUrl) {
        throw new Error("authenticated public exposure requires auth.publicBaseUrl");
      }
    }
  }
  
  let authReady = config.deploymentMode === "local_trusted";
  let betterAuthHandler: RequestHandler | undefined;
  let resolveSession:
    | ((req: ExpressRequest) => Promise<BetterAuthSessionResult | null>)
    | undefined;
  let resolveSessionFromHeaders:
    | ((headers: Headers) => Promise<BetterAuthSessionResult | null>)
    | undefined;
  if (config.deploymentMode === "local_trusted") {
    // F5 (plan 2026-08-18 pooler-stall): startup bootstrap DB (insert board principal/company)
    // là await DUY NHẤT trên startup path có thể ném 57014 khi Supabase pooler stall TỪNG LÚC —
    // ném = startServer().catch() → "Paperclip server failed to start" → PM2 restart, rồi lỗi
    // 57014 cũ rò tiếp sang tiến trình mới → restart ĐÚP (đo pm2.log 18:08/20:08/21:02 17/08:
    // cặp exit cách 6-7s). Bọc retryTransient (đã dùng cho ensureMigrations, BUG-082) → chỉ retry
    // lỗi transient (57014/08xxx/timeout), KHÔNG retry lỗi logic → startup vượt qua pooler-stall
    // thoáng qua thay vì chết + restart-storm.
    await retryTransient(
      () => ensureLocalTrustedBoardPrincipal(db as any),
      "ensureLocalTrustedBoardPrincipal",
    );
  }
  if (config.deploymentMode === "authenticated") {
    const {
      createBetterAuthHandler,
      createBetterAuthInstance,
      deriveAuthTrustedOrigins,
      resolveBetterAuthSession,
      resolveBetterAuthSessionFromHeaders,
    } = await import("./auth/better-auth.js");
    const betterAuthSecret =
      process.env.BETTER_AUTH_SECRET?.trim() ?? process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim();
    if (!betterAuthSecret) {
      throw new Error(
        "authenticated mode requires BETTER_AUTH_SECRET (or PAPERCLIP_AGENT_JWT_SECRET) to be set",
      );
    }
    const derivedTrustedOrigins = deriveAuthTrustedOrigins(config);
    const envTrustedOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const effectiveTrustedOrigins = Array.from(new Set([...derivedTrustedOrigins, ...envTrustedOrigins]));
    logger.info(
      {
        authBaseUrlMode: config.authBaseUrlMode,
        authPublicBaseUrl: config.authPublicBaseUrl ?? null,
        trustedOrigins: effectiveTrustedOrigins,
        trustedOriginsSource: {
          derived: derivedTrustedOrigins.length,
          env: envTrustedOrigins.length,
        },
      },
      "Authenticated mode auth origin configuration",
    );
    const auth = createBetterAuthInstance(db as any, config, effectiveTrustedOrigins);
    betterAuthHandler = createBetterAuthHandler(auth);
    resolveSession = (req) => resolveBetterAuthSession(auth, req);
    resolveSessionFromHeaders = (headers) => resolveBetterAuthSessionFromHeaders(auth, headers);
    await initializeBoardClaimChallenge(db as any, { deploymentMode: config.deploymentMode });
    authReady = true;
  }
  
  const listenPort = await detectPort(config.port);
  if (listenPort !== config.port) {
    config.port = listenPort;
  }
  if (resolvedEmbeddedPostgresPort !== null && resolvedEmbeddedPostgresPort !== config.embeddedPostgresPort) {
    config.embeddedPostgresPort = resolvedEmbeddedPostgresPort;
  }
  if (config.authBaseUrlMode === "explicit" && config.authPublicBaseUrl) {
    config.authPublicBaseUrl = rewriteLocalUrlPort(config.authPublicBaseUrl, listenPort);
  }
  maybePersistWorktreeRuntimePorts({
    serverPort: listenPort,
    databasePort: resolvedEmbeddedPostgresPort,
  });
  const uiMode = config.uiDevMiddleware ? "vite-dev" : config.serveUi ? "static" : "none";
  const storageService = createStorageServiceFromConfig(config);
  const app = await createApp(db as any, {
    uiMode,
    serverPort: listenPort,
    storageService,
    deploymentMode: config.deploymentMode,
    deploymentExposure: config.deploymentExposure,
    allowedHostnames: config.allowedHostnames,
    bindHost: config.host,
    authReady,
    companyDeletionEnabled: config.companyDeletionEnabled,
    betterAuthHandler,
    resolveSession,
  });
  const server = createServer(app as unknown as Parameters<typeof createServer>[0]);
  
  if (listenPort !== config.port) {
    logger.warn(`Requested port is busy; using next free port (requestedPort=${config.port}, selectedPort=${listenPort})`);
  }
  
  const runtimeListenHost = config.host;
  const runtimeApiHost =
    runtimeListenHost === "0.0.0.0" || runtimeListenHost === "::"
      ? "localhost"
      : runtimeListenHost;
  process.env.PAPERCLIP_LISTEN_HOST = runtimeListenHost;
  process.env.PAPERCLIP_LISTEN_PORT = String(listenPort);
  process.env.PAPERCLIP_API_URL = `http://${runtimeApiHost}:${listenPort}`;
  
  setupLiveEventsWebSocketServer(server, db as any, {
    deploymentMode: config.deploymentMode,
    resolveSessionFromHeaders,
  });

  // Training Room — REST + WebSocket live stream (Sprint B2 + B3 + C1)
  setupTrainingWebSocket(server);

  void reconcilePersistedRuntimeServicesOnStartup(db as any)
    .then((result) => {
      if (result.reconciled > 0) {
        logger.warn(
          { reconciled: result.reconciled },
          "reconciled persisted runtime services from a previous server process",
        );
      }
    })
    .catch((err) => {
      logger.error({ err }, "startup reconciliation of persisted runtime services failed");
    });
  
  if (config.heartbeatSchedulerEnabled) {
    const heartbeat = heartbeatService(db as any);
    const routines = routineService(db as any);
    const scheduledIssueWakeups = scheduledIssueWakeupService(db as any, { heartbeat });
  
    // Reap orphaned running runs at startup while in-memory execution state is empty,
    // then resume any persisted queued runs that were waiting on the previous process.
    void heartbeat
      .reapOrphanedRuns()
      .then(() => heartbeat.resumeQueuedRuns())
      .catch((err) => {
        logger.error({ err }, "startup heartbeat recovery failed");
      });

    // F1 (plan 2026-08-18 pooler-stall): SINGLE-FLIGHT per tick job. Trước fix, mỗi 30s
    // setInterval ném 4 job DB (tickTimers / tickScheduledTriggers / tickScheduledIssueWakeups /
    // reap+resume) BẤT KỂ lần trước xong chưa. Khi Supabase Micro swap-thrash làm 1 job treo,
    // các lần tick sau chồng thêm query → runtime pool (max:10) cạn → pool wedge → /api/health 503
    // → restart. Guard này bỏ qua job nếu lần trước CHƯA settle (kèm cảnh báo tuổi) → tối đa 1
    // in-flight/job → pool luôn còn slot cho health/API. Cùng pattern `backupInFlight` dưới.
    // markAlive CHỈ gọi khi tick THẬT SỰ settle (không gọi lúc skip) — job treo mãi = không
    // markAlive = liveness-tracker bắt đúng (incident 2026-08-09). Với F2 (boundedPoll 15s) một
    // job treo sẽ settle trong ~15s → markAlive lại → không báo degraded oan.
    const tickInFlight: Record<string, number | null> = {
      timers: null,
      routines: null,
      wakeups: null,
      recovery: null,
    };
    const SCHEDULER_TICK_JOB_TIMEOUT_MS = 60_000;
    // GEM-1443: Telegram when ticks keep timing out or cron slots get dropped mid-uptime.
    const schedulerAlerts = createSchedulerHealthAlerts({
      processStartMs: Date.now(),
      send: sendSchedulerAlertTelegram,
    });
    const runTickJob = (
      key: string,
      label: string,
      fn: () => Promise<void>,
      onSettle?: () => void,
      onError?: (err: unknown) => void,
    ): void => {
      const startedTickAt = Date.now();
      const inFlightSince = tickInFlight[key];
      if (inFlightSince !== null) {
        if (startedTickAt - inFlightSince > SCHEDULER_TICK_JOB_TIMEOUT_MS) {
          logger.warn(
            { job: key, inFlightMs: startedTickAt - inFlightSince, limitMs: SCHEDULER_TICK_JOB_TIMEOUT_MS },
            `${label} tick in-flight TTL expired (> ${SCHEDULER_TICK_JOB_TIMEOUT_MS}ms) — releasing stuck lock`,
          );
          tickInFlight[key] = null;
        } else {
          logger.warn(
            { job: key, inFlightMs: startedTickAt - inFlightSince },
            `${label} tick skipped — previous run still in-flight (pile-up guard F1)`,
          );
          return;
        }
      }
      tickInFlight[key] = startedTickAt;

      const timeoutPromise = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`${label} tick timed out after ${SCHEDULER_TICK_JOB_TIMEOUT_MS}ms`));
        }, SCHEDULER_TICK_JOB_TIMEOUT_MS);
        timer.unref?.();
      });

      void Promise.race([fn(), timeoutPromise])
        .catch((err) => {
          logger.error({ err }, `${label} tick failed`);
          onError?.(err);
        })
        .finally(() => {
          if (tickInFlight[key] === startedTickAt) {
            tickInFlight[key] = null;
          }
          onSettle?.();
        });
    };

    const scheduleStaggeredTickJob = (
      key: keyof typeof SCHEDULER_TICK_JOB_STAGGER_MS,
      label: string,
      fn: () => Promise<void>,
      onSettle?: () => void,
      onError?: (err: unknown) => void,
    ): void => {
      const staggerMs = SCHEDULER_TICK_JOB_STAGGER_MS[key] ?? 0;
      if (staggerMs <= 0) {
        runTickJob(key, label, fn, onSettle, onError);
        return;
      }
      const timer = setTimeout(() => {
        runTickJob(key, label, fn, onSettle, onError);
      }, staggerMs);
      timer.unref?.();
    };

    const dispatchStaggeredSchedulerTick = () => {
      scheduleStaggeredTickJob(
        "timers",
        "heartbeat timer",
        () =>
          heartbeat.tickTimers(new Date()).then((result) => {
            if (result.enqueued > 0) {
              logger.info({ ...result }, "heartbeat timer tick enqueued runs");
            }
            // GEM-1443: measurable tick latency (target p95 < 10s); probe reads this line.
            if (result.durationMs > 10_000) {
              logger.warn({ ...result }, "heartbeat timer tick slow");
            }
            schedulerAlerts.recordStaleSkip(result.staleSkipped);
          }),
        // Mark alive on settle (success OR failure), not on invocation — a hung promise
        // that never settles is exactly the failure mode this catches (incident 2026-08-09).
        () => markAlive("heartbeat-scheduler-tick"),
        (err) => {
          if (err instanceof Error && err.message.includes("tick timed out")) schedulerAlerts.recordTickTimeout();
        },
      );

      scheduleStaggeredTickJob("routines", "routine scheduler", () =>
        routines.tickScheduledTriggers(new Date()).then((result) => {
          if (result.triggered > 0) {
            logger.info({ ...result }, "routine scheduler tick enqueued runs");
          }
        }),
      );

      scheduleStaggeredTickJob("wakeups", "scheduled issue wake", () =>
        scheduledIssueWakeups.tickScheduledIssueWakeups(new Date()).then((result) => {
          if (result.due > 0) {
            logger.info({ ...result }, "scheduled issue wake tick fired");
          }
        }),
      );

      // Periodically reap orphaned runs (5-min staleness threshold) and make sure
      // persisted queued work is still being driven forward.
      scheduleStaggeredTickJob("recovery", "periodic heartbeat recovery", () =>
        heartbeat
          .reapOrphanedRuns({ staleThresholdMs: 5 * 60 * 1000 })
          .then(() => heartbeat.resumeQueuedRuns()),
      );
    };

    // GEM-1500: Apply deterministic initial jitter to the first post-restart tick cycle
    // and stagger the 4 DB jobs inside each interval so PgBouncer never receives a 4-way
    // burst on the same millisecond.
    const initialTickDelayMs = computeSchedulerInitialTickDelayMs(
      config.heartbeatSchedulerIntervalMs,
      process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "paperclip-server",
      readFleetThrottleConfig().heartbeatJitterMaxSec,
    );
    const initialTickTimer = setTimeout(() => {
      dispatchStaggeredSchedulerTick();
      setInterval(dispatchStaggeredSchedulerTick, config.heartbeatSchedulerIntervalMs);
    }, initialTickDelayMs);
    initialTickTimer.unref?.();
  }
  
  if (config.databaseBackupEnabled) {
    const backupIntervalMs = config.databaseBackupIntervalMinutes * 60 * 1000;
    let backupInFlight = false;
  
    const runScheduledBackup = async () => {
      if (backupInFlight) {
        logger.warn("Skipping scheduled database backup because a previous backup is still running");
        return;
      }
  
      backupInFlight = true;
      try {
        const result = await runDatabaseBackup({
          connectionString: activeDatabaseConnectionString,
          backupDir: config.databaseBackupDir,
          retentionDays: config.databaseBackupRetentionDays,
          filenamePrefix: "paperclip",
        });
        logger.info(
          {
            backupFile: result.backupFile,
            sizeBytes: result.sizeBytes,
            prunedCount: result.prunedCount,
            backupDir: config.databaseBackupDir,
            retentionDays: config.databaseBackupRetentionDays,
          },
          `Automatic database backup complete: ${formatDatabaseBackupResult(result)}`,
        );
      } catch (err) {
        logger.error({ err, backupDir: config.databaseBackupDir }, "Automatic database backup failed");
      } finally {
        backupInFlight = false;
      }
    };
  
    logger.info(
      {
        intervalMinutes: config.databaseBackupIntervalMinutes,
        retentionDays: config.databaseBackupRetentionDays,
        backupDir: config.databaseBackupDir,
      },
      "Automatic database backups enabled",
    );
    setInterval(() => {
      void runScheduledBackup();
    }, backupIntervalMs);
  }
  
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: Error) => {
      server.off("error", onError);
      rejectListen(err);
    };

    server.once("error", onError);
    server.listen(listenPort, config.host, () => {
      server.off("error", onError);
      logger.info(`Server listening on ${config.host}:${listenPort}`);
      startEventLoopMonitor();
      if (process.env.PAPERCLIP_OPEN_ON_LISTEN === "true") {
        const openHost = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
        const url = `http://${openHost}:${listenPort}`;
        void import("open")
          .then((mod) => mod.default(url))
          .then(() => {
            logger.info(`Opened browser at ${url}`);
          })
          .catch((err) => {
            logger.warn({ err, url }, "Failed to open browser on startup");
          });
      }
      printStartupBanner({
        host: config.host,
        deploymentMode: config.deploymentMode,
        deploymentExposure: config.deploymentExposure,
        authReady,
        requestedPort: config.port,
        listenPort,
        uiMode,
        db: startupDbInfo,
        migrationSummary,
        heartbeatSchedulerEnabled: config.heartbeatSchedulerEnabled,
        heartbeatSchedulerIntervalMs: config.heartbeatSchedulerIntervalMs,
        databaseBackupEnabled: config.databaseBackupEnabled,
        databaseBackupIntervalMinutes: config.databaseBackupIntervalMinutes,
        databaseBackupRetentionDays: config.databaseBackupRetentionDays,
        databaseBackupDir: config.databaseBackupDir,
      });

      const boardClaimUrl = getBoardClaimWarningUrl(config.host, listenPort);
      if (boardClaimUrl) {
        const red = "\x1b[41m\x1b[30m";
        const yellow = "\x1b[33m";
        const reset = "\x1b[0m";
        console.log(
          [
            `${red}  BOARD CLAIM REQUIRED  ${reset}`,
            `${yellow}This instance was previously local_trusted and still has local-board as the only admin.${reset}`,
            `${yellow}Sign in with a real user and open this one-time URL to claim ownership:${reset}`,
            `${yellow}${boardClaimUrl}${reset}`,
            `${yellow}If you are connecting over Tailscale, replace the host in this URL with your Tailscale IP/MagicDNS name.${reset}`,
          ].join("\n"),
        );
      }

      resolveListen();
    });
  });
  
  if (embeddedPostgres && embeddedPostgresStartedByThisProcess) {
    const shutdown = async (signal: "SIGINT" | "SIGTERM") => {
      logger.info({ signal }, "Stopping embedded PostgreSQL");
      try {
        await embeddedPostgres?.stop();
      } catch (err) {
        logger.error({ err }, "Failed to stop embedded PostgreSQL cleanly");
      } finally {
        process.exit(0);
      }
    };
  
    process.once("SIGINT", () => {
      void shutdown("SIGINT");
    });
    process.once("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
  }

  return {
    server,
    host: config.host,
    listenPort,
    apiUrl: process.env.PAPERCLIP_API_URL ?? `http://${runtimeApiHost}:${listenPort}`,
    databaseUrl: activeDatabaseConnectionString,
  };
}

function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === metaUrl;
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  void startServer().catch((err) => {
    logger.error({ err }, "Paperclip server failed to start");
    process.exit(1);
  });
}
