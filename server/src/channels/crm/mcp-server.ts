#!/usr/bin/env node
// CRM MCP Server — 9 tools for agent tool execution
// Spawned by Claude CLI via --mcp-config, communicates via stdio

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import { matchGemralUser, enrichWithGemralData } from './gemral-bridge.js';

// Initialize Supabase — same config as channels/zalo-personal/supabase.ts
const supabaseUrl = process.env.GEMRAL_SUPABASE_URL || 'https://pgfkbcnzqozzkohwbgbk.supabase.co';
const supabaseKey = process.env.GEMRAL_SUPABASE_SERVICE_KEY || '';
if (!supabaseKey) {
  console.error('[MCP] GEMRAL_SUPABASE_SERVICE_KEY not set');
}
const supabase = createClient(supabaseUrl, supabaseKey);

// Shopify config
const shopifyStore = process.env.SHOPIFY_STORE_URL || '';
const shopifyToken = process.env.SHOPIFY_ACCESS_TOKEN || '';

// ─── Tool definitions ───

const TOOLS = [
  {
    name: 'create_order',
    description: 'Tạo đơn hàng mới cho khách hàng trong CRM',
    inputSchema: {
      type: 'object' as const,
      properties: {
        customer_id: { type: 'string', description: 'UUID khách hàng CRM' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              variant_id: { type: 'string' },
              quantity: { type: 'number' },
              price: { type: 'number' },
            },
            required: ['title', 'quantity', 'price'],
          },
          description: 'Danh sách sản phẩm',
        },
        shipping_name: { type: 'string' },
        shipping_phone: { type: 'string' },
        shipping_address: { type: 'string' },
        payment_method: { type: 'string', description: 'chuyen_khoan, cod, momo, vnpay' },
        customer_note: { type: 'string' },
        source_channel: { type: 'string' },
      },
      required: ['customer_id', 'items'],
    },
  },
  {
    name: 'create_shopify_order',
    description:
      'Tạo đơn Shopify THẬT cho khách chốt mua (draft order → complete). MẶC ĐỊNH đơn UNPAID; chỉ đặt mark_paid=true khi ĐÃ xác nhận khách chuyển khoản đủ (có bill) — KHÔNG bao giờ tự suy tiền. KHÁC create_order (chỉ ghi crm_orders, không phải đơn Shopify). variant_id + giá tra product-catalog-index.json.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        variant_id: { type: 'string', description: 'shopify_variant_id (tra product-catalog-index.json)' },
        quantity: { type: 'number', description: 'Số lượng (mặc định 1)' },
        customer_id: { type: 'string', description: 'Shopify customer id (khách cũ). Bỏ trống nếu chỉ có SĐT.' },
        customer_phone: { type: 'string', description: 'SĐT khách — dùng tự tìm customer_id nếu chưa có' },
        shipping_name: { type: 'string' },
        shipping_phone: { type: 'string' },
        shipping_address1: { type: 'string', description: 'Địa chỉ giao đầy đủ' },
        shipping_city: { type: 'string', description: 'Tỉnh/TP' },
        discount_pct: { type: 'number', description: 'Giảm theo % (vd 10)' },
        discount_amount: { type: 'number', description: 'Giảm số tiền cố định VND (thay cho %)' },
        discount_title: { type: 'string', description: 'Nhãn ưu đãi' },
        note: { type: 'string' },
        tags: { type: 'string' },
        mark_paid: {
          type: 'boolean',
          description: 'CHỈ true khi ĐÃ xác nhận khách CK đủ (có bill). Mặc định false = đơn unpaid, nhân viên/chị check + mark paid sau.',
        },
      },
      required: ['variant_id', 'shipping_name', 'shipping_phone', 'shipping_address1'],
    },
  },
  {
    name: 'create_ticket',
    description: 'Tạo phiếu hỗ trợ / escalate vấn đề cho khách',
    inputSchema: {
      type: 'object' as const,
      properties: {
        customer_id: { type: 'string' },
        title: { type: 'string', description: 'Tiêu đề phiếu' },
        description: { type: 'string' },
        category: { type: 'string', description: 'general, product_inquiry, order_issue, payment_issue, shipping_issue, refund_request, technical_support, complaint, feature_request, bug_report, escalation' },
        priority: { type: 'string', description: 'low, medium, high, urgent, critical' },
        source_channel: { type: 'string' },
      },
      required: ['customer_id', 'title'],
    },
  },
  {
    name: 'search_product',
    description: 'Tìm sản phẩm trên Shopify theo từ khóa',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Từ khóa tìm kiếm' },
        limit: { type: 'number', description: 'Số kết quả tối đa (mặc định 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'crm_update',
    description: 'Cập nhật thông tin khách hàng CRM (SĐT, email, status, tags...)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        customer_id: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        status: { type: 'string' },
        display_name: { type: 'string' },
        assigned_agent: { type: 'string' },
        internal_notes: { type: 'string' },
        add_tags: { type: 'array', items: { type: 'string' }, description: 'Tên tag cần thêm' },
      },
      required: ['customer_id'],
    },
  },
  {
    name: 'send_email',
    description: 'Gửi email cho khách hàng qua Resend',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Email người nhận' },
        subject: { type: 'string' },
        body: { type: 'string', description: 'Nội dung email (HTML hoặc text)' },
        template: { type: 'string', description: 'Template: thank_you, follow_up, promotion, welcome' },
        customer_id: { type: 'string' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'get_customer_info',
    description: 'Lấy chi tiết khách hàng CRM + Gemral data',
    inputSchema: {
      type: 'object' as const,
      properties: {
        customer_id: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
      },
    },
  },
  {
    name: 'check_course_access',
    description: 'Kiểm tra quyền truy cập khóa học của khách trên Gemral App',
    inputSchema: {
      type: 'object' as const,
      properties: {
        customer_id: { type: 'string', description: 'CRM customer_id' },
        course_id: { type: 'string', description: 'UUID khóa học (tùy chọn)' },
      },
      required: ['customer_id'],
    },
  },
  {
    name: 'link_gemral_account',
    description: 'Liên kết tài khoản chat với tài khoản Gemral App bằng email hoặc SĐT',
    inputSchema: {
      type: 'object' as const,
      properties: {
        customer_id: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
      },
      required: ['customer_id'],
    },
  },
  {
    name: 'search_knowledge',
    description: 'Tìm thông tin trong Knowledge Base (sản phẩm, khóa học, FAQ)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Câu hỏi hoặc từ khóa' },
        collection: { type: 'string', description: 'Collection: products, courses, faq (tùy chọn)' },
        limit: { type: 'number', description: 'Số kết quả (mặc định 3)' },
      },
      required: ['query'],
    },
  },
  // ── 5 NEW shared tools (also available via marker pattern in agent-tools.ts) ──
  {
    name: 'verify_customer_identity',
    description: 'BẮT BUỘC GỌI TRƯỚC khi tra/cập nhật dữ liệu riêng tư của khách. Match ≥ 2/3 fields với DB → unlock các tool gated trong 30 phút. Phải có 2/3: phone, email, order_number (hoặc address).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        phone: { type: 'string', description: 'Số điện thoại khách (vd: 0901234567)' },
        email: { type: 'string', description: 'Email khách' },
        order_number: { type: 'string', description: 'Mã đơn hàng (không cần dấu #)' },
        address: { type: 'string', description: 'Địa chỉ giao hàng (optional, dùng nếu thiếu order#)' },
      },
    },
  },
  {
    name: 'lookup_order_shopify',
    description: 'Tra trạng thái đơn hàng Shopify: fulfillment, tracking, items, shipping address. PRECONDITION: phải verify_customer_identity trước.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        order_number: { type: 'string', description: 'Mã đơn hàng (không cần dấu #)' },
      },
      required: ['order_number'],
    },
  },
  {
    name: 'recall_memory',
    description: 'Tìm trong ReMe memory hội thoại trước đó của khách (semantic search). PRECONDITION: verify_customer_identity.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        customer_id: { type: 'string', description: 'CRM customer_id (auto-inject từ verified state nếu thiếu)' },
        query: { type: 'string', description: 'Câu hỏi semantic search' },
      },
      required: ['query'],
    },
  },
  {
    name: 'kg_lookup_entity',
    description: 'Tra Knowledge Graph entity (sản phẩm, khóa học, khái niệm) theo name hoặc id. PUBLIC tool — không cần verify.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Tên entity (ilike search)' },
        id: { type: 'string', description: 'UUID entity (chính xác)' },
        type: { type: 'string', description: 'Filter: product | course | concept ...' },
      },
    },
  },
  {
    name: 'kg_traverse',
    description: 'Lấy tất cả relations xung quanh 1 entity (sản phẩm liên quan, prerequisite, etc). PUBLIC tool.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_id: { type: 'string', description: 'UUID entity gốc' },
        depth: { type: 'number', description: 'Số bậc traverse (mặc định 1, max 3)' },
      },
      required: ['entity_id'],
    },
  },
  // ── Delegation tools (feature-flagged server-side via PAPERCLIP_DELEGATION_ENABLED) ──
  // Caller context is derived by the server from x-paperclip-run-id header,
  // which the handler reads from PAPERCLIP_RUN_ID env var inherited from the
  // Claude CLI → heartbeat spawn chain (see buildPaperclipEnv in adapter-utils).
  {
    name: 'delegate_to_agent',
    description: 'Giao một subtask cho agent khác (CTO/CMO/CSM…) và chạy song song. Agent mục tiêu sẽ tỉnh dậy qua heartbeat và thực thi. Trả về traceId để dùng với await_delegation. Khi feature flag tắt server trả 503.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target_agent_id: { type: 'string', description: 'UUID của agent mục tiêu (tra từ agents table của company).' },
        task: { type: 'string', description: 'Mô tả rõ ràng công việc cần agent mục tiêu làm. Bao gồm context + tiêu chí hoàn thành.' },
        turn_mode: { type: 'string', description: '"ask" | "do" | "delegate". Mặc định "do".' },
        timeout_ms: { type: 'number', description: 'Thời gian tối đa chờ, tính bằng ms. Default 300000 (5 phút), max 1800000 (30 phút).' },
        caller_issue_id: { type: 'string', description: 'UUID issue cha (optional). Dùng cho cycle detection + depth cap.' },
      },
      required: ['target_agent_id', 'task'],
    },
  },
  {
    name: 'await_delegation',
    description: 'Chờ một hoặc nhiều delegation hoàn thành và trả về kết quả gộp. Blocking poll tối đa timeout_ms, auto-cancel pending khi hết giờ.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        trace_ids: { type: 'array', items: { type: 'string' }, description: 'Danh sách traceId từ delegate_to_agent.' },
        timeout_ms: { type: 'number', description: 'Thời gian tối đa chờ. Default 300000.' },
      },
      required: ['trace_ids'],
    },
  },
];

