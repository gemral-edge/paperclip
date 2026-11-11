import { useState, useEffect, useMemo, useCallback } from "react";
import { Link, useNavigate, useLocation } from "@/lib/router";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL,
} from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";
import { DEFAULT_ANTIGRAVITY_MODEL } from "@paperclipai/adapter-antigravity-local";
import { agentsApi, type OrgNode } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import {
  isPauseToggleDisabled,
  isRunHeartbeatDisabled,
  pauseToggleAction,
} from "../lib/agent-action-availability";
import { StatusBadge } from "../components/StatusBadge";
import { agentStatusDot, agentStatusDotDefault } from "../lib/status-colors";
import { EntityRow } from "../components/EntityRow";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { HeartbeatScheduleBuilder } from "../components/HeartbeatScheduleBuilder";
import { relativeTime, formatDateTime, cn, agentRouteRef, agentUrl } from "../lib/utils";
import { PageTabBar } from "../components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Bot,
  Plus,
  List,
  GitBranch,
  SlidersHorizontal,
  Search,
  ArrowDownUp,
  GripVertical,
  Pause,
  Play,
  HeartPulse,
  Loader2,
  ChevronDown,
  Check,
  CalendarClock,
  Cpu,
} from "lucide-react";
import { AGENT_ROLE_LABELS, type Agent } from "@paperclipai/shared";

type AgentRowAction = "pause" | "resume" | "invoke";

type SortOption = "name-asc" | "name-desc" | "status" | "recent" | "model" | "custom";

const adapterLabels: Record<string, string> = {
  claude_local: "Claude",
  codex_local: "Codex",
  gemini_local: "Gemini",
  antigravity_local: "antigravity_local",
  opencode_local: "OpenCode",
  cursor: "Cursor",
  ollama: "Ollama",
  hermes_local: "Hermes",
  openclaw_gateway: "OpenClaw Gateway",
  process: "Process",
  http: "HTTP",
};

const QUICK_EDIT_ADAPTERS = [
  "antigravity_local",
  "claude_local",
  "codex_local",
  "gemini_local",
  "cursor",
  "ollama",
  "opencode_local",
] as const;

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

function getAgentScheduleCron(agent: Agent): string {
  const runtimeCron = (agent.runtimeConfig as Record<string, any> | undefined)?.heartbeat?.cronExpression;
  if (typeof runtimeCron === "string" && runtimeCron.trim().length > 0) {
    return runtimeCron.trim();
  }
  if (typeof agent.metadata?.schedule === "string" && agent.metadata.schedule.trim().length > 0) {
    return agent.metadata.schedule.trim();
  }
  return "";
}

function getDefaultModelForAdapter(adapterType: string): string {
  if (adapterType === "codex_local") return DEFAULT_CODEX_LOCAL_MODEL;
  if (adapterType === "gemini_local") return DEFAULT_GEMINI_LOCAL_MODEL;
  if (adapterType === "antigravity_local") return DEFAULT_ANTIGRAVITY_MODEL;
  if (adapterType === "cursor") return DEFAULT_CURSOR_LOCAL_MODEL;
  return "";
}

function formatSchedule(schedule: string | undefined | null): string {
  if (!schedule) return "Không cố định";
  
  // Try to parse basic cron "0 8,15,22 * * *" or "30 8 * * *"
  const parts = schedule.trim().split(/\s+/);
  if (parts.length >= 5) {
    const min = parts[0];
    const hr = parts[1];
    
    // Every X minutes or hours
    if (min!.startsWith("*/") && hr === "*") {
      return `Mỗi ${min!.replace("*/", "")} phút`;
    }
    if (min === "0" && hr!.startsWith("*/")) {
      return `Mỗi ${hr!.replace("*/", "")} giờ`;
    }
    
    // specific hours with a specific minute
    if (min !== "*" && !min!.includes("/") && hr !== "*" && !hr!.includes("/")) {
      const hours = hr!.split(",");
      const formatted = hours.map(h => `${h.padStart(2, "0")}:${min!.padStart(2, "0")}`);
      return formatted.join(" · ");
    }
  }
  
  return schedule;
}

type FilterTab = "all" | "active" | "paused" | "error";

function matchesFilter(status: string, tab: FilterTab, showTerminated: boolean): boolean {
  if (status === "terminated") return showTerminated;
  if (tab === "all") return true;
  if (tab === "active") return status === "active" || status === "running" || status === "idle";
  if (tab === "paused") return status === "paused";
  if (tab === "error") return status === "error";
  return true;
}

