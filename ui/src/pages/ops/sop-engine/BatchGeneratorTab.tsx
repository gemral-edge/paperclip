// Batch Jobs View — cc_generation_jobs queue viewer + trigger.
//
// Originally a standalone tab inside SOP Engine; now also embedded inside
// Content Pipeline → Nội Dung tab as a "Jobs queue" view mode. Rows are
// expandable: click to reveal full error_message, input_params, timestamps,
// progress — the user explicitly rejected the hardcoded read-only layout and
// requested click-to-expand everywhere.
//
// Features:
//   • Stats pills by status (pending/claimed/processing/completed/failed)
//   • Job list with filters (status, job_type, track, pillar)
//   • Retry button for failed jobs
//   • "Run batch now" button → spawns batch_processor.py via SSE stream
//   • Live stdout/stderr in a terminal-style pane
//   • Auto-refresh every 10s
//
// Reuses existing Registry dropdowns for filters.

import React, { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useToast } from '@/context/ToastContext';
import { useLiveInvalidate } from '@/hooks/useLiveInvalidate';
import {
  Play,
  RefreshCw,
  Terminal,
  AlertCircle,
  CheckCircle,
  Clock,
  Loader2,
  Filter,
  Zap,
  ChevronDown,
  ChevronRight,
  ExternalLink,
} from 'lucide-react';
import { useNavigate } from '@/lib/router';
import { fetchOk } from "@/lib/readJsonOrThrow";

interface BatchJob {
  id: string;
  job_type: string;
  status: 'pending' | 'claimed' | 'processing' | 'completed' | 'failed';
  priority: string;
  content_type: string | null;
  track: string | null;
  pillar: string | null;
  persona: string | null;
  model_used: string | null;
  retry_count: number;
  max_retries: number;
  progress: number;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  generation_time_ms?: number | null;
  created_at: string;
  updated_at: string;
  input_params?: any;
  output_script_id?: string | null;
}

interface BatchStats {
  pending: number;
  claimed: number;
  processing: number;
  completed: number;
  failed: number;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: any }> = {
  pending: { label: 'Pending', color: 'bg-slate-500/20 text-slate-400 border-slate-500/40', icon: Clock },
  claimed: { label: 'Claimed', color: 'bg-blue-500/20 text-blue-700 dark:text-blue-400 border-blue-500/40', icon: Loader2 },
  processing: { label: 'Processing', color: 'bg-amber-500/20 text-amber-700 dark:text-amber-400 border-amber-500/40', icon: Loader2 },
  completed: { label: 'Completed', color: 'bg-green-500/20 text-green-700 dark:text-green-400 border-green-500/40', icon: CheckCircle },
  failed: { label: 'Failed', color: 'bg-red-500/20 text-red-700 dark:text-red-400 border-red-500/40', icon: AlertCircle },
};

function Tip({ children, text }: { children: React.ReactNode; text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="max-w-xs">{text}</TooltipContent>
    </Tooltip>
  );
}

async function fetchBatchJobs(filter: { status?: string; track?: string; pillar?: string }): Promise<BatchJob[]> {
  const params = new URLSearchParams();
  if (filter.status && filter.status !== 'all') params.set('status', filter.status);
  if (filter.track) params.set('track', filter.track);
  if (filter.pillar) params.set('pillar', filter.pillar);
  const q = params.toString();
  const res = await fetch(`/api/ops/sop-engine/batch-jobs${q ? `?${q}` : ''}`);
  if (!res.ok) return [];
  return res.json();
}

async function fetchBatchStats(): Promise<BatchStats> {
  const res = await fetch('/api/ops/sop-engine/batch-jobs/stats');
  if (!res.ok) return { pending: 0, claimed: 0, processing: 0, completed: 0, failed: 0 };
  return res.json();
}

