// Cross-channel API routes
// Provides unified endpoints for all channel types

import { Router } from 'express';
import { supabase } from './zalo-personal/supabase.js';
import { clearConfigCache } from './consumer.js';
import { fetchTranscript } from './transcript.js';
import { isHumanSent } from './sent-by-utils.js';
import { approvePairing } from './policy.js';
import { streamEvents, clearAgentCache } from './router.js';

const router = Router();

/**
 * GET /api/channels/sessions
 * List all conversation sessions across all channels.
 * Query: ?status=active|closed&channel_name=xxx&limit=50&offset=0
 */
router.get('/sessions', async (req, res) => {
  const { status, channel_name, limit = 50, offset = 0 } = req.query;

  let query = supabase
    .from('channel_sessions')
    .select('*')
    .order('last_message_at', { ascending: false })
    .range(Number(offset), Number(offset) + Number(limit) - 1);

  if (status) {
    query = query.eq('status', String(status));
  }
  if (channel_name) {
    query = query.eq('channel_name', String(channel_name));
  }

  const { data, error } = await query;

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data || []);
});

// ── Phase 0: Session cost summary (MUST be before :sessionKey) ──
router.get('/sessions/cost-summary', async (_req, res) => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const weekStart = new Date(now.getTime() - 7 * 86400000).toISOString();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const fetchPeriod = async (since: string) => {
    const { data } = await supabase
      .from('agent_sessions')
      .select('total_cost, tokens_in, tokens_out, reply_count')
      .gte('created_at', since);
    const rows = data || [];
    return {
      cost: rows.reduce((s, r) => s + (r.total_cost || 0), 0),
      tokens_in: rows.reduce((s, r) => s + (r.tokens_in || 0), 0),
      tokens_out: rows.reduce((s, r) => s + (r.tokens_out || 0), 0),
      replies: rows.reduce((s, r) => s + (r.reply_count || 0), 0),
    };
  };

  const [today, week, month] = await Promise.all([
    fetchPeriod(todayStart),
    fetchPeriod(weekStart),
    fetchPeriod(monthStart),
  ]);

  res.json({
    today, week, month,
    avg_cost_per_reply: today.replies > 0 ? today.cost / today.replies : 0,
  });
});

/**
 * GET /api/channels/sessions/:sessionKey
 * Get a single session by session_key.
 */
router.get('/sessions/:sessionKey', async (req, res) => {
  const { sessionKey } = req.params;

  const { data, error } = await supabase
    .from('channel_sessions')
    .select('*')
    .eq('session_key', sessionKey)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json(data);
});

/**
 * GET /api/channels/sessions/:sessionKey/messages
 * Get merged inbound + outbound messages for a session.
 * Query: ?limit=100
 */
router.get('/sessions/:sessionKey/messages', async (req, res) => {
  const { sessionKey } = req.params;
  const limit = Number(req.query.limit) || 100;

  // Nguồn DUY NHẤT dùng chung với CrmInbox (transcript.ts) — cùng parser canonical
  // (indexOf-slicing, chịu được id chứa ':'; split(':') cũ cắt sai) + cùng bộ lọc + cùng
  // chính sách ẩn `deleted_for_me` ⇒ 2 màn không thể lệch nhau. Plan 2026-07-19-INBOX-...
  let inbound: Record<string, any>[];
  let outbound: Record<string, any>[];
  try {
    const t = await fetchTranscript(sessionKey, limit);
    inbound = t.inbound;
    outbound = t.outbound;
  } catch (err: any) {
    // Trước đây lỗi DB bị nuốt (destructure không check error) → trả thread rỗng giả.
    const invalid = /Invalid session_key/.test(err?.message || '');
    console.error('[sessions/:sessionKey/messages] transcript failed:', err?.message || err);
    return res.status(invalid ? 400 : 500).json({ error: err?.message || 'transcript failed' });
  }

  // Merge and normalize
  const messages = [
    ...(inbound || []).map((m: any) => ({
      ...m,
      direction: 'inbound' as const,
    })),
    ...(outbound || []).map((m: any) => ({
      ...m,
      direction: 'outbound' as const,
      from_uid: '',
      sender_name: (!m.sent_by || isHumanSent(m.sent_by)) ? 'Bạn' : `🤖 ${m.sent_by}`,
      ts: m.created_at,
    })),
  ].sort((a, b) => {
    const ta = a.ts || a.created_at || '';
    const tb = b.ts || b.created_at || '';
    return tb.localeCompare(ta);
  });

  // Apply operator-side flags (star / pin / delete-for-me) from inbox_message_flags.
  // Keyed by the message uuid (unique across both source tables).
  const ids = messages.map((m: any) => m.id).filter(Boolean);
  const flagMap: Record<string, { starred: boolean; pinned: boolean; deleted_for_me: boolean }> = {};
  if (ids.length) {
    const { data: flags } = await supabase
      .from('inbox_message_flags')
      .select('message_id, starred, pinned, deleted_for_me')
      .in('message_id', ids);
    for (const f of flags || []) flagMap[(f as any).message_id] = f as any;
  }

  const withFlags = messages
    .filter((m: any) => !flagMap[m.id]?.deleted_for_me) // hide messages deleted on our side only
    .map((m: any) => ({
      ...m,
      starred: flagMap[m.id]?.starred || false,
      pinned: flagMap[m.id]?.pinned || false,
    }));

  res.json(withFlags.slice(0, limit));
});

