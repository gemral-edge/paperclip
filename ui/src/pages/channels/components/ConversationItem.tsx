// ConversationItem — Professional conversation row with avatar, badges, and actions
// Features: Real avatars, online status, channel badges, labels, smooth hover states

import { useState } from "react";
import { type ChannelSession } from "@/api/channels";
import { type ChannelDisplayMap, type TicketInfo } from "../UnifiedInbox";
import { ConversationActions } from "./ConversationActions";
import { ChannelBadge } from "@/components/ChannelBadge";
import { Pin, VolumeX, Users, Bot, Paperclip, PauseCircle, Ticket } from "lucide-react";

interface Props {
  conversation: ChannelSession;
  isSelected: boolean;
  onClick: () => void;
  onAction: () => void;
  channelMap: ChannelDisplayMap;
  ticketInfo?: TicketInfo;
  onOpenTicket?: (customerId: string) => void;
}

// Compact badge color by the customer's highest open-ticket priority.
const TICKET_BADGE_TONE: Record<string, string> = {
  critical: "bg-red-600/15 text-red-600 ring-red-600/40",
  urgent: "bg-red-500/15 text-red-600 ring-red-500/40",
  high: "bg-orange-500/15 text-orange-600 ring-orange-500/40",
  medium: "bg-amber-500/15 text-amber-600 ring-amber-500/40",
  low: "bg-zinc-400/15 text-zinc-500 ring-zinc-400/40",
};
const PRIORITY_VN: Record<string, string> = {
  critical: "Nghiêm trọng", urgent: "Gấp", high: "Cao", medium: "TB", low: "Thấp",
};

function formatTime(ts: string | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffDays === 0) return d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
  if (diffDays === 1) return "Hôm qua";
  if (diffDays < 7) return d.toLocaleDateString("vi-VN", { weekday: "short" });
  return d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });
}

const LABEL_CONFIG: Record<string, { text: string; color: string; bg: string }> = {
  hot: { text: "HOT", color: "text-red-500", bg: "bg-red-500/10" },
  warm: { text: "Ấm", color: "text-amber-500", bg: "bg-amber-500/10" },
  cold: { text: "Lạnh", color: "text-blue-700 dark:text-blue-400", bg: "bg-blue-400/10" },
  vip: { text: "VIP", color: "text-purple-500", bg: "bg-purple-500/10" },
  spam: { text: "Spam", color: "text-zinc-600 dark:text-zinc-400", bg: "bg-zinc-400/10" },
  khach_hang: { text: "Khách hàng", color: "text-emerald-500", bg: "bg-emerald-500/10" },
  doi_tac: { text: "Đối tác", color: "text-blue-500", bg: "bg-blue-500/10" },
  ctv: { text: "CTV", color: "text-orange-500", bg: "bg-orange-500/10" },
};

// Avatar component with fallback
function Avatar({
  src,
  name,
  isGroup,
  isOnline,
  size = "md"
}: {
  src?: string | null;
  name: string;
  isGroup?: boolean;
  isOnline?: boolean;
  size?: "sm" | "md" | "lg";
}) {
  const sizeClasses = {
    sm: "w-8 h-8 text-xs",
    md: "w-10 h-10 text-sm",
    lg: "w-12 h-12 text-base",
  };

  const initial = name.charAt(0).toUpperCase();

  // Generate consistent color from name
  const colors = [
    "bg-violet-500", "bg-blue-500", "bg-emerald-500", "bg-amber-500",
    "bg-rose-500", "bg-cyan-500", "bg-indigo-500", "bg-teal-500",
  ];
  const colorIndex = name.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0) % colors.length;
  const bgColor = isGroup ? "bg-indigo-500" : colors[colorIndex];

  return (
    <div className="relative shrink-0">
      {src ? (
        <img
          src={src}
          alt={name}
          className={`${sizeClasses[size]} rounded-full object-cover ring-2 ring-background`}
          onError={(e) => {
            e.currentTarget.style.display = "none";
            e.currentTarget.nextElementSibling?.classList.remove("hidden");
          }}
        />
      ) : null}
      <div className={`
        ${sizeClasses[size]} ${bgColor} rounded-full flex items-center justify-center
        font-semibold text-white ring-2 ring-background
        ${src ? "hidden" : ""}
      `}>
        {isGroup ? <Users className="h-4 w-4" /> : initial}
      </div>

      {/* Online indicator */}
      {isOnline && (
        <span className="absolute bottom-0 right-0 w-3 h-3 bg-emerald-500 border-2 border-background rounded-full" />
      )}
    </div>
  );
}