async function retryJob(id: string): Promise<void> {
  const res = await fetch(`/api/ops/sop-engine/batch-jobs/${id}/retry`, { method: 'POST' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Retry failed');
  }
}

export default function BatchGeneratorTab() {
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [isBatchOpen, setIsBatchOpen] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const jobsQuery = useQuery({
    queryKey: ['batch-jobs', statusFilter],
    queryFn: () => fetchBatchJobs({ status: statusFilter }),
    refetchInterval: 10_000,
  });

  const statsQuery = useQuery({
    queryKey: ['batch-jobs', 'stats'],
    queryFn: fetchBatchStats,
    refetchInterval: 10_000,
  });

  // Live: auto-refresh when cc_generation_jobs changes
  useLiveInvalidate({
    table: 'cc_generation_jobs',
    queryKeys: [['batch-jobs'], ['batch-jobs', 'stats']],
  });

  const retryMutation = useMutation({
    mutationFn: retryJob,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['batch-jobs'] });
      pushToast({ title: '🔁 Job đã được retry', tone: 'success' });
    },
    onError: (err: Error) => pushToast({ title: 'Retry thất bại', body: err.message, tone: 'error' }),
  });

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [log]);

  const handleTriggerBatch = async (mode: 'batch' | 'one-shot') => {
    if (running) return;
    setRunning(true);
    setLog((l) => [...l, `─── START (${mode}) · ${new Date().toISOString()} ───`]);
    pushToast({ title: `⚡ Starting batch (${mode})`, tone: 'info' });

    try {
      const res = await fetchOk('/api/ops/sop-engine/batch-jobs/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      }, 'Lỗi trigger batch');

      if (!res.body) {
        setLog((l) => [...l, '[error] Không có response body']);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events (event: X\ndata: Y\n\n)
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';
        for (const event of events) {
          const lines = event.split('\n');
          let eventName = 'message';
          let dataStr = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) eventName = line.slice(7);
            if (line.startsWith('data: ')) dataStr = line.slice(6);
          }
          if (!dataStr) continue;
          try {
            const data = JSON.parse(dataStr);
            if (eventName === 'batch:stdout') {
              setLog((l) => [...l, data.text?.trimEnd()]);
            } else if (eventName === 'batch:stderr') {
              setLog((l) => [...l, `[stderr] ${data.text?.trimEnd()}`]);
            } else if (eventName === 'batch:done') {
              setLog((l) => [...l, `─── DONE · exit code ${data.exit_code} ───`]);
              pushToast({
                title: data.exit_code === 0 ? '✅ Batch completed' : '❌ Batch failed',
                body: `Exit code ${data.exit_code}`,
                tone: data.exit_code === 0 ? 'success' : 'error',
              });
            } else if (eventName === 'batch:error') {
              setLog((l) => [...l, `[error] ${data.error}`]);
            } else if (eventName === 'batch:start') {
              setLog((l) => [...l, `[start] script=${data.script}`]);
            }
          } catch {
            setLog((l) => [...l, `[raw] ${dataStr}`]);
          }
        }
      }
    } catch (err: any) {
      setLog((l) => [...l, `[exception] ${err.message}`]);
      pushToast({ title: 'Trigger failed', body: err.message, tone: 'error' });
    } finally {
      setRunning(false);
      qc.invalidateQueries({ queryKey: ['batch-jobs'] });
    }
  };

  const jobs = jobsQuery.data || [];
  const stats = statsQuery.data || { pending: 0, claimed: 0, processing: 0, completed: 0, failed: 0 };

  return (
    <TooltipProvider delayDuration={300}>
      <div className="p-4 space-y-4">
        {/* Header + trigger */}
        <div className="bg-card border border-border rounded-xl p-4">
          <div 
            className="flex items-center justify-between cursor-pointer hover:opacity-80"
            onClick={() => setIsBatchOpen(!isBatchOpen)}
          >
            <div className="flex items-center gap-2">
              {isBatchOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
              <Zap className="size-4 text-primary" />
              <h2 className="text-base font-semibold text-foreground">Batch Generator</h2>
              <Tip text="Queue viewer cho cc_generation_jobs + trigger batch_processor.py. Tương tác trực tiếp với pipeline gen content của Content Center.">
                <span className="text-[10px] text-muted-foreground cursor-help">ℹ️</span>
              </Tip>
            </div>
            <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
              <Tip text="Chạy batch_processor.py trong 1 lần (one-shot) — xử lý 1 job pending rồi exit.">
                <button
                  onClick={() => handleTriggerBatch('one-shot')}
                  disabled={running}
                  className="px-3 py-1.5 text-xs bg-primary/10 border border-primary text-primary rounded-md hover:bg-primary/20 disabled:opacity-50 flex items-center gap-1.5"
                >
                  <Play className="size-3.5" />
                  One-shot
                </button>
              </Tip>
              <Tip text="Chạy batch_processor.py ở chế độ batch — xử lý nhiều jobs pending cho đến khi hết queue.">
                <button
                  onClick={() => handleTriggerBatch('batch')}
                  disabled={running}
                  className="px-3 py-1.5 text-xs bg-primary hover:bg-primary/90 text-primary-foreground rounded-md disabled:opacity-50 flex items-center gap-1.5"
                >
                  {running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                  {running ? 'Running...' : 'Run Batch'}
                </button>
              </Tip>
            </div>
          </div>

          {/* Stats pills */}
          {isBatchOpen && (
            <div className="flex items-center gap-2 flex-wrap mt-4 pt-4 border-t border-border">
            <Tip text="Tổng jobs theo status — click để filter list bên dưới">
              <button
                onClick={() => setStatusFilter('all')}
                className={`px-2.5 py-1 text-xs rounded border ${statusFilter === 'all' ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-foreground'}`}
              >
                Tất cả ({Object.values(stats).reduce((a, b) => a + b, 0)})
              </button>
            </Tip>
            {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
              <Tip key={key} text={`${cfg.label}: ${stats[key as keyof BatchStats]} jobs`}>
                <button
                  onClick={() => setStatusFilter(key)}
                  className={`px-2.5 py-1 text-xs rounded border ${statusFilter === key ? cfg.color : 'border-border text-muted-foreground hover:border-foreground'}`}
                >
                  {cfg.label}: {stats[key as keyof BatchStats]}
                </button>
              </Tip>
            ))}
            <div className="ml-auto">
              <Tip text="Refresh manual — list tự động refresh mỗi 10 giây">
                <button
                  onClick={() => {
                    qc.invalidateQueries({ queryKey: ['batch-jobs'] });
                  }}
                  className="p-1.5 text-muted-foreground hover:text-foreground"
                >
                  <RefreshCw className="size-3.5" />
                </button>
              </Tip>
              </div>
            </div>
          )}
        </div>

        {isBatchOpen && (
          <>
            {/* Live log (terminal-style) — moved to TOP per Jennie request 2026-04-10
            so output is immediately visible after clicking Run Batch / One-shot,
            no need to scroll down past Jobs table. */}
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="border-b border-border px-3 py-2 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
            <Terminal className="size-3" />
            Live Log
            {running && <Loader2 className="size-3 animate-spin text-primary" />}
            <button
              onClick={() => setLog([])}
              className="ml-auto text-[10px] text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          </div>
          <div
              ref={logRef}
              className="font-mono text-[10px] leading-snug p-3 h-64 overflow-y-auto bg-background/50 text-foreground"
            >
              {log.length === 0 ? (
                <div className="text-muted-foreground italic">Chưa có output. Bấm "Run Batch" hoặc "One-shot" để bắt đầu.</div>
              ) : (
                log.map((line, i) => (
                  <div key={i} className={line.startsWith('[error]') || line.startsWith('[stderr]') ? 'text-destructive' : line.startsWith('───') ? 'text-primary font-semibold' : ''}>
                    {line}
                  </div>
                ))
              )}
            </div>
        </div>

        {/* Jobs table */}
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="border-b border-border px-3 py-2 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
            <Filter className="size-3" />
            Jobs ({jobs.length})
            {jobsQuery.isLoading && <Loader2 className="size-3 animate-spin" />}
          </div>
          {jobs.length === 0 ? (
            <div className="p-8 text-center text-xs text-muted-foreground">
              Không có job nào với filter hiện tại.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="w-6"></th>
                    <th className="text-left px-3 py-2 font-semibold">Status</th>
                    <th className="text-left px-3 py-2 font-semibold">Job Type</th>
                    <th className="text-left px-3 py-2 font-semibold">Track · Pillar</th>
                    <th className="text-left px-3 py-2 font-semibold">Model</th>
                    <th className="text-left px-3 py-2 font-semibold">Retry</th>
                    <th className="text-left px-3 py-2 font-semibold">Created</th>
                    <th className="text-right px-3 py-2 font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => {
                    const cfg = STATUS_CONFIG[j.status] || STATUS_CONFIG.pending;
                    const Icon = cfg.icon;
                    const isExpanded = expandedJobId === j.id;
                    return (
                      <React.Fragment key={j.id}>
                      <tr
                        onClick={() => setExpandedJobId(isExpanded ? null : j.id)}
                        className="border-t border-border hover:bg-accent/30 transition-colors cursor-pointer"
                      >
                        <td className="px-2 text-muted-foreground">
                          {isExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold border ${cfg.color}`}>
                            <Icon className={`size-3 ${j.status === 'claimed' || j.status === 'processing' ? 'animate-spin' : ''}`} />
                            {cfg.label}
                          </span>
                        </td>
                        <td className="px-3 py-2 font-mono text-[11px] text-foreground">{j.job_type}</td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {j.track || '—'} · {j.pillar || '—'}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground font-mono text-[10px]">{j.model_used || '—'}</td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {j.retry_count}/{j.max_retries}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {new Date(j.created_at).toLocaleString('vi-VN')}
                        </td>
                        <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                          {j.status === 'failed' && (
                            <Tip text="Retry job — set status=pending, clear error, reset retry_count">
                              <button
                                onClick={() => retryMutation.mutate(j.id)}
                                className="px-2 py-0.5 text-[10px] border border-primary text-primary rounded hover:bg-primary/10"
                              >
                                🔁 Retry
                              </button>
                            </Tip>
                          )}
                          {j.output_script_id && (
                            <Tip text="Mở script đã tạo">
                              <button
                                onClick={() => navigate(`/GEM/cc/scripts/${j.output_script_id}`)}
                                className="ml-1 p-1 hover:bg-primary/10 rounded"
                              >
                                <ExternalLink className="size-3 text-primary" />
                              </button>
                            </Tip>
                          )}
                          {j.error_message && (
                            <Tip text={j.error_message}>
                              <AlertCircle className="inline size-3 text-destructive ml-1" />
                            </Tip>
                          )}
                        </td>
                      </tr>
                      {isExpanded && (() => {
                        const ip = typeof j.input_params === 'string' ? JSON.parse(j.input_params || '{}') : (j.input_params || {});
                        const sopId = ip.sop_id || ip.linked_sop_id || '';
                        const prompt = ip.userPrompt || '';
                        const dayOffset = ip.dayOffset;
                        const emailLabel = ip.emailLabel || '';
                        const brandVoice = ip.brandVoice || '';
                        const provider = ip.provider || 'claude';
                        const hasSysPrompt = !!ip.systemPrompt;
                        const outputFormat = ip.output_format || (j.job_type === 'email' || j.content_type === 'email' ? 'html' : 'markdown');
                        const seriesId = ip.seriesId || '';
                        const courseType = ip.courseType || '';
                        const genTimeMs = j.generation_time_ms;
                        const modelUsed = j.model_used || '';
                        return (
                        <tr className="bg-muted/20 border-t border-border">
                          <td colSpan={8} className="px-4 py-3">
                            <div className="grid grid-cols-3 gap-4 text-[11px]">
                              {/* Col 1: Job metadata */}
                              <div className="space-y-1">
                                <div className="font-semibold text-foreground">Job metadata</div>
                                <div className="text-muted-foreground font-mono text-[10px]">ID: {j.id}</div>
                                <div className="text-muted-foreground">Content type: <span className="text-foreground font-medium">{j.content_type || '—'}</span></div>
                                <div className="text-muted-foreground">Persona: <span className="text-foreground">{j.persona || '—'}</span></div>
                                <div className="text-muted-foreground">Priority: <span className="text-foreground">{j.priority}</span></div>
                                <div className="text-muted-foreground">Progress: <span className="text-foreground">{j.progress}%</span></div>
                                {modelUsed && <div className="text-muted-foreground">Model: <span className="text-foreground font-mono">{modelUsed}</span></div>}
                                {genTimeMs != null && <div className="text-muted-foreground">Gen time: <span className="text-foreground">{(genTimeMs / 1000).toFixed(1)}s</span></div>}
                              </div>

                              {/* Col 2: SOP + Knowledge context */}
                              <div className="space-y-1">
                                <div className="font-semibold text-foreground">SOP + Knowledge context</div>
                                {sopId && <div className="text-muted-foreground">SOP ID: <span className="text-primary font-mono font-medium">{sopId}</span></div>}
                                {emailLabel && <div className="text-muted-foreground">Email: <span className="text-foreground font-medium">{emailLabel}</span></div>}
                                {dayOffset != null && <div className="text-muted-foreground">Day offset: <span className="text-foreground font-medium">Day {dayOffset}</span></div>}
                                {courseType && <div className="text-muted-foreground">Course: <span className="text-foreground">{courseType}</span></div>}
                                {seriesId && <div className="text-muted-foreground font-mono text-[9px]">Series: {seriesId}</div>}
                                <div className="text-muted-foreground">Brand voice: <span className={`font-medium ${brandVoice === 'jennie' ? 'text-pink-500' : 'text-violet-500'}`}>{brandVoice || '—'}</span></div>
                                <div className="text-muted-foreground">Provider: <span className="text-foreground">{provider}</span></div>
                                <div className="text-muted-foreground">Output format: <span className="text-foreground">{outputFormat}</span></div>
                                <div className="text-muted-foreground">System prompt: <span className={hasSysPrompt ? 'text-green-500' : 'text-amber-500'}>{hasSysPrompt ? '✅ Có (Brand Design System)' : '⚠️ Thiếu (dùng default)'}</span></div>
                              </div>

                              {/* Col 3: Timestamps */}
                              <div className="space-y-1">
                                <div className="font-semibold text-foreground">Timestamps</div>
                                <div className="text-muted-foreground">Created: <span className="text-foreground">{new Date(j.created_at).toLocaleString('vi-VN')}</span></div>
                                <div className="text-muted-foreground">Started: <span className="text-foreground">{j.started_at ? new Date(j.started_at).toLocaleString('vi-VN') : '—'}</span></div>
                                <div className="text-muted-foreground">Completed: <span className="text-foreground">{j.completed_at ? new Date(j.completed_at).toLocaleString('vi-VN') : '—'}</span></div>
                                <div className="text-muted-foreground">Updated: <span className="text-foreground">{new Date(j.updated_at).toLocaleString('vi-VN')}</span></div>
                              </div>

                              {/* Prompt preview */}
                              {prompt && (
                                <div className="col-span-3 space-y-1">
                                  <div className="font-semibold text-foreground">User Prompt</div>
                                  <div className="bg-background border border-border rounded p-2 text-[10px] text-foreground line-clamp-3">{prompt.slice(0, 500)}{prompt.length > 500 ? '...' : ''}</div>
                                </div>
                              )}

                              {/* Error message */}
                              {j.error_message && (
                                <div className="col-span-3 space-y-1">
                                  <div className="font-semibold text-destructive">Error message</div>
                                  <pre className="bg-destructive/10 border border-destructive/30 rounded p-2 text-[10px] whitespace-pre-wrap font-mono text-destructive">{j.error_message}</pre>
                                </div>
                              )}

                              {/* Raw input_params (collapsed) */}
                              <details className="col-span-3">
                                <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground">
                                  Xem raw input_params JSON...
                                </summary>
                                <pre className="bg-background border border-border rounded p-2 text-[9px] whitespace-pre-wrap font-mono text-foreground max-h-40 overflow-y-auto mt-1">{typeof j.input_params === 'string' ? j.input_params : JSON.stringify(j.input_params, null, 2)}</pre>
                              </details>
                            </div>
                          </td>
                        </tr>
                        );
                      })()}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
          </>
        )}

      </div>
    </TooltipProvider>
  );
}
