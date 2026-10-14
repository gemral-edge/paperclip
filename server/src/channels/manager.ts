// Channel-Agent Auto-Reply — Channel Manager
// Registers channels, dispatches outbound messages, logs to channel_sent_messages + War Room

import { supabase } from './zalo-personal/supabase.js';
import { bus } from './bus.js';
import { startConsumer, stopConsumer } from './consumer.js';
import { deduplicator } from './dedupe.js';
import { debouncer } from './debounce.js';
import type {
  Channel,
  ChannelType,
  OutboundMessage,
  ChannelInstanceRow,
} from './types.js';

class ChannelManager {
  private channels = new Map<string, Channel>();
  private outboundHandler: ((msg: OutboundMessage) => void) | null = null;

  /**
   * Register a channel instance.
   */
  register(channel: Channel): void {
    this.channels.set(channel.name, channel);
    console.log(`[Manager] Registered channel: ${channel.name} (${channel.type})`);
  }

  /**
   * Unregister a channel.
   */
  unregister(name: string): void {
    this.channels.delete(name);
    console.log(`[Manager] Unregistered channel: ${name}`);
  }

  /**
   * Start all registered channels and the consumer pipeline.
   */
  async startAll(signal?: AbortSignal): Promise<void> {
    // Start consumer first (listens for inbound messages)
    startConsumer();

    // Subscribe to outbound events for auto-dispatch
    this.outboundHandler = (msg: OutboundMessage) => {
      this.dispatch(msg).catch(err => {
        console.error(`[Manager] Dispatch error:`, err.message);
      });
    };
    bus.on('outbound', this.outboundHandler);

    // Subscribe to Supabase Realtime for cross-instance coordination
    bus.subscribeRealtime();

    // Start all channels
    const startPromises = Array.from(this.channels.values()).map(async (ch) => {
      try {
        await ch.start(signal);
        console.log(`[Manager] Channel started: ${ch.name}`);
      } catch (err: any) {
        console.error(`[Manager] Failed to start channel ${ch.name}:`, err.message);
      }
    });

    await Promise.allSettled(startPromises);

    console.log(`[Manager] All channels started (${this.channels.size} total)`);
  }

  /**
   * Stop all channels and the consumer.
   */
  async stopAll(): Promise<void> {
    // Stop consumer
    stopConsumer();

    // Remove outbound handler
    if (this.outboundHandler) {
      bus.off('outbound', this.outboundHandler);
      this.outboundHandler = null;
    }

    // Unsubscribe from realtime
    await bus.unsubscribeRealtime();

    // Stop all channels
    const stopPromises = Array.from(this.channels.values()).map(async (ch) => {
      try {
        await ch.stop();
        console.log(`[Manager] Channel stopped: ${ch.name}`);
      } catch (err: any) {
        console.error(`[Manager] Failed to stop channel ${ch.name}:`, err.message);
      }
    });

    await Promise.allSettled(stopPromises);

    // Cleanup
    deduplicator.destroy();
    debouncer.destroy();

    console.log('[Manager] All channels stopped');
  }

  /**
   * Dispatch an outbound message to the correct channel.
   * Logs to channel_sent_messages + War Room.
   */
  async dispatch(msg: OutboundMessage): Promise<void> {
    const channel = this.channels.get(msg.channel);

    if (!channel) {
      // Facebook channels have their own outbound handler in webhook.ts — skip silently
      if (msg.channel.startsWith('fb-')) return;
      // Instagram DM (ig-*) đi chung outbound handler Graph API trong facebook/webhook.ts (EC-089)
      if (msg.channel.startsWith('ig-')) return;
      // Facebook Web (Reverse Protocol) channels self-handle via FacebookWebChannel.installBusOutboundHandler
      if (msg.channel.startsWith('fbweb-')) return;
      // CSKH internal channel self-handles outbound via CskhChannel.installBusOutboundHandler
      if (msg.channel.startsWith('cskh')) return;
      console.warn(`[Manager] Channel not found for dispatch: ${msg.channel}`);
      await this.logSentMessage(msg, 'failed', 'Channel not found');
      return;
    }

    if (!channel.isRunning()) {
      console.warn(`[Manager] Channel not running: ${msg.channel}`);
      await this.logSentMessage(msg, 'failed', 'Channel not running');
      return;
    }

    try {
      await channel.send(msg);
      await this.logSentMessage(msg, 'sent');
      await this.logToWarRoom(msg);
    } catch (err: any) {
      console.error(`[Manager] Send failed on ${msg.channel}:`, err.message);
      await this.logSentMessage(msg, 'failed', err.message);
    }
  }