/**
 * POST /api/channels/messages/:id/flags
 * Toggle operator-side per-message flags (star / pin / delete-for-me). Partial
 * upsert — only provided fields change; others keep their stored value.
 */
router.post('/messages/:id/flags', async (req, res) => {
  const { id } = req.params;
  const { starred, pinned, deleted_for_me, session_key } = req.body || {};
  const patch: Record<string, any> = { message_id: id, updated_at: new Date().toISOString() };
  if (starred !== undefined) patch.starred = !!starred;
  if (pinned !== undefined) patch.pinned = !!pinned;
  if (deleted_for_me !== undefined) patch.deleted_for_me = !!deleted_for_me;
  if (session_key !== undefined) patch.session_key = session_key;

  const { data, error } = await supabase
    .from('inbox_message_flags')
    .upsert(patch, { onConflict: 'message_id' })
    .select('message_id, starred, pinned, deleted_for_me')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/**
 * POST /api/channels/settings/:channelName
 * Update channel settings (policies, quotas, etc.)
 */
router.post('/settings/:channelName', async (req, res) => {
  const { channelName } = req.params;
  const {
    display_name,
    agent_id,
    agent_slug,
    dm_policy,
    group_policy,
    require_mention,
    quota_hour,
    quota_day,
    history_limit,
    allow_from,
    enabled,
    save_contacts_to_crm,
    color,
  } = req.body;

  const updates: Record<string, any> = {
    updated_at: new Date().toISOString(),
  };

  if (display_name !== undefined) updates.display_name = display_name;
  if (agent_id !== undefined) updates.agent_id = agent_id;
  if (agent_slug !== undefined) updates.agent_slug = agent_slug;
  if (dm_policy !== undefined) updates.dm_policy = dm_policy;
  if (group_policy !== undefined) updates.group_policy = group_policy;
  if (require_mention !== undefined) updates.require_mention = require_mention;
  if (quota_hour !== undefined) updates.quota_hour = quota_hour;
  if (quota_day !== undefined) updates.quota_day = quota_day;
  if (history_limit !== undefined) updates.history_limit = history_limit;
  if (allow_from !== undefined) updates.allow_from = allow_from;
  if (enabled !== undefined) updates.enabled = enabled;
  if (save_contacts_to_crm !== undefined) updates.save_contacts_to_crm = save_contacts_to_crm;
  if (color !== undefined) updates.color = color || null;

  const { data, error } = await supabase
    .from('channel_instances')
    .update(updates)
    .eq('name', channelName)
    .select('*')
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  // Clear caches so consumer + router pick up new settings immediately
  clearConfigCache(channelName);
  clearAgentCache();

  // Sync agent_slug to all existing sessions for this channel
  if (agent_slug !== undefined) {
    await supabase
      .from('channel_sessions')
      .update({ agent_slug: agent_slug || null })
      .eq('channel_name', channelName);
  }

  res.json(data);
});

/**
 * GET /api/channels/settings/:channelName
 * Get channel settings.
 */
router.get('/settings/:channelName', async (req, res) => {
  const { channelName } = req.params;

  const { data, error } = await supabase
    .from('channel_instances')
    .select('*')
    .eq('name', channelName)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Channel not found' });
  }

  res.json(data);
});

/**
 * GET /api/channels/pairing/:channelName
 * List pending pairing codes for a channel.
 */
router.get('/pairing/:channelName', async (req, res) => {
  const { channelName } = req.params;

  const { data, error } = await supabase
    .from('channel_pairing_codes')
    .select('*')
    .eq('channel_name', channelName)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data || []);
});

