// 14/10 chị Jennie: "tắt fallback sang Gemini dự phòng luôn, ko đc gọi API. tăng thời gian chờ agy local lên".
import { describe, expect, it } from 'vitest';
import { resolveTimeoutFallback } from '../channels/agy-timeout-fallback.js';
import {
  AGY_DEFAULT_REPLY_TIMEOUT_MS,
  AGY_MIN_REPLY_TIMEOUT_MS,
  agyReplyTimeoutMs,
  childEnvWithoutGeminiApi,
  geminiApiFallbackEnabled,
} from '../channels/llm-route-policy.js';

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe('llm-route-policy (no Gemini API fallback, agy timeout)', () => {
  it('cờ mặc định TẮT', () => {
    expect(geminiApiFallbackEnabled(env({}))).toBe(false);
    expect(geminiApiFallbackEnabled(env({ LLM_GEMINI_API_FALLBACK: 'off' }))).toBe(false);
    expect(geminiApiFallbackEnabled(env({ LLM_GEMINI_API_FALLBACK: 'ON' }))).toBe(true);
  });
  it('cờ tắt ⇒ không đường reply nào rơi sang gemini', () => {
    for (const p of ['claude', 'antigravity', 'gemini', 'nvidia_nim', 'openrouter']) {
      expect(resolveTimeoutFallback(p, env({}))?.provider).not.toBe('gemini');
    }
    expect(resolveTimeoutFallback('antigravity', env({}))?.provider).toBe('claude');
  });
  it('CLI con không thừa hưởng khoá Gemini API khi cờ tắt', () => {
    const base = env({ GEMINI_API_KEY: 'k', GOOGLE_API_KEY: 'g', GOOGLE_GENAI_API_KEY: 'x', PATH: '/bin' });
    const out = childEnvWithoutGeminiApi(base, env({}));
    expect(out.GEMINI_API_KEY).toBeUndefined();
    expect(out.GOOGLE_API_KEY).toBeUndefined();
    expect(out.GOOGLE_GENAI_API_KEY).toBeUndefined();
    expect(out.PATH).toBe('/bin');
    expect(base.GEMINI_API_KEY).toBe('k'); // không sửa bản gốc
    expect(childEnvWithoutGeminiApi(base, env({ LLM_GEMINI_API_FALLBACK: 'on' })).GEMINI_API_KEY).toBe('k');
  });
  it('agy timeout mặc định 420s, sàn 300s', () => {
    expect(AGY_DEFAULT_REPLY_TIMEOUT_MS).toBe(420_000);
    expect(agyReplyTimeoutMs(env({}))).toBe(420_000);
    expect(agyReplyTimeoutMs(env({ AGY_REPLY_TIMEOUT_MS: '60000' }))).toBe(AGY_MIN_REPLY_TIMEOUT_MS);
    expect(agyReplyTimeoutMs(env({ AGY_REPLY_TIMEOUT_MS: '600000' }))).toBe(600_000);
    expect(agyReplyTimeoutMs(env({ AGY_REPLY_TIMEOUT_MS: 'abc' }))).toBe(420_000);
  });
});
