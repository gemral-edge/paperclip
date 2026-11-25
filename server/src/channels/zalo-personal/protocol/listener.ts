// packages/server/src/channels/zalo-personal/protocol/listener.ts
//
// Raw WebSocket client for Zalo.
// Zalo uses RSV1 bit for custom purpose (NOT permessage-deflate).
// The standard `ws` library rejects these frames, so we parse them ourselves.

import { EventEmitter } from 'events';
import * as https from 'https';
import * as crypto from 'crypto';
import { ZaloSession, WS_CMD, ZALO_API } from './message.js';
import { decryptEnvelope } from './crypto.js';
import { markAlive } from '../../../services/liveness-tracker.js';

const DEFAULT_WS_URLS = [
  'wss://ws1-msg.chat.zalo.me',
  'wss://ws2-msg.chat.zalo.me',
  'wss://ws3-msg.chat.zalo.me',
  'wss://ws4-msg.chat.zalo.me',
  'wss://ws5-msg.chat.zalo.me',
  'wss://ws6-msg.chat.zalo.me',
  'wss://ws7-msg.chat.zalo.me',
  'wss://ws8-msg.chat.zalo.me',
];

function buildWsUrl(baseUrl: string): string {
  return `${baseUrl}?t=${Date.now()}&zpw_type=${ZALO_API.ZPW_TYPE}&zpw_ver=${ZALO_API.ZPW_VER}`;
}

// ── Minimal raw WebSocket frame parser ──────────────────────────────
// Ignores RSV bits entirely (Zalo uses RSV1 for custom purpose).

const WS_OPCODE = { CONTINUATION: 0, TEXT: 1, BINARY: 2, CLOSE: 8, PING: 9, PONG: 10 };

interface ParsedFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

function parseFrames(buf: Buffer): { frames: ParsedFrame[]; remainder: Buffer } {
  const frames: ParsedFrame[] = [];
  let offset = 0;

  while (offset < buf.length) {
    if (buf.length - offset < 2) break;

    const b0 = buf[offset];
    const b1 = buf[offset + 1];

    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let payloadLen = b1 & 0x7f;
    let headerLen = 2;

    if (payloadLen === 126) {
      if (buf.length - offset < 4) break;
      payloadLen = buf.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (payloadLen === 127) {
      if (buf.length - offset < 10) break;
      // Read as 64-bit, but we only handle up to 2^32
      payloadLen = buf.readUInt32BE(offset + 6);
      headerLen = 10;
    }

    if (masked) headerLen += 4;

    if (buf.length - offset < headerLen + payloadLen) break;

    let payload = buf.slice(offset + headerLen, offset + headerLen + payloadLen);

    if (masked) {
      const maskKey = buf.slice(offset + headerLen - 4, offset + headerLen);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i & 3];
      }
    }

    frames.push({ fin, opcode, payload });
    offset += headerLen + payloadLen;
  }

  return { frames, remainder: buf.slice(offset) };
}

function buildFrame(opcode: number, payload: Buffer, mask = true): Buffer {
  const payloadLen = payload.length;
  let headerLen = 2;
  if (payloadLen > 125 && payloadLen <= 65535) headerLen += 2;
  else if (payloadLen > 65535) headerLen += 8;
  if (mask) headerLen += 4;

  const frame = Buffer.alloc(headerLen + payloadLen);
  frame[0] = 0x80 | opcode; // FIN + opcode

  let offset = 1;
  if (payloadLen <= 125) {
    frame[offset++] = (mask ? 0x80 : 0) | payloadLen;
  } else if (payloadLen <= 65535) {
    frame[offset++] = (mask ? 0x80 : 0) | 126;
    frame.writeUInt16BE(payloadLen, offset);
    offset += 2;
  } else {
    frame[offset++] = (mask ? 0x80 : 0) | 127;
    frame.writeUInt32BE(0, offset);
    frame.writeUInt32BE(payloadLen, offset + 4);
    offset += 8;
  }

  if (mask) {
    const maskKey = crypto.randomBytes(4);
    maskKey.copy(frame, offset);
    offset += 4;
    for (let i = 0; i < payloadLen; i++) {
      frame[offset + i] = payload[i] ^ maskKey[i & 3];
    }
  } else {
    payload.copy(frame, offset);
  }

  return frame;
}

// ── ZaloListener ────────────────────────────────────────────────────

export class ZaloListener extends EventEmitter {
  private socket: any = null;
  private session: ZaloSession;
  private pingInterval: NodeJS.Timeout | null = null;
  private cipherKey: string | null = null;
  private wsEndpointIndex = 0;
  private retryCount = 0;
  private stableTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private rawBuffer = Buffer.alloc(0);
  private fragmentBuffer: Buffer[] = [];
  private fragmentOpcode = 0;