function filterAgents(agents: Agent[], tab: FilterTab, showTerminated: boolean): Agent[] {
  return agents
    .filter((a) => matchesFilter(a.status, tab, showTerminated))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function filterOrgTree(nodes: OrgNode[], tab: FilterTab, showTerminated: boolean): OrgNode[] {
  return nodes
    .reduce<OrgNode[]>((acc, node) => {
      const filteredReports = filterOrgTree(node.reports, tab, showTerminated);
      if (matchesFilter(node.status, tab, showTerminated) || filteredReports.length > 0) {
        acc.push({ ...node, reports: filteredReports });
      }
      return acc;
    }, [])
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * @archetype list
 * @size small
 * @navigable
 */
export function Agents() {
  const { selectedCompanyId } = useCompany();
  const { openNewAgent } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const location = useLocation();
  const { isMobile } = useSidebar();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [pendingByAgentId, setPendingByAgentId] = useState<Record<string, AgentRowAction>>({});
  const [updatingFieldByAgentId, setUpdatingFieldByAgentId] = useState<Record<string, "model" | "schedule">>({});
  const pathSegment = location.pathname.split("/").pop() ?? "all";
  const tab: FilterTab = (pathSegment === "all" || pathSegment === "active" || pathSegment === "paused" || pathSegment === "error") ? pathSegment : "all";
  const [view, setView] = useState<"list" | "org">(() => {
    return (localStorage.getItem("paperclip_agent_view") as "list" | "org") || "list";
  });
  const forceListView = isMobile;
  const effectiveView: "list" | "org" = forceListView ? "list" : view;
  const [showTerminated, setShowTerminated] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortOption>("custom");
  const [customOrder, setCustomOrder] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem("paperclip_agent_order");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const { data: agents, isLoading, error } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: orgTree } = useQuery({
    queryKey: queryKeys.org(selectedCompanyId!),
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId && effectiveView === "org",
  });

  const { data: runs } = useQuery({
    queryKey: queryKeys.heartbeats(selectedCompanyId!),
    // F3 (pooler-stall): chỉ đọc status (live-run count) → dùng listSummary (bỏ JSON blob), giảm egress poll 15s.
    queryFn: () => heartbeatsApi.listSummary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  // Map agentId -> first live (running) run + live run count.
  // Chỉ đếm lượt đang chạy thật (`running`); lượt `queued` (xếp hàng chờ chỗ chạy) không tính là Live.
  const liveRunByAgent = useMemo(() => {
    const map = new Map<string, { runId: string; liveCount: number }>();
    for (const r of runs ?? []) {
      if (r.status !== "running") continue;
      const existing = map.get(r.agentId);
      if (existing) {
        existing.liveCount += 1;
        continue;
      }
      map.set(r.agentId, { runId: r.id, liveCount: 1 });
    }
    return map;
  }, [runs]);

  // Map agentId -> first queued run + queued run count.
  const queuedRunByAgent = useMemo(() => {
    const map = new Map<string, { runId: string; queuedCount: number }>();
    for (const r of runs ?? []) {
      if (r.status !== "queued") continue;
      const existing = map.get(r.agentId);
      if (existing) {
        existing.queuedCount += 1;
        continue;
      }
      map.set(r.agentId, { runId: r.id, queuedCount: 1 });
    }
    return map;
  }, [runs]);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const handlePauseResume = useCallback(
    async (agentId: string, action: AgentRowAction) => {
      if (!selectedCompanyId || pendingByAgentId[agentId]) return;
      setPendingByAgentId((prev) => ({ ...prev, [agentId]: action }));
      try {
        if (action === "invoke") {
          const run = await agentsApi.invoke(agentId, selectedCompanyId);
          const skipped = !run || (typeof run === "object" && (run as { status?: string }).status === "skipped");
          pushToast({
            tone: skipped ? "warn" : "success",
            title: skipped ? "Heartbeat bị bỏ qua" : "Đã chạy heartbeat",
            body: skipped
              ? "Agent hiện không nhận lượt chạy (đang bận hoặc không ở trạng thái chạy được)."
              : `${agentMap.get(agentId)?.name ?? "Agent"} đang chạy lượt mới.`,
          });
          queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(selectedCompanyId) });
          queryClient.invalidateQueries({ queryKey: queryKeys.liveRuns(selectedCompanyId) });
          queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) });
          queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(selectedCompanyId) });
          return;
        }
        const updated =
          action === "pause"
            ? await agentsApi.pause(agentId, selectedCompanyId)
            : await agentsApi.resume(agentId, selectedCompanyId);
        queryClient.setQueryData<Agent[]>(
          queryKeys.agents.list(selectedCompanyId),
          (old) => (old ? old.map((a) => (a.id === agentId ? { ...a, ...updated } : a)) : old),
        );
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.org(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(selectedCompanyId) });
      } catch (err) {
        pushToast({
          tone: "error",
          title:
            action === "pause"
              ? "Không thể tạm dừng agent"
              : action === "resume"
                ? "Không thể tiếp tục agent"
                : "Không thể chạy heartbeat",
          body: err instanceof Error ? err.message : "Thao tác thất bại",
        });
      } finally {
        setPendingByAgentId((prev) => {
          const next = { ...prev };
          delete next[agentId];
          return next;
        });
      }
    },
    [selectedCompanyId, pendingByAgentId, queryClient, pushToast, agentMap],
  );

  const handleQuickUpdateAgent = useCallback(
    async (
      agentId: string,
      field: "model" | "schedule",
      patch: Record<string, unknown>,
      successTitle: string,
    ): Promise<boolean> => {
      if (!selectedCompanyId || updatingFieldByAgentId[agentId]) return false;
      setUpdatingFieldByAgentId((prev) => ({ ...prev, [agentId]: field }));
      try {
        const updated = await agentsApi.update(agentId, patch, selectedCompanyId);
        queryClient.setQueryData<Agent[]>(
          queryKeys.agents.list(selectedCompanyId),
          (old) => (old ? old.map((a) => (a.id === agentId ? { ...a, ...updated } : a)) : old),
        );
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.org(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
        pushToast({
          tone: "success",
          title: successTitle,
        });
        return true;
      } catch (err) {
        pushToast({
          tone: "error",
          title: field === "model" ? "Không thể đổi model" : "Không thể cập nhật lịch heartbeat",
          body: err instanceof Error ? err.message : "Thao tác thất bại",
        });
        return false;
      } finally {
        setUpdatingFieldByAgentId((prev) => {
          const next = { ...prev };
          delete next[agentId];
          return next;
        });
      }
    },
    [selectedCompanyId, updatingFieldByAgentId, queryClient, pushToast],
  );

  useEffect(() => {
    setBreadcrumbs([{ label: "Agents" }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Bot} message="Select a company to view agents." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  let filtered = filterAgents(agents ?? [], tab, showTerminated);
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter((a) =>
      a.name.toLowerCase().includes(q) ||
      (adapterLabels[a.adapterType] ?? a.adapterType).toLowerCase().includes(q) ||
      (typeof a.adapterConfig?.model === "string" && a.adapterConfig.model.toLowerCase().includes(q))
    );
  }

  if (sortBy === "custom" && customOrder.length > 0) {
    filtered.sort((a, b) => {
      const indexA = customOrder.indexOf(a.id);
      const indexB = customOrder.indexOf(b.id);
      if (indexA === -1 && indexB === -1) return a.name.localeCompare(b.name);
      if (indexA === -1) return 1;
      if (indexB === -1) return -1;
      return indexA - indexB;
    });
  } else {
    filtered.sort((a, b) => {
      switch (sortBy) {
        case "name-asc": return a.name.localeCompare(b.name);
        case "name-desc": return b.name.localeCompare(a.name);
        case "recent": {
          const timeA = a.lastHeartbeatAt ? new Date(a.lastHeartbeatAt).getTime() : 0;
          const timeB = b.lastHeartbeatAt ? new Date(b.lastHeartbeatAt).getTime() : 0;
          return timeB - timeA;
        }
        case "status": return a.status.localeCompare(b.status);
        case "model": {
          const modelA = typeof a.adapterConfig?.model === "string" ? a.adapterConfig.model : "";
          const modelB = typeof b.adapterConfig?.model === "string" ? b.adapterConfig.model : "";
          return modelA.localeCompare(modelB);
        }
        default: return 0;
      }
    });
  }

  const filteredOrg = filterOrgTree(orgTree ?? [], tab, showTerminated);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = filtered.findIndex((a) => a.id === active.id);
      const newIndex = filtered.findIndex((a) => a.id === over.id);
      
      const newArray = arrayMove(filtered, oldIndex, newIndex);
      const newOrder = newArray.map((a) => a.id);
      setCustomOrder(newOrder);
      localStorage.setItem("paperclip_agent_order", JSON.stringify(newOrder));
      setSortBy("custom");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={tab} onValueChange={(v) => navigate(`/agents/${v}`)}>
          <PageTabBar
            items={[
              { value: "all", label: "All" },
              { value: "active", label: "Active" },
              { value: "paused", label: "Paused" },
              { value: "error", label: "Error" },
            ]}
            value={tab}
            onValueChange={(v) => navigate(`/agents/${v}`)}
          />
        </Tabs>

        <div className="relative max-w-xs w-full sm:w-48 ml-auto sm:ml-4">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search agents..."
            className="w-full pl-8 h-8 text-xs"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="flex items-center gap-2">
          {/* Sort */}
          {effectiveView === "list" && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs">
                  <ArrowDownUp className="h-3.5 w-3.5 mr-1.5" />
                  Sort
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuRadioGroup value={sortBy} onValueChange={(v) => setSortBy(v as SortOption)}>
                  <DropdownMenuRadioItem value="name-asc" className="text-xs">Name (A-Z)</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="name-desc" className="text-xs">Name (Z-A)</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="status" className="text-xs">Status</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="recent" className="text-xs">Recently Active</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="model" className="text-xs">Model</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="custom" className="text-xs">Custom Order</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Filters */}
          <div className="relative">
            <button
              className={cn(
                "flex items-center gap-1.5 px-2 py-1.5 text-xs transition-colors border border-border",
                filtersOpen || showTerminated ? "text-foreground bg-accent" : "text-muted-foreground hover:bg-accent/50"
              )}
              onClick={() => setFiltersOpen(!filtersOpen)}
            >
              <SlidersHorizontal className="h-3 w-3" />
              Filters
              {showTerminated && <span className="ml-0.5 px-1 bg-foreground/10 rounded text-[10px]">1</span>}
            </button>
            {filtersOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 w-48 border border-border bg-popover shadow-md p-1">
                <button
                  className="flex items-center gap-2 w-full px-2 py-1.5 text-xs text-left hover:bg-accent/50 transition-colors"
                  onClick={() => setShowTerminated(!showTerminated)}
                >
                  <span className={cn(
                    "flex items-center justify-center h-3.5 w-3.5 border border-border rounded-sm",
                    showTerminated && "bg-foreground"
                  )}>
                    {showTerminated && <span className="text-background text-[10px] leading-none">&#10003;</span>}
                  </span>
                  Show terminated
                </button>
              </div>
            )}
          </div>
          {/* View toggle */}
          {!forceListView && (
            <div className="flex items-center border border-border">
              <button
                className={cn(
                  "p-1.5 transition-colors",
                  effectiveView === "list" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
                )}
                onClick={() => {
                  setView("list");
                  localStorage.setItem("paperclip_agent_view", "list");
                }}
              >
                <List className="h-3.5 w-3.5" />
              </button>
              <button
                className={cn(
                  "p-1.5 transition-colors",
                  effectiveView === "org" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
                )}
                onClick={() => {
                  setView("org");
                  localStorage.setItem("paperclip_agent_view", "org");
                }}
              >
                <GitBranch className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <Button size="sm" variant="outline" onClick={openNewAgent}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            New Agent
          </Button>
        </div>
      </div>

      {filtered.length > 0 && (
        <p className="text-xs text-muted-foreground">{filtered.length} agent{filtered.length !== 1 ? "s" : ""}</p>
      )}

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {agents && agents.length === 0 && (
        <EmptyState
          icon={Bot}
          message="Create your first agent to get started."
          action="New Agent"
          onAction={openNewAgent}
        />
      )}

      {/* List view */}
      {effectiveView === "list" && filtered.length > 0 && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <div className="border border-border flex flex-col">
            <SortableContext
              items={filtered.map((a) => a.id)}
              strategy={verticalListSortingStrategy}
            >
              {filtered.map((agent) => (
                <SortableAgentRow
                  key={agent.id}
                  agent={agent}
                  companyId={selectedCompanyId}
                  roleLabels={roleLabels}
                  adapterLabels={adapterLabels}
                  agentStatusDot={agentStatusDot}
                  agentStatusDotDefault={agentStatusDotDefault}
                  liveRunByAgent={liveRunByAgent}
                  queuedRunByAgent={queuedRunByAgent}
                  agentRouteRef={agentRouteRef}
                  pendingAction={pendingByAgentId[agent.id]}
                  updatingField={updatingFieldByAgentId[agent.id]}
                  onPauseResume={handlePauseResume}
                  onQuickUpdateAgent={handleQuickUpdateAgent}
                />
              ))}
            </SortableContext>
          </div>
        </DndContext>
      )}

      {effectiveView === "list" && agents && agents.length > 0 && filtered.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No agents match the selected filter.
        </p>
      )}

      {/* Org chart view */}
      {effectiveView === "org" && filteredOrg.length > 0 && (
        <div className="border border-border py-1">
          {filteredOrg.map((node) => (
            <OrgTreeNode
              key={node.id}
              node={node}
              depth={0}
              companyId={selectedCompanyId}
              agentMap={agentMap}
              liveRunByAgent={liveRunByAgent}
              queuedRunByAgent={queuedRunByAgent}
              pendingByAgentId={pendingByAgentId}
              updatingFieldByAgentId={updatingFieldByAgentId}
              onPauseResume={handlePauseResume}
              onQuickUpdateAgent={handleQuickUpdateAgent}
            />
          ))}
        </div>
      )}

      {effectiveView === "org" && orgTree && orgTree.length > 0 && filteredOrg.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No agents match the selected filter.
        </p>
      )}

      {effectiveView === "org" && orgTree && orgTree.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No organizational hierarchy defined.
        </p>
      )}
    </div>
  );
}

