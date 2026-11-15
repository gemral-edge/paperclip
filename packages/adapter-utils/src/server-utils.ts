import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants, promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import type {
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "./types.js";

export interface RunProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  pid: number | null;
  startedAt: string | null;
}

interface RunningProcess {
  child: ChildProcess;
  graceSec: number;
}

interface SpawnTarget {
  command: string;
  args: string[];
}

type ChildProcessWithEvents = ChildProcess & {
  on(event: "error", listener: (err: Error) => void): ChildProcess;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): ChildProcess;
};

export const runningProcesses = new Map<string, RunningProcess>();

/**
 * GEMRAL FIX 2026-10-05: kill a spawned child AND all its descendants.
 *
 * On Windows `child.kill()` only TerminateProcess()es the direct child (often
 * the cmd.exe wrapper or agy.exe) — grandchildren (~30 agy workers) survive as
 * orphans and keep eating RAM. `child.killed` also flips true as soon as the
 * signal is *sent*, so the old "if (!child.killed) SIGKILL" escalation never ran.
 *
 * Windows: `taskkill /PID <pid> /T /F` (whole tree, forced). Spawned with
 * windowsHide + ignored stdio → libuv adds CREATE_NO_WINDOW (no console flash).
 * Fire-and-forget: never awaited, never throws, so callers (HTTP cancel route,
 * timeout timers) return immediately.
 * POSIX: plain signal to the child (adapters are not spawned detached, so there
 * is no process group to target).
 */
export function killProcessTree(
  target: ChildProcess | number | null | undefined,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  const pid = typeof target === "number" ? target : target?.pid;
  if (typeof pid !== "number" || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      });
      killer.on("error", () => {
        try {
          process.kill(pid);
        } catch {
          /* already gone */
        }
      });
      killer.unref();
    } catch {
      /* best effort */
    }
    return;
  }
  try {
    if (typeof target === "object" && target) target.kill(signal);
    else process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

/** SIGTERM the tree now; on POSIX escalate to SIGKILL after graceSec unless it actually exited. */
export function terminateProcessTree(child: ChildProcess, graceSec: number): void {
  killProcessTree(child, "SIGTERM");
  if (process.platform === "win32") return; // taskkill /F is already final
  const timer = setTimeout(() => {
    // `child.killed` only means "signal sent"; exitCode/signalCode mean "actually exited".
    if (child.exitCode === null && child.signalCode === null) killProcessTree(child, "SIGKILL");
  }, Math.max(1, graceSec) * 1000);
  timer.unref();
}
export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
export const MAX_EXCERPT_BYTES = 32 * 1024;
const SENSITIVE_ENV_KEY = /(key|token|secret|password|passwd|authorization|cookie)/i;
const PAPERCLIP_SKILL_ROOT_RELATIVE_CANDIDATES = [
  "../../skills",
  "../../../../../skills",
];

export interface PaperclipSkillEntry {
  key: string;
  runtimeName: string;
  source: string;
  required?: boolean;
  requiredReason?: string | null;
}

export interface InstalledSkillTarget {
  targetPath: string | null;
  kind: "symlink" | "directory" | "file";
}

interface PersistentSkillSnapshotOptions {
  adapterType: string;
  availableEntries: PaperclipSkillEntry[];
  desiredSkills: string[];
  installed: Map<string, InstalledSkillTarget>;
  skillsHome: string;
  locationLabel?: string | null;
  installedDetail?: string | null;
  missingDetail: string;
  externalConflictDetail: string;
  externalDetail: string;
  warnings?: string[];
}

function normalizePathSlashes(value: string): string {
  return value.replaceAll("\\", "/");
}

function isMaintainerOnlySkillTarget(candidate: string): boolean {
  return normalizePathSlashes(candidate).includes("/.agents/skills/");
}

function skillLocationLabel(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildManagedSkillOrigin(entry: { required?: boolean }): Pick<
  AdapterSkillEntry,
  "origin" | "originLabel" | "readOnly"
> {
  if (entry.required) {
    return {
      origin: "paperclip_required",
      originLabel: "Required by Paperclip",
      readOnly: false,
    };
  }
  return {
    origin: "company_managed",
    originLabel: "Managed by Paperclip",
    readOnly: false,
  };
}

function resolveInstalledEntryTarget(
  skillsHome: string,
  entryName: string,
  dirent: Dirent,
  linkedPath: string | null,
): InstalledSkillTarget {
  const fullPath = path.join(skillsHome, entryName);
  if (dirent.isSymbolicLink()) {
    return {
      targetPath: linkedPath ? path.resolve(path.dirname(fullPath), linkedPath) : null,
      kind: "symlink",
    };
  }
  if (dirent.isDirectory()) {
    return { targetPath: fullPath, kind: "directory" };
  }
  return { targetPath: fullPath, kind: "file" };
}

export function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function parseJson(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function appendWithCap(prev: string, chunk: string, cap = MAX_CAPTURE_BYTES) {
  if (chunk.length >= cap) {
    return chunk.slice(chunk.length - cap);
  }
  if (prev.length + chunk.length <= cap) {
    return prev + chunk;
  }
  const keepPrev = cap - chunk.length;
  return (keepPrev > 0 ? prev.slice(prev.length - keepPrev) : "") + chunk;
}

export function resolvePathValue(obj: Record<string, unknown>, dottedPath: string) {
  const parts = dottedPath.split(".");
  let cursor: unknown = obj;

  for (const part of parts) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      return "";
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }

  if (cursor === null || cursor === undefined) return "";
  if (typeof cursor === "string") return cursor;
  if (typeof cursor === "number" || typeof cursor === "boolean") return String(cursor);

  try {
    return JSON.stringify(cursor);
  } catch {
    return "";
  }
}

export function renderTemplate(template: string, data: Record<string, unknown>) {
  return template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_, path) => resolvePathValue(data, path));
}

