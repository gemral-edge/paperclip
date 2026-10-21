// GEM-1572 / OPS-1021-S1-01-b8b076: Bộ phân loại ý định kết thúc cuộc trò chuyện (closure intent).
// Nhận diện khi khách hàng gửi tin nhắn kết thúc, cảm ơn, ghi nhận ("Ok", "Ồ vậy mình cảm ơn...", "thanks shop", "dạ vâng ạ").
//
// Pure function, fail-closed: có dấu hỏi '?', có yêu cầu/khiếu nại/thắc mắc, hoặc quá dài -> false (người xử lý như cũ).

const MAX_TOKENS = 25;
const MAX_CHARS = 120;

/** Các từ khóa/ký hiệu thể hiện câu hỏi, khiếu nại, yêu cầu hỗ trợ hoặc vấn đề cần xử lý -> FAIL-CLOSED (không phải closure). */
const PROBLEM_OR_INQUIRY_TOKENS = new Set([
  'sao', 'lỗi', 'loi', 'chưa', 'chua', 'không', 'khong', 'giá', 'gia',
  'nhiêu', 'nhieu', 'bao', 'tiền', 'tien', 'hoàn', 'hoan', 'đổi', 'doi',
  'trả', 'tra', 'ship', 'hàng', 'hang', 'đơn', 'don', 'khi', 'nào', 'nao',
  'tại', 'tai', 'giúp', 'giup', 'hỗ', 'trợ', 'ho', 'tro', 'tư', 'vấn', 'tu', 'van',
  'mua', 'đặt', 'dat', 'sđt', 'sdt', 'địa', 'chỉ', 'dia', 'chi', 'tài', 'khoản',
  'tai', 'khoan', 'ngân', 'stk', 'ck', 'chuyển', 'chuyen', 'mật', 'khẩu', 'pass',
  'code', 'link', 'hỏng', 'hong', 'mất', 'mat', 'hủy', 'huy',
  'why', 'how', 'what', 'when', 'where', 'price', 'cost', 'issue', 'error', 'bug',
  'refund', 'cancel', 'help', 'support', 'broken',
]);

/** Các token đơn thuần túy là lời kết thúc / cảm ơn / ghi nhận. */
const SINGLE_CLOSURE_TOKENS = new Set([
  'ok', 'oke', 'oki', 'okela', 'okay', 'k',
  'thanks', 'thank', 'thx', 'tks',
  'bye', 'goodbye',
]);

/** Cụm từ tiếng Việt / tiếng Anh biểu thị kết thúc, cảm ơn, chấp thuận. */
const CLOSURE_PHRASES: string[] = [
  'cảm ơn', 'cam on', 'cám ơn',
  'thank you', 'thank u', 'thanks shop', 'cảm ơn shop', 'cam on shop',
  'mình cảm ơn', 'minh cam on', 'em cảm ơn', 'e cam on',
  'vậy mình cảm ơn', 'vay minh cam on', 'thôi mình cảm ơn', 'thoi minh cam on',
  'dạ vâng', 'da vang', 'vâng ạ', 'vang a', 'dạ ok', 'da ok', 'ok ạ', 'ok a',
  'ok nhé', 'ok nhe', 'ok nha', 'ok bạn', 'ok ban', 'ok shop', 'ok em',
  'hiểu rồi', 'hieu roi', 'rõ rồi', 'ro roi', 'biết rồi', 'biet roi',
  'xong rồi', 'xong roi', 'được rồi', 'duoc roi', 'thế thôi', 'the thoi', 'vậy thôi', 'vay thoi',
  'tạm biệt', 'tam biet', 'chúc shop', 'chuc shop', 'hẹn gặp lại', 'hen gap lai',
  'công việc của mình', 'cong viec cua minh', 'mình có việc', 'minh co viec', 'mình bận', 'minh ban',
  'không có gì', 'khong co gi', 'không sao', 'khong sao',
  'all good', 'got it', 'noted',
];

function tokenize(text: string): string[] {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Phân loại tin nhắn của khách có phải là ý định kết thúc cuộc trò chuyện (closure intent) hay không.
 * True nếu tin nhắn chỉ mang tính xác nhận ("Ok"), cảm ơn ("Ồ vậy mình cảm ơn..."), hoặc chào tạm biệt.
 *
 * Tiêu chí an toàn (Fail-closed):
 * 1. Chứa dấu hỏi '?' -> false.
 * 2. Chứa từ khóa thắc mắc/vấn đề (giá, lỗi, bao nhiêu, chưa, khi nào, ship...) -> false.
 * 3. Quá dài (> MAX_CHARS hoặc > MAX_TOKENS) -> false.
 * 4. Phải chứa ít nhất 1 dấu hiệu kết thúc cốt lõi (SINGLE_CLOSURE_TOKENS hoặc CLOSURE_PHRASES).
 */
export function isClosureIntent(text: string | null | undefined): boolean {
  if (!text) return false;
  const raw = text.trim();
  if (!raw || raw.length > MAX_CHARS || raw.includes('?')) return false;

  const normalized = raw.normalize('NFC').toLowerCase();
  const tokens = tokenize(raw);
  if (tokens.length === 0 || tokens.length > MAX_TOKENS) return false;

  // Ngoại lệ an toàn: "không có gì" / "không sao" là câu lịch sự đáp lại cảm ơn, không coi 'không' / 'sao' là câu hỏi/vấn đề
  const isPoliteNothing = normalized.includes('không có gì') || normalized.includes('khong co gi');
  const isPoliteNoProblem = normalized.includes('không sao') || normalized.includes('khong sao');

  // Kiểm tra từ khóa nghi vấn / khiếu nại (Fail-closed)
  for (const t of tokens) {
    if (PROBLEM_OR_INQUIRY_TOKENS.has(t)) {
      if ((t === 'không' || t === 'khong') && (isPoliteNothing || isPoliteNoProblem)) {
        continue;
      }
      if (t === 'sao' && isPoliteNoProblem) {
        continue;
      }
      return false;
    }
  }

  // Kiểm tra cụm từ closure
  for (const phrase of CLOSURE_PHRASES) {
    if (normalized.includes(phrase)) {
      return true;
    }
  }

  // Kiểm tra token đơn (như "ok", "thanks", "bye")
  if (tokens.length <= 4 && tokens.some((t) => SINGLE_CLOSURE_TOKENS.has(t))) {
    return true;
  }

  return false;
}
