// Tool Audit Log — danh sách mọi tool call (verify_customer, lookup_order,
// create_ticket, send_email, ...) mà các agent đã thực hiện. Cho phép filter
// theo agent / tool / success status để debug, audit và compliance.
//
// Backend endpoint: GET /api/training/audit-log
// Source code: paperclip/server/src/training/training-routes.ts

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Wrench,
  CheckCircle,
  XCircle,
  RefreshCw,
  Filter,
  Search,
} from "lucide-react";
import { trainingApi, type ToolAuditEntry } from "@/api/training";

const TOOL_OPTIONS = [
  { value: "", label: "Tất cả tools" },
  { value: "verify_customer_identity", label: "verify_customer_identity" },
  { value: "lookup_order_shopify", label: "lookup_order_shopify" },
  { value: "get_customer_info", label: "get_customer_info" },
  { value: "check_course_access", label: "check_course_access" },
  { value: "create_order", label: "create_order" },
  { value: "create_ticket", label: "create_ticket" },
  { value: "send_email", label: "send_email" },
  { value: "search_product", label: "search_product" },
  { value: "search_knowledge", label: "search_knowledge" },
  { value: "recall_memory", label: "recall_memory" },
  { value: "kg_lookup_entity", label: "kg_lookup_entity" },
  { value: "kg_traverse", label: "kg_traverse" },
  { value: "crm_update", label: "crm_update" },
  { value: "link_gemral_account", label: "link_gemral_account" },
];

const STATUS_OPTIONS = [
  { value: "", label: "Tất cả" },
  { value: "true", label: "Thành công" },
  { value: "false", label: "Lỗi" },
];

function timeAgo(d: string): string {
  if (!d) return "—";
  const ms = Date.now() - new Date(d).getTime();
  if (Number.isNaN(ms)) return "—";
  if (ms < 0) return "vừa xong";
  if (ms < 60_000) return Math.round(ms / 1_000) + "s trước";
  if (ms < 3_600_000) return Math.round(ms / 60_000) + " phút trước";
  if (ms < 86_400_000) return Math.round(ms / 3_600_000) + " giờ trước";
  return Math.round(ms / 86_400_000) + " ngày trước";
}

function formatArgs(args: unknown): string {
  if (!args) return "{}";
  try {
    const json = typeof args === "string" ? args : JSON.stringify(args);
    return json.length > 80 ? json.slice(0, 77) + "..." : json;
  } catch {
    return String(args);
  }
}