/**
 * POST /api/channels/pairing/:channelName/approve
 * Approve a pending pairing code.
 * Body: { code: string }
 */
router.post('/pairing/:channelName/approve', async (req, res) => {
  const { channelName } = req.params;
  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ error: 'code required' });
  }

  const result = await approvePairing(channelName, code);

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }

  // Clear config cache since paired_users was updated
  clearConfigCache(channelName);

  res.json({ success: true, senderId: result.senderId });
});

/**
 * GET /api/channels/stats
 * Overview stats: messages today, response rate, avg response time.
 */
router.get('/stats', async (_req, res) => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayISO = todayStart.toISOString();

  // Count inbound messages today
  const { count: inboundToday } = await supabase
    .from('channel_pending_messages')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', todayISO);

  // Count handled messages today
  const { count: handledToday } = await supabase
    .from('channel_pending_messages')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', todayISO)
    .eq('status', 'handled');

  // Count sent messages today
  const { count: sentToday } = await supabase
    .from('channel_sent_messages')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', todayISO);

  // Count active sessions
  const { count: activeSessions } = await supabase
    .from('channel_sessions')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'active');

  // Count all channel instances
  const { data: instances } = await supabase
    .from('channel_instances')
    .select('name, channel_type, status, enabled');

  const responseRate = (inboundToday ?? 0) > 0
    ? Math.round(((handledToday ?? 0) / (inboundToday ?? 1)) * 100)
    : 0;

  res.json({
    messagesInboundToday: inboundToday ?? 0,
    messagesSentToday: sentToday ?? 0,
    messagesHandledToday: handledToday ?? 0,
    responseRate,
    activeSessions: activeSessions ?? 0,
    channels: instances || [],
  });
});

/**
 * GET /api/channels/stream
 * SSE endpoint for real-time agent processing events.
 * Query: ?agent_slug=xxx (optional, filter by agent)
 */
router.get('/stream', (req, res) => {
  const filterAgent = req.query.agent_slug as string | undefined;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

  const onStart = (data: any) => {
    if (filterAgent && data.agentSlug !== filterAgent) return;
    res.write(`data: ${JSON.stringify({ type: 'agent:start', ...data })}\n\n`);
  };

  const onChunk = (data: any) => {
    if (filterAgent && data.agentSlug !== filterAgent) return;
    res.write(`data: ${JSON.stringify({ type: 'agent:chunk', agentSlug: data.agentSlug, streamKey: data.streamKey })}\n\n`);
  };

  const onDone = (data: any) => {
    if (filterAgent && data.agentSlug !== filterAgent) return;
    res.write(`data: ${JSON.stringify({ type: 'agent:done', agentSlug: data.agentSlug, reply: data.reply?.substring(0, 200) })}\n\n`);
  };

  const onError = (data: any) => {
    if (filterAgent && data.agentSlug !== filterAgent) return;
    res.write(`data: ${JSON.stringify({ type: 'agent:error', agentSlug: data.agentSlug, error: data.error })}\n\n`);
  };

  streamEvents.on('agent:start', onStart);
  streamEvents.on('agent:chunk', onChunk);
  streamEvents.on('agent:done', onDone);
  streamEvents.on('agent:error', onError);

  // Keep connection alive
  const heartbeat = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, 15_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    streamEvents.off('agent:start', onStart);
    streamEvents.off('agent:chunk', onChunk);
    streamEvents.off('agent:done', onDone);
    streamEvents.off('agent:error', onError);
  });
});

