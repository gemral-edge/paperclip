import { describe, expect, it } from 'vitest';
import { AGENT_LINK_SOURCES, allowedLinksFromHtml, stripUnlistedLinks } from '../channels/link-allowlist.js';

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

describe('email trong trang nguồn', () => {
  const a = allowedLinksFromHtml('<script>{"email": "jennieuyenchu@gmail.com"}</script>', 'https://jennie.yinyangmasters.com');
  it('thu email công khai', () => expect([...a.emails]).toEqual(['jennieuyenchu@gmail.com']));
  it('email có trong trang → giữ; email bịa → bỏ dòng', () => {
    expect(stripUnlistedLinks('Email: jennieuyenchu@gmail.com', a).removed).toEqual([]);
    expect(stripUnlistedLinks('Email: contact@jennieuyenchu.com', a).removed).toEqual(['contact@jennieuyenchu.com']);
  });
});

// 14/10 mở rộng cho agent bán hàng — đo 30 ngày: 6 link ngoài danh sách = 1 bịa (gemral.com/product/tu-duy-trieu-phu 404)
// + 2 link thật thêm đoạn ngôn ngữ /vi/ + 3 ảnh kho Supabase.
describe('agent bán hàng: đoạn ngôn ngữ + kho ảnh', () => {
  const a = allowedLinksFromHtml('"url": "https://yinyang-web.vercel.app/products/duyen-khoi-thach" https://www.gemral.com/product/duyen-khoi-thach', null);
  it('thêm /vi/ vào link thật → vẫn giữ', () => {
    expect(stripUnlistedLinks('https://yinyang-web.vercel.app/vi/products/duyen-khoi-thach', a).removed).toEqual([]);
  });
  it('ảnh kho Supabase công khai → giữ', () => {
    expect(stripUnlistedLinks('https://pgfkbcnzqozzkohwbgbk.supabase.co/storage/v1/object/public/cskh-attachments/cskh/x.jpg', a).removed).toEqual([]);
  });
  it('đường dẫn bịa trên chính tên miền của mình (404 thật) → bỏ', () => {
    expect(stripUnlistedLinks('Xem tại https://www.gemral.com/product/tu-duy-trieu-phu', a).removed).toHaveLength(1);
  });
});

describe('AGENT_LINK_SOURCES', () => {
  it('đăng ký đủ agent trả lời khách', () => {
    for (const s of ['jennie-support', 'sales-closer', 'yinyang-support', 'edge-sales-closer']) {
      expect(AGENT_LINK_SOURCES[s]).toBeDefined();
    }
  });
});

// 29/10: hướng dẫn Edge ghi đường dẫn ngắn (/edge/connect) → link gemral.com tương ứng hợp lệ; link bịa vẫn bị bỏ.
import { guideLinks } from '../channels/link-allowlist.js';

describe('link allowlist (đường dẫn ngắn trong hướng dẫn)', () => {
  const md = '## Use Edge in Claude: /edge/connect\nAPI docs: /edge/api-docs. Status: /edge/status.';
  const allow = allowedLinksFromHtml(guideLinks([md], ['https://www.gemral.com', 'https://gemral.com']).join('\n'), null);

  it('giữ link có trong hướng dẫn, kể cả không www', () => {
    const s = 'Open https://www.gemral.com/edge/connect\nDocs: https://gemral.com/edge/api-docs';
    expect(stripUnlistedLinks(s, allow).removed).toEqual([]);
  });

  it('vẫn bỏ link bịa không có trong hướng dẫn', () => {
    const r = stripUnlistedLinks('Go to https://www.gemral.com/edge/made-up-page', allow);
    expect(r.removed).toEqual(['https://www.gemral.com/edge/made-up-page']);
  });

  it('không nhặt nhầm phần đường dẫn của URL đầy đủ', () => {
    expect(guideLinks(['see https://example.com/edge/x'], ['https://www.gemral.com'])).toEqual([]);
  });
});
