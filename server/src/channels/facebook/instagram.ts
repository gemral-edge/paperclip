// Instagram Messaging (DM) qua Messenger Platform — EC-089 (14/10).
// Meta gửi webhook object "instagram": entry.id = IG professional account id, entry.messaging[]
// cùng dạng Messenger. Trả lời đi đường Page: POST /{page_id}/messages (Page token) recipient = IGSID.
// Module THUẦN (không import bus/supabase) để unit-test parse + route + bỏ echo không chạm mạng.

import { createHmac, timingSafeEqual } from 'crypto';
import type { InboundMessage } from '../types.js';

export interface IgAccount {
  igId: string;
  pageId: string;
  channel: string;
}

// SSOT cặp Page↔IG (đo 14/10: GET /{page}?fields=instagram_business_account) — env ghi đè được.
// Bản đồ thương hiệu: crypto-pattern-scanner/memory/state/brand_asset_map.json (jennie/edge/yinyang-instagram).
export function loadIgAccounts(env: NodeJS.ProcessEnv = process.env): IgAccount[] {
  return [
    {
      igId: env.IG_USER_ID_JENNIE || '17841444853573704',
      pageId: env.FB_PAGE_ID_JENNIE || '101609408467458',
      channel: 'ig-jennie',
    },
    {
      igId: env.IG_USER_ID_GEMRAL || '17841411458556367',
      pageId: env.FB_PAGE_ID_GEMRAL || '893324337205554',
      channel: 'ig-gemral',
    },
    {
      // Page Yinyang THỨ 2 (578361712032089) đang nối @yinyangmasters, KHÔNG phải Page fb-yinyang (dormant VN).
      igId: env.IG_USER_ID_YINYANG || '17841450342830812',
      pageId: env.FB_PAGE_ID_YINYANG_IG || '578361712032089',
      channel: 'ig-yinyang',
    },
  ];
}

/** Meta ký payload bằng app secret: header `X-Hub-Signature-256: sha256=<hex>`. */
export function verifyMetaSignature(rawBody: Buffer | string | undefined, header: string | undefined, appSecret: string): boolean {
  if (!rawBody || !header || !appSecret) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const got = Buffer.from(m[1], 'hex');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/**
 * Echo = tin do CHÍNH tài khoản IG gửi ra (bot Send API / chị gõ tay app Instagram).
 * IG gửi echo trong field `messages` với `message.is_echo=true` và sender.id = IG account id.
 * Kiểm cả 2 dấu hiệu để không bao giờ coi tin của mình là tin khách (vòng lặp tự trả lời).
 */
export function isIgEcho(igId: string, event: any): boolean {
  return event?.message?.is_echo === true || (!!event?.sender?.id && String(event.sender.id) === igId);
}

/**
 * Event messaging IG → InboundMessage (null = bỏ qua: read/reaction/seen, tin bị thu hồi, tin rỗng).
 * KHÔNG xử lý echo ở đây — caller kiểm isIgEcho trước.
 */
export function buildIgInbound(acct: IgAccount, event: any, senderName: string): InboundMessage | null {
  const msg = event?.message;
  if (!msg && !event?.postback) return null;
  if (msg?.is_deleted || msg?.is_unsupported) return null;

  const senderId: string | undefined = event?.sender?.id ? String(event.sender.id) : undefined;
  if (!senderId) return null;

  const text: string = msg?.text || event?.postback?.payload || event?.postback?.title || '';
  const attachments: any[] = Array.isArray(msg?.attachments) ? msg.attachments : [];
  if (!text && attachments.length === 0) return null;

  const mid: string = msg?.mid || event?.postback?.mid || `ig_postback_${event?.timestamp || Date.now()}`;
  const replyTo = msg?.reply_to;
  const hasStoryMention = attachments.some((a: any) => a?.type === 'story_mention');
  // Cùng nhãn với FB (router Tier 0b + consumer ẩn phiên chỉ-có-story): reply/mention STORY không auto-reply.
  const fbContext: 'story_reply' | 'story_mention' | undefined =
    replyTo?.story ? 'story_reply' : hasStoryMention ? 'story_mention' : undefined;

  let content = text;
  if (attachments.length > 0) {
    const info = attachments.map((a: any) => `[${a?.type}: ${a?.payload?.url || 'no-url'}]`).join(' ');
    content = content ? `${content}\n${info}` : info;
  }
  const media = attachments
    .filter((a: any) => a?.payload?.url && a?.type !== 'story_mention')
    .map((a: any) => ({
      url: a.payload.url as string,
      mimeType: a.type === 'image' ? 'image/jpeg' : a.type === 'video' ? 'video/mp4' : 'application/octet-stream',
      filename: undefined,
    }));

  return {
    id: mid,
    channel: acct.channel,
    // 'facebook' = cùng đường Graph/Page token (send proxy routes.ts, inbox_contacts.facebook_id, story filter).
    channelType: 'facebook',
    chatId: senderId, // IGSID
    senderId,
    senderName: senderName || senderId,
    content,
    contentType: attachments.length > 0 && !text ? 'image' : 'text',
    media: media.length > 0 ? media : undefined,
    peerKind: 'direct',
    metadata: {
      platform: 'instagram',
      page_id: acct.pageId,
      ig_user_id: acct.igId,
      attachments: attachments.length > 0 ? attachments : undefined,
      ...(fbContext ? { fb_context: fbContext, story_url: replyTo?.story?.url || undefined } : {}),
      ...(replyTo?.mid ? { reply_to_mid: replyTo.mid } : {}),
    },
    timestamp: event?.timestamp ? new Date(event.timestamp) : new Date(),
    dedupeKey: `ig:${acct.channel}:${senderId}:${mid}`,
  };
}
