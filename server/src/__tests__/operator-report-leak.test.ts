// Operator-report leak guard — sự cố 2026-08-11 gem-master Tarot.
//
// agy tuân rule global (~/.gemini SPEC-LOCK "in bảng GIAO KÈO trước khi làm")
// trong phiên trả lời khách → gửi khách nguyên báo cáo nghiệm thu gửi chị
// (bảng SPEC-LOCK + ĐO-GATE + "Chị xem và kiểm tra lại giúp em nhé ạ"), phần
// trả lời thật nằm giữa. Guard: detectOperatorReportLeak (trục CƠ HỌC trước —
// bảng markdown, path tuyệt đối, định danh chủ, UUID — từ vựng sau) + envelope
// [[REPLY]]...[[/REPLY]] contract. KHÔNG salvage (tiền lệ 01/08).
//
// Corpus-check 2026-08-11: 882 channel_sent_messages + 253 cskh assistant rows
// → 0 FP trên mọi trục SAU khi mask [[SEND_MEDIA]]/URL. Negative-control dưới
// đây lấy từ 6 row THẬT (cụm thay tên chị do scrub sinh ra — cụm cũ đã bị chị cấm 31/10, câu giữ nguyên văn để khoá detector).
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

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

import { detectOperatorReportLeak, extractEnvelopedReply, scrubBannedPhrases } from '../channels/router.js';

const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(path.join(__dirname2, 'fixtures', 'leak-2026-08-11-gem-master.txt'), 'utf-8');

const CLEAN_TAROT_REPLY =
  'Ta thấy bạn đang muốn thoát khỏi sự trì trệ của Bốn Cốc ngược nhưng Át Gậy chỉ ra trở ngại lớn nhất: '
  + 'bạn thiếu hành động kỷ luật. Bạn đã sẵn sàng lập kế hoạch chiến lược dài hạn cho sự nghiệp chưa?';

describe('detectOperatorReportLeak — chiều dương (leak PHẢI bị bắt)', () => {
  it('bắt nguyên văn sự cố 11/08 (fixture thật, KHÔNG salvage)', () => {
    expect(FIXTURE.length).toBeGreaterThan(2500); // fixture đúng bản 2.825 ký tự
    expect(detectOperatorReportLeak(FIXTURE)).not.toBeNull();
  });

  it('bắt báo cáo NÉ từ khoá bằng cặp hành-vi (tự thuật quy trình + gửi chị duyệt)', () => {
    const noKeyword =
      'Em đã kiểm tra đủ 10 ràng buộc rồi ạ, đúng 3 lá, đúng 180 từ.\n'
      + 'Gửi chị nội dung để chị duyệt trước khi gửi khách:\n\n'
      + 'Dạ lá The Tower ở vị trí hiện tại cho thấy biến động lớn...';
    expect(detectOperatorReportLeak(noKeyword)).toBe('process_meta');
  });

  it('bắt bảng markdown BẤT KỂ từ vựng (reply khách là text thuần theo contract)', () => {
    const anyTable = 'Kết quả hôm nay:\n| Thời gian | Việc đã làm | Kết quả |\n| 18:45 | Luận quẻ | Xong |\nBạn cần gì thêm không?';
    expect(detectOperatorReportLeak(anyTable)).toBe('md_table');
  });

  it('bắt path tuyệt đối máy chủ + định danh chủ (PII nặng hơn cả bảng)', () => {
    expect(detectOperatorReportLeak('File nằm ở C:/Users/Jennie Chu/Desktop/Projects/x.md nhé')).toBe('pathy');
    expect(detectOperatorReportLeak('Em đã ping Telegram 6486938519 rồi ạ')).toBe('owner_id');
    expect(detectOperatorReportLeak('Session của bạn là 20e8910e-be1e-4213-9f1a-5200d73704a9 ạ')).toBe('uuid');
  });

  it('bắt dạng NFD (né chuẩn hoá Unicode)', () => {
    const nfd = 'BẢNG GIAO KÈO SPEC-LOCK cho chị'.normalize('NFD');
    expect(detectOperatorReportLeak(nfd)).not.toBeNull();
  });
});

