// Agent tool calling — MCP-to-Marker bridge.
//
// REUSES existing infra:
//   - 9 handlers from crm/mcp-server.ts (create_order, create_ticket, search_product,
//     crm_update, send_email, get_customer_info, check_course_access,
//     link_gemral_account, search_knowledge)
//   - MemoryService (ReMe) from crm/memory-service.ts
//   - kg_entities + kg_relations tables (kg-routes equivalents)
//   - shopify_orders table (no MCP handler exists yet — bridged inline)
//
// Pattern: [[CALL: function_name({"arg":"value"})]]
//
// Why marker pattern instead of Ollama native function calling:
//   - Works with ANY model (Gemma, Claude, Gemini, OpenRouter)
//   - Single source of truth for whitelist (security)
//   - Easy to audit + parse + reject hallucinated functions
//
// Security guarantees:
//   1. WHITELIST: only ALLOWED_TOOLS dispatched; everything else stripped + logged
//   2. IDENTITY GATE: tools that touch private data require verified customer in
//      session state (verify_customer_identity must be called first)
//   3. SCOPE: lookup/update tools are scoped to the verified customer_id
//   4. AUDIT: every call written to agent_tool_audit_log
//   5. RATE LIMIT: enforced upstream (max 10 tool calls / minute / session)

import { supabase } from './zalo-personal/supabase.js';
import {
  handleCreateOrder,
  handleCreateShopifyOrder,
  handleCreateTicket,
  handleSearchProduct,
  handleCRMUpdate,
  handleSendEmail,
  handleGetCustomerInfo,
  handleCheckCourseAccess,
  handleLinkGemral,
  handleSearchKnowledge,
} from './crm/mcp-server.js';
import {
  handleVerifyCustomerIdentity,
  handleLookupOrderShopify,
  handleRecallMemory,
  handleKgLookupEntity,
  handleKgTraverse,
  GATED_TOOL_NAMES,
  type ToolHandlerContext,
  type SharedToolResult,
} from './crm/agent-tool-handlers.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tool whitelist — 14 tools total
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strict whitelist. Anything outside is rejected silently with security warning.
 *
 * Identity-gated tools (require verify_customer_identity first):
 *   get_customer_info, check_course_access, link_gemral_account, crm_update,
 *   send_email, create_order, lookup_order_shopify, recall_memory
 *
 * Public tools (no gate):
 *   search_product, search_knowledge, kg_lookup_entity, kg_traverse, create_ticket,
 *   verify_customer_identity (the gate itself)
 */
export const ALLOWED_TOOLS = [
  // Gate
  'verify_customer_identity',
  // Identity-gated
  'get_customer_info',
  'check_course_access',
  'link_gemral_account',
  'crm_update',
  'send_email',
  'create_order',
  'create_shopify_order',
  'lookup_order_shopify',
  'recall_memory',
  // Public
  'create_ticket',
  'search_product',
  'search_knowledge',
  'kg_lookup_entity',
  'kg_traverse',
] as const;

export type ToolName = (typeof ALLOWED_TOOLS)[number];

export function isAllowedTool(name: string): name is ToolName {
  return (ALLOWED_TOOLS as readonly string[]).includes(name);
}

export function isGatedTool(name: ToolName): boolean {
  return GATED_TOOL_NAMES.has(name);
}

/** Tools whose result the customer reply does not need (write-only side effects). */
const SIDE_EFFECT_ONLY_TOOLS: ReadonlySet<string> = new Set([
  // create_order KHÔNG ở đây: khách cần mã chuyển khoản + QR trong câu trả lời (YSC-004)
  'create_ticket', 'create_shopify_order', 'crm_update', 'send_email',
]);

export function isSideEffectOnlyTool(name: string): boolean {
  return SIDE_EFFECT_ONLY_TOOLS.has(name);
}

/**
 * Parse agent args. Accepts a JSON object, loose `{key:"v"}`, or the prompt contract form
 * `key="v", n=1, flag=true` (sales-closer AGENTS.md) — the latter used to fail JSON.parse
 * and the call was silently dropped.
 */
