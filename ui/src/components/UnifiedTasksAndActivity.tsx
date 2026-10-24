import { useState, useMemo } from "react";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { heartbeatsApi, type LiveRunForIssue } from "@/api/heartbeats";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import type { Issue, ActivityEvent, Agent, Project } from "@paperclipai/shared";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { Identity } from "./Identity";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Layers,
  Activity,
  ArrowUpRight,
  Search,
  Bot,
  FileText,
  Clock,
  Sparkles,
  MessageSquare,
  CheckCircle2,
  AlertCircle,
  ChevronRight,
  ListTodo,
  HeartPulse,
  Eye,
  Lock,
  Paperclip,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Filter,
  RotateCcw,
  X,
} from "lucide-react";

interface UnifiedTasksAndActivityProps {
  companyId: string;
  issues: Issue[] | undefined;
  activity: ActivityEvent[] | undefined;
  agents: Agent[] | undefined;
  projects: Project[] | undefined;
  animatedActivityIds: Set<string>;
}

// ─── Kiểu dữ liệu Sort & Filter ──────────────────────────────────────────

type SortField = "default" | "identifier" | "status" | "title" | "agent" | "activity" | "updated";
type SortOrder = "asc" | "desc";

// ─── Helpers định dạng & Việt hóa ──────────────────────────────────────────