// ─── Tool handlers ───

export async function handleCreateOrder(args: any): Promise<string> {
  const items = args.items || [];
  if (items.length === 0) {
    return JSON.stringify({ success: false, error: 'Cần ít nhất 1 sản phẩm' });
  }

  const subtotal = items.reduce((sum: number, i: any) => sum + (i.price * i.quantity), 0);
  const total = subtotal + (args.shipping_fee || 0) - (args.discount_amount || 0);

  const { data, error } = await supabase
    .from('crm_orders')
    .insert({
      customer_id: args.customer_id,
      items,
      subtotal,
      total,
      shipping_name: args.shipping_name,
      shipping_phone: args.shipping_phone,
      shipping_address: args.shipping_address,
      payment_method: args.payment_method || 'chuyen_khoan',
      source: 'chat',
      source_channel: args.source_channel,
      customer_note: args.customer_note,
      created_by_agent: 'mcp',
    })
    .select('id, order_number, total')
    .single();

  if (error) {
    return JSON.stringify({ success: false, error: `Lỗi tạo đơn: ${error.message}` });
  }

  // Update customer stats
  await supabase.rpc('increment_customer_stats', {
    p_id: args.customer_id,
    p_orders: 1,
    p_revenue: total,
  });

  // Create interaction record
  await supabase.from('crm_interactions').insert({
    customer_id: args.customer_id,
    interaction_type: 'order_created',
    title: `Đơn hàng ${data.order_number}`,
    content: `${items.length} sản phẩm, tổng ${formatVND(total)}`,
    revenue: total,
    agent_slug: 'mcp',
  });

  return JSON.stringify({
    success: true,
    order_number: data.order_number,
    total: formatVND(total),
    item_count: items.length,
  });
}

