// Escalation handler — invoked by consumer.ts when an agent emits an
// [[ESCALATE: ...]] marker. Performs three side-effects atomically:
//
//   1. Sets channel_sessions.metadata.bot_paused=true (no more auto-replies
//      in this session until a human un-pauses)
//   2. Inserts a row into crm_tickets with priority=urgent for the human queue
//   3. Sends a Telegram ping to Jennie (chat_id 6486938519) so she knows
//      immediately
//
// All steps are best-effort — if one fails, the others still run. We never
// throw out of this module to avoid breaking the inbound message handler.

import { supabase } from '../zalo-personal/supabase.js';

export interface EscalationContext {
  agentSlug: string;
  sessionKey: string;
  channelName: string;
  chatId: string;
  customerId: string | null;
  customerName: string | null;
  reason: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  summary: string;
  triggerMessage: string;          // The customer message that triggered escalation
  agentReply: string;              // The calming reply the bot just sent
  /**
   * Mode flag — controls which side-effects fire:
   *   'live'     — full flow: pause bot + insert ticket + Telegram ping
   *   'training' — ONLY insert ticket (tagged with training_session_id),
   *                skip pause and skip Telegram (avoid spamming Jennie when
   *                running training scenarios that intentionally trigger escalation)
   * Defaults to 'live'.
   */
  mode?: 'live' | 'training';
  /** Training session id, set when mode='training' for ticket linkage */
  trainingSessionId?: string;
  /** Turn number in training (for ticket metadata) */
  trainingTurnNo?: number;
  /**
   * Optional metadata patch for Step 1 instead of the default bot_paused patch.
   * Gem Master corrupted-output containment passes { agy_disabled_until, ... }:
   * bot_paused would strand the customer (no operator watches the gem-master
   * inbox), while agy_disabled_until lets the edge fn skip the agy branch and
   * serve the customer via the Gemini fallback for a bounded window.
   */
  pausePatch?: Record<string, unknown>;
  /**
   * Cảnh báo-không-khoá (GEM-1037): bỏ Step 1 (không pause bot, không containment).
   * Dùng khi sự cố là HẠ TẦNG (agent trả rỗng / provider timeout), KHÔNG phải khách bức xúc —
   * khoá phiên sẽ làm tin kế tiếp của khách cũng không ai trả lời. Vẫn ghi ticket + ping.
   */
  noPause?: boolean;
  /** Ghi đè câu trạng thái cuối tin Telegram (mặc định suy từ kết quả pause). */
  statusLine?: string;
  /**
   * GEM-1572 / OPS-1021-S1-01-b8b076: Cờ xác định tin nhắn là ý định kết thúc cuộc trò chuyện (Ok, cảm ơn, tạm biệt).
   * Khi true:
   *   - Không pause bot (tương đương noPause = true)
   *   - Ticket CRM được tạo ở trạng thái 'resolved' ngay lập tức (không để open kẹt P42)
   *   - Nếu đã có ticket open của phiên, tự động resolve ticket đó
   *   - Bỏ qua Telegram ping (tránh quấy rầy người vận hành)
   */
  closureIntent?: boolean;
}

export interface EscalationResult {
  ticketId: string | null;
  ticketDisplayId: string | null;
}

const TELEGRAM_BOARD_CHAT_ID = '6486938519'; // Jennie

/**
 * Main entry — fire-and-forget. Does NOT throw.
 *
 * Returns { ticketId, ticketDisplayId } so callers (e.g. training orchestrator)
 * can link back to the created ticket from their own UI.
 */
