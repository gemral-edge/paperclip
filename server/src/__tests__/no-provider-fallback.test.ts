import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FALLBACK_MAP, ProviderTimeoutError, withApiTimeout } from "../channels/agy-timeout-fallback.js";

// Chị Jennie 22/10/2026 (SSOT ~/.claude/CLAUDE.md §CẤM FALLBACK), gỡ nốt đường reply 06/11/2026:
// mọi provider timeout/quota/crash ⇒ để lỗi nguyên, KHÔNG gọi provider/model khác.
const read = (rel: string) => readFileSync(resolve(__dirname, "../../..", rel), "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("reply agent: không fallback provider/model", () => {
  it("FALLBACK_MAP rỗng", () => {
    expect(Object.keys(FALLBACK_MAP)).toEqual([]);
  });

  it("agy-timeout-fallback.ts không còn resolveTimeoutFallback/runWithTimeoutFallback/breaker/fallbackTo (ngoài comment)", () => {
    const src = stripComments(read("server/src/channels/agy-timeout-fallback.ts"));
    expect(src).not.toMatch(/resolveTimeoutFallback|resolveAgyFallback|runWithTimeoutFallback|TimeoutCircuitBreaker|getTimeoutBreaker|fallbackTo|geminiApiFallbackEnabled/);
    expect(src).not.toMatch(/_TIMEOUT_FALLBACK/);
  });

  it("router.ts, health.ts, index.ts không còn gọi breaker/fallback provider", () => {
    for (const f of ["server/src/channels/router.ts", "server/src/routes/health.ts", "server/src/index.ts"]) {
      const src = stripComments(read(f));
      expect(src, f).not.toMatch(/withTimeoutFallback|resolveTimeoutFallback|runWithTimeoutFallback|getTimeoutBreaker|configureBreakerPersistence|providerBreakers/);
    }
    expect(stripComments(read("server/src/channels/router.ts"))).not.toMatch(/fallback_models|fallbackModels/);
  });

  it.each(["claude", "gemini", "nvidia_nim", "openrouter", "antigravity"])(
    "%s timeout ⇒ ném ProviderTimeoutError, không có đường gọi provider khác",
    async (provider) => {
      let called = 0;
      await expect(
        withApiTimeout(provider, provider, "slug", 15, undefined, () => new Error("abort"), (s) => {
          called += 1;
          return new Promise<string>((_, rej) => s.addEventListener("abort", () => rej(new Error("aborted"))));
        }),
      ).rejects.toBeInstanceOf(ProviderTimeoutError);
      expect(called).toBe(1);
    },
  );

  it("kg-extractor.ts: không còn Gemini CLI fallback, không còn khoá viết thẳng (repo public), khoá đọc từ env", () => {
    const raw = read("server/src/channels/kg-extractor.ts");
    const src = stripComments(raw);
    expect(src).not.toMatch(/callGeminiCli|spawn\(\s*['"]gemini['"]/);
    expect(raw).not.toMatch(/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9]{20,}/);
    expect(src).toMatch(/process\.env\.NINEROUTER_API_KEY/);
  });

  it("training-orchestrator.ts: không còn nhánh Ollama→Gemini (callAgentViaGemini, breaker Ollama)", () => {
    const src = stripComments(read("server/src/training/training-orchestrator.ts"));
    expect(src).not.toMatch(/callAgentViaGemini|ollamaCircuitOpen|recordOllamaFailure|OLLAMA_FAILURE_/);
  });
});
