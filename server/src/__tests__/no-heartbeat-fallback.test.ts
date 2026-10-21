import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Chị Jennie 22/10/2026: heartbeat agent KHÔNG được fallback (sang claude CLI hay model khác) khi
// hết quota/model lỗi — để lỗi nguyên cho chị / Gem Kỹ Sư xử. Rào chắn cơ học cho cả 2 đường đã gỡ.
const read = (rel: string) => readFileSync(resolve(__dirname, "../../..", rel), "utf8");

describe("heartbeat agent: no fallback", () => {
  it("heartbeat.ts không còn chạy lại lượt bằng claude CLI", () => {
    const src = read("server/src/services/heartbeat.ts");
    expect(src).not.toMatch(/shouldFallbackToClaude|buildClaudeFallbackConfig|mergeClaudeFallbackResult|agy-claude-fallback/);
    expect(src).not.toMatch(/getServerAdapter\(CLAUDE_ADAPTER_TYPE\)/);
  });

  it("antigravity adapter execute() chỉ chạy đúng 1 model (bỏ qua fallbackModels)", () => {
    const src = read("packages/adapters/antigravity-local/src/server/execute.ts");
    expect(src).toMatch(/const modelChain = \[model\];/);
    expect(src).not.toMatch(/resolveAntigravityModelChain\(|DEFAULT_ANTIGRAVITY_FALLBACK_MODELS/);
  });

  it("DEFAULT_ANTIGRAVITY_FALLBACK_MODELS luôn rỗng và không còn hàm dựng chuỗi dự phòng", () => {
    const idx = read("packages/adapters/antigravity-local/src/index.ts");
    expect(idx).toMatch(/DEFAULT_ANTIGRAVITY_FALLBACK_MODELS: readonly string\[\] = \[\];/);
    expect(read("packages/adapters/antigravity-local/src/server/parse.ts")).not.toMatch(/resolveAntigravityModelChain/);
  });
});
