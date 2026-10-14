// Threads OAuth routes — /api/channels/threads/oauth/{start,callback}
// Chị bấm start 1 lần cho mỗi tài khoản → token long-lived ghi .env → refresher tự gia hạn.
// Chống gắn nhầm tài khoản: username trả về PHẢI khớp expectedUsername của account (else 400, không lưu).

import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import {
  THREADS_ACCOUNTS, buildAuthorizeUrl, scopes, exchangeCode, exchangeLongLived, fetchMe,
  persistAccountToken, expiryIso,
} from './token-store.js';

const router = Router();

const DEFAULT_REDIRECT = 'https://gemops.gemcapitalholding.com/api/channels/threads/oauth/callback';
const appId = () => process.env.THREADS_APP_ID || '';
const appSecret = () => process.env.THREADS_APP_SECRET || '';
const redirectUri = () => process.env.THREADS_REDIRECT_URI || DEFAULT_REDIRECT;

// CSRF state → account (TTL 10 phút)
const states = new Map<string, { account: string; exp: number }>();

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:560px;margin:48px auto;padding:0 16px">` +
    `<h2>${esc(title)}</h2>${body}</body>`;
}

router.get('/oauth/start', (req: Request, res: Response) => {
  const account = String(req.query.account || 'jennie');
  if (!THREADS_ACCOUNTS[account]) {
    res.status(400).send(`account không hợp lệ (chọn: ${Object.keys(THREADS_ACCOUNTS).join(', ')})`);
    return;
  }
  if (!appId() || !appSecret()) {
    res.status(500).send('Thiếu THREADS_APP_ID / THREADS_APP_SECRET trong paperclip/server/.env');
    return;
  }
  const state = randomUUID();
  states.set(state, { account, exp: Date.now() + 600_000 });
  res.redirect(buildAuthorizeUrl(appId(), redirectUri(), state, scopes()));
});

router.get('/oauth/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  const err = (req.query.error_description || req.query.error) as string | undefined;
  if (err) { res.status(400).send(page('Threads trả lỗi', `<p>${esc(String(err))}</p>`)); return; }
  const st = state ? states.get(state) : undefined;
  if (state) states.delete(state);
  if (!code || !st || st.exp < Date.now()) {
    res.status(400).send(page('State không hợp lệ', '<p>Thiếu code hoặc state hết hạn — bấm lại link bắt đầu.</p>'));
    return;
  }
  const meta = THREADS_ACCOUNTS[st.account];
  try {
    const short = await exchangeCode(fetch, appId(), appSecret(), redirectUri(), code);
    const long = await exchangeLongLived(fetch, appSecret(), short.access_token);
    const me = await fetchMe(fetch, long.access_token);
    if ((me.username || '').toLowerCase() !== meta.expectedUsername.toLowerCase()) {
      console.warn(`[Threads] OAuth ${st.account}: username @${me.username} ≠ @${meta.expectedUsername} — KHÔNG lưu`);
      res.status(400).send(page('Sai tài khoản Threads',
        `<p>Đang đăng nhập <b>@${esc(me.username || '?')}</b>, cần <b>@${esc(meta.expectedUsername)}</b>. ` +
        'Đăng xuất Threads rồi bấm lại link. Token KHÔNG được lưu.</p>'));
      return;
    }
    const now = Date.now();
    await persistAccountToken(meta.suffix, {
      token: long.access_token,
      userId: String(me.id || short.user_id),
      username: me.username,
      expiresAt: expiryIso(now, long.expires_in),
      issuedAt: new Date(now).toISOString(),
    });
    console.log(`[Threads] OAuth connected @${me.username} (${st.account}) — hết hạn ${process.env[`THREADS_TOKEN_EXPIRES_AT_${meta.suffix}`]}`);
    res.status(200).send(page('✅ Đã kết nối Threads',
      `<p>Tài khoản <b>@${esc(me.username)}</b> — token 60 ngày, máy chủ tự gia hạn trước khi hết hạn.</p>` +
      '<p style="color:#666">Có thể đóng cửa sổ này.</p>'));
  } catch (e: any) {
    console.error('[Threads] OAuth callback error:', e.message);
    res.status(500).send(page('Lỗi khi lấy token', `<p>${esc(e.message)}</p>`));
  }
});

export default router;