/**
 * GET /api/channels/instances
 * List all channel instances (all types).
 */
router.get('/instances', async (_req, res) => {
  const { data, error } = await supabase
    .from('channel_instances')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data || []);
});

// ── Phase 0: Restart agent session ──
router.post('/sessions/:id/restart', async (req, res) => {
  const { id } = req.params;
  // Kill existing session
  await supabase.from('agent_sessions').update({
    status: 'stopped',
    ended_at: new Date().toISOString(),
  }).eq('id', id);

  res.json({ success: true, message: 'Đã khởi động lại agent. Session mới sẽ tạo khi có tin nhắn.' });
});

// ── Phase 0: Pause agent session ──
router.post('/sessions/:id/pause', async (req, res) => {
  const { id } = req.params;
  await supabase.from('agent_sessions').update({
    status: 'paused',
  }).eq('id', id);
  res.json({ success: true, message: 'Đã tạm dừng agent. Tin nhắn mới sẽ được queue.' });
});

// ── Phase 0: Resume agent session ──
router.post('/sessions/:id/resume', async (req, res) => {
  const { id } = req.params;
  await supabase.from('agent_sessions').update({
    status: 'running',
  }).eq('id', id);
  res.json({ success: true, message: 'Đã kích hoạt lại agent.' });
});

