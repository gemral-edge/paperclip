// Auto Follow-Up Cron
//
// Bám đuổi khách stuck trong purchase funnel: nếu khách ở stage
// "interest" / "consideration" / "intent" mà X giờ chưa reply,
// auto-insert follow-up message vào follow_up_queue.
//
// Chạy mỗi 10 phút (interval). Worker riêng quét follow_up_queue và gửi
// message qua channel khi scheduled_at <= NOW().
//
// Tránh spam: max 2 follow-ups per session, skip nếu khách reply sau,
// skip nếu session bot_paused (escalated).

import { supabase } from '../zalo-personal/supabase.js';
import { bus } from '../bus.js';
import { recordCronRun } from '../../services/cron-registry.js';
import type { OutboundMessage } from '../types.js';

const CRON_INTERVAL_MS = 10 * 60 * 1000; // 10 phút

// Stage → (stuck threshold, follow-up message template)
interface FollowUpRule {
  stage: string;
  stuckHours: number;
  message: string;   // vi
  messageEn: string; // en — khách không nói tiếng Việt (13/10: cskh-web/shopify khách Mỹ nhận câu tiếng Việt)
}

const FOLLOWUP_RULES: FollowUpRule[] = [
  {
    stage: 'interest',
    stuckHours: 6,
    message: 'Dạ chị ơi, em vẫn đang đây nha 🌸 Có thông tin nào em chưa giải đáp rõ thì chị cứ hỏi em thêm nhé ạ — em luôn sẵn sàng tư vấn 💛',
    messageEn: "Hi, just checking in. If anything is still unclear, reply here and I'll help you out.",
  },
  {
    stage: 'consideration',
    stuckHours: 12,
    message: 'Dạ chị cứ cân nhắc thêm, phần nào còn phân vân thì nhắn em nha ạ ✨ Em gửi chị ảnh màn hình Gemral Edge/Scanner hoặc hướng dẫn nhanh cách dùng để chị xem trước nếu cần 🙏',
    messageEn: "Take your time. If something is still holding you back, tell me which part and I can send screenshots or a quick walkthrough.",
  },
  {
    stage: 'intent',
    stuckHours: 2,
    message: 'Dạ chị ơi, link đăng ký gói Gemral Edge/Scanner vẫn sẵn đây nha 💛 Chị cần em gửi lại link thanh toán không ạ? 🌟',
    messageEn: "Your checkout link is ready whenever you are. Want me to send it again?",
  },
];

const CATCHALL_RULE = {
  stuckHours: 24,
  maxFollowups: 1,
  message: 'Dạ chị ơi, em vẫn đang đây nha 🌸 Chị có câu hỏi gì thêm cứ nhắn em nhé — em luôn sẵn sàng hỗ trợ ạ 💛',
  messageEn: "Hi, I'm still here if you have any questions. Just reply and I'll help.",
};

const VI_DIACRITIC = /[ăâđêôơưàáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/i;

/** Ngôn ngữ nhắc lại = ngôn ngữ tin khách gửi gần nhất. Zalo luôn vi (khách VN, hay gõ không dấu). */
export function pickFollowupLang(channelName: string, lastInboundBody: string | null | undefined): 'vi' | 'en' {
  if (channelName.startsWith('zalo')) return 'vi';
  const body = (lastInboundBody || '').trim();
  if (VI_DIACRITIC.test(body)) return 'vi';
  if (/[a-z]{2,}/i.test(body)) return 'en';
  return channelName.startsWith('fb') ? 'vi' : 'en';
}

async function lastInboundBody(sessionKey: string): Promise<string | null> {
  const { data } = await supabase
    .from('channel_pending_messages')
    .select('body')
    .eq('session_key', sessionKey)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.body as string | undefined) ?? null;
}

const MAX_FOLLOWUPS_PER_SESSION = 2;

let cronTimer: NodeJS.Timeout | null = null;

function log(msg: string): void { console.log(`[FollowUp] ${msg}`); }
function logWarn(msg: string): void { console.warn(`[FollowUp] ⚠ ${msg}`); }
function logErr(msg: string): void { console.error(`[FollowUp] ❌ ${msg}`); }

