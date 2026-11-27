// Tab 1: Pipeline — V3 FINAL — stages with agent + jobs expandable + scripts with status

import { useState, useCallback, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { Play, Loader2, CheckCircle, Circle, Clock, ChevronDown, ChevronUp, AlertCircle, Copy, Trash2, RefreshCw, Eye, Calendar, Bot, ExternalLink, Plus, Pause, Edit2, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/context/ToastContext";
import { copyToClipboard } from "@/lib/clipboard";
import { fetchOk } from "@/lib/readJsonOrThrow";
import { useGuardedAction } from "@/lib/useGuardedAction";

// ── Stage → SOP mapping ──
const STAGE_SOP_MAP: Record<string, string> = {
  brainstorm: "CNT-001",
  generate: "CNT-018",
  review: "CNT-015",
  publish: "DST-001",
  email: "DST-004",
  push: "DST-005",
};

// ── Stage definitions per INDEX.md ──
const STAGES = [
  { id: "brainstorm", name: "Brainstorm", color: "bg-red-500", description: "Content Strategist tạo chủ đề (Thứ 3/5)", script: null, defaultAgent: "content-strategist", hasInput: true },
  { id: "outline", name: "Outline", color: "bg-blue-500", description: "Tạo outline LATC trước khi viết script", script: null, defaultAgent: "content-strategist", hasInput: true },
  { id: "generate", name: "Generate", color: "bg-emerald-500", description: "batch_processor.py tạo nội dung bằng AI", script: "batch_generate", defaultAgent: "content-strategist" },
  { id: "visual", name: "Visual", color: "bg-violet-500", description: "social_image_composer.py tạo combo images", script: "compose_images", defaultAgent: "designer" },
  { id: "review", name: "Review", color: "bg-orange-500", description: "CEO / Board duyệt nội dung", script: null, defaultAgent: "ceo" },
  { id: "publish", name: "Publish", color: "bg-teal-500", description: "daily_facebook_post.py đăng bài 3 accounts × 3 khung giờ", script: "daily_post", defaultAgent: "social-media-manager" },
  { id: "engage", name: "Engage", color: "bg-amber-500", description: "Community Engagement Agent trả lời comments", script: null, defaultAgent: "community-engagement" },
  { id: "analytics", name: "Analytics", color: "bg-gray-500", description: "Data Analyst pull engagement metrics weekly", script: null, defaultAgent: "data-analyst" },
  { id: "email", name: "Email", color: "bg-pink-500", description: "⚠️ Drip sequence system (edge functions + pg_cron). send_daily_newsletter.py ĐÃ TẮT.", script: null, defaultAgent: "email-crm-manager" },
  { id: "push", name: "Push", color: "bg-indigo-500", description: "daily_pipeline_orchestrator.py --stage push", script: "daily_push", defaultAgent: "email-crm-manager" },
];

const SCRIPTS = [
  { key: "pipeline_audit", name: "Pipeline Audit", schedule: "07:00 hàng ngày", defaultAgent: "ceo", status: "active" as const },
  { key: "daily_email", name: "Email 8 segments", schedule: "08:00 hàng ngày", defaultAgent: "email-crm-manager", status: "disabled" as const, note: "Script đã tắt. Email dùng drip sequence (edge functions + pg_cron #19)." },
  { key: "daily_push", name: "Push Notifications", schedule: "09:00 hàng ngày", defaultAgent: "email-crm-manager", status: "active" as const },
  { key: "daily_post", name: "Facebook Posts", schedule: "10:00, 17:00, 19:45", defaultAgent: "social-media-manager", status: "active" as const },
  { key: "compose_images", name: "Tạo hình ảnh", schedule: "Theo yêu cầu", defaultAgent: "designer", status: "active" as const },
  { key: "batch_generate", name: "Batch Generate", schedule: "Thứ 2 06:00", defaultAgent: "content-strategist", status: "active" as const },
  { key: "weekly_plan", name: "Tạo plan tuần", schedule: "CN 20:00", defaultAgent: "ceo", status: "active" as const },
  { key: "weekly_queue", name: "Queue jobs từ plan", schedule: "CN 21:00", defaultAgent: "ceo", status: "active" as const },
  { key: "schedule_all", name: "Schedule Meta BS (Pages)", schedule: "Theo yêu cầu", defaultAgent: "social-media-manager", status: "active" as const },
  { key: "schedule_profile", name: "Schedule Profile Jennie", schedule: "Theo yêu cầu", defaultAgent: "social-media-manager", status: "active" as const },
];

function timeAgo(d?: string): string {
  if (!d) return '—';
  const ms = Date.now() - new Date(d).getTime();
  if (ms < 3600000) return Math.round(ms / 60000) + ' phút trước';
  if (ms < 86400000) return Math.round(ms / 3600000) + ' giờ trước';
  return Math.round(ms / 86400000) + ' ngày trước';
}

export function PipelineTab({ onSwitchTab }: { onSwitchTab?: (tab: string) => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const guard = useGuardedAction();
  const [expandedStage, setExpandedStage] = useState<string | null>(null);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set(["Hoàn thành", "Đã hủy"]));
  const [runningScript, setRunningScript] = useState<string | null>(null);
  const [scriptOutput, setScriptOutput] = useState("");
  const [showOutput, setShowOutput] = useState(false);
  const [runningSopId, setRunningSopId] = useState<string | null>(null);

  const execSop = useCallback(async (sopId: string) => {
    setRunningSopId(sopId);
    try {
      await fetchOk(`/api/ops/sop-engine/sops/${sopId}/run`, { method: "POST" }, `Lỗi chạy SOP ${sopId}`);
      pushToast({ title: `Đã trigger SOP ${sopId}`, tone: "success" });
    } catch (e: any) { pushToast({ title: e?.message || "Lỗi kết nối", tone: "error" }); }
    finally { setRunningSopId(null); }
  }, [pushToast]);

  // 1B: Editable schedule state
  const [editingSchedule, setEditingSchedule] = useState<string | null>(null);
  const [scheduleHour, setScheduleHour] = useState("07");
  const [scheduleMin, setScheduleMin] = useState("00");
  const [scheduleFreq, setScheduleFreq] = useState<"daily" | "weekly" | "ondemand">("daily");
  const [scheduleDay, setScheduleDay] = useState("1");
  const [savingSchedule, setSavingSchedule] = useState(false);

  const saveSchedule = async (key: string) => {
    setSavingSchedule(true);
    const scheduleText = scheduleFreq === "ondemand"
      ? "Theo yêu cầu"
      : scheduleFreq === "weekly"
        ? `Thứ ${["CN","2","3","4","5","6","7"][Number(scheduleDay)]} ${scheduleHour}:${scheduleMin}`
        : `${scheduleHour}:${scheduleMin} hàng ngày`;
    try {
      await fetchOk(`/api/ops/content-pipeline/scripts/${key}/schedule`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schedule: scheduleText, hour: scheduleHour, minute: scheduleMin, frequency: scheduleFreq, weekday: scheduleDay }),
      }, "Lỗi lưu lịch");
      pushToast({ title: `Đã lưu lịch: ${scheduleText}`, tone: "success" });
      setEditingSchedule(null);
    } catch (e: any) {
      pushToast({ title: e?.message || "Lỗi lưu lịch", tone: "error" });
    } finally {
      setSavingSchedule(false);
    }
  };

  const { data: stats } = useQuery({ queryKey: ["ops", "content-stats"], queryFn: async () => (await fetch("/api/ops/content-pipeline/stats")).json(), staleTime: 30_000 });
  const { data: jobsSummary } = useQuery({ queryKey: ["ops", "jobs-summary"], queryFn: async () => (await fetch("/api/ops/content-pipeline/jobs-summary")).json(), staleTime: 10_000 });
  const { data: recentJobs, isLoading: jobsLoading, isFetching: jobsFetching } = useQuery({ queryKey: ["ops", "jobs"], queryFn: async () => { const r = await fetch("/api/ops/content-pipeline/jobs"); const d = await r.json(); return d.jobs || []; }, staleTime: 5_000, refetchInterval: 15_000 });
  const { data: agents } = useQuery({ queryKey: ["ops", "pipeline-agents"], queryFn: async () => { const r = await fetch("/api/ops/content-pipeline/agents"); const d = await r.json(); return d.agents || []; }, staleTime: 60_000 });

  const executeScript = useCallback(async (scriptKey: string) => {
    setRunningScript(scriptKey); setScriptOutput(""); setShowOutput(true);
    try {
      const response = await fetchOk(`/api/ops/content-pipeline/execute/${scriptKey}`, { method: "POST", headers: { "Content-Type": "application/json" } }, `Lỗi ${scriptKey}`);
      const reader = response.body?.getReader();
      if (!reader) { setRunningScript(null); return; }
      const decoder = new TextDecoder(); let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n"); buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try { const ev = JSON.parse(line.slice(6)); if (ev.type === "stdout" || ev.type === "stderr") setScriptOutput(p => p + ev.text); else if (ev.type === "exit") pushToast({ title: ev.code === 0 ? `${scriptKey} hoàn tất` : `${scriptKey} lỗi (exit ${ev.code})`, tone: ev.code === 0 ? "success" : "error" }); else if (ev.type === "error") pushToast({ title: ev.message, tone: "error" }); } catch {}
        }
      }
    } catch (err: any) { pushToast({ title: err.message, tone: "error" }); }
    finally { setRunningScript(null); qc.invalidateQueries({ queryKey: ["ops"] }); }
  }, [pushToast, qc]);

  const handleDelegate = useCallback(async (agentSlug: string, task: string) => {
    pushToast({ title: `Đang giao việc cho ${agentSlug}...`, tone: "info" });
    try {
      await fetchOk("/api/ops/content-pipeline/delegate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent_slug: agentSlug, task }) }, "Lỗi giao việc");
      pushToast({ title: `Đã giao việc cho ${agentSlug}`, tone: "success" });
    } catch (e: any) { pushToast({ title: e?.message || "Lỗi kết nối", tone: "error" }); }
  }, [pushToast]);

  const jobIcon = (s: string) => s === "processing" ? <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" /> : s === "completed" ? <CheckCircle className="h-3.5 w-3.5 text-green-500" /> : s === "failed" ? <AlertCircle className="h-3.5 w-3.5 text-red-500" /> : <Circle className="h-3.5 w-3.5 text-yellow-500" />;

  return (
    <div className="space-y-4">
      {/* 10-Stage Pipeline */}
      <Card className="p-4">
        <h3 className="text-sm font-semibold mb-3">Pipeline 10 bước</h3>
        <div className="flex gap-1 overflow-x-auto pb-2">
          {STAGES.map((stage, i) => (
            <div key={stage.id} className="flex items-center gap-1 shrink-0">
              <button onClick={() => setExpandedStage(expandedStage === stage.id ? null : stage.id)}
                className={`px-3 py-1.5 rounded-full text-[10px] font-medium text-white ${stage.color} hover:opacity-80 ${expandedStage === stage.id ? "ring-2 ring-offset-1 ring-foreground/20" : ""}`}>{stage.name}</button>
              {STAGE_SOP_MAP[stage.id] && (
                <span className="text-[9px] font-mono text-violet-500 cursor-pointer hover:underline" onClick={() => navigate(`/ops/sop-engine?sop=${STAGE_SOP_MAP[stage.id]}`)}>{STAGE_SOP_MAP[stage.id]}</span>
              )}
              {i < STAGES.length - 1 && <span className="text-muted-foreground text-xs">→</span>}
            </div>
          ))}
        </div>

        {expandedStage && (() => {
          const stage = STAGES.find(s => s.id === expandedStage)!;
          let statusText = "";
          if (stage.id === "generate" && jobsSummary) statusText = `${jobsSummary.queued || 0} queued · ${jobsSummary.processing || 0} đang tạo · ${jobsSummary.completed || 0} xong · ${jobsSummary.failed || 0} failed`;
          if (stage.id === "review" && stats) statusText = `${stats.pending_approval || 0} chờ duyệt`;
          if (stage.id === "publish" && stats) statusText = `${stats.posted_today || 0}/${stats.target_today || 9} đã đăng hôm nay`;
          return (
            <div className="mt-3 p-4 border rounded-lg bg-muted/20 space-y-3">
              <div className="flex items-center gap-2">
                <div className={`w-3 h-3 rounded-full ${stage.color}`} />
                <h4 className="text-sm font-semibold">{stage.name}</h4>
                {STAGE_SOP_MAP[stage.id] && (
                  <>
                    <button onClick={() => navigate(`/ops/sop-engine?sop=${STAGE_SOP_MAP[stage.id]}`)} className="px-1.5 py-0.5 text-[10px] font-mono font-medium rounded bg-violet-500/10 text-violet-600 hover:bg-violet-500/20 transition-colors" title={`Xem SOP ${STAGE_SOP_MAP[stage.id]}`}>
                      {STAGE_SOP_MAP[stage.id]}
                    </button>
                    <button onClick={() => execSop(STAGE_SOP_MAP[stage.id])} disabled={runningSopId === STAGE_SOP_MAP[stage.id]} className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-green-500/10 text-green-600 hover:bg-green-500/20 transition-colors disabled:opacity-50" title={`Chạy SOP ${STAGE_SOP_MAP[stage.id]}`}>
                      {runningSopId === STAGE_SOP_MAP[stage.id] ? <Loader2 className="h-2.5 w-2.5 animate-spin inline" /> : "▶"}
                    </button>
                  </>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{stage.description}</p>
              {statusText && <p className="text-xs font-medium">{statusText}</p>}
              {stage.hasInput && <textarea className="w-full border rounded-lg p-2 text-sm bg-background" placeholder="Nhập chủ đề / yêu cầu..." rows={2} />}
              {/* Agent delegation */}
              <div className="flex items-center gap-2 flex-wrap">
                <select defaultValue={stage.defaultAgent} className="text-xs border rounded px-2 py-1.5 bg-background">
                  {(agents || []).map((a: any) => <option key={a.slug} value={a.slug}>{a.display_name || a.slug}</option>)}
                </select>
                <Button size="sm" variant="outline" onClick={() => handleDelegate(stage.defaultAgent, `${stage.name}: ${stage.description}`)}><Bot className="h-3 w-3 mr-1" /> Giao việc</Button>
              </div>
              {stage.script && <Button size="sm" disabled={!!runningScript} onClick={() => executeScript(stage.script!)}>{runningScript === stage.script ? <><Loader2 className="h-3 w-3 animate-spin mr-1" /> Đang chạy...</> : <><Play className="h-3 w-3 mr-1" /> Chạy {stage.name}</>}</Button>}
              {stage.id === "generate" && (jobsSummary?.failed || 0) > 0 && (
                <Button size="sm" variant="outline" className="text-red-600" onClick={() => guard(async () => { await fetchOk("/api/ops/content-pipeline/jobs/retry-failed", { method: "POST" }, "Lỗi retry job lỗi"); qc.invalidateQueries({ queryKey: ["ops"] }); pushToast({ title: `Retry ${jobsSummary.failed} failed jobs`, tone: "success" }); }, "Không retry được job lỗi")}>
                  <RefreshCw className="h-3 w-3 mr-1" /> Retry {jobsSummary.failed} failed
                </Button>
              )}
              {stage.id === "review" && (
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={async () => {
                    pushToast({ title: "Đang kiểm tra compliance...", tone: "info" });
                    try {
                      const res = await fetch("/api/ops/content-pipeline/scripts?status=draft&limit=200");
                      const drafts = await res.json() || [];
                      if (!drafts.length) { pushToast({ title: "Không có bài chờ duyệt", tone: "info" }); return; }
                      const passIds: string[] = [];
                      let failCount = 0;
                      for (const s of drafts) {
                        const cr = await fetchOk("/api/ops/content-pipeline/compliance-check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: s.body || s.caption || "" }) }, "Lỗi kiểm tra compliance");
                        const check = await cr.json();
                        if (check.pass) passIds.push(s.id); else failCount++;
                      }
                      if (passIds.length) await fetchOk("/api/ops/content-pipeline/scripts/bulk-approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ script_ids: passIds }) }, "Lỗi duyệt hàng loạt");
                      pushToast({ title: `Đã duyệt ${passIds.length} bài. ${failCount} cần review.`, tone: "success" });
                      qc.invalidateQueries({ queryKey: ["ops"] });
                    } catch (e: any) { pushToast({ title: e?.message || "Lỗi bulk approve", tone: "error" }); }
                  }}>✅ Duyệt đạt compliance</Button>
                  <Button size="sm" variant="outline" onClick={() => onSwitchTab?.("content")}>📋 Xem chờ duyệt</Button>
                </div>
              )}
              {stage.id === "publish" && <Button size="sm" variant="outline" onClick={() => onSwitchTab?.("schedule")}>📅 Xem lịch đăng</Button>}
              {stage.id === "email" && (
                <div className="space-y-1.5 text-xs">
                  <div className="flex items-center gap-2 p-2 border rounded bg-background"><span className="text-green-500">●</span> email-automation-scheduler — pg_cron #19, mỗi 15 phút</div>
                  <div className="flex items-center gap-2 p-2 border rounded bg-background"><span className="text-green-500">●</span> waitlist-email-nurture — pg_cron #17, daily 01:00 UTC</div>
                  <div className="flex items-center gap-2 p-2 border rounded bg-background"><span className="text-green-500">●</span> send-email — 14+ templates, Resend API</div>
                  <Button size="sm" variant="outline" onClick={() => onSwitchTab?.("email")}>📊 Xem email stats</Button>
                </div>
              )}
            </div>
          );
        })()}
      </Card>

      {/* Generation Jobs — grouped by status */}
      {(() => {
        const now = Date.now();
        const TEN_MIN = 10 * 60 * 1000;
        const jobs: any[] = recentJobs || [];

        const stuck = jobs.filter(j => (j.status === 'queued' || j.status === 'processing') && (now - new Date(j.created_at).getTime()) > TEN_MIN);
        const stuckIds = new Set(stuck.map((j: any) => j.id));
        const processing = jobs.filter(j => j.status === 'processing' && !stuckIds.has(j.id));
        const queued = jobs.filter(j => j.status === 'queued' && !stuckIds.has(j.id));
        const failed = jobs.filter(j => j.status === 'failed');
        const completed = jobs.filter(j => j.status === 'completed');

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
          // Use server-extracted _provider/_model first, then fall back to input_params parsing
          const provider = j._provider || (() => { try { const p = typeof j.input_params === 'string' ? JSON.parse(j.input_params) : (j.input_params || {}); return p.provider || ''; } catch { return ''; } })();
          const model = j._model || j.model_used || (() => { try { const p = typeof j.input_params === 'string' ? JSON.parse(j.input_params) : (j.input_params || {}); return p.model || ''; } catch { return ''; } })();
          if (!provider && !model) return null; // Hide badge entirely when unknown
          const shortModel = (model || '—').replace('claude-', '').replace('gemini-', '').replace('-latest', '').replace('-preview', '').replace('sonnet-4-6', 'sonnet-4.6').replace('sonnet-4-5', 'sonnet-4.5').replace('haiku-4-5', 'haiku-4.5');
          return `${provider || '?'}/${shortModel}`;
        };

        const formatDt = (d: string) => {
          const dt = new Date(d);
          return dt.toLocaleString('vi', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        };

        type GroupConfig = { label: string; color: string; dot: string; jobs: any[]; canCancel: boolean; showAge?: boolean };
        const cancelled = jobs.filter(j => j.status === 'cancelled');

        const groups: GroupConfig[] = [
          { label: "Bị kẹt (>10 phút)", color: "border-red-500/30 bg-red-500/5", dot: "bg-red-500", jobs: stuck, canCancel: true, showAge: true },
          { label: "Đang xử lý", color: "border-blue-500/30 bg-blue-500/5", dot: "bg-blue-500 animate-pulse", jobs: processing, canCancel: true },
          { label: "Chờ xử lý", color: "border-yellow-500/30 bg-yellow-500/5", dot: "bg-yellow-500", jobs: queued, canCancel: true },
          { label: "Thất bại", color: "border-red-400/20 bg-red-400/5", dot: "bg-red-400", jobs: failed, canCancel: false },
          { label: "Hoàn thành", color: "border-green-500/20 bg-green-500/5", dot: "bg-green-500", jobs: completed, canCancel: false },
          { label: "Đã hủy", color: "border-muted/40 bg-muted/20", dot: "bg-muted-foreground/40", jobs: cancelled, canCancel: false },
        ];

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
                {groups.map(g => g.jobs.length === 0 ? null : (
                  <div key={g.label} className={`rounded-lg border ${g.color}`}>
                    {/* Group header — clickable to collapse */}
                    <div
                      className="flex items-center justify-between p-2.5 cursor-pointer select-none"
                      onClick={() => setCollapsedGroups(prev => {
                        const next = new Set(prev);
                        if (next.has(g.label)) next.delete(g.label); else next.add(g.label);
                        return next;
                      })}
                    >
                      <div className="flex items-center gap-2">
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
                        <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${collapsedGroups.has(g.label) ? "" : "rotate-180"}`} />
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
                            {/* Model — only show when known */}
                            {getModel(j) && <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-600 dark:text-violet-400 font-mono shrink-0">{getModel(j)}</span>}
                            {/* Topic preview */}
                            {j.topic && <span className="text-muted-foreground truncate min-w-0 flex-1">"{j.topic}"</span>}
                            {/* Age for stuck */}
                            {g.showAge && <span className="text-[10px] text-red-500 shrink-0">{Math.round((now - new Date(j.created_at).getTime()) / 60000)}m</span>}
                            {/* Failed error snippet — only when no topic */}
                            {j.status === 'failed' && j.error_message && !j.topic && <span className="text-muted-foreground truncate flex-1 min-w-0">{j.error_message.slice(0, 60)}</span>}
                            {/* Spacer when no topic */}
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
                                {/* Output — editable */}
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
                                      : <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => onSwitchTab?.("content")}><ExternalLink className="h-3 w-3 mr-0.5" /> Xem nội dung</Button>
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
      })()}

      {/* Scripts */}
      <Card className="p-4">
        <h3 className="text-sm font-semibold mb-3">Scripts</h3>
        <div className="space-y-1.5">
          {SCRIPTS.filter(s => s.status !== "disabled" && !s.name?.includes('ĐÃ TẮT')).map(s => (
            <div key={s.key} className="rounded-lg bg-muted/30 border border-transparent hover:border-border/40 transition-colors">
              <div className="flex items-center justify-between p-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium">{s.name}</div>
                  {/* Editable schedule */}
                  {editingSchedule === s.key ? (
                    <div className="flex items-center gap-1.5 mt-1.5 flex-wrap" onClick={e => e.stopPropagation()}>
                      <select
                        value={scheduleFreq}
                        onChange={e => setScheduleFreq(e.target.value as any)}
                        className="text-[10px] border rounded px-1 py-0.5 bg-background"
                      >
                        <option value="daily">Hàng ngày</option>
                        <option value="weekly">Hàng tuần</option>
                        <option value="ondemand">Theo yêu cầu</option>
                      </select>
                      {scheduleFreq === "weekly" && (
                        <select
                          value={scheduleDay}
                          onChange={e => setScheduleDay(e.target.value)}
                          className="text-[10px] border rounded px-1 py-0.5 bg-background"
                        >
                          {["CN","Thứ 2","Thứ 3","Thứ 4","Thứ 5","Thứ 6","Thứ 7"].map((d, i) => (
                            <option key={i} value={i}>{d}</option>
                          ))}
                        </select>
                      )}
                      {scheduleFreq !== "ondemand" && (
                        <>
                          <input
                            type="number" min={0} max={23} value={scheduleHour}
                            onChange={e => setScheduleHour(String(e.target.value).padStart(2,"0"))}
                            className="text-[10px] border rounded px-1 py-0.5 bg-background w-10 text-center"
                          />
                          <span className="text-[10px] text-muted-foreground">:</span>
                          <input
                            type="number" min={0} max={59} value={scheduleMin}
                            onChange={e => setScheduleMin(String(e.target.value).padStart(2,"0"))}
                            className="text-[10px] border rounded px-1 py-0.5 bg-background w-10 text-center"
                          />
                        </>
                      )}
                      <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[10px] text-green-600 hover:text-green-700" disabled={savingSchedule} onClick={() => saveSchedule(s.key)}>
                        <Save className="h-2.5 w-2.5 mr-0.5" /> Lưu
                      </Button>
                      <Button size="sm" variant="ghost" className="h-5 px-1 text-[10px] text-muted-foreground" onClick={() => setEditingSchedule(null)}>
                        <X className="h-2.5 w-2.5" />
                      </Button>
                    </div>
                  ) : (
                    <button
                      className="text-[10px] text-muted-foreground flex items-center gap-1 hover:text-foreground mt-0.5 group"
                      onClick={() => {
                        setEditingSchedule(s.key);
                        setScheduleFreq(s.schedule.includes("Thứ") ? "weekly" : s.schedule.includes("yêu cầu") ? "ondemand" : "daily");
                        const timeMatch = s.schedule.match(/(\d{2}):(\d{2})/);
                        if (timeMatch) { setScheduleHour(timeMatch[1]); setScheduleMin(timeMatch[2]); }
                      }}
                    >
                      <Clock className="h-3 w-3" /> {s.schedule}
                      <Edit2 className="h-2.5 w-2.5 opacity-0 group-hover:opacity-60 ml-0.5" />
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-1 ml-2">
                  <select defaultValue={s.defaultAgent} className="text-[10px] border rounded px-1.5 py-1 bg-background max-w-[120px]">
                    {(agents || []).map((a: any) => <option key={a.slug} value={a.slug}>{a.display_name || a.slug}</option>)}
                  </select>
                  <Button size="sm" variant="ghost" className="h-7 px-1.5" onClick={() => handleDelegate(s.defaultAgent, `Chạy ${s.name}`)}><Bot className="h-3 w-3" /></Button>
                  <Button size="sm" variant="outline" className="h-7" disabled={runningScript === s.key} onClick={() => executeScript(s.key)}>
                    {runningScript === s.key ? <Loader2 className="h-3 w-3 animate-spin mr-0.5" /> : <Play className="h-3 w-3 mr-0.5" />} Chạy
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Output terminal */}
      {showOutput && (
        <Card className="p-0 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 bg-zinc-900 text-zinc-400">
            <span className="text-xs font-mono">Output {runningScript ? `(${runningScript})` : ""}</span>
            <button onClick={() => { setShowOutput(false); setScriptOutput(""); }} className="text-xs hover:text-white">Đóng</button>
          </div>
          <div className="bg-zinc-950 text-green-400 p-3 text-xs font-mono max-h-60 overflow-y-auto whitespace-pre-wrap">{scriptOutput || (runningScript ? "Đang khởi động..." : "Không có output")}</div>
        </Card>
      )}

      {/* Weekly Workflow */}
      <Card className="p-4">
        <h3 className="text-sm font-semibold mb-3">Weekly Workflow</h3>
        <div className="flex gap-2 flex-wrap">
          {["weekly_plan", "weekly_queue", "batch_generate"].map(k => {
            const s = SCRIPTS.find(sc => sc.key === k)!;
            return <Button key={k} size="sm" variant="outline" disabled={!!runningScript} onClick={() => executeScript(k)}>{runningScript === k ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Play className="h-3 w-3 mr-1" />} {s?.name || k}</Button>;
          })}
        </div>
      </Card>
    </div>
  );
}
