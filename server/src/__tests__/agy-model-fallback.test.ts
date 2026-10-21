// GEM-1241: agy hết credits/quota ở model chính → chạy lại bằng model dự phòng; stderr sạch → giữ model chính.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ANTIGRAVITY_FALLBACK_MODELS,
  resolveAntigravityModelChain,
  shouldAntigravityFallback,
} from '@paperclipai/adapter-antigravity-local/server';

const CREDITS_STDERR = 'error: Your AI credits balance is too low to continue.';
const QUOTA_STDERR = 'error: RESOURCE_EXHAUSTED (code 429): quota exceeded';

/** Mô phỏng vòng chọn model của execute.ts: đi hết chuỗi tới khi stderr không còn đòi dự phòng. */
function pickModel(chain: string[], stderrByModel: Record<string, string>): { used: string; tried: string[] } {
  const tried: string[] = [];
  for (let i = 0; ; i++) {
    const m = chain[i];
    tried.push(m);
    const next = chain[i + 1];
    if (!next || !shouldAntigravityFallback({ stderr: stderrByModel[m] ?? '' })) return { used: m, tried };
  }
}

describe('agy model fallback (GEM-1241)', () => {
  const chain = resolveAntigravityModelChain('Gemini 3.8 Flash (High)', undefined, DEFAULT_ANTIGRAVITY_FALLBACK_MODELS);

  it('model Gemini mặc định có dự phòng Claude Sonnet 4.6 (Thinking)', () => {
    expect(chain).toEqual(['Gemini 3.8 Flash (High)', 'Claude Sonnet 4.6 (Thinking)']);
  });

  it('stderr hết credits → dùng model dự phòng', () => {
    const r = pickModel(chain, { 'Gemini 3.8 Flash (High)': CREDITS_STDERR });
    expect(r.used).toBe('Claude Sonnet 4.6 (Thinking)');
    expect(r.tried).toEqual(chain);
  });

  it('stderr RESOURCE_EXHAUSTED → dùng model dự phòng', () => {
    expect(pickModel(chain, { 'Gemini 3.8 Flash (High)': QUOTA_STDERR }).used).toBe('Claude Sonnet 4.6 (Thinking)');
  });

  it('stderr sạch → giữ model chính (tự quay về khi Gemini hồi)', () => {
    const r = pickModel(chain, { 'Gemini 3.8 Flash (High)': '' });
    expect(r).toEqual({ used: 'Gemini 3.8 Flash (High)', tried: ['Gemini 3.8 Flash (High)'] });
  });

  it('lỗi đăng nhập kèm chữ quota → KHÔNG đổi model (đổi model không chữa được auth)', () => {
    expect(shouldAntigravityFallback({ stderr: 'error: not logged in — quota unknown' })).toBe(false);
  });

  it('chữ "quota" trong stdout (lời agent) không kích dự phòng', () => {
    expect(shouldAntigravityFallback({ stdout: 'quota target caps 45s', stderr: '' })).toBe(false);
  });

  it('fallbackModels: [] tắt; chuỗi phẩy được tách; model chính Claude không tự thêm dự phòng', () => {
    expect(resolveAntigravityModelChain('Gemini 3.1 Pro (High)', [], DEFAULT_ANTIGRAVITY_FALLBACK_MODELS)).toEqual(['Gemini 3.1 Pro (High)']);
    expect(resolveAntigravityModelChain('Gemini 3.1 Pro (High)', 'Gemini 3.8 Flash (High), Claude Sonnet 4.6 (Thinking)', DEFAULT_ANTIGRAVITY_FALLBACK_MODELS))
      .toEqual(['Gemini 3.1 Pro (High)', 'Gemini 3.8 Flash (High)', 'Claude Sonnet 4.6 (Thinking)']);
    expect(resolveAntigravityModelChain('Claude Sonnet 4.6 (Thinking)', undefined, DEFAULT_ANTIGRAVITY_FALLBACK_MODELS)).toEqual(['Claude Sonnet 4.6 (Thinking)']);
  });
});

// GEM-1241 (12:28 đo thật): tín dụng agy là quỹ chung — Claude trong agy cũng cạn. Hết chuỗi model
// → ProviderQuotaError → đổi hẳn provider (claude CLI) qua runWithTimeoutFallback; lỗi thường thì không.
import { ProviderQuotaError, ProviderTimeoutError, runWithTimeoutFallback } from '../channels/agy-timeout-fallback.js';

describe('agy hết credits mọi model → đổi provider (GEM-1241)', () => {
  it('ProviderQuotaError kích fallback provider khác', async () => {
    const out = await runWithTimeoutFallback(
      () => Promise.reject(new ProviderQuotaError('antigravity', 'Antigravity', 'gem-master')),
      async () => 'claude-reply',
    );
    expect(out).toBe('claude-reply');
    expect(new ProviderQuotaError('antigravity', 'Antigravity', 'x')).toBeInstanceOf(ProviderTimeoutError);
  });

  it('lỗi thường (không phải quota/timeout) KHÔNG đổi provider', async () => {
    await expect(runWithTimeoutFallback(
      () => Promise.reject(new Error('exit 1')),
      async () => 'claude-reply',
    )).rejects.toThrow('exit 1');
  });
});