  constructor(session: ZaloSession) {
    super();
    this.session = session;
  }

  async start(): Promise<void> {
    if (this.stopped) return;

    const wsUrls = this.session.loginInfo.zpw_ws?.length
      ? this.session.loginInfo.zpw_ws
      : DEFAULT_WS_URLS;

    const baseUrl = wsUrls[this.wsEndpointIndex % wsUrls.length];
    const url = buildWsUrl(baseUrl);
    const parsed = new URL(url);

    const cookieHeader = this.session.cookies
      .map((c: any) => `${c.name}=${c.value}`)
      .join('; ');

    const hasZpwSek = this.session.cookies.some((c: any) => c.name === 'zpw_sek');
    console.log(`[ZaloListener] Connecting to ${url}`);
    console.log(`[ZaloListener] Cookies: ${this.session.cookies.map((c: any) => c.name).join(', ')}`);
    console.log(`[ZaloListener] zpw_sek present: ${hasZpwSek}`);

    const wsKey = crypto.randomBytes(16).toString('base64');

    const req = https.request({
      hostname: parsed.hostname,
      port: 443,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      headers: {
        'Host': parsed.hostname,
        'User-Agent': this.session.userAgent,
        'Origin': 'https://chat.zalo.me',
        'Cookie': cookieHeader,
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Sec-WebSocket-Key': wsKey,
        'Sec-WebSocket-Version': '13',
      },
    });

    req.on('upgrade', (_res: any, socket: any, head: Buffer) => {
      console.log('[ZaloListener] Connected!');
      this.socket = socket;
      this.rawBuffer = Buffer.alloc(0);

      // Attach error/close handlers BEFORE any write
      // (onSocketData below can trigger auto-PONG/CLOSE write — race-fix prevents
      //  unhandled 'error' event on Socket if peer already closed)
      socket.on('error', (err: Error) => {
        console.error('[ZaloListener] Socket error:', err.message);
        this.emit('error', err);
      });

      socket.on('close', () => {
        console.log('[ZaloListener] Socket closed');
        this.cleanup();
        if (!this.stopped) this.handleReconnect(1006);
      });

      if (head.length > 0) {
        this.onSocketData(head);
      }

      socket.on('data', (chunk: Buffer) => this.onSocketData(chunk));

      this.startPing();
      this.startStableTimer();
      this.emit('connected');
    });

    req.on('error', (err: Error) => {
      console.error('[ZaloListener] Connection error:', err.message);
      this.emit('error', err);
      if (!this.stopped) this.handleReconnect(1006);
    });

    req.on('response', (res: any) => {
      console.error(`[ZaloListener] Got HTTP ${res.statusCode} instead of upgrade`);
      res.destroy();
      if (!this.stopped) this.handleReconnect(1006);
    });

    req.end();
  }

  private chunkCount = 0;

  private onSocketData(chunk: Buffer): void {
    this.chunkCount++;

    // Detect HTTP response instead of WS frames (server error)
    if (this.chunkCount === 1) {
      const text = chunk.toString('utf-8');
      if (text.startsWith('HTTP/')) {
        console.error(`[ZaloListener] Server sent HTTP instead of WS frames!`);
        console.error(`[ZaloListener] ${text.substring(0, 500)}`);
        this.stopped = true;
        this.socket?.end();
        this.emit('error', new Error('WS rejected: ' + text.split('\n').pop()?.trim()));
        return;
      }
      console.log(`[ZaloListener] First chunk (${chunk.length} bytes) hex: ${chunk.toString('hex').substring(0, 100)}`);
    }

    this.rawBuffer = Buffer.concat([this.rawBuffer, chunk]) as any;
    const { frames, remainder } = parseFrames(this.rawBuffer);
    this.rawBuffer = remainder as any;

    for (const frame of frames) {
      this.onFrame(frame);
    }
  }