// ─── create_shopify_order: đơn Shopify THẬT (draft → complete) ───
// Đọc write-token từ gem-bridge-agent/.env (SHOPIFY_ADMIN_TOKEN) — không cần đổi env fleet.
function getShopifyWriteConf(): { store: string; token: string } {
  let store = process.env.SHOPIFY_STORE_URL || process.env.SHOPIFY_STORE || '';
  let token = process.env.SHOPIFY_ADMIN_TOKEN || '';
  if (!store || !token) {
    const candidates = [
      process.env.GEM_BRIDGE_ENV_PATH,
      'C:/Users/Jennie Chu/Desktop/Projects/crypto-pattern-scanner/gem-bridge-agent/.env',
    ].filter(Boolean) as string[];
    for (const p of candidates) {
      try {
        const txt = fs.readFileSync(p, 'utf-8');
        for (const raw of txt.split(/\r?\n/)) {
          const ln = raw.trim();
          if (!ln || ln.startsWith('#') || !ln.includes('=')) continue;
          const idx = ln.indexOf('=');
          const k = ln.slice(0, idx).trim();
          const v = ln.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
          if (k === 'SHOPIFY_ADMIN_TOKEN' && !token) token = v;
          if (k === 'SHOPIFY_STORE' && !store) store = v;
        }
        if (store && token) break;
      } catch {
        /* file không có → thử ứng viên kế */
      }
    }
  }
  token = token || shopifyToken; // last resort (có thể thiếu write scope)
  store = store || 'yinyang-masters.myshopify.com';
  if (!store.endsWith('myshopify.com')) store = `${store}.myshopify.com`;
  return { store, token };
}