export function joinPromptSections(
  sections: Array<string | null | undefined>,
  separator = "\n\n",
) {
  return sections
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .join(separator);
}

export function redactEnvForLogs(env: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    redacted[key] = SENSITIVE_ENV_KEY.test(key) ? "***REDACTED***" : value;
  }
  return redacted;
}

export function buildInvocationEnvForLogs(
  env: Record<string, string>,
  options: {
    runtimeEnv?: NodeJS.ProcessEnv | Record<string, string>;
    includeRuntimeKeys?: string[];
    resolvedCommand?: string | null;
    resolvedCommandEnvKey?: string;
  } = {},
): Record<string, string> {
  const merged: Record<string, string> = { ...env };
  const runtimeEnv = options.runtimeEnv ?? {};

  for (const key of options.includeRuntimeKeys ?? []) {
    if (key in merged) continue;
    const value = runtimeEnv[key];
    if (typeof value !== "string" || value.length === 0) continue;
    merged[key] = value;
  }

  const resolvedCommand = options.resolvedCommand?.trim();
  if (resolvedCommand) {
    merged[options.resolvedCommandEnvKey ?? "PAPERCLIP_RESOLVED_COMMAND"] = resolvedCommand;
  }

  return redactEnvForLogs(merged);
}

/**
 * Spawn-time identity context. Lets adapters inject everything an agent needs
 * to know about itself + its current task without making round-trip API calls
 * (eliminates the "Step 1: GET /api/agents/me" pattern).
 */
export interface SpawnIdentityContext {
  agent: {
    id: string;
    companyId: string;
    name?: string | null;
    role?: string | null;
    title?: string | null;
    icon?: string | null;
  };
  company?: {
    id: string;
    name?: string | null;
    issuePrefix?: string | null;
  } | null;
  issue?: {
    id: string;
    identifier?: string | null;
    title?: string | null;
    description?: string | null;
    status?: string | null;
    priority?: string | null;
    parentId?: string | null;
    assigneeAgentId?: string | null;
    projectId?: string | null;
  } | null;
  run?: {
    id?: string | null;
    wakeReason?: string | null;
    wakeCommentId?: string | null;
    approvalId?: string | null;
    taskId?: string | null;
  } | null;
}

