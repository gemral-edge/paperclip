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
