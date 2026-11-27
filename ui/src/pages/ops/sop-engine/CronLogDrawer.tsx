// CronLogDrawer — full-screen modal for inspecting a scheduled job.
// Layout + BaseItem pattern mirror SESSION_LOG_VIEWER_FEATURE_SPEC (AgentLogDrawer).
// Data sources:
//   GET /api/registry/crons/:id         → identity + execution_spec
//   GET /api/registry/crons/:id/runs    → per-execution history (transcript)
//   GET /api/registry/crons/:id/related → flow siblings (execution_spec.related_crons)

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertCircle,
  ChevronRight,
  Clock,
  Copy as CopyIcon,
  FileCode,
  Folder,
  Hash,
  Link as LinkIcon,
  Loader2,
  Play,
  PowerOff,
  Power,
  RefreshCw,
  ShieldCheck,
  Tag,
  Terminal,
  X,
} from 'lucide-react';
import { useToast } from '@/context/ToastContext';
import { copyToClipboard } from '@/lib/clipboard';

import { useConfirm } from "@/components/ConfirmDialog";
import { fetchOk } from "@/lib/readJsonOrThrow";
// ─────────── Types ───────────

interface Cron {
  id: string;
  display_name: string;
  description?: string;
  schedule_type: string;
  cron_expression?: string;
  cron_humanized?: string;
  script_full_path?: string;
  script_file_name?: string;
  execute_command?: string;
  working_directory?: string;
  enabled: boolean;
  last_run_at?: string;
  last_run_status?: string;
  last_run_duration_ms?: number;
  last_run_output?: string;
  next_run_at?: string;
  run_count?: number;
  fail_count?: number;
  category?: string;
  priority?: string;
  tags?: string[];
  execution_spec?: Record<string, any>;
  os_registered_as?: string;
}

interface Run {
  id: string;
  started_at: string;
  finished_at?: string;
  duration_ms?: number;
  status: string;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  pid?: number;
  triggered_by?: string;
  triggered_from?: string;
  metadata?: Record<string, any>;
}

interface RelatedResponse {
  cron_id: string;
  flow_name: string | null;
  related: Array<Pick<Cron, 'id' | 'display_name' | 'category' | 'priority' | 'enabled' | 'cron_humanized' | 'last_run_status' | 'last_run_at' | 'execution_spec'>>;
}

interface Props {
  cronId: string;
  open: boolean;
  onClose: () => void;
  onOpenRelated?: (id: string) => void;
}

// ─────────── Small primitives (BaseItem pattern) ───────────

function StatusDot({ status }: { status?: string }) {
  const cls = (() => {
    switch ((status || '').toLowerCase()) {
      case 'success': return 'bg-emerald-500';
      case 'running': return 'bg-blue-500 animate-pulse';
      case 'failed':
      case 'error': return 'bg-red-500';
      case 'timeout': return 'bg-orange-500';
      case 'cancelled': return 'bg-amber-500';
      default: return 'bg-muted-foreground/40';
    }
  })();
  return <span className={`inline-block size-1.5 rounded-full ${cls}`} />;
}

function PriorityBadge({ priority }: { priority?: string }) {
  const cls = (() => {
    switch ((priority || 'normal').toLowerCase()) {
      case 'critical': return 'bg-red-500/10 text-red-500 border-red-500/30';
      case 'high': return 'bg-orange-500/10 text-orange-600 border-orange-500/30';
      case 'normal': return 'bg-muted text-muted-foreground/70 border-border';
      case 'low': return 'bg-muted/50 text-muted-foreground/50 border-border/50';
      default: return 'bg-muted text-muted-foreground/70 border-border';
    }
  })();
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${cls} tabular-nums uppercase tracking-wide font-medium`}>
      {priority ?? 'normal'}
    </span>
  );
}

function BaseItem({
  icon,
  label,
  summary,
  defaultOpen = false,
  children,
  actions,
}: {
  icon?: React.ReactNode;
  label: string;
  summary?: string;
  defaultOpen?: boolean;
  children?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const hasContent = Boolean(children);
  return (
    <div className="group">
      <button
        type="button"
        onClick={() => hasContent && setOpen((v) => !v)}
        className={`w-full flex items-center gap-2 px-2 py-1.5 text-left rounded ${hasContent ? 'hover:bg-accent/50 cursor-pointer' : 'cursor-default'} text-sm font-medium text-foreground/80`}
      >
        {hasContent ? (
          <ChevronRight className={`size-3 text-muted-foreground/60 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
        ) : <span className="size-3" />}
        {icon}
        <span className="flex-1 truncate">{label}</span>
        {summary && <span className="text-xs text-muted-foreground/50 truncate max-w-[40%]">{summary}</span>}
        {actions}
      </button>
      {open && hasContent && (
        <div className="ml-2 mt-1 pl-6 border-l-2 border-border text-sm text-foreground/80">
          {children}
        </div>
      )}
    </div>
  );
}

