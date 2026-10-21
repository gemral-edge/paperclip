// Channel-Agent Auto-Reply system — shared type definitions

export interface Channel {
  name: string;
  type: ChannelType;
  start(ctx?: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  send(msg: OutboundMessage): Promise<void>;
  isRunning(): boolean;
  isAllowed(senderId: string): boolean;
}

export type ChannelType = 'facebook' | 'facebook_web' | 'zalo_personal' | 'zalo_oa' | 'telegram' | 'youtube' | 'cskh';

export type DmPolicy = 'open' | 'allowlist' | 'pairing' | 'disabled';
export type GroupPolicy = 'open' | 'allowlist' | 'pairing' | 'disabled';
export type PeerKind = 'direct' | 'group' | 'comment';
export type ContentType = 'text' | 'image' | 'file' | 'voice' | 'sticker';
export type MessageStatus = 'pending' | 'processing' | 'handled' | 'failed' | 'skipped';
export type PairingStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface InboundMessage {
  id: string;
  channel: string;
  channelType: ChannelType;
  chatId: string;
  senderId: string;
  senderName: string;
  content: string;
  contentType: ContentType;
  media?: MediaFile[];
  peerKind: PeerKind;
  metadata?: Record<string, any>;
  timestamp: Date;
  dedupeKey?: string;
}

export interface OutboundMessage {
  channel: string;
  chatId: string;
  content: string;
  contentType?: 'text' | 'image' | 'file';
  media?: MediaFile[];
  replyToMessageId?: string;
  metadata?: Record<string, any>;
  // Reply Gateway Contract (P2). Deterministic idempotency key for a bot reply
  // (`reply:<sessionKey>:<batchId>`). Set ONLY on gated bot-reply paths (via
  // emitReply); manual/human outbound leaves it undefined → adapter sends as
  // before (no claim). When present, the channel adapter routes the send through
  // deliverReplyOnce so a duplicate emit (listener leak / restart overlap) is a
  // 23505 → skip. `sessionKey` carried for logging/trace.
  dedupeKey?: string | null;
  sessionKey?: string;
}

export interface MediaFile {
  url?: string;
  path?: string;
  mimeType: string;
  filename?: string;
  size?: number;
  caption?: string;
}

/** Entry in agents/{slug}/media-library.json */
export interface MediaLibraryItem {
  id: string;
  name: string;
  type: 'image' | 'video' | 'pdf' | 'audio' | 'document' | 'file';
  mimeType: string;
  path?: string | null;
  /** Multi-ảnh/sản phẩm (2026-07-16): danh sách path ảnh; `path` = primary = all_images[0].
   *  Item không có all_images → gửi 1 ảnh (path/url) như cũ (backward-compat). */
  all_images?: string[];
  url?: string | null;
  description: string;
  tags?: string[];
  language?: string;
}

export interface MediaLibrary {
  agent_slug: string;
  version: string;
  description?: string;
  items: MediaLibraryItem[];
  instructions_for_agent?: string;
}

/** Row shape from channel_instances table */
export interface ChannelInstanceRow {
  id: string;
  name: string;
  display_name: string | null;
  channel_type: string;
  agent_id: string | null;
  agent_slug: string | null;
  config: ChannelConfig | null;
  enabled: boolean;
  status: string;
  status_message: string | null;
  last_connected_at: string | null;
  dm_policy: DmPolicy;
  group_policy: GroupPolicy;
  require_mention: boolean;
  allow_from: string[];
  paired_users: string[];
  streaming_enabled: boolean;
  history_limit: number;
  quota_hour: number;
  quota_day: number;
  save_contacts_to_crm: boolean;
  created_at: string;
  updated_at: string;
}

export interface ChannelConfig {
  dm_policy?: DmPolicy;
  group_policy?: GroupPolicy;
  require_mention?: boolean;
  allow_from?: string[];
  history_limit?: number;
  block_reply?: boolean;
}

/** Row shape from channel_pending_messages table */
export interface PendingMessageRow {
  id: string;
  channel_name: string;
  thread_id: string;
  thread_type: string;
  from_uid: string;
  sender_name: string;
  message_id: string;
  body: string;
  content_type: string;
  media: string[] | null;
  metadata: Record<string, any>;
  status: MessageStatus;
  handled_by: string | null;
  handled_at: string | null;
  session_key: string | null;
  peer_kind: PeerKind;
  agent_slug: string | null;
  priority: number;
  dedupe_key: string | null;
  ts: string;
  created_at: string;
}

/** Row shape from channel_sessions table */
export interface SessionRow {
  id: string;
  session_key: string;
  channel_name: string | null;
  agent_slug: string | null;
  peer_kind: PeerKind;
  chat_id: string;
  sender_id: string | null;
  sender_name: string | null;
  history: SessionMessage[];
  history_count: number;
  status: string;
  last_message_at: string | null;
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface SessionMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  senderName?: string;
  /** Optional per-message metadata. `agent_session_id` lets the Chat Drawer
   *  drill-down to the exact JSONL session that generated the assistant turn. */
  metadata?: {
    agent_session_id?: string;
    [k: string]: unknown;
  };
}

/** Policy check result */
export interface PolicyResult {
  pass: boolean;
  reason?: string;
  pairingCode?: string;
}

/** Quota check result */
export interface QuotaResult {
  allowed: boolean;
  hourCount: number;
  dayCount: number;
  hourLimit: number;
  dayLimit: number;
}

// ─── Agent Config (paperclip_agents table) ───

export type AgentProvider = 'claude' | 'gemini' | 'antigravity' | 'openrouter' | 'ollama' | 'nvidia_nim';

/** Row shape from paperclip_agents table */
export interface AgentConfig {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  avatar: string | null;
  provider: AgentProvider;
  model: string;
  temperature: number;
  max_tokens: number;
  system_prompt: string | null;
  persona_file: string | null;
  language: string;
  tools: string[];
  can_escalate_to: string[];
  fallback_message: string;
  effort_mode: string;
  max_turns: number;
  history_limit: number;
  session_timeout: number;
  enabled: boolean;
  /**
   * Antigravity (agy) only: id of the pre-seeded agy brain to resume. agy `-p`
   * headless CANNOT create a brain for an unknown id, so this must point at a
   * brain created once via `agy --conversation <id>` interactively. Optional for
   * other providers.
   */
  conversation_id?: string | null;
  /**
   * Antigravity only: model dự phòng khi model chính hết credits/quota (GEM-1241) —
   * adapter_config.fallbackModels. undefined = mặc định (model Gemini → Claude Sonnet 4.6 (Thinking));
   * [] = tắt.
   */
  fallback_models?: string[] | string | null;
  created_at: string;
  updated_at: string;
}

/** Provider → default models mapping */
export const PROVIDER_MODELS: Record<AgentProvider, string[]> = {
  claude: [
    // 2026-07-26: +opus-5 (agent gem-beat dùng) và +opus-4-7 — bản UI
    // (ui/src/api/agentConfigs.ts) đã có opus-4-7 từ trước mà bản server này thiếu,
    // tức hai danh sách đã lệch nhau. Đồng bộ lại cùng lượt.
    // 2026-08-01: +opus-4-8 (agent Gem Doanh Thu dùng) — sweep đồng bộ 4 list.
    // 2026-09-24: +opus-5-5 — sweep đồng bộ 4 list.
    // 2026-09-29: +sonnet-5-5 — sweep đồng bộ 4 list.
    'claude-opus-5-5',
    'claude-opus-4-8',
    'claude-opus-5',
    'claude-opus-4-7',
    'claude-sonnet-5-5',
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'claude-haiku-4-5-20251001',
  ],
  gemini: [
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
  ],
  antigravity: [
    // Display strings accepted verbatim by `agy --model` (see `agy models`, col 2).
    // Keep in sync with packages/adapters/antigravity-local/src/index.ts `models`
    // and ui/src/api/agentConfigs.ts PROVIDER_MODELS.antigravity — the audit probe
    // `paperclip_model_list_audit.py --provider antigravity --against-agy` diffs
    // agy's live list against all three copies.
    // 2026-08-15: +3.7 Flash x3, +3.6 Flash x3 (agy had them, all lists stopped at 3.5).
    // 2026-09-03: +3.8 Flash x3 (agy shipped 3.8, verbatim via `agy models`).
    'Gemini 3.8 Flash (High)',
    'Gemini 3.8 Flash (Medium)',
    'Gemini 3.8 Flash (Low)',
    // 2026-10-14: +Gemini 4 Argon x3 (verbatim via `agy models`).
    'Gemini 4 Argon (High)',
    'Gemini 4 Argon (Medium)',
    'Gemini 4 Argon (Low)',
    'Gemini 3.7 Flash (High)',
    'Gemini 3.7 Flash (Medium)',
    'Gemini 3.7 Flash (Low)',
    'Gemini 3.6 Flash (High)',
    'Gemini 3.6 Flash (Medium)',
    'Gemini 3.6 Flash (Low)',
    // 2026-09-03: removed Gemini 3.5 Flash x3 — agy no longer lists them.
    'Gemini 3.1 Pro (High)',
    'Gemini 3.1 Pro (Low)',
    'Claude Sonnet 4.6 (Thinking)',
    'Claude Opus 4.6 (Thinking)',
    'GPT-OSS 120B (Medium)',
  ],
  openrouter: [
    'anthropic/claude-sonnet-4-6',
    'anthropic/claude-opus-4-6',
    'anthropic/claude-sonnet-4',
    'anthropic/claude-haiku-4.5',
    'google/gemini-2.5-flash',
    'google/gemini-2.5-pro',
    'openai/gpt-4.1',
    'openai/gpt-4.1-mini',
    'meta-llama/llama-4-maverick',
  ],
  ollama: [
    'gemma4:latest',
    'gemma4:e2b',
    'gemma4:e4b',
    'gemma4:26b',
    'gemma4:31b',
  ],
  nvidia_nim: [
    'google/gemma-4-31b-it',
    'google/gemma-3-27b-it',
    'google/gemma-2-27b-it',
    'google/gemma-2-9b-it',
    'google/gemma-2-2b-it',
  ],
};
