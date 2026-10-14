// Facebook Webhook — Messenger DMs + Comment auto-reply
// Handles: inbound DMs (entry.messaging), inbound comments (entry.changes feed),
// outbound dispatch (DM via Messenger API, comment reply via Graph API)
// Integrates with the Channel-Agent Auto-Reply consumer pipeline via bus.publishInbound()

import { Router, type Request, type Response } from 'express';
import { promises as fsp } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { bus } from '../bus.js';
import { supabase } from '../zalo-personal/supabase.js';
import { deliverReplyOnce } from '../deliver-once.js';
import type { InboundMessage, OutboundMessage } from '../types.js';
import { loadIgAccounts, requireMetaSignature, isIgEcho, buildIgInbound, type IgAccount } from './instagram.js';

const router = Router();

const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || 'gemral-fb-webhook-verify-2026';
const GRAPH_API = 'https://graph.facebook.com/v24.0';

// ─── OAuth (Facebook Login for Business) — lấy Page token mới khớp app 998 ───
const FB_APP_ID = process.env.FB_APP_ID || '';
const FB_LOGIN_CONFIG_ID = process.env.FB_LOGIN_CONFIG_ID || '';
const FB_REDIRECT_URI =
  process.env.FB_REDIRECT_URI ||
  'https://gemops.gemcapitalholding.com/api/channels/facebook/oauth/callback';

// Page ID → tên biến .env để ghi đè token bền qua restart
const PAGE_ENV_KEY: Record<string, string> = {
  [process.env.FB_PAGE_ID_JENNIE || '101609408467458']: 'FB_PAGE_TOKEN_JENNIE',
  [process.env.FB_PAGE_ID_GEMRAL || '893324337205554']: 'FB_PAGE_TOKEN_GEMRAL',
  [process.env.FB_PAGE_ID_YINYANG || '844146582110162']: 'FB_PAGE_TOKEN_YINYANG',
};

// Page tokens map (loaded from env)
const PAGE_TOKENS: Record<string, string> = {};
if (process.env.FB_PAGE_TOKEN_JENNIE) PAGE_TOKENS[process.env.FB_PAGE_ID_JENNIE || '101609408467458'] = process.env.FB_PAGE_TOKEN_JENNIE;
if (process.env.FB_PAGE_TOKEN_GEMRAL) PAGE_TOKENS[process.env.FB_PAGE_ID_GEMRAL || '893324337205554'] = process.env.FB_PAGE_TOKEN_GEMRAL;
if (process.env.FB_PAGE_TOKEN_YINYANG) PAGE_TOKENS[process.env.FB_PAGE_ID_YINYANG || '844146582110162'] = process.env.FB_PAGE_TOKEN_YINYANG;
// Page ngoài 3 Page đã đặt tên (vd Page Yinyang thứ 2 đang nối Instagram) — OAuth ghi FB_PAGE_TOKEN_<pageId>
for (const [k, v] of Object.entries(process.env)) {
  const m = /^FB_PAGE_TOKEN_(\d+)$/.exec(k);
  if (m && v && !PAGE_TOKENS[m[1]]) PAGE_TOKENS[m[1]] = v;
}

// Page ID → channel name mapping (dynamic from env + hardcoded fallbacks)
const PAGE_CHANNEL: Record<string, string> = {
  [process.env.FB_PAGE_ID_JENNIE || '101609408467458']: 'fb-jennie',
  [process.env.FB_PAGE_ID_GEMRAL || '893324337205554']: 'fb-gemral',
  [process.env.FB_PAGE_ID_YINYANG || '844146582110162']: 'fb-yinyang',
  // Page Yinyang THỨ 2 "Tinh thể đá quý" (nối IG @yinyangmasters): Messenger vào fb-yinyang-ig,
  // agent yinyang-support như ig-yinyang (brand_asset_map yinyang-instagram). Thiếu dòng này = "Unknown page ID" drop.
  [process.env.FB_PAGE_ID_YINYANG_IG || '578361712032089']: 'fb-yinyang-ig',
};

// Instagram (EC-089): IG account id → {Page, kênh ig-*}. Trả lời dùng Page token của Page nối IG.
const IG_ACCOUNTS: Record<string, IgAccount> = {};
for (const a of loadIgAccounts()) IG_ACCOUNTS[a.igId] = a;

// Sender profile cache (avoid hammering Graph API)
const profileCache = new Map<string, { name: string; expiresAt: number }>();
const PROFILE_CACHE_TTL = 3600_000; // 1 hour

/**
 * GET /api/channels/facebook/webhook — Facebook verification handshake
 */
router.get('/webhook', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === FB_VERIFY_TOKEN) {
    console.log('[FB] Webhook verified');
    res.status(200).send(challenge);
  } else {
    console.warn('[FB] Webhook verification failed');
    res.sendStatus(403);
  }
});

/**
 * POST /api/channels/facebook/webhook — receive inbound messages
 */