export function ConversationItem({ conversation: conv, isSelected, onClick, onAction, channelMap, ticketInfo, onOpenTicket }: Props) {
  const [showMenu, setShowMenu] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const isUnread = (conv.unread_count || 0) > 0;

  // Channel display info
  const chInfo = conv.channel_name ? channelMap[conv.channel_name] : null;
  const channelLabel = chInfo?.display_name || conv.channel_name || "Kênh";

  // Determine if group (with proper type assertion)
  const isGroup = Boolean(conv.is_group || (conv.metadata as Record<string, unknown>)?.is_group);

  // Get display name - prioritize customer display_name, then sender_name, finally sender_id
  const displayName = String(
    isGroup
      ? (conv.group_name || (conv.metadata as Record<string, unknown>)?.group_name || "Nhóm")
      : (conv.customer?.display_name || conv.sender_name || formatPhoneNumber(conv.sender_id) || "Khách hàng")
  );

  // Get avatar URL (with proper type assertion)
  const avatarUrl = (conv.customer?.avatar_url || (conv.metadata as Record<string, unknown>)?.avatar_url || null) as string | null;

  // Check if online (last activity within 5 minutes)
  const lastActivity = conv.last_message_at ? new Date(conv.last_message_at) : null;
  const isOnline = lastActivity ? (Date.now() - lastActivity.getTime()) < 5 * 60 * 1000 : false;

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenuPos({ x: e.clientX, y: e.clientY });
    setShowMenu(true);
  };

  // Format message preview - truncate and clean up
  const preview = formatPreview(conv.last_message_preview);
  // Nhóm: nội dung có thể đã mang sẵn "Tên: ..." → không lặp nhãn ("VUHO: VUHO: ...").
  const rawLabel = previewSenderLabel(conv.last_message_sender, isGroup);
  const senderLabel = rawLabel && preview.startsWith(`${rawLabel}:`) ? "" : rawLabel;

  return (
    <>
      <div
        onClick={onClick}
        onContextMenu={handleContextMenu}
        className={`
          group relative px-3 py-3 cursor-pointer transition-all duration-150
          ${isSelected
            ? "bg-primary/8 border-l-[3px] border-l-primary"
            : "hover:bg-muted/40 border-l-[3px] border-l-transparent"
          }
          ${isUnread ? "bg-muted/20" : ""}
        `}
      >
        <div className="flex items-start gap-3">
          {/* Avatar */}
          <Avatar
            src={avatarUrl}
            name={displayName}
            isGroup={isGroup}
            isOnline={isOnline}
            size="md"
          />

          {/* Content */}
          <div className="flex-1 min-w-0">
            {/* Row 1: Name + Time */}
            <div className="flex items-center justify-between gap-2 mb-0.5">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className={`text-[14px] truncate ${isUnread ? "font-bold text-foreground" : "font-medium text-foreground/90"}`}>
                  {displayName}
                </span>
                {isGroup && conv.member_count != null && (
                  <span className="text-[11px] text-muted-foreground">({String(conv.member_count)})</span>
                )}
              </div>
              <span className="text-[11px] text-muted-foreground shrink-0">
                {formatTime(conv.last_message_at)}
              </span>
            </div>

            {/* Row 2: Channel badge (per-account color + origin arrow) + Agent badge.
                flex-wrap + min-w-0 so a narrow list panel wraps badges to a new line
                instead of overflowing / overlapping the text (owner report 2026-07-11). */}
            <div className="flex flex-wrap items-center gap-1 mb-1 min-w-0">
              <ChannelBadge name={channelLabel} color={chInfo?.color} withOriginArrow />

              {/* App vs Web origin badge (cskh only — metadata.last_source). */}
              {(() => {
                const src = (conv.metadata as { last_source?: string } | undefined)?.last_source;
                if (!src) return null;
                const isApp = src === "mobile";
                return (
                  <span
                    title={isApp ? "Khách nhắn từ App" : "Khách nhắn từ Web"}
                    className={`shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${isApp ? "bg-sky-500/10 text-sky-600" : "bg-emerald-500/10 text-emerald-600"}`}
                  >
                    {isApp ? "📱 App" : "🌐 Web"}
                  </span>
                );
              })()}

              {conv.agent_slug && (
                <span className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-500/10 text-violet-500 max-w-full truncate">
                  <Bot className="h-3 w-3 shrink-0" />
                  {conv.agent_slug}
                </span>
              )}

              {/* BOT ĐANG DỪNG (2026-07-28) — trước đây cờ này CHỈ hiện trong ChatHeader,
                  nên phải MỞ TỪNG hội thoại mới biết. Ca thật 27-28/07: một thread bị Dừng
                  Bot từ trước, khách nhắn 3 lần trong 16h chỉ nhận câu "nhân viên sẽ phản hồi
                  ngay" — không ai biết vì danh sách trông y hệt thread bình thường.
                  KHÔNG gate theo agent_slug: gemini-proxy đọc cờ này độc lập agent, gate sẽ
                  GIẤU trạng thái dừng thật. */}
              {(conv.metadata as { bot_paused?: boolean } | undefined)?.bot_paused === true && (
                <span
                  title="Bot ĐANG DỪNG cho hội thoại này — khách chỉ nhận câu chờ, bạn phải tự trả lời. Mở hội thoại rồi bấm 'Bật Bot' để bot chạy lại."
                  className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-600 ring-1 ring-amber-500/40"
                >
                  <PauseCircle className="h-3 w-3 shrink-0" />
                  Bot đang dừng
                </span>
              )}

              {/* Open-ticket badge — bấm để mở phiếu (top priority) ngay từ list */}
              {ticketInfo && ticketInfo.count > 0 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (conv.customer_id && onOpenTicket) onOpenTicket(conv.customer_id);
                  }}
                  title={`${ticketInfo.count} phiếu mở · cao nhất: ${PRIORITY_VN[ticketInfo.maxPriority] || ticketInfo.maxPriority}. Bấm để xem.`}
                  className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold ring-1 hover:brightness-110 transition ${TICKET_BADGE_TONE[ticketInfo.maxPriority] || TICKET_BADGE_TONE.low}`}
                >
                  <Ticket className="h-3 w-3 shrink-0" />
                  {ticketInfo.count > 1 ? `${ticketInfo.count} phiếu` : "Phiếu"}
                </button>
              )}
            </div>

            {/* Row 3: Message preview */}
            <div className="flex items-center gap-2">
              <p className={`text-[13px] truncate flex-1 ${isUnread ? "text-foreground" : "text-muted-foreground"}`}>
                {senderLabel && (
                  <span className="font-medium">{senderLabel}: </span>
                )}
                {preview || "..."}
              </p>

              {/* Badges */}
              <div className="flex items-center gap-1 shrink-0">
                {conv.has_attachments && (
                  <Paperclip className="h-3.5 w-3.5 text-muted-foreground" />
                )}
                {isUnread && (
                  <span className="min-w-[20px] h-5 flex items-center justify-center text-[11px] font-bold text-white bg-red-500 rounded-full px-1.5">
                    {(conv.unread_count || 0) > 99 ? "99+" : conv.unread_count}
                  </span>
                )}
              </div>
            </div>

            {/* Row 4: Labels & status indicators */}
            {(conv.label || conv.is_pinned || conv.is_muted) && (
              <div className="flex items-center gap-1.5 mt-1.5">
                {conv.is_pinned && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-500">
                    <Pin className="h-3 w-3" />
                  </span>
                )}
                {conv.is_muted && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
                    <VolumeX className="h-3 w-3" />
                  </span>
                )}
                {conv.label && LABEL_CONFIG[conv.label] && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${LABEL_CONFIG[conv.label].color} ${LABEL_CONFIG[conv.label].bg}`}>
                    {LABEL_CONFIG[conv.label].text}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Hover action button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            setMenuPos({ x: rect.right, y: rect.bottom });
            setShowMenu(true);
          }}
          className={`
            absolute right-2 top-1/2 -translate-y-1/2
            p-1.5 rounded-md transition-all duration-150
            bg-background/90 border border-border/50 shadow-sm
            opacity-0 group-hover:opacity-100
            hover:bg-muted
          `}
          title="Thao tác"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="text-muted-foreground">
            <circle cx="3" cy="8" r="1.5" /><circle cx="8" cy="8" r="1.5" /><circle cx="13" cy="8" r="1.5" />
          </svg>
        </button>
      </div>

      {/* Context menu */}
      {showMenu && (
        <ConversationActions
          conversation={conv}
          position={menuPos}
          onClose={() => setShowMenu(false)}
          onAction={onAction}
        />
      )}
    </>
  );
}

