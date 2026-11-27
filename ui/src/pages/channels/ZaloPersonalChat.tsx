import { promptDialog } from "@/lib/prompt-dialog";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useImageLightbox } from "@/components/ImageLightbox";
import { channelsApi, type PendingMessage } from "@/api/channels";
import { warRoomApi } from "@/api/warRoom";
import { useToast } from "@/context/ToastContext";
import { copyToClipboard } from "@/lib/clipboard";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  Send,
  MessageCircle,
  User,
  Smile,
  Paperclip,
  Zap,
  Bell,
  Loader2,
  Check,
  X,
  ImageIcon,
  FileText,
  Bot,
  Copy,
  Pin,
  Star,
  Trash2,
  Info,
} from "lucide-react";

// ── Emoji data ──────────────────────────────────────────────
const EMOJI_CATEGORIES: { label: string; emojis: string[] }[] = [
  {
    label: "Mặt cười",
    emojis: [
      "😀","😃","😄","😁","😆","😅","🤣","😂",
      "🙂","😊","😇","🥰","😍","🤩","😘","😋",
      "😛","😜","🤪","😝","🤑","🤗","🤭","🫢",
      "🤫","🤔","🫡","🤐","🤨","😐","😑","😶",
      "🫠","😏","😒","🙄","😬","😮‍💨","🤥","🫣",
      "😌","😔","😪","🤤","😴","😷","🤒","🤕",
      "🤢","🤮","🥵","🥶","🥴","😵","🤯","🥳",
    ],
  },
  {
    label: "Tay",
    emojis: [
      "👋","🤚","🖐️","✋","🖖","🫱","🫲","🫳",
      "🫴","👌","🤌","🤏","✌️","🤞","🫰","🤟",
      "🤘","🤙","👈","👉","👆","🖕","👇","☝️",
      "🫵","👍","👎","✊","👊","🤛","🤜","👏",
      "🙌","🫶","👐","🤲","🤝","🙏","💪","🦾",
      "🖖","💅","🤳","💪","🦵","🦶","👂","🦻",
    ],
  },
  {
    label: "Tim",
    emojis: [
      "❤️","🧡","💛","💚","💙","💜","🖤","🤍",
      "🤎","💔","❤️‍🔥","❤️‍🩹","❣️","💕","💞","💓",
      "💗","💖","💘","💝","💟","♥️","🫀","💑",
      "💏","👪","👨‍👩‍👧","👨‍👩‍👦","💐","🌹","🌷","🌸",
    ],
  },
  {
    label: "Vật",
    emojis: [
      "⌚","📱","💻","⌨️","🖥️","🖨️","🖱️","🖲️",
      "💾","💿","📀","📸","📹","🎥","📽️","🎞️",
      "📞","☎️","📟","📠","📺","📻","🎙️","🎚️",
      "🎛️","🧭","⏱️","⏰","🔔","🔑","🗝️","🪙",
      "💰","💳","💎","⚖️","🔧","🔨","⚒️","🛠️",
      "🧰","🪛","🔩","⚙️","🧱","🪜","🧲","🪝",
    ],
  },
  {
    label: "Thiên nhiên",
    emojis: [
      "🌍","🌎","🌏","🌐","🗺️","🧭","🏔️","⛰️",
      "🌋","🗻","🏕️","🏖️","🏜️","🏝️","🏞️","🌅",
      "🌄","🌠","🎇","🎆","🌇","🌆","🏙️","🌃",
      "🌁","🌉","🌊","🌈","☀️","🌤️","⛅","🌥️",
      "☁️","🌦️","🌧️","⛈️","🌩️","🌨️","❄️","☃️",
      "⛄","🌬️","💨","🌪️","🌫️","🌊","💧","💦",
    ],
  },
];

const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "😡"];

const DEFAULT_TEMPLATES = [
  "Cảm ơn bạn đã liên hệ! Mình sẽ hỗ trợ ngay ạ.",
  "Vui lòng cho mình biết thêm chi tiết về vấn đề của bạn.",
  "Mình đã chuyển thông tin cho bộ phận phụ trách. Bạn sẽ được hỗ trợ sớm nhất.",
  "Cảm ơn bạn! Chúc bạn một ngày tốt lành 🙏",
  "Bạn có thể xem thêm tại gemral.com nhé!",
];

// ── Avatar color palette ────────────────────────────────────
const AVATAR_COLORS = [
  "bg-blue-500",
  "bg-emerald-500",
  "bg-violet-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-cyan-500",
  "bg-pink-500",
  "bg-indigo-500",
];

function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

// ── Try parse image JSON ────────────────────────────────────
function tryParseImageMessage(body: string): { thumb: string; hd?: string; href?: string; title?: string } | null {
  if (!body) return null;
  try {
    const trimmed = body.trim();
    if (!trimmed.startsWith("{")) return null;
    const parsed = JSON.parse(trimmed);
    if (parsed.thumb && typeof parsed.thumb === "string" && parsed.thumb.startsWith("https://")) {
      return { thumb: parsed.thumb, hd: parsed.hd, href: parsed.href, title: parsed.title };
    }
    return null;
  } catch {
    return null;
  }
}