function parseToolArgs(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return JSON.parse(trimmed.replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":'));
    }
  }
  const args: Record<string, unknown> = {};
  const pairRe = /(\w+)\s*[=:]\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?\d+(?:\.\d+)?|true|false|null)/g;
  let m: RegExpExecArray | null;
  let matched = 0;
  while ((m = pairRe.exec(trimmed)) !== null) {
    matched++;
    const v = m[2];
    if (v.startsWith('"')) args[m[1]] = JSON.parse(v);
    else if (v.startsWith("'")) args[m[1]] = v.slice(1, -1).replace(/\\'/g, "'");
    else args[m[1]] = JSON.parse(v);
  }
  if (!matched) throw new Error('no key=value pairs');
  return args;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool call data structures
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolCall {
  name: ToolName;
  args: Record<string, unknown>;
  raw: string;
}

export interface ToolResult {
  ok: boolean;
  /** Human-readable Vietnamese summary fed back to the LLM as observation */
  summary: string;
  /** Optional structured data — not shown to LLM, only for audit */
  data?: unknown;
  error?: string;
}

export interface ToolExecutionContext {
  agentSlug: string;
  sessionKey: string;
  /** Verified customer_id (UUID) — null if identity gate not yet passed */
  verifiedCustomerId: string | null;
  channelName: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Marker parser:  [[CALL: function_name({"arg":"value"})]]
// ─────────────────────────────────────────────────────────────────────────────

const CALL_MARKER_RE = /\[\[\s*CALL\s*:\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([\s\S]*?)\)\s*\]\]/g;

/**
 * Extract all [[CALL: name(args)]] markers from a reply text.
 * Args must be a JSON object literal: {"key":"value", ...}
 *
 * Returns: { calls, cleanedText }
 *   - cleanedText has all CALL markers stripped
 *   - calls only contains whitelist-validated tool names
 *   - invalid/unknown function names are logged + dropped
 */
export function parseToolCalls(text: string): { calls: ToolCall[]; cleanedText: string } {
  if (!text) return { calls: [], cleanedText: text };

  const calls: ToolCall[] = [];
  const cleanedText = text.replace(CALL_MARKER_RE, (match, name: string, argsRaw: string) => {
    if (!isAllowedTool(name)) {
      console.warn(`[agent-tools] Rejected non-whitelisted call: ${name}() — likely hallucination`);
      return '';
    }

    let args: Record<string, unknown> = {};
    const trimmed = (argsRaw || '').trim();
    try {
      args = parseToolArgs(trimmed);
    } catch (err: any) {
      console.warn(`[agent-tools] Failed to parse args for ${name}(${trimmed.substring(0, 60)}): ${err.message}`);
      return '';
    }

    calls.push({ name: name as ToolName, args, raw: match });
    return '';
  });

  return { calls, cleanedText };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool catalog rendered for the system prompt
// ─────────────────────────────────────────────────────────────────────────────

export function renderToolCatalogForPrompt(_agentSlug: string): string {
  return [
    '',
    '═══ TOOL CATALOG — 13 tools bạn có thể gọi để tra cứu / hành động ═══',
    '',
    '✅ Cú pháp duy nhất: [[CALL: function_name({"arg":"value"})]]',
    '   args là JSON object một dòng. Có thể gọi nhiều tool trong 1 reply.',
    '   Hệ thống sẽ thay marker bằng kết quả thật và đưa lại cho bạn để soạn',
    '   câu trả lời thân thiện cho khách. Bạn KHÔNG cần tự bịa data.',
    '',
    '🔒 IDENTITY GATE — BẮT BUỘC TUÂN THỦ:',
    '   - Trước khi tra/cập nhật dữ liệu RIÊNG TƯ của khách (đơn hàng, tài khoản,',
    '     tier, course enrollment, gửi email cho khách), bạn PHẢI gọi',
    '     verify_customer_identity với ít nhất 2/3: SĐT, email, mã đơn (hoặc địa chỉ).',
    '   - Nếu thiếu thông tin, HỎI khách trước: "Để em tra cứu chính xác,',
    '     chị vui lòng cho em biết SĐT + email (hoặc mã đơn) dùng lúc đặt hàng',
    '     nhé ạ."',
    '   - Tools gated KHÔNG tự động unlock — system sẽ chặn và log nếu bạn',
    '     gọi sớm.',
    '',
    '📋 14 TOOLS AVAILABLE — chỉ dùng đúng tên dưới đây, KHÔNG bịa tên khác:',
    '',
    '── [GATE] ──',
    '1. verify_customer_identity({"phone":"0901234567","email":"a@b.com","order_number":"4766"})',
    '   → Verify danh tính. Match ≥ 2/3 fields với DB. Pass: unlock gated tools',
    '     trong 30 phút. Fail: trả về error → yêu cầu khách kiểm tra lại.',
    '',
    '── [INFO TRA CỨU — gated, cần verify trước] ──',
    '2. get_customer_info({"customer_id":"<uuid>"} | {"phone":"..."} | {"email":"..."})',
    '   → CRM customer chi tiết: tên, status, lead_score, total_orders, gemral_data.',
    '',
    '3. lookup_order_shopify({"order_number":"4766"})',
    '   → Trạng thái đơn hàng Shopify: fulfillment, tracking, items, shipping address.',
    '',
    '4. check_course_access({"customer_id":"<uuid>","course_id":"<uuid_optional>"})',
    '   → Course enrollments + tier app Gemral của khách.',
    '',
    '5. link_gemral_account({"customer_id":"<uuid>","email":"..."} hoặc {"phone":"..."})',
    '   → Liên kết CRM customer với account app Gemral qua email/SĐT.',
    '',
    '6. recall_memory({"customer_id":"<uuid>","query":"đã hỏi về giá Trading T1"})',
    '   → Tìm trong ReMe memory hội thoại trước đó của khách (semantic search).',
    '',
    '── [HÀNH ĐỘNG — gated] ──',
    '7. crm_update({"customer_id":"<uuid>","status":"...","add_tags":["..."],"internal_notes":"..."})',
    '   → Cập nhật CRM customer.',
    '',
    '8. send_email({"to":"a@b.com","subject":"...","body":"...","template":"thank_you","customer_id":"<uuid>"})',
    '   → Gửi email qua Resend. template: thank_you | follow_up | promotion | welcome.',
    '',
    '9. create_order({"customer_id":"<uuid>","items":[{"title":"...","quantity":1,"price":...}],"shipping_address":"...","payment_method":"chuyen_khoan"})',
    '   → Tạo đơn hàng CRM cho khách (KHÔNG sync sang Shopify).',
    '',
    '── [PUBLIC — không cần gate] ──',
    '10. create_ticket({"title":"...","description":"...","priority":"normal","category":"general","customer_id":"<uuid_optional>"})',
    '    → Tạo phiếu hỗ trợ cho team. priority: low | medium | high | urgent | critical.',
    '    → Dùng khi: khách phàn nàn, refund, lỗi kỹ thuật, hoặc bạn không tự xử lý được.',
    '',
    '11. search_product({"query":"trading tier 1","limit":5})',
    '    → Tìm sản phẩm trên Shopify catalog (public).',
    '',
    '12. search_knowledge({"query":"khóa học có guarantee không","collection":"faq","limit":3})',
    '    → Vector search Knowledge Base. collection: products | courses | faq (optional).',
    '',
    '13. kg_lookup_entity({"name":"khóa Trading T1"} hoặc {"id":"<uuid>","type":"product"})',
    '    → Tra Knowledge Graph entity (sản phẩm, khóa học, khái niệm).',
    '',
    '14. kg_traverse({"entity_id":"<uuid>","depth":2})',
    '    → Lấy tất cả relations xung quanh 1 entity (sản phẩm liên quan, prerequisite...).',
    '',
    '🚫 TUYỆT ĐỐI KHÔNG:',
    '   - Bịa các function khác như [[CALL: cancel_order]], [[CALL: refund]],',
    '     [[CALL: query_db]] — chúng sẽ bị strip và lộ syntax cho khách thấy.',
    '   - Bịa kết quả tool. Nếu chưa gọi tool, KHÔNG được nói "đơn của chị đang ship".',
    '   - Tra info khách A trả khách B. Mỗi session chỉ verified 1 customer.',
    '   - Output raw JSON kết quả tool — luôn paraphrase thân thiện bằng tiếng Việt.',
    '',
    'Khi có kết quả tool (hệ thống sẽ inject), bạn dùng kết quả đó soạn câu trả lời',
    'thân thiện bằng tiếng Việt có dấu cho khách. Nếu tool fail, hãy thông báo lịch',
    'sự + đề xuất bước tiếp theo (vd: "em sẽ chuyển team vận hành kiểm tra giúp chị").',
    '═══════════════════════════════════════════════════',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Executor — dispatches a parsed ToolCall to the right handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a single tool call. Always returns a ToolResult — never throws.
 * Identity gate enforced for gated tools BEFORE dispatch.
 */
export async function executeTool(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResult> {
  if (!isAllowedTool(call.name)) {
    return { ok: false, summary: `Tool "${call.name}" không tồn tại.`, error: 'not_whitelisted' };
  }

  // Identity gate check (skipped for verify_customer_identity itself + public tools)
  if (isGatedTool(call.name) && !ctx.verifiedCustomerId) {
    const result: ToolResult = {
      ok: false,
      summary: `Tool ${call.name} bị chặn — cần gọi verify_customer_identity trước (yêu cầu khách cung cấp 2/3: SĐT, email, mã đơn).`,
      error: 'identity_gate_locked',
    };
    void writeAuditLog(call, ctx, result);
    return result;
  }

  // Auto-inject verified customer_id when caller forgot to pass it
  if (isGatedTool(call.name) && ctx.verifiedCustomerId && !call.args.customer_id) {
    if (['get_customer_info', 'check_course_access', 'link_gemral_account', 'crm_update', 'create_order', 'recall_memory'].includes(call.name)) {
      call.args.customer_id = ctx.verifiedCustomerId;
    }
  }

  // Build shared handler context (Ollama path provides ctx already, just adapt)
  const sharedCtx: ToolHandlerContext = {
    supabase,
    agentSlug: ctx.agentSlug,
    sessionKey: ctx.sessionKey,
    verifiedCustomerId: ctx.verifiedCustomerId,
    channelName: ctx.channelName,
  };

  let result: ToolResult;
  try {
    switch (call.name) {
      case 'verify_customer_identity':
        result = adaptShared(await handleVerifyCustomerIdentity(call.args, sharedCtx));
        // verify mutates sharedCtx — propagate back to ctx for in-loop calls
        ctx.verifiedCustomerId = sharedCtx.verifiedCustomerId;
        break;
      case 'lookup_order_shopify':
        result = adaptShared(await handleLookupOrderShopify(call.args, sharedCtx));
        break;
      case 'recall_memory':
        result = adaptShared(await handleRecallMemory(call.args, sharedCtx));
        break;
      case 'kg_lookup_entity':
        result = adaptShared(await handleKgLookupEntity(call.args, sharedCtx));
        break;
      case 'kg_traverse':
        result = adaptShared(await handleKgTraverse(call.args, sharedCtx));
        break;
      // ── 9 MCP handlers ──────────────────────────────────────────────────
      case 'create_order':
        // YSC-004: đơn thật trên lõi commerce; kết quả (mã CK + QR) PHẢI vào câu trả lời khách
        result = wrapMcpResult(await handleCreateOrder({ ...call.args, source_channel: ctx.channelName }, ctx.agentSlug));
        break;
      case 'create_shopify_order':
        // KHÔNG auto-inject verifiedCustomerId (đó là CRM/verify id, KHÔNG phải Shopify customer_id).
        // Handler tự resolve Shopify customer qua customer_phone. mark_paid mặc định false (unpaid).
        // Chat path KHÔNG BAO GIỜ mark paid (AGENTS.md §THANH TOÁN — xác nhận tiền = nhân viên):
        // ép false ở tầng code, không tin prompt.
        result = wrapMcpResult(await handleCreateShopifyOrder({ ...call.args, mark_paid: false }, ctx.agentSlug));
        break;
      case 'create_ticket':
        result = wrapMcpResult(await handleCreateTicket({
          ...call.args,
          customer_id: call.args.customer_id || ctx.verifiedCustomerId,
          source_channel: ctx.channelName,
        }));
        break;
      case 'search_product':
        result = wrapMcpResult(await handleSearchProduct(call.args));
        break;
      case 'crm_update':
        result = wrapMcpResult(await handleCRMUpdate(call.args));
        break;
      case 'send_email':
        result = wrapMcpResult(await handleSendEmail(call.args));
        break;
      case 'get_customer_info':
        result = wrapMcpResult(await handleGetCustomerInfo(call.args));
        break;
      case 'check_course_access':
        result = wrapMcpResult(await handleCheckCourseAccess(call.args));
        break;
      case 'link_gemral_account':
        result = wrapMcpResult(await handleLinkGemral(call.args));
        break;
      case 'search_knowledge':
        result = wrapMcpResult(await handleSearchKnowledge(call.args));
        break;
      default:
        result = { ok: false, summary: `Tool ${call.name} chưa có handler.`, error: 'not_implemented' };
    }
  } catch (err: any) {
    console.error(`[agent-tools] ${call.name} threw:`, err.message);
    result = { ok: false, summary: `Lỗi khi gọi ${call.name}: ${err.message}`, error: err.message };
  }

  void writeAuditLog(call, ctx, result);
  return result;
}

/**
 * Execute multiple tool calls in series. Mutates ctx in place after a successful
 * verify_customer_identity so subsequent calls in the same loop see the new state.
 */
export async function executeToolCalls(
  calls: ToolCall[],
  ctx: ToolExecutionContext,
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  for (const c of calls) {
    results.push(await executeTool(c, ctx));
  }
  return results;
}

/**
 * Render tool results as a Vietnamese observation block to inject as the next
 * system message in the ReAct loop.
 */
export function renderToolResultsForPrompt(calls: ToolCall[], results: ToolResult[]): string {
  const lines: string[] = ['═══ KẾT QUẢ TOOL — Dùng để soạn câu trả lời thân thiện ═══'];
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    const r = results[i];
    lines.push('');
    lines.push(`▸ ${c.name}(${JSON.stringify(c.args)})`);
    lines.push(`  ${r.ok ? '✓ OK' : '✗ FAIL'}: ${r.summary}`);
  }
  lines.push('═══════════════════════════════════════════════════');
  lines.push('');
  lines.push('HƯỚNG DẪN: dựa trên kết quả tool ở trên, soạn câu trả lời thân thiện');
  lines.push('cho khách bằng tiếng Việt có dấu. KHÔNG copy raw JSON. KHÔNG bịa thêm.');
  lines.push('Nếu tool fail, hãy thông báo lịch sự cho khách + đề xuất bước tiếp theo.');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter: shared SharedToolResult → local ToolResult (same shape, type alias)
// ─────────────────────────────────────────────────────────────────────────────

function adaptShared(r: SharedToolResult): ToolResult {
  return { ok: r.ok, summary: r.summary, data: r.data, error: r.error };
}

// ─────────────────────────────────────────────────────────────────────────────
// (5 tool impls now live in crm/agent-tool-handlers.ts — shared with mcp-server.ts)
// ─────────────────────────────────────────────────────────────────────────────
// MCP result wrapping — MCP handlers return JSON strings, we need ToolResult
// ─────────────────────────────────────────────────────────────────────────────

function wrapMcpResult(jsonString: string): ToolResult {
  try {
    const parsed = JSON.parse(jsonString);
    if (parsed.success === false || parsed.error) {
      return {
        ok: false,
        summary: parsed.error || parsed.message || 'Tool MCP fail',
        data: parsed,
        error: parsed.error,
      };
    }
    // Build a Vietnamese summary from the most common fields
    const summary = mcpSummary(parsed);
    return { ok: true, summary, data: parsed };
  } catch (err: any) {
    return { ok: false, summary: `MCP returned non-JSON: ${jsonString.substring(0, 200)}`, error: err.message };
  }
}

function mcpSummary(parsed: any): string {
  if (parsed.order_number) return `Đơn ${parsed.order_number} (${parsed.total || ''}).`;
  if (parsed.ticket_number) return `Ticket ${parsed.ticket_number} đã tạo.`;
  if (parsed.customer) {
    const c = parsed.customer;
    return `Khách ${c.display_name || c.email || c.phone} — status: ${c.status}, ${c.total_orders || 0} đơn, ${c.lead_temperature || 'unknown'}.`;
  }
  if (parsed.products) {
    const items = parsed.products.slice(0, 5).map((p: any) => `${p.title} (${p.price})`).join(', ');
    return `Tìm thấy ${parsed.products.length} sản phẩm: ${items}.`;
  }
  if (parsed.results) {
    const items = parsed.results.slice(0, 3).map((r: any) => r.title || r.content?.substring(0, 100)).join(' | ');
    return `KB results: ${items}.`;
  }
  if (parsed.enrollments) {
    const list = parsed.enrollments.map((e: any) => `${e.course_title} (${e.progress}%)`).join(', ');
    return `Course access: ${parsed.linked ? 'linked' : 'not linked'}. ${list || ''}`;
  }
  if (parsed.success) return JSON.stringify(parsed).substring(0, 500);
  return JSON.stringify(parsed).substring(0, 500);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function normalizePhone(p: string | undefined | null): string | null {
  if (!p) return null;
  const digits = p.replace(/\D/g, '');
  if (digits.length === 0) return null;
  if (digits.startsWith('84') && digits.length === 11) return '0' + digits.slice(2);
  if (digits.startsWith('840')) return '0' + digits.slice(3);
  return digits;
}

function normalizeEmail(e: string | undefined | null): string | null {
  if (!e) return null;
  return e.trim().toLowerCase() || null;
}

async function writeAuditLog(call: ToolCall, ctx: ToolExecutionContext, result: ToolResult): Promise<void> {
  try {
    await supabase.from('agent_tool_audit_log').insert({
      agent_slug: ctx.agentSlug,
      session_key: ctx.sessionKey,
      tool_name: call.name,
      args: call.args,
      result_summary: result.summary?.substring(0, 1000) || null,
      target_customer_id: ctx.verifiedCustomerId,
      success: result.ok,
      error: result.error || null,
    });
  } catch (err: any) {
    console.warn(`[agent-tools] Audit log insert failed: ${err.message}`);
  }
}
