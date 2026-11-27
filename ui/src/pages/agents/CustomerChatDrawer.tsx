// Customer Chat Drawer (Mode A) — per-customer chat history with an agent.
// Reads from channel_sessions.history JSONB via /api/channels/agent-configs/:slug/chat-history.
// Design: mirrors AgentLogDrawer shell (max-w-5xl h-[88vh] rounded-2xl) for visual consistency,
// but presents messages as chat-bubble timeline instead of per-turn collapsible.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  X, RefreshCw, Loader2, Search, MessageSquare, User as UserIcon,
  Bot, CircleAlert, Calendar, Filter, ExternalLink, FileText,
  Sparkles, PanelRightOpen, PanelRightClose, FolderOpen,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { MarkdownBody } from '@/components/MarkdownBody';
import { CopyButton } from '@/components/CopyButton';
import { copyToClipboard } from '@/lib/clipboard';
import { cn } from '@/lib/utils';

// ─── Types ──────────────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  role: 'customer' | 'agent';
  content: string;
  senderName: string;
  timestamp: string | null;
  metadata: Record<string, any> | null;
}

interface SessionFile {
  session_id: string;
  short_id: string;
  fileKind: 'claude-jsonl' | 'gemini-json';
  file_path: string;
  started_at: string;
  last_activity_at: string;
  turn_count: number;
  first_user_snippet: string | null;
  size_bytes: number;
}

interface SessionFilesResponse {
  slug: string;
  total: number;
  returned: number;
  claude_count: number;
  gemini_count: number;
  files: SessionFile[];
}

interface ChatHistoryResponse {
  slug: string;
  agent_display_name: string;
  agent_provider?: string;
  agent_model?: string;
  session_key: string | null;
  channel: {
    name: string | null;
    display_name: string | null;
    platform: string | null;
  } | null;
  customer: {
    customer_id: string | null;
    sender_id: string | null;
    sender_name: string;
    stage: string | null;
    lead_score: number | null;
    lead_temperature: string | null;
    total_orders: number | null;
    total_revenue: number | null;
    first_contact_at: string | null;
  } | null;
  totalMessages: number;
  fullHistoryCount: number;
  lastMessageAt: string | null;
  messages: ChatMessage[];
  error?: string;
}