async function shopifyAdmin(
  store: string,
  token: string,
  method: string,
  path: string,
  body?: any,
): Promise<any> {
  const res = await fetch(`https://${store}/admin/api/2024-01${path}`, {
    method,
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Shopify ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}

// Agent gắn tag đơn: lời gọi in-process (agent-tools.ts) truyền slug theo TỪNG lời gọi; tiến trình MCP stdio
// (mỗi agent spawn riêng qua agents/<slug>/mcp.json) đọc `--agent <slug>` — KHÔNG dùng biến môi trường chung.
const CLI_AGENT_SLUG: string | null = (() => {
  const i = process.argv.indexOf('--agent');
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
})();

export async function handleCreateShopifyOrder(args: any, agentSlug?: string): Promise<string> {
  try {
    const variantId = args.variant_id;
    if (!variantId) {
      return JSON.stringify({ success: false, error: 'Thiếu variant_id (tra product-catalog-index.json)' });
    }
    const qty = Number(args.quantity || 1);
    const { store, token } = getShopifyWriteConf();
    if (!token) return JSON.stringify({ success: false, error: 'Thiếu Shopify write token (gem-bridge-agent/.env SHOPIFY_ADMIN_TOKEN)' });

    // resolve customer_id: chỉ nhận Shopify id NUMERIC (tránh CRM uuid lọt vào), else search theo SĐT
    let customerId: number | null = null;
    if (args.customer_id != null && /^\d+$/.test(String(args.customer_id))) {
      customerId = Number(args.customer_id);
    }
    const phone = String(args.customer_phone || args.shipping_phone || '').trim();
    if (!customerId && phone) {
      const d = await shopifyAdmin(store, token, 'GET', `/customers/search.json?query=${encodeURIComponent('phone:' + phone)}`);
      const cs = d.customers || [];
      if (cs.length === 1) customerId = cs[0].id;
      else if (cs.length > 1) {
        return JSON.stringify({ success: false, error: `Nhiều khách khớp SĐT ${phone} — cần customer_id rõ ràng` });
      }
    }

    // Idempotency (BUG-023: side-effect dedup): agent may re-emit the same CALL on a later
    // turn (vd khách gửi bill) → trả đơn đã có thay vì tạo đơn trùng. Cùng khách + cùng
    // variant trong 24h = cùng đơn.
    if (customerId) {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const recent = await shopifyAdmin(
        store, token, 'GET',
        `/orders.json?customer_id=${customerId}&status=any&created_at_min=${encodeURIComponent(since)}&fields=id,order_number,financial_status,total_price,line_items`,
      );
      const dup = (recent.orders || []).find((o: any) =>
        (o.line_items || []).some((li: any) => String(li.variant_id) === String(variantId)));
      if (dup) {
        return JSON.stringify({
          success: true,
          duplicate: true,
          order_number: dup.order_number,
          order_id: dup.id,
          financial_status: dup.financial_status,
          total: dup.total_price,
          note: 'Đơn đã tạo trước đó (<24h) — không tạo thêm.',
        });
      }
    }

    const draft: any = {
      line_items: [{ variant_id: Number(variantId), quantity: qty }],
      use_customer_default_address: false,
      shipping_address: {
        name: args.shipping_name,
        phone: args.shipping_phone || phone,
        address1: args.shipping_address1 || args.shipping_address,
        city: args.shipping_city || '',
        country: 'Vietnam',
      },
      tags: args.tags || `agent-order,chat-order,${agentSlug || CLI_AGENT_SLUG || 'sales-closer'}`,
      source_name: 'chat',
    };
    if (customerId) draft.customer = { id: customerId };
    if (args.note) draft.note = args.note;
    const dTitle = args.discount_title || 'Ưu đãi';
    if (args.discount_pct) {
      draft.applied_discount = { title: dTitle, description: dTitle, value_type: 'percentage', value: Number(args.discount_pct).toFixed(1) };
    } else if (args.discount_amount) {
      draft.applied_discount = { title: dTitle, description: dTitle, value_type: 'fixed_amount', value: String(Math.round(Number(args.discount_amount))) };
    }

    const created = await shopifyAdmin(store, token, 'POST', '/draft_orders.json', { draft_order: draft });
    const did = created.draft_order?.id;
    if (!did) return JSON.stringify({ success: false, error: 'Tạo draft order thất bại' });

    // SAFETY: mark_paid CHỈ khi tường minh true (xác nhận tiền = nhân viên, KHÔNG tự suy tiền).
    const markPaid = args.mark_paid === true || args.mark_paid === 'true';
    const paymentPending = markPaid ? 'false' : 'true';
    const done = await shopifyAdmin(store, token, 'PUT', `/draft_orders/${did}/complete.json?payment_pending=${paymentPending}`);
    const orderId = done.draft_order?.order_id;

    // verify by-effect: đọc lại order thật
    const o = (await shopifyAdmin(store, token, 'GET', `/orders/${orderId}.json`)).order || {};
    return JSON.stringify({
      success: true,
      order_number: o.order_number,
      order_id: orderId,
      financial_status: o.financial_status,
      total: o.total_price,
      currency: o.currency,
      marked_paid: markPaid,
      admin_url: `https://admin.shopify.com/store/${store.split('.')[0]}/orders/${orderId}`,
    });
  } catch (err: any) {
    return JSON.stringify({ success: false, error: `Lỗi tạo đơn Shopify: ${err.message}` });
  }
}

export async function handleCreateTicket(args: any): Promise<string> {
  const { data, error } = await supabase
    .from('crm_tickets')
    .insert({
      customer_id: args.customer_id,
      title: args.title,
      description: args.description,
      category: args.category || 'general',
      priority: args.priority || 'medium',
      source_channel: args.source_channel,
      created_by_agent: 'mcp',
      timeline: [{
        action: 'created',
        by: 'mcp',
        at: new Date().toISOString(),
        note: args.description,
      }],
    })
    .select('id, ticket_number, priority, status')
    .single();

  if (error) {
    return JSON.stringify({ success: false, error: `Lỗi tạo ticket: ${error.message}` });
  }

  // Create interaction
  await supabase.from('crm_interactions').insert({
    customer_id: args.customer_id,
    interaction_type: 'ticket_created',
    title: `Ticket ${data.ticket_number}: ${args.title}`,
    agent_slug: 'mcp',
  });

  // If escalation priority, post to War Room
  if (args.priority === 'urgent' || args.priority === 'critical') {
    await supabase.from('war_room_messages').insert({
      channel_id: await getWarRoomChannelId('general'),
      sender_type: 'system',
      sender_name: 'CRM Bot',
      content: `🚨 Ticket KHẨN CẤP: ${data.ticket_number} — ${args.title} (${args.priority})`,
      metadata: { ticket_id: data.id },
    }).then(undefined, () => { /* War Room optional */ });
  }

  return JSON.stringify({
    success: true,
    ticket_number: data.ticket_number,
    priority: data.priority,
    status: data.status,
  });
}

export async function handleSearchProduct(args: any): Promise<string> {
  if (!shopifyStore || !shopifyToken) {
    return JSON.stringify({ success: false, error: 'Shopify chưa cấu hình' });
  }

  const limit = args.limit || 5;
  const url = `https://${shopifyStore}/admin/api/2024-01/products.json?title=${encodeURIComponent(args.query)}&limit=${limit}`;

  try {
    const res = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': shopifyToken },
    });

    if (!res.ok) {
      return JSON.stringify({ success: false, error: `Shopify API lỗi: ${res.status}` });
    }

    const json = await res.json() as { products: any[] };
    const products = (json.products || []).map((p: any) => ({
      id: p.id,
      title: p.title,
      price: p.variants?.[0]?.price,
      variant_id: p.variants?.[0]?.id,
      status: p.status,
      image: p.image?.src,
      inventory: p.variants?.[0]?.inventory_quantity,
    }));

    return JSON.stringify({ success: true, products, count: products.length });
  } catch (err: any) {
    return JSON.stringify({ success: false, error: `Lỗi kết nối Shopify: ${err.message}` });
  }
}

