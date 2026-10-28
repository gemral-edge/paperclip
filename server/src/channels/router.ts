// Channel-Agent Auto-Reply — Agent Router
// Resolves which agent handles a message, loads config from paperclip_agents,
// and routes to the correct LLM provider (Claude CLI, Gemini CLI, OpenRouter API).

import { execSync, execFileSync, spawn } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync, readdirSync as readdirSyncFS } from 'node:fs';
import { resolve as pathResolve, join as pathJoin } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { spawnHidden } from '../spawn-hidden.js';
import {
  findAntigravityReplyByTurnMarker,
  looksLikeSystemPromptLeak as agyLooksLikeLeak,
  defaultAgyCommand,
  shouldAntigravityFallback,
  getActiveAntigravityAccountEmail,
  rotateAntigravityAccountOnQuota,
  DEFAULT_ANTIGRAVITY_MODEL,
} from '@paperclipai/adapter-antigravity-local/server';

const PROJECT_ROOT = process.env.PROJECT_ROOT || 'C:/Users/Jennie Chu/Desktop/Projects/crypto-pattern-scanner';
const SKILLS_STORE = pathResolve(PROJECT_ROOT, 'skills-store');
import { supabase } from './zalo-personal/supabase.js';
import type {
  InboundMessage,
  SessionMessage,
  AgentConfig,
  MediaFile,
  MediaLibrary,
} from './types.js';
import {
  type ToolExecutionContext,
} from './agent-tools.js';
import {
  parseStageMarker,
  loadPurchaseStage,
  type PurchaseStage,
} from './crm/purchase-stage-handler.js';
import { renderHistoryForPrompt, stripInjectedContext } from './session-history-util.js';
import { detectPaymentPolicyViolation, NON_SALES_AGENTS, PREPAY_POLICY_AGENTS } from './payment-policy.js';
import { splitIntoHumanMessages } from './human-message-split.js';
import { loadSalesCloserMediaFromCatalog } from './catalog-media-source.js';
import { selectInlineJson } from './inline-ssot-select.js';
import { ProviderCrashError, ProviderQuotaError, ProviderTimeoutError, isAgyCrashEmpty, getTimeoutBreaker, resolveTimeoutFallback, runWithTimeoutFallback, withApiTimeout } from './agy-timeout-fallback.js';
import { loadAgentLinkAllowlist, stripUnlistedLinks } from './link-allowlist.js';
import { agyReplyTimeoutMs, childEnvWithoutGeminiApi } from './llm-route-policy.js';

// Global event emitter for streaming events
export const streamEvents = new EventEmitter();
streamEvents.setMaxListeners(100);

const AGENT_TIMEOUT_MS = 300_000; // 300 seconds (5 min — Gemini CLI cold-start + large prompts)
const DEFAULT_AGENT = 'sales-closer';

// Cache channel → agent slug mapping for 60s
const agentCache = new Map<string, { slug: string; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

// Cache agent configs for 60s
const configCache = new Map<string, { config: AgentConfig; expiresAt: number }>();
const CONFIG_CACHE_TTL_MS = 60_000;

// ─── Public API ───

/**
 * Resolve which agent should handle a message based on channel config.
 */
/**
 * 3-tier smart routing:
 *   Tier 1: IGNORED CHATS — skip entirely (returns '' with skip reason)
 *   Tier 2: CUSTOMER-SPECIFIC AGENT — override per sender/chat
 *   Tier 3: CHANNEL DEFAULT — agent assigned to channel
 */
/**
 * Gate a resolved agent slug on paperclip_agents.enabled (chatbot SSOT — RULE 5).
 * A DISABLED agent must NOT reply on any channel: return '' so the consumer
 * treats it like "no agent" (saves the message to the human inbox, sends
 * nothing). Without this, runAgent() returns the fallback string for a disabled
 * agent and the consumer still publishes it — i.e. "tắt rồi vẫn trả lời".
 * Only blocks the explicit enabled=false case; missing/true row → unchanged.
 */
async function gateEnabledSlug(msg: InboundMessage, slug: string): Promise<string> {
  if (!slug) return '';
  const { data: pa } = await supabase
    .from('paperclip_agents')
    .select('enabled')
    .eq('slug', slug)
    .single();
  if (pa && pa.enabled === false) {
    (msg as any)._skipReason = 'agent_disabled';
    return '';
  }
  return slug;
}

export async function resolveAgent(msg: InboundMessage): Promise<string> {
  // ── Tier 0: COMMENT never gets a real-time agent reply ──
  // Bình luận trên bài viết (FB `facebook/webhook.ts` handleCommentEvent +
  // `youtube/comments.ts` poller — 2 producer duy nhất của peerKind='comment')
  // KHÔNG do agent kênh trả real-time. Chúng thuộc agent hẹn-giờ `comment-responder`
  // (wake 08:00/20:00 HCM) quét + trả BATCH qua Graph API
  // (scripts/facebook_api/fb_comments.py · scripts/youtube_api/yt_comments.py) —
  // đường đó đọc thẳng Graph API, KHÔNG phụ thuộc pipeline này.
  // Trả '' = "no agent" (cùng pattern gateEnabledSlug) → consumer vẫn lưu session
  // cho hộp thư người, KHÔNG gửi gì ra ngoài. DM/group thật đi tiếp Tier 1-3.
  // Lý do: sales-closer (agent mặc định kênh fb-*) đã trả 54 bình luận công khai,
  // gồm câu lỗi "Xin lỗi, em không thể xử lý yêu cầu này." (2026-08-05).
  if (msg.peerKind === 'comment') {
    (msg as any)._skipReason = 'comment_no_realtime';
    return '';
  }

  // ── Tier 0b: Tương tác STORY Facebook (reply/mention story) — KHÔNG auto-reply ──
  // Gắn nhãn ở facebook/webhook.ts (metadata.fb_context). Đây là phản ứng với nội dung
  // Page, không phải câu hỏi; người vẫn xem được trong thread nếu khách có DM thật.
  if (msg.metadata?.fb_context) {
    (msg as any)._skipReason = 'fb_story_interaction';
    return '';
  }

  // ── Tier 1: Check ignored chats ──
  const { data: ignored } = await supabase
    .from('chat_ignored')
    .select('id')
    .or(`chat_id.eq.${msg.chatId},chat_id.eq.${msg.senderId}`)
    .limit(1);

  if (ignored && ignored.length > 0) {
    (msg as any)._skipReason = 'ignored_chat';
    return '';
  }

  // ── Tier 2: Customer-specific agent override ──
  const { data: overrides } = await supabase
    .from('chat_agent_overrides')
    .select('agent_slug, action')
    .eq('is_active', true)
    .or(`and(match_type.eq.sender_id,match_value.eq.${msg.senderId}),and(match_type.eq.chat_id,match_value.eq.${msg.chatId})`)
    .order('priority', { ascending: false })
    .limit(1);

  if (overrides && overrides.length > 0) {
    const ov = overrides[0];
    if (ov.action === 'ignore') {
      (msg as any)._skipReason = 'override_ignore';
      return '';
    }
    if (ov.agent_slug) {
      (msg as any)._routeTier = 'override';
      return await gateEnabledSlug(msg, ov.agent_slug);
    }
  }

  // ── Tier 3: Channel default agent ──
  const cacheKey = msg.channel;
  const cached = agentCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return await gateEnabledSlug(msg, cached.slug);
  }

  const { data: instance } = await supabase
    .from('channel_instances')
    .select('agent_slug')
    .eq('name', msg.channel)
    .single();

  const slug = instance?.agent_slug || '';

  agentCache.set(cacheKey, {
    slug,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return await gateEnabledSlug(msg, slug);
}

/**
 * Load agent config from agents table (Paperclip Core — SSOT).
 * Maps agents table fields to AgentConfig interface.
 */
export async function loadAgentConfig(slug: string): Promise<AgentConfig | null> {
  const cached = configCache.get(slug);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.config;
  }

  // Query both: agents (core) + paperclip_agents (SSOT for model/provider/temperature)
  const [{ data, error }, { data: pa }] = await Promise.all([
    supabase.from('agents').select('*').eq('slug', slug).single(),
    supabase.from('paperclip_agents').select('*').eq('slug', slug).single(),
  ]);

  if (error || !data) {
    console.warn(`[Router] Agent config not found for slug: ${slug}`);
    return null;
  }

  const ac = (data.adapter_config || {}) as Record<string, any>;

  // Map: paperclip_agents is SSOT for model/provider/temperature
  const config: AgentConfig = {
    id: data.id,
    slug: data.slug || slug,
    display_name: pa?.display_name || data.name,
    description: pa?.description || data.capabilities || null,
    avatar: pa?.avatar || data.icon || null,
    provider: (pa?.provider || (data.adapter_type === 'claude_local' ? 'claude' : data.adapter_type === 'gemini_local' ? 'gemini' : data.adapter_type === 'antigravity_local' ? 'antigravity' : 'openrouter')) as any,
    model: pa?.model || ac.model || 'claude-sonnet-4-6',
    temperature: pa?.temperature != null ? parseFloat(pa.temperature) : (parseFloat(ac.temperature) || 0.7),
    max_tokens: parseInt(ac.maxTokens) || 4096,
    system_prompt: pa?.system_prompt || ac.systemPrompt || ac.promptTemplate || null,
    persona_file: ac.instructionsFilePath || null,
    language: pa?.language || ac.language || 'vi',
    tools: pa?.tools || ac.tools || [],
    can_escalate_to: ac.canEscalateTo || [],
    fallback_message: ac.fallbackMessage || 'Xin lỗi, em không thể xử lý yêu cầu này.',
    effort_mode: ac.effortMode || ac.thinkingEffort || 'auto',
    max_turns: pa?.max_turns != null ? parseInt(pa.max_turns) : (parseInt(ac.maxTurns) || 1),
    history_limit: parseInt(ac.historyLimit) || 20,
    session_timeout: 3600,
    enabled: pa?.enabled ?? (data.status !== 'paused'),
    // Antigravity (agy) seeded brain id — see AgentConfig.conversation_id.
    conversation_id: ac.conversationId || pa?.conversation_id || null,
    fallback_models: ac.fallbackModels,
    created_at: data.created_at,
    updated_at: pa?.updated_at || data.updated_at,
  };

  configCache.set(slug, {
    config,
    expiresAt: Date.now() + CONFIG_CACHE_TTL_MS,
  });

  return config;
}

/**
 * Run an agent: resolve config, load history, execute, save history.
 */
/**
 * Thrown when an agent run is cancelled by an EXTERNAL AbortSignal (a new customer
 * message arrived mid-generation → cancel-in-flight re-coalesce). Kept DISTINCT
 * from a genuine empty reply ('') so the consumer can un-claim + re-coalesce
 * instead of marking the batch agent_silent (which would lose the reply). Also
 * distinct from an internal timeout (that stays a provider failure → '').
 */
export class AgentAbortedError extends Error {
  constructor(msg = 'agent run aborted (cancel-in-flight)') {
    super(msg);
    this.name = 'AgentAbortedError';
  }
}

export async function runAgent(
  agentSlug: string,
  sessionKey: string,
  message: string,
  originalMsg: InboundMessage,
  history?: SessionMessage[],
  signal?: AbortSignal,
): Promise<string> {
  try {
    const baseConfig = await loadAgentConfig(agentSlug);

    if (!baseConfig) {
      // No config → stay SILENT (no fallback message). Consumer saves to inbox.
      console.warn(`[Router] ❌ No config for agent "${agentSlug}" — staying silent`);
      return '';
    }

    if (!baseConfig.enabled) {
      // Disabled agent → NO reply at all (no fallback). Normally already gated
      // in resolveAgent; this is defense-in-depth.
      return '';
    }

    // PER-REQUEST CLONE (provider-agnostic safety). loadAgentConfig returns a
    // SHARED cached object; mutating it with per-message data
    // (_customerContext/_media/_companyId) bleeds across CONCURRENT messages —
    // customer A's reply addressed customer B by name ("Anh Tam" incident).
    // Clone so every in-flight message owns its own property bag.
    const config = { ...baseConfig } as AgentConfig;

    // Attach customer context from consumer if available
    if ((originalMsg as any)?._customerContext) {
      (config as any)._customerContext = (originalMsg as any)._customerContext;
    }

    // Attach media (image/voice/file) from inbound message — used by multimodal
    // providers (Claude vision, Gemini). Providers resolve base64 on demand.
    if (originalMsg?.media && originalMsg.media.length > 0) {
      (config as any)._media = originalMsg.media;
      (config as any)._contentType = originalMsg.contentType;
    }

    // Load history from session if not provided
    const sessionHistory = history || await loadHistory(sessionKey, config.history_limit);

    const reply = await runAgentWithConfig(config, sessionKey, message, sessionHistory, signal);

    // Save history (single writer — stamps agent_session_id on each entry).
    // NOTE (Codex D2): this runs ONLY on a successful (non-aborted) run — an
    // AgentAbortedError thrown by runAgentWithConfig short-circuits to the catch
    // below, so an aborted reply never enters history (no phantom assistant turn).
    const senderNameForHist = (originalMsg as any)?.senderName || null;
    await saveHistory(sessionKey, message, reply, config, senderNameForHist);

    // Surface outbound media (extracted from [[SEND_MEDIA: id]] markers) back
    // to the caller via the originalMsg side-channel so consumer.ts can attach
    // it to the published OutboundMessage. This avoids changing runAgent's
    // string return signature.
    const outMedia = (config as any)._outboundMedia as MediaFile[] | undefined;
    if (outMedia && outMedia.length > 0) {
      (originalMsg as any)._outboundMedia = outMedia;
    }

    // Bridge escalation intent (set by postProcessReply) back to the message so
    // consumer.ts can fire handleEscalation (ticket + bot_paused + CS ping).
    const esc = (config as any)._escalation;
    if (esc) {
      (originalMsg as any)._escalation = esc;
    }

    const msgChunks = (config as any)._messageChunks as MessageChunk[] | undefined;
    if (msgChunks && msgChunks.length > 1) {
      (originalMsg as any)._messageChunks = msgChunks;
    }

    return reply;
  } catch (err: any) {
    // Cancel-in-flight: propagate abort so the consumer can un-claim + re-coalesce.
    // Do NOT swallow to '' (that would look like a genuine empty reply → the batch
    // would be marked agent_silent and the customer's message lost). Codex C1.
    if (err instanceof AgentAbortedError) throw err;
    console.error(`[Router] ❌ Agent "${agentSlug}" failed:`, err.message);
    return '';  // no fallback — stay silent; consumer saves to inbox
  }
}

/**
 * Run an agent with a specific config — main entry point.
 * Used by both the consumer pipeline and the /test endpoint.
 */
export async function runAgentWithConfig(
  config: AgentConfig,
  sessionKey: string,
  message: string,
  history?: SessionMessage[],
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new AgentAbortedError();  // already cancelled before we start
  const customerContext = (config as any)._customerContext || null;
  // Company context resolved either from the config override (set by SOP
  // executor or channel consumer) or the single-tenant default GEMRAL.
  const companyId = (config as any)._companyId || DEFAULT_COMPANY_ID;
  // Chuỗi tra cứu cho SSOT inline chọn lọc: câu hiện tại + 3 lượt KHÁCH gần nhất (câu ngắn kiểu
  // "còn không em?" cần ngữ cảnh lượt trước để biết đang nói SP nào).
  const recentUser = (history || []).filter((h) => h.role === 'user').slice(-3).map((h) => h.content || '');
  const retrievalQuery = [...recentUser, message || ''].join('\n').slice(-4000);
  const systemPrompt = await buildSystemPrompt(config, customerContext, companyId, retrievalQuery);
  // Time-aware, payment-safe history for EVERY provider: strip injected CRM context,
  // stamp each turn with [DD/MM HH:mm] (HCM), mark pre-boundary turns [CŨ] + downgrade old
  // bill/link-card images, and insert a "PHIÊN TRƯỚC KẾT THÚC" note. Prevents the agent
  // reading an old-session bill as the current order's payment. (plan CSKH-SALES-CLOSER-BRAIN)
  const chatHistory = renderHistoryForPrompt(history || []);

  // PROVIDER-AGNOSTIC identity header: prepend WHO this message is from so the
  // model never confuses customers in a shared context — applies to every
  // provider below (CLI claude/gemini AND API nvidia/openrouter + future).
  const messageForAgent = buildIdentityHeader(customerContext) + message;

  // Single dispatch closure so the pre-send payment gate can regenerate once without
  // duplicating the provider switch.
  // CLI quá 5' → đổi provider 1 lần thay vì trả '' (khách bị bỏ rơi câm — GEM-1050 agy→claude,
  // GEM-1067 claude→gemini · gemini→claude). Fallback gọi thẳng runViaX, không qua dispatch ⇒ không lặp.
  const withTimeoutFallback = (primary: () => Promise<string>, msg: string): Promise<string> => {
    const fb = resolveTimeoutFallback(config.provider);
    return runWithTimeoutFallback(
      primary,
      fb
        ? async () => {
            // Clone: model của agent gốc ('Gemini 3.1 Pro (High)', 'claude-…') không chạy được trên CLI đích.
            const fbConfig = { ...config, provider: fb.provider, model: fb.model } as AgentConfig;
            // agy không lưu phiên CLI nên claude fallback được resume phiên claude của thread (như cũ).
            // claude⇄gemini: id phiên của provider kia KHÔNG resume được ở CLI này → phiên trắng ('' = không
            // đọc/ghi channel_sessions); lịch sử vẫn đủ vì phiên mới nhận buildFullPrompt(history).
            // 02/10: agy→claude cũng KHÔNG resume nữa — phiên claude chỉ sinh ở các lần fallback lẻ tẻ nên
            // thiếu các lượt agy trả lời xen giữa, lại tích token (235k/lượt) → resume treo tới timeout.
            // Phiên mới nhận buildFullPrompt(history) = lịch sử đủ + nhẹ.
            const fbSessionKey = '';
            const out = fb.provider === 'gemini'
              ? await runViaGemini(fbConfig, systemPrompt, chatHistory, msg, fbSessionKey, signal)
              : await runViaClaude(fbConfig, systemPrompt, chatHistory, msg, fbSessionKey, signal);
            // Session drill-down (saveHistory) phải trỏ phiên đã thật sự xử lý lượt này.
            (config as any)._agent_session_id = (fbConfig as any)._agent_session_id;
            return out;
          }
        : null,
      () => console.warn(`[Router/${config.provider}] ${config.slug}: CLI timeout → fallback ${fb?.provider} (${fb?.model}) 1 lần`),
      // Circuit-breaker (GEM-1068): provider timeout liên tiếp → bỏ qua primary một lúc, khách khỏi chờ 5' mỗi tin.
      getTimeoutBreaker(config.provider),
      () => console.warn(`[Router/${config.provider}] ${config.slug}: circuit-breaker MỞ → bỏ qua ${config.provider}, chạy thẳng ${fb?.provider}`),
      // GEM-1427: caller (gemini-proxy) đóng kết nối → không chạy fallback claude oan vào socket đã đóng.
      signal,
    );
  };

  const dispatch = async (msg: string): Promise<string> => {
    switch (config.provider) {
      case 'claude':
        return withTimeoutFallback(() => runViaClaude(config, systemPrompt, chatHistory, msg, sessionKey, signal), msg);
      case 'gemini':
        return withTimeoutFallback(() => runViaGemini(config, systemPrompt, chatHistory, msg, sessionKey, signal), msg);
      case 'antigravity':
        return withTimeoutFallback(() => runViaAntigravity(config, systemPrompt, chatHistory, msg, sessionKey, signal), msg);
      case 'nvidia_nim':
        return withTimeoutFallback(() => runViaNvidiaNim(config, systemPrompt, chatHistory, msg, signal), msg);
      case 'openrouter':
        return withTimeoutFallback(() => runViaOpenRouter(config, systemPrompt, chatHistory, msg, signal), msg);
      default:
        console.warn(`[Router] Unknown provider: ${config.provider}, falling back to Claude`);
        return runViaClaude(config, systemPrompt, chatHistory, msg, sessionKey, signal);
    }
  };

  try {
    let reply: string = await dispatch(messageForAgent);
    if (signal?.aborted) throw new AgentAbortedError();  // aborted during generation → skip postProcess/side-effects

    // ── Pre-send payment-policy gate (A9, sales-closer prepay) ──
    // Catch COD/Momo offers or payment-method questions BEFORE the reply reaches the
    // customer (P-COD is monitoring only — too late once sent). Regenerate once with a
    // correction; if it still violates, refuse + escalate (bot_paused + ticket + CS ping).
    if (PREPAY_POLICY_AGENTS.has(config.slug) && detectPaymentPolicyViolation(reply)) {
      const bad = detectPaymentPolicyViolation(reply);
      console.warn(`[Router/prepay] violation slug=${config.slug}: "${(bad || '').slice(0, 70)}" → regenerate once`);
      const fixNote =
        '\n\n[HỆ THỐNG] Bản trả lời trước VI PHẠM QUY TẮC TIỀN (nhắc COD/Momo hoặc hỏi khách chọn hình thức thanh toán). '
        + 'Viết LẠI: TUYỆT ĐỐI không nhắc COD/Momo, không hỏi hình thức; nếu đã đủ tên + SĐT + địa chỉ thì gửi thông tin chuyển khoản ngay. Chỉ trả lời khách, không giải thích.';
      const reply2 = await dispatch(messageForAgent + fixNote);
      if (signal?.aborted) throw new AgentAbortedError();
      if (detectPaymentPolicyViolation(reply2)) {
        console.warn(`[Router/prepay] refuse slug=${config.slug} after regenerate → escalate`);
        (config as any)._escalation = {
          reason: 'payment_policy_violation',
          priority: 'high',
          summary: 'Agent nhắc COD / hỏi hình thức thanh toán 2 lần liên tiếp — cần người xử lý đơn.',
        };
        reply = ''; // 03/10: im lặng, escalation payment_policy_violation chạy ở consumer
      } else {
        reply = reply2;
      }
    }

    // ── HOISTED customer-facing contract (Reply Gateway P1) ──
    // Single chokepoint: scrub banned phrases + parse [[SEND_MEDIA]]/[[ESCALATE]]
    // markers + collapse-guard runs here for EVERY provider — not inside each
    // runVia*. This closes the gap where nvidia_nim/openrouter returned RAW
    // (never scrubbed). The 3 CLI providers no longer call postProcessReply
    // internally; they return the raw model reply and this is the only place it
    // is cleaned. Side-channels (_escalation/_outboundMedia) are set on `config`
    // (same object the consumer reads after runAgent returns).
    // ── Marker tool loop ([[CALL: tool(...)]]) — MUST run BEFORE postProcessReply ──
    // postProcessReply Rule 3b strips every [[CALL:…]] as a leak; without this loop the
    // agent's tool calls (create_shopify_order, create_ticket, verify_customer_identity…)
    // were silently discarded for all CLI providers (27/09: sales-closer "chốt đơn" never
    // created the Shopify order; CALL args with a CRM uuid also tripped the leak guard →
    // agent_output_corrupted → bot auto-paused).
    reply = await runMarkerToolLoop(reply, config, sessionKey, messageForAgent, dispatch, signal);

    const mediaLib = loadMediaLibrary(config.slug);
    reply = await postProcessReply(reply, config, mediaLib);

    return reply.trim();  // empty → consumer stays silent (no fallback)
  } catch (err: any) {
    if (err instanceof AgentAbortedError) throw err;  // cancel-in-flight — do NOT swallow to '' (Codex C1)
    console.error(`[Router] Provider ${config.provider} failed for ${config.slug}:`, err.message);
    return '';  // no fallback — stay silent
  }
}

/**
 * Clear the agent cache (e.g., after config change).
 */
export function clearAgentCache(): void {
  agentCache.clear();
  configCache.clear();
}

// ─── Skills / Instructions helpers (matching Core execute.ts pattern) ───

/**
 * Build temp dir with .claude/skills/ symlinks to skills-store.
 * Matches execute.ts buildSkillsDir() — triggers SessionStart:startup
 * so Claude auto-loads Skills/Tools.
 */
function buildSkillsDirForChat(): string {
  const tmp = mkdtempSync(pathJoin(tmpdir(), 'paperclip-chat-skills-'));
  const target = pathJoin(tmp, '.claude', 'skills');
  mkdirSync(target, { recursive: true });

  if (existsSync(SKILLS_STORE)) {
    try {
      for (const entry of readdirSyncFS(SKILLS_STORE)) {
        const src = pathResolve(SKILLS_STORE, entry);
        const dest = pathJoin(target, entry);
        try {
          symlinkSync(src, dest, 'junction');
        } catch { /* skip if symlink fails */ }
      }
    } catch { /* skip */ }
  }

  return tmp;
}

/**
 * Write instructions (system prompt + customer context) to temp file.
 * Matches execute.ts effectiveInstructionsFilePath pattern.
 */
function writeInstructionsFile(skillsDir: string, content: string): string {
  const filePath = pathJoin(skillsDir, 'agent-instructions.md');
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

// ─── Provider implementations ───

/**
 * Run via Claude CLI with PERSISTENT SESSION + Skills/Tools.
 * Follows Core execute.ts pattern:
 *   --print - (stdin), --output-format stream-json, --add-dir, --append-system-prompt-file
 *   CWD = PROJECT ROOT (not agents/{slug}/)
 */
async function runViaClaude(
  config: AgentConfig,
  systemPrompt: string,
  history: SessionMessage[],
  message: string,
  sessionKey: string = '',
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new AgentAbortedError();
  // 1. Check persistent session
  const sessionId = await getThreadSessionId(sessionKey);

  // 2. Build skills dir (matches execute.ts — triggers Skills/Tools)
  const skillsDir = buildSkillsDirForChat();

  // 2b. Load media library for this agent (provider-agnostic)
  const mediaLib = loadMediaLibrary(config.slug);

  // 3. Write system prompt + customer context to temp file
  //    (matches execute.ts effectiveInstructionsFilePath)
  let instructionsFile: string | undefined;
  if (systemPrompt && !sessionId) {
    // Only write instructions for NEW session (resume already has context).
    // Append provider-agnostic override: native MCP tools + media markers +
    // no-phone-number rule + no-tool-call-leak rule.
    const instructions = [
      systemPrompt,
      buildProviderOverride(config.slug, mediaLib),
      `\nThe above agent instructions apply to chat conversations on Zalo/Facebook.`,
      `Agent slug: ${config.slug}. Resolve relative paths from ${PROJECT_ROOT}.`,
    ].join('\n');
    instructionsFile = writeInstructionsFile(skillsDir, instructions);
  }

  // 4. Build user prompt (message only — context is in instructions file)
  // [Khách:] prefix is injected in BOTH new-session and resume paths so the
  // AgentLogDrawer can always extract customer name + channel from JSONL turns.
  // `message` already carries the [NGUỒN TIN NHẮN] identity header (prepended in
  // runAgentWithConfig) so the model always knows which customer it is replying to.
  let userPrompt: string;
  if (!sessionId) {
    // First message — instructions file has system prompt; identity header is in message.
    userPrompt = buildFullPrompt(history, message);
  } else {
    // Resume — only the new message (already carries identity header)
    userPrompt = message;
  }

  // 5. Build args — matches execute.ts buildClaudeArgs()
  //    MODEL: ALWAYS from config.model (paperclip_agents SSOT — RULE 5)
  const args: string[] = [
    '--print', '-',                        // stdin prompt (not -p)
    '--output-format', 'stream-json',      // streaming (not json)
    '--verbose',
    '--dangerously-skip-permissions',
    // Force DEFAULT output style for customer-facing agents. The subprocess runs
    // with cwd=PROJECT_ROOT, which loads crypto-pattern-scanner/.claude/settings.local.json
    // where outputStyle="Explanatory" (Jennie's dev mode) — that makes the agent
    // leak "★ Insight ───" educational blocks into customer replies (incident
    // 2026-06-10: scrub then collapsed them to a lone backtick). CLI --settings
    // overrides project-local settings, so this neutralizes it at the source.
    '--settings', '{"outputStyle":"default"}',
    // Cách ly môi trường dev (02/10, khách Thúy #4848 bị bỏ rơi 14'): cwd=PROJECT_ROOT kéo theo
    // hook SessionStart + 27 plugin user + mọi MCP dự án (.mcp.json) → 1 lượt CSKH tốn 235k token
    // input, resume nhân đôi → treo tới AGENT_TIMEOUT. Không nạp settings user/project/local
    // (chỉ --settings trên) + chỉ MCP của agent: đo prompt thử 133k → 43k token.
    // 1 token '=' (KHÔNG tách '', ''): nhánh dự phòng shell:true của spawnHidden làm rơi đối số rỗng.
    '--setting-sources=',
    '--strict-mcp-config',
  ];

  if (sessionId) {
    args.push('--resume', sessionId);
    console.log(`[Router] Resuming session ${sessionId.substring(0, 8)}... for ${config.slug}`);
  }

  // Model from UI Cấu hình Agent → paperclip_agents.model (SSOT)
  if (config.model) {
    args.push('--model', config.model);
    console.log(`[Router] Model from DB: ${config.model}`);
  }

  // Max turns from UI Cấu hình Agent → paperclip_agents.max_turns (SSOT)
  const maxTurns = (config as any).max_turns || 5;
  if (maxTurns > 0) {
    args.push('--max-turns', String(maxTurns));
  }

  // Instructions file (instead of stuffing into -p)
  if (instructionsFile) {
    args.push('--append-system-prompt-file', instructionsFile);
  }

  // Skills dir (triggers Skills/Tools — matches execute.ts)
  args.push('--add-dir', skillsDir);

  // MCP config if agent has one
  const agentDir = pathResolve(
    process.env.AGENTS_DIR || pathResolve(PROJECT_ROOT, 'agents'),
    config.slug,
  );
  const mcpConfigPath = pathJoin(agentDir, 'mcp.json');
  if (existsSync(mcpConfigPath)) {
    args.push('--mcp-config', mcpConfigPath);
  }

  // 6. CWD = PROJECT ROOT (not agents/{slug}/)
  const cwd = PROJECT_ROOT;

  // 7. Spawn + stream
  const streamKey = `${config.slug}:${Date.now()}`;
  streamEvents.emit('agent:start', { agentSlug: config.slug, streamKey });

  return new Promise<string>((resolve, reject) => {
    // spawnHidden — claude is .exe so spawns directly with windowsHide.
    // Plain `shell: true + windowsHide: true` flashes a black console window
    // on Windows because CREATE_NO_WINDOW doesn't always reach grandchildren.
    const child = spawnHidden('claude', args, {
      cwd,
      env: {
        ...childEnvWithoutGeminiApi(process.env),
        GEMRAL_SUPABASE_URL: process.env.GEMRAL_SUPABASE_URL || '',
        GEMRAL_SUPABASE_SERVICE_KEY: process.env.GEMRAL_SUPABASE_SERVICE_KEY || '',
        SHOPIFY_STORE_URL: process.env.SHOPIFY_STORE_URL || '',
        SHOPIFY_ACCESS_TOKEN: process.env.SHOPIFY_ACCESS_TOKEN || '',
        RESEND_API_KEY: process.env.RESEND_API_KEY || '',
        // Identity gate context for the spawned MCP server
        PAPERCLIP_AGENT_SLUG: config.slug,
        PAPERCLIP_SESSION_KEY: sessionKey,
        PAPERCLIP_CHANNEL_NAME: (config as any)._customerContext?.channel_name || '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Send prompt via stdin (matches execute.ts --print -)
    // Subprocess can die mid-write (e.g. CLI exits early on error). Without
    // the 'error' listener, EOF on the stdin pipe crashes the entire server.
    if (child.stdin) {
      child.stdin.on('error', (err) => {
        console.error(`[Router] Claude stdin error for ${config.slug}: ${err.message}`);
        streamEvents.emit('agent:error', { agentSlug: config.slug, streamKey, error: `stdin: ${err.message}` });
      });
      try {
        if (child.stdin.writable) {
          child.stdin.write(userPrompt);
          child.stdin.end();
        }
      } catch (err: any) {
        console.error(`[Router] Claude stdin write threw for ${config.slug}: ${err?.message || err}`);
      }
    }

    let stdout = '';
    let stderr = '';
    // Cancel-in-flight: a new customer message arrived mid-generation → kill the
    // CLI now (stop wasting tokens + release the session lock fast) and reject
    // with AgentAbortedError so the consumer un-claims + re-coalesces. `settled`
    // guards the close handler from running its parse/resolve side-effects after
    // an abort (Codex C4 — first-settle-wins; skip the rest).
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill('SIGTERM');
      // Dấu vết treo ở đâu (trước đây bỏ trống → không chẩn được): sự kiện stream cuối + stderr cuối.
      const lastEvent = stdout.trim().split('\n').pop()?.slice(0, 200) || '(chưa có stdout)';
      console.error(`[Router] Claude CLI timeout ${config.slug} (resume=${sessionId ? 'yes' : 'no'}) last_stdout=${lastEvent} stderr=${stderr.slice(-300) || '(trống)'}`);
      reject(new ProviderTimeoutError('claude', 'Claude', config.slug));
    }, AGENT_TIMEOUT_MS);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      reject(new AgentAbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stdout += text;
      streamEvents.emit('agent:chunk', { agentSlug: config.slug, streamKey, chunk: text, partial: stdout });
    });

    child.stderr?.setEncoding("utf8");
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    child.on('close', async (code) => {
      if (settled) return;   // aborted/timed-out already — skip parse/resolve side-effects
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(timeout);

      // Cleanup temp dir
      try { rmSync(skillsDir, { recursive: true, force: true }); } catch { /* OK */ }

      if (code !== 0 && !stdout.trim()) {
        console.error(`[Router] Claude CLI exited ${code}: ${stderr.substring(0, 200)}`);
        if (sessionId && (stderr.includes('session') || stderr.includes('resume'))) {
          console.log(`[Router] Clearing stale session for ${config.slug}`);
          await clearThreadSession(sessionKey);
        }
        streamEvents.emit('agent:error', { agentSlug: config.slug, streamKey, error: stderr.substring(0, 200) });
        reject(new Error(stderr.substring(0, 200) || `Exit code ${code}`));
        return;
      }

      // Parse stream-json output (Claude CLI JSONL format)
      // Format: {type:"system"}, {type:"assistant", message:{content:[{type:"text",text:"..."}]}},
      //         {type:"result", result:"...", session_id:"..."}, etc.
      let reply = '';
      let newSessionId: string | null = null;
      const textChunks: string[] = [];
      try {
        const lines = stdout.trim().split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            // Session ID from any line
            if (parsed.session_id) newSessionId = parsed.session_id;

            // Final result (legacy + new format)
            if (parsed.type === 'result' && parsed.result) {
              if (typeof parsed.result === 'string') {
                reply = parsed.result;
              } else if (Array.isArray(parsed.result)) {
                reply = parsed.result.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
              }
            }
            // Assistant message with content blocks
            if (parsed.type === 'assistant' && parsed.message?.content) {
              const blocks = Array.isArray(parsed.message.content) ? parsed.message.content : [parsed.message.content];
              for (const b of blocks) {
                if (b.type === 'text' && b.text) textChunks.push(b.text);
              }
            }
            // Content block delta (streaming)
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              textChunks.push(parsed.delta.text);
            }
            // Message delta with text
            if (parsed.type === 'message' && parsed.role === 'assistant' && parsed.content) {
              textChunks.push(parsed.content);
            }
          } catch { /* skip non-JSON lines */ }
        }

        // Use result if available, otherwise combine text chunks
        if (!reply && textChunks.length > 0) {
          reply = textChunks.join('');
        }
        // Last resort: if nothing parsed, DON'T return raw JSON — return error message
        if (!reply) {
          console.warn(`[Router] Claude JSONL parse: no text found in ${lines.length} lines`);
          reply = ''; // 03/10: KHÔNG câu đệm — rỗng = consumer im lặng + báo người
        }

        // Save session ID
        if (newSessionId && !sessionId) {
          await saveThreadSessionId(sessionKey, newSessionId);
        }

        // Expose session_id via side-channel so saveHistory() can stamp it
        // onto each history entry's metadata (enables per-message drill-down
        // in the Chat Drawer → Session Picker panel).
        (config as any)._agent_session_id = newSessionId || sessionId || null;

        console.log(`[Router/${config.provider}] ${config.slug}: reply ${reply.length} chars, session=${newSessionId?.substring(0, 8) || 'none'}`);

        // NOTE: customer-facing post-processing (scrub + media/escalation markers)
        // is HOISTED to runAgentWithConfig (Reply Gateway P1) — the single chokepoint
        // for every provider. This returns the RAW model reply; do NOT scrub here.

        // Track usage via RPC
        try {
          await supabase.rpc('increment_agent_usage', {
            p_slug: config.slug,
            p_input: 0, p_output: 0, p_cost: 0, p_duration: 0,
          });
        } catch { /* ignore */ }

      } catch (parseErr) {
        console.warn('[Router] Parse failed:', parseErr);
        // NEVER return raw JSON to customer — return safe fallback
        reply = ''; // 03/10: KHÔNG câu đệm — rỗng = consumer im lặng + báo người
      }

      streamEvents.emit('agent:done', { agentSlug: config.slug, streamKey, reply });
      resolve(reply);
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      try { rmSync(skillsDir, { recursive: true, force: true }); } catch { /* OK */ }
      streamEvents.emit('agent:error', { agentSlug: config.slug, streamKey, error: err.message });
      reject(err);
    });
  });
}