router.post('/webhook', requireMetaSignature(() => process.env.FB_APP_SECRET || ''), async (req: Request, res: Response) => {
  const body = req.body;

  if (body.object === 'instagram') {
    await handleInstagramWebhook(req, res);
    return;
  }

  if (body.object !== 'page') {
    res.sendStatus(404);
    return;
  }

  // Always respond 200 quickly to avoid Facebook retry storms
  res.sendStatus(200);

  // Process entries asynchronously
  for (const entry of body.entry || []) {
    const pageId = entry.id;
    const channelName = PAGE_CHANNEL[pageId];
    if (!channelName) {
      console.warn(`[FB] Unknown page ID: ${pageId}`);
      continue;
    }

    for (const event of entry.messaging || []) {
      try {
        await handleMessagingEvent(pageId, channelName, event);
      } catch (err: any) {
        console.error(`[FB] Error handling messaging event:`, err.message);
      }
    }

    // Handle feed changes (comments on posts)
    for (const change of entry.changes || []) {
      if (change.field === 'feed' && change.value?.item === 'comment') {
        try {
          await handleCommentEvent(pageId, channelName, change.value);
        } catch (err: any) {
          console.error(`[FB] Error handling comment event:`, err.message);
        }
      }
    }
  }
});

/**
 * Instagram DM webhook (object=instagram). Chữ ký X-Hub-Signature-256 đã kiểm ở middleware
 * requireMetaSignature của POST /webhook (áp MỌI object, kể cả page).
 */
async function handleInstagramWebhook(req: Request, res: Response): Promise<void> {
  res.sendStatus(200);

  for (const entry of req.body.entry || []) {
    const acct = IG_ACCOUNTS[String(entry.id)];
    if (!acct) {
      console.warn(`[IG] Unknown Instagram account id: ${entry.id}`);
      continue;
    }
    for (const event of entry.messaging || []) {
      try {
        await handleInstagramEvent(acct, event);
      } catch (err: any) {
        console.error('[IG] Error handling messaging event:', err.message);
      }
    }
  }
}

async function handleInstagramEvent(acct: IgAccount, event: any): Promise<void> {
  if (isIgEcho(acct.igId, event)) {
    // Echo = tin tài khoản IG gửi ra: KHÔNG publish inbound (chống tự trả lời chính mình).
    // Tin chị gõ tay trong app Instagram → ghi sổ manual (cùng logic Messenger: bỏ qua tin bot đã có sổ).
    if (event.message?.is_echo) {
      await handleEchoEvent(acct.channel, event).catch((err) =>
        console.error('[IG echo] handler failed:', err?.message || err));
    }
    return;
  }
  const senderId: string | undefined = event?.sender?.id;
  if (!senderId) return;
  const senderName = await resolveSenderName(senderId, acct.pageId, 'instagram');
  const inbound = buildIgInbound(acct, event, senderName);
  if (!inbound) return;
  console.log(`[IG] Message from ${inbound.senderName} on ${acct.channel}: ${inbound.content.slice(0, 100)}`);
  await bus.publishInbound(inbound);
}

/**
 * Process a single messaging event from Facebook.
 * Resolves sender profile, builds InboundMessage, and publishes to the bus.
 */
