// paperclip/server/src/channels/cskh/channel.ts
import { readFileSync, rmSync } from 'fs';
import { join as pathJoin, basename as pathBasename } from 'path';
import { bus } from '../bus.js';
import { supabase } from './supabase.js';
import { mirrorReplyToCustomer, mirrorReplyToVisitor } from './mirror.js';
import { pushSupportReply } from './push.js';
import { goiEdgeGemral } from './edge-call.js';
import { isImageMedia, resolveMediaToLocalPath } from '../media-util.js';
import { deliverReplyOnce } from '../deliver-once.js';
import type { Channel, ChannelType, OutboundMessage, MediaFile } from '../types.js';

export const CSKH_CHANNEL_NAME = 'cskh-internal';

/**
 * Self-hosted internal channel. Both ends are on our platform, so there is no
 * external API: outbound = log to channel_sent_messages (Paperclip inbox view)
 * + mirror to cskh_messages (customer view) + push the customer.
 * Inbound is handled entirely by the edge function `cskh-inbound`
 * (insert channel_pending_messages → bus realtime → consumer), so this adapter
 * has no listener.
 */
export class CskhChannel implements Channel {
  name = CSKH_CHANNEL_NAME;
  type: ChannelType = 'cskh';
  private running = false;
  private busListenerInstalled = false;