export function buildPaperclipEnv(
  agent: { id: string; companyId: string; name?: string | null; role?: string | null; title?: string | null; icon?: string | null },
  identity?: Omit<SpawnIdentityContext, "agent">,
): Record<string, string> {
  const resolveHostForUrl = (rawHost: string): string => {
    const host = rawHost.trim();
    if (!host || host === "0.0.0.0" || host === "::") return "localhost";
    if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) return `[${host}]`;
    return host;
  };
  const vars: Record<string, string> = {
    PAPERCLIP_AGENT_ID: agent.id,
    PAPERCLIP_COMPANY_ID: agent.companyId,
    // UTF-8 locale (BUG-051 fix 2026-04-21). Without these, on Windows the
    // console codepage defaults to cp1252 — any shell subprocess Claude CLI
    // spawns (curl, git-bash, cmd /c) strips emoji and mangles accented
    // Vietnamese chars in stdin/stdout. Comments containing "✅ hoàn thành"
    // land in the DB as "? ho�n th�nh". These env vars tell libc /
    // Python / Node child processes to stay in UTF-8 regardless of console
    // codepage. Inherited by the MCP stdio subprocess too.
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };
  // Agent identity vars (so agent doesn't need GET /api/agents/me at spawn).
  if (agent.name) vars.PAPERCLIP_AGENT_NAME = agent.name;
  if (agent.role) vars.PAPERCLIP_AGENT_ROLE = agent.role;
  if (agent.title) vars.PAPERCLIP_AGENT_TITLE = agent.title;
  if (agent.icon) vars.PAPERCLIP_AGENT_ICON = agent.icon;
  // Company prefix (so agent can construct issue URLs like /GEM/issues/GEM-378).
  if (identity?.company?.issuePrefix) vars.PAPERCLIP_COMPANY_PREFIX = identity.company.issuePrefix;
  if (identity?.company?.name) vars.PAPERCLIP_COMPANY_NAME = identity.company.name;
  // Issue context vars (so agent doesn't need GET /api/issues/{id} for the
  // task assignment that triggered this spawn).
  const issue = identity?.issue;
  if (issue) {
    vars.PAPERCLIP_ISSUE_ID = issue.id;
    if (issue.identifier) vars.PAPERCLIP_ISSUE_IDENTIFIER = issue.identifier;
    if (issue.title) vars.PAPERCLIP_ISSUE_TITLE = issue.title;
    // Description truncated to 4KB for env var (Windows env block size guard).
    // Manifest file has full description with no limit. If truncated, agent
    // sees PAPERCLIP_ISSUE_DESCRIPTION_TRUNCATED=1 sentinel and knows to
    // fall back to manifest or API for full body.
    if (issue.description) {
      const truncated = truncateUtf8ToBytes(issue.description, 4096);
      vars.PAPERCLIP_ISSUE_DESCRIPTION = truncated.text;
      if (truncated.wasTruncated) {
        vars.PAPERCLIP_ISSUE_DESCRIPTION_TRUNCATED = "1";
      }
    }
    if (issue.status) vars.PAPERCLIP_ISSUE_STATUS = issue.status;
    if (issue.priority) vars.PAPERCLIP_ISSUE_PRIORITY = issue.priority;
    if (issue.assigneeAgentId) vars.PAPERCLIP_ISSUE_ASSIGNEE_AGENT_ID = issue.assigneeAgentId;
    if (issue.projectId) vars.PAPERCLIP_ISSUE_PROJECT_ID = issue.projectId;
    if (issue.parentId) vars.PAPERCLIP_ISSUE_PARENT_ID = issue.parentId;
  }
  const run = identity?.run;
  if (run?.id) vars.PAPERCLIP_RUN_ID = run.id;
  if (run?.wakeReason) vars.PAPERCLIP_WAKE_REASON = run.wakeReason;
  if (run?.wakeCommentId) vars.PAPERCLIP_WAKE_COMMENT_ID = run.wakeCommentId;
  if (run?.approvalId) vars.PAPERCLIP_APPROVAL_ID = run.approvalId;
  if (run?.taskId) vars.PAPERCLIP_TASK_ID = run.taskId;
  const runtimeHost = resolveHostForUrl(
    process.env.PAPERCLIP_LISTEN_HOST ?? process.env.HOST ?? "localhost",
  );
  const runtimePort = process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100";
  const apiUrl = process.env.PAPERCLIP_API_URL ?? `http://${runtimeHost}:${runtimePort}`;
  vars.PAPERCLIP_API_URL = apiUrl;
  return vars;
}

export function defaultPathForPlatform() {
  if (process.platform === "win32") {
    return "C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem";
  }
  return "/usr/local/bin:/opt/homebrew/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin";
}

