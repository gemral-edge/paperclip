import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { dashboardApi } from "../api/dashboard";
import { activityApi } from "../api/activity";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import KGMiniWidget from "@/components/knowledge-graph/KGMiniWidget";
import TimetableWidget from "@/components/timetable/TimetableWidget";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { MetricCard } from "../components/MetricCard";
import { EmptyState } from "../components/EmptyState";
import { StatusIcon } from "../components/StatusIcon";
import { ActivityRow } from "../components/ActivityRow";
import { Identity } from "../components/Identity";
import { timeAgo } from "../lib/timeAgo";
import { cn, formatCents } from "../lib/utils";
import { Bot, CircleDot, DollarSign, ShieldCheck, LayoutDashboard, PauseCircle, GripVertical } from "lucide-react";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { UnifiedTasksAndActivity } from "../components/UnifiedTasksAndActivity";
import { ChartCard, RunActivityChart, PriorityChart, IssueStatusChart, SuccessRateChart } from "../components/ActivityCharts";
import { PageSkeleton } from "../components/PageSkeleton";
import type { Agent, Issue } from "@paperclipai/shared";
import { PluginSlotOutlet } from "@/plugins/slots";
import { useLiveInvalidate } from "@/hooks/useLiveInvalidate";
import { ChannelStatusCards } from "@/components/ops/ChannelStatusCards";
import { AgentStatusGrid } from "@/components/ops/AgentStatusGrid";
import { CRMPipelineCard } from "@/components/ops/CRMPipelineCard";
import { ActivityFeed } from "@/components/ops/ActivityFeed";
import { CapabilitiesGrid } from "@/components/ops/CapabilitiesGrid";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

// ─── Card order persistence ────────────────────────────────────────────────

const DEFAULT_CARD_ORDER = [
  "channels-agents",
  "capabilities",
  "crm-activity",
  "active-agents",
  "timetable",
  "metrics",
  "charts",
  "kg-widget",
  "tasks-activity",
] as const;

type CardId = (typeof DEFAULT_CARD_ORDER)[number];

const CARD_ORDER_STORAGE_KEY = "paperclip-dashboard-card-order-v1";

function loadCardOrder(): CardId[] {
  try {
    const stored = localStorage.getItem(CARD_ORDER_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as string[];
      const validSet = new Set<string>(DEFAULT_CARD_ORDER);
      const filtered = parsed.filter((id) => validSet.has(id)) as CardId[];
      const missing = Array.from(DEFAULT_CARD_ORDER).filter((id) => !filtered.includes(id));
      return [...filtered, ...missing];
    }
  } catch {
    // ignore corrupt localStorage
  }
  return Array.from(DEFAULT_CARD_ORDER);
}

function saveCardOrder(order: CardId[]): void {
  try {
    localStorage.setItem(CARD_ORDER_STORAGE_KEY, JSON.stringify(order));
  } catch {
    // ignore quota errors
  }
}

// ─── Sortable card wrapper ─────────────────────────────────────────────────

