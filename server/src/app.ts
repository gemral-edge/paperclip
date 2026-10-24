import express, { Router, type Request as ExpressRequest } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import type { StorageService } from "./storage/types.js";
import { httpLogger, errorHandler } from "./middleware/index.js";
import { actorMiddleware } from "./middleware/auth.js";
import { boardMutationGuard } from "./middleware/board-mutation-guard.js";
import { remoteApiKeyGuard } from "./middleware/remote-api-key-guard.js";
import { privateHostnameGuard, resolvePrivateHostnameAllowSet } from "./middleware/private-hostname-guard.js";
import { healthRoutes } from "./routes/health.js";
import { companyRoutes } from "./routes/companies.js";
import { companySkillRoutes } from "./routes/company-skills.js";
import { agentRoutes } from "./routes/agents.js";
import { projectRoutes } from "./routes/projects.js";
import { issueRoutes } from "./routes/issues.js";
import { delegationRoutes } from "./routes/delegations.js";
import { routineRoutes } from "./routes/routines.js";
import { timetableRoutes } from "./routes/timetable.js";
import { executionWorkspaceRoutes } from "./routes/execution-workspaces.js";
import { goalRoutes } from "./routes/goals.js";
import { approvalRoutes } from "./routes/approvals.js";
import { secretRoutes } from "./routes/secrets.js";
import { costRoutes } from "./routes/costs.js";
import { activityRoutes } from "./routes/activity.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { sidebarBadgeRoutes } from "./routes/sidebar-badges.js";
import { instanceSettingsRoutes } from "./routes/instance-settings.js";
import { toolsRoutes } from "./routes/tools.js";
import { llmRoutes } from "./routes/llms.js";
import { assetRoutes } from "./routes/assets.js";
import { accessRoutes } from "./routes/access.js";
import { pluginRoutes } from "./routes/plugins.js";
import { pluginUiStaticRoutes } from "./routes/plugin-ui-static.js";
import zaloPersonalRoutes, { restoreChannels } from "./channels/zalo-personal/routes.js";
import channelRoutes from "./channels/routes.js";
import agentConfigRoutes from "./channels/agent-config-routes.js";
import qaRoutes from "./channels/qa-routes.js";
import facebookWebhook from "./channels/facebook/webhook.js";
import threadsRoutes from "./channels/threads/routes.js";
import { startThreadsTokenRefresher } from "./channels/threads/token-store.js";
import facebookWebRoutes, { resumeAllFacebookWebChannels } from "./channels/facebook-web/routes.js";
import { cskhRouter, resumeCskhChannel } from "./channels/cskh/routes.js";
import youtubeRoutes from "./channels/youtube/routes.js";
import crmRoutes from "./channels/crm/crm-routes.js";
import ticketRoutes from "./channels/crm/ticket-routes.js";
import orderRoutes from "./channels/crm/order-routes.js";
import kbRoutes from "./channels/crm/knowledge-base/kb-routes.js";
import trackingRoutes from "./channels/crm/tracking/tracking-routes.js";
import conversationRoutes from "./channels/conversation-routes.js";
import opsRoutes from "./channels/ops-routes.js";
import ccDbProxy from "./channels/cc-db-proxy.js";
import sopEngineRoutes from "./channels/sop-engine-routes.js";
import cronRegistryRoutes from "./channels/cron-registry-routes.js";
import registryMarketplaceRoutes from "./channels/registry-marketplace-routes.js";
import kgRoutes from "./channels/kg-routes.js";
import socialRoutes from "./channels/social-routes.js";
import socialAnalyticsRoutes from "./channels/social-analytics-routes.js";
import systemRoutes from "./routes/system-routes.js";
import { applyUiBranding } from "./ui-branding.js";
import { logger } from "./middleware/logger.js";
import { DEFAULT_LOCAL_PLUGIN_DIR, pluginLoader } from "./services/plugin-loader.js";
import { createPluginWorkerManager } from "./services/plugin-worker-manager.js";
import { createPluginJobScheduler } from "./services/plugin-job-scheduler.js";
import { pluginJobStore } from "./services/plugin-job-store.js";
import { createPluginToolDispatcher } from "./services/plugin-tool-dispatcher.js";
import { pluginLifecycleManager } from "./services/plugin-lifecycle.js";
import { createPluginJobCoordinator } from "./services/plugin-job-coordinator.js";
import { buildHostServices, flushPluginLogBuffer } from "./services/plugin-host-services.js";
import { createPluginEventBus } from "./services/plugin-event-bus.js";
import { setPluginEventBus } from "./services/activity-log.js";
import { createPluginDevWatcher } from "./services/plugin-dev-watcher.js";
import { createPluginHostServiceCleanup } from "./services/plugin-host-service-cleanup.js";
import { pluginRegistryService } from "./services/plugin-registry.js";
import { createHostClientHandlers } from "@paperclipai/plugin-sdk";
import type { BetterAuthSessionResult } from "./auth/better-auth.js";

