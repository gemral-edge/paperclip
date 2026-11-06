import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ProviderCrashError,
  ProviderQuotaError,
  ProviderTimeoutError,
  isAgyCrashEmpty,
  withApiTimeout,
} from '../channels/agy-timeout-fallback.js';

// 06/11/2026: fallback provider đã GỠ (luật 22/10). File này giữ test lỗi provider + wiring router;
// khoá "không fallback" nằm ở no-provider-fallback.test.ts.
const timeout = () => new ProviderTimeoutError('antigravity', 'Antigravity', 'sales-closer');

describe('ProviderTimeoutError', () => {
  it('message timeout giữ nguyên định dạng cũ (log/probe grep được)', () => {
    expect(timeout().message).toBe('Antigravity CLI timed out for sales-closer');
    expect(timeout()).toBeInstanceOf(Error);
  });
  it('claude/gemini timeout: message giữ định dạng cũ để grep log/probe', () => {
    expect(new ProviderTimeoutError('claude', 'Claude', 'sales-closer').message).toBe('Claude CLI timed out for sales-closer');
    expect(new ProviderTimeoutError('gemini', 'Gemini', 'sales-closer').message).toBe('Gemini CLI timed out for sales-closer');
  });
});

describe('router wiring (guard chống revert)', () => {
  const src = readFileSync(fileURLToPath(new URL('../channels/router.ts', import.meta.url)), 'utf-8');
  it('dispatch 5 provider gọi THẲNG runViaX — không bọc fallback/breaker (luật 22/10, gỡ 06/11)', () => {
    const dispatch = src.slice(src.indexOf('const dispatch = async'), src.indexOf('Unknown provider'));
    expect(dispatch).toMatch(/case 'claude':\s*return runViaClaude\(config,/);
    expect(dispatch).toMatch(/case 'gemini':\s*return runViaGemini\(config,/);
    expect(dispatch).toMatch(/case 'antigravity':\s*return runViaAntigravity\(config,/);
    expect(dispatch).toMatch(/case 'nvidia_nim':\s*return runViaNvidiaNim\(config,/);
    expect(dispatch).toMatch(/case 'openrouter':\s*return runViaOpenRouter\(config,/);
    expect(src).not.toMatch(/withTimeoutFallback|resolveTimeoutFallback|runWithTimeoutFallback|getTimeoutBreaker/);
  });
  it('provider lạ ⇒ ném lỗi, KHÔNG âm thầm chạy bằng Claude', () => {
    const dispatch = src.slice(src.indexOf('const dispatch = async'), src.indexOf('Unknown provider') + 400);
    expect(dispatch).toMatch(/default:[\s\S]*throw new Error\(`\[Router\] Unknown provider/);
    expect(dispatch).not.toMatch(/falling back to Claude/);
  });
  it('runViaClaude cách ly môi trường dev: không nạp settings user/project/local + chỉ MCP của agent (02/10, 235k token/lượt)', () => {
    const claude = src.slice(src.indexOf('async function runViaClaude('), src.indexOf('async function runViaGemini('));
    expect(claude).toContain("'--setting-sources=',");
    expect(claude).toContain("'--strict-mcp-config',");
    // Không được tách thành 2 đối số ('--setting-sources', '') — nhánh shell:true làm rơi chuỗi rỗng.
    expect(claude).not.toMatch(/'--setting-sources',\s*''/);
    // Timeout phải để lại dấu vết (stdout/stderr cuối) để chẩn được treo ở đâu.
    expect(claude).toContain('Claude CLI timeout ${config.slug}');
  });
  it('3 runner CLI ném ProviderTimeoutError khi quá hạn (không phải Error trần) + guard timedOut ở close', () => {
    const claude = src.slice(src.indexOf('async function runViaClaude('), src.indexOf('async function runViaGemini('));
    expect(claude).toContain("new ProviderTimeoutError('claude'");
    expect(claude).toContain('if (settled) return;');
    const gemini = src.slice(src.indexOf('async function runViaGemini('), src.indexOf('async function runViaAntigravity('));
    expect(gemini).toContain("new ProviderTimeoutError('gemini'");
    expect(gemini).toContain('if (timedOut)');
    const fn = src.slice(src.indexOf('async function runViaAntigravity('), src.indexOf('async function runViaOpenRouter('));
    expect(fn).toContain("new ProviderTimeoutError('antigravity'");
    expect(fn).toContain('if (timedOut)');
  });
  it('không còn Error trần "CLI timed out" trong router.ts', () => {
    expect(src).not.toMatch(/new Error\(`(Claude|Gemini|Antigravity) CLI timed out/);
  });
  it('GEM-1427: route /:slug/test nối res.once(close) vào AbortSignal và cả 3 CLI runner đều lắng nghe abort + killProcessTree', () => {
    const routesSrc = readFileSync(fileURLToPath(new URL('../channels/agent-config-routes.ts', import.meta.url)), 'utf-8');
    expect(routesSrc).toContain("res.once('close', onClientDisconnect);");
    expect(routesSrc).toContain("req.once('aborted', onClientDisconnect);");
    expect(routesSrc).toMatch(/AgentRouter\.runAgentWithConfig\([\s\S]{0,200}?abortController\.signal/);

    const claude = src.slice(src.indexOf('async function runViaClaude('), src.indexOf('async function runViaGemini('));
    const gemini = src.slice(src.indexOf('async function runViaGemini('), src.indexOf('async function runViaAntigravity('));
    const agy = src.slice(src.indexOf('async function runViaAntigravity('), src.indexOf('async function runViaOpenRouter('));
    for (const [name, block] of [['claude', claude], ['gemini', gemini], ['antigravity', agy]] as const) {
      expect(block, `${name} must listen to signal abort`).toContain("signal?.addEventListener('abort', onAbort, { once: true })");
      expect(block, `${name} must kill process tree on abort`).toContain('killProcessTree(child)');
      expect(block, `${name} must reject AgentAbortedError on abort`).toContain('reject(new AgentAbortedError())');
    }
  });
  it('GEM-1085: runner API đi qua withApiTimeout, KHÔNG tự setTimeout(controller.abort) trần', () => {
    const api = src.slice(src.indexOf('async function runViaOpenRouter('), src.indexOf('async function resolveMediaToBase64('));
    expect(api).toContain("withApiTimeout('openrouter'");
    const nim = src.slice(src.indexOf('async function runViaNvidiaNim('), src.indexOf('// ─── Helpers ───'));
    expect(nim).toContain("withApiTimeout('nvidia_nim'");
    expect(`${api}${nim}`).not.toMatch(/setTimeout\(\(\) => controller\.abort\(\)/);
  });
});

describe('withApiTimeout (GEM-1085: provider API timeout → ProviderTimeoutError, không AbortError trần)', () => {
  const abortErr = () => new Error('agent run aborted (cancel-in-flight)');
  // fetch giả: treo tới khi signal abort, rồi ném AbortError như fetch thật.
  const hang = (s: AbortSignal) => new Promise<string>((_, rej) => {
    s.addEventListener('abort', () => rej(new DOMException('This operation was aborted', 'AbortError')));
  });

  it('quá hạn → ProviderTimeoutError(provider) và message đúng định dạng', async () => {
    const p = withApiTimeout('openrouter', 'OpenRouter', 'sales-closer', 20, undefined, abortErr, hang);
    await expect(p).rejects.toBeInstanceOf(ProviderTimeoutError);
    await expect(withApiTimeout('nvidia_nim', 'NVIDIA NIM', 'x', 20, undefined, abortErr, hang))
      .rejects.toMatchObject({ provider: 'nvidia_nim', message: 'NVIDIA NIM CLI timed out for x' });
  });

  it('timeout openrouter → ném ProviderTimeoutError, KHÔNG có đường chạy provider khác', async () => {
    await expect(withApiTimeout('openrouter', 'OpenRouter', 's', 20, undefined, abortErr, hang))
      .rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it('abort từ signal ngoài (khách nhắn mới) → makeAbortError, KHÔNG phải timeout', async () => {
    const ext = new AbortController();
    const run = withApiTimeout('openrouter', 'OpenRouter', 's', 5_000, ext.signal, abortErr, hang);
    setTimeout(() => ext.abort(), 10);
    await expect(run).rejects.toThrow('cancel-in-flight');
  });

  it('thành công trả giá trị; lỗi khác (vd HTTP 500) ném nguyên, không bị đổi thành timeout', async () => {
    await expect(withApiTimeout('openrouter', 'O', 's', 1_000, undefined, abortErr, async () => 'ok')).resolves.toBe('ok');
    const boom = new Error('OpenRouter API error 500');
    await expect(withApiTimeout('openrouter', 'O', 's', 1_000, undefined, abortErr, async () => { throw boom; })).rejects.toBe(boom);
  });

  it('timeout cũng cắt phần đọc body (run nhận signal, treo ở res.json() vẫn bị cắt)', async () => {
    const p = withApiTimeout('nvidia_nim', 'NVIDIA NIM', 's', 20, undefined, abortErr, async (s) => {
      await Promise.resolve(); // "fetch" đã xong
      return hang(s); // đọc body treo
    });
    await expect(p).rejects.toBeInstanceOf(ProviderTimeoutError);
  });
});

describe('isAgyCrashEmpty', () => {
  it('rỗng + exit 1 / 3 / null → crash', () => {
    expect(isAgyCrashEmpty('', 1, false)).toBe(true);
    expect(isAgyCrashEmpty('', 3, false)).toBe(true);
    expect(isAgyCrashEmpty('', null, false)).toBe(true);
  });
  it('rỗng + exit 0 = agent cố ý im (spam/cảm ơn) → KHÔNG phải crash', () => {
    expect(isAgyCrashEmpty('', 0, false)).toBe(false);
  });
  it('có reply hoặc khách nhắn mới (aborted) → KHÔNG', () => {
    expect(isAgyCrashEmpty('Dạ', 1, false)).toBe(false);
    expect(isAgyCrashEmpty('', 1, true)).toBe(false);
  });
  it('ProviderCrashError / ProviderQuotaError vẫn là ProviderTimeoutError (để lỗi nguyên, không đổi provider)', () => {
    expect(new ProviderCrashError('antigravity', 'Antigravity', 'x', 1)).toBeInstanceOf(ProviderTimeoutError);
    expect(new ProviderQuotaError('antigravity', 'Antigravity', 'x')).toBeInstanceOf(ProviderTimeoutError);
  });
});