  async start(): Promise<void> {
    this.installBusOutboundHandler();
    this.running = true;
    console.log('[cskh] Channel started (internal, no external listener)');
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  isAllowed(_senderId: string): boolean {
    return true;
  }

  private installBusOutboundHandler(): void {
    if (this.busListenerInstalled) return;
    this.busListenerInstalled = true;
    bus.on('outbound', async (msg: OutboundMessage) => {
      // Handle every internal CSKH channel (cskh-internal, cskh-shopify, ...).
      if (!msg.channel?.startsWith('cskh-')) return;
      try {
        await this.send(msg);
      } catch (err: any) {
        console.error('[cskh] outbound exception:', err?.message || err);
      }
    });
  }

  /** OutboundMessage.chatId === customer user_id (internal) or visitor_id (shopify). */
  async send(msg: OutboundMessage): Promise<void> {
    const threadId = msg.chatId;
    const agentSlug = (msg.metadata?.agentSlug as string) || null;
    // channel_sent_messages.sent_by = BARE agent slug (SSOT 2026-08-03). CSKH trước
    // ghi `agent:<slug>` = split-brain: 6 kênh khác (zalo/fb/fb-web/youtube/manager)
    // + cột `agent_slug` (pending/follow_up) + consumer agent-config-routes `.eq('sent_by', slug)`
    // đều dùng slug TRẦN → cskh prefix làm view hoạt-động-agent bỏ sót tin cskh. Prefix `agent:`
    // chỉ dành cho KG entity-id (khái niệm khác), KHÔNG cho sent_by.
    const sentBy = (msg.metadata?.sentBy as string) || agentSlug || 'agent';
    const isVisitor = msg.channel !== 'cskh-internal';

    // The customer-visible action for CSKH is the cskh_messages mirror (the app
    // reads that table), NOT channel_sent_messages. So the mirror is what deliverFn
    // must do + assert. push (notify) is best-effort: if push fails but the mirror
    // succeeded the customer still sees the reply in-app → stay 'sent'.
    // `sentRowId` do deliverReplyOnce truyền xuống = id row channel_sent_messages nó vừa claim.
    // Đường không-claim (gửi tay) truyền null ⇒ mirror ghi origin_store='local_only'.
    const doMirrorAndPush = async (sentRowId: string | null): Promise<{ platformMessageId: string | null }> => {
      if (isVisitor) {
        const r = await mirrorReplyToVisitor(threadId, 'assistant', msg.content, sentRowId, agentSlug, msg.channel);
        if (r.error) throw new Error(`cskh mirror failed: ${r.error}`);  // F1: don't mark 'sent' on lost reply
        const preview = msg.content.length > 80 ? msg.content.slice(0, 80) + '…' : msg.content;
        // Qua edge-call: client dùng chung cầm service_role → cổng 'secret' từ chối 401 (28/07).
        void goiEdgeGemral('cskh-notify-offline', { visitor_id: threadId, channel: msg.channel, preview });
      } else {
        const r = await mirrorReplyToCustomer(threadId, 'assistant', msg.content, sentRowId, agentSlug);
        if (r.error) throw new Error(`cskh mirror failed: ${r.error}`);  // F1
        try { await pushSupportReply(threadId, msg.content); } catch (e: any) { console.error('[cskh] push failed (best-effort):', e?.message || e); }
      }
      return { platformMessageId: null };
    };

    // Step 1: gửi TEXT trước (khách thấy lời tư vấn trước, ảnh sau — như Zalo). Chỉ khi có nội dung.
    if (msg.content && msg.content.trim()) {
      if (msg.dedupeKey) {
        // Reply Gateway: claim owns the channel_sent_messages row (replaces
        // logSentMessage) + gates against double-reply; deliverFn = the mirror.
        const outcome = await deliverReplyOnce(
          msg.dedupeKey,
          { channel_name: msg.channel, thread_id: threadId, thread_type: 'dm', to_uid: threadId,
            body: msg.content, content_type: 'text', sent_by: sentBy },
          doMirrorAndPush,
        );
        if (outcome !== 'sent') return;  // failed OR duplicate → skip media too
      } else {
        // Manual/human path (no idempotency key): log + mirror + push.
        // logSentMessage nay TRẢ VỀ id row để mirror nối được sang kho Paperclip.
        const manualSentId = await this.logSentMessage(msg.channel, threadId, msg.content, sentBy);
        await doMirrorAndPush(manualSentId);
      }
    }

    // Step 2: gửi MEDIA (agy [[SEND_MEDIA]] → ảnh crystal...). Khách CSKH đọc cskh_messages.attachment_url
    // = URL công khai → file media-library LOCAL phải upload lên bucket cskh-attachments trước
    // (khác Zalo gửi qua protocol). Additive: không media → return, reply text như cũ.
    if (!msg.media || msg.media.length === 0) return;

    // Codex H2 + GEM-1423: a MEDIA-ONLY reply (no text, hoặc chunk thuần [[SEND_MEDIA]] sau khi
    // human-message-split tách) cần deliverReplyOnce chặn gửi trùng, NHƯNG dòng claim trong
    // channel_sent_messages PHẢI chính là dòng media đầu tiên (update body/content_type/media thật
    // + mirror sang cskh_messages với origin_message_id = sentRowId), KHÔNG được để lại dòng cổng
    // body='[media]' mồ côi làm lệch P2 (sent > mirror) và hiện bong bóng '[media]' thừa trong inbox.
    const hadText = !!(msg.content && msg.content.trim());
    if (!hadText && msg.dedupeKey) {
      let claimedRowConsumed = false;
      const outcome = await deliverReplyOnce(
        msg.dedupeKey,
        { channel_name: msg.channel, thread_id: threadId, thread_type: 'dm', to_uid: threadId,
          body: '[Hình ảnh]', content_type: 'file', sent_by: sentBy },
        async (sentRowId) => {
          for (const item of msg.media!) {
            try {
              const reuseRowId = !claimedRowConsumed ? sentRowId : null;
              const didSend = await this.sendMediaToCustomer(
                threadId, msg.channel, agentSlug, sentBy, item, isVisitor, reuseRowId,
              );
              if (didSend && reuseRowId) claimedRowConsumed = true;
            } catch (err: any) {
              console.error('[cskh] send media failed:', err?.message || err);
            }
          }
          if (!claimedRowConsumed && sentRowId) {
            // Không có media item nào gửi được (vd không resolve được URL) → xoá dòng claim tạm
            // để không để lại dòng channel_sent_messages mồ côi thiếu mirror (P2).
            await supabase.from('channel_sent_messages').delete().eq('id', sentRowId);
          }
          return { platformMessageId: null };
        },
      );
      if (outcome !== 'sent') return; // duplicate media-only → skip
      return;
    }

    for (const item of msg.media) {
      try {
        await this.sendMediaToCustomer(threadId, msg.channel, agentSlug, sentBy, item, isVisitor);
      } catch (err: any) {
        console.error('[cskh] send media failed:', err?.message || err);
      }
    }
  }

  /**
   * Gửi 1 media item cho khách CSKH: upload local→bucket public → log inbox + mirror cskh_messages + báo.
   * Khi `claimedSentRowId` được truyền vào (chunk thuần media đã qua deliverReplyOnce), tái sử dụng
   * chính dòng channel_sent_messages đó (update body/content_type/media) thay vì insert dòng thứ 2.
   * Trả về `true` nếu đã ghi & mirror thành công, `false` nếu bị skip (không có URL hợp lệ).
   */
  private async sendMediaToCustomer(
    threadId: string, channel: string, agentSlug: string | null, sentBy: string,
    item: MediaFile, isVisitor: boolean, claimedSentRowId: string | null = null,
  ): Promise<boolean> {
    const isImg = isImageMedia(item);
    // Resolve local path (path media-library / download url) → upload bucket → public URL.
    const { localPath, cleanup } = await resolveMediaToLocalPath(item);
    let publicUrl: string | null = null;
    if (localPath) {
      publicUrl = await this.uploadToCskhBucket(localPath, threadId, item);
      if (cleanup) { try { rmSync(pathJoin(localPath, '..'), { recursive: true, force: true }); } catch { /* best effort */ } }
    } else if (item.url && /^https?:/i.test(item.url)) {
      // Không resolve được local nhưng có URL công khai → dùng thẳng (khách app load được).
      publicUrl = item.url;
    }
    if (!publicUrl) {
      console.warn(`[cskh] media skipped (no servable url): ${item.filename || '(unknown)'}`);
      return false;
    }
    const attachmentType = isImg ? 'image' : 'file';
    const attachFileName = decodeURIComponent((publicUrl.split('?')[0].split('/').pop()) || 'tệp đính kèm');

    // Log inbox Paperclip (ảnh→content_type='image'+media[url]; tệp→'file'+body-JSON → FileMsg).
    const sentBody = isImg ? '[Hình ảnh]' : JSON.stringify({ fileName: attachFileName, href: publicUrl });
    let mediaSentId: string | null = claimedSentRowId;
    if (claimedSentRowId) {
      const { error: updErr } = await supabase.from('channel_sent_messages').update({
        body: sentBody,
        content_type: attachmentType,
        media: isImg ? [publicUrl] : null,
      }).eq('id', claimedSentRowId);
      if (updErr) console.error('[cskh] media claimed row update failed:', updErr.message);
    } else {
      const { data: sentRow, error: sentErr } = await supabase.from('channel_sent_messages').insert({
        channel_name: channel, thread_id: threadId, thread_type: 'dm', to_uid: threadId,
        body: sentBody, content_type: attachmentType,
        media: isImg ? [publicUrl] : null,
        status: 'sent', sent_by: sentBy,
      }).select('id').single();
      if (sentErr) console.error('[cskh] media sent log failed:', sentErr.message);
      mediaSentId = (sentRow as { id: string } | null)?.id ?? null;
    }

    // Mirror cho khách (role='assistant' = BOT, KHÁC operator 'human'). KHÔNG leak item.caption
    // (LLM meta = description trong media-library, không phải customer-facing; incident Zalo 2026-05-01).
    const preview = isImg ? '📷 Hình ảnh' : '📎 Tệp đính kèm';
    if (isVisitor) {
      const r = await mirrorReplyToVisitor(threadId, 'assistant', '', mediaSentId, agentSlug, channel, publicUrl, attachmentType);
      if (r.error) throw new Error(`cskh media mirror failed: ${r.error}`);
      // Qua edge-call (28/07): khoá đúng + KHÔNG nuốt lỗi im lặng như `.catch(()=>{})` cũ.
      void goiEdgeGemral('cskh-notify-offline', { visitor_id: threadId, channel, preview });
    } else {
      const r = await mirrorReplyToCustomer(threadId, 'assistant', '', mediaSentId, agentSlug, publicUrl, attachmentType);
      if (r.error) throw new Error(`cskh media mirror failed: ${r.error}`);
      try { await pushSupportReply(threadId, preview); } catch (e: any) { console.error('[cskh] media push failed (best-effort):', e?.message || e); }
    }
    return true;
  }

  /** Đọc file local → upload lên bucket cskh-attachments (service_role, public) → public URL. */
  private async uploadToCskhBucket(localPath: string, threadId: string, item: MediaFile): Promise<string | null> {
    try {
      const buf = readFileSync(localPath);
      if (buf.byteLength > 15 * 1024 * 1024) { console.warn('[cskh] media too large (>15MB), skip'); return null; }
      const base = pathBasename(localPath);
      const ext = (base.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
      const isImg = isImageMedia(item);
      const mime = item.mimeType || (isImg ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : 'application/octet-stream');
      const path = isImg
        ? `cskh/${threadId}/agent/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`
        : `cskh/${threadId}/agent/${Date.now()}-${base.replace(/[^\w.\-]+/g, '_').slice(0, 60)}`;
      const { error } = await supabase.storage.from('cskh-attachments').upload(path, buf, { contentType: mime, upsert: false });
      if (error) { console.error('[cskh] bucket upload failed:', error.message); return null; }
      const { data } = supabase.storage.from('cskh-attachments').getPublicUrl(path);
      return data?.publicUrl || null;
    } catch (err: any) {
      console.error('[cskh] uploadToCskhBucket threw:', err?.message || err);
      return null;
    }
  }

  /** Trả về id row vừa ghi (hoặc null nếu ghi hụt) để mirror nối dây sang kho khách. */
  private async logSentMessage(channelName: string, threadId: string, body: string, sentBy: string): Promise<string | null> {
    const { data, error } = await supabase.from('channel_sent_messages').insert({
      channel_name: channelName,
      thread_id: threadId,
      thread_type: 'dm',
      to_uid: threadId,
      body,
      content_type: 'text',
      status: 'sent',
      sent_by: sentBy,
    }).select('id').single();
    if (error) { console.error('[cskh] logSentMessage failed:', error.message); return null; }
    return (data as { id: string }).id;
  }
}

export const cskhChannel = new CskhChannel();
