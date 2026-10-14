// Chính sách đường LLM trả lời khách — 1 chỗ đọc cờ cho mọi đường reply của Paperclip.
//
// Chị Jennie 14/10: "tắt fallback sang Gemini dự phòng luôn, ko đc gọi API. tăng thời gian chờ agy local lên".
//  - LLM_GEMINI_API_FALLBACK = off (mặc định) | on. Tắt ⇒ không đường reply nào được rơi sang Gemini
//    (claude→gemini fallback bị bỏ) và mọi CLI con sinh ra KHÔNG thừa hưởng GEMINI_API_KEY/GOOGLE_API_KEY
//    (gemini-cli thấy key trong env là có thể gọi API trả phí thay vì OAuth).
//    Fallback claude CLI cục bộ (gói Max của chị, không phải API) giữ nguyên.
//  - AGY_REPLY_TIMEOUT_MS: thời gian chờ agy local cho 1 lượt trả lời kênh (Zalo/FB/web chat/test route).
//    Mặc định 420s (cũ 300s dùng chung AGENT_TIMEOUT_MS); không cho đặt thấp hơn AGY_MIN_REPLY_TIMEOUT_MS.
// Cùng tên cờ ở edge Supabase: supabase/functions/_shared/llmRoutePolicy.ts (crypto-pattern-scanner).
// Máy gác: crypto-pattern-scanner/scripts/audit_cskh.py P-LLM-NO-GEMINI-API.

export const AGY_MIN_REPLY_TIMEOUT_MS = 300_000;
export const AGY_DEFAULT_REPLY_TIMEOUT_MS = 420_000;

const ON = new Set(['on', 'true', '1', 'yes']);

export function geminiApiFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ON.has(String(env.LLM_GEMINI_API_FALLBACK || 'off').trim().toLowerCase());
}

const GEMINI_KEY_VARS = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_API_KEY'];

/** Bản sao env cho CLI con: bỏ khoá Gemini API khi cờ tắt (không sửa process.env gốc). */
export function childEnvWithoutGeminiApi(
  base: NodeJS.ProcessEnv,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (geminiApiFallbackEnabled(env)) return { ...base };
  const out: NodeJS.ProcessEnv = { ...base };
  for (const k of GEMINI_KEY_VARS) delete out[k];
  return out;
}

/** Thời gian chờ agy cho 1 lượt trả lời; env lạ/thấp hơn sàn → dùng sàn. */
export function agyReplyTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.AGY_REPLY_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return AGY_DEFAULT_REPLY_TIMEOUT_MS;
  return Math.max(AGY_MIN_REPLY_TIMEOUT_MS, Math.round(raw));
}

// 14/10 (Gem Master async job): caller có trần cứng (edge Supabase wall-clock 400s) gửi header
// x-agy-timeout-ms để agy bị cắt SỚM hơn trần đó, chừa chỗ cho fallback claude CLI 1 lần trả lời kịp.
// Chỉ được RÚT NGẮN (không vượt agyReplyTimeoutMs), sàn 60s; header lạ/rỗng → undefined (dùng mặc định).
export const AGY_CALLER_MIN_TIMEOUT_MS = 60_000;

export function agyCallerTimeoutMs(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(agyReplyTimeoutMs(env), Math.max(AGY_CALLER_MIN_TIMEOUT_MS, Math.round(n)));
}
