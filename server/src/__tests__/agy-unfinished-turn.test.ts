import { describe, expect, it } from "vitest";
import {
  countAntigravityActionCalls,
  countAntigravityMutationCalls,
  isAntigravityUnfinishedPromise,
  isAntigravityWaitPromise,
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

  it("04/11 run 0bf866b4: mốc giờ đứng sau + động từ 'thực thi'", () => {
    expect(isAntigravityUnfinishedPromise("| 13 | … |\n\n---\n\nDạ em bắt đầu thực thi Slot S1 ngay bây giờ ạ!")).toBe(true);
    expect(isAntigravityUnfinishedPromise("--- Dạ em bắt đầu thực thi chu trình theo bảng SPEC-LOCK trên ạ!")).toBe(true);
    expect(isAntigravityUnfinishedPromise("Em đã bắt đầu thực thi lúc 10:10 và xong cả 13 bước, commit abc123 ạ.")).toBe(false);
  });

  it("mã mới được thử lại ngắn như no_action", () => {
    expect(TRANSIENT_RETRY_ERROR_CODES.has("antigravity_unfinished_turn")).toBe(true);
    const base = { runId: "2f7855e4", issueId: null, fromTimer: true, now: new Date("2026-10-21T22:50:00Z"), random: () => 0 };
    const plan = planQuotaRetry({ ...base, errorCode: "antigravity_unfinished_turn", priorAttempts: 0 });
    expect(plan).not.toBeNull();
    expect(new Date(plan!.retryAt).getTime() - base.now.getTime()).toBe(10 * 60_000);
  });
});

// GEM-2381 — agent ĐÃ sửa file rồi đẩy lệnh kiểm tra ra nền, kết thúc lượt bằng câu tiến độ.
// agy -p không gọi lại model khi lệnh xong → mất phần build/đối chiếu/báo cáo, run vẫn "succeeded".
describe("antigravity_unfinished_turn — câu chờ lệnh nền (GEM-2381)", () => {
  it("17/11 run d0a25d20 (mất báo cáo S3) + 16/11 run 268a25e0", () => {
    expect(isAntigravityWaitPromise(
      "Đang chạy bộ kiểm tra tổng hợp (ESLint, i18n, hardcoded-text ratchet, grid/hooks audit và Vitest S3) cho 3 trang Web Admin; em sẽ xử lý bước build và đối chiếu ngay khi lệnh hoàn tất ạ.",
    )).toBe(true);
    expect(isAntigravityWaitPromise(
      "Đang chạy lại kiểm tra AST, ESLint, i18n và bộ kiểm thử hồi quy Vitest sau khi sửa xong cụm S1 ạ.",
    )).toBe(true);
    expect(isAntigravityWaitPromise("Running the full test suite now.")).toBe(true);
    expect(isAntigravityWaitPromise("I'll compare the output once the build finishes.")).toBe(true);
  });

  it("báo cáo xong việc (kể cả có đẩy nền) KHÔNG bị bắt", () => {
    // Đuôi báo cáo thật của 2 lượt thành công cùng agent (17/11 S1, S2) và lượt bị reap nhưng báo đủ.
    expect(isAntigravityWaitPromise(
      "- **Hồ sơ và đẩy mã nguồn:** Em đã đăng ký mã cải tiến `UX-1117-S2-01-5c38ef` (`done`), commit (`aef1fcc5b7`), khởi chạy đẩy 6 commit qua `push_via_worktree.py`.\n\n**Đề xuất bước tiếp theo:** ở ca S3 kế tiếp em sẽ rà soát cụm màn hình Admin ạ.",
    )).toBe(false);
    expect(isAntigravityWaitPromise(
      "Em đã phát hiện `.git/index.lock` chỉ là khóa tạm thời nên đã khởi chạy lại bước commit báo cáo kèm `--wait` ạ.",
    )).toBe(false);
    expect(isAntigravityWaitPromise("Em đang chạy rất ổn.\n\n✅ Đã xong 3 file, commit abc123 ạ.")).toBe(false);
    expect(isAntigravityWaitPromise("Em xin phép thoát sạch phiên heartbeat này ạ!")).toBe(false);
    expect(isAntigravityWaitPromise("Dừng khi lệnh chưa chạy là đúng thiết kế, kết quả đã ghi ở trên ạ.")).toBe(false);
    expect(isAntigravityWaitPromise("")).toBe(false);
    expect(isAntigravityWaitPromise(null)).toBe(false);
  });
});