function windowsPathExts(env: NodeJS.ProcessEnv): string[] {
  return (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
}

async function pathExists(candidate: string) {
  try {
    await fs.access(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Truncates a UTF-8 string to fit within `maxBytes` bytes, respecting
 * multi-byte char boundaries (so Vietnamese diacritics / emoji aren't cut
 * mid-codepoint and turned into garbage). Appends ellipsis if truncated.
 *
 * Returns both the truncated text + a flag indicating whether truncation
 * happened, so callers can emit a sentinel env var and agents know to fetch
 * full body from manifest or API.
 */
export function truncateUtf8ToBytes(input: string, maxBytes: number): { text: string; wasTruncated: boolean } {
  const buf = Buffer.from(input, "utf8");
  if (buf.length <= maxBytes) {
    return { text: input, wasTruncated: false };
  }
  // Reserve 1 byte for the ellipsis (U+2026 = 3 UTF-8 bytes "…").
  let end = Math.max(0, maxBytes - 3);
  // Back off if we're in the middle of a multi-byte sequence (continuation
  // bytes have 10xxxxxx pattern = 0x80..0xBF).
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end--;
  }
  return { text: buf.subarray(0, end).toString("utf8") + "…", wasTruncated: true };
}

/**
 * Builds a SpawnIdentityContext from an agent record + the heartbeat-context
 * snapshot already populated by services/heartbeat.ts. Reusable across all
 * adapters so each one doesn't reimplement the same field plucking.
 */
export function synthesizeSpawnIdentity(
  agent: { id: string; companyId: string; name?: string | null; role?: string | null; title?: string | null; icon?: string | null },
  context: Record<string, unknown>,
  runId: string,
): SpawnIdentityContext {
  const pickString = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  const issueId = pickString(context.issueId);
  return {
    agent: {
      id: agent.id,
      companyId: agent.companyId,
      name: agent.name ?? null,
      role: agent.role ?? null,
      title: agent.title ?? null,
      icon: agent.icon ?? null,
    },
    company: {
      id: agent.companyId,
      name: pickString(context.companyName),
      issuePrefix: pickString(context.companyPrefix),
    },
    issue: issueId
      ? {
          id: issueId,
          identifier: pickString(context.issueIdentifier),
          title: pickString(context.issueTitle),
          description: pickString(context.issueDescription),
          status: pickString(context.issueStatus),
          priority: pickString(context.issuePriority),
          parentId: pickString(context.issueParentId),
          assigneeAgentId: pickString(context.issueAssigneeAgentId),
          projectId: pickString(context.issueProjectId),
        }
      : null,
    run: {
      id: runId,
      wakeReason: pickString(context.wakeReason),
      wakeCommentId: pickString(context.wakeCommentId) ?? pickString(context.commentId),
      approvalId: pickString(context.approvalId),
      taskId: pickString(context.taskId) ?? issueId,
    },
  };
}

/**
 * Drops a `.paperclip-spawn-context.json` file in the spawn cwd containing
 * the full identity + task context for the agent. Lets agents `cat` ONE file
 * to know everything (eliminates 3-4 round-trip API lookups per heartbeat
 * for agent name, role, issue identifier, etc.).
 *
 * Safe-by-design: file is overwritten on every spawn, contains only data
 * the agent already has access to via API, but presented atomically.
 */
export async function writeSpawnContextManifest(
  cwd: string,
  identity: SpawnIdentityContext,
  apiKey: string | null,
): Promise<void> {
  if (!cwd) return;
  const manifest = {
    schema: "paperclip-spawn-context/v1",
    spawnedAt: new Date().toISOString(),
    agent: {
      id: identity.agent.id,
      companyId: identity.agent.companyId,
      name: identity.agent.name ?? null,
      role: identity.agent.role ?? null,
      title: identity.agent.title ?? null,
      icon: identity.agent.icon ?? null,
    },
    company: identity.company
      ? {
          id: identity.company.id,
          name: identity.company.name ?? null,
          issuePrefix: identity.company.issuePrefix ?? null,
        }
      : null,
    issue: identity.issue
      ? {
          id: identity.issue.id,
          identifier: identity.issue.identifier ?? null,
          title: identity.issue.title ?? null,
          // Manifest gets FULL description (no truncation — file has no size
          // limit). The env var PAPERCLIP_ISSUE_DESCRIPTION is truncated to
          // 4KB; agent reads manifest when full body is needed.
          description: identity.issue.description ?? null,
          status: identity.issue.status ?? null,
          priority: identity.issue.priority ?? null,
          parentId: identity.issue.parentId ?? null,
          assigneeAgentId: identity.issue.assigneeAgentId ?? null,
          projectId: identity.issue.projectId ?? null,
        }
      : null,
    run: identity.run
      ? {
          id: identity.run.id ?? null,
          wakeReason: identity.run.wakeReason ?? null,
          wakeCommentId: identity.run.wakeCommentId ?? null,
          approvalId: identity.run.approvalId ?? null,
          taskId: identity.run.taskId ?? null,
        }
      : null,
    auth: {
      apiUrl:
        process.env.PAPERCLIP_API_URL ??
        `http://${process.env.PAPERCLIP_LISTEN_HOST ?? process.env.HOST ?? "localhost"}:${process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100"}`,
      hasApiKey: Boolean(apiKey && apiKey.trim().length > 0),
      runIdHeader: identity.run?.id ?? null,
    },
  };
  const target = path.join(cwd, ".paperclip-spawn-context.json");
  try {
    await fs.writeFile(target, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8" });
  } catch (err) {
    // Non-fatal — env vars still carry the same data; manifest is convenience.
    // Log via stderr but don't block spawn.
    process.stderr.write(
      `[paperclip] writeSpawnContextManifest failed for ${target}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

async function resolveCommandPath(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const hasPathSeparator = command.includes("/") || command.includes("\\");
  if (hasPathSeparator) {
    const absolute = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    return (await pathExists(absolute)) ? absolute : null;
  }

  const pathValue = env.PATH ?? env.Path ?? "";
  const delimiter = process.platform === "win32" ? ";" : ":";
  const dirs = pathValue.split(delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? windowsPathExts(env) : [""];
  const hasExtension = process.platform === "win32" && path.extname(command).length > 0;

  for (const dir of dirs) {
    const candidates =
      process.platform === "win32"
        ? hasExtension
          ? [path.join(dir, command)]
          : exts.map((ext) => path.join(dir, `${command}${ext}`))
        : [path.join(dir, command)];
    for (const candidate of candidates) {
      if (await pathExists(candidate)) return candidate;
    }
  }

  return null;
}

export async function resolveCommandForLogs(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return (await resolveCommandPath(command, cwd, env)) ?? command;
}

function quoteForCmd(arg: string) {
  if (!arg.length) return '""';
  const escaped = arg.replace(/"/g, '""');
  return /[\s"&<>|^()]/.test(escaped) ? `"${escaped}"` : escaped;
}

async function resolveSpawnTarget(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<SpawnTarget> {
  const resolved = await resolveCommandPath(command, cwd, env);
  const executable = resolved ?? command;

  if (process.platform !== "win32") {
    return { command: executable, args };
  }

  if (/\.(cmd|bat)$/i.test(executable)) {
    const shell = env.ComSpec || process.env.ComSpec || "cmd.exe";
    const commandLine = [quoteForCmd(executable), ...args.map(quoteForCmd)].join(" ");
    // GEMRAL FIX 2026-04-25b: cmd.exe `/s` flag forces "old behavior" of stripping
    // exactly one outer quote pair from the /c argument. To survive /s and keep the
    // inner quotes around an executable path with spaces (e.g. C:\Users\Jennie Chu\
    // ...\gemini.CMD), wrap the entire commandLine in an extra outer pair. cmd.exe
    // strips the outer pair → inner `"C:\path\gemini.CMD" args` reaches the parser
    // intact. Combined with windowsVerbatimArguments=true at the spawn site, Node
    // does not re-escape and clobber the carefully-built quoting. Pattern matches
    // Node.js own shell:true cmd.exe handling.
    const wrappedCommandLine = `"${commandLine}"`;
    return {
      command: shell,
      args: ["/d", "/s", "/c", wrappedCommandLine],
    };
  }

  return { command: executable, args };
}

export function ensurePathInEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (typeof env.PATH === "string" && env.PATH.length > 0) return env;
  if (typeof env.Path === "string" && env.Path.length > 0) return env;
  return { ...env, PATH: defaultPathForPlatform() };
}

export async function ensureAbsoluteDirectory(
  cwd: string,
  opts: { createIfMissing?: boolean } = {},
) {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`Working directory must be an absolute path: "${cwd}"`);
  }

  const assertDirectory = async () => {
    const stats = await fs.stat(cwd);
    if (!stats.isDirectory()) {
      throw new Error(`Working directory is not a directory: "${cwd}"`);
    }
  };

  try {
    await assertDirectory();
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!opts.createIfMissing || code !== "ENOENT") {
      if (code === "ENOENT") {
        throw new Error(`Working directory does not exist: "${cwd}"`);
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  try {
    await fs.mkdir(cwd, { recursive: true });
    await assertDirectory();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not create working directory "${cwd}": ${reason}`);
  }
}

export async function resolvePaperclipSkillsDir(
  moduleDir: string,
  additionalCandidates: string[] = [],
): Promise<string | null> {
  const candidates = [
    ...PAPERCLIP_SKILL_ROOT_RELATIVE_CANDIDATES.map((relativePath) => path.resolve(moduleDir, relativePath)),
    ...additionalCandidates.map((candidate) => path.resolve(candidate)),
  ];
  const seenRoots = new Set<string>();

  for (const root of candidates) {
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);
    const isDirectory = await fs.stat(root).then((stats) => stats.isDirectory()).catch(() => false);
    if (isDirectory) return root;
  }

  return null;
}

export async function listPaperclipSkillEntries(
  moduleDir: string,
  additionalCandidates: string[] = [],
): Promise<PaperclipSkillEntry[]> {
  const root = await resolvePaperclipSkillsDir(moduleDir, additionalCandidates);
  if (!root) return [];

  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        key: `paperclipai/paperclip/${entry.name}`,
        runtimeName: entry.name,
        source: path.join(root, entry.name),
        required: true,
        requiredReason: "Bundled Paperclip skills are always available for local adapters.",
      }));
  } catch {
    return [];
  }
}

