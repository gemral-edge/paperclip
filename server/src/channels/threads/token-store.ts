// Threads API token store — OAuth (threads.net) → long-lived token 60 ngày → tự refresh.
//
// Vì sao có (14/10/2026, board EC-086 crypto-pattern-scanner): agent comment-responder cần
// đọc / trả lời / ẩn bình luận trên Threads @jennieuyenchu qua Threads API chính thức.
// Threads KHÔNG có API tin nhắn — chỉ reply. ĐĂNG BÀI qua API vẫn bị cấm (REF-HARD-RULE-NO-SOCIAL-API).
//
// Token sống ở paperclip/server/.env (cùng chỗ FB_PAGE_TOKEN_*, gitignored), mỗi tài khoản 5 khoá:
//   THREADS_TOKEN_<SUFFIX> · THREADS_USER_ID_<SUFFIX> · THREADS_USERNAME_<SUFFIX>
//   THREADS_TOKEN_EXPIRES_AT_<SUFFIX> · THREADS_TOKEN_ISSUED_AT_<SUFFIX>   (ISO-8601 UTC)
// Người đọc: crypto-pattern-scanner/scripts/threads_api/threads_comments.py + audit_threads_token_health.py.
// (Khoá cũ THREADS_ACCESS_TOKEN/THREADS_USER_ID của social-routes.ts là đường đăng bài — KHÔNG đụng.)

import { promises as fsp } from 'fs';
import path from 'path';

export const THREADS_GRAPH = 'https://graph.threads.net';
export const THREADS_AUTHORIZE = 'https://threads.net/oauth/authorize';

// Mặc định 3 quyền chị duyệt (không threads_content_publish). Nếu Meta đòi publish cho reply,
// đặt THREADS_OAUTH_SCOPES trong .env rồi bấm OAuth lại — code vẫn KHÔNG có đường đăng bài.
export const DEFAULT_SCOPES = ['threads_basic', 'threads_read_replies', 'threads_manage_replies'];

export const REFRESH_WITHIN_DAYS = 10;
const DAY_MS = 86_400_000;

export interface ThreadsAccount {
  suffix: string;
  expectedUsername: string;
}

// Thêm tài khoản = 1 dòng ở đây (+ 1 dòng ACCOUNTS ở threads_comments.py).
export const THREADS_ACCOUNTS: Record<string, ThreadsAccount> = {
  jennie: { suffix: 'JENNIE', expectedUsername: 'jennieuyenchu' },
  gemral_edge: { suffix: 'GEMRAL_EDGE', expectedUsername: 'gemraledge' },
  yinyang: { suffix: 'YINYANG', expectedUsername: 'yinyangmasters' },
};

export function envKeys(suffix: string) {
  return {
    token: `THREADS_TOKEN_${suffix}`,
    userId: `THREADS_USER_ID_${suffix}`,
    username: `THREADS_USERNAME_${suffix}`,
    expiresAt: `THREADS_TOKEN_EXPIRES_AT_${suffix}`,
    issuedAt: `THREADS_TOKEN_ISSUED_AT_${suffix}`,
  };
}

export function scopes(): string[] {
  const raw = (process.env.THREADS_OAUTH_SCOPES || '').trim();
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_SCOPES;
}

export function buildAuthorizeUrl(appId: string, redirectUri: string, state: string, scope: string[]): string {
  const q = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    scope: scope.join(','),
    response_type: 'code',
    state,
  });
  return `${THREADS_AUTHORIZE}?${q.toString()}`;
}

/** Threads gắn "#_" vào cuối code trong redirect — phải cắt trước khi đổi token. */
export function cleanCode(code: string): string {
  return code.replace(/#_$/, '').trim();
}

/** Ghi/thay từng KEY=VALUE trong nội dung .env (thuần, test được). */
export function upsertEnv(content: string, kv: Record<string, string>): string {
  let out = content;
  for (const [k, v] of Object.entries(kv)) {
    const line = `${k}=${v}`;
    const re = new RegExp(`^${k}=.*$`, 'm');
    out = re.test(out) ? out.replace(re, () => line) : `${out.replace(/\s*$/, '')}\n${line}\n`;
  }
  return out;
}

/**
 * Cần refresh không? Threads chỉ cho refresh token long-lived đã ≥24h tuổi và CHƯA hết hạn.
 * 'refresh' = còn < REFRESH_WITHIN_DAYS ngày · 'expired' = đã hết hạn (phải OAuth lại) · 'ok' / 'too_young'.
 */
export function refreshDecision(expiresAtIso: string | undefined, issuedAtIso: string | undefined, nowMs: number,
  withinDays = REFRESH_WITHIN_DAYS): 'ok' | 'refresh' | 'expired' | 'too_young' | 'unknown' {
  const exp = expiresAtIso ? Date.parse(expiresAtIso) : NaN;
  if (Number.isNaN(exp)) return 'unknown';
  if (exp <= nowMs) return 'expired';
  if (exp - nowMs > withinDays * DAY_MS) return 'ok';
  const issued = issuedAtIso ? Date.parse(issuedAtIso) : NaN;
  if (!Number.isNaN(issued) && nowMs - issued < DAY_MS) return 'too_young';
  return 'refresh';
}

export function expiryIso(nowMs: number, expiresInSec: number): string {
  return new Date(nowMs + expiresInSec * 1000).toISOString();
}

type Fetch = typeof fetch;

async function getJson(f: Fetch, url: string, init?: RequestInit): Promise<any> {
  const res = await f(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.error) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

/** code → short-lived token (+user_id). */
export async function exchangeCode(f: Fetch, appId: string, appSecret: string, redirectUri: string, code: string) {
  const form = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code: cleanCode(code),
  });
  return getJson(f, `${THREADS_GRAPH}/oauth/access_token`, { method: 'POST', body: form }) as Promise<{
    access_token: string; user_id: string | number;
  }>;
}

