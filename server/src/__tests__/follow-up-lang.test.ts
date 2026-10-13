import { describe, it, expect, vi } from 'vitest';
vi.mock('../channels/zalo-personal/supabase.js', () => ({ supabase: {} }));
vi.mock('../services/cron-registry.js', () => ({ recordCronRun: async () => {} }));
import { pickFollowupLang } from '../channels/crm/follow-up-cron.js';

describe('pickFollowupLang', () => {
  it('English web/shopify customer gets en', () => {
    expect(pickFollowupLang('cskh-shopify', "Hi, what's the difference between Edge Pro and Premium?")).toBe('en');
    expect(pickFollowupLang('cskh-web', 'Do you have an English version?')).toBe('en');
  });
  it('Vietnamese with diacritics gets vi', () => {
    expect(pickFollowupLang('cskh-web', 'Cho em hỏi giá gói năm')).toBe('vi');
  });
  it('Zalo always vi even without diacritics', () => {
    expect(pickFollowupLang('zalo-personal-1784368397779', 'Oki shop')).toBe('vi');
  });
  it('no inbound text: fb vi, web en', () => {
    expect(pickFollowupLang('fb-yinyang', '')).toBe('vi');
    expect(pickFollowupLang('cskh-shopify', null)).toBe('en');
  });
});