function CopyButton({ text, size = 12 }: { text: string; size?: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void copyToClipboard(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground/60 hover:text-foreground"
      aria-label="Copy"
    >
      {copied ? <ShieldCheck size={size} className="text-emerald-500" /> : <CopyIcon size={size} />}
    </button>
  );
}

function KeyValueRow({ label, value, copy }: { label: string; value?: React.ReactNode; copy?: string }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div className="group flex items-start gap-3 py-1 text-[13px]">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground/60 w-32 shrink-0 pt-0.5">{label}</div>
      <div className="flex-1 text-foreground/80 font-mono break-all">{value}</div>
      {copy && <CopyButton text={copy} />}
    </div>
  );
}

// ─────────── Main Drawer ───────────

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtDuration(ms?: number): string {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function CronLogDrawer({ cronId, open, onClose, onOpenRelated }: Props) {
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const bodyRef = useRef<HTMLDivElement>(null);

  const { data: cron, isLoading: cronLoading, refetch: refetchCron } = useQuery({
    queryKey: ['registry', 'crons', cronId],
    queryFn: async () => {
      const r = await fetch(`/api/registry/crons/${cronId}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as Cron;
    },
    enabled: open && !!cronId,
    staleTime: 10_000,
  });

  const { data: runsRes, refetch: refetchRuns } = useQuery({
    queryKey: ['registry', 'crons', cronId, 'runs'],
    queryFn: async () => {
      const r = await fetch(`/api/registry/crons/${cronId}/runs?limit=30`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as { cron_id: string; runs: Run[] };
    },
    enabled: open && !!cronId,
    staleTime: 5_000,
    refetchInterval: 10_000,
  });

  const { data: relatedRes } = useQuery({
    queryKey: ['registry', 'crons', cronId, 'related'],
    queryFn: async () => {
      const r = await fetch(`/api/registry/crons/${cronId}/related`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as RelatedResponse;
    },
    enabled: open && !!cronId,
    staleTime: 30_000,
  });

  const runNow = useCallback(async () => {
    if (!cron) return;
    if (!(await confirm({ title: `Chạy cron "${cron.display_name}" NGAY bây giờ?`, confirmLabel: "Chạy ngay" }))) return;
    pushToast({ title: `▶️ Triggering ${cron.display_name}…`, tone: 'info' });
    try {
      const r = await fetchOk(`/api/registry/crons/${cron.id}/execute`, { method: 'POST' }, 'Lỗi chạy cron');
      const j = await r.json();
      pushToast({
        title: j.status === 'success' ? `✅ ${cron.display_name} done` : `❌ ${cron.display_name} failed`,
        body: (j.output || '').slice(-200),
        tone: j.status === 'success' ? 'success' : 'error',
      });
      qc.invalidateQueries({ queryKey: ['registry', 'crons'] });
      refetchCron(); refetchRuns();
    } catch (e: any) {
      pushToast({ title: 'Run thất bại', body: e.message, tone: 'error' });
    }
  }, [cron, confirm, pushToast, qc, refetchCron, refetchRuns]);

  const toggleEnabled = useCallback(async () => {
    if (!cron) return;
    const next = !cron.enabled;
    if (!(await confirm({ title: `${next ? 'Bật lại' : 'Tắt'} cron "${cron.display_name}"?`, confirmLabel: next ? 'Bật lại' : 'Tắt' }))) return;
    try {
      const r = await fetch(`/api/registry/crons/${cron.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      if (!r.ok) throw new Error((await r.json()).error || 'Toggle failed');
      pushToast({ title: next ? `✅ Đã bật ${cron.display_name}` : `⏸ Đã tắt ${cron.display_name}`, tone: 'success' });
      qc.invalidateQueries({ queryKey: ['registry', 'crons'] });
      refetchCron();
    } catch (e: any) {
      pushToast({ title: 'Toggle thất bại', body: e.message, tone: 'error' });
    }
  }, [cron, confirm, pushToast, qc, refetchCron]);

  // Close on Esc
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);

  const runs = runsRes?.runs ?? [];
  const related = relatedRes?.related ?? [];

  const flowInfo = useMemo(() => {
    if (!cron?.execution_spec) return null;
    const step = cron.execution_spec.flow_step;
    const total = cron.execution_spec.flow_of;
    const name = cron.execution_spec.flow_name;
    if (!step && !name) return null;
    return { step, total, name };
  }, [cron]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-background border border-border rounded-2xl shadow-2xl w-full max-w-5xl h-[88vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-border flex items-start gap-3">
          <div className="size-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Activity className="size-4 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <StatusDot status={cron?.last_run_status} />
              <h2 className="text-base font-semibold text-foreground truncate">
                {cron?.display_name ?? cronId}
              </h2>
              {cron?.priority && <PriorityBadge priority={cron.priority} />}
              {cron?.category && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground/70 border border-border">
                  {cron.category}
                </span>
              )}
              {flowInfo && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500 border border-blue-500/30">
                  Step {flowInfo.step}/{flowInfo.total} · {flowInfo.name}
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground/60 mt-0.5 font-mono">
              {cron?.id} · {cron?.schedule_type} · {cron?.cron_humanized ?? cron?.cron_expression ?? '—'}
            </div>
            {cron?.description && (
              <div className="text-sm text-foreground/80 mt-1.5 leading-snug">{cron.description}</div>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={runNow}
              className="text-xs px-2.5 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-1.5"
              title="Chạy cron ngay (manual trigger)"
            >
              <Play className="size-3" /> Chạy ngay
            </button>
            <button
              type="button"
              onClick={toggleEnabled}
              className={`text-xs px-2.5 py-1.5 rounded-md border flex items-center gap-1.5 ${cron?.enabled ? 'border-border text-muted-foreground/70 hover:bg-muted' : 'border-emerald-500/30 text-emerald-600 hover:bg-emerald-500/10'}`}
            >
              {cron?.enabled ? <><PowerOff className="size-3" /> Tắt</> : <><Power className="size-3" /> Bật</>}
            </button>
            <button
              type="button"
              onClick={() => { refetchCron(); refetchRuns(); }}
              className="size-7 rounded-md flex items-center justify-center text-muted-foreground/60 hover:text-foreground hover:bg-muted"
              title="Refresh"
            >
              <RefreshCw className="size-3" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="size-7 rounded-md flex items-center justify-center text-muted-foreground/60 hover:text-foreground hover:bg-muted"
              aria-label="Close"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div ref={bodyRef} className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {cronLoading && (
            <div className="flex items-center justify-center py-20 text-muted-foreground">
              <Loader2 className="size-4 animate-spin mr-2" /> Đang tải…
            </div>
          )}

          {!cronLoading && cron && (
            <>
              {/* Identity card */}
              <section className="bg-card border border-border rounded-lg p-3 space-y-1">
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground/60 mb-1 flex items-center gap-1.5">
                  <Hash className="size-3" /> Identity
                </div>
                <KeyValueRow label="Cron ID" value={cron.id} copy={cron.id} />
                <KeyValueRow label="OS Name" value={cron.os_registered_as} copy={cron.os_registered_as} />
                <KeyValueRow label="Schedule Type" value={cron.schedule_type} />
                <KeyValueRow label="Schedule" value={cron.cron_humanized || cron.cron_expression} />
                <KeyValueRow label="Next Run" value={fmtDate(cron.next_run_at)} />
                <KeyValueRow
                  label="Script Path"
                  value={cron.script_full_path || cron.script_file_name}
                  copy={cron.script_full_path}
                />
                <KeyValueRow label="Working Dir" value={cron.working_directory} copy={cron.working_directory} />
                <KeyValueRow label="Command" value={cron.execute_command} copy={cron.execute_command} />
                {cron.tags && cron.tags.length > 0 && (
                  <KeyValueRow
                    label="Tags"
                    value={
                      <div className="flex flex-wrap gap-1">
                        {cron.tags.map((t) => (
                          <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground/70 border border-border">
                            <Tag className="size-2.5 inline mr-0.5" />{t}
                          </span>
                        ))}
                      </div>
                    }
                  />
                )}
                <KeyValueRow
                  label="Run Count"
                  value={`${cron.run_count ?? 0} total · ${cron.fail_count ?? 0} failed`}
                />
              </section>

              {/* Flow / Related crons */}
              {related.length > 0 && (
                <section className="bg-card border border-border rounded-lg p-3 space-y-1">
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground/60 mb-2 flex items-center gap-1.5">
                    <LinkIcon className="size-3" />
                    Flow{relatedRes?.flow_name ? `: ${relatedRes.flow_name}` : ''} · {related.length} related
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {[cron, ...related].sort((a: any, b: any) =>
                      (a.execution_spec?.flow_step ?? 999) - (b.execution_spec?.flow_step ?? 999)
                    ).map((c: any, i: number, arr: any[]) => {
                      const isSelf = c.id === cron.id;
                      return (
                        <>
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => !isSelf && onOpenRelated?.(c.id)}
                            className={`text-xs px-2 py-1 rounded border flex items-center gap-1.5 ${isSelf ? 'bg-primary/10 border-primary/40 text-primary font-medium' : 'border-border hover:bg-muted text-foreground/80'}`}
                            disabled={isSelf}
                          >
                            <StatusDot status={c.last_run_status} />
                            {c.execution_spec?.flow_step && (
                              <span className="text-[10px] font-mono text-muted-foreground/60">#{c.execution_spec.flow_step}</span>
                            )}
                            <span>{c.display_name}</span>
                          </button>
                          {i < arr.length - 1 && <ChevronRight className="size-3 text-muted-foreground/40" />}
                        </>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* Execution Spec */}
              {cron.execution_spec && Object.keys(cron.execution_spec).length > 0 && (
                <section className="bg-card border border-border rounded-lg p-3">
                  <BaseItem
                    icon={<FileCode className="size-3.5 text-muted-foreground/60" />}
                    label="Execution Spec"
                    summary={`${Object.keys(cron.execution_spec).length} fields`}
                    defaultOpen={false}
                  >
                    <pre className="text-[12px] font-mono text-foreground/80 bg-muted p-2 rounded mt-1 overflow-auto max-h-96 whitespace-pre-wrap break-all">
                      {JSON.stringify(cron.execution_spec, null, 2)}
                    </pre>
                  </BaseItem>
                </section>
              )}

              {/* Last Run prominent */}
              {cron.last_run_output && (
                <section className="bg-accent/20 border border-accent/40 rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Terminal className="size-3.5 text-foreground/70" />
                    <div className="text-sm font-semibold text-foreground">Last Run Output</div>
                    <span className="text-[11px] text-muted-foreground/60">{fmtDate(cron.last_run_at)} · {fmtDuration(cron.last_run_duration_ms)}</span>
                    <StatusDot status={cron.last_run_status} />
                    <CopyButton text={cron.last_run_output} />
                  </div>
                  <pre className="text-[12px] font-mono text-foreground/80 bg-muted p-2 rounded max-h-[32rem] overflow-auto whitespace-pre-wrap break-all">
                    {cron.last_run_output}
                  </pre>
                </section>
              )}

              {/* History timeline */}
              <section className="bg-card border border-border rounded-lg p-3">
                <div className="flex items-center gap-2 mb-2">
                  <Clock className="size-3.5 text-muted-foreground/60" />
                  <div className="text-sm font-semibold text-foreground">History · {runs.length} runs</div>
                  {runs.length > 0 && (
                    <span className="text-[11px] text-muted-foreground/60">
                      first: {fmtDate(runs[runs.length - 1]?.started_at)} · last: {fmtDate(runs[0]?.started_at)}
                    </span>
                  )}
                </div>
                {runs.length === 0 ? (
                  <div className="text-xs text-muted-foreground/60 italic px-2 py-3">Chưa có lịch sử run nào.</div>
                ) : (
                  <div className="space-y-0.5">
                    {runs.map((run) => {
                      const label = `${fmtDate(run.started_at)} · ${fmtDuration(run.duration_ms)} · ${run.status}`;
                      const hasDetail = Boolean(run.stdout || run.stderr);
                      return (
                        <BaseItem
                          key={run.id}
                          icon={<StatusDot status={run.status} />}
                          label={label}
                          summary={run.triggered_by ? `by ${run.triggered_by}` : undefined}
                          defaultOpen={false}
                        >
                          {hasDetail ? (
                            <>
                              {run.stdout && (
                                <div className="mt-2">
                                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground/60 flex items-center gap-1 mb-1">
                                    stdout <CopyButton text={run.stdout} />
                                  </div>
                                  <pre className="text-[12px] font-mono text-foreground/80 bg-muted p-2 rounded max-h-64 overflow-auto whitespace-pre-wrap break-all">
                                    {run.stdout}
                                  </pre>
                                </div>
                              )}
                              {run.stderr && (
                                <div className="mt-2">
                                  <div className="text-[11px] uppercase tracking-wider text-red-500 flex items-center gap-1 mb-1">
                                    stderr <CopyButton text={run.stderr} />
                                  </div>
                                  <pre className="text-[12px] font-mono text-red-500/80 bg-red-500/5 p-2 rounded max-h-64 overflow-auto whitespace-pre-wrap break-all">
                                    {run.stderr}
                                  </pre>
                                </div>
                              )}
                            </>
                          ) : (
                            <div className="text-xs text-muted-foreground/50 italic py-2">No output captured</div>
                          )}
                        </BaseItem>
                      );
                    })}
                  </div>
                )}
              </section>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-2 border-t border-border text-[11px] text-muted-foreground/60 flex items-center justify-between">
          <span><AlertCircle className="size-3 inline mr-1" /> Auto-refresh 10s · runs snapshot từ cron_registry_runs</span>
          <span>{runs.length > 0 && `next run: ${fmtDate(cron?.next_run_at)}`}</span>
        </div>
      </div>
    </div>
  );
}
