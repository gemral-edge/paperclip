// Shared tool handlers for the 5 NEW tools beyond the original MCP 9.
//
// These are imported by BOTH:
//   - crm/mcp-server.ts        — for Claude/Gemini CLI agents (MCP stdio protocol)
//   - channels/agent-tools.ts  — for Ollama/marker-pattern agents
//
// Single source of truth so 14 tools work identically across all providers.
//
// Identity gate state lives in channel_sessions.metadata and is read/written
// by both sides through the Supabase service role.

import type { SupabaseClient } from '@supabase/supabase-js';
import { MemoryService } from './memory-service.js';
import { matchGemralUser, enrichWithGemralData } from './gemral-bridge.js';

const memoryService = new MemoryService();

// ─────────────────────────────────────────────────────────────────────────────
// Context shape
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolHandlerContext {
  supabase: SupabaseClient;
  /** Required so handlers can scope queries + log audit. */
  agentSlug: string;
  /** session_key from channel_sessions; used for identity gate persistence. */
  sessionKey: string;
  /** Verified customer_id (UUID). null if identity gate not yet passed. */
  verifiedCustomerId: string | null;
  /** Inbound channel name for audit. */
  channelName: string | null;
}

export interface SharedToolResult {
  ok: boolean;
  /** Vietnamese summary fed back to LLM as observation */
  summary: string;
  /** Optional structured data — for audit, not shown to LLM */
  data?: unknown;
  error?: string;
}

/**
 * Resolve a fresh ToolHandlerContext from env vars + DB.
 *
 * Used by mcp-server.ts (Claude/Gemini path) where the MCP subprocess inherits
 * env vars from the parent Node process spawning Claude. The parent (router.ts
 * runViaClaude/runViaGemini) sets:
 *   PAPERCLIP_AGENT_SLUG=<slug>
 *   PAPERCLIP_SESSION_KEY=<sessionKey>
 *   PAPERCLIP_CHANNEL_NAME=<channelName>
 */
export async function resolveToolContextFromEnv(supabase: SupabaseClient): Promise<ToolHandlerContext> {
  const agentSlug = process.env.PAPERCLIP_AGENT_SLUG || 'unknown';
  const sessionKey = process.env.PAPERCLIP_SESSION_KEY || '';
  const channelName = process.env.PAPERCLIP_CHANNEL_NAME || null;

  let verifiedCustomerId: string | null = null;
  if (sessionKey) {
    try {
      const { data } = await supabase
        .from('channel_sessions')
        .select('metadata')
        .eq('session_key', sessionKey)
        .maybeSingle();
      const meta = (data?.metadata || {}) as any;
      const verifiedAt = meta.verified_at ? new Date(meta.verified_at).getTime() : 0;
      const ageMs = Date.now() - verifiedAt;
      const VERIFY_TTL_MS = 30 * 60 * 1000;
      if (meta.verified_customer_id && ageMs < VERIFY_TTL_MS) {
        verifiedCustomerId = meta.verified_customer_id;
      }
    } catch (err: any) {
      console.warn(`[shared-tools] Failed to read session ${sessionKey}: ${err.message}`);
    }
  }

  return { supabase, agentSlug, sessionKey, verifiedCustomerId, channelName };
}

// ─────────────────────────────────────────────────────────────────────────────
// Identity gate enforcement helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tool names that require a verified customer in the session before they run.
 * Same set used by both providers for consistency.
 */
export const GATED_TOOL_NAMES = new Set([
  'get_customer_info',
  'check_course_access',
  'link_gemral_account',
  'crm_update',
  'send_email',
  'create_order',
  'create_shopify_order',
  'lookup_order_shopify',
  'recall_memory',
]);