type UiMode = "none" | "static" | "vite-dev";

export function resolveViteHmrPort(serverPort: number): number {
  if (serverPort <= 55_535) {
    return serverPort + 10_000;
  }
  return Math.max(1_024, serverPort - 10_000);
}

export async function createApp(
  db: Db,
  opts: {
    uiMode: UiMode;
    serverPort: number;
    storageService: StorageService;
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    allowedHostnames: string[];
    bindHost: string;
    authReady: boolean;
    companyDeletionEnabled: boolean;
    instanceId?: string;
    hostVersion?: string;
    localPluginDir?: string;
    betterAuthHandler?: express.RequestHandler;
    resolveSession?: (req: ExpressRequest) => Promise<BetterAuthSessionResult | null>;
  },
) {
  const app = express();

  app.use(express.json({
    // Company import/export payloads can inline full portable packages.
    limit: "10mb",
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    },
  }));
  app.use(httpLogger);
  const privateHostnameGateEnabled =
    opts.deploymentMode === "authenticated" && opts.deploymentExposure === "private";
  const privateHostnameAllowSet = resolvePrivateHostnameAllowSet({
    allowedHostnames: opts.allowedHostnames,
    bindHost: opts.bindHost,
  });
  app.use(
    privateHostnameGuard({
      enabled: privateHostnameGateEnabled,
      allowedHostnames: opts.allowedHostnames,
      bindHost: opts.bindHost,
    }),
  );
  app.use(
    actorMiddleware(db, {
      deploymentMode: opts.deploymentMode,
      resolveSession: opts.resolveSession,
    }),
  );
  app.get("/api/auth/get-session", (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    res.json({
      session: {
        id: `paperclip:${req.actor.source}:${req.actor.userId}`,
        userId: req.actor.userId,
      },
      user: {
        id: req.actor.userId,
        email: null,
        name: req.actor.source === "local_implicit" ? "Local Board" : null,
      },
    });
  });
  if (opts.betterAuthHandler) {
    app.all("/api/auth/*authPath", opts.betterAuthHandler);
  }
  app.use(llmRoutes(db));

  // Mount API routes
  const api = Router();
  api.use(boardMutationGuard());
  // Require PAPERCLIP_API_KEY for REMOTE (Cloudflare-tunnel) requests so the public
  // gemops.gemcapitalholding.com hostname cannot reach the control plane unauthenticated.
  // Local (loopback) requests and self-authenticating webhooks are exempt.
  api.use(remoteApiKeyGuard(process.env.PAPERCLIP_REMOTE_API_KEY || ""));
  api.use(
    "/health",
    healthRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      companyDeletionEnabled: opts.companyDeletionEnabled,
    }),
  );
  api.use("/companies", companyRoutes(db, opts.storageService));
  api.use(companySkillRoutes(db));
  api.use(agentRoutes(db));
  api.use(assetRoutes(db, opts.storageService));
  api.use(projectRoutes(db));
  api.use(issueRoutes(db, opts.storageService));
  api.use(delegationRoutes(db));
  api.use(routineRoutes(db));
  api.use(timetableRoutes(db));
  api.use(executionWorkspaceRoutes(db));
  api.use(goalRoutes(db));
  api.use(approvalRoutes(db));
  api.use(secretRoutes(db));
  api.use(costRoutes(db));
  api.use(activityRoutes(db));
  api.use(dashboardRoutes(db));
  api.use(sidebarBadgeRoutes(db));
  api.use(instanceSettingsRoutes(db));
  api.use("/tools", toolsRoutes());
  const hostServicesDisposers = new Map<string, () => void>();
  const workerManager = createPluginWorkerManager();
  const pluginRegistry = pluginRegistryService(db);
  const eventBus = createPluginEventBus();
  setPluginEventBus(eventBus);
  const jobStore = pluginJobStore(db);
  const lifecycle = pluginLifecycleManager(db, { workerManager });
  const scheduler = createPluginJobScheduler({
    db,
    jobStore,
    workerManager,
  });
  const toolDispatcher = createPluginToolDispatcher({
    workerManager,
    lifecycleManager: lifecycle,
    db,
  });
  const jobCoordinator = createPluginJobCoordinator({
    db,
    lifecycle,
    scheduler,
    jobStore,
  });
  const hostServiceCleanup = createPluginHostServiceCleanup(lifecycle, hostServicesDisposers);
  const loader = pluginLoader(
    db,
    { localPluginDir: opts.localPluginDir ?? DEFAULT_LOCAL_PLUGIN_DIR },
    {
      workerManager,
      eventBus,
      jobScheduler: scheduler,
      jobStore,
      toolDispatcher,
      lifecycleManager: lifecycle,
      instanceInfo: {
        instanceId: opts.instanceId ?? "default",
        hostVersion: opts.hostVersion ?? "0.0.0",
      },
      buildHostHandlers: (pluginId, manifest) => {
        const notifyWorker = (method: string, params: unknown) => {
          const handle = workerManager.getWorker(pluginId);
          if (handle) handle.notify(method, params);
        };
        const services = buildHostServices(db, pluginId, manifest.id, eventBus, notifyWorker);
        hostServicesDisposers.set(pluginId, () => services.dispose());
        return createHostClientHandlers({
          pluginId,
          capabilities: manifest.capabilities,
          services,
        });
      },
    },
  );
  api.use(
    pluginRoutes(
      db,
      loader,
      { scheduler, jobStore },
      { workerManager },
      { toolDispatcher },
      { workerManager },
    ),
  );
  api.use(
    accessRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      bindHost: opts.bindHost,
      allowedHostnames: opts.allowedHostnames,
    }),
  );
  api.use("/channels/facebook", facebookWebhook);
  api.use("/channels/threads", threadsRoutes);
  api.use("/channels/facebook-web", facebookWebRoutes);
  api.use("/channels/cskh", cskhRouter);
  api.use("/channels/youtube", youtubeRoutes);
  api.use("/channels/zalo-personal", zaloPersonalRoutes);
  api.use("/channels/agent-configs", agentConfigRoutes);
  api.use("/channels/qa", qaRoutes);
  api.use("/channels/crm", crmRoutes);
  api.use("/channels/crm/tickets", ticketRoutes);
  api.use("/channels/crm/orders", orderRoutes);
  api.use("/channels/crm/kb", kbRoutes);
  api.use("/channels/tracking", trackingRoutes);
  api.use("/channels/conversations", conversationRoutes);
  api.use("/cc-db", ccDbProxy); // GEM-1069: đường service_role cho cc_email_sends/cc_generation_jobs (thay policy anon)
  api.use("/ops", opsRoutes);
  api.use("/ops/sop-engine", sopEngineRoutes);
  api.use("/registry/crons", cronRegistryRoutes);
  api.use("/registry", registryMarketplaceRoutes);
  api.use("/ops/kg", kgRoutes);
  api.use("/", socialRoutes); // /api/social/publish, /api/news/publish, /api/social/pages
  api.use("/social-analytics", socialAnalyticsRoutes);

  // Phong Thuy De Vuong AI Chat — Claude CLI spawn via tunnel
  api.post("/ai/phong-thuy-chat", async (req, res) => {
    const { spawn } = await import("child_process");
    const { message, context, history, model: requestModel } = req.body;
    if (!message) return res.status(400).json({ error: "Missing message" });

    // CORS for Vercel frontend
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // Build prompt
    const parts = [
      "# Phong Thuỷ Đế Vương — Trợ Lý Tâm Linh AI\n",
      "Bạn là trợ lý AI chuyên về Phong Thuỷ, Tử Vi, Bát Tự, và tâm linh Việt Nam.",
      "Trả lời bằng tiếng Việt có dấu. Dùng markdown format đẹp.",
      "Tone: Uyên bác nhưng gần gũi.\n",
    ];
    if (context?.contextLabel) {
      parts.push(`## Bối cảnh\nNgười dùng đang xem: **${context.contextLabel}**`);
    }
    if (context?.contextData) {
      const d = context.contextData;
      const info = [d.full_name, d.gender, d.date_of_birth, d.menh, d.cung_menh].filter(Boolean).join(", ");
      if (info) parts.push(`Dữ liệu: ${info}`);
    }
    const historyText = (history || []).slice(-10).map((m: any) => `${m.role === "user" ? "Người dùng" : "Trợ lý"}: ${m.content}`).join("\n");
    if (historyText) parts.push(`\n## Lịch sử\n${historyText}`);
    parts.push(`\nNgười dùng: ${message}`);
    const fullPrompt = parts.join("\n");

    // Resolve CLI binary based on model
    const selectedModel = requestModel || "claude-opus-4-6";
    const isGemini = selectedModel.startsWith("gemini");
    const cliBin = isGemini
      ? (process.env.GEMINI_BIN || "C:/nvm4w/nodejs/gemini.cmd")
      : (process.env.CLAUDE_BIN || "C:/Users/Jennie Chu/.local/bin/claude.exe");
    const chatCwd = process.env.PROJECT_ROOT || "C:/Users/Jennie Chu/Desktop/Projects/App Phong Thủy Đế Vương";
    console.log(`[PTDV-Chat] Spawning ${cliBin} (model=${selectedModel}) in ${chatCwd}, prompt ${fullPrompt.length} chars`);

    const cliArgs = isGemini
      ? ["-o", "stream-json", "-m", selectedModel, "-y", "-p", fullPrompt.length < 7000 ? fullPrompt : ""]
      : ["--print", "-", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--model", selectedModel, "--max-turns", "5"];

    const child = spawn(cliBin, cliArgs, {
      cwd: chatCwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PATH: process.env.PATH + ";C:/Users/Jennie Chu/.local/bin" },
      windowsHide: true,
    });

    // For Claude: pipe prompt via stdin (--print -)
    // For Gemini: prompt already in -p flag (short) or pipe via stdin (long)
    if (!isGemini) {
      child.stdin.write(fullPrompt);
    } else if (fullPrompt.length >= 7000) {
      child.stdin.write(fullPrompt);
    }
    child.stdin.end();

    child.stderr?.setEncoding("utf8");
    child.stderr.on("data", (chunk: Buffer) => {
      const err = chunk.toString("utf-8");
      console.log(`[PTDV-Chat] stderr: ${err.slice(0, 200)}`);
    });

    child.stdout?.setEncoding("utf8");
    child.stdout.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const p = JSON.parse(line);
          let c = "";
          if (p.type === "assistant" && p.message?.content) {
            for (const b of (Array.isArray(p.message.content) ? p.message.content : [p.message.content])) {
              if (b.type === "text" && b.text) c += b.text;
            }
          }
          if (p.type === "content_block_delta" && p.delta?.text) c = p.delta.text;
          if (p.type === "message" && p.role === "assistant" && p.content) c = p.content;
          if (p.type === "result" && typeof p.result === "string") c = p.result;
          if (c) res.write(`data: ${JSON.stringify({ text: c })}\n\n`);
        } catch {}
      }
    });

    child.on("close", () => { res.write(`data: ${JSON.stringify({ done: true })}\n\n`); res.end(); });
    child.on("error", (err) => { res.write(`data: ${JSON.stringify({ error: (err as Error).message })}\n\n`); res.end(); });
    setTimeout(() => { try { child.kill(); } catch {} }, 280_000);
  });

  // CORS preflight for phong-thuy-chat
  api.options("/ai/phong-thuy-chat", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.status(204).end();
  });
  api.use("/system", systemRoutes);
  api.use("/channels", channelRoutes);
  // Training Room (Sprint B + C) — REST endpoints; WS upgrade is wired in index.ts
  const { trainingRouter } = await import("./training/training-routes.js");
  api.use("/training", trainingRouter);
  app.use("/api", api);
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });

  // On startup: reset stale agent sessions (old "running" sessions from before restart)
  import("./channels/zalo-personal/supabase.js").then(({ supabase }) => {
    supabase.from('agent_sessions')
      .update({ status: 'idle' })
      .eq('status', 'running')
      .then(() => console.log("[Startup] Stale agent sessions reset to idle"));
  });

  // On startup: one-shot sync of DB goals → memory/goals.md so Claude CLI
  // sessions outside Paperclip see the same goals as reply agents. No cron,
  // no timer — this runs exactly once per server boot.
  import("./services/goals-disk-sync.js").then(({ syncGoalsToDiskImmediate }) => {
    syncGoalsToDiskImmediate()
      .then((r) => {
        if (r.success) {
          console.log(`[Startup] Goals synced to disk: ${r.goalsWritten} goals → ${r.filePath}`);
        } else {
          console.warn(`[Startup] Goals sync skipped: ${r.error}`);
        }
      })
      .catch((err) => console.warn("[Startup] Goals sync error:", err?.message));
  });

  // On startup: seed the 8 pipeline templates into gem_pipelines table
  // (idempotent — upsert on pipeline_id, only touches is_template=true rows,
  // so user-cloned pipelines are safe).
  import("./channels/seed-pipelines.js").then(async ({ seedPipelineTemplates }) => {
    try {
      const result = await seedPipelineTemplates();
      console.log(`[Startup] Pipeline templates seeded: ${result.seeded}${result.errors.length ? ` (${result.errors.length} errors)` : ''}`);
      if (result.errors.length > 0) {
        console.warn('[Startup] Pipeline seed errors:', result.errors.slice(0, 3));
      }
    } catch (err: any) {
      console.warn('[Startup] Pipeline seed failed:', err?.message);
    }
  });

  // On startup: one-shot scan of ~/.claude/ to reconcile Registry Marketplace with disk.
  // F4 (plan 2026-08-18 pooler-stall): MẶC ĐỊNH KHÔNG chạy lúc startup. Trước fix, scan này bắn
  // ~4.600 REST upsert (memory_files 2.128, script_registry 1.029, skills_registry 539, slash_commands
  // 424...) trong 3-4 phút MỖI lần server khởi động (đo edge_logs E5) — trùng đúng lúc restart-storm
  // của pooler-stall → dội thêm tải lên DB Micro đang swap → khuếch đại sự cố. Registry Marketplace
  // vẫn refresh được qua NÚT UI (registry-marketplace-routes.ts scanRegistryDisk) hoặc set env
  // PAPERCLIP_REGISTRY_SYNC_ON_START=true khi thực sự cần sync lúc boot.
  if (process.env.PAPERCLIP_REGISTRY_SYNC_ON_START === "true") {
    import("./services/registry-disk-sync.js").then(async ({ scanRegistryDisk }) => {
      try {
        const result = await scanRegistryDisk();
        const total = Object.values(result.upserted).reduce((a, b) => a + b, 0);
        console.log(
          `[Startup] Registry disk scan: ${total} items synced (${result.upserted.skills} skills, ` +
          `${result.upserted.mcp} MCP, ${result.upserted.commands} commands, ${result.upserted.hooks} hooks, ` +
          `${result.upserted.plugins} plugins) in ${result.duration_ms}ms`,
        );
        if (result.stale_marked > 0) {
          console.log(`[Startup] Registry disk scan: ${result.stale_marked} stale rows marked disabled`);
        }
      } catch (err: any) {
        console.warn("[Startup] Registry disk scan failed:", err?.message);
      }
    });
  } else {
    console.log(
      "[Startup] Registry disk scan skipped (F4: manual-only). Bấm nút Sync trong Registry Marketplace UI, hoặc set PAPERCLIP_REGISTRY_SYNC_ON_START=true.",
    );
  }

  // On startup: seed the Cron Registry with all known scheduled work
  // (pg_cron jobs on Supabase + Node setInterval timers in this server
  // + Windows schtasks via scanOsTasks). This makes EVERY scheduled unit
  // visible in the Paperclip UI with full metadata: owner, schedule,
  // humanized text, linked entity, setup_by. User control landing point
  // for BUG-027 prevention.
  import("./services/cron-registry.js").then(async ({ seedKnownSchedulers, scanOsTasks }) => {
    try {
      const seeded = await seedKnownSchedulers();
      console.log(`[Startup] Cron registry seeded: ${seeded.pgcron} pg_cron + ${seeded.nodeTimers} node timers`);
    } catch (err: any) {
      console.warn("[Startup] Cron registry seed failed:", err?.message);
    }
    try {
      const scanned = await scanOsTasks('paperclip_startup');
      if (scanned.imported > 0) {
        console.log(`[Startup] Cron registry OS scan: ${scanned.imported}/${scanned.scanned} Windows tasks imported`);
      }
    } catch (err: any) {
      console.warn("[Startup] Cron registry OS scan failed:", err?.message);
    }
  });

  // Threads API token (EC-086): tự gia hạn long-lived token khi còn <10 ngày (mỗi 6h)
  startThreadsTokenRefresher();

  // Restore Zalo + Facebook Web channels + start consumer on startup
  resumeAllFacebookWebChannels().then(() => {
    console.log("[FbWeb] Channel restore complete");
  }).catch((err) => console.error("[FbWeb] Restore error:", err));

  resumeCskhChannel().then(() => {
    console.log("[cskh] resume complete");
  }).catch((err) => console.error("[cskh] Resume error:", err));

  restoreChannels().then(async () => {
    console.log("[ZaloPersonal] Channel restore complete");
    // Start the inbound consumer (agent auto-reply pipeline)
    try {
      const { startConsumer } = await import("./channels/consumer.js");
      startConsumer();
      console.log("[Consumer] Inbound consumer started — agent auto-reply active");
    } catch (err: any) {
      console.warn("[Consumer] Failed to start:", err.message);
    }
    // Start the YouTube comment poller (poll-based, no webhooks)
    try {
      const { startYouTubeCommentPoller } = await import("./channels/youtube/comments.js");
      startYouTubeCommentPoller();
      console.log("[YouTube] Comment poller started");
    } catch (err: any) {
      console.warn("[YouTube] Failed to start comment poller:", err.message);
    }
    // Start the auto follow-up cron (D9.4) — bám đuổi khách stuck trong funnel
    try {
      const { startFollowUpCron } = await import("./channels/crm/follow-up-cron.js");
      startFollowUpCron();
      console.log("[FollowUpCron] Auto follow-up cron started");
    } catch (err: any) {
      console.warn("[FollowUpCron] Failed to start:", err.message);
    }
    // Reconcile agent_sessions DB rows against JSONL files on disk (every 30min)
    // Marks rows as 'stopped' when Claude CLI cleaned up their JSONL —
    // prevents router from --resume'ing ghost sessions.
    try {
      const { startAgentSessionReconcileCron } = await import("./channels/agent-session-reconcile-cron.js");
      startAgentSessionReconcileCron();
      console.log("[SessionReconcile] Agent session reconcile cron started");
    } catch (err: any) {
      console.warn("[SessionReconcile] Failed to start:", err.message);
    }
  }).catch((err) => {
    console.warn("[ZaloPersonal] Channel restore failed:", err.message);
  });
  app.use(pluginUiStaticRoutes(db, {
    localPluginDir: opts.localPluginDir ?? DEFAULT_LOCAL_PLUGIN_DIR,
  }));

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  if (opts.uiMode === "static") {
    // Try published location first (server/ui-dist/), then monorepo dev location (../../ui/dist)
    const candidates = [
      path.resolve(__dirname, "../ui-dist"),
      path.resolve(__dirname, "../../ui/dist"),
    ];
    const uiDist = candidates.find((p) => fs.existsSync(path.join(p, "index.html")));
    if (uiDist) {
      // index.html đọc lại khi mtime đổi — rebuild UI không cần restart server (restart giết mọi
      // run agent đang chạy: 24/10 rebuild UI 12 lần → 26 run "Process lost").
      const indexPath = path.join(uiDist, "index.html");
      let indexCache = { mtimeMs: -1, html: "" };
      const getIndexHtml = () => {
        try {
          const { mtimeMs } = fs.statSync(indexPath);
          if (mtimeMs !== indexCache.mtimeMs) {
            indexCache = { mtimeMs, html: applyUiBranding(fs.readFileSync(indexPath, "utf-8")) };
          }
        } catch (err) {
          // Đang sync dist (file tạm vắng) → phục vụ bản cache cũ thay vì 500.
          if (indexCache.mtimeMs < 0) throw err;
        }
        return indexCache.html;
      };
      getIndexHtml();
      app.use(express.static(uiDist, { maxAge: '1h', setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }}));
      app.get(/.*/, (_req, res) => {
        res.status(200).set("Content-Type", "text/html").set("Cache-Control", "no-cache, no-store, must-revalidate").end(getIndexHtml());
      });
    } else {
      console.warn("[paperclip] UI dist not found; running in API-only mode");
    }
  }

  if (opts.uiMode === "vite-dev") {
    const uiRoot = path.resolve(__dirname, "../../ui");
    const hmrPort = resolveViteHmrPort(opts.serverPort);
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      root: uiRoot,
      appType: "custom",
      server: {
        middlewareMode: true,
        hmr: {
          host: opts.bindHost,
          port: hmrPort,
          clientPort: hmrPort,
        },
        allowedHosts: privateHostnameGateEnabled ? Array.from(privateHostnameAllowSet) : undefined,
      },
    });

    app.use(vite.middlewares);
    app.get(/.*/, async (req, res, next) => {
      try {
        const templatePath = path.resolve(uiRoot, "index.html");
        const template = fs.readFileSync(templatePath, "utf-8");
        const html = applyUiBranding(await vite.transformIndexHtml(req.originalUrl, template));
        res.status(200).set({ "Content-Type": "text/html" }).end(html);
      } catch (err) {
        next(err);
      }
    });
  }

  app.use(errorHandler);

  jobCoordinator.start();
  scheduler.start();
  void toolDispatcher.initialize().catch((err) => {
    logger.error({ err }, "Failed to initialize plugin tool dispatcher");
  });
  const devWatcher = opts.uiMode === "vite-dev"
    ? createPluginDevWatcher(
      lifecycle,
      async (pluginId) => (await pluginRegistry.getById(pluginId))?.packagePath ?? null,
    )
    : null;
  void loader.loadAll().then((result) => {
    if (!result) return;
    for (const loaded of result.results) {
      if (devWatcher && loaded.success && loaded.plugin.packagePath) {
        devWatcher.watch(loaded.plugin.id, loaded.plugin.packagePath);
      }
    }
  }).catch((err) => {
    logger.error({ err }, "Failed to load ready plugins on startup");
  });
  process.once("exit", () => {
    devWatcher?.close();
    hostServiceCleanup.disposeAll();
    hostServiceCleanup.teardown();
  });
  process.once("beforeExit", () => {
    void flushPluginLogBuffer();
  });

  return app;
}