function stuckLabel(hours: number): string {
  if (hours < 24) return `${hours} giờ`;
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h > 0 ? `${days} ngày ${h}h` : `${days} ngày`;
}

function channelLabel(name: string): string {
  if (name.startsWith('zalo-personal')) return 'Zalo';
  if (name.startsWith('fb-')) return `FB ${name.replace('fb-', '')}`;
  return name;
}

const FB_MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000; // Facebook 24h policy

function isFbChannelOutsideWindow(channelName: string, lastMessageAt: string): boolean {
  if (!channelName.startsWith('fb-')) return false;
  return Date.now() - new Date(lastMessageAt).getTime() > FB_MESSAGING_WINDOW_MS;
}

async function runAndRecord(cronId: string, fn: () => Promise<string>): Promise<void> {
  const start = Date.now();
  try {
    const output = await fn();
    await recordCronRun(cronId, { status: 'success', durationMs: Date.now() - start, output });
  } catch (err: any) {
    logErr(`Lỗi ${cronId}: ${err.message}`);
    await recordCronRun(cronId, { status: 'failed', durationMs: Date.now() - start, output: err.message });
  }
}

/**
 * Start the cron loop. Call once on app startup.
 */
export function startFollowUpCron(): void {
  if (cronTimer) {
    logWarn('Đã chạy rồi, bỏ qua');
    return;
  }
  log(`Khởi động — quét mỗi ${CRON_INTERVAL_MS / 60000} phút`);

  // Run once immediately on startup, then on interval
  void runAndRecord('node-follow-up-cron', runScanCycle);

  cronTimer = setInterval(() => {
    // `cronId` must match the id registered in cron-registry.ts NODE_TIMER_SEEDS
    // ('node-follow-up-cron') — recordCronRun() no-ops silently on unknown ids
    // (bug found 2026-08-09: 'followup-scan'/'followup-queue' were never
    // registered, so last_run_at was never actually written).
    void runAndRecord('node-follow-up-cron', runScanCycle);
    void runAndRecord('node-follow-up-cron', processQueueCycle);
  }, CRON_INTERVAL_MS);
}

