// GEM-1126 — lời chào dự phòng khi agent trả RỖNG với tin CHÀO HỎI NGẮN của khách (DM).
//
// Gốc: khách fb-jennie nhắn "Hi Em" 01/10, agent sales-closer chạy ~11' rồi trả rỗng (provider timeout)
// → consumer im lặng theo thiết kế, ticket mở nhưng không ai trả lời >22h. Chào hỏi là loại tin duy nhất
// mà một câu cố định LUÔN đúng ngữ cảnh (không giá, không cam kết, không dữ kiện) → cho phép ngoại lệ HẸP
// của quy tắc "không gửi canned fallback". Mọi tin khác (có câu hỏi/số/từ lạ) vẫn im lặng + báo người.
//
// Thuần hàm, không side-effect → test offline được (xem __tests__/greeting-fallback.test.ts).

/** Từ chào / gọi cửa / đuôi lịch sự (đứng cạnh từ chào gốc). */
const GREETING_TOKENS = new Set([
  'hi', 'hello', 'hey', 'helo', 'hallo', 'alo', 'allo', 'ê',
  'chào', 'chao', 'xin', 'good', 'morning', 'afternoon', 'evening',
  'ơi', 'oi', 'ạ', 'ạh', 'ah', 'dạ', 'da', 'nhé', 'nha', 'nhe',
  'có', 'ai', 'không', 'khong', 'đó', 'đây',
]);

/** Từ xưng hô / đối tượng (chỉ hợp lệ khi đi kèm từ chào gốc, không tự đứng một mình). */
const ADDRESS_TOKENS = new Set([
  'em', 'e', 'anh', 'a', 'chị', 'chi', 'c', 'bạn', 'ban', 'b', 'mình', 'minh',
  'shop', 'ad', 'admin', 'page', 'mọi', 'người', 'mn', 'mng', 'cả', 'nhà',
  'there', 'all', 'everyone', 'bác', 'cô', 'chú', 'sếp', 'gemral', 'jennie', 'cậu',
]);

/** Từ chào "gốc" — phải có ÍT NHẤT 1 từ trong nhóm này (loại tin chỉ có "ạ nhé" / "có không"). */
const CORE_GREETING = new Set([
  'hi', 'hello', 'hey', 'helo', 'hallo', 'alo', 'allo', 'ê', 'chào', 'chao', 'good', 'ơi', 'oi',
]);

/** Tin chào thuần tiếng Anh → trả lời tiếng Anh. */
const ENGLISH_ONLY = new Set(['hi', 'hello', 'hey', 'good', 'morning', 'afternoon', 'evening', 'there', 'all', 'everyone']);

const MAX_TOKENS = 6;
const MAX_CHARS = 30;

function tokenize(text: string): string[] {
  return text
    .normalize('NFC')
    .toLowerCase()
    // bỏ dấu câu / emoji / ký hiệu, giữ chữ + số (số sẽ làm tin KHÔNG còn là chào thuần)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * True nếu `text` CHỈ là lời chào/gọi ngắn ("Hi Em", "xin chào shop ạ", "alo", "Hello 👋").
 * Fail-closed: có chữ số, dấu hỏi, từ lạ, hoặc quá dài → false (người xử lý như cũ).
 */
export function isShortGreeting(text: string | null | undefined): boolean {
  if (!text) return false;
  const raw = text.trim();
  if (!raw || raw.length > MAX_CHARS || raw.includes('?')) return false;
  const tokens = tokenize(raw);
  if (tokens.length === 0 || tokens.length > MAX_TOKENS) return false;
  if (!tokens.every((t) => GREETING_TOKENS.has(t) || ADDRESS_TOKENS.has(t))) return false;
  return tokens.some((t) => CORE_GREETING.has(t));
}

/** Câu chào cố định — KHÔNG giá/cam kết/dữ kiện; trung tính giới tính khách ("mình"). */
export function buildGreetingFallback(text: string): string {
  const tokens = tokenize(text);
  const english = tokens.length > 0 && tokens.every((t) => ENGLISH_ONLY.has(t));
  if (english) {
    return 'Hello! Thanks for reaching out — we have received your message. How can we help you today?';
  }
  return 'Dạ em chào mình ạ! Em đã nhận được tin nhắn của mình rồi. Mình cần em hỗ trợ gì, mình nhắn giúp em nhé ạ.';
}
