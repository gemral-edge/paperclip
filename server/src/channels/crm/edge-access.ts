// check_edge_access — read-only lookup of the CHATTING customer's Gemral Edge plan.
//
// Scope rules (same spirit as check_course_access / get_customer_info, but stricter):
//   - The tool is identity-gated (GATED_TOOL_NAMES) — customer must be verified first.
//   - When the session has a verified customer, that id WINS over args.customer_id
//     (an agent can never read another customer by passing a different id).
//   - `email` is only an alternative locator for the SAME customer: it must equal the
//     CRM customer's own email / shopify email, otherwise it is refused.
//   - Never returns API keys / hashes / provider ids — only whether keys exist.
//
// Tables (verified via information_schema 29/10): edge_subscriptions, edge_plans,
// edge_subscription_history, edge_api_keys, profiles (scanner tier SSOT).

import type { ToolHandlerContext, SharedToolResult } from './agent-tool-handlers.js';

const HISTORY_LIMIT = 5;

function norm(s: unknown): string {
  return typeof s === 'string' ? s.trim().toLowerCase() : '';
}

export async function handleCheckEdgeAccess(
  args: Record<string, unknown>,
  ctx: ToolHandlerContext,
): Promise<SharedToolResult> {
  const db = ctx.supabase;
  const customerId = ctx.verifiedCustomerId || (args.customer_id as string | undefined) || null;
  const emailArg = norm(args.email);
  if (!customerId) {
    return { ok: false, summary: 'Thiếu customer_id (hoặc chưa verify khách).', error: 'missing_customer_id' };
  }

  const { data: customer, error: cErr } = await db
    .from('crm_customers')
    .select('id, email, shopify_customer_email, gemral_user_id')
    .eq('id', customerId)
    .maybeSingle();
  if (cErr) return { ok: false, summary: `Lỗi tra khách: ${cErr.message}`, error: cErr.message };
  if (!customer) return { ok: false, summary: 'Không tìm thấy khách hàng.', error: 'customer_not_found' };

  const ownEmails = [norm(customer.email), norm(customer.shopify_customer_email)].filter(Boolean);
  if (emailArg && !ownEmails.includes(emailArg)) {
    return {
      ok: false,
      summary: 'Email không khớp với khách đang chat — không tra được. Chỉ tra tài khoản của chính khách này.',
      error: 'email_mismatch',
    };
  }

  let userId: string | null = customer.gemral_user_id || null;
  if (!userId) {
    const lookupEmail = emailArg || ownEmails[0];
    if (lookupEmail) {
      const { data: prof } = await db.from('profiles').select('id').ilike('email', lookupEmail.replace(/[%_\\]/g, '\\$&')).limit(2);
      if (prof && prof.length === 1) userId = prof[0].id;
    }
  }
  if (!userId) {
    return {
      ok: true,
      summary: 'Khách chưa liên kết tài khoản Gemral — dùng link_gemral_account (email đăng ký) trước.',
      data: { linked: false },
    };
  }

  const [subRes, histRes, profRes, keyRes] = await Promise.all([
    db.from('edge_subscriptions')
      .select('plan, status, billing_interval, provider, current_period_end, updated_at')
      .eq('user_id', userId).maybeSingle(),
    db.from('edge_subscription_history')
      .select('plan_before, plan_after, status_before, status_after, reason, changed_at')
      .eq('user_id', userId).order('changed_at', { ascending: false }).limit(HISTORY_LIMIT),
    db.from('profiles')
      .select('scanner_tier, scanner_tier_expires_at')
      .eq('id', userId).maybeSingle(),
    db.from('edge_api_keys')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId).is('revoked_at', null),
  ]);

  const firstErr = subRes.error || histRes.error || profRes.error || keyRes.error;
  if (firstErr) return { ok: false, summary: `Lỗi tra gói Edge: ${firstErr.message}`, error: firstErr.message };

  const sub = subRes.data as any;
  const prof = profRes.data as any;
  const edge = sub
    ? {
        plan: sub.plan,
        status: sub.status,
        is_trial: sub.status === 'trialing',
        billing_interval: sub.billing_interval ?? null,
        payment_provider: sub.provider ?? null,
        current_period_end: sub.current_period_end ?? null,
        last_updated: sub.updated_at ?? null,
      }
    : null;
  const data = {
    linked: true,
    edge_subscription: edge,
    recent_plan_changes: (histRes.data || []).map((h: any) => ({
      from: h.plan_before, to: h.plan_after,
      status_from: h.status_before, status_to: h.status_after,
      reason: h.reason, at: h.changed_at,
    })),
    scanner_tier: prof?.scanner_tier ?? null,
    scanner_tier_expires_at: prof?.scanner_tier_expires_at ?? null,
    has_active_api_key: (keyRes.count ?? 0) > 0,
  };

  const summary = edge
    ? `Gói Edge: ${edge.plan} (${edge.status}${edge.is_trial ? ', đang dùng thử' : ''}), kỳ ${edge.billing_interval || 'n/a'}, `
      + `hết/gia hạn ${edge.current_period_end || 'n/a'}. Scanner tier: ${data.scanner_tier || 'n/a'}. `
      + `API key: ${data.has_active_api_key ? 'có' : 'không'}. Đổi gói gần nhất: ${data.recent_plan_changes.length} bản ghi.`
    : `Không có gói Edge trả phí. Scanner tier: ${data.scanner_tier || 'n/a'}. API key: ${data.has_active_api_key ? 'có' : 'không'}.`;
  return { ok: true, summary, data };
}
