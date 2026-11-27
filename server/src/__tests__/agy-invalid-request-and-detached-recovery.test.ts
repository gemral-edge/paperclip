import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { detectAntigravityInvalidRequest } from "@paperclipai/adapter-antigravity-local/server";
import {
  DETACHED_AGY_HARD_STALE_MS,
  DETACHED_AGY_IDLE_AFTER_ANSWER_MS,
  decideDetachedAntigravityReap,
  isTransientDbInfraError,
} from "../services/heartbeat.js";

describe("detectAntigravityInvalidRequest (GEM-2887)", () => {
  it("chiều 1: bắt HTTP 400 chung (13250442) và HTTP 404 chung (0cd3d78c)", () => {
    const err400 = [
      "root agent idle; waiting up to 24h0m0s for 1 background task(s)",
      "error: INVALID_ARGUMENT (code 400): Request contains an invalid argument. (response may be truncated)",
      'AGY_ERROR: {"short_error":"INVALID_ARGUMENT (code 400): Request contains an invalid argument.","status":"INVALID_ARGUMENT","error_code":400,"code_kind":"http","retryable":false}',
    ].join("\n");
    const err404 = [
      "root agent idle; waiting up to 24h0m0s for 1 background task(s)",
      "error: NOT_FOUND (code 404): Requested entity was not found. (response may be truncated)",
    ].join("\n");
    expect(detectAntigravityInvalidRequest({ stderr: err400 }).invalidRequest).toBe(true);
    expect(detectAntigravityInvalidRequest({ stderr: err404 }).invalidRequest).toBe(true);
  });

  it("chiều 2: loại trừ lỗi schema tĩnh (6ced528f) và lỗi auth/quota/[paperclip]", () => {
    const staticSchema =
      "error: INVALID_ARGUMENT (code 400): * GenerateContentRequest.tools[20].function_declarations[0].parameters.properties[component].enum[3]: cannot be empty";
    expect(detectAntigravityInvalidRequest({ stderr: staticSchema }).invalidRequest).toBe(false);
    for (const stderr of [
      "error: RESOURCE_EXHAUSTED (code 429)",
      "error: Eligibility check failed: 401 Unauthorized",
      "error: This service has been disabled in this account for violation of Terms of Service.",
      "[paperclip] error: INVALID_ARGUMENT (code 400): Request contains an invalid argument.",
      "",
    ]) {
      expect(detectAntigravityInvalidRequest({ stderr }).invalidRequest).toBe(false);
    }
    expect(detectAntigravityInvalidRequest({ stderr: null }).invalidRequest).toBe(false);
  });
});

