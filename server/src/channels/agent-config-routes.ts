// Agent Config CRUD API — manages paperclip_agents table
// Provides endpoints for listing, creating, updating, deleting agent configs
// and testing agent replies via AgentRouter.

import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { mkdtempSync } from 'fs';
import { supabase } from './zalo-personal/supabase.js';
import * as AgentRouter from './router.js';
import type { AgentConfig } from './types.js';
import { handleEscalation } from './crm/escalation-handler.js';
import { isHumanSent } from './sent-by-utils.js';
import { agyCallerTimeoutMs } from './llm-route-policy.js';

// Agent files directory — crypto-pattern-scanner/agents/
// NOTE: fallback MUST include /agents to match buildSystemPrompt (router.ts),
// else the "Tệp Agent" viewer reads <root>/<slug> (nonexistent) and shows
// every file as "chưa tạo" while the runtime correctly reads <root>/agents/<slug>.
const AGENTS_DIR = path.resolve(process.env.AGENTS_DIR || 'C:/Users/Jennie Chu/Desktop/Projects/crypto-pattern-scanner/agents');
const ALLOWED_FILES = ['AGENTS.md', 'HEARTBEAT.md', 'SOUL.md', 'TOOLS.md'];

const router = Router();

/**
 * GET /api/channels/agent-configs
 * List all agents from agents table (Paperclip Core — SSOT).
 */
router.get('/', async (_req, res) => {
  // Registry Marketplace "Cấu hình Agent LLM" is the chatbot-agent SSOT view.
  // It MUST list only rows from `paperclip_agents` (chatbot configs). The
  // `agents` heartbeat table is a separate domain (autonomous workers) and
  // showing it here confused users into deleting heartbeat workers from the
  // chatbot UI. The two tables only share a `slug` convention, never data.
  const { data: paRows, error } = await supabase
    .from('paperclip_agents')
    .select('*')
    .order('display_name', { ascending: true });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  const mapped = (paRows || []).map((pa: any) => ({
    id: pa.id,
    slug: pa.slug,
    display_name: pa.display_name,
    description: pa.description,
    avatar: pa.avatar,
    provider: pa.provider,
    model: pa.model,
    temperature: pa.temperature != null ? parseFloat(pa.temperature) : 0.7,
    max_tokens: parseInt(pa.max_tokens) || 4096,
    top_p: pa.top_p != null ? parseFloat(pa.top_p) : 1.0,
    system_prompt: pa.system_prompt,
    persona_file: pa.persona_file,
    language: pa.language || 'vi',
    tools: pa.tools || [],
    can_escalate_to: pa.can_escalate_to || [],
    fallback_message: pa.fallback_message || '',
    effort_mode: pa.effort_mode || 'auto',
    max_turns: pa.max_turns != null ? parseInt(pa.max_turns) : 50,
    history_limit: parseInt(pa.history_limit) || 50,
    session_timeout: parseInt(pa.session_timeout) || 1440,
    enabled: pa.enabled,
    conversation_id: pa.conversation_id || null,
    created_at: pa.created_at,
    updated_at: pa.updated_at,
  }));

  res.json(mapped);
});

// ─── Agent Sessions (MUST be before /:slug to avoid param capture) ───

/**
 * GET /api/channels/agent-configs/sessions
 * List all agent sessions (joined with paperclip_agents for display_name/avatar).
 */
router.get('/sessions', async (req, res) => {
  // ?scope=channel (default): only sessions owned by paperclip_agents (27 channel-serving agents).
  //   Excludes batch/content-center work, manual CLI, unknown-gemini disk files.
  // ?scope=all: legacy behaviour, every session materialized from DB + disk.
  const scope = (req.query.scope as string) || 'channel';

  // Pre-fetch channel agent slugs for scope filtering.
  // Falls back to empty set on error → with scope=channel the response is empty,
  // with scope=all the list is unfiltered.
  let channelAgentSlugs = new Set<string>();
  if (scope === 'channel') {
    const { data: paList } = await supabase.from('paperclip_agents').select('slug');
    for (const pa of paList || []) if (pa.slug) channelAgentSlugs.add(pa.slug);
  }
  const passesScope = (slug: string | null | undefined): boolean => {
    if (scope === 'all') return true;
    if (!slug) return false;
    return channelAgentSlugs.has(slug);
  };

  const { data: dbSessions, error } = await supabase
    .from('agent_sessions')
    .select('*')
    .order('started_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  // ALSO scan disk for historical JSONL files that aren't in DB. Older sessions
  // (from when an agent was spawned with cwd=agents/<slug>) live in dedicated
  // project dirs like `*-agents-<slug>/`. Without this scan, those sessions are
  // invisible in the UI even though their logs are intact on disk.
  const dbSessionIds = new Set((dbSessions || []).map((s: any) => s.session_id).filter(Boolean));
  const projectsRoot = path.resolve(os.homedir(), '.claude', 'projects');
  const diskSessions: any[] = [];

  if (fs.existsSync(projectsRoot)) {
    const allDirs = fs.readdirSync(projectsRoot).filter((d) => {
      try { return fs.statSync(path.join(projectsRoot, d)).isDirectory(); } catch { return false; }
    });

    // Convention-driven: any dir matching `-agents-<slug>` is owned by that agent.
    // This is safe — it avoids scanning the shared main project dir where
    // user's own Claude Code sessions live.
    for (const dir of allDirs) {
      const match = dir.match(/-agents-([a-z0-9-]+)$/);
      if (!match) continue;
      const agentSlug = match[1];
      const fullDir = path.join(projectsRoot, dir);
      let files: string[] = [];
      try {
        files = fs.readdirSync(fullDir).filter((f) => f.endsWith('.jsonl'));
      } catch { continue; }

      for (const file of files) {
        const sessionId = file.replace(/\.jsonl$/, '');
        if (dbSessionIds.has(sessionId)) continue; // DB row already covers it
        let mtimeMs = 0; let birthtimeMs = 0;
        try {
          const st = fs.statSync(path.join(fullDir, file));
          mtimeMs = st.mtimeMs;
          birthtimeMs = st.birthtimeMs || st.mtimeMs;
        } catch { continue; }
        diskSessions.push({
          id: sessionId,
          agent_slug: agentSlug,
          session_id: sessionId,
          status: 'stopped',
          started_at: new Date(birthtimeMs).toISOString(),
          last_activity_at: new Date(mtimeMs).toISOString(),
          terminal_type: 'disk-only',
          source: 'disk',
          total_input_tokens: null,
          total_output_tokens: null,
          total_cost_usd: null,
          total_requests: null,
          last_duration_ms: null,
        });
      }
    }
  }

  // Also scan Gemini CLI disk sessions at ~/.gemini/tmp/*/chats/session-*-<short8>.json.
  // These don't follow Claude's `-agents-<slug>` dir convention, so we must match
  // by filename short8 ↔ DB session_id short8 to figure out which agent owns them.
  const geminiRoot = path.resolve(os.homedir(), '.gemini', 'tmp');
  if (fs.existsSync(geminiRoot)) {
    // Build lookup: DB short8 → agent_slug (for Gemini sessions already tracked in DB)
    const short8ToSlug = new Map<string, string>();
    for (const s of (dbSessions || [])) {
      const sid = (s as any).session_id;
      if (sid) short8ToSlug.set(String(sid).substring(0, 8), (s as any).agent_slug);
    }
    const projectDirs = fs.readdirSync(geminiRoot).filter((d) => {
      try { return fs.statSync(path.join(geminiRoot, d)).isDirectory(); } catch { return false; }
    });
    for (const proj of projectDirs) {
      const chatsDir = path.join(geminiRoot, proj, 'chats');
      if (!fs.existsSync(chatsDir)) continue;
      let files: string[] = [];
      try { files = fs.readdirSync(chatsDir).filter((f) => f.startsWith('session-') && f.endsWith('.json')); } catch { continue; }
      for (const file of files) {
        // Filename: session-2026-04-15T15-33-d3caad11.json → short8 = "d3caad11"
        const m = file.match(/-([a-f0-9]{8})\.json$/);
        if (!m) continue;
        const short8 = m[1];
        // Already tracked in DB — don't duplicate
        if (short8ToSlug.has(short8)) continue;
        // Try to read sessionId from file content for full UUID
        let fullSessionId = short8;
        try {
          const raw = fs.readFileSync(path.join(chatsDir, file), 'utf-8');
          const doc = JSON.parse(raw);
          if (doc.sessionId) fullSessionId = doc.sessionId;
        } catch { /* fall back to short8 */ }
        let mtimeMs = 0; let birthtimeMs = 0;
        try {
          const st = fs.statSync(path.join(chatsDir, file));
          mtimeMs = st.mtimeMs;
          birthtimeMs = st.birthtimeMs || st.mtimeMs;
        } catch { continue; }
        diskSessions.push({
          id: fullSessionId,
          agent_slug: 'unknown-gemini',  // Cannot infer slug from file alone
          session_id: fullSessionId,
          status: 'stopped',
          started_at: new Date(birthtimeMs).toISOString(),
          last_activity_at: new Date(mtimeMs).toISOString(),
          terminal_type: 'gemini-disk',
          source: 'gemini-disk',
          total_input_tokens: null,
          total_output_tokens: null,
          total_cost_usd: null,
          total_requests: null,
          last_duration_ms: null,
        });
      }
    }
  }

  // Apply scope filter to BOTH DB rows and disk-materialized rows.
  const filteredDb = (dbSessions || []).filter((s: any) => passesScope(s.agent_slug));
  const filteredDisk = diskSessions.filter((s: any) => passesScope(s.agent_slug));

  const sessions = [...filteredDb, ...filteredDisk]
    .sort((a: any, b: any) => {
      const ta = new Date(a.started_at || 0).getTime();
      const tb = new Date(b.started_at || 0).getTime();
      return tb - ta;
    });

  if (sessions.length === 0) {
    return res.json([]);
  }

  // Fetch agent info for display_name / avatar
  const slugs = [...new Set(sessions.map((s: any) => s.agent_slug).filter(Boolean))];
  let agentMap: Record<string, { display_name: string; avatar: string | null; model: string | null; provider: string | null }> = {};

  if (slugs.length > 0) {
    const { data: agents } = await supabase
      .from('paperclip_agents')
      .select('slug, display_name, avatar, model, provider')
      .in('slug', slugs);

    if (agents) {
      for (const a of agents) {
        agentMap[a.slug] = { display_name: a.display_name, avatar: a.avatar, model: a.model, provider: a.provider };
      }
    }
  }

  // Fetch channel info — which channel(s) use each agent
  const { data: channels } = await supabase
    .from('channel_instances')
    .select('name, display_name, agent_slug, status, channel_type')
    .in('agent_slug', slugs);

  const channelMap: Record<string, Array<{ name: string; display_name: string | null; status: string; channel_type: string }>> = {};
  for (const ch of channels || []) {
    if (!ch.agent_slug) continue;
    if (!channelMap[ch.agent_slug]) channelMap[ch.agent_slug] = [];
    channelMap[ch.agent_slug].push({ name: ch.name, display_name: ch.display_name, status: ch.status, channel_type: ch.channel_type });
  }

  const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
  const now = Date.now();

  const enriched = sessions.map((s: any) => {
    // Auto-detect stale: if status=running but last_activity > 5 min ago, mark as idle
    let effectiveStatus = s.status;
    if (s.status === 'running' && s.last_activity_at) {
      const lastActive = new Date(s.last_activity_at).getTime();
      if (now - lastActive > STALE_THRESHOLD_MS) {
        effectiveStatus = 'idle';
      }
    }

    return {
      ...s,
      status: effectiveStatus,
      display_name: agentMap[s.agent_slug]?.display_name ?? s.agent_slug,
      avatar: agentMap[s.agent_slug]?.avatar ?? null,
      model: agentMap[s.agent_slug]?.model ?? null,
      provider: agentMap[s.agent_slug]?.provider ?? null,
      channels: channelMap[s.agent_slug] || [],
    };
  });

  res.json(enriched);
});

/**
 * POST /api/channels/agent-configs/sessions/clear-all
 * Delete all agent sessions.
 */
router.post('/sessions/clear-all', async (_req, res) => {
  const { error } = await supabase
    .from('agent_sessions')
    .delete()
    .neq('id', '00000000-0000-0000-0000-000000000000'); // delete all rows

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true, message: 'All sessions cleared' });
});