  private onFrame(frame: ParsedFrame): void {
    // Handle fragmentation
    if (frame.opcode === WS_OPCODE.CONTINUATION) {
      this.fragmentBuffer.push(frame.payload);
      if (frame.fin) {
        const fullPayload = Buffer.concat(this.fragmentBuffer);
        this.fragmentBuffer = [];
        this.onMessage(this.fragmentOpcode, fullPayload);
      }
      return;
    }

    if (frame.opcode === WS_OPCODE.CLOSE) {
      const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1000;
      console.log(`[ZaloListener] Close frame: code=${code}`);
      // Send close reply (race-safe — peer may have RST already)
      const reply = Buffer.alloc(2);
      reply.writeUInt16BE(code, 0);
      this.safeWrite(buildFrame(WS_OPCODE.CLOSE, reply));
      try { this.socket?.end(); } catch { /* peer already closed */ }
      return;
    }

    if (frame.opcode === WS_OPCODE.PING) {
      // Reply with pong (race-safe)
      this.safeWrite(buildFrame(WS_OPCODE.PONG, frame.payload));
      return;
    }

    if (frame.opcode === WS_OPCODE.PONG) {
      return; // Ignore pong
    }

    // Binary or text data frame
    if (!frame.fin) {
      // Start of fragmented message
      this.fragmentOpcode = frame.opcode;
      this.fragmentBuffer = [frame.payload];
      return;
    }

    this.onMessage(frame.opcode, frame.payload);
  }

  private onMessage(_opcode: number, data: Buffer): void {
    this.handleZaloFrame(data);
  }

  /**
   * Parse Zalo's custom binary protocol on top of WebSocket.
   * Format: [version: u8][cmd: u16 LE][subCmd: u8][json_payload]
   */
  private handleZaloFrame(data: Buffer): void {
    if (data.length < 4) return;

    const cmd = data.readUInt16LE(1);
    const subCmd = data.readUInt8(3);
    const payload = data.slice(4);

    // Ping/Pong (cmd=2, any subCmd) — skip logging to avoid 77MB+ server.log spam (GEM-2737)
    if (cmd === WS_CMD.PONG.cmd || cmd === WS_CMD.PING.cmd) {
      return;
    }

    console.log(`[ZaloListener] Frame: cmd=${cmd} subCmd=${subCmd} len=${data.length}`);

    // Cipher key handshake (cmd=1, subCmd=1)
    if (cmd === WS_CMD.CIPHER_KEY_HANDSHAKE.cmd && subCmd === WS_CMD.CIPHER_KEY_HANDSHAKE.subCmd) {
      try {
        const json = JSON.parse(payload.toString('utf-8'));
        this.cipherKey = json.key || json.data?.key || json.enk || json.data?.enk;
        console.log('[ZaloListener] Cipher key received:',
          this.cipherKey ? this.cipherKey.substring(0, 20) + '...' : 'EMPTY');

        if (this.cipherKey && !this.session.secretKey) {
          this.session.secretKey = this.cipherKey;
          console.log('[ZaloListener] SecretKey updated from WS handshake');
        }

        this.emit('cipher_key', this.cipherKey);
      } catch (err) {
        console.error('[ZaloListener] Cipher key parse error:', err);
        console.log('[ZaloListener] Cipher raw hex:', payload.toString('hex').substring(0, 100));
        console.log('[ZaloListener] Cipher raw utf8:', payload.toString('utf-8').substring(0, 200));
      }
      return;
    }

    // Duplicate session (cmd=3000)
    if (cmd === WS_CMD.DUPLICATE_SESSION.cmd) {
      console.warn('[ZaloListener] Duplicate session detected');
      this.stopped = true;
      this.emit('duplicate_session');
      return;
    }

    // Kickout (any 3xxx)
    if (cmd >= 3000) {
      console.warn(`[ZaloListener] Kicked: cmd=${cmd}`);
      this.emit('kickout', { code: cmd });
      return;
    }

    // Skip non-essential commands (typing, reactions, read receipts, etc.)
    const SKIP_CMDS = [502, 504, 522, 602, 603, 604, 610, 612, 613];
    if (SKIP_CMDS.includes(cmd)) {
      return;
    }

    // Parse encrypted payload
    const decryptKey = this.cipherKey || this.session.secretKey;
    let jsonStr: string;
    try {
      const rawJson = payload.toString('utf-8');
      const envelope = JSON.parse(rawJson);

      if (envelope.encrypt && envelope.encrypt > 0) {
        if (!decryptKey) {
          console.warn('[ZaloListener] No decryption key, skipping cmd=' + cmd);
          return;
        }
        jsonStr = decryptEnvelope(envelope, decryptKey);
      } else {
        jsonStr = typeof envelope.data === 'string' ? envelope.data : rawJson;
      }
    } catch (err: any) {
      console.error(`[ZaloListener] Decrypt error cmd=${cmd}:`, err.message);
      console.log(`[ZaloListener] Raw payload (first 200):`, payload.toString('utf-8').substring(0, 200));
      return;
    }

    // Route by command
    try {
      const parsed = JSON.parse(jsonStr);

      if (cmd === WS_CMD.DM_MESSAGE.cmd) {
        const msgs = parsed?.data?.msgs || [];
        console.log(`[ZaloListener] DM: ${msgs.length} message(s)`);
        for (const msg of msgs) {
          console.log(`[ZaloListener] DM from ${msg.uidFrom}: ${(typeof msg.content === 'string' ? msg.content : '(media)').substring(0, 100)}`);
          this.emit('dm_message', msg);
        }
      } else if (cmd === WS_CMD.GROUP_MESSAGE.cmd) {
        const msgs = parsed?.data?.groupMsgs || [];
        console.log(`[ZaloListener] Group: ${msgs.length} message(s)`);
        for (const msg of msgs) {
          this.emit('group_message', msg);
        }
      } else if (cmd === WS_CMD.CONTROL_EVENT.cmd) {
        this.emit('control_event', parsed);
      } else {
        console.log(`[ZaloListener] Unhandled cmd=${cmd} subCmd=${subCmd}`);
      }
    } catch (err: any) {
      console.error(`[ZaloListener] Parse error cmd=${cmd}:`, err.message);
    }
  }

