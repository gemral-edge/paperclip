// GEM-1572 / OPS-1021-S1-01-b8b076: Unit test cho bộ phân loại ý định kết thúc cuộc trò chuyện (closure intent).
import { describe, expect, it } from "vitest";
import { isClosureIntent } from "../channels/closure-intent.js";

describe("isClosureIntent", () => {
  describe("Positive cases (các tin kết thúc / cảm ơn / xác nhận hợp lệ)", () => {
    it.each([
      "Ok",
      "ok",
      "oke",
      "oki",
      "okela",
      "ok ạ",
      "dạ ok",
      "ok shop",
      "ok em nhé",
      "ok bạn",
      "ok nha",
      // Sự cố thực tế 20/10 tại fanpage fb-jennie:
      "Ồ vậy mình cảm ơn mình có công việc của mình rồi nhé",
      "Cảm ơn shop nhiều nha",
      "cảm ơn bạn nhé",
      "dạ vâng em cảm ơn",
      "vậy mình cảm ơn",
      "thôi mình cảm ơn nhé",
      "Dạ vâng ạ",
      "vâng ạ",
      "vâng em hiểu rồi",
      "mình rõ rồi nhé",
      "mình biết rồi cảm ơn shop",
      "xong rồi cảm ơn bạn",
      "được rồi nhé",
      "thế thôi cảm ơn em",
      "tạm biệt shop",
      "chúc shop buôn may bán đắt",
      "không có gì nhé",
      "dạ không sao ạ",
      // Tiếng Anh:
      "thanks",
      "thank you",
      "thanks shop",
      "got it",
      "noted",
      "all good",
      "bye",
      "goodbye",
    ])("nhận diện '%s' là closure intent", (text) => {
      expect(isClosureIntent(text)).toBe(true);
    });
  });

  describe("Negative cases (tin có câu hỏi, yêu cầu, khiếu nại, hoặc không phải closure)", () => {
    it.each([
      "",
      "   ",
      "Ok nhưng sao chưa nhận được hàng",
      "Cảm ơn shop kiểm tra giúp mình đơn này",
      "Ok giá bao nhiêu vậy shop?",
      "Ok không shop?",
      "cho mình hỏi giá khóa học",
      "sao chưa ship hàng cho mình",
      "mình muốn hoàn tiền đơn hàng",
      "app bị lỗi rồi em",
      "chuyển khoản stk nào vậy shop",
      "Hi Em",
      "xin chào shop",
      "alo shop ơi",
      "tư vấn giúp mình gói này",
      "mua hàng thế nào",
      "help me with this issue",
      "refund my order please",
      // Quá dài (> 120 ký tự):
      "mình cảm ơn shop rất nhiều vì đã tư vấn nhiệt tình hôm nay nhưng bây giờ mình đang có việc bận gia đình và mình sẽ quay lại sau để đặt hàng khi nào có thời gian rảnh nhé shop",
    ])("KHÔNG coi '%s' là closure intent (Fail-closed)", (text) => {
      expect(isClosureIntent(text)).toBe(false);
    });

    it("null/undefined -> false", () => {
      expect(isClosureIntent(null)).toBe(false);
      expect(isClosureIntent(undefined)).toBe(false);
    });
  });
});