export function stopFollowUpCron(): void {
  if (cronTimer) {
    clearInterval(cronTimer);
    cronTimer = null;
    log('Đã dừng');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scan cycle: tìm sessions bị stuck, thêm follow-up vào queue
// ─────────────────────────────────────────────────────────────────────────────

async function runScanCycle(): Promise<string> {
  const startMs = Date.now();
  log('━━━ Bắt đầu quét ━━━');
  let totalInserted = 0;
  let totalScanned = 0;
  const skips = { wrongStage: 0, botPaused: 0, noCustomer: 0, maxReached: 0, tooSoon: 0 };

  // ── Quét theo từng stage (interest → consideration → intent) ──
  for (const rule of FOLLOWUP_RULES) {
    const cutoffIso = new Date(Date.now() - rule.stuckHours * 60 * 60 * 1000).toISOString();

    const { data: sessions, error } = await supabase
      .from('channel_sessions')
      .select('session_key, channel_name, chat_id, agent_slug, customer_id, last_message_at, metadata')
      .lte('last_message_at', cutoffIso)
      .not('agent_slug', 'is', null)
      // 03/10: hội thoại chị ĐÃ XOÁ không bao giờ được nhắn chăm sóc (spam MISA nhận "em vẫn đang đây").
      .not('is_deleted', 'is', true)
      .or('label.is.null,label.not.in.(spam,blocked)') // 03/10: không nhắn chăm sóc spam/đã chặn
      .limit(200);

    if (error) {
      logErr(`Lỗi query stage "${rule.stage}": ${error.message}`);
      continue;
    }

    const count = sessions?.length ?? 0;
    log(`📊 Stage "${rule.stage}" (im lặng >${rule.stuckHours}h): ${count} sessions`);
    if (!sessions || count === 0) continue;
    totalScanned += count;

    for (const sess of sessions) {
      const meta = (sess.metadata as Record<string, unknown>) || {};

      if (meta.purchase_stage !== rule.stage) { skips.wrongStage++; continue; }
      if (meta.bot_paused === true) { skips.botPaused++; continue; }
      if (!sess.customer_id) { skips.noCustomer++; continue; }

      const followupCount = Number(meta.followup_count || 0);
      if (followupCount >= MAX_FOLLOWUPS_PER_SESSION) { skips.maxReached++; continue; }

      const lastFollowupAt = meta.last_followup_at as string | undefined;
      if (lastFollowupAt && Date.now() - new Date(lastFollowupAt).getTime() < 4 * 60 * 60 * 1000) {
        skips.tooSoon++;
        continue;
      }

      const inserted = await insertFollowup(sess, { vi: rule.message, en: rule.messageEn }, rule.stage, followupCount);
      if (inserted) totalInserted++;
    }
  }

  // ── Catch-all: khách không có stage, im lặng >24h ──
  const catchallCutoff = new Date(Date.now() - CATCHALL_RULE.stuckHours * 60 * 60 * 1000).toISOString();
  const { data: catchallSessions, error: catchallErr } = await supabase
    .from('channel_sessions')
    .select('session_key, channel_name, chat_id, agent_slug, customer_id, last_message_at, metadata')
    .lte('last_message_at', catchallCutoff)
    .not('agent_slug', 'is', null)
    .not('is_deleted', 'is', true)
      .or('label.is.null,label.not.in.(spam,blocked)') // 03/10: không nhắn chăm sóc spam/đã chặn // 03/10: bỏ hội thoại đã xoá
    .limit(200);

  let catchallQueued = 0;
  if (catchallErr) {
    logErr(`Lỗi query catch-all: ${catchallErr.message}`);
  } else {
    const eligible = (catchallSessions || []).filter((sess) => {
      const meta = (sess.metadata as Record<string, unknown>) || {};
      if (meta.purchase_stage) return false;
      if (meta.bot_paused === true) return false;
      if (!sess.customer_id) return false;
      if (!sess.channel_name) return false;
      const fc = Number(meta.followup_count || 0);
      if (fc >= CATCHALL_RULE.maxFollowups) return false;
      const lastFU = meta.last_followup_at as string | undefined;
      if (lastFU && Date.now() - new Date(lastFU).getTime() < 24 * 60 * 60 * 1000) return false;
      return true;
    });

    const total = catchallSessions?.length ?? 0;
    const skipped = total - eligible.length;
    log(`📊 Catch-all (im lặng >${CATCHALL_RULE.stuckHours}h, chưa phân loại): ${eligible.length} đủ điều kiện / ${total} tổng (bỏ qua ${skipped})`);

    for (const sess of eligible) {
      const meta = (sess.metadata as Record<string, unknown>) || {};
      const followupCount = Number(meta.followup_count || 0);
      const inserted = await insertFollowup(sess, { vi: CATCHALL_RULE.message, en: CATCHALL_RULE.messageEn }, 'catch-all', followupCount);
      if (inserted) { totalInserted++; catchallQueued++; }
    }
  }

  // ── Tổng kết + Quyết định ──
  const durationMs = Date.now() - startMs;
  const skipTotal = skips.wrongStage + skips.botPaused + skips.noCustomer + skips.maxReached + skips.tooSoon;

  log('───── KẾT QUẢ ─────');
  log(`⏱ Hoàn thành trong ${durationMs}ms`);
  log(`📬 Đã thêm vào queue: ${totalInserted} tin follow-up`);
  if (totalInserted > 0) {
    log(`   → Staged: ${totalInserted - catchallQueued} | Catch-all: ${catchallQueued}`);
  }
  log(`🔍 Đã quét: ${totalScanned} sessions (staged) + ${catchallSessions?.length ?? 0} (catch-all)`);
  if (skipTotal > 0) {
    log(`⏭ Bỏ qua ${skipTotal}: sai stage=${skips.wrongStage} | bot tạm dừng=${skips.botPaused} | chưa có KH=${skips.noCustomer} | đã gửi đủ=${skips.maxReached} | gửi gần đây=${skips.tooSoon}`);
  }

  // Quyết định tiếp theo
  if (totalInserted === 0 && skipTotal > 0 && skips.wrongStage === skipTotal) {
    log('💡 NHẬN XÉT: Tất cả sessions đều sai stage — sales-closer có thể chưa set purchase_stage. Catch-all đang bù đắp.');
  }
  if (totalInserted > 5) {
    logWarn('💡 NHẬN XÉT: >5 follow-ups cùng lúc — kiểm tra xem có khách nào bị gửi trùng không.');
  }
  if (totalInserted === 0) {
    log('✅ Không có khách nào cần follow-up lúc này.');
  } else {
    log(`✅ ${totalInserted} tin sẽ được gửi trong 1 phút tới (queue worker xử lý).`);
  }
  log('━━━━━━━━━━━━━━━━━━━');

  const summary = `${totalInserted} queued, ${skipTotal} skipped, ${durationMs}ms`;
  return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: thêm 1 follow-up vào queue
// ─────────────────────────────────────────────────────────────────────────────

async function getCustomerName(customerId: string): Promise<string> {
  const { data } = await supabase
    .from('crm_customers')
    .select('display_name')
    .eq('id', customerId)
    .maybeSingle();
  return data?.display_name || customerId.substring(0, 8);
}

async function insertFollowup(
  sess: { session_key: string; channel_name: string; customer_id: string; agent_slug: string; last_message_at: string; metadata: unknown },
  messages: { vi: string; en: string },
  stage: string,
  prevCount: number,
): Promise<boolean> {
  // Facebook 24h messaging window — skip nếu khách im lặng >24h
  if (isFbChannelOutsideWindow(sess.channel_name, sess.last_message_at)) {
    const stuckH = Math.round((Date.now() - new Date(sess.last_message_at).getTime()) / 3600000);
    log(`⏭ Bỏ qua FB (vượt 24h window) → ${channelLabel(sess.channel_name)} | im lặng ${stuckLabel(stuckH)}`);
    return false;
  }

  // Track A / A4 (plan CSKH-BOT-PAUSE-UX): nếu nhân viên đã trả lời TAY sau tin cuối của khách
  // → đang xử tay, template cứng không biết gì → KHÔNG nag "còn đó không". last_message_at =
  // mốc hoạt động cuối của KHÁCH (outbound không bump), nên manual > mốc = nhân viên đã vào sau.
  const threadId = sess.session_key.split(':')[1];
  if (threadId) {
    const { data: recentManual } = await supabase
      .from('channel_sent_messages')
      .select('created_at')
      .eq('channel_name', sess.channel_name)
      .eq('thread_id', threadId)
      .like('sent_by', 'manual%')
      .gt('created_at', sess.last_message_at)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recentManual) {
      log(`⏭ Bỏ follow-up "${sess.session_key.substring(0, 25)}": nhân viên đã trả tay sau tin khách`);
      return false;
    }
  }

  const { data: channelInstance } = await supabase
    .from('channel_instances')
    .select('id')
    .eq('name', sess.channel_name)
    .single();

  if (!channelInstance) {
    logWarn(`Không tìm thấy channel "${sess.channel_name}" — bỏ qua`);
    return false;
  }

  const lang = pickFollowupLang(sess.channel_name, await lastInboundBody(sess.session_key));
  const message = messages[lang];

  const scheduledAt = new Date(Date.now() + 60 * 1000).toISOString();
  const { error: insErr } = await supabase
    .from('follow_up_queue')
    .insert({
      customer_id: sess.customer_id,
      channel_instance_id: channelInstance.id,
      agent_slug: sess.agent_slug,
      message,
      scheduled_at: scheduledAt,
      status: 'pending',
    });

  if (insErr) {
    logErr(`Không thể thêm queue cho "${sess.session_key.substring(0, 25)}": ${insErr.message}`);
    return false;
  }

  // ATOMIC jsonb-merge (RPC) — KHÔNG read-merge-write cả object (clobber bot_paused nếu owner
  // pause xen giữa scan→write; plan 2026-08-10). Chỉ chạm 3 key follow-up.
  await supabase.rpc('channel_session_merge_meta', {
    p_session_key: sess.session_key,
    p_patch: {
      followup_count: prevCount + 1,
      last_followup_at: new Date().toISOString(),
      last_followup_stage: stage,
    },
  });

  const stuckH = Math.round((Date.now() - new Date(sess.last_message_at).getTime()) / 3600000);
  const customerName = await getCustomerName(sess.customer_id);
  log(`📩 Đặt lịch gửi #${prevCount + 1} → "${customerName}" qua ${channelLabel(sess.channel_name)} | im lặng ${stuckLabel(stuckH)} | loại: ${stage} | ngôn ngữ: ${lang} | agent: ${sess.agent_slug}`);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Queue process cycle: gửi follow-ups đã đến giờ
// ─────────────────────────────────────────────────────────────────────────────

async function processQueueCycle(): Promise<string> {
  const nowIso = new Date().toISOString();
  log('📤 Kiểm tra queue gửi tin...');

  const { data: pending, error } = await supabase
    .from('follow_up_queue')
    .select('id, customer_id, channel_instance_id, agent_slug, message, scheduled_at')
    .eq('status', 'pending')
    .lte('scheduled_at', nowIso)
    .limit(50);

  if (error) {
    logErr(`Lỗi đọc queue: ${error.message}`);
    return `Lỗi: ${error.message}`;
  }

  if (!pending || pending.length === 0) {
    log('📤 Queue trống — không có tin nào cần gửi.');
    return 'Queue trống';
  }

  log(`📤 Đang gửi ${pending.length} tin follow-up...`);
  let sent = 0;
  let failed = 0;

  for (const fu of pending) {
    try {
      const { data: channelInstance } = await supabase
        .from('channel_instances')
        .select('name')
        .eq('id', fu.channel_instance_id)
        .single();

      if (!channelInstance) {
        await markFollowupFailed(fu.id, 'Không tìm thấy channel');
        failed++;
        continue;
      }

      const { data: session } = await supabase
        .from('channel_sessions')
        .select('chat_id, metadata')
        .eq('customer_id', fu.customer_id)
        .eq('channel_name', channelInstance.name)
        // 03/10: lịch đã xếp TRƯỚC khi chị xoá hội thoại cũng không được gửi.
        .not('is_deleted', 'is', true)
      .or('label.is.null,label.not.in.(spam,blocked)') // 03/10: không nhắn chăm sóc spam/đã chặn
        .order('last_message_at', { ascending: false })
        .limit(1)
        .single();

      if (!session) {
        await markFollowupFailed(fu.id, 'Không tìm thấy session');
        failed++;
        continue;
      }

      const meta = (session.metadata as Record<string, unknown>) || {};
      if (meta.bot_paused === true) {
        await markFollowupFailed(fu.id, 'Bot đã tạm dừng (escalated)');
        failed++;
        continue;
      }

      const outbound: OutboundMessage = {
        channel: channelInstance.name,
        chatId: session.chat_id,
        content: fu.message,
        contentType: 'text',
        replyToMessageId: undefined,
        // Reply Gateway (Codex G2): idempotency key so a follow-up can't be sent
        // twice for one queue row (the 8×-listener-leak class, evolog 08/06). One
        // queue row id = one deterministic key.
        dedupeKey: `fu:${fu.id}`,
        metadata: {
          agentSlug: fu.agent_slug,
          isFollowUp: true,
          followUpId: fu.id,
        },
      };
      bus.publishOutbound(outbound);

      await supabase
        .from('follow_up_queue')
        .update({ status: 'sent' })
        .eq('id', fu.id);

      const customerName = await getCustomerName(fu.customer_id);
      log(`✅ Đã gửi → "${customerName}" qua ${channelLabel(channelInstance.name)} | chat: ${session.chat_id} | agent: ${fu.agent_slug}`);
      sent++;
    } catch (err: any) {
      logErr(`Gửi thất bại ${fu.id.substring(0, 8)}: ${err.message}`);
      await markFollowupFailed(fu.id, err.message);
      failed++;
    }
  }

  const summary = `Gửi xong: ${sent} thành công, ${failed} thất bại`;
  log(`📤 ${summary}`);
  return summary;
}

async function markFollowupFailed(id: string, reason: string): Promise<void> {
  try {
    await supabase
      .from('follow_up_queue')
      .update({ status: 'failed' })
      .eq('id', id);
    logWarn(`Đánh dấu thất bại ${id.substring(0, 8)}: ${reason}`);
  } catch {
    /* swallow */
  }
}