// ── Phase 0: Activity log with skip_reason ──
router.get('/activity', async (req, res) => {
  const { channel, agent, status, limit = '50' } = req.query;

  let query = supabase
    .from('channel_pending_messages')
    .select('id, channel_name, thread_id, sender_name, body, status, handled_by, skip_reason, agent_slug, session_key, created_at')
    .order('created_at', { ascending: false })
    .limit(parseInt(String(limit)));

  if (channel) query = query.eq('channel_name', String(channel));
  if (agent) query = query.eq('agent_slug', String(agent));
  if (status) query = query.eq('status', String(status));

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── Smart Routing: Ignored Chats CRUD ──

router.get('/routing/ignored', async (_req, res) => {
  const { data, error } = await supabase.from('chat_ignored').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post('/routing/ignored', async (req, res) => {
  const { chat_id, channel_name, display_name, reason } = req.body;
  if (!chat_id) return res.status(400).json({ error: 'chat_id required' });
  const { data, error } = await supabase.from('chat_ignored').upsert({ chat_id, channel_name: channel_name || null, display_name, reason, created_by: 'board' }, { onConflict: 'chat_id,channel_name' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/routing/ignored/:id', async (req, res) => {
  const { error } = await supabase.from('chat_ignored').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Đã bỏ ignore' });
});

// ── Smart Routing: Agent Overrides CRUD ──

router.get('/routing/overrides', async (_req, res) => {
  const { data, error } = await supabase.from('chat_agent_overrides').select('*').order('priority', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post('/routing/overrides', async (req, res) => {
  const { match_type, match_value, agent_slug, action, reason, priority } = req.body;
  if (!match_type || !match_value) return res.status(400).json({ error: 'match_type + match_value required' });
  const { data, error } = await supabase.from('chat_agent_overrides').insert({
    match_type, match_value, agent_slug: agent_slug || null, action: action || 'route', reason, priority: priority || 0, is_active: true, created_by: 'board',
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.patch('/routing/overrides/:id', async (req, res) => {
  const { agent_slug, action, reason, is_active, priority } = req.body;
  const updates: Record<string, any> = { updated_at: new Date().toISOString() };
  if (agent_slug !== undefined) updates.agent_slug = agent_slug;
  if (action !== undefined) updates.action = action;
  if (reason !== undefined) updates.reason = reason;
  if (is_active !== undefined) updates.is_active = is_active;
  if (priority !== undefined) updates.priority = priority;
  const { data, error } = await supabase.from('chat_agent_overrides').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/routing/overrides/:id', async (req, res) => {
  const { error } = await supabase.from('chat_agent_overrides').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Đã xóa rule' });
});

// ── Smart Routing: Keyword Rules CRUD (uses chat_agent_overrides with match_type='keyword') ──

router.get('/routing/keywords', async (_req, res) => {
  const { data, error } = await supabase
    .from('chat_agent_overrides')
    .select('*')
    .eq('match_type', 'keyword')
    .order('priority', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post('/routing/keywords', async (req, res) => {
  const { keywords, agent_slug, reason, priority } = req.body;
  if (!keywords || !agent_slug) return res.status(400).json({ error: 'keywords + agent_slug required' });
  const kws = Array.isArray(keywords) ? keywords.join(',') : String(keywords);
  const { data, error } = await supabase.from('chat_agent_overrides').insert({
    match_type: 'keyword',
    match_value: kws,
    agent_slug,
    action: 'route',
    reason: reason || null,
    priority: priority || 0,
    is_active: true,
    created_by: 'board',
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/routing/keywords/:id', async (req, res) => {
  const { error } = await supabase.from('chat_agent_overrides').delete()
    .eq('id', req.params.id).eq('match_type', 'keyword');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Đã xóa rule' });
});

// ── Smart Routing: Recent activity with skip reasons ──
router.get('/routing/activity', async (req, res) => {
  const limit = Number(req.query.limit) || 30;
  const { data, error } = await supabase
    .from('channel_pending_messages')
    .select('id, created_at, channel_name, session_key, status, skip_reason, agent_slug, sender_name, body')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── FIX 8: Contacts CRUD ──

router.get('/contacts', async (req, res) => {
  const { search, limit = 50 } = req.query;
  
  // Fetch from profiles
  let profileQuery = supabase.from('profiles').select('id, full_name, username, phone, email').limit(Number(limit));
  
  // Fetch from channel_sessions
  let sessionQuery = supabase.from('channel_sessions').select('chat_id, sender_name, channel_name').limit(Number(limit));
  
  const [profilesRes, sessionsRes] = await Promise.all([profileQuery, sessionQuery]);
  
  if (profilesRes.error) console.error("Profiles error:", profilesRes.error.message);
  if (sessionsRes.error) console.error("Sessions error:", sessionsRes.error.message);
  
  const contactsMap = new Map<string, any>();
  
  // Map profiles
  (profilesRes.data || []).forEach(p => {
    contactsMap.set(p.id, {
      id: p.id,
      user_id: p.id,
      name: p.full_name || p.username || p.phone || p.email || "Không tên",
      phone: p.phone,
      email: p.email,
      label: "Thành viên app"
    });
  });
  
  // Map channel sessions
  (sessionsRes.data || []).forEach(s => {
    // If the person is already mapped via user_id, we could merge, but here they only have chat_id
    if (!contactsMap.has(s.chat_id)) {
      contactsMap.set(s.chat_id, {
        id: s.chat_id,
        zalo_id: s.chat_id, // Assume chat_id is either Zalo/FB ID
        name: s.sender_name || s.chat_id,
        label: s.channel_name.includes('zalo') ? "Zalo" : "Kênh khác"
      });
    }
  });
  
  let allContacts = Array.from(contactsMap.values());
  
  if (search && typeof search === 'string') {
    const q = search.toLowerCase();
    allContacts = allContacts.filter(c => 
      (c.name && c.name.toLowerCase().includes(q)) ||
      (c.phone && c.phone.includes(q)) ||
      (c.zalo_id && c.zalo_id.includes(q)) ||
      (c.user_id && c.user_id.includes(q))
    );
  }

  res.json(allContacts.slice(0, Number(limit)));
});

router.post('/contacts', async (req, res) => {
  const { data, error } = await supabase
    .from('inbox_contacts')
    .insert(req.body)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.patch('/contacts/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('inbox_contacts')
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/contacts/:id', async (req, res) => {
  const { error } = await supabase
    .from('inbox_contacts')
    .delete()
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── POST /api/channels/send — Universal send message (FIX SEND) ──
// Ghi outbound message vào DB ngay, sau đó forward đến sub-handler kênh cụ thể
router.post('/send', async (req, res) => {
  const { channel_name, thread_id, message, thread_type = 'dm' } = req.body;
  if (!channel_name || !thread_id || !message) {
    return res.status(400).json({ error: 'channel_name, thread_id và message là bắt buộc' });
  }

  // Detect channel type từ DB (cần trước khi forward)
  const { data: inst } = await supabase
    .from('channel_instances')
    .select('channel_type, name')
    .eq('name', channel_name)
    .single();

  if (!inst) {
    return res.status(404).json({ error: `Kênh "${channel_name}" không tồn tại` });
  }

  // [19/08] facebook (Graph API, fb-*): PROXY ĐỒNG BỘ sang sub-handler — KHÔNG insert row ở đây
  // (sub-handler CLAIM-BEFORE-SEND tự ghi + stamp mid + dọn khi lỗi), KHÔNG optimistic (Graph ~300ms;
  // lỗi token/24h-window/PSID phải lộ ra UI thay vì thành "tin ma"). Zalo/CSKH bên dưới GIỮ NGUYÊN.
  // Cổng = cổng server ĐANG nghe thật (index.ts publish PAPERCLIP_LISTEN_PORT sau listen — đúng cả khi
  // PORT bận nhảy cổng); KHÔNG chép `PORT || 3101` của dòng forward cũ (3101 là cổng cũ). Codex R3.
  if (inst.channel_type === 'facebook' || inst.channel_type === 'instagram') {
    const fbPort = process.env.PAPERCLIP_LISTEN_PORT || process.env.PORT || 3100;
    const fbUrl = `http://localhost:${fbPort}/api/channels/facebook/send`;
    // Timeout (Codex R2): proxy treo/rớt SAU khi sub-handler đã claim row + Graph có thể đã nhận →
    // KHÔNG trả lỗi chung chung (UI khôi phục text → người trực gõ lại → khách nhận 2 tin).
    const timeoutMs = Number(process.env.FB_MANUAL_SEND_TIMEOUT_MS) || 15_000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(fbUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_name, thread_id, message, thread_type, sent_by: 'manual' }),
        signal: ac.signal,
      });
      const data = await r.json().catch(() => ({}));
      return res.status(r.status).json(data);
    } catch (err: any) {
      // Tới đây = sub-handler không trả lời được (timeout/rớt), KHÔNG biết Graph đã nhận chưa.
      // Row (nếu đã claim) vẫn nằm trong transcript → bảo người trực NHÌN transcript trước khi gửi lại.
      return res.status(502).json({
        error: `Gửi FB không xác nhận được (${err?.name === 'AbortError' ? `quá ${timeoutMs}ms` : err.message}). Tin CÓ THỂ đã tới khách — kiểm tra transcript trước khi gửi lại, đừng gửi mù.`,
        maybe_sent: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // 0. FAIL-CLOSED (25/07): chỉ gửi khi channel_type có sub-handler THẬT SỰ tương thích.
  //    Trước đây `subPathByType[type] || 'zalo-personal'` fail-OPEN ⇒ mọi type lạ
  //    (app / facebook / facebook_web) bị đẩy sang handler Zalo. Đường đó KHÔNG BAO GIỜ gửi
  //    được (zalo-personal/routes.ts:129 `activeChannels.get()` → 404) nhưng KỊP tạo row
  //    'sending' → lật 'failed'; mà transcript KHÔNG lọc status ⇒ tin hiện như ĐÃ GỬI trong
  //    khi khách chưa từng nhận ("tin ma" — đo 25/07: 18 row 'failed' đang render như vậy).
  //    Phải chặn TRƯỚC câu insert bên dưới, vì chính câu insert đẻ ra tin ma.
  //    ⚠️ facebook (Graph API) ĐÃ xử lý ở nhánh proxy phía TRÊN (19/08) — không rơi xuống đây nữa.
  //    facebook_web vẫn CHƯA: handler `/:name/send` body khác hẳn ⇒ vẫn là feature riêng, chưa nối.
  const subPathByType: Record<string, string> = { zalo_personal: 'zalo-personal', cskh: 'cskh' };
  const sub = subPathByType[inst.channel_type];
  if (!sub) {
    return res.status(400).json({
      error: `Kênh "${channel_name}" (loại ${inst.channel_type}) chưa hỗ trợ gửi tay từ Paperclip.`,
    });
  }

  // 1. Ghi outbound message vào DB NGAY (status 'sending') để UI hiển thị tức thì.
  //    Đây là row DUY NHẤT cho tin này — sub-handler được yêu cầu skip_db_log
  //    để tránh double-insert (channel.send tự log trước đây tạo row thứ 2).
  const { data: row, error: dbErr } = await supabase
    .from('channel_sent_messages')
    .insert({
      channel_name,
      thread_id,
      thread_type,
      to_uid: thread_id,
      body: message,
      content_type: 'text',
      status: 'sending',
      sent_by: 'manual',
    })
    .select('id')
    .single();
  if (dbErr) console.error('[Send] DB insert error:', dbErr.message);
  const rowId = row?.id;

  // 2. Trả về NGAY để UI render tức thì (không chờ ~2s typing+gửi của Zalo).
  //    Việc forward + cập nhật trạng thái chạy nền; status reconcile ở refetch kế.
  res.json({ success: true, optimistic: true, id: rowId });

  // 3. Forward (nền) đến sub-handler theo channel_type (đã resolve fail-closed ở bước 0),
  //    rồi cập nhật status theo id.
  const forwardUrl = `http://localhost:${process.env.PORT || 3101}/api/channels/${sub}/send`;
  (async () => {
    try {
      const fwdRes = await fetch(forwardUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `sent_row_id`: row channel_sent_messages do CHÍNH handler này tạo ở bước 1.
        // Sub-handler CSKH cần nó để nối bản-cho-khách với bản-cho-inbox, nhờ vậy thu hồi
        // 1 tin đánh dấu được cả hai kho. Sub-handler khác bỏ qua trường thừa này.
        body: JSON.stringify({ channel_name, thread_id, message, thread_type, skip_db_log: true, sent_row_id: rowId ?? null }),
      });
      const ok = fwdRes.ok;
      if (rowId) {
        await supabase
          .from('channel_sent_messages')
          .update({ status: ok ? 'sent' : 'failed' })
          .eq('id', rowId);
      }
      if (!ok) {
        const fwdData = await fwdRes.json().catch(() => ({}));
        console.error('[Send] Forward failed:', fwdData?.error || fwdRes.status);
      }
    } catch (err: any) {
      console.error('[Send] Forward error:', err.message);
      if (rowId) {
        await supabase.from('channel_sent_messages').update({ status: 'failed' }).eq('id', rowId);
      }
    }
  })();
});

// ── POST /api/channels/conversations — create new conversation (FIX 7) ──
router.post('/conversations', async (req, res) => {
  const { channel, target_id } = req.body;
  if (!channel || !target_id) {
    return res.status(400).json({ error: 'channel và target_id là bắt buộc' });
  }
  // Tạo phiên nếu CHƯA có để hiện trong inbox. Phiên đã tồn tại → KHÔNG ghi đè gì
  // (đặc biệt last_message_at: chỉ consumer tin VÀO + trigger tin RA được ghi — P41, GEM-1212).
  const sessionKey = `${channel}:${target_id}:${target_id}`;
  const { data: existing, error: selErr } = await supabase
    .from('channel_sessions')
    .select('*')
    .eq('session_key', sessionKey)
    .maybeSingle();
  if (selErr) return res.status(500).json({ error: selErr.message });
  if (existing) return res.json(existing);
  const { data, error } = await supabase
    .from('channel_sessions')
    .upsert({
      session_key: sessionKey,
      channel_name: channel,
      chat_id: target_id,
      sender_id: target_id,
      sender_name: target_id,
      status: 'active',
      peer_kind: 'direct',
      last_message_at: new Date().toISOString(),
    }, { onConflict: 'session_key', ignoreDuplicates: true })
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) {
    // race: phiên vừa được tạo bởi writer khác giữa select và upsert
    const { data: row } = await supabase.from('channel_sessions').select('*').eq('session_key', sessionKey).maybeSingle();
    return res.json(row);
  }
  res.json(data);
});

export default router;
