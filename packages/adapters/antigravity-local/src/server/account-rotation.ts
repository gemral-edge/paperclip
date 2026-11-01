import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AntigravityAccountRotationResult {
  rotated: boolean;
  alreadyRotatedByPeer?: boolean;
  previousEmail?: string | null;
  newEmail?: string | null;
  label?: string | null;
  tier?: string | null;
  limitType?: "5h" | "weekly" | null;
  previousCooldownUntil?: string | null;
  earliestCooldownUntil?: string | null;
  totalAccounts: number;
  readyAccounts: number;
  reason?: string;
  exitCode: number | null;
}

export interface RotateAntigravityAccountOptions {
  failedEmail?: string | null;
  stderr?: string | null;
  runId?: string | null;
  cwd?: string;
  timeoutMs?: number;
  runner?: (
    pythonCmd: string,
    args: string[],
    timeoutMs: number,
  ) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
}

export function computeMaxAccountRotations(totalAccounts: number): number {
  if (!Number.isFinite(totalAccounts) || totalAccounts <= 1) return 0;
  return Math.max(0, Math.min(10, Math.floor(totalAccounts) - 1));
}

export function resolveAgyAccountSwitcherScript(cwd?: string): string | null {
  const envPath = process.env.AGY_ACCOUNT_SWITCHER_SCRIPT?.trim();
  if (envPath && existsSync(envPath)) return envPath;

  const candidates: string[] = [];
  if (cwd) {
    candidates.push(path.resolve(cwd, "scripts", "agy_account_switcher.py"));
  }
  candidates.push(
    path.join(
      os.homedir(),
      "Desktop",
      "Projects",
      "crypto-pattern-scanner",
      "scripts",
      "agy_account_switcher.py",
    ),
  );
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function getActiveAntigravityAccountEmail(homeDir: string = os.homedir()): string | null {
  try {
    const poolPath = path.join(homeDir, ".gemini", "agy-accounts", "pool.json");
    if (existsSync(poolPath)) {
      const parsed = JSON.parse(readFileSync(poolPath, "utf8")) as Record<string, unknown>;
      if (typeof parsed.active_email === "string" && parsed.active_email.trim().length > 0) {
        return parsed.active_email.trim().toLowerCase();
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const googleAccountsPath = path.join(homeDir, ".gemini", "google_accounts.json");
    if (existsSync(googleAccountsPath)) {
      const parsed = JSON.parse(readFileSync(googleAccountsPath, "utf8")) as Record<string, unknown>;
      if (typeof parsed.active === "string" && parsed.active.trim().length > 0) {
        return parsed.active.trim().toLowerCase();
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function getAntigravityPoolAccountCount(homeDir: string = os.homedir()): number {
  try {
    const poolPath = path.join(homeDir, ".gemini", "agy-accounts", "pool.json");
    if (existsSync(poolPath)) {
      const parsed = JSON.parse(readFileSync(poolPath, "utf8")) as Record<string, unknown>;
      if (Array.isArray(parsed.accounts)) {
        return parsed.accounts.length;
      }
    }
  } catch {
    /* ignore */
  }
  return 0;
}

function defaultPythonRunner(
  pythonCmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(pythonCmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: "1" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      resolve({ exitCode: 124, stdout, stderr: `${stderr}\nTimed out` });
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

export async function rotateAntigravityAccountOnQuota(
  opts: RotateAntigravityAccountOptions = {},
): Promise<AntigravityAccountRotationResult> {
  const scriptPath = resolveAgyAccountSwitcherScript(opts.cwd);
  if (!scriptPath && !opts.runner) {
    return {
      rotated: false,
      totalAccounts: 0,
      readyAccounts: 0,
      reason: "switcher_script_not_found",
      exitCode: 1,
    };
  }

  const args: string[] = [scriptPath ?? "agy_account_switcher.py", "rotate-on-quota", "--json"];
  if (opts.failedEmail && opts.failedEmail.trim().length > 0) {
    args.push("--failed-email", opts.failedEmail.trim());
  }
  if (opts.stderr && opts.stderr.trim().length > 0) {
    // Keep argv well below Windows 8191-char limit
    args.push("--stderr", opts.stderr.trim().slice(0, 1200));
  }
  if (opts.runId && opts.runId.trim().length > 0) {
    args.push("--run-id", opts.runId.trim());
  }

  const runner = opts.runner ?? defaultPythonRunner;
  const timeoutMs = Math.max(1000, opts.timeoutMs ?? 12_000);
  const { exitCode, stdout } = await runner("python", args, timeoutMs);

  let parsed: Record<string, unknown> = {};
  const trimmed = stdout.trim();
  if (trimmed.length > 0) {
    const lastLine = trimmed.split(/\r?\n/).reverse().find((line) => line.trim().startsWith("{")) ?? trimmed;
    try {
      const obj = JSON.parse(lastLine);
      if (typeof obj === "object" && obj !== null) {
        parsed = obj as Record<string, unknown>;
      }
    } catch {
      /* ignore malformed JSON */
    }
  }

  const rotated = exitCode === 0 && parsed.rotated === true;
  const totalAccounts = typeof parsed.total_accounts === "number" ? parsed.total_accounts : 0;
  const readyAccounts = typeof parsed.ready_accounts === "number" ? parsed.ready_accounts : 0;
  const limitType =
    parsed.limit_type === "weekly" ? "weekly" : parsed.limit_type === "5h" ? "5h" : null;

  return {
    rotated,
    alreadyRotatedByPeer: parsed.already_rotated_by_peer === true,
    previousEmail: typeof parsed.previous_email === "string" ? parsed.previous_email : null,
    newEmail: typeof parsed.new_email === "string" ? parsed.new_email : null,
    label: typeof parsed.label === "string" ? parsed.label : null,
    tier: typeof parsed.tier === "string" ? parsed.tier : null,
    limitType,
    previousCooldownUntil:
      typeof parsed.previous_cooldown_until === "string"
        ? parsed.previous_cooldown_until
        : typeof parsed.cooldown_until === "string"
          ? parsed.cooldown_until
          : null,
    earliestCooldownUntil:
      typeof parsed.earliest_cooldown_until === "string" ? parsed.earliest_cooldown_until : null,
    totalAccounts,
    readyAccounts,
    reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    exitCode,
  };
}

export async function markAntigravityAccountHealthy(
  email?: string | null,
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<void> {
  const scriptPath = resolveAgyAccountSwitcherScript(opts.cwd);
  if (!scriptPath) return;
  const args = [scriptPath, "mark-healthy", "--json"];
  if (email && email.trim().length > 0) {
    args.push("--email", email.trim());
  }
  try {
    await defaultPythonRunner("python", args, opts.timeoutMs ?? 5_000);
  } catch {
    /* best effort */
  }
}

// ── GEM-1763: model theo gói tài khoản (ULTRA-only model trên tài khoản PRO) ────────────────

export interface AntigravityPoolAccount {
  email: string;
  plan: string | null;
  status: string | null;
  cooldownUntil: string | null;
}

export function readAntigravityPoolAccounts(homeDir: string = os.homedir()): AntigravityPoolAccount[] {
  try {
    const poolPath = path.join(homeDir, ".gemini", "agy-accounts", "pool.json");
    if (!existsSync(poolPath)) return [];
    const parsed = JSON.parse(readFileSync(poolPath, "utf8")) as Record<string, unknown>;
    const raw = Array.isArray(parsed.accounts) ? parsed.accounts : [];
    return raw
      .filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null)
      .filter((a) => typeof a.email === "string" && a.email.trim().length > 0)
      .map((a) => ({
        email: String(a.email).trim().toLowerCase(),
        plan: typeof a.plan === "string" ? a.plan.trim().toLowerCase() : null,
        status: typeof a.status === "string" ? a.status : null,
        cooldownUntil: typeof a.cooldown_until === "string" ? a.cooldown_until : null,
      }));
  } catch {
    return [];
  }
}

function isPoolAccountReady(acc: AntigravityPoolAccount, nowMs: number): boolean {
  if (!acc.cooldownUntil) return acc.status !== "disabled";
  const until = Date.parse(acc.cooldownUntil);
  return !Number.isFinite(until) || until <= nowMs;
}

export function planForAntigravityAccount(
  email: string | null | undefined,
  accounts: AntigravityPoolAccount[] = readAntigravityPoolAccounts(),
): string | null {
  if (!email) return null;
  const key = email.trim().toLowerCase();
  return accounts.find((a) => a.email === key)?.plan ?? null;
}

/**
 * Tài khoản sẵn sàng đầu tiên có đúng gói `plan` (bỏ qua `excludeEmail`), cùng thời điểm hồi
 * quota sớm nhất của gói đó khi không còn tài khoản nào sẵn sàng (để hẹn chạy lại đúng giờ).
 */
export function findReadyAntigravityAccountByPlan(
  plan: string,
  opts: { excludeEmail?: string | null; now?: Date; accounts?: AntigravityPoolAccount[] } = {},
): { email: string | null; earliestCooldownUntil: string | null } {
  const accounts = opts.accounts ?? readAntigravityPoolAccounts();
  const nowMs = (opts.now ?? new Date()).getTime();
  const exclude = opts.excludeEmail?.trim().toLowerCase() ?? null;
  const samePlan = accounts.filter((a) => a.plan === plan.toLowerCase());
  const ready = samePlan.find((a) => a.email !== exclude && isPoolAccountReady(a, nowMs));
  if (ready) return { email: ready.email, earliestCooldownUntil: null };
  const cooldowns = samePlan
    .map((a) => (a.cooldownUntil ? Date.parse(a.cooldownUntil) : Number.NaN))
    .filter((ms) => Number.isFinite(ms) && ms > nowMs)
    .sort((x, y) => x - y);
  return {
    email: null,
    earliestCooldownUntil: cooldowns.length > 0 ? new Date(cooldowns[0]!).toISOString() : null,
  };
}

/** Chuyển CLI agy sang tài khoản chỉ định (giữ nguyên model) qua `agy_account_switcher.py use`. */
export async function useAntigravityAccount(
  email: string,
  opts: Pick<RotateAntigravityAccountOptions, "cwd" | "timeoutMs" | "runner"> = {},
): Promise<{ ok: boolean; exitCode: number | null }> {
  const scriptPath = resolveAgyAccountSwitcherScript(opts.cwd);
  if (!scriptPath && !opts.runner) return { ok: false, exitCode: 1 };
  const runner = opts.runner ?? defaultPythonRunner;
  const args = [scriptPath ?? "agy_account_switcher.py", "use", email, "--json"];
  const { exitCode, stdout } = await runner("python", args, Math.max(1000, opts.timeoutMs ?? 20_000));
  const ok = exitCode === 0 && /"ok"\s*:\s*true/.test(stdout);
  return { ok, exitCode };
}
