// Operations Routes — Content Pipeline + Affiliate + Scanner
// KHÔNG HARDCODE — TẤT CẢ TỪ SUPABASE QUERY THẬT
// Script execution qua child_process spawn + SSE stream

import { Router } from 'express';
import { supabase } from './zalo-personal/supabase.js';
import { createClient } from '@supabase/supabase-js';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { pushScript, updatePageStatus, bulkUpdatePageStatus, notionPushEnabled } from './notion-push.js';
import DOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { checkOutboundEmail } from './outbound-gate.js';

// HTML sanitizer for user-pasted email bodies. Allows the standard email-safe tag
// surface (basic block/inline tags + a/img + tables + inline style) and strips
// scripts/event handlers/javascript: URIs. Lazy-init the JSDOM window once per
// process — instantiating per-request is wasteful.
let _purify: ReturnType<typeof DOMPurify> | null = null;
function getPurify() {
  if (!_purify) {
    const window = new JSDOM('').window;
    _purify = DOMPurify(window as any);
  }
  return _purify;
}
const EMAIL_SAFE_TAGS = [
  'a', 'b', 'blockquote', 'br', 'code', 'div', 'em', 'figure', 'figcaption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre',
  's', 'small', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot',
  'th', 'thead', 'tr', 'u', 'ul', 'center', 'font', 'style',
];
const EMAIL_SAFE_ATTRS = [
  'href', 'target', 'rel', 'title', 'src', 'alt', 'width', 'height',
  'align', 'valign', 'bgcolor', 'border', 'cellpadding', 'cellspacing',
  'colspan', 'rowspan', 'style', 'class', 'id', 'face', 'color', 'size',
];

function sanitizeEmailHtml(rawHtml: string): { clean: string; removed: number } {
  const before = rawHtml.length;
  const clean = getPurify().sanitize(rawHtml, {
    ALLOWED_TAGS: EMAIL_SAFE_TAGS,
    ALLOWED_ATTR: EMAIL_SAFE_ATTRS,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur'],
  });
  return { clean, removed: Math.max(0, before - clean.length) };
}

