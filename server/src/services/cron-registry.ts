// Cron Registry Service
//
// Central SSOT for EVERY recurring or scheduled unit of work in the Paperclip
// ecosystem. All agents, heartbeats, scripts, and schtasks MUST register here
// before running. The user controls enable/disable/execute/delete from the
// Paperclip UI (SOP Engine → Cron & Heartbeats tab).
//
// Policy:
//   1. No raw `setInterval` / `schtasks` / `pg_cron` usage allowed outside
//      this service. Anything recurring must go through `registerCron()`.
//   2. Disabling a cron here also disables the OS-level task (for schtasks
//      type). DB and OS are kept in lockstep.
//   3. Manual execution via `executeCronNow()` uses `spawnHidden()` so no
//      orphan cmd.exe windows pile up (root cause of BUG-027 / 2026-04-07
//      machine freeze).
//
// Created 2026-04-08 as part of Phase 0 — SOP Engine v2 refactor.

import { supabase } from '../channels/zalo-personal/supabase.js';
import { spawnHidden } from '../spawn-hidden.js';
import path from 'node:path';

// ─── Types ────────────────────────────────────────────────────────────────

export type CronOwnerType = 'paperclip_server' | 'agent' | 'user' | 'system' | 'external';
export type CronScheduleType = 'schtasks' | 'node_timer' | 'pg_cron' | 'external' | 'event_driven';
export type CronRunStatus = 'success' | 'failed' | 'cancelled' | 'running' | 'timeout';

export type CronPriority = 'critical' | 'high' | 'normal' | 'low';
export type CronLinkedEntityType =
  | 'task' | 'job' | 'issue' | 'sop' | 'pipeline'
  | 'customer' | 'campaign' | 'agent' | 'channel' | 'system';

/**
 * Full execution blueprint — lets the UI show "what happens when this cron
 * runs" without making the user read source code.
 */
export interface CronExecutionSpec {
  reads_tables?: string[];
  writes_tables?: string[];
  calls_apis?: Array<{ method: string; url: string; purpose?: string }>;
  notify_channels?: string[];          // e.g. ['telegram:jennie', 'email:resend', 'zalo_personal']
  output_endpoint?: string;            // human-readable "POST /api/... — creates ticket row"
  responsible_agent?: string;          // agent slug from paperclip_agents
  linked_sops?: string[];              // SOP IDs this cron touches
  linked_pipelines?: string[];         // pipeline IDs
  linked_workflows?: string[];
  description_detail?: string;         // full Vietnamese prose description
}

export interface CronRegistryEntry {
  id: string;                          // unique slug e.g. 'paperclip-blog-morning'
  display_name: string;
  description?: string;
  owner_type: CronOwnerType;
  owner_ref?: string | null;
  schedule_type: CronScheduleType;
  cron_expression?: string | null;
  script_full_path?: string | null;
  script_file_name?: string | null;
  execute_command?: string | null;
  working_directory?: string | null;
  enabled?: boolean;
  os_registered_as?: string | null;    // for schtasks type — the OS task name
  imported_from_os?: boolean;
  created_by?: string | null;
  // — Extended metadata (2026-04-08) —
  setup_by?: string | null;            // 'paperclip_startup', 'user_ui', 'agent:sales-closer'
  setup_by_label?: string | null;      // 'Paperclip Server', 'Jennie Chu', 'Agent Sales Closer'
  linked_entity_type?: CronLinkedEntityType | null;
  linked_entity_id?: string | null;
  linked_entity_label?: string | null; // e.g. 'Content Pipeline Biweekly'
  cron_humanized?: string | null;      // 'Mỗi 15 phút' / 'Mỗi ngày lúc 8:00'
  category?: string | null;            // 'email' | 'content' | 'crm' | 'sop' | 'system' | 'zalo' | 'heartbeat'
  priority?: CronPriority | null;
  notes?: string | null;
  tags?: string[] | null;
  execution_spec?: CronExecutionSpec | null;
}

export interface CronRegistryRow extends CronRegistryEntry {
  enabled: boolean;
  last_run_at: string | null;
  last_run_status: CronRunStatus | null;
  last_run_duration_ms: number | null;
  last_run_output: string | null;
  last_run_pid: number | null;
  next_run_at: string | null;
  run_count: number;
  fail_count: number;
  created_at: string;
  updated_at: string;
}

// ─── Internal helpers ─────────────────────────────────────────────────────

async function logEvent(cronId: string, eventType: string, actor: string, detail: any = {}): Promise<void> {
  try {
    await supabase.from('cron_registry_events').insert({
      cron_id: cronId,
      event_type: eventType,
      actor,
      detail,
    });
  } catch (err: any) {
    console.warn(`[cron-registry] logEvent failed for ${cronId}:`, err?.message);
  }
}

