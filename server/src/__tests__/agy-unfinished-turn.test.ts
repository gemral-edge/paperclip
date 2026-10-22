import { describe, expect, it } from "vitest";
import {
  countAntigravityActionCalls,
  countAntigravityMutationCalls,
  isAntigravityUnfinishedPromise,
} from "@paperclipai/adapter-antigravity-local/server";
import { planQuotaRetry, TRANSIENT_RETRY_ERROR_CODES } from "../services/quota-retry.js";

// GEM-1307 tái phát 22/10 — run 2f7855e4 (Kiểm Định UX, 05:50): read_file ×24,
// run_command ×23 (grep / Test-Path / eslint — chỉ đo), manage_task ×9 status;
// reply ends "Bây giờ em tiến hành tự sửa từng file…" → status succeeded, 0 file ghi.
const tc = (name: string) => ({ agyKind: "tool_call" as const, name, input: {} });
const run2f7855e4 = [
  ...Array.from({ length: 24 }, () => tc("read_file")),
  ...Array.from({ length: 23 }, () => tc("run_command")),
  ...Array.from({ length: 9 }, () => tc("manage_task")),
];
const reply2f7855e4 =
  "## 🔒 Bảng Giao Kèo Số (SPEC-LOCK)\n\n| # | Ràng Buộc |\n|---|---|\n| 1 | … |\n\n---\n\n" +
  "Bây giờ em tiến hành tự sửa từng file trong danh sách giao kèo ạ.\n";

describe("antigravity_unfinished_turn", () => {
  it("run 2f7855e4: lọt no_action (có run_command) nhưng bị bắt bởi nhánh mới", () => {
    expect(countAntigravityActionCalls(run2f7855e4)).toBeGreaterThan(0);
    expect(countAntigravityMutationCalls(run2f7855e4)).toBe(0);
    expect(isAntigravityUnfinishedPromise(reply2f7855e4)).toBe(true);
  });

  it("read_file là tool chỉ-đọc (agy ≥1.4)", () => {
    expect(countAntigravityActionCalls([tc("read_file"), tc("view_file")])).toBe(0);
  });

  it("có tool ghi file / MCP → không phải lượt bỏ dở", () => {
    for (const n of ["write_file", "write_to_file", "replace_file_content", "edit_file", "call_mcp_tool", "mcp_supabase_execute_sql"]) {
      expect(countAntigravityMutationCalls([tc(n)])).toBe(1);
    }
    expect(countAntigravityMutationCalls([tc("run_command"), tc("read_file"), tc("schedule")])).toBe(0);
  });

  it("câu hứa chỉ tính ở đoạn CUỐI — kế hoạch giữa bài rồi báo xong thì không bắt", () => {
    expect(
      isAntigravityUnfinishedPromise("Bây giờ em tiến hành sửa 3 file.\n\n✅ Đã sửa xong 3 file, commit abc123 ạ."),
    ).toBe(false);
    expect(isAntigravityUnfinishedPromise("Em xin phép thoát sạch phiên heartbeat này ạ!")).toBe(false);
    expect(isAntigravityUnfinishedPromise("")).toBe(false);
    expect(isAntigravityUnfinishedPromise(null)).toBe(false);
  });

  it("nhận diện câu hứa tiếng Việt + tiếng Anh", () => {
    expect(isAntigravityUnfinishedPromise("Tiếp theo em sẽ bắt đầu chạy Pha 1 ạ.")).toBe(true);
    expect(isAntigravityUnfinishedPromise("Now I'll proceed to fix each file.")).toBe(true);
    expect(isAntigravityUnfinishedPromise("Let me start with the first file.")).toBe(true);
  });

  it("mã mới được thử lại ngắn như no_action", () => {
    expect(TRANSIENT_RETRY_ERROR_CODES.has("antigravity_unfinished_turn")).toBe(true);
    const base = { runId: "2f7855e4", issueId: null, fromTimer: true, now: new Date("2026-10-21T22:50:00Z"), random: () => 0 };
    const plan = planQuotaRetry({ ...base, errorCode: "antigravity_unfinished_turn", priorAttempts: 0 });
    expect(plan).not.toBeNull();
    expect(new Date(plan!.retryAt).getTime() - base.now.getTime()).toBe(10 * 60_000);
  });
});