function DashboardCard({ id, children }: { id: CardId; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        zIndex: isDragging ? 10 : undefined,
      }}
      className="relative group"
    >
      {/* Drag handle — appears on hover */}
      <button
        {...attributes}
        {...listeners}
        aria-label="Kéo để sắp xếp lại"
        tabIndex={-1}
        className="absolute top-2 right-2 z-20 p-1 rounded opacity-0 group-hover:opacity-40 hover:!opacity-80 cursor-grab active:cursor-grabbing text-muted-foreground touch-none select-none bg-background/60"
      >
        <GripVertical size={14} />
      </button>
      {children}
    </div>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function getRecentIssues(issues: Issue[]): Issue[] {
  return [...issues].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────

export function Dashboard() {
  const { selectedCompanyId, companies } = useCompany();
  const { openOnboarding } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();

  const [cardOrder, setCardOrder] = useState<CardId[]>(() => loadCardOrder());
  const [animatedActivityIds, setAnimatedActivityIds] = useState<Set<string>>(new Set());
  const seenActivityIdsRef = useRef<Set<string>>(new Set());
  const hydratedActivityRef = useRef(false);
  const activityAnimationTimersRef = useRef<number[]>([]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Scroll to top on mount + sau khi data render xong (loading → content shift).
  // Layout có <main id="main-content" overflow-auto> → main IS scroll container
  // ở desktop (window không scroll). Mobile dùng window scroll. Phải đụng cả 2.
  // history.scrollRestoration='manual' để reload không restore scroll cũ.
  useLayoutEffect(() => {
    if (typeof history !== "undefined" && "scrollRestoration" in history) {
      history.scrollRestoration = "manual";
    }
    const main = document.getElementById("main-content");
    if (main) main.scrollTop = 0;
    window.scrollTo(0, 0);
    // Defer 1 frame: data có thể async render (recent tasks, activity) đẩy
    // page cao thêm sau initial paint → scroll lại để stick đầu trang.
    const raf = requestAnimationFrame(() => {
      const m = document.getElementById("main-content");
      if (m) m.scrollTop = 0;
      window.scrollTo(0, 0);
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    setBreadcrumbs([{ label: "Dashboard", href: "/dashboard" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.dashboard(selectedCompanyId!),
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    retry: 1,
    staleTime: 30_000,
  });

  const { data: activity } = useQuery({
    queryKey: queryKeys.activity(selectedCompanyId!),
    queryFn: () => activityApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: issues } = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId!), { includeHidden: true }],
    queryFn: () => issuesApi.list(selectedCompanyId!, { includeHidden: true }),
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  useLiveInvalidate({
    tables: [
      "crm_customers",
      "crm_tickets",
      "crm_orders",
      "gem_sop_executions",
      "gem_pipelines",
      "channel_pending_messages",
      "activity_log",
      "cc_scripts",
      "cc_generation_jobs",
    ],
    queryKeys: [["crm", "stats"], ["dashboard"], ["activity"], ["heartbeats"]],
  });

  const { data: runs } = useQuery({
    queryKey: queryKeys.heartbeats(selectedCompanyId!),
    // F3 (pooler-stall): chỉ vẽ RunActivityChart (status/timestamp) → dùng listSummary (bỏ JSON blob).
    queryFn: () => heartbeatsApi.listSummary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const recentIssues = issues ? getRecentIssues(issues) : [];
  const recentActivity = useMemo(() => (activity ?? []).slice(0, 10), [activity]);

  useEffect(() => {
    for (const timer of activityAnimationTimersRef.current) window.clearTimeout(timer);
    activityAnimationTimersRef.current = [];
    seenActivityIdsRef.current = new Set();
    hydratedActivityRef.current = false;
    setAnimatedActivityIds(new Set());
  }, [selectedCompanyId]);

  useEffect(() => {
    if (recentActivity.length === 0) return;
    const seen = seenActivityIdsRef.current;
    const currentIds = recentActivity.map((e) => e.id);
    if (!hydratedActivityRef.current) {
      for (const id of currentIds) seen.add(id);
      hydratedActivityRef.current = true;
      return;
    }
    const newIds = currentIds.filter((id) => !seen.has(id));
    if (newIds.length === 0) {
      for (const id of currentIds) seen.add(id);
      return;
    }
    setAnimatedActivityIds((prev) => {
      const next = new Set(prev);
      for (const id of newIds) next.add(id);
      return next;
    });
    for (const id of newIds) seen.add(id);
    const timer = window.setTimeout(() => {
      setAnimatedActivityIds((prev) => {
        const next = new Set(prev);
        for (const id of newIds) next.delete(id);
        return next;
      });
      activityAnimationTimersRef.current = activityAnimationTimersRef.current.filter((t) => t !== timer);
    }, 980);
    activityAnimationTimersRef.current.push(timer);
  }, [recentActivity]);

  useEffect(() => {
    return () => {
      for (const timer of activityAnimationTimersRef.current) window.clearTimeout(timer);
    };
  }, []);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.identifier ?? i.id.slice(0, 8));
    for (const a of agents ?? []) map.set(`agent:${a.id}`, a.name);
    for (const p of projects ?? []) map.set(`project:${p.id}`, p.name);
    return map;
  }, [issues, agents, projects]);

  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.title);
    return map;
  }, [issues]);

  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setCardOrder((prev) => {
        const oldIndex = prev.indexOf(active.id as CardId);
        const newIndex = prev.indexOf(over.id as CardId);
        const next = arrayMove(prev, oldIndex, newIndex);
        saveCardOrder(next);
        return next;
      });
    }
  }

  // ── Render card by ID ────────────────────────────────────────────────────

  function renderCardContent(id: CardId) {
    switch (id) {
      case "channels-agents":
        return (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="rounded-xl border bg-card p-4">
              <ChannelStatusCards />
            </div>
            <div className="rounded-xl border bg-card p-4">
              <AgentStatusGrid />
            </div>
          </div>
        );

      case "capabilities":
        return (
          <div className="rounded-xl border bg-card p-4">
            <CapabilitiesGrid />
          </div>
        );

      case "crm-activity":
        return (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="rounded-xl border bg-card p-4">
              <CRMPipelineCard />
            </div>
            <div className="rounded-xl border bg-card p-4">
              <ActivityFeed />
            </div>
          </div>
        );

      case "active-agents":
        return <ActiveAgentsPanel companyId={selectedCompanyId!} />;

      case "timetable":
        return <TimetableWidget />;

      case "metrics":
        return (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <MetricCard
              icon={Bot}
              value={
                (data?.agents?.active ?? 0) +
                  (data?.agents?.running ?? 0) +
                  (data?.agents?.paused ?? 0) +
                  (data?.agents?.error ?? 0) ||
                (agents?.length ?? 0)
              }
              label="Agents Enabled"
              to="/agents"
              description={
                <span>
                  {data?.agents?.running ?? 0} running{", "}
                  {data?.agents?.paused ?? 0} paused{", "}
                  {data?.agents?.error ?? 0} errors
                </span>
              }
            />
            <MetricCard
              icon={CircleDot}
              value={data?.tasks?.inProgress ?? 0}
              label="Tasks In Progress"
              to="/issues"
              description={
                <span>
                  {data?.tasks?.open ?? 0} open{", "}
                  {data?.tasks?.blocked ?? 0} blocked
                </span>
              }
            />
          </div>
        );

      case "charts":
        return (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <ChartCard title="Run Activity" subtitle="Last 14 days">
              <RunActivityChart runs={runs ?? []} />
            </ChartCard>
            <ChartCard title="Issues by Priority" subtitle="Last 14 days">
              <PriorityChart issues={issues ?? []} />
            </ChartCard>
          </div>
        );

      case "kg-widget":
        return (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <KGMiniWidget />
          </div>
        );

      case "tasks-activity":
        return (
          <UnifiedTasksAndActivity
            companyId={selectedCompanyId!}
            issues={issues}
            activity={activity}
            agents={agents}
            projects={projects}
            animatedActivityIds={animatedActivityIds}
          />
        );
    }
  }

  // ── Early returns ────────────────────────────────────────────────────────

  if (!selectedCompanyId) {
    if (companies.length === 0) {
      return (
        <EmptyState
          icon={LayoutDashboard}
          message="Welcome to Paperclip. Set up your first company and agent to get started."
          action="Get Started"
          onAction={openOnboarding}
        />
      );
    }
    return (
      <EmptyState icon={LayoutDashboard} message="Create or select a company to view the dashboard." />
    );
  }

  if (isLoading && !error) {
    return <PageSkeleton variant="dashboard" />;
  }

  const hasNoAgents = agents !== undefined && agents.length === 0;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {hasNoAgents && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-500/25 dark:bg-amber-950/60">
          <div className="flex items-center gap-2.5">
            <Bot className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <p className="text-sm text-amber-900 dark:text-amber-100">You have no agents.</p>
          </div>
          <button
            onClick={() => openOnboarding({ initialStep: 2, companyId: selectedCompanyId! })}
            className="text-sm font-medium text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100 underline underline-offset-2 shrink-0"
          >
            Create one here
          </button>
        </div>
      )}

      {/* Budget incidents — always at top, not draggable */}
      {data?.budgets?.activeIncidents ? (
        <div className="flex items-start justify-between gap-3 rounded-xl border border-red-500/20 bg-[linear-gradient(180deg,rgba(255,80,80,0.12),rgba(255,255,255,0.02))] px-4 py-3">
          <div className="flex items-start gap-2.5">
            <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
            <div>
              <p className="text-sm font-medium text-red-50">
                {data.budgets.activeIncidents} active budget incident
                {data.budgets.activeIncidents === 1 ? "" : "s"}
              </p>
              <p className="text-xs text-red-100/70">
                {data.budgets.pausedAgents} agents paused · {data.budgets.pausedProjects} projects
                paused · {data.budgets.pendingApprovals} pending budget approvals
              </p>
            </div>
          </div>
          <Link to="/costs" className="text-sm underline underline-offset-2 text-red-100">
            Open budgets
          </Link>
        </div>
      ) : null}

      {/* Draggable cards */}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={cardOrder} strategy={verticalListSortingStrategy}>
          <div className="space-y-6">
            {cardOrder.map((id) => (
              <DashboardCard key={id} id={id}>
                {renderCardContent(id)}
              </DashboardCard>
            ))}
          </div>
        </SortableContext>
      </DndContext>

      <PluginSlotOutlet
        slotTypes={["dashboardWidget"]}
        context={{ companyId: selectedCompanyId }}
        className="grid gap-4 md:grid-cols-2"
        itemClassName="rounded-lg border bg-card p-4 shadow-sm"
      />
    </div>
  );
}