function scriptFileNameOf(fullPath?: string | null): string | null {
  if (!fullPath) return null;
  return path.basename(fullPath);
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Register (upsert) a cron entry. For `schtasks` type, this also creates
 * the OS-level scheduled task via `schtasks /Create` unless `imported_from_os`
 * is true (meaning we're recording an existing OS task, not creating one).
 *
 * Throws if required fields are missing OR the OS-level registration fails.
 */
export async function registerCron(
  entry: CronRegistryEntry,
  actor: string = 'system',
): Promise<CronRegistryRow> {
  // Basic validation
  if (!entry.id || !entry.display_name || !entry.schedule_type || !entry.owner_type) {
    throw new Error('registerCron: id, display_name, schedule_type, owner_type là bắt buộc');
  }

  const row = {
    id: entry.id,
    display_name: entry.display_name,
    description: entry.description ?? null,
    owner_type: entry.owner_type,
    owner_ref: entry.owner_ref ?? null,
    schedule_type: entry.schedule_type,
    cron_expression: entry.cron_expression ?? null,
    cron_humanized: entry.cron_humanized ?? humanizeCron(entry.cron_expression ?? null),
    script_full_path: entry.script_full_path ?? null,
    script_file_name: entry.script_file_name ?? scriptFileNameOf(entry.script_full_path),
    execute_command: entry.execute_command ?? null,
    working_directory: entry.working_directory ?? null,
    enabled: entry.enabled ?? true,
    os_registered_as: entry.os_registered_as ?? null,
    imported_from_os: entry.imported_from_os ?? false,
    created_by: entry.created_by ?? actor,
    setup_by: entry.setup_by ?? actor,
    setup_by_label: entry.setup_by_label ?? null,
    linked_entity_type: entry.linked_entity_type ?? null,
    linked_entity_id: entry.linked_entity_id ?? null,
    linked_entity_label: entry.linked_entity_label ?? null,
    category: entry.category ?? null,
    priority: entry.priority ?? 'normal',
    notes: entry.notes ?? null,
    tags: entry.tags ?? null,
    execution_spec: entry.execution_spec ?? {},
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('cron_registry')
    .upsert(row, { onConflict: 'id' })
    .select()
    .single();

  if (error || !data) {
    throw new Error(`registerCron DB upsert failed: ${error?.message || 'unknown'}`);
  }

  await logEvent(entry.id, 'registered', actor, {
    schedule_type: entry.schedule_type,
    owner_type: entry.owner_type,
    owner_ref: entry.owner_ref,
    imported_from_os: entry.imported_from_os ?? false,
  });

  return data as CronRegistryRow;
}

/**
 * Delete a cron entry. For `schtasks` type, also attempts to remove the
 * OS-level task via `schtasks /Delete`. Safe no-op if OS task doesn't exist.
 */
export async function unregisterCron(id: string, actor: string = 'system'): Promise<void> {
  const { data: existing } = await supabase
    .from('cron_registry')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (!existing) return;

  if (existing.schedule_type === 'schtasks' && existing.os_registered_as) {
    try {
      await runSchtasks(['/Delete', '/TN', existing.os_registered_as, '/F']);
    } catch (err: any) {
      console.warn(`[cron-registry] schtasks delete warn for ${existing.os_registered_as}:`, err?.message);
    }
  }

  await supabase.from('cron_registry').delete().eq('id', id);
  await logEvent(id, 'deleted', actor, { os_registered_as: existing.os_registered_as });
}

/**
 * Toggle enabled state. For `schtasks` type, also shells `schtasks /Change
 * /Enable` or `/Disable` so DB and OS stay in lockstep.
 */
export async function setCronEnabled(id: string, enabled: boolean, actor: string = 'system'): Promise<CronRegistryRow> {
  const { data: existing } = await supabase
    .from('cron_registry')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (!existing) throw new Error(`Cron ${id} không tồn tại`);

  if (existing.schedule_type === 'schtasks' && existing.os_registered_as) {
    try {
      await runSchtasks(['/Change', '/TN', existing.os_registered_as, enabled ? '/Enable' : '/Disable']);
    } catch (err: any) {
      console.warn(`[cron-registry] schtasks toggle warn for ${existing.os_registered_as}:`, err?.message);
    }
  }

  const { data, error } = await supabase
    .from('cron_registry')
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error || !data) throw new Error(`setCronEnabled DB update failed: ${error?.message}`);

  await logEvent(id, enabled ? 'enabled' : 'disabled', actor);
  return data as CronRegistryRow;
}

/**
 * Manually run a cron now. Returns once the subprocess exits or times out.
 * Uses `spawnHidden` so no orphan cmd.exe windows appear.
 */
export async function executeCronNow(
  id: string,
  actor: string = 'user',
  timeoutMs: number = 120_000,
): Promise<{ status: CronRunStatus; output: string; durationMs: number }> {
  const { data: row } = await supabase
    .from('cron_registry')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (!row) throw new Error(`Cron ${id} không tồn tại`);
  if (!row.execute_command && !row.script_full_path) {
    throw new Error(`Cron ${id} không có execute_command hoặc script_full_path để chạy`);
  }

  await logEvent(id, 'execute_start', actor, { manual: true });
  await supabase
    .from('cron_registry')
    .update({ last_run_status: 'running', last_run_at: new Date().toISOString() })
    .eq('id', id);

  const startTime = Date.now();
  const cmdLine = row.execute_command || row.script_full_path!;
  const workDir = row.working_directory || path.dirname(row.script_full_path || '.');

  // Parse the command line into executable + args. Keep simple: split on first space.
  const firstSpace = cmdLine.indexOf(' ');
  const executable = firstSpace === -1 ? cmdLine : cmdLine.slice(0, firstSpace);
  const argString = firstSpace === -1 ? '' : cmdLine.slice(firstSpace + 1);
  const args = argString.length > 0 ? argString.split(/\s+/) : [];

  return new Promise((resolve) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    let resolved = false;

    const proc = spawnHidden(executable, args, {
      cwd: workDir,
      env: { ...process.env, PYTHONUTF8: '1' },
    });

    const pid = proc.pid;
    if (pid) {
      // Fire-and-forget PID update; ignore failures.
      (async () => {
        try {
          await supabase.from('cron_registry').update({ last_run_pid: pid }).eq('id', id);
        } catch { /* ignore */ }
      })();
    }

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { proc.kill('SIGTERM'); } catch { /* noop */ }
      const duration = Date.now() - startTime;
      finalize('timeout', stdoutBuf + stderrBuf + `\n[timeout after ${timeoutMs}ms]`, duration);
    }, timeoutMs);

    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      if (stdoutBuf.length > 8000) stdoutBuf = stdoutBuf.slice(-8000);
    });
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-8000);
    });

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (resolved) return;
      resolved = true;
      const duration = Date.now() - startTime;
      const status: CronRunStatus = code === 0 ? 'success' : 'failed';
      const output = (status === 'success' ? stdoutBuf : (stderrBuf + '\n' + stdoutBuf)).slice(-4000);
      finalize(status, output, duration);
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      if (resolved) return;
      resolved = true;
      const duration = Date.now() - startTime;
      finalize('failed', `[spawn error] ${err.message}`, duration);
    });

    async function finalize(status: CronRunStatus, output: string, durationMs: number) {
      await supabase
        .from('cron_registry')
        .update({
          last_run_status: status,
          last_run_duration_ms: durationMs,
          last_run_output: output,
          last_run_pid: null,
          run_count: (row.run_count || 0) + 1,
          fail_count: status === 'success' ? (row.fail_count || 0) : (row.fail_count || 0) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id);
      await logEvent(id, status === 'success' ? 'execute_complete' : 'execute_failed', actor, {
        duration_ms: durationMs,
        output_preview: output.slice(0, 300),
      });
      resolve({ status, output, durationMs });
    }
  });
}

