// CLI timeout → fallback 1 lần sang provider khác: agy→claude (GEM-1050, ENG-0929-F1037-01),
// claude→gemini · gemini→claude (GEM-1067, ENG-0930-F1050-01), nvidia_nim/openrouter→claude (GEM-1085). (Tên file giữ nguyên để không vỡ import/test.)
//
// Gốc: runViaAntigravity quá AGENT_TIMEOUT_MS (5') → reject → runAgentWithConfig nuốt lỗi → '' →
// khách không nhận được gì (sales-closer, homyhue 28/09). Rút prompt 710k→178k chưa đủ: agy còn
// chậm/429 khi nhiều agent dồn cùng 1 model. Retry lại CHÍNH provider đó với cùng prompt to là vô ích
// (thêm 5' cho khách chờ) → đổi sang provider độc lập quota. claude/gemini có cùng lỗi (reject Error trần).
//
// Chỉ bắt ProviderTimeoutError — lỗi khác (abort do khách nhắn mới, exit≠0…) giữ nguyên hành vi cũ.
// Fallback gọi thẳng runViaX (KHÔNG qua dispatch) ⇒ tối đa 1 bước nhảy, không vòng claude⇄gemini.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { geminiApiFallbackEnabled } from './llm-route-policy.js';

export class ProviderTimeoutError extends Error {
  readonly provider: string;
  constructor(provider: string, label: string, slug: string) {
    super(`${label} CLI timed out for ${slug}`);
    this.name = 'ProviderTimeoutError';
    this.provider = provider;
  }
}

/**
 * Provider cạn tín dụng/quota ở MỌI model của nó (vd agy: Gemini → Claude trong agy đều "credits balance
 * is too low" — tín dụng Antigravity là 1 quỹ chung, đo 05/10 12:28). Kế thừa ProviderTimeoutError để đi
 * đúng đường đổi provider + circuit-breaker sẵn có (agy → claude CLI, quỹ độc lập). GEM-1241.
 */
export class ProviderQuotaError extends ProviderTimeoutError {
  constructor(provider: string, label: string, slug: string) {
    super(provider, label, slug);
    this.message = `${label} credits/quota exhausted on every model for ${slug}`;
    this.name = 'ProviderQuotaError';
  }
}

/**
 * Provider CLI thoát lỗi (exit≠0 hoặc bị giết) mà không ra reply nào — khách sẽ bị im lặng. Đi cùng đường
 * đổi provider 1 lần như timeout (14/10: đo log 37/~1.090 lượt agy rỗng, phần lớn exit 1/3).
 */
export class ProviderCrashError extends ProviderTimeoutError {
  constructor(provider: string, label: string, slug: string, code: number | null) {
    super(provider, label, slug);
    this.message = `${label} CLI exited ${code} with no reply for ${slug}`;
    this.name = 'ProviderCrashError';
  }
}

/** Rỗng + exit 0 = agent cố ý im (spam, "ok", thả tim) → giữ im. Rỗng + exit≠0/null = sự cố → đổi provider. */
export function isAgyCrashEmpty(reply: string, code: number | null, aborted: boolean): boolean {
  return !reply && code !== 0 && !aborted;
}

export interface TimeoutFallback {
  provider: 'claude' | 'gemini';
  model: string;
}
export type AgyFallback = TimeoutFallback;

/**
 * Provider API (fetch) quá hạn: `controller.abort()` chỉ ném DOMException AbortError trần — không phân biệt được
 * với abort do khách nhắn mới, nên runWithTimeoutFallback không thể bắt. Bọc cả fetch + đọc body trong 1 hàm:
 * hết hạn ⇒ ProviderTimeoutError (kích hoạt fallback/breaker); abort từ `signal` ngoài ⇒ `makeAbortError()`
 * (AgentAbortedError của router — truyền vào để khỏi import vòng). GEM-1085 (ENG-0930-F1067-01).
 */