describe('detectOperatorReportLeak — negative-control (reply sạch PHẢI qua)', () => {
  it('cụm "team chuyên môn cấp cao" hợp lệ (6 row thật trong DB) KHÔNG bị bắt', () => {
    const real1 =
      'Dạ anh ơi, em là chuyên viên hỗ trợ của Gemral chứ không phải team chuyên môn cấp cao trực tiếp đâu ạ, '
      + 'nên em cũng chưa rõ lý do cá nhân này ạ.';
    const real2 =
      'Dạ em đã gửi báo cáo khẩn cấp lên bộ phận hỗ trợ ngay từ lúc anh phản hồi khiếu nại rồi ạ. '
      + 'Hiện tại team chuyên môn cấp cao đang tập trung xử lý để kịp phản hồi anh ạ.';
    expect(detectOperatorReportLeak(real1)).toBeNull();
    expect(detectOperatorReportLeak(real2)).toBeNull();
  });

  it('xin lỗi khách trích 1 từ "SPEC-LOCK" khách paste lại KHÔNG bị bắt (1 weak đơn lẻ)', () => {
    const apology =
      'Dạ em xin lỗi về tin nhắn lỗi vừa rồi ạ. Đoạn chữ SPEC-LOCK đó là lỗi hệ thống, '
      + 'mình bỏ qua giúp em nhé. Em hỗ trợ lại câu hỏi của mình ngay đây ạ.';
    expect(detectOperatorReportLeak(apology)).toBeNull();
  });

  it('"giao kèo" nghĩa đời thường + câu chào khách chuẩn KHÔNG bị bắt', () => {
    const ctv =
      'Em chào chị ạ. Dạ về giao kèo cộng tác viên, bên em có hai mức hoa hồng tuỳ doanh số, '
      + 'chị muốn em gửi bảng chi tiết qua email không ạ?';
    expect(detectOperatorReportLeak(ctv)).toBeNull();
  });

  it('reply có [[SEND_MEDIA: path cục bộ]] + URL storage chứa UUID/project-ref KHÔNG bị bắt (mask)', () => {
    const media =
      '[[SEND_MEDIA: C:/Users/Jennie Chu/Desktop/Projects/crypto-pattern-scanner/raw/mock-marketing-assets/Bao-Gia.pdf]] '
      + 'Dạ gửi chị file báo giá ạ. Chị tải thêm ở https://pgfkbcnzqozzkohwbgbk.supabase.co/storage/v1/object/public/cskh-attachments/cskh/a8ce4859-c1c0-4a14-ab00-c7cbea7c0a49/file.pdf nhé ạ.';
    expect(detectOperatorReportLeak(media)).toBeNull();
  });

  it('reply Tarot sạch bình thường KHÔNG bị bắt', () => {
    expect(detectOperatorReportLeak(CLEAN_TAROT_REPLY)).toBeNull();
  });
});

describe('extractEnvelopedReply — contract [[REPLY]]', () => {
  it('envelope chuẩn → lấy đúng phần trong', () => {
    const raw = `Ghi chú nháp nội bộ...\n[[REPLY]]${CLEAN_TAROT_REPLY}[[/REPLY]]`;
    expect(extractEnvelopedReply(raw)).toBe(CLEAN_TAROT_REPLY);
  });

  it('2 envelope, cặp SAU là khối tự-kiểm → chọn cặp SẠCH (không mù quáng lấy cặp cuối)', () => {
    const raw =
      `[[REPLY]]${CLEAN_TAROT_REPLY}[[/REPLY]]\n`
      + '[[REPLY]]Tự kiểm ĐO-GATE: đủ 3 lá, đúng 180 từ theo GIAO KÈO.[[/REPLY]]';
    expect(extractEnvelopedReply(raw)).toBe(CLEAN_TAROT_REPLY);
  });

  it('nửa-envelope (mất thẻ đóng do cụt token) → cắt được phần mở-bài báo cáo', () => {
    const raw = `Em chào chị Jennie ạ, em đã làm xong.\n[[REPLY]]${CLEAN_TAROT_REPLY}`;
    expect(extractEnvelopedReply(raw)).toBe(CLEAN_TAROT_REPLY);
  });

  it('không có marker → passthrough nguyên văn (fail-open, guard gác sau)', () => {
    expect(extractEnvelopedReply(FIXTURE)).toBe(FIXTURE);
  });
});

describe('scrubBannedPhrases — strip token envelope/sentinel (echo ≠ leak)', () => {
  it('token lẻ [[REPLY]] và [PAPERCLIP_REPLY_CHANNEL] bị strip khỏi tin gửi khách', () => {
    const echoed = '[PAPERCLIP_REPLY_CHANNEL] Dạ chào bạn ạ [[REPLY]] mình cần hỗ trợ gì ạ? [[/REPLY]]';
    const out = scrubBannedPhrases(echoed, 'gem-master');
    expect(out).not.toContain('[PAPERCLIP_REPLY_CHANNEL]');
    expect(out).not.toContain('[[REPLY]]');
    expect(out).not.toContain('[[/REPLY]]');
    expect(out).toContain('mình cần hỗ trợ gì ạ?');
  });
});