describe("decideDetachedAntigravityReap (GEM-2887)", () => {
  const T0 = Date.parse("2026-11-27T06:00:00.000Z");

  it("giữ nguyên nếu mới detached < 30 phút hoặc adapter khác", () => {
    expect(
      decideDetachedAntigravityReap({
        adapterType: "antigravity_local",
        detachedAtMs: T0,
        nowMs: T0 + 15 * 60_000,
        transcriptFound: true,
        lastEntryKind: "assistant",
        lastActivityMs: T0 - 5 * 60_000,
        reply: "Đã xong ạ.",
      }),
    ).toEqual({ action: "keep" });

    expect(
      decideDetachedAntigravityReap({
        adapterType: "claude_local",
        detachedAtMs: T0,
        nowMs: T0 + 120 * 60_000,
        transcriptFound: false,
        lastEntryKind: null,
        lastActivityMs: null,
        reply: "",
      }),
    ).toEqual({ action: "keep" });
  });

  it("giữ nguyên nếu transcript vừa có hoạt động 2 phút trước", () => {
    const nowMs = T0 + DETACHED_AGY_IDLE_AFTER_ANSWER_MS + 5 * 60_000;
    expect(
      decideDetachedAntigravityReap({
        adapterType: "antigravity_local",
        detachedAtMs: T0,
        nowMs,
        transcriptFound: true,
        lastEntryKind: "assistant",
        lastActivityMs: nowMs - 2 * 60_000,
        reply: "Đã xong ạ.",
      }),
    ).toEqual({ action: "keep" });
  });

  it("reap_succeeded khi đã trả lời thật và im >= 30 phút", () => {
    const nowMs = T0 + DETACHED_AGY_IDLE_AFTER_ANSWER_MS;
    expect(
      decideDetachedAntigravityReap({
        adapterType: "antigravity_local",
        detachedAtMs: T0,
        nowMs,
        transcriptFound: true,
        lastEntryKind: "assistant",
        lastActivityMs: T0,
        reply: "Hoàn tất kiểm tra rồi ạ.",
      }),
    ).toEqual({ action: "reap_succeeded", reply: "Hoàn tất kiểm tra rồi ạ." });
  });

  it("reap_unfinished khi câu cuối là hứa chờ lệnh nền và im >= 30 phút", () => {
    const nowMs = T0 + DETACHED_AGY_IDLE_AFTER_ANSWER_MS;
    const waitReply = "Đang chạy bộ kiểm tra, em sẽ xử lý khi lệnh hoàn tất ạ.";
    expect(
      decideDetachedAntigravityReap({
        adapterType: "antigravity_local",
        detachedAtMs: T0,
        nowMs,
        transcriptFound: true,
        lastEntryKind: "assistant",
        lastActivityMs: T0,
        reply: waitReply,
      }),
    ).toEqual({ action: "reap_unfinished", reply: waitReply });
  });

  it("reap_stale khi im >= 60 phút mà không có transcript hoặc kẹt ở tool_call", () => {
    const nowMs = T0 + DETACHED_AGY_HARD_STALE_MS;
    expect(
      decideDetachedAntigravityReap({
        adapterType: "antigravity_local",
        detachedAtMs: T0,
        nowMs,
        transcriptFound: false,
        lastEntryKind: null,
        lastActivityMs: null,
        reply: "",
      }).action,
    ).toBe("reap_stale");

    expect(
      decideDetachedAntigravityReap({
        adapterType: "antigravity_local",
        detachedAtMs: T0,
        nowMs,
        transcriptFound: true,
        lastEntryKind: "tool_call",
        lastActivityMs: T0,
        reply: "",
      }).action,
    ).toBe("reap_stale");
  });
});

describe("isTransientDbInfraError & source wiring (GEM-2887)", () => {
  it("bắt CONNECT_TIMEOUT (f52f77bb), CONNECTION_ENDED, EAI_AGAIN, 25006 và bỏ qua lỗi thường", () => {
    expect(isTransientDbInfraError("write CONNECT_TIMEOUT aws-1-ap-southeast-1.pooler.supabase.com:6543")).toBe(true);
    expect(isTransientDbInfraError("CONNECTION_ENDED")).toBe(true);
    expect(isTransientDbInfraError("getaddrinfo EAI_AGAIN pooler.supabase.com")).toBe(true);
    expect(isTransientDbInfraError("cannot execute UPDATE in a read-only transaction (SQLSTATE 25006)")).toBe(true);
    expect(isTransientDbInfraError("TypeError: Cannot read properties of undefined")).toBe(false);
  });

  it("execute.ts & heartbeat.ts giữ đủ wiring GEM-2887", () => {
    const execSrc = readFileSync(
      resolve(__dirname, "../../..", "packages/adapters/antigravity-local/src/server/execute.ts"),
      "utf8",
    );
    const hbSrc = readFileSync(resolve(__dirname, "../services/heartbeat.ts"), "utf8");
    expect(execSrc).toMatch(/errorCode = "antigravity_invalid_request";[\s\S]{0,250}clearSession = true;/);
    expect(hbSrc).toMatch(/decideDetachedAntigravityReap\(/);
    expect(hbSrc).toMatch(/killProcessTree\(run\.processPid/);
    expect(hbSrc).toMatch(/isTransientDbInfraError\(message\)/);
  });
});