export async function withApiTimeout<T>(
  provider: string,
  label: string,
  slug: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  makeAbortError: () => Error,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await run(controller.signal);
  } catch (err) {
    if (signal?.aborted) throw makeAbortError(); // khách nhắn mới thắng: không phải lỗi provider
    if (timedOut) throw new ProviderTimeoutError(provider, label, slug);
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Provider chính → (provider đích mặc định, model đích mặc định, tiền tố biến môi trường). */
const FALLBACK_MAP = {
  antigravity: { provider: 'claude', model: 'claude-sonnet-4-6', envPrefix: 'AGY' },
  claude: { provider: 'gemini', model: 'gemini-2.5-flash', envPrefix: 'CLAUDE' },
  gemini: { provider: 'claude', model: 'claude-sonnet-4-6', envPrefix: 'GEMINI' },
  // API provider (GEM-1085): timeout 5' → claude CLI (quota độc lập với OpenRouter/NIM).
  nvidia_nim: { provider: 'claude', model: 'claude-sonnet-4-6', envPrefix: 'NVIDIA_NIM' },
  openrouter: { provider: 'claude', model: 'claude-sonnet-4-6', envPrefix: 'OPENROUTER' },
} as const;

/**
 * `<AGY|CLAUDE|GEMINI>_TIMEOUT_FALLBACK` = `on` (mặc định) | `off`; `<…>_TIMEOUT_FALLBACK_MODEL` đổi model đích.
 * Trả null khi tắt hoặc provider không có trong FALLBACK_MAP → hành vi cũ (timeout ⇒ '' im lặng).
 */
export function resolveTimeoutFallback(
  primary: string,
  env: NodeJS.ProcessEnv = process.env,
): TimeoutFallback | null {
  const entry = (FALLBACK_MAP as Record<string, (typeof FALLBACK_MAP)[keyof typeof FALLBACK_MAP]>)[primary];
  if (!entry) return null;
  const mode = (env[`${entry.envPrefix}_TIMEOUT_FALLBACK`] || 'on').trim().toLowerCase();
  if (mode === 'off' || mode === 'none' || mode === '0' || mode === 'false') return null;
  // 14/10 chị Jennie: cấm rơi sang Gemini dự phòng (LLM_GEMINI_API_FALLBACK mặc định off) — llm-route-policy.ts.
  if (entry.provider === 'gemini' && !geminiApiFallbackEnabled(env)) return null;
  const model = (env[`${entry.envPrefix}_TIMEOUT_FALLBACK_MODEL`] || '').trim() || entry.model;
  return { provider: entry.provider, model };
}

/** agy → claude (GEM-1050). Giữ tên cũ cho test/caller hiện có. */
export function resolveAgyFallback(env: NodeJS.ProcessEnv = process.env): TimeoutFallback | null {
  return resolveTimeoutFallback('antigravity', env);
}

/**
 * Circuit-breaker theo provider (GEM-1068, ENG-0930-F1050-02): fallback 1 lần chỉ cứu khách khỏi bị bỏ rơi,
 * KHÔNG giảm độ trễ — khi agy đang 429/chậm mỗi tin vẫn chờ đủ 5' rồi mới sang claude. Sau `threshold` lần
 * timeout LIÊN TIẾP thì "mở mạch": `cooldownMs` tới bỏ qua primary, chạy fallback ngay. Hết cooldown → half-open,
 * cho ĐÚNG 1 lượt thử primary (single-flight, các lượt khác vẫn đi fallback); thành công → đóng, timeout → mở lại.
 * Chỉ đếm ProviderTimeoutError (abort do khách nhắn mới / exit≠0 không phải dấu hiệu provider chậm).
 */
/** Trạng thái quan sát được của 1 breaker (GEM-1094: lộ ra /api/health + lưu đĩa qua restart). */
export interface BreakerSnapshot {
  provider: string;
  state: 'closed' | 'open' | 'half_open';
  consecutiveTimeouts: number;
  threshold: number;
  cooldownMs: number;
  openUntil: string | null;
  lastOpenedAt: string | null;
  lastClosedAt: string | null;
  fallbackTo: string | null;
}

/** Phần trạng thái cần sống qua restart (đọc/ghi file). */
export interface PersistedBreakerState {
  consecutive: number;
  openUntil: number;
  lastOpenedAt: number | null;
}

export class TimeoutCircuitBreaker {
  private consecutive = 0;
  private openUntil = 0;
  private probing = false;
  private lastOpenedAt: number | null = null;
  private lastClosedAt: number | null = null;
  /** Gọi khi mạch chuyển trạng thái mở↔đóng (KHÔNG gọi mỗi lượt) — dùng để log 1 lần + lưu đĩa. */
  onTransition: ((to: 'open' | 'closed') => void) | null = null;
  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** true = chạy primary; false = mạch đang mở → đi thẳng fallback. */
  allowPrimary(): boolean {
    if (this.threshold <= 0 || this.consecutive < this.threshold) return true;
    if (this.now() < this.openUntil) return false;
    if (this.probing) return false;
    this.probing = true;
    return true;
  }
  recordSuccess(): void {
    const wasOpen = this.isOpen;
    this.consecutive = 0;
    this.openUntil = 0;
    this.probing = false;
    if (wasOpen) {
      this.lastClosedAt = this.now();
      this.onTransition?.('closed');
    }
  }
  recordTimeout(): void {
    this.consecutive += 1;
    this.probing = false;
    if (this.threshold > 0 && this.consecutive >= this.threshold) {
      this.openUntil = this.now() + this.cooldownMs;
      this.lastOpenedAt = this.now();
      // Mở lần đầu HOẶC probe half-open lại timeout → mở lại: cả hai đều là 1 chuyển trạng thái đáng ghi.
      this.onTransition?.('open');
    }
  }
  /** Lượt thử half-open kết thúc bằng lỗi KHÔNG phải timeout → nhả cờ để lượt sau thử lại (không kẹt probing). */
  releaseProbe(): void {
    this.probing = false;
  }
  get isOpen(): boolean {
    return this.threshold > 0 && this.consecutive >= this.threshold;
  }
  snapshot(provider: string, fallbackTo: string | null = null): BreakerSnapshot {
    const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);
    const state = !this.isOpen ? 'closed' : this.now() < this.openUntil ? 'open' : 'half_open';
    return {
      provider,
      state,
      consecutiveTimeouts: this.consecutive,
      threshold: this.threshold,
      cooldownMs: this.cooldownMs,
      openUntil: this.isOpen ? iso(this.openUntil) : null,
      lastOpenedAt: iso(this.lastOpenedAt),
      lastClosedAt: iso(this.lastClosedAt),
      fallbackTo,
    };
  }
  toPersisted(): PersistedBreakerState {
    return { consecutive: this.consecutive, openUntil: this.openUntil, lastOpenedAt: this.lastOpenedAt };
  }
  /** Khôi phục sau restart — chỉ khi cooldown CHƯA hết (hết rồi thì bắt đầu đóng, primary tự được thử lại). */
  restore(s: PersistedBreakerState): void {
    if (!Number.isFinite(s.openUntil) || s.openUntil <= this.now()) return;
    if (!Number.isFinite(s.consecutive) || s.consecutive < 1) return;
    this.consecutive = Math.trunc(s.consecutive);
    this.openUntil = s.openUntil;
    this.lastOpenedAt = typeof s.lastOpenedAt === 'number' ? s.lastOpenedAt : null;
  }
}