export function checkIdentityGate(toolName: string, ctx: ToolHandlerContext): SharedToolResult | null {
  if (!GATED_TOOL_NAMES.has(toolName)) return null; // not gated → allow
  if (ctx.verifiedCustomerId) return null; // already verified → allow
  return {
    ok: false,
    summary: `Tool ${toolName} bị chặn — cần gọi verify_customer_identity trước (yêu cầu khách cung cấp 2/3: SĐT, email, mã đơn).`,
    error: 'identity_gate_locked',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5 NEW tool implementations (not in original MCP 9)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * verify_customer_identity — match phone/email/order# (or address) against
 * shopify_orders + crm_customers. Requires ≥2/3 to pass.
 *
 * On success: persists verified_customer_id into channel_sessions.metadata
 * AND mutates ctx in place so subsequent calls in same loop see new state.
 */
export async function handleVerifyCustomerIdentity(
  args: Record<string, unknown>,
  ctx: ToolHandlerContext,
): Promise<SharedToolResult> {
  const phone = normalizePhone(args.phone as string | undefined);
  const email = normalizeEmail(args.email as string | undefined);
  const orderNumber = (args.order_number as string | undefined)?.replace(/^#/, '').trim() || null;
  const addressHint = (args.address as string | undefined)?.trim() || null;

  const provided = [phone, email, orderNumber || addressHint].filter(Boolean).length;
  if (provided < 2) {
    return {
      ok: false,
      summary: 'Cần ít nhất 2 trong 3: số điện thoại, email, mã đơn hàng (hoặc địa chỉ).',
      error: 'insufficient_inputs',
    };
  }

  let candidates: any[] = [];
  if (orderNumber) {
    const { data } = await ctx.supabase
      .from('shopify_orders')
      .select('id, order_number, email, phone, customer_email, shipping_address, user_id')
      .eq('order_number', orderNumber)
      .limit(5);
    candidates = data || [];
  } else if (email) {
    const { data } = await ctx.supabase
      .from('shopify_orders')
      .select('id, order_number, email, phone, customer_email, shipping_address, user_id')
      .or(`email.ilike.${likeEscape(email)},customer_email.ilike.${likeEscape(email)}`)
      .order('created_at', { ascending: false })
      .limit(5);
    candidates = data || [];
  } else if (phone) {
    const { data } = await ctx.supabase
      .from('shopify_orders')
      .select('id, order_number, email, phone, customer_email, shipping_address, user_id')
      .eq('phone', phone)
      .order('created_at', { ascending: false })
      .limit(5);
    candidates = data || [];
  }

  // Score Shopify-order candidates (possession proof via order#/email/phone/address).
  let best: { score: number; row: any } | null = null;
  for (const row of candidates) {
    let score = 0;
    if (orderNumber && row.order_number === orderNumber) score++;
    if (email && (normalizeEmail(row.email) === email || normalizeEmail(row.customer_email) === email)) score++;
    if (phone && normalizePhone(row.phone) === phone) score++;
    if (addressHint && typeof row.shipping_address === 'object' && row.shipping_address) {
      const addrText = JSON.stringify(row.shipping_address).toLowerCase();
      if (addrText.includes(addressHint.toLowerCase())) score++;
    }
    if (!best || score > best.score) best = { score, row };
  }

  // ALSO verify against the IDENTITY HUB (profiles). A Gemral account holder is a
  // valid identity even with zero Shopify orders — the previous gate ignored
  // profiles entirely, so account-holders who never bought could NEVER verify.
  // Counts email + phone on the SAME profile (both factors must resolve to one
  // entity → no cross-identity mixing). Email is unique + lowercase in profiles;
  // phone matched in both 0xxx / +84xxx forms.
  let bestProfile: { score: number; id: string } | null = null;
  if (email || phone) {
    const orFilters: string[] = [];
    if (email) orFilters.push(`email.ilike.${likeEscape(email)}`);
    if (phone) {
      const altPhone = phone.startsWith('0') ? '+84' + phone.slice(1) : phone;
      orFilters.push(`phone.eq.${phone}`);
      if (altPhone !== phone) orFilters.push(`phone.eq.${altPhone}`);
    }
    const { data: profs } = await ctx.supabase
      .from('profiles')
      .select('id, email, phone')
      .or(orFilters.join(','))
      .limit(5);
    for (const p of profs || []) {
      let score = 0;
      if (email && normalizeEmail(p.email) === email) score++;
      if (phone && normalizePhone(p.phone) === phone) score++;
      if (!bestProfile || score > bestProfile.score) bestProfile = { score, id: p.id };
    }
  }

  const orderScore = best?.score ?? 0;
  const profileScore = bestProfile?.score ?? 0;
  const topScore = Math.max(orderScore, profileScore);

  if (topScore < 2) {
    return {
      ok: false,
      summary: 'Không khớp đủ 2 thông tin. Vui lòng kiểm tra lại SĐT, email, mã đơn hàng — hoặc dùng email + SĐT đã đăng ký tài khoản Gemral.',
      error: 'no_match',
    };
  }

  // Prefer the profile identity when it scored at least as high → link the hub directly.
  const matchedProfileId = bestProfile && profileScore >= orderScore ? bestProfile.id : null;

  // ── Canonical row = the chat's crm_customer (resolved from sender_id in
  // consumer.ts and stored on channel_sessions.customer_id). Previously this
  // handler only set a 30-min gate flag keyed off the Shopify order id/user_id
  // and NEVER persisted the proven email/phone or linked the Gemral account →
  // gemral_user_id stayed null forever and the agent could not see the
  // customer's real profile/courses/orders. Fix: write identity back here.
  let chatCustomerId: string | null = null;
  if (ctx.sessionKey) {
    const { data: sess } = await ctx.supabase
      .from('channel_sessions')
      .select('customer_id')
      .eq('session_key', ctx.sessionKey)
      .maybeSingle();
    chatCustomerId = (sess as any)?.customer_id || null;
  }

  // Fallback ordering when there is no chat customer (e.g. save_contacts off):
  // crm_customers matched by email/phone → Shopify order user_id → order id.
  let customerId: string | null = chatCustomerId;
  if (!customerId && (email || phone)) {
    const filters: string[] = [];
    if (email) filters.push(`email.eq.${email}`);
    if (phone) filters.push(`phone.eq.${phone}`);
    const { data: c } = await ctx.supabase
      .from('crm_customers')
      .select('id')
      .or(filters.join(','))
      .limit(1);
    if (c && c.length > 0) customerId = c[0].id;
  }
  if (!customerId) customerId = best?.row?.user_id || best?.row?.id || matchedProfileId || null;

  // Persist proven identity + link Gemral account onto the chat customer row.
  if (chatCustomerId) {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (email) patch.email = email;       // email first — enrichWithGemralData reads it for Shopify match
    if (phone) patch.phone = phone;
    if (email || phone) {
      await ctx.supabase.from('crm_customers').update(patch).eq('id', chatCustomerId);
    }
    try {
      // Profile matched directly during verify → use it; else resolve by email/phone.
      const gemralId = matchedProfileId || await matchGemralUser(phone, email);
      if (gemralId) await enrichWithGemralData(chatCustomerId, gemralId);
    } catch (err: any) {
      console.warn(`[verify] Gemral link failed (non-blocking): ${err.message}`);
    }
  }

  // Persist verification into channel_sessions — ATOMIC jsonb-merge (RPC) do not clobber
  // purchase_stage / bot_paused / followup_count. Read-merge-write JS cũ dùng snapshot existingMeta
  // cũ → có thể xoá bot_paused nếu owner pause xen giữa (plan 2026-08-10). verified_* là key phẳng.
  if (ctx.sessionKey) {
    await ctx.supabase.rpc('channel_session_merge_meta', {
      p_session_key: ctx.sessionKey,
      p_patch: {
        verified_customer_id: customerId,
        verified_at: new Date().toISOString(),
        verified_via: { phone: !!phone, email: !!email, order_number: !!orderNumber, via_profile: !!matchedProfileId },
      },
    });
  }

  ctx.verifiedCustomerId = customerId;

  return {
    ok: true,
    summary: `Đã xác minh danh tính khách (khớp ${topScore} thông tin${matchedProfileId ? ' qua tài khoản Gemral' : ''}). Có thể tra cứu trong 30 phút.`,
    data: { customer_id: customerId, match_score: topScore, order_number: best?.row?.order_number ?? null, via_profile: !!matchedProfileId },
  };
}

/**
 * Resolve the verified customer's email — used to list their orders and to
 * scope single-order lookups to the owner. Tries crm_customers.email then the
 * linked profiles.email (190 orders carry email, only 3 carry user_id, so
 * email is the real join key).
 */
async function resolveVerifiedEmail(ctx: ToolHandlerContext): Promise<string | null> {
  if (!ctx.verifiedCustomerId) return null;
  const { data: cust } = await ctx.supabase
    .from('crm_customers')
    .select('email, gemral_user_id')
    .eq('id', ctx.verifiedCustomerId)
    .maybeSingle();
  let email = normalizeEmail((cust as any)?.email);
  if (!email && (cust as any)?.gemral_user_id) {
    const { data: prof } = await ctx.supabase
      .from('profiles')
      .select('email')
      .eq('id', (cust as any).gemral_user_id)
      .maybeSingle();
    email = normalizeEmail((prof as any)?.email);
  }
  return email;
}

function formatOrderLine(o: any): string {
  return [
    `#${o.order_number}: ${o.financial_status || 'pending'} / ${o.fulfillment_status || 'chưa giao'}`,
    `${o.total_price || 0} ${o.currency || 'VND'}`,
    o.tracking_number ? `tracking ${o.tracking_number}${o.carrier ? ' (' + o.carrier + ')' : ''}` : '',
  ].filter(Boolean).join(' — ');
}

// Đơn trên web Yinyang mới (commerce core, YC-P5-5 21/10: yinyangmasters.com rời Shopify). Số đơn lõi bắt đầu
// sau đơn Shopify cuối (seq từ 5844, Shopify max 4844) nên tra theo order_number không trùng nhau.
const COMMERCE_ORDER_COLS = 'id, order_number, status, fulfillment_state, total_minor, currency, created_at, paid_at, fulfilled_at, email, shipping_address, livemode';
const ZERO_DECIMAL = new Set(['vnd', 'jpy', 'krw']);

function commerceTotal(o: any): string {
  const cur = String(o.currency || 'usd').toLowerCase();
  const amount = ZERO_DECIMAL.has(cur) ? Number(o.total_minor || 0) : Number(o.total_minor || 0) / 100;
  return `${amount.toLocaleString('en-US')} ${cur.toUpperCase()}`;
}

function formatCommerceLine(o: any): string {
  return `#${o.order_number} (web Yinyang): ${o.status}${o.fulfillment_state ? ' / ' + o.fulfillment_state : ''} — ${commerceTotal(o)}`;
}

async function lookupCommerceOrder(orderNumber: string, ctx: ToolHandlerContext): Promise<SharedToolResult> {
  const { data, error } = await ctx.supabase
    .from('commerce_orders')
    .select(COMMERCE_ORDER_COLS)
    .eq('order_number', Number(orderNumber))
    .eq('livemode', true)
    .limit(1);
  if (error) return { ok: false, summary: `Lỗi DB: ${error.message}`, error: error.message };
  const order = data?.[0];
  if (!order) return { ok: false, summary: `Không tìm thấy đơn hàng #${orderNumber}.`, error: 'not_found' };

  // Cùng luật sở hữu như đơn Shopify: khách đã xác minh chỉ đọc đơn của chính mình.
  const verifiedEmail = await resolveVerifiedEmail(ctx);
  const orderEmail = normalizeEmail(order.email);
  if (verifiedEmail && orderEmail && verifiedEmail !== orderEmail) {
    return {
      ok: false,
      summary: `Đơn #${orderNumber} không thuộc tài khoản đã xác minh. Vui lòng kiểm tra lại mã đơn.`,
      error: 'order_not_owned',
    };
  }

  const { data: items } = await ctx.supabase
    .from('commerce_order_items')
    .select('title_snapshot, qty, kind_snapshot')
    .eq('order_id', order.id);
  const itemText = (items || []).map((it: any) => `${it.title_snapshot || 'sp'} x${it.qty || 1}`).join(', ');

  return {
    ok: true,
    summary: [
      `Đơn #${order.order_number} (web Yinyang): ${order.status}${order.fulfillment_state ? ' / ' + order.fulfillment_state : ''}.`,
      itemText ? `Items: ${itemText}.` : '',
      order.paid_at ? `Thanh toán lúc ${order.paid_at}.` : 'Chưa thanh toán.',
      order.fulfilled_at ? `Đã giao lúc ${order.fulfilled_at}.` : '',
      `Tổng: ${commerceTotal(order)}.`,
    ].filter(Boolean).join(' '),
    data: { ...order, items: items || [] },
  };
}

/**
 * lookup_order_shopify — query shopify_orders + commerce_orders (web Yinyang mới). Identity gate enforced upstream.
 *
 * Mode A (order_number given): return that order, scoped to the verified owner.
 * Mode B (no order_number): list the verified customer's own orders by email —
 *   most chat customers do not remember their order number, so before this the
 *   agent simply could not answer "đơn của tôi đâu rồi?".
 */
export async function handleLookupOrderShopify(
  args: Record<string, unknown>,
  ctx: ToolHandlerContext,
): Promise<SharedToolResult> {
  const orderNumber = (args.order_number as string | undefined)?.replace(/^#/, '').trim() || null;

  // ── Mode B: list the verified customer's own orders by email ──
  if (!orderNumber) {
    const email = await resolveVerifiedEmail(ctx);
    if (!email) {
      return {
        ok: false,
        summary: 'Cần mã đơn hàng, hoặc xác minh email (verify_customer_identity) để xem tất cả đơn của khách.',
        error: 'missing_order_number',
      };
    }
    const { data, error } = await ctx.supabase
      .from('shopify_orders')
      .select('order_number, financial_status, fulfillment_status, tracking_number, carrier, total_price, currency, created_at')
      .or(`email.ilike.${likeEscape(email)},customer_email.ilike.${likeEscape(email)}`)
      .order('created_at', { ascending: false })
      .limit(10);
    if (error) return { ok: false, summary: `Lỗi DB: ${error.message}`, error: error.message };
    const { data: core, error: coreErr } = await ctx.supabase
      .from('commerce_orders')
      .select(COMMERCE_ORDER_COLS)
      .eq('email', email)
      .eq('livemode', true)
      .not('status', 'in', '(pending,expired)') // giỏ bỏ dở / hết hạn không phải đơn của khách
      .order('created_at', { ascending: false })
      .limit(10);
    if (coreErr) return { ok: false, summary: `Lỗi DB: ${coreErr.message}`, error: coreErr.message };
    const lines = [
      ...(core || []).map((o: any) => ({ at: o.created_at, line: formatCommerceLine(o) })),
      ...(data || []).map((o: any) => ({ at: o.created_at, line: formatOrderLine(o) })),
    ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
    if (lines.length === 0) {
      return { ok: true, summary: 'Không tìm thấy đơn hàng nào theo email đã xác minh.', data: { count: 0 } };
    }
    return {
      ok: true,
      summary: `${lines.length} đơn của khách:\n${lines.map((l) => l.line).join('\n')}`,
      data: { shopify: data || [], commerce: core || [] },
    };
  }

  // ── Mode A: specific order number ──
  const { data, error } = await ctx.supabase
    .from('shopify_orders')
    .select('order_number, financial_status, fulfillment_status, tracking_number, tracking_url, carrier, fulfilled_at, paid_at, total_price, currency, shipping_address, line_items, email, customer_email, phone')
    .eq('order_number', orderNumber)
    .limit(1);

  if (error) return { ok: false, summary: `Lỗi DB: ${error.message}`, error: error.message };
  if (!data || data.length === 0) {
    if (/^\d{1,12}$/.test(orderNumber)) return lookupCommerceOrder(orderNumber, ctx);
    return { ok: false, summary: `Không tìm thấy đơn hàng #${orderNumber}.`, error: 'not_found' };
  }

  const order = data[0];

  // Ownership scope: a verified customer may only read their own order. If we
  // can resolve their email AND the order carries a different email, deny — this
  // stops a verified customer probing other people's order numbers (plan risk #1).
  const verifiedEmail = await resolveVerifiedEmail(ctx);
  const orderEmail = normalizeEmail(order.email) || normalizeEmail(order.customer_email);
  if (verifiedEmail && orderEmail && verifiedEmail !== orderEmail) {
    return {
      ok: false,
      summary: `Đơn #${orderNumber} không thuộc tài khoản đã xác minh. Vui lòng kiểm tra lại mã đơn.`,
      error: 'order_not_owned',
    };
  }

  const items = Array.isArray(order.line_items)
    ? order.line_items.map((it: any) => `${it.title || it.name || 'sp'} x${it.quantity || 1}`).join(', ')
    : '';

  return {
    ok: true,
    summary: [
      `Đơn #${order.order_number}: ${order.financial_status || 'pending'} / ${order.fulfillment_status || 'chưa giao'}.`,
      items ? `Items: ${items}.` : '',
      order.tracking_number ? `Tracking: ${order.tracking_number}${order.carrier ? ' (' + order.carrier + ')' : ''}.` : '',
      order.tracking_url ? `Link tracking: ${order.tracking_url}.` : '',
      order.fulfilled_at ? `Đã giao lúc ${order.fulfilled_at}.` : '',
      `Tổng: ${order.total_price || 0} ${order.currency || 'VND'}.`,
    ].filter(Boolean).join(' '),
    data: order,
  };
}

/**
 * recall_memory — call ReMe via MemoryService.retrieve()
 */
export async function handleRecallMemory(
  args: Record<string, unknown>,
  ctx: ToolHandlerContext,
): Promise<SharedToolResult> {
  const customerId = (args.customer_id as string | undefined) || ctx.verifiedCustomerId;
  const query = (args.query as string | undefined)?.trim();
  if (!customerId) return { ok: false, summary: 'Thiếu customer_id.', error: 'missing_customer_id' };
  if (!query) return { ok: false, summary: 'Thiếu query.', error: 'missing_query' };

  const memText = await memoryService.retrieve(customerId, query);
  if (!memText) {
    return { ok: true, summary: 'Không tìm thấy memory liên quan.', data: { count: 0 } };
  }
  return { ok: true, summary: memText.substring(0, 1500), data: { raw: memText } };
}

/**
 * kg_lookup_entity — query kg_entities by name OR id.
 */
export async function handleKgLookupEntity(
  args: Record<string, unknown>,
  ctx: ToolHandlerContext,
): Promise<SharedToolResult> {
  const id = args.id as string | undefined;
  const name = args.name as string | undefined;
  const type = args.type as string | undefined;

  if (!id && !name) {
    return { ok: false, summary: 'Thiếu id hoặc name.', error: 'missing_input' };
  }

  let q = ctx.supabase.from('kg_entities').select('id, name, entity_type, description, properties').limit(5);
  if (id) q = q.eq('id', id);
  else if (name) q = q.ilike('name', `%${name}%`);
  if (type) q = q.eq('entity_type', type);

  const { data, error } = await q;
  if (error) return { ok: false, summary: `Lỗi KG: ${error.message}`, error: error.message };
  if (!data || data.length === 0) {
    return { ok: false, summary: `Không tìm thấy entity ${name || id}.`, error: 'not_found' };
  }

  const lines = data.map((e: any) => `[${e.entity_type}] ${e.name}: ${e.description || ''}`);
  return { ok: true, summary: lines.join('\n'), data };
}

/**
 * kg_traverse — fetch all relations from a starting entity.
 */
export async function handleKgTraverse(
  args: Record<string, unknown>,
  ctx: ToolHandlerContext,
): Promise<SharedToolResult> {
  const entityId = args.entity_id as string | undefined;
  const depth = Math.min(Number(args.depth) || 1, 3);
  if (!entityId) return { ok: false, summary: 'Thiếu entity_id.', error: 'missing_entity_id' };

  const { data: relations, error } = await ctx.supabase
    .from('kg_relations')
    .select('source_entity_id, target_entity_id, relation_type, properties')
    .or(`source_entity_id.eq.${entityId},target_entity_id.eq.${entityId}`)
    .limit(50);

  if (error) return { ok: false, summary: `Lỗi KG: ${error.message}`, error: error.message };
  if (!relations || relations.length === 0) {
    return { ok: true, summary: 'Không có relations nào.', data: { count: 0, depth } };
  }

  const lines = relations.map((r: any) => `${r.source_entity_id} —[${r.relation_type}]→ ${r.target_entity_id}`);
  return { ok: true, summary: `Tìm thấy ${relations.length} relations:\n${lines.join('\n')}`, data: relations };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function normalizePhone(p: string | undefined | null): string | null {
  if (!p) return null;
  const digits = p.replace(/\D/g, '');
  if (digits.length === 0) return null;
  if (digits.startsWith('84') && digits.length === 11) return '0' + digits.slice(2);
  if (digits.startsWith('840')) return '0' + digits.slice(3);
  return digits;
}

export function normalizeEmail(e: string | undefined | null): string | null {
  if (!e) return null;
  return e.trim().toLowerCase() || null;
}

/**
 * Escape LIKE/ILIKE metacharacters (`\ % _`) so an email is matched literally.
 * Needed because shopify_orders.email is NOT guaranteed lowercase (verified:
 * mixed-case rows exist) so we match with case-insensitive ILIKE, but ILIKE
 * treats `%`/`_` as wildcards — an email like `a_b@x.com` must not over-match.
 */
export function likeEscape(s: string): string {
  return s.replace(/([\\%_])/g, '\\$1');
}
