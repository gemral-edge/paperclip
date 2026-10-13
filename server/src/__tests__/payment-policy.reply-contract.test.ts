// Payment-policy gate (A6) — sales-closer must never offer COD/Momo or ask the customer to
// pick a payment method (prepay-only). Born from the Hồ Thị Mỹ Huệ incident 2026-08-17 where
// the agent said "chuyển khoản … hay để khi nhận hàng thanh toán COD".
//
// This test IS the gate: the 6 violation + 6 valid cases mirror A6 in the plan. Adding a new
// pattern to payment-policy.json requires adding a case here. Wired into `test:reply-contract`.

import { describe, expect, it } from 'vitest';
import { detectPaymentPolicyViolation } from '../channels/payment-policy.js';

describe('detectPaymentPolicyViolation — must FLAG COD/method-choice offers', () => {
  const violations = [
    // 3 real sentences from the 2026-08-17 incident:
    'Phần 1.440.000đ này chị Huệ muốn chuyển khoản tiếp qua tài khoản VCB lúc nãy hay để khi nhận hàng thanh toán COD cho tiện vậy chị?',
    'Phần 1.440.000đ còn lại bên em sẽ để thu COD khi giao hàng đến nơi cho chị tiện nhé ạ.',
    'Khoản 1.440.000đ còn lại này chị Huệ muốn chuyển khoản nốt hay để khi nhận hàng thanh toán COD cho tiện vậy chị?',
    'Chị muốn thanh toán Momo hay chuyển khoản?',
    'Bên em ship COD được nha chị.',
    'Chị nhận hàng rồi thanh toán cũng được ạ.',
  ];
  for (const v of violations) {
    it(`flags: ${v.slice(0, 45)}…`, () => {
      expect(detectPaymentPolicyViolation(v)).not.toBeNull();
    });
  }
});

describe('detectPaymentPolicyViolation — must NOT flag legitimate no-COD / pay-first replies', () => {
  const valid = [
    'COD bên em chưa hỗ trợ ạ.',
    'Bên em chỉ thanh toán trước, COD thì chưa áp dụng.',
    'Dạ, do đá phong thuỷ cần khai quang, thanh tẩy riêng cho từng khách đặt trước khi ship, nên cần thanh toán trước rồi nhân viên bên em mới tiến hành đóng gói và giao hàng được ạ.',
    'Em gửi chị thông tin chuyển khoản ạ. Ngân hàng: Vietcombank. Số tài khoản: 107428 6868. Tên tài khoản: CT TNHH GEM CAPITAL HOLDING.',
    'Chị chuyển xong chụp bill giúp em để em lên đơn ship sớm cho chị nhé.',
    'Bên em không ship COD, chị thông cảm nha.',
  ];
  for (const v of valid) {
    it(`allows: ${v.slice(0, 45)}…`, () => {
      expect(detectPaymentPolicyViolation(v)).toBeNull();
    });
  }
});

// 14/10 (plan CSKH-SPLIT): yinyang-support trả lời khách web nói tiếng Anh → cổng phải hiểu câu tiếng Anh.
describe('detectPaymentPolicyViolation — English (yinyang-support)', () => {
  const bad = [
    'Would you like to pay by bank transfer or cash on delivery?',
    'You can pay when you receive the crystal.',
    'We could arrange COD for you.',
    'Payment on delivery is fine too.',
  ];
  for (const v of bad) {
    it(`flags: ${v}`, () => {
      expect(detectPaymentPolicyViolation(v)).not.toBeNull();
    });
  }
  const ok = [
    "We don't offer cash on delivery, payment is upfront.",
    'You can pay by card on the checkout page or with VietQR.',
    'Here is the link to the journal.',
  ];
  for (const v of ok) {
    it(`allows: ${v}`, () => {
      expect(detectPaymentPolicyViolation(v)).toBeNull();
    });
  }
});