export async function readInstalledSkillTargets(skillsHome: string): Promise<Map<string, InstalledSkillTarget>> {
  const entries = await fs.readdir(skillsHome, { withFileTypes: true }).catch(() => []);
  const out = new Map<string, InstalledSkillTarget>();
  for (const entry of entries) {
    const fullPath = path.join(skillsHome, entry.name);
    const linkedPath = entry.isSymbolicLink() ? await fs.readlink(fullPath).catch(() => null) : null;
    out.set(entry.name, resolveInstalledEntryTarget(skillsHome, entry.name, entry, linkedPath));
  }
  return out;
}

export function buildPersistentSkillSnapshot(
  options: PersistentSkillSnapshotOptions,
): AdapterSkillSnapshot {
  const {
    adapterType,
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel,
    installedDetail,
    missingDetail,
    externalConflictDetail,
    externalDetail,
  } = options;
  const availableByKey = new Map(availableEntries.map((entry) => [entry.key, entry]));
  const desiredSet = new Set(desiredSkills);
  const entries: AdapterSkillEntry[] = [];
  const warnings = [...(options.warnings ?? [])];

  for (const available of availableEntries) {
    const installedEntry = installed.get(available.runtimeName) ?? null;
    const desired = desiredSet.has(available.key);
    let state: AdapterSkillEntry["state"] = "available";
    let managed = false;
    let detail: string | null = null;

    if (installedEntry?.targetPath === available.source) {
      managed = true;
      state = desired ? "installed" : "stale";
      detail = installedDetail ?? null;
    } else if (installedEntry) {
      state = "external";
      detail = desired ? externalConflictDetail : externalDetail;
    } else if (desired) {
      state = "missing";
      detail = missingDetail;
    }

    entries.push({
      key: available.key,
      runtimeName: available.runtimeName,
      desired,
      managed,
      state,
      sourcePath: available.source,
      targetPath: path.join(skillsHome, available.runtimeName),
      detail,
      required: Boolean(available.required),
      requiredReason: available.requiredReason ?? null,
      ...buildManagedSkillOrigin(available),
    });
  }

  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill)) continue;
    warnings.push(`Desired skill "${desiredSkill}" is not available from the Paperclip skills directory.`);
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      sourcePath: null,
      targetPath: null,
      detail: "Paperclip cannot find this skill in the local runtime skills directory.",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
    });
  }

  for (const [name, installedEntry] of installed.entries()) {
    if (availableEntries.some((entry) => entry.runtimeName === name)) continue;
    entries.push({
      key: name,
      runtimeName: name,
      desired: false,
      managed: false,
      state: "external",
      origin: "user_installed",
      originLabel: "User-installed",
      locationLabel: skillLocationLabel(locationLabel),
      readOnly: true,
      sourcePath: null,
      targetPath: installedEntry.targetPath ?? path.join(skillsHome, name),
      detail: externalDetail,
    });
  }

  entries.sort((left, right) => left.key.localeCompare(right.key));

  return {
    adapterType,
    supported: true,
    mode: "persistent",
    desiredSkills,
    entries,
    warnings,
  };
}