async function handleMessagingEvent(pageId: string, channelName: string, event: any): Promise<void> {
  const senderId: string = event.sender?.id;

  // ── ECHO = tin do PAGE gửi (bot Send API / chị gõ tay Messenger / facebook-web / Business Suite) ──
  // Track B (plan CSKH-BOT-PAUSE-UX): trước đây nuốt SẠCH → tin chị gõ tay Messenger vô hình với agent.
  // Ghi sổ 'manual_fb' để Track A tiêm cho agent thấy (KHÔNG auto-pause — OD-2). Phân loại phòng thủ
  // nhiều lớp (app_id KHÔNG đủ: facebook-web dùng BUSINESS_APP_ID trùng Page inbox — vòng 1 ROLL-F2).
  if (event.message?.is_echo) {
    await handleEchoEvent(channelName, event).catch((err) =>
      console.error('[FB echo] handler failed:', err?.message || err));
    return;
  }

  // Skip if no message content and no postback
  if (!event.message && !event.postback) return;

  const messageText: string = event.message?.text || event.postback?.payload || '';
  const attachments: any[] = event.message?.attachments || [];
  const messageId: string = event.message?.mid || `postback_${Date.now()}`;
  const timestamp = event.timestamp ? new Date(event.timestamp) : new Date();

  // STORY FILTER (27/09): khách trả lời / nhắc tên trong STORY của Page tới qua Messenger như
  // một DM thường (Graph gắn `message.reply_to.story` hoặc attachment `story_mention`). Đó là
  // phản ứng với nội dung (emoji 🔥👍, "cảm ơn đã chia sẻ"), KHÔNG phải khách hỏi — để agent
  // trả lời thì câu trả lời lạc đề ("Xin lỗi, em không thể xử lý yêu cầu này."). Gắn nhãn
  // fb_context → router bỏ auto-reply, consumer ẩn phiên chỉ-có-story khỏi Hộp thư.
  const replyTo = event.message?.reply_to;
  const hasStoryMention = attachments.some((a: any) => a?.type === 'story_mention');
  const fbContext: 'story_reply' | 'story_mention' | undefined =
    replyTo?.story ? 'story_reply' : hasStoryMention ? 'story_mention' : undefined;

  // Resolve sender name from Graph API (cached)
  const senderName = await resolveSenderName(senderId, pageId);

  console.log(`[FB] Message from ${senderName} on ${channelName}: ${messageText.slice(0, 100)}`);

  // Build content: text + attachment descriptions
  let content = messageText;
  if (attachments.length > 0) {
    const attachInfo = attachments
      .map((a: any) => `[${a.type}: ${a.payload?.url || 'no-url'}]`)
      .join(' ');
    content = content ? `${content}\n${attachInfo}` : attachInfo;
  }

  // Build media array for attachments
  const media = attachments
    .filter((a: any) => a.payload?.url)
    .map((a: any) => ({
      url: a.payload.url as string,
      mimeType: a.type === 'image' ? 'image/jpeg' : a.type === 'video' ? 'video/mp4' : 'application/octet-stream',
      filename: undefined,
    }));

  // Publish to the consumer pipeline via bus (handles persistence + agent routing)
  const inbound: InboundMessage = {
    id: messageId,
    channel: channelName,
    channelType: 'facebook',
    chatId: senderId, // FB DMs use sender PSID as thread ID
    senderId,
    senderName,
    content,
    contentType: attachments.length > 0 && !messageText ? 'image' : 'text',
    media: media.length > 0 ? media : undefined,
    peerKind: 'direct', // FB Messenger is always DM
    metadata: {
      platform: 'facebook',
      page_id: pageId,
      attachments: attachments.length > 0 ? attachments : undefined,
      ...(fbContext ? { fb_context: fbContext, story_url: replyTo?.story?.url || undefined } : {}),
      ...(replyTo?.mid ? { reply_to_mid: replyTo.mid } : {}),
    },
    timestamp,
    dedupeKey: `fb:${channelName}:${senderId}:${messageId}`,
  };

  await bus.publishInbound(inbound);
}

/** Postgres unique-violation (idx_csm_platform_mid) — race 2 webhook cùng mid → 1 thắng, bỏ qua. */
function isDupErr(err: { code?: string } | null | undefined): boolean {
  return err?.code === '23505';
}

/**
 * Xử lý ECHO của Facebook (tin do Page gửi). Ghi 'manual_fb' CHỈ khi là tin NGƯỜI gõ tay,
 * KHÔNG ghi cho tin bot (Send API / facebook-web / Business Suite auto-reply).
 * ⚠️ Cần bật field webhook `message_echoes` ở App Dashboard mỗi Page, nếu không echo không về.
 */
async function handleEchoEvent(channelName: string, event: any): Promise<void> {
  const threadId: string | undefined = event.recipient?.id; // ECHO: recipient = KHÁCH (sender = Page!)
  const mid: string | undefined = event.message?.mid;
  if (!threadId || !mid) return;

  const text: string = event.message?.text || '';
  const attachments: any[] = event.message?.attachments || [];
  const appId: string | null = event.message?.app_id != null ? String(event.message.app_id) : null;
  const body = text || (attachments.length ? '[đính kèm]' : '');

  // Lớp (b0) — KHỚP CHÍNH XÁC theo mid (Codex code-R2): tin hệ-mình mà handler đã stamp
  // platform_message_id = mid này → row định danh TUYỆT ĐỐI, không cần đoán theo body ⇒ chống
  // cross-stamp khi 2 tin trùng nội dung cùng thread. Đã resolve rồi (mid có = handler chạy xong)
  // → chỉ cần bỏ qua, KHÔNG ghi manual_fb.
  const { data: byMid } = await supabase
    .from('channel_sent_messages')
    .select('id')
    .eq('platform_message_id', mid)
    .limit(1);
  if (byMid && byMid.length > 0) return;

  // Lớp (b) — LƯỚI body-match: cho row CHƯA stamp mid (facebook-web/Business Suite, hoặc claim row
  // mà update sau Graph-OK lỗi). Đối chiếu (thread_id, body, 5'). Row đã stamp mid đã do (b0) bắt ở trên.
  const since = new Date(Date.now() - 5 * 60_000).toISOString();
  const { data: recent } = await supabase
    .from('channel_sent_messages')
    .select('id, platform_message_id, status')
    .eq('thread_id', threadId)
    .eq('body', body)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1);
  if (recent && recent.length > 0) {
    // Tin của hệ thống mình → stamp mid nếu chưa có + RECONCILE status (Codex code-F1): row của
    // claim-before-send có thể còn kẹt 'sending' nếu update sau Graph-OK lỗi → echo về lật nốt 'sent'.
    const row = recent[0] as { id: string; platform_message_id: string | null; status: string | null };
    const patch: Record<string, unknown> = {};
    if (!row.platform_message_id) patch.platform_message_id = mid;
    if (row.status === 'sending') patch.status = 'sent';
    if (Object.keys(patch).length > 0) {
      const { error } = await supabase.from('channel_sent_messages').update(patch).eq('id', row.id);
      if (error && !isDupErr(error)) console.warn('[FB echo] reconcile row failed:', error.message);
    }
    return;
  }

  // Lớp (a) — DỰ PHÒNG: app_id trùng app bot Send API của mình mà body-match trượt (chưa kịp ghi row)
  //           → vẫn coi là bot, KHÔNG ghi manual. facebook-web/Business Suite đã do lớp (b) bắt.
  if (appId && FB_APP_ID && appId === FB_APP_ID) {
    console.log(`[FB echo] app_id=${appId} khớp app bot Send API (body-match trượt) → coi là bot, skip`);
    return;
  }

  // Lớp (c) — còn lại = chị/nhân viên GÕ TAY trong Messenger/Page inbox → ghi sổ manual_fb cho Track A.
  const media = attachments.filter((a: any) => a.payload?.url).map((a: any) => a.payload.url as string);
  const { error } = await supabase.from('channel_sent_messages').insert({
    channel_name: channelName,
    thread_id: threadId,
    thread_type: 'dm',
    to_uid: threadId,
    body: body || '[Tin nhân viên]',
    content_type: media.length > 0 && !text ? 'image' : 'text',
    media: media.length > 0 ? media : null,
    status: 'sent',
    sent_by: 'manual_fb',
    platform_message_id: mid,
  });
  if (error && !isDupErr(error)) console.error('[FB echo] insert manual_fb failed:', error.message);
  else if (!error) console.log(`[FB echo] ✓ manual_fb logged thread=${threadId}: ${body.slice(0, 50)}`);
}

