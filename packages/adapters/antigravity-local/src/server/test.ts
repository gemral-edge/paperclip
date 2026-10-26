import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  asStringArray,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  parseObject,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_ANTIGRAVITY_MODEL } from "../index.js";
import { defaultAgyCommand } from "./execute.js";
import {
  detectAntigravityAuthRequired,
  detectAntigravityQuotaExhausted,
  parseAntigravityStdout,
} from "./parse.js";
import { firstNonEmptyLine } from "./utils.js";
import {
  getActiveAntigravityAccountEmail,
  rotateAntigravityAccountOnQuota,
} from "./account-rotation.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function commandLooksLike(command: string, expected: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === expected || base === `${expected}.cmd` || base === `${expected}.exe`;
}

function summarizeProbeDetail(stdout: string, stderr: string): string | null {
  const raw = firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, defaultAgyCommand());
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "antigravity_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "antigravity_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    checks.push({
      code: "antigravity_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "antigravity_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  checks.push({
    code: "antigravity_auth_note",
    level: "info",
    message: "Antigravity (agy) uses the shared Google OAuth login under ~/.gemini.",
    hint: "If the hello probe fails with an auth error, run `agy` once interactively to complete the Google login.",
  });

  const canRunProbe =
    checks.every(
      (check) => check.code !== "antigravity_cwd_invalid" && check.code !== "antigravity_command_unresolvable",
    );
  if (canRunProbe) {
    if (!commandLooksLike(command, "agy")) {
      checks.push({
        code: "antigravity_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `agy`.",
        detail: command,
      });
    } else {
      const model = asString(config.model, DEFAULT_ANTIGRAVITY_MODEL).trim();
      const helloProbeTimeoutSec = Math.max(1, asNumber(config.helloProbeTimeoutSec, 30));
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();

      const args = ["-p", "Trả lời đúng một từ duy nhất: hello", "--dangerously-skip-permissions"];
      if (model) args.push("--model", model);
      if (extraArgs.length > 0) args.push(...extraArgs);

      const initialAccountEmail = getActiveAntigravityAccountEmail();
      let probe = await runChildProcess(
        `antigravity-envtest-${ctx.adapterType}`,
        command,
        args,
        {
          cwd,
          env,
          timeoutSec: helloProbeTimeoutSec,
          graceSec: 5,
          onLog: async () => {},
        },
      );
      let rotatedToEmail: string | null = null;
      if (detectAntigravityQuotaExhausted({ stdout: probe.stdout, stderr: probe.stderr }).exhausted) {
        const rot = await rotateAntigravityAccountOnQuota({
          failedEmail: initialAccountEmail,
          stderr: probe.stderr,
          cwd,
        });
        if (rot.rotated) {
          rotatedToEmail = rot.newEmail ?? null;
          probe = await runChildProcess(
            `antigravity-envtest-rot-${ctx.adapterType}`,
            command,
            args,
            {
              cwd,
              env,
              timeoutSec: helloProbeTimeoutSec,
              graceSec: 5,
              onLog: async () => {},
            },
          );
        }
      }
      const parsed = parseAntigravityStdout(probe.stdout);
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr);
      const authMeta = detectAntigravityAuthRequired({ stdout: probe.stdout, stderr: probe.stderr });
      const quotaMeta = detectAntigravityQuotaExhausted({ stdout: probe.stdout, stderr: probe.stderr });

      if (quotaMeta.exhausted) {
        checks.push({
          code: "antigravity_hello_probe_quota_exhausted",
          level: "warn",
          message: "Antigravity authentication is configured, but the Google AI Ultra quota is exhausted across all ready pool accounts.",
          ...(detail ? { detail } : {}),
          hint: "Wait for the Ultra quota to reset, or add another account via `python scripts/agy_account_switcher.py login-new`.",
        });
      } else if (probe.timedOut) {
        checks.push({
          code: "antigravity_hello_probe_timed_out",
          level: "warn",
          message: "Antigravity hello probe timed out.",
          hint: "Retry the probe. The agy model + MCP cold-start can be slow on first run.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsed.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "antigravity_hello_probe_passed" : "antigravity_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? rotatedToEmail
              ? `Antigravity hello probe succeeded after auto-rotating to ${rotatedToEmail}.`
              : "Antigravity hello probe succeeded."
            : "Antigravity probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
        });
      } else if (authMeta.requiresAuth) {
        checks.push({
          code: "antigravity_hello_probe_auth_required",
          level: "warn",
          message: "Antigravity CLI is installed, but Google authentication is not ready.",
          ...(detail ? { detail } : {}),
          hint: "Run `agy` once interactively to complete the Google OAuth login, then retry the probe.",
        });
      } else {
        checks.push({
          code: "antigravity_hello_probe_failed",
          level: "error",
          message: "Antigravity hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `agy -p \"Respond with hello\"` manually in this working directory to debug.",
        });
      }
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