const breakers = new Map<string, TimeoutCircuitBreaker>();

// Lưu trạng thái breaker xuống đĩa (GEM-1094): restart lúc agy đang 429 KHÔNG được xoá mạch — nếu xoá,
// `threshold` tin đầu sau restart lại chờ đủ 5' mỗi tin. Đường dẫn do composition root (index.ts) cấp;
// null (mặc định — test/CLI) = không đụng đĩa. Ghi chỉ khi chuyển trạng thái (hiếm), lỗi ghi KHÔNG chặn tin.
let persistPath: string | null = null;

export function configureBreakerPersistence(filePath: string | null): void {
  persistPath = filePath;
}

function readPersistedBreakers(): Record<string, PersistedBreakerState> {
  if (!persistPath || !existsSync(persistPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(persistPath, 'utf8'));
    return raw && typeof raw === 'object' ? (raw as Record<string, PersistedBreakerState>) : {};
  } catch (err) {
    console.warn(`[Breaker] đọc ${persistPath} lỗi, bắt đầu mạch đóng: ${(err as Error).message}`);
    return {};
  }
}

function writePersistedBreakers(): void {
  if (!persistPath) return;
  try {
    // Giữ entry của provider chưa được tạo lại sau restart (breaker tạo lười) — không ghi đè mất mạch đang mở của nó.
    const out: Record<string, PersistedBreakerState> = { ...readPersistedBreakers() };
    for (const [p, b] of breakers) out[p] = b.toPersisted();
    mkdirSync(dirname(persistPath), { recursive: true });
    const tmp = `${persistPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
    renameSync(tmp, persistPath); // atomic: không để file nửa vời nếu crash giữa chừng
  } catch (err) {
    console.warn(`[Breaker] ghi ${persistPath} lỗi (trạng thái chỉ còn trong RAM): ${(err as Error).message}`);
  }
}

/** `<AGY|CLAUDE|GEMINI>_BREAKER_THRESHOLD` (mặc định 2, 0 = tắt) · `<…>_BREAKER_COOLDOWN_MS` (mặc định 600000 = 10'). */
export function getTimeoutBreaker(primary: string, env: NodeJS.ProcessEnv = process.env): TimeoutCircuitBreaker | null {
  const entry = (FALLBACK_MAP as Record<string, (typeof FALLBACK_MAP)[keyof typeof FALLBACK_MAP]>)[primary];
  if (!entry) return null;
  let b = breakers.get(primary);
  if (!b) {
    const thr = Number.parseInt(env[`${entry.envPrefix}_BREAKER_THRESHOLD`] ?? '', 10);
    const cd = Number.parseInt(env[`${entry.envPrefix}_BREAKER_COOLDOWN_MS`] ?? '', 10);
    b = new TimeoutCircuitBreaker(Number.isFinite(thr) && thr >= 0 ? thr : 2, Number.isFinite(cd) && cd > 0 ? cd : 600_000);
    const saved = readPersistedBreakers()[primary];
    if (saved) b.restore(saved);
    const created = b;
    created.onTransition = (to) => {
      // 1 dòng/chuyển trạng thái (không phải mỗi tin) → ops grep được mốc mạch mở/đóng trong log pm2.
      if (to === 'open') console.warn(`[Breaker/${primary}] MẠCH MỞ → mọi tin đi thẳng ${entry.provider} tới ${created.snapshot(primary).openUntil}`);
      else console.info(`[Breaker/${primary}] mạch ĐÓNG lại — ${primary} trả lời bình thường`);
      writePersistedBreakers();
    };
    breakers.set(primary, created);
  }
  return b;
}

/** Trạng thái MỌI provider có breaker — cho /api/health (GEM-1094). */
export function getTimeoutBreakerSnapshot(env: NodeJS.ProcessEnv = process.env): BreakerSnapshot[] {
  const out: BreakerSnapshot[] = [];
  for (const primary of Object.keys(FALLBACK_MAP)) {
    const b = getTimeoutBreaker(primary, env);
    if (b) out.push(b.snapshot(primary, resolveTimeoutFallback(primary, env)?.provider ?? null));
  }
  return out;
}

/** Chỉ cho test: xoá trạng thái breaker toàn cục. */
export function resetTimeoutBreakers(): void {
  breakers.clear();
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; message?: string };
  return (
    e.name === 'AgentAbortedError' ||
    e.name === 'AbortError' ||
    (typeof e.message === 'string' && (e.message.includes('aborted') || e.message.includes('cancel-in-flight')))
  );
}

/**
 * Chạy `primary`; nếu nó timeout (ProviderTimeoutError) và có `fallback` → chạy `fallback` ĐÚNG 1 lần.
 * Lỗi của fallback được ném nguyên (caller quyết định im lặng) — KHÔNG lặp thêm.
 * Có `breaker` + `fallback`: mạch mở ⇒ bỏ qua primary (`onSkip`), chạy fallback luôn.
 * (GEM-1335, ENG-0930-F1068-03): Mạch mở mà fallback cũng lỗi (không phải abort) → thử primary 1 lần,
 * nếu primary còn sống thì trả kết quả và đóng mạch (tránh khách nhận rỗng khi primary đã hồi phục).
 */
export async function runWithTimeoutFallback<T>(
  primary: () => Promise<T>,
  fallback: (() => Promise<T>) | null,
  onFallback?: (err: ProviderTimeoutError) => void,
  breaker?: TimeoutCircuitBreaker | null,
  onSkip?: () => void,
  signal?: AbortSignal,
): Promise<T> {
  // Không có fallback ⇒ breaker vô nghĩa (không có chỗ để chuyển) → hành vi cũ.
  const cb = fallback ? breaker ?? null : null;
  if (cb && !cb.allowPrimary()) {
    onSkip?.();
    try {
      return await fallback!();
    } catch (fbErr: any) {
      if (signal?.aborted || isAbortError(fbErr)) throw fbErr;
      // Mạch mở mà fallback lỗi: thử primary 1 lần xem primary đã hồi phục chưa (GEM-1335)
      try {
        const out = await primary();
        cb.recordSuccess();
        return out;
      } catch (primaryErr) {
        if (signal?.aborted || isAbortError(primaryErr) || !(primaryErr instanceof ProviderTimeoutError)) {
          cb.releaseProbe();
        } else {
          cb.recordTimeout();
        }
        throw primaryErr;
      }
    }
  }
  try {
    const out = await primary();
    cb?.recordSuccess();
    return out;
  } catch (err) {
    if (signal?.aborted || isAbortError(err) || !(err instanceof ProviderTimeoutError)) {
      cb?.releaseProbe();
      throw err;
    }
    cb?.recordTimeout();
    if (!fallback) throw err;
    onFallback?.(err);
    return fallback();
  }
}

