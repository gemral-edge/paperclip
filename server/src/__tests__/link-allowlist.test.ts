import { describe, expect, it } from 'vitest';
import { allowedLinksFromHtml, stripUnlistedLinks } from '../channels/link-allowlist.js';

// 14/10: jennie-support bịa "Instagram: https://www.instagram.com/jennieuyenchu/" — trang Jennie không có link
// Instagram. Agent có trang nguồn → chỉ được gửi link có NGUYÊN VĂN trong trang (máy chặn, không trông prompt).
const html = `
  <a href="#hop-tac">Hợp tác</a>
  <a href="/blog">Blog</a>
  <a href="https://www.youtube.com/@JennieUyenChu">YouTube</a>
  <a href="https://www.tiktok.com/@jennieuyenchu_">TikTok</a>
  <link rel="canonical" href="https://jennie.yinyangmasters.com/">
  <a href="https://apps.apple.com/vn/app/gemral/id6756418547">App</a>
  <link href="https://fonts.googleapis.com">`;

describe('link allowlist (trang nguồn)', () => {
  const allow = allowedLinksFromHtml(html, 'https://jennie.yinyangmasters.com');

  it('giữ link có trong trang + mọi đường dẫn của chính site', () => {
    const s = 'YouTube: https://www.youtube.com/@JennieUyenChu\nForm: https://jennie.yinyangmasters.com/#hop-tac\nhttps://jennie.yinyangmasters.com/blog';
    expect(stripUnlistedLinks(s, allow)).toEqual({ text: s, removed: [] });
  });

  it('bỏ cả DÒNG chứa link bịa (ca thật Instagram 14/10)', () => {
    const s = 'TikTok: https://www.tiktok.com/@jennieuyenchu_\nInstagram: https://www.instagram.com/jennieuyenchu/';
    const out = stripUnlistedLinks(s, allow);
    expect(out.text).toBe('TikTok: https://www.tiktok.com/@jennieuyenchu_');
    expect(out.removed).toEqual(['https://www.instagram.com/jennieuyenchu/']);
  });

  it('link sai 1 ký tự (handle bịa) cũng bị bỏ', () => {
    expect(stripUnlistedLinks('https://www.youtube.com/@JennieUyenChuOfficial', allow).text).toBe('');
  });

  it('dấu câu cuối link và dấu / cuối không làm trượt', () => {
    expect(stripUnlistedLinks('Kênh nè: https://www.youtube.com/@JennieUyenChu/.', allow).removed).toEqual([]);
  });

  it('link trong khối JSON-LD sameAs (không phải href) cũng hợp lệ — 14/10 em chặn oan Instagram thật', () => {
    const a2 = allowedLinksFromHtml(`${html}<script type="application/ld+json">{"sameAs":["https://www.instagram.com/jennieuyenchu/"]}</script>`, 'https://jennie.yinyangmasters.com');
    expect(stripUnlistedLinks('Instagram: https://www.instagram.com/jennieuyenchu/', a2).removed).toEqual([]);
  });

  it('tin không có link → giữ nguyên', () => {
    expect(stripUnlistedLinks('Chào bạn nha', allow)).toEqual({ text: 'Chào bạn nha', removed: [] });
  });
});
