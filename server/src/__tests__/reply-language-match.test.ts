// Reply theo ngôn ngữ khách — chị Jennie 09/10/2026 (sales-closer: khách tiếng Anh → trả lời tiếng Anh).
// Scrubber cũ coi mọi câu tiếng Anh mở đầu "I'll check…" là narration rò rỉ (bot 100% tiếng Việt) →
// nay chỉ cắt khi phần còn lại của reply là tiếng Việt.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../channels/zalo-personal/supabase.js', () => ({
  supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) },
}));

import { scrubBannedPhrases } from '../channels/router.js';

describe('reply language match', () => {
  it('keeps an English reply that starts with "I\'ll check"', () => {
    const reply = "I'll check the Premium annual plan for you — it's the best value.\nYou can start here: https://www.gemral.com/edge/pricing";
    expect(scrubBannedPhrases(reply, 'sales-closer')).toContain("I'll check the Premium annual plan");
  });

  it('still strips English task narration before a Vietnamese reply', () => {
    const reply = 'I will wait for the background search task to complete.\n\nDạ em gửi chị link gói năm ạ.';
    const out = scrubBannedPhrases(reply, 'sales-closer');
    expect(out).not.toMatch(/background search task/);
    expect(out).toContain('Dạ em gửi chị link gói năm ạ.');
  });

  it('replaces an owner-name leak in the reply language', () => {
    expect(scrubBannedPhrases('Please contact Jennie for that.', 'sales-closer')).toContain('our support team');
    expect(scrubBannedPhrases('Dạ chị Jennie sẽ hỗ trợ ạ.', 'sales-closer')).toContain('đội ngũ hỗ trợ');
  });
});