  /**
   * Get channel config from DB.
   */
  async getConfig(channelName: string): Promise<ChannelInstanceRow | null> {
    const { data, error } = await supabase
      .from('channel_instances')
      .select('*')
      .eq('name', channelName)
      .single();

    if (error || !data) return null;
    return data as ChannelInstanceRow;
  }

  /**
   * Load all enabled channels from DB and register them.
   * Uses a factory per channel_type.
   */
  async loadFromDB(): Promise<void> {
    const { data: instances, error } = await supabase
      .from('channel_instances')
      .select('*')
      .eq('enabled', true);

    if (error) {
      console.error('[Manager] Failed to load channels from DB:', error.message);
      return;
    }

    for (const instance of instances || []) {
      const channelType = instance.channel_type as ChannelType;
      const existing = this.channels.get(instance.name);

      if (existing) {
        console.log(`[Manager] Channel already registered: ${instance.name}`);
        continue;
      }

      const channel = await this.createChannel(instance.name, channelType, instance);

      if (channel) {
        this.register(channel);
      }
    }

    console.log(`[Manager] Loaded ${this.channels.size} channels from DB`);
  }

  /**
   * Factory: create a Channel instance by type.
   * Override this to add new channel types.
   */
  private async createChannel(
    name: string,
    type: ChannelType,
    _config: Record<string, any>
  ): Promise<Channel | null> {
    switch (type) {
      case 'zalo_personal':
        // Zalo Personal has its own channel class — import dynamically
        try {
          const { ZaloPersonalChannel } = await import('./zalo-personal/channel.js');
          return wrapLegacyChannel(name, type, new ZaloPersonalChannel(name));
        } catch (err: any) {
          console.error(`[Manager] Failed to create zalo_personal channel:`, err.message);
          return null;
        }

      case 'facebook':
      case 'zalo_oa':
      case 'telegram':
        // Not yet implemented — log and skip
        console.log(`[Manager] Channel type '${type}' not yet implemented, skipping: ${name}`);
        return null;

      default:
        console.warn(`[Manager] Unknown channel type: ${type}`);
        return null;
    }
  }

  /**
   * Log a sent message to channel_sent_messages.
   */
  private async logSentMessage(
    msg: OutboundMessage,
    status: 'sent' | 'failed',
    errorMessage?: string
  ): Promise<void> {
    const { error } = await supabase.from('channel_sent_messages').insert({
      channel_name: msg.channel,
      thread_id: msg.chatId,
      thread_type: msg.metadata?.peerKind === 'comment' ? 'comment' : msg.metadata?.peerKind === 'group' ? 'group' : 'dm',
      to_uid: msg.chatId,
      body: msg.content,
      content_type: msg.contentType || 'text',
      status,
      error_message: errorMessage || null,
      sent_by: msg.metadata?.agentSlug || 'system',
    });

    if (error) {
      console.error('[Manager] Failed to log sent message:', error.message);
    }
  }

  /**
   * Log outbound messages to War Room for visibility.
   */
  private async logToWarRoom(msg: OutboundMessage): Promise<void> {
    const { data: warChannel } = await supabase
      .from('war_room_channels')
      .select('id')
      .eq('name', 'customer-support')
      .single();

    if (!warChannel) return;

    const agentSlug = msg.metadata?.agentSlug || 'system';
    const contentPreview = msg.content.slice(0, 200);

    await supabase.from('war_room_messages').insert({
      channel_id: warChannel.id,
      sender_type: 'agent',
      sender_id: agentSlug,
      sender_name: `Agent: ${agentSlug}`,
      message_type: 'text',
      content: `[REPLY → ${msg.channel}] ${contentPreview}`,
      priority: 0,
      metadata: {
        channel: msg.channel,
        chatId: msg.chatId,
        agentSlug,
      },
    });
  }

  /**
   * Get a registered channel by name.
   */
  get(name: string): Channel | undefined {
    return this.channels.get(name);
  }

  /**
   * List all registered channels.
   */
  list(): Array<{ name: string; type: ChannelType; running: boolean }> {
    return Array.from(this.channels.values()).map(ch => ({
      name: ch.name,
      type: ch.type,
      running: ch.isRunning(),
    }));
  }

  get size(): number {
    return this.channels.size;
  }
}