/**
 * Process a comment event from Facebook feed webhook.
 * Builds InboundMessage with peerKind='comment' and publishes to the bus.
 */
async function handleCommentEvent(pageId: string, channelName: string, value: any): Promise<void> {
  const commentId: string = value.comment_id;
  const senderId: string = value.from?.id;
  const senderName: string = value.from?.name || senderId;
  const message: string = value.message || '';
  const postId: string = value.post_id;
  const parentId: string | undefined = value.parent_id;
  const createdTime: string | undefined = value.created_time;

  // Skip if the comment is from the page itself (page's own reply)
  if (senderId === pageId) {
    console.log(`[FB] Skipping own comment on ${channelName}: ${commentId}`);
    return;
  }

  // Skip if no message content
  if (!message.trim()) {
    console.log(`[FB] Skipping empty comment on ${channelName}: ${commentId}`);
    return;
  }

  const timestamp = createdTime ? new Date(parseInt(createdTime) * 1000) : new Date();

  console.log(`[FB] Comment from ${senderName} on ${channelName} (post=${postId}): ${message.slice(0, 100)}`);

  // Build InboundMessage — chatId is post_id so all comments on same post share one conversation
  const inbound: InboundMessage = {
    id: commentId,
    channel: channelName,
    channelType: 'facebook',
    chatId: postId, // Group conversation by post
    senderId,
    senderName,
    content: message,
    contentType: 'text',
    peerKind: 'comment',
    metadata: {
      platform: 'facebook',
      page_id: pageId,
      comment_id: commentId,
      post_id: postId,
      parent_id: parentId,
    },
    timestamp,
    dedupeKey: `fb:${channelName}:comment:${commentId}`,
  };

  await bus.publishInbound(inbound);
}

/**
 * Resolve sender name from Facebook Graph API with caching.
 */
async function resolveSenderName(senderId: string, pageId: string, platform: 'facebook' | 'instagram' = 'facebook'): Promise<string> {
  const cacheKey = `${platform}:${pageId}:${senderId}`;
  const cached = profileCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.name;
  }

  const token = PAGE_TOKENS[pageId];
  if (!token) return senderId;

  try {
    const profileRes = await fetch(
      platform === 'instagram'
        ? `${GRAPH_API}/${senderId}?fields=name,username&access_token=${token}`
        : `${GRAPH_API}/${senderId}?fields=first_name,last_name,profile_pic&access_token=${token}`
    );
    if (profileRes.ok) {
      const profile = await profileRes.json();
      const name = platform === 'instagram'
        ? (profile.name || (profile.username ? `@${profile.username}` : '') || senderId)
        : (`${profile.first_name || ''} ${profile.last_name || ''}`.trim() || senderId);
      profileCache.set(cacheKey, { name, expiresAt: Date.now() + PROFILE_CACHE_TTL });
      return name;
    }
  } catch {
    // Non-fatal — fall back to sender ID
  }

  return senderId;
}