export interface CustomerChatDrawerProps {
  open: boolean;
  onClose: () => void;
  agentSlug: string;
  sessionKey?: string | null;
  channelName?: string | null;
  senderId?: string | null;
  // Optional fallbacks for header when API errors
  fallbackCustomerName?: string | null;
  fallbackChannelDisplay?: string | null;
  // Drill-down to session log — opens AgentLogDrawer overlay
  onOpenSessionLog?: (sessionId: string | null) => void;
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Strip the CRM context prefix injected by router.ts into user messages.
 * If the message has `[TIN NHẮN MỚI]\n<actual>`, return only <actual>.
 * Otherwise return the original content unchanged.
 */
function extractActualMessage(content: string): string {
  if (!content) return '';
  const marker = content.indexOf('[TIN NHẮN MỚI]');
  if (marker === -1) {
    // Check for older `[Khách:` prefix without [TIN NHẮN MỚI]
    if (content.trim().startsWith('[Khách:') || content.trim().startsWith('[HỒ SƠ')) {
      // Fallback: return last paragraph
      const lines = content.split('\n').filter(l => l.trim() && !l.trim().startsWith('['));
      return lines.length > 0 ? lines[lines.length - 1] : content;
    }
    return content;
  }
  const after = content.slice(marker + '[TIN NHẮN MỚI]'.length).trim();
  return after || content;
}

/** Format timestamp to HH:mm:ss (HCM) */
function fmtTime(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Format date to "Thứ X, dd/MM/yyyy" for dividers */
function fmtDateDivider(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  const weekday = d.toLocaleDateString('vi-VN', { weekday: 'long' });
  const date = d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  return `${weekday}, ${date}`;
}

/** Check if two timestamps are on different calendar days (HCM) */
function isDifferentDay(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const da = new Date(a), db = new Date(b);
  return da.toDateString() !== db.toDateString();
}

/** Stage badge colors */
function stageBadgeClass(stage: string | null): string {
  if (!stage) return 'bg-muted text-muted-foreground';
  const s = stage.toLowerCase();
  if (s.includes('lead_moi') || s.includes('new')) return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300';
  if (s.includes('qualified') || s.includes('warm')) return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';
  if (s.includes('customer') || s.includes('paid')) return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300';
  if (s.includes('churn')) return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300';
  return 'bg-muted text-muted-foreground';
}

/** Platform icon emoji */
function platformEmoji(platform: string | null): string {
  if (!platform) return '💬';
  const p = platform.toLowerCase();
  if (p.includes('zalo')) return '💙';
  if (p.includes('facebook') || p === 'fb') return '📘';
  if (p.includes('instagram') || p === 'ig') return '📷';
  if (p.includes('forum')) return '💭';
  if (p.includes('email')) return '✉';
  if (p.includes('sms')) return '📱';
  return '💬';
}

// ─── Main Drawer ────────────────────────────────────────────────────

export function CustomerChatDrawer({
  open,
  onClose,
  agentSlug,
  sessionKey,
  channelName,
  senderId,
  fallbackCustomerName,
  fallbackChannelDisplay,
  onOpenSessionLog,
}: CustomerChatDrawerProps) {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Debounce search 300ms
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Close on Esc
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const queryParams = useMemo(() => {
    const p = new URLSearchParams();
    if (sessionKey) p.set('session_key', sessionKey);
    else {
      if (channelName) p.set('channel_name', channelName);
      if (senderId) p.set('sender_id', senderId);
    }
    if (debouncedSearch) p.set('search', debouncedSearch);
    return p.toString();
  }, [sessionKey, channelName, senderId, debouncedSearch]);

  const canQuery = !!sessionKey || !!(channelName && senderId);

  // Session Picker panel state
  const [sessionPanelOpen, setSessionPanelOpen] = useState(false);
  type Timeframe = 'chat' | 'week' | 'month' | 'all';
  const [sessionTimeframe, setSessionTimeframe] = useState<Timeframe>('chat');

  const { data, isLoading, isFetching, refetch, error } = useQuery<ChatHistoryResponse>({
    queryKey: ['customer-chat', agentSlug, sessionKey, channelName, senderId, debouncedSearch],
    queryFn: async () => {
      const resp = await fetch(`/api/channels/agent-configs/${encodeURIComponent(agentSlug)}/chat-history?${queryParams}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.json();
    },
    enabled: open && canQuery,
    refetchInterval: autoRefresh && open ? 5000 : false,
  });

  // Auto-scroll to bottom when new messages arrive in live mode
  useEffect(() => {
    if (autoRefresh && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [data?.messages.length, autoRefresh]);

  if (!open) return null;

  const customer = data?.customer;
  const channel = data?.channel;
  const customerName = customer?.sender_name || fallbackCustomerName || 'Khách hàng';
  const channelDisplay = channel?.display_name || fallbackChannelDisplay || channelName || '—';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal="true" aria-labelledby="chat-drawer-title">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative w-full max-w-6xl h-[88vh] bg-background rounded-2xl border shadow-2xl flex flex-col overflow-hidden mx-4">

        {/* ─── HEADER ─────────────────────────────────────────── */}
        <div className="px-6 py-4 border-b shrink-0">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3 min-w-0 flex-1">
              {/* Avatar */}
              <div className="h-10 w-10 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center shrink-0 text-base font-semibold text-blue-700 dark:text-blue-300">
                {customerName.slice(0, 2).toUpperCase()}
              </div>

              <div className="min-w-0 flex-1">
                {/* Identity row */}
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 id="chat-drawer-title" className="text-base font-semibold truncate">{customerName}</h2>
                  {customer?.stage && (
                    <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0 border-0', stageBadgeClass(customer.stage))}>
                      {customer.stage}
                    </Badge>
                  )}
                  {customer?.lead_score !== null && customer?.lead_score !== undefined && (
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 gap-1">
                      <span className="font-mono">{customer.lead_score}/100</span>
                      {customer.lead_temperature && (
                        <span className="text-muted-foreground">
                          {customer.lead_temperature === 'hot' ? '🔥' : customer.lead_temperature === 'warm' ? '☀' : '❄'}
                        </span>
                      )}
                    </Badge>
                  )}
                </div>

                {/* Channel + user ID */}
                <div className="mt-0.5 text-[12px] text-muted-foreground flex items-center gap-2 flex-wrap">
                  <span>{platformEmoji(channel?.platform || null)} {channelDisplay}</span>
                  {customer?.sender_id && (
                    <>
                      <span className="text-muted-foreground/40">·</span>
                      <span className="font-mono text-[11px]">User ID: {customer.sender_id}</span>
                    </>
                  )}
                </div>

                {/* Agent + stats */}
                <div className="mt-1 text-[11px] text-muted-foreground/70 flex items-center gap-2 flex-wrap">
                  <span>
                    <Bot className="inline h-3 w-3 mr-0.5" />
                    Agent: <span className="font-medium text-foreground/80">{data?.agent_display_name || agentSlug}</span>
                    {data?.agent_model && <span className="ml-1 font-mono text-muted-foreground/50">({data.agent_model})</span>}
                  </span>
                  {data?.fullHistoryCount !== undefined && (
                    <>
                      <span className="text-muted-foreground/40">·</span>
                      <span>
                        <MessageSquare className="inline h-3 w-3 mr-0.5" />
                        {data.fullHistoryCount} tin nhắn
                      </span>
                    </>
                  )}
                  {customer?.first_contact_at && (
                    <>
                      <span className="text-muted-foreground/40">·</span>
                      <span>Lần đầu {new Date(customer.first_contact_at).toLocaleDateString('vi-VN')}</span>
                    </>
                  )}
                  {data?.lastMessageAt && (
                    <>
                      <span className="text-muted-foreground/40">·</span>
                      <span>Gần nhất {new Date(data.lastMessageAt).toLocaleDateString('vi-VN')} {new Date(data.lastMessageAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</span>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-1 shrink-0">
              <Button size="icon" variant="ghost" onClick={() => refetch()} disabled={isFetching} className="h-8 w-8" aria-label="Refresh">
                <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />
              </Button>
              <Button size="icon" variant="ghost" onClick={onClose} className="h-8 w-8" aria-label="Đóng">
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Secondary action bar */}
          {customer?.customer_id && (
            <div className="mt-2 flex items-center gap-2 text-[11px]">
              <a
                href={`/crm/customers/${customer.customer_id}`}
                className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
              >
                <ExternalLink className="h-3 w-3" /> Xem hồ sơ khách
              </a>
              {customer.total_orders !== null && customer.total_orders > 0 && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="text-muted-foreground">
                    {customer.total_orders} đơn · {customer.total_revenue ? new Intl.NumberFormat('vi-VN').format(customer.total_revenue) : 0}₫ doanh thu
                  </span>
                </>
              )}
            </div>
          )}
        </div>

        {/* ─── TOOLBAR ────────────────────────────────────────── */}
        <div className="px-6 py-2 border-b flex flex-wrap gap-2 items-center shrink-0">
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
            <Input
              type="text"
              placeholder="Tìm trong hội thoại..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-7 text-sm"
            />
          </div>
          <div className="flex-1" />
          {/* Session Picker toggle */}
          <button
            onClick={() => setSessionPanelOpen(!sessionPanelOpen)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-medium select-none border transition-colors',
              sessionPanelOpen
                ? 'bg-blue-50 dark:bg-blue-950/20 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800'
                : 'bg-muted text-muted-foreground/70 border-transparent hover:text-foreground',
            )}
            title={sessionPanelOpen ? 'Đóng panel session logs' : 'Mở panel session logs (Claude + Gemini JSONL files)'}
          >
            {sessionPanelOpen ? <PanelRightClose className="h-3 w-3" /> : <FolderOpen className="h-3 w-3" />}
            Sessions
          </button>
          <div
            className={cn(
              'flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-medium cursor-pointer select-none',
              autoRefresh
                ? 'bg-emerald-50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-400'
                : 'bg-muted text-muted-foreground/60',
            )}
            onClick={() => setAutoRefresh(!autoRefresh)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setAutoRefresh(!autoRefresh); } }}
          >
            {autoRefresh && (
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
              </span>
            )}
            {autoRefresh ? 'Live · 5s' : 'Paused'}
          </div>
          {debouncedSearch && data && (
            <span className="text-[11px] text-muted-foreground">
              {data.totalMessages}/{data.fullHistoryCount} khớp
            </span>
          )}
        </div>

        {/* ─── Split layout: chat + session picker ────────────── */}
        <div className="flex-1 flex overflow-hidden min-h-0">

        {/* ─── BODY ───────────────────────────────────────────── */}
        <div ref={scrollRef} className="flex-1 overflow-auto px-6 py-4">
          {!canQuery && !isLoading && (
            <div className="py-16 text-center max-w-md mx-auto">
              <CircleAlert className="h-10 w-10 mx-auto mb-3 text-muted-foreground/40" />
              <p className="text-sm font-medium text-foreground/80">Row này không map được về một cuộc chat cụ thể</p>
              <div className="text-xs text-muted-foreground mt-2 space-y-2">
                <p>
                  Hoạt động này thiếu <code className="bg-muted px-1 rounded">sender_id</code> hoặc{' '}
                  <code className="bg-muted px-1 rounded">channel_name</code> — thường xảy ra với:
                </p>
                <ul className="text-left list-disc pl-4 space-y-0.5">
                  <li>Follow-up queue (tin gửi tự động theo schedule)</li>
                  <li>Outbound gửi thủ công qua dashboard</li>
                  <li>Rows hệ thống (skipped bởi policy/quota)</li>
                </ul>
                {fallbackCustomerName && (
                  <p className="pt-2 border-t border-border/50">
                    💡 Muốn xem chat của <span className="font-semibold text-foreground/80">{fallbackCustomerName}</span>?
                    Scroll xuống bảng Hoạt động, click vào 1 row có cột "Hội thoại" là tên khách.
                  </p>
                )}
              </div>
              <Button size="sm" variant="outline" onClick={onClose} className="mt-4">
                Đóng & xem danh sách hoạt động
              </Button>
            </div>
          )}

          {canQuery && isLoading && (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              <span className="text-sm">Đang tải lịch sử chat...</span>
            </div>
          )}

          {!isLoading && (error || data?.error) && (
            <div className="py-12 text-center">
              <CircleAlert className="h-8 w-8 mx-auto mb-3 text-destructive/60" />
              <p className="text-sm text-destructive font-medium">Không load được lịch sử</p>
              <p className="text-xs text-muted-foreground mt-1">
                {error instanceof Error ? error.message : data?.error || 'Unknown error'}
              </p>
              <Button size="sm" variant="outline" onClick={() => refetch()} className="mt-4">
                Thử lại
              </Button>
            </div>
          )}

          {!isLoading && !error && data && data.messages.length === 0 && !debouncedSearch && (
            <div className="py-16 text-center">
              <MessageSquare className="h-12 w-12 mx-auto mb-3 text-muted-foreground/30" />
              <p className="text-sm font-medium text-foreground/80">Chưa có lịch sử chat với khách này</p>
              <p className="text-xs text-muted-foreground mt-1">
                Khách chưa tương tác với agent {data.agent_display_name || agentSlug}
              </p>
            </div>
          )}

          {!isLoading && !error && data && data.messages.length === 0 && debouncedSearch && (
            <div className="py-16 text-center">
              <Search className="h-12 w-12 mx-auto mb-3 text-muted-foreground/30" />
              <p className="text-sm font-medium text-foreground/80">Không tìm thấy kết quả cho "{debouncedSearch}"</p>
              <p className="text-xs text-muted-foreground mt-1">
                Thử từ khóa khác hoặc clear tìm kiếm
              </p>
            </div>
          )}

          {!isLoading && data && data.messages.length > 0 && (
            <div className="space-y-3">
              {data.messages.map((msg, i) => {
                const prev = i > 0 ? data.messages[i - 1] : null;
                const showDateDivider = !prev || isDifferentDay(prev.timestamp, msg.timestamp);
                // Session boundary: gap > 30 min between consecutive messages on same day
                const showGapDivider = !showDateDivider && prev?.timestamp && msg.timestamp &&
                  (new Date(msg.timestamp).getTime() - new Date(prev.timestamp).getTime() > 30 * 60 * 1000);
                const gapMinutes = showGapDivider && prev?.timestamp && msg.timestamp
                  ? Math.floor((new Date(msg.timestamp).getTime() - new Date(prev.timestamp).getTime()) / 60000)
                  : 0;

                return (
                  <div key={msg.id}>
                    {showDateDivider && (
                      <div className="flex items-center gap-3 my-5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
                        <div className="flex-1 h-px bg-border/50" />
                        <span className="px-2">
                          <Calendar className="inline h-3 w-3 mr-1" />
                          {fmtDateDivider(msg.timestamp)}
                        </span>
                        <div className="flex-1 h-px bg-border/50" />
                      </div>
                    )}
                    {showGapDivider && (
                      <div className="flex items-center gap-3 my-4 text-[10px] uppercase tracking-wider text-muted-foreground/40">
                        <div className="flex-1 h-px bg-border/30" />
                        <span>Cách {gapMinutes < 60 ? `${gapMinutes}m` : `${Math.floor(gapMinutes / 60)}h ${gapMinutes % 60}m`}</span>
                        <div className="flex-1 h-px bg-border/30" />
                      </div>
                    )}
                    <ChatBubble
                      message={msg}
                      agentDisplayName={data.agent_display_name || agentSlug}
                      onOpenSessionLog={onOpenSessionLog}
                    />
                  </div>
                );
              })}
            </div>
          )}

          {autoRefresh && data && data.messages.length > 0 && (
            <div className="py-6 text-center">
              <span className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-50 dark:bg-emerald-950/20 text-[12px] font-medium text-emerald-700 dark:text-emerald-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Đang theo dõi tin nhắn mới...
              </span>
            </div>
          )}
        </div>

        {/* ─── SESSION PICKER PANEL (right side) ──────────────── */}
        {sessionPanelOpen && (
          <SessionPickerPanel
            agentSlug={agentSlug}
            agentDisplayName={data?.agent_display_name || agentSlug}
            timeframe={sessionTimeframe}
            onTimeframeChange={setSessionTimeframe}
            chatFirstMsgAt={data?.messages[0]?.timestamp || null}
            chatLastMsgAt={data?.messages[data.messages.length - 1]?.timestamp || data?.lastMessageAt || null}
            onOpenSession={(sessionId) => onOpenSessionLog?.(sessionId)}
            onClose={() => setSessionPanelOpen(false)}
          />
        )}
        </div>
        {/* ─── /Split layout ────────────────────────────────── */}

        {/* ─── FOOTER ─────────────────────────────────────────── */}
        {data && data.messages.length > 0 && (
          <div className="px-6 py-2 border-t text-[11px] text-muted-foreground flex items-center justify-between shrink-0">
            <span>
              Hiển thị {data.messages.length}/{data.fullHistoryCount} tin nhắn
              {debouncedSearch && <span className="ml-2">· Filter: "{debouncedSearch}"</span>}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  const text = data.messages.map(m => `[${fmtTime(m.timestamp)}] ${m.senderName}: ${extractActualMessage(m.content)}`).join('\n\n');
                  void copyToClipboard(text);
                }}
                className="hover:text-foreground underline-offset-2 hover:underline"
              >
                Copy all
              </button>
              <button
                onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
                className="hover:text-foreground"
                aria-label="Scroll to top"
              >
                ↑
              </button>
              <button
                onClick={() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })}
                className="hover:text-foreground"
                aria-label="Scroll to bottom"
              >
                ↓
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Chat Bubble ────────────────────────────────────────────────────

function ChatBubble({
  message,
  agentDisplayName,
  onOpenSessionLog,
}: {
  message: ChatMessage;
  agentDisplayName: string;
  onOpenSessionLog?: (sessionId: string | null) => void;
}) {
  const isCustomer = message.role === 'customer';
  const actualContent = isCustomer ? extractActualMessage(message.content) : message.content;

  // Detect markers in agent messages
  const hasEscalation = !isCustomer && /🚨|ESCALATION|\[\[ESCALATE:/i.test(actualContent);
  const hasTicket = !isCustomer && /✓ Ticket|ticket created/i.test(actualContent);
  const hasSendMedia = !isCustomer && /\[\[SEND_MEDIA:/i.test(actualContent);

  return (
    <div className={cn('flex group', isCustomer ? 'justify-start' : 'justify-end')}>
      <div
        className={cn(
          'max-w-[78%] rounded-md px-3 py-2 relative',
          isCustomer
            ? 'bg-muted/60 border border-border/40'
            : 'bg-accent/25 border-l-2 border-emerald-500/40 pl-3',
        )}
      >
        {/* Sender row */}
        <div className="flex items-center gap-2 mb-1">
          {isCustomer ? (
            <UserIcon className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
          ) : (
            <Bot className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
          )}
          <span className={cn(
            'text-xs font-semibold',
            isCustomer ? 'text-blue-700 dark:text-blue-300' : 'text-emerald-700 dark:text-emerald-300',
          )}>
            {isCustomer ? message.senderName : agentDisplayName}
          </span>
          <span className="text-[11px] tabular-nums text-muted-foreground/50 ml-auto">
            {fmtTime(message.timestamp)}
          </span>
          <div className="opacity-0 group-hover:opacity-100 transition-opacity">
            <CopyButton text={actualContent} size={11} />
          </div>
        </div>

        {/* Content */}
        <div className="text-sm text-foreground/90 break-words">
          <MarkdownBody>{actualContent}</MarkdownBody>
        </div>

        {/* Agent markers row */}
        {!isCustomer && (hasEscalation || hasTicket || hasSendMedia) && (
          <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
            {hasEscalation && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-orange-50 dark:bg-orange-950/20 text-orange-700 dark:text-orange-400 border-orange-200 dark:border-orange-800">
                🚨 Escalation
              </Badge>
            )}
            {hasTicket && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-purple-50 dark:bg-purple-950/20 text-purple-700 dark:text-purple-400 border-purple-200 dark:border-purple-800">
                🎫 Ticket
              </Badge>
            )}
            {hasSendMedia && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-cyan-50 dark:bg-cyan-950/20 text-cyan-700 dark:text-cyan-400 border-cyan-200 dark:border-cyan-800">
                📎 Media
              </Badge>
            )}
          </div>
        )}

        {/* Drill-down only when message has agent_session_id tracking.
            Per-message session_id tracking lands in v2 (writer-side patch of
            consumer.ts + router.ts). Until then, old messages have no
            precise session link — use the Sessions panel in the toolbar
            to browse all JSONL sessions of this agent. */}
        {!isCustomer && onOpenSessionLog && message.metadata?.agent_session_id && (
          <button
            onClick={() => onOpenSessionLog(message.metadata?.agent_session_id || null)}
            className="mt-1 text-[10px] text-muted-foreground/60 hover:text-foreground underline-offset-2 hover:underline inline-flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
            title={`Xem JSONL session: ${String(message.metadata.agent_session_id).slice(0, 8)}…`}
          >
            <FileText className="h-2.5 w-2.5" />
            Xem session log
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Session Picker Panel ───────────────────────────────────────────
// Collapsible right panel showing Claude + Gemini session JSONL files for
// this agent, filterable by timeframe. Each file click opens AgentLogDrawer
// overlay (Mode B) via onOpenSession callback.

function SessionPickerPanel({
  agentSlug,
  agentDisplayName,
  timeframe,
  onTimeframeChange,
  chatFirstMsgAt,
  chatLastMsgAt,
  onOpenSession,
  onClose,
}: {
  agentSlug: string;
  agentDisplayName: string;
  timeframe: 'chat' | 'week' | 'month' | 'all';
  onTimeframeChange: (t: 'chat' | 'week' | 'month' | 'all') => void;
  chatFirstMsgAt: string | null;
  chatLastMsgAt: string | null;
  onOpenSession: (sessionId: string) => void;
  onClose: () => void;
}) {
  // Compute date range based on timeframe
  const { fromISO, toISO } = useMemo(() => {
    const now = Date.now();
    if (timeframe === 'chat' && chatFirstMsgAt) {
      const first = new Date(chatFirstMsgAt).getTime();
      const last = chatLastMsgAt ? new Date(chatLastMsgAt).getTime() : now;
      // ±12h padding
      return {
        fromISO: new Date(first - 12 * 3600 * 1000).toISOString(),
        toISO: new Date(last + 12 * 3600 * 1000).toISOString(),
      };
    }
    if (timeframe === 'week') {
      return { fromISO: new Date(now - 7 * 86400 * 1000).toISOString(), toISO: new Date(now).toISOString() };
    }
    if (timeframe === 'month') {
      return { fromISO: new Date(now - 30 * 86400 * 1000).toISOString(), toISO: new Date(now).toISOString() };
    }
    return { fromISO: '', toISO: '' }; // all
  }, [timeframe, chatFirstMsgAt, chatLastMsgAt]);

  const { data, isLoading, error } = useQuery<SessionFilesResponse>({
    queryKey: ['session-files', agentSlug, fromISO, toISO],
    queryFn: async () => {
      const p = new URLSearchParams();
      if (fromISO) p.set('from', fromISO);
      if (toISO) p.set('to', toISO);
      p.set('limit', '100');
      const resp = await fetch(`/api/channels/agent-configs/${encodeURIComponent(agentSlug)}/session-files?${p}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.json();
    },
    enabled: !!agentSlug,
  });

  const claudeFiles = useMemo(() => (data?.files || []).filter((f) => f.fileKind === 'claude-jsonl'), [data]);
  const geminiFiles = useMemo(() => (data?.files || []).filter((f) => f.fileKind === 'gemini-json'), [data]);

  // Check if session might match a customer message (within ±10min of chat range)
  const isNearChat = (f: SessionFile): boolean => {
    if (!chatFirstMsgAt || !chatLastMsgAt) return false;
    const sessTs = new Date(f.last_activity_at).getTime();
    const firstTs = new Date(chatFirstMsgAt).getTime();
    const lastTs = new Date(chatLastMsgAt).getTime();
    return sessTs >= firstTs - 10 * 60 * 1000 && sessTs <= lastTs + 10 * 60 * 1000;
  };

  return (
    <div className="w-80 shrink-0 border-l bg-muted/20 flex flex-col overflow-hidden">
      {/* Panel header */}
      <div className="px-4 py-3 border-b flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">Session logs</div>
            <div className="text-[10px] text-muted-foreground">
              {data ? `${data.claude_count} Claude · ${data.gemini_count} Gemini` : 'Đang tải...'}
            </div>
          </div>
        </div>
        <Button size="icon" variant="ghost" onClick={onClose} className="h-6 w-6 shrink-0" aria-label="Đóng panel">
          <PanelRightClose className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Timeframe filter */}
      <div className="px-4 py-2 border-b flex items-center gap-1.5 shrink-0 text-[10px]">
        <Filter className="h-3 w-3 text-muted-foreground/60" />
        {(['chat', 'week', 'month', 'all'] as const).map((t) => (
          <button
            key={t}
            onClick={() => onTimeframeChange(t)}
            className={cn(
              'px-1.5 py-0.5 rounded border transition-colors',
              timeframe === t
                ? 'bg-foreground/10 text-foreground border-border'
                : 'text-muted-foreground/60 border-transparent hover:text-foreground',
            )}
            title={
              t === 'chat' ? 'Trong khoảng thời gian chat ±12h'
              : t === 'week' ? '7 ngày gần nhất'
              : t === 'month' ? '30 ngày gần nhất'
              : 'Tất cả (không filter)'
            }
          >
            {t === 'chat' ? 'Chat range' : t === 'week' ? '7d' : t === 'month' ? '30d' : 'All'}
          </button>
        ))}
      </div>

      {/* File list */}
      <div className="flex-1 overflow-auto">
        {isLoading && (
          <div className="p-4 text-center text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mx-auto mb-1.5" />
            <p className="text-xs">Đang scan disk...</p>
          </div>
        )}
        {error && (
          <div className="p-4 text-center text-destructive">
            <CircleAlert className="h-4 w-4 mx-auto mb-1.5" />
            <p className="text-xs">Không load được: {error instanceof Error ? error.message : 'Error'}</p>
          </div>
        )}
        {!isLoading && !error && data && data.total === 0 && (
          <div className="p-4 text-center text-muted-foreground">
            <FolderOpen className="h-6 w-6 mx-auto mb-2 opacity-30" />
            <p className="text-xs font-medium">Không có session file nào</p>
            <p className="text-[10px] mt-1">
              Thử chuyển timeframe qua <span className="font-mono">All</span> hoặc dùng agent khác.
            </p>
          </div>
        )}

        {!isLoading && !error && data && data.total > 0 && (
          <>
            {claudeFiles.length > 0 && (
              <div>
                <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 bg-muted/30 sticky top-0">
                  <FileText className="inline h-3 w-3 mr-1" />
                  Claude ({claudeFiles.length})
                </div>
                {claudeFiles.map((f) => (
                  <SessionFileRow key={f.session_id} file={f} nearChat={isNearChat(f)} onClick={() => onOpenSession(f.session_id)} />
                ))}
              </div>
            )}
            {geminiFiles.length > 0 && (
              <div>
                <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 bg-muted/30 sticky top-0">
                  <Sparkles className="inline h-3 w-3 mr-1" />
                  Gemini ({geminiFiles.length})
                </div>
                {geminiFiles.map((f) => (
                  <SessionFileRow key={f.session_id} file={f} nearChat={isNearChat(f)} onClick={() => onOpenSession(f.session_id)} />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Panel footer */}
      <div className="px-4 py-2 border-t text-[10px] text-muted-foreground/60 shrink-0">
        Agent: <span className="font-medium text-foreground/80">{agentDisplayName}</span>
        {data && data.total > data.returned && (
          <span className="ml-2">· Hiển thị {data.returned}/{data.total}</span>
        )}
      </div>
    </div>
  );
}

function SessionFileRow({
  file,
  nearChat,
  onClick,
}: {
  file: SessionFile;
  nearChat: boolean;
  onClick: () => void;
}) {
  const date = new Date(file.last_activity_at);
  const dateStr = date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
  const timeStr = date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const sizeKB = Math.round(file.size_bytes / 1024);

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full px-4 py-2 border-b border-border/30 text-left hover:bg-accent/50 transition-colors',
        nearChat && 'bg-blue-50/40 dark:bg-blue-950/10',
      )}
      title={`Open JSONL: ${file.short_id}…  ${file.turn_count} turns · ${sizeKB}KB`}
    >
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <span className="font-mono text-[11px] text-foreground/80 truncate">{file.short_id}…</span>
        <span className="text-[10px] tabular-nums text-muted-foreground/60 shrink-0">
          {dateStr} {timeStr}
        </span>
      </div>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground/60">
        <span>{file.turn_count} turns</span>
        <span>·</span>
        <span>{sizeKB}KB</span>
        {nearChat && (
          <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 bg-blue-100/50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-700">
            match
          </Badge>
        )}
      </div>
      {file.first_user_snippet && (
        <div className="mt-0.5 text-[10px] text-muted-foreground/50 line-clamp-2 leading-tight">
          {file.first_user_snippet}
        </div>
      )}
    </button>
  );
}
