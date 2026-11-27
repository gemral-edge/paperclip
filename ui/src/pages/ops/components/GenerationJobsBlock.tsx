import React, { useState, useCallback } from "react";
import { useUIOrder } from "@/hooks/useUIOrder";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { Loader2, CheckCircle, Circle, AlertCircle, ChevronDown, Copy, Trash2, RefreshCw, ExternalLink, Plus, Pause, Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/context/ToastContext";
import { copyToClipboard } from "@/lib/clipboard";
import { fetchOk } from "@/lib/readJsonOrThrow";
import { useGuardedAction } from "@/lib/useGuardedAction";

const DEFAULT_GROUP_ORDER = [
  "Hoàn thành",
  "Bị kẹt (>10 phút)",
  "Đang xử lý",
  "Chờ xử lý",
  "Thất bại",
  "Đã hủy",
];

export function GenerationJobsBlock() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const guard = useGuardedAction();

  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set(["Hoàn thành", "Thất bại", "Đã hủy"]));
  
  const [groupOrder, setGroupOrder] = useUIOrder<string>('genJobs.groupOrder.v1', DEFAULT_GROUP_ORDER);
  const [dragGroup, setDragGroup] = useState<string | null>(null);
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);

  const { data: jobsSummary } = useQuery({ queryKey: ["ops", "jobs-summary"], queryFn: async () => (await fetch("/api/ops/content-pipeline/jobs-summary")).json(), staleTime: 10_000 });
  const { data: recentJobs, isLoading: jobsLoading, isFetching: jobsFetching } = useQuery({ queryKey: ["ops", "jobs"], queryFn: async () => { const r = await fetch("/api/ops/content-pipeline/jobs"); const d = await r.json(); return d.jobs || []; }, staleTime: 5_000, refetchInterval: 15_000 });
  const { data: agents } = useQuery({ queryKey: ["ops", "pipeline-agents"], queryFn: async () => { const r = await fetch("/api/ops/content-pipeline/agents"); const d = await r.json(); return d.agents || []; }, staleTime: 60_000 });

  const handleDelegate = useCallback(async (agentSlug: string, task: string) => {
    pushToast({ title: `Đang giao việc cho ${agentSlug}...`, tone: "info" });
    try {
      await fetchOk("/api/ops/content-pipeline/delegate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent_slug: agentSlug, task }) }, "Lỗi giao việc");
      pushToast({ title: `Đã giao việc cho ${agentSlug}`, tone: "success" });
    } catch (e: any) { pushToast({ title: e?.message || "Lỗi kết nối", tone: "error" }); }
  }, [pushToast]);

  const reorderGroup = useCallback((src: string, dst: string) => {
    if (src === dst) return;
    const next = groupOrder.slice();
    const si = next.indexOf(src);
    const di = next.indexOf(dst);
    if (si === -1 || di === -1) return;
    next.splice(si, 1);
    next.splice(di, 0, src);
    setGroupOrder(next); // useUIOrder tự save
  }, [groupOrder, setGroupOrder]);

  const now = Date.now();
  const TEN_MIN = 10 * 60 * 1000;
  const jobs: any[] = recentJobs || [];

  const stuck = jobs.filter(j => (j.status === 'queued' || j.status === 'processing') && (now - new Date(j.created_at).getTime()) > TEN_MIN);
  const stuckIds = new Set(stuck.map((j: any) => j.id));
  const processing = jobs.filter(j => j.status === 'processing' && !stuckIds.has(j.id));
  const queued = jobs.filter(j => j.status === 'queued' && !stuckIds.has(j.id));
  const failed = jobs.filter(j => j.status === 'failed');
  const completed = jobs.filter(j => j.status === 'completed');
  const cancelled = jobs.filter(j => j.status === 'cancelled');

  const cancelJob = async (id: string) => {
    await guard(async () => {
      await fetchOk(`/api/ops/content-pipeline/jobs/${id}/cancel`, { method: "POST" }, "Lỗi hủy job");
      qc.invalidateQueries({ queryKey: ["ops", "jobs"] });
      qc.invalidateQueries({ queryKey: ["ops", "jobs-summary"] });
    }, "Không hủy được job");
  };

  const cancelAll = async (ids: string[]) => {
    await guard(async () => {
      await Promise.all(ids.map(id => fetchOk(`/api/ops/content-pipeline/jobs/${id}/cancel`, { method: "POST" }, "Lỗi hủy job")));
      qc.invalidateQueries({ queryKey: ["ops", "jobs"] });
      qc.invalidateQueries({ queryKey: ["ops", "jobs-summary"] });
      pushToast({ title: `Đã hủy ${ids.length} job`, tone: "success" });
    }, "Không hủy được hết job");
  };

  const getModel = (j: any) => {
    const provider = j._provider || (() => { try { const p = typeof j.input_params === 'string' ? JSON.parse(j.input_params) : (j.input_params || {}); return p.provider || ''; } catch { return ''; } })();
    const model = j._model || j.model_used || (() => { try { const p = typeof j.input_params === 'string' ? JSON.parse(j.input_params) : (j.input_params || {}); return p.model || ''; } catch { return ''; } })();
    if (!provider && !model) return null;
    const shortModel = (model || '—').replace('claude-', '').replace('gemini-', '').replace('-latest', '').replace('-preview', '').replace('sonnet-4-6', 'sonnet-4.6').replace('sonnet-4-5', 'sonnet-4.5').replace('haiku-4-5', 'haiku-4.5');
    return `${provider || '?'}/${shortModel}`;
  };

  const formatDt = (d: string) => {
    const dt = new Date(d);
    return dt.toLocaleString('vi', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  type GroupConfig = { label: string; color: string; dot: string; jobs: any[]; canCancel: boolean; showAge?: boolean };
  
  const allGroups: Record<string, GroupConfig> = {
    "Bị kẹt (>10 phút)": { label: "Bị kẹt (>10 phút)", color: "border-red-500/30 bg-red-500/5", dot: "bg-red-500", jobs: stuck, canCancel: true, showAge: true },
    "Đang xử lý": { label: "Đang xử lý", color: "border-blue-500/30 bg-blue-500/5", dot: "bg-blue-500 animate-pulse", jobs: processing, canCancel: true },
    "Chờ xử lý": { label: "Chờ xử lý", color: "border-yellow-500/30 bg-yellow-500/5", dot: "bg-yellow-500", jobs: queued, canCancel: true },
    "Thất bại": { label: "Thất bại", color: "border-red-400/20 bg-red-400/5", dot: "bg-red-400", jobs: failed, canCancel: false },
    "Hoàn thành": { label: "Hoàn thành", color: "border-green-500/20 bg-green-500/5", dot: "bg-green-500", jobs: completed, canCancel: false },
    "Đã hủy": { label: "Đã hủy", color: "border-muted/40 bg-muted/20", dot: "bg-muted-foreground/40", jobs: cancelled, canCancel: false },
  };

  const sortedGroups = groupOrder.map(k => allGroups[k]).filter(Boolean);

  return (
    <Card className="p-4" id="generation-jobs">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">Generation Jobs</h3>
        <div className="flex items-center gap-2">
          {jobsSummary && <span className="text-xs text-muted-foreground">{jobsSummary.queued || 0} chờ · {jobsSummary.processing || 0} đang chạy · {jobsSummary.completed || 0} xong · {jobsSummary.failed || 0} lỗi</span>}
          <Button size="sm" variant="ghost" className={`h-6 w-6 p-0 ${jobsFetching ? "animate-spin" : ""}`} onClick={() => { qc.refetchQueries({ queryKey: ["ops", "jobs"] }); qc.refetchQueries({ queryKey: ["ops", "jobs-summary"] }); }} title="Làm mới"><RefreshCw className="h-3 w-3" /></Button>
        </div>
      </div>

      {jobsLoading ? (
        <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
      ) : jobs.length === 0 ? (
        <p className="text-xs text-muted-foreground">Không có job nào</p>
      ) : (
        <div className="space-y-3">
          {sortedGroups.map(g => g.jobs.length === 0 ? null : (
            <div 
              key={g.label} 
              className={`rounded-lg border transition-all duration-150 ${g.color} ${dragGroup === g.label ? "opacity-40 scale-[0.99]" : ""} ${dragOverGroup === g.label && dragGroup !== g.label ? "ring-2 ring-primary/50" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setDragOverGroup(g.label); }}
              onDragLeave={() => setDragOverGroup(null)}
              onDrop={(e) => {
                e.preventDefault();
                if (dragGroup && dragGroup !== g.label) reorderGroup(dragGroup, g.label);
                setDragGroup(null); setDragOverGroup(null);
              }}
            >
              {/* Group header — clickable to collapse */}
              <div
                className="flex items-center justify-between p-2.5 cursor-pointer select-none group/ghead relative"
                onClick={() => setCollapsedGroups(prev => {
                  const next = new Set(prev);
                  if (next.has(g.label)) next.delete(g.label); else next.add(g.label);
                  return next;
                })}
              >
                <div className="flex items-center gap-2">
                  <span 
                    draggable 
                    onDragStart={(e) => { setDragGroup(g.label); e.dataTransfer.effectAllowed = "move"; e.stopPropagation(); }}
                    onDragEnd={() => { setDragGroup(null); setDragOverGroup(null); }}
                    className="text-muted-foreground/40 hover:text-foreground cursor-grab active:cursor-grabbing px-1"
                    onClick={e => e.stopPropagation()}
                    title="Kéo để di chuyển section này"
                  >
                    ⠿
                  </span>
                  <span className={`w-2 h-2 rounded-full shrink-0 ${g.dot}`} />
                  <span className="text-xs font-semibold">{g.label}</span>
                  <span className="text-[10px] text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded-full">{g.jobs.length}</span>
                </div>
                <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                  {g.canCancel && g.jobs.length > 1 && (
                    <Button size="sm" variant="ghost" className="h-5 text-[10px] text-red-500 hover:text-red-600 hover:bg-red-500/10" onClick={() => cancelAll(g.jobs.map(j => j.id))}>
                      Hủy tất cả {g.jobs.length}
                    </Button>
                  )}
                  <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${collapsedGroups.has(g.label) ? "" : "rotate-180"}`} onClick={() => setCollapsedGroups(prev => {
                  const next = new Set(prev);
                  if (next.has(g.label)) next.delete(g.label); else next.add(g.label);
                  return next;
                })}/>
                </div>
              </div>
              {/* Job rows — hidden when collapsed */}
              {!collapsedGroups.has(g.label) && <div className="space-y-0.5 px-2.5 pb-2.5">
                {g.jobs.map((j: any) => (
                  <div key={j.id}>
                    <div
                      onClick={() => setExpandedJob(expandedJob === j.id ? null : j.id)}
                      className="flex items-center gap-2 p-2 rounded bg-background/60 hover:bg-background cursor-pointer text-xs"
                    >
                      {/* Date/time */}
                      <span className="text-muted-foreground shrink-0 tabular-nums">{formatDt(j.created_at)}</span>
                      <span className="text-muted-foreground">·</span>
                      {/* Content type */}
                      <span className="font-medium shrink-0">{j.content_type || j.job_type || '—'}</span>
                      {/* Pillar */}
                      {j.pillar && <span className="text-[10px] px-1 py-0.5 rounded bg-muted text-muted-foreground shrink-0">{j.pillar}</span>}
                      {/* Model */}
                      {getModel(j) && <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-600 dark:text-violet-400 font-mono shrink-0">{getModel(j)}</span>}
                      {/* Topic preview */}
                      {j.topic && <span className="text-muted-foreground truncate min-w-0 flex-1">"{j.topic}"</span>}
                      {/* Age for stuck */}
                      {g.showAge && <span className="text-[10px] text-red-500 shrink-0">{Math.round((now - new Date(j.created_at).getTime()) / 60000)}m</span>}
                      {/* Failed error snippet */}
                      {j.status === 'failed' && j.error_message && !j.topic && <span className="text-muted-foreground truncate flex-1 min-w-0">{j.error_message.slice(0, 60)}</span>}
                      {/* Spacer */}
                      {!j.topic && <span className="flex-1" />}
                      {/* Cancel button */}
                      {g.canCancel && (
                        <Button size="sm" variant="ghost" className="h-5 text-[10px] px-1.5 text-red-500 hover:text-red-600 hover:bg-red-500/10 shrink-0"
                          onClick={e => { e.stopPropagation(); cancelJob(j.id); }}>Hủy</Button>
                      )}
                      {/* Retry for failed */}
                      {j.status === 'failed' && (
                        <Button size="sm" variant="ghost" className="h-5 text-[10px] px-1.5 shrink-0"
                          onClick={e => { e.stopPropagation(); return guard(async () => { await fetchOk(`/api/ops/content-pipeline/jobs/${j.id}/retry`, { method: "POST" }, "Lỗi retry job"); qc.refetchQueries({ queryKey: ["ops", "jobs"] }); pushToast({ title: "Đã retry", tone: "success" }); }, "Không retry được job"); }}>
                          <RefreshCw className="h-2.5 w-2.5 mr-0.5" /> Thử lại
                        </Button>
                      )}
                      <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform shrink-0 ${expandedJob === j.id ? "rotate-180" : ""}`} />
                    </div>
                    {/* Expanded detail */}
                    {expandedJob === j.id && (() => {
                      const outputText = j.output_content || '';
                      const scriptId = j.script_id || null;
                      const delegateSelectId = `delegate-${j.id}`;
                      return (
                        <div className="mx-1 mb-1 p-3 bg-muted/10 border rounded-lg space-y-2.5 text-xs" onClick={e => e.stopPropagation()}>
                          {/* Job info grid */}
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-muted-foreground">
                            <div>ID: <code className="text-foreground">{j.id?.slice(0, 12)}</code></div>
                            <div>Loại: <span className="text-foreground">{j.content_type || j.job_type || '—'}</span></div>
                            <div>Pillar: <span className="text-foreground">{j.pillar || '—'}</span></div>
                            <div>Voice: <span className="text-foreground">{j.brand_voice || '—'}</span></div>
                            <div>Tạo: <span className="text-foreground">{formatDt(j.created_at)}</span></div>
                            <div>Xong: <span className="text-foreground">{j.completed_at ? formatDt(j.completed_at) : '—'}</span></div>
                            <div>Thời lượng: <span className="text-foreground">{j.completed_at && j.created_at ? (() => { const s = Math.round((new Date(j.completed_at).getTime() - new Date(j.created_at).getTime()) / 1000); return s >= 60 ? `${Math.floor(s/60)} phút ${s%60}s` : `${s}s`; })() : '—'}</span></div>
                            <div>Model: <span className="text-foreground font-mono">{getModel(j) || '—'}</span></div>
                            <div>Nguồn: <span className="text-foreground">{({"batch_processor":"Batch tự động","web_app":"Manual (web)","cron":"Cron tự động","ceo_agent":"CEO Agent"} as Record<string,string>)[j.source||j.processor||'']||j.source||'Manual'}</span></div>
                            {scriptId && <div>Script: <code className="text-foreground">{scriptId.slice(0,8)}</code></div>}
                            {(j.prompt_tokens || j.completion_tokens) && (
                              <div>Tokens: <span className="text-foreground">{j.prompt_tokens?.toLocaleString()||'?'} / {j.completion_tokens?.toLocaleString()||'?'}</span></div>
                            )}
                            {j.prompt_tokens && j.completion_tokens && (
                              <div>Chi phí: <span className="text-foreground">~${((j.prompt_tokens * 0.000003) + (j.completion_tokens * 0.000015)).toFixed(4)}</span></div>
                            )}
                          </div>
                          {/* Topic */}
                          {j.topic && <div className="p-2 bg-background border rounded"><span className="text-muted-foreground">Chủ đề:</span> {j.topic}</div>}
                          {/* Output */}
                          {outputText && (
                            <div className="space-y-1">
                              <div className="flex items-center justify-between">
                                <span className="text-muted-foreground text-[10px]">Output ({outputText.length.toLocaleString()} ký tự):</span>
                                <Button size="sm" variant="ghost" className="h-5 text-[10px]" onClick={() => {
                                  const el = document.getElementById(`job-output-${j.id}`) as HTMLTextAreaElement;
                                  if (el) { el.readOnly = !el.readOnly; if (!el.readOnly) el.focus(); }
                                }}>✏ Sửa</Button>
                              </div>
                              <textarea
                                id={`job-output-${j.id}`}
                                readOnly
                                defaultValue={outputText}
                                className="w-full p-2 bg-background border rounded text-sm max-h-48 min-h-[60px] resize-y font-mono"
                                onBlur={async (e) => {
                                  if (e.target.readOnly) return;
                                  const target = e.target;
                                  await guard(async () => {
                                    await fetchOk(`/api/ops/content-pipeline/jobs/${j.id}/output`, { method: "PUT", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ output_text: target.value }) }, "Lỗi lưu nội dung");
                                    pushToast({ title: "Đã lưu nội dung", tone: "success" });
                                    target.readOnly = true;
                                  }, "Không lưu được nội dung");
                                }}
                              />
                            </div>
                          )}
                          {j.output_error && <div className="p-2 bg-red-500/5 text-red-600 border border-red-200 rounded">⚠️ {j.output_error}</div>}
                          {/* Failed error */}
                          {j.status === 'failed' && j.error_message && (
                            <div className="p-2.5 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg">
                              <div className="flex items-center gap-2 mb-1">
                                <span className="text-xs font-medium text-red-600 dark:text-red-400">Lý do thất bại</span>
                                {j.error_code && <span className="text-[10px] bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300 px-1.5 py-0.5 rounded font-mono">{j.error_code}</span>}
                              </div>
                              <p className="text-xs text-red-700 dark:text-red-300">{j.error_message}</p>
                            </div>
                          )}
                          {/* Input params preview */}
                          {j.input_params && <div className="p-2 bg-background border rounded text-[10px] text-muted-foreground max-h-20 overflow-hidden"><span className="font-medium">Input:</span> {typeof j.input_params === 'string' ? j.input_params.slice(0, 200) : JSON.stringify(j.input_params).slice(0, 200)}</div>}
                          {/* Action buttons */}
                          <div className="flex flex-wrap gap-1.5">
                            {j.status === "completed" && <>
                              <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => { void copyToClipboard(outputText).then((ok) => { pushToast(ok ? { title: "Đã sao chép", tone: "success" } : { title: "Không thể sao chép", body: "Trình duyệt chặn quyền truy cập clipboard.", tone: "error" }); }); }}><Copy className="h-3 w-3 mr-0.5" /> Copy</Button>
                              {scriptId
                                ? <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => navigate(`/GEM/cc/scripts/${scriptId}`)}><ExternalLink className="h-3 w-3 mr-0.5" /> Xem bài viết</Button>
                                : <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => navigate("/ops/content-pipeline?tab=content")}><ExternalLink className="h-3 w-3 mr-0.5" /> Xem nội dung</Button>
                              }
                            </>}
                            {j.status === "failed" && <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => guard(async () => { await fetchOk(`/api/ops/content-pipeline/jobs/${j.id}/retry`, { method: "POST" }, "Lỗi retry job"); qc.refetchQueries({ queryKey: ["ops", "jobs"] }); pushToast({ title: "Đã retry", tone: "success" }); }, "Không retry được job")}><RefreshCw className="h-3 w-3 mr-0.5" /> Thử lại</Button>}
                            {(j.status === "queued" || j.status === "processing") && <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => cancelJob(j.id)}><Circle className="h-3 w-3 mr-0.5" /> Hủy</Button>}
                            <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => guard(async () => {
                              await fetchOk("/api/ops/content-pipeline/jobs", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ content_type: j.content_type, job_type: j.job_type, pillar: j.pillar, topic: j.topic, brand_voice: j.brand_voice, input_params: j.input_params }) }, "Lỗi tạo lại job");
                              qc.refetchQueries({ queryKey: ["ops", "jobs"] }); pushToast({ title: "Đã tạo lại job", tone: "success" });
                            }, "Không tạo lại được job")}><Plus className="h-3 w-3 mr-0.5" /> Tạo lại</Button>
                            <Button size="sm" variant="ghost" className="h-6 text-[10px] text-orange-600" onClick={() => guard(async () => {
                              await fetchOk(`/api/ops/content-pipeline/jobs/${j.id}/cancel`, { method: "POST" }, "Lỗi tắt job");
                              pushToast({ title: `Đã tắt job ${j.content_type || j.job_type}`, tone: "info" });
                              qc.refetchQueries({ queryKey: ["ops", "jobs"] });
                            }, "Không tắt được job")}><Pause className="h-3 w-3 mr-0.5" /> Tắt vĩnh viễn</Button>
                            <Button size="sm" variant="ghost" className="h-6 text-[10px] text-red-500" onClick={() => guard(async () => {
                              await fetchOk(`/api/ops/content-pipeline/jobs/${j.id}`, { method: "DELETE" }, "Lỗi xóa job");
                              qc.refetchQueries({ queryKey: ["ops", "jobs"] });
                              pushToast({ title: "Đã xóa job", tone: "success" });
                            }, "Không xóa được job")}><Trash2 className="h-3 w-3 mr-0.5" /> Xóa</Button>
                            {j.paperclip_issue_id && <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => navigate(`/issues/${j.paperclip_issue_id}`)}><ExternalLink className="h-3 w-3 mr-0.5" /> Xem issue</Button>}
                          </div>
                          {/* Agent delegate */}
                          <div className="flex items-center gap-2 pt-1.5 border-t">
                            <select id={delegateSelectId} defaultValue="ceo" className="text-[10px] border rounded px-1.5 py-1 bg-background">
                              {(agents || []).map((a: any) => <option key={a.slug} value={a.slug}>{a.display_name || a.slug}</option>)}
                            </select>
                            <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => {
                              const sel = document.getElementById(delegateSelectId) as HTMLSelectElement;
                              handleDelegate(sel?.value || 'ceo', `Review job "${j.topic}" (${j.content_type || j.job_type})`);
                            }}><Bot className="h-3 w-3 mr-0.5" /> Giao review</Button>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                ))}
              </div>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
