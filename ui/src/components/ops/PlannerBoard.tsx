// PlannerBoard — Content Planner với drag & drop (dnd-kit)
// Phase 5: 14 ngày × 3 time slots × 3 accounts = 126 ô

import { useState, useCallback, useRef } from "react";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Sparkles, FileText, CheckCircle, Rocket, Bot,
  ChevronLeft, ChevronRight, RefreshCw, Loader2,
  Clock, X, Copy, Check, AlertCircle, Trash2,
  CheckSquare, Pencil,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/context/ToastContext";
import { copyToClipboard } from "@/lib/clipboard";
import { readJsonOrThrow } from "@/lib/readJsonOrThrow";

import { useConfirm } from "@/components/ConfirmDialog";
import { fetchOk } from "@/lib/readJsonOrThrow";
// ─── Constants ────────────────────────────────────────────────────
const ACCOUNTS = [
  { key: "profile_jennie", label: "👤 Profile Jennie", voice: "jennie",
    border: "border-l-pink-400",   bg: "bg-pink-50/60",   badge: "bg-pink-100 text-pink-700 border-pink-200" },
  { key: "page_jennie",    label: "📘 Page Jennie",    voice: "jennie",
    border: "border-l-blue-400",   bg: "bg-blue-50/60",   badge: "bg-blue-100 text-blue-700 border-blue-200" },
  { key: "page_gemral",   label: "📘 Page Gemral",    voice: "generic",
    border: "border-l-violet-400", bg: "bg-violet-50/60", badge: "bg-violet-100 text-violet-700 border-violet-200" },
];

const TIME_SLOTS = ["10:00", "17:00", "19:45"];

const STATUS_CFG: Record<string, { label: string; cls: string }> = {
  topic:      { label: "📋 Chủ đề",     cls: "bg-zinc-100 text-zinc-600 border-zinc-200" },
  generating: { label: "⏳ Đang tạo",   cls: "bg-amber-100 text-amber-700 border-amber-200" },
  draft:      { label: "📝 Nháp",        cls: "bg-blue-100 text-blue-700 border-blue-200" },
  review:     { label: "👁 Review",      cls: "bg-purple-100 text-purple-700 border-purple-200" },
  approved:   { label: "✅ Đã duyệt",    cls: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  scheduled:  { label: "🟢 Lên lịch",   cls: "bg-teal-100 text-teal-700 border-teal-200" },
  published:  { label: "🔵 Đã đăng",    cls: "bg-indigo-100 text-indigo-700 border-indigo-200" },
  failed:     { label: "🔴 Lỗi",        cls: "bg-red-100 text-red-700 border-red-200" },
};

const PILLAR_BORDER: Record<string, string> = {
  crystal: "border-l-green-400", trading: "border-l-blue-400",
  trading_technical: "border-l-blue-400", trading_mindset: "border-l-sky-400",
  ritual: "border-l-purple-400", spiritual: "border-l-indigo-400",
  tinh_yeu: "border-l-pink-400", lifestyle: "border-l-orange-400",
  trieu_phu: "border-l-yellow-400", app_product: "border-l-cyan-400",
  education: "border-l-teal-400", "7_ngay": "border-l-emerald-400",
  integration: "border-l-zinc-300",
};

// ─── Date helpers ─────────────────────────────────────────────────
function getMonday(offset = 0): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay() + 1 + offset * 7);
  return d.toISOString().split("T")[0];
}
function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().split("T")[0];
}
function genRange(start: string, days: number): string[] {
  return Array.from({ length: days }, (_, i) => addDays(start, i));
}
function fmtDate(dateStr: string): string {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("vi-VN", {
    weekday: "short", month: "numeric", day: "numeric",
  });
}
function isToday(dateStr: string): boolean {
  return dateStr === new Date().toISOString().split("T")[0];
}

