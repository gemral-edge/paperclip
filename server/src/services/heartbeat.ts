import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { and, asc, desc, eq, gt, inArray, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { BillingType, ExecutionWorkspace, ExecutionWorkspaceConfig } from "@paperclipai/shared";
import {
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  companies,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { boundedPoll } from "./bounded-poll.js";
import { publishLiveEvent } from "./live-events.js";
import { HEARTBEAT_SKIP_STATUSES, isHeartbeatSkipped } from "./heartbeat-eligibility.js";
import {
  computeAgentHeartbeatJitterMs,
  computeJitteredDueAtMs,
  evaluateFleetClaim,
  fleetWindowStart,
  isFleetClaimGateEnabled,
  isTimerExempt,
  orderQueuedRunsForClaim,
  orderTimerCandidatesFairly,
  readFleetThrottleConfig,
  withKeyedLock,
} from "./fleet-throttle.js";
import { lookupAgentConfirmed } from "./agent-lookup-confirm.js";
import { getRunLogStore, type RunLogHandle } from "./run-log-store.js";
import { getServerAdapter, runningProcesses, terminateProcessTree } from "../adapters/index.js";
import type { AdapterExecutionResult, AdapterInvocationMeta, AdapterSessionCodec, UsageSummary } from "../adapters/index.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { parseObject, asBoolean, asNumber, asString, appendWithCap, MAX_EXCERPT_BYTES } from "../adapters/utils.js";
import { parseCron, nextCronTick, validateCron, type ParsedCron } from "./cron.js";
import { classifyCronCatchUp, shouldDeferForTickBudget } from "./cron-catch-up.js";
import { costService } from "./costs.js";
import { companySkillService } from "./company-skills.js";
import { budgetService, type BudgetEnforcementScope } from "./budgets.js";
import { secretService } from "./secrets.js";
import { resolveDefaultAgentWorkspaceDir, resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { summarizeHeartbeatRunResultJson } from "./heartbeat-run-summary.js";
import { planQuotaRetry, readQuotaRetryPlan, type QuotaRetryPlan } from "./quota-retry.js";
import {
  AGY_ADAPTER_TYPE,
  CLAUDE_ADAPTER_TYPE,
  buildClaudeFallbackConfig,
  mergeClaudeFallbackResult,
  shouldFallbackToClaude,
} from "./agy-claude-fallback.js";
import {
  buildWorkspaceReadyComment,
  cleanupExecutionWorkspaceArtifacts,
  ensureRuntimeServicesForRun,
  persistAdapterManagedRuntimeServices,
  realizeExecutionWorkspace,
  releaseRuntimeServicesForRun,
  type ExecutionWorkspaceInput,
  type RealizedExecutionWorkspace,
  sanitizeRuntimeServiceBaseEnv,
} from "./workspace-runtime.js";
import { issueService } from "./issues.js";
import { executionWorkspaceService, mergeExecutionWorkspaceConfig } from "./execution-workspaces.js";
import { workspaceOperationService } from "./workspace-operations.js";
import {
  buildExecutionWorkspaceAdapterConfig,
  gateProjectExecutionWorkspacePolicy,
  issueExecutionWorkspaceModeForPersistedWorkspace,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveExecutionWorkspaceMode,
} from "./execution-workspace-policy.js";
import { instanceSettingsService } from "./instance-settings.js";
import { redactCurrentUserText, redactCurrentUserValue } from "../log-redaction.js";
import {
  hasSessionCompactionThresholds,
  resolveSessionCompactionPolicy,
  type SessionCompactionPolicy,
} from "@paperclipai/adapter-utils";

// GEM-1443: cron slots that passed before this process started were missed while the
// server was down (keep the stale guard); slots after it were missed by us (fire late).
const SCHEDULER_PROCESS_STARTED_AT_MS = Date.now();

const MAX_LIVE_LOG_CHUNK_BYTES = 8 * 1024;
const HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT = 1;
const HEARTBEAT_MAX_CONCURRENT_RUNS_MAX = 10;
const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";
const DETACHED_PROCESS_ERROR_CODE = "process_detached";
// Tiền tố message event lifecycle khi run bị detached — dấu vết BỀN (event không bị xoá khi
// clearDetachedRunWarning dọn errorCode), reaper dựa vào đây để không retry lượt từng detached.
const DETACHED_EVENT_MESSAGE_PREFIX = "Lost in-memory process handle";
const startLocksByAgent = new Map<string, Promise<void>>();
const REPO_ONLY_CWD_SENTINEL = "/__paperclip_repo_only__";
const MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const execFile = promisify(execFileCallback);
const SESSIONED_LOCAL_ADAPTERS = new Set([
  // antigravity_local cũng spawn child local có pid → phải được reap/retry như các adapter dưới
  // (thiếu = lượt agy mất tiến trình khi server restart không bao giờ retry, 29/09).
  "antigravity_local",
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "opencode_local",
  "pi_local",
]);

export function applyPersistedExecutionWorkspaceConfig(input: {
  config: Record<string, unknown>;
  workspaceConfig: ExecutionWorkspaceConfig | null;
  mode: ReturnType<typeof resolveExecutionWorkspaceMode>;
}) {
  const nextConfig = { ...input.config };

  if (input.mode !== "agent_default") {
    if (input.workspaceConfig?.workspaceRuntime === null) {
      delete nextConfig.workspaceRuntime;
    } else if (input.workspaceConfig?.workspaceRuntime) {
      nextConfig.workspaceRuntime = { ...input.workspaceConfig.workspaceRuntime };
    }
  }

  if (input.workspaceConfig && input.mode === "isolated_workspace") {
    const nextStrategy = parseObject(nextConfig.workspaceStrategy);
    if (input.workspaceConfig.provisionCommand === null) delete nextStrategy.provisionCommand;
    else nextStrategy.provisionCommand = input.workspaceConfig.provisionCommand;
    if (input.workspaceConfig.teardownCommand === null) delete nextStrategy.teardownCommand;
    else nextStrategy.teardownCommand = input.workspaceConfig.teardownCommand;
    nextConfig.workspaceStrategy = nextStrategy;
  }

  return nextConfig;
}

export function stripWorkspaceRuntimeFromExecutionRunConfig(config: Record<string, unknown>) {
  const nextConfig = { ...config };
  delete nextConfig.workspaceRuntime;
  return nextConfig;
}

export function buildRealizedExecutionWorkspaceFromPersisted(input: {
  base: ExecutionWorkspaceInput;
  workspace: ExecutionWorkspace;
}): RealizedExecutionWorkspace | null {
  const cwd = readNonEmptyString(input.workspace.cwd) ?? readNonEmptyString(input.workspace.providerRef);
  if (!cwd) {
    return null;
  }

  const strategy = input.workspace.strategyType === "git_worktree" ? "git_worktree" : "project_primary";
  return {
    baseCwd: input.base.baseCwd,
    source: input.workspace.mode === "shared_workspace" ? "project_primary" : "task_session",
    projectId: input.workspace.projectId ?? input.base.projectId,
    workspaceId: input.workspace.projectWorkspaceId ?? input.base.workspaceId,
    repoUrl: input.workspace.repoUrl ?? input.base.repoUrl,
    repoRef: input.workspace.baseRef ?? input.base.repoRef,
    strategy,
    cwd,
    branchName: input.workspace.branchName ?? null,
    worktreePath: strategy === "git_worktree" ? (readNonEmptyString(input.workspace.providerRef) ?? cwd) : null,
    warnings: [],
    created: false,
  };
}

function buildExecutionWorkspaceConfigSnapshot(config: Record<string, unknown>): Partial<ExecutionWorkspaceConfig> | null {
  const strategy = parseObject(config.workspaceStrategy);
  const snapshot: Partial<ExecutionWorkspaceConfig> = {};

  if ("workspaceStrategy" in config) {
    snapshot.provisionCommand = typeof strategy.provisionCommand === "string" ? strategy.provisionCommand : null;
    snapshot.teardownCommand = typeof strategy.teardownCommand === "string" ? strategy.teardownCommand : null;
  }

  if ("workspaceRuntime" in config) {
    const workspaceRuntime = parseObject(config.workspaceRuntime);
    snapshot.workspaceRuntime = Object.keys(workspaceRuntime).length > 0 ? workspaceRuntime : null;
  }

  const hasSnapshot = Object.values(snapshot).some((value) => {
    if (value === null) return false;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return true;
  });
  return hasSnapshot ? snapshot : null;
}

function deriveRepoNameFromRepoUrl(repoUrl: string | null): string | null {
  const trimmed = repoUrl?.trim() ?? "";
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    const cleanedPath = parsed.pathname.replace(/\/+$/, "");
    const repoName = cleanedPath.split("/").filter(Boolean).pop()?.replace(/\.git$/i, "") ?? "";
    return repoName || null;
  } catch {
    return null;
  }
}

async function ensureManagedProjectWorkspace(input: {
  companyId: string;
  projectId: string;
  repoUrl: string | null;
}): Promise<{ cwd: string; warning: string | null }> {
  const cwd = resolveManagedProjectWorkspaceDir({
    companyId: input.companyId,
    projectId: input.projectId,
    repoName: deriveRepoNameFromRepoUrl(input.repoUrl),
  });
  await fs.mkdir(path.dirname(cwd), { recursive: true });
  const stats = await fs.stat(cwd).catch(() => null);

  if (!input.repoUrl) {
    if (!stats) {
      await fs.mkdir(cwd, { recursive: true });
    }
    return { cwd, warning: null };
  }

  const gitDirExists = await fs
    .stat(path.resolve(cwd, ".git"))
    .then((entry) => entry.isDirectory())
    .catch(() => false);
  if (gitDirExists) {
    return { cwd, warning: null };
  }

  if (stats) {
    const entries = await fs.readdir(cwd).catch(() => []);
    if (entries.length > 0) {
      return {
        cwd,
        warning: `Managed workspace path "${cwd}" already exists but is not a git checkout. Using it as-is.`,
      };
    }
    await fs.rm(cwd, { recursive: true, force: true });
  }

  try {
    await execFile("git", ["clone", input.repoUrl, cwd], {
      env: sanitizeRuntimeServiceBaseEnv(process.env),
      timeout: MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS,
    });
    return { cwd, warning: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to prepare managed checkout for "${input.repoUrl}" at "${cwd}": ${reason}`);
  }
}

const heartbeatRunListColumns = {
  id: heartbeatRuns.id,
  companyId: heartbeatRuns.companyId,
  agentId: heartbeatRuns.agentId,
  invocationSource: heartbeatRuns.invocationSource,
  triggerDetail: heartbeatRuns.triggerDetail,
  status: heartbeatRuns.status,
  startedAt: heartbeatRuns.startedAt,
  finishedAt: heartbeatRuns.finishedAt,
  error: heartbeatRuns.error,
  wakeupRequestId: heartbeatRuns.wakeupRequestId,
  exitCode: heartbeatRuns.exitCode,
  signal: heartbeatRuns.signal,
  usageJson: heartbeatRuns.usageJson,
  resultJson: heartbeatRuns.resultJson,
  sessionIdBefore: heartbeatRuns.sessionIdBefore,
  sessionIdAfter: heartbeatRuns.sessionIdAfter,
  logStore: heartbeatRuns.logStore,
  logRef: heartbeatRuns.logRef,
  logBytes: heartbeatRuns.logBytes,
  logSha256: heartbeatRuns.logSha256,
  logCompressed: heartbeatRuns.logCompressed,
  stdoutExcerpt: heartbeatRuns.stdoutExcerpt,
  stderrExcerpt: heartbeatRuns.stderrExcerpt,
  errorCode: heartbeatRuns.errorCode,
  externalRunId: heartbeatRuns.externalRunId,
  processPid: heartbeatRuns.processPid,
  processStartedAt: heartbeatRuns.processStartedAt,
  retryOfRunId: heartbeatRuns.retryOfRunId,
  processLossRetryCount: heartbeatRuns.processLossRetryCount,
  contextSnapshot: heartbeatRuns.contextSnapshot,
  createdAt: heartbeatRuns.createdAt,
  updatedAt: heartbeatRuns.updatedAt,
} as const;

// F3 (plan 2026-08-18 pooler-stall): projection NHẸ cho list/badge poller — BỎ 3 blob JSON lớn
// (usageJson, resultJson, contextSnapshot) là nguồn egress chính (E8: mean 0.9-9s, ~37GB egress
// Supavisor→client) + giữ query lâu → giữ slot runtime pool. Dùng cho các caller CHỈ hiển thị
// status/timestamp/error (useInboxBadge, Dashboard, Agents). Caller cần contextSnapshot cho
// retry/detail (Inbox, AgentDetail) VẪN dùng `list` full — KHÔNG đổi (an toàn retry path).
const heartbeatRunSummaryColumns = {
  id: heartbeatRuns.id,
  companyId: heartbeatRuns.companyId,
  agentId: heartbeatRuns.agentId,
  invocationSource: heartbeatRuns.invocationSource,
  triggerDetail: heartbeatRuns.triggerDetail,
  status: heartbeatRuns.status,
  startedAt: heartbeatRuns.startedAt,
  finishedAt: heartbeatRuns.finishedAt,
  error: heartbeatRuns.error,
  wakeupRequestId: heartbeatRuns.wakeupRequestId,
  exitCode: heartbeatRuns.exitCode,
  signal: heartbeatRuns.signal,
  sessionIdBefore: heartbeatRuns.sessionIdBefore,
  sessionIdAfter: heartbeatRuns.sessionIdAfter,
  logStore: heartbeatRuns.logStore,
  logRef: heartbeatRuns.logRef,
  logBytes: heartbeatRuns.logBytes,
  logSha256: heartbeatRuns.logSha256,
  logCompressed: heartbeatRuns.logCompressed,
  stdoutExcerpt: heartbeatRuns.stdoutExcerpt,
  stderrExcerpt: heartbeatRuns.stderrExcerpt,
  errorCode: heartbeatRuns.errorCode,
  externalRunId: heartbeatRuns.externalRunId,
  processPid: heartbeatRuns.processPid,
  processStartedAt: heartbeatRuns.processStartedAt,
  retryOfRunId: heartbeatRuns.retryOfRunId,
  processLossRetryCount: heartbeatRuns.processLossRetryCount,
  createdAt: heartbeatRuns.createdAt,
  updatedAt: heartbeatRuns.updatedAt,
} as const;

function appendExcerpt(prev: string, chunk: string) {
  const combined = prev + chunk;
  if (combined.length <= MAX_EXCERPT_BYTES) return combined;
  return "..." + combined.slice(-(MAX_EXCERPT_BYTES - 3));
}

function normalizeMaxConcurrentRuns(value: unknown) {
  const parsed = Math.floor(asNumber(value, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT));
  if (!Number.isFinite(parsed)) return HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT;
  return Math.max(HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT, Math.min(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, parsed));
}

const AGENT_START_LOCK_WAIT_TIMEOUT_MS = 20_000;
async function withAgentStartLock<T>(agentId: string, fn: () => Promise<T>) {
  const previous = startLocksByAgent.get(agentId) ?? Promise.resolve();
  // GEM-1368: Chống kẹt in-memory start lock khi previous promise bị treo > 20s.
  const waitPrevious = Promise.race([
    previous,
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, AGENT_START_LOCK_WAIT_TIMEOUT_MS);
      t.unref?.();
    }),
  ]);
  const run = waitPrevious.then(fn);
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  startLocksByAgent.set(agentId, marker);
  try {
    return await run;
  } finally {
    if (startLocksByAgent.get(agentId) === marker) {
      startLocksByAgent.delete(agentId);
    }
  }
}

interface WakeupOptions {
  source?: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
}

type UsageTotals = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

type SessionCompactionDecision = {
  rotate: boolean;
  reason: string | null;
  handoffMarkdown: string | null;
  previousRunId: string | null;
};

interface ParsedIssueAssigneeAdapterOverrides {
  adapterConfig: Record<string, unknown> | null;
  useProjectWorkspace: boolean | null;
}

export type ResolvedWorkspaceForRun = {
  cwd: string;
  source: "project_primary" | "task_session" | "agent_home";
  projectId: string | null;
  workspaceId: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  workspaceHints: Array<{
    workspaceId: string;
    cwd: string | null;
    repoUrl: string | null;
    repoRef: string | null;
  }>;
  warnings: string[];
};

type ProjectWorkspaceCandidate = {
  id: string;
};

export function prioritizeProjectWorkspaceCandidatesForRun<T extends ProjectWorkspaceCandidate>(
  rows: T[],
  preferredWorkspaceId: string | null | undefined,
): T[] {
  if (!preferredWorkspaceId) return rows;
  const preferredIndex = rows.findIndex((row) => row.id === preferredWorkspaceId);
  if (preferredIndex <= 0) return rows;
  return [rows[preferredIndex]!, ...rows.slice(0, preferredIndex), ...rows.slice(preferredIndex + 1)];
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeLedgerBillingType(value: unknown): BillingType {
  const raw = readNonEmptyString(value);
  switch (raw) {
    case "api":
    case "metered_api":
      return "metered_api";
    case "subscription":
    case "subscription_included":
      return "subscription_included";
    case "subscription_overage":
      return "subscription_overage";
    case "credits":
      return "credits";
    case "fixed":
      return "fixed";
    default:
      return "unknown";
  }
}

function resolveLedgerBiller(result: AdapterExecutionResult): string {
  return readNonEmptyString(result.biller) ?? readNonEmptyString(result.provider) ?? "unknown";
}

function normalizeBilledCostCents(costUsd: number | null | undefined, billingType: BillingType): number {
  if (billingType === "subscription_included") return 0;
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) return 0;
  return Math.max(0, Math.round(costUsd * 100));
}

async function resolveLedgerScopeForRun(
  db: Db,
  companyId: string,
  run: typeof heartbeatRuns.$inferSelect,
) {
  const context = parseObject(run.contextSnapshot);
  const contextIssueId = readNonEmptyString(context.issueId);
  const contextProjectId = readNonEmptyString(context.projectId);

  if (!contextIssueId) {
    return {
      issueId: null,
      projectId: contextProjectId,
    };
  }

  const issue = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
    })
    .from(issues)
    .where(and(eq(issues.id, contextIssueId), eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);

  return {
    issueId: issue?.id ?? null,
    projectId: issue?.projectId ?? contextProjectId,
  };
}

type ResumeSessionRow = {
  sessionParamsJson: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  lastRunId: string | null;
};

export function buildExplicitResumeSessionOverride(input: {
  resumeFromRunId: string;
  resumeRunSessionIdBefore: string | null;
  resumeRunSessionIdAfter: string | null;
  taskSession: ResumeSessionRow | null;
  sessionCodec: AdapterSessionCodec;
}) {
  const desiredDisplayId = truncateDisplayId(
    input.resumeRunSessionIdAfter ?? input.resumeRunSessionIdBefore,
  );
  const taskSessionParams = normalizeSessionParams(
    input.sessionCodec.deserialize(input.taskSession?.sessionParamsJson ?? null),
  );
  const taskSessionDisplayId = truncateDisplayId(
    input.taskSession?.sessionDisplayId ??
      (input.sessionCodec.getDisplayId ? input.sessionCodec.getDisplayId(taskSessionParams) : null) ??
      readNonEmptyString(taskSessionParams?.sessionId),
  );
  const canReuseTaskSessionParams =
    input.taskSession != null &&
    (
      input.taskSession.lastRunId === input.resumeFromRunId ||
      (!!desiredDisplayId && taskSessionDisplayId === desiredDisplayId)
    );
  const sessionParams =
    canReuseTaskSessionParams
      ? taskSessionParams
      : desiredDisplayId
        ? { sessionId: desiredDisplayId }
        : null;
  const sessionDisplayId = desiredDisplayId ?? (canReuseTaskSessionParams ? taskSessionDisplayId : null);

  if (!sessionDisplayId && !sessionParams) return null;
  return {
    sessionDisplayId,
    sessionParams,
  };
}

function normalizeUsageTotals(usage: UsageSummary | null | undefined): UsageTotals | null {
  if (!usage) return null;
  return {
    inputTokens: Math.max(0, Math.floor(asNumber(usage.inputTokens, 0))),
    cachedInputTokens: Math.max(0, Math.floor(asNumber(usage.cachedInputTokens, 0))),
    outputTokens: Math.max(0, Math.floor(asNumber(usage.outputTokens, 0))),
  };
}

function readRawUsageTotals(usageJson: unknown): UsageTotals | null {
  const parsed = parseObject(usageJson);
  if (Object.keys(parsed).length === 0) return null;

  const inputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawInputTokens, asNumber(parsed.inputTokens, 0))),
  );
  const cachedInputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawCachedInputTokens, asNumber(parsed.cachedInputTokens, 0))),
  );
  const outputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawOutputTokens, asNumber(parsed.outputTokens, 0))),
  );

  if (inputTokens <= 0 && cachedInputTokens <= 0 && outputTokens <= 0) {
    return null;
  }

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
  };
}

function deriveNormalizedUsageDelta(current: UsageTotals | null, previous: UsageTotals | null): UsageTotals | null {
  if (!current) return null;
  if (!previous) return { ...current };

  const inputTokens = current.inputTokens >= previous.inputTokens
    ? current.inputTokens - previous.inputTokens
    : current.inputTokens;
  const cachedInputTokens = current.cachedInputTokens >= previous.cachedInputTokens
    ? current.cachedInputTokens - previous.cachedInputTokens
    : current.cachedInputTokens;
  const outputTokens = current.outputTokens >= previous.outputTokens
    ? current.outputTokens - previous.outputTokens
    : current.outputTokens;

  return {
    inputTokens: Math.max(0, inputTokens),
    cachedInputTokens: Math.max(0, cachedInputTokens),
    outputTokens: Math.max(0, outputTokens),
  };
}

function formatCount(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0";
  return value.toLocaleString("en-US");
}

export function parseSessionCompactionPolicy(agent: typeof agents.$inferSelect): SessionCompactionPolicy {
  return resolveSessionCompactionPolicy(agent.adapterType, agent.runtimeConfig).policy;
}

export function resolveRuntimeSessionParamsForWorkspace(input: {
  agentId: string;
  previousSessionParams: Record<string, unknown> | null;
  resolvedWorkspace: ResolvedWorkspaceForRun;
}) {
  const { agentId, previousSessionParams, resolvedWorkspace } = input;
  const previousSessionId = readNonEmptyString(previousSessionParams?.sessionId);
  const previousCwd = readNonEmptyString(previousSessionParams?.cwd);
  if (!previousSessionId || !previousCwd) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  if (resolvedWorkspace.source !== "project_primary") {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const projectCwd = readNonEmptyString(resolvedWorkspace.cwd);
  if (!projectCwd) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const fallbackAgentHomeCwd = resolveDefaultAgentWorkspaceDir(agentId);
  if (path.resolve(previousCwd) !== path.resolve(fallbackAgentHomeCwd)) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  if (path.resolve(projectCwd) === path.resolve(previousCwd)) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const previousWorkspaceId = readNonEmptyString(previousSessionParams?.workspaceId);
  if (
    previousWorkspaceId &&
    resolvedWorkspace.workspaceId &&
    previousWorkspaceId !== resolvedWorkspace.workspaceId
  ) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }

  const migratedSessionParams: Record<string, unknown> = {
    ...(previousSessionParams ?? {}),
    cwd: projectCwd,
  };
  if (resolvedWorkspace.workspaceId) migratedSessionParams.workspaceId = resolvedWorkspace.workspaceId;
  if (resolvedWorkspace.repoUrl) migratedSessionParams.repoUrl = resolvedWorkspace.repoUrl;
  if (resolvedWorkspace.repoRef) migratedSessionParams.repoRef = resolvedWorkspace.repoRef;

  return {
    sessionParams: migratedSessionParams,
    warning:
      `Project workspace "${projectCwd}" is now available. ` +
      `Attempting to resume session "${previousSessionId}" that was previously saved in fallback workspace "${previousCwd}".`,
  };
}

function parseIssueAssigneeAdapterOverrides(
  raw: unknown,
): ParsedIssueAssigneeAdapterOverrides | null {
  const parsed = parseObject(raw);
  const parsedAdapterConfig = parseObject(parsed.adapterConfig);
  const adapterConfig =
    Object.keys(parsedAdapterConfig).length > 0 ? parsedAdapterConfig : null;
  const useProjectWorkspace =
    typeof parsed.useProjectWorkspace === "boolean"
      ? parsed.useProjectWorkspace
      : null;
  if (!adapterConfig && useProjectWorkspace === null) return null;
  return {
    adapterConfig,
    useProjectWorkspace,
  };
}

/**
 * Synthetic task key for timer/heartbeat wakes that have no issue context.
 * This allows timer wakes to participate in the `agentTaskSessions` system
 * and benefit from robust session resume, instead of relying solely on the
 * simpler `agentRuntimeState.sessionId` fallback.
 */
const HEARTBEAT_TASK_KEY = "__heartbeat__";

function deriveTaskKey(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  return (
    readNonEmptyString(contextSnapshot?.taskKey) ??
    readNonEmptyString(contextSnapshot?.taskId) ??
    readNonEmptyString(contextSnapshot?.issueId) ??
    readNonEmptyString(payload?.taskKey) ??
    readNonEmptyString(payload?.taskId) ??
    readNonEmptyString(payload?.issueId) ??
    null
  );
}

/**
 * Extended task key derivation that falls back to a stable synthetic key
 * for timer/heartbeat wakes. This ensures timer wakes can resume their
 * previous session via `agentTaskSessions` instead of starting fresh.
 *
 * The synthetic key is only used when:
 * - No explicit task/issue key exists in the context
 * - The wake source is "timer" (scheduled heartbeat)
 */
export function deriveTaskKeyWithHeartbeatFallback(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  const explicit = deriveTaskKey(contextSnapshot, payload);
  if (explicit) return explicit;

  const wakeSource = readNonEmptyString(contextSnapshot?.wakeSource);
  if (wakeSource === "timer") return HEARTBEAT_TASK_KEY;

  return null;
}

export function shouldResetTaskSessionForWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (contextSnapshot?.forceFreshSession === true) return true;

  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (wakeReason === "issue_assigned") return true;
  return false;
}

export function formatRuntimeWorkspaceWarningLog(warning: string) {
  return {
    stream: "stdout" as const,
    chunk: `[paperclip] ${warning}\n`,
  };
}

function describeSessionResetReason(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (contextSnapshot?.forceFreshSession === true) return "forceFreshSession was requested";

  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (wakeReason === "issue_assigned") return "wake reason is issue_assigned";
  return null;
}

function deriveCommentId(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  return (
    readNonEmptyString(contextSnapshot?.wakeCommentId) ??
    readNonEmptyString(contextSnapshot?.commentId) ??
    readNonEmptyString(payload?.commentId) ??
    null
  );
}

function enrichWakeContextSnapshot(input: {
  contextSnapshot: Record<string, unknown>;
  reason: string | null;
  source: WakeupOptions["source"];
  triggerDetail: WakeupOptions["triggerDetail"] | null;
  payload: Record<string, unknown> | null;
}) {
  const { contextSnapshot, reason, source, triggerDetail, payload } = input;
  const issueIdFromPayload = readNonEmptyString(payload?.["issueId"]);
  const commentIdFromPayload = readNonEmptyString(payload?.["commentId"]);
  const taskKey = deriveTaskKey(contextSnapshot, payload);
  const wakeCommentId = deriveCommentId(contextSnapshot, payload);

  if (!readNonEmptyString(contextSnapshot["wakeReason"]) && reason) {
    contextSnapshot.wakeReason = reason;
  }
  if (!readNonEmptyString(contextSnapshot["issueId"]) && issueIdFromPayload) {
    contextSnapshot.issueId = issueIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["taskId"]) && issueIdFromPayload) {
    contextSnapshot.taskId = issueIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["taskKey"]) && taskKey) {
    contextSnapshot.taskKey = taskKey;
  }
  if (!readNonEmptyString(contextSnapshot["commentId"]) && commentIdFromPayload) {
    contextSnapshot.commentId = commentIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["wakeCommentId"]) && wakeCommentId) {
    contextSnapshot.wakeCommentId = wakeCommentId;
  }
  if (!readNonEmptyString(contextSnapshot["wakeSource"]) && source) {
    contextSnapshot.wakeSource = source;
  }
  if (!readNonEmptyString(contextSnapshot["wakeTriggerDetail"]) && triggerDetail) {
    contextSnapshot.wakeTriggerDetail = triggerDetail;
  }

  return {
    contextSnapshot,
    issueIdFromPayload,
    commentIdFromPayload,
    taskKey,
    wakeCommentId,
  };
}

function mergeCoalescedContextSnapshot(
  existingRaw: unknown,
  incoming: Record<string, unknown>,
) {
  const existing = parseObject(existingRaw);
  const merged: Record<string, unknown> = {
    ...existing,
    ...incoming,
  };
  const commentId = deriveCommentId(incoming, null);
  if (commentId) {
    merged.commentId = commentId;
    merged.wakeCommentId = commentId;
  }
  return merged;
}

function runTaskKey(run: typeof heartbeatRuns.$inferSelect) {
  return deriveTaskKey(run.contextSnapshot as Record<string, unknown> | null, null);
}

function isSameTaskScope(left: string | null, right: string | null) {
  return (left ?? null) === (right ?? null);
}

function isTrackedLocalChildProcessAdapter(adapterType: string) {
  return SESSIONED_LOCAL_ADAPTERS.has(adapterType);
}

// A positive liveness check means some process currently owns the PID.
// On Linux, PIDs can be recycled, so this is a best-effort signal rather
// than proof that the original child is still alive.
function isProcessAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return false;
  }
}

function truncateDisplayId(value: string | null | undefined, max = 128) {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function normalizeAgentNameKey(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

const defaultSessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    const asObj = parseObject(raw);
    if (Object.keys(asObj).length > 0) return asObj;
    const sessionId = readNonEmptyString((raw as Record<string, unknown> | null)?.sessionId);
    if (sessionId) return { sessionId };
    return null;
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params || Object.keys(params).length === 0) return null;
    return params;
  },
  getDisplayId(params: Record<string, unknown> | null) {
    return readNonEmptyString(params?.sessionId);
  },
};

function getAdapterSessionCodec(adapterType: string) {
  const adapter = getServerAdapter(adapterType);
  return adapter.sessionCodec ?? defaultSessionCodec;
}

function normalizeSessionParams(params: Record<string, unknown> | null | undefined) {
  if (!params) return null;
  return Object.keys(params).length > 0 ? params : null;
}

function resolveNextSessionState(input: {
  codec: AdapterSessionCodec;
  adapterResult: AdapterExecutionResult;
  previousParams: Record<string, unknown> | null;
  previousDisplayId: string | null;
  previousLegacySessionId: string | null;
}) {
  const { codec, adapterResult, previousParams, previousDisplayId, previousLegacySessionId } = input;

  if (adapterResult.clearSession) {
    return {
      params: null as Record<string, unknown> | null,
      displayId: null as string | null,
      legacySessionId: null as string | null,
    };
  }

  const explicitParams = adapterResult.sessionParams;
  const hasExplicitParams = adapterResult.sessionParams !== undefined;
  const hasExplicitSessionId = adapterResult.sessionId !== undefined;
  const explicitSessionId = readNonEmptyString(adapterResult.sessionId);
  const hasExplicitDisplay = adapterResult.sessionDisplayId !== undefined;
  const explicitDisplayId = readNonEmptyString(adapterResult.sessionDisplayId);
  const shouldUsePrevious = !hasExplicitParams && !hasExplicitSessionId && !hasExplicitDisplay;

  const candidateParams =
    hasExplicitParams
      ? explicitParams
      : hasExplicitSessionId
        ? (explicitSessionId ? { sessionId: explicitSessionId } : null)
        : previousParams;

  const serialized = normalizeSessionParams(codec.serialize(normalizeSessionParams(candidateParams) ?? null));
  const deserialized = normalizeSessionParams(codec.deserialize(serialized));

  const displayId = truncateDisplayId(
    explicitDisplayId ??
      (codec.getDisplayId ? codec.getDisplayId(deserialized) : null) ??
      readNonEmptyString(deserialized?.sessionId) ??
      (shouldUsePrevious ? previousDisplayId : null) ??
      explicitSessionId ??
      (shouldUsePrevious ? previousLegacySessionId : null),
  );

  const legacySessionId =
    explicitSessionId ??
    readNonEmptyString(deserialized?.sessionId) ??
    displayId ??
    (shouldUsePrevious ? previousLegacySessionId : null);

  return {
    params: serialized,
    displayId,
    legacySessionId,
  };
}
/**
 * Xây dựng comment Markdown tóm tắt một run để inject vào issue thread.
 * Luôn trả về string (ít nhất là header status) — không trả null trừ khi
 * outcome là "succeeded" mà không có bất kỳ nội dung nào để hiển thị.
 */
function buildRunSummaryComment(input: {
  run: { id: string; createdAt: Date | string; finishedAt?: Date | string | null };
  agentId: string;
  outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
  resultJson: Record<string, unknown> | null;
  errorMessage: string | null;
  agentName: string;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
}): string | null {
  const { run, agentId, outcome, resultJson, errorMessage, agentName, stdoutExcerpt, stderrExcerpt } = input;
  const runIdShort = run.id.slice(0, 8);

  // Ưu tiên: resultJson.summary > resultJson.result > resultJson.message > tail of stdoutExcerpt
  // Lấy ĐUÔI (tail) của stdout vì đó là phần agent kết luận/summary
  let summaryText: string | null = null;
  let isRawLog = false;

  /** Normalize: unescape literal \r\n và \n thành newline thật */
  const unescapeNewlines = (s: string) =>
    s.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\r\n/g, "\n");

  /** Strip // prefix (code-comment style lines từ Claude agents) */
  const stripDoubleSlash = (s: string) => s.replace(/^\/\/\s?/gm, "");

  if (typeof resultJson?.summary === "string" && resultJson.summary.trim()) {
    summaryText = unescapeNewlines(resultJson.summary.trim());
  } else if (typeof resultJson?.result === "string" && resultJson.result.trim()) {
    summaryText = unescapeNewlines(resultJson.result.trim());
  } else if (typeof resultJson?.message === "string" && resultJson.message.trim()) {
    summaryText = unescapeNewlines(resultJson.message.trim());
  } else if (typeof stdoutExcerpt === "string" && stdoutExcerpt.trim()) {
    summaryText = unescapeNewlines(stdoutExcerpt.trim());
    isRawLog = true;
  }

  // Với succeeded mà không có content gì → skip để tránh spam comment rỗng
  if (outcome === "succeeded" && !summaryText) return null;

  const outcomeEmoji =
    outcome === "succeeded" ? "✅" :
    outcome === "cancelled" ? "⏹️" :
    outcome === "timed_out" ? "⏱️" : "❌";

  const outcomeLabel =
    outcome === "succeeded" ? "Hoàn thành" :
    outcome === "cancelled" ? "Đã huỷ" :
    outcome === "timed_out" ? "Hết thời gian" : "Thất bại";

  const lines: string[] = [];
  lines.push(`${outcomeEmoji} **${agentName}** ${outcomeLabel} — run \`${runIdShort}\``);
  // Metadata tag ẩn — UI sẽ parse để render Run ID badge với link
  lines.push(`<!-- paperclip-run:${run.id} agent:${agentId} -->`);
  lines.push("");

  if (summaryText) {
    let display = summaryText;

    // Strip '// ' prefix từ mọi source (Claude agent hay stdout đều có thể có)
    display = stripDoubleSlash(display);

    // Nếu quá dài → hiện ĐUÔI (tail) — nơi agent kết luận/summary thường nằm ở cuối
    if (display.length > 2000) {
      const tail = display.slice(-2000);
      const firstNewline = tail.indexOf("\n");
      const cleanTail = firstNewline !== -1 ? tail.slice(firstNewline + 1) : tail;
      display = "…_(bỏ qua phần đầu — xem đầy đủ tại trang Runs)_\n\n" + cleanTail;
    }

    if (isRawLog) {
      // Wrap raw stdout trong code block nếu chưa có
      if (!display.includes("```")) {
        display = "```text\n" + display.trim() + "\n```";
      }
    }

    lines.push(display);
  }

  if (errorMessage && outcome !== "succeeded") {
    const errDisplay = stderrExcerpt?.trim() || errorMessage;
    lines.push("");
    lines.push(`> **Lỗi:** ${errDisplay.slice(-400)}`);
  }

  return lines.join("\n");
}


export function heartbeatService(db: Db) {

  const instanceSettings = instanceSettingsService(db);
  const getCurrentUserRedactionOptions = async () => ({
    enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
  });

  const runLogStore = getRunLogStore();
  const secretsSvc = secretService(db);
  const companySkills = companySkillService(db);
  const issuesSvc = issueService(db);
  const executionWorkspacesSvc = executionWorkspaceService(db);
  const workspaceOperationsSvc = workspaceOperationService(db);
  const activeRunExecutions = new Set<string>();
  // Runs already logged as held by the fleet throttle (log once per run, not every tick).
  const fleetDeferredRunIds = new Set<string>();
  const budgetHooks = {
    cancelWorkForScope: cancelBudgetScopeWork,
  };
  const budgets = budgetService(db, budgetHooks);

  async function getAgent(agentId: string) {
    return db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
  }

  // GEM-1429: a single empty agents read is not proof of deletion — confirm with a second read
  // before cancelling/failing a run. Throws propagate (run stays queued for the next tick).
  async function getAgentConfirmed(agentId: string, runId: string) {
    const outcome = await lookupAgentConfirmed(() => getAgent(agentId));
    if (outcome.kind === "missing") return null;
    if (outcome.recoveredOnRetry) {
      logger.warn({ runId, agentId }, "[heartbeat] agent lookup returned empty once, found on re-read — run kept");
    }
    return outcome.agent;
  }

  async function getRun(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function getRuntimeState(agentId: string) {
    return db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function getTaskSession(
    companyId: string,
    agentId: string,
    adapterType: string,
    taskKey: string,
  ) {
    return db
      .select()
      .from(agentTaskSessions)
      .where(
        and(
          eq(agentTaskSessions.companyId, companyId),
          eq(agentTaskSessions.agentId, agentId),
          eq(agentTaskSessions.adapterType, adapterType),
          eq(agentTaskSessions.taskKey, taskKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function getLatestRunForSession(
    agentId: string,
    sessionId: string,
    opts?: { excludeRunId?: string | null },
  ) {
    const conditions = [
      eq(heartbeatRuns.agentId, agentId),
      eq(heartbeatRuns.sessionIdAfter, sessionId),
    ];
    if (opts?.excludeRunId) {
      conditions.push(sql`${heartbeatRuns.id} <> ${opts.excludeRunId}`);
    }
    return db
      .select()
      .from(heartbeatRuns)
      .where(and(...conditions))
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function getOldestRunForSession(agentId: string, sessionId: string) {
    return db
      .select({
        id: heartbeatRuns.id,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.sessionIdAfter, sessionId)))
      .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function resolveNormalizedUsageForSession(input: {
    agentId: string;
    runId: string;
    sessionId: string | null;
    rawUsage: UsageTotals | null;
  }) {
    const { agentId, runId, sessionId, rawUsage } = input;
    if (!sessionId || !rawUsage) {
      return {
        normalizedUsage: rawUsage,
        previousRawUsage: null as UsageTotals | null,
        derivedFromSessionTotals: false,
      };
    }

    const previousRun = await getLatestRunForSession(agentId, sessionId, { excludeRunId: runId });
    const previousRawUsage = readRawUsageTotals(previousRun?.usageJson);
    return {
      normalizedUsage: deriveNormalizedUsageDelta(rawUsage, previousRawUsage),
      previousRawUsage,
      derivedFromSessionTotals: previousRawUsage !== null,
    };
  }

  async function evaluateSessionCompaction(input: {
    agent: typeof agents.$inferSelect;
    sessionId: string | null;
    issueId: string | null;
  }): Promise<SessionCompactionDecision> {
    const { agent, sessionId, issueId } = input;
    if (!sessionId) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: null,
      };
    }

    const policy = parseSessionCompactionPolicy(agent);
    if (!policy.enabled || !hasSessionCompactionThresholds(policy)) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: null,
      };
    }

    const fetchLimit = Math.max(policy.maxSessionRuns > 0 ? policy.maxSessionRuns + 1 : 0, 4);
    const runs = await db
      .select({
        id: heartbeatRuns.id,
        createdAt: heartbeatRuns.createdAt,
        usageJson: heartbeatRuns.usageJson,
        resultJson: heartbeatRuns.resultJson,
        error: heartbeatRuns.error,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.sessionIdAfter, sessionId)))
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(fetchLimit);

    if (runs.length === 0) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: null,
      };
    }

    const latestRun = runs[0] ?? null;
    const oldestRun =
      policy.maxSessionAgeHours > 0
        ? await getOldestRunForSession(agent.id, sessionId)
        : runs[runs.length - 1] ?? latestRun;
    const latestRawUsage = readRawUsageTotals(latestRun?.usageJson);
    const sessionAgeHours =
      latestRun && oldestRun
        ? Math.max(
            0,
            (new Date(latestRun.createdAt).getTime() - new Date(oldestRun.createdAt).getTime()) / (1000 * 60 * 60),
          )
        : 0;

    let reason: string | null = null;
    if (policy.maxSessionRuns > 0 && runs.length > policy.maxSessionRuns) {
      reason = `session exceeded ${policy.maxSessionRuns} runs`;
    } else if (
      policy.maxRawInputTokens > 0 &&
      latestRawUsage &&
      latestRawUsage.inputTokens >= policy.maxRawInputTokens
    ) {
      reason =
        `session raw input reached ${formatCount(latestRawUsage.inputTokens)} tokens ` +
        `(threshold ${formatCount(policy.maxRawInputTokens)})`;
    } else if (policy.maxSessionAgeHours > 0 && sessionAgeHours >= policy.maxSessionAgeHours) {
      reason = `session age reached ${Math.floor(sessionAgeHours)} hours`;
    }

    if (!reason || !latestRun) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: latestRun?.id ?? null,
      };
    }

    const latestSummary = summarizeHeartbeatRunResultJson(latestRun.resultJson);
    const latestTextSummary =
      readNonEmptyString(latestSummary?.summary) ??
      readNonEmptyString(latestSummary?.result) ??
      readNonEmptyString(latestSummary?.message) ??
      readNonEmptyString(latestRun.error);

    const handoffMarkdown = [
      "Paperclip session handoff:",
      `- Previous session: ${sessionId}`,
      issueId ? `- Issue: ${issueId}` : "",
      `- Rotation reason: ${reason}`,
      latestTextSummary ? `- Last run summary: ${latestTextSummary}` : "",
      "Continue from the current task state. Rebuild only the minimum context you need.",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      rotate: true,
      reason,
      handoffMarkdown,
      previousRunId: latestRun.id,
    };
  }

  async function resolveSessionBeforeForWakeup(
    agent: typeof agents.$inferSelect,
    taskKey: string | null,
  ) {
    if (taskKey) {
      const codec = getAdapterSessionCodec(agent.adapterType);
      const existingTaskSession = await getTaskSession(
        agent.companyId,
        agent.id,
        agent.adapterType,
        taskKey,
      );
      const parsedParams = normalizeSessionParams(
        codec.deserialize(existingTaskSession?.sessionParamsJson ?? null),
      );
      return truncateDisplayId(
        existingTaskSession?.sessionDisplayId ??
          (codec.getDisplayId ? codec.getDisplayId(parsedParams) : null) ??
          readNonEmptyString(parsedParams?.sessionId),
      );
    }

    const runtimeForRun = await getRuntimeState(agent.id);
    return runtimeForRun?.sessionId ?? null;
  }

  async function resolveExplicitResumeSessionOverride(
    agent: typeof agents.$inferSelect,
    payload: Record<string, unknown> | null,
    taskKey: string | null,
  ) {
    const resumeFromRunId = readNonEmptyString(payload?.resumeFromRunId);
    if (!resumeFromRunId) return null;

    const resumeRun = await db
      .select({
        id: heartbeatRuns.id,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        sessionIdBefore: heartbeatRuns.sessionIdBefore,
        sessionIdAfter: heartbeatRuns.sessionIdAfter,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, resumeFromRunId),
          eq(heartbeatRuns.companyId, agent.companyId),
          eq(heartbeatRuns.agentId, agent.id),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!resumeRun) return null;

    const resumeContext = parseObject(resumeRun.contextSnapshot);
    const resumeTaskKey = deriveTaskKey(resumeContext, null) ?? taskKey;
    const resumeTaskSession = resumeTaskKey
      ? await getTaskSession(agent.companyId, agent.id, agent.adapterType, resumeTaskKey)
      : null;
    const sessionCodec = getAdapterSessionCodec(agent.adapterType);
    const sessionOverride = buildExplicitResumeSessionOverride({
      resumeFromRunId,
      resumeRunSessionIdBefore: resumeRun.sessionIdBefore,
      resumeRunSessionIdAfter: resumeRun.sessionIdAfter,
      taskSession: resumeTaskSession,
      sessionCodec,
    });
    if (!sessionOverride) return null;

    return {
      resumeFromRunId,
      taskKey: resumeTaskKey,
      issueId: readNonEmptyString(resumeContext.issueId),
      taskId: readNonEmptyString(resumeContext.taskId) ?? readNonEmptyString(resumeContext.issueId),
      sessionDisplayId: sessionOverride.sessionDisplayId,
      sessionParams: sessionOverride.sessionParams,
    };
  }

  async function resolveWorkspaceForRun(
    agent: typeof agents.$inferSelect,
    context: Record<string, unknown>,
    previousSessionParams: Record<string, unknown> | null,
    opts?: { useProjectWorkspace?: boolean | null },
  ): Promise<ResolvedWorkspaceForRun> {
    const issueId = readNonEmptyString(context.issueId);
    const contextProjectId = readNonEmptyString(context.projectId);
    const contextProjectWorkspaceId = readNonEmptyString(context.projectWorkspaceId);
    const issueProjectRef = issueId
      ? await db
          .select({
            projectId: issues.projectId,
            projectWorkspaceId: issues.projectWorkspaceId,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    const issueProjectId = issueProjectRef?.projectId ?? null;
    const preferredProjectWorkspaceId =
      issueProjectRef?.projectWorkspaceId ?? contextProjectWorkspaceId ?? null;
    const resolvedProjectId = issueProjectId ?? contextProjectId;
    const useProjectWorkspace = opts?.useProjectWorkspace !== false;
    const workspaceProjectId = useProjectWorkspace ? resolvedProjectId : null;

    const unorderedProjectWorkspaceRows = workspaceProjectId
      ? await db
          .select()
          .from(projectWorkspaces)
          .where(
            and(
              eq(projectWorkspaces.companyId, agent.companyId),
              eq(projectWorkspaces.projectId, workspaceProjectId),
            ),
          )
          .orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
      : [];
    const projectWorkspaceRows = prioritizeProjectWorkspaceCandidatesForRun(
      unorderedProjectWorkspaceRows,
      preferredProjectWorkspaceId,
    );

    const workspaceHints = projectWorkspaceRows.map((workspace) => ({
      workspaceId: workspace.id,
      cwd: readNonEmptyString(workspace.cwd),
      repoUrl: readNonEmptyString(workspace.repoUrl),
      repoRef: readNonEmptyString(workspace.repoRef),
    }));

    if (projectWorkspaceRows.length > 0) {
      const preferredWorkspace = preferredProjectWorkspaceId
        ? projectWorkspaceRows.find((workspace) => workspace.id === preferredProjectWorkspaceId) ?? null
        : null;
      const missingProjectCwds: string[] = [];
      let hasConfiguredProjectCwd = false;
      let preferredWorkspaceWarning: string | null = null;
      if (preferredProjectWorkspaceId && !preferredWorkspace) {
        preferredWorkspaceWarning =
          `Selected project workspace "${preferredProjectWorkspaceId}" is not available on this project.`;
      }
      for (const workspace of projectWorkspaceRows) {
        let projectCwd = readNonEmptyString(workspace.cwd);
        let managedWorkspaceWarning: string | null = null;
        if (!projectCwd || projectCwd === REPO_ONLY_CWD_SENTINEL) {
          try {
            const managedWorkspace = await ensureManagedProjectWorkspace({
              companyId: agent.companyId,
              projectId: workspaceProjectId ?? resolvedProjectId ?? workspace.projectId,
              repoUrl: readNonEmptyString(workspace.repoUrl),
            });
            projectCwd = managedWorkspace.cwd;
            managedWorkspaceWarning = managedWorkspace.warning;
          } catch (error) {
            if (preferredWorkspace?.id === workspace.id) {
              preferredWorkspaceWarning = error instanceof Error ? error.message : String(error);
            }
            continue;
          }
        }
        hasConfiguredProjectCwd = true;
        const projectCwdExists = await fs
          .stat(projectCwd)
          .then((stats) => stats.isDirectory())
          .catch(() => false);
        if (projectCwdExists) {
          return {
            cwd: projectCwd,
            source: "project_primary" as const,
            projectId: resolvedProjectId,
            workspaceId: workspace.id,
            repoUrl: workspace.repoUrl,
            repoRef: workspace.repoRef,
            workspaceHints,
            warnings: [preferredWorkspaceWarning, managedWorkspaceWarning].filter(
              (value): value is string => Boolean(value),
            ),
          };
        }
        if (preferredWorkspace?.id === workspace.id) {
          preferredWorkspaceWarning =
            `Selected project workspace path "${projectCwd}" is not available yet.`;
        }
        missingProjectCwds.push(projectCwd);
      }

      const fallbackCwd = resolveDefaultAgentWorkspaceDir(agent.id);
      await fs.mkdir(fallbackCwd, { recursive: true });
      const warnings: string[] = [];
      if (preferredWorkspaceWarning) {
        warnings.push(preferredWorkspaceWarning);
      }
      if (missingProjectCwds.length > 0) {
        const firstMissing = missingProjectCwds[0];
        const extraMissingCount = Math.max(0, missingProjectCwds.length - 1);
        warnings.push(
          extraMissingCount > 0
            ? `Project workspace path "${firstMissing}" and ${extraMissingCount} other configured path(s) are not available yet. Using fallback workspace "${fallbackCwd}" for this run.`
            : `Project workspace path "${firstMissing}" is not available yet. Using fallback workspace "${fallbackCwd}" for this run.`,
        );
      } else if (!hasConfiguredProjectCwd) {
        warnings.push(
          `Project workspace has no local cwd configured. Using fallback workspace "${fallbackCwd}" for this run.`,
        );
      }
      return {
        cwd: fallbackCwd,
        source: "project_primary" as const,
        projectId: resolvedProjectId,
        workspaceId: projectWorkspaceRows[0]?.id ?? null,
        repoUrl: projectWorkspaceRows[0]?.repoUrl ?? null,
        repoRef: projectWorkspaceRows[0]?.repoRef ?? null,
        workspaceHints,
        warnings,
      };
    }

    if (workspaceProjectId) {
      const managedWorkspace = await ensureManagedProjectWorkspace({
        companyId: agent.companyId,
        projectId: workspaceProjectId,
        repoUrl: null,
      });
      return {
        cwd: managedWorkspace.cwd,
        source: "project_primary" as const,
        projectId: resolvedProjectId,
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
        workspaceHints,
        warnings: managedWorkspace.warning ? [managedWorkspace.warning] : [],
      };
    }

    const sessionCwd = readNonEmptyString(previousSessionParams?.cwd);
    if (sessionCwd) {
      const sessionCwdExists = await fs
        .stat(sessionCwd)
        .then((stats) => stats.isDirectory())
        .catch(() => false);
      if (sessionCwdExists) {
        return {
          cwd: sessionCwd,
          source: "task_session" as const,
          projectId: resolvedProjectId,
          workspaceId: readNonEmptyString(previousSessionParams?.workspaceId),
          repoUrl: readNonEmptyString(previousSessionParams?.repoUrl),
          repoRef: readNonEmptyString(previousSessionParams?.repoRef),
          workspaceHints,
          warnings: [],
        };
      }
    }

    const cwd = resolveDefaultAgentWorkspaceDir(agent.id);
    await fs.mkdir(cwd, { recursive: true });
    const warnings: string[] = [];
    if (sessionCwd) {
      warnings.push(
        `Saved session workspace "${sessionCwd}" is not available. Using fallback workspace "${cwd}" for this run.`,
      );
    } else if (resolvedProjectId) {
      warnings.push(
        `No project workspace directory is currently available for this issue. Using fallback workspace "${cwd}" for this run.`,
      );
    } else {
      warnings.push(
        `No project or prior session workspace was available. Using fallback workspace "${cwd}" for this run.`,
      );
    }
    return {
      cwd,
      source: "agent_home" as const,
      projectId: resolvedProjectId,
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      workspaceHints,
      warnings,
    };
  }

  async function upsertTaskSession(input: {
    companyId: string;
    agentId: string;
    adapterType: string;
    taskKey: string;
    sessionParamsJson: Record<string, unknown> | null;
    sessionDisplayId: string | null;
    lastRunId: string | null;
    lastError: string | null;
  }) {
    const existing = await getTaskSession(
      input.companyId,
      input.agentId,
      input.adapterType,
      input.taskKey,
    );
    if (existing) {
      return db
        .update(agentTaskSessions)
        .set({
          sessionParamsJson: input.sessionParamsJson,
          sessionDisplayId: input.sessionDisplayId,
          lastRunId: input.lastRunId,
          lastError: input.lastError,
          updatedAt: new Date(),
        })
        .where(eq(agentTaskSessions.id, existing.id))
        .returning()
        .then((rows) => rows[0] ?? null);
    }

    return db
      .insert(agentTaskSessions)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        adapterType: input.adapterType,
        taskKey: input.taskKey,
        sessionParamsJson: input.sessionParamsJson,
        sessionDisplayId: input.sessionDisplayId,
        lastRunId: input.lastRunId,
        lastError: input.lastError,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function clearTaskSessions(
    companyId: string,
    agentId: string,
    opts?: { taskKey?: string | null; adapterType?: string | null },
  ) {
    const conditions = [
      eq(agentTaskSessions.companyId, companyId),
      eq(agentTaskSessions.agentId, agentId),
    ];
    if (opts?.taskKey) {
      conditions.push(eq(agentTaskSessions.taskKey, opts.taskKey));
    }
    if (opts?.adapterType) {
      conditions.push(eq(agentTaskSessions.adapterType, opts.adapterType));
    }

    return db
      .delete(agentTaskSessions)
      .where(and(...conditions))
      .returning()
      .then((rows) => rows.length);
  }

  async function ensureRuntimeState(agent: typeof agents.$inferSelect) {
    const existing = await getRuntimeState(agent.id);
    if (existing) return existing;

    return db
      .insert(agentRuntimeState)
      .values({
        agentId: agent.id,
        companyId: agent.companyId,
        adapterType: agent.adapterType,
        stateJson: {},
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function setRunStatus(
    runId: string,
    status: string,
    patch?: Partial<typeof heartbeatRuns.$inferInsert>,
    opts?: { expectedStatus?: string },
  ) {
    const updated = await db
      .update(heartbeatRuns)
      .set({ status, ...patch, updatedAt: new Date() })
      .where(
        opts?.expectedStatus
          ? and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, opts.expectedStatus))
          : eq(heartbeatRuns.id, runId),
      )
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      publishLiveEvent({
        companyId: updated.companyId,
        type: "heartbeat.run.status",
        payload: {
          runId: updated.id,
          agentId: updated.agentId,
          status: updated.status,
          invocationSource: updated.invocationSource,
          triggerDetail: updated.triggerDetail,
          error: updated.error ?? null,
          errorCode: updated.errorCode ?? null,
          startedAt: updated.startedAt ? new Date(updated.startedAt).toISOString() : null,
          finishedAt: updated.finishedAt ? new Date(updated.finishedAt).toISOString() : null,
        },
      });
    }

    return updated;
  }

  async function setWakeupStatus(
    wakeupRequestId: string | null | undefined,
    status: string,
    patch?: Partial<typeof agentWakeupRequests.$inferInsert>,
  ) {
    if (!wakeupRequestId) return;
    await db
      .update(agentWakeupRequests)
      .set({ status, ...patch, updatedAt: new Date() })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
  }

  async function appendRunEvent(
    run: typeof heartbeatRuns.$inferSelect,
    seq: number,
    event: {
      eventType: string;
      stream?: "system" | "stdout" | "stderr";
      level?: "info" | "warn" | "error";
      color?: string;
      message?: string;
      payload?: Record<string, unknown>;
    },
  ) {
    const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
    const sanitizedMessage = event.message
      ? redactCurrentUserText(event.message, currentUserRedactionOptions)
      : event.message;
    const sanitizedPayload = event.payload
      ? redactCurrentUserValue(event.payload, currentUserRedactionOptions)
      : event.payload;

    await db.insert(heartbeatRunEvents).values({
      companyId: run.companyId,
      runId: run.id,
      agentId: run.agentId,
      seq,
      eventType: event.eventType,
      stream: event.stream,
      level: event.level,
      color: event.color,
      message: sanitizedMessage,
      payload: sanitizedPayload,
    });

    publishLiveEvent({
      companyId: run.companyId,
      type: "heartbeat.run.event",
      payload: {
        runId: run.id,
        agentId: run.agentId,
        seq,
        eventType: event.eventType,
        stream: event.stream ?? null,
        level: event.level ?? null,
        color: event.color ?? null,
        message: sanitizedMessage ?? null,
        payload: sanitizedPayload ?? null,
      },
    });
  }

  async function nextRunEventSeq(runId: string) {
    const [row] = await db
      .select({ maxSeq: sql<number | null>`max(${heartbeatRunEvents.seq})` })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
    return Number(row?.maxSeq ?? 0) + 1;
  }

  async function persistRunProcessMetadata(
    runId: string,
    meta: { pid: number; startedAt: string },
  ) {
    const startedAt = new Date(meta.startedAt);
    return db
      .update(heartbeatRuns)
      .set({
        processPid: meta.pid,
        processStartedAt: Number.isNaN(startedAt.getTime()) ? new Date() : startedAt,
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function clearDetachedRunWarning(runId: string) {
    const updated = await db
      .update(heartbeatRuns)
      .set({
        error: null,
        errorCode: null,
        updatedAt: new Date(),
      })
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.errorCode, DETACHED_PROCESS_ERROR_CODE)))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) return null;

    await appendRunEvent(updated, await nextRunEventSeq(updated.id), {
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: "Detached child process reported activity; cleared detached warning",
    });
    return updated;
  }

  async function enqueueProcessLossRetry(
    run: typeof heartbeatRuns.$inferSelect,
    agent: typeof agents.$inferSelect,
    now: Date,
  ) {
    const contextSnapshot = parseObject(run.contextSnapshot);
    const issueId = readNonEmptyString(contextSnapshot.issueId);
    const taskKey = deriveTaskKeyWithHeartbeatFallback(contextSnapshot, null);
    const sessionBefore = await resolveSessionBeforeForWakeup(agent, taskKey);
    const retryContextSnapshot = {
      ...contextSnapshot,
      retryOfRunId: run.id,
      wakeReason: "process_lost_retry",
      retryReason: "process_lost",
    };

    const queued = await db.transaction(async (tx) => {
      const wakeupRequest = await tx
        .insert(agentWakeupRequests)
        .values({
          companyId: run.companyId,
          agentId: run.agentId,
          source: "automation",
          triggerDetail: "system",
          reason: "process_lost_retry",
          payload: {
            ...(issueId ? { issueId } : {}),
            retryOfRunId: run.id,
          },
          status: "queued",
          requestedByActorType: "system",
          requestedByActorId: null,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);

      const retryRun = await tx
        .insert(heartbeatRuns)
        .values({
          companyId: run.companyId,
          agentId: run.agentId,
          invocationSource: "automation",
          triggerDetail: "system",
          status: "queued",
          wakeupRequestId: wakeupRequest.id,
          contextSnapshot: retryContextSnapshot,
          sessionIdBefore: sessionBefore,
          retryOfRunId: run.id,
          processLossRetryCount: (run.processLossRetryCount ?? 0) + 1,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);

      await tx
        .update(agentWakeupRequests)
        .set({
          runId: retryRun.id,
          updatedAt: now,
        })
        .where(eq(agentWakeupRequests.id, wakeupRequest.id));

      if (issueId) {
        await tx
          .update(issues)
          .set({
            executionRunId: retryRun.id,
            executionAgentNameKey: normalizeAgentNameKey(agent.name),
            executionLockedAt: now,
            updatedAt: now,
          })
          .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId), eq(issues.executionRunId, run.id)));
      }

      return retryRun;
    });

    publishLiveEvent({
      companyId: queued.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: queued.id,
        agentId: queued.agentId,
        invocationSource: queued.invocationSource,
        triggerDetail: queued.triggerDetail,
        wakeupRequestId: queued.wakeupRequestId,
      },
    });

    await appendRunEvent(queued, 1, {
      eventType: "lifecycle",
      stream: "system",
      level: "warn",
      message: "Queued automatic retry after orphaned child process was confirmed dead",
      payload: {
        retryOfRunId: run.id,
      },
    });

    return queued;
  }

  function parseHeartbeatPolicy(agent: typeof agents.$inferSelect) {
    const runtimeConfig = parseObject(agent.runtimeConfig);
    const heartbeat = parseObject(runtimeConfig.heartbeat);

    // GEMRAL FIX 2026-04-06 P2: Add cron expression support.
    // If cronExpression is set AND valid, it takes precedence over intervalSec.
    // Cron format: standard 5-field (minute hour day-of-month month day-of-week).
    // Example: "0 9 * * *" = daily 09:00. "*/15 * * * *" = every 15 min.
    // If cron fails validation, fall back to intervalSec with a warning.
    const rawCron = asString(heartbeat.cronExpression ?? heartbeat.cron, "").trim();
    let cron: ParsedCron | null = null;
    if (rawCron) {
      const err = validateCron(rawCron);
      if (err) {
        logger.warn({ agentId: agent.id, cron: rawCron, error: err }, "Invalid cronExpression, falling back to intervalSec");
      } else {
        try {
          cron = parseCron(rawCron);
        } catch {
          cron = null;
        }
      }
    }

    return {
      enabled: asBoolean(heartbeat.enabled, true),
      intervalSec: Math.max(0, asNumber(heartbeat.intervalSec, 0)),
      cronExpression: cron ? rawCron : "",
      cron,
      // GEMRAL FIX 2026-06-10 (B): max lateness (seconds) an overdue cron slot may
      // still fire as a catch-up. Beyond this the slot is skipped and the baseline
      // resynced to the next scheduled time. Default 3600s (1h): a 07:00 daily brief
      // restarted at 07:30 still fires, but a restart at 14:00 does NOT run the
      // "morning" job in the afternoon. Set 0 to disable the guard (legacy always-fire).
      catchUpGraceSec: Math.max(0, asNumber(heartbeat.catchUpGraceSec, 3600)),
      wakeOnDemand: asBoolean(heartbeat.wakeOnDemand ?? heartbeat.wakeOnAssignment ?? heartbeat.wakeOnOnDemand ?? heartbeat.wakeOnAutomation, true),
      maxConcurrentRuns: normalizeMaxConcurrentRuns(heartbeat.maxConcurrentRuns),
    };
  }

  async function countRunningRunsForAgent(agentId: string) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running")));
    return Number(count ?? 0);
  }

  /**
   * Atomic queued→running transition guarded by the company-wide fleet throttle
   * (fleet-throttle.ts rules 1+2). Serialized per company in-process AND by a
   * transaction-scoped advisory lock, so two concurrent claimers can never both see
   * "1 running" and push the fleet to 3. Returns null (run stays queued) when the
   * fleet is full; the periodic recovery tick (resumeQueuedRuns) retries it.
   */
  async function claimQueuedRunWithinFleetLimits(run: typeof heartbeatRuns.$inferSelect) {
    const fleet = readFleetThrottleConfig();
    const doClaim = async (executor: Pick<Db, "update">) => {
      const claimedAt = new Date();
      return executor
        .update(heartbeatRuns)
        .set({
          status: "running",
          startedAt: run.startedAt ?? claimedAt,
          updatedAt: claimedAt,
        })
        .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "queued")))
        .returning()
        .then((rows) => rows[0] ?? null);
    };
    if (!isFleetClaimGateEnabled(fleet)) return doClaim(db);

    return withKeyedLock(`fleet-claim:${run.companyId}`, () =>
      boundedPoll(db, async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`paperclip:fleet-claim:${run.companyId}`}))`,
        );
        const windowStart = fleetWindowStart(new Date(), fleet.startWindowMs);
        const [counts] = await tx
          .select({
            running: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'running')`,
            runningNonTimer: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'running' and ${heartbeatRuns.invocationSource} is distinct from 'timer')`,
            startsInWindow: sql<number>`count(*) filter (where ${heartbeatRuns.startedAt} >= ${windowStart.toISOString()}::timestamptz)`,
          })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, run.companyId),
              sql`(${heartbeatRuns.status} = 'running' or ${heartbeatRuns.startedAt} >= ${windowStart.toISOString()}::timestamptz)`,
            ),
          );
        // Rule 4: claimable queued timer runs (agent invokable + no run in flight) that a
        // non-timer claim must not crowd out. Unclaimable timers are ignored so they can
        // never block the fleet.
        let pendingTimerRuns = 0;
        if (fleet.timerPriority && run.invocationSource !== "timer") {
          const [pending] = await tx
            .select({ count: sql<number>`count(*)` })
            .from(heartbeatRuns)
            .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
            .where(
              and(
                eq(heartbeatRuns.companyId, run.companyId),
                eq(heartbeatRuns.status, "queued"),
                eq(heartbeatRuns.invocationSource, "timer"),
                sql`${heartbeatRuns.id} <> ${run.id}`,
                notInArray(agents.status, [...HEARTBEAT_SKIP_STATUSES]),
                sql`not exists (select 1 from heartbeat_runs inflight where inflight.agent_id = ${heartbeatRuns.agentId} and inflight.status = 'running')`,
              ),
            );
          pendingTimerRuns = Number(pending?.count ?? 0);
        }
        const verdict = evaluateFleetClaim(
          fleet,
          {
            running: Number(counts?.running ?? 0),
            startsInWindow: Number(counts?.startsInWindow ?? 0),
            runningNonTimer: Number(counts?.runningNonTimer ?? 0),
          },
          { invocationSource: run.invocationSource, pendingTimerRuns },
        );
        if (!verdict.ok) {
          if (!fleetDeferredRunIds.has(run.id)) {
            if (fleetDeferredRunIds.size > 500) fleetDeferredRunIds.clear();
            fleetDeferredRunIds.add(run.id);
            logger.info(
              { runId: run.id, agentId: run.agentId, ...verdict, maxRunning: fleet.maxRunning, startsPerWindow: fleet.startsPerWindow },
              "[fleet-throttle] run held in queue (company-wide limit)",
            );
          }
          return null;
        }
        fleetDeferredRunIds.delete(run.id);
        return doClaim(tx as unknown as Db);
      }),
    );
  }

  async function claimQueuedRun(run: typeof heartbeatRuns.$inferSelect) {
    if (run.status !== "queued") return run;
    const agent = await getAgentConfirmed(run.agentId, run.id);
    if (!agent) {
      await cancelRunInternal(run.id, "Cancelled because the agent no longer exists");
      return null;
    }
    if (isHeartbeatSkipped(agent.status)) {
      await cancelRunInternal(run.id, "Cancelled because the agent is not invokable");
      return null;
    }

    const context = parseObject(run.contextSnapshot);
    const budgetBlock = await budgets.getInvocationBlock(run.companyId, run.agentId, {
      issueId: readNonEmptyString(context.issueId),
      projectId: readNonEmptyString(context.projectId),
    });
    if (budgetBlock) {
      await cancelRunInternal(run.id, budgetBlock.reason);
      return null;
    }

    const claimed = await claimQueuedRunWithinFleetLimits(run);
    if (!claimed) return null;
    const claimedAt = claimed.updatedAt ?? new Date();

    publishLiveEvent({
      companyId: claimed.companyId,
      type: "heartbeat.run.status",
      payload: {
        runId: claimed.id,
        agentId: claimed.agentId,
        status: claimed.status,
        invocationSource: claimed.invocationSource,
        triggerDetail: claimed.triggerDetail,
        error: claimed.error ?? null,
        errorCode: claimed.errorCode ?? null,
        startedAt: claimed.startedAt ? new Date(claimed.startedAt).toISOString() : null,
        finishedAt: claimed.finishedAt ? new Date(claimed.finishedAt).toISOString() : null,
      },
    });

    await setWakeupStatus(claimed.wakeupRequestId, "claimed", { claimedAt });
    return claimed;
  }

  async function finalizeAgentStatus(
    agentId: string,
    outcome: "succeeded" | "failed" | "cancelled" | "timed_out",
    opts?: { retryScheduled?: boolean; infraFault?: boolean },
  ) {
    const existing = await getAgent(agentId);
    if (!existing) return;

    if (existing.status === "paused" || existing.status === "terminated") {
      return;
    }

    const runningCount = await countRunningRunsForAgent(agentId);
    // A quota failure with a scheduled retry is not an agent fault → idle, not error.
    const nextStatus =
      runningCount > 0
        ? "running"
        : outcome === "succeeded" || outcome === "cancelled" || opts?.retryScheduled || opts?.infraFault
          ? "idle"
          : "error";

    const updated = await db
      .update(agents)
      .set({
        status: nextStatus,
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      publishLiveEvent({
        companyId: updated.companyId,
        type: "agent.status",
        payload: {
          agentId: updated.id,
          status: updated.status,
          lastHeartbeatAt: updated.lastHeartbeatAt
            ? new Date(updated.lastHeartbeatAt).toISOString()
            : null,
          outcome,
        },
      });
    }
  }

  // GEM-1004: quota wall → persist a retry plan in agent_runtime_state.state_json
  // (survives restart) instead of leaving the agent in `error`. A later successful
  // run clears any pending plan. Best-effort: a failure here must not break the
  // run-finalize path (the run is already recorded as failed).
  async function syncQuotaRetryAfterRun(input: {
    agent: typeof agents.$inferSelect;
    run: typeof heartbeatRuns.$inferSelect;
    context: Record<string, unknown>;
    issueId: string | null;
    outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
    adapterResult: AdapterExecutionResult;
    nextSeq: () => number;
  }): Promise<QuotaRetryPlan | null> {
    const { agent, run, context, outcome, adapterResult } = input;
    try {
      if (outcome === "succeeded") {
        await db
          .update(agentRuntimeState)
          .set({ stateJson: sql`${agentRuntimeState.stateJson} - 'quotaRetry'`, updatedAt: new Date() })
          .where(and(
            eq(agentRuntimeState.agentId, agent.id),
            sql`(${agentRuntimeState.stateJson} -> 'quotaRetry') is not null`,
          ));
        return null;
      }
      if (outcome !== "failed") return null;

      const plan = planQuotaRetry({
        errorCode: adapterResult.errorCode,
        errorMeta: adapterResult.errorMeta ?? null,
        priorAttempts: asNumber(context.quotaRetryAttempt, 0),
        runId: run.id,
        // Timer runs sit on the evergreen heartbeat thread — let the retry re-derive it.
        issueId: context.heartbeatThread === true ? null : input.issueId,
        fromTimer: run.invocationSource === "timer",
        now: new Date(),
      });
      if (!plan) return null;

      await db
        .update(agentRuntimeState)
        .set({
          stateJson: sql`${agentRuntimeState.stateJson} || jsonb_build_object('quotaRetry', ${JSON.stringify(plan)}::jsonb)`,
          updatedAt: new Date(),
        })
        .where(eq(agentRuntimeState.agentId, agent.id));
      await appendRunEvent(run, input.nextSeq(), {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message: `Retryable failure (${plan.errorCode}) — retry ${plan.attempt} scheduled at ${plan.retryAt}`,
        payload: plan as unknown as Record<string, unknown>,
      });
      return plan;
    } catch (err) {
      logger.warn({ err, runId: run.id, agentId: agent.id }, "quota retry: failed to sync plan (best-effort)");
      return null;
    }
  }

  // Fire due quota retries. The claim is one atomic UPDATE (CTE snapshots the plan,
  // the UPDATE removes it) so two overlapping ticks cannot double-fire a retry.
  /**
   * Fleet rule 3: remaining timer wakes per company in the current wall-clock hour.
   * Every timer-source run created this hour counts (scheduler fires AND quota retries,
   * which also carry invocationSource=timer), except exempt agents. null = rule off.
   */
  async function computeTimerWakeBudget(
    now: Date,
    fleet: ReturnType<typeof readFleetThrottleConfig>,
    exemptIds: Set<string>,
  ): Promise<Map<string, number> | null> {
    if (fleet.timerWakesPerHour <= 0) return null;
    const hourStart = fleetWindowStart(now, fleet.timerWindowMs);
    const rows = await db
      .select({ companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId, count: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.invocationSource, "timer"), sql`${heartbeatRuns.createdAt} >= ${hourStart.toISOString()}::timestamptz`))
      .groupBy(heartbeatRuns.companyId, heartbeatRuns.agentId);
    const budget = new Map<string, number>();
    for (const row of rows) {
      if (exemptIds.has(row.agentId)) continue;
      budget.set(row.companyId, (budget.get(row.companyId) ?? fleet.timerWakesPerHour) - Number(row.count ?? 0));
    }
    return budget;
  }

  async function lastFinishedAtByAgent(agentIds: string[], companyIds: string[]) {
    const result = new Map<string, Date | null>();
    if (agentIds.length === 0) return result;
    // GEM-1443: company_id filter lets Postgres use heartbeat_runs_company_agent_started_idx
    // (agent_id alone = seq scan of the 140MB table every tick with ≥2 fires, ~550ms measured).
    const rows = await db
      .select({ agentId: heartbeatRuns.agentId, lastFinishedAt: sql<string | null>`max(${heartbeatRuns.finishedAt})` })
      .from(heartbeatRuns)
      .where(and(inArray(heartbeatRuns.companyId, companyIds), inArray(heartbeatRuns.agentId, agentIds)))
      .groupBy(heartbeatRuns.agentId);
    for (const row of rows) {
      result.set(row.agentId, row.lastFinishedAt ? new Date(row.lastFinishedAt) : null);
    }
    return result;
  }

  async function fireDueQuotaRetries(
    now: Date,
    fleetGate?: { timerBudget: Map<string, number> | null; timerExemptIds: Set<string>; fleetDefault: number },
  ) {
    // Fleet rule 3: timer-source quota retries share the hourly timer cap. Over-cap plans
    // are left untouched (still due) so a later tick fires them — never dropped.
    let agentFilter = sql``;
    const timerBudget = fleetGate?.timerBudget ?? null;
    if (timerBudget && fleetGate) {
      const dueRows = await boundedPoll(db, (tx) =>
        tx.execute(sql`
          select s.agent_id as "agentId", a.company_id as "companyId",
                 coalesce(s.state_json -> 'quotaRetry' ->> 'source', 'timer') as "source"
          from agent_runtime_state s
          join agents a on a.id = s.agent_id
          where (s.state_json -> 'quotaRetry' ->> 'retryAt') ~ '^\\d{4}-'
            and (s.state_json -> 'quotaRetry' ->> 'retryAt')::timestamptz <= ${now.toISOString()}::timestamptz
          order by (s.state_json -> 'quotaRetry' ->> 'retryAt')::timestamptz asc
        `),
      );
      const allowed: string[] = [];
      for (const row of Array.from(dueRows as unknown as Iterable<{ agentId: string; companyId: string; source: string }>)) {
        if (row.source !== "timer" || fleetGate.timerExemptIds.has(row.agentId)) {
          allowed.push(row.agentId);
          continue;
        }
        const remaining = timerBudget.get(row.companyId) ?? fleetGate.fleetDefault;
        if (remaining <= 0) continue;
        timerBudget.set(row.companyId, remaining - 1);
        allowed.push(row.agentId);
      }
      if (allowed.length === 0) return { due: 0, fired: 0 };
      agentFilter = sql`and agent_id::text in (${sql.join(allowed.map((id) => sql`${id}`), sql`, `)})`;
    }
    const claimed = await boundedPoll(db, (tx) =>
      tx.execute(sql`
        with due as (
          select agent_id, state_json -> 'quotaRetry' as plan
          from agent_runtime_state
          where (state_json -> 'quotaRetry' ->> 'retryAt') ~ '^\\d{4}-'
            and (state_json -> 'quotaRetry' ->> 'retryAt')::timestamptz <= ${now.toISOString()}::timestamptz
            ${agentFilter}
          for update skip locked
        )
        update agent_runtime_state s
        set state_json = s.state_json - 'quotaRetry', updated_at = ${now.toISOString()}::timestamptz
        from due
        where s.agent_id = due.agent_id
        returning s.agent_id as "agentId", due.plan as "plan"
      `),
    );
    const rows = Array.from(claimed as unknown as Iterable<{ agentId: string; plan: unknown }>);
    let fired = 0;
    for (const row of rows) {
      const plan = readQuotaRetryPlan(row.plan);
      if (!plan) continue;
      try {
        const run = await enqueueWakeup(row.agentId, {
          source: plan.source,
          triggerDetail: "system",
          reason: "quota_retry",
          payload: plan.issueId ? { issueId: plan.issueId } : null,
          requestedByActorType: "system",
          requestedByActorId: "quota_retry_scheduler",
          contextSnapshot: {
            ...(plan.issueId ? { issueId: plan.issueId } : {}),
            retryOfRunId: plan.retryOfRunId,
            retryReason: plan.errorCode,
            quotaRetryAttempt: plan.attempt,
          },
        });
        if (run) fired += 1;
        logger.info({ agentId: row.agentId, plan, runId: run?.id ?? null }, "quota retry: fired");
      } catch (err) {
        // paused / budget-blocked / terminated → drop the retry, leave a trace.
        logger.warn({ err, agentId: row.agentId, plan }, "quota retry: wake rejected");
      }
    }
    return { due: rows.length, fired };
  }

  async function reapOrphanedRuns(opts?: { staleThresholdMs?: number }) {
    const staleThresholdMs = opts?.staleThresholdMs ?? 0;
    const now = new Date();

    // Find all runs stuck in "running" state (queued runs are legitimately waiting; resumeQueuedRuns handles them)
    // F2: quét bounded 15s (SET LOCAL). Vòng reap per-run bên dưới dùng db thường.
    const activeRuns = await boundedPoll(db, (tx) =>
      tx
        .select({
          run: heartbeatRuns,
          adapterType: agents.adapterType,
        })
        .from(heartbeatRuns)
        .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
        .where(eq(heartbeatRuns.status, "running")),
    );

    const reaped: string[] = [];

    for (const { run, adapterType } of activeRuns) {
      const tracksLocalChild = isTrackedLocalChildProcessAdapter(adapterType);
      const hasMapEntry = runningProcesses.has(run.id) || activeRunExecutions.has(run.id);
      if (hasMapEntry) {
        // Map entries are advisory — they're maintained by adapter exit handlers
        // (`runChildProcess` close/exit handler, `executeRun` finally). When a child
        // crashes externally (kill -9, OOM, Windows TaskKill) those handlers can fail
        // to fire if stdio doesn't drain, leaving an orphan entry. OS-level pid truth
        // wins: if we have a tracked pid and the OS confirms it's gone, treat the
        // Map entry as stale, drop it, and proceed to reap. Otherwise trust the Map
        // (this server is actively executing the run).
        const pidIsKnownDead =
          tracksLocalChild && !!run.processPid && !isProcessAlive(run.processPid);
        if (!pidIsKnownDead) continue;
        runningProcesses.delete(run.id);
        activeRunExecutions.delete(run.id);
      }

      // Apply staleness threshold to avoid false positives
      if (staleThresholdMs > 0) {
        const refTime = run.updatedAt ? new Date(run.updatedAt).getTime() : 0;
        if (now.getTime() - refTime < staleThresholdMs) continue;
      }

      if (tracksLocalChild && run.processPid && isProcessAlive(run.processPid)) {
        if (run.errorCode !== DETACHED_PROCESS_ERROR_CODE) {
          const detachedMessage = `${DETACHED_EVENT_MESSAGE_PREFIX}, but child pid ${run.processPid} is still alive`;
          // Dấu vết BỀN ghi CÙNG lệnh UPDATE (atomic) vào contextSnapshot — clearDetachedRunWarning
          // không đụng field này; CAS status='running' để không hồi sinh run reaper khác vừa fail.
          const detachedRun = await setRunStatus(
            run.id,
            "running",
            {
              error: detachedMessage,
              errorCode: DETACHED_PROCESS_ERROR_CODE,
              contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || jsonb_build_object('processDetachedAt', ${now.toISOString()}::text)` as unknown as Record<string, unknown>,
            },
            { expectedStatus: "running" },
          );
          if (detachedRun) {
            await appendRunEvent(detachedRun, await nextRunEventSeq(detachedRun.id), {
              eventType: "lifecycle",
              stream: "system",
              level: "warn",
              message: detachedMessage,
              payload: {
                processPid: run.processPid,
              },
            });
          }
        }
        continue;
      }

      // Không retry lượt đã từng `process_detached`: tiến trình sống qua restart rồi tự exit ⇒ có
      // thể đã làm xong việc ra ngoài (đăng bài...) mà server không thấy → chạy lại = đăng đôi.
      let shouldRetry =
        tracksLocalChild &&
        !!run.processPid &&
        (run.processLossRetryCount ?? 0) < 1 &&
        run.errorCode !== DETACHED_PROCESS_ERROR_CODE;

      // errorCode có thể đã bị clearDetachedRunWarning dọn khi tiến trình báo hoạt động lại →
      // tra event lifecycle bền để biết run này từng detached (Codex R2).
      if (shouldRetry && readNonEmptyString(parseObject(run.contextSnapshot).processDetachedAt)) {
        shouldRetry = false;
      }
      // Run detached trước bản vá này chỉ có event lifecycle (chưa có processDetachedAt).
      if (shouldRetry) {
        const everDetached = await db
          .select({ id: heartbeatRunEvents.id })
          .from(heartbeatRunEvents)
          .where(
            and(
              eq(heartbeatRunEvents.runId, run.id),
              eq(heartbeatRunEvents.eventType, "lifecycle"),
              sql`${heartbeatRunEvents.message} like ${DETACHED_EVENT_MESSAGE_PREFIX + "%"}`,
            ),
          )
          .limit(1)
          .then((rows) => rows.length > 0);
        if (everDetached) shouldRetry = false;
      }

      // Skip retry if the assigned issue is already done/cancelled — work was committed before the crash
      if (shouldRetry) {
        const contextIssueId = readNonEmptyString(parseObject(run.contextSnapshot).issueId);
        if (contextIssueId) {
          const issueStatus = await db
            .select({ status: issues.status })
            .from(issues)
            .where(and(eq(issues.id, contextIssueId), eq(issues.companyId, run.companyId)))
            .then((rows) => rows[0]?.status ?? null);
          if (issueStatus === "done" || issueStatus === "cancelled") {
            shouldRetry = false;
          }
        }
      }

      const baseMessage = run.processPid
        ? `Process lost -- child pid ${run.processPid} is no longer running`
        : "Process lost -- server may have restarted";

      // Chiếm dòng có điều kiện status='running' → 2 reaper chạy song song chỉ 1 bên thắng,
      // bên thua bỏ qua (không enqueue retry đôi).
      let finalizedRun = await setRunStatus(
        run.id,
        "failed",
        {
          error: shouldRetry ? `${baseMessage}; retrying once` : baseMessage,
          errorCode: "process_lost",
          finishedAt: now,
        },
        { expectedStatus: "running" },
      );
      if (!finalizedRun) continue;
      // Quyết lại trên dòng RETURNING (đã khoá khi UPDATE): reaper khác có thể vừa đánh dấu
      // detached giữa lúc mình snapshot và lúc mình chiếm → không retry, sửa lại message.
      if (shouldRetry && readNonEmptyString(parseObject(finalizedRun.contextSnapshot).processDetachedAt)) {
        shouldRetry = false;
        finalizedRun = (await setRunStatus(run.id, "failed", { error: baseMessage })) ?? finalizedRun;
      }
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: now,
        error: shouldRetry ? `${baseMessage}; retrying once` : baseMessage,
      });
      if (!finalizedRun) finalizedRun = await getRun(run.id);
      if (!finalizedRun) continue;

      let retriedRun: typeof heartbeatRuns.$inferSelect | null = null;
      if (shouldRetry) {
        const agent = await getAgentConfirmed(run.agentId, run.id);
        if (agent) {
          retriedRun = await enqueueProcessLossRetry(finalizedRun, agent, now);
        }
      } else {
        await releaseIssueExecutionAndPromote(finalizedRun);
      }

      await appendRunEvent(finalizedRun, await nextRunEventSeq(finalizedRun.id), {
        eventType: "lifecycle",
        stream: "system",
        level: "error",
        message: shouldRetry
          ? `${baseMessage}; queued retry ${retriedRun?.id ?? ""}`.trim()
          : baseMessage,
        payload: {
          ...(run.processPid ? { processPid: run.processPid } : {}),
          ...(retriedRun ? { retryRunId: retriedRun.id } : {}),
        },
      });

      // GEM-1452: process lost = server/PM2 restart, not an agent fault -> idle, not error.
      await finalizeAgentStatus(run.agentId, "failed", { infraFault: true });
      await startNextQueuedRunForAgent(run.agentId);
      runningProcesses.delete(run.id);
      reaped.push(run.id);
    }

    if (reaped.length > 0) {
      logger.warn({ reapedCount: reaped.length, runIds: reaped }, "reaped orphaned heartbeat runs");
    }
    return { reaped: reaped.length, runIds: reaped };
  }

  async function resumeQueuedRuns() {
    // F2: quét queued bounded 15s (SET LOCAL). Vòng claim/spawn per-agent bên dưới dùng db thường.
    const queuedRuns = await boundedPoll(db, (tx) =>
      tx
        .select({
          agentId: heartbeatRuns.agentId,
          invocationSource: heartbeatRuns.invocationSource,
          createdAt: heartbeatRuns.createdAt,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.status, "queued"))
        // Fleet throttle fairness: the agent whose run has waited longest goes first.
        .orderBy(asc(heartbeatRuns.createdAt)),
    );

    // Rule 4 (GEM-1413): agents holding a queued timer run are drained before backlogs.
    const ordered = orderQueuedRunsForClaim(readFleetThrottleConfig(), queuedRuns);
    const agentIds = [...new Set(ordered.map((r) => r.agentId))];
    let spawnedPrevious = false;
    for (let i = 0; i < agentIds.length; i++) {
      // GEMRAL FIX 2026-05-10: Stagger subprocess spawning across agents.
      // executeRun() inside startNextQueuedRunForAgent is fire-and-forget (void),
      // so even though we await the claim step, all subprocesses still end up
      // spawning nearly simultaneously. With 4+ agents each making their first
      // Gemini API call at the same instant, Google's burst rate limiter fires
      // "Reset after 0s" (429). A 2s gap between agents prevents the burst.
      // Only stagger after an agent actually spawned — runs held by the fleet throttle
      // spawn nothing, so waiting 2s per held agent would just stall the recovery tick.
      if (i > 0 && spawnedPrevious) {
        await new Promise<void>((res) => setTimeout(res, 2000));
      }
      // GEM-1368: Bọc timeout 15s cho từng agent để chống việc 1 agent kẹt làm nghẽn toàn bộ queue.
      const started = await Promise.race([
        startNextQueuedRunForAgent(agentIds[i]!),
        new Promise<never[]>((res) => {
          const t = setTimeout(() => res([]), 15_000);
          t.unref?.();
        }),
      ]);
      spawnedPrevious = Array.isArray(started) && started.length > 0;
    }
  }


  async function updateRuntimeState(
    agent: typeof agents.$inferSelect,
    run: typeof heartbeatRuns.$inferSelect,
    result: AdapterExecutionResult,
    session: { legacySessionId: string | null },
    normalizedUsage?: UsageTotals | null,
  ) {
    await ensureRuntimeState(agent);
    const usage = normalizedUsage ?? normalizeUsageTotals(result.usage);
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const cachedInputTokens = usage?.cachedInputTokens ?? 0;
    const billingType = normalizeLedgerBillingType(result.billingType);
    const additionalCostCents = normalizeBilledCostCents(result.costUsd, billingType);
    const hasTokenUsage = inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0;
    const provider = result.provider ?? "unknown";
    const biller = resolveLedgerBiller(result);
    const ledgerScope = await resolveLedgerScopeForRun(db, agent.companyId, run);

    await db
      .update(agentRuntimeState)
      .set({
        adapterType: agent.adapterType,
        sessionId: session.legacySessionId,
        lastRunId: run.id,
        lastRunStatus: run.status,
        lastError: result.errorMessage ?? null,
        totalInputTokens: sql`${agentRuntimeState.totalInputTokens} + ${inputTokens}`,
        totalOutputTokens: sql`${agentRuntimeState.totalOutputTokens} + ${outputTokens}`,
        totalCachedInputTokens: sql`${agentRuntimeState.totalCachedInputTokens} + ${cachedInputTokens}`,
        totalCostCents: sql`${agentRuntimeState.totalCostCents} + ${additionalCostCents}`,
        updatedAt: new Date(),
      })
      .where(eq(agentRuntimeState.agentId, agent.id));

    if (additionalCostCents > 0 || hasTokenUsage) {
      const costs = costService(db, budgetHooks);
      await costs.createEvent(agent.companyId, {
        heartbeatRunId: run.id,
        agentId: agent.id,
        issueId: ledgerScope.issueId,
        projectId: ledgerScope.projectId,
        provider,
        biller,
        billingType,
        model: result.model ?? "unknown",
        inputTokens,
        cachedInputTokens,
        outputTokens,
        costCents: additionalCostCents,
        occurredAt: new Date(),
      });
    }
  }

  async function writeAgentTelemetry(params: {
    agentId: string;
    agentName: string;
    runId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number | null;
    success: boolean;
    errorMessage: string | null;
    responseTimeMs: number | null;
    inferenceTimeMs: number | null;
    adapterType: string;
  }): Promise<void> {
    const supabaseUrl = process.env.GEMRAL_SUPABASE_URL ?? "https://pgfkbcnzqozzkohwbgbk.supabase.co";
    const serviceKey = process.env.GEMRAL_SUPABASE_SERVICE_KEY ?? "";
    if (!serviceKey) return;
    await fetch(`${supabaseUrl}/rest/v1/ai_usage_logs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": serviceKey,
        "Authorization": `Bearer ${serviceKey}`,
        "Prefer": "return=minimal",
      },
      body: JSON.stringify({
        feature: "agent_heartbeat",
        model: params.model,
        prompt_tokens: params.inputTokens,
        completion_tokens: params.outputTokens,
        total_tokens: params.totalTokens,
        request_type: params.adapterType,
        success: params.success,
        error_message: params.errorMessage,
        response_time_ms: params.responseTimeMs,
        agent_id: params.agentId,
        agent_name: params.agentName,
        run_id: params.runId,
        metadata: { cost_usd: params.costUsd, adapter_type: params.adapterType, inference_time_ms: params.inferenceTimeMs },
      }),
    });
  }

  async function startNextQueuedRunForAgent(agentId: string) {
    return withAgentStartLock(agentId, async () => {
      const agent = await getAgent(agentId);
      if (!agent) return [];
      if (isHeartbeatSkipped(agent.status)) {
        return [];
      }
      const policy = parseHeartbeatPolicy(agent);
      const runningCount = await countRunningRunsForAgent(agentId);
      const availableSlots = Math.max(0, policy.maxConcurrentRuns - runningCount);
      if (availableSlots <= 0) return [];

      const allQueued = await db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "queued")))
        .orderBy(asc(heartbeatRuns.createdAt));
      // Rule 4 (GEM-1413): this agent's own timer run goes before its automation backlog.
      const queuedRuns = orderQueuedRunsForClaim(readFleetThrottleConfig(), allQueued).slice(0, availableSlots);
      if (queuedRuns.length === 0) return [];

      const claimedRuns: Array<typeof heartbeatRuns.$inferSelect> = [];
      for (const queuedRun of queuedRuns) {
        const claimed = await claimQueuedRun(queuedRun);
        if (claimed) claimedRuns.push(claimed);
      }
      if (claimedRuns.length === 0) return [];

      for (const claimedRun of claimedRuns) {
        void executeRun(claimedRun.id).catch((err) => {
          logger.error({ err, runId: claimedRun.id }, "queued heartbeat execution failed");
        });
      }
      return claimedRuns;
    });
  }

  async function executeRun(runId: string) {
    let run = await getRun(runId);
    if (!run) return;
    if (run.status !== "queued" && run.status !== "running") return;

    if (run.status === "queued") {
      const claimed = await claimQueuedRun(run);
      if (!claimed) {
        // Another worker has already claimed or finalized this run.
        return;
      }
      run = claimed;
    }

    activeRunExecutions.add(run.id);

    try {
    const agent = await getAgentConfirmed(run.agentId, run.id);
    if (!agent) {
      await setRunStatus(runId, "failed", {
        error: "Agent not found",
        errorCode: "agent_not_found",
        finishedAt: new Date(),
      });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: new Date(),
        error: "Agent not found",
      });
      const failedRun = await getRun(runId);
      if (failedRun) await releaseIssueExecutionAndPromote(failedRun);
      return;
    }

    const runtime = await ensureRuntimeState(agent);
    const context = parseObject(run.contextSnapshot);
    const taskKey = deriveTaskKeyWithHeartbeatFallback(context, null);
    const sessionCodec = getAdapterSessionCodec(agent.adapterType);
    const issueId = readNonEmptyString(context.issueId);
    const issueContext = issueId
      ? await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            description: issues.description,
            status: issues.status,
            priority: issues.priority,
            parentId: issues.parentId,
            projectId: issues.projectId,
            projectWorkspaceId: issues.projectWorkspaceId,
            executionWorkspaceId: issues.executionWorkspaceId,
            executionWorkspacePreference: issues.executionWorkspacePreference,
            assigneeAgentId: issues.assigneeAgentId,
            assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
            executionWorkspaceSettings: issues.executionWorkspaceSettings,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    // Lookup company prefix for spawn context (lets agent construct issue URLs
    // like /GEM/issues/GEM-378 without an extra API call).
    const companyContext = await db
      .select({ id: companies.id, name: companies.name, issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, agent.companyId))
      .then((rows) => rows[0] ?? null);
    // Augment heartbeat context with denormalized identity fields so adapter
    // execute() can synthesize PAPERCLIP_* env vars + spawn manifest without
    // re-querying the DB. Keeps existing context.* fields untouched for
    // backward compat with adapters that haven't migrated yet.
    if (issueContext) {
      context.issueIdentifier = issueContext.identifier ?? null;
      context.issueTitle = issueContext.title ?? null;
      context.issueDescription = issueContext.description ?? null;
      context.issueStatus = issueContext.status ?? null;
      context.issuePriority = issueContext.priority ?? null;
      context.issueParentId = issueContext.parentId ?? null;
      context.issueAssigneeAgentId = issueContext.assigneeAgentId ?? null;
      context.issueProjectId = issueContext.projectId ?? null;
    }
    if (companyContext) {
      context.companyName = companyContext.name ?? null;
      context.companyPrefix = companyContext.issuePrefix ?? null;
    }
    const issueAssigneeOverrides =
      issueContext && issueContext.assigneeAgentId === agent.id
        ? parseIssueAssigneeAdapterOverrides(
            issueContext.assigneeAdapterOverrides,
          )
        : null;
    const isolatedWorkspacesEnabled = (await instanceSettings.getExperimental()).enableIsolatedWorkspaces;
    const issueExecutionWorkspaceSettings = isolatedWorkspacesEnabled
      ? parseIssueExecutionWorkspaceSettings(issueContext?.executionWorkspaceSettings)
      : null;
    const contextProjectId = readNonEmptyString(context.projectId);
    const executionProjectId = issueContext?.projectId ?? contextProjectId;
    const projectExecutionWorkspacePolicy = executionProjectId
      ? await db
          .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
          .from(projects)
          .where(and(eq(projects.id, executionProjectId), eq(projects.companyId, agent.companyId)))
          .then((rows) =>
            gateProjectExecutionWorkspacePolicy(
              parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy),
              isolatedWorkspacesEnabled,
            ))
      : null;
    const taskSession = taskKey
      ? await getTaskSession(agent.companyId, agent.id, agent.adapterType, taskKey)
      : null;
    const resetTaskSession = shouldResetTaskSessionForWake(context);
    const sessionResetReason = describeSessionResetReason(context);
    const taskSessionForRun = resetTaskSession ? null : taskSession;
    const explicitResumeSessionParams = normalizeSessionParams(
      sessionCodec.deserialize(parseObject(context.resumeSessionParams)),
    );
    const explicitResumeSessionDisplayId = truncateDisplayId(
      readNonEmptyString(context.resumeSessionDisplayId) ??
        (sessionCodec.getDisplayId ? sessionCodec.getDisplayId(explicitResumeSessionParams) : null) ??
        readNonEmptyString(explicitResumeSessionParams?.sessionId),
    );
    const previousSessionParams =
      explicitResumeSessionParams ??
      (explicitResumeSessionDisplayId ? { sessionId: explicitResumeSessionDisplayId } : null) ??
      normalizeSessionParams(sessionCodec.deserialize(taskSessionForRun?.sessionParamsJson ?? null));
    const config = parseObject(agent.adapterConfig);
    const requestedExecutionWorkspaceMode = resolveExecutionWorkspaceMode({
      projectPolicy: projectExecutionWorkspacePolicy,
      issueSettings: issueExecutionWorkspaceSettings,
      legacyUseProjectWorkspace: issueAssigneeOverrides?.useProjectWorkspace ?? null,
    });
    const resolvedWorkspace = await resolveWorkspaceForRun(
      agent,
      context,
      previousSessionParams,
      { useProjectWorkspace: requestedExecutionWorkspaceMode !== "agent_default" },
    );
    const issueRef = issueContext
      ? {
          id: issueContext.id,
          identifier: issueContext.identifier,
          title: issueContext.title,
          projectId: issueContext.projectId,
          projectWorkspaceId: issueContext.projectWorkspaceId,
          executionWorkspaceId: issueContext.executionWorkspaceId,
          executionWorkspacePreference: issueContext.executionWorkspacePreference,
        }
      : null;
    const existingExecutionWorkspace =
      issueRef?.executionWorkspaceId ? await executionWorkspacesSvc.getById(issueRef.executionWorkspaceId) : null;
    const shouldReuseExisting =
      issueRef?.executionWorkspacePreference === "reuse_existing" &&
      existingExecutionWorkspace &&
      existingExecutionWorkspace.status !== "archived";
    const persistedExecutionWorkspaceMode = shouldReuseExisting && existingExecutionWorkspace
      ? issueExecutionWorkspaceModeForPersistedWorkspace(existingExecutionWorkspace.mode)
      : null;
    const effectiveExecutionWorkspaceMode: ReturnType<typeof resolveExecutionWorkspaceMode> =
      persistedExecutionWorkspaceMode === "isolated_workspace" ||
      persistedExecutionWorkspaceMode === "operator_branch" ||
      persistedExecutionWorkspaceMode === "agent_default"
        ? persistedExecutionWorkspaceMode
        : requestedExecutionWorkspaceMode;
    const workspaceManagedConfig = shouldReuseExisting
      ? { ...config }
      : buildExecutionWorkspaceAdapterConfig({
          agentConfig: config,
          projectPolicy: projectExecutionWorkspacePolicy,
          issueSettings: issueExecutionWorkspaceSettings,
          mode: requestedExecutionWorkspaceMode,
          legacyUseProjectWorkspace: issueAssigneeOverrides?.useProjectWorkspace ?? null,
        });
    const persistedWorkspaceManagedConfig = applyPersistedExecutionWorkspaceConfig({
      config: workspaceManagedConfig,
      workspaceConfig: existingExecutionWorkspace?.config ?? null,
      mode: effectiveExecutionWorkspaceMode,
    });
    const mergedConfig = issueAssigneeOverrides?.adapterConfig
      ? { ...persistedWorkspaceManagedConfig, ...issueAssigneeOverrides.adapterConfig }
      : persistedWorkspaceManagedConfig;
    const configSnapshot = buildExecutionWorkspaceConfigSnapshot(mergedConfig);
    const executionRunConfig = stripWorkspaceRuntimeFromExecutionRunConfig(mergedConfig);
    const { config: resolvedConfig, secretKeys } = await secretsSvc.resolveAdapterConfigForRuntime(
      agent.companyId,
      executionRunConfig,
    );
    const runtimeSkillEntries = await companySkills.listRuntimeSkillEntries(agent.companyId);
    const runtimeConfig = {
      ...resolvedConfig,
      paperclipRuntimeSkills: runtimeSkillEntries,
    };
    const workspaceOperationRecorder = workspaceOperationsSvc.createRecorder({
      companyId: agent.companyId,
      heartbeatRunId: run.id,
      executionWorkspaceId: existingExecutionWorkspace?.id ?? null,
    });
    const executionWorkspaceBase = {
      baseCwd: resolvedWorkspace.cwd,
      source: resolvedWorkspace.source,
      projectId: resolvedWorkspace.projectId,
      workspaceId: resolvedWorkspace.workspaceId,
      repoUrl: resolvedWorkspace.repoUrl,
      repoRef: resolvedWorkspace.repoRef,
    } satisfies ExecutionWorkspaceInput;
    const reusedExecutionWorkspace = shouldReuseExisting && existingExecutionWorkspace
      ? buildRealizedExecutionWorkspaceFromPersisted({
          base: executionWorkspaceBase,
          workspace: existingExecutionWorkspace,
        })
      : null;
    const executionWorkspace = reusedExecutionWorkspace ?? await realizeExecutionWorkspace({
          base: executionWorkspaceBase,
          config: runtimeConfig,
          issue: issueRef,
          agent: {
            id: agent.id,
            name: agent.name,
            companyId: agent.companyId,
          },
          recorder: workspaceOperationRecorder,
        });
    const resolvedProjectId = executionWorkspace.projectId ?? issueRef?.projectId ?? executionProjectId ?? null;
    const resolvedProjectWorkspaceId = issueRef?.projectWorkspaceId ?? resolvedWorkspace.workspaceId ?? null;
    let persistedExecutionWorkspace = null;
    const nextExecutionWorkspaceMetadataBase = {
      ...(existingExecutionWorkspace?.metadata ?? {}),
      source: executionWorkspace.source,
      createdByRuntime: executionWorkspace.created,
    } as Record<string, unknown>;
    const nextExecutionWorkspaceMetadata = shouldReuseExisting
      ? nextExecutionWorkspaceMetadataBase
      : configSnapshot
        ? mergeExecutionWorkspaceConfig(nextExecutionWorkspaceMetadataBase, configSnapshot)
        : nextExecutionWorkspaceMetadataBase;
    try {
      persistedExecutionWorkspace = shouldReuseExisting && existingExecutionWorkspace
        ? await executionWorkspacesSvc.update(existingExecutionWorkspace.id, {
            cwd: executionWorkspace.cwd,
            repoUrl: executionWorkspace.repoUrl,
            baseRef: executionWorkspace.repoRef,
            branchName: executionWorkspace.branchName,
            providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
            providerRef: executionWorkspace.worktreePath,
            status: "active",
            lastUsedAt: new Date(),
            metadata: nextExecutionWorkspaceMetadata,
          })
        : resolvedProjectId
          ? await executionWorkspacesSvc.create({
              companyId: agent.companyId,
              projectId: resolvedProjectId,
              projectWorkspaceId: resolvedProjectWorkspaceId,
              sourceIssueId: issueRef?.id ?? null,
              mode:
                requestedExecutionWorkspaceMode === "isolated_workspace"
                  ? "isolated_workspace"
                  : requestedExecutionWorkspaceMode === "operator_branch"
                    ? "operator_branch"
                    : requestedExecutionWorkspaceMode === "agent_default"
                      ? "adapter_managed"
                      : "shared_workspace",
              strategyType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "project_primary",
              name: executionWorkspace.branchName ?? issueRef?.identifier ?? `workspace-${agent.id.slice(0, 8)}`,
              status: "active",
              cwd: executionWorkspace.cwd,
              repoUrl: executionWorkspace.repoUrl,
              baseRef: executionWorkspace.repoRef,
              branchName: executionWorkspace.branchName,
              providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
              providerRef: executionWorkspace.worktreePath,
              lastUsedAt: new Date(),
              openedAt: new Date(),
              metadata: nextExecutionWorkspaceMetadata,
            })
          : null;
    } catch (error) {
      if (executionWorkspace.created) {
        try {
          await cleanupExecutionWorkspaceArtifacts({
            workspace: {
              id: existingExecutionWorkspace?.id ?? `transient-${run.id}`,
              cwd: executionWorkspace.cwd,
              providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
              providerRef: executionWorkspace.worktreePath,
              branchName: executionWorkspace.branchName,
              repoUrl: executionWorkspace.repoUrl,
              baseRef: executionWorkspace.repoRef,
              projectId: resolvedProjectId,
              projectWorkspaceId: resolvedProjectWorkspaceId,
              sourceIssueId: issueRef?.id ?? null,
              metadata: {
                createdByRuntime: true,
                source: executionWorkspace.source,
              },
            },
            projectWorkspace: {
              cwd: resolvedWorkspace.cwd,
              cleanupCommand: null,
            },
            cleanupCommand: configSnapshot?.cleanupCommand ?? null,
            teardownCommand: configSnapshot?.teardownCommand ?? projectExecutionWorkspacePolicy?.workspaceStrategy?.teardownCommand ?? null,
            recorder: workspaceOperationRecorder,
          });
        } catch (cleanupError) {
          logger.warn(
            {
              runId: run.id,
              issueId,
              executionWorkspaceCwd: executionWorkspace.cwd,
              cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            },
            "Failed to cleanup realized execution workspace after persistence failure",
          );
        }
      }
      throw error;
    }
    await workspaceOperationRecorder.attachExecutionWorkspaceId(persistedExecutionWorkspace?.id ?? null);
    if (
      existingExecutionWorkspace &&
      persistedExecutionWorkspace &&
      existingExecutionWorkspace.id !== persistedExecutionWorkspace.id &&
      existingExecutionWorkspace.status === "active"
    ) {
      await executionWorkspacesSvc.update(existingExecutionWorkspace.id, {
        status: "idle",
        cleanupReason: null,
      });
    }
    if (issueId && persistedExecutionWorkspace) {
      const nextIssueWorkspaceMode = issueExecutionWorkspaceModeForPersistedWorkspace(persistedExecutionWorkspace.mode);
      const shouldSwitchIssueToExistingWorkspace =
        issueRef?.executionWorkspacePreference === "reuse_existing" ||
        requestedExecutionWorkspaceMode === "isolated_workspace" ||
        requestedExecutionWorkspaceMode === "operator_branch";
      const nextIssuePatch: Record<string, unknown> = {};
      if (issueRef?.executionWorkspaceId !== persistedExecutionWorkspace.id) {
        nextIssuePatch.executionWorkspaceId = persistedExecutionWorkspace.id;
      }
      if (resolvedProjectWorkspaceId && issueRef?.projectWorkspaceId !== resolvedProjectWorkspaceId) {
        nextIssuePatch.projectWorkspaceId = resolvedProjectWorkspaceId;
      }
      if (shouldSwitchIssueToExistingWorkspace) {
        nextIssuePatch.executionWorkspacePreference = "reuse_existing";
        nextIssuePatch.executionWorkspaceSettings = {
          ...(issueExecutionWorkspaceSettings ?? {}),
          mode: nextIssueWorkspaceMode,
        };
      }
      if (Object.keys(nextIssuePatch).length > 0) {
        await issuesSvc.update(issueId, nextIssuePatch);
      }
    }
    if (persistedExecutionWorkspace) {
      context.executionWorkspaceId = persistedExecutionWorkspace.id;
      await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: context,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, run.id));
    }
    const runtimeSessionResolution = resolveRuntimeSessionParamsForWorkspace({
      agentId: agent.id,
      previousSessionParams,
      resolvedWorkspace: {
        ...resolvedWorkspace,
        cwd: executionWorkspace.cwd,
      },
    });
    const runtimeSessionParams = runtimeSessionResolution.sessionParams;
    const runtimeWorkspaceWarnings = [
      ...resolvedWorkspace.warnings,
      ...executionWorkspace.warnings,
      ...(runtimeSessionResolution.warning ? [runtimeSessionResolution.warning] : []),
      ...(resetTaskSession && sessionResetReason
        ? [
            taskKey
              ? `Skipping saved session resume for task "${taskKey}" because ${sessionResetReason}.`
              : `Skipping saved session resume because ${sessionResetReason}.`,
          ]
        : []),
    ];
    context.paperclipWorkspace = {
      cwd: executionWorkspace.cwd,
      source: executionWorkspace.source,
      mode: effectiveExecutionWorkspaceMode,
      strategy: executionWorkspace.strategy,
      projectId: executionWorkspace.projectId,
      workspaceId: executionWorkspace.workspaceId,
      repoUrl: executionWorkspace.repoUrl,
      repoRef: executionWorkspace.repoRef,
      branchName: executionWorkspace.branchName,
      worktreePath: executionWorkspace.worktreePath,
      agentHome: await (async () => {
        const home = resolveDefaultAgentWorkspaceDir(agent.id);
        await fs.mkdir(home, { recursive: true });
        return home;
      })(),
    };
    context.paperclipWorkspaces = resolvedWorkspace.workspaceHints;
    const runtimeServiceIntents = (() => {
      const runtimeConfig = parseObject(resolvedConfig.workspaceRuntime);
      return Array.isArray(runtimeConfig.services)
        ? runtimeConfig.services.filter(
            (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
          )
        : [];
    })();
    if (runtimeServiceIntents.length > 0) {
      context.paperclipRuntimeServiceIntents = runtimeServiceIntents;
    } else {
      delete context.paperclipRuntimeServiceIntents;
    }
    if (executionWorkspace.projectId && !readNonEmptyString(context.projectId)) {
      context.projectId = executionWorkspace.projectId;
    }
    const runtimeSessionFallback = taskKey || resetTaskSession ? null : runtime.sessionId;
    let previousSessionDisplayId = truncateDisplayId(
      explicitResumeSessionDisplayId ??
        taskSessionForRun?.sessionDisplayId ??
        (sessionCodec.getDisplayId ? sessionCodec.getDisplayId(runtimeSessionParams) : null) ??
        readNonEmptyString(runtimeSessionParams?.sessionId) ??
        runtimeSessionFallback,
    );
    let runtimeSessionIdForAdapter =
      readNonEmptyString(runtimeSessionParams?.sessionId) ?? runtimeSessionFallback;
    let runtimeSessionParamsForAdapter = runtimeSessionParams;

    const sessionCompaction = await evaluateSessionCompaction({
      agent,
      sessionId: previousSessionDisplayId ?? runtimeSessionIdForAdapter,
      issueId,
    });
    if (sessionCompaction.rotate) {
      context.paperclipSessionHandoffMarkdown = sessionCompaction.handoffMarkdown;
      context.paperclipSessionRotationReason = sessionCompaction.reason;
      context.paperclipPreviousSessionId = previousSessionDisplayId ?? runtimeSessionIdForAdapter;
      runtimeSessionIdForAdapter = null;
      runtimeSessionParamsForAdapter = null;
      previousSessionDisplayId = null;
      if (sessionCompaction.reason) {
        runtimeWorkspaceWarnings.push(
          `Starting a fresh session because ${sessionCompaction.reason}.`,
        );
      }
    } else {
      delete context.paperclipSessionHandoffMarkdown;
      delete context.paperclipSessionRotationReason;
      delete context.paperclipPreviousSessionId;
    }

    const runtimeForAdapter = {
      sessionId: runtimeSessionIdForAdapter,
      sessionParams: runtimeSessionParamsForAdapter,
      sessionDisplayId: previousSessionDisplayId,
      taskKey,
    };

    let seq = 1;
    let handle: RunLogHandle | null = null;
    let stdoutExcerpt = "";
    let stderrExcerpt = "";
    try {
      const startedAt = run.startedAt ?? new Date();
      const runningWithSession = await db
        .update(heartbeatRuns)
        .set({
          startedAt,
          sessionIdBefore: runtimeForAdapter.sessionDisplayId ?? runtimeForAdapter.sessionId,
          contextSnapshot: context,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, run.id))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (runningWithSession) run = runningWithSession;

      const runningAgent = await db
        .update(agents)
        .set({ status: "running", updatedAt: new Date() })
        .where(eq(agents.id, agent.id))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (runningAgent) {
        publishLiveEvent({
          companyId: runningAgent.companyId,
          type: "agent.status",
          payload: {
            agentId: runningAgent.id,
            status: runningAgent.status,
            outcome: "running",
          },
        });
      }

      const currentRun = run;
      await appendRunEvent(currentRun, seq++, {
        eventType: "lifecycle",
        stream: "system",
        level: "info",
        message: "run started",
      });

      handle = await runLogStore.begin({
        companyId: run.companyId,
        agentId: run.agentId,
        runId,
      });

      await db
        .update(heartbeatRuns)
        .set({
          logStore: handle.store,
          logRef: handle.logRef,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, runId));

      const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
      const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
        const sanitizedChunk = redactCurrentUserText(chunk, currentUserRedactionOptions);
        if (stream === "stdout") stdoutExcerpt = appendExcerpt(stdoutExcerpt, sanitizedChunk);
        if (stream === "stderr") stderrExcerpt = appendExcerpt(stderrExcerpt, sanitizedChunk);
        const ts = new Date().toISOString();

        if (handle) {
          await runLogStore.append(handle, {
            stream,
            chunk: sanitizedChunk,
            ts,
          });
        }

        const payloadChunk =
          sanitizedChunk.length > MAX_LIVE_LOG_CHUNK_BYTES
            ? sanitizedChunk.slice(sanitizedChunk.length - MAX_LIVE_LOG_CHUNK_BYTES)
            : sanitizedChunk;

        publishLiveEvent({
          companyId: run.companyId,
          type: "heartbeat.run.log",
          payload: {
            runId: run.id,
            agentId: run.agentId,
            ts,
            stream,
            chunk: payloadChunk,
            truncated: payloadChunk.length !== sanitizedChunk.length,
          },
        });
      };
      for (const warning of runtimeWorkspaceWarnings) {
        const logEntry = formatRuntimeWorkspaceWarningLog(warning);
        await onLog(logEntry.stream, logEntry.chunk);
      }
      const adapterEnv = Object.fromEntries(
        Object.entries(parseObject(resolvedConfig.env)).filter(
          (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
        ),
      );
      const runtimeServices = await ensureRuntimeServicesForRun({
        db,
        runId: run.id,
        agent: {
          id: agent.id,
          name: agent.name,
          companyId: agent.companyId,
        },
        issue: issueRef,
        workspace: executionWorkspace,
        executionWorkspaceId: persistedExecutionWorkspace?.id ?? issueRef?.executionWorkspaceId ?? null,
        config: resolvedConfig,
        adapterEnv,
        onLog,
      });
      if (runtimeServices.length > 0) {
        context.paperclipRuntimeServices = runtimeServices;
        context.paperclipRuntimePrimaryUrl =
          runtimeServices.find((service) => readNonEmptyString(service.url))?.url ?? null;
        await db
          .update(heartbeatRuns)
          .set({
            contextSnapshot: context,
            updatedAt: new Date(),
          })
          .where(eq(heartbeatRuns.id, run.id));
      }
      if (issueId && (executionWorkspace.created || runtimeServices.some((service) => !service.reused))) {
        try {
          await issuesSvc.addComment(
            issueId,
            buildWorkspaceReadyComment({
              workspace: executionWorkspace,
              runtimeServices,
            }),
            { agentId: agent.id },
          );
        } catch (err) {
          await onLog(
            "stderr",
            `[paperclip] Failed to post workspace-ready comment: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
      const onAdapterMeta = async (meta: AdapterInvocationMeta) => {
        if (meta.env && secretKeys.size > 0) {
          for (const key of secretKeys) {
            if (key in meta.env) meta.env[key] = "***REDACTED***";
          }
        }
        await appendRunEvent(currentRun, seq++, {
          eventType: "adapter.invoke",
          stream: "system",
          level: "info",
          message: "adapter invocation",
          payload: meta as unknown as Record<string, unknown>,
        });
      };

      const adapter = getServerAdapter(agent.adapterType);
      const authToken = adapter.supportsLocalAgentJwt
        ? createLocalAgentJwt(agent.id, agent.companyId, agent.adapterType, run.id)
        : null;
      if (adapter.supportsLocalAgentJwt && !authToken) {
        logger.warn(
          {
            companyId: agent.companyId,
            agentId: agent.id,
            runId: run.id,
            adapterType: agent.adapterType,
          },
          "local agent jwt secret missing or invalid; running without injected PAPERCLIP_API_KEY",
        );
      }
      const inferenceStartMs = Date.now();
      let adapterResult = await adapter.execute({
        runId: run.id,
        agent,
        runtime: runtimeForAdapter,
        config: runtimeConfig,
        context,
        onLog,
        onMeta: onAdapterMeta,
        onSpawn: async (meta) => {
          await persistRunProcessMetadata(run.id, meta);
        },
        authToken: authToken ?? undefined,
      });
      // GEM-1244: quỹ credits agy cạn ở MỌI model → chạy lại CÙNG lượt bằng claude CLI (quỹ độc lập)
      // thay vì chỉ quota-retry 30/60/120'. Phiên agy giữ nguyên; claude fail ⇒ giữ kết quả quota cũ.
      if (
        shouldFallbackToClaude({
          adapterType: agent.adapterType,
          config: runtimeConfig,
          result: adapterResult,
          cancelled: (await getRun(run.id))?.status === "cancelled",
        })
      ) {
        const claudeConfig = buildClaudeFallbackConfig(runtimeConfig);
        const claudeModel = String(claudeConfig.model);
        await onLog(
          "stderr",
          `[paperclip] agy hết credits ở mọi model (${adapterResult.errorMessage ?? "quota"}) → chạy lại lượt này bằng claude CLI (${claudeModel}).\n`,
        );
        try {
          const claudeAdapter = getServerAdapter(CLAUDE_ADAPTER_TYPE);
          const claudeAuthToken = claudeAdapter.supportsLocalAgentJwt
            ? createLocalAgentJwt(agent.id, agent.companyId, CLAUDE_ADAPTER_TYPE, run.id)
            : null;
          const claudeResult = await claudeAdapter.execute({
            runId: run.id,
            agent,
            // Không resume brain agy bằng claude: phiên mới, phiên agy được giữ lại trong merge.
            runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey },
            config: claudeConfig,
            context,
            onLog,
            onMeta: onAdapterMeta,
            onSpawn: async (meta) => {
              await persistRunProcessMetadata(run.id, meta);
            },
            authToken: claudeAuthToken ?? authToken ?? undefined,
          });
          adapterResult = mergeClaudeFallbackResult(adapterResult, claudeResult, claudeModel);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await onLog("stderr", `[paperclip] claude CLI dự phòng lỗi: ${message} — giữ quota-retry.\n`);
          adapterResult = {
            ...adapterResult,
            resultJson: {
              ...(adapterResult.resultJson ?? {}),
              adapterUsed: AGY_ADAPTER_TYPE,
              claudeFallback: { attempted: true, model: claudeModel, errorMessage: message },
            },
          };
        }
      }
      const inferenceTimeMs = Date.now() - inferenceStartMs;
      const adapterManagedRuntimeServices = adapterResult.runtimeServices
        ? await persistAdapterManagedRuntimeServices({
            db,
            adapterType: agent.adapterType,
            runId: run.id,
            agent: {
              id: agent.id,
              name: agent.name,
              companyId: agent.companyId,
            },
            issue: issueRef,
            workspace: executionWorkspace,
            reports: adapterResult.runtimeServices,
          })
        : [];
      if (adapterManagedRuntimeServices.length > 0) {
        const combinedRuntimeServices = [
          ...runtimeServices,
          ...adapterManagedRuntimeServices,
        ];
        context.paperclipRuntimeServices = combinedRuntimeServices;
        context.paperclipRuntimePrimaryUrl =
          combinedRuntimeServices.find((service) => readNonEmptyString(service.url))?.url ?? null;
        await db
          .update(heartbeatRuns)
          .set({
            contextSnapshot: context,
            updatedAt: new Date(),
          })
          .where(eq(heartbeatRuns.id, run.id));
        if (issueId) {
          try {
            await issuesSvc.addComment(
              issueId,
              buildWorkspaceReadyComment({
                workspace: executionWorkspace,
                runtimeServices: adapterManagedRuntimeServices,
              }),
              { agentId: agent.id },
            );
          } catch (err) {
            await onLog(
              "stderr",
              `[paperclip] Failed to post adapter-managed runtime comment: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }
      }
      const nextSessionState = resolveNextSessionState({
        codec: sessionCodec,
        adapterResult,
        previousParams: previousSessionParams,
        previousDisplayId: runtimeForAdapter.sessionDisplayId,
        previousLegacySessionId: runtimeForAdapter.sessionId,
      });
      const rawUsage = normalizeUsageTotals(adapterResult.usage);
      const sessionUsageResolution = await resolveNormalizedUsageForSession({
        agentId: agent.id,
        runId: run.id,
        sessionId: nextSessionState.displayId ?? nextSessionState.legacySessionId,
        rawUsage,
      });
      const normalizedUsage = sessionUsageResolution.normalizedUsage;

      let outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
      const latestRun = await getRun(run.id);
      if (latestRun?.status === "cancelled") {
        outcome = "cancelled";
      } else if (adapterResult.timedOut) {
        outcome = "timed_out";
      } else if ((adapterResult.exitCode ?? 0) === 0 && !adapterResult.errorMessage) {
        outcome = "succeeded";
      } else {
        outcome = "failed";
      }

      let logSummary: { bytes: number; sha256?: string; compressed: boolean } | null = null;
      if (handle) {
        logSummary = await runLogStore.finalize(handle);
      }

      const status =
        outcome === "succeeded"
          ? "succeeded"
          : outcome === "cancelled"
            ? "cancelled"
            : outcome === "timed_out"
              ? "timed_out"
              : "failed";

      const usageJson =
        normalizedUsage || adapterResult.costUsd != null
          ? ({
              ...(normalizedUsage ?? {}),
              ...(rawUsage ? {
                rawInputTokens: rawUsage.inputTokens,
                rawCachedInputTokens: rawUsage.cachedInputTokens,
                rawOutputTokens: rawUsage.outputTokens,
              } : {}),
              ...(sessionUsageResolution.derivedFromSessionTotals ? { usageSource: "session_delta" } : {}),
              ...((nextSessionState.displayId ?? nextSessionState.legacySessionId)
                ? { persistedSessionId: nextSessionState.displayId ?? nextSessionState.legacySessionId }
                : {}),
              sessionReused: runtimeForAdapter.sessionId != null || runtimeForAdapter.sessionDisplayId != null,
              taskSessionReused: taskSessionForRun != null,
              freshSession: runtimeForAdapter.sessionId == null && runtimeForAdapter.sessionDisplayId == null,
              sessionRotated: sessionCompaction.rotate,
              sessionRotationReason: sessionCompaction.reason,
              provider: readNonEmptyString(adapterResult.provider) ?? "unknown",
              biller: resolveLedgerBiller(adapterResult),
              model: readNonEmptyString(adapterResult.model) ?? "unknown",
              ...(adapterResult.costUsd != null ? { costUsd: adapterResult.costUsd } : {}),
              billingType: normalizeLedgerBillingType(adapterResult.billingType),
            } as Record<string, unknown>)
          : null;

      await setRunStatus(run.id, status, {
        finishedAt: new Date(),
        error:
          outcome === "succeeded"
            ? null
            : redactCurrentUserText(
                adapterResult.errorMessage ?? (outcome === "timed_out" ? "Timed out" : "Adapter failed"),
                currentUserRedactionOptions,
              ),
        errorCode:
          outcome === "timed_out"
            ? "timeout"
            : outcome === "cancelled"
              ? "cancelled"
              : outcome === "failed"
                ? (adapterResult.errorCode ?? "adapter_failed")
                : null,
        exitCode: adapterResult.exitCode,
        signal: adapterResult.signal,
        usageJson,
        resultJson: adapterResult.resultJson ?? null,
        sessionIdAfter: nextSessionState.displayId ?? nextSessionState.legacySessionId,
        stdoutExcerpt,
        stderrExcerpt,
        logBytes: logSummary?.bytes,
        logSha256: logSummary?.sha256,
        logCompressed: logSummary?.compressed ?? false,
      });

      await setWakeupStatus(run.wakeupRequestId, outcome === "succeeded" ? "completed" : status, {
        finishedAt: new Date(),
        error: adapterResult.errorMessage ?? null,
      });

      const finalizedRun = await getRun(run.id);
      if (finalizedRun) {
        await appendRunEvent(finalizedRun, seq++, {
          eventType: "lifecycle",
          stream: "system",
          level: outcome === "succeeded" ? "info" : "error",
          message: `run ${outcome}`,
          payload: {
            status,
            exitCode: adapterResult.exitCode,
          },
        });
        await releaseIssueExecutionAndPromote(finalizedRun);

        // Auto-inject run summary vào issue comment thread để user không cần
        // switch sang Runs tab để đọc kết quả. Chỉ fire khi có issueId và có nội dung.
        logger.info(
          { runId: finalizedRun.id, issueId, outcome, stdoutLen: stdoutExcerpt.length, resultJsonKeys: Object.keys(adapterResult.resultJson ?? {}) },
          "heartbeat: run-summary injection check",
        );
        if (issueId) {
          try {
            const summaryComment = buildRunSummaryComment({
              run: finalizedRun,
              agentId: agent.id,
              outcome,
              resultJson: adapterResult.resultJson ?? null,
              errorMessage: adapterResult.errorMessage ?? null,
              agentName: agent.name,
              // Dùng local excerpt variable (accumulated in onLog) thay vì
              // finalizedRun.stdoutExcerpt vì runColumns hardcode NULL cho field đó.
              stdoutExcerpt: stdoutExcerpt || null,
              stderrExcerpt: stderrExcerpt || null,
            });
            if (summaryComment) {
              await issuesSvc.addComment(issueId, summaryComment, { agentId: agent.id });
              logger.info({ runId: finalizedRun.id, issueId }, "heartbeat: run-summary comment posted OK");
            } else {
              logger.info({ runId: finalizedRun.id, issueId, outcome }, "heartbeat: buildRunSummaryComment returned null — skip post");
            }
          } catch (err) {
            logger.warn(
              { err, runId: finalizedRun.id, issueId },
              "heartbeat: failed to post run-summary comment to issue",
            );
          }
        }
      }


      if (finalizedRun) {
        await updateRuntimeState(agent, finalizedRun, adapterResult, {

          legacySessionId: nextSessionState.legacySessionId,
        }, normalizedUsage);
        writeAgentTelemetry({
          agentId: agent.id,
          agentName: agent.name,
          runId: finalizedRun.id,
          model: adapterResult.model ?? "unknown",
          inputTokens: normalizedUsage?.inputTokens ?? 0,
          outputTokens: normalizedUsage?.outputTokens ?? 0,
          totalTokens: (normalizedUsage?.inputTokens ?? 0) + (normalizedUsage?.outputTokens ?? 0),
          costUsd: adapterResult.costUsd ?? null,
          success: outcome === "succeeded",
          errorMessage: adapterResult.errorMessage ?? null,
          responseTimeMs: finalizedRun.startedAt ? Date.now() - new Date(finalizedRun.startedAt).getTime() : null,
          inferenceTimeMs: inferenceTimeMs,
          adapterType: agent.adapterType,
        }).catch((err) => {
          logger.warn({ err, runId: finalizedRun.id }, "heartbeat: writeAgentTelemetry failed (best-effort)");
        });
        if (taskKey) {
          if (adapterResult.clearSession || (!nextSessionState.params && !nextSessionState.displayId)) {
            await clearTaskSessions(agent.companyId, agent.id, {
              taskKey,
              adapterType: agent.adapterType,
            });
          } else {
            await upsertTaskSession({
              companyId: agent.companyId,
              agentId: agent.id,
              adapterType: agent.adapterType,
              taskKey,
              sessionParamsJson: nextSessionState.params,
              sessionDisplayId: nextSessionState.displayId,
              lastRunId: finalizedRun.id,
              lastError: outcome === "succeeded" ? null : (adapterResult.errorMessage ?? "run_failed"),
            });
          }
        }
      }
      const quotaRetry = await syncQuotaRetryAfterRun({
        agent,
        run: finalizedRun ?? run,
        context,
        issueId,
        outcome,
        adapterResult,
        nextSeq: () => seq++,
      });
      await finalizeAgentStatus(agent.id, outcome, { retryScheduled: quotaRetry !== null });
    } catch (err) {
      const message = redactCurrentUserText(
        err instanceof Error ? err.message : "Unknown adapter failure",
        await getCurrentUserRedactionOptions(),
      );
      logger.error({ err, runId }, "heartbeat execution failed");

      let logSummary: { bytes: number; sha256?: string; compressed: boolean } | null = null;
      if (handle) {
        try {
          logSummary = await runLogStore.finalize(handle);
        } catch (finalizeErr) {
          logger.warn({ err: finalizeErr, runId }, "failed to finalize run log after error");
        }
      }

      const failedRun = await setRunStatus(run.id, "failed", {
        error: message,
        errorCode: "adapter_failed",
        finishedAt: new Date(),
        stdoutExcerpt,
        stderrExcerpt,
        logBytes: logSummary?.bytes,
        logSha256: logSummary?.sha256,
        logCompressed: logSummary?.compressed ?? false,
      });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: new Date(),
        error: message,
      });

      if (failedRun) {
        await appendRunEvent(failedRun, seq++, {
          eventType: "error",
          stream: "system",
          level: "error",
          message,
        });
        await releaseIssueExecutionAndPromote(failedRun);

        await updateRuntimeState(agent, failedRun, {
          exitCode: null,
          signal: null,
          timedOut: false,
          errorMessage: message,
        }, {
          legacySessionId: runtimeForAdapter.sessionId,
        });

        if (taskKey && (previousSessionParams || previousSessionDisplayId || taskSession)) {
          await upsertTaskSession({
            companyId: agent.companyId,
            agentId: agent.id,
            adapterType: agent.adapterType,
            taskKey,
            sessionParamsJson: previousSessionParams,
            sessionDisplayId: previousSessionDisplayId,
            lastRunId: failedRun.id,
            lastError: message,
          });
        }
      }

      await finalizeAgentStatus(agent.id, "failed");
    }
    } catch (outerErr) {
          // Setup code before adapter.execute threw (e.g. ensureRuntimeState, resolveWorkspaceForRun).
          // The inner catch did not fire, so we must record the failure here.
          const message = outerErr instanceof Error ? outerErr.message : "Unknown setup failure";
          logger.error({ err: outerErr, runId }, "heartbeat execution setup failed");
          await setRunStatus(runId, "failed", {
            error: message,
            errorCode: "adapter_failed",
            finishedAt: new Date(),
          }).catch(() => undefined);
          await setWakeupStatus(run.wakeupRequestId, "failed", {
            finishedAt: new Date(),
            error: message,
          }).catch(() => undefined);
          const failedRun = await getRun(runId).catch(() => null);
          if (failedRun) {
            // Emit a run-log event so the failure is visible in the run timeline,
            // consistent with what the inner catch block does for adapter failures.
            await appendRunEvent(failedRun, 1, {
              eventType: "error",
              stream: "system",
              level: "error",
              message,
            }).catch(() => undefined);
            await releaseIssueExecutionAndPromote(failedRun).catch(() => undefined);
          }
          // Ensure the agent is not left stuck in "running" if the inner catch handler's
          // DB calls threw (e.g. a transient DB error in finalizeAgentStatus).
          await finalizeAgentStatus(run.agentId, "failed").catch(() => undefined);
        } finally {
          // Safety net: ensure the issue execution lock is always released even
          // if the success path, inner catch, or outer catch threw before reaching
          // their own releaseIssueExecutionAndPromote call. Idempotent — if the
          // lock was already cleared, the lookup by executionRunId returns null
          // and the function is a no-op.
          await releaseIssueExecutionAndPromote(run).catch(() => undefined);
          await releaseRuntimeServicesForRun(run.id).catch(() => undefined);
          activeRunExecutions.delete(run.id);
          await startNextQueuedRunForAgent(run.agentId);
        }
  }

  async function releaseIssueExecutionAndPromote(run: typeof heartbeatRuns.$inferSelect) {
    const promotedRun = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from issues where company_id = ${run.companyId} and execution_run_id = ${run.id} for update`,
      );

      const issue = await tx
        .select({
          id: issues.id,
          companyId: issues.companyId,
        })
        .from(issues)
        .where(and(eq(issues.companyId, run.companyId), eq(issues.executionRunId, run.id)))
        .then((rows) => rows[0] ?? null);

      if (!issue) return;

      await tx
        .update(issues)
        .set({
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issue.id));

      while (true) {
        const deferred = await tx
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, issue.companyId),
              eq(agentWakeupRequests.status, "deferred_issue_execution"),
              sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
            ),
          )
          .orderBy(asc(agentWakeupRequests.requestedAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);

        if (!deferred) return null;

        const deferredAgent = await tx
          .select()
          .from(agents)
          .where(eq(agents.id, deferred.agentId))
          .then((rows) => rows[0] ?? null);

        if (
          !deferredAgent ||
          deferredAgent.companyId !== issue.companyId ||
          deferredAgent.status === "paused" ||
          deferredAgent.status === "terminated" ||
          deferredAgent.status === "pending_approval"
        ) {
          await tx
            .update(agentWakeupRequests)
            .set({
              status: "failed",
              finishedAt: new Date(),
              error: "Deferred wake could not be promoted: agent is not invokable",
              updatedAt: new Date(),
            })
            .where(eq(agentWakeupRequests.id, deferred.id));
          continue;
        }

        const deferredPayload = parseObject(deferred.payload);
        const deferredContextSeed = parseObject(deferredPayload[DEFERRED_WAKE_CONTEXT_KEY]);
        const promotedContextSeed: Record<string, unknown> = { ...deferredContextSeed };
        const promotedReason = readNonEmptyString(deferred.reason) ?? "issue_execution_promoted";
        const promotedSource =
          (readNonEmptyString(deferred.source) as WakeupOptions["source"]) ?? "automation";
        const promotedTriggerDetail =
          (readNonEmptyString(deferred.triggerDetail) as WakeupOptions["triggerDetail"]) ?? null;
        const promotedPayload = deferredPayload;
        delete promotedPayload[DEFERRED_WAKE_CONTEXT_KEY];

        const {
          contextSnapshot: promotedContextSnapshot,
          taskKey: promotedTaskKey,
        } = enrichWakeContextSnapshot({
          contextSnapshot: promotedContextSeed,
          reason: promotedReason,
          source: promotedSource,
          triggerDetail: promotedTriggerDetail,
          payload: promotedPayload,
        });

        const sessionBefore =
          readNonEmptyString(promotedContextSnapshot.resumeSessionDisplayId) ??
          await resolveSessionBeforeForWakeup(deferredAgent, promotedTaskKey);
        const now = new Date();
        const newRun = await tx
          .insert(heartbeatRuns)
          .values({
            companyId: deferredAgent.companyId,
            agentId: deferredAgent.id,
            invocationSource: promotedSource,
            triggerDetail: promotedTriggerDetail,
            status: "queued",
            wakeupRequestId: deferred.id,
            contextSnapshot: promotedContextSnapshot,
            sessionIdBefore: sessionBefore,
          })
          .returning()
          .then((rows) => rows[0]);

        await tx
          .update(agentWakeupRequests)
          .set({
            status: "queued",
            reason: "issue_execution_promoted",
            runId: newRun.id,
            claimedAt: null,
            finishedAt: null,
            error: null,
            updatedAt: now,
          })
          .where(eq(agentWakeupRequests.id, deferred.id));

        await tx
          .update(issues)
          .set({
            executionRunId: newRun.id,
            executionAgentNameKey: normalizeAgentNameKey(deferredAgent.name),
            executionLockedAt: now,
            updatedAt: now,
          })
          .where(eq(issues.id, issue.id));

        return newRun;
      }
    });

    if (!promotedRun) return;

    publishLiveEvent({
      companyId: promotedRun.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: promotedRun.id,
        agentId: promotedRun.agentId,
        invocationSource: promotedRun.invocationSource,
        triggerDetail: promotedRun.triggerDetail,
        wakeupRequestId: promotedRun.wakeupRequestId,
      },
    });

    await startNextQueuedRunForAgent(promotedRun.agentId);
  }

  // A' evergreen heartbeat thread (2026-04-17). Lazy-bootstrap a single hidden
  // issue per agent that acts as the persistent conversation buffer for timer /
  // on-demand heartbeat runs that don't carry their own issueId. Jennie comments
  // on this thread → agent wakes with wake_comment_id and resumes context.
  // The issue stays `hidden` so it never pollutes the default inbox listing.
  async function ensureHeartbeatThread(
    agent: typeof agents.$inferSelect,
  ): Promise<string> {
    const existingId = (agent as unknown as { heartbeatThreadIssueId: string | null }).heartbeatThreadIssueId;
    if (existingId) {
      const stillThere = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, existingId), eq(issues.companyId, agent.companyId)))
        .then((rows) => rows[0]);
      if (stillThere) return stillThere.id;
      // FK dangling (issue deleted) — fall through and recreate
    }
    const now = new Date();
    const title = `Heartbeat Thread — ${agent.name ?? agent.id.slice(0, 8)}`;
    const description =
      `Evergreen heartbeat conversation thread for agent **${agent.name ?? agent.id}**.\n\n` +
      `Every timer / on-demand wake run without an explicit issue is attached here. ` +
      `Post a comment to reply to the agent — it wakes with wake_comment_id and resumes the session. ` +
      `Hidden from the default inbox; toggle the filter to view.`;
    // Atomically bump companies.issueCounter (same pattern as issueService.create)
    // so the thread issue gets a GEM-### identifier and UI routes work. Skipping
    // this leaves identifier=null and the issue link breaks.
    const [created] = await db.transaction(async (tx) => {
      const [company] = await tx
        .update(companies)
        .set({ issueCounter: sql`${companies.issueCounter} + 1` })
        .where(eq(companies.id, agent.companyId))
        .returning({ issueCounter: companies.issueCounter, issuePrefix: companies.issuePrefix });
      const issueNumber = company.issueCounter;
      const identifier = `${company.issuePrefix}-${issueNumber}`;
      const rows = await tx
        .insert(issues)
        .values({
          companyId: agent.companyId,
          title,
          description,
          status: "in_progress",
          priority: "low",
          assigneeAgentId: agent.id,
          originKind: "system",
          originId: `heartbeat-thread:${agent.id}`,
          hiddenAt: now,
          issueNumber,
          identifier,
          startedAt: now,
        })
        .returning({ id: issues.id });
      return rows;
    });
    await db
      .update(agents)
      .set({
        heartbeatThreadIssueId: created.id,
        updatedAt: now,
      } as any)
      .where(eq(agents.id, agent.id));
    logger.info(
      { agentId: agent.id, companyId: agent.companyId, issueId: created.id },
      "heartbeat-thread: created evergreen issue",
    );
    return created.id;
  }

  async function enqueueWakeup(agentId: string, opts: WakeupOptions = {}) {
    const source = opts.source ?? "on_demand";
    const triggerDetail = opts.triggerDetail ?? null;
    const contextSnapshot: Record<string, unknown> = { ...(opts.contextSnapshot ?? {}) };
    const reason = opts.reason ?? null;
    const payload = opts.payload ?? null;
    const {
      contextSnapshot: enrichedContextSnapshot,
      issueIdFromPayload,
      taskKey,
      wakeCommentId,
    } = enrichWakeContextSnapshot({
      contextSnapshot,
      reason,
      source,
      triggerDetail,
      payload,
    });
    let issueId = readNonEmptyString(enrichedContextSnapshot.issueId) ?? issueIdFromPayload;

    const agent = await getAgent(agentId);
    if (!agent) throw notFound("Agent not found");
    const explicitResumeSession = await resolveExplicitResumeSessionOverride(agent, payload, taskKey);
    if (explicitResumeSession) {
      enrichedContextSnapshot.resumeFromRunId = explicitResumeSession.resumeFromRunId;
      enrichedContextSnapshot.resumeSessionDisplayId = explicitResumeSession.sessionDisplayId;
      enrichedContextSnapshot.resumeSessionParams = explicitResumeSession.sessionParams;
      if (!readNonEmptyString(enrichedContextSnapshot.issueId) && explicitResumeSession.issueId) {
        enrichedContextSnapshot.issueId = explicitResumeSession.issueId;
      }
      if (!readNonEmptyString(enrichedContextSnapshot.taskId) && explicitResumeSession.taskId) {
        enrichedContextSnapshot.taskId = explicitResumeSession.taskId;
      }
      if (!readNonEmptyString(enrichedContextSnapshot.taskKey) && explicitResumeSession.taskKey) {
        enrichedContextSnapshot.taskKey = explicitResumeSession.taskKey;
      }
      issueId = readNonEmptyString(enrichedContextSnapshot.issueId) ?? issueId;
    }

    // A' — attach to evergreen Heartbeat Thread if still no issue. Done AFTER
    // the explicit resume block so real issue wakes (assignment, comment, etc.)
    // take precedence; only orphan heartbeat / on-demand runs fall through here.
    if (!issueId) {
      try {
        const threadIssueId = await ensureHeartbeatThread(agent);
        enrichedContextSnapshot.issueId = threadIssueId;
        if (!readNonEmptyString(enrichedContextSnapshot.taskId)) {
          enrichedContextSnapshot.taskId = threadIssueId;
        }
        if (!readNonEmptyString(enrichedContextSnapshot.taskKey)) {
          enrichedContextSnapshot.taskKey = threadIssueId;
        }
        enrichedContextSnapshot.heartbeatThread = true;
        issueId = threadIssueId;
      } catch (err) {
        logger.warn(
          { err, agentId },
          "ensureHeartbeatThread failed — continuing without thread attachment",
        );
      }
    }

    const effectiveTaskKey = readNonEmptyString(enrichedContextSnapshot.taskKey) ?? taskKey;
    const sessionBefore =
      explicitResumeSession?.sessionDisplayId ??
      await resolveSessionBeforeForWakeup(agent, effectiveTaskKey);

    const writeSkippedRequest = async (skipReason: string) => {
      await db.insert(agentWakeupRequests).values({
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason: skipReason,
        payload,
        status: "skipped",
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        finishedAt: new Date(),
      });
    };

    let projectId = readNonEmptyString(enrichedContextSnapshot.projectId);
    if (!projectId && issueId) {
      projectId = await db
        .select({ projectId: issues.projectId })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
        .then((rows) => rows[0]?.projectId ?? null);
    }

    const budgetBlock = await budgets.getInvocationBlock(agent.companyId, agentId, {
      issueId,
      projectId,
    });
    if (budgetBlock) {
      await writeSkippedRequest("budget.blocked");
      throw conflict(budgetBlock.reason, {
        scopeType: budgetBlock.scopeType,
        scopeId: budgetBlock.scopeId,
      });
    }

    if (
      agent.status === "paused" ||
      agent.status === "terminated" ||
      agent.status === "pending_approval"
    ) {
      throw conflict("Agent is not invokable in its current state", { status: agent.status });
    }

    const policy = parseHeartbeatPolicy(agent);

    if (source === "timer" && !policy.enabled) {
      await writeSkippedRequest("heartbeat.disabled");
      return null;
    }
    if (source !== "timer" && !policy.wakeOnDemand) {
      await writeSkippedRequest("heartbeat.wakeOnDemand.disabled");
      return null;
    }

    const bypassIssueExecutionLock =
      reason === "issue_comment_mentioned" ||
      readNonEmptyString(enrichedContextSnapshot.wakeReason) === "issue_comment_mentioned";

    if (issueId && !bypassIssueExecutionLock) {
      const agentNameKey = normalizeAgentNameKey(agent.name);

      const outcome = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from issues where id = ${issueId} and company_id = ${agent.companyId} for update`,
        );

        const issue = await tx
          .select({
            id: issues.id,
            companyId: issues.companyId,
            executionRunId: issues.executionRunId,
            executionAgentNameKey: issues.executionAgentNameKey,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null);

        if (!issue) {
          await tx.insert(agentWakeupRequests).values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason: "issue_execution_issue_not_found",
            payload,
            status: "skipped",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
            finishedAt: new Date(),
          });
          return { kind: "skipped" as const };
        }

        let activeExecutionRun = issue.executionRunId
          ? await tx
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, issue.executionRunId))
            .then((rows) => rows[0] ?? null)
          : null;

        if (activeExecutionRun && activeExecutionRun.status !== "queued" && activeExecutionRun.status !== "running") {
          activeExecutionRun = null;
        }

        if (!activeExecutionRun && issue.executionRunId) {
          await tx
            .update(issues)
            .set({
              executionRunId: null,
              executionAgentNameKey: null,
              executionLockedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(issues.id, issue.id));
        }

        if (!activeExecutionRun) {
          const legacyRun = await tx
            .select()
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, issue.companyId),
                inArray(heartbeatRuns.status, ["queued", "running"]),
                sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
              ),
            )
            .orderBy(
              sql`case when ${heartbeatRuns.status} = 'running' then 0 else 1 end`,
              asc(heartbeatRuns.createdAt),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);

          if (legacyRun) {
            activeExecutionRun = legacyRun;
            const legacyAgent = await tx
              .select({ name: agents.name })
              .from(agents)
              .where(eq(agents.id, legacyRun.agentId))
              .then((rows) => rows[0] ?? null);
            await tx
              .update(issues)
              .set({
                executionRunId: legacyRun.id,
                executionAgentNameKey: normalizeAgentNameKey(legacyAgent?.name),
                executionLockedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(issues.id, issue.id));
          }
        }

        if (activeExecutionRun) {
          const executionAgent = await tx
            .select({ name: agents.name })
            .from(agents)
            .where(eq(agents.id, activeExecutionRun.agentId))
            .then((rows) => rows[0] ?? null);
          const executionAgentNameKey =
            normalizeAgentNameKey(issue.executionAgentNameKey) ??
            normalizeAgentNameKey(executionAgent?.name);
          const isSameExecutionAgent =
            Boolean(executionAgentNameKey) && executionAgentNameKey === agentNameKey;
          const shouldQueueFollowupForCommentWake =
            Boolean(wakeCommentId) &&
            activeExecutionRun.status === "running" &&
            isSameExecutionAgent;

          if (isSameExecutionAgent && !shouldQueueFollowupForCommentWake) {
            const mergedContextSnapshot = mergeCoalescedContextSnapshot(
              activeExecutionRun.contextSnapshot,
              enrichedContextSnapshot,
            );
            const mergedRun = await tx
              .update(heartbeatRuns)
              .set({
                contextSnapshot: mergedContextSnapshot,
                updatedAt: new Date(),
              })
              .where(eq(heartbeatRuns.id, activeExecutionRun.id))
              .returning()
              .then((rows) => rows[0] ?? activeExecutionRun);

            await tx.insert(agentWakeupRequests).values({
              companyId: agent.companyId,
              agentId,
              source,
              triggerDetail,
              reason: "issue_execution_same_name",
              payload,
              status: "coalesced",
              coalescedCount: 1,
              requestedByActorType: opts.requestedByActorType ?? null,
              requestedByActorId: opts.requestedByActorId ?? null,
              idempotencyKey: opts.idempotencyKey ?? null,
              runId: mergedRun.id,
              finishedAt: new Date(),
            });

            return { kind: "coalesced" as const, run: mergedRun };
          }

          const deferredPayload = {
            ...(payload ?? {}),
            issueId,
            [DEFERRED_WAKE_CONTEXT_KEY]: enrichedContextSnapshot,
          };

          const existingDeferred = await tx
            .select()
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.companyId, agent.companyId),
                eq(agentWakeupRequests.agentId, agentId),
                eq(agentWakeupRequests.status, "deferred_issue_execution"),
                sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
              ),
            )
            .orderBy(asc(agentWakeupRequests.requestedAt))
            .limit(1)
            .then((rows) => rows[0] ?? null);

          if (existingDeferred) {
            const existingDeferredPayload = parseObject(existingDeferred.payload);
            const existingDeferredContext = parseObject(existingDeferredPayload[DEFERRED_WAKE_CONTEXT_KEY]);
            const mergedDeferredContext = mergeCoalescedContextSnapshot(
              existingDeferredContext,
              enrichedContextSnapshot,
            );
            const mergedDeferredPayload = {
              ...existingDeferredPayload,
              ...(payload ?? {}),
              issueId,
              [DEFERRED_WAKE_CONTEXT_KEY]: mergedDeferredContext,
            };

            await tx
              .update(agentWakeupRequests)
              .set({
                payload: mergedDeferredPayload,
                coalescedCount: (existingDeferred.coalescedCount ?? 0) + 1,
                updatedAt: new Date(),
              })
              .where(eq(agentWakeupRequests.id, existingDeferred.id));

            return { kind: "deferred" as const };
          }

          await tx.insert(agentWakeupRequests).values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason: "issue_execution_deferred",
            payload: deferredPayload,
            status: "deferred_issue_execution",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
          });

          return { kind: "deferred" as const };
        }

        const wakeupRequest = await tx
          .insert(agentWakeupRequests)
          .values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason,
            payload,
            status: "queued",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
          })
          .returning()
          .then((rows) => rows[0]);

        const newRun = await tx
          .insert(heartbeatRuns)
          .values({
            companyId: agent.companyId,
            agentId,
            invocationSource: source,
            triggerDetail,
            status: "queued",
            wakeupRequestId: wakeupRequest.id,
            contextSnapshot: enrichedContextSnapshot,
            sessionIdBefore: sessionBefore,
          })
          .returning()
          .then((rows) => rows[0]);

        await tx
          .update(agentWakeupRequests)
          .set({
            runId: newRun.id,
            updatedAt: new Date(),
          })
          .where(eq(agentWakeupRequests.id, wakeupRequest.id));

        await tx
          .update(issues)
          .set({
            executionRunId: newRun.id,
            executionAgentNameKey: agentNameKey,
            executionLockedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(issues.id, issue.id));

        return { kind: "queued" as const, run: newRun };
      });

      if (outcome.kind === "deferred" || outcome.kind === "skipped") return null;
      if (outcome.kind === "coalesced") return outcome.run;

      const newRun = outcome.run;
      publishLiveEvent({
        companyId: newRun.companyId,
        type: "heartbeat.run.queued",
        payload: {
          runId: newRun.id,
          agentId: newRun.agentId,
          invocationSource: newRun.invocationSource,
          triggerDetail: newRun.triggerDetail,
          wakeupRequestId: newRun.wakeupRequestId,
        },
      });

      await startNextQueuedRunForAgent(agent.id);
      return newRun;
    }

    const activeRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])))
      .orderBy(desc(heartbeatRuns.createdAt));

    const sameScopeQueuedRun = activeRuns.find(
      (candidate) => candidate.status === "queued" && isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const sameScopeRunningRun = activeRuns.find(
      (candidate) => candidate.status === "running" && isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const shouldQueueFollowupForCommentWake =
      Boolean(wakeCommentId) && Boolean(sameScopeRunningRun) && !sameScopeQueuedRun;

    const coalescedTargetRun =
      sameScopeQueuedRun ??
      (shouldQueueFollowupForCommentWake ? null : sameScopeRunningRun ?? null);

    if (coalescedTargetRun) {
      const mergedContextSnapshot = mergeCoalescedContextSnapshot(
        coalescedTargetRun.contextSnapshot,
        contextSnapshot,
      );
      const mergedRun = await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: mergedContextSnapshot,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, coalescedTargetRun.id))
        .returning()
        .then((rows) => rows[0] ?? coalescedTargetRun);

      await db.insert(agentWakeupRequests).values({
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason,
        payload,
        status: "coalesced",
        coalescedCount: 1,
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        runId: mergedRun.id,
        finishedAt: new Date(),
      });
      return mergedRun;
    }

    const wakeupRequest = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason,
        payload,
        status: "queued",
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
      })
      .returning()
      .then((rows) => rows[0]);

    const newRun = await db
      .insert(heartbeatRuns)
      .values({
        companyId: agent.companyId,
        agentId,
        invocationSource: source,
        triggerDetail,
        status: "queued",
        wakeupRequestId: wakeupRequest.id,
        contextSnapshot: enrichedContextSnapshot,
        sessionIdBefore: sessionBefore,
      })
      .returning()
      .then((rows) => rows[0]);

    await db
      .update(agentWakeupRequests)
      .set({
        runId: newRun.id,
        updatedAt: new Date(),
      })
      .where(eq(agentWakeupRequests.id, wakeupRequest.id));

    publishLiveEvent({
      companyId: newRun.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: newRun.id,
        agentId: newRun.agentId,
        invocationSource: newRun.invocationSource,
        triggerDetail: newRun.triggerDetail,
        wakeupRequestId: newRun.wakeupRequestId,
      },
    });

    await startNextQueuedRunForAgent(agent.id);

    return newRun;
  }

  async function listProjectScopedRunIds(companyId: string, projectId: string) {
    const runIssueId = sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
    const effectiveProjectId = sql<string | null>`coalesce(${heartbeatRuns.contextSnapshot} ->> 'projectId', ${issues.projectId}::text)`;

    const rows = await db
      .selectDistinctOn([heartbeatRuns.id], { id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .leftJoin(
        issues,
        and(
          eq(issues.companyId, companyId),
          sql`${issues.id}::text = ${runIssueId}`,
        ),
      )
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, ["queued", "running"]),
          sql`${effectiveProjectId} = ${projectId}`,
        ),
      );

    return rows.map((row) => row.id);
  }

  async function listProjectScopedWakeupIds(companyId: string, projectId: string) {
    const wakeIssueId = sql<string | null>`${agentWakeupRequests.payload} ->> 'issueId'`;
    const effectiveProjectId = sql<string | null>`coalesce(${agentWakeupRequests.payload} ->> 'projectId', ${issues.projectId}::text)`;

    const rows = await db
      .selectDistinctOn([agentWakeupRequests.id], { id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .leftJoin(
        issues,
        and(
          eq(issues.companyId, companyId),
          sql`${issues.id}::text = ${wakeIssueId}`,
        ),
      )
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
          sql`${agentWakeupRequests.runId} is null`,
          sql`${effectiveProjectId} = ${projectId}`,
        ),
      );

    return rows.map((row) => row.id);
  }

  async function cancelPendingWakeupsForBudgetScope(scope: BudgetEnforcementScope) {
    const now = new Date();
    let wakeupIds: string[] = [];

    if (scope.scopeType === "company") {
      wakeupIds = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, scope.companyId),
            inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
            sql`${agentWakeupRequests.runId} is null`,
          ),
        )
        .then((rows) => rows.map((row) => row.id));
    } else if (scope.scopeType === "agent") {
      wakeupIds = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, scope.companyId),
            eq(agentWakeupRequests.agentId, scope.scopeId),
            inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
            sql`${agentWakeupRequests.runId} is null`,
          ),
        )
        .then((rows) => rows.map((row) => row.id));
    } else {
      wakeupIds = await listProjectScopedWakeupIds(scope.companyId, scope.scopeId);
    }

    if (wakeupIds.length === 0) return 0;

    await db
      .update(agentWakeupRequests)
      .set({
        status: "cancelled",
        finishedAt: now,
        error: "Cancelled due to budget pause",
        updatedAt: now,
      })
      .where(inArray(agentWakeupRequests.id, wakeupIds));

    return wakeupIds.length;
  }

  async function cancelRunInternal(runId: string, reason = "Cancelled by control plane") {
    const run = await getRun(runId);
    if (!run) throw notFound("Heartbeat run not found");
    if (run.status !== "running" && run.status !== "queued") return run;

    const running = runningProcesses.get(run.id);
    if (running) {
      // Kill the WHOLE tree (agy.exe spawns ~30 workers) — fire-and-forget.
      terminateProcessTree(running.child, running.graceSec);
    }

    const cancelled = await setRunStatus(run.id, "cancelled", {
      finishedAt: new Date(),
      error: reason,
      errorCode: "cancelled",
    });

    await setWakeupStatus(run.wakeupRequestId, "cancelled", {
      finishedAt: new Date(),
      error: reason,
    });

    if (cancelled) {
      await appendRunEvent(cancelled, 1, {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message: "run cancelled",
      });
      await releaseIssueExecutionAndPromote(cancelled);
    }

    runningProcesses.delete(run.id);
    await finalizeAgentStatus(run.agentId, "cancelled");
    // Don't hold the cancel request on the agent start-lock / next spawn:
    // cancelling N runs in a row used to serialize N lock waits + N spawns.
    void startNextQueuedRunForAgent(run.agentId).catch((err) => {
      logger.error({ err, agentId: run.agentId }, "start next queued run after cancel failed");
    });
    return cancelled;
  }

  async function cancelActiveForAgentInternal(agentId: string, reason = "Cancelled due to agent pause") {
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])));

    for (const run of runs) {
      await setRunStatus(run.id, "cancelled", {
        finishedAt: new Date(),
        error: reason,
        errorCode: "cancelled",
      });

      await setWakeupStatus(run.wakeupRequestId, "cancelled", {
        finishedAt: new Date(),
        error: reason,
      });

      const running = runningProcesses.get(run.id);
      if (running) {
        terminateProcessTree(running.child, running.graceSec);
        runningProcesses.delete(run.id);
      }
      await releaseIssueExecutionAndPromote(run);
    }

    return runs.length;
  }

  async function cancelBudgetScopeWork(scope: BudgetEnforcementScope) {
    if (scope.scopeType === "agent") {
      await cancelActiveForAgentInternal(scope.scopeId, "Cancelled due to budget pause");
      await cancelPendingWakeupsForBudgetScope(scope);
      return;
    }

    const runIds =
      scope.scopeType === "company"
        ? await db
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, scope.companyId),
              inArray(heartbeatRuns.status, ["queued", "running"]),
            ),
          )
          .then((rows) => rows.map((row) => row.id))
        : await listProjectScopedRunIds(scope.companyId, scope.scopeId);

    for (const runId of runIds) {
      await cancelRunInternal(runId, "Cancelled due to budget pause");
    }

    await cancelPendingWakeupsForBudgetScope(scope);
  }

  return {
    list: async (companyId: string, agentId?: string, limit?: number) => {
      const query = db
        .select(heartbeatRunListColumns)
        .from(heartbeatRuns)
        .where(
          agentId
            ? and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId))
            : eq(heartbeatRuns.companyId, companyId),
        )
        .orderBy(desc(heartbeatRuns.createdAt));

      // Egress fix 2026-05-27: cap unbounded list reads. This list selects ~30 columns
      // (incl. large resultJson/contextSnapshot/usageJson) so fetching the full history
      // every poll drove heavy Supabase egress. Default to 500 most-recent runs when no
      // explicit limit is given; callers needing more still pass an explicit limit.
      const rows = await query.limit(limit ?? 500);
      return rows.map((row) => ({
        ...row,
        resultJson: summarizeHeartbeatRunResultJson(row.resultJson),
      }));
    },

    // F3: bản NHẸ cho poller chỉ-hiển-thị (không JSON blob). Giữ chữ ký/limit như `list`.
    listSummary: async (companyId: string, agentId?: string, limit?: number) => {
      const query = db
        .select(heartbeatRunSummaryColumns)
        .from(heartbeatRuns)
        .where(
          agentId
            ? and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId))
            : eq(heartbeatRuns.companyId, companyId),
        )
        .orderBy(desc(heartbeatRuns.createdAt));
      return query.limit(limit ?? 500);
    },

    getRun,

    getRuntimeState: async (agentId: string) => {
      const state = await getRuntimeState(agentId);
      const agent = await getAgent(agentId);
      if (!agent) return null;
      const ensured = state ?? (await ensureRuntimeState(agent));
      const latestTaskSession = await db
        .select()
        .from(agentTaskSessions)
        .where(and(eq(agentTaskSessions.companyId, agent.companyId), eq(agentTaskSessions.agentId, agent.id)))
        .orderBy(desc(agentTaskSessions.updatedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return {
        ...ensured,
        sessionDisplayId: latestTaskSession?.sessionDisplayId ?? ensured.sessionId,
        sessionParamsJson: latestTaskSession?.sessionParamsJson ?? null,
      };
    },

    listTaskSessions: async (agentId: string) => {
      const agent = await getAgent(agentId);
      if (!agent) throw notFound("Agent not found");

      return db
        .select()
        .from(agentTaskSessions)
        .where(and(eq(agentTaskSessions.companyId, agent.companyId), eq(agentTaskSessions.agentId, agentId)))
        .orderBy(desc(agentTaskSessions.updatedAt), desc(agentTaskSessions.createdAt));
    },

    resetRuntimeSession: async (agentId: string, opts?: { taskKey?: string | null }) => {
      const agent = await getAgent(agentId);
      if (!agent) throw notFound("Agent not found");
      await ensureRuntimeState(agent);
      const taskKey = readNonEmptyString(opts?.taskKey);
      const clearedTaskSessions = await clearTaskSessions(
        agent.companyId,
        agent.id,
        taskKey ? { taskKey, adapterType: agent.adapterType } : undefined,
      );
      const runtimePatch: Partial<typeof agentRuntimeState.$inferInsert> = {
        sessionId: null,
        lastError: null,
        updatedAt: new Date(),
      };
      if (!taskKey) {
        runtimePatch.stateJson = {};
      }

      const updated = await db
        .update(agentRuntimeState)
        .set(runtimePatch)
        .where(eq(agentRuntimeState.agentId, agentId))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!updated) return null;
      return {
        ...updated,
        sessionDisplayId: null,
        sessionParamsJson: null,
        clearedTaskSessions,
      };
    },

    listEvents: (runId: string, afterSeq = 0, limit = 200) =>
      db
        .select()
        .from(heartbeatRunEvents)
        .where(and(eq(heartbeatRunEvents.runId, runId), gt(heartbeatRunEvents.seq, afterSeq)))
        .orderBy(asc(heartbeatRunEvents.seq))
        .limit(Math.max(1, Math.min(limit, 1000))),

    readLog: async (runId: string, opts?: { offset?: number; limitBytes?: number }) => {
      const run = await getRun(runId);
      if (!run) throw notFound("Heartbeat run not found");
      if (!run.logStore || !run.logRef) throw notFound("Run log not found");

      const result = await runLogStore.read(
        {
          store: run.logStore as "local_file",
          logRef: run.logRef,
        },
        opts,
      );

      return {
        runId,
        store: run.logStore,
        logRef: run.logRef,
        ...result,
        content: redactCurrentUserText(result.content, await getCurrentUserRedactionOptions()),
      };
    },

    invoke: async (
      agentId: string,
      source: "timer" | "assignment" | "on_demand" | "automation" = "on_demand",
      contextSnapshot: Record<string, unknown> = {},
      triggerDetail: "manual" | "ping" | "callback" | "system" = "manual",
      actor?: { actorType?: "user" | "agent" | "system"; actorId?: string | null },
    ) =>
      enqueueWakeup(agentId, {
        source,
        triggerDetail,
        contextSnapshot,
        requestedByActorType: actor?.actorType,
        requestedByActorId: actor?.actorId ?? null,
      }),

    wakeup: enqueueWakeup,

    reportRunActivity: clearDetachedRunWarning,

    reapOrphanedRuns,

    resumeQueuedRuns,

    tickTimers: async (
      now = new Date(),
      options: { processStartMs?: number } = { processStartMs: SCHEDULER_PROCESS_STARTED_AT_MS },
    ) => {
      const tickStartedAtMs = Date.now();
      const fleet = readFleetThrottleConfig();
      const effectiveProcessStartMs = options.processStartMs ?? SCHEDULER_PROCESS_STARTED_AT_MS;
      // F2: quét danh sách agent bounded 15s (SET LOCAL). Pass 2 (fire/enqueue per-agent) dùng db thường.
      const allAgents = await boundedPoll(db, (tx) => tx.select().from(agents));
      // GEM-1443: per-phase timing so a slow tick says WHERE it spent the time.
      const phases: Record<string, number> = { pollAgents: Date.now() - tickStartedAtMs };
      let phaseStartedAtMs = Date.now();
      const endPhase = (name: string) => {
        const t = Date.now();
        phases[name] = t - phaseStartedAtMs;
        phaseStartedAtMs = t;
      };
      let checked = 0;
      let enqueued = 0;
      let skipped = 0;

      // Pass 1: collect agents whose timer/cron has elapsed.
      type PendingFire = {
        agent: typeof allAgents[0];
        policy: ReturnType<typeof parseHeartbeatPolicy>;
        reason: string;
      };
      const pendingFires: PendingFire[] = [];
      // GEMRAL FIX 2026-06-10 (B): agents whose cron is overdue beyond the catch-up
      // grace window — skip the stale fire but resync baseline so the NEXT scheduled
      // tick fires on time (prevents a missed 07:00 brief from firing hours later).
      const staleResyncIds: string[] = [];

      for (const agent of allAgents) {
        if (isHeartbeatSkipped(agent.status)) continue;
        const policy = parseHeartbeatPolicy(agent);
        if (!policy.enabled) continue;
        // Must have at least one schedule: cron OR intervalSec
        if (!policy.cron && policy.intervalSec <= 0) continue;

        checked += 1;
        const baseline = new Date(agent.lastHeartbeatAt ?? agent.createdAt);

        // GEMRAL FIX 2026-04-06 P2: Cron expression takes precedence over intervalSec.
        // GEM-1500: Apply deterministic per-agent hash jitter (`hash(agent_id) % 30s`)
        // on both recurring slots and the first catch-up slot after a server restart.
        let shouldFire = false;
        let reason = "";
        if (policy.cron) {
          const next = nextCronTick(policy.cron, baseline);
          const dueAtMs = next
            ? computeJitteredDueAtMs({
                baseDueAtMs: next.getTime(),
                agentId: agent.id,
                maxJitterSec: fleet.heartbeatJitterMaxSec,
                processStartMs: effectiveProcessStartMs,
              })
            : null;
          if (next && dueAtMs !== null && now.getTime() >= dueAtMs) {
            const lateMs = now.getTime() - next.getTime();
            const graceMs = policy.catchUpGraceSec * 1000;
            // GEMRAL FIX 2026-06-10 (B): staleness guard. If the scheduler was
            // asleep/down through the scheduled time and only ticks again much
            // later (e.g. a 07:00 brief first noticed at 14:00 after a restart),
            // firing the overdue slot now would run a "morning" job in the
            // afternoon. Skip it; resync baseline so it fires on time next cycle.
            // GEM-1443: a slot that passed while the server was up but ticks were
            // failing is fired (flagged late) instead of silently dropped.
            const decision = classifyCronCatchUp({
              nextMs: next.getTime(),
              nowMs: now.getTime(),
              graceMs,
              processStartMs: effectiveProcessStartMs,
            });
            if (decision === "skip_stale") {
              staleResyncIds.push(agent.id);
              logger.info(
                { agentId: agent.id, cron: policy.cronExpression, lateMs, graceMs },
                "[tickTimers] Skipping stale cron catch-up (overdue beyond grace); resyncing baseline",
              );
            } else {
              shouldFire = true;
              reason = `cron_elapsed:${policy.cronExpression}`;
              if (decision === "fire_late") {
                reason = `cron_elapsed_late:${policy.cronExpression}`;
                logger.warn(
                  { agentId: agent.id, cron: policy.cronExpression, lateMs, graceMs },
                  "[tickTimers] Firing late cron slot missed during scheduler tick outage",
                );
              }
            }
          }
        } else {
          const baseDueAtMs = baseline.getTime() + policy.intervalSec * 1000;
          const dueAtMs = computeJitteredDueAtMs({
            baseDueAtMs,
            agentId: agent.id,
            maxJitterSec: fleet.heartbeatJitterMaxSec,
            processStartMs: effectiveProcessStartMs,
          });
          if (now.getTime() >= dueAtMs) {
            shouldFire = true;
            reason = "interval_elapsed";
          }
        }

        if (shouldFire) {
          pendingFires.push({ agent, policy, reason });
        }
      }

      // GEMRAL FIX 2026-06-10 (B): resync baseline for agents whose overdue cron was
      // skipped as stale — set lastHeartbeatAt=now so nextCronTick targets the NEXT
      // scheduled time instead of re-detecting the same stale slot on every tick.
      // GEM-1443: one statement for all stale agents instead of one round-trip each.
      if (staleResyncIds.length > 0) {
        await db.update(agents).set({ lastHeartbeatAt: now, updatedAt: now }).where(inArray(agents.id, staleResyncIds));
      }
      endPhase("classify");

      // GEM-316 fix: Batch-fetch task status for agents whose timers fired.
      // Skip timer wakeup when an agent has ONLY blocked tasks (no actionable
      // todo/in_progress/backlog work). Event-based wakeups (issue_assigned,
      // issue_comment_mentioned) still fire when blockers resolve, so the agent
      // is never permanently silenced — it just stops burning budget on
      // heartbeats where it has nothing it can do.
      const agentTaskFlags = new Map<string, { hasActionable: boolean; hasBlocked: boolean }>();
      if (pendingFires.length > 0) {
        const pendingIds = pendingFires.map((p) => p.agent.id);
        const taskRows = await boundedPoll(db, (tx) =>
          tx
            .select({ agentId: issues.assigneeAgentId, status: issues.status })
            .from(issues)
            .where(
              and(
                inArray(issues.assigneeAgentId, pendingIds),
                inArray(issues.status, ["todo", "in_progress", "backlog", "blocked"]),
                sql`${issues.hiddenAt} is null`,
                // Issues waiting on a scheduled wake are not actionable yet —
                // they must not keep an otherwise-idle agent's timer firing.
                sql`(${issues.scheduledWakeAt} is null or ${issues.scheduledWakeAt} <= now())`,
              ),
            ),
        );
        for (const row of taskRows) {
          if (!row.agentId) continue;
          const entry = agentTaskFlags.get(row.agentId) ?? { hasActionable: false, hasBlocked: false };
          if (row.status !== "blocked") entry.hasActionable = true;
          else entry.hasBlocked = true;
          agentTaskFlags.set(row.agentId, entry);
        }
      }

      // Pass 2: enqueue wakeups, skipping agents that only have blocked tasks.
      // GEMRAL FIX 2026-05-10: Stagger enqueues across agents that fire in the same tick.
      // Without this, all agents whose cron/interval elapsed simultaneously have their
      // executeRun() kicked off nearly at the same instant, causing Google Gemini API
      // burst-rate 429 errors ("Reset after 0s"). The 2 s gap matches resumeQueuedRuns.
      let enqueuedInThisTick = 0;
      const fireable: PendingFire[] = [];
      for (const pending of pendingFires) {
        const flags = agentTaskFlags.get(pending.agent.id) ?? { hasActionable: false, hasBlocked: false };

        // Skip timer-driven heartbeat when all assigned tasks are blocked.
        // Prevents the agent from looping on work it cannot make progress on.
        if (!flags.hasActionable && flags.hasBlocked) {
          logger.debug(
            { agentId: pending.agent.id },
            "[tickTimers] Skipping timer wakeup — agent has only blocked tasks",
          );
          skipped += 1;
          continue;
        }
        fireable.push(pending);
      }
      endPhase("taskFlags");

      // Fleet throttle rule 3 (fleet-throttle.ts): at most N timer wakes per wall-clock
      // hour per company. Over-cap fires are NOT enqueued and their baseline is NOT
      // advanced, so the next tick re-evaluates them. Fair pick = oldest last-finished.
      const timerExemptIds = new Set(allAgents.filter((a) => isTimerExempt(fleet, a)).map((a) => a.id));
      const timerBudget = await computeTimerWakeBudget(now, fleet, timerExemptIds);
      let deferredByFleet = 0;
      let orderedFires = fireable;
      if (timerBudget && fireable.length > 1) {
        const lastFinished = await lastFinishedAtByAgent(
          fireable.map((p) => p.agent.id),
          [...new Set(fireable.map((p) => p.agent.companyId))],
        );
        orderedFires = orderTimerCandidatesFairly(fireable, (p) => lastFinished.get(p.agent.id));
      }
      endPhase("fleetBudget");

      let deferredByTickBudget = 0;
      const enqueueLoopStartedAtMs = Date.now();

      for (const { agent, policy, reason } of orderedFires) {
        const capped = timerBudget !== null && !timerExemptIds.has(agent.id);
        if (capped && (timerBudget.get(agent.companyId) ?? fleet.timerWakesPerHour) <= 0) {
          deferredByFleet += 1;
          logger.debug(
            { agentId: agent.id, timerWakesPerHour: fleet.timerWakesPerHour },
            "[fleet-throttle] timer wake skipped — hourly company cap reached; re-evaluated next tick",
          );
          continue;
        }

        // GEM-1443: tick time budget — leave the rest due (baseline untouched) for the next tick.
        if (shouldDeferForTickBudget({ enqueuedInThisTick, loopStartedAtMs: enqueueLoopStartedAtMs, nowMs: Date.now() })) {
          deferredByTickBudget += 1;
          continue;
        }

        // Stagger: wait 2 s before the 2nd, 3rd, ... enqueue in this tick so
        // their subprocess spawns don't all hit the Gemini API simultaneously.
        if (enqueuedInThisTick > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 2000));
        }

        const run = await enqueueWakeup(agent.id, {
          source: "timer",
          triggerDetail: "system",
          reason: "heartbeat_timer",
          requestedByActorType: "system",
          requestedByActorId: "heartbeat_scheduler",
          contextSnapshot: {
            source: "scheduler",
            reason,
            now: now.toISOString(),
            cronExpression: policy.cronExpression || undefined,
            intervalSec: policy.cron ? undefined : policy.intervalSec,
            heartbeatJitterMs: computeAgentHeartbeatJitterMs(agent.id, fleet.heartbeatJitterMaxSec),
            // GEM-1443: agent decides whether a late slot still fits its time window.
            late: reason.startsWith("cron_elapsed_late:") || undefined,
          },
        });
        if (run) {
          enqueued += 1;
          enqueuedInThisTick += 1;
          if (capped && timerBudget) {
            timerBudget.set(
              agent.companyId,
              (timerBudget.get(agent.companyId) ?? fleet.timerWakesPerHour) - 1,
            );
          }
          // GEMRAL FIX 2026-06-10 (C): claim the slot at ENQUEUE time, not only on
          // run completion (finalizeAgentStatus). Without this the baseline stays old
          // while the run executes, so every 30s tick re-enqueues the same agent
          // (runaway), and a run that dies mid-flight never advances baseline → the
          // agent stays "due" → re-fires on every restart. Monotonic forward-only
          // write to the same field (no new writer/row — finalize still sets it later).
          await db.update(agents).set({ lastHeartbeatAt: now, updatedAt: now }).where(eq(agents.id, agent.id));
        } else {
          skipped += 1;
        }
      }

      endPhase("enqueue");

      // GEM-1004: quota retries ride the same tick (persisted plan, fires after restart too).
      let quotaRetries = { due: 0, fired: 0 };
      try {
        quotaRetries = await fireDueQuotaRetries(now, { timerBudget, timerExemptIds, fleetDefault: fleet.timerWakesPerHour });
      } catch (err) {
        logger.warn({ err }, "[tickTimers] quota retry pass failed");
      }

      if (deferredByFleet > 0) {
        logger.debug({ deferredByFleet }, "[fleet-throttle] timer wakes deferred this tick");
      }
      if (deferredByTickBudget > 0) {
        logger.info({ deferredByTickBudget }, "[tickTimers] timer wakes deferred to next tick (tick time budget)");
      }
      endPhase("quotaRetries");
      const durationMs = Date.now() - tickStartedAtMs;
      return {
        checked,
        enqueued,
        skipped,
        deferredByFleet,
        deferredByTickBudget,
        staleSkipped: staleResyncIds.length,
        quotaRetries,
        durationMs,
        phases,
      };
    },

    cancelRun: (runId: string) => cancelRunInternal(runId),

    cancelActiveForAgent: (agentId: string) => cancelActiveForAgentInternal(agentId),

    cancelBudgetScopeWork,

    getActiveRunForAgent: async (agentId: string) => {
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agentId),
            eq(heartbeatRuns.status, "running"),
          ),
        )
        .orderBy(desc(heartbeatRuns.startedAt))
        .limit(1);
      return run ?? null;
    },
  };
}
