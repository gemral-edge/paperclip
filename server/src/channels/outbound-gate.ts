/**
 * outbound-gate.ts — nối Paperclip với cổng KHÔNG-GỌI-KHÔNG-HỌP của repo crypto-pattern-scanner.
 *
 * Luật chị Jennie 15/10/2026: mọi thư gửi ra ngoài (khách/đối tác) CHỈ qua email — cấm đề nghị cuộc gọi,
 * họp, demo, link đặt lịch, khung giờ. Nguồn luật DUY NHẤT: crypto-pattern-scanner/supabase/functions/_shared/
 * outbound-no-call-rules.json (+ outboundNoCallGate.ts đọc nó). Ở đây KHÔNG chép regex — chỉ nạp module.
 * SOP: crypto-pattern-scanner/memory/sops/SOP_engineering_and_ops/SOP-CUSTOMER-FACING-AGENT-PRIVACY.md §7.
 *
 * Nạp động bằng đường dẫn biến (tsc không phân giải) — không làm gãy build Paperclip.
 * Không nạp được ⇒ FAIL-OPEN có tiếng (console.error) để không chặn nhầm CSKH; probe Resend định kỳ
 * (crypto-pattern-scanner/scripts/audit_outbound_resend_sent.py) là lưới thứ hai.
 */
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

type Gate = {
  assertClean: (body: string, subject?: string, context?: string) => { rule: string; snippet: string }[];
  OutboundCallProposalError: new (...a: any[]) => Error;
};

let gatePromise: Promise<Gate | null> | null = null;

function loadGate(): Promise<Gate | null> {
  if (!gatePromise) {
    gatePromise = (async () => {
      try {
        const here = path.dirname(fileURLToPath(import.meta.url));
        const root = process.env.GEMRAL_REPO_ROOT
          || path.resolve(here, '../../../../crypto-pattern-scanner'); // channels → src → server → paperclip → Projects
        const file = path.join(root, 'supabase', 'functions', '_shared', 'outboundNoCallGate.ts');
        return (await import(pathToFileURL(file).href)) as Gate;
      } catch (err: any) {
        console.error('[outbound-gate] KHÔNG nạp được cổng no-call (fail-open):', err?.message);
        return null;
      }
    })();
  }
  return gatePromise;
}

/** Trả `null` = được gửi; trả chuỗi = lý do CHẶN (caller trả lỗi, không gửi). */
export async function checkOutboundEmail(html: string, subject: string, context: string): Promise<string | null> {
  const gate = await loadGate();
  if (!gate) return null;
  try {
    const warns = gate.assertClean(html || '', subject || '', context);
    for (const w of warns) console.warn(`[outbound-gate] WARN ${w.rule}: …${w.snippet}… (${context})`);
    return null;
  } catch (err: any) {
    if (err instanceof gate.OutboundCallProposalError) {
      console.warn(`[outbound-gate] BLOCKED ${context}: ${err.message}`);
      return err.message;
    }
    console.error('[outbound-gate] lỗi bất ngờ khi soi (fail-open):', err?.message);
    return null;
  }
}
