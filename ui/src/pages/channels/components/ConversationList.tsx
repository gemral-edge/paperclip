// ConversationList — Professional left panel with search, filters, and conversations
// Clean design with smooth animations and better UX

import { useState, useMemo } from "react";
import {
  Search, SlidersHorizontal, Plus, X, Filter, RotateCcw,
  Circle, CheckCircle, CheckCheck, Pin, Flame, Thermometer, Snowflake, Star, User, Handshake, Briefcase, Ban, ShieldBan, Ticket, PanelLeftClose
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { channelsApi, type ChannelSession } from "@/api/channels";
import { type ChannelDisplayMap, type TicketMap } from "../UnifiedInbox";
import { ConversationItem } from "./ConversationItem";

interface Props {
  conversations: ChannelSession[];
  isLoading: boolean;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  filters: { status?: string; channel?: string; search?: string; label?: string };
  onFiltersChange: (f: Props["filters"]) => void;
  onAction: () => void;
  channelMap: ChannelDisplayMap;
  ticketMap?: TicketMap;
  onOpenTicket?: (customerId: string) => void;
  ticketOnly?: boolean;
  onToggleTicketOnly?: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

const STATUS_TABS = [
  { key: "", label: "Tất cả", icon: null },
  { key: "pending", label: "Chờ xử lý", icon: <Circle className="h-3 w-3 fill-blue-500 text-blue-500" /> },
  { key: "resolved", label: "Đã xong", icon: <CheckCircle className="h-3 w-3 text-emerald-500" /> },
  { key: "pinned", label: "Ghim", icon: <Pin className="h-3 w-3 text-amber-500" /> },
] as const;

const LABEL_OPTIONS = [
  { key: "", label: "Tất cả phân loại", icon: null },
  { key: "hot", label: "Hot", icon: <Flame className="h-3 w-3 text-red-500" /> },
  { key: "warm", label: "Ấm", icon: <Thermometer className="h-3 w-3 text-orange-500" /> },
  { key: "cold", label: "Lạnh", icon: <Snowflake className="h-3 w-3 text-blue-600 dark:text-blue-400" /> },
  { key: "vip", label: "VIP", icon: <Star className="h-3 w-3 text-amber-500" /> },
  { key: "khach_hang", label: "Khách hàng", icon: <User className="h-3 w-3 text-slate-500" /> },
  { key: "doi_tac", label: "Đối tác", icon: <Handshake className="h-3 w-3 text-teal-500" /> },
  { key: "ctv", label: "CTV", icon: <Briefcase className="h-3 w-3 text-violet-500" /> },
  { key: "spam", label: "Spam", icon: <Ban className="h-3 w-3 text-red-600 dark:text-red-400" /> },
  // 03/10: hội thoại "Chặn" ẩn khỏi Hộp thư chính — xem lại + bỏ chặn ở đây.
  { key: "blocked", label: "Đã chặn", icon: <ShieldBan className="h-3 w-3 text-red-500" /> },
] as const;

export function ConversationList({
  conversations,
  isLoading,
  selectedKey,
  onSelect,
  filters,
  onFiltersChange,
  onAction,
  channelMap,
  ticketMap,
  onOpenTicket,
  ticketOnly,
  onToggleTicketOnly,
  onToggleCollapse,
}: Props) {
  const [searchInput, setSearchInput] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [showNewChat, setShowNewChat] = useState(false);
  const [markingRead, setMarkingRead] = useState(false);

  const handleMarkAllRead = async () => {
    if (markingRead) return;
    try {
      setMarkingRead(true);
      await channelsApi.markAllRead(filters.channel);
      onAction();
    } catch (err) {
      console.error("Lỗi đánh dấu tất cả đã đọc:", err);
    } finally {
      setMarkingRead(false);
    }
  };

  // Count active filters
  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filters.status) count++;
    if (filters.label) count++;
    if (filters.channel) count++;
    return count;
  }, [filters]);

  // Total unread count
  const totalUnread = useMemo(
    () => conversations.reduce((sum, c) => sum + (c.unread_count || 0), 0),
    [conversations]
  );

  const handleSearch = (value: string) => {
    setSearchInput(value);
    clearTimeout((window as any).__inboxSearchTimer);
    (window as any).__inboxSearchTimer = setTimeout(() => {
      onFiltersChange({ ...filters, search: value || undefined });
    }, 300);
  };

  const clearFilters = () => {
    onFiltersChange({ search: filters.search });
    setShowFilters(false);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header: Search + New Chat */}
      <div className="p-3 border-b border-border space-y-2">
        {/* Search bar */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Tìm kiếm hội thoại..."
              value={searchInput}
              onChange={(e) => handleSearch(e.target.value)}
              className="w-full h-9 pl-9 pr-3 text-sm rounded-lg border border-border bg-muted/30 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50 transition-all"
            />
          </div>

          {/* Filter toggle */}
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`
              relative h-9 px-3 rounded-lg border transition-all flex items-center gap-1.5
              ${showFilters || activeFilterCount > 0
                ? "border-primary/50 bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
              }
            `}
            title="Bộ lọc"
          >
            <Filter className="h-4 w-4" />
            {activeFilterCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 w-4 h-4 flex items-center justify-center text-[10px] font-bold bg-primary text-primary-foreground rounded-full">
                {activeFilterCount}
              </span>
            )}
          </button>

          {/* Mark all as read button */}
          {totalUnread > 0 && (
            <button
              onClick={handleMarkAllRead}
              disabled={markingRead}
              className="h-9 px-2.5 rounded-lg border border-border text-muted-foreground hover:bg-muted hover:text-emerald-500 transition-all shrink-0 flex items-center gap-1.5"
              title="Đánh dấu tất cả là đã đọc"
            >
              <CheckCheck className="h-4 w-4 text-emerald-500" />
              <span className="text-xs hidden sm:inline font-medium">{markingRead ? "..." : "Đã đọc"}</span>
            </button>
          )}

          {/* New chat button */}
          <button
            onClick={() => setShowNewChat(true)}
            className="h-9 px-3 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors flex items-center gap-1.5 shrink-0"
            title="Tạo hội thoại mới"
          >
            <Plus className="h-4 w-4" />
          </button>

          {/* Collapse the whole list panel (desktop only — parent passes the toggle) */}
          {onToggleCollapse && (
            <button
              onClick={onToggleCollapse}
              className="h-9 px-2.5 rounded-lg border border-border text-muted-foreground hover:bg-muted hover:text-foreground transition-all shrink-0"
              title="Thu gọn danh sách"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Status tabs */}
        <div className="flex gap-1 overflow-x-auto scrollbar-none -mx-1 px-1">
          {STATUS_TABS.map((tab) => {
            const isActive = (filters.status || "") === tab.key;
            const tabUnread = tab.key === "" ? totalUnread
              : tab.key === "pending" ? conversations.filter(c => c.status === "pending" && (c.unread_count || 0) > 0).length
              : 0;

            return (
              <button
                key={tab.key}
                onClick={() => onFiltersChange({ ...filters, status: tab.key || undefined })}
                className={`
                  flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium
                  transition-all whitespace-nowrap shrink-0
                  ${isActive
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                  }
                `}
              >
                {tab.icon}
                <span>{tab.label}</span>
                {tabUnread > 0 && (
                  <span className={`
                    min-w-[18px] h-[18px] flex items-center justify-center
                    text-[10px] font-bold rounded-full px-1
                    ${isActive ? "bg-white/20 text-white" : "bg-red-500/20 text-red-500"}
                  `}>
                    {tabUnread}
                  </span>
                )}
              </button>
            );
          })}

          {/* S3: toggle to show only conversations whose customer has an open ticket */}
          {onToggleTicketOnly && (
            <button
              onClick={onToggleTicketOnly}
              title="Chỉ hiện khách đang có phiếu hỗ trợ"
              className={`
                flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium
                transition-all whitespace-nowrap shrink-0
                ${ticketOnly
                  ? "bg-amber-500 text-white shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }
              `}
            >
              <Ticket className="h-3 w-3" />
              <span>Có phiếu</span>
            </button>
          )}
        </div>
      </div>

      {/* Filter panel (collapsible) */}
      {showFilters && (
        <div className="px-3 py-2 border-b border-border bg-muted/20 space-y-3">
          {/* Label filter */}
          <div>
            <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
              Phân loại
            </div>
            <div className="flex flex-wrap gap-1">
              {LABEL_OPTIONS.map(({ key, label, icon }) => (
                <button
                  key={key}
                  onClick={() => onFiltersChange({ ...filters, label: key || undefined })}
                  className={`
                    flex items-center gap-1.5 px-2.5 py-1 text-[12px] rounded-md transition-all
                    ${(filters.label || "") === key
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground"
                    }
                  `}
                >
                  {icon}
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Clear filters */}
          {activeFilterCount > 0 && (
            <button
              onClick={clearFilters}
              className="flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground transition-colors"
            >
              <RotateCcw className="h-3 w-3" />
              Xóa bộ lọc
            </button>
          )}
        </div>
      )}

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-4 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-start gap-3 px-3 py-3">
                <div className="w-10 h-10 rounded-full bg-muted animate-pulse" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 bg-muted rounded animate-pulse w-2/3" />
                  <div className="h-3 bg-muted rounded animate-pulse w-1/3" />
                  <div className="h-3 bg-muted rounded animate-pulse w-full" />
                </div>
              </div>
            ))}
          </div>
        ) : conversations.length === 0 ? (
          <div className="p-8 text-center">
            <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-muted flex items-center justify-center">
              <Search className="h-6 w-6 text-muted-foreground/50" />
            </div>
            <p className="text-sm text-muted-foreground">
              {filters.search
                ? `Không tìm thấy hội thoại nào khớp với "${filters.search}"`
                : "Chưa có hội thoại nào"}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {conversations.map((conv) => (
              <ConversationItem
                key={conv.session_key}
                conversation={conv}
                isSelected={selectedKey === conv.session_key}
                onClick={() => onSelect(conv.session_key)}
                onAction={onAction}
                channelMap={channelMap}
                ticketInfo={conv.customer_id ? ticketMap?.get(conv.customer_id) : undefined}
                onOpenTicket={onOpenTicket}
              />
            ))}
          </div>
        )}
      </div>

      {/* Footer stats */}
      <div className="px-3 py-2 border-t border-border bg-muted/20">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{conversations.length} hội thoại</span>
          {totalUnread > 0 ? (
            <div className="flex items-center gap-2">
              <span className="text-red-500 font-medium">{totalUnread} chưa đọc</span>
              <button
                onClick={handleMarkAllRead}
                disabled={markingRead}
                className="text-primary hover:underline font-semibold hover:text-primary/80 transition-colors flex items-center gap-1 cursor-pointer"
                title="Đánh dấu tất cả hội thoại là đã đọc"
              >
                <CheckCheck className="h-3 w-3 text-emerald-500" />
                <span>{markingRead ? "Đang xử lý..." : "Đánh dấu tất cả đã đọc"}</span>
              </button>
            </div>
          ) : (
            <span className="text-emerald-500 font-medium flex items-center gap-1">
              <CheckCircle className="h-3 w-3" />
              <span>Đã đọc hết</span>
            </span>
          )}
        </div>
      </div>

      {/* New Chat Modal */}
      <NewChatModal
        isOpen={showNewChat}
        onClose={() => setShowNewChat(false)}
        onSuccess={() => { setShowNewChat(false); onAction(); }}
      />
    </div>
  );
}

