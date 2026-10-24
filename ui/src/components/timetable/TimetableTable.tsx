// Shared timetable table primitives — used by TimetableWidget (Dashboard)
// and the full /timetable page. Keeps rendering + row expansion + note
// save mutation in one place so P6–P10 features (sort/group/column
// reorder, smart search) only need to change one spot.

import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Copy, ExternalLink } from "lucide-react";
import { Link, useNavigate } from "@/lib/router";
import { useUpsertTimetableNote } from "@/hooks/useTimetable";
import type {
  TimetableRow,
  TimetableStatus,
  TimetableKind,
} from "@/types/timetable";
import {
  COLUMN_KEYS,
  COLUMN_LABELS,
  DEFAULT_VISIBLE_COLUMNS,
  type ColumnKey,
} from "@/lib/timetableFilters";

type VisibleColumns = ReadonlySet<ColumnKey>;

function defaultVisibleSet(): VisibleColumns {
  return new Set(DEFAULT_VISIBLE_COLUMNS);
}

// ─── Constants ─────────────────────────────────────────────────────────────

export const HCM_TZ = "Asia/Ho_Chi_Minh";

// ─── Helpers ───────────────────────────────────────────────────────────────

export function formatTimeHCM(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-GB", {
    timeZone: HCM_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

type KindMeta = { icon: string; label: string };
const KIND_META: Record<string, KindMeta> = {
  heartbeat: { icon: "💓", label: "Heartbeat" },
  task: { icon: "✅", label: "Task" },
  routine: { icon: "🔁", label: "Routine" },
  post: { icon: "📢", label: "Post" },
  reel: { icon: "🎬", label: "Reel" },
  email: { icon: "✉️", label: "Email" },
  push: { icon: "🔔", label: "Push" },
  reply: { icon: "💬", label: "Reply" },
  manual_task: { icon: "📌", label: "Manual" },
  meeting: { icon: "🗓", label: "Meeting" },
  reminder: { icon: "⏰", label: "Nhắc" },
  call: { icon: "📞", label: "Call" },
  test: { icon: "🧪", label: "Test" },
};

export function kindMeta(kind: TimetableKind | string): KindMeta {
  return KIND_META[kind] ?? { icon: "📎", label: kind };
}

type StatusMeta = { icon: string; label: string; className: string };
export const STATUS_META: Record<TimetableStatus, StatusMeta> = {
  done: {
    icon: "✅",
    label: "Done",
    className:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  },
  running: {
    icon: "🔵",
    label: "Running",
    className: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  },
  scheduled: {
    icon: "🟡",
    label: "Scheduled",
    className:
      "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  },
  failed: {
    icon: "❌",
    label: "Failed",
    className: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  },
  paused: {
    icon: "⏸",
    label: "Paused",
    className:
      "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-300",
  },
};

export function rowToCopyText(row: TimetableRow): string {
  const t = formatTimeHCM(row.startsAt);
  const agent = row.agent?.name ?? "—";
  const result = row.resultOverride ?? row.resultAuto ?? "—";
  return `${t} · ${agent} · ${row.title} · ${result}`;
}

function agentInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function agentColor(agentId: string | undefined): string {
  if (!agentId) return "oklch(60% 0.05 270)";
  let hash = 0;
  for (let i = 0; i < agentId.length; i += 1) hash = (hash * 31 + agentId.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return `oklch(60% 0.14 ${hue})`;
}

// ─── Cell subcomponents ────────────────────────────────────────────────────

export function getRowTargetUrl(row: TimetableRow): string | null {
  const issueIdentifier =
    (row.payload as any)?.identifier ||
    (typeof row.title === "string" ? row.title.match(/^([A-Z0-9]+-\d+)/)?.[1] : null);

  const issueRef = issueIdentifier || row.issueId || (row.sourceTable === "issues" ? row.sourceId : null);

  if (issueRef) {
    return `/issues/${issueRef}`;
  }
  if (
    (row.sourceTable === "heartbeat_runs" ||
      row.sourceTable === "routine_runs" ||
      row.sourceTable === "agent_task_sessions") &&
    row.agent
  ) {
    return `/agents/${row.agent.id}/runs/${row.sourceId}`;
  }
  if (row.sourceTable === "routine_triggers") {
    const routineId = (row.payload as any)?.routineId || row.sourceId;
    return `/routines/${routineId}`;
  }
  if (row.sourceTable === "cc_scripts") {
    return `/cc/scripts/${row.sourceId}`;
  }
  if (row.sourceTable === "cc_email_campaigns") {
    return `/cc/email/${row.sourceId}`;
  }
  if (row.sourceTable === "cc_social_posts") {
    return `/cc/calendar`;
  }
  if (row.sourceTable === "timetable_manual_rows") {
    return null;
  }
  if (row.agent) {
    return `/agents/${row.agent.id}`;
  }
  return null;
}

export function AgentCell({ row }: { row: TimetableRow }) {
  if (!row.agent) {
    return <span className="text-xs text-muted-foreground italic">— hệ thống —</span>;
  }

  const agentUrl = `/agents/${row.agent.id}`;

  return (
    <Link
      to={agentUrl}
      onClick={(e) => e.stopPropagation()}
      className="group inline-flex items-center gap-2 min-w-0 max-w-full rounded-md p-1 -m-1 hover:bg-accent/80 transition-colors"
      title={`Mở Agent Dashboard: ${row.agent.name} (Click chuột trái hoặc phải để mở)`}
    >
      <span
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white shadow-xs group-hover:ring-2 group-hover:ring-primary/40 transition-all"
        style={{ background: agentColor(row.agent.id) }}
        aria-hidden
      >
        {agentInitials(row.agent.name)}
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-xs font-medium group-hover:text-primary group-hover:underline">
          {row.agent.name}
        </span>
        <span
          className="truncate rounded border border-border bg-muted/40 px-1 py-px text-[10px] text-muted-foreground font-mono group-hover:border-primary/30"
          style={{ maxWidth: "120px" }}
          title={row.agent.model ?? ""}
        >
          {row.agent.model ?? "—"}
        </span>
      </span>
    </Link>
  );
}

export function StatusPill({
  status,
  extra,
}: {
  status: TimetableStatus;
  extra: string | null;
}) {
  const meta = STATUS_META[status] ?? STATUS_META.scheduled;
  return (
    <span className="flex flex-col gap-0.5 items-start">
      <span
        className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${meta.className}`}
        style={{ minWidth: "96px" }}
      >
        <span>{meta.icon}</span>
        <span className="truncate">{meta.label}</span>
      </span>
      <span className="text-[10px] text-muted-foreground font-mono">{extra ?? "—"}</span>
    </span>
  );
}

export function KindPill({ kind }: { kind: TimetableKind | string }) {
  const meta = kindMeta(kind);
  return (
    <span
      className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[11px]"
      style={{ minWidth: "84px" }}
      title={meta.label}
    >
      <span>{meta.icon}</span>
      <span className="truncate">{meta.label}</span>
    </span>
  );
}

// ─── Row detail panel ──────────────────────────────────────────────────────

export function RowDetail({
  row,
  companyId,
  onClose,
}: {
  row: TimetableRow;
  companyId: string;
  onClose: () => void;
}) {
  const mutation = useUpsertTimetableNote(companyId);
  const [result, setResult] = useState<string>(row.resultOverride ?? row.resultAuto ?? "");
  const [note, setNote] = useState<string>(row.note ?? "");
  const dirty =
    result !== (row.resultOverride ?? row.resultAuto ?? "") || note !== (row.note ?? "");

  const handleSave = () => {
    mutation.mutate(
      {
        sourceTable: row.sourceTable,
        sourceId: row.sourceId,
        resultOverride: result || null,
        note: note || null,
      },
      { onSuccess: () => onClose() },
    );
  };

  const payloadEntries = Object.entries(row.payload ?? {});

  return (
    <div className="border-t border-border bg-muted/30 p-4 text-xs grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <div className="mb-1 text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
          Chi tiết
        </div>
        {payloadEntries.length === 0 ? (
          <p className="italic text-muted-foreground">Không có payload.</p>
        ) : (
          <div className="rounded border border-border bg-background p-2 font-mono leading-5 max-h-48 overflow-auto">
            {payloadEntries.map(([key, val]) => (
              <div key={key} className="truncate">
                <span className="text-muted-foreground">{key}:</span>{" "}
                <span>{typeof val === "string" ? val : JSON.stringify(val)}</span>
              </div>
            ))}
          </div>
        )}
        <div className="mt-2 text-muted-foreground">
          source: <code>{row.sourceTable}</code> · id: <code className="break-all">{row.sourceId}</code>
        </div>
      </div>

      <div>
        <div className="mb-1 text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
          Sửa kết quả · ghi chú
        </div>
        <label className="mb-1 block text-[11px] text-muted-foreground">Kết quả (override default)</label>
        <input
          className="mb-2 w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
          value={result}
          onChange={(e) => setResult(e.target.value)}
          placeholder={row.resultAuto ?? ""}
          title="Override giá trị auto của hệ thống"
        />
        <label className="mb-1 block text-[11px] text-muted-foreground">Ghi chú</label>
        <textarea
          className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Thêm ghi chú cá nhân..."
        />
        <div className="mt-2 flex items-center justify-end gap-2">
          <button
            type="button"
            className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
            onClick={onClose}
            disabled={mutation.isPending}
          >
            Hủy
          </button>
          <button
            type="button"
            className="rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
            onClick={handleSave}
            disabled={!dirty || mutation.isPending}
          >
            {mutation.isPending ? "Đang lưu…" : "Lưu"}
          </button>
        </div>
        {mutation.isError && (
          <p className="mt-1 text-[11px] text-destructive">Lỗi khi lưu. Thử lại.</p>
        )}
        <p className="mt-2 italic text-[10px] text-muted-foreground">
          Mọi thay đổi ghi vào <code>activity_log</code> với <code>entityType=timetable_note</code>.
        </p>
      </div>
    </div>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────

export function TimetableTableRow({
  row,
  companyId,
  expanded,
  onToggle,
  visibleColumns,
  isNearest = false,
}: {
  row: TimetableRow;
  companyId: string;
  expanded: boolean;
  onToggle: () => void;
  visibleColumns?: VisibleColumns;
  isNearest?: boolean;
}) {
  const vis = visibleColumns ?? defaultVisibleSet();
  const time = formatTimeHCM(row.startsAt);
  const result = row.resultOverride ?? row.resultAuto;
  const note = row.note;

  // Per-cell expand state. Clicking a truncated cell toggles inline wrap;
  // stopPropagation keeps the row's onToggle (expand detail) from firing.
  // Click same cell again to collapse. Opening the row detail (or closing
  // it) also resets cell expansions via the effect below — so users get
  // consistent state without a fragile document-level listener.
  const [expandedCells, setExpandedCells] = useState<Set<ColumnKey>>(new Set());
  const navigate = useNavigate();
  const toggleCell = (col: ColumnKey, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedCells((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      return next;
    });
  };

  // Reset cell expansions whenever the row detail toggles. Keeps cell
  // state tied to row lifecycle — no stale expansions lingering.
  useEffect(() => {
    if (expandedCells.size > 0) setExpandedCells(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);
  const cellClass = (col: ColumnKey, baseMaxWidth: string) =>
    expandedCells.has(col)
      ? "whitespace-normal break-words cursor-pointer"
      : `${baseMaxWidth} truncate cursor-pointer`;

  // colSpan for the expanded detail row — count of visible data columns + 1
  // (actions column which is always present).
  const visibleColSpan = vis.size + 1;

  const targetUrl = getRowTargetUrl(row);

  const handleRowClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (
      target.closest("button") ||
      target.closest("a") ||
      target.closest("input") ||
      target.closest("textarea")
    ) {
      return;
    }

    if (targetUrl) {
      if (e.ctrlKey || e.metaKey) {
        window.open(targetUrl, "_blank");
      } else {
        navigate(targetUrl);
      }
    } else {
      onToggle();
    }
  };

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(rowToCopyText(row)).catch(() => {});
    }
  };

  return (
    <>
      <tr
        onClick={handleRowClick}
        className={`border-b border-border transition-colors cursor-pointer hover:bg-accent/50 ${
          isNearest
            ? "bg-amber-50/80 dark:bg-amber-950/30 border-l-2 border-l-amber-500"
            : ""
        }`}
        aria-expanded={expanded}
        aria-current={isNearest ? "time" : undefined}
        title={targetUrl ? `Xem chi tiết: ${row.title}` : isNearest ? "Gần thời gian hiện tại nhất" : undefined}
      >
        {vis.has("time") && (
          <td className="px-3 py-2 font-mono text-muted-foreground w-16">{time}</td>
        )}
        {vis.has("agent") && (
          <td className="px-3 py-2 w-44">
            <AgentCell row={row} />
          </td>
        )}
        {vis.has("kind") && (
          <td className="px-3 py-2 w-24">
            <KindPill kind={row.kind} />
          </td>
        )}
        {vis.has("title") && (
          <td className="px-3 py-2 w-40 align-top">
            <div
              className={cellClass("title", "max-w-[160px]")}
              title={expandedCells.has("title") ? "Click để thu gọn" : row.title}
              onClick={(e) => toggleCell("title", e)}
            >
              {row.title}
            </div>
          </td>
        )}
        {vis.has("description") && (
          <td className="px-3 py-2 text-muted-foreground align-top min-w-[140px] max-w-[200px]">
            <div
              className={cellClass("description", "max-w-[200px]")}
              title={expandedCells.has("description") ? "Click để thu gọn" : row.description}
              onClick={(e) => toggleCell("description", e)}
            >
              {row.description || "—"}
            </div>
          </td>
        )}
        {vis.has("status") && (
          <td className="px-3 py-2 w-32">
            <div
              className={`inline-flex ${row.sourceTable !== "timetable_manual_rows" ? "cursor-pointer hover:opacity-80" : ""}`}
              onClick={(e) => {
                if (row.sourceTable === "timetable_manual_rows") return;
                e.stopPropagation();
                const target = getRowTargetUrl(row);
                if (target) navigate(target);
              }}
              title={row.sourceTable !== "timetable_manual_rows" ? "Xem chi tiết" : undefined}
            >
              <StatusPill status={row.status} extra={row.statusExtra} />
            </div>
          </td>
        )}
        {vis.has("result") && (
          <td className="px-3 py-2 text-muted-foreground align-top min-w-[120px] max-w-[180px]">
            {result ? (
              <div
                className={cellClass("result", "max-w-[180px]")}
                title={expandedCells.has("result") ? "Click để thu gọn" : result}
                onClick={(e) => toggleCell("result", e)}
              >
                {result}
              </div>
            ) : (
              <span className="italic">— chưa có —</span>
            )}
          </td>
        )}
        {vis.has("note") && (
          <td className="px-3 py-2 text-muted-foreground align-top min-w-[120px] max-w-[180px]">
            {note ? (
              <div
                className={cellClass("note", "max-w-[180px]")}
                title={expandedCells.has("note") ? "Click để thu gọn" : note}
                onClick={(e) => toggleCell("note", e)}
              >
                {note}
              </div>
            ) : (
              <span className="italic">— chưa ghi —</span>
            )}
          </td>
        )}
        <td className="px-3 py-2 w-16 text-right">
          <span className="inline-flex items-center gap-1">
            {targetUrl && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (e.ctrlKey || e.metaKey) {
                    window.open(targetUrl, "_blank");
                  } else {
                    navigate(targetUrl);
                  }
                }}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-primary transition-colors"
                title="Mở trang chi tiết"
                aria-label="Mở trang chi tiết"
              >
                <ExternalLink size={12} />
              </button>
            )}
            <button
              type="button"
              onClick={handleCopy}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Copy cả dòng thành text (giờ · agent · việc · kết quả)"
              aria-label="Copy row"
            >
              <Copy size={12} />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              title={expanded ? "Thu gọn chi tiết" : "Mở chi tiết · sửa note/kết quả"}
              aria-label={expanded ? "Thu gọn chi tiết dòng" : "Mở chi tiết dòng"}
            >
              <ChevronRight
                size={14}
                className={`transition-transform ${expanded ? "rotate-90" : ""}`}
                aria-hidden
              />
            </button>
          </span>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={visibleColSpan} className="p-0">
            <RowDetail row={row} companyId={companyId} onClose={onToggle} />
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Table ─────────────────────────────────────────────────────────────────

// Column widths tuned so all 9 columns fit a 960-1200px table without
// horizontal scroll on Dashboard widget and /timetable page. Each text
// cell below wraps content in a truncate div — clicking the cell toggles
// inline wrap (stopPropagation prevents row expansion).
const COLUMN_CLASS: Record<ColumnKey, string> = {
  time: "w-14",
  agent: "w-40",
  kind: "w-24",
  title: "w-40",
  description: "min-w-[140px] max-w-[200px]",
  status: "w-28",
  result: "min-w-[120px] max-w-[180px]",
  note: "min-w-[120px] max-w-[180px]",
};

// Pick the row whose startsAt is closest to NOW. Used to highlight the
// "current" row in the today timetable so the user can spot what's
// happening now without scanning timestamps. Re-runs whenever rows or
// the now-tick changes; ties go to the first row encountered (stable).
function useNearestRowId(rows: TimetableRow[]): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return useMemo(() => {
    if (!rows.length) return null;
    let bestId: string | null = null;
    let bestDelta = Infinity;
    for (const r of rows) {
      const t = new Date(r.startsAt).getTime();
      if (Number.isNaN(t)) continue;
      const delta = Math.abs(t - now);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestId = r.id;
      }
    }
    return bestId;
  }, [rows, now]);
}

export function TimetableTable({
  rows,
  companyId,
  expanded,
  onToggleRow,
  visibleColumns,
  minWidth = 960,
}: {
  rows: TimetableRow[];
  companyId: string;
  expanded: Record<string, boolean>;
  onToggleRow: (id: string) => void;
  visibleColumns?: VisibleColumns;
  minWidth?: number;
}) {
  const vis = visibleColumns ?? defaultVisibleSet();
  const nearestId = useNearestRowId(rows);
  return (
    <>
      {/* Mobile: card list — 9-col table is unreadable under 640px. */}
      <div className="lg:hidden">
        {rows.map((row) => (
          <TimetableCardRow
            key={row.id}
            row={row}
            companyId={companyId}
            expanded={!!expanded[row.id]}
            onToggle={() => onToggleRow(row.id)}
            isNearest={row.id === nearestId}
          />
        ))}
      </div>

      {/* Desktop: full table. */}
      <table
        className="hidden w-full text-sm lg:table"
        style={{ minWidth: `${minWidth}px` }}
      >
        <thead className="bg-slate-100 dark:bg-slate-800/80 text-[11px] uppercase tracking-wider text-slate-700 dark:text-slate-200 border-b-2 border-border">
          <tr className="text-left">
            {COLUMN_KEYS.map((key) =>
              vis.has(key) ? (
                <th key={key} className={`px-3 py-2 font-semibold ${COLUMN_CLASS[key]}`}>
                  {COLUMN_LABELS[key]}
                </th>
              ) : null,
            )}
            <th className="px-3 py-2 w-14 font-semibold" aria-label="Hành động" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <TimetableTableRow
              key={row.id}
              row={row}
              companyId={companyId}
              expanded={!!expanded[row.id]}
              onToggle={() => onToggleRow(row.id)}
              visibleColumns={vis}
              isNearest={row.id === nearestId}
            />
          ))}
        </tbody>
      </table>
    </>
  );
}

// ─── Mobile card row ───────────────────────────────────────────────────────

function TimetableCardRow({
  row,
  companyId,
  expanded,
  onToggle,
  isNearest = false,
}: {
  row: TimetableRow;
  companyId: string;
  expanded: boolean;
  onToggle: () => void;
  isNearest?: boolean;
}) {
  const time = formatTimeHCM(row.startsAt);
  const result = row.resultOverride ?? row.resultAuto;
  const note = row.note;
  const navigate = useNavigate();

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(rowToCopyText(row)).catch(() => {});
    }
  };

  return (
    <div
      className={`border-b border-border last:border-b-0 ${
        isNearest ? "bg-amber-50 dark:bg-amber-950/30 border-l-2 border-l-amber-500" : ""
      }`}
      aria-current={isNearest ? "time" : undefined}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full flex-col gap-1.5 px-4 py-3 text-left hover:bg-accent/40"
        title={isNearest ? "Gần thời gian hiện tại nhất" : undefined}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{time}</span>
            <KindPill kind={row.kind} />
          </div>
          <div
            className={row.sourceTable !== "timetable_manual_rows" ? "cursor-pointer hover:opacity-80" : ""}
            onClick={(e) => {
              if (row.sourceTable === "timetable_manual_rows") return;
              e.stopPropagation();
              const target = getRowTargetUrl(row);
              if (target) navigate(target);
            }}
          >
            <StatusPill status={row.status} extra={row.statusExtra} />
          </div>
        </div>

        <div className="flex items-start gap-2 min-w-0">
          <div className="flex-1 min-w-0">
            <div className="truncate font-medium text-sm">{row.title}</div>
            {row.description && (
              <div className="truncate text-xs text-muted-foreground">{row.description}</div>
            )}
            {row.agent && (
              <div className="mt-1">
                <AgentCell row={row} />
              </div>
            )}
            {result && (
              <div className="mt-1 text-xs">
                <span className="text-muted-foreground">Kết quả: </span>
                <span className="text-foreground">{result}</span>
              </div>
            )}
            {note && (
              <div className="text-xs">
                <span className="text-muted-foreground">Ghi chú: </span>
                <span className="italic text-foreground/80">{note}</span>
              </div>
            )}
          </div>
          <div className="flex flex-col items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={handleCopy}
              className="rounded p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Copy dòng"
              aria-label="Copy"
            >
              <Copy size={14} />
            </button>
            <ChevronRight
              size={16}
              className={`text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
              aria-hidden
            />
          </div>
        </div>
      </button>
      {expanded && <RowDetail row={row} companyId={companyId} onClose={onToggle} />}
    </div>
  );
}