// ─── Persistent session DB helpers ───

async function getAgentSessionId(slug: string): Promise<string | null> {
  // Find ANY existing session (running OR idle) — session files persist on disk
  const { data } = await supabase
    .from('agent_sessions')
    .select('session_id')
    .eq('agent_slug', slug)
    .in('status', ['running', 'idle'])
    .single();
  const sessionId = data?.session_id || null;
  if (!sessionId) return null;

  // Defensive check: verify JSONL file still exists on disk. Claude CLI's
  // cleanupPeriodDays or a crashed spawn can leave the DB row pointing at a
  // ghost session — `--resume` would then fail or silently spawn a new session.
  // If missing: mark stopped and return null so caller creates a fresh session.
  try {
    const { homedir } = await import('node:os');
    const projectsRoot = pathResolve(homedir(), '.claude', 'projects');
    if (existsSync(projectsRoot)) {
      const dirs = readdirSync(projectsRoot);
      for (const dir of dirs) {
        if (existsSync(pathJoin(projectsRoot, dir, `${sessionId}.jsonl`))) {
          return sessionId;
        }
      }
    }
    console.warn(`[Router] Ghost session for ${slug}: ${String(sessionId).substring(0, 8)}… — archiving, will create fresh`);
    await supabase.from('agent_sessions')
      .update({ status: 'stopped' })
      .eq('agent_slug', slug)
      .eq('session_id', sessionId);
    return null;
  } catch (err: any) {
    console.warn(`[Router] Ghost-session check failed for ${slug}: ${err.message} — returning ID anyway`);
    return sessionId;
  }
}

async function saveAgentSession(slug: string, sessionId: string): Promise<void> {
  await supabase.from('agent_sessions').upsert({
    agent_slug: slug,
    session_id: sessionId,
    status: 'running',
    started_at: new Date().toISOString(),
    last_activity_at: new Date().toISOString(),
    terminal_type: 'direct',
    total_requests: 1,
  }, { onConflict: 'agent_slug' });
  console.log(`[Router] Session saved: ${slug} → ${sessionId.substring(0, 20)}...`);
}

/** Mark session as actively running — ONLY called by increment_agent_usage RPC now */
async function markSessionRunning(_slug: string): Promise<void> {
  // DISABLED — use increment_agent_usage RPC only
  return;
}

async function updateAgentSessionActivity(_slug: string): Promise<void> {
  // DISABLED — phantom update source. Only increment_agent_usage RPC should update last_activity_at.
  return;
}

async function clearAgentSession(slug: string): Promise<void> {
  await supabase.from('agent_sessions')
    .update({ status: 'stopped' })
    .eq('agent_slug', slug);
}

// ─── PER-THREAD architecture (provider-agnostic: claude / gemini / future) ───
// Two cross-customer bleed vectors are closed here:
//  1. CLI session must be PER customer thread (sessionKey), NOT per agent slug —
//     otherwise every customer resumes the same CLI session and the model "remembers"
//     other customers (the "Anh Tam" incident on Claude resume).
//  2. Each message carries an explicit identity header so the model always knows
//     WHO it is replying to (Telegram-style source tag) — defense-in-depth for any
//     provider, including API providers that keep no CLI session.

/**
 * Build the per-message identity header. Provider-agnostic — prepended to the
 * user message in runAgentWithConfig so EVERY provider (CLI or API) receives it.
 */
function buildIdentityHeader(ctx: any): string {
  if (!ctx) return '';
  const id = ctx.sender_id || ctx.account_id || '?';
  const name = ctx.name || ctx.sender_name || 'Chưa rõ';
  const GENDER_LABELS: Record<string, string> = {
    nam: 'Nam (khách nam → xưng hô phù hợp: gọi khách là "anh")',
    nu: 'Nữ (khách nữ → xưng hô phù hợp: gọi khách là "chị")',
  };
  const gender = ctx.gender
    ? (GENDER_LABELS[ctx.gender] || ctx.gender)
    : 'chưa rõ — tự suy luận theo cách khách xưng hô';
  const channel = ctx.channel_name || 'Zalo';
  const crmId = ctx.customer_id || null;
  const lines = [
    `[NGUỒN TIN NHẮN] account_id=${id} | tên=${name} | giới_tính=${gender} | kênh=${channel}`,
  ];
  if (crmId) {
    lines.push(
      `crm_customer_id=${crmId}  ← BẮT BUỘC truyền id NÀY vào tham số customer_id của MỌI CRM tool `
        + `(create_ticket, get_customer_info, check_course_access, crm_update, recall_memory...).`,
    );
  }
  lines.push(`→ CHỈ trả lời cho người này. KHÔNG dùng thông tin/tên của khách khác trong lịch sử.`, '');
  return lines.join('\n');
}

/** Resolve the CLI session for a specific customer thread (sessionKey). */
async function getThreadSessionId(sessionKey: string): Promise<string | null> {
  if (!sessionKey) return null;
  const { data } = await supabase
    .from('channel_sessions')
    .select('cli_session_id')
    .eq('session_key', sessionKey)
    .maybeSingle();
  const sessionId = (data as any)?.cli_session_id || null;
  if (!sessionId) return null;
  // Verify the session file still exists (Claude JSONL OR Gemini JSON). If the
  // CLI cleaned it up, a --resume would fail; return null so a fresh session is
  // created instead of breaking the customer's reply.
  try {
    const { homedir } = await import('node:os');
    const short8 = String(sessionId).substring(0, 8);
    const claudeRoot = pathResolve(homedir(), '.claude', 'projects');
    if (existsSync(claudeRoot)) {
      for (const dir of readdirSync(claudeRoot)) {
        if (existsSync(pathJoin(claudeRoot, dir, `${sessionId}.jsonl`))) return sessionId;
      }
    }
    const geminiRoot = pathResolve(homedir(), '.gemini', 'tmp');
    if (existsSync(geminiRoot)) {
      for (const proj of readdirSync(geminiRoot)) {
        const chatsDir = pathJoin(geminiRoot, proj, 'chats');
        if (!existsSync(chatsDir)) continue;
        if (readdirSync(chatsDir).some((f) => f.endsWith(`-${short8}.json`))) return sessionId;
      }
    }
    return null; // file gone → fresh session
  } catch {
    return sessionId; // check failed → optimistically resume
  }
}

/** Persist the CLI session id for a specific customer thread. */
async function saveThreadSessionId(sessionKey: string, sessionId: string): Promise<void> {
  if (!sessionKey || !sessionId) return;
  try {
    await supabase.from('channel_sessions')
      .update({ cli_session_id: sessionId })
      .eq('session_key', sessionKey);
  } catch (err: any) {
    console.warn(`[Router] saveThreadSessionId failed for ${sessionKey}: ${err.message}`);
  }
}

/** Clear the CLI session for a thread (e.g. on resume failure → next run is fresh). */
async function clearThreadSession(sessionKey: string): Promise<void> {
  if (!sessionKey) return;
  try {
    await supabase.from('channel_sessions')
      .update({ cli_session_id: null })
      .eq('session_key', sessionKey);
  } catch { /* non-blocking */ }
}

/**
 * Run via Gemini CLI — async spawn with streaming.
 * Matches Gemini Core execute.ts pattern:
 *   --output-format stream-json, --resume, --model, --approval-mode yolo, --sandbox=none, --prompt
 */
