// Customer privacy guard — chị Jennie 08/10/2026 (sau đơn #4846).
// Agent nói chuyện với khách: (1) không nạp hồ sơ cá nhân owner (USER.md) vào prompt,
// (2) chặn câu lộ đời tư người sáng lập, (3) không tự nhận là AI — chỉ xưng tư vấn viên.
// Corpus-check 08/10: 581 câu bot đã gửi 60 ngày → 0 bắt oan (lớp 2); lớp 3 bắt đúng 1 ca thật.
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../channels/zalo-personal/supabase.js', () => ({
  supabase: {
    from: () => {
      const thenable: any = {
        select: () => thenable,
        eq: () => thenable,
        order: () => thenable,
        limit: () => thenable,
        maybeSingle: () => Promise.resolve({ data: null }),
        single: () => Promise.resolve({ data: null }),
        then: (r: any) => Promise.resolve({ data: [], error: null }).then(r),
      };
      return thenable;
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  },
}));

import { detectOwnerPersonalInfoLeak, isCustomerFacingAgent, scrubBannedPhrases } from '../channels/router.js';

function agentDir(meta: object | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-'));
  if (meta) fs.writeFileSync(path.join(dir, 'agent.meta.json'), JSON.stringify(meta));
  return dir;
}

describe('isCustomerFacingAgent', () => {
  it('reply agent = nói chuyện với khách', () => expect(isCustomerFacingAgent(agentDir({ type: 'reply' }))).toBe(true));
  it('heartbeat agent = nội bộ', () => expect(isCustomerFacingAgent(agentDir({ type: 'heartbeat' }))).toBe(false));
  it('thiếu meta → fail-closed (coi là khách)', () => expect(isCustomerFacingAgent(agentDir(null))).toBe(true));
});

describe('detectOwnerPersonalInfoLeak', () => {
  it.each([
    'Người sáng lập Gemral sinh năm 1990, hiện đang sống ở Quận 7 ạ.',
    'Dạ chị Jennie có số điện thoại riêng là 09xx, bạn gọi thử nha.',
    'Founder bên em đã có chồng và hai con gái rồi ạ.',
    'Lá số tử vi của chị chủ shop thuộc mệnh Kim nha bạn.',
  ])('chặn: %s', (s) => expect(detectOwnerPersonalInfoLeak(s)).toBe(true));

  it.each([
    'Dạ khóa Kích Hoạt Tần Số Tình Yêu giúp bạn hàn gắn với chồng và gia đình ạ.',
    'Bạn sinh năm 1992 thì cung mệnh là Kiếm Phong Kim nha.',
    'Team chuyên môn cấp cao sẽ phản hồi bạn trong vòng 24-48 tiếng ạ.',
    'GEM Master là trợ lý AI trong app Gemral ạ.',
  ])('không chặn oan: %s', (s) => expect(detectOwnerPersonalInfoLeak(s)).toBe(false));
});

describe('scrubBannedPhrases — tự nhận AI', () => {
  it('ca thật 60 ngày: "em là trợ lý ảo" → tư vấn viên', () => {
    const out = scrubBannedPhrases('tiếc là em là trợ lý ảo nên chưa đi uống nước thật với bạn được nè', 'sales-closer');
    expect(out).toContain('em là tư vấn viên');
    expect(out).not.toMatch(/trợ lý ảo/);
  });
  it.each(['Mình là chatbot của Gemral', 'Tôi là một mô hình ngôn ngữ lớn', 'Em là AI nên không biết ạ', 'em chỉ là Claude thôi'])(
    'đổi: %s', (s) => expect(scrubBannedPhrases(s, 'sales-closer')).toMatch(/là tư vấn viên/),
  );
  it('gem-master (sản phẩm chatbot AI) được miễn', () => {
    expect(scrubBannedPhrases('Em là trợ lý AI GEM Master', 'gem-master')).toBe('Em là trợ lý AI GEM Master');
  });
  it.each(['GEM Master là trợ lý AI trong app', 'Khóa học AI Trading cho người mới', 'Xem là biết ngay ạ', 'em là Aiden'])(
    'giữ nguyên: %s', (s) => expect(scrubBannedPhrases(s, 'sales-closer')).not.toMatch(/tư vấn viên/),
  );
});

// 14/10 (EC-084): jennie-support trả lời trên kênh thương hiệu cá nhân Jennie — tên "Jennie" là tên thương hiệu,
// đổi thành "team chuyên môn cấp cao" làm hỏng link/handle (ca thật: "team chuyên môn cấp cao Uyen Chu").
describe('scrubBannedPhrases — kênh thương hiệu cá nhân (jennie-support)', () => {
  it('giữ tên thương hiệu + link + handle', () => {
    const s = 'Bạn xem lịch video trên kênh YouTube @JennieUyenChu của chị Jennie nha. Form hợp tác ở https://jennie.yinyangmasters.com/#hop-tac';
    expect(scrubBannedPhrases(s, 'jennie-support')).toBe(s);
  });
  it('vẫn chặn cụm nội bộ "sếp em"', () => {
    expect(scrubBannedPhrases('Để sếp em xem rồi báo bạn nha', 'jennie-support')).not.toMatch(/sếp em/);
  });
  it('agent khác vẫn đổi tên chị như cũ', () => {
    expect(scrubBannedPhrases('Chị Jennie sẽ trả lời bạn', 'sales-closer')).not.toMatch(/Jennie/i);
  });
});