function normalizeConfiguredPaperclipRuntimeSkills(value: unknown): PaperclipSkillEntry[] {
  if (!Array.isArray(value)) return [];
  const out: PaperclipSkillEntry[] = [];
  for (const rawEntry of value) {
    const entry = parseObject(rawEntry);
    const key = asString(entry.key, asString(entry.name, "")).trim();
    const runtimeName = asString(entry.runtimeName, asString(entry.name, "")).trim();
    const source = asString(entry.source, "").trim();
    if (!key || !runtimeName || !source) continue;
    out.push({
      key,
      runtimeName,
      source,
      required: asBoolean(entry.required, false),
      requiredReason:
        typeof entry.requiredReason === "string" && entry.requiredReason.trim().length > 0
          ? entry.requiredReason.trim()
          : null,
    });
  }
  return out;
}

export async function readPaperclipRuntimeSkillEntries(
  config: Record<string, unknown>,
  moduleDir: string,
  additionalCandidates: string[] = [],
): Promise<PaperclipSkillEntry[]> {
  const configuredEntries = normalizeConfiguredPaperclipRuntimeSkills(config.paperclipRuntimeSkills);
  if (configuredEntries.length > 0) return configuredEntries;
  return listPaperclipSkillEntries(moduleDir, additionalCandidates);
}

export async function readPaperclipSkillMarkdown(
  moduleDir: string,
  skillKey: string,
): Promise<string | null> {
  const normalized = skillKey.trim().toLowerCase();
  if (!normalized) return null;

  const entries = await listPaperclipSkillEntries(moduleDir);
  const match = entries.find((entry) => entry.key === normalized);
  if (!match) return null;

  try {
    return await fs.readFile(path.join(match.source, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
}

export function readPaperclipSkillSyncPreference(config: Record<string, unknown>): {
  explicit: boolean;
  desiredSkills: string[];
} {
  const raw = config.paperclipSkillSync;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { explicit: false, desiredSkills: [] };
  }
  const syncConfig = raw as Record<string, unknown>;
  const desiredValues = syncConfig.desiredSkills;
  const desired = Array.isArray(desiredValues)
    ? desiredValues
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  return {
    explicit: Object.prototype.hasOwnProperty.call(raw, "desiredSkills"),
    desiredSkills: Array.from(new Set(desired)),
  };
}

function canonicalizeDesiredPaperclipSkillReference(
  reference: string,
  availableEntries: Array<{ key: string; runtimeName?: string | null }>,
): string {
  const normalizedReference = reference.trim().toLowerCase();
  if (!normalizedReference) return "";

  const exactKey = availableEntries.find((entry) => entry.key.trim().toLowerCase() === normalizedReference);
  if (exactKey) return exactKey.key;

  const byRuntimeName = availableEntries.filter((entry) =>
    typeof entry.runtimeName === "string" && entry.runtimeName.trim().toLowerCase() === normalizedReference,
  );
  if (byRuntimeName.length === 1) return byRuntimeName[0]!.key;

  const slugMatches = availableEntries.filter((entry) =>
    entry.key.trim().toLowerCase().split("/").pop() === normalizedReference,
  );
  if (slugMatches.length === 1) return slugMatches[0]!.key;

  return normalizedReference;
}

export function resolvePaperclipDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; runtimeName?: string | null; required?: boolean }>,
): string[] {
  const preference = readPaperclipSkillSyncPreference(config);
  const requiredSkills = availableEntries
    .filter((entry) => entry.required)
    .map((entry) => entry.key);
  if (!preference.explicit) {
    return Array.from(new Set(requiredSkills));
  }
  const desiredSkills = preference.desiredSkills
    .map((reference) => canonicalizeDesiredPaperclipSkillReference(reference, availableEntries))
    .filter(Boolean);
  return Array.from(new Set([...requiredSkills, ...desiredSkills]));
}

