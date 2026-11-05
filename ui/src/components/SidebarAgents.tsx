import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import {
  DndContext,
  closestCenter,
  MouseSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { NavLink, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Plus, Filter, Inbox, Users } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { heartbeatsApi } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { cn, agentRouteRef, agentUrl } from "../lib/utils";
import { useAgentOrder } from "../hooks/useAgentOrder";
import { AgentIcon } from "./AgentIconPicker";
import { SidebarSection } from "./SidebarSection";
import { BudgetSidebarMarker } from "./BudgetSidebarMarker";
import type { Agent } from "@paperclipai/shared";
export function SidebarAgents({
  label = "Agents",
  onLabelChange,
  dragHandleListeners,
  dragHandleAttributes
}: {
  label?: string,
  onLabelChange?: (label: string) => void,
  dragHandleListeners?: any,
  dragHandleAttributes?: any
}) {
  const { selectedCompanyId } = useCompany();
  const { openNewAgent } = useDialog();
  const { isMobile, setSidebarOpen } = useSidebar();
  const location = useLocation();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });

  const liveCountByAgent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const run of liveRuns ?? []) {
      if (run.status !== "running") continue;
      counts.set(run.agentId, (counts.get(run.agentId) ?? 0) + 1);
    }
    return counts;
  }, [liveRuns]);

  const visibleAgents = useMemo(() => {
    const filtered = (agents ?? []).filter(
      (a: Agent) => a.status !== "terminated"
    );
    return filtered;
  }, [agents]);
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const { orderedAgents } = useAgentOrder({
    agents: visibleAgents,
    companyId: selectedCompanyId,
    userId: currentUserId,
  });

  const [sortOrder, setSortOrder] = useState<"custom" | "role" | "name">("custom");

  const displayAgents = useMemo(() => {
    if (sortOrder === "custom") return orderedAgents;
    return [...orderedAgents].sort((a, b) => {
      if (sortOrder === "role") {
        return a.role.localeCompare(b.role) || a.name.localeCompare(b.name);
      }
      return a.name.localeCompare(b.name);
    });
  }, [orderedAgents, sortOrder]);

  const agentMatch = location.pathname.match(/^\/(?:[^/]+\/)?agents\/([^/]+)(?:\/([^/]+))?/);
  const activeAgentId = agentMatch?.[1] ?? null;
  const activeTab = agentMatch?.[2] ?? null;

  const { persistOrder } = useAgentOrder({
    agents: visibleAgents,
    companyId: selectedCompanyId,
    userId: currentUserId,
  });

  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (sortOrder !== "custom") return;
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const ids = orderedAgents.map((a: Agent) => a.id);
      const oldIndex = ids.indexOf(active.id as string);
      const newIndex = ids.indexOf(over.id as string);
      if (oldIndex === -1 || newIndex === -1) return;

      persistOrder(arrayMove(ids, oldIndex, newIndex));
    },
    [orderedAgents, persistOrder, sortOrder],
  );

  const actionButtons = (
    <div className="flex items-center">
      <span className="opacity-70 font-sans normal-case text-[10px] mr-1">({visibleAgents.length})</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          openNewAgent();
        }}
        className="flex items-center justify-center h-4 w-4 rounded text-muted-foreground/60 hover:text-foreground hover:bg-accent/50 transition-colors"
        aria-label="New agent"
      >
        <Plus className="h-3 w-3" />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            onClick={(e) => e.stopPropagation()}
            className="flex items-center justify-center h-4 w-4 rounded text-muted-foreground/60 hover:text-foreground hover:bg-accent/50 transition-colors ml-1"
            aria-label="Sort agents"
          >
            <Filter className="h-3 w-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuLabel>Sắp xếp Agents</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup value={sortOrder} onValueChange={(v) => setSortOrder(v as any)}>
            <DropdownMenuRadioItem value="custom">Tùy chỉnh (Kéo thả)</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="role">Theo loại (Role)</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="name">Theo tên (A-Z)</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  return (
    <SidebarSection
      label={label}
      onLabelChange={onLabelChange}
      dragHandleListeners={dragHandleListeners}
      dragHandleAttributes={dragHandleAttributes}
      action={actionButtons}
    >
      <DndContext
        id="agents-context"
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={displayAgents.map((a: Agent) => a.id)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-0.5 mt-0.5 mb-2">
            {displayAgents.map((agent: Agent) => {
              const runCount = liveCountByAgent.get(agent.id) ?? 0;
              return (
                <SortableAgentItem
                  key={agent.id}
                  agent={agent}
                  activeTab={activeTab}
                  isMobile={isMobile}
                  setSidebarOpen={setSidebarOpen}
                  activeAgentId={activeAgentId}
                  runCount={runCount}
                />
              );
            })}
          </div>
        </SortableContext>
      </DndContext>
    </SidebarSection>
  );
}

function SortableAgentItem({
  agent,
  activeTab,
  isMobile,
  setSidebarOpen,
  activeAgentId,
  runCount,
}: {
  agent: Agent;
  activeTab: string | null;
  isMobile: boolean;
  setSidebarOpen: (v: boolean) => void;
  activeAgentId: string | null;
  runCount: number;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: agent.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : 1,
    position: "relative" as const,
  };

  return (
    <div ref={setNodeRef} {...{ style: style }} {...attributes} {...listeners} className={isDragging ? "opacity-50" : ""}>
      <NavLink
        to={activeTab ? `${agentUrl(agent)}/${activeTab}` : agentUrl(agent)}
        onClick={() => {
          if (isMobile) setSidebarOpen(false);
        }}
        className={cn(
          "flex items-center gap-2.5 px-3 py-1.5 text-[13px] font-medium transition-colors",
          activeAgentId === agentRouteRef(agent)
            ? "bg-accent text-foreground"
            : "text-foreground/80 hover:bg-accent/50 hover:text-foreground"
        )}
      >
        <AgentIcon icon={agent.icon} className="shrink-0 h-3.5 w-3.5 text-muted-foreground" />
        <span className="flex-1 truncate">{agent.name}</span>
        {(agent.pauseReason === "budget" || runCount > 0) && (
          <span className="ml-auto flex items-center gap-1.5 shrink-0">
            {agent.pauseReason === "budget" ? <BudgetSidebarMarker title="Agent paused by budget" /> : null}
            {runCount > 0 ? (
              <span className="relative flex h-2 w-2">
                <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
              </span>
            ) : null}
            {runCount > 0 ? (
              <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">{runCount} live</span>
            ) : null}
          </span>
        )}
      </NavLink>
    </div>
  );
}
