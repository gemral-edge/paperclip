import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  firstNonEmptyLine,
  resolveInitialAntigravityConversationId,
} from "@paperclipai/adapter-antigravity-local/server";

describe("antigravity conversation not found root fix (GEM-2194)", () => {
  it("resolveInitialAntigravityConversationId không truyền runId giả khi tạo phiên mới", () => {
    expect(
      resolveInitialAntigravityConversationId({
        configuredConversationId: "preseeded-id",
        configuredBrainExists: false,
        canResumeSession: false,
        runtimeSessionId: "stale-brain-id",
      }),
    ).toBe("");

    expect(
      resolveInitialAntigravityConversationId({
        configuredConversationId: "preseeded-id",
        configuredBrainExists: true,
        canResumeSession: false,
        runtimeSessionId: "stale-brain-id",
      }),
    ).toBe("preseeded-id");

    expect(
      resolveInitialAntigravityConversationId({
        configuredConversationId: "",
        configuredBrainExists: false,
        canResumeSession: true,
        runtimeSessionId: "active-brain-id",
      }),
    ).toBe("active-brain-id");
  });

  it("firstNonEmptyLine bỏ qua warning conversation not found ở dòng 1 khi có lỗi thật ở dòng 2+", () => {
    const maskedStderr =
      'warning: conversation "641132dc-1111-2222-3333-444455556666" not found\n' +
      "error: Eligibility check failed: failed to fetch user info: 500 Internal Server Error\n";
    expect(firstNonEmptyLine(maskedStderr)).toBe(
      "error: Eligibility check failed: failed to fetch user info: 500 Internal Server Error",
    );

    const goawayStderr =
      'warning: conversation "70626eb4-1111-2222-3333-444455556666" not found\n' +
      "[paperclip] info: retrying\n" +
      "error: agent executor error: http2: server sent GOAWAY and closed the connection\n";
    expect(firstNonEmptyLine(goawayStderr)).toBe(
      "error: agent executor error: http2: server sent GOAWAY and closed the connection",
    );

    expect(
      firstNonEmptyLine('warning: conversation "e4517f66-4b9b-4de8-aa2a-3c1a8420c300" not found\n'),
    ).toBe('warning: conversation "e4517f66-4b9b-4de8-aa2a-3c1a8420c300" not found');

    expect(firstNonEmptyLine("  error: real error line\nsecond line")).toBe("error: real error line");
    expect(firstNonEmptyLine("   \n  \n")).toBe("");

    // GEM-2887: bỏ qua dòng trạng thái nền "root agent idle; waiting up to 24h0m0s..." để lộ lỗi thật ở dòng 2+
    const masked400 =
      "root agent idle; waiting up to 24h0m0s for 1 background task(s)\n" +
      "error: INVALID_ARGUMENT (code 400): Request contains an invalid argument.\n";
    expect(firstNonEmptyLine(masked400)).toBe(
      "error: INVALID_ARGUMENT (code 400): Request contains an invalid argument.",
    );
    const masked404 =
      "root agent idle; waiting up to 24h0m0s for 2 background task(s)\n" +
      "error: NOT_FOUND (code 404): Requested entity was not found.\n";
    expect(firstNonEmptyLine(masked404)).toBe(
      "error: NOT_FOUND (code 404): Requested entity was not found.",
    );
    expect(
      firstNonEmptyLine("root agent idle; waiting up to 24h0m0s for 1 background task(s)\n"),
    ).toBe("root agent idle; waiting up to 24h0m0s for 1 background task(s)");
  });

  it("execute.ts không còn gán conversationId = runId ở nhánh mở phiên mới / retry", () => {
    const src = readFileSync(
      resolve(__dirname, "../../..", "packages/adapters/antigravity-local/src/server/execute.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/conversationId\s*=\s*runId\b/);
    expect(src).not.toMatch(/canResumeSession\s*\?\s*runtimeSessionId\s*:\s*runId\b/);
  });
});
