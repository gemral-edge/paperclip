import { describe, expect, it } from "vitest";
import {
  buildClaudeFallbackConfig,
  mergeClaudeFallbackResult,
  shouldFallbackToClaude,
} from "../services/agy-claude-fallback.js";

// GEM-1244 — stderr thật run 96a201f4 / cec751c0 (05/10 12:53-13:04).
const CREDITS_STDERR = "error: Your AI credits balance is too low to continue.";
const credits = {
  errorCode: "antigravity_quota_exhausted",
  errorMessage: CREDITS_STDERR,
  resultJson: { stderr: CREDITS_STDERR, modelsTried: ["Gemini 3.8 Flash (High)", "Claude Sonnet 4.6 (Thinking)"] },
};
const base = { adapterType: "antigravity_local", config: {}, env: {} as NodeJS.ProcessEnv };

describe("shouldFallbackToClaude — kích hoạt", () => {
  it("agy hết credits mọi model → claude CLI", () => {
    expect(shouldFallbackToClaude({ ...base, result: credits })).toBe(true);
  });
  it("nhánh timedOut-quota (chỉ có errorMessage RESOURCE_EXHAUSTED, không resultJson)", () => {
    const result = { errorCode: "antigravity_quota_exhausted", errorMessage: "error: RESOURCE_EXHAUSTED (code 429)" };
    expect(shouldFallbackToClaude({ ...base, result })).toBe(true);
  });
});

describe("shouldFallbackToClaude — KHÔNG kích hoạt", () => {
  it("lỗi khác (transient disconnect, auth, empty reply)", () => {
    for (const errorCode of ["antigravity_transient_disconnect", "antigravity_auth_required", "antigravity_empty_reply", null]) {
      expect(shouldFallbackToClaude({ ...base, result: { ...credits, errorCode } })).toBe(false);
    }
  });
  it("quota nhưng không có chữ credits/RESOURCE_EXHAUSTED trên stderr", () => {
    const result = { errorCode: "antigravity_quota_exhausted", errorMessage: "Antigravity Ultra quota exhausted.", resultJson: { stderr: "", stdout: CREDITS_STDERR } };
    expect(shouldFallbackToClaude({ ...base, result })).toBe(false);
  });
  it("adapter không phải agy", () => {
    expect(shouldFallbackToClaude({ ...base, adapterType: "claude_local", result: credits })).toBe(false);
    expect(shouldFallbackToClaude({ ...base, adapterType: "gemini_local", result: credits })).toBe(false);
  });
  it("agent opt-out claudeFallback:false (cần tool riêng agy)", () => {
    expect(shouldFallbackToClaude({ ...base, config: { claudeFallback: false }, result: credits })).toBe(false);
  });
  it("tắt toàn cục bằng env + run đã bị huỷ", () => {
    expect(shouldFallbackToClaude({ ...base, env: { AGY_HEARTBEAT_CLAUDE_FALLBACK: "off" }, result: credits })).toBe(false);
    expect(shouldFallbackToClaude({ ...base, cancelled: true, result: credits })).toBe(false);
  });
});

describe("buildClaudeFallbackConfig", () => {
  const agy = {
    cwd: "C:/proj",
    instructionsFilePath: "C:/proj/agents/x/AGENTS.md",
    instructionsBundleMode: "external",
    promptTemplate: "p",
    timeoutSec: 900,
    model: "Gemini 3.8 Flash (High)",
    printTimeout: "24h",
    fallbackModels: ["Claude Sonnet 4.6 (Thinking)"],
    conversationId: "abc",
    extraArgs: ["--x"],
    effort: "high",
  };
  it("giữ cwd + instructionsFilePath, bỏ khoá riêng agy, model claude", () => {
    const out = buildClaudeFallbackConfig(agy, {});
    expect(out).toMatchObject({ cwd: "C:/proj", instructionsFilePath: agy.instructionsFilePath, promptTemplate: "p", timeoutSec: 900, model: "sonnet", dangerouslySkipPermissions: true });
    for (const k of ["printTimeout", "fallbackModels", "conversationId", "extraArgs", "effort"]) expect(out).not.toHaveProperty(k);
  });
  it("model đổi được qua env", () => {
    expect(buildClaudeFallbackConfig(agy, { AGY_HEARTBEAT_CLAUDE_FALLBACK_MODEL: "opus" }).model).toBe("opus");
  });
});

describe("mergeClaudeFallbackResult", () => {
  const agyResult = {
    exitCode: 1, signal: null, timedOut: false, ...credits,
    sessionId: "brain-1", sessionParams: { sessionId: "brain-1", cwd: "C:/proj" }, sessionDisplayId: "brain-1",
  };
  it("claude ok → kết quả claude, giữ phiên agy, ghi adapter thực dùng", () => {
    const claude = { exitCode: 0, signal: null, timedOut: false, sessionId: "claude-s", sessionParams: { sessionId: "claude-s" }, summary: "xong", resultJson: { summary: "xong" } };
    const m = mergeClaudeFallbackResult(agyResult, claude, "sonnet");
    expect(m.exitCode).toBe(0);
    expect(m.errorCode).toBeUndefined();
    expect(m.sessionId).toBe("brain-1");
    expect(m.sessionParams).toEqual(agyResult.sessionParams);
    expect(m.resultJson).toMatchObject({ adapterUsed: "claude_local", adapterPrimary: "antigravity_local", claudeFallbackModel: "sonnet", summary: "xong" });
    expect(m.resultJson?.agyModelsTried).toEqual(credits.resultJson.modelsTried);
  });
  it("claude fail → giữ kết quả quota agy (quota-retry vẫn hẹn) + ghi lỗi claude", () => {
    const claude = { exitCode: 1, signal: null, timedOut: false, errorCode: "claude_weekly_limit", errorMessage: "limit" };
    const m = mergeClaudeFallbackResult(agyResult, claude, "sonnet");
    expect(m.errorCode).toBe("antigravity_quota_exhausted");
    expect(m.resultJson).toMatchObject({ adapterUsed: "antigravity_local", claudeFallback: { attempted: true, errorCode: "claude_weekly_limit" } });
  });
});