function formatViDateTime(date: Date | string): string {
  const d = new Date(date);
  return d.toLocaleString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function formatViTimeAgo(date: Date | string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.round((now - then) / 1000);

  if (seconds < 60) return "vừa xong";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} phút trước`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} giờ trước`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} ngày trước`;
  return new Date(date).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });
}

/**
 * Rút gọn tên model để hiển thị trong badge nhỏ gọn, không bao giờ bị vỡ dòng
 */
function formatModelShort(rawModel: string | null | undefined): string {
  if (!rawModel) return "";
  const m = String(rawModel)
    .replace(/^anthropic\//i, "")
    .replace(/^openai\//i, "")
    .replace(/^google\//i, "")
    .replace(/^gemini\//i, "")
    .replace(/\(High\)/i, "")
    .replace(/\(Low\)/i, "")
    .replace(/\(Medium\)/i, "")
    .replace(/latest/i, "")
    .trim();

  if (/gemini.*3\.8.*flash/i.test(m) || /3\.8.*flash/i.test(m)) return "3.8 Flash";
  if (/gemini.*2\.5.*flash/i.test(m) || /2\.5.*flash/i.test(m)) return "2.5 Flash";
  if (/gemini.*2\.5.*pro/i.test(m) || /2\.5.*pro/i.test(m)) return "2.5 Pro";
  if (/claude.*3\.7.*sonnet/i.test(m) || /3\.7.*sonnet/i.test(m)) return "Claude 3.7";
  if (/claude.*3\.5.*sonnet/i.test(m) || /3\.5.*sonnet/i.test(m)) return "Claude 3.5";
  if (/claude.*3\.5.*haiku/i.test(m) || /3\.5.*haiku/i.test(m)) return "Haiku 3.5";
  if (/gpt-4o-mini/i.test(m)) return "4o-mini";
  if (/gpt-4o/i.test(m)) return "GPT-4o";
  if (/codex/i.test(m)) return "Codex";
  if (/claude_local/i.test(m)) return "Claude";
  if (/cursor/i.test(m)) return "Cursor";

  if (m.length > 12) return m.slice(0, 11) + "…";
  return m;
}

interface ActionBadge {
  label: string;
  className: string;
  icon: typeof Sparkles;
}

function getActionMeta(action: string): ActionBadge {
  const norm = action.replace(/_/g, ".");

  // Nhóm Heartbeat & Wake
  if (
    norm.includes("scheduled.wake") ||
    norm.includes("schedule.wake") ||
    norm.includes("wake.fired") ||
    norm === "issue.scheduled.wake.fired" ||
    norm === "heartbeat.invoked" ||
    norm.startsWith("heartbeat.")
  ) {
    if (norm.includes("cancel")) {
      return {
        label: "Hủy Heartbeat",
        className: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border-zinc-500/20",
        icon: HeartPulse,
      };
    }
    return {
      label: "Heartbeat",
      className: "bg-pink-500/10 text-pink-600 dark:text-pink-400 border-pink-500/20 font-medium",
      icon: HeartPulse,
    };
  }

  switch (norm) {
    case "issue.checked.out":
      return {
        label: "Agent nhận việc",
        className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
        icon: Sparkles,
      };
    case "issue.document.updated":
      return {
        label: "Cập nhật tài liệu",
        className: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
        icon: FileText,
      };
    case "issue.document.created":
      return {
        label: "Tạo tài liệu mới",
        className: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20",
        icon: FileText,
      };
    case "issue.comment.added":
    case "issue.commented":
      return {
        label: "Thêm bình luận",
        className: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
        icon: MessageSquare,
      };
    case "issue.created":
      return {
        label: "Mở task mới",
        className: "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20",
        icon: Sparkles,
      };
    case "issue.updated":
      return {
        label: "Cập nhật tiến độ",
        className: "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20",
        icon: Clock,
      };
    case "issue.completed":
    case "issue.closed":
      return {
        label: "Đã hoàn thành",
        className: "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20",
        icon: CheckCircle2,
      };
    case "issue.blocked":
      return {
        label: "Bị nghẽn (Blocked)",
        className: "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20",
        icon: AlertCircle,
      };
    case "issue.read.marked":
      return {
        label: "Đã xem tiến độ",
        className: "bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20",
        icon: Eye,
      };
    case "issue.checkout.lock.adopted":
      return {
        label: "Gia hạn tiếp nhận",
        className: "bg-teal-500/10 text-teal-600 dark:text-teal-400 border-teal-500/20",
        icon: Lock,
      };
    case "issue.attachment.added":
      return {
        label: "Đính kèm tệp tin",
        className: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/20",
        icon: Paperclip,
      };
    case "approval.created":
      return {
        label: "Chờ phê duyệt",
        className: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
        icon: Clock,
      };
    case "approval.approved":
      return {
        label: "Đã phê duyệt",
        className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
        icon: CheckCircle2,
      };
    case "agent.created":
    case "agent.updated":
      return {
        label: "Cập nhật Agent",
        className: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/20",
        icon: Bot,
      };
    default:
      return {
        label: norm.replace(/^issue\./, "").replace(/^agent\./, ""),
        className: "bg-muted text-muted-foreground border-border",
        icon: Activity,
      };
  }
}

const STATUS_VI_TEXT: Record<string, string> = {
  backlog: "Tồn đọng",
  todo: "Cần làm",
  in_progress: "Đang làm",
  in_review: "Đang duyệt",
  done: "Đã xong",
  cancelled: "Đã hủy",
  blocked: "Bị nghẽn",
};

const STATUS_WEIGHT: Record<string, number> = {
  in_progress: 10,
  in_review: 8,
  todo: 6,
  blocked: 4,
  backlog: 2,
  done: 1,
  cancelled: 0,
};

function getRuntimeScore(issueId: string, liveRunByIssueId: Map<string, LiveRunForIssue>): number {
  const run = liveRunByIssueId.get(issueId);
  if (run?.status === "running") return 3; // Live now: Điểm cao nhất
  if (run?.status === "queued") return 2;  // Chờ slot: Điểm nhì
  return 1;
}

// ─── Header Sort Button Helper ─────────────────────────────────────────────

function SortHeaderButton({
  label,
  field,
  currentField,
  currentOrder,
  onSort,
  align = "left",
}: {
  label: string;
  field: SortField;
  currentField: SortField;
  currentOrder: SortOrder;
  onSort: (field: SortField) => void;
  align?: "left" | "right" | "center";
}) {
  const isActive = currentField === field;

  return (
    <button
      type="button"
      onClick={() => onSort(field)}
      className={cn(
        "inline-flex items-center gap-1.5 font-semibold uppercase tracking-wider transition-colors group select-none py-1 text-[11px]",
        align === "right" && "justify-end w-full",
        align === "center" && "justify-center w-full",
        isActive ? "text-primary font-bold" : "text-muted-foreground hover:text-foreground"
      )}
      title={`Bấm để sắp xếp theo ${label} (${isActive ? (currentOrder === "asc" ? "Tăng dần → bấm để Giảm dần" : "Giảm dần → bấm để Bỏ sort") : "Bấm để sắp xếp"})`}
    >
      <span>{label}</span>
      <span className="shrink-0 inline-flex items-center">
        {isActive ? (
          currentOrder === "asc" ? (
            <ArrowUp className="h-3.5 w-3.5 text-primary animate-in fade-in zoom-in-75 duration-150" />
          ) : (
            <ArrowDown className="h-3.5 w-3.5 text-primary animate-in fade-in zoom-in-75 duration-150" />
          )
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-30 group-hover:opacity-80 transition-opacity" />
        )}
      </span>
    </button>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────

export function UnifiedTasksAndActivity({
  companyId,
  issues = [],
  activity = [],
  agents = [],
  projects = [],
  animatedActivityIds,
}: UnifiedTasksAndActivityProps) {
  const [activeTab, setActiveTab] = useState<"tasks" | "activity">("tasks");
  const [searchQuery, setSearchQuery] = useState("");
  const [pageSize, setPageSize] = useState<number | "all">(50);

  // Sorting state
  const [sortField, setSortField] = useState<SortField>("default");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");

  // Filter state
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [agentFilter, setAgentFilter] = useState<string>("all");

  // Query live runs với polling 1.5s để đồng bộ trạng thái thực thi tức thời cực nhạy
  const { data: liveRuns } = useQuery({
    queryKey: [...queryKeys.liveRuns(companyId), "dashboard"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId, 16),
    enabled: !!companyId,
    refetchInterval: 1500,
  });

  const liveRunByIssueId = useMemo(() => {
    const map = new Map<string, LiveRunForIssue>();
    for (const r of liveRuns ?? []) {
      if (r.issueId) map.set(r.issueId, r);
    }
    return map;
  }, [liveRuns]);

  // Phát hiện các issue đang có run thực thi (running hoặc queued) nhưng không có trong danh sách issues
  // (ví dụ: các Heartbeat Thread bị ẩn trong hệ thống hoặc các task chạy nền)
  const missingActiveIssueIds = useMemo(() => {
    const issueIdSet = new Set((issues ?? []).map((i) => i.id));
    const missing = new Set<string>();
    for (const r of liveRuns ?? []) {
      if (r.issueId && (r.status === "running" || r.status === "queued") && !issueIdSet.has(r.issueId)) {
        missing.add(r.issueId);
      }
    }
    return Array.from(missing);
  }, [issues, liveRuns]);

  // Tự động fetch thông tin đầy đủ của các active/queued issue bị ẩn để bảng hiển thị đúng 100%
  const { data: fetchedMissingIssues } = useQuery({
    queryKey: ["activeHiddenIssues", companyId, missingActiveIssueIds.sort().join(",")],
    queryFn: async () => {
      if (missingActiveIssueIds.length === 0) return [];
      const results = await Promise.allSettled(
        missingActiveIssueIds.map((id) => issuesApi.get(id))
      );
      return results
        .filter((r): r is PromiseFulfilledResult<Issue> => r.status === "fulfilled" && !!r.value)
        .map((r) => r.value);
    },
    enabled: !!companyId && missingActiveIssueIds.length > 0,
    staleTime: 30_000,
  });

  // Hợp nhất danh sách issues (issues thường + các active/queued issue đang chạy Live now hoặc Chờ slot)
  const allIssues = useMemo(() => {
    const list = [...(issues ?? [])];
    const existingIds = new Set(list.map((i) => i.id));

    // 1. Thêm các issue đã fetch được từ API
    for (const missing of fetchedMissingIssues ?? []) {
      if (!existingIds.has(missing.id)) {
        list.push(missing);
        existingIds.add(missing.id);
      }
    }

    // 2. Dựng placeholder tức thời nếu API đang fetch dở để bảng hiển thị ngay lập tức
    for (const r of liveRuns ?? []) {
      if (r.issueId && (r.status === "running" || r.status === "queued") && !existingIds.has(r.issueId)) {
        list.push({
          id: r.issueId,
          companyId,
          projectId: null,
          projectWorkspaceId: null,
          goalId: null,
          parentId: null,
          title: `Heartbeat Thread — ${r.agentName}`,
          description: null,
          metadata: {},
          status: "in_progress",
          priority: "low",
          assigneeAgentId: r.agentId,
          assigneeUserId: null,
          checkoutRunId: null,
          executionRunId: r.id,
          executionAgentNameKey: r.agentName.toLowerCase(),
          executionLockedAt: null,
          createdByAgentId: null,
          createdByUserId: null,
          issueNumber: 0,
          identifier: r.issueId.slice(0, 8),
          originKind: "system",
          originId: null,
          originRunId: null,
          requestDepth: 0,
          billingCode: null,
          assigneeAdapterOverrides: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
          executionWorkspaceSettings: null,
          scheduledWakeAt: null,
          startedAt: r.startedAt,
          completedAt: null,
          cancelledAt: null,
          hiddenAt: null,
          createdAt: r.createdAt,
          updatedAt: r.startedAt || r.createdAt,
          labels: [],
          labelIds: [],
          ancestors: [],
          planDocument: null,
          documentSummaries: [],
          legacyPlanDocument: null,
          project: null,
          goal: null,
          mentionedProjects: [],
          currentExecutionWorkspace: null,
          workProducts: [],
        } as unknown as Issue);
        existingIds.add(r.issueId);
      }
    }

    return list;
  }, [issues, fetchedMissingIssues, liveRuns, companyId]);

  // Map tra cứu nhanh
  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents) map.set(a.id, a);
    return map;
  }, [agents]);

  const projectMap = useMemo(() => {
    const map = new Map<string, Project>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of allIssues) map.set(`issue:${i.id}`, i.identifier ?? i.id.slice(0, 8));
    for (const a of agents) map.set(`agent:${a.id}`, a.name);
    for (const p of projects) map.set(`project:${p.id}`, p.name);
    return map;
  }, [allIssues, agents, projects]);

  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of allIssues) map.set(`issue:${i.id}`, i.title);
    return map;
  }, [allIssues]);

  // Gom activity theo issue (lấy event mới nhất của mỗi issue)
  const latestActivityByIssue = useMemo(() => {
    const map = new Map<string, ActivityEvent>();
    for (const act of activity) {
      if (act.entityType === "issue" && act.entityId) {
        if (!map.has(act.entityId)) {
          map.set(act.entityId, act);
        }
      }
    }
    return map;
  }, [activity]);

  // Toggle sort khi click header cột
  function toggleSort(field: SortField) {
    if (sortField !== field) {
      setSortField(field);
      setSortOrder(field === "updated" || field === "status" || field === "activity" ? "desc" : "asc");
    } else {
      if (sortOrder === "asc") {
        setSortOrder("desc");
      } else {
        // Reset về mặc định
        setSortField("default");
        setSortOrder("desc");
      }
    }
  }

  // Lọc và Sắp xếp Reactive (Tự động nhảy Live now lên đầu ngay khi liveRuns đổi!)
  const filteredAndSortedIssues = useMemo(() => {
    let list = [...allIssues];

    // 1. Lọc theo search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter((i) => {
        const idMatch = (i.identifier ?? "").toLowerCase().includes(q);
        const titleMatch = (i.title ?? "").toLowerCase().includes(q);
        const agentName = i.assigneeAgentId ? agentMap.get(i.assigneeAgentId)?.name.toLowerCase() : "";
        return idMatch || titleMatch || (agentName && agentName.includes(q));
      });
    }

    // 2. Lọc theo trạng thái
    if (statusFilter !== "all") {
      if (statusFilter === "live") {
        list = list.filter((i) => liveRunByIssueId.get(i.id)?.status === "running");
      } else if (statusFilter === "queued") {
        list = list.filter((i) => liveRunByIssueId.get(i.id)?.status === "queued");
      } else {
        list = list.filter((i) => i.status === statusFilter);
      }
    }

    // 3. Lọc theo agent
    if (agentFilter !== "all") {
      if (agentFilter === "unassigned") {
        list = list.filter((i) => !i.assigneeAgentId);
      } else {
        list = list.filter((i) => i.assigneeAgentId === agentFilter);
      }
    }

    // 4. Sắp xếp (Sort)
    list.sort((a, b) => {
      // QUY TẮC MẶC ĐỊNH:
      // Live now (Score 3) -> Queued (Score 2) -> Khác (Score 1)
      // Khi 1 task đổi trạng thái thành Live now, nó tự động nhảy lên trên đầu ngay lập tức!
      if (sortField === "default") {
        const scoreA = getRuntimeScore(a.id, liveRunByIssueId);
        const scoreB = getRuntimeScore(b.id, liveRunByIssueId);
        if (scoreB !== scoreA) {
          return scoreB - scoreA; // 3 -> 2 -> 1
        }
        // Cùng score thì việc có cập nhật mới nhất ở hàng đầu
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      }

      let diff = 0;
      if (sortField === "identifier") {
        const idA = a.identifier ?? a.id;
        const idB = b.identifier ?? b.id;
        diff = idA.localeCompare(idB, undefined, { numeric: true, sensitivity: "base" });
      } else if (sortField === "status") {
        // So sánh trạng thái kết hợp điểm runtime
        const scoreA = getRuntimeScore(a.id, liveRunByIssueId) * 100 + (STATUS_WEIGHT[a.status] ?? 0);
        const scoreB = getRuntimeScore(b.id, liveRunByIssueId) * 100 + (STATUS_WEIGHT[b.status] ?? 0);
        diff = scoreA - scoreB;
      } else if (sortField === "title") {
        diff = (a.title || "").localeCompare(b.title || "", "vi", { sensitivity: "base" });
      } else if (sortField === "agent") {
        const nameA = a.assigneeAgentId ? (agentMap.get(a.assigneeAgentId)?.name ?? "") : "zzz";
        const nameB = b.assigneeAgentId ? (agentMap.get(b.assigneeAgentId)?.name ?? "") : "zzz";
        diff = nameA.localeCompare(nameB, "vi", { sensitivity: "base" });
      } else if (sortField === "activity") {
        const actA = latestActivityByIssue.get(a.id) ?? latestActivityByIssue.get(a.identifier ?? "");
        const actB = latestActivityByIssue.get(b.id) ?? latestActivityByIssue.get(b.identifier ?? "");
        const timeA = actA ? new Date(actA.createdAt).getTime() : 0;
        const timeB = actB ? new Date(actB.createdAt).getTime() : 0;
        diff = timeA - timeB;
      } else if (sortField === "updated") {
        diff = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
      }

      return sortOrder === "asc" ? diff : -diff;
    });

    if (pageSize === "all") return list;
    return list.slice(0, pageSize);
  }, [
    allIssues,
    liveRunByIssueId, // Quan trọng: theo dõi liveRuns để re-sort tự động khi có Live now
    sortField,
    sortOrder,
    statusFilter,
    agentFilter,
    searchQuery,
    pageSize,
    agentMap,
    latestActivityByIssue,
  ]);

  const filteredActivity = useMemo(() => {
    let list = activity;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter((e) => {
        const label = entityNameMap.get(`${e.entityType}:${e.entityId}`)?.toLowerCase() ?? "";
        const title = entityTitleMap.get(`${e.entityType}:${e.entityId}`)?.toLowerCase() ?? "";
        const action = e.action.toLowerCase();
        return label.includes(q) || title.includes(q) || action.includes(q);
      });
    }
    if (pageSize === "all") return list;
    return list.slice(0, pageSize);
  }, [activity, searchQuery, entityNameMap, entityTitleMap, pageSize]);

  // Kiểm tra xem có đang áp dụng filter/sort nào khác mặc định không
  const isFilteredOrSorted =
    statusFilter !== "all" || agentFilter !== "all" || sortField !== "default" || !!searchQuery.trim();

  function resetAllFiltersAndSort() {
    setSearchQuery("");
    setStatusFilter("all");
    setAgentFilter("all");
    setSortField("default");
    setSortOrder("desc");
  }

  // Danh sách các agent có việc để hiển thị trong filter
  const assignedAgentsList = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of allIssues) {
      if (i.assigneeAgentId) {
        const a = agentMap.get(i.assigneeAgentId);
        if (a) map.set(a.id, a.name);
      }
    }
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1], "vi"));
  }, [allIssues, agentMap]);

  return (
    <div className="rounded-xl border border-border bg-card text-card-foreground shadow-sm overflow-hidden">
      {/* ── Header bảng thống nhất ────────────────────────────────────────── */}
      <div className="p-4 sm:p-5 border-b border-border bg-muted/20 space-y-3.5">
        {/* Hàng 1: Tiêu đề bên trái ↔ Tab Switchers & Link bên phải */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary border border-primary/20 shrink-0">
              <Layers className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold tracking-tight text-foreground">
                  Công việc & Hoạt động gần đây
                </h3>
                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground border border-border">
                  {allIssues.length.toLocaleString("vi-VN")} công việc
                </span>
                {sortField === "default" && (
                  <span className="hidden md:inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border border-cyan-500/20">
                    <span className="h-1.5 w-1.5 rounded-full bg-cyan-500 animate-pulse" />
                    Ưu tiên Live & Mới nhất
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Theo dõi tiến độ xử lý công việc và dòng thời gian hoạt động thực tế của Agent
              </p>
            </div>
          </div>

          {/* Bên phải Hàng 1: Tabs & Link Xem tất cả */}
          <div className="flex items-center gap-2.5 sm:ml-auto">
            {/* Tab switchers */}
            <div className="inline-flex rounded-lg bg-muted/80 p-1 text-xs border border-border/40">
              <button
                type="button"
                onClick={() => setActiveTab("tasks")}
                className={cn(
                  "px-3 py-1 font-medium rounded-md transition-all flex items-center gap-1.5",
                  activeTab === "tasks"
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <ListTodo className="h-3.5 w-3.5" />
                <span>Tiến độ công việc</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("activity")}
                className={cn(
                  "px-3 py-1 font-medium rounded-md transition-all flex items-center gap-1.5",
                  activeTab === "activity"
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Activity className="h-3.5 w-3.5" />
                <span>Nhật ký thời gian</span>
              </button>
            </div>

            {/* Link sang trang đầy đủ */}
            <Link
              to={activeTab === "tasks" ? "/issues" : "/activity"}
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline font-medium px-2 py-1 rounded hover:bg-primary/5 transition-colors"
            >
              <span>Xem tất cả</span>
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>

        {/* Hàng 2 (Sub-toolbar): Tìm kiếm & Bộ lọc bên trái ↔ Bộ chọn số lượng xem bên phải */}
        <div className="pt-2.5 border-t border-border/40 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          {/* Cụm Tìm kiếm + Lọc trạng thái + Lọc Agent bên trái */}
          <div className="flex flex-wrap items-center gap-2 flex-1 max-w-3xl">
            {/* Ô tìm kiếm */}
            <div className="relative min-w-[200px] flex-1 max-w-[280px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="text"
                placeholder="Tìm mã GEM, tiêu đề, agent..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full h-8 pl-8 pr-7 text-xs rounded-md bg-background border border-input focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/60 transition-colors"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  aria-label="Xóa tìm kiếm"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs h-4 w-4 rounded-full flex items-center justify-center hover:bg-muted"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>

            {/* Dropdown lọc Trạng thái */}
            <div className="relative">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="h-8 pl-2.5 pr-7 text-xs rounded-md bg-background border border-input focus:outline-none focus:ring-1 focus:ring-primary text-foreground font-medium cursor-pointer"
              >
                <option value="all">Tất cả trạng thái</option>
                <option value="live">🔵 Đang chạy Live now</option>
                <option value="queued">🟡 Chờ slot (Queued)</option>
                <option value="in_progress">Đang làm (In Progress)</option>
                <option value="todo">Cần làm (Todo)</option>
                <option value="in_review">Đang duyệt (In Review)</option>
                <option value="done">Đã xong (Done)</option>
                <option value="blocked">Bị nghẽn (Blocked)</option>
                <option value="backlog">Tồn đọng (Backlog)</option>
              </select>
            </div>

            {/* Dropdown lọc Agent */}
            <div className="relative">
              <select
                value={agentFilter}
                onChange={(e) => setAgentFilter(e.target.value)}
                className="h-8 pl-2.5 pr-7 text-xs rounded-md bg-background border border-input focus:outline-none focus:ring-1 focus:ring-primary text-foreground font-medium cursor-pointer max-w-[180px]"
              >
                <option value="all">Tất cả Agent</option>
                <option value="unassigned">Chưa gán agent</option>
                {assignedAgentsList.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </div>

            {/* Nút đặt lại khi có lọc hoặc sort */}
            {isFilteredOrSorted && (
              <button
                type="button"
                onClick={resetAllFiltersAndSort}
                className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/80 border border-dashed border-border transition-colors"
                title="Đặt lại sắp xếp & bộ lọc về mặc định"
              >
                <RotateCcw className="h-3 w-3" />
                <span>Đặt lại</span>
              </button>
            )}
          </div>

          {/* Bộ chọn số lượng hiển thị + Chỉ số thống kê dàn đều bên phải */}
          <div className="flex items-center justify-between md:justify-end gap-3 shrink-0">
            <span className="text-[11px] text-muted-foreground">
              Đang hiển thị:{" "}
              <strong className="text-foreground font-semibold">
                {activeTab === "tasks" ? filteredAndSortedIssues.length : filteredActivity.length}
              </strong>
              /{activeTab === "tasks" ? allIssues.length : activity.length}
            </span>

            <div className="flex items-center gap-1 text-xs text-muted-foreground bg-muted/60 p-0.5 rounded-md border border-border/50">
              <span className="px-1.5 text-[11px] font-medium">Xem:</span>
              {[25, 50, 100, "all"].map((val) => (
                <button
                  key={String(val)}
                  type="button"
                  onClick={() => setPageSize(val as number | "all")}
                  className={cn(
                    "px-2 py-0.5 rounded text-[11px] font-medium transition-all",
                    pageSize === val
                      ? "bg-background text-foreground shadow-xs font-semibold"
                      : "hover:text-foreground text-muted-foreground"
                  )}
                >
                  {val === "all" ? "Tất cả" : val}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── TAB 1: BẢNG GỘP CÔNG VIỆC & HOẠT ĐỘNG GẦN NHẤT (CUỘN ĐƯỢC) ──────── */}
      {activeTab === "tasks" && (
        <div className="overflow-x-auto overflow-y-auto max-h-[620px] scrollbar-thin">
          {filteredAndSortedIssues.length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground">
              {isFilteredOrSorted
                ? "Không tìm thấy công việc nào khớp với bộ lọc hoặc từ khóa tìm kiếm."
                : "Chưa có công việc nào."}
              {isFilteredOrSorted && (
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={resetAllFiltersAndSort}
                    className="inline-flex items-center gap-1.5 text-xs text-primary font-medium hover:underline"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    <span>Xóa bộ lọc & đặt lại mặc định</span>
                  </button>
                </div>
              )}
            </div>
          ) : (
            <table className="w-full text-left text-sm border-collapse table-fixed">
              <thead className="sticky top-0 z-20 bg-muted/95 backdrop-blur-xs border-b border-border shadow-xs">
                <tr className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                  {/* Cột 1: Agent phụ trách & Trạng thái */}
                  <th className="py-2.5 px-4 w-[230px]">
                    <SortHeaderButton
                      label="Agent & Trạng thái"
                      field="agent"
                      currentField={sortField}
                      currentOrder={sortOrder}
                      onSort={toggleSort}
                    />
                  </th>

                  {/* Cột 2: Nội dung công việc (gộp mã GEM-###) */}
                  <th className="py-2.5 px-4 min-w-[280px]">
                    <SortHeaderButton
                      label="Nội dung công việc"
                      field="title"
                      currentField={sortField}
                      currentOrder={sortOrder}
                      onSort={toggleSort}
                    />
                  </th>

                  {/* Cột 3: Hoạt động mới nhất */}
                  <th className="py-2.5 px-4 w-[210px]">
                    <SortHeaderButton
                      label="Hoạt động mới nhất"
                      field="activity"
                      currentField={sortField}
                      currentOrder={sortOrder}
                      onSort={toggleSort}
                    />
                  </th>

                  {/* Cột 4: Cập nhật */}
                  <th className="py-2.5 px-4 w-[130px] text-right">
                    <SortHeaderButton
                      label="Cập nhật"
                      field="updated"
                      currentField={sortField}
                      currentOrder={sortOrder}
                      onSort={toggleSort}
                      align="right"
                    />
                  </th>

                  {/* Cột 5: Xem */}
                  <th className="py-2.5 px-3 w-[45px] text-center">Xem</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredAndSortedIssues.map((issue) => {
                  const agent = issue.assigneeAgentId ? agentMap.get(issue.assigneeAgentId) : null;
                  const project = issue.projectId ? projectMap.get(issue.projectId) : null;
                  const latestAct = latestActivityByIssue.get(issue.id) ?? latestActivityByIssue.get(issue.identifier ?? "");
                  const actMeta = latestAct ? getActionMeta(latestAct.action) : null;

                  // Đồng bộ trạng thái thực thi tức thời của agent
                  const liveRun = liveRunByIssueId.get(issue.id);
                  const isLiveRunning = liveRun?.status === "running";
                  const isLiveQueued = liveRun?.status === "queued";

                  return (
                    <tr
                      key={issue.id}
                      className={cn(
                        "group hover:bg-muted/40 transition-colors h-[64px]",
                        isLiveRunning && "bg-cyan-500/[0.04] hover:bg-cyan-500/[0.08]"
                      )}
                    >
                      {/* Cột 1: Agent phụ trách & Trạng thái */}
                      <td className="py-2.5 px-4 align-middle">
                        {agent ? (
                          (() => {
                            const rawModel =
                              (agent.adapterConfig?.model as string) ||
                              (agent.adapterConfig?.defaultModel as string) ||
                              agent.adapterType;
                            const shortModel = formatModelShort(rawModel);

                            return (
                              <div className="space-y-1">
                                {/* Hàng 1: Avatar + Tên Agent + Badge Model */}
                                <div className="flex items-center justify-between gap-1.5 max-w-[210px]">
                                  <Link
                                    to={`/agents/${agent.id}`}
                                    className="inline-flex items-center gap-1.5 no-underline hover:text-primary min-w-0 flex-1 group/agent"
                                    title={`Xem bảng điều khiển agent ${agent.name}`}
                                  >
                                    <Identity name={agent.name} size="sm" className="truncate font-semibold text-xs text-foreground group-hover/agent:text-primary transition-colors" />
                                  </Link>
                                  {shortModel && (
                                    <TooltipProvider delayDuration={200}>
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <span className="shrink-0 text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted/80 text-muted-foreground border border-border/60 leading-none whitespace-nowrap cursor-default">
                                            {shortModel}
                                          </span>
                                        </TooltipTrigger>
                                        <TooltipContent side="top" className="text-[11px] font-mono">
                                          Model: {String(rawModel)}
                                        </TooltipContent>
                                      </Tooltip>
                                    </TooltipProvider>
                                  )}
                                </div>

                                {/* Hàng 2: Trạng thái & Badge Live now / Chờ slot */}
                                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground font-medium flex-wrap">
                                  <StatusIcon status={issue.status} />
                                  {issue.priority && <PriorityIcon priority={issue.priority} />}
                                  <span>{STATUS_VI_TEXT[issue.status] ?? issue.status}</span>

                                  {isLiveRunning && (
                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-[10px] font-semibold bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border border-cyan-500/30 whitespace-nowrap animate-pulse">
                                      <span className="relative flex h-1.5 w-1.5 shrink-0">
                                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-75" />
                                        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-cyan-500" />
                                      </span>
                                      Live now
                                    </span>
                                  )}
                                  {isLiveQueued && (
                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-[10px] font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 whitespace-nowrap">
                                      <Clock className="h-2.5 w-2.5 shrink-0" />
                                      Chờ slot
                                    </span>
                                  )}
                                </div>
                              </div>
                            );
                          })()
                        ) : (
                          <div className="space-y-1">
                            <div className="text-xs text-muted-foreground/70 italic flex items-center gap-1.5">
                              <Bot className="h-3.5 w-3.5 opacity-50" />
                              <span>Chưa gán agent</span>
                            </div>
                            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground font-medium">
                              <StatusIcon status={issue.status} />
                              {issue.priority && <PriorityIcon priority={issue.priority} />}
                              <span>{STATUS_VI_TEXT[issue.status] ?? issue.status}</span>
                            </div>
                          </div>
                        )}
                      </td>

                      {/* Cột 2: Nội dung công việc — Gộp mã GEM-### + Tiêu đề công việc + Tooltip */}
                      <td className="py-2.5 px-4 align-middle">
                        <TooltipProvider delayDuration={150}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="cursor-default group/title">
                                <div className="flex items-baseline gap-2 flex-wrap sm:flex-nowrap">
                                  {/* Mã GEM-### gộp vào cột nội dung */}
                                  <Link
                                    to={`/issues/${issue.identifier ?? issue.id}`}
                                    className="inline-flex items-center font-mono text-xs font-bold text-primary hover:underline px-1.5 py-0.5 rounded bg-primary/10 border border-primary/20 shrink-0 leading-none"
                                    title={`Xem chi tiết ${issue.identifier ?? issue.id}`}
                                  >
                                    {issue.identifier ?? issue.id.slice(0, 8)}
                                  </Link>

                                  {/* Tiêu đề công việc */}
                                  <Link
                                    to={`/issues/${issue.identifier ?? issue.id}`}
                                    className="font-medium text-foreground hover:text-primary transition-colors line-clamp-2 no-underline text-xs sm:text-sm leading-snug flex-1"
                                  >
                                    {issue.title}
                                  </Link>
                                </div>

                                {project && (
                                  <div className="flex items-center gap-1.5 mt-1">
                                    <span className="inline-flex items-center rounded px-1.5 py-0.2 text-[10px] font-medium bg-secondary text-secondary-foreground border border-border">
                                      {project.name}
                                    </span>
                                  </div>
                                )}
                              </div>
                            </TooltipTrigger>
                            <TooltipContent
                              side="top"
                              align="start"
                              className="max-w-[560px] p-3 shadow-xl bg-popover text-popover-foreground border border-border text-xs z-50 rounded-lg pointer-events-none"
                            >
                              <div className="font-semibold text-primary mb-1 flex items-center gap-2">
                                <span className="font-mono">{issue.identifier ?? issue.id}</span>
                                {project && (
                                  <span className="text-[10px] text-muted-foreground">({project.name})</span>
                                )}
                              </div>
                              <p className="text-foreground leading-relaxed whitespace-pre-wrap font-normal select-text">
                                {issue.title}
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </td>

                      {/* Cột 4: Hoạt động mới nhất — Chuẩn hóa Heartbeat & Action có dấu đẹp */}
                      <td className="py-2 px-4 align-middle">
                        {latestAct && actMeta ? (
                          <div className="flex flex-col gap-0.5">
                            <div className="flex items-center gap-1.5">
                              <span
                                className={cn(
                                  "inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded border whitespace-nowrap",
                                  actMeta.className
                                )}
                              >
                                <actMeta.icon className="h-3 w-3 shrink-0" />
                                <span>{actMeta.label}</span>
                              </span>
                            </div>
                            <div className="text-[11px] text-muted-foreground flex items-center gap-1 truncate">
                              <span>Bởi</span>
                              <span className="font-medium text-foreground/80 truncate max-w-[85px]">
                                {latestAct.actorType === "agent"
                                  ? (agentMap.get(latestAct.actorId)?.name ?? "Agent")
                                  : "Ban điều hành"}
                              </span>
                              <span>&middot;</span>
                              <span className="shrink-0">{formatViTimeAgo(latestAct.createdAt)}</span>
                            </div>
                          </div>
                        ) : (
                          <div className="text-[11px] text-muted-foreground/70 flex items-center gap-1">
                            <Clock className="h-3 w-3 shrink-0" />
                            <span className="truncate">
                              {STATUS_VI_TEXT[issue.status] ?? issue.status}
                            </span>
                          </div>
                        )}
                      </td>

                      {/* Cột 5: Thời gian cập nhật */}
                      <td className="py-2 px-4 align-middle text-right">
                        <div className="text-xs font-medium text-foreground whitespace-nowrap">
                          {formatViTimeAgo(issue.updatedAt)}
                        </div>
                        <div className="text-[10px] text-muted-foreground whitespace-nowrap">
                          {formatViDateTime(issue.updatedAt)}
                        </div>
                      </td>

                      {/* Cột 6: Xem chi tiết */}
                      <td className="py-2 px-3 align-middle text-center">
                        <Link
                          to={`/issues/${issue.identifier ?? issue.id}`}
                          aria-label={`Mở chi tiết ${issue.identifier ?? issue.id}`}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                        >
                          <ChevronRight className="h-4 w-4" />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── TAB 2: DÒNG THỜI GIAN HOẠT ĐỘNG (CUỘN ĐƯỢC) ───────────────────── */}
      {activeTab === "activity" && (
        <div className="overflow-x-auto overflow-y-auto max-h-[620px] scrollbar-thin">
          {filteredActivity.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              {searchQuery ? "Không tìm thấy hoạt động nào." : "Chưa có hoạt động nào được ghi nhận."}
            </div>
          ) : (
            <table className="w-full text-left text-sm border-collapse table-fixed">
              <thead className="sticky top-0 z-20 bg-muted/95 backdrop-blur-xs border-b border-border shadow-xs">
                <tr className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                  <th className="py-2.5 px-4 w-[160px]">Thời gian</th>
                  <th className="py-2.5 px-4 w-[180px]">Tác nhân</th>
                  <th className="py-2.5 px-4 w-[180px]">Hành động</th>
                  <th className="py-2.5 px-4 min-w-[260px]">Đối tượng & Chi tiết</th>
                  <th className="py-2.5 px-4 w-[60px] text-center">Xem</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredActivity.map((event) => {
                  const actMeta = getActionMeta(event.action);
                  const isNew = animatedActivityIds.has(event.id);
                  const entityLink =
                    event.entityType === "issue"
                      ? `/issues/${entityNameMap.get(`issue:${event.entityId}`) ?? event.entityId}`
                      : event.entityType === "agent"
                        ? `/agents/${event.entityId}`
                        : event.entityType === "project"
                          ? `/projects/${event.entityId}`
                          : event.entityType === "heartbeat_run"
                            ? `/agents/${event.agentId}`
                            : "/activity";

                  const entityLabel = entityNameMap.get(`${event.entityType}:${event.entityId}`) ?? event.entityType;
                  const entityTitle = entityTitleMap.get(`${event.entityType}:${event.entityId}`);

                  return (
                    <tr
                      key={event.id}
                      className={cn(
                        "group hover:bg-muted/40 transition-colors h-[60px]",
                        isNew && "bg-primary/5 animate-pulse"
                      )}
                    >
                      {/* Cột 1: Thời gian */}
                      <td className="py-2 px-4 align-middle">
                        <div className="text-xs font-medium text-foreground whitespace-nowrap">
                          {formatViTimeAgo(event.createdAt)}
                        </div>
                        <div className="text-[10px] text-muted-foreground whitespace-nowrap">
                          {formatViDateTime(event.createdAt)}
                        </div>
                      </td>

                      {/* Cột 2: Tác nhân */}
                      <td className="py-2 px-4 align-middle">
                        {event.actorType === "agent" ? (
                          <Link
                            to={`/agents/${event.actorId}`}
                            className="inline-flex items-center gap-1.5 no-underline hover:text-primary max-w-[170px]"
                          >
                            <Identity
                              name={agentMap.get(event.actorId)?.name ?? "Agent"}
                              size="sm"
                              className="truncate text-xs font-medium"
                            />
                          </Link>
                        ) : (
                          <div className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                            <span className="h-5 w-5 rounded bg-muted flex items-center justify-center text-[10px] font-bold shrink-0">
                              BO
                            </span>
                            <span className="truncate">Ban điều hành</span>
                          </div>
                        )}
                      </td>

                      {/* Cột 3: Hành động */}
                      <td className="py-2 px-4 align-middle">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded border whitespace-nowrap",
                            actMeta.className
                          )}
                        >
                          <actMeta.icon className="h-3 w-3 shrink-0" />
                          <span>{actMeta.label}</span>
                        </span>
                      </td>

                      {/* Cột 4: Đối tượng liên quan */}
                      <td className="py-2 px-4 align-middle">
                        <div className="flex flex-col gap-0.5">
                          <Link
                            to={entityLink}
                            className="font-mono text-xs font-semibold text-primary hover:underline inline-flex items-center gap-1 truncate"
                          >
                            <span>{entityLabel}</span>
                          </Link>
                          {entityTitle && (
                            <span className="text-xs text-foreground/80 line-clamp-1">
                              {entityTitle}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Cột 5: Xem */}
                      <td className="py-2 px-4 align-middle text-center">
                        <Link
                          to={entityLink}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                        >
                          <ChevronRight className="h-4 w-4" />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── Footer tóm tắt ──────────────────────────────────────────────── */}
      <div className="p-3 bg-muted/10 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
          <span>
            Đang hiển thị {activeTab === "tasks" ? filteredAndSortedIssues.length : filteredActivity.length} /{" "}
            {activeTab === "tasks" ? issues.length : activity.length} mục &middot; Đồng bộ Live Updates 1.5s
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Link to="/issues" className="hover:text-foreground underline underline-offset-2">
            Quản lý toàn bộ công việc
          </Link>
          <span>&middot;</span>
          <Link to="/activity" className="hover:text-foreground underline underline-offset-2">
            Nhật ký hệ thống
          </Link>
        </div>
      </div>
    </div>
  );
}