/**
 * Dọn row đã CLAIM khi Graph từ chối/không gửi được (plan 2026-08-19 §5.2, Codex R5/R6).
 * Hàm THUẦN (nhận client qua tham số) để unit-test 3 nhánh không cần chạm mạng:
 *  - delete OK               → 400 {error} (sạch, không tin ma)
 *  - delete lỗi, update OK   → 400 {error + '…còn hiện trong lịch sử…', cleanup_degraded:true}
 *  - delete lỗi, update lỗi  → 400 {error + '…dọn sổ thất bại…', cleanup_failed:true}
 * MỌI nhánh để-lại-row đều gắn cờ + câu nói rõ để người trực biết bubble đó là tin CHƯA tới khách
 * (transcript/UI không lọc status — ngoài phạm vi fix này; xử lý tại đây bằng thông điệp).
 */
export async function cleanupClaimedRow(
  db: Pick<typeof supabase, 'from'>,
  rowId: string,
  graphMsg: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let { error: delErr } = await db.from('channel_sent_messages').delete().eq('id', rowId);
  if (delErr) {
    // Retry 1 lần: lỗi delete thường transient → xoá sạch được thì KHÔNG để lại 'failed' bubble (Codex code-F2).
    ({ error: delErr } = await db.from('channel_sent_messages').delete().eq('id', rowId));
  }
  if (!delErr) return { status: 400, body: { error: graphMsg } };

  const { error: updErr } = await db.from('channel_sent_messages')
    .update({ status: 'failed' }).eq('id', rowId);
  if (!updErr) {
    return { status: 400, body: {
      error: `${graphMsg} (⚠️ tin CHƯA tới khách nhưng vẫn còn hiện trong lịch sử — bỏ qua bubble đó)`,
      cleanup_degraded: true,
    } };
  }

  console.error('[FB send] cleanup FAILED for row', rowId, '·', delErr.message, '·', updErr.message);
  return { status: 400, body: {
    error: `${graphMsg} (⚠️ dọn sổ thất bại — bubble này trong lịch sử là tin CHƯA tới khách)`,
    cleanup_failed: true,
  } };
}

/**
 * POST /api/channels/facebook/send — send a message to a Facebook user.
 * Body: bot Send API cũ `{ page_id, recipient_id, message, message_type? }`
 *   HOẶC body universal (proxy từ /api/channels/send, gửi tay từ inbox):
 *   `{ channel_name, thread_id, message, thread_type?, sent_by? }` (plan 2026-08-19 §5.2).
 * CLAIM-BEFORE-SEND: ghi row 'sending' TRƯỚC khi gọi Graph (fail-closed nếu ghi lỗi) → chống
 * echo ghi nhầm 'manual_fb' + chống gửi lại khi response rớt.
 */