// Helper: Format phone number for display
function formatPhoneNumber(phone: string | null | undefined): string {
  if (!phone) return "";
  const cleaned = phone.replace(/\D/g, "");
  if (cleaned.length === 10) {
    return `${cleaned.slice(0, 4)} ${cleaned.slice(4, 7)} ${cleaned.slice(7)}`;
  }
  if (cleaned.length === 11 && cleaned.startsWith("84")) {
    return `+84 ${cleaned.slice(2, 5)} ${cleaned.slice(5, 8)} ${cleaned.slice(8)}`;
  }
  return phone;
}

// Helper: Clean and truncate message preview
// Nhãn người gửi trước preview — chuẩn Messenger/Zalo: tin phía mình gửi (agent/người, DB
// trigger ghi 'Bạn'; mirror cũ ghi 'agent') → "Bạn"; hội thoại 1-1 tin khách → không nhãn
// (tên đã ở tiêu đề dòng); nhóm → tên người nói.
function previewSenderLabel(sender: string | null | undefined, isGroup: boolean): string {
  if (!sender) return "";
  if (sender === "Bạn" || sender === "agent") return "Bạn";
  return isGroup ? sender : "";
}

function formatPreview(preview: string | null | undefined): string {
  if (!preview) return "";

  // Remove JSON-like content
  if (preview.startsWith("{") && preview.includes('"')) {
    try {
      const parsed = JSON.parse(preview);
      if (parsed.type === "system") return "[Hệ thống]";
      if (parsed.type === "sticker") return "[Sticker]";
      if (parsed.type === "image" || parsed.href) return "[Hình ảnh]";
      if (parsed.fileName) return `[Tệp] ${parsed.fileName}`;
    } catch {
      // Not JSON, continue
    }
    return "[Tin nhắn]";
  }

  return preview.slice(0, 80);
}
