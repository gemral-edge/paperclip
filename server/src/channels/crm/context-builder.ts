// CRM Context Builder — builds customer context block for agent prompt injection

import { supabase } from '../zalo-personal/supabase.js';
import { MemoryService } from './memory-service.js';
import { computePaymentSignals, type PaymentSignals } from '../session-history-util.js';
import type { SessionMessage } from '../types.js';

const memoryService = new MemoryService();

export class ContextBuilder {

  /**
   * Build a text context block with full customer info for agent prompt.
   * Returns empty string if customer not found.
   *
   * Sprint D10: optional `sessionKey` arg pulls purchase_stage + bot_paused
   * + escalation history from channel_sessions.metadata so the agent knows
   * exactly where in the funnel this customer is across the entire session.
   */
  async build(customerId: string, sessionKey?: string, history?: SessionMessage[]): Promise<string> {
    // 1. Customer profile
    const { data: c } = await supabase
      .from('crm_customers')
      .select('*')
      .eq('id', customerId)
      .single();

    if (!c) return '';

    // 2. Recent orders (last 3)
    const { data: orders } = await supabase
      .from('crm_orders')
      .select('order_number, status, total, created_at')
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false })
      .limit(3);

    // 3. Open tickets
    const { data: tickets } = await supabase
      .from('crm_tickets')
      .select('ticket_number, title, priority, status')
      .eq('customer_id', customerId)
      .not('status', 'in', '("resolved","closed")')
      .limit(5);

    // 4. Pinned notes
    const { data: notes } = await supabase
      .from('crm_notes')
      .select('content, created_by, created_at')
      .eq('customer_id', customerId)
      .eq('pinned', true)
      .limit(3);

    // 5. Format helpers
    const formatVND = (n: number) =>
      new Intl.NumberFormat('vi-VN').format(n || 0) + '₫';

    const timeAgo = (d: string) => {
      const ms = Date.now() - new Date(d).getTime();
      if (ms < 3600000) return Math.round(ms / 60000) + ' phút trước';
      if (ms < 86400000) return Math.round(ms / 3600000) + ' giờ trước';
      return Math.round(ms / 86400000) + ' ngày trước';
    };

    // 6. Build context string
    let ctx = `[HỒ SƠ KHÁCH HÀNG — ${c.display_name}]
• Trạng thái: ${c.status} | Lead: ${c.lead_score}/100 (${c.lead_temperature})
• SĐT: ${c.phone || 'Chưa có'} | Email: ${c.email || 'Chưa có'}
• Tổng đơn: ${c.total_orders} | Doanh thu: ${formatVND(c.total_revenue)}
• Lần cuối liên hệ: ${c.last_contact_at ? timeAgo(c.last_contact_at) : 'Lần đầu'}
• Agent phụ trách: ${c.assigned_agent || 'Chưa gán'}`;

    // Tags from CRM (auto-tag từ purchase stage handler hoặc CS manual tags)
    if (Array.isArray(c.ai_tags) && c.ai_tags.length > 0) {
      ctx += `\n• Tags: ${c.ai_tags.join(', ')}`;
    }

    // ── Structured order ledger + money rules (plan CSKH-SALES-CLOSER-BRAIN, RC2/A8) ──
    // Placed BEFORE [TÓM TẮT AI] so the STRUCTURED truth (which orders are paid & closed)
    // outranks the free-text summary. Identity-gated to prevent injecting another
    // customer's orders (Codex F1). Non-blocking.
    try {
      const ledger = await this.buildOrderLedger(c);
      ctx += ledger;
      const signals = computePaymentSignals(history || []);
      ctx += this.buildPaymentRules(signals);
    } catch (err) {
      // Fail-closed toward "0 đã trả": if the ledger can't be built, still print the rules.
      ctx += this.buildPaymentRules({ imagesAfterStk: 0, customerClaimsPaid: false });
    }

    if (c.ai_summary) {
      const dateLabel = c.ai_summary_updated_at
        ? ` — lịch sử tới ${this.fmtDate(c.ai_summary_updated_at)}, KHÔNG phải trạng thái đơn hiện tại`
        : '';
      ctx += `\n\n[TÓM TẮT AI${dateLabel}]\n${c.ai_summary}`;
    }

    // Sprint D10: purchase journey stage + bot_paused state from session metadata
    if (sessionKey) {
      try {
        const { data: sessRow } = await supabase
          .from('channel_sessions')
          .select('metadata')
          .eq('session_key', sessionKey)
          .single();
        const meta = (sessRow?.metadata as Record<string, unknown>) || {};
        const stage = meta.purchase_stage as string | undefined;
        const stageUpdatedAt = meta.purchase_stage_updated_at as string | undefined;
        const followupCount = Number(meta.followup_count || 0);
        const botPaused = meta.bot_paused === true;

        if (stage || followupCount > 0 || botPaused) {
          ctx += '\n\n[PURCHASE JOURNEY STATE]';
          if (stage) ctx += `\n• Stage: ${stage}${stageUpdatedAt ? ` (cập nhật ${timeAgo(stageUpdatedAt)})` : ''}`;
          if (followupCount > 0) {
            ctx += `\n• Đã follow-up ${followupCount} lần`;
            const lastFollowupAt = meta.last_followup_at as string | undefined;
            if (lastFollowupAt) ctx += ` (gần nhất ${timeAgo(lastFollowupAt)})`;
          }
          if (botPaused) {
            ctx += `\n• ⚠️ BOT PAUSED — escalation đang chờ human xử lý`;
          }
        }
      } catch { /* non-blocking */ }
    }

    // Gemral data (enriched by Module G later)
    if (c.gemral_data?.is_app_user) {
      ctx += '\n\n[GEMRAL APP — ĐÃ ĐĂNG KÝ]';
      ctx += `\n• Chatbot: ${c.gemral_data.chatbot_tier} | Scanner: ${c.gemral_data.scanner_tier} | Khóa học: ${c.gemral_data.course_tier}`;
      if ((c.gemral_data.courses_enrolled || []).length > 0) {
        ctx += `\n• Khóa học (${c.gemral_data.total_courses}):`;
        for (const co of c.gemral_data.courses_enrolled) {
          ctx += `\n  — ${co.title}: ${co.progress}% hoàn thành`;
        }
      }
      if (c.gemral_data.is_affiliate) {
        ctx += `\n• CTV ${(c.gemral_data.affiliate_tier || '').toUpperCase()} | Mã: ${c.gemral_data.affiliate_code} | Doanh số: ${formatVND(c.gemral_data.affiliate_total_sales || 0)}`;
      }
    }

    if ((orders || []).length > 0) {
      ctx += '\n\n[ĐƠN HÀNG GẦN ĐÂY]';
      for (const o of orders!) {
        ctx += `\n• ${o.order_number}: ${o.status} — ${formatVND(o.total)} (${timeAgo(o.created_at)})`;
      }
    }

    if ((tickets || []).length > 0) {
      ctx += '\n\n[TICKET ĐANG MỞ]';
      for (const t of tickets!) {
        ctx += `\n• ${t.ticket_number}: [${t.priority}] ${t.title} — ${t.status}`;
      }
    }

    if ((notes || []).length > 0) {
      ctx += '\n\n[GHI CHÚ QUAN TRỌNG]';
      for (const n of notes!) {
        ctx += `\n• ${n.content} (${n.created_by}, ${timeAgo(n.created_at)})`;
      }
    }

    // ReMe memory (non-blocking, timeout 5s)
    const memoryContext = await memoryService.retrieve(customerId, 'recent conversations').catch(() => '');
    if (memoryContext) ctx += memoryContext;

    // Sprint D10: Knowledge Graph entities related to this customer
    // Pulls top 3 entities the KG extractor has linked to this customer in
    // past chats (products mentioned, courses asked about, crystals viewed).
    try {
      const { data: kgEntities } = await supabase
        .from('kg_entities')
        .select('entity_type, entity_name, properties')
        .eq('linked_customer_id', customerId)
        .order('updated_at', { ascending: false })
        .limit(5);

      if (kgEntities && kgEntities.length > 0) {
        ctx += '\n\n[KNOWLEDGE GRAPH — Entities khách đã quan tâm]';
        for (const e of kgEntities) {
          ctx += `\n• ${e.entity_type}: ${e.entity_name}`;
        }
      }
    } catch { /* table may not exist yet — fail silent */ }

    ctx += `\n\n[HƯỚNG DẪN TOOLS]
- Dùng tool "crm_update" để cập nhật thông tin khách
- Dùng tool "create_ticket" nếu cần escalate vấn đề
- Dùng tool "create_order" nếu khách muốn đặt hàng
- Dùng tool "search_product" để tìm sản phẩm Shopify
- Dùng tool "search_knowledge" để tìm thông tin chính xác về sản phẩm/khóa học`;

    return ctx;
  }

  /** DD/MM/YYYY in Asia/Ho_Chi_Minh. */
  private fmtDate(d: string): string {
    const t = new Date(d);
    if (isNaN(t.getTime())) return '?';
    const h = new Date(t.getTime() + 7 * 3600_000);
    const p = (x: number) => String(x).padStart(2, '0');
    return `${p(h.getUTCDate())}/${p(h.getUTCMonth() + 1)}/${h.getUTCFullYear()}`;
  }

  /** Candidate phone forms so `0938…` ⇄ `+84938…` ⇄ `84938…` all match shopify_orders.phone. */
  private normalizePhones(phone?: string | null): string[] {
    if (!phone) return [];
    const digits = phone.replace(/\D/g, '');
    if (!digits) return [];
    const local = digits.startsWith('84') ? '0' + digits.slice(2) : digits.startsWith('0') ? digits : '0' + digits;
    const intl84 = '84' + local.replace(/^0/, '');
    return [...new Set([phone.trim(), digits, local, intl84, '+' + intl84])].filter(Boolean);
  }

  /**
   * Build [SỔ ĐƠN HÀNG] from shopify_orders with an identity provenance gate:
   * shopify_customer_id > email > phone. If the phone/email maps to another active CRM
   * record, or the matched orders span multiple customer emails, skip injection entirely
   * (do NOT leak another customer's orders — Codex F1). Returns the block text.
   */
  private async buildOrderLedger(c: any): Promise<string> {
    const HEAD = '\n\n[SỔ ĐƠN HÀNG — nguồn hệ thống, đây là SỰ THẬT]';
    const SKIP = `${HEAD}\n• Bỏ qua — định danh (SĐT/email) trùng nhiều hồ sơ khách, nhân viên kiểm tra tay.`;
    const email = String(c.email || c.shopify_customer_email || '').trim().toLowerCase();
    const phones = this.normalizePhones(c.phone);
    const shopifyCustId = c.shopify_customer_id;

    // Conflict: same identity on >1 active CRM record → ambiguous, do not inject.
    if (email) {
      const { data } = await supabase.from('crm_customers').select('id')
        .eq('email', email).neq('id', c.id).neq('status', 'churned').limit(1);
      if (data && data.length) return SKIP;
    }
    if (phones.length) {
      const { data } = await supabase.from('crm_customers').select('id')
        .in('phone', phones).neq('id', c.id).neq('status', 'churned').limit(1);
      if (data && data.length) return SKIP;
    }

    const cols = 'order_number, financial_status, fulfillment_status, total_price, created_at, line_items, email, customer_email';
    let rows: any[] = [];
    if (shopifyCustId) {
      const { data } = await supabase.from('shopify_orders').select(cols)
        .eq('shopify_customer_id', shopifyCustId).order('created_at', { ascending: false }).limit(5);
      rows = data || [];
    } else if (email) {
      const [a, b] = await Promise.all([
        supabase.from('shopify_orders').select(cols).eq('email', email).order('created_at', { ascending: false }).limit(5),
        supabase.from('shopify_orders').select(cols).eq('customer_email', email).order('created_at', { ascending: false }).limit(5),
      ]);
      const merged = new Map<string, any>();
      for (const r of [...(a.data || []), ...(b.data || [])]) merged.set(String(r.order_number), r);
      rows = [...merged.values()];
    } else if (phones.length) {
      const { data } = await supabase.from('shopify_orders').select(cols)
        .in('phone', phones).order('created_at', { ascending: false }).limit(5);
      rows = data || [];
    }

    // Đơn web Yinyang mới (commerce core — yinyangmasters.com rời Shopify 21/10): chỉ khớp theo email, đổi về cùng
    // dạng hàng shopify_orders để khối dưới dùng chung. Bỏ giỏ bỏ dở/hết hạn (pending, expired).
    if (email) {
      const { data: core } = await supabase.from('commerce_orders')
        .select('id, order_number, status, fulfillment_state, total_minor, currency, created_at, email')
        .eq('email', email).eq('livemode', true).not('status', 'in', '(pending,expired)')
        .order('created_at', { ascending: false }).limit(5);
      if (core && core.length) {
        const { data: items } = await supabase.from('commerce_order_items')
          .select('order_id, title_snapshot').in('order_id', core.map((o: any) => o.id));
        for (const o of core as any[]) {
          const cur = String(o.currency || '').toLowerCase();
          rows.push({
            order_number: o.order_number,
            financial_status: o.status === 'fulfilled' ? 'paid' : o.status === 'awaiting_transfer' ? 'pending' : o.status,
            fulfillment_status: o.fulfillment_state || (o.status === 'fulfilled' ? 'đã giao' : null),
            total_price: cur === 'vnd' ? o.total_minor : null,
            total_label: cur === 'vnd' ? null : `${(Number(o.total_minor || 0) / 100).toLocaleString('en-US')} ${cur.toUpperCase()}`,
            created_at: o.created_at,
            line_items: (items || []).filter((it: any) => it.order_id === o.id).map((it: any) => ({ title: it.title_snapshot })),
            email: o.email,
          });
        }
      }
    }

    // All matched orders must belong to the SAME customer email; mixed = suspicious → skip.
    const emailSet = new Set(rows.map((r) => String(r.customer_email || r.email || '').toLowerCase()).filter(Boolean));
    if (emailSet.size > 1) return SKIP;

    if (rows.length === 0) {
      return `${HEAD}\n• Chưa có đơn nào trong hệ thống.`;
    }

    rows.sort((x, y) => new Date(y.created_at).getTime() - new Date(x.created_at).getTime());
    const fmtVND = (n: any) => new Intl.NumberFormat('vi-VN').format(Number(n) || 0) + 'đ';
    const payLabel = (s: string) =>
      s === 'paid' ? 'ĐÃ THANH TOÁN' : s === 'pending' ? 'CHƯA THANH TOÁN' : s === 'refunded' ? 'ĐÃ HOÀN' : (s || 'không rõ');
    const itemTitles = (li: any): string => {
      try {
        const arr = Array.isArray(li) ? li : JSON.parse(li || '[]');
        return arr.map((x: any) => x?.title).filter(Boolean).join(', ');
      } catch { return ''; }
    };

    let block = HEAD;
    for (const r of rows.slice(0, 5)) {
      const ship = r.fulfillment_status || 'chưa cập nhật';
      block += `\n• #${r.order_number} — ${this.fmtDate(r.created_at)} — ${itemTitles(r.line_items) || 'sản phẩm'} — ${r.total_label || fmtVND(r.total_price)} — ${payLabel(r.financial_status)} — giao: ${ship}`;
    }
    return block;
  }

  /** [QUY TẮC TIỀN] — prepay-only, no COD, no bill inference (A8). */
  private buildPaymentRules(signals: PaymentSignals): string {
    let b = '\n\n[QUY TẮC TIỀN — BẮT BUỘC]';
    b += '\n- Mỗi dòng trong [SỔ ĐƠN HÀNG] là 1 đơn RIÊNG, ĐÃ KHÉP. Tiền của đơn cũ KHÔNG BAO GIỜ trừ vào đơn mới.';
    b += '\n- Đã trả cho đơn ĐANG CHỐT hôm nay: 0đ. CHỈ nhân viên xác nhận đã nhận tiền — em KHÔNG tự kết luận "đã chuyển / đã nhận được tiền", KHÔNG suy từ lịch sử/ảnh.';
    b += '\n- Mọi đơn thanh toán TRƯỚC 100% qua chuyển khoản (Vietcombank). KHÔNG COD, KHÔNG hỏi "chuyển khoản hay COD/Momo". Đủ tên + SĐT + địa chỉ → gửi thông tin chuyển khoản NGAY. Khách hỏi vì sao/COD → giải thích ngắn theo SOP.';
    if (signals.imagesAfterStk > 0) {
      b += `\n- Trong phiên này khách đã gửi ${signals.imagesAfterStk} ảnh sau khi em gửi số tài khoản — CHƯA PHÂN LOẠI (có thể là bill, có thể ảnh khác). Cảm ơn + "em chuyển bộ phận kiểm tra rồi báo lại chị ngay", KHÔNG nói "đã nhận được tiền".`;
    }
    if (signals.customerClaimsPaid) {
      b += `\n- Khách có BÁO đã chuyển khoản trong phiên này — mới là lời khách, CHƯA xác minh. Trả lời như trên, KHÔNG trừ tiền, chờ nhân viên xác nhận.`;
    }
    return b;
  }
}