router.post('/send', async (req: Request, res: Response) => {
  const { message, message_type, channel_name, thread_id, thread_type, sent_by } = req.body;
  const page_id = req.body.page_id || (channel_name ? CHANNEL_PAGE[channel_name] : undefined);
  const recipient_id = req.body.recipient_id || thread_id;

  // Comment thread fail-closed: session comment có thread_id = post_id (KHÔNG phải comment_id)
  // ⇒ không thể reply đúng comment từ đường này. Báo rõ thay vì gửi DM nhầm người.
  if (thread_type === 'comment') {
    res.status(400).json({ error: 'Chưa hỗ trợ trả lời bình luận tay từ inbox (thread_id là post_id, không phải comment_id).' });
    return;
  }

  if (!page_id || !recipient_id || !message) {
    res.status(400).json({ error: 'Missing page_id/channel_name, recipient_id/thread_id, or message' });
    return;
  }

  const token = PAGE_TOKENS[page_id];
  if (!token) {
    res.status(400).json({ error: `No token configured for page ${page_id}` });
    return;
  }

  const bodyText = typeof message === 'string' ? message : JSON.stringify(message);

  // CLAIM-BEFORE-SEND (fail-closed, plan §5.2 + Codex R1-F2): ghi row 'sending' TRƯỚC Graph.
  //  - Echo message_echoes có thể về TRƯỚC → lớp (b) body-match tra trúng row này ⇒ KHÔNG ghi 'manual_fb'.
  //  - Response tới proxy rớt sau Graph OK → transcript ĐÃ có bản này ⇒ người trực không gõ lại.
  //  - Insert lỗi ⇒ KHÔNG gọi Graph (thà 500 còn hơn khách nhận tin mà hệ không có sổ).
  const { data: row, error: claimErr } = await supabase.from('channel_sent_messages').insert({
    // ig-* dùng chung Page với fb-* → giữ đúng kênh người trực đang gửi, không quy về fb-*.
    channel_name: (channel_name && CHANNEL_PAGE[channel_name] === page_id ? channel_name : undefined) || PAGE_CHANNEL[page_id] || `fb-${page_id}`,
    thread_id: recipient_id,
    thread_type: 'dm',
    to_uid: recipient_id,
    body: bodyText,
    content_type: 'text',
    status: 'sending',
    sent_by: sent_by || 'api',
  }).select('id').single();
  if (claimErr || !row?.id) {
    res.status(500).json({ error: `Không ghi sổ được tin (chưa gửi): ${claimErr?.message || 'no id'}` });
    return;
  }
  const rowId = row.id as string;

  try {
    const fbRes = await fetch(`${GRAPH_API}/${page_id}/messages?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipient_id },
        message: typeof message === 'string' ? { text: message } : message,
        messaging_type: message_type || 'RESPONSE',
      }),
    });

    const result = await fbRes.json();
    if (result.error) {
      console.error(`[FB] Send error:`, result.error);
      const { status, body } = await cleanupClaimedRow(supabase, rowId, result.error.message);
      res.status(status).json(body);
      return;
    }

    // Graph OK → lật 'sending' → 'sent' + stamp mid (echo body-match tra trúng row này, KHÔNG double).
    // (Codex code-F1) Nếu update LỖI: tin ĐÃ tới khách (Graph trả message_id) ⇒ KHÔNG bảo gửi lại;
    // row có thể kẹt 'sending' cho tới khi echo về reconcile (lớp b) → log to + cờ persist_degraded.
    const { error: stampErr } = await supabase.from('channel_sent_messages')
      .update({ status: 'sent', platform_message_id: result.message_id || null })
      .eq('id', rowId);
    if (stampErr) console.error('[FB send] stamp-sent FAILED after Graph OK — row', rowId, 'kẹt sending tới khi echo reconcile:', stampErr.message);

    // [test-only, Codex R4] Delay SAU claim+Graph+stamp, TRƯỚC res → tái tạo TẤT ĐỊNH ca
    // "đã gửi + đã ghi sổ, proxy không nhận được phản hồi". Mặc định không set env ⇒ 0 tác dụng.
    const testDelay = Number(process.env.FB_SEND_TEST_DELAY_MS) || 0;
    if (testDelay > 0) await new Promise((r) => setTimeout(r, testDelay));

    res.json({ success: true, message_id: result.message_id, ...(stampErr ? { persist_degraded: true } : {}) });
  } catch (err: any) {
    // Lỗi mạng khi gọi Graph (gần như luôn = request KHÔNG hoàn tất = chưa gửi) → dọn row như Graph-error.
    const { status, body } = await cleanupClaimedRow(supabase, rowId, err.message);
    res.status(status).json(body);
  }
});

/**
 * POST /api/channels/facebook/comment-reply — reply to a Facebook comment
 * Body: { page_id, comment_id, message }
 */
router.post('/comment-reply', async (req: Request, res: Response) => {
  const { page_id, comment_id, message } = req.body;

  if (!page_id || !comment_id || !message) {
    res.status(400).json({ error: 'Missing page_id, comment_id, or message' });
    return;
  }

  const token = PAGE_TOKENS[page_id];
  if (!token) {
    res.status(400).json({ error: `No token configured for page ${page_id}` });
    return;
  }

  try {
    const fbRes = await fetch(`${GRAPH_API}/${comment_id}/comments?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });

    const result = await fbRes.json();
    if (result.error) {
      console.error(`[FB] Comment reply error:`, result.error);
      res.status(400).json({ error: result.error.message });
      return;
    }

    // Log to channel_sent_messages for audit trail (non-blocking)
    void supabase.from('channel_sent_messages').insert({
      channel_name: PAGE_CHANNEL[page_id] || `fb-${page_id}`,
      thread_id: comment_id,
      thread_type: 'comment',
      to_uid: comment_id,
      body: message,
      content_type: 'text',
      status: 'sent',
      sent_by: 'api',
    }).then(() => {}, () => {});

    res.json({ success: true, comment_id: result.id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/channels/facebook/pages — list configured pages and their status
 */
router.get('/pages', (_req: Request, res: Response) => {
  const pages = Object.entries(PAGE_CHANNEL).map(([pageId, channelName]) => ({
    page_id: pageId,
    channel_name: channelName,
    has_token: !!PAGE_TOKENS[pageId],
  }));
  res.json(pages);
});

// ─── Reverse lookup: channel name → page ID ───
const CHANNEL_PAGE: Record<string, string> = {};
for (const [pageId, channelName] of Object.entries(PAGE_CHANNEL)) {
  CHANNEL_PAGE[channelName] = pageId;
}
// ig-* → Page nối IG: outbound bus + gửi tay (/send) đi POST /{page_id}/messages recipient=IGSID.
for (const a of Object.values(IG_ACCOUNTS)) CHANNEL_PAGE[a.channel] = a.pageId;

/**
 * Outbound message handler: subscribe to bus outbound events for fb-* channels.
 * Routes to Messenger send (DMs) or comment reply (comments) based on peerKind.
 */
bus.on('outbound', async (msg: OutboundMessage) => {
  const pageId = CHANNEL_PAGE[msg.channel];
  if (!pageId) return; // Not a Facebook channel — skip

  const token = PAGE_TOKENS[pageId];
  if (!token) {
    console.warn(`[FB] No token for outbound on ${msg.channel}`);
    return;
  }

  const peerKind = msg.metadata?.peerKind as string | undefined;
  const commentId = msg.metadata?.comment_id as string | undefined;
  const threadId = (peerKind === 'comment' ? commentId : msg.chatId) as string;
  const threadType = peerKind === 'comment' ? 'comment' : 'dm';

  // The customer-visible send (Graph API). Throws on a Graph error so the Reply
  // Gateway (or the manual catch below) treats it as failed (Codex F2).
  const doSend = async (): Promise<{ platformMessageId: string | null }> => {
    if (peerKind === 'comment' && commentId) {
      const fbRes = await fetch(`${GRAPH_API}/${commentId}/comments?access_token=${token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg.content }),
      });
      const result = await fbRes.json();
      if (result.error) throw new Error(`FB comment reply error: ${JSON.stringify(result.error)}`);
      console.log(`[FB] Comment reply sent on ${msg.channel} → ${commentId}: "${msg.content.slice(0, 60)}"`);
      return { platformMessageId: result.id ?? null };
    } else {
      const fbRes = await fetch(`${GRAPH_API}/${pageId}/messages?access_token=${token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: { id: msg.chatId }, message: { text: msg.content }, messaging_type: 'RESPONSE' }),
      });
      const result = await fbRes.json();
      if (result.error) throw new Error(`FB DM error: ${JSON.stringify(result.error)}`);
      console.log(`[FB] DM sent on ${msg.channel} → ${msg.chatId}: "${msg.content.slice(0, 60)}"`);
      return { platformMessageId: result.message_id ?? null };
    }
  };

  const logRow = {
    channel_name: msg.channel, thread_id: threadId, thread_type: threadType,
    to_uid: msg.chatId, body: msg.content, content_type: 'text',
    sent_by: msg.metadata?.agentSlug || 'system',
  };

  try {
    if (msg.dedupeKey) {
      // Reply Gateway: claim-before-send owns the channel_sent_messages row.
      await deliverReplyOnce(msg.dedupeKey, logRow, doSend);
    } else {
      // Manual path (no idempotency key): send + best-effort log, unchanged.
      await doSend();
      void supabase.from('channel_sent_messages').insert({ ...logRow, status: 'sent' }).then(() => {}, () => {});
    }
  } catch (err: any) {
    console.error(`[FB] Outbound send failed on ${msg.channel}:`, err.message);
  }
});

// ─── Token setter: nạp nóng in-memory + đăng ký routing map + ghi .env (OD-1 A) ───
// (Opus CRITICAL F1) PHẢI đăng ký CẢ PAGE_CHANNEL + CHANNEL_PAGE, nếu không POST /webhook
// gặp pageId lạ → "Unknown page ID" → tin DROP CÂM.
async function setPageToken(pageId: string, token: string, channelName?: string): Promise<void> {
  PAGE_TOKENS[pageId] = token;
  const ch = channelName || PAGE_CHANNEL[pageId] || `fb-${pageId}`;
  PAGE_CHANNEL[pageId] = ch;
  CHANNEL_PAGE[ch] = pageId;

  // Ghi bền vào .env: 3 page đã đặt tên dùng biến riêng; page khác → FB_PAGE_TOKEN_<pageId>
  // (trước 14/10 page lạ chỉ nạp nóng → mất token khi restart, Page Yinyang có Instagram bị bỏ sót)
  const envKey = PAGE_ENV_KEY[pageId] || (/^\d+$/.test(pageId) ? `FB_PAGE_TOKEN_${pageId}` : '');
  if (!envKey) return;
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    let content = await fsp.readFile(envPath, 'utf8');
    const line = `${envKey}=${token}`;
    const re = new RegExp(`^${envKey}=.*$`, 'm');
    content = re.test(content) ? content.replace(re, line) : `${content.replace(/\s*$/, '')}\n${line}\n`;
    await fsp.writeFile(envPath, content, 'utf8');
    console.log(`[FB] Persisted ${envKey} to .env (page ${pageId} → ${ch})`);
  } catch (err: any) {
    console.warn(`[FB] Could not persist ${envKey} to .env:`, err.message);
  }
}

// CSRF state store (in-memory, TTL 10 phút) — Opus LOW F8
const oauthStates = new Map<string, number>();
function newState(): string {
  const s = randomUUID();
  oauthStates.set(s, Date.now() + 600_000);
  return s;
}
function consumeState(s: string): boolean {
  const exp = oauthStates.get(s);
  oauthStates.delete(s);
  return !!exp && exp > Date.now();
}

/**
 * GET /api/channels/facebook/oauth/start — bắt đầu luồng "Đăng nhập bằng Facebook"
 * → redirect tới Business Login dialog (config_id). User consent → callback.
 */
router.get('/oauth/start', (_req: Request, res: Response) => {
  if (!FB_APP_ID || !FB_LOGIN_CONFIG_ID) {
    res.status(500).send('Thiếu FB_APP_ID / FB_LOGIN_CONFIG_ID trong .env');
    return;
  }
  const state = newState();
  const url =
    `https://www.facebook.com/v24.0/dialog/oauth?` +
    `client_id=${encodeURIComponent(FB_APP_ID)}` +
    `&config_id=${encodeURIComponent(FB_LOGIN_CONFIG_ID)}` +
    `&redirect_uri=${encodeURIComponent(FB_REDIRECT_URI)}` +
    `&state=${encodeURIComponent(state)}` +
    `&response_type=code`;
  res.redirect(url);
});

/**
 * GET /api/channels/facebook/oauth/callback — nhận code → đổi ra Page token(s) never-expires,
 * lưu (.env + nạp nóng), auto-subscribe từng Page vào webhook app.
 */
router.get('/oauth/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  const err = req.query.error_description as string | undefined;

  if (err) { res.status(400).send(`Facebook trả lỗi: ${err}`); return; }
  if (!code || !state || !consumeState(state)) {
    res.status(400).send('State không hợp lệ hoặc thiếu code (thử đăng nhập lại).');
    return;
  }

  const appSecret = process.env.FB_APP_SECRET || '';
  if (!FB_APP_ID || !appSecret) { res.status(500).send('Thiếu FB_APP_ID / FB_APP_SECRET.'); return; }

  try {
    // 1) code → short-lived user token
    const tokRes = await fetch(
      `${GRAPH_API}/oauth/access_token?client_id=${encodeURIComponent(FB_APP_ID)}` +
      `&client_secret=${encodeURIComponent(appSecret)}` +
      `&redirect_uri=${encodeURIComponent(FB_REDIRECT_URI)}` +
      `&code=${encodeURIComponent(code)}`
    );
    const tok = await tokRes.json();
    if (tok.error) throw new Error(`exchange code: ${JSON.stringify(tok.error)}`);
    const shortUserToken = tok.access_token as string;

    // 2) short → long-lived user token (page tokens dẫn xuất từ đây = never-expires)
    const llRes = await fetch(
      `${GRAPH_API}/oauth/access_token?grant_type=fb_exchange_token` +
      `&client_id=${encodeURIComponent(FB_APP_ID)}` +
      `&client_secret=${encodeURIComponent(appSecret)}` +
      `&fb_exchange_token=${encodeURIComponent(shortUserToken)}`
    );
    const ll = await llRes.json();
    const longUserToken = (ll.error ? shortUserToken : ll.access_token) as string;

    // 3) /me/accounts → danh sách Page + page access_token
    const accRes = await fetch(
      `${GRAPH_API}/me/accounts?fields=id,name,access_token&limit=100&access_token=${encodeURIComponent(longUserToken)}`
    );
    const acc = await accRes.json();
    if (acc.error) throw new Error(`me/accounts: ${JSON.stringify(acc.error)}`);
    const pages: Array<{ id: string; name: string; access_token: string }> = acc.data || [];
    if (pages.length === 0) {
      res.status(200).send('Đăng nhập OK nhưng không có Page nào được cấp quyền. Thử lại và chọn Page.');
      return;
    }

    // 4) lưu token + 5) auto-subscribe từng Page vào webhook app
    const results: Array<{ name: string; id: string; subscribed: boolean }> = [];
    for (const p of pages) {
      await setPageToken(p.id, p.access_token, PAGE_CHANNEL[p.id]);
      let subscribed = false;
      try {
        const subRes = await fetch(
          `${GRAPH_API}/${p.id}/subscribed_apps?access_token=${encodeURIComponent(p.access_token)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // +message_echoes (Track B): nhận bản sao tin Page gửi ra (kể cả chị gõ tay Messenger)
            // → agent thấy nhân viên đã trả gì. Giữ trong code để OAuth re-subscribe không rớt field.
            body: JSON.stringify({ subscribed_fields: ['messages', 'messaging_postbacks', 'feed', 'message_echoes'] }),
          }
        );
        const sub = await subRes.json();
        subscribed = !!sub.success;
        if (sub.error) console.warn(`[FB] subscribe ${p.id}:`, JSON.stringify(sub.error));
      } catch (e: any) {
        console.warn(`[FB] subscribe ${p.id} failed:`, e.message);
      }
      console.log(`[FB] OAuth connected Page ${p.name} (${p.id}) → ${PAGE_CHANNEL[p.id]} · subscribed=${subscribed}`);
      results.push({ name: p.name, id: p.id, subscribed });
    }

    const rows = results
      .map((r) => `<li><b>${r.name}</b> (${r.id}) — ${r.subscribed ? '✅ đã kết nối webhook' : '⚠️ chưa subscribe'}</li>`)
      .join('');
    res.status(200).send(
      `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:560px;margin:48px auto;padding:0 16px">` +
      `<h2>✅ Đã kết nối Facebook</h2><p>Các Page đã lấy token mới (khớp app Gemral Growth) + đăng ký nhận tin:</p>` +
      `<ul>${rows}</ul><p style="color:#666">Bạn có thể đóng cửa sổ này.</p></body>`
    );
  } catch (e: any) {
    console.error('[FB] OAuth callback error:', e.message);
    res.status(500).send(`Lỗi khi lấy token: ${e.message}`);
  }
});

export default router;