/**
 * Wrap the existing ZaloPersonalChannel (which doesn't implement the Channel interface)
 * into a proper Channel object.
 */
function wrapLegacyChannel(
  name: string,
  type: ChannelType,
  legacy: any
): Channel {
  let running = false;

  return {
    name,
    type,

    async start(_signal?: AbortSignal): Promise<void> {
      const success = await legacy.startFromDB();
      running = success;
    },

    async stop(): Promise<void> {
      legacy.stop();
      running = false;
    },

    async send(msg: OutboundMessage): Promise<void> {
      const threadType = msg.metadata?.threadType || 'dm';
      const agentSlug = msg.metadata?.agentSlug;
      const media = msg.media || [];

      // Strategy:
      //   1. For each IMAGE in media[]: try legacy.sendImage(localPath)
      //      — Zalo personal supports direct image upload from local fs.
      //      For URL-only images, fall through to URL appending.
      //   2. For non-image media (PDF, video, doc): append the URL to the
      //      text content as a clickable link. Zalo/FB auto-render previews.
      //   3. Send the (possibly augmented) text once at the end.

      const urlAppends: string[] = [];

      if (media.length > 0) {
        for (const m of media) {
          const isImage = (m.mimeType || '').startsWith('image/');
          const hasLocalPath = !!m.path;
          const hasUrl = !!m.url;

          // Branch 1: image with local path → legacy.sendImage()
          if (isImage && hasLocalPath && typeof legacy.sendImage === 'function') {
            try {
              const imgResult = await legacy.sendImage(
                msg.chatId,
                m.path,
                threadType,
                undefined,
                agentSlug,
              );
              if (!imgResult?.success) {
                console.warn(`[Manager/wrapLegacy] sendImage failed for ${m.filename}: ${imgResult?.error}`);
                if (hasUrl) urlAppends.push(`📎 ${m.filename || 'Hình'}: ${m.url}`);
              }
              continue;
            } catch (err: any) {
              console.warn(`[Manager/wrapLegacy] sendImage threw for ${m.filename}: ${err.message}`);
              if (hasUrl) urlAppends.push(`📎 ${m.filename || 'Hình'}: ${m.url}`);
              continue;
            }
          }

          // Branch 2: non-image with local path → legacy.sendFile() (PDF/video/doc)
          //          EXPERIMENTAL — falls back to URL-append on error.
          if (!isImage && hasLocalPath && typeof legacy.sendFile === 'function') {
            try {
              const fileResult = await legacy.sendFile(
                msg.chatId,
                m.path,
                threadType,
                m.caption,
                agentSlug,
              );
              if (!fileResult?.success) {
                console.warn(`[Manager/wrapLegacy] sendFile failed for ${m.filename}: ${fileResult?.error}`);
                if (hasUrl) urlAppends.push(`📎 ${m.filename || 'File'}: ${m.url}`);
              }
              continue;
            } catch (err: any) {
              console.warn(`[Manager/wrapLegacy] sendFile threw for ${m.filename}: ${err.message}`);
              if (hasUrl) urlAppends.push(`📎 ${m.filename || 'File'}: ${m.url}`);
              continue;
            }
          }

          // Branch 3: URL-only (no local path) → append clickable link
          if (hasUrl) {
            const label = m.filename || (isImage ? 'Hình' : 'File');
            urlAppends.push(`📎 ${label}: ${m.url}`);
            continue;
          }

          console.warn(`[Manager/wrapLegacy] Skipped media (no path/url): ${m.filename}`);
        }
      }

      const finalContent = urlAppends.length > 0
        ? `${msg.content}\n\n${urlAppends.join('\n')}`
        : msg.content;

      // Truyền agentSlug (Track A, plan CSKH-BOT-PAUSE-UX): thiếu → reply BOT rơi về fallback
      // sent_by='manual' → block "nhân viên đã trả lời" tự nuốt chính reply bot (vòng 1 ROLL-F12/COR-F8,
      // verify-on-source: đây là caller DUY NHẤT drop slug; các nhánh image/file trên ĐÃ truyền).
      const result = await legacy.send(msg.chatId, finalContent, threadType, agentSlug);
      if (!result.success) {
        throw new Error(result.error || 'Send failed');
      }
    },

    isRunning(): boolean {
      return running;
    },

    isAllowed(_senderId: string): boolean {
      // Policy checks are handled by the consumer pipeline
      return true;
    },
  };
}

// Singleton instance
export const channelManager = new ChannelManager();
