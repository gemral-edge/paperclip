// Payment-policy detection (A6/A9) — the sales-closer must never offer COD/Momo or ask the
// customer to choose a payment method (prepay-only). This module is the ENFORCEMENT side of
// the pre-send gate in router.ts; the monitoring probe (audit_cskh.py P-COD) reads the SAME
// patterns from payment-policy.json so there is one source of truth.
//
// Born 2026-08-17 (plan CSKH-SALES-CLOSER-BRAIN): sales-closer offered "chuyển khoản hay
// để khi nhận hàng thanh toán COD" to a customer; Jennie had to take over.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Agent slugs the prepay policy applies to. */
// yinyang-support (14/10, plan CSKH-SPLIT): chốt đơn crystal qua chat cũng trả trước 100% — cùng cổng.
// jennie-support (29/10): chốt đơn đá qua chat kênh Jennie — cùng luật trả trước.
export const PREPAY_POLICY_AGENTS = new Set<string>(['sales-closer', 'yinyang-support', 'edge-sales-closer', 'jennie-support']);

/**
 * Agent KHÔNG CHỦ ĐỘNG bán (14/10, EC-084): jennie-support trả lời fan + đề xuất hợp tác trên kênh thương hiệu
 * cá nhân Jennie; cron chăm sóc không nhắn câu mời mua. 29/10: khách TỰ hỏi đá thì agent tự tư vấn + chốt đơn.
 */
export const NON_SALES_AGENTS = new Set<string>(['jennie-support']);

interface PolicyFile {
  flags: string;
  sentence_split: string;
  allowlist: string[];
  violation: string[];
}

let cached: {
  splitRe: RegExp;
  allow: RegExp[];
  violate: RegExp[];
} | null = null;

function loadPolicy(): NonNullable<typeof cached> {
  if (cached) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = JSON.parse(readFileSync(join(here, 'payment-policy.json'), 'utf-8')) as PolicyFile;
  const flags = raw.flags || 'i';
  cached = {
    splitRe: new RegExp(raw.sentence_split),
    allow: raw.allowlist.map((p) => new RegExp(p, flags)),
    violate: raw.violation.map((p) => new RegExp(p, flags)),
  };
  return cached;
}

/**
 * Return the first sentence of `reply` that offers/accepts COD or asks the customer to pick
 * a payment method, or null if the reply is clean. A sentence matching the allowlist (a
 * legitimate "we don't do COD" explanation, or "pay-first" wording) is never a violation.
 */
export function detectPaymentPolicyViolation(reply: string): string | null {
  if (!reply) return null;
  const { splitRe, allow, violate } = loadPolicy();
  const sentences = reply.split(splitRe).map((s) => s.trim()).filter(Boolean);
  for (const s of sentences) {
    if (allow.some((re) => re.test(s))) continue; // legitimate no-COD / pay-first explanation
    if (violate.some((re) => re.test(s))) return s;
  }
  return null;
}