function renderMd(md: string): string {
  return md
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/^### (.+)$/gm, "<strong class='block text-[11px] font-semibold mt-2'>$1</strong>")
    .replace(/^## (.+)$/gm, "<strong class='block text-xs font-bold mt-2'>$1</strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/#(\w+)/g, "<span class='text-blue-600'>#$1</span>")
    .replace(/\n\n/g, "<br/><br/>")
    .replace(/\n/g, "<br/>");
}

// ─── ScriptCard (draggable) ───────────────────────────────────────
function ScriptCard({
  script, selected, onSelect, onExpand, expanded, inPool = false, onUpdate,
}: {
  script: any; selected?: boolean; onSelect?: (id: string) => void;
  onExpand?: (id: string) => void; expanded?: boolean; inPool?: boolean;
  onUpdate?: (id: string, fields: Record<string, any>) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `script:${script.id}`,
    data: { script },
  });
  const style = transform
    ? { transform: `translate3d(${transform.x}px,${transform.y}px,0)` }
    : undefined;

  const status = STATUS_CFG[script.status] || STATUS_CFG.topic;
  const pillarBorder = PILLAR_BORDER[script.pillar] || "border-l-zinc-200";
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(script.title || "");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (script.body) {
      void copyToClipboard(script.body).then((ok) => {
        if (!ok) return;
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    }
  };

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditTitle(script.title || "");
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const saveEdit = () => {
    if (editTitle.trim() && editTitle !== script.title) {
      onUpdate?.(script.id, { title: editTitle.trim() });
    }
    setEditing(false);
  };

  const cancelEdit = () => { setEditing(false); setEditTitle(script.title || ""); };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group relative border rounded-lg border-l-4 bg-white text-xs select-none
        ${pillarBorder}
        ${isDragging ? "opacity-30 shadow-lg" : "shadow-sm"}
        ${selected ? "ring-2 ring-primary/60" : ""}
        ${inPool ? "p-2" : "p-1.5"}
      `}
    >
      {/* Top row: checkbox + drag handle + status + edit */}
      <div className="flex items-center gap-1 mb-1">
        {onSelect && (
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onSelect(script.id)}
            className="w-3 h-3 shrink-0"
            onClick={e => e.stopPropagation()}
          />
        )}
        <span
          {...attributes}
          {...listeners}
          className="cursor-grab text-zinc-300 hover:text-zinc-500 text-[10px] leading-none shrink-0"
          title="Kéo"
        >⠿</span>
        <span className={`text-[9px] px-1 py-0.5 rounded border shrink-0 ${status.cls}`}>
          {status.label}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          {onUpdate && !editing && (
            <button onClick={startEdit} className="opacity-0 group-hover:opacity-100 shrink-0 p-0.5 hover:bg-zinc-100 rounded" title="Sửa tiêu đề">
              <Pencil size={9} className="text-zinc-400" />
            </button>
          )}
          {script.body && (
            <button onClick={handleCopy} className="opacity-0 group-hover:opacity-100 shrink-0 p-0.5" title="Copy">
              {copied ? <Check size={9} className="text-emerald-500" /> : <Copy size={9} className="text-zinc-400" />}
            </button>
          )}
        </div>
      </div>

      {/* Title — inline edit */}
      {editing ? (
        <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
          <input
            ref={inputRef}
            value={editTitle}
            onChange={e => setEditTitle(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") cancelEdit(); }}
            onBlur={saveEdit}
            className="flex-1 border rounded px-1 py-0.5 text-xs bg-white focus:ring-1 focus:ring-primary/40 outline-none"
          />
        </div>
      ) : (
        <p
          className="font-medium leading-snug cursor-pointer hover:text-primary line-clamp-2"
          onClick={() => onExpand?.(script.id)}
          onDoubleClick={onUpdate ? startEdit : undefined}
          title={`${script.title}${onUpdate ? " (double-click để sửa)" : ""}`}
        >
          {script.title || "Không có tiêu đề"}
        </p>
      )}

      {/* Word count */}
      {script.word_count > 0 && (
        <span className="text-[9px] text-zinc-400 mt-0.5 block">{script.word_count} từ</span>
      )}

      {/* Expand panel */}
      {expanded && <ScriptExpandPanel script={script} onUpdate={onUpdate} />}
    </div>
  );
}

// ─── ScriptCard preview (drag overlay) ───────────────────────────
function ScriptCardPreview({ script }: { script: any }) {
  const status = STATUS_CFG[script.status] || STATUS_CFG.topic;
  const pillarBorder = PILLAR_BORDER[script.pillar] || "border-l-zinc-200";
  return (
    <div className={`border rounded-lg border-l-4 bg-white shadow-xl p-2 text-xs w-44 ${pillarBorder}`}>
      <span className={`text-[9px] px-1 py-0.5 rounded border ${status.cls}`}>{status.label}</span>
      <p className="font-medium mt-1 line-clamp-2">{script.title}</p>
    </div>
  );
}

// ─── Inline expand panel ──────────────────────────────────────────
function ScriptExpandPanel({ script, onUpdate }: { script: any; onUpdate?: (id: string, fields: Record<string, any>) => void }) {
  const { pushToast } = useToast();
  const qc = useQueryClient();
  const [editingBody, setEditingBody] = useState(false);
  const [bodyDraft, setBodyDraft] = useState(script.body || "");

  const approveMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/ops/content-pipeline/scripts/${script.id}/approve`, { method: "POST" });
      return readJsonOrThrow(res, "Lỗi duyệt bài");
    },
    onSuccess: () => { pushToast({ title: "Đã duyệt bài", tone: "success" }); qc.invalidateQueries({ queryKey: ["planner"] }); },
    onError: (e: any) => pushToast({ title: e.message, tone: "error" }),
  });

  const genMut = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/ops/content-pipeline/planner/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script_ids: [script.id] }),
      });
      return readJsonOrThrow(res, "Lỗi tạo nội dung");
    },
    onSuccess: (d) => { pushToast({ title: d.message, tone: "success" }); qc.invalidateQueries({ queryKey: ["planner"] }); },
    onError: (e: any) => pushToast({ title: e.message, tone: "error" }),
  });

  return (
    <div className="mt-2 pt-2 border-t border-zinc-100 space-y-1.5" onClick={e => e.stopPropagation()}>
      {!script.body ? (
        <>
          {script.metadata?.topic_summary && (
            <p className="text-[10px] text-zinc-500"><span className="font-medium">Tóm tắt:</span> {script.metadata.topic_summary}</p>
          )}
          {script.metadata?.hashtags && (
            <p className="text-[10px] text-zinc-400">{script.metadata.hashtags}</p>
          )}
          <div className="flex gap-1 flex-wrap">
            <Button size="sm" variant="default" className="h-5 text-[9px] px-1.5" onClick={() => genMut.mutate()} disabled={genMut.isPending}>
              {genMut.isPending ? <Loader2 size={8} className="animate-spin" /> : <FileText size={8} />}
              Generate bài này
            </Button>
          </div>
        </>
      ) : (
        <>
          {editingBody ? (
            <div onClick={e => e.stopPropagation()}>
              <textarea
                value={bodyDraft}
                onChange={e => setBodyDraft(e.target.value)}
                rows={6}
                className="w-full text-[10px] leading-relaxed bg-white border rounded p-1.5 font-mono resize-y outline-none focus:ring-1 focus:ring-primary/40"
              />
              <div className="flex gap-1 mt-1">
                <Button size="sm" className="h-5 text-[9px] px-1.5" onClick={() => { onUpdate?.(script.id, { body: bodyDraft }); setEditingBody(false); }}>
                  <Check size={8} /> Lưu
                </Button>
                <Button size="sm" variant="outline" className="h-5 text-[9px] px-1.5" onClick={() => setEditingBody(false)}>
                  Huỷ
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div
                className="text-[10px] leading-relaxed max-h-32 overflow-y-auto bg-zinc-50 rounded p-1.5 cursor-pointer hover:bg-zinc-100"
                dangerouslySetInnerHTML={{ __html: renderMd(script.body) }}
                onDoubleClick={() => { setBodyDraft(script.body); setEditingBody(true); }}
                title="Double-click để sửa nội dung"
              />
              <div className="flex gap-1 flex-wrap">
                {onUpdate && (
                  <Button size="sm" variant="outline" className="h-5 text-[9px] px-1.5"
                    onClick={() => { setBodyDraft(script.body); setEditingBody(true); }}>
                    <Pencil size={8} /> Sửa
                  </Button>
                )}
                {script.status === "draft" && (
                  <Button size="sm" variant="default" className="h-5 text-[9px] px-1.5 bg-emerald-600 hover:bg-emerald-700"
                    onClick={() => approveMut.mutate()} disabled={approveMut.isPending}>
                    {approveMut.isPending ? <Loader2 size={8} className="animate-spin" /> : <CheckCircle size={8} />}
                    Duyệt
                  </Button>
                )}
                <Button size="sm" variant="outline" className="h-5 text-[9px] px-1.5"
                  onClick={() => { void copyToClipboard(script.body).then((ok) => { pushToast(ok ? { title: "Đã copy", tone: "success" } : { title: "Không thể sao chép", body: "Trình duyệt chặn quyền truy cập clipboard.", tone: "error" }); }); }}>
                  <Copy size={8} /> Copy
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ─── CalendarSlot (droppable) ─────────────────────────────────────
function CalendarSlot({
  slotId, script, selected, onSelect, expandedId, onExpand, onUpdate,
}: {
  slotId: string; script?: any; selected?: boolean;
  onSelect?: (id: string) => void; expandedId?: string | null; onExpand?: (id: string) => void;
  onUpdate?: (id: string, fields: Record<string, any>) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: slotId });

  return (
    <td
      ref={setNodeRef}
      className={`border border-border/40 p-1 align-top min-w-[130px] max-w-[160px] h-14
        ${isOver ? "bg-primary/10 border-primary/40" : ""}
      `}
    >
      {script ? (
        <ScriptCard
          script={script}
          selected={selected}
          onSelect={onSelect}
          onExpand={onExpand}
          expanded={expandedId === script.id}
          onUpdate={onUpdate}
        />
      ) : (
        <div className={`h-full flex items-center justify-center text-[9px] rounded border-dashed border
          ${isOver ? "border-primary text-primary" : "border-zinc-200 text-zinc-300"}`}>
          kéo vào đây
        </div>
      )}
    </td>
  );
}

// ─── Unassigned Pool (droppable) ──────────────────────────────────
function UnassignedPool({
  scripts, expandedId, onExpand, selectedIds, onSelect, onSelectAll, onUpdate,
}: {
  scripts: any[]; expandedId: string | null; onExpand: (id: string) => void;
  selectedIds: Set<string>; onSelect: (id: string) => void; onSelectAll?: (ids: string[]) => void;
  onUpdate?: (id: string, fields: Record<string, any>) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: "pool" });
  const allSelected = scripts.length > 0 && scripts.every(s => selectedIds.has(s.id));

  return (
    <div
      ref={setNodeRef}
      className={`w-52 shrink-0 rounded-lg border-2 border-dashed transition-colors ${isOver ? "border-primary/50 bg-primary/5" : "border-transparent"}`}
    >
      <Card className="p-3 h-full min-h-[200px]">
        <div className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1">
          <button
            onClick={() => onSelectAll?.(scripts.map(s => s.id))}
            className={`p-0.5 rounded hover:bg-muted ${allSelected ? "text-primary" : "text-muted-foreground"}`}
            title={allSelected ? "Bỏ chọn tất cả" : "Chọn tất cả"}
          >
            <CheckSquare size={12} />
          </button>
          <span>Chưa gán</span>
          <span className="ml-auto bg-muted text-muted-foreground rounded px-1">{scripts.length}</span>
        </div>
        {scripts.length === 0 ? (
          <div className="text-[10px] text-muted-foreground text-center py-6">
            {isOver ? "Thả vào đây để bỏ gán" : "Tất cả đã gán 🎉"}
          </div>
        ) : (
          <div className="space-y-1.5 max-h-[560px] overflow-y-auto">
            {scripts.map(s => (
              <ScriptCard key={s.id} script={s} selected={selectedIds.has(s.id)}
                onSelect={onSelect} onExpand={onExpand} expanded={expandedId === s.id} inPool onUpdate={onUpdate} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ─── CEO Delegate SSE Modal ────────────────────────────────────────
function DelegateModal({ planId, onClose }: { planId: string; onClose: () => void }) {
  const [lines, setLines] = useState(["Đang khởi động CEO Agent..."]);
  const [done, setDone] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  const run = useCallback(async () => {
    try {
      const res = await fetchOk("/api/ops/content-pipeline/planner/delegate-ceo", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_id: planId }),
      }, "Lỗi delegate CEO");
      const reader = res.body?.getReader();
      if (!reader) return;
      const dec = new TextDecoder();
      while (true) {
        const { value, done: d } = await reader.read();
        if (d) break;
        for (const line of dec.decode(value).split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            const obj = JSON.parse(line.slice(6));
            if (obj.text) setLines(p => [...p, obj.text.trimEnd()]);
            if (obj.type === "exit" || obj.type === "error") setDone(true);
          } catch { /* skip */ }
        }
        if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
      }
    } catch (e: any) {
      setLines(p => [...p, `Lỗi: ${e.message}`]);
    }
    setDone(true);
    qc.invalidateQueries({ queryKey: ["planner"] });
  }, [planId, qc]);

  // auto-run on mount
  useState(() => { run(); });

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="bg-background border rounded-xl w-full max-w-2xl shadow-xl flex flex-col" style={{ maxHeight: "80vh" }}>
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Bot size={16} className={done ? "text-emerald-500" : "text-amber-500 animate-pulse"} />
            CEO Agent — Full Auto Pipeline
          </div>
          {done && <Button size="sm" variant="ghost" onClick={onClose}><X size={14} /></Button>}
        </div>
        <div ref={ref} className="flex-1 overflow-y-auto p-4 font-mono text-xs space-y-0.5 bg-muted/20">
          {lines.map((l, i) => <div key={i} className="whitespace-pre-wrap leading-relaxed">{l || "\u00A0"}</div>)}
        </div>
        {!done && (
          <div className="px-4 py-2 border-t text-[10px] text-muted-foreground flex items-center gap-1.5">
            <Loader2 size={10} className="animate-spin" /> Đang chạy...
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main PlannerBoard ────────────────────────────────────────────
export function PlannerBoard() {
  const confirm = useConfirm();
  const { pushToast } = useToast();
  const qc = useQueryClient();

  const [weekOffset, setWeekOffset] = useState(0);
  const [planId, setPlanId] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [activeScript, setActiveScript] = useState<any | null>(null);
  const [showDelegate, setShowDelegate] = useState(false);

  const monday = getMonday(weekOffset);
  const weekDates = genRange(monday, 7);
  const start = weekDates[0], end = weekDates[6];

  // Plans list
  const { data: plans = [] } = useQuery({
    queryKey: ["planner", "plans"],
    queryFn: async () => {
      const res = await fetch("/api/ops/content-pipeline/planner/plans");
      return res.json();
    },
    staleTime: 30_000,
  });

  // Calendar data
  const { data: plannerData, isLoading, refetch } = useQuery({
    queryKey: ["planner", "calendar", start, end, planId],
    queryFn: async () => {
      const p = new URLSearchParams({ start, end });
      if (planId) p.set("plan_id", planId);
      const res = await fetch(`/api/ops/content-pipeline/planner?${p}`);
      return res.json();
    },
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

  // Progress
  const { data: progress } = useQuery({
    queryKey: ["planner", "progress", planId],
    queryFn: async () => {
      if (!planId) return null;
      const res = await fetch(`/api/ops/content-pipeline/planner/progress?plan_id=${planId}`);
      return res.json();
    },
    enabled: !!planId,
    refetchInterval: 8_000,
  });

  const calendar = plannerData?.calendar || {};
  const unassigned: any[] = plannerData?.unassigned || [];

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["planner"] });
  }, [qc]);

  // Mutations
  const assignMut = useMutation({
    mutationFn: async ({ scriptId, date, time, account }: { scriptId: string; date: string; time: string; account: string }) => {
      const res = await fetch("/api/ops/content-pipeline/planner/assign", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script_id: scriptId, date, time, account }),
      });
      return readJsonOrThrow(res, "Lỗi gán bài");
    },
    onSuccess: invalidate,
    onError: (e: any) => pushToast({ title: e.message, tone: "error" }),
  });

  const unassignMut = useMutation({
    mutationFn: async (scriptId: string) => {
      const res = await fetch("/api/ops/content-pipeline/planner/unassign", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script_id: scriptId }),
      });
      return readJsonOrThrow(res, "Lỗi bỏ gán bài");
    },
    onSuccess: invalidate,
    onError: (e: any) => pushToast({ title: e.message, tone: "error" }),
  });

  const parseMut = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/ops/content-pipeline/planner/parse-plan", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planner_script_id: planId }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Lỗi");
      return d;
    },
    onSuccess: (d) => { pushToast({ title: d.message, tone: "success" }); invalidate(); },
    onError: (e: any) => pushToast({ title: `Lỗi parse: ${e.message}`, tone: "error" }),
  });

  const generateMut = useMutation({
    mutationFn: async (scriptIds?: string[]) => {
      const body: any = scriptIds?.length ? { script_ids: scriptIds } : planId ? { plan_id: planId } : {};
      const res = await fetch("/api/ops/content-pipeline/planner/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Lỗi");
      return d;
    },
    onSuccess: (d) => { pushToast({ title: d.message, tone: "success" }); invalidate(); },
    onError: (e: any) => pushToast({ title: `Lỗi generate: ${e.message}`, tone: "error" }),
  });

  const approveMut = useMutation({
    mutationFn: async (scriptIds?: string[]) => {
      const body: any = scriptIds?.length ? { script_ids: scriptIds } : planId ? { plan_id: planId } : {};
      const res = await fetch("/api/ops/content-pipeline/planner/bulk-approve", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Lỗi");
      return d;
    },
    onSuccess: (d) => { pushToast({ title: d.message, tone: "success" }); invalidate(); },
    onError: (e: any) => pushToast({ title: `Lỗi approve: ${e.message}`, tone: "error" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (scriptIds: string[]) => {
      const res = await fetch("/api/ops/content-pipeline/scripts/bulk-delete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script_ids: scriptIds }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Lỗi");
      return d;
    },
    onSuccess: (d) => { pushToast({ title: `Đã xoá ${d.deleted} bài`, tone: "success" }); clearSelection(); invalidate(); },
    onError: (e: any) => pushToast({ title: `Lỗi xoá: ${e.message}`, tone: "error" }),
  });

  const updateMut = useMutation({
    mutationFn: async ({ id, ...fields }: { id: string; title?: string; body?: string }) => {
      const res = await fetch(`/api/ops/content-pipeline/scripts/${id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Lỗi");
      return d;
    },
    onSuccess: () => { pushToast({ title: "Đã cập nhật", tone: "success" }); invalidate(); },
    onError: (e: any) => pushToast({ title: `Lỗi cập nhật: ${e.message}`, tone: "error" }),
  });

  // Drag & Drop
  const handleDragStart = (event: DragStartEvent) => {
    setActiveScript(event.active.data.current?.script || null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveScript(null);
    const { active, over } = event;
    if (!over) return;
    const script = (active.data.current as any)?.script;
    if (!script) return;

    const targetId = over.id as string;

    if (targetId === "pool") {
      unassignMut.mutate(script.id);
      return;
    }

    if (targetId.startsWith("slot:")) {
      // format: slot:{date}:{hh}:{mm}:{account}
      // e.g. slot:2026-04-01:10:00:profile_jennie
      const withoutPrefix = targetId.slice(5); // remove "slot:"
      const dateMatch = withoutPrefix.match(/^(\d{4}-\d{2}-\d{2}):([\d:]+):(.+)$/);
      if (!dateMatch) return;
      const [, date, time, account] = dateMatch;
      assignMut.mutate({ scriptId: script.id, date, time, account });
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleExpand = (id: string) => {
    setExpandedId(prev => prev === id ? null : id);
  };

  const clearSelection = () => setSelectedIds(new Set());

  const selectAll = (ids: string[]) => {
    setSelectedIds(prev => {
      const allSelected = ids.every(id => prev.has(id));
      if (allSelected) return new Set(); // deselect all
      return new Set([...prev, ...ids]);
    });
  };

  return (
    <DndContext
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      {/* ── Toolbar ── */}
      <Card className="p-3 mb-4">
        <div className="flex flex-wrap items-center gap-2">
          {/* Plan selector */}
          <select
            value={planId}
            onChange={e => setPlanId(e.target.value)}
            className="text-xs border rounded px-2 py-1.5 bg-background max-w-[230px]"
          >
            <option value="">— Tất cả (không filter plan) —</option>
            {(plans as any[]).map((p: any) => (
              <option key={p.id} value={p.id}>{p.title || p.id.slice(0, 20)}</option>
            ))}
          </select>

          <div className="h-4 w-px bg-border" />

          <Button size="sm" variant="outline" disabled={!planId || parseMut.isPending}
            onClick={() => parseMut.mutate()} title="Parse markdown table → tạo topic scripts">
            {parseMut.isPending ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            <span className="ml-1">Parse Plan</span>
          </Button>

          <Button size="sm" variant="outline" disabled={generateMut.isPending}
            onClick={() => generateMut.mutate(selectedIds.size > 0 ? [...selectedIds] : undefined)}
            title="Tạo cc_generation_jobs → batch_processor generate">
            {generateMut.isPending ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />}
            <span className="ml-1">{selectedIds.size > 0 ? `Generate ${selectedIds.size}` : "Generate"}</span>
          </Button>

          <Button size="sm" variant="outline" disabled={approveMut.isPending}
            onClick={() => approveMut.mutate(selectedIds.size > 0 ? [...selectedIds] : undefined)}
            title="Bulk approve bài draft">
            {approveMut.isPending ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle size={12} />}
            <span className="ml-1">{selectedIds.size > 0 ? `Duyệt ${selectedIds.size}` : "Duyệt"}</span>
          </Button>

          <Button size="sm" variant="outline"
            onClick={() => window.open("/api/ops/content-pipeline/execute/schedule_all", "_blank")}
            title="Lên lịch Meta Business Suite">
            <Rocket size={12} />
            <span className="ml-1">Lên Lịch MBS</span>
          </Button>

          <Button size="sm" disabled={!planId}
            onClick={() => setShowDelegate(true)}
            className="bg-violet-600 hover:bg-violet-700 text-white"
            title="CEO Agent tự động: generate → approve → schedule">
            <Bot size={12} />
            <span className="ml-1">Giao CEO Auto</span>
          </Button>

          <div className="flex items-center gap-1 ml-auto">
            <span className="text-xs text-muted-foreground">
              {plannerData?.total_assigned || 0} gán · {unassigned.length} chưa
            </span>
            <Button size="sm" variant="ghost" onClick={() => refetch()}>
              <RefreshCw size={12} className={isLoading ? "animate-spin" : ""} />
            </Button>
          </div>
        </div>

        {/* Progress bar */}
        {progress?.total > 0 && (
          <div className="flex items-center gap-2 flex-wrap text-[10px] mt-2 pt-2 border-t">
            <span className="font-medium text-muted-foreground">Tiến độ ({progress.total} bài):</span>
            {(["topic","generating","draft","review","approved","scheduled","published","failed"] as const).map(s =>
              (progress[s] || 0) > 0 ? (
                <span key={s} className={`px-1.5 py-0.5 rounded border ${STATUS_CFG[s]?.cls}`}>
                  {STATUS_CFG[s]?.label}: {progress[s]}
                </span>
              ) : null
            )}
          </div>
        )}
      </Card>

      <div className="flex gap-4">
        {/* ── Unassigned pool ── */}
        <UnassignedPool
          scripts={unassigned}
          expandedId={expandedId}
          onExpand={toggleExpand}
          selectedIds={selectedIds}
          onSelect={toggleSelect}
          onSelectAll={selectAll}
          onUpdate={(id, fields) => updateMut.mutate({ id, ...fields })}
        />

        {/* ── Calendar ── */}
        <div className="flex-1 min-w-0">
          {/* Week nav */}
          <div className="flex items-center justify-between mb-2">
            <Button size="sm" variant="outline" onClick={() => setWeekOffset(w => w - 1)}>
              <ChevronLeft size={14} />
            </Button>
            <span className="text-sm font-medium">
              Tuần {weekOffset === 0 ? "này" : weekOffset > 0 ? `+${weekOffset}` : weekOffset}
              <span className="text-muted-foreground text-xs ml-2">{fmtDate(start)} – {fmtDate(end)}</span>
            </span>
            <Button size="sm" variant="outline" onClick={() => setWeekOffset(w => w + 1)}>
              <ChevronRight size={14} />
            </Button>
          </div>

          {isLoading ? (
            <div className="flex justify-center py-16 text-muted-foreground"><Loader2 size={20} className="animate-spin" /></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="border-collapse text-xs" style={{ tableLayout: "fixed", width: "100%" }}>
                <colgroup>
                  <col style={{ width: "90px" }} />
                  <col style={{ width: "42px" }} />
                  {ACCOUNTS.map(() => <col key={Math.random()} />)}
                </colgroup>
                <thead>
                  <tr>
                    <th className="px-2 py-1.5 border border-border/40 bg-muted/30 text-left text-[10px] text-muted-foreground font-medium">Ngày</th>
                    <th className="px-1 py-1.5 border border-border/40 bg-muted/30 text-center text-[10px] text-muted-foreground font-medium">
                      <Clock size={10} className="inline" />
                    </th>
                    {ACCOUNTS.map(a => (
                      <th key={a.key} className={`px-2 py-1.5 border border-border/40 text-center text-[10px] font-semibold ${a.badge} rounded-none`}>
                        {a.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {weekDates.flatMap(date =>
                    TIME_SLOTS.map((time, ti) => {
                      const today = isToday(date);
                      return (
                        <tr key={`${date}-${time}`} className={ti === 0 && !today ? "border-t-2 border-t-border/50" : ""}>
                          {/* Date cell — rowspan 3 */}
                          {ti === 0 && (
                            <td rowSpan={3} className={`border border-border/40 px-2 py-1 align-top text-[10px] font-medium
                              ${today ? "bg-primary/10 text-primary" : "bg-muted/20 text-muted-foreground"}`}>
                              {fmtDate(date)}
                              {today && <div className="text-[8px] text-primary/60">Hôm nay</div>}
                            </td>
                          )}
                          {/* Time cell */}
                          <td className="border border-border/40 px-1 text-center text-[9px] text-muted-foreground bg-muted/10">
                            {time}
                          </td>
                          {/* Account slots */}
                          {ACCOUNTS.map(acc => {
                            const slotId = `slot:${date}:${time}:${acc.key}`;
                            const script = calendar[date]?.[acc.key]?.[time];
                            return (
                              <CalendarSlot
                                key={slotId}
                                slotId={slotId}
                                script={script}
                                selected={script && selectedIds.has(script.id)}
                                onSelect={toggleSelect}
                                expandedId={expandedId}
                                onExpand={toggleExpand}
                                onUpdate={(id, fields) => updateMut.mutate({ id, ...fields })}
                              />
                            );
                          })}
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* ── Floating multi-select bar ── */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-zinc-900 text-white px-4 py-2 rounded-xl shadow-xl flex items-center gap-3 z-50 text-sm">
          <span className="text-zinc-300">Đã chọn: <strong>{selectedIds.size}</strong></span>
          <Button size="sm" className="h-6 text-[11px] px-2 bg-zinc-700 hover:bg-zinc-600"
            onClick={() => selectAll(unassigned.map((s: any) => s.id))}
            title="Chọn tất cả chưa gán">
            <CheckSquare size={10} className="mr-1" /> Chọn tất cả
          </Button>
          <Button size="sm" className="h-6 text-[11px] px-2 bg-blue-600 hover:bg-blue-700"
            onClick={() => { generateMut.mutate([...selectedIds]); clearSelection(); }}>
            <FileText size={10} className="mr-1" /> Generate
          </Button>
          <Button size="sm" className="h-6 text-[11px] px-2 bg-emerald-600 hover:bg-emerald-700"
            onClick={() => { approveMut.mutate([...selectedIds]); clearSelection(); }}>
            <CheckCircle size={10} className="mr-1" /> Duyệt
          </Button>
          <Button size="sm" className="h-6 text-[11px] px-2 bg-red-600 hover:bg-red-700"
            onClick={async () => {
              if (await confirm({ title: `Xoá ${selectedIds.size} bài?`, body: "Không thể hoàn tác!", confirmLabel: "Xoá", destructive: true })) {
                deleteMut.mutate([...selectedIds]);
              }
            }}>
            <Trash2 size={10} className="mr-1" /> Xoá
          </Button>
          <button onClick={clearSelection} className="text-zinc-400 hover:text-white ml-1">
            <X size={14} />
          </button>
        </div>
      )}

      {/* ── Footer info ── */}
      <Card className="p-3 mt-4">
        <div className="grid grid-cols-3 gap-4 text-[10px] text-muted-foreground">
          <div>
            <div className="font-semibold text-foreground mb-1">3 Tài khoản</div>
            <div>👤 Profile Jennie — tinh_yeu, ritual, crystal, 7_ngay</div>
            <div>📘 Page Jennie — trieu_phu, trading_mindset, lifestyle</div>
            <div>📘 Page Gemral — trading_technical, app, education</div>
          </div>
          <div>
            <div className="font-semibold text-foreground mb-1">Workflow</div>
            <div>1. Parse Plan (markdown → topics)</div>
            <div>2. Kéo topics vào lịch</div>
            <div>3. Generate → batch_processor.py batch</div>
            <div>4. Review → Bulk Approve → Schedule MBS</div>
          </div>
          <div>
            <div className="font-semibold text-foreground mb-1 flex items-center gap-1">
              <AlertCircle size={9} /> Quy tắc quan trọng
            </div>
            <div className="text-amber-600 font-medium">Content PHẢI qua batch_processor.py batch</div>
            <div>Agent KHÔNG tự viết content</div>
            <div>Không đăng cùng pillar liên tiếp</div>
          </div>
        </div>
      </Card>

      {/* ── Drag overlay ── */}
      <DragOverlay>
        {activeScript && <ScriptCardPreview script={activeScript} />}
      </DragOverlay>

      {/* ── CEO Delegate modal ── */}
      {showDelegate && planId && (
        <DelegateModal planId={planId} onClose={() => setShowDelegate(false)} />
      )}
    </DndContext>
  );
}
