import { useMemo } from "react";
import {
  Inbox,
  CircleDot,
  Target,
  LayoutDashboard,
  DollarSign,
  History,
  Search,
  SquarePen,
  Network,
  Boxes,
  Repeat,
  Settings,
  MessageCircle,
  Zap,
  Activity,
  BarChart3,
  UserCircle,
  Ticket,
  ShoppingBag,
  Mail,
  BookOpen,
  Terminal,
  Database,
  Sparkles,
  FileText,
  Calendar,
  RefreshCw,
  Image,
  Video,
  Filter,
  ClipboardList,
  Share2,
} from "lucide-react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { SidebarNavItem } from "./SidebarNavItem";
import { DraggableSidebarSection } from "./DraggableSidebarSection";
import { SidebarProjects } from "./SidebarProjects";
import { SidebarAgents } from "./SidebarAgents";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { heartbeatsApi } from "../api/heartbeats";
import { companiesApi } from "../api/companies";
import { queryKeys } from "../lib/queryKeys";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { useUnreadCount } from "../hooks/useUnreadCount";
import { useNotificationSound } from "../hooks/useNotificationSound";
import { Button } from "@/components/ui/button";
import { PluginSlotOutlet } from "@/plugins/slots";
import { useSidebarStaticItems } from "../hooks/useSidebarStaticItems";
import { DndContext, PointerSensor, useSensor, useSensors, closestCenter } from "@dnd-kit/core";
import { useSortable, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

function DraggableCustomSection({ id, children }: { id: string, children: (attributes: any, listeners: any) => React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} className="relative">
      {children(attributes, listeners)}
    </div>
  );
}

const SECTION_LABELS: Record<string, string> = {
  "kenh-chat": "Kênh Chat",
  "van-hanh": "Vận hành",
  "trung-tam-noi-dung": "Trung tâm Nội dung",
  "cau-hinh": "Cấu hình",
  "crm": "CRM",
  "work": "Work",
  "company": "Company",
};