export function writePaperclipSkillSyncPreference(
  config: Record<string, unknown>,
  desiredSkills: string[],
): Record<string, unknown> {
  const next = { ...config };
  const raw = next.paperclipSkillSync;
  const current =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  current.desiredSkills = Array.from(
    new Set(
      desiredSkills
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
  next.paperclipSkillSync = current;
  return next;
}

export async function ensurePaperclipSkillSymlink(
  source: string,
  target: string,
  linkSkill: (source: string, target: string) => Promise<void> = (linkSource, linkTarget) =>
    fs.symlink(linkSource, linkTarget),
): Promise<"created" | "repaired" | "skipped"> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await linkSkill(source, target);
    return "created";
  }

  if (!existing.isSymbolicLink()) {
    return "skipped";
  }

  const linkedPath = await fs.readlink(target).catch(() => null);
  if (!linkedPath) return "skipped";

  const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
  if (resolvedLinkedPath === source) {
    return "skipped";
  }

  const linkedPathExists = await fs.stat(resolvedLinkedPath).then(() => true).catch(() => false);
  if (linkedPathExists) {
    return "skipped";
  }

  await fs.unlink(target);
  await linkSkill(source, target);
  return "repaired";
}

export async function removeMaintainerOnlySkillSymlinks(
  skillsHome: string,
  allowedSkillNames: Iterable<string>,
): Promise<string[]> {
  const allowed = new Set(Array.from(allowedSkillNames));
  try {
    const entries = await fs.readdir(skillsHome, { withFileTypes: true });
    const removed: string[] = [];
    for (const entry of entries) {
      if (allowed.has(entry.name)) continue;

      const target = path.join(skillsHome, entry.name);
      const existing = await fs.lstat(target).catch(() => null);
      if (!existing?.isSymbolicLink()) continue;

      const linkedPath = await fs.readlink(target).catch(() => null);
      if (!linkedPath) continue;

      const resolvedLinkedPath = path.isAbsolute(linkedPath)
        ? linkedPath
        : path.resolve(path.dirname(target), linkedPath);
      if (
        !isMaintainerOnlySkillTarget(linkedPath) &&
        !isMaintainerOnlySkillTarget(resolvedLinkedPath)
      ) {
        continue;
      }

      await fs.unlink(target);
      removed.push(entry.name);
    }

    return removed;
  } catch {
    return [];
  }
}

export async function ensureCommandResolvable(command: string, cwd: string, env: NodeJS.ProcessEnv) {
  const resolved = await resolveCommandPath(command, cwd, env);
  if (resolved) return;
  if (command.includes("/") || command.includes("\\")) {
    const absolute = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    throw new Error(`Command is not executable: "${command}" (resolved: "${absolute}")`);
  }
  throw new Error(`Command not found in PATH: "${command}"`);
}