function loadCustomTemplates(): string[] {
  try { return JSON.parse(localStorage.getItem("zalo-quick-templates") || "[]"); } catch { return []; }
}
function saveCustomTemplates(t: string[]) {
  localStorage.setItem("zalo-quick-templates", JSON.stringify(t));
}

// ── Types ───────────────────────────────────────────────────
interface Thread {
  thread_id: string;
  thread_type: string;
  sender_name: string;
  last_message: string;
  last_ts: string;
  unread_count: number;
}

interface OptimisticMessage {
  id: string;
  body: string;
  direction: string;
  from_uid: string;
  sender_name: string;
  ts: string;
  status: "sending" | "sent" | "failed";
  reactions?: string[];
}

// ── Context menu types ──────────────────────────────────────
interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  messageId: string;
  messageBody: string;
  isOutbound: boolean;
}

// ── Component ───────────────────────────────────────────────
export function ZaloPersonalChat() {
  const { channelName, threadId } = useParams<{ channelName: string; threadId?: string }>();
  const navigate = useNavigate();
  const { openImage } = useImageLightbox();
  const qc = useQueryClient();
  const { pushToast } = useToast();

  const [input, setInput] = useState("");
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [emojiCategory, setEmojiCategory] = useState(0);
  const [showQuickReplies, setShowQuickReplies] = useState(false);
  const [showFilePreview, setShowFilePreview] = useState<{ name: string; type: "image" | "file" } | null>(null);
  const [messageReactions, setMessageReactions] = useState<Record<string, string[]>>({});
  const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [customTemplates, setCustomTemplates] = useState<string[]>(loadCustomTemplates);
  const [editingTemplateIdx, setEditingTemplateIdx] = useState<number | null>(null);
  const [editingTemplateText, setEditingTemplateText] = useState("");
  const allTemplates = [...DEFAULT_TEMPLATES, ...customTemplates];

  // Context menu state
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false, x: 0, y: 0, messageId: "", messageBody: "", isOutbound: false,
  });
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const quickReplyRef = useRef<HTMLDivElement>(null);

  // Track previous message count for browser notifications
  const prevMessageCountRef = useRef<number>(0);
  const isInitialLoadRef = useRef(true);

  // Agent processing state (from SSE stream)
  const [agentProcessing, setAgentProcessing] = useState<{ agentSlug: string; active: boolean } | null>(null);

  // ── Request notification permission on mount ──────────────
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  // ── Subscribe to agent streaming events via SSE ─────────
  useEffect(() => {
    if (!threadId) return;

    const es = new EventSource("/api/channels/stream");
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "agent:start") {
          setAgentProcessing({ agentSlug: data.agentSlug, active: true });
        } else if (data.type === "agent:done" || data.type === "agent:error") {
          setAgentProcessing(null);
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => {
      // SSE reconnects automatically
    };
    return () => es.close();
  }, [threadId]);

  // ── Queries ─────────────────────────────────────────────
  const { data: threads = [] } = useQuery({
    queryKey: ["zalo-threads", channelName],
    queryFn: async () => {
      const msgs = await channelsApi.getMessages(channelName!, undefined, 200);
      const map = new Map<string, Thread>();
      for (const m of msgs) {
        const existing = map.get(m.thread_id);
        if (!existing || m.ts > existing.last_ts) {
          map.set(m.thread_id, {
            thread_id: m.thread_id,
            thread_type: m.thread_type,
            sender_name: m.sender_name,
            last_message: m.body?.substring(0, 80) || "(media)",
            last_ts: m.ts,
            unread_count: 0,
          });
        }
      }
      return Array.from(map.values()).sort((a, b) => b.last_ts.localeCompare(a.last_ts));
    },
    enabled: !!channelName,
    refetchInterval: 5000,
  });

  const { data: messages = [] } = useQuery({
    queryKey: ["zalo-messages", channelName, threadId],
    queryFn: () => channelsApi.getMessages(channelName!, threadId, 100),
    enabled: !!channelName && !!threadId,
    refetchInterval: 1000,
  });

  // ── Browser notification on new inbound message ───────────
  useEffect(() => {
    if (!messages.length) return;

    // Skip initial load
    if (isInitialLoadRef.current) {
      isInitialLoadRef.current = false;
      prevMessageCountRef.current = messages.length;
      return;
    }

    if (messages.length > prevMessageCountRef.current) {
      // Find new messages
      const newMessages = messages.slice(prevMessageCountRef.current);
      const newInbound = newMessages.filter(
        (m: any) => m.direction !== "outbound" && m.from_uid !== ""
      );

      if (newInbound.length > 0 && document.hidden) {
        const lastInbound = newInbound[newInbound.length - 1] as any;
        const senderName = lastInbound.sender_name || "Tin nhắn mới";
        const bodyPreview = (lastInbound.body || "(media)").substring(0, 100);

        if ("Notification" in window && Notification.permission === "granted") {
          const notif = new Notification(senderName, {
            body: bodyPreview,
            icon: "/favicon.ico",
          });
          notif.onclick = () => {
            window.focus();
            notif.close();
          };
        }
      }
    }

    prevMessageCountRef.current = messages.length;
  }, [messages]);

  // ── Optimistic messages ─────────────────────────────────
  const [optimisticMsgs, setOptimisticMsgs] = useState<OptimisticMessage[]>([]);

  const sendMut = useMutation({
    mutationFn: (msg: string) => channelsApi.sendMessage(channelName!, threadId!, msg),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["zalo-messages"] });
    },
  });

  const handleSend = useCallback(() => {
    const msg = input.trim();
    if (!msg) return;

    setIsSending(true);

    setOptimisticMsgs((prev) => [
      ...prev,
      {
        id: `opt-${Date.now()}`,
        body: msg,
        direction: "outbound",
        from_uid: "",
        sender_name: "Bạn",
        ts: new Date().toISOString(),
        status: "sending",
      },
    ]);
    setInput("");

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    sendMut.mutate(msg, {
      onSuccess: () => {
        setOptimisticMsgs((prev) =>
          prev.map((m) => (m.status === "sending" ? { ...m, status: "sent" as const } : m))
        );
        setTimeout(() => setOptimisticMsgs([]), 1500);
        setIsSending(false);
      },
      onError: () => {
        setOptimisticMsgs((prev) =>
          prev.map((m) => (m.status === "sending" ? { ...m, status: "failed" as const } : m))
        );
        setIsSending(false);
      },
    });
  }, [input, channelName, threadId, sendMut]);

  // ── Escalate to War Room ────────────────────────────────
  const handleEscalate = useCallback(async () => {
    const lastMsg = sortedMessages[sortedMessages.length - 1];
    const senderName = threads.find((t) => t.thread_id === threadId)?.sender_name || threadId || "Unknown";
    const preview = lastMsg?.body?.substring(0, 100) || "(không có tin nhắn)";
    const content = `[ESCALATE] ${senderName}: ${preview}`;

    try {
      await warRoomApi.sendMessage({
        channelId: "incidents",
        content,
        messageType: "escalation",
      });
      pushToast({
        title: "Đã thông báo War Room",
        body: `Đã gửi thông tin escalation đến kênh #incidents`,
        tone: "success",
        ttlMs: 3000,
      });
    } catch {
      pushToast({
        title: "Lỗi gửi thông báo",
        body: "Không thể gửi tin nhắn đến War Room. Vui lòng thử lại.",
        tone: "error",
        ttlMs: 4000,
      });
    }
  }, [threadId, threads, pushToast]);

  // ── Auto-scroll ─────────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, optimisticMsgs]);

  // ── Auto-focus textarea ─────────────────────────────────
  useEffect(() => {
    if (threadId && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [threadId]);

  // ── Close popups on outside click ───────────────────────
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(e.target as Node)) {
        setShowEmojiPicker(false);
      }
      if (quickReplyRef.current && !quickReplyRef.current.contains(e.target as Node)) {
        setShowQuickReplies(false);
      }
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu((prev) => ({ ...prev, visible: false }));
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // ── Close context menu on Escape ──────────────────────────
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setContextMenu((prev) => ({ ...prev, visible: false }));
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // ── Auto-resize textarea ───────────────────────────────
  const handleTextareaChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, []);

  // ── Insert emoji at cursor (do NOT close picker) ─────────
  const insertEmoji = useCallback((emoji: string) => {
    const ta = textareaRef.current;
    if (ta) {
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const before = input.substring(0, start);
      const after = input.substring(end);
      setInput(before + emoji + after);
      // Set cursor after emoji
      requestAnimationFrame(() => {
        ta.focus();
        const pos = start + emoji.length;
        ta.setSelectionRange(pos, pos);
      });
    } else {
      setInput((prev) => prev + emoji);
    }
    // Do NOT close emoji picker — user can pick multiple emojis
  }, [input]);

  // ── File selection ─────────────────────────────────────
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const isImage = file.type.startsWith("image/");
    setShowFilePreview({
      name: file.name,
      type: isImage ? "image" : "file",
    });
    setPendingFile(file);
    // Reset file input
    e.target.value = "";
  }, []);

  const handleSendFile = useCallback(async () => {
    if (!showFilePreview || !pendingFile || !channelName || !threadId) return;

    if (showFilePreview.type === "image") {
      // Real image upload via Zalo file API
      setIsSending(true);
      setOptimisticMsgs((prev) => [
        ...prev,
        {
          id: `opt-img-${Date.now()}`,
          body: `[Đang gửi hình: ${showFilePreview.name}...]`,
          direction: "outbound",
          from_uid: "",
          sender_name: "Bạn",
          ts: new Date().toISOString(),
          status: "sending",
        },
      ]);
      setShowFilePreview(null);

      try {
        const result = await channelsApi.uploadImage(channelName, threadId, pendingFile);
        if (result.success) {
          setOptimisticMsgs((prev) =>
            prev.map((m) => (m.status === "sending" ? { ...m, body: "[Hình ảnh đã gửi]", status: "sent" as const } : m))
          );
          pushToast({ title: "Đã gửi hình ảnh", body: showFilePreview.name, tone: "success", ttlMs: 2000 });
        } else {
          setOptimisticMsgs((prev) =>
            prev.map((m) => (m.status === "sending" ? { ...m, body: `[Lỗi: ${result.error}]`, status: "failed" as const } : m))
          );
          pushToast({ title: "Gửi hình thất bại", body: result.error || "Lỗi không xác định", tone: "error", ttlMs: 4000 });
        }
      } catch (err: any) {
        setOptimisticMsgs((prev) =>
          prev.map((m) => (m.status === "sending" ? { ...m, status: "failed" as const } : m))
        );
        pushToast({ title: "Gửi hình thất bại", body: err.message, tone: "error", ttlMs: 4000 });
      } finally {
        setIsSending(false);
        setPendingFile(null);
        setTimeout(() => setOptimisticMsgs([]), 2000);
        qc.invalidateQueries({ queryKey: ["zalo-messages"] });
      }
    } else {
      // Non-image files: send as text placeholder for now
      const placeholder = `[Tệp: ${showFilePreview.name}]`;
      setInput(placeholder);
      setShowFilePreview(null);
      setPendingFile(null);
      requestAnimationFrame(() => {
        handleSend();
      });
    }
  }, [showFilePreview, pendingFile, channelName, threadId, handleSend, pushToast, qc]);

  // ── Toggle reaction on message ─────────────────────────
  const toggleReaction = useCallback((messageId: string, emoji: string) => {
    setMessageReactions((prev) => {
      const current = prev[messageId] || [];
      const hasEmoji = current.includes(emoji);
      return {
        ...prev,
        [messageId]: hasEmoji ? current.filter((e) => e !== emoji) : [...current, emoji],
      };
    });
  }, []);

  // ── Context menu handler ──────────────────────────────────
  const handleContextMenu = useCallback((e: React.MouseEvent, msgId: string, msgBody: string, isOutbound: boolean) => {
    e.preventDefault();
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      messageId: msgId,
      messageBody: msgBody,
      isOutbound,
    });
  }, []);

  const handleContextAction = useCallback((action: string) => {
    switch (action) {
      case "copy":
        void copyToClipboard(contextMenu.messageBody).then((ok) => {
          pushToast(
            ok
              ? { title: "Đã sao chép", body: "Tin nhắn đã được sao chép vào clipboard", tone: "success", ttlMs: 2000 }
              : { title: "Không thể sao chép", body: "Trình duyệt chặn quyền truy cập clipboard.", tone: "error", ttlMs: 3000 },
          );
        });
        break;
      case "pin":
        pushToast({ title: "Tính năng đang phát triển", body: "Ghim tin nhắn sẽ sớm được hỗ trợ", tone: "info", ttlMs: 2000 });
        break;
      case "star":
        pushToast({ title: "Tính năng đang phát triển", body: "Đánh dấu tin nhắn sẽ sớm được hỗ trợ", tone: "info", ttlMs: 2000 });
        break;
      case "delete":
        pushToast({ title: "Tính năng đang phát triển", body: "Xóa tin nhắn sẽ sớm được hỗ trợ", tone: "info", ttlMs: 2000 });
        break;
      case "details":
        pushToast({ title: "Tính năng đang phát triển", body: "Xem chi tiết sẽ sớm được hỗ trợ", tone: "info", ttlMs: 2000 });
        break;
    }
    setContextMenu((prev) => ({ ...prev, visible: false }));
  }, [contextMenu.messageBody, pushToast]);

  // ── Sorted messages ─────────────────────────────────────
  const sortedMessages = [...messages, ...optimisticMsgs].sort((a: any, b: any) =>
    (a.ts || a.created_at || "").localeCompare(b.ts || b.created_at || "")
  );

  // ── Message grouping ─────────────────────────────────────
  const groupedMessages = useMemo(() => {
    return sortedMessages.map((msg: any, idx: number) => {
      const prev = idx > 0 ? sortedMessages[idx - 1] : null;
      const isOutbound = msg.direction === "outbound" || msg.status === "sent" || msg.from_uid === "";
      const prevIsOutbound = prev ? (prev.direction === "outbound" || prev.status === "sent" || prev.from_uid === "") : null;

      // Same sender group: same direction AND same sender_name (or both outbound)
      const isSameGroup = prev
        ? isOutbound === prevIsOutbound && (isOutbound || msg.sender_name === prev.sender_name)
        : false;

      return { msg, isOutbound, isFirstInGroup: !isSameGroup };
    });
  }, [sortedMessages]);

  // ── Helpers ─────────────────────────────────────────────
  function formatTime(ts: string) {
    try {
      const d = new Date(ts);
      return d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  }

  // ══════════════════════════════════════════════════════════
  // Thread list view (no threadId selected)
  // ══════════════════════════════════════════════════════════
  if (!threadId) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-3 p-4 border-b">
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="font-semibold">Tin nhắn Zalo</h1>
        </div>

        {threads.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <MessageCircle className="h-12 w-12 mx-auto mb-3 opacity-30" />
              <p className="text-sm font-medium">Chưa có tin nhắn nào</p>
              <p className="text-xs mt-1 opacity-60">Tin nhắn từ Zalo sẽ hiển thị tại đây</p>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-auto">
            {threads.map((t) => (
              <div
                key={t.thread_id}
                className="flex items-center gap-3 p-3 hover:bg-muted/50 cursor-pointer border-b transition-colors"
                onClick={() => navigate(t.thread_id)}
              >
                <div className={`w-9 h-9 rounded-full ${getAvatarColor(t.sender_name)} flex items-center justify-center shrink-0`}>
                  <span className="text-sm font-medium text-white">{t.sender_name?.charAt(0)?.toUpperCase() || "?"}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-sm truncate">{t.sender_name}</span>
                    <span className="text-[10px] text-muted-foreground shrink-0">
                      {formatTime(t.last_ts)}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground truncate">{t.last_message}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ══════════════════════════════════════════════════════════
  // Chat view (threadId selected)
  // ══════════════════════════════════════════════════════════
  const threadName = sortedMessages[0]?.sender_name || threadId;

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ──────────────────────────────────────── */}
      <div className="flex items-center gap-3 p-3 border-b shrink-0">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className={`w-8 h-8 rounded-full ${getAvatarColor(threadName)} flex items-center justify-center`}>
          <span className="text-sm font-medium text-white">{threadName?.charAt(0)?.toUpperCase() || "?"}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm truncate">{threadName}</div>
          <div className="text-[10px] text-muted-foreground">UID: {threadId}</div>
        </div>
        {/* Notify Board button */}
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 text-muted-foreground hover:text-amber-500"
          title="Thông báo War Room"
          onClick={handleEscalate}
        >
          <Bell className="h-4 w-4" />
        </Button>
      </div>

      {/* ── Messages ────────────────────────────────────── */}
      <div className="flex-1 overflow-auto p-4 space-y-0.5">
        {sortedMessages.length === 0 && (
          <div className="flex-1 flex items-center justify-center h-full text-muted-foreground">
            <div className="text-center">
              <MessageCircle className="h-12 w-12 mx-auto mb-3 opacity-30" />
              <p className="text-sm font-medium">Chưa có tin nhắn nào</p>
              <p className="text-xs mt-1 opacity-60">Bắt đầu cuộc trò chuyện</p>
            </div>
          </div>
        )}

        {groupedMessages.map(({ msg, isOutbound, isFirstInGroup }: any, idx: number) => {
          const isFailed = msg.status === "failed";
          const isSendingMsg = msg.status === "sending";
          const msgId = msg.id;
          const reactions = messageReactions[msgId] || [];
          const isAgentReply = isOutbound && msg.sender_name && msg.sender_name !== "Bạn";
          const imageData = tryParseImageMessage(msg.body);

          return (
            <div
              key={msgId}
              className={`flex ${isOutbound ? "justify-end" : "justify-start"} group ${isFirstInGroup ? "mt-3" : "mt-0.5"}`}
              onMouseEnter={() => setHoveredMessageId(msgId)}
              onMouseLeave={() => setHoveredMessageId(null)}
            >
              {/* Inbound avatar */}
              {!isOutbound && (
                <div className="w-8 h-8 shrink-0 mr-2 mt-auto">
                  {isFirstInGroup ? (
                    <div className={`w-8 h-8 rounded-full ${getAvatarColor(msg.sender_name || "?")} flex items-center justify-center`}>
                      <span className="text-xs font-medium text-white">{(msg.sender_name || "?").charAt(0).toUpperCase()}</span>
                    </div>
                  ) : (
                    <div className="w-8 h-8" /> /* spacer for alignment */
                  )}
                </div>
              )}

              <div className="relative max-w-[75%]">
                {/* Sender name for first message in group (inbound only) */}
                {!isOutbound && isFirstInGroup && (
                  <p className="text-[11px] text-muted-foreground mb-0.5 ml-1">{msg.sender_name}</p>
                )}
                {/* Agent name for outbound agent replies */}
                {isOutbound && isAgentReply && isFirstInGroup && (
                  <p className="text-[11px] text-violet-500 mb-0.5 mr-1 text-right">{msg.sender_name}</p>
                )}

                {/* Message bubble */}
                <div
                  className={`rounded-2xl px-3.5 py-2 ${
                    isOutbound
                      ? isFailed
                        ? "bg-primary text-primary-foreground border-2 border-destructive"
                        : "bg-primary text-primary-foreground"
                      : "bg-muted"
                  }`}
                  onContextMenu={(e) => handleContextMenu(e, msgId, msg.body || "", isOutbound)}
                >
                  {/* Image message rendering */}
                  {imageData ? (
                    <div>
                      {imageData.title && (
                        <p className="text-sm mb-1">{imageData.title}</p>
                      )}
                      <img
                        src={imageData.thumb}
                        alt={imageData.title || "Hình ảnh"}
                        className="max-w-[200px] rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
                        data-lightbox=""
                        data-lightbox-src={imageData.hd || imageData.href || imageData.thumb}
                        onClick={() => {
                          const fullUrl = imageData.hd || imageData.href || imageData.thumb;
                          openImage(fullUrl, imageData.title || "Hình ảnh");
                        }}
                      />
                    </div>
                  ) : (
                    <p className="text-sm whitespace-pre-wrap break-words">
                      {msg.body || "(media)"}
                    </p>
                  )}
                  <div
                    className={`flex items-center gap-1.5 mt-0.5 ${
                      isOutbound ? "justify-end" : "justify-start"
                    }`}
                  >
                    <span
                      className={`text-[10px] ${
                        isOutbound ? "text-primary-foreground/60" : "text-muted-foreground"
                      }`}
                    >
                      {formatTime(msg.ts)}
                    </span>
                    {/* Status indicators for outbound */}
                    {isOutbound && (
                      <span className="inline-flex items-center">
                        {isSendingMsg && (
                          <Loader2 className="h-3 w-3 animate-spin text-primary-foreground/60" />
                        )}
                        {msg.status === "sent" && (
                          <Check className="h-3 w-3 text-primary-foreground/60" />
                        )}
                        {!msg.status && !isSendingMsg && !isFailed && (
                          <Check className="h-3 w-3 text-primary-foreground/60" />
                        )}
                        {isFailed && <X className="h-3 w-3 text-destructive" />}
                      </span>
                    )}
                  </div>
                  {isFailed && (
                    <p className="text-[10px] text-destructive font-medium mt-0.5 text-right">
                      Gửi thất bại
                    </p>
                  )}
                </div>

                {/* Reactions display */}
                {reactions.length > 0 && (
                  <div
                    className={`flex gap-0.5 mt-1 ${
                      isOutbound ? "justify-end" : "justify-start"
                    }`}
                  >
                    <div className="inline-flex items-center gap-0.5 bg-muted/80 rounded-full px-1.5 py-0.5 border border-border/50">
                      {reactions.map((emoji, i) => (
                        <span key={i} className="text-xs cursor-pointer hover:scale-125 transition-transform">
                          {emoji}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Reaction emoji row (on hover) */}
                {hoveredMessageId === msgId && (
                  <div
                    className={`absolute -top-8 z-10 flex items-center gap-0.5 bg-popover border border-border rounded-full px-1.5 py-1 shadow-lg ${
                      isOutbound ? "right-0" : "left-0"
                    }`}
                  >
                    {REACTION_EMOJIS.map((emoji) => (
                      <button
                        key={emoji}
                        className="text-sm hover:scale-125 transition-transform px-0.5 cursor-pointer"
                        onClick={() => toggleReaction(msgId, emoji)}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Outbound avatar */}
              {isOutbound && (
                <div className="w-8 h-8 shrink-0 ml-2 mt-auto">
                  {isFirstInGroup ? (
                    isAgentReply ? (
                      <div
                        className="w-8 h-8 rounded-full bg-violet-500/15 flex items-center justify-center"
                        title={msg.sender_name}
                      >
                        <Bot className="h-4 w-4 text-violet-500" />
                      </div>
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-primary/15 flex items-center justify-center">
                        <User className="h-4 w-4 text-primary" />
                      </div>
                    )
                  ) : (
                    <div className="w-8 h-8" /> /* spacer for alignment */
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* Typing indicator — manual send */}
        {isSending && !agentProcessing && (
          <div className="flex justify-start mt-3">
            <div className="w-8 h-8 shrink-0 mr-2" />
            <div className="bg-muted rounded-2xl px-4 py-2.5">
              <div className="flex gap-1 items-center">
                <span className="text-xs text-muted-foreground mr-1">Đang gửi</span>
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:0ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          </div>
        )}

        {/* Agent processing indicator */}
        {agentProcessing?.active && (
          <div className="flex justify-end mt-3">
            <div className="bg-violet-500/10 border border-violet-500/20 rounded-2xl px-4 py-2.5">
              <div className="flex gap-1.5 items-center">
                <Bot className="h-3.5 w-3.5 text-violet-500 animate-pulse" />
                <span className="text-xs text-violet-600 dark:text-violet-400 font-medium">
                  {agentProcessing.agentSlug} đang xử lý
                </span>
                <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce [animation-delay:0ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
            <div className="w-8 h-8 shrink-0 ml-2 mt-auto">
              <div className="w-8 h-8 rounded-full bg-violet-500/15 flex items-center justify-center">
                <Bot className="h-4 w-4 text-violet-500" />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* ── Context menu ──────────────────────────────────── */}
      {contextMenu.visible && (
        <div
          ref={contextMenuRef}
          className="fixed z-[100] bg-popover border border-border rounded-xl shadow-xl py-1 min-w-[200px]"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted transition-colors text-left"
            onClick={() => handleContextAction("copy")}
          >
            <Copy className="h-4 w-4 text-muted-foreground" />
            Sao chép tin nhắn
          </button>
          <button
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted transition-colors text-left"
            onClick={() => handleContextAction("pin")}
          >
            <Pin className="h-4 w-4 text-muted-foreground" />
            Ghim tin nhắn
          </button>
          <button
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted transition-colors text-left"
            onClick={() => handleContextAction("star")}
          >
            <Star className="h-4 w-4 text-muted-foreground" />
            Đánh dấu tin nhắn
          </button>
          {contextMenu.isOutbound && (
            <button
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted transition-colors text-left text-destructive"
              onClick={() => handleContextAction("delete")}
            >
              <Trash2 className="h-4 w-4" />
              Xóa tin nhắn
            </button>
          )}
          <div className="border-t border-border my-1" />
          <button
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted transition-colors text-left"
            onClick={() => handleContextAction("details")}
          >
            <Info className="h-4 w-4 text-muted-foreground" />
            Xem chi tiết
          </button>
        </div>
      )}

      {/* ── File preview bar ────────────────────────────── */}
      {showFilePreview && (
        <div className="px-3 py-2 border-t bg-muted/30 flex items-center gap-3">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            {showFilePreview.type === "image" ? (
              <ImageIcon className="h-5 w-5 text-blue-500 shrink-0" />
            ) : (
              <FileText className="h-5 w-5 text-muted-foreground shrink-0" />
            )}
            <span className="text-sm truncate">{showFilePreview.name}</span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => setShowFilePreview(null)}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
            <Button size="sm" className="h-7 text-xs px-3" onClick={handleSendFile}>
              Gửi
            </Button>
          </div>
        </div>
      )}

      {/* ── Input area ──────────────────────────────────── */}
      <div className="p-3 border-t shrink-0">
        <div className="flex items-end gap-1.5">
          {/* File upload button */}
          <div className="relative">
            <Button
              variant="ghost"
              size="sm"
              className="h-9 w-9 p-0 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => fileInputRef.current?.click()}
              title="Đính kèm tệp"
            >
              <Paperclip className="h-4 w-4" />
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.zip,.rar,.txt"
              className="hidden"
              onChange={handleFileSelect}
            />
          </div>

          {/* Emoji picker button */}
          <div className="relative" ref={emojiPickerRef}>
            <Button
              variant="ghost"
              size="sm"
              className={`h-9 w-9 p-0 shrink-0 ${
                showEmojiPicker
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => {
                setShowEmojiPicker((v) => !v);
                setShowQuickReplies(false);
              }}
              title="Chèn biểu tượng cảm xúc"
            >
              <Smile className="h-4 w-4" />
            </Button>

            {/* Emoji picker popup */}
            {showEmojiPicker && (
              <div className="absolute bottom-full left-0 mb-2 w-72 sm:w-80 bg-popover border border-border rounded-xl shadow-xl z-50">
                {/* Header with close button */}
                <div className="flex items-center justify-between px-3 py-1.5 border-b border-border">
                  <span className="text-xs font-medium text-muted-foreground">Biểu tượng cảm xúc</span>
                  <button
                    className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => setShowEmojiPicker(false)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                {/* Category tabs */}
                <div className="flex border-b border-border overflow-x-auto px-1 py-1.5 gap-0.5">
                  {EMOJI_CATEGORIES.map((cat, idx) => (
                    <button
                      key={cat.label}
                      className={`text-[11px] px-2.5 py-1 rounded-md whitespace-nowrap transition-colors cursor-pointer ${
                        emojiCategory === idx
                          ? "bg-primary text-primary-foreground font-medium"
                          : "text-muted-foreground hover:bg-muted"
                      }`}
                      onClick={() => setEmojiCategory(idx)}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
                {/* Emoji grid */}
                <div className="grid grid-cols-8 gap-0.5 p-2 max-h-48 overflow-auto">
                  {EMOJI_CATEGORIES[emojiCategory].emojis.map((emoji, i) => (
                    <button
                      key={`${emoji}-${i}`}
                      className="text-xl hover:bg-muted rounded-md p-1 transition-colors cursor-pointer"
                      onClick={() => insertEmoji(emoji)}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Quick reply button */}
          <div className="relative" ref={quickReplyRef}>
            <Button
              variant="ghost"
              size="sm"
              className={`h-9 w-9 p-0 shrink-0 ${
                showQuickReplies
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => {
                setShowQuickReplies((v) => !v);
                setShowEmojiPicker(false);
              }}
              title="Mẫu trả lời nhanh"
            >
              <Zap className="h-4 w-4" />
            </Button>

            {/* Quick reply dropdown */}
            {showQuickReplies && (
              <div className="absolute bottom-full left-0 mb-2 w-80 sm:w-96 bg-popover border border-border rounded-xl shadow-xl z-50 overflow-hidden">
                <div className="px-3 py-2 border-b border-border">
                  <p className="text-xs font-medium text-muted-foreground">Mẫu trả lời nhanh</p>
                </div>
                <div className="py-1 max-h-60 overflow-auto">
                  {allTemplates.map((template, idx) => {
                    const isCustom = idx >= DEFAULT_TEMPLATES.length;
                    const customIdx = idx - DEFAULT_TEMPLATES.length;

                    if (editingTemplateIdx === idx) {
                      return (
                        <div key={idx} className="flex gap-1 px-2 py-1.5">
                          <input
                            className="flex-1 text-sm border rounded px-2 py-1 bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                            value={editingTemplateText}
                            onChange={(e) => setEditingTemplateText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && editingTemplateText.trim()) {
                                const updated = [...customTemplates];
                                updated[customIdx] = editingTemplateText.trim();
                                setCustomTemplates(updated);
                                saveCustomTemplates(updated);
                                setEditingTemplateIdx(null);
                              }
                              if (e.key === "Escape") setEditingTemplateIdx(null);
                            }}
                            autoFocus
                          />
                          <Button size="sm" variant="ghost" onClick={() => {
                            if (editingTemplateText.trim()) {
                              const updated = [...customTemplates];
                              updated[customIdx] = editingTemplateText.trim();
                              setCustomTemplates(updated);
                              saveCustomTemplates(updated);
                            }
                            setEditingTemplateIdx(null);
                          }}>
                            <Check className="h-3 w-3" />
                          </Button>
                        </div>
                      );
                    }

                    return (
                      <div key={idx} className="group flex items-center hover:bg-muted transition-colors">
                        <button
                          className="flex-1 text-left px-3 py-2 text-sm cursor-pointer"
                          onClick={() => {
                            setInput(template);
                            setShowQuickReplies(false);
                            textareaRef.current?.focus();
                          }}
                        >
                          {template}
                        </button>
                        {isCustom && (
                          <div className="hidden group-hover:flex gap-0.5 pr-2">
                            <button
                              className="p-1 hover:text-foreground text-muted-foreground"
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingTemplateIdx(idx);
                                setEditingTemplateText(template);
                              }}
                              title="Sửa"
                            >
                              <FileText className="h-3 w-3" />
                            </button>
                            <button
                              className="p-1 hover:text-destructive text-muted-foreground"
                              onClick={(e) => {
                                e.stopPropagation();
                                const updated = customTemplates.filter((_, i) => i !== customIdx);
                                setCustomTemplates(updated);
                                saveCustomTemplates(updated);
                              }}
                              title="Xóa"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="border-t border-border px-2 py-1.5">
                  <button
                    className="w-full text-left px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors flex items-center gap-1.5"
                    onClick={async () => {
                      const text = await promptDialog({ title: "Thêm mẫu trả lời", placeholder: "Nhập mẫu trả lời mới", multiline: true, confirmLabel: "Thêm" });
                      if (text) {
                        const updated = [...customTemplates, text];
                        setCustomTemplates(updated);
                        saveCustomTemplates(updated);
                      }
                    }}
                  >
                    <Zap className="h-3 w-3" /> Thêm mẫu mới...
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Textarea input */}
          <textarea
            ref={textareaRef}
            className="flex-1 rounded-2xl border bg-background px-4 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring resize-none min-h-[36px] max-h-[120px] leading-5"
            placeholder="Nhập tin nhắn..."
            rows={1}
            value={input}
            onChange={handleTextareaChange}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && input.trim()) {
                e.preventDefault();
                handleSend();
              }
            }}
          />

          {/* Send button */}
          <Button
            size="sm"
            className="rounded-full h-9 w-9 p-0 shrink-0"
            disabled={!input.trim()}
            onClick={handleSend}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
