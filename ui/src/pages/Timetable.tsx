// Full /timetable page. 3 tabs: Lịch hôm nay (data) · Lịch sử thay đổi
// (audit, P6 wiring) · Sắp tới 3 ngày (P6 wiring). Today tab reuses shared
// TimetableTable so widget + page stay in lock-step.

import { useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  RotateCw,
  Plus,
} from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useTimetable } from "../hooks/useTimetable";
import { HCM_TZ, TimetableTable } from "../components/timetable/TimetableTable";
import { TimetableAuditTab } from "../components/timetable/TimetableAuditTab";
import { TimetableUpcomingTab } from "../components/timetable/TimetableUpcomingTab";
import { AddManualRowModal } from "../components/timetable/AddManualRowModal";
import { SortMenu, GroupMenu, ColumnMenu, FilterMenu } from "../components/timetable/TimetableMenus";
import { SmartSearch } from "../components/timetable/SmartSearch";
import { EmptyState } from "../components/EmptyState";
import type { TimetableKpis, TimetableSort, TimetableGroup } from "../types/timetable";
import {
  sortRows,
  groupRows,
  parseQuery,
  applyQuery,
  pushRecentSearch,
  loadVisibleColumns,
  saveVisibleColumns,
  loadSavedQuery,
  saveQuery,
  type ColumnKey,
} from "../lib/timetableFilters";

// ─── Date helpers (HCM) ───────────────────────────────────────────────────

function todayHCM(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: HCM_TZ });
}

function shiftDay(date: string, days: number): string {
  const parts = date.split("-").map(Number);
  const [y, m, d] = parts;
  if (parts.length !== 3 || !Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return todayHCM();
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(dt.getTime())) return todayHCM();
  dt.setUTCDate(dt.getUTCDate() + days);
  return Number.isNaN(dt.getTime()) ? todayHCM() : dt.toISOString().slice(0, 10);
}