function AgentPauseResumeActions({
  agentId,
  status,
  pendingAction,
  onAction,
  compact = false,
}: {
  agentId: string;
  status: string;
  pendingAction?: AgentRowAction;
  onAction: (agentId: string, action: AgentRowAction) => void;
  compact?: boolean;
}) {
  const isMutating = Boolean(pendingAction);
  const toggleAction = pauseToggleAction(status);
  const toggleDisabled = isPauseToggleDisabled(status, isMutating);
  const heartbeatDisabled = isRunHeartbeatDisabled(status, isMutating);
  const toggleLabel = toggleAction === "resume" ? "Resume" : "Pause";

  return (
    <div
      className="flex items-center gap-1 shrink-0"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={toggleDisabled}
        title={toggleAction === "resume" ? "Tiếp tục chạy agent (Resume)" : "Tạm dừng agent (Pause)"}
        className="min-w-[4.75rem] justify-start"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onAction(agentId, toggleAction);
        }}
      >
        {pendingAction === "pause" || pendingAction === "resume" ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : toggleAction === "resume" ? (
          <Play className="h-3 w-3" />
        ) : (
          <Pause className="h-3 w-3" />
        )}
        <span className={compact ? "sr-only" : undefined}>{toggleLabel}</span>
      </Button>
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={heartbeatDisabled}
        title={
          status === "paused"
            ? "Agent đang tạm dừng — bấm Resume trước khi chạy heartbeat"
            : "Chạy heartbeat ngay (Run Heartbeat)"
        }
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onAction(agentId, "invoke");
        }}
      >
        {pendingAction === "invoke" ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <HeartPulse className="h-3 w-3" />
        )}
        <span className={compact ? "sr-only" : undefined}>Heartbeat</span>
      </Button>
    </div>
  );
}

