import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ProviderTimeoutError,
  TimeoutCircuitBreaker,
  configureBreakerPersistence,
  getTimeoutBreaker,
  getTimeoutBreakerSnapshot,
  resetTimeoutBreakers,
  resolveAgyFallback,
  resolveTimeoutFallback,
  runWithTimeoutFallback,
  withApiTimeout,
} from '../channels/agy-timeout-fallback.js';

const timeout = () => new ProviderTimeoutError('antigravity', 'Antigravity', 'sales-closer');

describe('runWithTimeoutFallback', () => {
  it('agy timeout → chạy fallback ĐÚNG 1 lần và trả reply của fallback (không rỗng)', async () => {
    const primary = vi.fn().mockRejectedValue(timeout());
    const fallback = vi.fn().mockResolvedValue('Dạ em đây ạ');
    const onFallback = vi.fn();
    await expect(runWithTimeoutFallback(primary, fallback, onFallback)).resolves.toBe('Dạ em đây ạ');
    expect(primary).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('primary OK → không đụng fallback', async () => {
    const fallback = vi.fn();
    await expect(runWithTimeoutFallback(async () => 'ok', fallback)).resolves.toBe('ok');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('lỗi KHÔNG phải timeout (vd abort do khách nhắn mới) → ném nguyên, không fallback', async () => {
    const abort = new Error('agent run aborted (cancel-in-flight)');
    const fallback = vi.fn();
    await expect(runWithTimeoutFallback(() => Promise.reject(abort), fallback)).rejects.toBe(abort);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('fallback = null (tắt) → giữ hành vi cũ: ném timeout', async () => {
    const err = timeout();
    await expect(runWithTimeoutFallback(() => Promise.reject(err), null)).rejects.toBe(err);
  });

  it('fallback cũng lỗi → ném lỗi của fallback, KHÔNG thử thêm lần 3', async () => {
    const fallback = vi.fn().mockRejectedValue(new Error('claude down'));
    await expect(runWithTimeoutFallback(() => Promise.reject(timeout()), fallback)).rejects.toThrow('claude down');
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});

describe('resolveAgyFallback', () => {
  it('mặc định bật: claude + model Sonnet', () => {
    expect(resolveAgyFallback({} as NodeJS.ProcessEnv)).toEqual({ provider: 'claude', model: 'claude-sonnet-4-6' });
  });
  it('AGY_TIMEOUT_FALLBACK=off tắt hẳn', () => {
    expect(resolveAgyFallback({ AGY_TIMEOUT_FALLBACK: 'off' } as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
  it('AGY_TIMEOUT_FALLBACK_MODEL đổi được model', () => {
    expect(resolveAgyFallback({ AGY_TIMEOUT_FALLBACK_MODEL: ' claude-opus-4-8 ' } as unknown as NodeJS.ProcessEnv)?.model).toBe('claude-opus-4-8');
  });
  it('message timeout giữ nguyên định dạng cũ (log/probe grep được)', () => {
    expect(timeout().message).toBe('Antigravity CLI timed out for sales-closer');
    expect(timeout()).toBeInstanceOf(Error);
  });
});

describe('resolveTimeoutFallback (GEM-1067: claude/gemini cùng lớp lỗi với agy)', () => {
  const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
  it('claude → gemini flash (CHỈ khi LLM_GEMINI_API_FALLBACK=on); gemini → claude sonnet; agy → claude sonnet', () => {
    expect(resolveTimeoutFallback('claude', env({ LLM_GEMINI_API_FALLBACK: 'on' }))).toEqual({ provider: 'gemini', model: 'gemini-2.5-flash' });
    expect(resolveTimeoutFallback('gemini', env({}))).toEqual({ provider: 'claude', model: 'claude-sonnet-4-6' });
    expect(resolveTimeoutFallback('antigravity', env({}))).toEqual({ provider: 'claude', model: 'claude-sonnet-4-6' });
  });
  it('mỗi provider tắt/đổi model ĐỘC LẬP bằng env riêng', () => {
    expect(resolveTimeoutFallback('claude', env({ CLAUDE_TIMEOUT_FALLBACK: 'off' }))).toBeNull();
    expect(resolveTimeoutFallback('gemini', env({ CLAUDE_TIMEOUT_FALLBACK: 'off' }))).not.toBeNull();
    expect(resolveTimeoutFallback('gemini', env({ GEMINI_TIMEOUT_FALLBACK_MODEL: ' claude-opus-4-8 ' }))?.model).toBe('claude-opus-4-8');
    expect(resolveTimeoutFallback('claude', env({ LLM_GEMINI_API_FALLBACK: 'on', CLAUDE_TIMEOUT_FALLBACK_MODEL: 'gemini-2.5-pro' }))?.model).toBe('gemini-2.5-pro');
  });
  it('provider lạ → null (hành vi cũ)', () => {
    expect(resolveTimeoutFallback('whatever', env({}))).toBeNull();
  });
  it('GEM-1085: nvidia_nim/openrouter → claude sonnet, tắt/đổi model bằng env riêng', () => {
    for (const p of ['nvidia_nim', 'openrouter']) {
      expect(resolveTimeoutFallback(p, env({}))).toEqual({ provider: 'claude', model: 'claude-sonnet-4-6' });
    }
    expect(resolveTimeoutFallback('nvidia_nim', env({ NVIDIA_NIM_TIMEOUT_FALLBACK: 'off' }))).toBeNull();
    expect(resolveTimeoutFallback('openrouter', env({ NVIDIA_NIM_TIMEOUT_FALLBACK: 'off' }))).not.toBeNull();
    expect(resolveTimeoutFallback('openrouter', env({ OPENROUTER_TIMEOUT_FALLBACK_MODEL: 'claude-opus-4-8' }))?.model).toBe('claude-opus-4-8');
  });
  it('claude/gemini timeout: message giữ định dạng cũ để grep log/probe', () => {
    expect(new ProviderTimeoutError('claude', 'Claude', 'sales-closer').message).toBe('Claude CLI timed out for sales-closer');
    expect(new ProviderTimeoutError('gemini', 'Gemini', 'sales-closer').message).toBe('Gemini CLI timed out for sales-closer');
  });
});

describe('router wiring (guard chống revert)', () => {
  const src = readFileSync(fileURLToPath(new URL('../channels/router.ts', import.meta.url)), 'utf-8');
  it('dispatch claude/gemini/antigravity đều đi qua withTimeoutFallback → runWithTimeoutFallback', () => {
    const dispatch = src.slice(src.indexOf('const dispatch = async'), src.indexOf('default:\n        console.warn(`[Router] Unknown provider'));
    for (const p of ['claude', 'gemini', 'antigravity', 'nvidia_nim', 'openrouter']) {
      expect(dispatch).toMatch(new RegExp(`case '${p}':\\s*return withTimeoutFallback\\(`));
    }
    const helper = src.slice(src.indexOf('const withTimeoutFallback'), src.indexOf('const dispatch = async'));
    expect(helper).toContain('runWithTimeoutFallback(');
    expect(helper).toContain('runViaGemini(fbConfig');
    expect(helper).toContain('runViaClaude(fbConfig');
  });
  it("MỌI fallback (kể cả agy→claude) dùng phiên trắng (sessionKey '') — không resume phiên lẻ tẻ thiếu lượt, phình token", () => {
    const helper = src.slice(src.indexOf('const withTimeoutFallback'), src.indexOf('const dispatch = async'));
    expect(helper).toContain("const fbSessionKey = '';");
    expect(helper).not.toContain("config.provider === 'antigravity' ? sessionKey");
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

  it('timeout openrouter → runWithTimeoutFallback chạy fallback đúng 1 lần, khách có reply', async () => {
    const fb = vi.fn().mockResolvedValue('claude reply');
    const out = await runWithTimeoutFallback(
      () => withApiTimeout('openrouter', 'OpenRouter', 's', 20, undefined, abortErr, hang), fb);
    expect(out).toBe('claude reply');
    expect(fb).toHaveBeenCalledTimes(1);
  });

  it('abort từ signal ngoài (khách nhắn mới) → makeAbortError, KHÔNG phải timeout, KHÔNG fallback', async () => {
    const ext = new AbortController();
    const fb = vi.fn();
    const run = runWithTimeoutFallback(
      () => withApiTimeout('openrouter', 'OpenRouter', 's', 5_000, ext.signal, abortErr, hang), fb);
    setTimeout(() => ext.abort(), 10);
    await expect(run).rejects.toThrow('cancel-in-flight');
    expect(fb).not.toHaveBeenCalled();
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

describe('TimeoutCircuitBreaker (GEM-1068: agy chậm/429 → khỏi chờ 5 phút mỗi tin)', () => {
  const mk = (thr = 2, cd = 1000) => {
    let t = 0;
    const b = new TimeoutCircuitBreaker(thr, cd, () => t);
    return { b, advance: (ms: number) => { t += ms; } };
  };
  const slow = () => Promise.reject(timeout());

  it('dưới ngưỡng: vẫn chạy primary rồi fallback (hành vi GEM-1050); đủ ngưỡng: lượt kế bỏ qua primary', async () => {
    const { b } = mk(2);
    const fb = vi.fn().mockResolvedValue('claude reply');
    const primary = vi.fn().mockImplementation(slow);
    const onSkip = vi.fn();
    await runWithTimeoutFallback(primary, fb, undefined, b, onSkip); // timeout #1
    expect(b.isOpen).toBe(false);
    await runWithTimeoutFallback(primary, fb, undefined, b, onSkip); // timeout #2 → mở
    expect(b.isOpen).toBe(true);
    expect(primary).toHaveBeenCalledTimes(2);
    await expect(runWithTimeoutFallback(primary, fb, undefined, b, onSkip)).resolves.toBe('claude reply');
    expect(primary).toHaveBeenCalledTimes(2); // KHÔNG chờ primary nữa
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(fb).toHaveBeenCalledTimes(3);
  });

  it('hết cooldown → half-open: đúng 1 lượt thử primary, lượt đồng thời khác vẫn đi fallback', async () => {
    const { b, advance } = mk(1, 1000);
    const fb = vi.fn().mockResolvedValue('fb');
    await runWithTimeoutFallback(slow, fb, undefined, b); // mở
    advance(1001);
    let release!: (v: string) => void;
    const probe = vi.fn().mockImplementation(() => new Promise<string>((r) => { release = r; }));
    const p1 = runWithTimeoutFallback(probe, fb, undefined, b); // lượt thử
    const p2 = runWithTimeoutFallback(probe, fb, undefined, b); // lượt song song
    await expect(p2).resolves.toBe('fb');
    expect(probe).toHaveBeenCalledTimes(1);
    release('agy ok');
    await expect(p1).resolves.toBe('agy ok');
    expect(b.isOpen).toBe(false); // thành công → đóng mạch
  });

  it('lượt thử half-open lại timeout → mở lại cooldown mới', async () => {
    const { b, advance } = mk(1, 1000);
    const fb = vi.fn().mockResolvedValue('fb');
    await runWithTimeoutFallback(slow, fb, undefined, b);
    advance(1001);
    await runWithTimeoutFallback(slow, fb, undefined, b); // probe timeout
    const primary = vi.fn().mockResolvedValue('x');
    await runWithTimeoutFallback(primary, fb, undefined, b);
    expect(primary).not.toHaveBeenCalled(); // vẫn mở
  });

  it('lỗi KHÔNG phải timeout không tính vào ngưỡng và nhả cờ probe (không kẹt half-open)', async () => {
    const { b, advance } = mk(1, 1000);
    const fb = vi.fn().mockResolvedValue('fb');
    await runWithTimeoutFallback(slow, fb, undefined, b);
    advance(1001);
    await expect(runWithTimeoutFallback(() => Promise.reject(new Error('aborted')), fb, undefined, b)).rejects.toThrow('aborted');
    const primary = vi.fn().mockResolvedValue('ok');
    await expect(runWithTimeoutFallback(primary, fb, undefined, b)).resolves.toBe('ok'); // được thử lại
    expect(primary).toHaveBeenCalledTimes(1);
  });

  it('thành công xen kẽ reset đếm liên tiếp; threshold 0 = tắt; không có fallback = bỏ qua breaker', async () => {
    const { b } = mk(2);
    const fb = vi.fn().mockResolvedValue('fb');
    await runWithTimeoutFallback(slow, fb, undefined, b);
    await runWithTimeoutFallback(async () => 'ok', fb, undefined, b);
    await runWithTimeoutFallback(slow, fb, undefined, b);
    expect(b.isOpen).toBe(false);
    const off = new TimeoutCircuitBreaker(0, 1000);
    for (let i = 0; i < 5; i++) await runWithTimeoutFallback(slow, fb, undefined, off);
    expect(off.allowPrimary()).toBe(true);
    const err = timeout();
    const open = new TimeoutCircuitBreaker(1, 1000);
    open.recordTimeout();
    await expect(runWithTimeoutFallback(() => Promise.reject(err), null, undefined, open)).rejects.toBe(err);
  });

  it('getTimeoutBreaker: per-provider, đọc env, provider lạ → null', () => {
    resetTimeoutBreakers();
    const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
    expect(getTimeoutBreaker('whatever', env({}))).toBeNull();
    expect(getTimeoutBreaker('openrouter', env({}))).not.toBeNull(); // GEM-1085: API provider có breaker riêng
    const a = getTimeoutBreaker('antigravity', env({ AGY_BREAKER_THRESHOLD: '1', AGY_BREAKER_COOLDOWN_MS: '50' }))!;
    expect(getTimeoutBreaker('antigravity', env({}))).toBe(a); // cache
    expect(getTimeoutBreaker('claude', env({}))).not.toBe(a);
    a.recordTimeout();
    expect(a.isOpen).toBe(true);
    resetTimeoutBreakers();
  });

  it('router.ts truyền breaker vào runWithTimeoutFallback (guard chống revert)', () => {
    const src = readFileSync(fileURLToPath(new URL('../channels/router.ts', import.meta.url)), 'utf-8');
    const helper = src.slice(src.indexOf('const withTimeoutFallback'), src.indexOf('const dispatch = async'));
    expect(helper).toContain('getTimeoutBreaker(config.provider)');
  });

  it('GEM-1335 (ENG-0930-F1068-03): mạch mở + fallback lỗi (không phải abort) → thử primary 1 lần, primary sống thì trả kết quả và đóng mạch', async () => {
    const { b } = mk(1, 10000);
    const fbErr = new Error('claude CLI crash (500)');
    const fb = vi.fn().mockRejectedValue(fbErr);
    // Lần 1: primary timeout → mở mạch
    await expect(runWithTimeoutFallback(slow, fb, undefined, b)).rejects.toThrow();
    expect(b.isOpen).toBe(true);

    // Lần 2: mạch đang mở, fallback lỗi, nhưng primary đã hồi phục
    const primaryRevived = vi.fn().mockResolvedValue('agy revived reply');
    const onSkip = vi.fn();
    const res = await runWithTimeoutFallback(primaryRevived, fb, undefined, b, onSkip);
    expect(res).toBe('agy revived reply');
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(fb).toHaveBeenCalled(); // fallback đã được gọi trước
    expect(primaryRevived).toHaveBeenCalledTimes(1); // primary được thử 1 lần
    expect(b.isOpen).toBe(false); // mạch được đóng lại vì primary thành công
  });

  it('GEM-1335: mạch mở + fallback lỗi + primary cũng lỗi → ném lỗi primary, mạch vẫn mở', async () => {
    const { b } = mk(1, 10000);
    const fb = vi.fn().mockRejectedValue(new Error('claude CLI crash'));
    await expect(runWithTimeoutFallback(slow, fb, undefined, b)).rejects.toThrow();
    expect(b.isOpen).toBe(true);

    const primaryStillSlow = vi.fn().mockImplementation(slow);
    await expect(runWithTimeoutFallback(primaryStillSlow, fb, undefined, b)).rejects.toBeInstanceOf(ProviderTimeoutError);
    expect(b.isOpen).toBe(true);
    expect(primaryStillSlow).toHaveBeenCalledTimes(1);
  });

  it('GEM-1335: mạch mở + fallback bị abort (AgentAbortedError/cancel-in-flight) → ném ngay, KHÔNG thử primary', async () => {
    const { b } = mk(1, 10000);
    const fb = vi.fn().mockResolvedValue('ok');
    await runWithTimeoutFallback(slow, fb, undefined, b);
    expect(b.isOpen).toBe(true);

    const abortErr = new Error('agent run aborted (cancel-in-flight)');
    (abortErr as any).name = 'AgentAbortedError';
    const fbAborted = vi.fn().mockRejectedValue(abortErr);
    const primary = vi.fn().mockResolvedValue('should not run');

    await expect(runWithTimeoutFallback(primary, fbAborted, undefined, b)).rejects.toBe(abortErr);
    expect(primary).not.toHaveBeenCalled();
    expect(b.isOpen).toBe(true);
  });
});

describe('Breaker quan sát được + sống qua restart (GEM-1094)', () => {
  const env = (o: Record<string, string> = {}) => o as unknown as NodeJS.ProcessEnv;
  const withTmp = (fn: (file: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'breaker-'));
    const file = join(dir, 'provider-breakers.json');
    try {
      resetTimeoutBreakers();
      configureBreakerPersistence(file);
      fn(file);
    } finally {
      configureBreakerPersistence(null);
      resetTimeoutBreakers();
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('snapshot: closed → open → half_open → closed, có mốc thời gian + đích fallback', () => {
    let t = 1_000_000;
    const b = new TimeoutCircuitBreaker(1, 1000, () => t);
    expect(b.snapshot('antigravity', 'claude')).toMatchObject({ state: 'closed', openUntil: null, fallbackTo: 'claude' });
    b.recordTimeout();
    const open = b.snapshot('antigravity');
    expect(open.state).toBe('open');
    expect(open.openUntil).toBe(new Date(1_001_000).toISOString());
    expect(open.lastOpenedAt).toBe(new Date(1_000_000).toISOString());
    t += 1001;
    expect(b.snapshot('antigravity').state).toBe('half_open');
    b.recordSuccess();
    expect(b.snapshot('antigravity')).toMatchObject({ state: 'closed', consecutiveTimeouts: 0, lastClosedAt: new Date(t).toISOString() });
  });

  it('onTransition chỉ bắn khi đổi trạng thái, KHÔNG mỗi lượt', () => {
    const b = new TimeoutCircuitBreaker(2, 1000);
    const seen: string[] = [];
    b.onTransition = (to) => seen.push(to);
    b.recordTimeout(); // dưới ngưỡng
    b.recordSuccess(); // đang đóng → không phải chuyển
    b.recordTimeout();
    b.recordTimeout(); // mở
    b.recordSuccess(); // đóng
    expect(seen).toEqual(['open', 'closed']);
  });

  it('mạch mở sống qua restart: map RAM bị xoá nhưng breaker mới đọc lại file vẫn MỞ', () =>
    withTmp((file) => {
      const a = getTimeoutBreaker('antigravity', env({ AGY_BREAKER_THRESHOLD: '1' }))!;
      a.recordTimeout();
      expect(JSON.parse(readFileSync(file, 'utf8')).antigravity.consecutive).toBe(1);
      resetTimeoutBreakers(); // = restart: RAM sạch
      const after = getTimeoutBreaker('antigravity', env({ AGY_BREAKER_THRESHOLD: '1' }))!;
      expect(after).not.toBe(a);
      expect(after.allowPrimary()).toBe(false); // khách KHÔNG phải chờ 5' lại từ đầu
    }));

  it('cooldown đã hết lúc restart → bắt đầu đóng; file hỏng → đóng, không ném', () =>
    withTmp((file) => {
      writeFileSync(file, JSON.stringify({ antigravity: { consecutive: 3, openUntil: Date.now() - 1, lastOpenedAt: 1 } }));
      expect(getTimeoutBreaker('antigravity', env())!.isOpen).toBe(false);
      resetTimeoutBreakers();
      writeFileSync(file, '{not json');
      expect(getTimeoutBreaker('claude', env())!.isOpen).toBe(false);
    }));

  it('ghi file giữ entry của provider chưa được tạo lại (breaker tạo lười)', () =>
    withTmp((file) => {
      const until = Date.now() + 60_000;
      writeFileSync(file, JSON.stringify({ gemini: { consecutive: 2, openUntil: until, lastOpenedAt: 1 } }));
      getTimeoutBreaker('antigravity', env({ AGY_BREAKER_THRESHOLD: '1' }))!.recordTimeout();
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      expect(saved.gemini.openUntil).toBe(until);
      expect(saved.antigravity.consecutive).toBe(1);
    }));

  it('getTimeoutBreakerSnapshot liệt kê đủ provider có fallback, kèm đích', () => {
    resetTimeoutBreakers();
    const snap = getTimeoutBreakerSnapshot(env());
    expect(snap.map((s) => s.provider).sort()).toEqual(['antigravity', 'claude', 'gemini', 'nvidia_nim', 'openrouter']);
    expect(snap.find((s) => s.provider === 'antigravity')!.fallbackTo).toBe('claude');
    resetTimeoutBreakers();
  });
});

// 14/10: agy thoát lỗi (exit≠0/null) mà không ra reply → khách im lặng (đo log: 37/~1.090 lượt agy rỗng,
// ca thật cskh-jennie 92504a91 + zalo khách 775721998332536475). Coi như sự cố provider → đổi provider 1 lần.
import { ProviderCrashError, isAgyCrashEmpty } from '../channels/agy-timeout-fallback.js';

describe('isAgyCrashEmpty', () => {
  it('rỗng + exit 1 / 3 / null → crash', () => {
    expect(isAgyCrashEmpty('', 1, false)).toBe(true);
    expect(isAgyCrashEmpty('', 3, false)).toBe(true);
    expect(isAgyCrashEmpty('', null, false)).toBe(true);
  });
  it('rỗng + exit 0 = agent cố ý im (spam/cảm ơn) → KHÔNG đổi provider', () => {
    expect(isAgyCrashEmpty('', 0, false)).toBe(false);
  });
  it('có reply hoặc khách nhắn mới (aborted) → KHÔNG', () => {
    expect(isAgyCrashEmpty('Dạ', 1, false)).toBe(false);
    expect(isAgyCrashEmpty('', 1, true)).toBe(false);
  });
  it('ProviderCrashError đi đúng đường fallback 1 lần', async () => {
    const primary = vi.fn().mockRejectedValue(new ProviderCrashError('antigravity', 'Antigravity', 'jennie-support', 1));
    const fallback = vi.fn().mockResolvedValue('Dạ bạn ơi');
    await expect(runWithTimeoutFallback(primary, fallback)).resolves.toBe('Dạ bạn ơi');
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});