export function Sidebar() {
  const { openNewIssue } = useDialog();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const inboxBadge = useInboxBadge(selectedCompanyId);
  const { totalUnread } = useUnreadCount();
  // Activate notification sound globally
  useNotificationSound();
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });
  // Chỉ đếm lượt đang chạy thật; `queued` (chờ chỗ chạy) không tính là live.
  const liveRunCount = liveRuns?.filter((run) => run.status === "running").length ?? 0;

  function openSearch() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
  }

  const pluginContext = {
    companyId: selectedCompanyId,
    companyPrefix: selectedCompany?.issuePrefix ?? null,
  };

  const { items, sectionOrder, sectionLabels, setSectionLabels, handleDragOver, handleDragEnd } = useSidebarStaticItems(selectedCompany?.sidebarConfig);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const { mutate: saveGlobalConfig, isPending: isSavingGlobal } = useMutation({
    mutationFn: () => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return companiesApi.updateBranding(selectedCompanyId, {
        sidebarConfig: { items, sectionOrder, sectionLabels },
      });
    },
    onSuccess: () => {
      // Success will invalidate companies or we could just trust it.
      // We don't have access to pushToast here, but we can just let it silently succeed.
    },
    onError: (err) => {
      console.error("Failed to save global config", err);
    }
  });

  const itemMap: Record<string, React.ReactNode> = useMemo(() => ({
    // Kênh Chat
    "/inbox": <SidebarNavItem to="/inbox" label="Inbox (Agents)" icon={Inbox} />,
    "/channels/inbox": <SidebarNavItem to="/channels/inbox" label="Hộp thư" icon={Inbox} badge={totalUnread > 0 ? totalUnread : undefined} badgeTone="danger" alert={totalUnread > 0} />,
    "/channels/settings": <SidebarNavItem to="/channels/settings" label="Cài đặt kênh" icon={Settings} />,
    "/war-room": <SidebarNavItem to="/war-room" label="War Room" icon={Zap} />,
    "/training": <SidebarNavItem to="/training" label="Phòng Training" icon={Activity} />,
    "/training/history": <SidebarNavItem to="/training/history" label="Lịch sử Training" icon={Activity} />,
    "/training/audit-log": <SidebarNavItem to="/training/audit-log" label="Tool Audit Log" icon={Activity} />,
    "/agents-config/sessions": <SidebarNavItem to="/agents-config/sessions" label="Phiên Agent" icon={Activity} />,

    // Vận hành
    "/ops/content-pipeline": <SidebarNavItem to="/ops/content-pipeline" label="Content Pipeline" icon={Activity} />,
    "/ops/sop-engine": <SidebarNavItem to="/ops/sop-engine" label="SOP Engine" icon={ClipboardList} />,
    "/ops/affiliate": <SidebarNavItem to="/ops/affiliate" label="Affiliate & CTV" icon={UserCircle} />,
    "/ops/scanner": <SidebarNavItem to="/ops/scanner" label="GEM Scanner" icon={Search} />,
    "/ops/knowledge-graph": <SidebarNavItem to="/ops/knowledge-graph" label="Mắt Thần CEO" icon={Network} />,
    "/analytics": <SidebarNavItem to="/analytics" label="Phân Tích MXH" icon={BarChart3} />,

    // Trung tâm Nội dung
    "/cc": <SidebarNavItem to="/cc" label="Tổng quan" icon={LayoutDashboard} end />,
    "/cc/ai-gen": <SidebarNavItem to="/cc/ai-gen" label="AI Tạo Nội dung" icon={Sparkles} />,
    "/cc/scripts": <SidebarNavItem to="/cc/scripts" label="Kịch bản" icon={FileText} />,
    "/cc/calendar": <SidebarNavItem to="/cc/calendar" label="Lịch đăng bài" icon={Calendar} />,
    "/cc/repurpose": <SidebarNavItem to="/cc/repurpose" label="Tái sử dụng" icon={RefreshCw} />,
    "/cc/analytics": <SidebarNavItem to="/cc/analytics" label="Thống kê" icon={BarChart3} />,
    "/cc/image-gen": <SidebarNavItem to="/cc/image-gen" label="Tạo hình" icon={Image} />,
    "/cc/video-reels": <SidebarNavItem to="/cc/video-reels" label="Video & Reels" icon={Video} />,
    "/cc/email": <SidebarNavItem to="/cc/email" label="Email Campaign" icon={Mail} />,
    "/cc/funnels": <SidebarNavItem to="/cc/funnels" label="Phễu chuyển đổi" icon={Filter} />,
    "/cc/settings": <SidebarNavItem to="/cc/settings" label="Cài đặt CC" icon={Settings} />,

    // Cấu hình
    "/ops/sop-registry": <SidebarNavItem to="/ops/sop-engine" label="Registry Marketplace" icon={Database} />,
    "/agents/all": <SidebarNavItem to="/agents/all" label="Tất cả Agents" icon={Boxes} />,
    "/agents-config": <SidebarNavItem to="/agents-config" label="Agent LLM (→ Registry)" icon={Database} textBadge="Deprecated" textBadgeTone="amber" />,
    "/config": <SidebarNavItem to="/config" label="Trung tâm Cấu hình (→ Registry)" icon={Settings} textBadge="Deprecated" textBadgeTone="amber" />,

    // CRM
    "/crm": <SidebarNavItem to="/crm" label="Tổng quan CRM" icon={BarChart3} end />,
    "/crm/customers": <SidebarNavItem to="/crm/customers" label="Khách hàng" icon={UserCircle} />,
    "/crm/tickets": <SidebarNavItem to="/crm/tickets" label="Phiếu hỗ trợ" icon={Ticket} />,
    "/crm/orders": <SidebarNavItem to="/crm/orders" label="Đơn hàng" icon={ShoppingBag} />,
    "/crm/campaigns": <SidebarNavItem to="/crm/campaigns" label="Email Campaigns" icon={Mail} />,
    "/crm/knowledge-base": <SidebarNavItem to="/crm/knowledge-base" label="Knowledge Base" icon={BookOpen} />,
    "/crm-messaging": <SidebarNavItem to="/crm-messaging" label="Messaging Gallery" icon={MessageCircle} />,
    "/crm-inbox": <SidebarNavItem to="/crm-inbox" label="Command Center" icon={MessageCircle} />,

    // Work
    "/timetable": <SidebarNavItem to="/timetable" label="Lịch hôm nay" icon={Calendar} />,
    "/issues": <SidebarNavItem to="/issues" label="Issues" icon={CircleDot} />,
    "/delegations": <SidebarNavItem to="/delegations" label="Ủy quyền" icon={Share2} />,
    "/routines": <SidebarNavItem to="/routines" label="Routines" icon={Repeat} textBadge="Beta" textBadgeTone="amber" />,
    "/goals": <SidebarNavItem to="/goals" label="Goals" icon={Target} />,
    "/workflows": <SidebarNavItem to="/workflows" label="Workflows" icon={Activity} />,
    "/channels/qa": <SidebarNavItem to="/channels/qa" label="Đánh giá & Trí tuệ" icon={BarChart3} />,
    "/ops/console": <SidebarNavItem to="/ops/console" label="Console" icon={Terminal} />,

    // Company
    "/org": <SidebarNavItem to="/org" label="Org" icon={Network} />,
    "/skills": <SidebarNavItem to="/skills" label="Skills" icon={Boxes} />,
    "/costs": <SidebarNavItem to="/costs" label="Costs" icon={DollarSign} />,
    "/activity": <SidebarNavItem to="/activity" label="Activity" icon={History} />,
  }), [totalUnread, inboxBadge]);

  return (
    <aside className="w-60 h-full min-h-0 border-r border-border bg-background flex flex-col">
      {/* Top bar: Company name (bold) + Search — aligned with top sections (no visible border) */}
      <div className="flex items-center gap-1 px-3 h-12 shrink-0">
        {selectedCompany?.brandColor && (
          <div
            className="w-4 h-4 rounded-sm shrink-0 ml-1"
            style={{ backgroundColor: selectedCompany.brandColor }}
          />
        )}
        <span className="flex-1 text-sm font-bold text-foreground truncate pl-1">
          {selectedCompany?.name ?? "Select company"}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground shrink-0"
          onClick={openSearch}
        >
          <Search className="h-4 w-4" />
        </Button>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide flex flex-col gap-4 px-3 py-2">
        <div className="flex flex-col gap-0.5">
          {/* New Issue button aligned with nav items */}
          <button
            onClick={() => openNewIssue()}
            className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
          >
            <SquarePen className="h-4 w-4 shrink-0" />
            <span className="truncate">New Issue</span>
          </button>
          <SidebarNavItem to="/dashboard" label="Dashboard" icon={LayoutDashboard} liveCount={liveRunCount} />
          <PluginSlotOutlet
            slotTypes={["sidebar"]}
            context={pluginContext}
            className="flex flex-col gap-0.5"
            itemClassName="text-[13px] font-medium"
            missingBehavior="placeholder"
          />
        </div>

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragOver={handleDragOver} onDragEnd={handleDragEnd}>
          <SortableContext items={sectionOrder} strategy={verticalListSortingStrategy}>
            {sectionOrder.map((sectionId) => {
              const currentLabel = sectionLabels[sectionId] || SECTION_LABELS[sectionId] || sectionId;
              
              const handleLabelChange = (newLabel: string) => {
                setSectionLabels((prev) => ({ ...prev, [sectionId]: newLabel }));
              };

              if (sectionId === "projects") {
                return (
                  <DraggableCustomSection key="projects" id="projects">
                    {(attributes, listeners) => (
                      <SidebarProjects 
                        label={currentLabel}
                        onLabelChange={handleLabelChange}
                        dragHandleAttributes={attributes} 
                        dragHandleListeners={listeners} 
                      />
                    )}
                  </DraggableCustomSection>
                );
              }
              if (sectionId === "agents") {
                return (
                  <DraggableCustomSection key="agents" id="agents">
                    {(attributes, listeners) => (
                      <SidebarAgents 
                        label={currentLabel}
                        onLabelChange={handleLabelChange}
                        dragHandleAttributes={attributes} 
                        dragHandleListeners={listeners} 
                      />
                    )}
                  </DraggableCustomSection>
                );
              }
              return (
                <DraggableSidebarSection
                  key={sectionId}
                  sectionId={sectionId}
                  label={currentLabel}
                  onLabelChange={handleLabelChange}
                  itemIds={items[sectionId] || []}
                  childrenMap={itemMap}
                />
              );
            })}
          </SortableContext>
        </DndContext>

        <div className="px-3 py-2 border-t border-border/50">
          <Button
            variant="outline"
            className="w-full text-xs h-8"
            onClick={() => saveGlobalConfig()}
            disabled={isSavingGlobal}
          >
            {isSavingGlobal ? "Đang lưu..." : "Lưu Global Sidebar (Admin)"}
          </Button>
        </div>

        <PluginSlotOutlet
          slotTypes={["sidebarPanel"]}
          context={pluginContext}
          className="flex flex-col gap-3"
          itemClassName="rounded-lg border border-border p-3"
          missingBehavior="placeholder"
        />
      </nav>
    </aside>
  );
}