function AgentScheduleQuickEdit({
  agent,
  isUpdating,
  onQuickUpdateAgent,
}: {
  agent: Agent;
  isUpdating: boolean;
  onQuickUpdateAgent: (
    agentId: string,
    field: "model" | "schedule",
    patch: Record<string, unknown>,
    successTitle: string,
  ) => Promise<boolean>;
}) {
  const effectiveCron = getAgentScheduleCron(agent);
  const [open, setOpen] = useState(false);
  const [draftCron, setDraftCron] = useState<string>(effectiveCron || "0 9 * * *");

  useEffect(() => {
    if (open) {
      setDraftCron(effectiveCron || "0 9 * * *");
    }
  }, [open, effectiveCron]);

  const applySchedule = async (nextCron: string) => {
    const trimmed = nextCron.trim();
    const existingRc = ((agent.runtimeConfig ?? {}) as Record<string, unknown>);
    const existingHb = ((existingRc.heartbeat ?? {}) as Record<string, unknown>);
    const existingMeta = ((agent.metadata ?? {}) as Record<string, unknown>);

    const patch: Record<string, unknown> = {
      runtimeConfig: {
        ...existingRc,
        heartbeat: {
          ...existingHb,
          enabled: trimmed.length > 0 ? true : false,
          cronExpression: trimmed,
        },
      },
      ...("schedule" in existingMeta
        ? {
            metadata: {
              ...existingMeta,
              schedule: trimmed.length > 0 ? trimmed : null,
            },
          }
        : {}),
    };

    const ok = await onQuickUpdateAgent(
      agent.id,
      "schedule",
      patch,
      trimmed.length > 0
        ? `Đã cập nhật lịch cho ${agent.name} (${formatSchedule(trimmed)})`
        : `Đã đặt lịch ${agent.name} về Không cố định`,
    );
    if (ok) {
      setOpen(false);
    }
  };

  return (
    <div
      className="w-64 shrink-0 border-l border-border/50 pl-2"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <div
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={isUpdating}
              title="Bấm để sửa lịch Heartbeat"
              className="flex flex-col items-start justify-center w-full px-1.5 py-1 rounded-sm hover:bg-accent/60 transition-colors text-left group/schedule cursor-pointer disabled:opacity-60"
            >
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground group-hover/schedule:text-foreground font-semibold truncate w-full">
                <span className="truncate">
                  Lịch: {formatSchedule(effectiveCron)}
                </span>
                {isUpdating ? (
                  <Loader2 className="h-2.5 w-2.5 animate-spin shrink-0 ml-auto" />
                ) : (
                  <ChevronDown className="h-3 w-3 opacity-50 group-hover/schedule:opacity-100 transition-opacity shrink-0 ml-auto" />
                )}
              </span>
              <span className="text-xs text-muted-foreground truncate w-full">
                {agent.lastHeartbeatAt ? formatDateTime(agent.lastHeartbeatAt) : "Chưa từng chạy"}
              </span>
            </button>
          </PopoverTrigger>
        </div>
        <PopoverContent
          align="start"
          className="w-[360px] sm:w-[400px] p-3 space-y-3"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between border-b border-border pb-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <CalendarClock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-xs font-semibold truncate">
                Lịch Heartbeat — {agent.name}
              </span>
            </div>
            {effectiveCron && (
              <button
                type="button"
                disabled={isUpdating}
                onClick={() => void applySchedule("")}
                className="text-[11px] text-destructive hover:underline shrink-0 cursor-pointer disabled:opacity-50"
              >
                Không cố định
              </button>
            )}
          </div>

          <HeartbeatScheduleBuilder
            value={draftCron}
            onChange={(cron) => setDraftCron(cron)}
          />

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={isUpdating}
              onClick={() => setOpen(false)}
            >
              Hủy
            </Button>
            <Button
              type="button"
              variant="default"
              size="xs"
              disabled={isUpdating || !draftCron.trim()}
              onClick={() => void applySchedule(draftCron)}
            >
              {isUpdating && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
              Lưu lịch
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function AgentModelQuickEdit({
  agent,
  companyId,
  adapterLabels,
  isUpdating,
  onQuickUpdateAgent,
}: {
  agent: Agent;
  companyId: string;
  adapterLabels: Record<string, string>;
  isUpdating: boolean;
  onQuickUpdateAgent: (
    agentId: string,
    field: "model" | "schedule",
    patch: Record<string, unknown>,
    successTitle: string,
  ) => Promise<boolean>;
}) {
  const currentModel = typeof agent.adapterConfig?.model === "string" ? agent.adapterConfig.model : "";
  const [open, setOpen] = useState(false);
  const [selectedAdapter, setSelectedAdapter] = useState<string>(agent.adapterType);
  const [modelSearch, setModelSearch] = useState("");

  useEffect(() => {
    if (open) {
      setSelectedAdapter(agent.adapterType);
      setModelSearch("");
    }
  }, [open, agent.adapterType]);

  const { data: adapterModels, isLoading: modelsLoading } = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId, selectedAdapter),
    queryFn: () => agentsApi.adapterModels(companyId, selectedAdapter),
    enabled: open && Boolean(companyId),
  });

  const adapterOptions = useMemo(() => {
    const list: string[] = [...QUICK_EDIT_ADAPTERS];
    if (agent.adapterType && !list.includes(agent.adapterType)) {
      list.unshift(agent.adapterType);
    }
    return list;
  }, [agent.adapterType]);

  const filteredModels = useMemo(() => {
    const list = adapterModels ?? [];
    const q = modelSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q),
    );
  }, [adapterModels, modelSearch]);

  const handleSelectModel = async (nextAdapter: string, nextModel: string) => {
    const adapterChanged = nextAdapter !== agent.adapterType;
    const existingConfig = ((agent.adapterConfig ?? {}) as Record<string, unknown>);
    const nextConfig: Record<string, unknown> = adapterChanged
      ? {
          ...existingConfig,
          model: nextModel || undefined,
          effort: "",
          modelReasoningEffort: "",
          variant: "",
          mode: "",
          ...(nextAdapter === "codex_local"
            ? {
                dangerouslyBypassApprovalsAndSandbox:
                  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
              }
            : {}),
        }
      : {
          ...existingConfig,
          model: nextModel || undefined,
        };

    const patch: Record<string, unknown> = adapterChanged
      ? { adapterType: nextAdapter, adapterConfig: nextConfig }
      : { adapterConfig: nextConfig };

    const labelDisplay = nextModel || "Default";
    const ok = await onQuickUpdateAgent(
      agent.id,
      "model",
      patch,
      `Đã đổi model ${agent.name} sang ${adapterLabels[nextAdapter] ?? nextAdapter} · ${labelDisplay}`,
    );
    if (ok) {
      setOpen(false);
    }
  };

  return (
    <div
      className="w-36 shrink-0 border-l border-border/50 pl-2"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <div
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={isUpdating}
              title="Bấm để đổi Adapter / Model"
              className="flex flex-col items-end justify-center w-full px-1.5 py-1 rounded-sm hover:bg-accent/60 transition-colors text-right group/model cursor-pointer disabled:opacity-60"
            >
              <span className="flex items-center justify-end gap-1 text-xs text-foreground font-medium truncate w-full">
                <span className="truncate">
                  {adapterLabels[agent.adapterType] ?? agent.adapterType}
                </span>
                {isUpdating ? (
                  <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                ) : (
                  <ChevronDown className="h-3 w-3 text-muted-foreground opacity-50 group-hover/model:opacity-100 transition-opacity shrink-0" />
                )}
              </span>
              <span
                className="text-[10px] text-muted-foreground text-right truncate w-full"
                title={currentModel || "Default"}
              >
                {currentModel || "Default"}
              </span>
            </button>
          </PopoverTrigger>
        </div>
        <PopoverContent
          align="end"
          className="w-80 p-3 space-y-2.5"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between border-b border-border pb-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <Cpu className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-xs font-semibold truncate">
                Đổi Model — {agent.name}
              </span>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Adapter
            </label>
            <div className="flex flex-wrap gap-1">
              {adapterOptions.map((adapterKey) => {
                const active = selectedAdapter === adapterKey;
                return (
                  <button
                    key={adapterKey}
                    type="button"
                    onClick={() => setSelectedAdapter(adapterKey)}
                    className={cn(
                      "px-2 py-0.5 rounded text-[11px] border transition-colors cursor-pointer",
                      active
                        ? "bg-primary text-primary-foreground border-primary font-medium"
                        : "bg-background text-muted-foreground border-border hover:bg-accent/60 hover:text-foreground",
                    )}
                  >
                    {adapterLabels[adapterKey] ?? adapterKey}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Model ({adapterLabels[selectedAdapter] ?? selectedAdapter})
              </label>
              {selectedAdapter !== agent.adapterType && (
                <button
                  type="button"
                  disabled={isUpdating}
                  onClick={() =>
                    void handleSelectModel(
                      selectedAdapter,
                      getDefaultModelForAdapter(selectedAdapter),
                    )
                  }
                  className="text-[10px] text-primary hover:underline cursor-pointer"
                >
                  Dùng mặc định adapter này
                </button>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <Input
                type="text"
                placeholder="Tìm hoặc nhập mã model..."
                value={modelSearch}
                onChange={(e) => setModelSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && modelSearch.trim()) {
                    e.preventDefault();
                    void handleSelectModel(selectedAdapter, modelSearch.trim());
                  }
                }}
                className="h-7 text-xs"
              />
              {modelSearch.trim() && (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={isUpdating}
                  onClick={() => void handleSelectModel(selectedAdapter, modelSearch.trim())}
                >
                  Đặt
                </Button>
              )}
            </div>
          </div>

          <div className="max-h-56 overflow-y-auto border border-border rounded-sm divide-y divide-border/40">
            {selectedAdapter !== "opencode_local" && !modelSearch.trim() && (
              <button
                type="button"
                disabled={isUpdating}
                onClick={() => void handleSelectModel(selectedAdapter, "")}
                className={cn(
                  "flex items-center justify-between w-full px-2.5 py-1.5 text-xs text-left hover:bg-accent/60 transition-colors cursor-pointer",
                  selectedAdapter === agent.adapterType && !currentModel && "bg-accent/40 font-medium",
                )}
              >
                <span>Default (Mặc định của adapter)</span>
                {selectedAdapter === agent.adapterType && !currentModel && (
                  <Check className="h-3.5 w-3.5 text-primary shrink-0" />
                )}
              </button>
            )}

            {modelsLoading ? (
              <div className="flex items-center justify-center gap-1.5 py-4 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Đang tải danh sách model...</span>
              </div>
            ) : filteredModels.length > 0 ? (
              filteredModels.map((item) => {
                const isSelected =
                  selectedAdapter === agent.adapterType && item.id === currentModel;
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={isUpdating}
                    onClick={() => void handleSelectModel(selectedAdapter, item.id)}
                    className={cn(
                      "flex items-center justify-between gap-2 w-full px-2.5 py-1.5 text-xs text-left hover:bg-accent/60 transition-colors cursor-pointer",
                      isSelected && "bg-accent/40 font-medium",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{item.label || item.id}</div>
                      {item.label && item.label !== item.id && (
                        <div className="text-[10px] text-muted-foreground font-mono truncate">
                          {item.id}
                        </div>
                      )}
                    </div>
                    {isSelected && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
                  </button>
                );
              })
            ) : (
              <div className="px-2.5 py-3 text-xs text-muted-foreground text-center">
                {modelSearch.trim()
                  ? `Nhấn Enter hoặc bấm "Đặt" để dùng model "${modelSearch.trim()}"`
                  : "Không có model cấu hình sẵn cho adapter này."}
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function SortableAgentRow({
  agent,
  companyId,
  roleLabels,
  adapterLabels,
  agentStatusDot,
  agentStatusDotDefault,
  liveRunByAgent,
  queuedRunByAgent,
  agentRouteRef,
  pendingAction,
  updatingField,
  onPauseResume,
  onQuickUpdateAgent,
}: any) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: agent.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : 1,
    position: "relative" as const,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex group bg-background border-b border-border last:border-b-0",
        isDragging && "opacity-50"
      )}
    >
      <div
        {...attributes}
        {...listeners}
        className="flex items-center justify-center px-2 cursor-grab active:cursor-grabbing hover:bg-accent/50 text-muted-foreground hover:text-foreground"
      >
        <GripVertical className="h-4 w-4 opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
      <div className="flex-1 min-w-0">
        <EntityRow
          className="border-b-0"
          title={agent.name}
          subtitle={`${roleLabels[agent.role] ?? agent.role}${agent.title ? ` - ${agent.title}` : ""}`}
          to={agentUrl(agent)}
          leading={
            <span className="relative flex h-2.5 w-2.5">
              <span
                className={`absolute inline-flex h-full w-full rounded-full ${agentStatusDot[agent.status] ?? agentStatusDotDefault}`}
              />
            </span>
          }
          trailing={
            <div className="flex items-center gap-3">
              <span className="sm:hidden flex items-center gap-1.5">
                {liveRunByAgent.has(agent.id) && (
                  <LiveRunIndicator
                    agentRef={agentRouteRef(agent)}
                    runId={liveRunByAgent.get(agent.id)!.runId}
                    liveCount={liveRunByAgent.get(agent.id)!.liveCount}
                  />
                )}
                {queuedRunByAgent.has(agent.id) && (
                  <QueuedRunIndicator
                    agentRef={agentRouteRef(agent)}
                    runId={queuedRunByAgent.get(agent.id)!.runId}
                    queuedCount={queuedRunByAgent.get(agent.id)!.queuedCount}
                  />
                )}
                {!liveRunByAgent.has(agent.id) && !queuedRunByAgent.has(agent.id) && (
                  <StatusBadge status={agent.status} />
                )}
                <AgentPauseResumeActions
                  agentId={agent.id}
                  status={agent.status}
                  pendingAction={pendingAction}
                  onAction={onPauseResume}
                  compact
                />
              </span>
              <div className="hidden sm:flex items-center gap-3">
                {liveRunByAgent.has(agent.id) && (
                  <LiveRunIndicator
                    agentRef={agentRouteRef(agent)}
                    runId={liveRunByAgent.get(agent.id)!.runId}
                    liveCount={liveRunByAgent.get(agent.id)!.liveCount}
                  />
                )}
                {queuedRunByAgent.has(agent.id) && (
                  <QueuedRunIndicator
                    agentRef={agentRouteRef(agent)}
                    runId={queuedRunByAgent.get(agent.id)!.runId}
                    queuedCount={queuedRunByAgent.get(agent.id)!.queuedCount}
                  />
                )}
                <AgentScheduleQuickEdit
                  agent={agent}
                  isUpdating={updatingField === "schedule"}
                  onQuickUpdateAgent={onQuickUpdateAgent}
                />
                <AgentModelQuickEdit
                  agent={agent}
                  companyId={companyId}
                  adapterLabels={adapterLabels}
                  isUpdating={updatingField === "model"}
                  onQuickUpdateAgent={onQuickUpdateAgent}
                />
                <span className="text-xs text-muted-foreground w-16 text-right shrink-0">
                  {agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "—"}
                </span>
                <div className="flex items-center justify-end gap-2 shrink-0">
                  <span className="w-20 flex justify-end">
                    <StatusBadge status={agent.status} />
                  </span>
                  <AgentPauseResumeActions
                    agentId={agent.id}
                    status={agent.status}
                    pendingAction={pendingAction}
                    onAction={onPauseResume}
                  />
                </div>
              </div>
            </div>
          }
        />
      </div>
    </div>
  );
}

function OrgTreeNode({
  node,
  depth,
  companyId,
  agentMap,
  liveRunByAgent,
  queuedRunByAgent,
  pendingByAgentId,
  updatingFieldByAgentId,
  onPauseResume,
  onQuickUpdateAgent,
}: {
  node: OrgNode;
  depth: number;
  companyId: string;
  agentMap: Map<string, Agent>;
  liveRunByAgent: Map<string, { runId: string; liveCount: number }>;
  queuedRunByAgent: Map<string, { runId: string; queuedCount: number }>;
  pendingByAgentId: Record<string, AgentRowAction>;
  updatingFieldByAgentId: Record<string, "model" | "schedule">;
  onPauseResume: (agentId: string, action: AgentRowAction) => void;
  onQuickUpdateAgent: (
    agentId: string,
    field: "model" | "schedule",
    patch: Record<string, unknown>,
    successTitle: string,
  ) => Promise<boolean>;
}) {
  const agent = agentMap.get(node.id);
  const currentStatus = agent?.status ?? node.status;

  const statusColor = agentStatusDot[currentStatus] ?? agentStatusDotDefault;

  return (
    <div style={{ paddingLeft: depth * 24 }}>
      <Link
        to={agent ? agentUrl(agent) : `/agents/${node.id}`}
        className="flex items-center gap-3 px-3 py-2 hover:bg-accent/30 transition-colors w-full text-left no-underline text-inherit"
      >
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className={`absolute inline-flex h-full w-full rounded-full ${statusColor}`} />
        </span>
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium">{node.name}</span>
          <span className="text-xs text-muted-foreground ml-2">
            {roleLabels[node.role] ?? node.role}
            {agent?.title ? ` - ${agent.title}` : ""}
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="sm:hidden flex items-center gap-1.5">
            {liveRunByAgent.has(node.id) && (
              <LiveRunIndicator
                agentRef={agent ? agentRouteRef(agent) : node.id}
                runId={liveRunByAgent.get(node.id)!.runId}
                liveCount={liveRunByAgent.get(node.id)!.liveCount}
              />
            )}
            {queuedRunByAgent.has(node.id) && (
              <QueuedRunIndicator
                agentRef={agent ? agentRouteRef(agent) : node.id}
                runId={queuedRunByAgent.get(node.id)!.runId}
                queuedCount={queuedRunByAgent.get(node.id)!.queuedCount}
              />
            )}
            {!liveRunByAgent.has(node.id) && !queuedRunByAgent.has(node.id) && (
              <StatusBadge status={currentStatus} />
            )}
            <AgentPauseResumeActions
              agentId={node.id}
              status={currentStatus}
              pendingAction={pendingByAgentId[node.id]}
              onAction={onPauseResume}
              compact
            />
          </span>
          <div className="hidden sm:flex items-center gap-3">
            {liveRunByAgent.has(node.id) && (
              <LiveRunIndicator
                agentRef={agent ? agentRouteRef(agent) : node.id}
                runId={liveRunByAgent.get(node.id)!.runId}
                liveCount={liveRunByAgent.get(node.id)!.liveCount}
              />
            )}
            {queuedRunByAgent.has(node.id) && (
              <QueuedRunIndicator
                agentRef={agent ? agentRouteRef(agent) : node.id}
                runId={queuedRunByAgent.get(node.id)!.runId}
                queuedCount={queuedRunByAgent.get(node.id)!.queuedCount}
              />
            )}
            {agent && (
              <>
                <AgentScheduleQuickEdit
                  agent={agent}
                  isUpdating={updatingFieldByAgentId[node.id] === "schedule"}
                  onQuickUpdateAgent={onQuickUpdateAgent}
                />
                <AgentModelQuickEdit
                  agent={agent}
                  companyId={companyId}
                  adapterLabels={adapterLabels}
                  isUpdating={updatingFieldByAgentId[node.id] === "model"}
                  onQuickUpdateAgent={onQuickUpdateAgent}
                />
                <span className="text-xs text-muted-foreground w-16 text-right shrink-0">
                  {agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "—"}
                </span>
              </>
            )}
            <div className="flex items-center justify-end gap-2 shrink-0">
              <span className="w-20 flex justify-end">
                <StatusBadge status={currentStatus} />
              </span>
              <AgentPauseResumeActions
                agentId={node.id}
                status={currentStatus}
                pendingAction={pendingByAgentId[node.id]}
                onAction={onPauseResume}
              />
            </div>
          </div>
        </div>
      </Link>
      {node.reports && node.reports.length > 0 && (
        <div className="border-l border-border/50 ml-4">
          {node.reports.map((child) => (
            <OrgTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              companyId={companyId}
              agentMap={agentMap}
              liveRunByAgent={liveRunByAgent}
              queuedRunByAgent={queuedRunByAgent}
              pendingByAgentId={pendingByAgentId}
              updatingFieldByAgentId={updatingFieldByAgentId}
              onPauseResume={onPauseResume}
              onQuickUpdateAgent={onQuickUpdateAgent}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function LiveRunIndicator({
  agentRef,
  runId,
  liveCount,
}: {
  agentRef: string;
  runId: string;
  liveCount: number;
}) {
  return (
    <Link
      to={`/agents/${agentRef}/runs/${runId}`}
      className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-500/10 hover:bg-blue-500/20 transition-colors no-underline"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="relative flex h-2 w-2">
        <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
      </span>
      <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">
        Live{liveCount > 1 ? ` (${liveCount})` : ""}
      </span>
    </Link>
  );
}

function QueuedRunIndicator({
  agentRef,
  runId,
  queuedCount,
}: {
  agentRef: string;
  runId: string;
  queuedCount: number;
}) {
  return (
    <Link
      to={`/agents/${agentRef}/runs/${runId}`}
      className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-500/10 hover:bg-amber-500/20 transition-colors no-underline"
      onClick={(e) => e.stopPropagation()}
      title="Đang xếp hàng chờ chỗ chạy"
    >
      <span className="relative flex h-2 w-2">
        <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
      </span>
      <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
        Queued{queuedCount > 1 ? ` (${queuedCount})` : ""}
      </span>
    </Link>
  );
}