// New Chat Modal component
function NewChatModal({
  isOpen,
  onClose,
  onSuccess,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [channel, setChannel] = useState("");
  const [target, setTarget] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch channel instances
  const { data: instances } = useQuery({
    queryKey: ["channel-instances"],
    queryFn: () => channelsApi.listInstances(),
    staleTime: 60_000,
    enabled: isOpen,
  });

  // Recent contacts
  const { data: recentContacts = [] } = useQuery({
    queryKey: ["inbox-contacts-recent"],
    queryFn: async () => {
      const r = await fetch("/api/channels/contacts?limit=8");
      return r.json();
    },
    staleTime: 30_000,
    enabled: isOpen,
  });

  const handleCreate = async () => {
    if (!channel || !target.trim()) return;

    setCreating(true);
    setError(null);

    try {
      const res = await fetch("/api/channels/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, target_id: target.trim() }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Không thể tạo hội thoại");
      }

      onSuccess();
    } catch (err: any) {
      setError(err.message || "Có lỗi xảy ra");
    } finally {
      setCreating(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-background border border-border rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="text-base font-semibold">Tạo hội thoại mới</h3>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-muted transition-colors"
          >
            <X className="h-5 w-5 text-muted-foreground" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {/* Channel select */}
          <div>
            <label className="block text-sm font-medium mb-2">Kênh liên lạc</label>
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              className="w-full h-10 px-3 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50"
            >
              <option value="">— Chọn kênh —</option>
              {(instances || []).map((inst: any) => (
                <option key={inst.name} value={inst.name}>
                  {inst.display_name || inst.name}
                </option>
              ))}
            </select>
          </div>

          {/* Target input */}
          <div>
            <label className="block text-sm font-medium mb-2">
              Số điện thoại / ID người dùng
            </label>
            <input
              type="text"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="Nhập SĐT hoặc ID..."
              className="w-full h-10 px-3 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50"
            />

            {/* Recent contacts */}
            {recentContacts.length > 0 && !target && (
              <div className="mt-3">
                <div className="text-[11px] text-muted-foreground mb-2">Liên hệ gần đây:</div>
                <div className="flex flex-wrap gap-1.5">
                  {recentContacts.map((c: any) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setTarget(c.zalo_id || c.phone || c.facebook_id || "")}
                      className="flex items-center gap-1.5 px-2.5 py-1 text-[12px] rounded-full border border-border bg-muted/30 hover:bg-muted transition-colors max-w-[140px]"
                      title={c.name}
                    >
                      <span className="w-5 h-5 rounded-full bg-primary/20 flex items-center justify-center text-[10px] font-semibold text-primary shrink-0">
                        {(c.name || "?").charAt(0).toUpperCase()}
                      </span>
                      <span className="truncate">{c.name || c.phone}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Error */}
          {error && (
            <p className="text-sm text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-border bg-muted/20">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium rounded-lg border border-border hover:bg-muted transition-colors"
          >
            Hủy
          </button>
          <button
            onClick={handleCreate}
            disabled={!channel || !target.trim() || creating}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {creating ? "Đang tạo..." : "Tạo hội thoại"}
          </button>
        </div>
      </div>
    </div>
  );
}