export async function handleCRMUpdate(args: any): Promise<string> {
  const updates: Record<string, any> = {};
  if (args.phone) updates.phone = args.phone;
  if (args.email) updates.email = args.email;
  if (args.status) updates.status = args.status;
  if (args.display_name) updates.display_name = args.display_name;
  if (args.assigned_agent) updates.assigned_agent = args.assigned_agent;
  if (args.internal_notes) updates.internal_notes = args.internal_notes;

  if (Object.keys(updates).length > 0) {
    updates.updated_at = new Date().toISOString();
    const { error } = await supabase
      .from('crm_customers')
      .update(updates)
      .eq('id', args.customer_id);

    if (error) {
      return JSON.stringify({ success: false, error: `Lỗi cập nhật: ${error.message}` });
    }
  }

  // Handle tags
  if (args.add_tags?.length > 0) {
    for (const tagName of args.add_tags) {
      const { data: tag } = await supabase
        .from('crm_tags')
        .select('id')
        .eq('name', tagName)
        .maybeSingle();

      if (tag) {
        await supabase.from('crm_customer_tags')
          .upsert({ customer_id: args.customer_id, tag_id: tag.id, tagged_by: 'agent' });
      }
    }
  }

  return JSON.stringify({
    success: true,
    updated_fields: Object.keys(updates),
    tags_added: args.add_tags || [],
  });
}

export async function handleSendEmail(args: any): Promise<string> {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    return JSON.stringify({ success: false, error: 'Resend API key chưa cấu hình' });
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'GEM Partnership <partnership@gemral.com>',
        to: [args.to],
        subject: args.subject,
        html: args.body,
      }),
    });

    const result = await res.json() as { id?: string; message?: string };

    if (!res.ok) {
      return JSON.stringify({ success: false, error: `Lỗi gửi email: ${result.message}` });
    }

    // Track in CRM
    if (args.customer_id) {
      await supabase.from('crm_customers')
        .update({
          // emails_sent will use increment later
          last_email_at: new Date().toISOString(),
        })
        .eq('id', args.customer_id);

      await supabase.from('crm_interactions').insert({
        customer_id: args.customer_id,
        interaction_type: 'email_sent',
        title: args.subject,
        content: args.body.substring(0, 500),
        agent_slug: 'mcp',
      });
    }

    return JSON.stringify({ success: true, email_id: result.id });
  } catch (err: any) {
    return JSON.stringify({ success: false, error: `Lỗi gửi email: ${err.message}` });
  }
}