/** short-lived → long-lived (60 ngày). */
export async function exchangeLongLived(f: Fetch, appSecret: string, shortToken: string) {
  const q = new URLSearchParams({ grant_type: 'th_exchange_token', client_secret: appSecret, access_token: shortToken });
  return getJson(f, `${THREADS_GRAPH}/access_token?${q}`) as Promise<{ access_token: string; expires_in: number }>;
}

export async function refreshLongLived(f: Fetch, token: string) {
  const q = new URLSearchParams({ grant_type: 'th_refresh_token', access_token: token });
  return getJson(f, `${THREADS_GRAPH}/refresh_access_token?${q}`) as Promise<{ access_token: string; expires_in: number }>;
}

export async function fetchMe(f: Fetch, token: string) {
  const q = new URLSearchParams({ fields: 'id,username', access_token: token });
  return getJson(f, `${THREADS_GRAPH}/v1.0/me?${q}`) as Promise<{ id: string; username: string }>;
}

export function envPath(): string {
  return process.env.PAPERCLIP_ENV_PATH || path.resolve(process.cwd(), '.env');
}

/** Ghi bền vào .env + nạp nóng process.env (1 lần đọc-sửa-ghi cho cả bộ khoá). */
export async function persistAccountToken(suffix: string, vals: {
  token: string; userId: string; username: string; expiresAt: string; issuedAt: string;
}, file = envPath()): Promise<void> {
  const k = envKeys(suffix);
  const kv: Record<string, string> = {
    [k.token]: vals.token,
    [k.userId]: vals.userId,
    [k.username]: vals.username,
    [k.expiresAt]: vals.expiresAt,
    [k.issuedAt]: vals.issuedAt,
  };
  for (const [key, v] of Object.entries(kv)) process.env[key] = v;
  const content = await fsp.readFile(file, 'utf8').catch(() => '');
  const tmp = `${file}.threads.tmp`;
  await fsp.writeFile(tmp, upsertEnv(content, kv), 'utf8');
  await fsp.rename(tmp, file);
}

/** 1 vòng refresh cho mọi tài khoản có token. Trả kết quả từng tài khoản (không ném lỗi). */
export async function refreshAll(f: Fetch = fetch, nowMs = Date.now(), file = envPath()) {
  const results: Array<{ account: string; decision: string; ok?: boolean; error?: string }> = [];
  for (const [account, meta] of Object.entries(THREADS_ACCOUNTS)) {
    const k = envKeys(meta.suffix);
    const token = process.env[k.token];
    if (!token) continue;
    const decision = refreshDecision(process.env[k.expiresAt], process.env[k.issuedAt], nowMs);
    if (decision !== 'refresh') {
      if (decision === 'expired') console.error(`[Threads] token ${account} ĐÃ HẾT HẠN — phải bấm lại /api/channels/threads/oauth/start?account=${account}`);
      results.push({ account, decision });
      continue;
    }
    try {
      const r = await refreshLongLived(f, token);
      await persistAccountToken(meta.suffix, {
        token: r.access_token,
        userId: process.env[k.userId] || '',
        username: process.env[k.username] || '',
        expiresAt: expiryIso(nowMs, r.expires_in),
        issuedAt: new Date(nowMs).toISOString(),
      }, file);
      console.log(`[Threads] refreshed token ${account} → hết hạn ${process.env[k.expiresAt]}`);
      results.push({ account, decision, ok: true });
    } catch (e: any) {
      console.error(`[Threads] refresh ${account} lỗi:`, e.message);
      results.push({ account, decision, ok: false, error: e.message });
    }
  }
  return results;
}

let timer: NodeJS.Timeout | null = null;
export const REFRESH_INTERVAL_MS = 6 * 3_600_000;

export function startThreadsTokenRefresher(): void {
  if (timer) return;
  const run = () => { refreshAll().catch((e) => console.error('[Threads] refreshAll:', e?.message)); };
  setTimeout(run, 60_000).unref();
  timer = setInterval(run, REFRESH_INTERVAL_MS);
  timer.unref();
}