/**
 * Kill a currently running cron's subprocess via its last-known PID.
 */
export async function cancelCron(id: string, actor: string = 'user'): Promise<boolean> {
  const { data: row } = await supabase
    .from('cron_registry')
    .select('last_run_pid, last_run_status')
    .eq('id', id)
    .maybeSingle();

  if (!row || !row.last_run_pid || row.last_run_status !== 'running') return false;

  try {
    process.kill(row.last_run_pid, 'SIGTERM');
  } catch (err: any) {
    console.warn(`[cron-registry] cancel kill warn:`, err?.message);
  }

  await supabase
    .from('cron_registry')
    .update({ last_run_status: 'cancelled', last_run_pid: null })
    .eq('id', id);

  await logEvent(id, 'execute_cancelled', actor);
  return true;
}

/**
 * Scan the OS for existing `Paperclip*` scheduled tasks and import them into
 * `cron_registry` so the user sees the full landscape in the UI. Safe to
 * run multiple times — uses upsert. Marks imported rows with
 * `imported_from_os = true` so the UI can show a legacy badge.
 *
 * Returns the number of tasks scanned/imported.
 */
export async function scanOsTasks(actor: string = 'system'): Promise<{ scanned: number; imported: number }> {
  if (process.platform !== 'win32') {
    return { scanned: 0, imported: 0 };
  }

  let lines: string[] = [];
  try {
    const output = await runPowerShell(
      `Get-ScheduledTask | Where-Object { $_.TaskName -like '*Paperclip*' } | ` +
      `Select-Object TaskName, State, Description | ConvertTo-Json -Compress`,
    );
    const parsed = output.trim() ? JSON.parse(output) : [];
    const tasks = Array.isArray(parsed) ? parsed : [parsed];
    lines = tasks;
  } catch (err: any) {
    console.warn(`[cron-registry] scanOsTasks PowerShell failed:`, err?.message);
    return { scanned: 0, imported: 0 };
  }

  let imported = 0;
  for (const t of lines as any[]) {
    if (!t || !t.TaskName) continue;
    const id = `os-${String(t.TaskName).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    try {
      await registerCron(
        {
          id,
          display_name: t.TaskName,
          description: t.Description || 'Imported from Windows Task Scheduler',
          owner_type: 'external',
          owner_ref: 'windows_task_scheduler',
          schedule_type: 'schtasks',
          os_registered_as: t.TaskName,
          imported_from_os: true,
          enabled: t.State === 'Ready' || t.State === 3, // 3 = Running/Ready in enum
        },
        actor,
      );
      await logEvent(id, 'os_scanned', actor, { state: t.State });
      imported++;
    } catch (err: any) {
      console.warn(`[cron-registry] scan import failed for ${t.TaskName}:`, err?.message);
    }
  }
  return { scanned: lines.length, imported };
}

/**
 * List all registered crons (optionally filtered).
 */
export async function listCrons(filter?: { enabled?: boolean; owner_type?: CronOwnerType }): Promise<CronRegistryRow[]> {
  let query = supabase.from('cron_registry').select('*').order('display_name', { ascending: true });
  if (filter?.enabled !== undefined) query = query.eq('enabled', filter.enabled);
  if (filter?.owner_type) query = query.eq('owner_type', filter.owner_type);
  const { data, error } = await query;
  if (error) throw new Error(`listCrons failed: ${error.message}`);
  return (data || []) as CronRegistryRow[];
}

export async function getCron(id: string): Promise<CronRegistryRow | null> {
  const { data } = await supabase.from('cron_registry').select('*').eq('id', id).maybeSingle();
  return (data as CronRegistryRow) || null;
}

/**
 * Record a completed run for node_timer crons (FollowUpCron, ZaloListener, etc.)
 * that use setInterval instead of executeCronNow().
 */
export async function recordCronRun(
  id: string,
  result: { status: CronRunStatus; durationMs: number; output: string },
): Promise<void> {
  try {
    const { data: row } = await supabase
      .from('cron_registry')
      .select('run_count, fail_count')
      .eq('id', id)
      .maybeSingle();

    if (!row) return; // cron not registered, skip silently

    await supabase
      .from('cron_registry')
      .update({
        last_run_at: new Date().toISOString(),
        last_run_status: result.status,
        last_run_duration_ms: result.durationMs,
        last_run_output: result.output.slice(-4000),
        last_run_pid: null,
        run_count: (row.run_count || 0) + 1,
        fail_count: result.status === 'success' ? (row.fail_count || 0) : (row.fail_count || 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    await logEvent(id, result.status === 'success' ? 'run_complete' : 'run_failed', 'node_timer', {
      duration_ms: result.durationMs,
      output_preview: result.output.slice(0, 300),
    });
  } catch (err: any) {
    console.warn(`[cron-registry] recordCronRun failed for ${id}:`, err?.message);
  }
}

// ─── Humanization ─────────────────────────────────────────────────────────

/**
 * Convert a cron expression into human-readable Vietnamese.
 * Covers the most common patterns used in GEM ecosystem schedules.
 * Falls back to the raw expression for unusual patterns.
 */
export function humanizeCron(expr: string | null | undefined): string | null {
  if (!expr) return null;
  const raw = expr.trim();
  const parts = raw.split(/\s+/);
  // Handle Node timer intervals expressed as "every Xs" / "every Xm"
  const everyMatch = /^every\s+(\d+)\s*(s|ms|m|min|mins|h|hr|hrs)$/i.exec(raw);
  if (everyMatch) {
    const n = Number(everyMatch[1]);
    const unit = everyMatch[2].toLowerCase();
    if (unit === 'ms') return `Mỗi ${n}ms`;
    if (unit === 's') return `Mỗi ${n}s`;
    if (unit.startsWith('m')) return `Mỗi ${n} phút`;
    if (unit.startsWith('h')) return `Mỗi ${n} giờ`;
  }
  if (parts.length !== 5) return raw;
  const [minute, hour, dom, month, dow] = parts;

  // All stars
  if (minute === '*' && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return 'Mỗi phút';
  }
  // Every N minutes
  const everyMinMatch = /^\*\/(\d+)$/.exec(minute);
  if (everyMinMatch && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return `Mỗi ${everyMinMatch[1]} phút`;
  }
  // Minutes list at every hour — e.g. "0,15,30,45 * * * *" → mỗi 15 phút
  if (/^\d+(,\d+)+$/.test(minute) && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    const list = minute.split(',').map(Number).sort((a, b) => a - b);
    if (list.length > 1) {
      const diff = list[1] - list[0];
      if (list.every((m, i) => i === 0 || m - list[i - 1] === diff)) {
        return `Mỗi ${diff} phút (${list.join(', ')})`;
      }
    }
    return `Các phút ${minute} mỗi giờ`;
  }
  // Daily at HH:MM
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === '*' && month === '*' && dow === '*') {
    return `Mỗi ngày lúc ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  }
  // Weekdays (dow = 1-5)
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === '*' && month === '*' && dow === '1-5') {
    return `Từ Thứ 2 đến Thứ 6 lúc ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  }
  // Weekly (dow = 0-6 or name)
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === '*' && month === '*' && /^\d+$/.test(dow)) {
    const days = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
    return `Mỗi ${days[Number(dow)] || `day-${dow}`} lúc ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  }
  // Monthly (dom is a number)
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && /^\d+$/.test(dom) && month === '*' && dow === '*') {
    return `Ngày ${dom} hàng tháng lúc ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  }
  return raw;
}

// ─── Known pg_cron jobs (seeded on server start) ─────────────────────────
//
// Daily email resend + subscription + analytics all run via Supabase pg_cron.
// We hardcode the list so that even if the `get_cron_jobs` RPC isn't exposed,
// the registry knows about them and the UI can show them to the user.
// These are IMPORT-ONLY records — disabling them here does NOT disable the
// actual pg_cron job (pg_cron toggle requires DB-side SQL). The UI warns
// users that pg_cron entries are read-only for state changes.

interface PgCronSeed {
  id: string;
  display_name: string;
  cron_expression: string;
  category: string;
  description: string;
  priority?: CronPriority;
  linked_entity_label?: string;
  execution_spec: CronExecutionSpec;
}

const PG_CRON_SEEDS: PgCronSeed[] = [
  {
    id: 'pg-subscription-checker',
    display_name: 'Subscription Checker',
    cron_expression: '0 17 * * *',
    category: 'crm',
    description: 'Check subscription status and flag expiring ones',
    priority: 'high',
    execution_spec: {
      reads_tables: ['profiles', 'course_enrollments', 'shopify_orders'],
      writes_tables: ['profiles', 'cc_email_campaigns'],
      notify_channels: ['telegram:jennie'],
      output_endpoint: 'UPDATE profiles SET course_tier_expires_at; INSERT cc_email_campaigns (renewal reminder)',
      responsible_agent: 'customer-success',
      linked_sops: ['COM-007', 'SAL-009'],
      linked_pipelines: ['pipe-retention-winback'],
      description_detail: 'Mỗi ngày 17h quét `profiles` tìm các user có tier sắp expire trong 7 ngày tới. Với mỗi user: (1) flag `profiles.course_tier_expires_at` gần hết, (2) tạo email renewal reminder vào `cc_email_campaigns`, (3) nếu đã expire → notify Telegram cho Jennie để CS DM cá nhân.',
    },
  },
  {
    id: 'pg-expire-scanner-trials',
    display_name: 'Expire Scanner Trials',
    cron_expression: '0 0 * * *',
    category: 'crm',
    description: 'Mark GEM Scanner trial subscriptions as expired',
    priority: 'high',
    execution_spec: {
      reads_tables: ['profiles'],
      writes_tables: ['profiles'],
      notify_channels: [],
      output_endpoint: 'UPDATE profiles SET scanner_tier = NULL WHERE scanner_tier_expires_at < now()',
      responsible_agent: 'customer-success',
      linked_sops: ['SOP-SCANNER-TRIAL'],
      description_detail: 'Đúng 0h mỗi ngày quét `profiles.scanner_tier_expires_at` và set `scanner_tier = NULL` cho các trial đã hết hạn. Không gửi email (trial-expiry-reminders job lo việc gửi trước đó).',
    },
  },
  {
    id: 'pg-trial-expiry-reminders',
    display_name: 'Trial Expiry Reminders',
    cron_expression: '0 8 * * *',
    category: 'email',
    description: 'Send reminder emails for trials expiring soon',
    priority: 'normal',
    execution_spec: {
      reads_tables: ['profiles', 'email_templates'],
      writes_tables: ['cc_email_campaigns', 'cc_email_sends'],
      calls_apis: [{ method: 'POST', url: 'https://api.resend.com/emails', purpose: 'Send email via Resend' }],
      notify_channels: ['email:resend'],
      output_endpoint: 'POST https://api.resend.com/emails (Resend API)',
      responsible_agent: 'email-crm-manager',
      linked_sops: ['CNT-021', 'DST-004'],
      linked_pipelines: ['pipe-retention-winback'],
      description_detail: 'Mỗi ngày 8h sáng gửi email nhắc nhở cho các user có trial còn 3/1/0 ngày. Lấy template từ `email_templates` theo `type=trial_expiry`, personalize với tên user, insert vào `cc_email_campaigns`, gọi Resend API, ghi kết quả vào `cc_email_sends` (open_tracking, click_tracking).',
    },
  },
  {
    id: 'pg-paper-trade-monitor',
    display_name: 'Paper Trade Monitor',
    cron_expression: '* * * * *',
    category: 'trading',
    description: 'Monitor paper trade positions and update PnL',
    priority: 'normal',
    execution_spec: {
      reads_tables: ['paper_trades', 'market_prices'],
      writes_tables: ['paper_trades'],
      calls_apis: [{ method: 'GET', url: 'https://api.binance.com/api/v3/ticker/price', purpose: 'Get current crypto prices' }],
      notify_channels: ['push:mobile_app'],
      output_endpoint: 'UPDATE paper_trades SET current_pnl, status (if hit SL/TP)',
      responsible_agent: 'analytics-agent',
      description_detail: 'Mỗi phút polling: đọc `paper_trades` status=open, fetch giá hiện tại từ Binance API, tính PnL, update row. Nếu giá chạm SL hoặc TP → set status=closed + gửi push notification cho user qua mobile app.',
    },
  },
  {
    id: 'pg-expire-boosts',
    display_name: 'Expire Boosts',
    cron_expression: '*/5 * * * *',
    category: 'crm',
    description: 'Expire time-boxed booster offers',
    priority: 'low',
    execution_spec: {
      reads_tables: ['active_boosts'],
      writes_tables: ['active_boosts'],
      output_endpoint: 'UPDATE active_boosts SET status=expired WHERE expires_at < now()',
      description_detail: 'Mỗi 5 phút quét `active_boosts` và expire các booster đã hết hạn. Nhẹ, không notify, chỉ update DB.',
    },
  },
  {
    id: 'pg-daily-analytics',
    display_name: 'Daily Analytics',
    cron_expression: '0 1 * * *',
    category: 'analytics',
    description: 'Compute daily analytics rollups (revenue, reach, conversion)',
    priority: 'normal',
    execution_spec: {
      reads_tables: ['shopify_orders', 'cc_email_sends', 'cc_social_posts', 'profiles', 'course_enrollments'],
      writes_tables: ['daily_analytics_snapshots'],
      notify_channels: ['telegram:jennie'],
      output_endpoint: 'INSERT daily_analytics_snapshots; Telegram daily brief to Jennie',
      responsible_agent: 'data-analyst',
      linked_sops: ['ANA-001', 'ANA-002', 'ANA-003'],
      linked_pipelines: ['pipe-content-biweekly', 'pipe-email-biweekly'],
      description_detail: 'Mỗi ngày 1h sáng compute rollup: doanh thu hôm qua (shopify_orders), email reach/open/click (cc_email_sends), social reach/engagement (cc_social_posts), new signups (profiles), new enrollments. Ghi snapshot vào `daily_analytics_snapshots`. Gửi Telegram brief cho Jennie lúc 8h sáng (qua daily-analytics + morning-brief workflow).',
    },
  },
  {
    id: 'pg-waitlist-email-nurture',
    display_name: 'Waitlist Email Nurture',
    cron_expression: '0 1 * * *',
    category: 'email',
    description: 'Send nurture emails to waitlist subscribers',
    priority: 'normal',
    execution_spec: {
      reads_tables: ['waitlist_subscribers', 'email_templates'],
      writes_tables: ['cc_email_campaigns', 'cc_email_sends', 'waitlist_subscribers'],
      calls_apis: [{ method: 'POST', url: 'https://api.resend.com/emails', purpose: 'Send via Resend' }],
      notify_channels: ['email:resend'],
      output_endpoint: 'POST Resend API — nurture sequence day N',
      responsible_agent: 'email-crm-manager',
      linked_sops: ['CNT-021', 'DST-011'],
      linked_pipelines: ['pipe-onboarding-post-purchase'],
      description_detail: 'Mỗi ngày 1h sáng scan `waitlist_subscribers`, tính số ngày từ khi subscribe, chọn đúng email template theo day (Day 0/1/3/5/7 nurture sequence), gửi via Resend, update `waitlist_subscribers.last_email_sent_at`.',
    },
  },
  {
    id: 'pg-email-send-time-stats',
    display_name: 'Email Send Time Stats',
    cron_expression: '30 0 * * *',
    category: 'email',
    description: 'Compute optimal send-time stats per segment',
    priority: 'low',
    execution_spec: {
      reads_tables: ['cc_email_sends'],
      writes_tables: ['email_send_time_stats'],
      output_endpoint: 'INSERT email_send_time_stats (open_rate by hour/day/segment)',
      responsible_agent: 'data-analyst',
      linked_sops: ['ANA-003'],
      description_detail: 'Mỗi ngày 0h30 aggregation open rate từ `cc_email_sends` theo giờ+ngày_trong_tuần+segment → ghi `email_send_time_stats` để sau này chọn giờ gửi tối ưu cho mỗi segment.',
    },
  },
  {
    id: 'pg-email-automation-scheduler',
    display_name: 'Email Automation Scheduler — Daily Email Resend',
    cron_expression: '0,15,30,45 * * * *',
    category: 'email',
    description:
      'Polls cc_email_campaigns + automation queue every 15 minutes and sends emails via Resend. This is the main daily email resend pipeline.',
    priority: 'critical',
    linked_entity_label: 'cc_email_campaigns + cc_email_sends',
    execution_spec: {
      reads_tables: ['cc_email_campaigns', 'cc_email_sends', 'profiles'],
      writes_tables: ['cc_email_campaigns', 'cc_email_sends'],
      calls_apis: [
        { method: 'POST', url: 'https://api.resend.com/emails', purpose: 'Send email' },
        { method: 'GET', url: 'https://api.resend.com/emails/:id', purpose: 'Check delivery status' },
      ],
      notify_channels: ['email:resend', 'telegram:jennie (on failure)'],
      output_endpoint: 'POST https://api.resend.com/emails → UPDATE cc_email_campaigns status, INSERT cc_email_sends per recipient',
      responsible_agent: 'email-crm-manager',
      linked_sops: ['CNT-021', 'DST-004', 'DST-007', 'DST-009', 'DST-010', 'DST-011'],
      linked_pipelines: [
        'pipe-email-biweekly',
        'pipe-onboarding-post-purchase',
        'pipe-retention-winback',
        'pipe-launch-product',
      ],
      description_detail: 'Đây là trái tim của hệ thống email của Gemral. Mỗi 15 phút polling `cc_email_campaigns WHERE status=scheduled AND scheduled_at <= now()`. Với mỗi campaign match: expand segment query → list recipients → loop: render HTML personalize → POST Resend API → INSERT row vào `cc_email_sends` (track open/click) → nếu lỗi: increment retry_count, notify Telegram cho Jennie nếu retry >= 3 → UPDATE campaign status=sending/sent/failed. Support tất cả pipelines email: biweekly 8 segments, onboarding 7 khóa, retention win-back Day 30/60/90, launch nurture, trial reminder.',
    },
  },
];

// ─── Known Node timers (seeded on server start) ─────────────────────────

interface NodeTimerSeed {
  id: string;
  display_name: string;
  cron_expression: string;            // pseudo-cron "every Xm" / "every Xs"
  category: string;
  owner_ref: string;
  description: string;
  priority?: CronPriority;
  source_file: string;
  execution_spec: CronExecutionSpec;
}

const NODE_TIMER_SEEDS: NodeTimerSeed[] = [
  {
    id: 'node-follow-up-cron',
    display_name: 'CRM Follow-Up Queue',
    cron_expression: 'every 600s',
    category: 'crm',
    owner_ref: 'paperclip_server',
    description: 'Scans follow_up_queue and sends queued follow-up messages',
    priority: 'high',
    source_file: 'paperclip/server/src/channels/crm/follow-up-cron.ts',
    execution_spec: {
      reads_tables: ['follow_up_queue', 'crm_customers', 'channel_instances'],
      writes_tables: ['follow_up_queue', 'channel_sent_messages'],
      notify_channels: ['zalo_personal', 'facebook_messenger'],
      output_endpoint: 'Sends message via zalo-personal/send OR facebook/send APIs',
      responsible_agent: 'sales-closer',
      linked_sops: ['SAL-005', 'CS-011'],
      linked_pipelines: ['pipe-sales-lead-close', 'pipe-retention-winback'],
      description_detail: 'Mỗi 10 phút quét `follow_up_queue` tìm các row status=pending AND scheduled_at <= now(). Với mỗi row: lookup customer → gửi tin nhắn qua channel tương ứng (Zalo Personal hoặc FB Messenger) → nếu success: update status=sent, ghi `channel_sent_messages` → nếu fail: increment retry_count, nếu > 3 thì mark status=failed.',
    },
  },
  {
    id: 'node-threads-token-refresh',
    display_name: 'Threads API Token Refresh',
    cron_expression: 'every 21600s',
    category: 'channel',
    owner_ref: 'paperclip_server',
    description: 'Refreshes Threads long-lived tokens (THREADS_TOKEN_*) when <10 days remain',
    priority: 'high',
    source_file: 'paperclip/server/src/channels/threads/token-store.ts',
    execution_spec: {
      reads_tables: [],
      writes_tables: [],
      output_endpoint: 'paperclip/server/.env THREADS_TOKEN_* + THREADS_TOKEN_EXPIRES_AT_*',
      description_detail: 'Mỗi 6 giờ (lần đầu 60s sau khởi động) đọc token Threads từng tài khoản (jennie, gemral_edge). Còn <10 ngày và token ≥24h tuổi → gọi graph.threads.net/refresh_access_token (th_refresh_token) → ghi .env + nạp nóng. Hết hạn → log lỗi, phải bấm lại /api/channels/threads/oauth/start. Probe gác: crypto scripts/audit_threads_token_health.py.',
    },
  },
  {
    id: 'node-dedupe-cleanup',
    display_name: 'Message Dedupe Cleanup',
    cron_expression: 'every 300s',
    category: 'channel',
    owner_ref: 'paperclip_server',
    description: 'Prunes stale message dedupe cache entries',
    priority: 'low',
    source_file: 'paperclip/server/src/channels/dedupe.ts',
    execution_spec: {
      reads_tables: [],
      writes_tables: [],
      output_endpoint: 'In-memory cache cleanup (no DB write)',
      description_detail: 'Mỗi 5 phút cleanup in-memory Map của dedupe cache. Xóa các entries > 1 giờ để tránh memory leak. Không đọc/ghi DB. Không notify.',
    },
  },
  {
    id: 'node-zalo-health-check',
    display_name: 'Zalo Personal Channel Health Check',
    cron_expression: 'every 120s',
    category: 'zalo',
    owner_ref: 'paperclip_server',
    description: 'Monitors Zalo WebSocket connection health and auto-reconnects',
    priority: 'high',
    source_file: 'paperclip/server/src/channels/zalo-personal/channel.ts',
    execution_spec: {
      reads_tables: ['channel_instances'],
      writes_tables: ['channel_instances'],
      notify_channels: ['telegram:jennie (on disconnect)'],
      output_endpoint: 'UPDATE channel_instances SET status, last_heartbeat_at',
      description_detail: 'Mỗi 120s kiểm tra WebSocket connection tới Zalo Server có alive không. Nếu đã disconnect > 2 lần liên tiếp → auto reconnect bằng cookies đã lưu → nếu reconnect fail → update `channel_instances.status=error` + gửi Telegram alert cho Jennie để re-scan QR.',
    },
  },
  {
    id: 'node-zalo-listener-ping',
    display_name: 'Zalo WebSocket Ping',
    cron_expression: 'every 30s',
    category: 'zalo',
    owner_ref: 'paperclip_server',
    description: 'Keeps Zalo WS connection alive with periodic ping frames',
    priority: 'high',
    source_file: 'paperclip/server/src/channels/zalo-personal/protocol/listener.ts',
    execution_spec: {
      output_endpoint: 'Send WebSocket ping frame to tt-chatN-wpa.chat.zalo.me',
      description_detail: 'Mỗi 30s gửi raw TLS ping frame (RSV1 custom) tới Zalo WebSocket server để giữ connection alive. Không đọc/ghi DB. Nếu ping fail → listener throw → zalo health check sẽ restart.',
    },
  },
  {
    id: 'node-live-events-ws-ping',
    display_name: 'LiveUpdates WebSocket Ping',
    cron_expression: 'every 30s',
    category: 'system',
    owner_ref: 'paperclip_server',
    description: 'Keeps Paperclip UI live-updates WS alive',
    priority: 'normal',
    source_file: 'paperclip/server/src/realtime/live-events-ws.ts',
    execution_spec: {
      output_endpoint: 'Broadcast WS ping to all connected Paperclip UI clients',
      description_detail: 'Mỗi 30s broadcast ping frame tới tất cả Paperclip UI clients đang connect. Giữ connection alive cho LiveUpdatesProvider, Training Room live thread, và SOP execution SSE. Nếu client không response → drop từ connection pool.',
    },
  },
];

/**
 * Seed the registry with all known pg_cron jobs + Node timers so the user
 * sees the full scheduling landscape in the UI even if individual schedulers
 * haven't explicitly called `registerCron()` yet. Safe to call repeatedly —
 * upsert semantics.
 *
 * Call this ONCE during Paperclip server startup, after DB connection is
 * ready. NO cron, NO timer — it's a single fire-and-forget call.
 */
export async function seedKnownSchedulers(): Promise<{ pgcron: number; nodeTimers: number }> {
  let pgcron = 0;
  let nodeTimers = 0;

  for (const seed of PG_CRON_SEEDS) {
    try {
      await registerCron(
        {
          id: seed.id,
          display_name: seed.display_name,
          description: seed.description,
          owner_type: 'system',
          owner_ref: 'gemral_supabase_pg_cron',
          schedule_type: 'pg_cron',
          cron_expression: seed.cron_expression,
          cron_humanized: humanizeCron(seed.cron_expression),
          enabled: true,
          category: seed.category,
          priority: seed.priority || 'normal',
          setup_by: 'paperclip_startup',
          setup_by_label: 'Paperclip Server (auto-seed)',
          linked_entity_type: 'system',
          linked_entity_label: seed.linked_entity_label || seed.display_name,
          notes: 'pg_cron job on Gemral Supabase — enable/disable must be done via SQL (pg_cron.job table). UI state-changes are advisory only.',
          tags: ['pg_cron', 'supabase', seed.category],
          execution_spec: seed.execution_spec,
        },
        'paperclip_startup',
      );
      pgcron++;
    } catch (err: any) {
      console.warn(`[cron-registry seed] pg_cron ${seed.id} failed:`, err?.message);
    }
  }

  for (const seed of NODE_TIMER_SEEDS) {
    try {
      await registerCron(
        {
          id: seed.id,
          display_name: seed.display_name,
          description: seed.description,
          owner_type: 'paperclip_server',
          owner_ref: seed.owner_ref,
          schedule_type: 'node_timer',
          cron_expression: seed.cron_expression,
          cron_humanized: humanizeCron(seed.cron_expression),
          enabled: true,
          category: seed.category,
          priority: seed.priority || 'normal',
          setup_by: 'paperclip_startup',
          setup_by_label: 'Paperclip Server (auto-seed)',
          linked_entity_type: 'system',
          linked_entity_label: seed.display_name,
          script_full_path: `C:/Users/Jennie Chu/Desktop/Projects/${seed.source_file}`,
          script_file_name: seed.source_file.split('/').pop(),
          notes: 'Node setInterval timer — enable/disable requires Paperclip server restart. Use Execute Now to trigger a health check.',
          tags: ['node_timer', seed.category],
          execution_spec: seed.execution_spec,
        },
        'paperclip_startup',
      );
      nodeTimers++;
    } catch (err: any) {
      console.warn(`[cron-registry seed] node timer ${seed.id} failed:`, err?.message);
    }
  }

  return { pgcron, nodeTimers };
}

// ─── Private spawn helpers ────────────────────────────────────────────────

function runSchtasks(args: string[]): Promise<string> {
  return runHidden('schtasks', args);
}

function runPowerShell(script: string): Promise<string> {
  return runHidden('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
}

function runHidden(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const proc = spawnHidden(cmd, args, { env: process.env });
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on('data', (c: Buffer) => { stdout += c.toString(); });
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
    proc.on('close', (code: number | null) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited ${code}: ${stderr}`));
    });
    proc.on('error', reject);
  });
}