export async function handleGetCustomerInfo(args: any): Promise<string> {
  let query = supabase.from('crm_customers').select('*');

  if (args.customer_id) {
    query = query.eq('id', args.customer_id);
  } else if (args.phone) {
    query = query.eq('phone', args.phone);
  } else if (args.email) {
    query = query.eq('email', args.email);
  } else {
    return JSON.stringify({ success: false, error: 'Cần customer_id, phone, hoặc email' });
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    return JSON.stringify({ success: false, error: error.message });
  }

  if (!data) {
    return JSON.stringify({ success: false, error: 'Không tìm thấy khách hàng' });
  }

  return JSON.stringify({
    success: true,
    customer: {
      id: data.id,
      display_name: data.display_name,
      phone: data.phone,
      email: data.email,
      status: data.status,
      lead_score: data.lead_score,
      lead_temperature: data.lead_temperature,
      total_orders: data.total_orders,
      total_revenue: data.total_revenue,
      gemral_data: data.gemral_data,
      ai_summary: data.ai_summary,
    },
  });
}

export async function handleCheckCourseAccess(args: any): Promise<string> {
  // Get gemral_user_id from CRM customer
  const { data: customer } = await supabase
    .from('crm_customers')
    .select('gemral_user_id, gemral_data')
    .eq('id', args.customer_id)
    .single();

  if (!customer?.gemral_user_id) {
    return JSON.stringify({
      success: true,
      linked: false,
      message: 'Khách chưa liên kết tài khoản Gemral App',
    });
  }

  let query = supabase
    .from('course_enrollments')
    .select('*, courses(title, slug)')
    .eq('user_id', customer.gemral_user_id);

  if (args.course_id) {
    query = query.eq('course_id', args.course_id);
  }

  const { data: enrollments } = await query;

  return JSON.stringify({
    success: true,
    linked: true,
    gemral_user_id: customer.gemral_user_id,
    enrollments: (enrollments || []).map((e: any) => ({
      course_title: e.courses?.title,
      enrolled_at: e.enrolled_at,
      progress: e.progress_percentage || 0,
      completed: e.completed_at != null,
    })),
  });
}

export async function handleLinkGemral(args: any): Promise<string> {
  const { customer_id, email, phone } = args;

  if (!email && !phone) {
    return JSON.stringify({ success: false, error: 'Cần email hoặc SĐT để liên kết' });
  }

  // Persist the contact info first — enrichWithGemralData reads crm_customers.email
  // to also pull Shopify orders for this customer.
  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  if (email) patch.email = String(email).toLowerCase();
  if (phone) patch.phone = phone;
  await supabase.from('crm_customers').update(patch).eq('id', customer_id);

  // Single source of truth for matching + enrichment (uniqueness-guarded match,
  // full gemral_data: tiers + courses + affiliate + KOL + Shopify totals).
  const gemralId = await matchGemralUser(phone, email);
  if (!gemralId) {
    return JSON.stringify({
      success: false,
      error: 'Không tìm thấy tài khoản Gemral khớp duy nhất (hoặc khớp nhiều tài khoản — cần kiểm tra thủ công).',
    });
  }

  const gemralData = await enrichWithGemralData(customer_id, gemralId);

  return JSON.stringify({
    success: true,
    gemral_user_id: gemralId,
    tiers: {
      chatbot: gemralData.chatbot_tier,
      scanner: gemralData.scanner_tier,
      course: gemralData.course_tier,
    },
  });
}