/**
 * POST /api/channels/agent-configs/sessions/:slug/clear
 * Delete sessions for a specific agent slug.
 */
router.post('/sessions/:slug/clear', async (req, res) => {
  const { slug } = req.params;

  const { error } = await supabase
    .from('agent_sessions')
    .delete()
    .eq('agent_slug', slug);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true, slug });
});

/**
 * GET /api/channels/agent-configs/sessions/:slug/log
 * Returns parsed/pretty events from the agent's Claude CLI session JSONL file.
 *
 * Flow:
 *   1. Look up the agent's session_id from agent_sessions table
 *   2. Find the matching JSONL file under ~/.claude/projects/<encoded-project>/
 *   3. Parse last N lines and return as structured events
 *
 * Query params:
 *   ?limit=100   How many events to return (default 100, max 500)
 *   ?session_id=<uuid>  Specific session to load (else uses active one from DB)
 */
router.get('/sessions/:slug/log', async (req, res) => {
  let { slug } = req.params;
  const limitRaw = parseInt(String(req.query.limit || '100'), 10);
  const limit = Math.max(1, Math.min(500, isNaN(limitRaw) ? 100 : limitRaw));
  const explicitSessionId = typeof req.query.session_id === 'string' ? req.query.session_id : null;

  try {
    // Resolve URL slug → paperclip_agents.slug (same logic as activity endpoint)
    const { data: paCheck } = await supabase.from('paperclip_agents').select('slug').eq('slug', slug).maybeSingle();
    if (!paCheck) {
      const { data: agentRow } = await supabase.from('agents').select('slug').eq('slug', slug).maybeSingle();
      if (agentRow?.slug) {
        slug = agentRow.slug;
      } else {
        const { data: allPa } = await supabase.from('paperclip_agents').select('slug, display_name');
        const match = (allPa || []).find((pa: any) => {
          const derived = (pa.display_name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
          return derived === slug;
        });
        if (match) slug = match.slug;
      }
    }

    // Resolve session_id
    let sessionId = explicitSessionId;
    if (!sessionId) {
      const { data: sessRow } = await supabase
        .from('agent_sessions')
        .select('session_id, started_at, status')
        .eq('agent_slug', slug)
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (sessRow?.session_id) {
        sessionId = sessRow.session_id;
      }
    }

    // Sessions may be stored in TWO different places depending on provider:
    //   1. Claude CLI: ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl (line-per-event)
    //   2. Gemini CLI: ~/.gemini/tmp/<project>/chats/session-<ISO>-<short8>.json (single JSON object)
    // We resolve the file by trying Claude first, then Gemini (matching first 8 chars
    // of the UUID to the filename suffix).
    const claudeRoot = path.resolve(os.homedir(), '.claude', 'projects');
    const geminiRoot = path.resolve(os.homedir(), '.gemini', 'tmp');

    // Helper: find Claude JSONL by exact sessionId across all project dirs
    const findClaudeJsonl = (sid: string): string | null => {
      if (!fs.existsSync(claudeRoot)) return null;
      const dirs = fs.readdirSync(claudeRoot).filter((d) => {
        try { return fs.statSync(path.join(claudeRoot, d)).isDirectory(); } catch { return false; }
      });
      for (const dir of dirs) {
        const candidate = path.join(claudeRoot, dir, `${sid}.jsonl`);
        if (fs.existsSync(candidate)) return candidate;
      }
      return null;
    };

    // Helper: find Gemini JSON by matching short8 suffix in any project's chats dir
    const findGeminiJson = (sid: string): string | null => {
      if (!fs.existsSync(geminiRoot)) return null;
      const short8 = sid.substring(0, 8);
      const projectDirs = fs.readdirSync(geminiRoot).filter((d) => {
        try { return fs.statSync(path.join(geminiRoot, d)).isDirectory(); } catch { return false; }
      });
      for (const proj of projectDirs) {
        const chatsDir = path.join(geminiRoot, proj, 'chats');
        if (!fs.existsSync(chatsDir)) continue;
        let files: string[] = [];
        try { files = fs.readdirSync(chatsDir); } catch { continue; }
        const hit = files.find((f) => f.endsWith(`-${short8}.json`));
        if (hit) return path.join(chatsDir, hit);
      }
      return null;
    };

    // Helper: newest Claude JSONL for agent (disk convention `-agents-<slug>`)
    const findNewestClaudeForSlug = (targetSlug: string): { file: string; sessionId: string } | null => {
      if (!fs.existsSync(claudeRoot)) return null;
      const allDirs = fs.readdirSync(claudeRoot).filter((d) => {
        try { return fs.statSync(path.join(claudeRoot, d)).isDirectory(); } catch { return false; }
      });
      const agentDirs = allDirs.filter((d) => d.endsWith(`-agents-${targetSlug}`));
      let newest: { file: string; sessionId: string; mtime: number } | null = null;
      for (const dir of agentDirs) {
        const fullDir = path.join(claudeRoot, dir);
        let files: string[] = [];
        try { files = fs.readdirSync(fullDir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
        for (const f of files) {
          try {
            const mtime = fs.statSync(path.join(fullDir, f)).mtimeMs;
            if (!newest || mtime > newest.mtime) {
              newest = { file: path.join(fullDir, f), sessionId: f.replace(/\.jsonl$/, ''), mtime };
            }
          } catch { /* skip */ }
        }
      }
      return newest ? { file: newest.file, sessionId: newest.sessionId } : null;
    };

    let targetFile: string | null = null;
    let fileKind: 'claude-jsonl' | 'gemini-json' | null = null;

    if (sessionId) {
      // Try Claude JSONL first, then Gemini JSON for this exact sessionId
      targetFile = findClaudeJsonl(sessionId);
      if (targetFile) fileKind = 'claude-jsonl';
      if (!targetFile) {
        targetFile = findGeminiJson(sessionId);
        if (targetFile) fileKind = 'gemini-json';
      }
      if (!targetFile) {
        return res.json({
          slug,
          sessionId,
          events: [],
          error: `Session ${sessionId.substring(0, 8)}… not found in Claude or Gemini dirs. DB row may be stale or provider logs differently.`,
        });
      }
    } else {
      // No DB session → try newest Claude disk session (Gemini doesn't follow disk convention)
      const diskHit = findNewestClaudeForSlug(slug);
      if (diskHit) {
        targetFile = diskHit.file;
        sessionId = diskHit.sessionId;
        fileKind = 'claude-jsonl';
      } else {
        return res.json({
          slug,
          sessionId: null,
          events: [],
          error: 'No session found for agent (no DB row and no JSONL files on disk).',
        });
      }
    }

    // Parse based on file kind
    const events: any[] = [];
    let totalLines = 0;
    let returnedLines = 0;

    if (fileKind === 'claude-jsonl') {
      const raw = fs.readFileSync(targetFile, 'utf-8');
      const allLines = raw.split('\n').filter((l) => l.trim());
      const lines = allLines.slice(-limit);
      totalLines = allLines.length;
      returnedLines = lines.length;
      for (const line of lines) {
        try {
          const d = JSON.parse(line);
          const event = extractEvent(d);
          if (event) events.push(event);
        } catch { /* skip */ }
      }
    } else if (fileKind === 'gemini-json') {
      try {
        const raw = fs.readFileSync(targetFile, 'utf-8');
        const doc = JSON.parse(raw);
        const messages = Array.isArray(doc.messages) ? doc.messages : [];
        totalLines = messages.length;
        const sliced = messages.slice(-limit);
        returnedLines = sliced.length;
        for (const m of sliced) {
          const event = geminiMessageToEvent(m);
          if (event) events.push(event);
        }
      } catch (err: any) {
        return res.json({ slug, sessionId, events: [], error: `Gemini parse failed: ${err.message}` });
      }
    }

    res.json({
      slug,
      sessionId,
      file: path.basename(targetFile),
      fileKind,
      totalLines,
      returnedLines,
      events,
    });
  } catch (err: any) {
    console.error(`[AgentLog] Error for ${slug}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Extract a structured event from 1 JSONL record — compatible with
 * ~/claude-log-pretty.py parser (same fields: kind, text, tool name, hook, etc.)
 */
function extractEvent(d: any): any | null {
  const t = d.type;
  const msg = d.message && typeof d.message === 'object' ? d.message : {};

  if (t === 'user') {
    const content = msg.content ?? d.content ?? '';
    const parsed = extractContentBlocks(content);
    const text = parsed.text;
    const result = parsed.result;
    if (result) return { kind: 'result', text: result, ts: d.timestamp };
    if (text) return { kind: 'user', text, ts: d.timestamp };
    return null;
  }

  if (t === 'assistant') {
    const parsed = extractContentBlocks(msg.content);
    return {
      kind: 'assistant',
      thinking: parsed.thinking,
      thinkingRedacted: parsed.thinkingRedacted,
      text: parsed.text,
      tools: parsed.tools,
      ts: d.timestamp,
    };
  }

  if (t === 'attachment') {
    const att = d.attachment;
    if (att && typeof att === 'object' && String(att.type || '').includes('hook')) {
      return {
        kind: 'hook',
        name: att.hookName || '?',
        event: att.hookEvent || '',
        exitCode: att.exitCode || 0,
        durationMs: att.durationMs || 0,
        command: att.command || '',
        stdout: att.stdout || '',
        ts: d.timestamp,
      };
    }
  }

  return null;
}

/**
 * Convert a single Gemini CLI session message to a LogEvent.
 * Gemini format: { id, timestamp, type: 'user'|'gemini', content: string | [{text}] }
 * No tool_use/thinking blocks in this format — Gemini CLI stores them elsewhere.
 */
function geminiMessageToEvent(m: any): any | null {
  if (!m || typeof m !== 'object') return null;
  const ts = m.timestamp;
  const content = m.content;
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content.map((c: any) => (c && typeof c === 'object' && c.text) || '').join('');
  } else if (content && typeof content === 'object' && content.text) {
    text = content.text;
  }
  if (!text) return null;
  if (m.type === 'user') return { kind: 'user', text, ts };
  if (m.type === 'gemini' || m.type === 'model' || m.type === 'assistant') {
    return { kind: 'assistant', text, ts };
  }
  return null;
}

function extractContentBlocks(content: any): {
  text: string;
  thinking: string;
  thinkingRedacted: boolean;
  tools: any[];
  result: string;
} {
  const out = { text: '', thinking: '', thinkingRedacted: false, tools: [] as any[], result: '' };
  if (content == null) return out;
  if (typeof content === 'string') {
    out.text = content;
    return out;
  }
  if (!Array.isArray(content)) {
    out.text = String(content);
    return out;
  }
  const textParts: string[] = [];
  const thinkParts: string[] = [];
  const resultParts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const bt = b.type;
    if (bt === 'text' && b.text) textParts.push(b.text);
    else if (bt === 'thinking') {
      if (b.thinking) thinkParts.push(b.thinking);
      else if (b.signature) out.thinkingRedacted = true;
    } else if (bt === 'redacted_thinking') {
      out.thinkingRedacted = true;
    } else if (bt === 'tool_use') {
      out.tools.push({ name: b.name || '?', input: b.input || {} });
    } else if (bt === 'tool_result') {
      let r = b.content || '';
      if (Array.isArray(r)) {
        r = r.map((x: any) => (typeof x === 'object' && x?.text) || '').join(' ');
      }
      resultParts.push(String(r));
    } else if (bt === 'image') {
      textParts.push('[IMAGE]');
    }
  }
  out.text = textParts.join(' ');
  out.thinking = thinkParts.join('\n');
  out.result = resultParts.join('\n');
  return out;
}

/**
 * GET /api/channels/agent-configs/sessions/activity
 * Recent consumer activity — messages handled by agents.
 */
router.get('/sessions/activity', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 300, 1000);
  const perTableLimit = Math.ceil(limit * 0.6); // generous per-table budget
  // Fetch recent activity from BOTH pending_messages (inbound handled) and sent_messages (outbound)
  const [{ data: handled }, { data: sent }] = await Promise.all([
    supabase
      .from('channel_pending_messages')
      .select('id, channel_name, thread_id, from_uid, sender_name, body, status, agent_slug, handled_by, handled_at, created_at, customer_id')
      .not('handled_by', 'is', null)
      .order('handled_at', { ascending: false })
      .limit(perTableLimit),
    supabase
      .from('channel_sent_messages')
      .select('id, channel_name, thread_id, to_uid, body, status, sent_by, created_at')
      .in('status', ['sent', 'failed', 'archived'])
      .order('created_at', { ascending: false })
      .limit(perTableLimit),
  ]);

  // Resolve customer names from crm_customers
  const customerIds = new Set<string>();
  for (const m of handled || []) if (m.customer_id) customerIds.add(m.customer_id);
  const customerNameMap = new Map<string, string>();
  if (customerIds.size > 0) {
    const { data: customers } = await supabase
      .from('crm_customers')
      .select('id, display_name')
      .in('id', [...customerIds]);
    for (const c of customers || []) {
      if (c.display_name) customerNameMap.set(c.id, c.display_name);
    }
  }

  // Fetch channel display names for mapping
  const allChannelNames = new Set<string>();
  for (const m of handled || []) allChannelNames.add(m.channel_name);
  for (const m of sent || []) allChannelNames.add(m.channel_name);

  const channelDisplayMap = new Map<string, string>();
  if (allChannelNames.size > 0) {
    const { data: channels } = await supabase
      .from('channel_instances')
      .select('name, display_name')
      .in('name', [...allChannelNames]);
    for (const ch of channels || []) {
      if (ch.display_name) channelDisplayMap.set(ch.name, ch.display_name);
    }
  }

  // Merge into unified activity log
  const activity = [
    ...(handled || []).map((m: any) => ({
      id: m.id,
      type: 'inbound' as const,
      channel_name: channelDisplayMap.get(m.channel_name) || m.channel_name,
      channel_raw: m.channel_name,
      thread_id: m.thread_id,
      sender_id: m.from_uid,
      sender_name: m.sender_name,
      customer_name: m.customer_id ? customerNameMap.get(m.customer_id) || null : null,
      body: m.body,
      status: m.status === 'handled' ? 'done' : m.status,
      handled_by: m.agent_slug || (m.handled_by !== 'consumer' ? m.handled_by : null) || 'skipped',
      handled_at: m.handled_at || m.created_at,
      message: m.body?.substring(0, 100),
    })),
    ...(sent || []).map((m: any) => ({
      id: m.id,
      type: 'outbound' as const,
      channel_name: channelDisplayMap.get(m.channel_name) || m.channel_name,
      channel_raw: m.channel_name,
      thread_id: m.thread_id,
      sender_id: m.to_uid,
      sender_name: (!m.sent_by || isHumanSent(m.sent_by)) ? 'Manual' : `Agent: ${m.sent_by}`,
      body: m.body,
      status: m.status === 'sent' ? 'done' : m.status,
      handled_by: m.sent_by,
      handled_at: m.created_at,
      message: m.body?.substring(0, 100),
    })),
  ].sort((a, b) => (b.handled_at || '').localeCompare(a.handled_at || ''))
   .slice(0, limit);

  res.json(activity);
});

// ─── Agent-specific Activity Log ────────────────────────────────────

/**
 * GET /api/channels/agent-configs/:slug/activity
 * Activity log for a specific agent — inbound messages handled + outbound sent + follow-ups.
 * Used by the "Nhật ký" tab in agent detail page.
 */
router.get('/:slug/activity', async (req, res) => {
  let { slug } = req.params;
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);

  // Resolve: URL key (e.g. "gi-m-c-i-u-h-nh") → paperclip_agents.slug ("ceo")
  // channel tables use paperclip_agents.slug, but UI passes the URL-derived slug
  const { data: paCheck } = await supabase.from('paperclip_agents').select('slug').eq('slug', slug).maybeSingle();
  if (!paCheck) {
    // Try matching via agents table: agents.slug often matches paperclip_agents.slug
    // but URL key is derived from agent name, so look up by agents table slug first
    const { data: agentRow } = await supabase.from('agents').select('slug').eq('slug', slug).maybeSingle();
    if (agentRow?.slug) {
      // agents.slug = paperclip_agents.slug for known agents
      slug = agentRow.slug;
    } else {
      // Last resort: scan paperclip_agents for a display_name-derived match
      const { data: allPa } = await supabase.from('paperclip_agents').select('slug, display_name');
      const match = (allPa || []).find((pa: any) => {
        const derived = (pa.display_name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        return derived === slug;
      });
      if (match) slug = match.slug;
    }
  }

  const [{ data: handled }, { data: sent }, { data: followups }] = await Promise.all([
    supabase
      .from('channel_pending_messages')
      .select('id, channel_name, thread_id, from_uid, sender_name, body, status, agent_slug, handled_by, handled_at, created_at, customer_id')
      .eq('agent_slug', slug)
      .not('handled_by', 'is', null)
      .order('handled_at', { ascending: false })
      .limit(limit),
    supabase
      .from('channel_sent_messages')
      .select('id, channel_name, thread_id, to_uid, body, status, sent_by, created_at')
      .eq('sent_by', slug)
      .in('status', ['sent', 'failed', 'archived'])
      .order('created_at', { ascending: false })
      .limit(limit),
    supabase
      .from('follow_up_queue')
      .select('id, customer_id, agent_slug, message, scheduled_at, status, created_at')
      .eq('agent_slug', slug)
      .order('created_at', { ascending: false })
      .limit(50),
  ]);

  // Resolve customer + channel names
  const customerIds = new Set<string>();
  for (const m of handled || []) if (m.customer_id) customerIds.add(m.customer_id);
  for (const f of followups || []) if (f.customer_id) customerIds.add(f.customer_id);
  const customerMap = new Map<string, string>();
  if (customerIds.size > 0) {
    const { data: customers } = await supabase.from('crm_customers').select('id, display_name').in('id', [...customerIds]);
    for (const c of customers || []) if (c.display_name) customerMap.set(c.id, c.display_name);
  }

  const channelNames = new Set<string>();
  for (const m of handled || []) channelNames.add(m.channel_name);
  for (const m of sent || []) channelNames.add(m.channel_name);
  const channelMap = new Map<string, string>();
  if (channelNames.size > 0) {
    const { data: channels } = await supabase.from('channel_instances').select('name, display_name').in('name', [...channelNames]);
    for (const ch of channels || []) if (ch.display_name) channelMap.set(ch.name, ch.display_name);
  }

  const activity = [
    ...(handled || []).map((m: any) => ({
      id: m.id,
      kind: 'inbound' as const,
      channel: channelMap.get(m.channel_name) || m.channel_name,
      channel_raw: m.channel_name,
      sender: m.sender_name || m.from_uid || '—',
      customer_name: m.customer_id ? customerMap.get(m.customer_id) || null : null,
      body: m.body,
      preview: m.body?.substring(0, 150),
      status: m.status === 'handled' ? 'done' : m.status,
      ts: m.handled_at || m.created_at,
    })),
    ...(sent || []).map((m: any) => ({
      id: m.id,
      kind: 'outbound' as const,
      channel: channelMap.get(m.channel_name) || m.channel_name,
      channel_raw: m.channel_name,
      sender: null,
      customer_name: null,
      body: m.body,
      preview: m.body?.substring(0, 150),
      status: m.status === 'sent' ? 'done' : m.status,
      ts: m.created_at,
    })),
    ...(followups || []).map((f: any) => ({
      id: f.id,
      kind: 'follow-up' as const,
      channel: null,
      channel_raw: null,
      sender: null,
      customer_name: f.customer_id ? customerMap.get(f.customer_id) || null : null,
      body: f.message,
      preview: f.message?.substring(0, 150),
      status: f.status,
      ts: f.scheduled_at || f.created_at,
    })),
  ].sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));

  res.json({ slug, total: activity.length, items: activity });
});

// ─── Per-Customer Chat History ──────────────────────────────────────

/**
 * GET /api/channels/agent-configs/:slug/chat-history
 * Full chat history with a specific customer for this agent.
 * Reads channel_sessions.history JSONB (already persisted by session.appendMessage).
 *
 * Query params:
 *   - session_key (preferred — unique per customer×channel thread)
 *   OR
 *   - channel_name + sender_id (compose lookup)
 *
 *   Optional:
 *   - search: substring filter on message content
 *   - from / to: ISO date range filter on message timestamp
 *
 * Response: { slug, agent_display_name, channel, customer, totalMessages, messages: [...] }
 */
router.get('/:slug/chat-history', async (req, res) => {
  let { slug } = req.params;
  const session_key = (req.query.session_key as string | undefined)?.trim();
  const channel_name = (req.query.channel_name as string | undefined)?.trim();
  const sender_id = (req.query.sender_id as string | undefined)?.trim();
  const search = (req.query.search as string | undefined)?.trim().toLowerCase();
  const fromStr = req.query.from as string | undefined;
  const toStr = req.query.to as string | undefined;

  if (!session_key && !(channel_name && sender_id)) {
    return res.status(400).json({ error: 'session_key OR (channel_name + sender_id) required', messages: [] });
  }

  // Resolve URL slug → paperclip_agents.slug (same as /:slug/activity)
  let paRow: any = null;
  const { data: paCheck } = await supabase
    .from('paperclip_agents')
    .select('slug, display_name, provider, model')
    .eq('slug', slug)
    .maybeSingle();
  paRow = paCheck;
  if (!paRow) {
    const { data: agentRow } = await supabase.from('agents').select('slug').eq('slug', slug).maybeSingle();
    if (agentRow?.slug) {
      slug = agentRow.slug;
      const { data } = await supabase
        .from('paperclip_agents')
        .select('slug, display_name, provider, model')
        .eq('slug', slug)
        .maybeSingle();
      paRow = data;
    } else {
      const { data: allPa } = await supabase
        .from('paperclip_agents')
        .select('slug, display_name, provider, model');
      const match = (allPa || []).find((pa: any) => {
        const derived = (pa.display_name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        return derived === slug;
      });
      if (match) {
        slug = match.slug;
        paRow = match;
      }
    }
  }
  if (!paRow) {
    return res.status(404).json({ error: 'Agent not found', messages: [] });
  }

  // Lookup session row
  let q = supabase.from('channel_sessions').select('*').eq('agent_slug', slug);
  if (session_key) {
    q = q.eq('session_key', session_key);
  } else {
    q = q.eq('channel_name', channel_name!).eq('sender_id', sender_id!);
  }
  const { data: sessionRow, error: sessErr } = await q.maybeSingle();

  if (sessErr) {
    return res.status(500).json({ error: sessErr.message, messages: [] });
  }
  if (!sessionRow) {
    return res.json({
      slug,
      agent_display_name: paRow.display_name,
      agent_provider: paRow.provider,
      agent_model: paRow.model,
      session_key: session_key || null,
      channel: null,
      customer: null,
      totalMessages: 0,
      fullHistoryCount: 0,
      messages: [],
      error: 'No session found for this customer/channel pair',
    });
  }

  // Join crm_customers if linked
  let customerData: any = null;
  if (sessionRow.customer_id) {
    const { data: c } = await supabase
      .from('crm_customers')
      .select('id, display_name, status, lead_score, lead_temperature, total_orders, total_revenue, first_contact_at')
      .eq('id', sessionRow.customer_id)
      .maybeSingle();
    customerData = c;
  }

  // Resolve channel display name + platform
  let channelDisplayName: string | null = null;
  let channelPlatform: string | null = null;
  if (sessionRow.channel_name) {
    const { data: chInst } = await supabase
      .from('channel_instances')
      .select('display_name, channel_type')
      .eq('name', sessionRow.channel_name)
      .maybeSingle();
    channelDisplayName = chInst?.display_name || null;
    channelPlatform = chInst?.channel_type || sessionRow.channel_name.split('-')[0] || null;
  }

  // Normalize + filter messages
  let history: any[] = Array.isArray(sessionRow.history) ? sessionRow.history : [];
  const fullHistoryCount = history.length;

  // STEP 1: Strip context-injection prefix from user messages.
  // router.ts prepends CRM context blocks like:
  //   [HỒ SƠ KHÁCH HÀNG — JN]
  //   • Trạng thái: ... | Lead: ...
  //   • SĐT: ...
  //   [TÓM TẮT AI] ...
  //   [HƯỚNG DẪN TOOLS] ...
  //   [PURCHASE JOURNEY STATE] ...
  //   [TIN NHẮN MỚI]
  //   <actual customer message>
  // into user content (persisted verbatim by session.appendMessage).
  // Extract only the part after [TIN NHẮN MỚI]. Context-only rows with NO
  // [TIN NHẮN MỚI] section (older format) get their full content replaced
  // with an explanatory placeholder so the user row isn't missing.
  const TIN_NHAN_MOI_RE = /\[TIN\s+NH[ẮA]N\s+M[ỚO]I\]\s*\n?/i;
  history = history.map((m: any) => {
    if (m.role !== 'user') return m;
    const c = (m.content || '').trim();
    // Only injected-context messages start with `[HỒ SƠ`; a real customer message that
    // merely starts with `[` (e.g. `[Hình ảnh]`) must NOT be stripped/dropped.
    if (!c.startsWith('[HỒ SƠ') && !TIN_NHAN_MOI_RE.test(c)) return m;
    const match = c.match(TIN_NHAN_MOI_RE);
    if (match && match.index !== undefined) {
      const real = c.slice(match.index + match[0].length).trim();
      return { ...m, content: real || c, _hadContextPrefix: true };
    }
    // No [TIN NHẮN MỚI] marker — leave content but flag for UI to style as context
    return { ...m, _contextOnly: true };
  });
  // Drop context-only user rows that have NO real message after stripping —
  // these are pure CRM-context pseudo-messages from older format.
  history = history.filter((m: any) => !m._contextOnly);
  const contextStrippedCount = history.filter((m: any) => m._hadContextPrefix).length;
  if (contextStrippedCount > 0) {
    console.log(`[chat-history] ${slug} ${sessionRow.session_key}: stripped context prefix from ${contextStrippedCount} user messages`);
  }

  // STEP 2: Dedupe near-simultaneous duplicate writes.
  // Consumer/router has a writer bug (BUG-047, v2 fix pending):
  //   - Assistant replies persisted twice (~300ms apart)
  //   - User messages persisted twice: once raw (consumer.ts) + once enriched
  //     (some other path), which after prefix-strip look identical.
  // Dedupe window: 2s for same role+content (catches millisec duplicates).
  // Wider window: 5 minutes for user role if the duplicate carries the
  // "_hadContextPrefix" flag (enriched re-write from context-builder path).
  const deduped: any[] = [];
  for (const m of history) {
    const last = deduped[deduped.length - 1];
    if (last && last.role === m.role && last.content === m.content) {
      const dt = Math.abs(
        new Date(last.timestamp || 0).getTime() - new Date(m.timestamp || 0).getTime()
      );
      const windowMs = (m.role === 'user' && (m._hadContextPrefix || last._hadContextPrefix))
        ? 5 * 60 * 1000  // 5min window for enriched user dupes
        : 2000;          // 2s window for regular writer dupes
      if (dt < windowMs) continue;
    }
    deduped.push(m);
  }
  history = deduped;

  // STEP 3: Apply user filters
  if (search) {
    history = history.filter((m: any) => typeof m.content === 'string' && m.content.toLowerCase().includes(search));
  }
  if (fromStr) {
    const fromTs = new Date(fromStr).getTime();
    if (Number.isFinite(fromTs)) {
      history = history.filter((m: any) => new Date(m.timestamp || 0).getTime() >= fromTs);
    }
  }
  if (toStr) {
    const toTs = new Date(toStr).getTime();
    if (Number.isFinite(toTs)) {
      history = history.filter((m: any) => new Date(m.timestamp || 0).getTime() <= toTs);
    }
  }

  const messages = history.map((m: any, idx: number) => ({
    id: `${sessionRow.session_key}:${idx}`,
    role: m.role === 'user' ? 'customer' : 'agent',
    content: m.content || '',
    senderName: m.senderName || (m.role === 'user' ? sessionRow.sender_name : paRow.display_name),
    timestamp: m.timestamp || null,
    metadata: m.metadata || null,
  }));

  return res.json({
    slug,
    agent_display_name: paRow.display_name,
    agent_provider: paRow.provider,
    agent_model: paRow.model,
    session_key: sessionRow.session_key,
    channel: {
      name: sessionRow.channel_name,
      display_name: channelDisplayName || sessionRow.channel_name,
      platform: channelPlatform,
    },
    customer: {
      customer_id: sessionRow.customer_id,
      sender_id: sessionRow.sender_id,
      sender_name: customerData?.display_name || sessionRow.sender_name || sessionRow.sender_id,
      stage: customerData?.status || null,
      lead_score: customerData?.lead_score ?? null,
      lead_temperature: customerData?.lead_temperature ?? null,
      total_orders: customerData?.total_orders ?? null,
      total_revenue: customerData?.total_revenue ?? null,
      first_contact_at: customerData?.first_contact_at || sessionRow.created_at,
    },
    totalMessages: messages.length,
    fullHistoryCount,
    lastMessageAt: sessionRow.last_message_at,
    messages,
  });
});

// ─── Per-Agent Session Files (browse JSONL disk) ────────────────────

/**
 * GET /api/channels/agent-configs/:slug/session-files
 * Lists ALL session JSONL files on disk for a given agent slug.
 * Returns both Claude (~/.claude/projects/*-agents-<slug>/*.jsonl) and Gemini
 * (~/.gemini/tmp/...) sessions with metadata for browsing inside the chat drawer.
 *
 * Query params:
 *   - from / to: ISO date range (filter by file mtime)
 *   - limit: default 100, max 500
 */
router.get('/:slug/session-files', async (req, res) => {
  let { slug } = req.params;
  const fromStr = req.query.from as string | undefined;
  const toStr = req.query.to as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);

  // Slug resolution (reuse pattern from other endpoints)
  const { data: paCheck } = await supabase.from('paperclip_agents').select('slug').eq('slug', slug).maybeSingle();
  if (!paCheck) {
    const { data: agentRow } = await supabase.from('agents').select('slug').eq('slug', slug).maybeSingle();
    if (agentRow?.slug) {
      slug = agentRow.slug;
    } else {
      const { data: allPa } = await supabase.from('paperclip_agents').select('slug, display_name');
      const match = (allPa || []).find((pa: any) => {
        const derived = (pa.display_name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        return derived === slug;
      });
      if (match) slug = match.slug;
    }
  }

  const fromTs = fromStr ? new Date(fromStr).getTime() : 0;
  const toTs = toStr ? new Date(toStr).getTime() : Number.MAX_SAFE_INTEGER;
  const inRange = (ms: number) => ms >= fromTs && ms <= toTs;

  const files: Array<{
    session_id: string;
    short_id: string;
    fileKind: 'claude-jsonl' | 'gemini-json';
    file_path: string;
    started_at: string;
    last_activity_at: string;
    turn_count: number;
    first_user_snippet: string | null;
    size_bytes: number;
  }> = [];

  // Claude scan: ~/.claude/projects/*-agents-<slug>/*.jsonl
  const projectsRoot = path.resolve(os.homedir(), '.claude', 'projects');
  if (fs.existsSync(projectsRoot)) {
    const dirs = fs.readdirSync(projectsRoot).filter((d) => {
      try {
        const m = d.match(/-agents-([a-z0-9-]+)$/);
        return m && m[1] === slug && fs.statSync(path.join(projectsRoot, d)).isDirectory();
      } catch { return false; }
    });
    for (const dir of dirs) {
      const fullDir = path.join(projectsRoot, dir);
      let fileNames: string[] = [];
      try { fileNames = fs.readdirSync(fullDir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
      for (const fn of fileNames) {
        const fp = path.join(fullDir, fn);
        try {
          const st = fs.statSync(fp);
          if (!inRange(st.mtimeMs)) continue;
          // Quick line count + first user snippet (read first ~4KB only)
          let turn_count = 0;
          let first_user_snippet: string | null = null;
          try {
            const buf = fs.readFileSync(fp, { encoding: 'utf-8' });
            const lines = buf.split('\n').filter(Boolean);
            turn_count = lines.length;
            for (const line of lines.slice(0, 50)) {
              try {
                const ev = JSON.parse(line);
                const content = ev?.message?.content || ev?.content;
                if (ev?.type === 'user' || ev?.role === 'user') {
                  const text = typeof content === 'string' ? content : (Array.isArray(content) ? content.map((c: any) => c?.text || '').join(' ') : '');
                  if (text && text.length > 10) {
                    first_user_snippet = text.replace(/\[(TIN NHẮN MỚI|HỒ SƠ|Khách:|TÓM TẮT AI|HƯỚNG DẪN TOOLS|PURCHASE JOURNEY STATE).*?\]/gs, '').trim().slice(0, 120);
                    if (first_user_snippet) break;
                  }
                }
              } catch { /* skip malformed line */ }
            }
          } catch { /* keep defaults */ }
          files.push({
            session_id: fn.replace(/\.jsonl$/, ''),
            short_id: fn.slice(0, 8),
            fileKind: 'claude-jsonl',
            file_path: fp,
            started_at: new Date(st.birthtimeMs || st.mtimeMs).toISOString(),
            last_activity_at: new Date(st.mtimeMs).toISOString(),
            turn_count,
            first_user_snippet,
            size_bytes: st.size,
          });
        } catch { /* skip unreadable file */ }
      }
    }
  }

  // Gemini scan: ~/.gemini/tmp/**/chats/session-*-<short8>.json
  // Cross-ref with agent_sessions DB for slug attribution (short8 → slug).
  const geminiRoot = path.resolve(os.homedir(), '.gemini', 'tmp');
  if (fs.existsSync(geminiRoot)) {
    const { data: dbSessions } = await supabase
      .from('agent_sessions')
      .select('session_id, agent_slug')
      .eq('agent_slug', slug);
    const short8Set = new Set<string>();
    for (const s of dbSessions || []) {
      if (s.session_id) short8Set.add(String(s.session_id).substring(0, 8));
    }
    const projDirs = fs.readdirSync(geminiRoot).filter((d) => {
      try { return fs.statSync(path.join(geminiRoot, d)).isDirectory(); } catch { return false; }
    });
    for (const proj of projDirs) {
      const chatsDir = path.join(geminiRoot, proj, 'chats');
      if (!fs.existsSync(chatsDir)) continue;
      let fileNames: string[] = [];
      try { fileNames = fs.readdirSync(chatsDir).filter((f) => f.startsWith('session-') && f.endsWith('.json')); } catch { continue; }
      for (const fn of fileNames) {
        const m = fn.match(/-([a-f0-9]{8})\.json$/);
        if (!m) continue;
        const short8 = m[1];
        if (!short8Set.has(short8)) continue; // only surface Gemini sessions owned by this agent
        const fp = path.join(chatsDir, fn);
        try {
          const st = fs.statSync(fp);
          if (!inRange(st.mtimeMs)) continue;
          let fullSessionId = short8;
          let turn_count = 0;
          let first_user_snippet: string | null = null;
          try {
            const raw = fs.readFileSync(fp, 'utf-8');
            const doc = JSON.parse(raw);
            if (doc.sessionId) fullSessionId = doc.sessionId;
            if (Array.isArray(doc.messages)) {
              turn_count = doc.messages.length;
              const firstUser = doc.messages.find((m: any) => m?.type === 'user' && typeof m.content === 'string' && m.content.length > 10);
              if (firstUser) {
                first_user_snippet = String(firstUser.content).replace(/\[(TIN NHẮN MỚI|HỒ SƠ|Khách:|TÓM TẮT AI|HƯỚNG DẪN TOOLS|PURCHASE JOURNEY STATE).*?\]/gs, '').trim().slice(0, 120);
              }
            }
          } catch { /* defaults */ }
          files.push({
            session_id: fullSessionId,
            short_id: short8,
            fileKind: 'gemini-json',
            file_path: fp,
            started_at: new Date(st.birthtimeMs || st.mtimeMs).toISOString(),
            last_activity_at: new Date(st.mtimeMs).toISOString(),
            turn_count,
            first_user_snippet,
            size_bytes: st.size,
          });
        } catch { /* skip */ }
      }
    }
  }

  files.sort((a, b) => new Date(b.last_activity_at).getTime() - new Date(a.last_activity_at).getTime());
  const trimmed = files.slice(0, limit);

  return res.json({
    slug,
    total: files.length,
    returned: trimmed.length,
    claude_count: trimmed.filter((f) => f.fileKind === 'claude-jsonl').length,
    gemini_count: trimmed.filter((f) => f.fileKind === 'gemini-json').length,
    files: trimmed,
  });
});

// ─── Single Agent CRUD (/:slug routes) ──────────────────────────────

/**
 * GET /api/channels/agent-configs/:slug
 * Get a single agent by slug — reads from agents table (SSOT).
 */
router.get('/:slug', async (req, res) => {
  const { slug } = req.params;

  // Read from paperclip_agents only — chatbot config SSOT.
  const { data: pa, error } = await supabase
    .from('paperclip_agents')
    .select('*')
    .eq('slug', slug)
    .single();

  if (error || !pa) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  res.json({
    id: pa.id,
    slug: pa.slug,
    display_name: pa.display_name,
    description: pa.description,
    avatar: pa.avatar,
    provider: pa.provider,
    model: pa.model,
    temperature: pa.temperature != null ? parseFloat(pa.temperature) : 0.7,
    max_tokens: parseInt(pa.max_tokens) || 4096,
    top_p: pa.top_p != null ? parseFloat(pa.top_p) : 1.0,
    system_prompt: pa.system_prompt,
    persona_file: pa.persona_file,
    language: pa.language || 'vi',
    tools: pa.tools || [],
    can_escalate_to: pa.can_escalate_to || [],
    fallback_message: pa.fallback_message || '',
    effort_mode: pa.effort_mode || 'auto',
    max_turns: pa.max_turns != null ? parseInt(pa.max_turns) : 50,
    history_limit: parseInt(pa.history_limit) || 50,
    session_timeout: parseInt(pa.session_timeout) || 1440,
    enabled: pa.enabled,
    conversation_id: pa.conversation_id || null,
    created_at: pa.created_at,
    updated_at: pa.updated_at,
  });
});

/**
 * POST /api/channels/agent-configs
 * Create a new agent.
 */
router.post('/', async (req, res) => {
  const {
    slug,
    display_name,
    description,
    avatar,
    provider,
    model,
    temperature,
    max_tokens,
    system_prompt,
    persona_file,
    language,
    tools,
    can_escalate_to,
    fallback_message,
    history_limit,
    session_timeout,
    enabled,
    conversation_id,
  } = req.body;

  if (!slug || !display_name) {
    return res.status(400).json({ error: 'slug and display_name are required' });
  }

  // Check for duplicate slug
  const { data: existing } = await supabase
    .from('paperclip_agents')
    .select('id')
    .eq('slug', slug)
    .single();

  if (existing) {
    return res.status(409).json({ error: `Agent with slug "${slug}" already exists` });
  }

  const { data, error } = await supabase
    .from('paperclip_agents')
    .insert({
      slug,
      display_name,
      description: description || null,
      avatar: avatar || null,
      provider: provider || 'claude',
      model: model || 'claude-sonnet-4-6',
      temperature: temperature ?? 0.7,
      max_tokens: max_tokens ?? 4096,
      system_prompt: system_prompt || null,
      persona_file: persona_file || null,
      language: language || 'vi',
      tools: tools || [],
      can_escalate_to: can_escalate_to || [],
      fallback_message: fallback_message || 'Xin lỗi, em không thể xử lý yêu cầu này.',
      history_limit: history_limit ?? 20,
      session_timeout: session_timeout ?? 3600,
      enabled: enabled ?? true,
      conversation_id: conversation_id || null,
    })
    .select('*')
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  // Auto-create agent directory + default files on disk (full Paperclip template)
  const agentDir = path.join(AGENTS_DIR, slug);
  if (!fs.existsSync(agentDir)) {
    fs.mkdirSync(agentDir, { recursive: true });

    const escalateTo = (can_escalate_to || ['ceo']).join(', ');
    const today = new Date().toISOString().split('T')[0];

    // SOUL.md — full persona template
    fs.writeFileSync(path.join(agentDir, 'SOUL.md'), `# SOUL.md — ${display_name}

## Identity (🔒 IMMUTABLE)
- Name: ${display_name}
- Role: ${description || display_name}
- Mission: [Mô tả sứ mệnh cụ thể của agent]
- Reports to: ${escalateTo}
- Company: Gemral

## Strategic Posture (🔒 IMMUTABLE)

- [Định hướng chiến lược #1]
- [Định hướng chiến lược #2]
- [Định hướng chiến lược #3]

## Communication Style (✏️ AGENT TỰ SỬA ĐƯỢC)

- Tiếng Việt 100%, có dấu đầy đủ
- Xưng "mình", gọi "bạn" hoặc "anh/chị"
- Ngắn gọn, rõ ràng, không vòng vo
- Không dùng markdown formatting trong chat (chỉ text thuần)
- Conversational — như nói chuyện với bạn, không như robot

## Preferences (✏️ AGENT TỰ SỬA ĐƯỢC)

- [Thời gian hoạt động ưu tiên]
- [Workflow ưu tiên]

## Lessons (✏️ AGENT TỰ SỬA ĐƯỢC)

- ${today}: Initial SOUL.md created
`, 'utf-8');

    // AGENTS.md — operating instructions template
    fs.writeFileSync(path.join(agentDir, 'AGENTS.md'), `You are the ${display_name}.

## ⚠️ INFORMATION PRIORITY ORDER (Bắt buộc)

\`\`\`
1. SOP (memory/sops/) — Quy trình chính thức, SSOT cho workflow
2. Skills (skills-store/) — Reusable workflows đã được verify
3. Memory (memory/agents/*/MEMORY.md) — Ghi chú cá nhân, có thể outdated
\`\`\`

Khi SOP và Memory xung đột → LUÔN theo SOP, cập nhật Memory ngay.

### Daily End-of-Day Audit (Bắt buộc)

Cuối mỗi ngày làm việc, agent PHẢI:
1. Đọc lại SOP liên quan đến tasks đã làm hôm nay
2. So sánh với Memory cá nhân — tìm xung đột
3. Nếu có xung đột: cập nhật Memory, KHÔNG xóa entry cũ, ghi thêm [DEPRECATED] + lý do
4. Ghi kết quả audit vào daily notes

## Role & Mission

${description || `Bạn là ${display_name} của Gemral. [Mô tả chi tiết vai trò và nhiệm vụ].`}

## Products Knowledge

### Khóa học
- Kích Hoạt Tần Số Tình Yêu: ₫399,000
- Tái Tạo Tư Duy Triệu Phú: ₫499,000
- 7 Ngày Khai Mở Tần Số Gốc: ₫1,999,000
- Starter Trading: ₫299,000
- Tier 1/2/3 Scanner: ₫11M / ₫21M / ₫30M

### Crystal (Yinyang Masters)
- Đá tự nhiên 100%, tịnh hóa bởi Dr. Jennie Uyên Chu
- Shop: yinyangmasters.com

### App GEM
- Scanner 24+ patterns, Forum, Khóa học online
- Download: App Store / Google Play

## Tone & Voice

- Tiếng Việt 100%, có dấu đầy đủ
- Confident nhưng không kiêu ngạo
- Empathy trước, action sau
- Dùng emoji có chọn lọc

## Escalation

- Có thể escalate tới: ${escalateTo}
- Nếu không biết → nói thật, đề nghị chuyển cho người phụ trách

## Memory System

ALL memory writes go to project \`memory/\` folder:
- Daily notes: \`memory/agents/${slug}/daily/YYYY-MM-DD.md\`
- Tacit knowledge: \`memory/agents/${slug}/MEMORY.md\`
- Full rules: \`memory/INDEX.md\`

## References

- \`agents/${slug}/SOUL.md\` — persona
- \`agents/${slug}/TOOLS.md\` — available tools
- \`docs/IMPORTANT_LINKS.md\` — CTAs and landing pages
`, 'utf-8');

    // TOOLS.md — tools template
    fs.writeFileSync(path.join(agentDir, 'TOOLS.md'), `# TOOLS.md — ${display_name}

## Skills
- **paperclip** — Paperclip coordination
- **para-memory-files** — Memory system

## Tools
- Bash (scripts, API calls)
- Read/Write/Edit (file operations)
- Supabase MCP (data queries)

## Key Resources
- \`docs/IMPORTANT_LINKS.md\` — landing pages, CTAs
- \`memory/sops/\` — standard operating procedures
`, 'utf-8');

    console.log(`[AgentConfig] Created agent directory with full Paperclip template: ${agentDir}`);
  }

  res.status(201).json(data);
});

/**
 * PATCH /api/channels/agent-configs/:slug
 * Update an existing agent — writes to agents table (SSOT).
 */
router.patch('/:slug', async (req, res) => {
  const { slug } = req.params;

  // Registry Marketplace edits a chatbot config — write ONLY to paperclip_agents.
  // The `agents` heartbeat table is a different domain (autonomous workers) and
  // must never be mutated by chatbot edits, even though the rows share a slug.
  const { data: current, error: fetchErr } = await supabase
    .from('paperclip_agents')
    .select('id')
    .eq('slug', slug)
    .single();

  if (fetchErr || !current) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  const paUpdates: Record<string, any> = { updated_at: new Date().toISOString() };
  if (req.body.display_name !== undefined) paUpdates.display_name = req.body.display_name;
  if (req.body.description !== undefined) paUpdates.description = req.body.description;
  if (req.body.avatar !== undefined) paUpdates.avatar = req.body.avatar;
  if (req.body.provider !== undefined) paUpdates.provider = req.body.provider;
  if (req.body.model !== undefined) paUpdates.model = req.body.model;
  if (req.body.temperature !== undefined) paUpdates.temperature = parseFloat(req.body.temperature);
  if (req.body.max_tokens !== undefined) paUpdates.max_tokens = parseInt(req.body.max_tokens);
  if (req.body.top_p !== undefined) paUpdates.top_p = parseFloat(req.body.top_p);
  if (req.body.system_prompt !== undefined) paUpdates.system_prompt = req.body.system_prompt;
  if (req.body.persona_file !== undefined) paUpdates.persona_file = req.body.persona_file;
  if (req.body.language !== undefined) paUpdates.language = req.body.language;
  if (req.body.tools !== undefined) paUpdates.tools = req.body.tools;
  if (req.body.can_escalate_to !== undefined) paUpdates.can_escalate_to = req.body.can_escalate_to;
  if (req.body.fallback_message !== undefined) paUpdates.fallback_message = req.body.fallback_message;
  if (req.body.history_limit !== undefined) paUpdates.history_limit = parseInt(req.body.history_limit);
  if (req.body.session_timeout !== undefined) paUpdates.session_timeout = parseInt(req.body.session_timeout);
  if (req.body.effort_mode !== undefined) paUpdates.effort_mode = req.body.effort_mode;
  if (req.body.max_turns !== undefined) paUpdates.max_turns = parseInt(req.body.max_turns);
  if (req.body.enabled !== undefined) paUpdates.enabled = req.body.enabled;
  if (req.body.conversation_id !== undefined) paUpdates.conversation_id = req.body.conversation_id || null;

  const { data, error } = await supabase
    .from('paperclip_agents')
    .update(paUpdates)
    .eq('slug', slug)
    .select('*')
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  // Clear router cache since chatbot config changed
  AgentRouter.clearAgentCache();

  res.json(data);
});

/**
 * DELETE /api/channels/agent-configs/:slug
 * Delete an agent (with channel usage check).
 */
/**
 * POST /api/channels/agent-configs/:slug/clone
 * Clone an existing agent with a new slug.
 */
router.post('/:slug/clone', async (req, res) => {
  const { slug } = req.params;

  // Clone a chatbot config — read/write ONLY paperclip_agents.
  // Do NOT touch `agents` heartbeat or the on-disk agents/<slug> folder.
  const { data: pa, error: fetchErr } = await supabase
    .from('paperclip_agents')
    .select('*')
    .eq('slug', slug)
    .single();

  if (fetchErr || !pa) return res.status(404).json({ error: 'Agent không tìm thấy' });

  const newSlug = `${slug}-copy-${Date.now().toString(36).slice(-4)}`;
  const { id: _pid, created_at: _pca, updated_at: _pua, ...paClone } = pa;

  const { data: newPa, error } = await supabase
    .from('paperclip_agents')
    .insert({
      ...paClone,
      slug: newSlug,
      display_name: `${pa.display_name} (Bản sao)`,
      enabled: false,
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  AgentRouter.clearAgentCache();
  res.json(newPa);
});

router.delete('/:slug', async (req, res) => {
  const { slug } = req.params;

  // Check if any channel instances reference this agent
  const { data: usages } = await supabase
    .from('channel_instances')
    .select('name, display_name')
    .eq('agent_slug', slug);

  if (usages && usages.length > 0) {
    const channelNames = usages.map((u: any) => u.display_name || u.name).join(', ');
    return res.status(409).json({
      error: `Agent đang được sử dụng bởi ${usages.length} kênh: ${channelNames}. Hãy gỡ agent khỏi các kênh trước khi xóa.`,
      channels: usages,
    });
  }

  // Delete ONLY from paperclip_agents (chatbot config table).
  // Do NOT touch `agents` (heartbeat table) or the on-disk agents/<slug> folder —
  // those are owned by the autonomous-heartbeat side of the system and share
  // the same slug by convention only. A chatbot config delete must never
  // cascade into the heartbeat worker or its persona files.
  const { error: paErr } = await supabase.from('paperclip_agents').delete().eq('slug', slug);
  if (paErr) {
    return res.status(500).json({ error: paErr.message });
  }

  // Clear router cache
  AgentRouter.clearAgentCache();

  res.json({ success: true });
});

/**
 * POST /api/channels/agent-configs/:slug/test
 * Test an agent reply with optional multimodal input (image/voice).
 *
 * Body:
 *   message      string             — text prompt (can be empty if media provided)
 *   media        MediaInput[]       — optional. Each: { base64 | url | path, mimeType?, filename? }
 *   contentType  'text'|'image'|'voice'|'file'  — optional, hints to provider
 *
 * Notes:
 *   - For Ollama gemma4 (omnimodal), images and audio both go in messages[].images[]
 *   - Base64 inputs are written to a tmp file so resolveMediaToBase64() can reuse path
 */
type TestMediaInput = {
  base64?: string;
  url?: string;
  path?: string;
  mimeType?: string;
  filename?: string;
};

// ── Gem Master corrupted-output containment (2026-08-11 operator-report leak) ──
// The gem-master PRODUCTION path runs through this /test endpoint (edge fn
// gemini-proxy → tunnel → here, header x-training-session-id: gemmaster:<userId>).
// When postProcessReply refuses a corrupted reply we must do more than swallow
// it: disable the agy branch for a bounded window (metadata.agy_disabled_until —
// NOT bot_paused, which would strand the customer since nobody staffs the
// gem-master inbox; the edge falls back to Gemini instead) + ticket + CS ping.
// In-process cross-customer storm cooldown: >3 corrupted escalations / 15 min →
// one aggregated ping instead of a flood (a bad rule-file edit hits EVERY user).
const GM_DISABLE_MINUTES = 30;
const GM_STORM_WINDOW_MS = 15 * 60 * 1000;
const GM_STORM_THRESHOLD = 3;
const gmCorruptedTimestamps: number[] = [];

async function containGemMasterCorruptedOutput(
  userId: string,
  triggerMessage: string,
  escalation: { reason: string; priority: 'low' | 'normal' | 'high' | 'urgent'; summary?: string },
): Promise<void> {
  const sessionKey = `gem-master:${userId}`;
  const nowIso = new Date().toISOString();
  const untilIso = new Date(Date.now() + GM_DISABLE_MINUTES * 60 * 1000).toISOString();

  // Skip entirely when a disable window is already active (repeat turns of the
  // same broken agent must not re-ticket/re-ping).
  try {
    const { data: sess } = await supabase
      .from('channel_sessions')
      .select('metadata')
      .eq('session_key', sessionKey)
      .maybeSingle();
    const until = (sess?.metadata as Record<string, unknown> | null)?.agy_disabled_until;
    if (typeof until === 'string' && Date.parse(until) > Date.now()) {
      console.warn(`[GM-contain] ${sessionKey}: agy already disabled until ${until} — skip re-escalation`);
      return;
    }
  } catch { /* best-effort — continue */ }

  // ① Session shell upsert — FULL mirror column shape (chat_id is NOT NULL and
  // the column is channel_name; schema verified 2026-08-11). First-turn safe:
  // the edge mirror only creates this row AFTER it receives a reply, so the
  // corrupted first turn would otherwise have nothing to patch.
  try {
    await supabase.from('channel_sessions').upsert(
      {
        session_key: sessionKey,
        channel_name: 'gem-master',
        agent_slug: 'gem-master',
        peer_kind: 'direct',
        chat_id: userId,
        sender_id: userId,
        status: 'active',
        last_message_at: nowIso,
      },
      // ignoreDuplicates: chỉ tạo shell khi CHƯA có phiên — không đè last_message_at (P41, GEM-1212)
      { onConflict: 'session_key', ignoreDuplicates: true },
    );
    // ② Metadata via atomic jsonb-merge RPC — never read-merge-write the whole
    // object (BUG-081 clobber class) and never inline metadata in the upsert
    // (would overwrite unrelated keys).
    await supabase.rpc('channel_session_merge_meta', {
      p_session_key: sessionKey,
      p_patch: {
        agy_disabled_until: untilIso,
        agy_disabled_reason: escalation.reason,
        agy_disabled_at: nowIso,
      },
    });
    console.warn(`[GM-contain] ${sessionKey}: agy disabled until ${untilIso} (${escalation.reason})`);
  } catch (err) {
    console.error(`[GM-contain] ${sessionKey}: containment write failed`, err);
  }

  // ③ Ticket + Telegram ping — fire-and-forget (this sits on the edge's 40s
  // budget; never await network side-effects here). Storm cooldown: past the
  // threshold, one aggregated warning instead of per-customer pings.
  const now = Date.now();
  gmCorruptedTimestamps.push(now);
  while (gmCorruptedTimestamps.length && now - gmCorruptedTimestamps[0] > GM_STORM_WINDOW_MS) {
    gmCorruptedTimestamps.shift();
  }
  const stormHits = gmCorruptedTimestamps.length;
  const summary = (escalation.summary || 'Bot lộ báo cáo nội bộ — đã chặn gửi.')
    .replace(/\[PAPERCLIP_REPLY_CHANNEL\]/g, '');
  if (stormHits > GM_STORM_THRESHOLD) {
    console.error(
      `[GM-contain] STORM: ${stormHits} corrupted-output escalations in 15min — suppressing per-customer ping (session ${sessionKey})`,
    );
    return;
  }
  void handleEscalation({
    agentSlug: 'gem-master',
    sessionKey,
    channelName: 'gem-master',
    chatId: userId,
    // crm_tickets.customer_id FK → crm_customers(id); the gem-master userId is a
    // profiles/auth uuid, NOT a crm_customers id — passing it fails the insert
    // for REAL users too (verified 2026-08-11 E2E). The user stays traceable via
    // ticket metadata.chat_id + source_session_key.
    customerId: null,
    customerName: null,
    reason: escalation.reason,
    priority: escalation.priority || 'high',
    summary:
      stormHits === GM_STORM_THRESHOLD
        ? `${summary} ⚠️ Ca thứ ${stormHits}/15 phút — nghi lỗi hàng loạt, các ca sau sẽ không ping lẻ.`
        : summary,
    triggerMessage: triggerMessage.substring(0, 1000),
    agentReply: '(bị guard chặn — không gửi cho khách)',
    mode: 'live', // MUST stay 'live': 'training' skips the containment step entirely
    pausePatch: {
      agy_disabled_until: untilIso,
      agy_disabled_reason: escalation.reason,
      agy_disabled_at: nowIso,
    },
  }).catch((err) => console.error(`[GM-contain] ${sessionKey}: handleEscalation failed`, err));
}

router.post('/:slug/test', async (req, res) => {
  const { slug } = req.params;
  const { message, media, contentType } = req.body as {
    message?: string;
    media?: TestMediaInput[];
    contentType?: 'text' | 'image' | 'voice' | 'file';
  };

  // Training Room: orchestrator passes a stable session id via header so the
  // agent's conversation history persists across turns. Without this every
  // turn would get a fresh sessionKey based on Date.now() and the agent would
  // forget what the customer said in the previous turn (the "agent keeps
  // asking the same question" bug).
  const trainingSessionId = req.headers['x-training-session-id'] as string | undefined;

  const hasText = typeof message === 'string' && message.trim().length > 0;
  const hasMedia = Array.isArray(media) && media.length > 0;

  if (!hasText && !hasMedia) {
    return res.status(400).json({ error: 'message or media is required' });
  }

  // Load agent config
  const { data: config } = await supabase
    .from('paperclip_agents')
    .select('*')
    .eq('slug', slug)
    .single();

  if (!config) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  const startTime = Date.now();
  const tmpFiles: string[] = [];

  // ── Gem Master ASYNC JOB (14/10) ── Cloudflare tunnel cắt 1 request ở ~125s (đo: edge nhận 524 lúc
  // 125s trong khi agy cần 40-230s). Edge gửi header x-gm-job-id → trả 202 NGAY, chạy agent nền KHÔNG
  // gắn với kết nối, xong thì tự ghi gem_master_jobs (chỉ khi dòng còn 'pending' + đúng user — edge có
  // thể đã bỏ cuộc và ghi 'failed' trước). Edge đọc dòng đó để trả cho app/web.
  const gmJobId = String(req.headers['x-gm-job-id'] || '').trim();
  if (gmJobId && trainingSessionId?.startsWith('gemmaster:')) {
    const gmUserId = trainingSessionId.slice('gemmaster:'.length).trim();
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(gmJobId) || !UUID_RE.test(gmUserId) || !hasText) {
      return res.status(400).json({ error: 'invalid gem master job' });
    }
    const callerAgyTimeoutAsync = agyCallerTimeoutMs(req.headers['x-agy-timeout-ms']);
    if (callerAgyTimeoutAsync) (config as any)._agyTimeoutMs = callerAgyTimeoutAsync;
    res.status(202).json({ accepted: true, job_id: gmJobId });
    void (async () => {
      let reply = '';
      try {
        reply = (await AgentRouter.runAgentWithConfig(
          config as AgentConfig,
          `training:${slug}:${trainingSessionId}`,
          message || '',
        )) || '';
        const esc = (config as any)._escalation as
          | { reason: string; priority: 'low' | 'normal' | 'high' | 'urgent'; summary?: string }
          | undefined;
        if (esc?.reason === 'agent_output_corrupted') {
          void containGemMasterCorruptedOutput(gmUserId, message || '', esc).catch((err) =>
            console.error('[GM-contain] async containment failed', err),
          );
          reply = '';
        }
      } catch (err: any) {
        console.error(`[AgentTest/async] ${slug} job ${gmJobId} failed: ${err?.message || err}`);
        reply = '';
      }
      const ok = reply.trim().length > 0;
      // Hụt: KHÔNG tự đánh 'failed' — chỉ ghi `error` để edge chốt (edge gắn câu "quá tải" + ghi sổ),
      // nhờ vậy client không bao giờ thấy 'failed' mà reply rỗng.
      const { error: upErr } = await supabase
        .from('gem_master_jobs')
        .update(ok
          ? { status: 'done', reply: reply.trim(), backend: 'antigravity', finished_at: new Date().toISOString() }
          : { error: 'paperclip_no_reply' })
        .eq('id', gmJobId)
        .eq('user_id', gmUserId)
        .eq('status', 'pending');
      if (upErr) console.error(`[AgentTest/async] job ${gmJobId} update failed: ${upErr.message}`);
      console.log(`[AgentTest/async] ${slug} job ${gmJobId} ${ok ? 'done' : 'failed'} after ${Date.now() - startTime}ms`);
    })();
    return;
  }

  // ── QuAnt Trader Pit ASYNC REPLY (28/10) ── Cùng lý do Gem Master (tunnel cắt ~125s, agy trả lời
  // tin Pit đo 140s). Edge fn `quant-pit-reply` gửi header x-pit-reply-of (id tin khách) → 202 NGAY,
  // chạy agent nền, xong gọi RPC quant_post_bot_reply (lọc cứng + chống trùng theo reply_of ở DB).
  const pitReplyOf = String(req.headers['x-pit-reply-of'] || '').trim();
  if (pitReplyOf && slug === 'quant-pit-reply' && trainingSessionId?.startsWith('quantpit:')) {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(pitReplyOf) || !hasText) {
      return res.status(400).json({ error: 'invalid pit reply job' });
    }
    const callerAgyTimeoutPit = agyCallerTimeoutMs(req.headers['x-agy-timeout-ms']);
    if (callerAgyTimeoutPit) (config as any)._agyTimeoutMs = callerAgyTimeoutPit;
    res.status(202).json({ accepted: true, reply_of: pitReplyOf });
    void (async () => {
      let reply = '';
      try {
        reply = ((await AgentRouter.runAgentWithConfig(
          config as AgentConfig,
          `training:${slug}:${trainingSessionId}`,
          message || '',
        )) || '').trim();
      } catch (err: any) {
        console.error(`[AgentTest/pit] reply_of ${pitReplyOf} failed: ${err?.message || err}`);
      }
      if (!reply || reply.toUpperCase() === 'SKIP') {
        console.log(`[AgentTest/pit] reply_of ${pitReplyOf} no reply (${reply ? 'SKIP' : 'empty'})`);
        return;
      }
      const { data, error } = await supabase.rpc('quant_post_bot_reply', { p_reply_of: pitReplyOf, p_text: reply });
      if (error) console.error(`[AgentTest/pit] post reply_of ${pitReplyOf} failed: ${error.message}`);
      else console.log(`[AgentTest/pit] reply_of ${pitReplyOf} ${data} after ${Date.now() - startTime}ms`);
    })();
    return;
  }

  // ── Live Persona Terminal ASYNC REPLY (LVT-013, 28/10) ── Đường dùng chung cho các trang nhân vật trực live
  // (moon-keeper-reply, jennie-desk-reply, *-reply). Edge fn `live-terminal-reply` gửi header x-lt-reply-of (id tin khách)
  // → 202 NGAY, chạy agent nền, xong gọi RPC live_terminal_post_bot_reply (lọc cứng + chống trùng theo reply_of).
  const ltReplyOf = String(req.headers['x-lt-reply-of'] || '').trim();
  if (ltReplyOf && slug.endsWith('-reply') && trainingSessionId?.startsWith('ltreply:')) {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(ltReplyOf) || !hasText) {
      return res.status(400).json({ error: 'invalid live terminal reply job' });
    }
    const callerAgyTimeoutLt = agyCallerTimeoutMs(req.headers['x-agy-timeout-ms']);
    if (callerAgyTimeoutLt) (config as any)._agyTimeoutMs = callerAgyTimeoutLt;
    res.status(202).json({ accepted: true, reply_of: ltReplyOf });
    void (async () => {
      let reply = '';
      try {
        reply = ((await AgentRouter.runAgentWithConfig(
          config as AgentConfig,
          `training:${slug}:${trainingSessionId}`,
          message || '',
        )) || '').trim();
      } catch (err: any) {
        console.error(`[AgentTest/lt] ${slug} reply_of ${ltReplyOf} failed: ${err?.message || err}`);
      }
      if (!reply || reply.toUpperCase() === 'SKIP') {
        console.log(`[AgentTest/lt] ${slug} reply_of ${ltReplyOf} no reply (${reply ? 'SKIP' : 'empty'})`);
        return;
      }
      const { data, error } = await supabase.rpc('live_terminal_post_bot_reply', { p_reply_of: ltReplyOf, p_text: reply });
      if (error) console.error(`[AgentTest/lt] ${slug} post reply_of ${ltReplyOf} failed: ${error.message}`);
      else console.log(`[AgentTest/lt] ${slug} reply_of ${ltReplyOf} ${data} after ${Date.now() - startTime}ms`);
    })();
    return;
  }

  // Hủy ngay subprocess CLI (agy/gemini/claude) khi caller (vd: gemini-proxy ở 38–53.5s)
  // đóng kết nối HTTP sớm, chống chạy mồ côi tới 300s rồi đốt oan fallback claude-sonnet-4-6
  // vào socket đã đóng (GEM-1427 / OPS-1014-S1-05).
  const abortController = new AbortController();
  const onClientDisconnect = () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  };
  res.once('close', onClientDisconnect);
  req.once('aborted', onClientDisconnect);

  try {
    // Materialize base64 media to tmp files so router resolveMediaToBase64 can read by path
    const resolvedMedia: Array<{ url?: string; path?: string; mimeType: string; filename?: string }> = [];
    if (hasMedia) {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'pc-agent-test-'));
      for (let i = 0; i < media!.length; i++) {
        const m = media![i];
        if (m.base64) {
          const ext = (m.mimeType || '').includes('audio')
            ? '.wav'
            : (m.mimeType || '').includes('png')
              ? '.png'
              : (m.mimeType || '').includes('jpeg') || (m.mimeType || '').includes('jpg')
                ? '.jpg'
                : '.bin';
          const fp = path.join(tmpDir, `media_${i}${ext}`);
          fs.writeFileSync(fp, Buffer.from(m.base64, 'base64'));
          tmpFiles.push(fp);
          resolvedMedia.push({
            path: fp,
            mimeType: m.mimeType || 'application/octet-stream',
            filename: m.filename,
          });
        } else if (m.url || m.path) {
          resolvedMedia.push({
            url: m.url,
            path: m.path,
            mimeType: m.mimeType || 'application/octet-stream',
            filename: m.filename,
          });
        }
      }
    }

    // 14/10 Gem Master async job: caller có trần cứng (edge 400s) → rút ngắn trần agy để fallback
    // claude CLI kịp trả lời trước khi caller ngắt (ngắt = huỷ subprocess, GEM-1427).
    const callerAgyTimeout = agyCallerTimeoutMs(req.headers['x-agy-timeout-ms']);
    if (callerAgyTimeout) (config as any)._agyTimeoutMs = callerAgyTimeout;

    // Inject media into config via the same `_media` channel that runAgent uses
    if (resolvedMedia.length > 0) {
      (config as any)._media = resolvedMedia;
      (config as any)._contentType = contentType || (resolvedMedia[0].mimeType.startsWith('audio') ? 'voice' : 'image');
    }

    // Use stable session key per training session, falling back to per-call
    // ad-hoc key for non-training tests. This is what gives the agent
    // continuity across turns ("remembering" what the customer said).
    const sessionKey = trainingSessionId
      ? `training:${slug}:${trainingSessionId}`
      : `test:${slug}:${Date.now()}`;

    const reply = await AgentRouter.runAgentWithConfig(
      config as AgentConfig,
      sessionKey,
      message || '',
      undefined,
      abortController.signal,
    );

    const duration = Date.now() - startTime;
    if (abortController.signal.aborted || res.writableEnded || res.destroyed) {
      console.warn(`[AgentTest] Client disconnected early for ${slug} after ${duration}ms — skipping response`);
      return;
    }

    // Surface outbound media (extracted from [[SEND_MEDIA: id]] markers) so the
    // test UI can preview what would be attached to a real Zalo/FB reply.
    const outboundMedia = (config as any)._outboundMedia as
      | Array<{ url?: string; path?: string; mimeType: string; filename?: string; caption?: string }>
      | undefined;

    // Surface MSG_BREAK chunks so training room can render multi-message replies
    // exactly like the live channels do (each chunk a separate bubble).
    // Field name matches router.ts side-channel: `_messageChunks`.
    const rawChunks = (config as any)._messageChunks as Array<string | { text: string }> | undefined;
    const messageChunks = rawChunks?.map((c) => (typeof c === 'string' ? c : c.text));

    // Surface escalation marker so training orchestrator can call handleEscalation()
    // and create a real CRM ticket. Router parses [[ESCALATE: reason]] markers in
    // post-processing and stores the parsed object on `config._escalation` BEFORE
    // stripping the marker from finalContent — meaning the cleaned `reply` no
    // longer contains the marker. Without surfacing here, orchestrator's regex
    // match on replyText would always miss → no ticket created.
    const escalation = (config as any)._escalation as
      | {
          reason: string;
          priority: 'low' | 'normal' | 'high' | 'urgent';
          summary?: string;
        }
      | undefined;

    // Gem Master corrupted-output containment (2026-08-11). Discriminator is the
    // RAW header value (gemmaster:<userId>) — NOT sessionKey, which the server
    // prefixes to `training:gem-master:gemmaster:<userId>`. Ordinary Training
    // Room / UI tests carry no gemmaster: header and are untouched.
    let finalReply = reply;
    if (escalation?.reason === 'agent_output_corrupted' && trainingSessionId?.startsWith('gemmaster:')) {
      const gmUserId = trainingSessionId.slice('gemmaster:'.length).trim();
      if (gmUserId) {
        void containGemMasterCorruptedOutput(gmUserId, message || '', escalation).catch((err) =>
          console.error('[GM-contain] async containment failed', err),
        );
        // Empty reply → edge callAntigravityAgent() returns null → gemini-proxy
        // falls back to the Gemini branch, so the customer still gets a REAL
        // answer instead of the generic handoff line.
        finalReply = '';
      }
    }

    res.json({
      reply: finalReply,
      agent: slug,
      provider: config.provider,
      model: config.model,
      duration_ms: duration,
      media_count: resolvedMedia.length,
      outbound_media: outboundMedia || [],
      message_chunks: messageChunks || undefined,
      escalation: escalation || undefined,
      session_key: sessionKey,
    });
  } catch (err: any) {
    const duration = Date.now() - startTime;
    if (
      abortController.signal.aborted ||
      err?.name === 'AgentAbortedError' ||
      res.writableEnded ||
      res.destroyed
    ) {
      console.warn(`[AgentTest] Client disconnected early for ${slug} after ${duration}ms (${err?.message || 'aborted'})`);
      return;
    }
    res.status(500).json({
      error: err.message || 'Agent test failed',
      duration_ms: duration,
    });
  } finally {
    res.off('close', onClientDisconnect);
    req.off('aborted', onClientDisconnect);
    // Cleanup tmp files
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

/**
 * GET /api/channels/agent-configs/:slug/files
 * List agent files (AGENTS.md, HEARTBEAT.md, SOUL.md, TOOLS.md)
 */
router.get('/:slug/files', (req, res) => {
  const { slug } = req.params;
  const agentDir = path.join(AGENTS_DIR, slug);

  if (!fs.existsSync(agentDir)) {
    return res.json({ files: ALLOWED_FILES.map(name => ({ name, missing: true, size: 0, content: '' })) });
  }

  const files = ALLOWED_FILES.map(name => {
    const filePath = path.join(agentDir, name);
    const exists = fs.existsSync(filePath);
    if (!exists) return { name, missing: true, size: 0, content: '' };

    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    return {
      name,
      missing: false,
      size: stat.size,
      content,
      updatedAt: stat.mtime.toISOString(),
    };
  });

  res.json({ files, agentDir });
});

/**
 * GET /api/channels/agent-configs/:slug/files/:fileName
 * Read a single agent file
 */
router.get('/:slug/files/:fileName', (req, res) => {
  const { slug, fileName } = req.params;

  if (!ALLOWED_FILES.includes(fileName)) {
    return res.status(400).json({ error: `File không cho phép: ${fileName}` });
  }

  const filePath = path.join(AGENTS_DIR, slug, fileName);
  if (!fs.existsSync(filePath)) {
    return res.json({ name: fileName, missing: true, content: '' });
  }

  const stat = fs.statSync(filePath);
  const content = fs.readFileSync(filePath, 'utf-8');
  res.json({ name: fileName, missing: false, size: stat.size, content, updatedAt: stat.mtime.toISOString() });
});

/**
 * PUT /api/channels/agent-configs/:slug/files/:fileName
 *
 * DISABLED 2026-04-14 per Jennie (Telegram msg #2512).
 *
 * This endpoint let the channel-router UI overwrite any file under
 * `agents/{slug}/` (SOUL.md, AGENTS.md, TOOLS.md, HEARTBEAT.md, ...).
 * Those files are the HEARTBEAT adapter's SSOT (read on disk by
 * `packages/adapters/{gemini,claude,...}-local/src/server/execute.ts`).
 * Allowing the ROUTER to mutate them violated the separation declared in
 * `paperclip-dashboard/architecture/ssot.md` (see BUG-033, BUG-040):
 *
 *   - Router SSOT   = `paperclip_agents` (DB)
 *   - Heartbeat SSOT = `agents.adapter_config` (DB) + disk files under AGENTS_DIR
 *
 * A save from the router UI's Files tab trimmed
 * `agents/community-engagement/AGENTS.md` from 8,670 B to 105 B, which in turn
 * left the heartbeat adapter with no real instructions and the agent wandered
 * blindly through the repo (verified in run 29093a35 on 2026-04-14).
 *
 * To edit heartbeat disk files use the HEARTBEAT config page
 * (`/GEM/agents/:agentId/configuration` + its dedicated file editor), NOT the
 * router's agent-configs page.
 *
 * GET /:slug/files/:fileName (the read endpoint above) remains available —
 * reads are harmless and still power the "Loaded" badge on the Skills tab.
 */
router.put('/:slug/files/:fileName', (_req, res) => {
  return res.status(410).json({
    error:
      'Router route cannot write heartbeat disk files. Use the heartbeat Configuration page ' +
      '(/GEM/agents/:agentId/configuration) — see troubleshooting_tips.md BUG-040.',
    ssot: {
      router: 'paperclip_agents (DB)',
      heartbeat_db: 'agents.adapter_config (DB)',
      heartbeat_disk: 'agents/{slug}/*.md (read-only from router)',
    },
  });
});

export default router;