function formatDateLabel(date: string): string {
  const parts = date.split("-").map(Number);
  const [y, m, d] = parts;
  if (parts.length !== 3 || !Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return date || "—";
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(dt.getTime())) return date || "—";
  const weekday = dt.toLocaleDateString("vi-VN", { timeZone: "UTC", weekday: "long" });
  const dmy = dt.toLocaleDateString("vi-VN", {
    timeZone: "UTC",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  // Capitalize first letter of weekday for consistency with VN format
  const weekdayCap = weekday.charAt(0).toUpperCase() + weekday.slice(1);
  return `${weekdayCap}, ${dmy}`;
}

function isToday(date: string): boolean {
  return date === todayHCM();
}

// ─── KPI row ──────────────────────────────────────────────────────────────

const KPI_SPEC: Array<{
  key: keyof TimetableKpis;
  label: string;
  className: string;
}> = [
  { key: "total", label: "Tổng", className: "border-border bg-card" },
  { key: "done", label: "Done", className: "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/60" },
  { key: "running", label: "Running", className: "border-sky-200 bg-sky-50 dark:border-sky-900 dark:bg-sky-950/60" },
  { key: "scheduled", label: "Scheduled", className: "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/60" },
  { key: "failed", label: "Failed", className: "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/60" },
];

function KpiRow({ kpis }: { kpis: TimetableKpis | undefined }) {
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
      {KPI_SPEC.map(({ key, label, className }) => (
        <div key={key} className={`rounded-lg border p-3 ${className}`}>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
          <div className="text-2xl font-semibold tabular-nums">
            {kpis ? kpis[key] : "—"}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Tabs ─────────────────────────────────────────────────────────────────

type TabKey = "today" | "audit" | "upcoming";

function TabBar({
  current,
  onChange,
  todayCount,
}: {
  current: TabKey;
  onChange: (t: TabKey) => void;
  todayCount: number;
}) {
  const tabs: Array<{ key: TabKey; label: string; badge?: string; hint: string }> = [
    { key: "today", label: "Lịch hôm nay", badge: todayCount ? String(todayCount) : undefined, hint: `${todayCount} dòng lịch trong ngày` },
    { key: "audit", label: "Lịch sử thay đổi", hint: "Audit log của các edit ghi chú/kết quả (Phase 6)" },
    { key: "upcoming", label: "Sắp tới (3 ngày)", hint: "Lịch của 3 ngày kế tiếp (Phase 6)" },
  ];
  return (
    <div className="border-b border-border" role="tablist">
      <div className="flex flex-wrap items-center gap-1 px-1">
        {tabs.map((t) => {
          const active = t.key === current;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(t.key)}
              title={t.hint}
              className={`flex items-center gap-1.5 rounded-t px-3 py-2 text-sm transition-colors ${
                active
                  ? "border-b-2 border-primary text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <span>{t.label}</span>
              {t.badge && (
                <span className="rounded bg-muted/40 px-1.5 py-0.5 text-[11px] font-medium">
                  {t.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * @archetype list
 * @capability-skip pagination: lịch theo từng ngày nên không phân trang
 * @capability-skip delete-confirm: xem/lọc dòng lịch, thao tác sửa nằm ở tab/modal con
 * @capability-skip bulk-actions: lịch theo dõi vận hành không xóa hàng loạt
 */
export function Timetable() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const companyId = selectedCompanyId ?? "";

  const [date, setDate] = useState<string>(todayHCM());
  const [tab, setTab] = useState<TabKey>("today");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [addOpen, setAddOpen] = useState(false);
  const [sort, setSort] = useState<TimetableSort>({ field: "time", dir: "asc" });
  const [group, setGroup] = useState<TimetableGroup>("none");
  const [visibleColumns, setVisibleColumns] = useState<ColumnKey[]>(() => loadVisibleColumns());
  const [query, setQuery] = useState(() => loadSavedQuery());

  useEffect(() => {
    saveVisibleColumns(visibleColumns);
  }, [visibleColumns]);

  useEffect(() => {
    saveQuery(query);
  }, [query]);

  useEffect(() => {
    if (!query.trim()) return;
    const t = window.setTimeout(() => pushRecentSearch(query.trim()), 700);
    return () => window.clearTimeout(t);
  }, [query]);

  const visibleSet = useMemo(() => new Set(visibleColumns), [visibleColumns]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Lịch hôm nay" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error, refetch, isFetching, dataUpdatedAt } = useTimetable(
    companyId,
    { date },
  );
  const rows = data?.rows ?? [];

  const parsed = useMemo(() => parseQuery(query), [query]);
  const filteredRows = useMemo(() => applyQuery(rows, parsed), [rows, parsed]);

  const processedSections = useMemo(() => {
    const sorted = sortRows(filteredRows, sort);
    return groupRows(sorted, group);
  }, [filteredRows, sort, group]);

  // Reset expanded when date switches so rows from prior day don't linger
  useEffect(() => {
    setExpanded({});
  }, [date]);

  // Keyboard shortcuts: T = today, ← = prev day, → = next day.
  // Ignore when user is typing in an input/textarea.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement | null)?.isContentEditable) {
        return;
      }
      if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        setDate(todayHCM());
      } else if (e.key === "ArrowLeft") {
        setDate((d) => shiftDay(d, -1));
      } else if (e.key === "ArrowRight") {
        setDate((d) => shiftDay(d, 1));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const toggleRow = (id: string) => setExpanded((p) => ({ ...p, [id]: !p[id] }));

  const lastUpdated = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString("en-GB", {
        timeZone: HCM_TZ,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
    : "—";

  const dateLabel = useMemo(() => formatDateLabel(date), [date]);

  if (!companyId) {
    return (
      <EmptyState icon={CalendarDays} message="Chọn company để xem lịch." />
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <CalendarDays className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">Lịch hôm nay</h1>
          <span className="inline-flex items-center gap-1 rounded bg-sky-100 px-1.5 py-0.5 text-[11px] text-sky-800 dark:bg-sky-950 dark:text-sky-300">
            <RotateCw size={10} className={isFetching ? "animate-spin" : ""} aria-hidden />
            <span>30s</span>
          </span>
        </div>

        {/* Date navigation */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setDate((d) => shiftDay(d, -1))}
            className="inline-flex min-h-[36px] min-w-[36px] sm:min-h-[32px] sm:min-w-[32px] items-center justify-center rounded border border-border p-1.5 text-muted-foreground hover:bg-accent"
            title="Hôm trước (phím ←)"
            aria-label="Hôm trước"
          >
            <ChevronLeft size={14} aria-hidden="true" />
          </button>
          <input
            type="date"
            className="min-h-[36px] sm:min-h-[32px] rounded border border-border bg-background px-2 py-1 text-base sm:text-sm"
            value={date}
            onChange={(e) => setDate(e.target.value || todayHCM())}
            aria-label="Chọn ngày"
            onClick={(e) => {
              if ('showPicker' in HTMLInputElement.prototype) {
                try {
                  (e.target as HTMLInputElement).showPicker();
                } catch (err) {}
              }
            }}
          />
          <button
            type="button"
            onClick={() => setDate((d) => shiftDay(d, 1))}
            className="inline-flex min-h-[36px] min-w-[36px] sm:min-h-[32px] sm:min-w-[32px] items-center justify-center rounded border border-border p-1.5 text-muted-foreground hover:bg-accent"
            title="Hôm sau (phím →)"
            aria-label="Hôm sau"
          >
            <ChevronRight size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setDate(todayHCM())}
            disabled={isToday(date)}
            className="min-h-[36px] sm:min-h-[32px] rounded border border-border px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-40"
            title="Về hôm nay (phím T)"
          >
            Hôm nay
          </button>
          <span className="ml-2 text-xs text-muted-foreground">{dateLabel}</span>
        </div>
      </div>

      {/* KPI row */}
      <KpiRow kpis={data?.kpis} />

      {/* Card */}
      <div className="rounded-lg border border-border bg-card">
        <TabBar current={tab} onChange={setTab} todayCount={rows.length} />

        {/* Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
          <div className="flex flex-wrap items-center gap-1">
            <SortMenu sort={sort} onChange={setSort} />
            <GroupMenu group={group} onChange={setGroup} />
            <ColumnMenu visibleColumns={visibleColumns} onChange={setVisibleColumns} />
            <FilterMenu query={query} onQueryChange={setQuery} />
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="inline-flex min-h-[36px] sm:min-h-[28px] items-center gap-1 rounded px-2.5 py-1.5 text-xs hover:bg-accent sm:py-1"
              title="Thêm dòng thủ công cho ngày đang xem"
            >
              <Plus size={12} aria-hidden="true" />
              <span>Thêm dòng</span>
            </button>
          </div>
          <span className="text-xs text-muted-foreground">
            Cập nhật: <span className="tabular-nums">{lastUpdated}</span>
          </span>
        </div>

        {/* Smart search */}
        <div className="border-b border-border px-4 py-2">
          <SmartSearch value={query} onChange={setQuery} companyId={companyId} />
        </div>

        {/* Tab body */}
        {tab === "today" && (
          <div className="overflow-x-auto">
            {isLoading ? (
              <div className="px-4 py-16 text-center text-sm text-muted-foreground">Đang tải lịch…</div>
            ) : error ? (
              <div role="alert" className="flex flex-col items-center gap-3 px-4 py-12 text-center text-sm text-destructive">
                <span>Lỗi tải lịch: {(error as Error).message || "unknown"}</span>
                <button
                  type="button"
                  onClick={() => refetch()}
                  className="min-h-[36px] rounded-md border border-destructive/40 px-3 py-1.5 text-xs font-medium hover:bg-destructive/10"
                >
                  Thử lại
                </button>
              </div>
            ) : rows.length === 0 ? (
              <div className="px-4 py-16 text-center text-sm text-muted-foreground">
                Không có lịch cho {dateLabel}.
              </div>
            ) : filteredRows.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-14 text-center text-sm text-muted-foreground">
                <span>
                  Không có dòng nào khớp với <code className="rounded bg-muted/40 px-1">{query}</code>.
                </span>
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="min-h-[36px] rounded border border-border px-3 py-1 text-xs font-medium text-foreground hover:bg-accent"
                >
                  Xoá filter
                </button>
              </div>
            ) : (
              <div>
                {processedSections.map((section) => (
                  <div key={section.key}>
                    {section.label && (
                      <div className="flex items-center justify-between bg-muted/40 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        <span>{section.label}</span>
                        <span>{section.rows.length} dòng</span>
                      </div>
                    )}
                    <TimetableTable
                      rows={section.rows}
                      companyId={companyId}
                      expanded={expanded}
                      onToggleRow={toggleRow}
                      visibleColumns={visibleSet}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "audit" && <TimetableAuditTab companyId={companyId} />}

        {tab === "upcoming" && <TimetableUpcomingTab companyId={companyId} />}
      </div>

      <AddManualRowModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        companyId={companyId}
        defaultDate={date}
      />

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          Phím tắt: <kbd className="rounded border border-border px-1">T</kbd> về hôm nay ·
          {" "}<kbd className="rounded border border-border px-1">←</kbd>/<kbd className="rounded border border-border px-1">→</kbd> đổi ngày
        </span>
        <span>
          Source: <code>heartbeat_runs</code>, <code>issues</code>, <code>routine_runs</code>, <code>timetable_manual_rows</code>
        </span>
      </div>
    </div>
  );
}

export default Timetable;