export async function runChildProcess(
  runId: string,
  command: string,
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    timeoutSec: number;
    graceSec: number;
    onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
    onLogError?: (err: unknown, runId: string, message: string) => void;
    onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
    stdin?: string;
  },
): Promise<RunProcessResult> {
  const onLogError = opts.onLogError ?? ((err, id, msg) => console.warn({ err, runId: id }, msg));

  return new Promise<RunProcessResult>((resolve, reject) => {
    const rawMerged: NodeJS.ProcessEnv = { ...process.env, ...opts.env };

    // Strip Claude Code nesting-guard env vars so spawned `claude` processes
    // don't refuse to start with "cannot be launched inside another session".
    // These vars leak in when the Paperclip server itself is started from
    // within a Claude Code session (e.g. `npx paperclipai run` in a terminal
    // owned by Claude Code) or when cron inherits a contaminated shell env.
    const CLAUDE_CODE_NESTING_VARS = [
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_SESSION",
      "CLAUDE_CODE_PARENT_SESSION",
    ] as const;
    for (const key of CLAUDE_CODE_NESTING_VARS) {
      delete rawMerged[key];
    }

    // GEMRAL FIX 2026-04-30: Force Gemini CLI use OAuth Ultra subscription
    // (defense in depth):
    //   1. Strip API key env vars (GEMINI_API_KEY / GOOGLE_API_KEY /
    //      GOOGLE_GENAI_API_KEY) so CLI doesn't pick api-key auth.
    //   2. Set GOOGLE_GENAI_USE_GCA=true — explicit escape hatch in CLI
    //      getAuthTypeFromEnv() that forces AuthType.LOGIN_WITH_GOOGLE
    //      even if API keys somehow remain.
    // Source verified: gemini-cli bundle/chunk-IWSCP2GY.js line 278443.
    // Without this, CLI fallback to free tier API → 429 quota exceeded on
    // cloudcode-pa.googleapis.com. Affects all heartbeat agents (gemini-local
    // adapter) + chatbot router + kg-extractor + training-orchestrator.
    const GEMINI_API_KEY_VARS = [
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_GENAI_API_KEY",
    ] as const;
    for (const key of GEMINI_API_KEY_VARS) {
      delete rawMerged[key];
    }

    const mergedEnv = ensurePathInEnv(rawMerged);
    void resolveSpawnTarget(command, args, opts.cwd, mergedEnv)
      .then((target) => {
        // GEMRAL FIX 2026-04-25: When spawning .CMD/.BAT through cmd.exe wrapper,
        // resolveSpawnTarget pre-quotes the command line (executable + args) using
        // quoteForCmd. Default Node.js Windows spawn then re-escapes that quoted
        // string, producing `cmd.exe /d /s /c ""C:\path with space\gemini.CMD" ..."`
        // which cmd.exe interprets as command name `"C:\path...\gemini.CMD"` (with
        // literal quotes). Result: "is not recognized as an internal or external
        // command". Setting windowsVerbatimArguments=true tells Node to pass the
        // already-quoted command line through verbatim. Only applies to cmd.exe
        // wrapper invocations — direct .exe spawns still get default escaping.
        const isCmdShellInvocation =
          process.platform === "win32" &&
          /(?:^|[\\/])cmd\.exe$/i.test(target.command);
        const child = spawn(target.command, target.args, {
          cwd: opts.cwd,
          env: mergedEnv,
          shell: false,
          stdio: [opts.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
          // GEMRAL FIX 2026-04-06: Prevent console window popup on Windows for
          // all heartbeat/cron spawned processes (Claude CLI, Gemini CLI, etc.)
          // Per Jennie msg #1920 — "terminal đen không tự động pop-up trên màn hình"
          windowsHide: true,
          windowsVerbatimArguments: isCmdShellInvocation,
        }) as ChildProcessWithEvents;
        const startedAt = new Date().toISOString();

        if (opts.stdin != null && child.stdin) {
          child.stdin.write(opts.stdin);
          child.stdin.end();
        }

        if (typeof child.pid === "number" && child.pid > 0 && opts.onSpawn) {
          void opts.onSpawn({ pid: child.pid, startedAt }).catch((err) => {
            onLogError(err, runId, "failed to record child process metadata");
          });
        }

        runningProcesses.set(runId, { child, graceSec: opts.graceSec });

        let timedOut = false;
        let stdout = "";
        let stderr = "";
        let logChain: Promise<void> = Promise.resolve();

        const timeout =
          opts.timeoutSec > 0
            ? setTimeout(() => {
                timedOut = true;
                terminateProcessTree(child, opts.graceSec);
              }, opts.timeoutSec * 1000)
            : null;

        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: unknown) => {
          const text = String(chunk);
          stdout = appendWithCap(stdout, text);
          logChain = logChain
            .then(() => opts.onLog("stdout", text))
            .catch((err) => onLogError(err, runId, "failed to append stdout log chunk"));
        });

        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: unknown) => {
          const text = String(chunk);
          stderr = appendWithCap(stderr, text);
          logChain = logChain
            .then(() => opts.onLog("stderr", text))
            .catch((err) => onLogError(err, runId, "failed to append stderr log chunk"));
        });

        child.on("error", (err: Error) => {
          if (timeout) clearTimeout(timeout);
          runningProcesses.delete(runId);
          const errno = (err as NodeJS.ErrnoException).code;
          const pathValue = mergedEnv.PATH ?? mergedEnv.Path ?? "";
          const msg =
            errno === "ENOENT"
              ? `Failed to start command "${command}" in "${opts.cwd}". Verify adapter command, working directory, and PATH (${pathValue}).`
              : `Failed to start command "${command}" in "${opts.cwd}": ${err.message}`;
          reject(new Error(msg));
        });

        // Defense in depth: `exit` fires when the child terminates, regardless of
        // whether stdio has drained. `close` fires only after stdio drains, which
        // can stall on Windows when a child is killed externally (kill -9, OOM,
        // TaskKill) and the parent's pipe buffers aren't flushed. Clearing the
        // Map on `exit` ensures the heartbeat reaper sees the OS truth promptly
        // even if `close` is delayed; the promise itself still resolves on `close`
        // for stdout/stderr correctness.
        child.on("exit", () => {
          runningProcesses.delete(runId);
        });

        child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
          if (timeout) clearTimeout(timeout);
          runningProcesses.delete(runId);
          void logChain.finally(() => {
            resolve({
              exitCode: code,
              signal,
              timedOut,
              stdout,
              stderr,
              pid: child.pid ?? null,
              startedAt,
            });
          });
        });
      })
      .catch(reject);
  });
}