  private startPing(): void {
    this.pingInterval = setInterval(() => {
      markAlive('zalo-listener-ping');
      if (!this.socket || this.socket.destroyed) return;

      const jsonPayload = JSON.stringify({ eventId: Date.now() });
      const zaloBuf = Buffer.alloc(4 + jsonPayload.length);
      zaloBuf.writeUInt8(1, 0);
      zaloBuf.writeUInt16LE(WS_CMD.PING.cmd, 1);
      zaloBuf.writeUInt8(WS_CMD.PING.subCmd, 3);
      zaloBuf.write(jsonPayload, 4);

      this.safeWrite(buildFrame(WS_OPCODE.BINARY, zaloBuf));
    }, ZALO_API.PING_INTERVAL);
  }

  /**
   * Race-safe socket write — defends against Zalo peer RST mid-write.
   * Catches both sync throws and async 'error' events that bypass the upgrade-time
   * `socket.on('error')` listener (Node may emit on underlying socket before
   * upgrade-attached listener fires). Returns false if write was skipped/failed.
   *
   * Reason: 6 server crashes 2026-05-05 in WriteWrap.onWriteComplete with
   * "Error: write EOF" → unhandled error event → Node exit code 1 → pm2 restart
   * → all heartbeat agent runs reaped as orphans (e.g. Pháp Sư run c3fb8e18).
   */
  private safeWrite(buf: Buffer): boolean {
    const sock = this.socket;
    if (!sock || sock.destroyed || !sock.writable) return false;
    try {
      sock.write(buf, (err: Error | null | undefined) => {
        if (err) {
          console.error('[ZaloListener] write callback error:', err.message);
          // Don't re-throw — listener at line ~192 + this catch suffice.
        }
      });
      return true;
    } catch (err) {
      console.error('[ZaloListener] safeWrite sync throw:', (err as Error).message);
      return false;
    }
  }

  stop(): void {
    this.stopped = true;
    this.cleanup();
    if (this.socket) {
      try {
        this.socket.write(buildFrame(WS_OPCODE.CLOSE, Buffer.from([0x03, 0xe8]))); // 1000
      } catch {}
      this.socket.end();
      this.socket = null;
    }
  }

  // Expose readyState for compatibility with channel.ts ping checks
  get readyState(): number {
    if (!this.socket || this.socket.destroyed) return 3; // CLOSED
    return 1; // OPEN
  }

  // Send raw binary data as a WebSocket frame (race-safe)
  send(data: Buffer): void {
    this.safeWrite(buildFrame(WS_OPCODE.BINARY, data));
  }

  private startStableTimer(): void {
    this.stableTimer = setTimeout(() => {
      this.retryCount = 0;
    }, ZALO_API.STABLE_THRESHOLD);
  }

  private cleanup(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  private handleReconnect(code: number): void {
    const retryLimits: Record<number, number> = {
      1000: 5, 1006: 10, 4000: 3,
    };
    const maxRetries = retryLimits[code] ?? 5;

    if ([1002, 1007].includes(code)) {
      this.wsEndpointIndex++;
    }

    if (code === 3000) {
      setTimeout(() => this.start(), 60_000);
      return;
    }

    if (this.retryCount < maxRetries) {
      const delay = Math.min(2000 * Math.pow(2, this.retryCount), 60_000);
      this.retryCount++;
      console.log(`[ZaloListener] Reconnecting in ${delay}ms (retry ${this.retryCount}/${maxRetries})`);
      setTimeout(() => this.start(), delay);
    } else {
      this.emit('max_retries', code);
    }
  }
}