export async function handleEscalation(ctx: EscalationContext): Promise<EscalationResult> {
  const mode = ctx.mode ?? 'live';
  const isTraining = mode === 'training';
  const logPrefix = `[Escalation/${ctx.agentSlug}${isTraining ? '/training' : ''}]`;
  console.warn(
    `${logPrefix} 🚨 ESCALATION FIRED — `
      + `reason=${ctx.reason} priority=${ctx.priority} `
      + `session=${ctx.sessionKey.substring(0, 30)}`,
  );

  // ── Step 1: Pause / contain the session ───────────────────────────────────
  // SKIPPED in training mode — training scenarios intentionally trigger
  // escalations as part of testing, we don't want to lock the session.
  // didPause / botCurrentlyPaused feed the ping message variant (Step 3).
  let didPause = false;
  let botCurrentlyPaused = false;
  if (!isTraining && !ctx.noPause && !ctx.closureIntent) {
    if (ctx.pausePatch) {
      // Gem-Master (hoặc caller tùy biến): containment HẸN GIỜ qua merge_meta (agy_disabled_until…).
      // KHÁC bot_paused — engine gem-master (gemini-proxy) đọc agy_disabled_until riêng. KHÔNG route
      // qua cskh_toggle_bot (sai cơ chế). Plan §Deviations D-1.
      try {
        await supabase.rpc('channel_session_merge_meta', { p_session_key: ctx.sessionKey, p_patch: ctx.pausePatch });
        didPause = true; botCurrentlyPaused = true;
        console.log(`${logPrefix} ✓ Containment applied (${Object.keys(ctx.pausePatch).join(',')})`);
      } catch (err: any) {
        console.error(`${logPrefix} ✗ Containment failed: ${err.message}`);
      }
    } else {
      // CSKH/channel escalation: pause qua cskh_toggle_bot v2 (1 cửa ghi + owner-window C2/OD-1).
      // OD-1 (chị chốt 12/08): lệnh chị thắng máy TRỌN 24h — KHÔNG ngoại lệ (bỏ OD-1b). Trong 24h
      // kể từ khi chị bật bot, escalation KHÔNG tự pause đè (mọi reason/priority) — vẫn ghi ticket + ping.
      try {
        const respectWindow = '24 hours';
        const { data: rc, error: rpcErr } = await supabase.rpc('cskh_toggle_bot', {
          p_session_key: ctx.sessionKey,
          p_paused: true,
          p_reason: ctx.reason,
          p_actor: `escalation:${ctx.agentSlug}`,
          p_priority: ctx.priority,
          p_respect_owner_window: respectWindow,
        });
        if (rpcErr) throw new Error(rpcErr.message);
        didPause = Number(rc) > 0;
        if (didPause) {
          botCurrentlyPaused = true;
        } else {
          // rowcount=0: session-not-found HOẶC bị owner-window chặn — đọc trạng thái THẬT (C2/G5).
          const { data: sess } = await supabase
            .from('channel_sessions').select('metadata').eq('session_key', ctx.sessionKey).maybeSingle();
          if (!sess) {
            console.error(`${logPrefix} ✗ session không tồn tại khi pause (${ctx.sessionKey.substring(0, 30)})`);
          } else {
            botCurrentlyPaused = !!(sess.metadata as any)?.bot_paused;
            console.log(`${logPrefix} ⊘ Không pause (owner-window): bot hiện ${botCurrentlyPaused ? 'ĐANG tắt (chị trực)' : 'ĐANG chạy theo lệnh chị'}`);
          }
        }
      } catch (err: any) {
        console.error(`${logPrefix} ✗ Failed to pause session: ${err.message}`);
      }
    }
  }

  // ── Step 2: Insert urgent ticket ──────────────────────────────────────────
  // ALWAYS runs (live + training). In training mode the ticket is tagged with
  // metadata.training_session_id so the Phòng Training UI can link to it.
  let ticketId: string | null = null;
  let ticketDisplayId: string | null = null;
  const isClosure = !!ctx.closureIntent;
  const nowIso = new Date().toISOString();

  // Per-session dedup at DB level — one ticket per sessionKey. ⚠️ KHÔNG return sớm
  // ở đây (bug cũ: nuốt luôn Step 3 ping — vòng 1 C3): chỉ NHỚ ticket cũ, đi tiếp
  // để ping-có-phanh chạy. Suppression ping giờ do rate-limit (last_escalation_ping_at)
  // đảm nhận, KHÔNG do dedup-return (đường cũ khiến gem-master storm im ping đúng nhờ nó).
  let hadExistingTicket = false;
  try {
    const { data: existing } = await supabase
      .from('crm_tickets')
      .select('id, ticket_number, metadata, timeline')
      .eq('source_session_key', ctx.sessionKey)
      .in('status', ['open', 'pending', 'in_progress'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) {
      hadExistingTicket = true;
      ticketId = existing.id;
      ticketDisplayId = (existing as { ticket_number?: string }).ticket_number ?? null;
      if (isClosure) {
        const note = `Tự đóng: khách gửi tin nhắn kết thúc cuộc trò chuyện (${ctx.triggerMessage.slice(0, 50)})`;
        const timeline = Array.isArray((existing as any).timeline) ? (existing as any).timeline : [];
        const { error: resErr } = await supabase
          .from('crm_tickets')
          .update({
            status: 'resolved',
            resolved_at: nowIso,
            updated_at: nowIso,
            metadata: {
              ...((existing as any).metadata || {}),
              resolution_note: note,
              resolved_by: 'auto:closure_intent',
              closure_intent: true,
            },
            timeline: [...timeline, { at: nowIso, by: `auto:${ctx.agentSlug}`, action: 'resolved', note }],
          })
          .eq('id', existing.id);
        if (resErr) {
          console.warn(`${logPrefix} auto-resolve existing ticket on closure failed: ${resErr.message}`);
        } else {
          console.log(`${logPrefix} ✓ Auto-resolved existing open ticket ${ticketDisplayId ?? ticketId} on closure intent`);
        }
      } else {
        console.warn(
          `${logPrefix} ⊘ Dedup — ticket mở sẵn ${ticketDisplayId ?? ticketId} cho session ${ctx.sessionKey.substring(0, 30)} — bỏ qua insert (vẫn cân nhắc ping có phanh)`,
        );
      }
    }
  } catch (err: any) {
    // Soft-fail dedup check — fall through to insert path. Worst case = duplicate.
    console.warn(`${logPrefix} dedup check failed (continuing): ${err.message}`);
  }

  if (!hadExistingTicket) try {
    // Schema reference (verified 2026-04-08 against pgfkbcnzqozzkohwbgbk):
    //   crm_tickets columns: id, customer_id, ticket_number, title, description,
    //   category, priority, status, created_by_agent, assigned_to_agent,
    //   source_channel, source_session_key, source_message_id, tags, metadata,
    //   timeline, sla_deadline, ...
    // NOTE: column is `title` (not `subject`) and `ticket_number` (not `display_id`).
    const { data: ticket, error: tErr } = await supabase
      .from('crm_tickets')
      .insert({
        category: mapReasonToCategory(ctx.reason),
        priority: ctx.priority,
        status: isClosure ? 'resolved' : 'open',
        resolved_at: isClosure ? nowIso : null,
        title: isTraining
          ? `[TRAINING/${ctx.reason}] turn ${ctx.trainingTurnNo ?? '?'}`
          : isClosure
          ? `[CLOSURE/${ctx.reason}] ${ctx.customerName || ctx.chatId}`
          : `[ESCALATE/${ctx.reason}] ${ctx.customerName || ctx.chatId}`,
        description: [
          `**Reason**: ${ctx.reason}`,
          `**Priority**: ${ctx.priority}`,
          `**Channel**: ${ctx.channelName}`,
          `**Session**: ${ctx.sessionKey}`,
          isTraining ? `**Training Session**: ${ctx.trainingSessionId ?? '(unknown)'}` : '',
          isTraining ? `**Training Turn**: ${ctx.trainingTurnNo ?? '?'}` : '',
          `**Customer**: ${ctx.customerName || '(unknown)'} (id: ${ctx.customerId || 'n/a'})`,
          isClosure ? `**Closure Intent**: Detected ("${ctx.triggerMessage.slice(0, 60)}")` : '',
          '',
          '**Summary from agent:**',
          ctx.summary,
          '',
          '**Customer message that triggered escalation:**',
          ctx.triggerMessage.substring(0, 1000),
          '',
          '**Bot calming reply (already sent):**',
          ctx.agentReply.substring(0, 1000),
        ].filter(Boolean).join('\n'),
        customer_id: ctx.customerId,
        created_by_agent: ctx.agentSlug,
        source_channel: isTraining ? 'training_room' : ctx.channelName,
        source_session_key: ctx.sessionKey,
        tags: isTraining
          ? ['training', `escalation:${ctx.reason}`]
          : isClosure
          ? [`escalation:${ctx.reason}`, 'closure_intent']
          : [`escalation:${ctx.reason}`],
        metadata: {
          escalation_reason: ctx.reason,
          escalation_agent: ctx.agentSlug,
          chat_id: ctx.chatId,
          ...(isClosure && {
            closure_intent: true,
            resolved_by: 'auto:closure_intent',
            resolution_note: 'Tự đóng: khách gửi tin nhắn kết thúc cuộc trò chuyện (closure intent)',
          }),
          ...(isTraining && {
            training_mode: true,
            training_session_id: ctx.trainingSessionId,
            training_turn_no: ctx.trainingTurnNo,
          }),
        },
        timeline: isClosure
          ? [
              {
                at: nowIso,
                by: `auto:${ctx.agentSlug}`,
                action: 'resolved',
                note: 'Tự đóng: khách gửi tin nhắn kết thúc cuộc trò chuyện (closure intent)',
              },
            ]
          : [],
      })
      .select('id, ticket_number')
      .single();

    if (tErr) {
      console.error(`${logPrefix} ✗ Ticket insert failed: ${tErr.message}`);
    } else {
      ticketId = ticket?.id || null;
      ticketDisplayId = (ticket as { ticket_number?: string })?.ticket_number || null;
      console.log(`${logPrefix} ✓ Ticket created: ${ticketDisplayId ?? ticketId}`);
    }
  } catch (err: any) {
    console.error(`${logPrefix} ✗ Ticket insert exception: ${err.message}`);
  }

  // ── Step 3: Telegram ping (có PHANH + câu trạng thái đúng sự thật) ─────────
  if (ctx.closureIntent) {
    console.log(`${logPrefix} ⊘ Bỏ qua Telegram ping (closure intent — khách chỉ chào/cảm ơn/kết thúc)`);
    return { ticketId, ticketDisplayId };
  }
  // Rate-limit thay vai trò suppression của dedup-return cũ (vòng 1 C3): tối đa 1 ping /
  // session / 30' — bỏ phanh khi priority='urgent'. Chống bão ping khi C2 giữ bot chạy
  // mà khách bức xúc nhắn liên tục. Training LUÔN ping (không phanh).
  if (!isTraining && await isPingThrottled(ctx.sessionKey, ctx.priority)) {
    console.log(`${logPrefix} ⏸ Ping bị phanh (đã ping <30' + priority≠urgent) — bỏ ping lượt này`);
    return { ticketId, ticketDisplayId };
  }

  // Câu trạng thái phản ánh THẬT (C2/G5): KHÔNG nói "bot vẫn chạy" khi bot đang tắt.
  const statusLine = ctx.statusLine
    ? ctx.statusLine
    : ctx.pausePatch
    ? 'Đã tạm khoá phiên (containment). Cần xử lý tay.'
    : didPause
      ? 'Bot đã dừng cho session này. Cần xử lý tay.'
      : botCurrentlyPaused
        ? 'Khách vẫn bức xúc — chị đang trực thread này (bot đang tắt).'
        : 'Khách vẫn bức xúc — bot VẪN chạy theo lệnh chị (chị vừa bật bot gần đây). Vào xem nếu cần.';

  try {
    const pinged = await pingTelegramBoard({
      reason: ctx.reason,
      priority: ctx.priority,
      summary: ctx.summary,
      customerName: ctx.customerName,
      channelName: ctx.channelName,
      chatId: ctx.chatId,
      ticketId,
      ticketDisplayId,
      triggerMessage: ctx.triggerMessage,
      isTraining,
      statusLine,
    });
    if (pinged) {
      console.log(`${logPrefix} ✓ Telegram ping sent`);
      if (!isTraining) {
        // Ghi mốc ping — sự kiện PING (khác pause) → merge_meta hợp lệ, KHÔNG vào cskh_toggle_bot
        // (vòng 2 G4). Khoá này KHÔNG bị unpause xoá + P37 không coi là rác.
        try {
          await supabase.rpc('channel_session_merge_meta', {
            p_session_key: ctx.sessionKey,
            p_patch: { last_escalation_ping_at: new Date().toISOString() },
          });
        } catch { /* best-effort */ }
      }
    } else {
      console.warn(`${logPrefix} ⊘ Telegram ping NOT sent (no token) — ticket exists but nobody was pinged`);
    }
  } catch (err: any) {
    console.error(`${logPrefix} ✗ Telegram ping failed: ${err.message}`);
  }

  return { ticketId, ticketDisplayId };
}

const PING_THROTTLE_MS = 30 * 60 * 1000;
/** true = bỏ ping (đã ping <30' trước); priority='urgent' luôn qua (không phanh). */
async function isPingThrottled(sessionKey: string, priority: string): Promise<boolean> {
  if (priority === 'urgent') return false;
  try {
    const { data } = await supabase
      .from('channel_sessions').select('metadata').eq('session_key', sessionKey).maybeSingle();
    const last = (data?.metadata as any)?.last_escalation_ping_at as string | undefined;
    if (!last) return false;
    return Date.now() - new Date(last).getTime() < PING_THROTTLE_MS;
  } catch {
    return false; // đọc lỗi → cho ping (thà thừa còn hơn câm)
  }
}

/**
 * Check if a session is currently paused due to escalation.
 * Called at the START of consumer.ts message handler so paused sessions
 * skip auto-reply entirely.
 */
export async function isSessionPaused(sessionKey: string): Promise<boolean> {
  if (!sessionKey) return false;
  try {
    const { data } = await supabase
      .from('channel_sessions')
      .select('metadata')
      .eq('session_key', sessionKey)
      .single();
    const meta = (data?.metadata as Record<string, unknown>) || {};
    return Boolean(meta.bot_paused);
  } catch {
    return false; // fail open — if DB read fails, allow the reply
  }
}

/**
 * Lý do "khách CHƯA nhận gì" — phiếu loại này hết nghĩa khi bot đã gửi được câu trả lời sau đó
 * trên cùng phiên (thử lại / tin kế tiếp / chạy lại sau restart). 14/10 TK-20261014-001: phiếu
 * agent_silent mở lúc 13:18, bot trả lời 14:47 cùng tin đó mà phiếu vẫn mở → nhắc 18:00 báo sai
 * "khách đang chờ". Phiếu lý do khác (khách bức xúc, đơn hàng…) KHÔNG tự đóng.
 */
export const AUTO_RESOLVE_ON_REPLY_REASONS = ['agent_silent', 'agent_output_corrupted'] as const;

/**
 * Bot vừa gửi được câu trả lời trên phiên → đóng các phiếu "khách chưa nhận gì" còn mở của phiên đó.
 * Best-effort, không ném lỗi (không được làm hỏng luồng gửi). Trả số phiếu đã đóng.
 */
export async function autoResolveNoReplyTickets(sessionKey: string, agentSlug: string): Promise<number> {
  if (!sessionKey) return 0;
  try {
    const { data: open } = await supabase
      .from('crm_tickets')
      .select('id, ticket_number, metadata, timeline')
      .eq('source_session_key', sessionKey)
      .in('status', ['open', 'pending', 'in_progress'])
      .in('metadata->>escalation_reason', [...AUTO_RESOLVE_ON_REPLY_REASONS])
      .limit(20);
    let closed = 0;
    const nowIso = new Date().toISOString();
    for (const t of (open || []) as Array<{ id: string; ticket_number?: string; metadata?: any; timeline?: any }>) {
      const note = `Tự đóng: bot ${agentSlug} đã gửi được câu trả lời trên phiên này sau khi phiếu mở`;
      const timeline = Array.isArray(t.timeline) ? t.timeline : [];
      const { error } = await supabase
        .from('crm_tickets')
        .update({
          status: 'resolved',
          resolved_at: nowIso,
          updated_at: nowIso,
          metadata: { ...(t.metadata || {}), resolution_note: note, resolved_by: 'auto:reply_delivered' },
          timeline: [...timeline, { at: nowIso, by: `auto:${agentSlug}`, action: 'resolved', note }],
        })
        .eq('id', t.id)
        .in('status', ['open', 'pending', 'in_progress']);
      if (error) {
        console.warn(`[Escalation/${agentSlug}] auto-resolve ${t.ticket_number ?? t.id} failed: ${error.message}`);
      } else {
        closed++;
        console.log(`[Escalation/${agentSlug}] ✓ Auto-resolved ${t.ticket_number ?? t.id} (bot replied later)`);
      }
    }
    return closed;
  } catch (err: any) {
    console.warn(`[Escalation/${agentSlug}] auto-resolve check failed: ${err?.message}`);
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function mapReasonToCategory(reason: string): string {
  // Allowed values per crm_tickets_category_check (verified 2026-04-08):
  //   general, product_inquiry, order_issue, payment_issue, shipping_issue,
  //   refund_request, technical_support, complaint, feature_request,
  //   bug_report, escalation
  // The enum is intentionally generic — finer-grained reason is preserved in
  // ctx.reason and stored in metadata.escalation_reason + tags.
  switch (reason) {
    case 'refund_dispute':
      return 'refund_request';
    case 'customer_hostile':
    case 'fraud_allegation':
    case 'prolonged_frustration':
      return 'complaint';
    case 'legal_threat':
    case 'compliance_request':
    case 'public_complaint_threat':
    case 'public_complaint_active':
    case 'mental_health_concern':
    case 'identity_verification_failed':
    case 'ceo_request':
      return 'escalation';
    default:
      return 'escalation';
  }
}

interface TelegramPingArgs {
  reason: string;
  priority: string;
  summary: string;
  customerName: string | null;
  channelName: string;
  chatId: string;
  ticketId: string | null;
  ticketDisplayId?: string | null;
  triggerMessage: string;
  isTraining?: boolean;
  /** Câu trạng thái cuối tin (C2) — phản ánh THẬT bot đã dừng / vẫn chạy theo lệnh chị. */
  statusLine?: string;
}

/**
 * Sends the escalation ping to the ops Telegram board.
 * Returns `true` only when a message was actually delivered; returns `false`
 * when the ping was skipped (no token configured) so the caller does not log a
 * misleading "ping sent". Throws on a real Telegram API failure.
 */
async function pingTelegramBoard(args: TelegramPingArgs): Promise<boolean> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.warn('[Escalation/telegram] TELEGRAM_BOT_TOKEN not set — skipping ping (ticket still created)');
    return false;
  }

  const emoji = args.priority === 'urgent' ? '🚨🚨🚨'
    : args.priority === 'high' ? '🚨'
    : '⚠️';
  const trainingTag = args.isTraining ? ' [TRAINING]' : '';

  const text = [
    `${emoji} *ESCALATION${trainingTag} — ${args.reason}*`,
    `*Priority*: ${args.priority}`,
    `*Channel*: ${args.channelName}`,
    `*Customer*: ${args.customerName || args.chatId}`,
    '',
    `*Summary*: ${args.summary}`,
    '',
    `*Customer said*:`,
    `> ${args.triggerMessage.substring(0, 300).replace(/\n/g, '\n> ')}`,
    '',
    args.ticketDisplayId
      ? `*Ticket*: ${args.ticketDisplayId}`
      : args.ticketId ? `*Ticket*: ${args.ticketId}` : '_(ticket creation failed)_',
    '',
    args.isTraining
      ? '_Training run — bot KHÔNG bị pause, ticket tagged với training_session_id._'
      : (args.statusLine || 'Bot đã pause cho session này. Cần xử lý tay.'),
  ].join('\n');

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = {
    chat_id: TELEGRAM_BOARD_CHAT_ID,
    text,
    parse_mode: 'Markdown',
  };

  const post = (payload: Record<string, unknown>) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  let res = await post(body);
  if (!res.ok) {
    const errBody = await res.text();
    // Nội dung khách (URL có `_`, `[Hình ảnh…]`) làm Markdown legacy vỡ → Telegram 400 "can't parse
    // entities" → cảnh báo mất câm đúng lúc khách gửi ảnh. Gửi lại dạng text thuần thay vì nuốt.
    if (res.status === 400 && /parse entities/i.test(errBody)) {
      const { parse_mode: _drop, ...plain } = body;
      res = await post(plain);
      if (res.ok) return true;
      throw new Error(`Telegram API ${res.status} (plain retry): ${(await res.text()).substring(0, 200)}`);
    }
    throw new Error(`Telegram API ${res.status}: ${errBody.substring(0, 200)}`);
  }
  return true;
}
