import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import {
  buildAuthorizeUrl, cleanCode, upsertEnv, refreshDecision, refreshAll, envKeys, DEFAULT_SCOPES, scopes,
  exchangeCode, exchangeLongLived,
} from '../token-store.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-14T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('authorize url + code', () => {
  it('builds threads.net authorize URL with comma scopes, no publish scope by default', () => {
    const u = new URL(buildAuthorizeUrl('123', 'https://x.test/cb', 'st', DEFAULT_SCOPES));
    expect(u.origin + u.pathname).toBe('https://threads.net/oauth/authorize');
    expect(u.searchParams.get('client_id')).toBe('123');
    expect(u.searchParams.get('redirect_uri')).toBe('https://x.test/cb');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('scope')).toBe('threads_basic,threads_read_replies,threads_manage_replies');
    expect(DEFAULT_SCOPES).not.toContain('threads_content_publish');
  });
  it('THREADS_OAUTH_SCOPES env overrides scopes', () => {
    process.env.THREADS_OAUTH_SCOPES = 'threads_basic, threads_manage_replies';
    expect(scopes()).toEqual(['threads_basic', 'threads_manage_replies']);
    delete process.env.THREADS_OAUTH_SCOPES;
    expect(scopes()).toEqual(DEFAULT_SCOPES);
  });
  it('strips trailing #_ from code', () => {
    expect(cleanCode('AQBx#_')).toBe('AQBx');
    expect(cleanCode('AQBx')).toBe('AQBx');
  });
});

describe('upsertEnv', () => {
  it('replaces existing keys and appends new ones, keeps others', () => {
    const out = upsertEnv('A=1\nTHREADS_TOKEN_JENNIE=old\nB=2\n', { THREADS_TOKEN_JENNIE: 'new$1', C: '3' });
    expect(out).toContain('THREADS_TOKEN_JENNIE=new$1');
    expect(out).not.toContain('old');
    expect(out).toMatch(/A=1/);
    expect(out).toMatch(/B=2/);
    expect(out.trim().endsWith('C=3')).toBe(true);
  });
});

describe('refreshDecision', () => {
  it('ok when >10 days left', () => expect(refreshDecision(iso(NOW + 30 * DAY), iso(NOW - 30 * DAY), NOW)).toBe('ok'));
  it('refresh when <10 days left', () => expect(refreshDecision(iso(NOW + 5 * DAY), iso(NOW - 55 * DAY), NOW)).toBe('refresh'));
  it('expired when past expiry', () => expect(refreshDecision(iso(NOW - 1), iso(NOW - 61 * DAY), NOW)).toBe('expired'));
  it('too_young when issued <24h ago', () => expect(refreshDecision(iso(NOW + 5 * DAY), iso(NOW - 3_600_000), NOW)).toBe('too_young'));
  it('unknown without expiry', () => expect(refreshDecision(undefined, undefined, NOW)).toBe('unknown'));
});

function fakeFetch(routes: Record<string, any>, calls: string[]) {
  return (async (url: any, init?: any) => {
    const u = String(url);
    calls.push(`${init?.method || 'GET'} ${u}`);
    const key = Object.keys(routes).find((k) => u.includes(k));
    const body = key ? routes[key] : { error: { message: 'no route' } };
    return { ok: !body.error, status: body.error ? 400 : 200, json: async () => body } as any;
  }) as typeof fetch;
}

describe('exchange calls', () => {
  it('code exchange POSTs to oauth/access_token, long-lived uses th_exchange_token', async () => {
    const calls: string[] = [];
    const f = fakeFetch({ '/oauth/access_token': { access_token: 'S', user_id: 9 }, 'th_exchange_token': { access_token: 'L', expires_in: 5_184_000 } }, calls);
    const s = await exchangeCode(f, 'id', 'sec', 'https://x/cb', 'abc#_');
    expect(s.access_token).toBe('S');
    const l = await exchangeLongLived(f, 'sec', 'S');
    expect(l.expires_in).toBe(5_184_000);
    expect(calls[0]).toMatch(/^POST https:\/\/graph\.threads\.net\/oauth\/access_token/);
    expect(calls[1]).toContain('grant_type=th_exchange_token');
  });
  it('API error surfaces as thrown Error', async () => {
    const f = fakeFetch({}, []);
    await expect(exchangeLongLived(f, 'sec', 'S')).rejects.toThrow('no route');
  });
});

describe('refreshAll', () => {
  let dir: string; let file: string;
  const k = envKeys('JENNIE');
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'thr-'));
    file = path.join(dir, '.env');
    await fsp.writeFile(file, 'KEEP=1\n', 'utf8');
    for (const s of ['JENNIE', 'GEMRAL_EDGE']) for (const key of Object.values(envKeys(s))) delete process.env[key];
  });
  afterEach(async () => {
    for (const key of Object.values(k)) delete process.env[key];
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('refreshes a token with <10 days left and persists new expiry', async () => {
    process.env[k.token] = 'OLD';
    process.env[k.userId] = '42';
    process.env[k.username] = 'jennieuyenchu';
    process.env[k.expiresAt] = iso(NOW + 3 * DAY);
    process.env[k.issuedAt] = iso(NOW - 57 * DAY);
    const calls: string[] = [];
    const f = fakeFetch({ 'refresh_access_token': { access_token: 'NEW', expires_in: 60 * 86400 } }, calls);
    const res = await refreshAll(f, NOW, file);
    expect(res).toEqual([{ account: 'jennie', decision: 'refresh', ok: true }]);
    expect(calls[0]).toContain('grant_type=th_refresh_token');
    const content = await fsp.readFile(file, 'utf8');
    expect(content).toContain('KEEP=1');
    expect(content).toContain(`${k.token}=NEW`);
    expect(content).toContain(`${k.expiresAt}=${iso(NOW + 60 * DAY)}`);
    expect(process.env[k.token]).toBe('NEW');
  });

  it('does not call API when token is fresh, skips accounts without token', async () => {
    process.env[k.token] = 'T';
    process.env[k.expiresAt] = iso(NOW + 40 * DAY);
    const calls: string[] = [];
    const res = await refreshAll(fakeFetch({}, calls), NOW, file);
    expect(calls).toEqual([]);
    expect(res).toEqual([{ account: 'jennie', decision: 'ok' }]);
  });

  it('refresh failure is reported, not thrown, and .env untouched', async () => {
    process.env[k.token] = 'OLD';
    process.env[k.expiresAt] = iso(NOW + 2 * DAY);
    process.env[k.issuedAt] = iso(NOW - 58 * DAY);
    const res = await refreshAll(fakeFetch({}, []), NOW, file);
    expect(res[0].ok).toBe(false);
    expect(await fsp.readFile(file, 'utf8')).toBe('KEEP=1\n');
  });
});