// Dedicated Realtime client — service_role key + realtime config.
// LAZY init: đọc key từ env lúc dùng lần đầu (sau khi dotenv nạp) + KHÔNG fallback hardcode.
const REALTIME_URL = 'https://pgfkbcnzqozzkohwbgbk.supabase.co';
let _realtimeClient: ReturnType<typeof createClient> | null = null;
function getRealtimeClient(): ReturnType<typeof createClient> {
  if (!_realtimeClient) {
    const key = process.env.GEMRAL_SUPABASE_SERVICE_KEY;
    if (!key) {
      throw new Error('[ops-routes] GEMRAL_SUPABASE_SERVICE_KEY chưa set — bắt buộc cho realtime client (service_role).');
    }
    _realtimeClient = createClient(REALTIME_URL, key, {
      realtime: { params: { eventsPerSecond: 5 } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _realtimeClient;
}

const router = Router();

// ═══ PATHS ═══
const PAPERCLIP_ROOT = path.resolve(process.cwd(), '..');
const CPS_ROOT = 'C:/Users/Jennie Chu/Desktop/Projects/crypto-pattern-scanner';
const CC_CWD = 'D:/Claude Projects/App Content Jennie/gem-content-center';

// Phase 1: CC Supabase removed — batch_processor now writes directly to Main Supabase

// ═══════════════════════════════════════════════════════
// PUBLISH QUEUE REALTIME LISTENER (hybrid with 5m polling)
// Subscribes to cc_publish_queue INSERT → call BE endpoint instantly
// Gives <1s latency; polling cron (Gemral_PublishQueue 5m) is safety net.
// ═══════════════════════════════════════════════════════

// Realtime dispatcher for cc_publish_queue INSERTs. Two critical invariants
// prevent the feedback loop that generated 379 rows in 11s (2026-04-18):
//
// 1. Skip `trigger_type='manual'` — those rows are ALREADY produced BY the
//    `/publish-now` endpoint. If realtime also calls `/publish-now` for them,
//    the endpoint updates cc_scripts → trigger_type='immediate' row enqueued
//    by DB trigger + another 'manual' row inserted by the endpoint →
//    realtime fires for both → re-dispatch → infinite loop.
//
// 2. Debounce by SCRIPT_ID (not queue row id). A queue-row-id debounce never
//    matches because each loop iteration creates a fresh id.
const REALTIME_DEBOUNCE_MS = 10_000; // one dispatch per script per 10s
const recentScripts = new Map<string, number>();
let realtimeSub: any = null;

function isScriptRecentlyDispatched(sid: string): boolean {
  const last = recentScripts.get(sid);
  if (!last) return false;
  if (Date.now() - last > REALTIME_DEBOUNCE_MS) {
    recentScripts.delete(sid);
    return false;
  }
  return true;
}

async function handlePublishInsert(row: any) {
  const qid = row.id;
  const tt = row.trigger_type;
  const sid = row.script_id;
  if (!qid || !sid) return;
  // 'manual' rows are the endpoint's own audit trail — ignore them to avoid
  // dispatching the endpoint that just inserted them.
  if (tt === 'manual') {
    return;
  }
  if (isScriptRecentlyDispatched(sid)) {
    console.log(`[PublishRealtime] skip duplicate dispatch for script=${sid} (within debounce)`);
    return;
  }
  recentScripts.set(sid, Date.now());
  console.log(`[PublishRealtime] event trigger=${tt} script=${sid} qid=${qid}`);

  try {
    if (tt === 'immediate') {
      const r = await fetch(`http://127.0.0.1:${process.env.PORT || 3100}/api/ops/content-pipeline/scripts/${sid}/publish-now`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      console.log(`[PublishRealtime] publish-now(${sid}) → ${r.status}`);
    } else if (tt === 'threshold') {
      const body = row.channel_target ? JSON.stringify({ channel_target: row.channel_target }) : '{}';
      const r = await fetch(`http://127.0.0.1:${process.env.PORT || 3100}/api/ops/content-pipeline/publish-batch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      });
      console.log(`[PublishRealtime] publish-batch → ${r.status}`);
    }
  } catch (err: any) {
    console.error(`[PublishRealtime] handler error: ${err.message}`);
  }
}

function startPublishRealtime() {
  if (realtimeSub) return;
  try {
    realtimeSub = getRealtimeClient()
      .channel('publish-queue-inserts')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'cc_publish_queue' },
        (payload: any) => handlePublishInsert(payload.new))
      .subscribe((status: string, err?: Error) => {
        console.log(`[PublishRealtime] channel status: ${status}${err ? ' err=' + err.message : ''}`);
        if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
          realtimeSub = null;
          setTimeout(startPublishRealtime, 10000); // retry after 10s
        }
      });
    console.log('[PublishRealtime] Subscribing to cc_publish_queue INSERT events (Realtime)');
  } catch (err: any) {
    console.error('[PublishRealtime] failed to subscribe:', err.message);
    realtimeSub = null;
    setTimeout(startPublishRealtime, 10000);
  }
}

// Kick off subscription on module load (after express router init below)
setTimeout(startPublishRealtime, 2000);

// ═══════════════════════════════════════════════════════
// CONTENT PIPELINE — REAL DATA, NO HARDCODE
// ═══════════════════════════════════════════════════════

// Stats — TẤT CẢ TỪ DB
router.get('/content-pipeline/stats', async (_req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const [published, drafts, processing, total] = await Promise.all([
      supabase.from('cc_scripts').select('*', { count: 'exact', head: true }).eq('status', 'published').gte('updated_at', today + 'T00:00:00Z'),
      supabase.from('cc_scripts').select('*', { count: 'exact', head: true }).eq('status', 'draft'),
      supabase.from('cc_generation_jobs').select('*', { count: 'exact', head: true }).eq('status', 'processing'),
      supabase.from('cc_scripts').select('*', { count: 'exact', head: true }),
    ]);

    res.json({
      posted_today: published.count || 0,
      target_today: 9,
      pending_approval: drafts.count || 0,
      generating: processing.count || 0,
      total_scripts: total.count || 0,
    });
  } catch (err: any) {
    console.error('[Pipeline Stats]', err.message);
    res.status(500).json({ error: 'Lỗi tải thống kê pipeline' });
  }
});

// Scripts CRUD — REAL DB
router.get('/content-pipeline/scripts', async (req, res) => {
  try {
    const { status, pillar, limit = '50', id, generation_job_id } = req.query;
    let query = supabase.from('cc_scripts').select('*').order('created_at', { ascending: false }).limit(Number(limit));
    if (status) query = query.eq('status', String(status));
    if (pillar) query = query.eq('pillar', String(pillar));
    // 2026-04-26 — UI poll uses these to resolve a script after a DOC-* generation
    // completes. Without them, ?id=X and ?generation_job_id=X were silently ignored
    // and the endpoint returned latest 50 of EVERY user → wrong script picked up.
    if (id) query = query.eq('id', String(id));
    if (generation_job_id) {
      // batch_processor.py writes the originating job id into metadata->>'job_id'
      // (the dedicated generation_job_id FK column is left NULL as of 2026-04-26).
      // Match either location so the UI poll can resolve a script regardless of
      // which back-link batch_processor populated.
      const jobId = String(generation_job_id);
      query = query.or(`generation_job_id.eq.${jobId},metadata->>job_id.eq.${jobId}`);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/content-pipeline/scripts/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('cc_scripts').update(req.body).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/content-pipeline/scripts/:id/approve', async (req, res) => {
  try {
    const { data, error } = await supabase.from('cc_scripts')
      .update({ status: 'approved', approved_at: new Date().toISOString() })
      .eq('id', req.params.id).select('*').single();
    if (error) throw error;
    // Fire-and-forget: push Status=Approved to Notion. Never block the UI —
    // if NOTION_TOKEN is missing or Notion is flaky, the DB write still succeeds.
    // If no Notion page exists yet (manually-inserted row), fall back to full push.
    void (async () => {
      const quick = await updatePageStatus(req.params.id, 'approved');
      if (!quick.ok && quick.note === 'no-page') {
        await pushScript(req.params.id);
      }
    })().catch((e) => console.warn('[notion-push] approve fail', e));
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/content-pipeline/scripts/:id/reject', async (req, res) => {
  try {
    const { reason } = req.body;
    const { data, error } = await supabase.from('cc_scripts')
      .update({ status: 'rejected', rejection_reason: reason })
      .eq('id', req.params.id).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk approve
router.post('/content-pipeline/scripts/bulk-approve', async (req, res) => {
  try {
    const { script_ids } = req.body;
    if (!script_ids?.length) return res.status(400).json({ error: 'Không có script_ids' });
    const { error } = await supabase.from('cc_scripts')
      .update({ status: 'approved', approved_at: new Date().toISOString() })
      .in('id', script_ids);
    if (error) throw error;
    // Fire-and-forget bulk sync to Notion — paced at ~350ms/req inside helper
    // to stay under Notion 3 req/s rate limit.
    void bulkUpdatePageStatus(script_ids, 'approved').catch((e) =>
      console.warn('[notion-push] bulk-approve fail', e),
    );
    res.json({ approved: script_ids.length });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete('/content-pipeline/scripts/:id', async (req, res) => {
  try {
    await supabase.from('cc_scripts').delete().eq('id', req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk delete
router.post('/content-pipeline/scripts/bulk-delete', async (req, res) => {
  try {
    const { script_ids } = req.body;
    if (!script_ids?.length) return res.status(400).json({ error: 'Không có script_ids' });
    const { error } = await supabase.from('cc_scripts').delete().in('id', script_ids);
    if (error) throw error;
    res.json({ success: true, deleted: script_ids.length });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// 1B: Editable schedule — PUT /content-pipeline/scripts/:key/schedule
router.put('/content-pipeline/scripts/:key/schedule', async (req, res) => {
  try {
    const { key } = req.params;
    const { schedule, hour, minute, frequency, weekday } = req.body;
    if (!schedule) return res.status(400).json({ error: 'schedule required' });
    // Store in system_config: key = pipeline.script.<key>.schedule
    const configKey = `pipeline.script.${key}.schedule`;
    const { error } = await supabase
      .from('system_config')
      .upsert({ key: configKey, value: JSON.stringify({ schedule, hour, minute, frequency, weekday }), updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) throw error;
    res.json({ key, schedule });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Generation Jobs — REAL DB + actions
router.get('/content-pipeline/jobs', async (req, res) => {
  try {
    const { status, limit = '200' } = req.query;
    let query = supabase
      .from('cc_generation_jobs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(parseInt(limit as string));
    if (status) {
      const statuses = (status as string).split(',');
      query = query.in('status', statuses);
    }
    const { data, error } = await query;
    if (error) throw error;

    const jobs = (data || []).map((job: any) => {
      let params: any = {};
      try { params = typeof job.input_params === 'string' ? JSON.parse(job.input_params) : (job.input_params || {}); } catch {}
      let outData: any = {};
      try { outData = typeof job.output_data === 'string' ? JSON.parse(job.output_data) : (job.output_data || {}); } catch {}
      return {
        ...job,
        // Prefer DB columns, fall back to input_params only when DB is empty
        pillar: (job.pillar || params.pillar || params.track || ''),
        content_type: (job.content_type || params.contentType || params.content_type || ''),
        topic: params.userPrompt?.slice(0, 120) || params.topic || job.topic || '',
        brand_voice: job.brand_voice || params.brandVoice || 'jennie',
        // Expose provider/model from input_params for display
        _provider: params.provider || '',
        _model: params.model || '',
        // Flatten output_data for easy frontend access
        output_content: outData.content || (typeof outData === 'string' ? outData : ''),
        script_id: outData.script_id || null,
      };
    });
    res.json({ jobs });
  } catch (err: any) {
    res.status(500).json({ error: 'Lỗi tải jobs' });
  }
});

router.post('/content-pipeline/jobs/:id/retry', async (req, res) => {
  try {
    const { error } = await supabase.from('cc_generation_jobs').update({ status: 'queued', output_error: null, processor: null, started_at: null }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ message: 'Job đã được queue lại' });
  } catch (err: any) {
    res.status(500).json({ error: 'Lỗi retry job' });
  }
});

router.post('/content-pipeline/jobs/:id/cancel', async (req, res) => {
  try {
    const { error } = await supabase.from('cc_generation_jobs').update({ status: 'cancelled' }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ message: 'Job đã hủy' });
  } catch (err: any) {
    res.status(500).json({ error: 'Lỗi hủy job' });
  }
});

router.delete('/content-pipeline/jobs/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('cc_generation_jobs').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ message: 'Job đã xóa' });
  } catch (err: any) {
    res.status(500).json({ error: 'Lỗi xóa job' });
  }
});

// Edit job output content — auto-sync to cc_scripts if linked
router.put('/content-pipeline/jobs/:id/output', async (req, res) => {
  try {
    const { output_text } = req.body;
    if (typeof output_text !== 'string') return res.status(400).json({ error: 'output_text required' });

    const { error } = await supabase
      .from('cc_generation_jobs')
      .update({ output_text, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if (error) throw error;

    // Auto-sync to cc_scripts if linked via metadata.job_id
    await supabase
      .from('cc_scripts')
      .update({ body: output_text })
      .eq('metadata->>job_id', req.params.id);

    res.json({ message: 'Đã cập nhật nội dung' });
  } catch (err: any) {
    res.status(500).json({ error: 'Lỗi cập nhật output' });
  }
});

// Script Execution — CHILD_PROCESS SPAWN + SSE STREAM
// Scripts paths — THẬT từ SOP-CONTENT-PIPELINE.md
const SCRIPTS_CONFIG: Record<string, { path: string; cwd: string; args: string[]; label: string }> = {
  'batch_generate': { path: 'scripts/batch_processor.py', cwd: CC_CWD, args: ['batch'], label: 'Batch Generate' },
  'daily_post': { path: 'scripts/daily_facebook_post.py', cwd: CPS_ROOT, args: [], label: 'Facebook Posts' },
  'pipeline_audit': { path: 'scripts/daily_pipeline_audit.py', cwd: CPS_ROOT, args: [], label: 'Pipeline Audit' },
  'daily_email': { path: 'scripts/send_daily_newsletter.py', cwd: CPS_ROOT, args: [], label: 'Email Segments' },
  'daily_push': { path: 'scripts/daily_pipeline_orchestrator.py', cwd: CPS_ROOT, args: ['--stage', 'push'], label: 'Push Notifications' },
  'compose_images': { path: 'agents/designer/scripts/social_image_composer.py', cwd: CPS_ROOT, args: [], label: 'Image Composer' },
  'weekly_plan': { path: 'scripts/weekly_content_queue.py', cwd: CPS_ROOT, args: ['--create-plan'], label: 'Weekly Plan' },
  'weekly_queue': { path: 'scripts/weekly_content_queue.py', cwd: CPS_ROOT, args: ['--from-plan'], label: 'Weekly Queue' },
  'schedule_test_one': { path: 'scripts/schedule_meta_business_suite.py', cwd: CPS_ROOT, args: ['--weeks', '2', '--test-one'], label: 'Schedule Test' },
  'schedule_page_jennie': { path: 'scripts/schedule_meta_business_suite.py', cwd: CPS_ROOT, args: ['--weeks', '2', '--account', 'page_jennie'], label: 'Schedule Page Jennie' },
  'schedule_page_gemral': { path: 'scripts/schedule_meta_business_suite.py', cwd: CPS_ROOT, args: ['--weeks', '2', '--account', 'page_gemral'], label: 'Schedule Page Gemral' },
  'schedule_profile_jennie': { path: 'scripts/schedule_meta_business_suite.py', cwd: CPS_ROOT, args: ['--weeks', '2', '--account', 'profile_jennie'], label: 'Schedule Profile Jennie' },
  'schedule_all': { path: 'scripts/schedule_meta_business_suite.py', cwd: CPS_ROOT, args: ['--weeks', '2'], label: 'Schedule All' },
};

router.post('/content-pipeline/execute/:script', (req, res) => {
  const scriptKey = req.params.script;
  const config = SCRIPTS_CONFIG[scriptKey];

  if (!config) {
    return res.status(400).json({ error: `Script không hợp lệ: ${scriptKey}. Hợp lệ: ${Object.keys(SCRIPTS_CONFIG).join(', ')}` });
  }

  const scriptPath = path.resolve(config.cwd, config.path);
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: `Script không tìm thấy: ${scriptPath}`, hint: 'Kiểm tra đường dẫn' });
  }

  // SSE stream
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const extraArgs = req.body?.args || [];
  const proc = spawn('python', [scriptPath, ...config.args, ...extraArgs], {
    cwd: config.cwd,
    env: { ...process.env, PYTHONUTF8: '1' },
    windowsHide: true,
  });

  res.write(`data: ${JSON.stringify({ type: 'start', script: scriptKey, path: scriptPath })}\n\n`);

  proc.stdout?.setEncoding("utf8");
  proc.stdout.on('data', (data) => {
    res.write(`data: ${JSON.stringify({ type: 'stdout', text: data.toString() })}\n\n`);
  });

  proc.stderr?.setEncoding("utf8");
  proc.stderr.on('data', (data) => {
    res.write(`data: ${JSON.stringify({ type: 'stderr', text: data.toString() })}\n\n`);
  });

  proc.on('close', (code) => {
    res.write(`data: ${JSON.stringify({ type: 'exit', code, script: scriptKey })}\n\n`);
    res.end();
  });

  proc.on('error', (err) => {
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
    res.end();
  });

  const timeout = setTimeout(() => { proc.kill(); res.write(`data: ${JSON.stringify({ type: 'timeout', message: 'Script quá 15 phút' })}\n\n`); res.end(); }, 15 * 60 * 1000);
  proc.on('close', () => clearTimeout(timeout));
});

// ═══════════════════════════════════════════════════════
// BATCH PROCESSOR — start / stop / status (fire-and-forget)
// ═══════════════════════════════════════════════════════
const batchProcs = new Map<string, ReturnType<typeof spawn>>();

router.post('/content-pipeline/batch/start', (req, res) => {
  const key = 'batch_processor';
  const existing = batchProcs.get(key);
  if (existing && !existing.killed) {
    return res.json({ ok: true, running: true, pid: existing.pid, message: 'Đã đang chạy' });
  }

  const scriptPath = path.resolve(CC_CWD, 'scripts/batch_processor.py');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ ok: false, error: `Script không tìm thấy: ${scriptPath}` });
  }

  // 2026-04-18 — `batch` (subcommand) is a one-shot that polls once and
  // exits. `--batch` (flag) is the continuous watcher Jennie wants: poll,
  // process queue, sleep, repeat. Using the subcommand caused the UI to
  // revert to 'Play' within ~5s because the process finished immediately.
  const proc = spawn('python', [scriptPath, '--batch'], {
    cwd: CC_CWD,
    env: { ...process.env, PYTHONUTF8: '1' },
    windowsHide: true,
    detached: false,
  });

  batchProcs.set(key, proc);
  proc.on('close', () => batchProcs.delete(key));
  proc.on('error', () => batchProcs.delete(key));

  console.log(`[BatchProcessor] Started PID=${proc.pid}`);
  return res.json({ ok: true, running: true, pid: proc.pid });
});

router.post('/content-pipeline/batch/stop', (_req, res) => {
  const key = 'batch_processor';
  const proc = batchProcs.get(key);
  if (!proc || proc.killed) {
    batchProcs.delete(key);
    return res.json({ ok: true, running: false, message: 'Không có process đang chạy' });
  }
  proc.kill('SIGTERM');
  batchProcs.delete(key);
  console.log('[BatchProcessor] Stopped');
  return res.json({ ok: true, running: false });
});

router.get('/content-pipeline/batch/status', (_req, res) => {
  const key = 'batch_processor';
  const proc = batchProcs.get(key);
  const running = !!proc && !proc.killed;
  return res.json({ running, pid: running ? proc!.pid : null });
});

// Jobs summary — count by status (lightweight)
router.get('/content-pipeline/jobs-summary', async (_req, res) => {
  try {
    const statuses = ['queued', 'processing', 'completed', 'failed', 'cancelled'];
    const counts: Record<string, number> = {};
    for (const status of statuses) {
      const { count } = await supabase.from('cc_generation_jobs').select('*', { count: 'exact', head: true }).eq('status', status);
      counts[status] = count || 0;
    }
    res.json(counts);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /scripts — tạo script thủ công
router.post('/content-pipeline/scripts', async (req, res) => {
  try {
    const {
      title,
      body,
      content_type,
      pillar,
      brand_voice,
      status,
      track,
      persona,
      writing_mode,
      // Optional fields accepted by cc_scripts — UI must pass explicit values,
      // no hardcoded defaults beyond what the schema requires. Missing fields
      // stay NULL (schema allows). posted_account drives which Meta BS account
      // the publisher uses; publish_mode controls the trigger flow.
      hook,
      cta,
      word_count,
      posted_account,
      posted_time_slot,
      scheduled_at,
      publish_mode,
      image_urls,
      tags,
      notes,
      metadata,
      // Content gating — tier tối thiểu + danh sách course được phép đọc.
      // NULL = không khóa. Cột do migration 20260613120000 thêm vào cc_scripts.
      required_tier,
      required_course_ids,
    } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'Tiêu đề không được trống' });
    // cc_scripts NOT NULL columns without defaults: title, content_type, track,
    // pillar, persona, writing_mode, body, hook, cta, word_count,
    // estimated_duration_seconds, status, publish_mode, version,
    // publish_attempt_count, created_by. Provide sane defaults so manual UI
    // create doesn't die on constraint violation. Callers can still override.
    const insertRow: Record<string, unknown> = {
      title: title.trim(),
      body: body ?? '',
      hook: hook ?? '',
      cta: cta ?? '',
      word_count: typeof word_count === 'number' ? word_count : 0,
      content_type: content_type || 'social_post',
      track: track || 'wealth',
      pillar: pillar || 'trading',
      persona: persona || 'jennie_mentor',
      writing_mode: writing_mode || 'mode_1_calm',
      brand_voice: brand_voice || 'jennie',
      status: status || 'draft',
      publish_mode: publish_mode
        || (content_type === 'push_notification' ? 'immediate' : 'scheduled'),
    };
    const resolvedPostedAccount = posted_account
      || (content_type === 'news' ? 'forum' : undefined)
      || (content_type === 'push_notification' ? 'push' : undefined);
    if (resolvedPostedAccount !== undefined) insertRow.posted_account = resolvedPostedAccount;
    if (posted_time_slot !== undefined) insertRow.posted_time_slot = posted_time_slot;
    if (scheduled_at !== undefined) insertRow.scheduled_at = scheduled_at;
    if (Array.isArray(image_urls)) insertRow.image_urls = image_urls;
    if (Array.isArray(tags)) insertRow.tags = tags;
    if (notes !== undefined) insertRow.notes = notes;
    if (metadata !== undefined) insertRow.metadata = metadata;
    if (required_tier !== undefined) insertRow.required_tier = required_tier;
    if (required_course_ids !== undefined) insertRow.required_course_ids = required_course_ids;
    const { data, error } = await supabase.from('cc_scripts').insert(insertRow).select('*').single();
    if (error) throw error;
    // Fire-and-forget: create matching Notion page in CONTENT PLANNER 2026 so
    // Jennie sees the new row there without waiting for the weekly migrate cron.
    // Writes notion_page_id back to cc_scripts on success. No-op if NOTION_TOKEN
    // is unset, so the BE endpoint still works even without Notion configured.
    if (data?.id) {
      void pushScript(data.id).catch((e) => console.warn('[notion-push] create fail', e));
    }
    res.json(data);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /generate — tạo AI generation job.
// Accepts:
//   content_type: str (e.g. 'social_post', 'email', 'DOC-MKT-001', 'DOC-ONB-002', ...)
//   topic: str (free-form brief; optional for DOC-* types that self-describe via SOP)
//   brand_voice: 'jennie' | 'generic' (default 'jennie')
//   pillar: str (default 'trading')
//   email_day: 1..N | 'all' (only meaningful for DOC-ONB-* types)
//   sop_id: str (explicit SOP linkage; if provided, overrides content_type for SOP lookup)
// For DOC-* content_types, batch_processor reads DOC_KNOWLEDGE_FILES + DOC_PROMPT_TEMPLATES.
router.post('/content-pipeline/generate', async (req, res) => {
  try {
    const {
      content_type,
      topic,
      title, // optional document title (separate from topic/brief)
      brand_voice,
      pillar,
      email_day,
      sop_id,
      ai_provider,
      ai_model,
      persona,
      writing_mode,
      track,
      // Posting metadata — pass-through to batch_processor so the generated
      // cc_scripts row has the right account/publish flags set from the UI
      // instead of defaulting and forcing a later manual edit.
      posted_account,
      posted_time_slot,
      scheduled_at,
      publish_mode,
      // 2026-04-19 — DOC-* output format override (markdown/html/both).
      // Batch processor reads input_params.output_format (lowercase with underscore).
      output_format,
      // 2026-04-19 (Plan v2 Phase B) — Email marketing schema passthrough.
      // Khi content_type='email' hoặc DOC-ONB-*/DOC-AFF-*/DOC-CS-011, UI gửi
      // các field này để populate cc_email_campaigns khi Notion Approved.
      from_name,
      from_email,
      email_template,
      audience_type,
      reply_to,
      preview_text,
      campaign_type,
      // 2026-04-19 Path A — Drip step override. UI set khi Jennie tick "Override drip step".
      // Batch processor lưu vào cc_scripts.metadata.drip_step_id_override.
      // Notion webhook khi Approve sẽ auto-link cc_email_campaigns vào step.
      drip_step_id_override,
      // 2026-04-19 V2 — Sequence id (meta-data để UI trace lại + Notion tag).
      drip_sequence_id,
      // 2026-04-19 V2 — Per-step extra prompt. UI gõ textarea → batch_processor append
      // vào user prompt. Fallback cascade: extra_prompt → step.generation_hint (từ DB)
      // → DOC_ONB_DAY_HINTS (hardcoded baseline trong batch_processor).
      extra_prompt,
    } = req.body || {};
    const ct: string = content_type || 'social_post';
    // For DOC-* and DST-* rows we want job_type = 'doc_tai_lieu' so batch_processor
    // knows it's a knowledge-driven doc write. Other content_types keep legacy mapping.
    // 2026-05-13: extended DST- (Daily SOP email sequences) — same semantic as DOC-ONB-*.
    const jobType = (ct.startsWith('DOC-') || ct.startsWith('DST-')) ? 'doc_tai_lieu' : ct;
    // Default to 'gemini' — Claude is BLOCKED in batch_processor per Jennie's
    // directive (scripts/batch_processor.py line 3542 fallback). If UI doesn't
    // pass ai_provider, batch would default to 'claude' and fail. Keep BE default
    // in sync with batch_processor expectations.
    const provider = (ai_provider || 'gemini').toLowerCase();
    const inputParams: Record<string, unknown> = {
      userPrompt: topic || '',
      brandVoice: brand_voice || 'jennie',
      pillar: pillar || 'trading',
      contentType: ct,
      provider,
    };
    if (ai_model) inputParams.model = ai_model;
    if (persona) inputParams.persona = persona;
    if (writing_mode) inputParams.writingMode = writing_mode;
    if (track) inputParams.track = track;
    if (posted_account) inputParams.posted_account = posted_account;
    if (posted_time_slot) inputParams.posted_time_slot = posted_time_slot;
    if (scheduled_at) inputParams.scheduled_at = scheduled_at;
    if (publish_mode) inputParams.publish_mode = publish_mode;
    if (title) inputParams.title = title;
    if (output_format) inputParams.output_format = output_format;
    if (email_day !== undefined && email_day !== null && email_day !== '') {
      inputParams.email_day = email_day;
    }
    if (sop_id) {
      inputParams.sop_id = sop_id;
    } else if (ct.startsWith('DOC-')) {
      inputParams.sop_id = ct; // DOC-* content_type doubles as SOP id
    }
    // 2026-04-19 — Email schema fields (Phase B of plan v2)
    if (from_name) inputParams.from_name = from_name;
    if (from_email) inputParams.from_email = from_email;
    if (email_template) inputParams.email_template = email_template;
    if (audience_type) inputParams.audience_type = audience_type;
    if (reply_to) inputParams.reply_to = reply_to;
    if (preview_text) inputParams.preview_text = preview_text;
    if (campaign_type) inputParams.campaign_type = campaign_type;
    if (drip_step_id_override) inputParams.drip_step_id_override = drip_step_id_override;
    if (drip_sequence_id) inputParams.drip_sequence_id = drip_sequence_id;
    if (extra_prompt && typeof extra_prompt === 'string' && extra_prompt.trim().length > 0) {
      inputParams.extra_prompt = extra_prompt.trim();
    }
    // 2026-04-19 FIX — KHÔNG JSON.stringify inputParams vì input_params là jsonb.
    // Supabase-js tự serialize object. Double-encode trước đây khiến batch processor
    // phải json.loads() lại, và SQL query phải unescape `"{\"key\":...}"` làm lộn xộn.
    //
    // 2026-04-19 Phase 5 — ALSO set top-level columns (track/pillar/persona/writing_mode)
    // vì auto_save_to_cc_scripts ưu tiên đọc job.get("track") trước fallback input_params.
    // Nếu bỏ, cc_scripts.pillar luôn default "lifestyle" mặc dù UI chọn khác.
    const jobInsert: Record<string, unknown> = {
      job_type: jobType,
      content_type: ct,
      status: 'queued',
      input_params: inputParams,
    };
    if (track) jobInsert.track = track;
    if (pillar) jobInsert.pillar = pillar;
    if (persona) jobInsert.persona = persona;
    if (writing_mode) jobInsert.writing_mode = writing_mode;
    const { data, error } = await supabase.from('cc_generation_jobs').insert(jobInsert).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Links — parse IMPORTANT_LINKS.md
router.get('/content-pipeline/links', (_req, res) => {
  const linksPath = path.join(CPS_ROOT, 'docs/IMPORTANT_LINKS.md');
  if (!fs.existsSync(linksPath)) return res.json({ links: [], raw: '', exists: false });
  const raw = fs.readFileSync(linksPath, 'utf-8');
  const links: Array<{ category: string; name: string; url: string }> = [];
  let cat = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('## ')) cat = line.replace('## ', '').trim();
    const m = line.match(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
    if (m) links.push({ category: cat, name: m[1], url: m[2] });
    const m2 = line.match(/\|\s*(.+?)\s*\|\s*(https?:\/\/\S+)\s*\|/);
    if (m2) links.push({ category: cat, name: m2[1].trim(), url: m2[2].trim() });
  }
  res.json({ links, raw, exists: true });
});

// Chain status
router.get('/content-pipeline/chain-status', (_req, res) => {
  const statusPath = path.join(CPS_ROOT, 'memory/pipeline-chain-status.json');
  if (!fs.existsSync(statusPath)) return res.json({ steps: [], last_run: null });
  try {
    const data = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
    res.json(data);
  } catch { res.json({ steps: [], last_run: null }); }
});

// Agents list for pipeline delegation
router.get('/content-pipeline/agents', async (_req, res) => {
  try {
    // Use agent-configs which has slug + display_name
    const configRes = await fetch('http://127.0.0.1:3101/api/channels/agent-configs');
    const allAgents = configRes.ok ? await configRes.json() : [];
    const pipelineSlugs = ['ceo', 'content-strategist', 'social-media-manager', 'designer',
       'email-crm-manager', 'community-engagement', 'data-analyst'];
    const pipelineAgents = (allAgents as any[]).filter(a => pipelineSlugs.includes(a.slug));
    res.json({ agents: pipelineAgents });
  } catch { res.json({ agents: [] }); }
});

// Delegate task to agent
router.post('/content-pipeline/delegate', (req, res) => {
  const { agent_slug, task, context } = req.body;
  if (!agent_slug || !task) return res.status(400).json({ error: 'Thiếu agent_slug hoặc task' });

  // Find claude CLI
  const claudeBin = process.platform === 'win32' ? 'claude' : 'claude';
  const agentCwd = path.join(CPS_ROOT, 'agents', agent_slug);

  const taskPrompt = `[PIPELINE TASK — ĐƯỢC GIAO TỪ DASHBOARD]\n\n${task}\n\n${context ? `Bối cảnh:\n${context}` : ''}`;

  // SSE stream
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: 'start', agent: agent_slug, task })}\n\n`);

  const proc = spawn(claudeBin, ['--dangerously-skip-permissions', '-p', taskPrompt], {
    cwd: fs.existsSync(agentCwd) ? agentCwd : CPS_ROOT,
    env: { ...process.env },
    shell: true,
    timeout: 600_000,
    windowsHide: true,
  });

  proc.stdout?.setEncoding("utf8");
  proc.stdout?.on('data', (chunk: Buffer) => { res.write(`data: ${JSON.stringify({ type: 'stdout', text: chunk.toString() })}\n\n`); });
  proc.stderr?.setEncoding("utf8");
  proc.stderr?.on('data', (chunk: Buffer) => { res.write(`data: ${JSON.stringify({ type: 'stderr', text: chunk.toString() })}\n\n`); });
  proc.on('close', (code: number | null) => { res.write(`data: ${JSON.stringify({ type: 'exit', code, agent: agent_slug })}\n\n`); res.end(); });
  proc.on('error', (err: Error) => { res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`); res.end(); });
  req.on('close', () => { if (!proc.killed) proc.kill(); });
});

// Reload agents
router.post('/content-pipeline/reload-agents', (_req, res) => {
  // Agents run via Paperclip heartbeat — not PM2
  res.json({ message: 'Agent context sẽ được reload ở lần heartbeat tiếp theo' });
});

// Schedule
router.get('/content-pipeline/schedule', async (req, res) => {
  try {
    const { date } = req.query;
    // Column is `scheduled_date` (a DATE) plus a separate `scheduled_time`; the old
    // `scheduled_at` never existed, so PostgREST rejected every one of these queries.
    let query = supabase
      .from('cc_calendar_events')
      .select('*')
      .order('scheduled_date', { ascending: true })
      .order('scheduled_time', { ascending: true, nullsFirst: true });
    if (date) query = query.eq('scheduled_date', date as string);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch { res.json([]); }
});

router.post('/content-pipeline/schedule/bulk', async (req, res) => {
  const { weeks = 2, account, test_one } = req.body;
  // TODO: execute schedule_meta_business_suite.py with SSE
  res.json({ success: true, message: `Lên lịch ${test_one ? '1 bài test' : `${weeks} tuần`}${account ? ` cho ${account}` : ' tất cả'}` });
});

// POST /content-pipeline/schedule — lên lịch 1 bài
router.post('/content-pipeline/schedule', async (req, res) => {
  try {
    const { script_id, scheduled_at, account } = req.body;
    if (!script_id || !scheduled_at) return res.status(400).json({ error: 'script_id và scheduled_at là bắt buộc' });

    const dt = new Date(scheduled_at);
    const scheduledDate = dt.toISOString().split('T')[0]; // YYYY-MM-DD
    const scheduledTime = dt.toTimeString().slice(0, 8);   // HH:MM:SS

    // Lấy script
    const { data: script } = await supabase.from('cc_scripts').select('title, body, image_urls, content_type, track, pillar, persona').eq('id', script_id).single();

    // Tạo calendar event — đúng schema cc_calendar_events
    const { data, error } = await supabase.from('cc_calendar_events').insert({
      script_id,
      title: script?.title || 'Bài đăng',
      description: script?.body?.slice(0, 300) || '',
      content_type: script?.content_type || 'social_post',
      track: script?.track || null,
      pillar: script?.pillar || null,
      persona: script?.persona || null,
      scheduled_date: scheduledDate,
      scheduled_time: scheduledTime,
      status: 'scheduled',
      event_type: 'post',
      platforms: [account || 'profile_jennie'],
      metadata: { account, image_urls: script?.image_urls || [] },
    }).select().single();

    if (error) throw error;

    // Cập nhật script: status + scheduled_at + posted_account
    await supabase.from('cc_scripts').update({
      status: 'scheduled',
      posted_account: account,
      scheduled_at: dt.toISOString(),
    }).eq('id', script_id);

    res.json({ success: true, event: data });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Lỗi lên lịch' });
  }
});

// POST /content-pipeline/agent-review — giao review cho agent qua War Room
router.post('/content-pipeline/agent-review', async (req, res) => {
  try {
    const { script_id, agent, task } = req.body;
    if (!script_id || !task) return res.status(400).json({ error: 'script_id và task là bắt buộc' });

    // Tìm channel #general hoặc #learning-room
    const { data: channel } = await supabase
      .from('war_room_channels')
      .select('id')
      .or('slug.eq.general,name.ilike.%general%')
      .limit(1)
      .single();

    if (!channel) return res.status(404).json({ error: 'Không tìm thấy War Room channel' });

    // Gửi message vào channel với @mention agent
    const { error } = await supabase.from('war_room_messages').insert({
      channel_id: channel.id,
      sender: 'ops-pipeline',
      content: `@${agent} ${task}`,
      metadata: { script_id, type: 'agent_review_request', agent },
      created_at: new Date().toISOString(),
    });

    if (error) throw error;
    res.json({ success: true, message: `Đã giao review cho ${agent} qua War Room` });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Lỗi giao review' });
  }
});

// POST /content-pipeline/scripts/:id/images — upload hình ảnh (multipart)
// Dùng Supabase Storage bucket 'cc-content' (public)
router.post('/content-pipeline/scripts/:id/images', async (req, res) => {
  try {
    const { id } = req.params;
    const { image_url } = req.body; // Client gửi URL sau khi upload trực tiếp lên Supabase
    if (!image_url) return res.status(400).json({ error: 'image_url required' });

    const { data: script } = await supabase.from('cc_scripts').select('image_urls').eq('id', id).single();
    const existing: string[] = script?.image_urls || [];
    const newUrls = [...existing, image_url];

    const { error } = await supabase.from('cc_scripts').update({ image_urls: newUrls }).eq('id', id);
    if (error) throw error;

    res.json({ success: true, image_urls: newUrls });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Compliance check — REAL banned words
const BANNED_WORDS = ['giàu nhanh', 'kiếm tiền dễ dàng', 'thu nhập thụ động', 'bí mật làm giàu', 'đảm bảo lợi nhuận', 'get rich quick', 'bói toán', 'phán số mệnh', 'ma quỷ'];
router.post('/content-pipeline/compliance-check', async (req, res) => {
  const { content } = req.body;
  if (!content) return res.json({ pass: true, violations: [] });
  const lower = content.toLowerCase();
  const violations = BANNED_WORDS.filter(w => lower.includes(w));
  res.json({ pass: violations.length === 0, violations });
});

// Skill Files — REAL PATHS ON DISK
const SKILL_FILES: Record<string, { filePath: string; description: string }> = {
  'SKILL-FACEBOOK-POSTING-PLAYWRIGHT.md': { filePath: path.join(CPS_ROOT, 'skills-store/SKILL-FACEBOOK-POSTING-PLAYWRIGHT.md'), description: 'Quy trình đăng Facebook qua Playwright' },
  'SKILL-batch-processor.md': { filePath: 'D:/Claude Projects/App Content Jennie/gem-content-center/CLAUDE.md', description: 'Batch processor usage guide' },
  'SKILL-schedule-meta-business-suite.md': { filePath: path.join(CPS_ROOT, 'skills-store/SKILL-schedule-meta-business-suite.md'), description: 'Meta Business Suite scheduling' },
  'SOP-CONTENT-PIPELINE.md': { filePath: path.join(CPS_ROOT, 'memory/sops/SOP-CONTENT-PIPELINE.md'), description: 'SOP pipeline V3' },
  'social-channels.md': { filePath: path.join(CPS_ROOT, 'memory/social-channels.md'), description: 'Danh sách kênh social' },
  'IMPORTANT_LINKS.md': { filePath: path.join(CPS_ROOT, 'docs/IMPORTANT_LINKS.md'), description: 'Links + CTA mapping' },
};

router.get('/content-pipeline/skills', (_req, res) => {
  const skills = Object.entries(SKILL_FILES).map(([name, config]) => ({
    name, description: config.description, path: config.filePath, exists: fs.existsSync(config.filePath),
  }));
  res.json({ skills });
});

router.get('/content-pipeline/skills/:name', (req, res) => {
  const config = SKILL_FILES[req.params.name];
  if (!config) return res.status(404).json({ error: `Skill "${req.params.name}" không tồn tại trong config` });
  if (!fs.existsSync(config.filePath)) return res.status(404).json({ error: 'File không tìm thấy', path: config.filePath });
  try {
    const content = fs.readFileSync(config.filePath, 'utf-8');
    res.json({ name: req.params.name, content, path: config.filePath });
  } catch (err: any) {
    res.status(500).json({ error: `Lỗi đọc: ${err.message}` });
  }
});

router.put('/content-pipeline/skills/:name', (req, res) => {
  const config = SKILL_FILES[req.params.name];
  if (!config) return res.status(404).json({ error: `Skill "${req.params.name}" không tồn tại` });
  try {
    fs.writeFileSync(config.filePath, req.body.content, 'utf-8');
    res.json({ message: `Đã lưu ${req.params.name}`, path: config.filePath });
  } catch (err: any) {
    res.status(500).json({ error: `Lỗi ghi: ${err.message}` });
  }
});

// Sync CC → Main — REMOVED (Phase 1: batch_processor now writes directly to Main Supabase)

// ═══════════════════════════════════════════════════════
// EMAIL SEND — RESEND API
// ═══════════════════════════════════════════════════════

router.post('/email/send', async (req, res) => {
  try {
    const { from, to, bcc, subject, html } = req.body;
    if (!to || !subject || !html) {
      return res.status(400).json({ success: false, error: 'Thiếu to, subject hoặc html' });
    }

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ success: false, error: 'RESEND_API_KEY chưa được cấu hình' });
    }

    // Cổng KHÔNG-GỌI-KHÔNG-HỌP (chị Jennie 15/10/2026, SOP-CUSTOMER-FACING-AGENT-PRIVACY §7)
    const blockedByGate = await checkOutboundEmail(String(html), String(subject), 'ops.email.send');
    if (blockedByGate) {
      return res.status(422).json({ success: false, error: 'BLOCKED_BY_NO_CALL_GATE', detail: blockedByGate });
    }

    const payload: Record<string, unknown> = {
      from: from || 'GEM <noreply@gemral.com>',
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
    };
    if (bcc) {
      const bccList = Array.isArray(bcc) ? bcc : [bcc];
      const cleaned = bccList.map((e: string) => e.trim()).filter(Boolean);
      if (cleaned.length > 0) payload.bcc = cleaned;
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json() as any;
    if (!response.ok) {
      return res.status(response.status).json({ success: false, error: data.message || data.error || 'Lỗi Resend API' });
    }

    res.json({ success: true, id: data.id, data });
  } catch (err: any) {
    console.error('[Email Send]', err.message);
    res.status(500).json({ success: false, error: err.message || 'Lỗi gửi email' });
  }
});

// ═══════════════════════════════════════════════════════
// AFFILIATE — REAL DB
// ═══════════════════════════════════════════════════════

router.get('/affiliate/stats', async (_req, res) => {
  try {
    // Cột vai của affiliate_profiles là `role` (CHECK IN ('ctv','kol')).
    // `partnership_role` là cột của `profiles`, KHÔNG có ở đây ⇒ query cột lạ thì
    // PostgREST trả 400 và `catch` dưới đây nuốt thành 0/0/0 (đọc như "chưa có đối tác").
    const { data: profiles } = await supabase.from('affiliate_profiles').select('role, is_active, total_sales');
    const all = profiles || [];
    const ctv = all.filter(p => p.role === 'ctv' || !p.role).length;
    const kol = all.filter(p => p.role === 'kol').length;
    const monthSales = all.reduce((s, p) => s + (parseFloat(p.total_sales) || 0), 0);
    const { count: pendingCount } = await supabase.from('partnership_applications').select('id', { count: 'exact', head: true }).eq('status', 'pending');
    res.json({ ctv, kol, pending: pendingCount || 0, month_sales: monthSales });
  } catch { res.json({ ctv: 0, kol: 0, pending: 0, month_sales: 0 }); }
});

router.get('/affiliate/pending', async (_req, res) => {
  try {
    const { data } = await supabase.from('partnership_applications').select('*').eq('status', 'pending').order('created_at', { ascending: false });
    res.json(data || []);
  } catch { res.json([]); }
});

router.get('/affiliate/list', async (req, res) => {
  try {
    const { tier, role, active } = req.query;
    let query = supabase.from('affiliate_profiles').select('*').order('total_sales', { ascending: false });
    if (tier) query = query.eq('ctv_tier', String(tier));
    if (role) query = query.eq('role', String(role));
    if (active === 'true') query = query.eq('is_active', true);
    if (active === 'false') query = query.eq('is_active', false);
    const { data } = await query;
    res.json(data || []);
  } catch { res.json([]); }
});

router.post('/affiliate/:id/approve', async (req, res) => {
  try {
    const { data: app } = await supabase.from('partnership_applications').select('*').eq('id', req.params.id).single();
    if (!app) return res.status(404).json({ error: 'Không tìm thấy đơn' });
    await supabase.from('partnership_applications').update({ status: 'approved', approved_at: new Date().toISOString() }).eq('id', req.params.id);
    if (app.user_id) {
      // `role` (KHÔNG phải `partnership_role`) + chặn giá trị ngoài CHECK: application_type
      // cho phép 'affiliate' nhưng affiliate_profiles.role chỉ nhận ctv/kol — cùng guard với
      // admin web (frontend ApplicationsPage/UsersPage). Thiếu `role` thì rơi vào DEFAULT và
      // trước 2026-07-30 DEFAULT là 'affiliate' ⇒ 23514 câm.
      const affRole = ['ctv', 'kol'].includes(app.application_type) ? app.application_type : 'ctv';
      const { error: affErr } = await supabase.from('affiliate_profiles').upsert({ user_id: app.user_id, role: affRole, ctv_tier: 'bronze', is_active: true }, { onConflict: 'user_id' });
      if (affErr) console.error('[affiliate/approve] upsert affiliate_profiles that bai:', affErr);
      await supabase.from('profiles').update({ partnership_role: app.application_type || 'ctv', ctv_tier: 'bronze' }).eq('id', app.user_id);
    }
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/affiliate/:id/reject', async (req, res) => {
  try {
    await supabase.from('partnership_applications').update({ status: 'rejected', rejection_reason: req.body.reason }).eq('id', req.params.id);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put('/affiliate/:id/tier', async (req, res) => {
  try { await supabase.from('affiliate_profiles').update({ ctv_tier: req.body.tier }).eq('id', req.params.id); res.json({ success: true }); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put('/affiliate/:id/status', async (req, res) => {
  try { await supabase.from('affiliate_profiles').update({ is_active: req.body.is_active }).eq('id', req.params.id); res.json({ success: true }); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/affiliate/:id/pay-commission', async (req, res) => {
  try {
    await supabase.from('commission_sales').update({ payment_status: 'paid', paid_at: new Date().toISOString() }).eq('affiliate_id', req.params.id).eq('payment_status', 'pending');
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/affiliate/:id/commission', async (req, res) => {
  try { const { data } = await supabase.from('commission_sales').select('*').eq('affiliate_id', req.params.id).order('created_at', { ascending: false }); res.json(data || []); }
  catch { res.json([]); }
});

// ═══════════════════════════════════════════════════════
// SCANNER — DB WHERE AVAILABLE, STATIC DEFAULTS WHERE NOT
// ═══════════════════════════════════════════════════════

router.get('/scanner/stats', async (_req, res) => {
  // Scanner tables may not exist yet — return safe defaults
  res.json({ today_scans: 0, patterns_found: 0, alerts_sent: 0, win_rate: 0.678, total_coins: 437, total_patterns: 24 });
});

router.get('/scanner/recent-patterns', async (_req, res) => { res.json([]); });

// Chưa nối engine quét (engine sống ở gemral/gem-mobile). Trước 01/10 route trả success "Scan triggered"
// mà không quét gì — cùng lớp lỗi stub với PUT /scanner/config (GEM-1107). Báo thật 501 để modal hiện lỗi.
router.post('/scanner/scan', async (_req, res) => {
  res.status(501).json({ error: 'Quét tay từ Paperclip chưa được nối với engine scanner — hãy quét trên gemral.com/scanner.' });
});

router.get('/scanner/win-rates', async (_req, res) => {
  res.json({ overall: 0.678, by_pattern: { DPD: 0.68, UPU: 0.71, UPD: 0.65, DPU: 0.69, 'H&S': 0.70, QM: 0.73, FL: 0.66, FTR: 0.64 } });
});

// Cấu hình scanner lưu ở system_config (key-value, value jsonb). Trước 01/10 PUT là stub trả success
// mà không lưu gì → nút "Lưu cấu hình" giả vờ thành công (GEM-1107). Chỉ các trường chỉnh được mới ghi;
// coins_active/timeframes là thông tin hiển thị, không nhận từ client.
const SCANNER_CONFIG_KEY = 'ops.scanner.config';
const SCANNER_CONFIG_DEFAULTS = {
  coins_active: 437, timeframes: ['1H', '4H', 'Daily', 'Weekly'], push_enabled: true,
  auto_scan_interval: '4h', alert_threshold: 70, daily_quota: 50, alert_channels: ['Telegram', 'Push'],
};
const SCANNER_INTERVALS = ['1h', '4h', '8h', 'daily'];
const SCANNER_THRESHOLDS = [60, 70, 80];
const SCANNER_CHANNELS = ['Telegram', 'Email', 'Push', 'War Room'];

function validateScannerConfig(body: any): { value?: Record<string, any>; error?: string } {
  const value: Record<string, any> = {};
  if (body.auto_scan_interval !== undefined) {
    if (!SCANNER_INTERVALS.includes(body.auto_scan_interval)) return { error: `auto_scan_interval phải là một trong: ${SCANNER_INTERVALS.join(', ')}` };
    value.auto_scan_interval = body.auto_scan_interval;
  }
  if (body.alert_threshold !== undefined) {
    const t = Number(body.alert_threshold);
    if (!SCANNER_THRESHOLDS.includes(t)) return { error: `alert_threshold phải là một trong: ${SCANNER_THRESHOLDS.join(', ')}` };
    value.alert_threshold = t;
  }
  if (body.daily_quota !== undefined) {
    const q = Number(body.daily_quota);
    if (!Number.isInteger(q) || q < 1 || q > 10000) return { error: 'daily_quota phải là số nguyên từ 1 đến 10000' };
    value.daily_quota = q;
  }
  if (body.alert_channels !== undefined) {
    if (!Array.isArray(body.alert_channels) || body.alert_channels.some((c: any) => !SCANNER_CHANNELS.includes(c))) {
      return { error: `alert_channels chỉ nhận: ${SCANNER_CHANNELS.join(', ')}` };
    }
    value.alert_channels = [...new Set(body.alert_channels as string[])];
  }
  if (body.push_enabled !== undefined) {
    if (typeof body.push_enabled !== 'boolean') return { error: 'push_enabled phải là true/false' };
    value.push_enabled = body.push_enabled;
  }
  if (Object.keys(value).length === 0) return { error: 'Không có trường cấu hình hợp lệ nào để lưu' };
  return { value };
}

async function readScannerConfig(): Promise<Record<string, any>> {
  const { data, error } = await supabase.from('system_config').select('value').eq('key', SCANNER_CONFIG_KEY).maybeSingle();
  if (error) throw error;
  const saved = data?.value && typeof data.value === 'object' && !Array.isArray(data.value) ? data.value : {};
  return { ...SCANNER_CONFIG_DEFAULTS, ...saved };
}

router.get('/scanner/config', async (_req, res) => {
  try { res.json(await readScannerConfig()); }
  catch (err: any) { res.status(500).json({ error: `Không đọc được cấu hình scanner: ${err.message}` }); }
});

router.put('/scanner/config', async (req, res) => {
  const { value, error: invalid } = validateScannerConfig(req.body || {});
  if (invalid) return res.status(400).json({ error: invalid });
  try {
    // Gộp với bản đang lưu để lưu một phần không xoá các trường khác.
    const current = await readScannerConfig();
    const next: Record<string, any> = {};
    for (const k of ['auto_scan_interval', 'alert_threshold', 'daily_quota', 'alert_channels', 'push_enabled']) next[k] = { ...current, ...value }[k];
    const { error } = await supabase.from('system_config').upsert(
      { key: SCANNER_CONFIG_KEY, value: next, category: 'scanner', description: 'Cấu hình Scanner (Paperclip ops)', updated_at: new Date().toISOString(), updated_by: 'board' },
      { onConflict: 'key' },
    );
    if (error) throw error;
    res.json({ success: true, config: { ...SCANNER_CONFIG_DEFAULTS, ...next } });
  } catch (err: any) { res.status(500).json({ error: `Không lưu được cấu hình scanner: ${err.message}` }); }
});

// ═══ WORKFLOWS ═══

router.get('/workflows', async (_req, res) => {
  const { data, error } = await supabase.from('workflows').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.get('/workflows/:id', async (req, res) => {
  const { data, error } = await supabase.from('workflows').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Workflow không tìm thấy' });
  res.json(data);
});

router.post('/workflows', async (req, res) => {
  const { name, description, trigger_type, trigger_config, nodes, edges } = req.body;
  const { data, error } = await supabase.from('workflows').insert({
    name: name || 'Workflow mới',
    description, trigger_type: trigger_type || 'manual',
    trigger_config: trigger_config || {}, nodes: nodes || [], edges: edges || [],
    created_by: 'board',
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.put('/workflows/:id', async (req, res) => {
  const { name, description, trigger_type, trigger_config, nodes, edges, is_active } = req.body;
  const updates: Record<string, any> = { updated_at: new Date().toISOString() };
  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (trigger_type !== undefined) updates.trigger_type = trigger_type;
  if (trigger_config !== undefined) updates.trigger_config = trigger_config;
  if (nodes !== undefined) updates.nodes = nodes;
  if (edges !== undefined) updates.edges = edges;
  if (is_active !== undefined) updates.is_active = is_active;
  const { data, error } = await supabase.from('workflows').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/workflows/:id', async (req, res) => {
  const { error } = await supabase.from('workflows').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

router.post('/workflows/:id/run', async (req, res) => {
  const { data: wf } = await supabase.from('workflows').select('*').eq('id', req.params.id).single();
  if (!wf) return res.status(404).json({ error: 'Workflow không tìm thấy' });
  const { data: run, error } = await supabase.from('workflow_runs').insert({
    workflow_id: wf.id, status: 'running', trigger_data: req.body.trigger_data || {},
    started_at: new Date().toISOString(),
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(run);
});

// ═══════════════════════════════════════════════════════
// PHASE 5: PLANNER BOARD ENDPOINTS
// ═══════════════════════════════════════════════════════

// Map free-text topic → valid cc_scripts pillar value
function topicToPillar(topic: string): string {
  const t = topic.toLowerCase();
  if (/trading|scanner|kỹ thuật|đầu tư|crypto|tài chính|tiền/.test(t)) return 'trading';
  if (/tâm linh|spiritual|crystal|năng lượng|ritual|chakra/.test(t)) return 'spiritual';
  if (/sức khỏe|wellness|ngủ|thiền|meditation|yoga|thể dục/.test(t)) return 'wellness';
  if (/lifestyle|cuộc sống|phong cách|daily|routine/.test(t)) return 'lifestyle';
  if (/khóa học|course|latc|tmt|education|học|mindset/.test(t)) return 'latc_money';
  if (/cộng đồng|community|forum|kết nối/.test(t)) return 'community';
  return 'integration';
}

// GET /content-pipeline/planner?start=YYYY-MM-DD&end=YYYY-MM-DD
router.get('/content-pipeline/planner', async (req, res) => {
  const { start, end, plan_id } = req.query as Record<string, string>;

  let assignedQuery = supabase
    .from('cc_scripts')
    .select('id, title, body, pillar, status, word_count, content_type, metadata, created_at')
    .not('metadata->plan_id', 'is', null);

  if (start) assignedQuery = assignedQuery.gte('metadata->>scheduled_date', start);
  if (end)   assignedQuery = assignedQuery.lte('metadata->>scheduled_date', end);
  if (plan_id) assignedQuery = assignedQuery.eq('metadata->>plan_id', plan_id);

  const { data, error } = await assignedQuery.order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  let unassignedQuery = supabase
    .from('cc_scripts')
    .select('id, title, body, pillar, status, word_count, content_type, metadata, created_at')
    .not('metadata->plan_id', 'is', null)
    .is('metadata->>scheduled_date', null)
    .order('created_at', { ascending: false });

  if (plan_id) unassignedQuery = unassignedQuery.eq('metadata->>plan_id', plan_id);

  const { data: unassigned } = await unassignedQuery;

  // Group assigned by date → account → time
  const calendar: Record<string, Record<string, Record<string, any>>> = {};
  for (const script of (data || [])) {
    const meta = (script.metadata as any) || {};
    const d = meta.scheduled_date, t = meta.scheduled_time, a = meta.target_account;
    if (d && a) {
      if (!calendar[d]) calendar[d] = {};
      if (!calendar[d][a]) calendar[d][a] = {};
      calendar[d][a][t || '10:00'] = script;
    }
  }

  res.json({
    calendar,
    unassigned: unassigned || [],
    total_assigned: data?.length || 0,
    total_unassigned: unassigned?.length || 0,
  });
});

// GET /content-pipeline/planner/plans — list content_planner scripts
router.get('/content-pipeline/planner/plans', async (_req, res) => {
  const { data, error } = await supabase
    .from('cc_scripts')
    .select('id, title, created_at, metadata')
    .eq('content_type', 'content_planner')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// PUT /content-pipeline/planner/assign
router.put('/content-pipeline/planner/assign', async (req, res) => {
  const { script_id, date, time, account } = req.body;
  if (!script_id || !date || !account) return res.status(400).json({ error: 'Thiếu script_id, date hoặc account' });

  const { data: script } = await supabase.from('cc_scripts').select('metadata').eq('id', script_id).single();
  const metadata = { ...((script?.metadata as any) || {}), scheduled_date: date, scheduled_time: time || '10:00', target_account: account };

  const { error } = await supabase.from('cc_scripts').update({ metadata }).eq('id', script_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, message: `Đã gán vào ${account} ${date} ${time || '10:00'}` });
});

// PUT /content-pipeline/planner/unassign
router.put('/content-pipeline/planner/unassign', async (req, res) => {
  const { script_id } = req.body;
  if (!script_id) return res.status(400).json({ error: 'Thiếu script_id' });

  const { data: script } = await supabase.from('cc_scripts').select('metadata').eq('id', script_id).single();
  const metadata = { ...((script?.metadata as any) || {}) };
  delete metadata.scheduled_date;
  delete metadata.scheduled_time;
  delete metadata.target_account;

  const { error } = await supabase.from('cc_scripts').update({ metadata }).eq('id', script_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, message: 'Đã bỏ gán' });
});

// POST /content-pipeline/planner/parse-plan
router.post('/content-pipeline/planner/parse-plan', async (req, res) => {
  const { planner_script_id } = req.body;
  if (!planner_script_id) return res.status(400).json({ error: 'Thiếu planner_script_id' });

  const { data: planner } = await supabase.from('cc_scripts').select('id, body').eq('id', planner_script_id).single();
  if (!planner?.body) return res.status(404).json({ error: 'Không tìm thấy plan hoặc body trống' });

  // Parse markdown table — find header via separator line (|---|---|)
  const allLines = (planner.body as string).split('\n');
  const sepIdx = allLines.findIndex((l: string) => l.includes('|') && /[-]{3,}/.test(l) && l.replace(/[\s|:-]/g, '').length === 0);
  if (sepIdx < 1) return res.status(400).json({ error: 'Không parse được bảng markdown — không tìm thấy separator line (|---|---|)' });

  const headers = allLines[sepIdx - 1].split('|').map((h: string) => h.trim()).filter(Boolean);
  const dataLines = allLines.slice(sepIdx + 1).filter((l: string) => l.includes('|') && l.trim().length > 3);
  if (dataLines.length === 0) return res.status(400).json({ error: 'Không parse được bảng markdown — không có data row nào' });

  const rows = dataLines.map((line: string) => {
    const cells = line.split('|').map((c: string) => c.trim()).filter(Boolean);
    const row: Record<string, string> = {};
    headers.forEach((h: string, i: number) => { row[h] = cells[i] || ''; });
    return row;
  }).filter((r: Record<string, string>) => Object.values(r).some(v => v.length > 0));

  const scripts = rows.map((row: Record<string, string>) => {
    const topic = ((row['Chủ đề'] || row['Chu de'] || '')).toLowerCase();
    let account = 'page_jennie';
    if (/trading|kỹ thuật|scanner|app|sản phẩm|education|gemral/.test(topic)) account = 'page_gemral';
    else if (/tình yêu|ritual|crystal|spiritual|7 ngày|vision/.test(topic)) account = 'profile_jennie';

    const rawPillar = row['Pillar'] || row['Chủ đề'] || '';
    const rawType = (row['Loại'] || row['Type'] || '').toLowerCase();
    // Allowed: social_post, news, email, push_notification, sms, latc, tmt, short_clip, content_planner, etc.
    const contentType = /blog|bài viết|seo/.test(rawType) ? 'news'
      : /email/.test(rawType) ? 'email'
      : /push/.test(rawType) ? 'push_notification'
      : /sms/.test(rawType) ? 'sms'
      : /clip|video|reel/.test(rawType) ? 'short_clip'
      : 'social_post';
    return {
      title: row['Tiêu đề'] || row['Tieu de'] || row['Title'] || row['Chủ đề'] || 'Không có tiêu đề',
      content_type: contentType,
      track: 'wealth',
      pillar: topicToPillar(rawPillar),
      persona: 'jennie_mentor',
      writing_mode: 'mode_1_calm',
      status: 'topic',
      metadata: {
        // Don't auto-assign date — let user drag into calendar slots
        suggested_date: row['Ngày'] || row['Ngay'] || null,
        suggested_time: row['Giờ đăng'] || row['Gio dang'] || '10:00',
        target_account: row['Account'] || account,
        platform: row['Nền tảng'] || row['Platform'] || '',
        topic_summary: row['Tóm tắt'] || row['Tom tat'] || '',
        hashtags: row['Hashtags'] || '',
        plan_id: planner_script_id,
        source: 'content_planner',
        brand_voice: account === 'page_gemral' ? 'generic' : 'jennie',
      },
    };
  });

  const { data: inserted, error } = await supabase.from('cc_scripts').insert(scripts).select('id');
  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true, message: `Đã parse ${inserted?.length || 0} chủ đề`, count: inserted?.length || 0 });
});

// POST /content-pipeline/planner/generate
router.post('/content-pipeline/planner/generate', async (req, res) => {
  const { plan_id, script_ids } = req.body;
  if (!plan_id && !script_ids?.length) return res.status(400).json({ error: 'Thiếu plan_id hoặc script_ids' });

  let query = supabase
    .from('cc_scripts')
    .select('id, title, pillar, content_type, metadata')
    .or('body.is.null,body.eq.')
    .eq('status', 'topic');

  if (script_ids?.length) query = query.in('id', script_ids);
  else query = query.eq('metadata->>plan_id', plan_id);

  const { data: topics } = await query;
  if (!topics?.length) return res.json({ success: true, message: 'Không có chủ đề nào cần generate', count: 0 });

  const jobs = topics.map((t: any) => {
    const meta = t.metadata || {};
    return {
      job_type: 'script',
      content_type: t.content_type || 'social_post',
      status: 'queued',
      input_params: {
        contentType: t.content_type || 'social_post',
        brandVoice: meta.brand_voice || 'jennie',
        userPrompt: [
          `LOẠI: ${t.content_type || 'social_post'}`,
          `CHỦ ĐỀ: ${t.title}`,
          meta.topic_summary ? `TÓM TẮT: ${meta.topic_summary}` : '',
          meta.hashtags ? `HASHTAGS GỢI Ý: ${meta.hashtags}` : '',
          meta.target_account ? `ACCOUNT: ${meta.target_account}` : '',
          '',
          'Viết bài đăng MXH đầy đủ. Tuân thủ brand voice, compliance.',
        ].filter(Boolean).join('\n'),
        maxTokens: 16384,
        model: 'claude-sonnet-4-6',
        provider: 'claude',
        target_script_id: t.id,
      },
      created_by: '01fe99b8-ef1b-4cdd-892a-3e976d6b1881', // system/board user
    };
  });

  const { data: inserted, error } = await supabase.from('cc_generation_jobs').insert(jobs).select('id');
  if (error) return res.status(500).json({ error: error.message });

  await supabase.from('cc_scripts').update({ status: 'generating' }).in('id', topics.map((t: any) => t.id));

  res.json({
    success: true,
    message: `Đã tạo ${inserted?.length || 0} jobs. Chạy batch_processor.py batch để generate.`,
    count: inserted?.length || 0,
    instruction: 'cd "D:/Claude Projects/App Content Jennie/gem-content-center" && PYTHONUTF8=1 python scripts/batch_processor.py batch',
  });
});

// GET /content-pipeline/planner/progress?plan_id=xxx
router.get('/content-pipeline/planner/progress', async (req, res) => {
  const { plan_id } = req.query as Record<string, string>;
  if (!plan_id) return res.status(400).json({ error: 'Thiếu plan_id' });

  const { data } = await supabase
    .from('cc_scripts')
    .select('status')
    .eq('metadata->>plan_id', plan_id);

  const counts: Record<string, number> = { topic: 0, generating: 0, draft: 0, review: 0, approved: 0, scheduled: 0, published: 0, failed: 0 };
  for (const s of (data || [])) { counts[s.status] = (counts[s.status] || 0) + 1; }

  res.json({ total: data?.length || 0, ...counts });
});

// POST /content-pipeline/planner/bulk-approve
router.post('/content-pipeline/planner/bulk-approve', async (req, res) => {
  const { plan_id, script_ids } = req.body;
  if (!plan_id && !script_ids?.length) return res.status(400).json({ error: 'Thiếu plan_id hoặc script_ids' });

  let query = supabase
    .from('cc_scripts')
    .select('id')
    .eq('status', 'draft')
    .not('body', 'is', null);

  if (script_ids?.length) query = query.in('id', script_ids);
  else query = query.eq('metadata->>plan_id', plan_id);

  const { data: drafts } = await query;
  if (!drafts?.length) return res.json({ success: true, message: 'Không có bài nào cần duyệt', count: 0 });

  const ids = drafts.map((d: any) => d.id);
  const { error } = await supabase
    .from('cc_scripts')
    .update({ status: 'approved', approved_at: new Date().toISOString() })
    .in('id', ids);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, message: `Đã duyệt ${ids.length} bài`, count: ids.length });
});

// POST /content-pipeline/planner/import — import từ markdown/CSV paste
router.post('/content-pipeline/planner/import', async (req, res) => {
  const { content, format } = req.body;
  if (!content) return res.status(400).json({ error: 'Thiếu content' });

  let rows: Record<string, string>[] = [];
  if (format === 'csv') {
    const lines = (content as string).split('\n').filter((l: string) => l.trim());
    const headers = lines[0].split(',').map((h: string) => h.trim());
    rows = lines.slice(1).map((line: string) => {
      const cells = line.split(',').map((c: string) => c.trim());
      const row: Record<string, string> = {};
      headers.forEach((h: string, i: number) => { row[h] = cells[i] || ''; });
      return row;
    }).filter((r: Record<string, string>) => Object.values(r).some(v => v.length > 0));
  } else {
    // Find header via separator line (|---|---|)
    const allMdLines = (content as string).split('\n');
    const sepIdx = allMdLines.findIndex((l: string) => l.includes('|') && /[-]{3,}/.test(l) && l.replace(/[\s|:-]/g, '').length === 0);
    if (sepIdx >= 1) {
      const headers = allMdLines[sepIdx - 1].split('|').map((h: string) => h.trim()).filter(Boolean);
      const dataLines = allMdLines.slice(sepIdx + 1).filter((l: string) => l.includes('|') && l.trim().length > 3);
      rows = dataLines.map((line: string) => {
        const cells = line.split('|').map((c: string) => c.trim()).filter(Boolean);
        const row: Record<string, string> = {};
        headers.forEach((h: string, i: number) => { row[h] = cells[i] || ''; });
        return row;
      }).filter((r: Record<string, string>) => Object.values(r).some(v => v.length > 0));
    }
  }

  if (!rows.length) return res.status(400).json({ error: 'Không parse được dữ liệu — kiểm tra định dạng markdown/CSV' });

  // Tạo plan parent script
  const { data: planScript, error: planError } = await supabase.from('cc_scripts').insert({
    title: `Imported Plan ${new Date().toLocaleDateString('vi')}`,
    content_type: 'content_planner',
    track: 'wealth',
    pillar: 'integration',
    persona: 'jennie_mentor',
    writing_mode: 'mode_1_calm',
    status: 'completed',
    body: content,
    metadata: { source: 'import', import_count: rows.length },
  }).select('id').single();

  if (planError) return res.status(500).json({ error: planError.message });

  // Tạo topic entries
  const scripts = rows.map((row: Record<string, string>) => {
    const topic = (row['Chủ đề'] || row['Chu de'] || '').toLowerCase();
    let account = 'page_jennie';
    if (/trading|kỹ thuật|scanner|app|sản phẩm|education|gemral/.test(topic)) account = 'page_gemral';
    else if (/tình yêu|ritual|crystal|spiritual|7 ngày|vision/.test(topic)) account = 'profile_jennie';

    return {
      title: row['Tiêu đề'] || row['Chủ đề'] || 'Không tiêu đề',
      content_type: 'social_post',
      track: 'wealth',
      pillar: topicToPillar(row['Pillar'] || row['Chủ đề'] || ''),
      persona: 'jennie_mentor',
      writing_mode: 'mode_1_calm',
      status: 'topic',
      metadata: {
        scheduled_date: row['Ngày'] || null,
        scheduled_time: row['Giờ đăng'] || '10:00',
        target_account: row['Account'] || account,
        topic_summary: row['Tóm tắt'] || '',
        hashtags: row['Hashtags'] || '',
        plan_id: planScript?.id,
        source: 'import',
        brand_voice: account === 'page_gemral' ? 'generic' : 'jennie',
      },
    };
  });

  const { data: inserted, error: insertError } = await supabase.from('cc_scripts').insert(scripts).select('id');
  if (insertError) return res.status(500).json({ error: insertError.message });

  res.json({
    success: true,
    message: `Đã import ${inserted?.length || 0} chủ đề`,
    plan_id: planScript?.id,
    count: inserted?.length || 0,
  });
});

// POST /content-pipeline/planner/delegate-ceo (SSE stream)
router.post('/content-pipeline/planner/delegate-ceo', async (req, res) => {
  const { plan_id } = req.body;
  if (!plan_id) return res.status(400).json({ error: 'Thiếu plan_id' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const task = [
    `Plan ID: ${plan_id} đã được Board duyệt chủ đề.`,
    ``,
    `Nhiệm vụ (CHỈ TRIGGER SCRIPTS — KHÔNG TỰ VIẾT CONTENT):`,
    `1. Gọi POST http://localhost:3101/api/ops/content-pipeline/planner/generate với body {"plan_id":"${plan_id}"}`,
    `2. Chạy: cd "D:/Claude Projects/App Content Jennie/gem-content-center" && PYTHONUTF8=1 python scripts/batch_processor.py batch`,
    `3. Poll GET http://localhost:3101/api/ops/content-pipeline/planner/progress?plan_id=${plan_id} cho đến khi generating=0`,
    `4. Gọi POST http://localhost:3101/api/ops/content-pipeline/planner/bulk-approve với body {"plan_id":"${plan_id}"}`,
    `5. Chạy: cd "D:/Claude Projects/App Content Jennie/gem-content-center/scripts" && python schedule_meta_business_suite.py --weeks 2`,
    `6. Báo cáo kết quả qua Telegram`,
    ``,
    `⚠️ KHÔNG TỰ VIẾT NỘI DUNG. batch_processor.py batch đọc 28+ knowledge files và generate content.`,
  ].join('\n');

  const send = (obj: Record<string, unknown>) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const { execSync } = await import('child_process');
    const claudeBin = execSync('where claude 2>nul || which claude 2>/dev/null', { encoding: 'utf-8', shell: 'cmd.exe' }).trim().split('\n')[0].trim();

    const agentCwd = path.resolve(PAPERCLIP_ROOT, 'agents/ceo');
    const agentCwdExists = fs.existsSync(agentCwd);

    const proc = spawn(claudeBin, [
      '--dangerously-skip-permissions',
      '-p', task,
    ], {
      cwd: agentCwdExists ? agentCwd : process.cwd(),
      shell: true,
      env: { ...process.env },
      windowsHide: true,
    });

    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on('data', (d: Buffer) => send({ type: 'stdout', text: d.toString() }));
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on('data', (d: Buffer) => send({ type: 'stderr', text: d.toString() }));
    proc.on('close', (code: number) => { send({ type: 'exit', code }); res.end(); });
    req.on('close', () => { if (!proc.killed) proc.kill(); });
  } catch (err: any) {
    send({ type: 'error', text: `Không tìm thấy claude CLI: ${err.message}` });
    res.end();
  }
});

// ═══════════════════════════════════════════════════════
// JOB LOGS — GET /content-pipeline/jobs/:id/logs + SSE stream
// Data source: cc_job_logs (nếu có) + fallback cc_generation_jobs.output_data/metadata
// ═══════════════════════════════════════════════════════

function normalizeJobLogs(job: any, dbLogs: any[]): any[] {
  const events: any[] = [];
  // Synthetic events from job status
  if (job?.created_at) {
    events.push({ ts: job.created_at, level: 'info', stage: 'queued',
      message: `Job created — type=${job.job_type} content=${job.content_type || ''} model=${job.model_used || '?'}` });
  }
  if (job?.started_at) {
    events.push({ ts: job.started_at, level: 'info', stage: 'started',
      message: `Processor acquired: ${job.processor || '(unknown)'}` });
  }
  // DB logs from cc_job_logs
  for (const row of dbLogs || []) {
    events.push({
      ts: row.ts,
      level: row.level || 'info',
      stage: row.stage || '',
      message: row.message || '',
      metadata: row.metadata || null,
    });
  }
  // Output data.logs (if batch_processor wrote timestamped array)
  let outData: any = {};
  try {
    outData = typeof job?.output_data === 'string' ? JSON.parse(job.output_data) : (job?.output_data || {});
  } catch {}
  if (Array.isArray(outData?.logs)) {
    for (const entry of outData.logs) {
      events.push({
        ts: entry.ts || entry.timestamp || job.updated_at,
        level: entry.level || 'info',
        stage: entry.stage || 'batch',
        message: entry.message || String(entry),
      });
    }
  }
  if (job?.error_message) {
    events.push({ ts: job.completed_at || job.updated_at, level: 'error', stage: 'error',
      message: job.error_message, metadata: { code: job.error_code } });
  }
  if (job?.completed_at) {
    const label = job.status === 'completed' ? 'completed' : job.status;
    events.push({ ts: job.completed_at, level: job.status === 'failed' ? 'error' : 'info', stage: label,
      message: `Job ${label} — duration ${job.generation_time_ms || 0}ms, tokens ${job.total_tokens || 0}` });
  }
  // Sort ascending by ts
  events.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  return events;
}

router.get('/content-pipeline/jobs/:id/logs', async (req, res) => {
  try {
    const { id } = req.params;
    const sinceParam = req.query.since as string | undefined;
    const since = sinceParam ? new Date(sinceParam) : null;

    const [{ data: job, error: jobErr }, logsRes] = await Promise.all([
      supabase.from('cc_generation_jobs').select('*').eq('id', id).single(),
      (async () => {
        let q = supabase.from('cc_job_logs').select('*').eq('job_id', id).order('ts', { ascending: true }).limit(2000);
        if (since) q = q.gt('ts', since.toISOString());
        return q;
      })(),
    ]);

    if (jobErr && jobErr.code !== 'PGRST116') throw jobErr;
    if (logsRes.error) throw logsRes.error;

    const events = normalizeJobLogs(job, logsRes.data || []);
    const filtered = since ? events.filter((e) => new Date(e.ts).getTime() > since.getTime()) : events;

    // input_params is jsonb but PostgREST sometimes returns it as a JSON string — normalize
    let inputParams: any = job?.input_params ?? null;
    if (typeof inputParams === 'string') {
      try { inputParams = JSON.parse(inputParams); } catch { /* leave as string */ }
    }
    let metadata: any = job?.metadata ?? null;
    if (typeof metadata === 'string') {
      try { metadata = JSON.parse(metadata); } catch {}
    }
    let outputData: any = job?.output_data ?? null;
    if (typeof outputData === 'string') {
      try { outputData = JSON.parse(outputData); } catch {}
    }

    res.json({
      job: job ? {
        id: job.id,
        status: job.status,
        job_type: job.job_type,
        content_type: job.content_type,
        track: job.track,
        pillar: job.pillar,
        persona: job.persona,
        writing_mode: job.writing_mode,
        model_used: job.model_used,
        progress: job.progress,
        priority: job.priority,
        created_at: job.created_at,
        started_at: job.started_at,
        completed_at: job.completed_at,
        prompt_tokens: job.prompt_tokens,
        completion_tokens: job.completion_tokens,
        total_tokens: job.total_tokens,
        generation_time_ms: job.generation_time_ms,
        retry_count: job.retry_count,
        max_retries: job.max_retries,
        entity_type: job.entity_type,
        entity_id: job.entity_id,
        processor: job.processor,
        error_message: job.error_message,
        error_code: job.error_code,
        output_error: job.output_error,
        input_params: inputParams,
        metadata,
        output_data: outputData,
      } : null,
      events: filtered,
      lastTs: filtered.length > 0 ? filtered[filtered.length - 1].ts : (since ? since.toISOString() : null),
      isLive: job?.status === 'queued' || job?.status === 'processing',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Lỗi tải logs' });
  }
});

router.get('/content-pipeline/jobs/:id/logs/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (obj: any) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const { id } = req.params;
  let lastTs: string | null = null;
  let closed = false;

  const poll = async () => {
    if (closed) return;
    try {
      let logsQuery = supabase.from('cc_job_logs').select('*').eq('job_id', id).order('ts', { ascending: true }).limit(500);
      if (lastTs) logsQuery = logsQuery.gt('ts', lastTs);
      const [{ data: job }, { data: dbLogs }] = await Promise.all([
        supabase.from('cc_generation_jobs').select('*').eq('id', id).single(),
        logsQuery,
      ]);
      const events = normalizeJobLogs(job, dbLogs || []);
      const fresh = lastTs ? events.filter((e) => new Date(e.ts).getTime() > new Date(lastTs!).getTime()) : events;
      for (const ev of fresh) send({ type: 'event', event: ev });
      if (fresh.length > 0) lastTs = fresh[fresh.length - 1].ts;
      if (job && (job.status === 'completed' || job.status === 'failed')) {
        send({ type: 'done', status: job.status });
        closed = true; res.end();
        return;
      }
    } catch (err: any) {
      send({ type: 'error', text: err.message || 'poll error' });
    }
  };

  // Initial flush
  await poll();
  const interval = setInterval(poll, 2000);
  req.on('close', () => { closed = true; clearInterval(interval); });
});

// ═══════════════════════════════════════════════════════
// PUBLISH TRIGGERS — Immediate + Batch + Queue polling
// ═══════════════════════════════════════════════════════

const SCHEDULER_CWD = CPS_ROOT;
const SCHEDULER_SCRIPT = 'scripts/schedule_meta_business_suite.py';

function spawnPublisher(args: string[], label: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn('python', [SCHEDULER_SCRIPT, ...args], { cwd: SCHEDULER_CWD, env: { ...process.env, PYTHONUTF8: '1' }, windowsHide: true });
    let stdout = '', stderr = '';
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code: number) => {
      console.log(`[Publisher:${label}] exit=${code} stdout=${stdout.length} stderr=${stderr.length}`);
      resolve({ code, stdout, stderr });
    });
  });
}

// POST /content-pipeline/scripts/:id/publish-now — đăng 1 bài liền, bypass cron
router.post('/content-pipeline/scripts/:id/publish-now', async (req, res) => {
  const { id } = req.params;
  try {
    // 2026-04-18 dedup: if ANY pending row exists for this script_id, claim
    // them by flipping to 'processing' and skip insert. Without this the
    // cron / multiple callers all race, each spawning its own Playwright and
    // each inserting a new 'manual' audit row — the exact feedback loop that
    // dumped 3000+ rows earlier today.
    const { data: claimed } = await supabase
      .from('cc_publish_queue')
      .update({ status: 'processing', picked_at: new Date().toISOString() })
      .eq('script_id', id)
      .eq('status', 'pending')
      .select('id');
    const alreadyQueued = (claimed?.length || 0) > 0;

    // NOTE: cc_scripts uses posted_account (text). channel_target only exists on
    // cc_publish_queue. Previous code selected cc_scripts.channel_target →
    // PostgREST 500. Read posted_account, copy into queue.channel_target.
    const { data: script, error: sErr } = await supabase
      .from('cc_scripts')
      .update({ status: 'approved', publish_mode: 'immediate', publish_ready_at: new Date().toISOString() })
      .eq('id', id)
      .select('id, posted_account, status')
      .single();
    if (sErr) throw sErr;

    // Only insert a new audit row when nothing was already pending. Prevents
    // the endpoint from creating extra 'manual' rows for every cron tick.
    if (!alreadyQueued) {
      await supabase.from('cc_publish_queue').insert({
        script_id: id,
        trigger_type: 'manual',
        channel_target: script.posted_account,
        status: 'processing',
        picked_at: new Date().toISOString(),
        metadata: { source: 'api_publish_now', user: req.headers['x-user'] || 'unknown' },
      });
    }

    // Spawn Playwright single-publish async (don't wait for full upload)
    spawnPublisher(['--single', id], `single-${id.slice(0, 8)}`).then((r) => {
      supabase.from('cc_publish_queue')
        .update({
          status: r.code === 0 ? 'done' : 'failed',
          published_at: r.code === 0 ? new Date().toISOString() : null,
          error_message: r.code !== 0 ? r.stderr.slice(0, 2000) : null,
        })
        .eq('script_id', id).eq('status', 'processing')
        .then(() => {});
      // Fire-and-forget: sync Status=Published to Notion when publish succeeds.
      // Mirror approve flow's no-page fallback (page may be missing for
      // manually-inserted rows). post_url not yet captured by Playwright (B2).
      if (r.code === 0) {
        void (async () => {
          const quick = await updatePageStatus(id, 'published');
          if (!quick.ok && quick.note === 'no-page') {
            await pushScript(id);
          }
        })().catch((e) => console.warn('[notion-push] publish-now fail', e));
      }
    });

    res.json({ message: 'Đang publish ngay — check Log Viewer hoặc cc_publish_queue để track', script_id: id });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Lỗi publish-now' });
  }
});

// POST /content-pipeline/scripts/:id/dispatch — 1 nút "Đăng ngay / Lên lịch":
// branch theo publish_mode. immediate → đăng NOW (--single). scheduled → đặt lịch
// Meta BS theo scheduled_at (--single-schedule), validate buffer ≥20 phút.
router.post('/content-pipeline/scripts/:id/dispatch', async (req, res) => {
  const { id } = req.params;
  try {
    const { data: script, error: sErr } = await supabase
      .from('cc_scripts')
      .select('id, title, body, posted_account, publish_mode, scheduled_at, status, metadata')
      .eq('id', id)
      .single();
    if (sErr) throw sErr;
    const mode = (script.publish_mode || 'immediate') as string;
    const account = script.posted_account as string | null;
    const isScheduledMode = (mode === 'scheduled' || mode === 'schedule2week');

    // ── Resend newsletter broadcast (không qua Playwright) ──
    // Mỗi broadcast = 1 segment. metadata.resend_segments (array) quyết định
    // segments; default active_customer + partner_ctv. create-broadcast = draft,
    // phải /send mới gửi (kèm scheduled_at nếu publish_mode=scheduled).
    if (account === 'resend') {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'RESEND_API_KEY chưa cấu hình', code: 'NO_RESEND_KEY' });
      const meta = (script.metadata || {}) as Record<string, any>;
      const html = (script.body || '').trim();
      if (!html) return res.status(422).json({ error: 'Body trống — newsletter cần nội dung HTML.', code: 'EMPTY_BODY' });
      const scheduledAt = isScheduledMode ? script.scheduled_at : undefined;
      if (isScheduledMode && !scheduledAt) {
        return res.status(422).json({ error: 'publish_mode=scheduled nhưng chưa có scheduled_at.', code: 'NO_SCHEDULE' });
      }
      const segs: string[] = (Array.isArray(meta.resend_segments) && meta.resend_segments.length)
        ? meta.resend_segments : ['active_customer', 'partner_ctv'];
      const subject = meta.email_subject || script.title || 'Gemral Newsletter';
      const fromName = meta.from_name || 'Gemral';
      const fromEmail = meta.from_email || 'hello@gemral.com';
      const replyTo = meta.reply_to || fromEmail;
      const previewText = meta.preview_text || undefined;
      // Segment name → Resend audience UUID (audience ≡ segment trong Resend).
      const RESEND_SEGMENT_MAP: Record<string, string> = {
        active_customer: '23de5912-92ae-4f4a-8af5-4aeed56b1264',
        partner_ctv: '4e407443-ea09-4ec2-8634-d506e91d6f8a',
        vip_high_spender: '0e7a2ec3-245d-4cc9-9ad1-c411732adb91',
        dormant: '068dd425-50b4-4520-a040-ac53bada2c1b',
        new_signup: '701a0b97-d02e-4682-a104-ec1b9918fb2e',
        'Waitlist Leads': '4e94549c-653b-4f7b-98b7-926777939eec',
        Test: 'a3b2b965-2a6f-477f-84ad-e02af7b2d2ac',
      };
      const rHeaders = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
      const broadcasts: Array<Record<string, unknown>> = [];
      for (const seg of segs) {
        const audienceId = RESEND_SEGMENT_MAP[seg] || seg; // cho phép raw UUID
        try {
          const cResp = await fetch('https://api.resend.com/broadcasts', {
            method: 'POST', headers: rHeaders,
            // Resend broadcast `name` max 70 chars — keep the segment tag visible, truncate subject.
            body: JSON.stringify((() => {
              const segTag = ` — ${seg}`;
              const bname = `${subject.slice(0, Math.max(0, 70 - segTag.length))}${segTag}`.slice(0, 70);
              return {
                audience_id: audienceId,
                from: `${fromName} <${fromEmail}>`,
                subject, html, name: bname,
                reply_to: replyTo,
                ...(previewText ? { preview_text: previewText } : {}),
              };
            })()),
          });
          const cBody: any = await cResp.json().catch(() => ({}));
          if (!cResp.ok) { broadcasts.push({ segment: seg, error: `create ${cResp.status}: ${JSON.stringify(cBody).slice(0, 200)}` }); continue; }
          const bid = cBody?.id ?? cBody?.data?.id;
          const sResp = await fetch(`https://api.resend.com/broadcasts/${bid}/send`, {
            method: 'POST', headers: rHeaders,
            body: JSON.stringify(scheduledAt ? { scheduled_at: scheduledAt } : {}),
          });
          const sBody: any = await sResp.json().catch(() => ({}));
          if (!sResp.ok) { broadcasts.push({ segment: seg, broadcast_id: bid, error: `send ${sResp.status}: ${JSON.stringify(sBody).slice(0, 200)}` }); continue; }
          broadcasts.push({ segment: seg, broadcast_id: bid, scheduled_at: scheduledAt || 'now', ok: true });
        } catch (e: any) {
          broadcasts.push({ segment: seg, error: e?.message || 'fetch failed' });
        }
      }
      const okCount = broadcasts.filter((b) => b.ok).length;
      await supabase.from('cc_scripts').update({
        status: okCount > 0 ? 'published' : 'approved',
        published_at: okCount > 0 ? new Date().toISOString() : null,
        metadata: { ...meta, resend_broadcasts: broadcasts, dispatched_at: new Date().toISOString() },
      }).eq('id', id);
      if (okCount === 0) {
        const firstErr = (broadcasts.find((b) => b.error)?.error as string) || 'unknown';
        return res.status(502).json({ error: `Broadcast fail — ${firstErr}`, code: 'RESEND_ALL_FAILED', broadcasts });
      }
      const partialErr = broadcasts.find((b) => b.error)?.error as string | undefined;
      return res.json({
        message: `Newsletter: ${okCount}/${broadcasts.length} broadcast ${scheduledAt ? 'đã lên lịch' : 'đã gửi'}${partialErr ? ` (1 lỗi: ${partialErr})` : ''}`,
        mode: isScheduledMode ? 'scheduled' : 'immediate', broadcasts,
      });
    }

    // Nút dispatch hiện cả ở draft → auto-approve trước khi đăng/lên lịch (approve+đăng 1 phát).
    if (script.status === 'draft') {
      await supabase.from('cc_scripts')
        .update({ status: 'approved', approved_at: new Date().toISOString() })
        .eq('id', id);
      void updatePageStatus(id, 'approved').catch(() => {});
    }

    // FB Page/Profile cần Chrome GUI → phải đăng từ phiên user (Task Scheduler),
    // KHÔNG spawn từ server (pm2 không launch được Chrome). forum/push/resend OK trên server.
    const needsChrome = !!account && (account.startsWith('page_') || account.startsWith('profile_'));
    const enqueuePending = async (source: string) => {
      const { data: existing } = await supabase
        .from('cc_publish_queue')
        .select('id').eq('script_id', id).eq('status', 'pending');
      if (!(existing?.length)) {
        await supabase.from('cc_publish_queue').insert({
          script_id: id,
          trigger_type: 'manual',
          channel_target: account,
          status: 'pending',
          metadata: { source, user: req.headers['x-user'] || 'unknown' },
        });
      }
    };

    const enqueue = async (source: string) => {
      const { data: claimed } = await supabase
        .from('cc_publish_queue')
        .update({ status: 'processing', picked_at: new Date().toISOString() })
        .eq('script_id', id)
        .eq('status', 'pending')
        .select('id');
      if (!(claimed?.length)) {
        await supabase.from('cc_publish_queue').insert({
          script_id: id,
          trigger_type: 'manual',
          channel_target: account,
          status: 'processing',
          picked_at: new Date().toISOString(),
          metadata: { source, user: req.headers['x-user'] || 'unknown' },
        });
      }
    };
    const finalizeQueue = (label: string) => (r: { code: number; stderr: string }) => {
      supabase.from('cc_publish_queue')
        .update({
          status: r.code === 0 ? 'done' : 'failed',
          published_at: r.code === 0 ? new Date().toISOString() : null,
          error_message: r.code !== 0 ? r.stderr.slice(0, 2000) : null,
        })
        .eq('script_id', id).eq('status', 'processing')
        .then(() => {});
      if (r.code === 0) {
        void (async () => {
          const quick = await updatePageStatus(id, 'published');
          if (!quick.ok && quick.note === 'no-page') await pushScript(id);
        })().catch((e) => console.warn(`[notion-push] ${label} fail`, e));
      }
    };

    if (mode === 'scheduled' || mode === 'schedule2week') {
      if (!script.scheduled_at) {
        return res.status(422).json({ error: 'Chưa có lịch đăng (scheduled_at). Chọn ngày giờ trước khi lên lịch.', code: 'NO_SCHEDULE' });
      }
      const whenMs = new Date(script.scheduled_at).getTime();
      if (isNaN(whenMs) || whenMs < Date.now() + 20 * 60 * 1000) {
        return res.status(422).json({ error: 'Lịch quá gần — Meta BS cần ≥20 phút. Chọn giờ xa hơn.', code: 'SCHEDULE_TOO_SOON' });
      }
      if (needsChrome) {
        await enqueuePending('api_dispatch_schedule_local');
        return res.json({ message: 'Đã vào hàng đợi — Task Scheduler (phiên user) sẽ lên lịch Meta BS trong ~2 phút', script_id: id, mode: 'scheduled', via: 'local_queue' });
      }
      await enqueue('api_dispatch_schedule');
      spawnPublisher(['--single-schedule', id], `sched-${id.slice(0, 8)}`).then(finalizeQueue('dispatch-schedule'));
      return res.json({ message: 'Đang lên lịch Meta BS — check cc_publish_queue để track', script_id: id, mode: 'scheduled' });
    }

    // immediate / threshold_5 → đăng NOW
    await supabase.from('cc_scripts').update({ publish_ready_at: new Date().toISOString() }).eq('id', id);
    if (needsChrome) {
      // FB (page_/profile_) cần Chrome GUI — server (pm2) KHÔNG launch được Chrome.
      // Enqueue pending → Task Scheduler chạy poll_publish_queue.py --local (phiên user) đăng.
      await enqueuePending('api_dispatch_now_local');
      return res.json({ message: 'Đã vào hàng đợi — Task Scheduler (phiên user) sẽ đăng FB trong ~2 phút', script_id: id, mode: 'immediate', via: 'local_queue' });
    }
    await enqueue('api_dispatch_now');
    spawnPublisher(['--single', id], `single-${id.slice(0, 8)}`).then(finalizeQueue('dispatch-now'));
    return res.json({ message: 'Đang đăng ngay — check cc_publish_queue để track', script_id: id, mode: 'immediate' });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Lỗi dispatch' });
  }
});

// POST /content-pipeline/publish-batch — đăng tất cả approved với publish_mode=threshold_5 hoặc manual batch
router.post('/content-pipeline/publish-batch', async (req, res) => {
  try {
    const channelTarget = req.body?.channel_target as string | undefined;
    const forceAll = req.body?.force_all === true;

    // cc_scripts stores account as `posted_account`. channel_target in the
    // request body is the high-level filter that the caller cares about —
    // translate it to posted_account for cc_scripts queries.
    let query = supabase
      .from('cc_scripts')
      .select('id, posted_account, publish_mode')
      .eq('status', 'approved')
      .is('published_at', null);
    if (!forceAll) query = query.eq('publish_mode', 'threshold_5');
    if (channelTarget) query = query.eq('posted_account', channelTarget);

    const { data: scripts, error: sErr } = await query;
    if (sErr) throw sErr;
    if (!scripts || scripts.length === 0) {
      return res.json({ message: 'Không có bài nào đủ điều kiện publish', count: 0 });
    }

    const ids = scripts.map((s) => s.id);
    await supabase.from('cc_publish_queue').insert(
      ids.map((sid) => ({
        script_id: sid,
        trigger_type: 'manual' as const,
        channel_target: channelTarget,
        metadata: { source: 'api_publish_batch', batch_size: ids.length },
      }))
    );
    await supabase.from('cc_scripts')
      .update({ publish_queued_at: new Date().toISOString(), publish_ready_at: new Date().toISOString() })
      .in('id', ids);

    spawnPublisher(['--batch-approved', ...(channelTarget ? ['--channel', channelTarget] : [])], `batch-${ids.length}`).then((r) => {
      supabase.from('cc_publish_queue')
        .update({
          status: r.code === 0 ? 'done' : 'failed',
          published_at: r.code === 0 ? new Date().toISOString() : null,
          error_message: r.code !== 0 ? r.stderr.slice(0, 2000) : null,
        })
        .in('script_id', ids).eq('status', 'pending')
        .then(() => {});
      // Fire-and-forget: bulk sync Status=Published to Notion when publish
      // succeeds. Items were 'approved' before this call → Notion pages should
      // already exist from the approve flow's pushScript fallback.
      if (r.code === 0) {
        void bulkUpdatePageStatus(ids, 'published').catch((e) =>
          console.warn('[notion-push] publish-batch fail', e),
        );
      }
    });

    res.json({ message: `Đã enqueue ${ids.length} bài để publish batch`, count: ids.length, script_ids: ids });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Lỗi publish-batch' });
  }
});

// GET /content-pipeline/publish-queue — status của queue
router.get('/content-pipeline/publish-queue', async (req, res) => {
  try {
    const status = (req.query.status as string) || '';
    const limit = parseInt((req.query.limit as string) || '50');
    let q = supabase.from('cc_publish_queue').select('*').order('enqueued_at', { ascending: false }).limit(limit);
    if (status) q = q.in('status', status.split(','));
    const { data, error } = await q;
    if (error) throw error;
    res.json({ queue: data || [] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /content-pipeline/scripts/:id/publish-mode — đổi publish_mode
router.put('/content-pipeline/scripts/:id/publish-mode', async (req, res) => {
  const { id } = req.params;
  const { publish_mode } = req.body;
  if (!['scheduled', 'immediate', 'threshold_5'].includes(publish_mode)) {
    return res.status(400).json({ error: 'publish_mode phải là scheduled | immediate | threshold_5' });
  }
  try {
    const { error } = await supabase.from('cc_scripts').update({ publish_mode }).eq('id', id);
    if (error) throw error;
    res.json({ message: `Đã đổi publish_mode → ${publish_mode}`, script_id: id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Recent jobs — dùng cho Log Viewer list ở trang CCAIGen
router.get('/content-pipeline/jobs/recent', async (req, res) => {
  try {
    const limit = parseInt((req.query.limit as string) || '10');
    const { data, error } = await supabase
      .from('cc_generation_jobs')
      .select('id, job_type, content_type, status, model_used, progress, created_at, started_at, completed_at, total_tokens, generation_time_ms, error_message, output_error, input_params')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    const jobs = (data || []).map((j: any) => {
      let params: any = {};
      try { params = typeof j.input_params === 'string' ? JSON.parse(j.input_params) : (j.input_params || {}); } catch {}
      return {
        ...j,
        topic: params.userPrompt?.slice(0, 100) || params.topic || '',
        _provider: params.provider || '',
        _model: params.model || j.model_used || '',
      };
    });
    res.json({ jobs });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Lỗi tải recent jobs' });
  }
});

// 2026-04-19 Cách B — Drip sequence editor: UI load existing sequences + steps,
// generate content override cho step, link campaign_id vào step.

// GET /email/sequences — list ALL sequences với steps (cho UI dropdown)
// 2026-04-19: Removed is_active filter — DOC-ONB sequences hiện inactive (not yet live)
// nhưng UI generator vẫn cần pick để bind. Trả include_inactive qua query nếu cần filter.
// Thêm generation_hint vào steps để UI prefill textarea override.
router.get('/email/sequences', async (req, res) => {
  try {
    const activeOnly = req.query.active === '1';
    let seqQ = supabase
      .from('email_sequences')
      .select('id, name, description, segment, trigger_event, is_active')
      .order('name');
    if (activeOnly) seqQ = seqQ.eq('is_active', true);
    const { data: sequences, error: seqErr } = await seqQ;
    if (seqErr) throw seqErr;

    const { data: steps, error: stepsErr } = await supabase
      .from('email_sequence_steps')
      .select('id, sequence_id, step_order, delay_minutes, channel, template, subject_override, campaign_id_override, is_active, generation_hint')
      .order('step_order');
    if (stepsErr) throw stepsErr;

    // Group steps by sequence
    const result = (sequences || []).map((seq: any) => ({
      ...seq,
      steps: (steps || []).filter((s: any) => s.sequence_id === seq.id),
    }));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /email/steps/:stepId/hint — Save generation_hint cho step (V2 "Save hint for next time").
// Body: { generation_hint: string | null }. null = clear → fallback về DOC_ONB_DAY_HINTS default.
router.patch('/email/steps/:stepId/hint', async (req, res) => {
  try {
    const { generation_hint } = req.body || {};
    if (generation_hint !== null && typeof generation_hint !== 'string') {
      return res.status(400).json({ error: 'generation_hint must be string or null' });
    }
    const { data, error } = await supabase
      .from('email_sequence_steps')
      .update({ generation_hint: generation_hint || null, updated_at: new Date().toISOString() })
      .eq('id', req.params.stepId)
      .select('id, template, generation_hint')
      .single();
    if (error) throw error;
    res.json({ ok: true, step: data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /email/steps/:stepId/link-campaign — set step.campaign_id_override
// Body: { campaign_id: uuid | null }. null = clear override → fallback hardcode.
router.post('/email/steps/:stepId/link-campaign', async (req, res) => {
  try {
    const { campaign_id } = req.body || {};
    const { data, error } = await supabase
      .from('email_sequence_steps')
      .update({ campaign_id_override: campaign_id || null })
      .eq('id', req.params.stepId)
      .select('id, template, campaign_id_override')
      .single();
    if (error) throw error;
    res.json({ ok: true, step: data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /email/campaigns/:id — đọc lại 1 campaign (cho UI preview HTML đã lưu).
// Dùng để confirm sau khi user save HTML override: response trả nguyên html_body
// + subject + status + created_at để UI render iframe preview hoặc badge "đã lưu".
router.get('/email/campaigns/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cc_email_campaigns')
      .select('id, subject, html_body, preview_text, status, campaign_type, audience_type, created_at, metadata')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'campaign not found' });
    res.json({
      ok: true,
      campaign: {
        ...data,
        html_length: data.html_body?.length ?? 0,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /email/steps/:stepId/save-campaign — one-shot: tạo cc_email_campaigns
// từ HTML body + subject + sender, set status=approved, link ngay vào step.
// Dành cho drip override: bypass Notion, chị generate xong UI gọi trực tiếp.
router.post('/email/steps/:stepId/save-campaign', async (req, res) => {
  try {
    const {
      html_body, subject, preview_text,
      from_name, from_email, reply_to,
      template_key, track,
    } = req.body || {};
    if (!html_body || !subject) {
      return res.status(400).json({ error: 'html_body + subject required' });
    }
    // Sanitize before any further processing — strip <script>, on* handlers,
    // javascript: URIs, iframes/embeds. Keep table+inline-style surface so
    // email layouts work. Returns char-count diff for the audit log.
    const { clean: safeHtml, removed: bytesStripped } = sanitizeEmailHtml(html_body);
    if (!safeHtml.trim()) {
      return res.status(400).json({ error: 'html_body became empty after sanitization (everything was stripped)' });
    }
    // Get step → extract sequence segment để audience_type khớp
    const { data: step, error: stepErr } = await supabase
      .from('email_sequence_steps')
      .select('id, template, sequence_id, sequence:email_sequences(segment)')
      .eq('id', req.params.stepId)
      .single();
    if (stepErr || !step) return res.status(404).json({ error: 'step not found' });

    // cc_email_campaigns.audience_type CHECK constraint allows only:
    //   'all','tier_free','tier_1','tier_2','tier_3','segment','manual'
    // Map raw sequence.segment (e.g. 'ctv_partners','paid_buyers') → 'segment'
    // bucket; pass canonical tier names through unchanged.
    const VALID_AUDIENCE = new Set(['all', 'tier_free', 'tier_1', 'tier_2', 'tier_3', 'segment', 'manual']);
    const rawSegment = (step as any).sequence?.segment ?? 'all';
    const audienceType = VALID_AUDIENCE.has(rawSegment) ? rawSegment : 'segment';

    // Insert campaign (status=approved ngay để trigger enqueue nếu có users).
    // cc_email_campaigns.created_by has a NOT NULL constraint — fall back to the
    // hardcoded owner UUID (chị Jennie) when no auth session is attached, since
    // this route is callable from the trusted local UI without a session token.
    const ownerUuid = process.env.PAPERCLIP_OWNER_UUID
      || '01fe99b8-ef1b-4cdd-892a-3e976d6b1881';
    const { data: campaign, error: campErr } = await supabase
      .from('cc_email_campaigns')
      .insert({
        name: `Drip override · ${step.template} · ${new Date().toISOString().slice(0, 10)}`,
        template_key: template_key || step.template,
        sop_id: `drip_override:${step.id}`,
        from_name: from_name || 'GEM',
        from_email: from_email || 'hello@gemral.com',
        reply_to: reply_to || from_email || 'hello@gemral.com',
        subject,
        preview_text: preview_text || null,
        html_body: safeHtml,
        // CHECK constraints on cc_email_campaigns:
        //   campaign_type ∈ {one_time, sequence, ab_test, triggered, newsletter}
        //   status        ∈ {draft, scheduled, sending, sent, paused, failed}
        //   track         ∈ {wealth, wellness, integration}
        // Drip steps map naturally to 'sequence'. Status starts 'scheduled'
        // (= ready, will pick up when drip cron triggers; consumers gate on the
        //  step.campaign_id_override link, not the campaign's own status).
        campaign_type: 'sequence',
        track: track || 'wealth',
        audience_type: audienceType,
        status: 'scheduled',
        created_by: ownerUuid,
        metadata: {
          source: 'drip_override_ui',
          step_id: step.id,
          sanitized_bytes_stripped: bytesStripped,
          raw_segment: rawSegment,
        },
      })
      .select('id')
      .single();
    if (campErr) return res.status(500).json({ error: `insert campaign: ${campErr.message}` });

    // Link step → campaign
    const { error: linkErr } = await supabase
      .from('email_sequence_steps')
      .update({ campaign_id_override: campaign.id })
      .eq('id', req.params.stepId);
    if (linkErr) return res.status(500).json({ error: `link step: ${linkErr.message}` });

    res.json({
      ok: true,
      campaign_id: campaign.id,
      step_id: req.params.stepId,
      audience_type: audienceType,
      sanitized_bytes_stripped: bytesStripped,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