export function ToolAuditLogPage() {
  const [agentFilter, setAgentFilter] = useState<string>("");
  const [toolFilter, setToolFilter] = useState<string>("");
  const [successFilter, setSuccessFilter] = useState<"" | "true" | "false">("");

  const { data: entries = [], isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["training", "audit-log", agentFilter, toolFilter, successFilter],
    queryFn: () =>
      trainingApi.listAuditLog({
        agent: agentFilter || undefined,
        tool: toolFilter || undefined,
        success: successFilter || undefined,
        limit: 200,
      }),
    refetchInterval: 10_000,
  });

  const hasActiveFilter = Boolean(agentFilter || toolFilter || successFilter);

  return (
    <div className="min-h-[calc(100vh-48px)] bg-background p-4 sm:p-5 text-foreground">
      {/* Header */}
      <div className="mb-4">
        <h1 className="text-[20px] font-bold text-foreground mb-1">Tool Audit Log</h1>
        <p className="text-[12px] text-muted-foreground">
          Mọi tool call agent thực hiện (verify customer, lookup order, create ticket...).
          Audit + debug + compliance trail cho từng action.
        </p>
      </div>

      {/* Filters */}
      <div className="rounded-xl border border-border bg-card p-3.5 mb-4 flex items-center gap-3 flex-wrap">
        <Filter size={14} className="text-muted-foreground" aria-hidden="true" />

        <div className="flex items-center gap-2">
          <label htmlFor="audit-agent-filter" className="text-[11px] font-semibold text-muted-foreground uppercase">Agent</label>
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input
              id="audit-agent-filter"
              aria-label="Lọc theo agent"
              type="text"
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value)}
              placeholder="sales-closer"
              className="h-9 sm:h-8 w-44 pl-7 pr-2.5 text-base sm:text-xs bg-background border border-input rounded-lg text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none transition-colors"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="audit-tool-filter" className="text-[11px] font-semibold text-muted-foreground uppercase">Tool</label>
          <select
            id="audit-tool-filter"
            aria-label="Lọc theo tool"
            value={toolFilter}
            onChange={(e) => setToolFilter(e.target.value)}
            className="h-9 sm:h-8 px-2.5 text-base sm:text-xs bg-background border border-input rounded-lg text-foreground focus:border-primary focus:outline-none"
          >
            {TOOL_OPTIONS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="audit-status-filter" className="text-[11px] font-semibold text-muted-foreground uppercase">Trạng thái</label>
          <select
            id="audit-status-filter"
            aria-label="Lọc theo trạng thái"
            value={successFilter}
            onChange={(e) => setSuccessFilter(e.target.value as "" | "true" | "false")}
            className="h-9 sm:h-8 px-2.5 text-base sm:text-xs bg-background border border-input rounded-lg text-foreground focus:border-primary focus:outline-none"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        {hasActiveFilter && (
          <button
            type="button"
            onClick={() => {
              setAgentFilter("");
              setToolFilter("");
              setSuccessFilter("");
            }}
            className="h-9 sm:h-8 px-2.5 text-xs font-medium rounded-md border border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            Xoá lọc
          </button>
        )}

        <div className="flex-1" />

        <span className="text-[11px] text-muted-foreground tabular-nums">{entries.length} bản ghi</span>

        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="h-9 sm:h-8 px-3 text-[11px] font-semibold rounded-md border border-border bg-background text-foreground hover:bg-accent transition-colors cursor-pointer inline-flex items-center gap-1.5 disabled:opacity-50"
        >
          <RefreshCw size={12} className={isFetching ? "animate-spin" : ""} aria-hidden="true" />
          Refresh
        </button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr>
              <th scope="col" className="text-left p-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border whitespace-nowrap">
                Thời gian
              </th>
              <th scope="col" className="text-left p-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border whitespace-nowrap">
                Agent
              </th>
              <th scope="col" className="text-left p-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border whitespace-nowrap">
                Tool
              </th>
              <th scope="col" className="text-left p-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border">
                Args
              </th>
              <th scope="col" className="text-left p-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border">
                Result
              </th>
              <th scope="col" className="text-center p-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border whitespace-nowrap">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={6} className="text-center py-10 text-muted-foreground text-[12px]">
                  Đang tải...
                </td>
              </tr>
            )}
            {!isLoading && isError && (
              <tr>
                <td colSpan={6} className="text-center py-10 px-4">
                  <div role="alert" className="inline-flex flex-col items-center gap-2 text-sm text-destructive">
                    <span>Không thể tải tool audit log: {(error as Error)?.message || "Lỗi kết nối"}</span>
                    <button
                      type="button"
                      onClick={() => refetch()}
                      className="min-h-[36px] rounded-md border border-destructive/40 px-3 py-1.5 text-xs font-medium hover:bg-destructive/10"
                    >
                      Thử lại
                    </button>
                  </div>
                </td>
              </tr>
            )}
            {!isLoading && !isError && entries.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center py-10">
                  <Wrench size={32} className="mx-auto mb-2 text-muted-foreground/30" aria-hidden="true" />
                  <div className="text-[14px] text-muted-foreground">
                    {hasActiveFilter ? "Không có tool call khớp bộ lọc" : "Chưa có tool call nào"}
                  </div>
                  <div className="text-[12px] text-muted-foreground/70 mt-1">
                    {hasActiveFilter
                      ? "Thử thay đổi hoặc xoá bộ lọc để xem thêm."
                      : "Khi agent gọi tool, nó sẽ xuất hiện ở đây"}
                  </div>
                </td>
              </tr>
            )}
            {entries.map((entry) => (
              <AuditRow key={entry.id} entry={entry} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface AuditRowProps {
  entry: ToolAuditEntry;
}

function AuditRow({ entry }: AuditRowProps) {
  return (
    <tr className="hover:[&>td]:bg-muted/30">
      <td className="p-2.5 text-muted-foreground border-b border-border/50 align-middle whitespace-nowrap tabular-nums">
        {timeAgo(entry.ts)}
      </td>
      <td className="p-2.5 border-b border-border/50 align-middle whitespace-nowrap">
        <span className="inline-flex items-center h-[22px] px-2 text-[10px] font-semibold rounded bg-indigo-500/10 text-indigo-700 dark:text-indigo-300">
          {entry.agent_slug}
        </span>
      </td>
      <td className="p-2.5 border-b border-border/50 align-middle whitespace-nowrap">
        <span className="text-amber-700 dark:text-amber-400 font-semibold text-[12px]">{entry.tool_name}</span>
      </td>
      <td className="p-2.5 text-muted-foreground border-b border-border/50 align-middle font-mono text-[11px]">
        {formatArgs(entry.args)}
      </td>
      <td className="p-2.5 text-muted-foreground border-b border-border/50 align-middle">
        {entry.error ? (
          <span className="text-red-600 dark:text-red-400 text-[11px]">{entry.error.slice(0, 80)}</span>
        ) : (
          <span className="text-muted-foreground text-[11px]">{entry.result_summary || "—"}</span>
        )}
      </td>
      <td className="p-2.5 border-b border-border/50 align-middle text-center">
        {entry.success ? (
          <CheckCircle size={14} className="text-emerald-600 dark:text-emerald-400 mx-auto" aria-label="Thành công" />
        ) : (
          <XCircle size={14} className="text-red-600 dark:text-red-400 mx-auto" aria-label="Lỗi" />
        )}
      </td>
    </tr>
  );
}
