// Lỗi timeout/quota/crash của provider + withApiTimeout. (Tên file giữ nguyên để không vỡ import/test.)
//
// 22/10/2026 chị Jennie (SSOT ~/.claude/CLAUDE.md §CẤM FALLBACK): provider nào chạy agent thì hết quota /
// timeout / crash CHỈ được để lỗi nguyên — CẤM đổi sang provider/model khác (claude CLI, Gemini, chuỗi dự phòng).
// 06/11/2026: GỠ HẲN đường fallback còn sót ở đây (FALLBACK_MAP claude⇄gemini · nvidia_nim/openrouter→claude,
// resolveTimeoutFallback, runWithTimeoutFallback, circuit-breaker "chạy thẳng fallback"). Timeout ⇒ ném
// ProviderTimeoutError, caller (runAgentWithConfig) trả lỗi rõ ràng; khách nhận câu quá tải ở edge.
// Máy gác: server/src/__tests__/no-provider-fallback.test.ts + crypto repo scripts/paperclip_model_list_audit.py.
// Cấm thêm lại mục vào FALLBACK_MAP. Xoay tài khoản Google trong agy (giữ nguyên model) KHÔNG phải fallback.

/** Luật 22/10: rỗng VĨNH VIỄN. Test + probe đỏ nếu có mục. */
export const FALLBACK_MAP: Readonly<Record<string, never>> = Object.freeze({});

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

/** Rỗng + exit 0 = agent cố ý im (spam, "ok", thả tim) → giữ im. Rỗng + exit≠0/null = sự cố → ProviderCrashError (để lỗi nguyên, không đổi provider). */
export function isAgyCrashEmpty(reply: string, code: number | null, aborted: boolean): boolean {
  return !reply && code !== 0 && !aborted;
}

/**
 * Provider API (fetch) quá hạn: `controller.abort()` chỉ ném DOMException AbortError trần — không phân biệt được
 * với abort do khách nhắn mới, nên caller không phân biệt được. Bọc cả fetch + đọc body trong 1 hàm:
 * hết hạn ⇒ ProviderTimeoutError (caller trả lỗi rõ ràng, KHÔNG đổi provider); abort từ `signal` ngoài ⇒ `makeAbortError()`
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