// ⚠ 2026-07-04: repoint OpenAI text-embedding-3-small (1536) → bge-m3 LOCAL service (1024)
// để KHỚP kb_chunks vector(1024). Fail-fast khi service down (KHÔNG zero-vector 1536 → dim
// mismatch CÂM). PHẢI đồng bộ với processor.ts getEmbedding (ingest-time). Query MCP local (không tunnel).
async function getEmbedding(text: string): Promise<number[]> {
  const url = process.env.EMBED_SERVICE_URL;
  if (!url) {
    throw new Error('[MCP] EMBED_SERVICE_URL chưa set — bge-m3 embed service (scripts/embed_service.py) phải chạy. KHÔNG fallback zero-vector (dim mismatch câm với kb_chunks vector(1024)).');
  }
  const key = process.env.EMBED_SERVICE_KEY || '';
  const res = await fetch(`${url.replace(/\/$/, '')}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'x-embed-key': key } : {}) },
    body: JSON.stringify({ texts: [text.slice(0, 8000)] }),
  });
  if (!res.ok) throw new Error(`bge-m3 embed error: ${res.status}`);
  const data = await res.json() as { vectors: number[][] };
  return data.vectors[0];
}

export async function handleSearchKnowledge(args: any): Promise<string> {
  const { query, limit = 3, collection } = args;

  if (!query) {
    return JSON.stringify({ success: false, error: 'Thiếu query.' });
  }

  try {
    const embedding = await getEmbedding(query);

    let collectionIds: string[] | null = null;
    
    let mappedType: string | null = null;
    if (collection === 'products' || collection === 'product') mappedType = 'product';
    else if (collection === 'courses' || collection === 'course') mappedType = 'course';
    else if (collection === 'faq') mappedType = 'faq';

    if (mappedType) {
      const { data: cols } = await supabase
        .from('kb_collections')
        .select('id')
        .eq('collection_type', mappedType);
        
      if (cols && cols.length > 0) {
        collectionIds = cols.map(c => c.id);
      }
    }

    const { data: results, error } = await supabase.rpc('search_knowledge', {
      p_query: query,
      p_query_embedding: embedding,
      p_collection_ids: collectionIds,
      p_limit: limit,
    });

    if (error) {
      console.error('[MCP] search_knowledge error:', error);
      return JSON.stringify({ success: false, error: `Lỗi tìm kiếm: ${error.message}` });
    }

    if ((results || []).length > 0) {
      return JSON.stringify({
        success: true,
        source: 'knowledge_base',
        results: results.map((r: any) => ({
          title: r.document_title,
          content: r.content,
          type: r.source_type,
          similarity: r.similarity,
          score: r.combined_score,
        })),
      });
    }

    // Fallback: search shopify_products (FRESH — daily pg_cron sync). Was
    // shopify_product_variants (stale Jan-2026 order-webhook mirror, WRONG prices,
    // and its columns are product_title/price_vnd so this select even errored).
    const { data: products } = await supabase
      .from('shopify_products')
      .select('title, price')
      .eq('status', 'active')
      .ilike('title', `%${query}%`)
      .limit(limit);

    if ((products || []).length > 0) {
      return JSON.stringify({
        success: true,
        source: 'shopify_products (fallback)',
        results: products,
      });
    }

    return JSON.stringify({
      success: true,
      results: [],
      note: 'Không tìm thấy kết quả.',
    });
  } catch (err: any) {
    return JSON.stringify({ success: false, error: `Lỗi RAG: ${err.message}` });
  }
}

// ─── Delegation handlers (HTTP callback to Paperclip server) ───
//
// Unlike the 9 CRM handlers + 5 shared tools above (which hit Supabase
// directly), delegation tools HTTP-call back to the parent Paperclip server
// so routes/delegations.ts can enforce the feature flag, auth, cycle
// detection, rate limit, and company isolation in one place.
//
// Required env (set by claude-local adapter, inherited through Claude CLI):
//   PAPERCLIP_API_URL    http://localhost:3100 (or configured host)
//   PAPERCLIP_RUN_ID     heartbeat run UUID → becomes x-paperclip-run-id

function paperclipApiUrl(): string {
  return process.env.PAPERCLIP_API_URL || 'http://127.0.0.1:3100';
}

function paperclipRunIdHeader(): Record<string, string> {
  const runId = process.env.PAPERCLIP_RUN_ID;
  return runId ? { 'x-paperclip-run-id': runId } : {};
}

async function callPaperclipJson(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const url = `${paperclipApiUrl()}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...paperclipRunIdHeader(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

async function handleDelegateToAgent(args: any): Promise<string> {
  const body: Record<string, unknown> = {
    targetAgentId: args.target_agent_id,
    task: args.task,
  };
  if (args.turn_mode) body.turnMode = args.turn_mode;
  if (args.timeout_ms) body.timeoutMs = args.timeout_ms;
  if (args.caller_issue_id) body.callerIssueId = args.caller_issue_id;

  const { status, body: resBody } = await callPaperclipJson(
    'POST',
    '/api/delegations',
    body,
  );
  if (status === 503) {
    return JSON.stringify({ success: false, error: 'Feature delegation đang tắt (PAPERCLIP_DELEGATION_ENABLED=false).' });
  }
  if (status === 401) {
    return JSON.stringify({ success: false, error: 'Không xác thực được run id — MCP subprocess thiếu PAPERCLIP_RUN_ID env var.' });
  }
  if (status >= 400) {
    const err = (resBody as { error?: string } | null)?.error ?? `HTTP ${status}`;
    return JSON.stringify({ success: false, error: err });
  }
  return JSON.stringify({ success: true, ...(resBody as object) });
}

async function handleAwaitDelegation(args: any): Promise<string> {
  const body: Record<string, unknown> = {
    traceIds: Array.isArray(args.trace_ids) ? args.trace_ids : [],
  };
  if (args.timeout_ms) body.timeoutMs = args.timeout_ms;
  if (body.traceIds instanceof Array && (body.traceIds as unknown[]).length === 0) {
    return JSON.stringify({ success: false, error: 'trace_ids rỗng.' });
  }

  const { status, body: resBody } = await callPaperclipJson(
    'POST',
    '/api/delegations/await',
    body,
  );
  if (status === 503) {
    return JSON.stringify({ success: false, error: 'Feature delegation đang tắt.' });
  }
  if (status >= 400) {
    const err = (resBody as { error?: string } | null)?.error ?? `HTTP ${status}`;
    return JSON.stringify({ success: false, error: err });
  }
  return JSON.stringify({ success: true, ...(resBody as object) });
}

// ─── Helpers ───

function formatVND(n: number): string {
  return new Intl.NumberFormat('vi-VN').format(n || 0) + '₫';
}

async function getWarRoomChannelId(name: string): Promise<string | null> {
  const { data } = await supabase
    .from('war_room_channels')
    .select('id')
    .eq('name', name)
    .maybeSingle();
  return data?.id || null;
}

// ─── MCP Server setup ───

const server = new Server(
  { name: 'crm-tools', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// ── 5 NEW shared tools — single source of truth in crm/agent-tool-handlers.ts ──
import {
  resolveToolContextFromEnv,
  checkIdentityGate,
  handleVerifyCustomerIdentity,
  handleLookupOrderShopify,
  handleRecallMemory,
  handleKgLookupEntity,
  handleKgTraverse,
  type SharedToolResult,
} from './agent-tool-handlers.js';

/** Format a SharedToolResult as a JSON string compatible with MCP `content[].text` */
function formatSharedResult(r: SharedToolResult): string {
  return JSON.stringify({
    success: r.ok,
    summary: r.summary,
    data: r.data || null,
    error: r.error || null,
  });
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: string;

    // For the 5 NEW shared tools, resolve the per-call ToolHandlerContext from
    // env vars (PAPERCLIP_SESSION_KEY etc) so identity gate state is honored
    // even though Claude/Gemini CLI re-spawn this process per request.
    const SHARED_TOOL_NAMES = new Set([
      'verify_customer_identity', 'lookup_order_shopify', 'recall_memory',
      'kg_lookup_entity', 'kg_traverse',
    ]);

    if (SHARED_TOOL_NAMES.has(name)) {
      const ctx = await resolveToolContextFromEnv(supabase);
      const gateError = checkIdentityGate(name, ctx);
      if (gateError) {
        result = formatSharedResult(gateError);
      } else {
        let shared: SharedToolResult;
        switch (name) {
          case 'verify_customer_identity':
            shared = await handleVerifyCustomerIdentity(args || {}, ctx);
            break;
          case 'lookup_order_shopify':
            shared = await handleLookupOrderShopify(args || {}, ctx);
            break;
          case 'recall_memory':
            shared = await handleRecallMemory(args || {}, ctx);
            break;
          case 'kg_lookup_entity':
            shared = await handleKgLookupEntity(args || {}, ctx);
            break;
          case 'kg_traverse':
            shared = await handleKgTraverse(args || {}, ctx);
            break;
          default:
            shared = { ok: false, summary: `unreachable`, error: 'unreachable' };
        }
        result = formatSharedResult(shared);
      }
    } else {
      // Original 9 MCP handlers
      switch (name) {
        case 'create_order':
          result = await handleCreateOrder(args);
          break;
        case 'create_shopify_order':
          result = await handleCreateShopifyOrder(args);
          break;
        case 'create_ticket':
          result = await handleCreateTicket(args);
          break;
        case 'search_product':
          result = await handleSearchProduct(args);
          break;
        case 'crm_update':
          result = await handleCRMUpdate(args);
          break;
        case 'send_email':
          result = await handleSendEmail(args);
          break;
        case 'get_customer_info':
          result = await handleGetCustomerInfo(args);
          break;
        case 'check_course_access':
          result = await handleCheckCourseAccess(args);
          break;
        case 'link_gemral_account':
          result = await handleLinkGemral(args);
          break;
        case 'search_knowledge':
          result = await handleSearchKnowledge(args);
          break;
        case 'delegate_to_agent':
          result = await handleDelegateToAgent(args);
          break;
        case 'await_delegation':
          result = await handleAwaitDelegation(args);
          break;
        default:
          result = JSON.stringify({ error: `Tool không tồn tại: ${name}` });
      }
    }

    return { content: [{ type: 'text', text: result }] };
  } catch (err: any) {
    console.error(`[MCP] Lỗi tool ${name}:`, err.message);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `Lỗi: ${err.message}` }) }],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MCP] CRM Tools server started');
}

main().catch((err) => {
  console.error('[MCP] Fatal error:', err);
  process.exit(1);
});