async function runViaGemini(
  config: AgentConfig,
  systemPrompt: string,
  history: SessionMessage[],
  message: string,
  sessionKey: string = '',
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new AgentAbortedError();
  // Model from UI Cấu hình Agent → paperclip_agents.model (SSOT)
  const model = config.model || 'gemini-2.5-flash';

  // Session
  const sessionId = await getThreadSessionId(sessionKey);

  // Load media library (provider-agnostic — same helper as Claude)
  const mediaLib = loadMediaLibrary(config.slug);

  // Augment system prompt with provider-agnostic override block:
  //  - native MCP tool use (no [[CALL:...]] marker leak)
  //  - media library catalog + [[SEND_MEDIA: id]] instructions
  //  - no-phone-number rule
  const augmentedSystemPrompt = systemPrompt
    ? [systemPrompt, buildProviderOverride(config.slug, mediaLib)].join('\n')
    : buildProviderOverride(config.slug, mediaLib);

  // Build full prompt (system + history + message)
  // [Khách:] prefix injected so any JSONL log viewer can extract customer identity.
  // `message` already carries the [NGUỒN TIN NHẮN] identity header (prepended in
  // runAgentWithConfig) so the model always knows which customer it is replying to.
  const fullPrompt = augmentedSystemPrompt
    ? [augmentedSystemPrompt, '', buildFullPrompt(history, message)].join('\n')
    : buildFullPrompt(history, message);

  // Gemini CLI: pipe prompt via stdin, use -p to signal non-interactive mode
  // Can't use -p with long prompts (Windows 8K cmd limit)
  // Can't use @file (Gemini treats it as workspace file reference)
  // Solution: pipe via stdin — gemini reads stdin when -p receives stdin content
  const args: string[] = [
    '-o', 'stream-json',                      // --output-format
    '-m', model,                               // --model
    '-y',                                      // --yolo (auto-approve all)
  ];

  // Scope MCP to ONLY the servers this agent needs (crm gated CRM tools incl
  // lookup_order_shopify/create_ticket/check_course_access + marketing assets +
  // DB + email). Without this whitelist gemini connects ALL ~16 global
  // ~/.gemini servers per reply → heavy latency.
  args.push('--allowed-mcp-server-names', 'crm', 'marketing-asset-search', 'supabase', 'resend');

  // Session resume
  if (sessionId) {
    args.push('-r', sessionId);
    console.log(`[Router] Gemini resuming session ${sessionId.substring(0, 8)}...`);
  }

  // Gemini CLI: -p reads prompt from argument OR stdin
  // For long prompts (>7K chars): write to temp file, cat via stdin
  // This avoids Windows cmd length limit AND @file misinterpretation
  const promptFile = pathJoin(PROJECT_ROOT, '.gemini', 'tmp', `prompt-${config.slug}-${Date.now()}.txt`);
  mkdirSync(pathJoin(PROJECT_ROOT, '.gemini', 'tmp'), { recursive: true });
  writeFileSync(promptFile, fullPrompt, 'utf-8');
  (config as any)._promptFile = promptFile;

  // Pipe prompt file content as stdin, -p "" triggers non-interactive mode
  args.push('-p', '');

  console.log(`[Router] Gemini ${config.slug}: model=${model}, prompt=${fullPrompt.length} chars`);

  // CWD = lightweight sandbox dir, NOT PROJECT_ROOT.
  // gemini-cli scans cwd on startup (loads GEMINI.md, scans subdirs for skills,
  // resolves project context). PROJECT_ROOT (crypto-pattern-scanner) has 1000s
  // of files in skills-store/ + agents/ + memory/ → 60-180s startup, often
  // exceeds AGENT_TIMEOUT_MS. Sandbox dir is empty → 5-15s startup.
  // Confirmed empirically 2026-05-05: cps cwd = 86s, paperclip cwd = 16s,
  // empty sandbox cwd should be even faster.
  // Empty shared sandbox for fast gemini startup. The agent's MCP servers (crm:
  // lookup_order_shopify/create_ticket/check_course_access, marketing-asset-search)
  // are installed at the USER scope in ~/.gemini/settings.json + enabled in
  // ~/.gemini/mcp-server-enablement.json — gemini DISABLES workspace-level MCP
  // servers, so per-agent workspace settings.json does NOT work. The
  // --allowed-mcp-server-names whitelist (above) scopes which of those connect.
  const sandboxDir = pathJoin(PROJECT_ROOT, '.gemini', 'chatbot-sandbox');
  mkdirSync(sandboxDir, { recursive: true });
  const cwd = sandboxDir;

  const streamKey = `${config.slug}:${Date.now()}`;
  streamEvents.emit('agent:start', { agentSlug: config.slug, streamKey });

  return new Promise<string>((resolve, reject) => {
    // spawnHidden — gemini is .cmd shim, so spawnHidden invokes cmd.exe with
    // /d /s /c explicitly + windowsHide: true. No black console flash.
    const child = spawnHidden('gemini', args, {
      cwd,
      env: {
        ...childEnvWithoutGeminiApi(process.env),
        // Creds for the agent-scoped MCP servers (crm → DB+Shopify, marketing-asset → DB, resend → email)
        GEMRAL_SUPABASE_URL: process.env.GEMRAL_SUPABASE_URL || '',
        GEMRAL_SUPABASE_SERVICE_KEY: process.env.GEMRAL_SUPABASE_SERVICE_KEY || '',
        SUPABASE_URL: process.env.SUPABASE_URL || 'https://pgfkbcnzqozzkohwbgbk.supabase.co',
        SHOPIFY_STORE_URL: process.env.SHOPIFY_STORE_URL || '',
        SHOPIFY_ACCESS_TOKEN: process.env.SHOPIFY_ACCESS_TOKEN || '',
        RESEND_API_KEY: process.env.RESEND_API_KEY || '',
        // Identity gate context for any MCP server the Gemini CLI may spawn
        PAPERCLIP_AGENT_SLUG: config.slug,
        PAPERCLIP_SESSION_KEY: sessionKey,
        PAPERCLIP_CHANNEL_NAME: (config as any)._customerContext?.channel_name || '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Pipe prompt content via stdin (Gemini -p "" reads from stdin)
    // Subprocess can die mid-write — e.g. gemini-2.5-pro returns 429
    // RESOURCE_EXHAUSTED, CLI retries, then exits. Closing stdin pipe
    // mid-write triggers EOF; without the 'error' listener this becomes
    // an unhandled error event and crashes the entire Node server (incident
    // 2026-05-04: every Zalo DM crashed paperclip-server, no agent reply).
    const pf = (config as any)._promptFile;
    if (pf && child.stdin) {
      child.stdin.on('error', (err) => {
        console.error(`[Router] Gemini stdin error for ${config.slug}: ${err.message}`);
        streamEvents.emit('agent:error', { agentSlug: config.slug, streamKey, error: `stdin: ${err.message}` });
      });
      try {
        if (child.stdin.writable) {
          const promptContent = readFileSync(pf, 'utf-8');
          child.stdin.write(promptContent);
          child.stdin.end();
        }
      } catch (err: any) {
        console.error(`[Router] Gemini stdin write threw for ${config.slug}: ${err?.message || err}`);
      }
    }

    // Clean up temp file after process exits
    if (pf) child.on('exit', () => { try { rmSync(pf, { force: true }); } catch {} });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      reject(new ProviderTimeoutError('gemini', 'Gemini', config.slug));
    }, AGENT_TIMEOUT_MS);

    child.stdout?.setEncoding("utf8");
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stdout += text;
      streamEvents.emit('agent:chunk', { agentSlug: config.slug, streamKey, chunk: text });
    });

    child.stderr?.setEncoding("utf8");
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    child.on('close', async (code) => {
      clearTimeout(timeout);
      // Đã reject vì timeout (fallback claude có thể đang chạy) → KHÔNG parse/ghi phiên/emit agent:done
      // bằng "Xin lỗi, hệ thống đang xử lý" của tiến trình bị kill (đè _agent_session_id của fallback).
      if (timedOut) {
        streamEvents.emit('agent:error', { agentSlug: config.slug, streamKey, error: 'gemini timeout' });
        return;
      }

      if (code !== 0 && !stdout.trim()) {
        console.error(`[Router] Gemini CLI exited ${code}: ${stderr.substring(0, 200)}`);
        if (sessionId && stderr.includes('session')) {
          await clearThreadSession(sessionKey);
        }
        streamEvents.emit('agent:error', { agentSlug: config.slug, streamKey, error: stderr.substring(0, 200) });
        reject(new Error(stderr.substring(0, 200) || `Exit code ${code}`));
        return;
      }

      // Parse stream-json output (Gemini JSONL format)
      // Gemini stream-json emits: {type:"init", session_id}, {type:"message", role:"assistant", content, delta:true}, {type:"result"}
      let reply = '';
      let newSessionId: string | null = null;
      const assistantChunks: string[] = [];
      try {
        const lines = stdout.trim().split('\n');
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            // Session ID from init
            if (parsed.type === 'init' && parsed.session_id) newSessionId = parsed.session_id;
            if (parsed.session_id && !newSessionId) newSessionId = parsed.session_id;
            // Assistant message chunks (delta or full)
            if (parsed.type === 'message' && parsed.role === 'assistant' && parsed.content) {
              assistantChunks.push(parsed.content);
            }
            // Final result (some versions)
            if (parsed.type === 'result' && parsed.response) {
              reply = parsed.response;
            }
            // Legacy format
            if (parsed.result && typeof parsed.result === 'string') {
              reply = parsed.result;
            }
            if (parsed.type === 'content' && parsed.text) assistantChunks.push(parsed.text);
          } catch { /* skip non-JSON lines */ }
        }
        // Combine assistant chunks if no final reply
        if (!reply && assistantChunks.length > 0) reply = assistantChunks.join('');

        // SAFETY: NEVER return raw stdout to customer — leaks system prompt.
        // Gemini stream-json may emit init+user frames before failing to produce
        // assistant content. Falling back to stdout dumps the entire prompt
        // (incident GEM-2026-04-30 sales-closer Zalo: customer received 22KB
        // system prompt JSONL). Detect leak signature + return safe fallback.
        const looksLikeRawJsonl = /^\s*\{"type":"(init|message)"|"role":"(user|system)"/m.test(reply);
        if (!reply || looksLikeRawJsonl) {
          if (looksLikeRawJsonl) {
            console.error(`[Router/${config.provider}] ${config.slug}: REFUSED raw JSONL leak (${reply.length} chars stdout). assistantChunks=${assistantChunks.length}`);
          } else {
            console.warn(`[Router/${config.provider}] ${config.slug}: no assistant text in ${lines.length} lines (assistantChunks=${assistantChunks.length})`);
          }
          reply = ''; // 03/10: KHÔNG câu đệm — rỗng = consumer im lặng + báo người
        }

        if (newSessionId && !sessionId) {
          await saveThreadSessionId(sessionKey, newSessionId);
        }

        // Expose session_id via side-channel (see runViaClaude for rationale).
        (config as any)._agent_session_id = newSessionId || sessionId || null;

        console.log(`[Router/${config.provider}] ${config.slug}: reply ${reply.length} chars`);

        // NOTE: post-processing (scrub + markers) HOISTED to runAgentWithConfig
        // (Reply Gateway P1) — returns RAW reply here, do NOT scrub in this fn.
      } catch (parseErr) {
        console.warn(`[Router/${config.provider}] ${config.slug}: parse failed`, parseErr);
        // NEVER return raw stdout — return safe fallback
        reply = ''; // 03/10: KHÔNG câu đệm — rỗng = consumer im lặng + báo người
      }

      try {
        await supabase.rpc('increment_agent_usage', {
          p_slug: config.slug, p_input: 0, p_output: 0, p_cost: 0, p_duration: 0,
        });
      } catch { /* ignore usage tracking errors */ }

      streamEvents.emit('agent:done', { agentSlug: config.slug, streamKey, reply });
      resolve(reply);
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Run via Antigravity CLI (`agy` → DEFAULT_ANTIGRAVITY_MODEL, Google AI Ultra).
 *
 * agy follows the Claude-Code model: it reads context from a FILE POINTER (no
 * stdin), so we write the full system prompt + history to a temp file and pass a
 * short `-p "Đọc <file>. Trả lời: <msg>"`. CWD = PROJECT_ROOT (agy native file
 * tools are safe, no heavy cwd scan like gemini-cli).
 *
 * TWO Windows constraints (lesson evolution-log/08-windows.md, verified 15/06):
 *  1. agy prints the reply to CONOUT$ (TTY) → the stdout pipe is EMPTY. The reply
 *     MUST be read from the brain transcript.jsonl (PLANNER_RESPONSE after the
 *     USER_INPUT containing this run's unique temp-prompt filename = turnMarker).
 *  2. agy `-p` headless CANNOT create a brain for an unknown --conversation id.
 *     The brain must be pre-seeded ONCE via `agy --conversation <id>` interactive.
 *     So this provider REQUIRES config.conversation_id (a real seeded brain).
 *     Per-customer isolation comes from the injected system prompt + identity
 *     header + history (the file pointer), NOT from per-customer brains.
 */
/**
 * Extract the customer message from the [[REPLY]]...[[/REPLY]] envelope the
 * antigravity reply prompt asks for (2026-08-11 contract).
 *
 * - Multiple envelopes: prefer the LAST one that does NOT trip the
 *   operator-report guard (models sometimes append a self-check envelope after
 *   the real reply — and in the 2026-08-11 incident the real reply sat in the
 *   MIDDLE, so "last" alone is not a safe heuristic).
 * - Open marker without a closing pair (truncated output): take everything
 *   after the last [[REPLY]] — that at least severs the report preamble; the
 *   operator-report guard still checks the remainder.
 * - No marker at all: return the input unchanged (fail-open; guard downstream).
 */
export function extractEnvelopedReply(raw: string): string {
  if (!raw) return raw;
  try {
    const matches = [...raw.matchAll(/\[\[\s*REPLY\s*\]\]([\s\S]*?)\[\[\s*\/\s*REPLY\s*\]\]/gi)]
      .map((m) => (m[1] || '').trim())
      .filter((c) => /[\p{L}\p{N}]/u.test(c));
    if (matches.length > 0) {
      if (matches.length > 1) {
        console.warn(`[Router/antigravity] ${matches.length} [[REPLY]] envelopes in one output — model is drifting off-frame`);
      }
      const clean = [...matches].reverse().find((c) => !detectOperatorReportLeak(c));
      return clean ?? matches[matches.length - 1];
    }
    const openIdx = raw.toUpperCase().lastIndexOf('[[REPLY]]');
    if (openIdx >= 0) {
      const tail = raw.slice(openIdx + '[[REPLY]]'.length).trim();
      if (/[\p{L}\p{N}]/u.test(tail)) return tail;
    }
  } catch (err) {
    console.error('[Router/antigravity] envelope extraction errored (returning raw)', err);
  }
  return raw;
}

async function runViaAntigravity(
  config: AgentConfig,
  systemPrompt: string,
  history: SessionMessage[],
  message: string,
  sessionKey: string = '',
  signal?: AbortSignal,
  _accountRotated: boolean = false,
): Promise<string> {
  if (signal?.aborted) throw new AgentAbortedError();
  const model = config.model || DEFAULT_ANTIGRAVITY_MODEL; // 21/10: 3.1 Pro bị agy gỡ (GEM-1583)

  // Conversation id passed to agy. If a brain with this id exists, agy RESUMES it;
  // otherwise agy IGNORES it and auto-creates its OWN brain (we then locate the real
  // brain + reply via the turnMarker below). So a pre-seeded brain is NOT required —
  // fall back to the per-customer sessionKey for a stable-ish handle. (Full history
  // is re-injected via the file pointer each turn, so brain-memory continuity is not
  // critical for correctness.)
  const conversationId =
    (config.conversation_id || '').trim() || (sessionKey || '').trim() || `agy-${config.slug}`;

  // 29/10: agent `"sandbox": true` — không khối "NATIVE MCP tools … override", chạy thư mục tạm ngoài dự án
  // (agy không tự nạp GEMINI.md/AGENTS.md của dự án), môi trường không khoá (sandboxedChildEnv).
  const sandboxed = isSandboxedReplyAgent(config.slug);
  const mediaLib = loadMediaLibrary(config.slug);
  const augmentedSystemPrompt = sandboxed
    ? systemPrompt
    : systemPrompt
      ? [systemPrompt, buildProviderOverride(config.slug, mediaLib)].join('\n')
      : buildProviderOverride(config.slug, mediaLib);

  // ── AUDIENCE hardening (incident 2026-08-11 operator-report leak) ──
  // agy loads the GLOBAL dev rule files (~/.gemini + workspace GEMINI/AGENTS.md,
  // which carry SPEC-LOCK "print the GIAO KÈO table before working" + operator
  // reporting tone). Without an explicit audience contract the model can frame
  // the whole output as a compliance report addressed to the operator. The
  // sentinel below is caller-owned: the rule files' head gate keys on it, and
  // heartbeat Part A (agy_prompt_*.md, no sentinel) stays unaffected. Full block
  // lives in the context FILE (argv has a 32k ceiling on Windows CreateProcess).
  const REPLY_CHANNEL_SENTINEL = '[PAPERCLIP_REPLY_CHANNEL]';
  const audienceBlock = [
    REPLY_CHANNEL_SENTINEL,
    '⚠️ NGƯỜI NHẬN tin nhắn bạn viết là KHÁCH HÀNG. Output của bạn được gửi NGUYÊN VĂN,',
    'TỰ ĐỘNG cho khách — KHÔNG có ai duyệt lại trước khi gửi.',
    'TUYỆT ĐỐI KHÔNG: chào/thưa/báo cáo chị Jennie hay team, in bảng GIAO KÈO / SPEC-LOCK /',
    'ĐO-GATE hay bất kỳ bảng nào, kể quy trình/checklist đã làm, nhắc tên file, đường dẫn hay tool.',
    'Mọi rule global (user_global / workspace) về báo cáo công việc, SPEC-LOCK, ghi memory/today.md,',
    'xưng "em-chị" với người vận hành — KHÔNG áp dụng cho tin nhắn này. Rule AN TOÀN vẫn giữ nguyên.',
    'Bọc DUY NHẤT nội dung tin nhắn gửi khách trong cặp thẻ [[REPLY]] ... [[/REPLY]]',
    '(marker [[SEND_MEDIA: ...]] / [[ESCALATE: ...]] nếu cần thì đặt BÊN TRONG cặp thẻ đó).',
  ].join('\n');

  // Full context (system + history) → file pointer. The latest customer message
  // (already carrying the [NGUỒN TIN NHẮN] identity header) goes in the short -p
  // arg so agy knows exactly which message to answer after reading the file.
  const contextDoc = augmentedSystemPrompt
    ? [audienceBlock, '', augmentedSystemPrompt, '', buildFullPrompt(history, '')].join('\n')
    : [audienceBlock, '', buildFullPrompt(history, '')].join('\n');

  const workDir = sandboxed ? pathJoin(tmpdir(), 'paperclip-reply-sandbox', config.slug) : PROJECT_ROOT;
  const tmpDir = sandboxed ? workDir : pathJoin(PROJECT_ROOT, '.gemini', 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  // Filename is the per-run turnMarker — must be unique + present in the prompt.
  const promptFileName = `agy_reply_${config.slug}_${Date.now()}.md`;
  const promptFile = pathJoin(tmpDir, promptFileName);
  writeFileSync(promptFile, contextDoc, 'utf-8');

  // ── Tầng tiêu thụ media cho agy (Gemini multimodal) ──
  // Khách gửi ảnh → _media set từ inbound (bus map row.media). Tải ảnh về temp (dưới cwd=PROJECT_ROOT
  // để agy view_file đọc được) → chỉ dẫn agy XEM ảnh trước khi trả lời. Gate: CHỈ ảnh; KHÔNG nhắc
  // URL/path cho khách (chống leak). Ảnh lỗi/không tải được → bỏ qua, agy trả lời theo text.
  let mediaDirective = '';
  const inboundMedia = (config as any)._media as Array<{ url?: string; mimeType?: string }> | undefined;
  if (inboundMedia && inboundMedia.length > 0) {
    const imgPaths: string[] = [];
    for (const m of inboundMedia.slice(0, 3)) {
      try {
        if (!m.url) continue;
        const isImg = (m.mimeType || '').startsWith('image') || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(m.url);
        if (!isImg) continue;
        const r = await fetch(m.url);
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.byteLength > 15 * 1024 * 1024) continue;
        const ext = (m.mimeType || '').includes('png') ? 'png' : (m.mimeType || '').includes('webp') ? 'webp' : 'jpg';
        const imgFile = pathJoin(tmpDir, `agy_img_${config.slug}_${Date.now()}_${imgPaths.length}.${ext}`);
        writeFileSync(imgFile, buf);
        imgPaths.push(imgFile.replace(/\\/g, '/'));
      } catch { /* ảnh lỗi → bỏ qua */ }
    }
    if (imgPaths.length > 0) {
      mediaDirective = [
        '',
        `⚠️ Khách VỪA GỬI ${imgPaths.length} HÌNH ẢNH. BẮT BUỘC dùng view_file XEM từng ảnh sau TRƯỚC khi trả lời, rồi tư vấn dựa trên NỘI DUNG ẢNH:`,
        ...imgPaths,
        'TUYỆT ĐỐI KHÔNG nhắc đường dẫn/URL ảnh cho khách — chỉ trả lời tự nhiên về nội dung bạn thấy.',
      ].join('\n');
    }
  }

  const pointerPrompt = [
    REPLY_CHANNEL_SENTINEL,
    'Dùng công cụ đọc file (view_file) đọc TOÀN BỘ bối cảnh + hướng dẫn + lịch sử hội thoại trong file sau NGAY LẬP TỨC, trước khi trả lời:',
    promptFile.replace(/\\/g, '/'),
    'Sau khi đọc xong, trả lời tin nhắn mới nhất của khách dưới đây bằng đúng NGÔN NGỮ khách đang dùng (khách viết tiếng Anh → trả lời tiếng Anh; tiếng Việt → tiếng Việt có dấu đầy đủ; tiếng Trung → tiếng Trung), đúng vai trò + giọng đã mô tả trong file. TUYỆT ĐỐI KHÔNG đọc lại / trích lại nội dung file cho khách — chỉ trả lời tự nhiên như đang nhắn tin. Bọc DUY NHẤT tin nhắn gửi khách trong [[REPLY]] ... [[/REPLY]]:',
    mediaDirective,
    message,
  ].join('\n');

  const agy = defaultAgyCommand();
  const args: string[] = [
    '-p', pointerPrompt,
    '--model', model,
    '--dangerously-skip-permissions',
    '--conversation', conversationId,
  ];

  const streamKey = `${config.slug}:${Date.now()}`;
  const attemptStartedAtMs = Date.now();
  const attemptAccountEmail = getActiveAntigravityAccountEmail();
  streamEvents.emit('agent:start', { agentSlug: config.slug, streamKey });
  console.log(`[Router] Antigravity ${config.slug}: model=${model}, brain=${conversationId.substring(0, 8)}, ctx=${contextDoc.length} chars`);

  return new Promise<string>((resolve, reject) => {
    // agy is a real .exe → spawnHidden spawns it directly (full path resolved).
    // No stdin (agy reads the prompt from the -p arg / file pointer).
    const child = spawnHidden(agy, args, {
      cwd: workDir,
      env: sandboxed ? {
        ...sandboxedChildEnv(process.env),
        PAPERCLIP_AGENT_SLUG: config.slug,
      } : {
        ...childEnvWithoutGeminiApi(process.env),
        GEMRAL_SUPABASE_URL: process.env.GEMRAL_SUPABASE_URL || '',
        GEMRAL_SUPABASE_SERVICE_KEY: process.env.GEMRAL_SUPABASE_SERVICE_KEY || '',
        SUPABASE_URL: process.env.SUPABASE_URL || 'https://pgfkbcnzqozzkohwbgbk.supabase.co',
        SHOPIFY_STORE_URL: process.env.SHOPIFY_STORE_URL || '',
        SHOPIFY_ACCESS_TOKEN: process.env.SHOPIFY_ACCESS_TOKEN || '',
        RESEND_API_KEY: process.env.RESEND_API_KEY || '',
        PAPERCLIP_AGENT_SLUG: config.slug,
        PAPERCLIP_SESSION_KEY: sessionKey,
        PAPERCLIP_CHANNEL_NAME: (config as any)._customerContext?.channel_name || '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      reject(new ProviderTimeoutError('antigravity', 'Antigravity', config.slug));
    }, Number((config as any)._agyTimeoutMs) > 0 ? Number((config as any)._agyTimeoutMs) : agyReplyTimeoutMs());
    // 14/10: 300s → 420s (llm-route-policy.ts), sàn 300s; caller có trần cứng (header x-agy-timeout-ms) được rút ngắn.

    child.stdout?.setEncoding("utf8");
    child.stdout.on('data', (chunk: Buffer) => {
      streamEvents.emit('agent:chunk', { agentSlug: config.slug, streamKey, chunk: chunk.toString('utf-8') });
    });
    child.stderr?.setEncoding("utf8");
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });

    child.on('close', async (code) => {
      clearTimeout(timeout);
      try { rmSync(promptFile, { force: true }); } catch {}
      // Đã reject vì timeout (fallback claude có thể đang chạy) → KHÔNG dò brain/ghi đè
      // _agent_session_id/emit agent:done bằng fallback_message của agy.
      if (timedOut) {
        streamEvents.emit('agent:error', { agentSlug: config.slug, streamKey, error: 'antigravity timeout' });
        return;
      }

      let reply = '';
      try {
        // Windows TTY trap + agy auto-brain: agy may IGNORE the --conversation id
        // and create its own brain, so scan brains by THIS run's turnMarker (unique
        // temp-prompt filename) to find the real brain + reply (poll-retry for flush).
        const t = await findAntigravityReplyByTurnMarker(promptFileName);
        reply = (t.reply || '').trim();

        // Reply-envelope contract (2026-08-11): keep only the customer message.
        reply = extractEnvelopedReply(reply);

        // Leak-guard: never return injected system context to a customer.
        if (reply && agyLooksLikeLeak(reply)) {
          console.error(`[Router] Antigravity ${config.slug}: REFUSED system-context leak in reply.`);
          reply = '';
        }

        if (!reply) {
          console.warn(`[Router] Antigravity ${config.slug}: empty reply (exit ${code}). stderr=${stderr.substring(0, 200)}`);
          reply = ''; // 03/10: KHÔNG câu đệm — rỗng = consumer im lặng + báo người (gem-master: edge chuyển dự phòng)
        }

        // 22/10/2026 chị Jennie: KHÔNG đổi model/provider khi agy hết credits/quota — chỉ đường agy local,
        // để lỗi nguyên (reject → caller trả rỗng → edge chốt câu quá tải). Đã gỡ chuỗi model (GEM-1241).
        // 26/10/2026 (AGY-SW-002): Cho phép tự động xoay sang tài khoản Google khác trong kho Antigravity
        // (giữ nguyên 100% `model`) tối đa 1 lần nếu lượt đầu phát hiện lỗi quota trong < 25s.
        if (!reply && shouldAntigravityFallback({ stderr })) {
          const elapsedMs = Date.now() - attemptStartedAtMs;
          if (!_accountRotated && elapsedMs < 25_000) {
            const rot = await rotateAntigravityAccountOnQuota({
              failedEmail: attemptAccountEmail,
              stderr,
              runId: streamKey,
              cwd: PROJECT_ROOT,
            });
            if (rot.rotated) {
              console.warn(
                `[Router/antigravity] ${config.slug}: tài khoản "${rot.previousEmail ?? 'active'}" hết quota (${rot.limitType ?? '5h'}) → đã tự động xoay sang "${rot.newEmail}" (${rot.label ?? 'pool'}) và chạy lại 1 lần trên cùng model "${model}".`,
              );
              try {
                const retryReply = await runViaAntigravity(
                  config,
                  systemPrompt,
                  history,
                  message,
                  sessionKey,
                  signal,
                  true,
                );
                resolve(retryReply);
              } catch (retryErr) {
                reject(retryErr);
              }
              return;
            }
          }
          console.warn(`[Router/antigravity] ${config.slug}: agy hết credits/quota → KHÔNG fallback, để lỗi nguyên`);
          streamEvents.emit('agent:error', { agentSlug: config.slug, streamKey, error: 'antigravity quota: hết credits/quota (không fallback)' });
          reject(new ProviderQuotaError('antigravity', 'Antigravity', config.slug));
          return;
        }

        // agy thoát lỗi mà không có reply (14/10: ~3% lượt) → báo lỗi nguyên (22/10: không đổi provider).
        if (isAgyCrashEmpty(reply, code, !!signal?.aborted)) {
          streamEvents.emit('agent:error', { agentSlug: config.slug, streamKey, error: `antigravity exit ${code}, no reply` });
          reject(new ProviderCrashError('antigravity', 'Antigravity', config.slug, code));
          return;
        }

        // Expose the brain id via side-channel (mirrors runViaClaude/Gemini).
        (config as any)._agent_session_id = conversationId;
        console.log(`[Router/antigravity] ${config.slug}: reply ${reply.length} chars`);

        // NOTE: post-processing (scrub + [[SEND_MEDIA]]/[[ESCALATE]] markers)
        // HOISTED to runAgentWithConfig (Reply Gateway P1) — returns RAW reply
        // here, do NOT scrub in this fn.
      } catch (parseErr) {
        console.warn(`[Router/antigravity] ${config.slug}: parse failed`, parseErr);
        reply = ''; // 03/10: KHÔNG câu đệm — rỗng = consumer im lặng + báo người (gem-master: edge chuyển dự phòng)
      }

      try {
        await supabase.rpc('increment_agent_usage', {
          p_slug: config.slug, p_input: 0, p_output: 0, p_cost: 0, p_duration: 0,
        });
      } catch { /* ignore usage tracking errors */ }

      streamEvents.emit('agent:done', { agentSlug: config.slug, streamKey, reply });
      resolve(reply);
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Run via OpenRouter API (fetch).
 * Uses OPENROUTER_API_KEY from env.
 */
async function runViaOpenRouter(
  config: AgentConfig,
  systemPrompt: string,
  history: SessionMessage[],
  message: string,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new AgentAbortedError();
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY not set');
  }

  const messages: Array<{ role: string; content: string }> = [];

  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  // Add history
  for (const entry of history) {
    messages.push({
      role: entry.role === 'assistant' ? 'assistant' : 'user',
      content: entry.content,
    });
  }

  // Add current message
  messages.push({ role: 'user', content: message });

  // Timeout ⇒ ProviderTimeoutError (không phải AbortError trần) để withTimeoutFallback chuyển provider (GEM-1085).
  return withApiTimeout('openrouter', 'OpenRouter', config.slug, AGENT_TIMEOUT_MS, signal, () => new AgentAbortedError(), async (fetchSignal) => {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://gemral.com',
        'X-Title': 'Paperclip Agent',
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: config.temperature,
        max_tokens: config.max_tokens,
      }),
      signal: fetchSignal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenRouter API error ${res.status}: ${body}`);
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    return data.choices?.[0]?.message?.content?.trim() || '';
  });
}

/**
 * Resolve a MediaFile to base64 (with mime sniffing).
 * Accepts either a remote URL or a local filesystem path.
 * Caps payload at 20 MB to avoid OOM.
 *
 * Returns null if download/read fails — caller should fall back to text-only.
 */
async function resolveMediaToBase64(media: {
  url?: string;
  path?: string;
  mimeType?: string;
}): Promise<{ base64: string; mimeType: string } | null> {
  const MAX_BYTES = 20 * 1024 * 1024;
  try {
    let buffer: Buffer | null = null;

    if (media.url) {
      const res = await fetch(media.url);
      if (!res.ok) {
        console.warn(`[Router/media] fetch ${media.url} → ${res.status}`);
        return null;
      }
      const arr = await res.arrayBuffer();
      if (arr.byteLength > MAX_BYTES) {
        console.warn(`[Router/media] ${media.url} too large: ${arr.byteLength} bytes`);
        return null;
      }
      buffer = Buffer.from(arr);
    } else if (media.path && existsSync(media.path)) {
      const data = readFileSync(media.path);
      if (data.length > MAX_BYTES) {
        console.warn(`[Router/media] ${media.path} too large: ${data.length} bytes`);
        return null;
      }
      buffer = data;
    }

    if (!buffer) return null;
    return {
      base64: buffer.toString('base64'),
      mimeType: media.mimeType || 'application/octet-stream',
    };
  } catch (err: any) {
    console.warn(`[Router/media] resolve failed:`, err.message);
    return null;
  }
}

// ─── Training log injection (Sprint B4) ──────────────────────────────────────

const trainingLogCache = new Map<string, { content: string; expiresAt: number }>();

/**
 * Load agents/{slug}/training-log.md and return the LAST N entries as a
 * compact in-context-learning section for the system prompt.
 *
 * Each "entry" is delimited by `---` lines (appended by training-reviewer.ts).
 * We keep only the latest 30 entries to avoid context bloat.
 */
function loadTrainingLogForPrompt(agentSlug: string): string {
  const cached = trainingLogCache.get(agentSlug);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.content;
  }

  const logPath = pathResolve(PROJECT_ROOT, 'agents', agentSlug, 'training-log.md');
  let content = '';

  // Quality filter: skip entries where overall score is below threshold
  // (default 30/100). These are usually infra-failure sessions where the
  // agent never spoke — their lessons are about the infra, not the agent.
  const QUALITY_THRESHOLD = Number(process.env.PAPERCLIP_TRAINING_LOG_MIN_SCORE || 30);
  // Limit how many lessons to inject (avoid context bloat)
  const MAX_INJECT = Number(process.env.PAPERCLIP_TRAINING_LOG_MAX_INJECT || 10);

  if (existsSync(logPath)) {
    try {
      const raw = readFileSync(logPath, 'utf-8');
      // Split by `---` separator (keep only blocks with `## ` session header)
      const blocks = raw
        .split(/^---$/m)
        .map((b) => b.trim())
        .filter((b) => b.length > 0 && /^##\s+\d{4}-/m.test(b));

      // Quality filter: parse `**Overall score**: N/100` from each block
      const scoreRe = /\*\*Overall score\*\*:\s*(\d+)\/100/i;
      const qualityBlocks = blocks.filter((b) => {
        const m = b.match(scoreRe);
        if (!m) return true; // unknown score → keep (legacy entries)
        return Number(m[1]) >= QUALITY_THRESHOLD;
      });

      // Sort by recency (last entries are most recent, append-only file)
      const recent = qualityBlocks.slice(-MAX_INJECT);

      if (recent.length > 0) {
        content = [
          '',
          '═══ TRAINING FEEDBACK — Bài học từ các training round trước ═══',
          '',
          `Bạn đã được CEO + Opus 4.6 review qua các session trước. Dưới đây là`,
          `${recent.length} bài học chất lượng (score ≥ ${QUALITY_THRESHOLD}/100) bạn PHẢI áp dụng:`,
          '',
          ...recent,
          '',
          '═══════════════════════════════════════════════════',
        ].join('\n');
      }

      // Diagnostic: log how many were filtered (one-time per cache cycle)
      const filtered = blocks.length - qualityBlocks.length;
      if (filtered > 0) {
        console.log(
          `[Router/training-log] ${agentSlug}: filtered ${filtered}/${blocks.length} low-quality entries (score < ${QUALITY_THRESHOLD}), inject ${recent.length}`,
        );
      }
    } catch (err: any) {
      console.warn(`[Router/training-log] Failed to read ${logPath}: ${err.message}`);
    }
  }

  trainingLogCache.set(agentSlug, { content, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS });
  return content;
}

// ─── Granted skills loader (per-agent, from skills-store + skill_grants) ─────

/**
 * Cache loaded skill SKILL.md content by agent slug. TTL 60s.
 * The cache value is the FULL prompt-ready string with all granted skills
 * joined and headed by section markers.
 */
const grantedSkillsCache = new Map<string, { content: string; expiresAt: number }>();

/**
 * Load all skills granted to this agent from skill_grants table, then read
 * each SKILL.md from skills-store/<name>/<version>.<minor>.<patch>/SKILL.md
 * and concatenate into a single prompt-ready block.
 *
 * The version directory is resolved by listing the skill folder and picking
 * the highest version directory (semver-sorted). This avoids hardcoding
 * "1.0.0" so future skill upgrades flow through automatically.
 *
 * Returns empty string if agent has no grants or skills-store missing.
 */
async function loadGrantedSkillsForPrompt(agentSlug: string): Promise<string> {
  const cached = grantedSkillsCache.get(agentSlug);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.content;
  }

  let content = '';
  try {
    // Query skill_grants joined with skills to get name + file_path
    const { data: grants, error } = await supabase
      .from('skill_grants')
      .select('skill_id, skills:skill_id(name, display_name, file_path, current_version)')
      .eq('grantee_type', 'agent')
      .eq('grantee_id', agentSlug)
      .eq('permission', 'read');

    if (error || !grants || grants.length === 0) {
      grantedSkillsCache.set(agentSlug, { content: '', expiresAt: Date.now() + CONFIG_CACHE_TTL_MS });
      return '';
    }

    const skillBlocks: string[] = [];
    for (const g of grants) {
      const skill = (g as any).skills as
        | { name: string; display_name: string; file_path: string; current_version: number }
        | null;
      if (!skill || !skill.name) continue;

      // Resolve the SKILL.md path. Prefer the file_path stored in DB; fall
      // back to scanning skills-store/<name>/ for the highest semver dir.
      let skillMdAbsPath: string | null = null;

      if (skill.file_path) {
        const candidate = pathResolve(PROJECT_ROOT, skill.file_path);
        if (existsSync(candidate)) {
          skillMdAbsPath = candidate;
        }
      }

      if (!skillMdAbsPath) {
        const skillDir = pathResolve(SKILLS_STORE, skill.name);
        if (existsSync(skillDir)) {
          try {
            const versions = readdirSyncFS(skillDir).filter((entry) => /^\d+\.\d+\.\d+$/.test(entry));
            // Pick the highest version (semver sort)
            versions.sort((a, b) => {
              const pa = a.split('.').map(Number);
              const pb = b.split('.').map(Number);
              for (let i = 0; i < 3; i++) {
                if (pa[i] !== pb[i]) return pb[i] - pa[i];
              }
              return 0;
            });
            if (versions[0]) {
              const candidate = pathResolve(skillDir, versions[0], 'SKILL.md');
              if (existsSync(candidate)) skillMdAbsPath = candidate;
            }
          } catch {
            /* skip */
          }
        }
      }

      if (!skillMdAbsPath) {
        console.warn(`[Router/skills] ${agentSlug} grant for "${skill.name}" — SKILL.md not found`);
        continue;
      }

      try {
        const raw = readFileSync(skillMdAbsPath, 'utf-8');
        // Strip YAML frontmatter (between leading --- and next ---) so the
        // prompt only carries the body. Frontmatter is for metadata loaders.
        const stripped = raw.replace(/^---[\s\S]*?---\s*/m, '').trim();
        skillBlocks.push(
          [
            '',
            `### SKILL: ${skill.display_name || skill.name}`,
            '',
            stripped,
            '',
            '─────────────────────────────────────────────',
          ].join('\n'),
        );
      } catch (err: any) {
        console.warn(`[Router/skills] Failed to read ${skillMdAbsPath}: ${err.message}`);
      }
    }

    if (skillBlocks.length > 0) {
      content = [
        '',
        '═══ GRANTED SKILLS — Procedural knowledge bạn có quyền dùng ═══',
        '',
        `Bạn đã được grant ${skillBlocks.length} skill dưới đây. Mỗi skill là 1 procedural`,
        'guide cho 1 loại tình huống (sales conversation, identity verify, escalation, ...).',
        'Áp dụng skill phù hợp dựa trên trigger phrase trong mỗi skill description.',
        ...skillBlocks,
        '═══════════════════════════════════════════════════',
      ].join('\n');
      console.log(`[Router/skills] ${agentSlug}: loaded ${skillBlocks.length} granted skills`);
    }
  } catch (err: any) {
    console.warn(`[Router/skills] loadGrantedSkillsForPrompt failed for ${agentSlug}: ${err.message}`);
  }

  grantedSkillsCache.set(agentSlug, { content, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS });
  return content;
}

// ─── Outbound media library (per-agent JSON) ─────────────────────────────────

/**
 * Cache parsed media libraries by agent slug. TTL 60s — same as configCache.
 */
const mediaLibraryCache = new Map<string, { lib: MediaLibrary | null; expiresAt: number }>();

/**
 * Thương hiệu agent xưng trong luật chat (14/10, plan CSKH-SPLIT §3 bước 3). Trước đây gắn cứng "của Gemral"
 * → yinyang-support trên web Yinyang tự xưng Gemral. Agent không có trong bảng = Gemral như cũ.
 */
const AGENT_BRAND: Readonly<Record<string, string>> = {
  'yinyang-support': 'Yin Yang Masters',
  'edge-sales-closer': 'Gemral Edge',
  // 14/10 (EC-084): bubble jennie.yinyangmasters.com + inbox Page Jennie — team của thương hiệu cá nhân, KHÔNG bán hàng.
  'jennie-support': 'Jennie Uyên Chu',
};
export function agentBrand(slug: string | undefined): string {
  return (slug && AGENT_BRAND[slug]) || 'Gemral';
}

/**
 * Agent CSKH gửi ảnh sản phẩm đọc THẲNG product-catalog-index.json (Option A). yinyang-support
 * (14/10, plan CSKH-SPLIT §3 bước 3) cần ảnh crystal y như sales-closer — thiếu thì [[SEND_MEDIA]] câm.
 */
export const CATALOG_MEDIA_AGENTS: ReadonlyMap<string, ReadonlySet<string> | null> = new Map([
  // 14/10 (EC-054): sales-closer chỉ còn kênh VN — KHÔNG gửi ảnh Edge/Scanner (edge-sales-closer lo). Allow-list
  // = mọi type catalog TRỪ edge/scanner (thêm type mới vào catalog ⇒ nhớ thêm vào đây).
  ['sales-closer', new Set(['crystal', 'crystal-category', 'course', 'gem-pack', 'brand-asset', 'media-guide',
                            'lead-magnet', 'chatbot', 'affiliate', 'digital-tool'])],
  ['yinyang-support', new Set(['crystal', 'crystal-category'])],
]);

/**
 * Load agents/{slug}/media-library.json — list of files this agent can SEND
 * to users (PDFs, images, videos). Returns null if file missing.
 *
 * Cached 60s.
 */
export function loadMediaLibrary(agentSlug: string): MediaLibrary | null {
  const cached = mediaLibraryCache.get(agentSlug);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.lib;
  }

  const projectRoot = PROJECT_ROOT;
  let lib: MediaLibrary | null = null;

  if (CATALOG_MEDIA_AGENTS.has(agentSlug)) {
    // Option A (OD-1, plan §5.1): đọc THẲNG product-catalog-index.json + transform-on-read (derive
    // tags TS khớp Python — parity gate §6.1). Chỉ sales-closer; agent khác giữ đường file cũ.
    lib = loadSalesCloserMediaFromCatalog(projectRoot, agentSlug, CATALOG_MEDIA_AGENTS.get(agentSlug) ?? null);
    if (lib) {
      console.log(`[Router/media] ${agentSlug}: loaded ${lib.items.length} item từ catalog (Option A)`);
    } else {
      // Catalog thiếu/hỏng (mount lệch, ghi lỗi, PROJECT_ROOT sai) → KHÔNG để sales-closer câm media.
      // Fallback agents/sales-closer/media-library.json (sync-generated, giữ sống cho social-posting)
      // + cảnh báo TO cho người trực (Codex P5-R1 [high]: đừng cache null im lặng). Dữ liệu fallback
      // có thể CŨ hơn catalog nhưng "có ảnh cũ" > "câm hoàn toàn".
      const fbPath = pathResolve(projectRoot, 'agents', agentSlug, 'media-library.json');
      console.error(
        `[Router/media] ⚠️ ${agentSlug} CATALOG LOAD FAILED → fallback ${fbPath} (dữ liệu có thể CŨ). ` +
        `Kiểm PROJECT_ROOT + product-catalog-index.json NGAY.`,
      );
      if (existsSync(fbPath)) {
        try {
          lib = JSON.parse(readFileSync(fbPath, 'utf-8')) as MediaLibrary;
          console.error(`[Router/media] fallback OK: ${lib?.items?.length ?? 0} item từ media-library.json cũ`);
        } catch (err: any) {
          console.error(`[Router/media] ⚠️ fallback media-library.json CŨNG lỗi parse: ${err.message} — sales-closer sẽ KHÔNG có media tới khi sửa`);
        }
      } else {
        console.error(`[Router/media] ⚠️ fallback media-library.json KHÔNG tồn tại — sales-closer KHÔNG có media`);
      }
    }
  } else {
    const libPath = pathResolve(projectRoot, 'agents', agentSlug, 'media-library.json');
    if (existsSync(libPath)) {
      try {
        const raw = readFileSync(libPath, 'utf-8');
        lib = JSON.parse(raw) as MediaLibrary;
      } catch (err: any) {
        console.warn(`[Router/media] Failed to parse ${libPath}:`, err.message);
      }
    }
  }

  mediaLibraryCache.set(agentSlug, { lib, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS });
  return lib;
}

/**
 * Render the media library as a compact catalog for system prompt injection.
 * Each item is one line with id + name + tags so Gemma can pick by id.
 */
function renderMediaLibraryForPrompt(lib: MediaLibrary): string {
  if (!lib || !lib.items || lib.items.length === 0) return '';
  const lines = lib.items.map((it) => {
    const tags = (it.tags || []).join(', ');
    return `- [[SEND_MEDIA: ${it.id}]] — ${it.name} (${it.type}) — ${it.description}${tags ? ` [tags: ${tags}]` : ''}`;
  });
  const instructions = lib.instructions_for_agent || '';
  return [
    '',
    '═══ MEDIA LIBRARY — File/ảnh/video bạn có thể GỬI cho khách ═══',
    instructions,
    '',
    '✅ ĐƯỢC PHÉP — Cú pháp duy nhất:',
    '   [[SEND_MEDIA: id]]   ← chỉ dùng id có trong danh sách bên dưới',
    '   Khi gửi ảnh SẢN PHẨM: 1 marker là đủ — hệ thống tự đính kèm NHIỀU ảnh KHÁC NHAU',
    '   của sản phẩm đó (ít nhất 2 ảnh) để khách có nhiều góc lựa chọn. KHÔNG lặp lại',
    '   cùng 1 id nhiều lần.',
    '',
    '🚫 TUYỆT ĐỐI KHÔNG ĐƯỢC:',
    '   - KHÔNG bịa các marker khác như [[CALL: ...]], [[FUNCTION: ...]],',
    '     [[TICKET: ...]], [[QUERY: ...]], [[API: ...]] — bạn KHÔNG có',
    '     bất kỳ tool nào khác ngoài SEND_MEDIA. Mọi marker không thuộc',
    '     danh sách bên dưới sẽ bị strip và KHÁCH SẼ THẤY bạn bịa.',
    '   - KHÔNG bịa id media không có trong danh sách (vd [[SEND_MEDIA:',
    '     non_existent_file]]) — sẽ bị xoá silent.',
    '   - KHÔNG dùng SEND_MEDIA id chỉ vì câu hỏi nghe có vẻ liên quan;',
    '     chỉ dùng khi item TRONG danh sách thực sự khớp ý khách.',
    '',
    '📋 KHI BẠN KHÔNG CÓ THÔNG TIN HOẶC CÔNG CỤ ĐỂ TRẢ LỜI:',
    '   - KHÔNG giả vờ tạo ticket, không bịa "em sẽ chuyển team".',
    '   - Nói THẲNG, tự nhiên, bằng ngôn ngữ khách đang dùng: "Em chưa tra được',
    '     phần này ngay, để em kiểm tra với team hỗ trợ rồi cập nhật lại',
    '     cho chị sớm nhất nhé." (Hệ thống có người theo dõi inbox sẽ',
    '     escalate; bạn KHÔNG cần — và KHÔNG ĐƯỢC — output bất kỳ marker',
    '     command nào.)',
    '',
    'Danh sách media available (CHỈ dùng id trong list này):',
    ...lines,
    '═══════════════════════════════════════════════════',
  ].join('\n');
}

/**
 * Parse [[SEND_MEDIA: id]] markers out of a reply text.
 * Returns the cleaned text + the list of resolved MediaFile objects.
 *
 * Markers that don't match a library id are silently dropped (logged warning).
 */
/**
 * Per-chunk message piece used for the multi-message reply pattern.
 * The agent splits its reply with [[MSG_BREAK]] markers; each chunk is sent
 * as a separate message with a small delay so it feels like a real human typing.
 * Each chunk can carry its own media attachments inline.
 */
export interface MessageChunk {
  text: string;
  media?: MediaFile[];
}

/** Strip Vietnamese accents + lowercase for fuzzy product-name matching. */
export function stripAccentsLower(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd').toLowerCase();
}

// Tag values that are generic (không phải danh tính sản phẩm) — bỏ qua khi auto-match.
export const GENERIC_MEDIA_TAGS = new Set([
  'image', 'crystal', 'set', 'pdf', 'video', 'vi', 'stone', 'course', 'trading',
  'feng_shui', 'yinyang_masters', 'starter', 'tier0', 'tier1', 'tier2', 'tier3',
  'wealth', 'love', 'purple', 'pink', 'yellow', 'guide', 'infographic', 'brand',
  'logo', 'demo', 'tool', 'ritual', 'spiritual', 'wellness', 'healing', 'mixed',
  'tien_tai', 'binh_an', 'tinh_yeu', 'bao_ve', 'jennie', 'profile', 'founder',
  'chart', 'education', 'banner', 'promo', 'sale', 'catalog', 'overview',
]);

// Multi-ảnh/sản phẩm (2026-07-16): cap số ảnh gửi cho 1 item/lần (upload bucket tuần tự
// ở CSKH, tránh spam N tin + latency). Áp cho CẢ marker lẫn fallback auto-match.
const MEDIA_MAX_PER_MARKER = 6;
// Per-product image cap when the agent sends product photos: send MULTIPLE different images
// (≥2, up to this cap) so the customer has choices — but not so many it spams Zalo (each
// image is a separate message). OD-1 = 3. (plan CSKH-SALES-CLOSER-BRAIN)
const MEDIA_PRODUCT_IMAGES_MAX = 3;

// Suy mimeType từ đuôi path (all_images là list PATH, mỗi ảnh có thể khác loại) → fallback item.mimeType.
function mimeFromExt(p: string): string | undefined {
  const ext = p.toLowerCase().match(/\.([a-z0-9]+)(?:\?|$)/)?.[1];
  switch (ext) {
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'webp': return 'image/webp';
    case 'gif': return 'image/gif';
    case 'pdf': return 'application/pdf';
    case 'mp4': return 'video/mp4';
    default: return undefined;
  }
}

// SSOT resolve 1 media-library item → N MediaFile (multi-ảnh 2026-07-16). Dùng CHUNG cho
// parseMediaMarkers ([[SEND_MEDIA]]) + autoMatchMediaFromReply (fallback quên marker) → chống
// split-brain. item.all_images (list PATH) → N ảnh (cap); item chỉ url/path (không all_images)
// → 1 MediaFile GIỮ url-only backward-compat (Codex: fallback all_images||[path] rớt url).
export function itemToMediaFiles(item: MediaLibrary['items'][number]): MediaFile[] {
  if (item.all_images && item.all_images.length) {
    const capped = item.all_images.slice(0, MEDIA_PRODUCT_IMAGES_MAX);
    if (item.all_images.length > MEDIA_PRODUCT_IMAGES_MAX) {
      console.log(`[Router/media] capped ${item.all_images.length}→${MEDIA_PRODUCT_IMAGES_MAX} images for id=${item.id}`);
    } else if (item.all_images.length < 2) {
      // Library says <2 images for a product — send what we have (1 is better than 0) but log
      // so the pre-ship media audit (STALE_MULTI) / P-MEDIA2 can flag the under-indexed product.
      console.log(`[Router/media] UNDER_MIN id=${item.id} has only ${item.all_images.length} image(s)`);
    }
    return capped.map((p) => {
      // URL (http/https) → field `url` để channel tự download (zalo channel.ts + cskh
      // resolveMediaToLocalPath cùng logic: path-local-trước, url-download-sau). GÁN URL vào `path`
      // = câm: pathIsAbsolute(URL)=false → resolve rác → existsSync=false → url undefined → bỏ ảnh
      // (18/134 catalog entry có URL, 4 entry toàn-URL mất sạch ảnh). Plan §Deviations D-2 / §5.1 đ4.
      const isUrl = /^https?:\/\//i.test(p);
      return {
        path: isUrl ? undefined : p,
        url: isUrl ? p : undefined,
        mimeType: mimeFromExt(p) || item.mimeType,
        filename: item.name,
        caption: item.description,
      };
    });
  }
  return [{
    url: item.url || undefined,
    path: item.path || undefined,
    mimeType: item.mimeType,
    filename: item.name,
    caption: item.description,
  }];
}

/**
 * FALLBACK auto-media (2026-07-01): agy/Gemini Flash hay HỨA gửi ảnh trong prose
 * ("Em gửi bạn xem hình ảnh…") mà KHÔNG emit `[[SEND_MEDIA: id]]` → khách không
 * nhận ảnh, agent tưởng đã gửi (silent). Khi reply hứa media + 0 marker → match
 * media theo TÊN sản phẩm/set (tag danh-tính) xuất hiện trong reply → đính kèm.
 * Precise: chỉ match tag ≥6 ký tự, không generic; cap tổng MEDIA_MAX_PER_MARKER.
 */
export function autoMatchMediaFromReply(text: string, lib: MediaLibrary | null): MediaFile[] {
  if (!lib?.items?.length || !text) return [];
  const PROMISE_RE = /(g[uử]i|xem|đính\s*kèm|k[eè]m)[\s\S]{0,30}(h[ìi]nh|ảnh|photo|catalog|b[ải]ng\s*gi[áa]|file)/i;
  if (!PROMISE_RE.test(text)) return [];

  const norm = stripAccentsLower(text);
  const scored: { item: MediaLibrary['items'][number]; keyLen: number }[] = [];
  for (const it of lib.items) {
    let best = 0;
    for (const tag of it.tags || []) {
      if (GENERIC_MEDIA_TAGS.has(tag)) continue;
      const phrase = stripAccentsLower(tag.replace(/_/g, ' ').trim());
      if (phrase.length >= 6 && norm.includes(phrase)) best = Math.max(best, phrase.length);
    }
    if (best > 0) scored.push({ item: it, keyLen: best });
  }
  scored.sort((a, b) => b.keyLen - a.keyLen); // ưu tiên khớp cụ thể nhất
  const picked: MediaFile[] = [];
  const seen = new Set<string>();
  for (const s of scored) {
    if (seen.has(s.item.id)) continue;
    seen.add(s.item.id);
    picked.push(...itemToMediaFiles(s.item)); // multi-ảnh: item → N MediaFile (helper chung)
    if (picked.length >= MEDIA_MAX_PER_MARKER) break; // cap TỔNG media, KHÔNG phải số item (Codex R2)
  }
  return picked.slice(0, MEDIA_MAX_PER_MARKER); // item cuối có thể đẩy vượt → cắt tổng
}

/**
 * Strip INTERNAL agent markers (e.g. `[[CALL: crm_update(...)]]`) from a reply while
 * PRESERVING the two markers the pipeline consumes (`[[SEND_MEDIA:...]]`, `[[MSG_BREAK]]`)
 * AND genuine customer double-brackets (`[[bao nhiêu]]`, `[[3,4]]`). Must run on the
 * WHOLE text BEFORE the MSG_BREAK split so a marker can't be severed across chunks and
 * leak its tail — that severing was the root cause of the `..., lifecycle_stage="consideration")]]`
 * leak (2026-07-10 fix, Codex-reviewed). NOT a blanket `[[...]]` strip.
 */
export function stripInternalMarkers(text: string): string {
  return text.replace(/\[\[[\s\S]*?\]\]/g, (m) => {
    if (/\bSEND_MEDIA\b/i.test(m) || /\bMSG_BREAK\b/i.test(m)) return m; // preserve real markers
    const markerLike =
      /\[\[\s*(CALL|FUNCTION|TOOL|TICKET|QUERY|API|MCP[_A-Z]*|SET_STAGE|CRM_UPDATE|UPDATE|ESCALATE)\b/i.test(m) ||
      /\[\[\s*[A-Z_]{3,}\s*:/.test(m) ||          // uppercase keyword + colon (invented markers)
      /[a-z_]+\s*=\s*"[^"]*"/i.test(m);           // key="value" args (CALL-style)
    return markerLike ? '' : m;                    // keep genuine customer [[...]]
  });
}

/**
 * Defensive cleanup for an ORPHANED marker fragment left when a marker was severed
 * before this ran (e.g. a leading `..., key="val")]]` tail, or a trailing unclosed
 * `[[CALL ...`). BOUNDED — only marker-like fragments; never a blanket `]]` / `[[`
 * removal, so ordinary customer text (`mảng [1,2]`, a stray `]]`) survives.
 */
function stripOrphanMarkerFragments(text: string): string {
  return text
    // leading severed CALL-arg tail: `[…]key="value"[)]]]` at the start of a line/chunk
    .replace(/^\s*[^\n[]*?[a-z_]+\s*=\s*"[^"]*"\s*\)?\s*\]\]/gim, '')
    // trailing unclosed internal marker opener (not SEND_MEDIA/MSG_BREAK)
    .replace(/\[\[\s*(?!SEND_MEDIA|MSG_BREAK)(?:CALL|FUNCTION|TOOL|TICKET|QUERY|API|MCP[_A-Z]*|[A-Z_]{3,}\s*:)[^\]]*$/g, '')
    .trim();
}

async function parseMediaMarkers(
  text: string,
  lib: MediaLibrary | null,
): Promise<{ cleanedText: string; media: MediaFile[]; chunks: MessageChunk[] }> {
  if (!text) return { cleanedText: text, media: [], chunks: [{ text }] };

  // ── Step 0 (2026-07-10): strip internal markers on the WHOLE text FIRST ──
  // Removing full `[[CALL: ...]]` markers before the MSG_BREAK split prevents a
  // marker from being severed across chunks (root cause of the leaked tail).
  // Genuine customer [[...]] and the SEND_MEDIA/MSG_BREAK markers are preserved.
  const preSplit = stripInternalMarkers(text);

  // ── Step 1: Split into chat messages ──
  // [[MSG_BREAK]] + blank-line paragraphs + long paragraphs cut to ≤2 sentences
  // (14/10: agents ignored MSG_BREAK and sent one long block). Media markers stay with their chunk.
  const rawChunks = splitIntoHumanMessages(preSplit);

  const allMedia: MediaFile[] = [];
  const seenGlobal = new Set<string>();
  const chunks: MessageChunk[] = [];

  // Match [[SEND_MEDIA: some_id]] (with or without spaces, case-insensitive)
  const SEND_MEDIA_RE = /\[\[\s*SEND_MEDIA\s*:\s*([a-zA-Z0-9_\-]+)\s*\]\]/gi;

  for (const rawChunk of rawChunks) {
    const chunkMedia: MediaFile[] = [];
    let chunkText = rawChunk;

    // Step 2a: extract SEND_MEDIA markers from THIS chunk
    const matches = Array.from(chunkText.matchAll(SEND_MEDIA_RE));
    for (const match of matches) {
      const fullMatch = match[0];
      const id = match[1];

      // Multi-ảnh (2026-07-16): 1 marker → N MediaFile (item.all_images) qua helper chung.
      let mediaFiles: MediaFile[] = [];

      // 1. Local static library lookup
      if (lib) {
        const item = lib.items.find((x) => x.id === id);
        if (item) mediaFiles = itemToMediaFiles(item);
      }

      // 2. Supabase DB lookup if UUID format (single asset — marketing_assets 1 file/id)
      if (mediaFiles.length === 0 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        try {
          const { data, error } = await supabase
            .from('marketing_assets')
            .select('id, title, description, file_path, type')
            .eq('id', id)
            .single();

          if (data && !error && data.file_path) {
            mediaFiles = [{
              path: pathJoin(PROJECT_ROOT, data.file_path),
              mimeType: data.type === 'video' ? 'video/mp4' : (data.type === 'document' ? 'application/pdf' : 'image/jpeg'),
              filename: data.file_path.split('/').pop() || 'media',
              caption: [data.title, data.description].filter(Boolean).join('\n'),
            }];
          }
        } catch (e) {
          console.error(`[Router/media] Supabase query failed for ${id}:`, e);
        }
      }

      if (mediaFiles.length === 0) {
        console.warn(`[Router/media] Marker [[SEND_MEDIA: ${id}]] — id not found in library or DB`);
        chunkText = chunkText.replace(fullMatch, '');
        continue;
      }

      // Dedup theo id (1 marker = 1 set, kể cả agent emit id 2 lần) → push CẢ N ảnh.
      if (!seenGlobal.has(id)) {
        seenGlobal.add(id);
        for (const mf of mediaFiles) { chunkMedia.push(mf); allMedia.push(mf); }
      }

      chunkText = chunkText.replace(fullMatch, '');
    }

    // Step 2b: defensive orphan-fragment cleanup (BOUNDED — internal markers were
    // already stripped whole at Step 0, so this only catches a severed tail that
    // somehow survived; it never blanket-strips [[...]] or ]] from customer text).
    const before = chunkText;
    chunkText = stripOrphanMarkerFragments(chunkText);
    if (before !== chunkText) {
      console.warn(`[Router/media] Stripped orphan marker fragment from chunk`);
    }

    // Step 2c: tidy whitespace
    const tidied = chunkText
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/ +\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // Skip empty chunks (e.g. consecutive [[MSG_BREAK]][[MSG_BREAK]] or
    // a chunk that contained only a media marker — media is preserved on
    // the next non-empty chunk).
    if (!tidied && chunkMedia.length === 0) continue;

    chunks.push({
      text: tidied,
      ...(chunkMedia.length > 0 ? { media: chunkMedia } : {}),
    });
  }

  // If splitting produced no usable chunks (e.g. agent only emitted markers),
  // return at least one empty chunk so consumer.ts has something to send.
  if (chunks.length === 0) {
    chunks.push({ text: '' });
  }

  // ── FALLBACK auto-media: agent hứa gửi ảnh trong prose nhưng KHÔNG emit marker
  // (agy/Gemini Flash hay quên) → match media theo tên sản phẩm/set → đính kèm.
  // Logged (KHÔNG silent) để verify được. Chỉ chạy khi 0 marker nào resolve.
  if (allMedia.length === 0) {
    const auto = autoMatchMediaFromReply(text, lib);
    if (auto.length > 0) {
      console.log(
        `[Router/media] FALLBACK auto-attached ${auto.length} media (agent hứa ảnh nhưng KHÔNG emit marker): ${auto.map((m) => m.filename).join(', ')}`,
      );
      for (const m of auto) allMedia.push(m);
      const lastChunk = [...chunks].reverse().find((c) => c.text) || chunks[chunks.length - 1];
      if (lastChunk) lastChunk.media = [...(lastChunk.media || []), ...auto];
    }
  }

  // Backward-compat: cleanedText is the chunks joined by double newlines.
  // Existing call sites that don't yet support multi-message will still get
  // a sensible single string.
  const cleanedText = chunks.map((c) => c.text).filter(Boolean).join('\n\n');

  return { cleanedText, media: allMedia, chunks };
}

// ─── Provider-agnostic helpers (used by all providers: Claude, Gemini, etc.) ─

/**
 * Build a provider-neutral override block that gets appended to the agent's
 * base system prompt. It overrides any legacy `[[CALL: name(args)]]` marker
 * instructions (which were designed for non-native-tool LLMs) and teaches
 * the agent how to send media via `[[SEND_MEDIA: id]]` markers.
 *
 * Works for ANY provider with native MCP tool support (Claude, Gemini, etc.).
 */
function buildProviderOverride(agentSlug: string, mediaLib: MediaLibrary | null): string {
  const mediaCatalog = mediaLib ? renderMediaLibraryForPrompt(mediaLib) : '';
  return [
    '',
    '# ⚠️ NATIVE TOOL USE + MEDIA (OVERRIDE TOOLS.md / HEARTBEAT.md)',
    '',
    'Bạn đang chạy với NATIVE MCP tools (qua mcp.json).',
    'CÁC HƯỚNG DẪN VỀ `[[CALL: name(args)]]` MARKER TRONG TOOLS.md/HEARTBEAT.md',
    'ĐÃ LỖI THỜI — chúng chỉ dành cho LLMs không có native tool support.',
    '',
    'Quy tắc (BẮT BUỘC — override mọi instruction trước đó):',
    '1. GỌI tool qua MCP protocol native — runtime tự xử lý tool call & result.',
    '2. TUYỆT ĐỐI KHÔNG viết `[[CALL: ...]]`, `[CALL: ...]`, `[MCP_...]`,',
    '   `[SEARCH: ...]`, `[TOOL: ...]`, `[FUNCTION: ...]` ra text reply cho khách.',
    '3. Tool call & result SILENT — khách chỉ thấy câu trả lời cuối cùng.',
    '4. Reply cho khách là TEXT THUẦN, không markdown, không bullet đặc biệt.',
    '5. KHÔNG xin số điện thoại để gửi qua Zalo/Facebook — khách ĐÃ nhắn trực tiếp',
    '   qua kênh đó rồi, gửi TRỰC TIẾP trong tin nhắn này.',
    '',
    '# 📸 GỬI HÌNH / FILE / VIDEO CHO KHÁCH',
    '',
    'Cách gửi file/hình/video: chèn marker `[[SEND_MEDIA: id]]` vào text reply.',
    'Marker sẽ được router parse và gửi file kèm tin nhắn cho khách.',
    'CHỈ dùng id có trong danh sách bên dưới. KHÔNG bịa id.',
    '',
    mediaCatalog || `(Agent "${agentSlug}" chưa có media library — chỉ reply text)`,
    '',
  ].join('\n');
}

/**
 * Post-process LLM reply before sending to customer. Runs across ALL providers:
 *   1. scrubBannedPhrases — strips owner name, short-time promise, tool markers,
 *      special chars, markdown, Insight blocks, internal system mentions.
 *   2. parseMediaMarkers — extracts [[SEND_MEDIA: id]] and sets _outboundMedia
 *      on config so consumer.ts can attach files to the outbound message.
 *
 * Returns the cleaned reply text (without markers, safe to send to customer).
 */
// Trailing self-narration / task-completion leak (2026-06-29). Anchors are tokens that
// NEVER appear in a real Vietnamese customer reply — internal file paths or operator-facing
// self-report phrasings (the project CLAUDE.md "Task Completion Protocol" leaking through a
// provider=claude agent). Used BOTH to strip the block (scrubBannedPhrases Rule 8b) and to
// classify a fully-collapsed reply as benign-silent vs corrupted-escalate (postProcessReply).
// No `g` flag → safe for repeated `.test()`.
const SELF_NARRATION_LEAK_RE =
  /(?:^|\n)[ \t]*[^\n]*?(?:today\.md|docs\/tasksdone|tasksdone|MEMORY\.md|memory\/|evolution-log|active-tasks|CLAUDE\.md|đã đọc xong bối cảnh|soạn (?:lại\s+)?(?:tin nhắn|tin)\s+(?:phản hồi|gửi)|log tiến độ|tạo báo cáo\s+(?:trong|vào))[\s\S]*$/i;

// ── Operator-report leak detector (incident 2026-08-11, gem-master Tarot) ────
// agy obeyed the GLOBAL dev rules (~/.gemini SPEC-LOCK: "print the GIAO KÈO
// table BEFORE working" + "em-chị" reporting tone) inside a customer-reply
// session and sent the customer a full compliance report addressed to the
// operator — the real reply buried in the middle. Detection is STRUCTURAL /
// mechanical first (markdown tables, absolute paths, owner identifiers, UUIDs),
// vocabulary second: the leak vocabulary is open-ended because the rule files
// keep evolving, so single keywords can never be the primary axis.
//
// Corpus-checked 2026-08-11 against ALL history (882 channel_sent_messages +
// 253 cskh assistant rows): 0 false positives on every axis below AFTER masking
// media markers + URLs (legit replies carry [[SEND_MEDIA: C:/...]] local paths
// and supabase-storage URLs containing the project ref + UUIDs — mask them
// before testing, or attachments would refuse-loop).
//
// NO salvage by design (2026-08-01 agent-trace lesson: never salvage a
// corrupted output — the "clean part" of a report can still carry sensitive
// prose that matches no marker). Refuse whole + escalate.
// Plan: crypto docs/plans_reports/2026-08-11-GEM-MASTER-INTERNAL-THOUGHT-LEAK_ARCHITECTURE_PLAN.md
const OPREPORT_STRONG_RES: Array<[string, RegExp]> = [
  ['spec_table', /\|\s*#\s*\|\s*Ràng buộc\s*\||RULE\[user_global\]|agy_reply_[\w-]+\.md|BẢNG GIAO KÈO SPEC-LOCK|ĐO-GATE NGHIỆM THU/i],
  // Absolute Windows paths / dotdirs / repo-relative internal paths never belong in a customer chat.
  ['pathy', /[A-Za-z]:[\\/]Users[\\/]|~[\\/]\.(?:gemini|claude)\b|(?:^|\s)(?:memory|docs|scripts|skills-store)[\\/][\w./-]{3,}/m],
  // Owner identifiers (Telegram chat_id, admin emails, supabase project ref, TG handle).
  ['owner_id', /6486938519|baobao_lawbewbew|jenniechu68@|maow390@|pgfkbcnzqozzkohwbgbk/i],
  // Raw UUIDs (session/user/run ids) — legit ones only ever appear inside URLs, which are masked.
  ['uuid', /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i],
];
// Customer replies are plain text by contract (buildProviderOverride: "TEXT THUẦN,
// không markdown") — ≥2 pipe-table lines is a report table of ANY vocabulary.
const OPREPORT_MDTABLE_RE = /^[ \t]*\|.*\|[^\n]*\n[ \t]*\|.*\|/m;
const OPREPORT_WEAK_RES: RegExp[] = [/SPEC-LOCK/i, /ĐO[- ]GATE/i, /GIAO KÈO/i];
// Pre-scrub reality: the operator greeting reads "chị Jennie" here (scrubBannedPhrases
// rewrites it to "team chuyên môn cấp cao" LATER), so match both forms.
const OPREPORT_ADDR_RE =
  /Em chào\s+(?:chị\s+Jennie|team)\b|(?:gửi|trình|báo cáo)\s+(?:chị|team)[^\n]{0,40}(?:duyệt|kiểm tra|xem lại)|Chị xem[^\n]{0,60}giúp em/i;
// Behavioral pair — self-narrated process + operator-facing deliverable framing.
// Both must hit: a bot never tells the CUSTOMER it is handing content to someone else.
const OPREPORT_PROCESS_RE =
  /\b(?:em|mình)\s+(?:đã|vừa|sẽ)\s+(?:kiểm tra|rà(?:\s*soát)?|đo|chạy|verify|đối chiếu|hoàn thành|làm xong)\b/i;
const OPREPORT_METADELIV_RE =
  /(?:gửi|trình|nhờ)\s+(?:chị|anh|team)\b[^\n]{0,40}(?:nội dung|tin nhắn|kết quả|bảng|duyệt)|nội dung\s+(?:trả lời|gửi)\s+(?:cho\s+)?khách|đủ\s+\d+\s+(?:ràng buộc|yêu cầu|tiêu chí|bước)/i;

/**
 * Returns the matched-axis label when `reply` looks like an internal
 * operator-report leak, or null when clean. Exported for unit tests and for the
 * antigravity envelope extractor (which prefers the last NON-leaky envelope).
 */
export function detectOperatorReportLeak(reply: string): string | null {
  if (!reply) return null;
  // NFC-normalize (NFD output would dodge the Vietnamese patterns), then mask
  // the two legit carriers of paths/UUIDs: media/escalate markers + URLs.
  const masked = reply
    .normalize('NFC')
    .replace(/\[\[\s*(?:SEND_MEDIA|ESCALATE)[\s\S]*?\]\]/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ');
  for (const [label, re] of OPREPORT_STRONG_RES) {
    if (re.test(masked)) return label;
  }
  if (OPREPORT_MDTABLE_RE.test(masked)) return 'md_table';
  // Count NON-OVERLAPPING weak spans ("BẢNG GIAO KÈO" must not double-count as
  // two distinct hits through nested patterns — that is why the list holds only
  // disjoint tokens).
  const weakSpans: Array<[number, number]> = [];
  for (const re of OPREPORT_WEAK_RES) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (const m of masked.matchAll(g)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (!weakSpans.some(([s, e]) => start < e && end > s)) weakSpans.push([start, end]);
    }
  }
  const weak = weakSpans.length;
  if (weak >= 2) return 'weak_x2';
  if (weak >= 1 && masked.length > 1500) return 'weak_long';
  if (weak >= 1 && OPREPORT_ADDR_RE.test(masked)) return 'weak_addr';
  if (OPREPORT_PROCESS_RE.test(masked) && OPREPORT_METADELIV_RE.test(masked)) return 'process_meta';
  return null;
}

/** true khi reply nói về đời tư chủ/người sáng lập (owner + thuộc tính cá nhân trong cùng ~80 ký tự). */
const OWNER_REF_RE = /(jennie|uyên\s+chu|người\s+sáng\s+lập|nhà\s+sáng\s+lập|founder|chủ\s+(?:shop|gemral|công\s+ty|doanh\s+nghiệp)|sếp\s+(?:em|mình|bên\s+em)|bà\s+chủ|chị\s+chủ|owner|team\s+chuyên\s+môn\s+cấp\s+cao)/iu;
const PERSONAL_ATTR_RE = /(ngày\s+sinh|sinh\s+(?:năm|ngày|tháng)|năm\s+sinh|bao\s+nhiêu\s+tuổi|\d+\s+tuổi|lá\s+số|tử\s+vi\s+của|cung\s+hoàng\s+đạo\s+của|địa\s+chỉ\s+nhà|nhà\s+ở|đang\s+sống\s+ở|quê\s+(?:ở|quán)|số\s+điện\s+thoại\s+(?:riêng|cá\s+nhân)|sđt\s+(?:riêng|cá\s+nhân)|căn\s+cước|cccd|cmnd|hộ\s+chiếu|passport|chồng|vợ|người\s+yêu|con\s+(?:gái|trai)|gia\s+đình|email\s+(?:riêng|cá\s+nhân)|gmail)/iu;
export function detectOwnerPersonalInfoLeak(reply: string, publicContacts: string[] = []): boolean {
  if (!reply) return false;
  // 14/10: liên hệ CÔNG KHAI trên trang nguồn của agent (email hợp tác, link kênh) không phải đời tư.
  let text = reply.normalize('NFC');
  for (const c of publicContacts) {
    if (c) text = text.replace(new RegExp(c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
  }
  const g = new RegExp(OWNER_REF_RE.source, 'giu');
  for (const m of text.matchAll(g)) {
    const start = Math.max(0, (m.index ?? 0) - 80);
    const end = Math.min(text.length, (m.index ?? 0) + m[0].length + 80);
    if (PERSONAL_ATTR_RE.test(text.slice(start, end))) return true;
  }
  return false;
}

export async function postProcessReply(
  reply: string,
  config: AgentConfig,
  mediaLib: MediaLibrary | null,
): Promise<string> {
  if (!reply) return reply;

  // ── Final defense: refuse raw JSONL leak (incident 2026-04-30 sales-closer
  // Zalo, customer JN received 22KB of system prompt JSONL when Gemini failed
  // to emit assistant content). Even if upstream stream parser missed it, this
  // catches anything that smells like raw provider-stream output.
  const jsonlLeakRegex = /^\s*\{"type":"(init|message|content|result)"|"role":"(user|system)"/m;
  if (jsonlLeakRegex.test(reply)) {
    console.error(
      `[Router/${config.provider}] ${config.slug}: postProcessReply REFUSED JSONL leak (${reply.length} chars). Returning safe fallback.`,
    );
    return ''; // 03/10: KHÔNG câu đệm (JSONL leak đã chặn) — im lặng + báo người
  }

  // ── Final defense: refuse Antigravity/Gemini function-call TRACE leak (incident
  // 2026-08-01, cskh-shopify: customer Hồ Thị Mỹ Huệ received the agent's raw brain
  // transcript — `default_api:run_command{CommandLine:python "...antigravity-cli\\brain
  // \\...\\inspect_tables.py",...ExitCode:0,Output:=== GET SCHEMA DEFINITIONS ===...task-36}`
  // — prepended to the real reply). The model serialized an internal tool-call turn as
  // TEXT instead of executing it, and the antigravity reply-extractor (brain transcript
  // turnMarker) pulled the whole transcript. These tokens NEVER appear in a real
  // Vietnamese customer reply. Do NOT salvage the "clean" tail — a bled transcript can
  // carry another customer's data (task-36 referenced a different order). Refuse the whole
  // reply, hand off, and escalate so the session pauses (the agent is malfunctioning and
  // would re-leak on the next turn). Distinct from jsonlLeakRegex (raw JSONL stream) and
  // SELF_NARRATION_LEAK_RE (CLAUDE.md protocol leak on provider=claude).
  const agentTraceLeakRegex =
    /default_api\s*:\s*\w+\s*\{|run_command\s*\{|antigravity-cli[\\/]+brain|ExitCode\s*:\s*-?\d|=== GET SCHEMA DEFINITIONS ===/i;
  if (agentTraceLeakRegex.test(reply)) {
    console.error(
      `[Router/${config.provider}] ${config.slug}: postProcessReply REFUSED agent-trace leak `
        + `(${reply.length} chars). Suppressing + escalating. `
        + `Head: ${JSON.stringify(reply.slice(0, 300))}`,
    );
    (config as any)._escalation = {
      reason: 'agent_output_corrupted',
      priority: 'high',
      summary: 'Bot rò rỉ trace nội bộ (default_api / run_command / brain transcript) — đã chặn gửi, cần người tiếp quản.',
    };
    return ''; // 03/10 chị Jennie: chặn reply hỏng thì IM LẶNG, không câu đệm (escalation vẫn chạy ở consumer)
  }

  let cleaned = scrubBannedPhrases(reply, config.slug);

  // Chốt link bịa (14/10): agent có trang nguồn chỉ gửi link có nguyên văn trong trang (link-allowlist.ts).
  const linkAllow = loadAgentLinkAllowlist(config.slug, PROJECT_ROOT);
  if (linkAllow) {
    const { text, removed } = stripUnlistedLinks(cleaned, linkAllow);
    if (removed.length) {
      console.warn(`[Router/links] ${config.slug}: bỏ ${removed.length} link không có trong trang nguồn: ${removed.join(', ')}`);
      cleaned = text;
    }
  }

  // ── Collapse guard: scrub nuked ALL real content (incident 2026-06-10) ──
  // When the agent leaks Claude-Code explanatory output (★ Insight blocks, **bold**,
  // bullets) the defense-in-depth scrub above can strip the ENTIRE reply down to
  // stray punctuation — observed: a lone backtick `` ` `` reaching the customer for
  // turn after turn. NEVER send that. Suppress the garbage with a safe handoff line
  // AND escalate so the session pauses (bot_paused) + a ticket fires + CS is pinged;
  // otherwise the next customer message re-triggers the same broken agent.
  const hasLetters = (s: string) => /[\p{L}\p{N}]/u.test(s);

  // ── Self-narration collapse → SILENT skip (2026-06-29) ──
  // When the agent's ENTIRE reply was internal task-completion narration (CLAUDE.md
  // protocol leak: "*** Em đã đọc xong bối cảnh ... log tiến độ vào today.md và tạo báo
  // cáo trong docs/tasksdone rồi ạ"), Rule 8 strips it to empty. The agent simply had
  // NOTHING to say to the customer — this is NOT a malfunction needing a human. Send
  // nothing (return '' → consumer stays silent), do NOT escalate, do NOT send a handoff.
  // Must run BEFORE the generic collapse guard below (which would otherwise escalate).
  if (hasLetters(reply) && !hasLetters(cleaned) && SELF_NARRATION_LEAK_RE.test(reply)) {
    console.warn(
      `[Router/${config.provider}] ${config.slug}: reply was pure self-narration `
        + `(${reply.length} chars) — staying SILENT (skipped, no send, no escalation). `
        + `Head: ${JSON.stringify(reply.slice(0, 200))}`,
    );
    return '';
  }

  // GEM-1572: Bỏ envelope tokens ([[REPLY]], [[/REPLY]], [PAPERCLIP_REPLY_CHANNEL]) trước khi đo hasLetters
  // Tránh trường hợp bot chỉ trả về emoji như "💛[[/REPLY]]" mà bị coi là collapse vì chữ cái chỉ nằm trong tag wrapper.
  const replyWithoutEnvelope = reply.replace(/\[\[\s*\/?\s*REPLY\s*\]\]|\[PAPERCLIP_REPLY_CHANNEL\]/gi, '');
  if (hasLetters(replyWithoutEnvelope) && !hasLetters(cleaned)) {
    console.error(
      `[Router/${config.provider}] ${config.slug}: scrub COLLAPSED reply to no-content `
        + `(${reply.length}→${cleaned.trim().length} chars). Suppressing + escalating. `
        + `Original head: ${JSON.stringify(reply.slice(0, 300))}`,
    );
    (config as any)._escalation = {
      reason: 'agent_output_corrupted',
      priority: 'high',
      summary: 'Bot trả lời lỗi định dạng (rò rỉ output-style nội bộ) — đã chặn gửi, cần người tiếp quản.',
    };
    return ''; // 03/10 chị Jennie: chặn reply hỏng thì IM LẶNG, không câu đệm (escalation vẫn chạy ở consumer)
  }

  // ── Final defense: refuse operator-report leak (incident 2026-08-11) ──
  // See detectOperatorReportLeak above. Tests the PRE-scrub `reply` (the
  // operator greeting still reads "chị Jennie" here; scrub already rewrote
  // `cleaned`). Runs AFTER the self-narration silent-skip + collapse guards on
  // purpose: a pure-narration reply must stay silently skipped (2026-06-29
  // design), not converted into a handoff. Whole-reply refuse, no salvage. The
  // guard must never take the channel down: internal error → treat as clean.
  let opReportAxis: string | null = null;
  try {
    opReportAxis = detectOperatorReportLeak(reply);
  } catch (guardErr) {
    console.error(`[Router/${config.provider}] ${config.slug}: operator-report guard errored (treating as clean)`, guardErr);
  }
  if (opReportAxis) {
    console.error(
      `[Router/${config.provider}] ${config.slug}: postProcessReply REFUSED operator-report leak `
        + `(axis=${opReportAxis}, ${reply.length} chars). Suppressing + escalating. `
        + `Head: ${JSON.stringify(reply.slice(0, 300))}`,
    );
    (config as any)._escalation = {
      reason: 'agent_output_corrupted',
      priority: 'high',
      summary: `Bot lộ báo cáo nội bộ (operator-report leak, axis=${opReportAxis}) — đã chặn gửi, cần người kiểm tra.`,
    };
    return ''; // 03/10 chị Jennie: chặn reply hỏng thì IM LẶNG, không câu đệm (escalation vẫn chạy ở consumer)
  }

  // ── Final defense: owner personal-info leak (chị Jennie 08/10/2026) ──
  // Reply nói về đời tư người sáng lập/chủ (ngày sinh, địa chỉ, SĐT riêng, căn cước, gia đình…) →
  // chặn CẢ câu, im lặng + báo người. Rule 1 chỉ đổi TÊN; câu "người sáng lập sinh năm…" không có tên vẫn lộ.
  const ownAllow = loadAgentLinkAllowlist(config.slug, PROJECT_ROOT);
  const publicContacts = ownAllow ? [...ownAllow.emails, ...ownAllow.urls] : [];
  if (detectOwnerPersonalInfoLeak(reply, publicContacts)) {
    console.error(
      `[Router/${config.provider}] ${config.slug}: postProcessReply REFUSED owner personal-info leak `
        + `(${reply.length} chars). Head: ${JSON.stringify(reply.slice(0, 200))}`,
    );
    (config as any)._escalation = {
      reason: 'agent_output_corrupted',
      priority: 'high',
      summary: 'Bot định tiết lộ thông tin cá nhân của người sáng lập — đã chặn gửi, cần người kiểm tra.',
    };
    return '';
  }

  // Parse + strip [[ESCALATE: ...]] FIRST and stash the intent on config so the
  // consumer can fire handleEscalation (ticket + bot_paused + CS Telegram ping).
  // Previously this marker was never parsed here → escalation never fired
  // (crm_tickets stayed empty; agent "promised" escalation but did nothing).
  const escParsed = parseEscalationMarker(cleaned);
  cleaned = escParsed.cleanedText;
  if (escParsed.escalation) {
    (config as any)._escalation = escParsed.escalation;
    console.log(
      `[Router/${config.provider}] ${config.slug}: ESCALATE parsed `
        + `(reason=${escParsed.escalation.reason}, priority=${escParsed.escalation.priority})`,
    );
  }

  const mediaParsed = await parseMediaMarkers(cleaned, mediaLib);
  cleaned = mediaParsed.cleanedText;
  // Side-channel for consumer.ts multi-message send (each chunk = 1 bubble, typing delay).
  // Was read by consumer + test route but never SET — every reply went out as 1 block (14/10).
  if (mediaParsed.chunks.filter((c) => c.text || c.media?.length).length > 1) {
    (config as any)._messageChunks = mediaParsed.chunks;
  }
  if (mediaParsed.media.length > 0) {
    (config as any)._outboundMedia = mediaParsed.media;
    // MediaFile has `filename` (not `id` — id is on MediaLibraryItem).
    // Log filename so we can see what's being dispatched in the logs.
    console.log(
      `[Router/${config.provider}] ${config.slug}: extracted ${mediaParsed.media.length} media file(s): `
        + mediaParsed.media.map((m) => m.filename || m.url || '(unnamed)').join(', '),
    );
  }

  return cleaned;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Escalation intent extracted from a [[ESCALATE: ...]] marker.
 * Set when the agent decides the situation needs human handoff (angry customer,
 * legal threat, public complaint, mental health concern, etc.).
 *
 * Downstream consumer.ts uses this to:
 *   1. Mark channel_sessions.metadata.bot_paused = true (no more auto-replies)
 *   2. Insert urgent crm_tickets row
 *   3. Telegram-ping the operator (Jennie chat_id 6486938519)
 */
export interface EscalationIntent {
  reason: string;          // e.g. "customer_hostile", "legal_threat", "prolonged_frustration"
  priority: 'low' | 'normal' | 'high' | 'urgent';
  summary: string;          // Short Vietnamese description for the ticket
}

const ESCALATION_REASON_WHITELIST = new Set([
  'customer_hostile',
  'legal_threat',
  'public_complaint_threat',
  'public_complaint_active',
  'fraud_allegation',
  'mental_health_concern',
  'refund_dispute',
  'identity_verification_failed',
  'prolonged_frustration',
  'compliance_request',
  'ceo_request',
  'agent_output_corrupted',
]);

/**
 * Parse [[ESCALATE: reason="...", priority="...", summary="..."]] markers.
 * Strips the marker from text and returns the escalation intent (or null).
 *
 * The marker accepts kwargs in any order. Unknown reasons get coerced to
 * "customer_hostile" with a warning so the escalation still fires.
 */

/**
 * Customer-facing hard-rule scrub. Defense-in-depth — system prompt rules can
 * be ignored by small LLMs (Gemma 8B), so we enforce two NEVER rules at the
 * router level before the message ever reaches the customer:
 *
 *   1. NEVER name the owner — "chị Jennie", "Jennie", "Dr. Jennie", "owner",
 *      "sếp em", "boss em", "chị chủ" → replaced with "team chuyên môn cấp cao".
 *
 *   2. NEVER promise resolution faster than 24h — any "X phút", "X tiếng",
 *      "ngay bây giờ", "ngay trong hôm nay" pattern in a resolution-promise
 *      context → replaced with "trong vòng 24-48 tiếng".
 *
 * Logs a warning when a violation is scrubbed so we can audit prompt drift.
 */
const AI_PERSONA_AGENTS = new Set(['gem-master']);
/**
 * Agent trả lời trên kênh thương hiệu CÁ NHÂN của chị (14/10, EC-084 jennie-support): tên "Jennie" là tên
 * thương hiệu công khai (link jennie.yinyangmasters.com, @JennieUyenChu) — Rule 1 đổi tên thành "team chuyên
 * môn cấp cao" làm hỏng link + câu ("team chuyên môn cấp cao Uyen Chu", ca thật 14/10). Các agent này chỉ
 * bị chặn cụm nội bộ (sếp em/chị chủ/owner); đời tư vẫn do detectOwnerPersonalInfoLeak chặn.
 */
const OWNER_BRAND_AGENTS = new Set(['jennie-support']);

// Link (http/www/tên-miền) và @handle — các luật đổi chữ không được chạm vào bên trong.
const LINK_OR_HANDLE_RE = /(https?:\/\/\S+|www\.\S+|[\w-]+(?:\.[\w-]+)*\.(?:com|vn|net|org|io|me|co|app)\b\S*|@[\w.]+)/gi;

function replaceOutsideLinks(text: string, re: RegExp, replacement: string): string {
  return text
    .split(LINK_OR_HANDLE_RE)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(re, replacement)))
    .join('');
}

export function scrubBannedPhrases(text: string, agentSlug: string): string {
  if (!text) return text;
  let scrubbed = text;
  const violations: string[] = [];

  // Rule 1: owner name leak
  const ownerNameRe = OWNER_BRAND_AGENTS.has(agentSlug)
    ? /(sếp\s+em|boss\s+em|chị\s+chủ|owner)/gi
    : /(chị\s+jennie|dr\.?\s*jennie|jennie\s+uy[eê]n\s+chu|jennie(?!\s*team)|sếp\s+em|boss\s+em|chị\s+chủ|owner)/gi;
  // 14/10: KHÔNG đổi tên bên trong link/@handle — đổi ở đó làm hỏng link ("facebook.com/team chuyên môn cấp
  // caochuofficial", "youtube.com/@team" — ca thật sales-closer). Link công khai của kênh không phải đời tư.
  const isViReply = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(scrubbed);
  const ownerScrubbed = replaceOutsideLinks(scrubbed, ownerNameRe, isViReply ? 'team chuyên môn cấp cao' : 'our senior support team');
  if (ownerScrubbed !== scrubbed) {
    violations.push('owner_name');
    scrubbed = ownerScrubbed;
  }

  // Rule 1c: bot tự nhận là AI/bot/mô hình (chị Jennie 08/10/2026) → chỉ được xưng tư vấn viên.
  // Chỉ bắt câu TỰ XƯNG ("em là AI", "mình là chatbot", "tôi là Claude") — KHÔNG bắt chữ AI trong
  // mô tả sản phẩm ("GEM Master là trợ lý AI", "khóa học AI").
  const aiSelfRe = /\b(em|mình|tôi|bên em|bên mình)\s+(?:chỉ\s+)?là\s+(?:một\s+)?(?:trợ\s+lý\s+(?:ảo|ai)|chatbot|chat\s*bot|bot|ai|trí\s+tuệ\s+nhân\s+tạo|mô\s+hình\s+ngôn\s+ngữ(?:\s+lớn)?|language\s+model|claude|gemini|chatgpt|gpt[-\s]?\d*)(?![\p{L}\p{N}])/giu;
  // gem-master = sản phẩm chatbot AI bán trong app (khách mua chính vì là AI) → miễn luật này.
  if (!AI_PERSONA_AGENTS.has(agentSlug) && aiSelfRe.test(scrubbed)) {
    violations.push('ai_self_disclosure');
    scrubbed = scrubbed.replace(aiSelfRe, (_m, who) => `${who} là tư vấn viên`);
  }

  // Rule 2: short-time promise. Match common resolution-time phrasings.
  // Patterns: "trong X phút", "X phút nữa", "trong vòng X tiếng", "trong X giờ",
  //           "ngay bây giờ chị chờ", "trong hôm nay", "trong vài tiếng".
  const shortTimeRe = /(trong\s+(?:vòng\s+)?(?:khoảng\s+)?\d+\s*(?:[-–]\s*\d+\s*)?(?:phút|tiếng|giờ|h)|(?:khoảng\s+)?\d+\s*(?:phút|tiếng|giờ|h)\s+(?:nữa|tới|sau)|trong\s+vài\s+(?:phút|tiếng|giờ)|ngay\s+(?:bây\s+giờ|trong\s+hôm\s+nay|hôm\s+nay)|trong\s+hôm\s+nay)/gi;
  if (shortTimeRe.test(scrubbed)) {
    violations.push('short_time_promise');
    scrubbed = scrubbed.replace(shortTimeRe, 'trong vòng 24-48 tiếng');
  }

  // Rule 3a: Strip thinking/reasoning token leaks (Gemini extended thinking, Claude thinking)
  // Catches: [Thought: true], [Thinking: ...], "Changing Focus...", "<thinking>...</thinking>"
  const thinkingRe = /\[Thought:\s*\w+\]|\[Thinking:\s*[^\]]*\]|Changing\s+Focus\.{2,3}\s*|<thinking>[\s\S]*?<\/thinking>/gi;
  if (thinkingRe.test(scrubbed)) {
    violations.push('thinking_token_leak');
    scrubbed = scrubbed.replace(thinkingRe, '');
  }

  // Rule 3b: Strip tool/MCP/function-call markers (machine-readable brackets)
  // Catches: [MCP_xxx], [CALL: ...], [TOOL: ...], [FUNCTION: ...], [DEBUG: ...]
  // EXCLUDED: SEND_MEDIA, MSG_BREAK, STAGE, ESCALATE — those are real markers
  // parsed downstream by parseMediaMarkers / parseStageMarker / parseEscalationMarker.
  // P18 fix (2026-07-16): form [[...]] phải match tới ]] ĐÓNG (nhánh double-bracket lazy
  // [\s\S]*?\]\]) — KHÔNG dùng [^\]]* (dừng ở ] lồng trong args như JSON array tags=["a","b"]
  // hoặc ngoặc khách echo → CẮT marker, leak đuôi `..., key="v")]]`). Nhánh single [TOOL:...]
  // dùng [^\][]* (loại cả [ và ]) để không nuốt bracket khách. SEND_MEDIA/MSG_BREAK không nằm
  // trong keyword list → vẫn preserve (parseMediaMarkers xử downstream). Verified 9/9 test.
  const toolMarkerRe = /\[\[\s*(?:MCP|CALL|TOOL|FUNCTION|BROWSE|SEARCH|UPDATE|INSERT|DELETE|QUERY|FETCH|API|RPC|LOG|DEBUG)[_A-Z0-9]*[\s\S]*?\]\]|\[\s*(?:MCP|CALL|TOOL|FUNCTION|BROWSE|SEARCH|UPDATE|INSERT|DELETE|QUERY|FETCH|API|RPC|LOG|DEBUG)[_A-Z0-9]*\s*[:=]?[^\][]*\]/gi;
  if (toolMarkerRe.test(scrubbed)) {
    violations.push('tool_markers');
    scrubbed = scrubbed.replace(/\[\[\s*(?:MCP|CALL|TOOL|FUNCTION|BROWSE|SEARCH|UPDATE|INSERT|DELETE|QUERY|FETCH|API|RPC|LOG|DEBUG)[_A-Z0-9]*[\s\S]*?\]\]|\[\s*(?:MCP|CALL|TOOL|FUNCTION|BROWSE|SEARCH|UPDATE|INSERT|DELETE|QUERY|FETCH|API|RPC|LOG|DEBUG)[_A-Z0-9]*\s*[:=]?[^\][]*\]/gi, '');
  }

  // Rule 3c: Strip reply-envelope + reply-channel sentinel tokens (2026-08-11).
  // [[REPLY]]/[[/REPLY]] is the antigravity reply contract and
  // [PAPERCLIP_REPLY_CHANNEL] is the rule-file gate sentinel — a model echoing
  // either must never reach the customer, and an echo is NOT a leak by itself
  // (do not refuse on it — just strip).
  const envelopeTokenRe = /\[\[\s*\/?\s*REPLY\s*\]\]|\[PAPERCLIP_REPLY_CHANNEL\]/gi;
  if (envelopeTokenRe.test(scrubbed)) {
    violations.push('envelope_tokens');
    scrubbed = scrubbed.replace(/\[\[\s*\/?\s*REPLY\s*\]\]|\[PAPERCLIP_REPLY_CHANNEL\]/gi, '');
  }

  // Rule 4: Strip ALL special formatting characters (★, •, **, ##, etc.)
  // Customer chat should be plain text only
  if (/[★•]/.test(scrubbed)) {
    violations.push('special_chars');
    scrubbed = scrubbed.replace(/[★•]/g, '-');  // Replace with simple dash
  }
  // Strip markdown headers
  if (/^#{1,3}\s/m.test(scrubbed)) {
    violations.push('markdown_headers');
    scrubbed = scrubbed.replace(/^#{1,3}\s+/gm, '');
  }
  // Strip bold/italic markers
  if (/\*{1,2}[^*]+\*{1,2}/.test(scrubbed)) {
    violations.push('markdown_bold');
    scrubbed = scrubbed.replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1');
  }

  // Rule 4: Strip Claude-Code "★ Insight ───…" fenced blocks (output-style leak).
  // BOUNDED to the box-drawing/dash fence so a stray word "insight" in normal prose
  // does NOT nuke everything to end-of-reply (the 2026-06-10 backtick incident: the
  // old `Insight[\s\S]*$` deleted from the first "Insight" to the very end). Require
  // a fence of ≥2 rule chars after the header, then lazily stop at the closing fence
  // / blank line / end. If a leak slips past this, the collapse guard in
  // postProcessReply catches the all-content-stripped result.
  const insightBlockRe = /[-★•]?\s*Insight[ \t]*[─━—–=_-]{2,}[\s\S]*?(?:[─━—–=_-]{2,}|\n\s*\n|$)/gi;
  if (insightBlockRe.test(scrubbed)) {
    violations.push('insight_section');
    scrubbed = scrubbed.replace(insightBlockRe, '');
  }

  // Rule 5: Strip internal system mentions (CRM, tracking, database, etc.)
  const internalPatterns = [
    /[-•★]\s*(?:CRM|tracking|database|internal|system|hệ thống).*?(?:\n|$)/gi,
    /[-•★]\s*Customer acknowledgement.*?(?:\n|$)/gi,
    /[-•★]\s*Maintain natural conversation.*?(?:\n|$)/gi,
  ];
  for (const pattern of internalPatterns) {
    if (pattern.test(scrubbed)) {
      violations.push('internal_system_mention');
      scrubbed = scrubbed.replace(pattern, '');
    }
  }

  // Rule 6: Strip code fences / stray backticks (2026-06-10 backtick-leak class).
  // outputStyle:default (--settings) prevents the source, but defense-in-depth at the
  // router per BUG-022+026 (enforce customer-facing rules at ROUTER, not just prompt —
  // the small reply model ignores prompt bans). Vietnamese customer chat never uses
  // backticks, so dropping fences + leftover backticks is safe.
  if (/`/.test(scrubbed)) {
    violations.push('code_fence_or_backtick');
    scrubbed = scrubbed
      .replace(/```[a-zA-Z0-9]*\n?/g, '') // ```lang opening + ``` closing fences
      .replace(/`+/g, '');                // any remaining lone/inline backticks
  }

  // Rule 7: Strip meta-label prefix the LLM sometimes prepends ("Reply gửi chị X:",
  // "Trả lời:", "Tin nhắn:", "Phản hồi:") — these address the operator, not the
  // customer, and must never reach the chat (2026-06-11 "Reply gửi chị Trang:" leak).
  const metaLabelRe = /^\s*(?:reply(?:\s+g[uưử]i[^\n:]*)?|trả\s*lời|tin\s*nhắn|phản\s*hồi|message|response)\s*:\s*/i;
  if (metaLabelRe.test(scrubbed)) {
    violations.push('meta_label_prefix');
    scrubbed = scrubbed.replace(metaLabelRe, '');
  }

  // Rule 8: Strip agent self-narration / task-completion meta block (2026-06-29).
  // Provider=claude agents inherit the project CLAUDE.md "Task Completion Protocol"
  // and sometimes append a self-report to the customer after a *** / --- rule, e.g.:
  //   "*** Em đã đọc xong bối cảnh, soạn tin nhắn phản hồi chị X... đồng thời log tiến
  //    độ vào today.md và tạo báo cáo trong docs/tasksdone rồi ạ."
  // This narrates the agent's OWN dev work and must never reach the customer.
  // 8a: drop standalone markdown horizontal rules (***, ---, ___ on their own line).
  if (/^[ \t]*([*_-])\1{2,}[ \t]*$/m.test(scrubbed)) {
    violations.push('hr_separator');
    scrubbed = scrubbed.replace(/^[ \t]*([*_-])\1{2,}[ \t]*$/gm, '');
  }
  // 8b: cut a trailing self-narration block from the first line carrying an internal
  // dev-artifact signal to end. Anchors are tokens that NEVER appear in a real Vietnamese
  // customer reply (file paths today.md/docs/tasksdone/MEMORY.md/memory//evolution-log/
  // active-tasks/CLAUDE.md) or operator-facing self-report phrasings ("đã đọc xong bối
  // cảnh", "soạn tin nhắn/lại … phản hồi/gửi", "log tiến độ", "tạo báo cáo trong/vào") →
  // cut-to-end is safe (unlike the 2026-06-10 generic Insight bug, these anchors ARE the leak).
  if (SELF_NARRATION_LEAK_RE.test(scrubbed)) {
    violations.push('self_narration_leak');
    scrubbed = scrubbed.replace(SELF_NARRATION_LEAK_RE, '');
  }

  // Rule 9: Strip agentic task-runner execution log leaked as a PREFIX (2026-07-01).
  // Antigravity/agy (and any tool-running provider) can echo its own task trace BEFORE the
  // real customer reply, e.g.:
  //   "Task completed: python -c "import os; ... os.walk('.') ...".
  //    Task logs:
  //    .\backups\memory\sops\REF-PRODUCT-CATALOG_stale_...md
  //    .\memory\sops\REF-PRODUCT-CATALOG.md
  //
  //    Dạ set Dạ Kim Tụ ..."   <-- the actual reply follows a blank line.
  // Unlike Rule 8 (cut-to-END), this leak is a PREFIX with the real reply AFTER it, so we cut
  // from the "Task completed:"/"Task logs:" header lazily to the FIRST blank line (or end) and
  // KEEP everything after. Anchors are the runner's own labels, never present in customer prose.
  const taskLogLeakRe = /(?:^|\n)[ \t]*(?:Task completed:|Task logs:)[\s\S]*?(?:\n[ \t]*\n|$)/gi;
  if (taskLogLeakRe.test(scrubbed)) {
    violations.push('task_log_leak');
    scrubbed = scrubbed.replace(taskLogLeakRe, '\n');
  }

  // Rule 10: Strip English agent-action self-narration leaked as a PREFIX (2026-07-01).
  // When agy backgrounds a long tool/CLI call it narrates its plan in ENGLISH before the real
  // Vietnamese reply, e.g. "I will wait for the background search task to complete to check if
  // there are any ... stored in the project's standard operations procedures (SOPs)." The bot
  // replies 100% Vietnamese, so a leading English first-person action-narration line is always a
  // leak. Anchor = English first-person opener (I will/I'm/Let me/…) + a task/search/SOP/project
  // keyword, cut to the first blank line (or next Vietnamese "Dạ"/capitalised line), keep reply.
  const enNarrationRe = /(?:^|\n)[ \t]*(?:I(?:['’]ll|['’]m|\s+will|\s+am|\s+need\s+to|\s+have\s+to|\s+should|\s+can)|Let\s+me|Please\s+(?:wait|hold|allow)|Give\s+me\s+a\s+moment|Hold\s+on)\b[^\n]*?(?:background|task|search|SOP|procedure|project|check|look\s*up|wait|complete|stored|retriev|verif|fetch)[^\n]*(?:\n[ \t]*\n|\n(?=D[aạ]\b)|$)/gi;
  // 09/10/2026: bot trả lời theo ngôn ngữ khách → CHỈ cắt khi phần còn lại là tiếng Việt
  // (khách nói tiếng Anh thì "I'll check…" là câu trả lời thật, không phải narration rò rỉ).
  const viDiacriticRe = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i;
  if (enNarrationRe.test(scrubbed) && viDiacriticRe.test(scrubbed.replace(enNarrationRe, '\n'))) {
    violations.push('en_action_narration');
    scrubbed = scrubbed.replace(enNarrationRe, '\n');
  }

  // Cleanup: remove multiple consecutive newlines
  scrubbed = scrubbed.replace(/\n{3,}/g, '\n\n').trim();

  if (violations.length > 0) {
    console.warn(
      `[Router/scrub] ${agentSlug}: scrubbed ${violations.join(', ')} from reply (defense-in-depth)`,
    );
  }
  return scrubbed;
}

export function parseEscalationMarker(
  text: string,
): { cleanedText: string; escalation: EscalationIntent | null } {
  if (!text) return { cleanedText: text, escalation: null };

  // Match the OUTER [[ESCALATE: ... ]] envelope. Args may span multiple lines.
  const ESCALATE_RE = /\[\[\s*ESCALATE\s*:\s*([\s\S]*?)\s*\]\]/i;
  const match = text.match(ESCALATE_RE);
  if (!match) return { cleanedText: text, escalation: null };

  const argsBlob = match[1];

  // Pull each kwarg with a tolerant regex. Values may be quoted with " or '.
  const extractKwarg = (key: string): string | null => {
    const re = new RegExp(`${key}\\s*=\\s*["']([^"']*)["']`, 'i');
    const m = argsBlob.match(re);
    return m ? m[1] : null;
  };

  let reason = (extractKwarg('reason') || 'customer_hostile').trim();
  if (!ESCALATION_REASON_WHITELIST.has(reason)) {
    console.warn(`[Router/escalate] Unknown reason "${reason}" — coercing to customer_hostile`);
    reason = 'customer_hostile';
  }

  let priority = (extractKwarg('priority') || 'high').trim().toLowerCase();
  if (!['low', 'normal', 'high', 'urgent'].includes(priority)) {
    priority = 'high';
  }

  const summary = (extractKwarg('summary') || `Escalation triggered: ${reason}`).trim();

  // Strip the marker from the text. Note: any other [[...]] markers in the
  // same text will be handled by parseMediaMarkers downstream — we only
  // remove the ESCALATE envelope here.
  const cleanedText = text.replace(ESCALATE_RE, '').trim();

  return {
    cleanedText,
    escalation: {
      reason,
      priority: priority as EscalationIntent['priority'],
      summary,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

const MAX_TOOL_ROUNDS = 2;

/**
 * Parse + execute [[CALL: …]] markers in a raw model reply.
 * - Side-effect-only calls that all succeed → keep the model's own text (no extra LLM turn).
 * - Any info tool or any failure → re-dispatch ONCE per round with the tool observation so
 *   the customer reply is grounded in real results (bounded by MAX_TOOL_ROUNDS).
 * Leftover markers after the last round are still stripped by postProcessReply.
 */
async function runMarkerToolLoop(
  reply: string,
  config: AgentConfig,
  sessionKey: string,
  messageForAgent: string,
  dispatch: (msg: string) => Promise<string>,
  signal?: AbortSignal,
): Promise<string> {
  if (!/\[\[\s*CALL\s*:/i.test(reply)) return reply;
  // Lazy import: agent-tools → crm/mcp-server builds a Supabase client at module load;
  // a static import would make router.ts unloadable in env-less reply-contract tests.
  const { parseToolCalls, executeToolCalls, renderToolResultsForPrompt, isSideEffectOnlyTool } =
    await import('./agent-tools.js');
  let current = reply;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const { calls, cleanedText } = parseToolCalls(current);
    if (calls.length === 0) return current;

    const ctx = await loadToolExecutionContext(config.slug, sessionKey);
    const results = await executeToolCalls(calls, ctx);
    console.log(
      `[Router/tools] ${config.slug}: round ${round + 1} executed ` +
        calls.map((c, i) => `${c.name}=${results[i].ok ? 'ok' : 'fail'}`).join(', '),
    );

    const needsObservation = calls.some((c, i) => !isSideEffectOnlyTool(c.name) || !results[i].ok);
    if (!needsObservation && cleanedText.trim()) return cleanedText;

    const observation = renderToolResultsForPrompt(calls, results);
    try {
      current = await dispatch(
        `${messageForAgent}\n\n${observation}\n\nBản nháp trả lời trước khi có kết quả tool (sửa lại cho đúng kết quả, KHÔNG gọi lại tool đã OK):\n${cleanedText}`,
      );
    } catch (err: any) {
      console.warn(`[Router/tools] ${config.slug}: observation re-dispatch failed: ${err.message}`);
      return cleanedText;
    }
    if (signal?.aborted) throw new AgentAbortedError();
  }
  return current;
}

/**
 * Load tool execution context (verified customer + channel name) from
 * channel_sessions.metadata. Returns a fresh context every call so verifications
 * persist across multiple replies in the same session.
 */
async function loadToolExecutionContext(
  agentSlug: string,
  sessionKey: string,
): Promise<ToolExecutionContext> {
  const ctx: ToolExecutionContext = {
    agentSlug,
    sessionKey,
    verifiedCustomerId: null,
    channelName: null,
  };

  if (!sessionKey) return ctx;

  try {
    const { data } = await supabase
      .from('channel_sessions')
      .select('metadata, channel_name')
      .eq('session_key', sessionKey)
      .single();

    if (data) {
      ctx.channelName = data.channel_name || null;
      const meta = (data.metadata || {}) as any;
      const verifiedAt = meta.verified_at ? new Date(meta.verified_at).getTime() : 0;
      const ageMs = Date.now() - verifiedAt;
      const VERIFY_TTL_MS = 30 * 60 * 1000; // 30 phút
      if (meta.verified_customer_id && ageMs < VERIFY_TTL_MS) {
        ctx.verifiedCustomerId = meta.verified_customer_id;
      }
    }
  } catch (err: any) {
    console.warn(`[Router] loadToolExecutionContext failed for ${sessionKey}: ${err.message}`);
  }

  return ctx;
}

/**
 * Run via NVIDIA NIM API (cloud, free tier 1000 credits).
 *
 * Free hosted Gemma models on build.nvidia.com — same OpenAI-compatible
 * /v1/chat/completions schema as OpenRouter / Ollama, but GPU-fast.
 *
 * Setup:
 *   1. Sign up at https://build.nvidia.com → get nvapi-xxx key
 *   2. Add to paperclip/server/.env: NVIDIA_API_KEY=nvapi-xxx
 *   3. Set agent: provider='nvidia_nim', model='google/gemma-4-31b-it'
 *
 * Available Gemma models on NIM (as of 2026-04):
 *   - google/gemma-4-31b-it     ← largest, best Vietnamese
 *   - google/gemma-3-27b-it
 *   - google/gemma-2-27b-it
 *   - google/gemma-2-9b-it      ← faster, fewer credits
 *   - google/gemma-2-2b-it
 *
 * Notes:
 *   - Each request consumes credits (larger model = more).
 *   - 401 = bad/missing key. 429 = quota exhausted → fall back to Ollama.
 *   - Endpoint is OpenAI-compat → reuse messages[] format like Ollama /api/chat.
 *   - Vietnamese: Gemma 4 has strong multilingual support, but we still
 *     inject the language hint for safety.
 */
async function runViaNvidiaNim(
  config: AgentConfig,
  systemPrompt: string,
  history: SessionMessage[],
  message: string,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new AgentAbortedError();
  const apiKey = process.env.NVIDIA_API_KEY || process.env.NVIDIA_NIM_API_KEY;
  if (!apiKey) {
    throw new Error(
      'NVIDIA_API_KEY not set. Sign up at https://build.nvidia.com → '
        + 'paste key into paperclip/server/.env as NVIDIA_API_KEY=nvapi-xxx',
    );
  }

  const baseUrl = (process.env.NVIDIA_NIM_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '');
  const model = config.model || process.env.NVIDIA_NIM_MODEL || 'google/gemma-4-31b-it';

  // 09/10/2026 (chị Jennie chốt): trả lời theo NGÔN NGỮ CỦA KHÁCH, không ép tiếng Việt.
  const languageHint = '\n\nQUY TẮC NGÔN NGỮ: Trả lời bằng đúng ngôn ngữ khách đang dùng — khách viết tiếng Anh thì trả lời tiếng Anh, tiếng Việt thì tiếng Việt có dấu đầy đủ, tiếng Trung thì tiếng Trung. Ngắn gọn, thân thiện. Chưa rõ thì theo ngôn ngữ tin nhắn gần nhất của khách.';

  const finalSystem = (systemPrompt || '') + languageHint;

  type ChatMsg = { role: 'system' | 'user' | 'assistant'; content: string };
  const messages: ChatMsg[] = [];
  if (finalSystem.trim()) {
    messages.push({ role: 'system', content: finalSystem.trim() });
  }
  const historyLimit = config.history_limit || 20;
  const recentHistory = history.slice(-historyLimit);
  for (const h of recentHistory) {
    if (h.role === 'user' || h.role === 'assistant') {
      messages.push({ role: h.role, content: h.content });
    }
  }
  messages.push({ role: 'user', content: message });

  return withApiTimeout('nvidia_nim', 'NVIDIA NIM', config.slug, AGENT_TIMEOUT_MS, signal, () => new AgentAbortedError(), async (fetchSignal) => {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: config.temperature ?? 0.7,
        max_tokens: config.max_tokens || 1500,
        top_p: 0.95,
        stream: false,
      }),
      signal: fetchSignal,
    });

    if (!res.ok) {
      const body = await res.text();
      // 401 = bad key, 402/429 = quota exhausted
      if (res.status === 401) {
        throw new Error(`NVIDIA NIM 401: API key invalid or expired. Re-issue at https://build.nvidia.com.`);
      }
      if (res.status === 429 || res.status === 402) {
        throw new Error(`NVIDIA NIM ${res.status}: free credits exhausted. Switch agent provider to 'claude' or 'gemini'.`);
      }
      throw new Error(`NVIDIA NIM ${baseUrl}/chat/completions ${res.status}: ${body.substring(0, 400)}`);
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { role?: string; content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      error?: { message?: string };
    };

    if (data.error) {
      throw new Error(`NVIDIA NIM error: ${data.error.message || JSON.stringify(data.error)}`);
    }

    const content = (data.choices?.[0]?.message?.content || '').trim();

    if (!content) {
      console.warn(
        `[Router/NIM] ${config.slug}: empty content (finish_reason=${data.choices?.[0]?.finish_reason}, `
          + `tokens used=${data.usage?.total_tokens})`,
      );
    }

    return content;
  });
}

// ─── Helpers ───

/**
 * Build system prompt from config.
 * Priority: system_prompt > persona_file content > generic fallback
 */
/**
 * Default company UUID (GEMRAL). Used when no explicit company context is
 * available for the call. Single-tenant fallback for shared Goals SSOT.
 */
const DEFAULT_COMPANY_ID = process.env.DEFAULT_COMPANY_ID
  || 'f78ffdea-e400-46be-8705-5f6cfbce1eb0'; // GEMRAL

/**
 * Fetch active company goals from the Supabase `goals` table and format them
 * into a markdown block for system-prompt injection. Company-scoped. Returns
 * empty string on any failure so prompt assembly never blocks.
 *
 * Hierarchy: root (level='company', parent_id IS NULL) → children (level in
 * 'project'/'task'). Only active goals are included.
 */
async function fetchCompanyGoalsBlock(companyId: string): Promise<{ block: string; count: number }> {
  try {
    const { data: goals, error } = await supabase
      .from('goals')
      .select('id, title, description, level, status, parent_id, owner_agent_id')
      .eq('company_id', companyId)
      .eq('status', 'active')
      .order('created_at', { ascending: true });

    if (error || !goals || goals.length === 0) {
      return { block: '', count: 0 };
    }

    // Build parent → children map
    const byId = new Map<string, any>();
    for (const g of goals) byId.set(g.id, g);
    const roots = goals.filter((g: any) => !g.parent_id || !byId.has(g.parent_id));
    const childrenOf = (parentId: string) => goals.filter((g: any) => g.parent_id === parentId);

    const lines: string[] = ['# MỤC TIÊU & ĐỊNH HƯỚNG CÔNG TY (LIVE từ DB)'];
    for (const root of roots) {
      const prefix = root.level === 'company' ? '🎯' : root.level === 'project' ? '📁' : '•';
      lines.push(`${prefix} **${root.title}**${root.description ? ` — ${root.description}` : ''}`);
      const kids = childrenOf(root.id);
      for (const k of kids) {
        const kidPrefix = k.level === 'task' ? '  ☐' : '  •';
        lines.push(`${kidPrefix} ${k.title}${k.description ? ` — ${k.description}` : ''}`);
      }
    }
    lines.push('');
    lines.push('→ MỌI agent trong hệ thống PHẢI biết và hỗ trợ các mục tiêu này khi trả lời khách hàng, tạo content, và xử lý công việc.');
    return { block: lines.join('\n'), count: goals.length };
  } catch (err) {
    console.warn('[Router] fetchCompanyGoalsBlock failed:', (err as any)?.message);
    return { block: '', count: 0 };
  }
}

/** Agent nói chuyện trực tiếp với khách = `type: "reply"` trong agent.meta.json. Thiếu/hỏng meta → coi là
 *  nói chuyện với khách (fail-closed: thà thiếu hồ sơ owner còn hơn lộ cho khách). */
export function isCustomerFacingAgent(agentDir: string): boolean {
  try {
    const meta = JSON.parse(readFileSync(pathResolve(agentDir, 'agent.meta.json'), 'utf-8'));
    return meta?.type !== 'heartbeat';
  } catch {
    return true;
  }
}

/** Agent trả lời khách khai `"sandbox": true` trong agent.meta.json (29/10, rà bảo mật live-terminal):
 *  chạy agy trong thư mục tạm NGOÀI dự án, môi trường không mang khoá, prompt không có khối MCP/mục tiêu.
 *  Chỉ bật cho agent không cần công cụ (mọi ngữ cảnh đã nạp sẵn trong prompt) — CSKH/Gem Master giữ nguyên. */
export function isSandboxedReplyAgent(slug: string): boolean {
  try {
    const dir = pathResolve(process.env.AGENTS_DIR || pathResolve(PROJECT_ROOT, 'agents'), slug);
    const meta = JSON.parse(readFileSync(pathResolve(dir, 'agent.meta.json'), 'utf-8'));
    return meta?.type === 'reply' && meta?.sandbox === true;
  } catch {
    return false;
  }
}

/** Môi trường cho agy chạy riêng: bỏ mọi biến mang khoá/bí mật, giữ biến hệ điều hành agy cần để chạy. */
export function sandboxedChildEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const SECRET_RE = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|SUPABASE|SHOPIFY|RESEND|STRIPE|DATABASE_URL|DIRECT_URL|PAPERCLIP_API)/i;
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(childEnvWithoutGeminiApi(base))) {
    if (!SECRET_RE.test(k)) out[k] = v;
  }
  return out;
}

async function buildSystemPrompt(
  config: AgentConfig,
  customerContext?: any,
  companyId: string = DEFAULT_COMPANY_ID,
  retrievalQuery: string = '',
): Promise<string> {
  const projectRoot = PROJECT_ROOT;
  const agentsDir = pathResolve(
    process.env.AGENTS_DIR || pathResolve(projectRoot, 'agents'),
    config.slug,
  );

  const parts: string[] = [];
  const loadedFiles: string[] = [];

  function tryLoad(filePath: string, header: string): void {
    if (existsSync(filePath)) {
      parts.push(`# ${header}\n` + readFileSync(filePath, 'utf-8'));
      loadedFiles.push(header);
    }
  }

  // JSON SSOT inline GỌN (29/09): prompt sales-closer phình 710k ký tự (catalog 483KB thụt dòng +
  // cskh-qa 208KB) → agy quá 5' timeout → reply rỗng → khách bị bỏ rơi câm (homyhue 28/09).
  // Ghi compact + bỏ trường agent KHÔNG dùng: link/đường dẫn ảnh (gửi ảnh qua [[SEND_MEDIA: id]],
  // server tự tra ảnh từ file catalog gốc — catalog-media-source.ts), `origin`/`freq` (provenance).
  // Giữ id/name/covers/price/variant/links/description/includes/answer. Parse lỗi → nạp nguyên văn.
  const INLINE_JSON_OMIT = new Set(['images', 'all_images', 'all_image_urls', 'path', 'origin', 'freq']);
  function tryLoadJsonSlim(filePath: string, header: string, relPath: string = ''): void {
    if (!existsSync(filePath)) return;
    const raw = readFileSync(filePath, 'utf-8');
    try {
      const parsed = JSON.parse(raw);
      // Chọn lọc theo câu khách (inline-ssot-select.ts): mục lục đủ + chi tiết mục khớp → prompt nhỏ.
      const picked = selectInlineJson(relPath.split('/').pop() || '', parsed, retrievalQuery, relPath);
      const slim = picked ?? JSON.stringify(parsed, (k, v) => (INLINE_JSON_OMIT.has(k) ? undefined : v));
      parts.push(`# ${header}\n` + slim);
    } catch {
      parts.push(`# ${header}\n` + raw);
    }
    loadedFiles.push(header);
  }

  // 0. Owner info (shared USER.md) + Agent identity
  // Agent loại "reply" nói chuyện với KHÁCH → KHÔNG nạp hồ sơ cá nhân owner (chống lộ thông tin
  // cá nhân chị Jennie cho khách, chị chốt 08/10/2026). Loại đọc từ agents/<slug>/agent.meta.json.
  if (!isCustomerFacingAgent(agentsDir)) {
    tryLoad(pathResolve(projectRoot, 'agents', 'USER.md'), 'THÔNG TIN OWNER');
  }
  tryLoad(pathResolve(agentsDir, 'IDENTITY.md'), 'NHÂN CÁCH AGENT');

  // 1. Agent persona files
  tryLoad(pathResolve(agentsDir, 'SOUL.md'), 'PERSONA');
  tryLoad(pathResolve(agentsDir, 'AGENTS.md'), 'HƯỚNG DẪN VẬN HÀNH');
  tryLoad(pathResolve(agentsDir, 'TOOLS.md'), 'CÔNG CỤ');
  tryLoad(pathResolve(agentsDir, 'HEARTBEAT.md'), 'HEARTBEAT CHECKLIST');

  // 1.5. (bỏ 28/10/2026) Giọng + correction chị dạy giờ sống ở SOUL.md §🗣️ (đã nạp ở PERSONA bên trên).
  // memory/agents/<slug>/tone-profile.md đã gộp nguyên văn vào SOUL.md và gỡ — không nạp nữa
  // (máy gác crypto-pattern-scanner scripts/audit_agent_tone_profile.py).

  // 2. Agent memory (tacit knowledge)
  const agentMemoryPath = pathResolve(projectRoot, 'memory', 'agents', config.slug, 'MEMORY.md');
  tryLoad(agentMemoryPath, 'KIẾN THỨC CÁ NHÂN');

  // 2.5 Company Goals and Directions — SSOT live from Supabase `goals` table.
  // File fallback (memory/goals.md) only used if DB returns nothing.
  // 29/10: agent chạy riêng (sandbox) KHÔNG nhận mục tiêu doanh thu nội bộ (lộ số + đẩy agent chào bán).
  // CSKH/Gem Master giữ nguyên theo yêu cầu chị Jennie (cần ngữ cảnh chung).
  const sandboxed = isSandboxedReplyAgent(config.slug);
  const dbGoals = sandboxed ? { block: '', count: 0 } : await fetchCompanyGoalsBlock(companyId);
  if (sandboxed) {
    // không nạp cả bản file dự phòng memory/goals.md
  } else if (dbGoals.block) {
    parts.push(dbGoals.block);
    loadedFiles.push(`DB goals (${dbGoals.count} live)`);
  } else {
    const goalsFilePath = pathResolve(projectRoot, 'memory', 'goals.md');
    tryLoad(goalsFilePath, 'MỤC TIÊU & ĐỊNH HƯỚNG CÔNG TY');
  }
  // memory/projects.md = bảng trạng thái dự án NỘI BỘ (~17,5K ký tự, ~40% prompt gem-master 14/10). Agent trả lời
  // KHÁCH không dùng tới nó — chỉ làm agy đọc lâu hơn + rủi ro lộ việc nội bộ cho khách (cùng lý do bỏ USER.md 08/10).
  if (!isCustomerFacingAgent(agentsDir)) {
    const projectsFilePath = pathResolve(projectRoot, 'memory', 'projects.md');
    tryLoad(projectsFilePath, 'DỰ ÁN ĐANG CHẠY');
  }

  // 3. Relevant SOPs — walk memory/sops RECURSIVELY. Since the 2026-07 reorg the SOP files
  // live in categorized subdirs (DOC-HTML/, Other_Docs/, SOP_social_media_and_ads/, …) so the
  // old top-level-only readdirSync found NOTHING (365 SOPs sit in subdirs, only 5 at top level).
  // Gate on memory/INDEX.md mentioning the slug (opt-in, avoids over-broad slugKey matches like
  // "gem"), then inline .md files whose name carries the agent's slug-prefix.
  const sopsDir = pathResolve(projectRoot, 'memory', 'sops');
  if (existsSync(sopsDir)) {
    try {
      const sopIndexPath = pathResolve(sopsDir, '..', 'INDEX.md');
      const sopIndex = existsSync(sopIndexPath)
        ? readFileSync(sopIndexPath, 'utf-8').toLowerCase()
        : '';
      if (sopIndex.includes(config.slug)) {
        const slugKey = config.slug.split('-')[0].toLowerCase();
        const walkSops = (dir: string): void => {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = pathResolve(dir, entry.name);
            if (entry.isDirectory()) walkSops(full);
            else if (entry.name.endsWith('.md') && entry.name.toLowerCase().includes(slugKey)) {
              tryLoad(full, `SOP: ${entry.name}`);
            }
          }
        };
        walkSops(sopsDir);
      }
    } catch { /* skip */ }
  }

  // 3b. Always-inline curated reference files (per-agent manifest agents/<slug>/sop/_INLINE.json).
  // Ensures key SSOT refs (pricing catalog, crystal-consult, CS cases) are IN-PROMPT so the reply
  // agent never filesystem-searches (os.walk) to locate them — a search that can surface a STALE
  // backup copy and quote/leak outdated data. See CSKH_SUPPORT_SYSTEM_SSOT §11 + chatbot-doctor.
  // Paths are PROJECT_ROOT-relative to the REAL files (NOT the agents/<slug>/sop/ symlinks —
  // those MSYS-style symlinks are unreadable by Node's fs on Windows: realpathSync → ENOENT).
  const inlineManifest = pathResolve(agentsDir, 'sop', '_INLINE.json');
  if (existsSync(inlineManifest)) {
    try {
      const names = JSON.parse(readFileSync(inlineManifest, 'utf-8'));
      if (Array.isArray(names)) {
        for (const name of names) {
          if (typeof name === 'string') {
            const refPath = pathResolve(projectRoot, name);
            const refHeader = `SSOT REF: ${name.split('/').pop()}`;
            if (name.endsWith('.json')) tryLoadJsonSlim(refPath, refHeader, name);
            else tryLoad(refPath, refHeader);
          }
        }
      }
    } catch { /* skip malformed manifest */ }
  }

  // 4. System prompt from DB (additional instructions)
  if (config.system_prompt) {
    parts.push('# CHỈ THỊ BỔ SUNG\n' + config.system_prompt);
    loadedFiles.push('DB system_prompt');
  }

  // 5. Customer context (if available from CRM lookup)
  if (customerContext) {
    const stage = customerContext.stage || 'new';
    const isSales = ['new', 'đang_tư_vấn', 'chờ_chốt', 'follow_up'].includes(stage);
    parts.push([
      '# THÔNG TIN KHÁCH HÀNG',
      `- Tên: ${customerContext.name || 'Chưa biết'}`,
      `- Kênh: ${customerContext.channel_name || 'Zalo'}`,
      `- Giai đoạn: ${stage}`,
      customerContext.products_interested ? `- Quan tâm: ${customerContext.products_interested}` : '',
      customerContext.total_orders ? `- Đã mua: ${customerContext.total_orders} đơn` : '',
      '',
      '# VAI TRÒ',
      // 14/10 (EC-084): agent không bán hàng (jennie-support) KHÔNG được nhận vai "tư vấn bán hàng, chốt đơn".
      NON_SALES_AGENTS.has(config.slug)
        ? 'BẠN LÀ TEAM HỖ TRỢ CỦA THƯƠNG HIỆU. KHÔNG tư vấn bán hàng, KHÔNG chào sản phẩm, KHÔNG chốt đơn — làm đúng phạm vi trong AGENTS.md.'
        : isSales
          ? 'BẠN LÀ TƯ VẤN BÁN HÀNG. Tư vấn sản phẩm, thuyết phục, chốt đơn.'
          : 'BẠN LÀ CHĂM SÓC SAU MUA. Hỗ trợ, giải quyết vấn đề, giữ chân.',
    ].filter(Boolean).join('\n'));
  }

  // 6. Chat-specific rules — agent chạy riêng theo ENGINE MODE trong system_prompt (không công cụ, 1 câu),
  // khối này ("Bạn CÓ MCP tools", "2-4 câu", "chuyển chuyên viên") mâu thuẫn hợp đồng của nó → bỏ.
  if (!sandboxed) parts.push([
    '# QUY TẮC CHAT',
    '- Đây là tin nhắn từ khách hàng qua kênh chat (Zalo / Facebook / chat trên web). Trả lời TRỰC TIẾP.',
    '- NHẮN NGẮN 2-4 câu. Thân thiện. Trả lời bằng đúng ngôn ngữ khách đang dùng (tiếng Anh → tiếng Anh, tiếng Việt → tiếng Việt có dấu đầy đủ, tiếng Trung → tiếng Trung).',
    `- Bạn là ${config.display_name} của ${agentBrand(config.slug)}. KHÔNG xưng là Jennie hay bất kỳ ai khác.`,
    '- Nếu không biết câu trả lời → nói thật, đề nghị chuyển cho người phụ trách.',
    '- Nếu khách tức giận → 1 câu báo sẽ chuyển chuyên viên (bằng đúng ngôn ngữ của khách) → DỪNG.',
    '- CHỈ TEXT THUẦN. KHÔNG ★, •, **, ##, backticks, headers, bullets đặc biệt.',
    '- Dùng dấu gạch ngang (-) nếu cần list. Viết như tin nhắn bình thường.',
    '- TUYỆT ĐỐI KHÔNG nhắc: Insight, CRM, tracking, database, system, internal, meta-commentary.',
    '- KHÔNG giải thích cách bạn suy nghĩ hay process. Chỉ trả lời khách.',
    '- KHÁCH ĐANG NHẮN TIN TRỰC TIẾP TRONG CUỘC CHAT NÀY. KHÔNG xin SĐT để gửi qua kênh khác — họ ĐÃ Ở ĐÂY.',
    '- Muốn gửi hình/link → gửi TRỰC TIẾP trong tin nhắn này, không cần xin SĐT.',
    '- Bạn CÓ MCP tools (check order, CRM, search product, Shopify...). GỌI tools qua MCP protocol đúng cách.',
    '- TUYỆT ĐỐI KHÔNG viết tool call syntax ra text reply: KHÔNG "[CALL: ...]", KHÔNG "[MCP_...]", KHÔNG "[SEARCH: ...]".',
    '- Tool call xảy ra SILENT qua MCP — chỉ dùng RESULT của tool để soạn reply text thuần cho khách.',
    '- Khách KHÔNG cần thấy bạn đang gọi tool nào — chỉ thấy câu trả lời cuối cùng.',
    '- Sản phẩm đang bán: theo HƯỚNG DẪN VẬN HÀNH (AGENTS.md) của agent — KHÔNG tự chào sản phẩm ngoài danh sách đó.',
    `- Có thể escalate tới: ${(config.can_escalate_to || []).join(', ') || 'CEO'}`,
  ].join('\n'));

  if (parts.length <= 1) {
    return `Bạn là ${config.display_name}. ${config.description || ''} Trả lời bằng đúng ngôn ngữ khách đang dùng (tiếng Việt thì có dấu đầy đủ), ngắn gọn.`;
  }

  const prompt = parts.join('\n\n---\n\n');
  console.log(`[Router] System prompt for ${config.slug}: ${prompt.length} chars from ${loadedFiles.length} sources: ${loadedFiles.join(', ')}`);
  return prompt;
}

/**
 * Build the full user prompt including conversation history.
 */
function buildFullPrompt(history: SessionMessage[], message: string): string {
  const parts: string[] = [];

  if (history.length > 0) {
    parts.push('--- Lịch sử hội thoại ---');
    for (const entry of history) {
      const name = entry.role === 'user'
        ? (entry.senderName || 'User')
        : 'Assistant';
      parts.push(`${name}: ${entry.content}`);
    }
    parts.push('--- Kết thúc lịch sử ---\n');
  }

  parts.push(message);

  return parts.join('\n');
}

/**
 * Load conversation history from channel_sessions.
 */
async function loadHistory(
  sessionKey: string,
  limit: number = 20,
): Promise<SessionMessage[]> {
  const { data: session } = await supabase
    .from('channel_sessions')
    .select('history')
    .eq('session_key', sessionKey)
    .single();

  if (!session) return [];

  const history = (session.history || []) as SessionMessage[];

  if (limit > 0 && history.length > limit) {
    return history.slice(history.length - limit);
  }

  return history;
}

/**
 * Save user message and agent reply to session history.
 * Stamps each entry's metadata with agent_session_id (from side-channel set
 * by runViaClaude / runViaGemini) so the Chat Drawer can drill down into
 * the exact JSONL session that handled this turn.
 *
 * This is the SINGLE WRITER for `channel_sessions.history` on the channel
 * flow. Consumer.ts no longer calls session.appendMessage separately —
 * that was the duplicate-write bug (BUG-047).
 */
async function saveHistory(
  sessionKey: string,
  userMessage: string,
  agentReply: string,
  config: AgentConfig,
  senderName?: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  const agentSessionId = (config as any)._agent_session_id as string | null | undefined;
  const metadata = agentSessionId ? { agent_session_id: agentSessionId } : undefined;

  // Store the RAW customer text, NOT the enriched `[HỒ SƠ…][TÓM TẮT AI]…[TIN NHẮN MỚI]`
  // block that was injected for this turn. Storing the enriched form made history bloat +
  // self-reinforce (stale CRM snapshots re-fed every turn, summarizer re-summarizing its
  // own summary → phantom "đang chờ hoàn tất đơn"). Stripping at the single writer covers
  // every caller (consumer, /test, training) without threading a new param. (plan
  // CSKH-SALES-CLOSER-BRAIN, ADR-6). Idempotent for already-raw messages.
  const rawUserMessage = stripInjectedContext(userMessage);
  if (rawUserMessage.startsWith('[HỒ SƠ')) {
    console.error(`[saveHistory] injected-context leaked into stored user message for ${sessionKey}`);
  }

  // Fetch current session — may be null for training/test sessions which have
  // no live channel row. We UPSERT below so the first turn creates the row.
  const { data: session } = await supabase
    .from('channel_sessions')
    .select('history, history_count')
    .eq('session_key', sessionKey)
    .single();

  let history = ((session?.history as SessionMessage[] | null) || []) as SessionMessage[];

  history.push(
    {
      role: 'user',
      content: rawUserMessage,
      timestamp: now,
      ...(senderName ? { senderName } : {}),
      ...(metadata ? { metadata } : {}),
    },
    {
      role: 'assistant',
      content: agentReply,
      timestamp: now,
      ...(metadata ? { metadata } : {}),
    },
  );

  // Trim to history limit
  const limit = config.history_limit || 20;
  if (history.length > limit) {
    history = history.slice(history.length - limit);
  }

  // If row exists, UPDATE (preserves real chat_id from channel ingestion).
  // If row missing (training/test sessions), INSERT with synthetic chat_id.
  // Without this insert path, loadHistory always returns [] for training →
  // agent has zero context → repeats the same canned reply every turn
  // (the "robot agent" bug).
  if (session) {
    // KHÔNG ghi last_message_at / last_message_preview / last_message_sender ở nhánh UPDATE
    // (P41, GEM-1177): preview Hộp thư chỉ có 2 điểm ghi — consumer (tin VÀO, theo giờ tin) và
    // trigger DB trg_channel_sent_touch_session (tin RA, theo created_at thật của
    // channel_sent_messages). saveHistory chạy theo giờ XỬ LÝ và TRƯỚC khi reply thật sự được gửi
    // (có khi không bao giờ gửi: im lặng/bị chặn) → ghi `now` + nội dung reply ở đây làm
    // last_message_at vượt created_at của tin ra thật, trigger bị chặn bởi
    // `last_message_at <= new.created_at` và preview lệch tin cuối thật. Cùng nguyên tắc với
    // session.ts getOrCreate (27/09).
    await supabase
      .from('channel_sessions')
      .update({
        history,
        history_count: history.length,
        agent_slug: config.slug,
        updated_at: now,
      })
      .eq('session_key', sessionKey);
  } else {
    // Phiên training/test chưa có dòng: không có consumer lẫn kênh gửi thật → seed preview 1 lần.
    // Tên cột PHẢI đúng (PostgREST bỏ qua cột lạ — GEM-1028).
    const last_message_preview = agentReply.substring(0, 200);
    const last_message_sender = 'Bạn';
    await supabase
      .from('channel_sessions')
      .insert({
        session_key: sessionKey,
        chat_id: sessionKey, // synthetic — satisfies NOT NULL for training/test
        history,
        history_count: history.length,
        agent_slug: config.slug,
        last_message_at: now,
        last_message_preview,
        last_message_sender,
        updated_at: now,
      });
  }
}
