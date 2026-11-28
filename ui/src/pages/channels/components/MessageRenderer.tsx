// MessageRenderer — Professional content renderer for chat messages
// Supports: text, markdown, images, stickers, files, calls, links, emojis, system messages
// Gracefully handles JSON content and mojibake encoding

import { Component, useState, type ErrorInfo, type ReactNode } from "react";

import { useImageLightbox } from "@/components/ImageLightbox";
import {
  Phone, FileText, Download, AlertCircle, CheckCircle, Clock, Info, ChevronDown, ChevronUp,
  File, FileSpreadsheet, Presentation, Archive, Music, Video, Paperclip, Image, Link2, Palette
} from "lucide-react";

interface MessageContent {
  body: string;
  content_type?: string;
  extra_data?: Record<string, unknown>;
  // onDark = bubble has a dark background (outbound zinc-800) → inner text elements
  // (links, URLs, inline code, expand/collapse) must switch to light-on-dark colors.
  // Default false = light bubble, keep brand `text-primary` accents.
  onDark?: boolean;
}

type MsgType = "text" | "image" | "sticker" | "file" | "call" | "link" | "gif" | "reaction" | "system" | "typing";

// Each message bubble renders inside an ErrorBoundary so one malformed message
// (bad JSON, invalid URL, unexpected shape) degrades to plain text instead of
// throwing during render and blanking the entire chat list.
export function MessageRenderer({ body, content_type, extra_data, onDark }: MessageContent) {
  return (
    <MessageErrorBoundary body={body}>
      <MessageBody body={body} content_type={content_type} extra_data={extra_data} onDark={onDark} />
    </MessageErrorBoundary>
  );
}

function MessageBody({ body, content_type, extra_data, onDark }: MessageContent) {
  const type = detectType({ body, content_type, extra_data });

  switch (type) {
    case "system":
      return <SystemMsg data={extra_data || tryParseJson(body)} body={body} />;
    case "typing":
      return <TypingIndicator />;
    case "image":
      return <ImageMsg data={extra_data || tryParseJson(body)} />;
    case "sticker":
      return <StickerMsg data={extra_data || tryParseJson(body)} />;
    case "file":
      return <FileMsg data={extra_data || tryParseJson(body)} />;
    case "call":
      return <CallMsg data={extra_data || tryParseJson(body)} />;
    case "link":
      return <LinkMsg data={extra_data || tryParseJson(body)} />;
    case "gif":
      return <ImageMsg data={extra_data || tryParseJson(body)} />;
    case "reaction":
      return <ReactionMsg data={extra_data || tryParseJson(body)} />;
    default:
      return <TextMsg content={body} onDark={onDark} />;
  }
}

// Per-bubble error boundary. Fallback shows the raw body as plain text so the
// operator still reads the content, instead of a throw unmounting the whole list.
type MessageErrorBoundaryProps = { body: string; children: ReactNode };
type MessageErrorBoundaryState = { hasError: boolean };

class MessageErrorBoundary extends Component<MessageErrorBoundaryProps, MessageErrorBoundaryState> {
  override state: MessageErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): MessageErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("MessageRenderer failed — falling back to plain text", {
      error,
      info: info.componentStack,
    });
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="text-[13px] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground italic">
          {this.props.body?.trim() || "[Không hiển thị được nội dung tin nhắn]"}
        </div>
      );
    }
    return this.props.children;
  }
}

const KNOWN_TYPES = new Set(["image", "sticker", "file", "call", "link", "gif", "reaction", "system"]);

function detectType(msg: MessageContent): MsgType {
  // Check explicit content_type first
  if (msg.content_type && KNOWN_TYPES.has(msg.content_type)) {
    return msg.content_type as MsgType;
  }

  const c = msg.body || "";

  // Typing indicator
  if (c === "..." || c === "typing" || c === "[typing]") return "typing";

  // Not JSON — return text
  if (!c.startsWith("{")) return "text";

  // JSON content — detect by fields
  try {
    const parsed = JSON.parse(c);

    // System messages (hook events, etc.)
    if (parsed.type === "system" || parsed.subtype?.includes("hook") || parsed.hook_name) {
      return "system";
    }

    // Media types
    if (parsed.href && (parsed.href.includes("zdn.vn") || parsed.href.includes("photo"))) return "image";
    // Sticker: various formats including Zalo's id+catId format
    if (parsed.sticker || parsed.stickerUrl || parsed.spriteUrl ||
        (parsed.id && parsed.catId) || parsed.stickerId || parsed.type === "sticker") return "sticker";
    if (parsed.fileName || parsed.fileSize) return "file";
    if (parsed.callDuration !== undefined || parsed.callType) return "call";
    if (parsed.title && parsed.href) return "link";
    if (parsed.rType || parsed.react) return "reaction";

  } catch {
    // Not valid JSON
  }

  // Fallback: check string patterns
  if (c.includes('"type":"system"')) return "system";
  if (c.includes('"href"') && (c.includes("zdn.vn") || c.includes("photo"))) return "image";
  // Sticker patterns including Zalo's catId format
  if (c.includes('"sticker"') || c.includes('"stickerUrl"') || c.includes('"spriteUrl"') ||
      c.includes('"catId"') || c.includes('"stickerId"') || c.includes('"type":"sticker"')) return "sticker";
  if (c.includes('"fileName"') || c.includes('"fileSize"')) return "file";
  if (c.includes('"callDuration"') || c.includes('"callType"')) return "call";
  if (c.includes('"title"') && c.includes('"href"')) return "link";
  if (c.includes('"rType"') || c.includes('"react"')) return "reaction";

  return "text";
}

function tryParseJson(s: string): Record<string, unknown> {
  try { return JSON.parse(s); } catch { return {}; }
}

// ── System Message ──
function SystemMsg({ data, body }: { data: Record<string, unknown>; body: string }) {
  // Parse body if data is empty
  const parsed = Object.keys(data).length > 0 ? data : tryParseJson(body);

  const subtype = (parsed.subtype || parsed.type || "") as string;
  const hookName = (parsed.hook_name || parsed.name || "") as string;

  // Determine icon and style based on subtype
  const getSystemStyle = () => {
    if (subtype.includes("started") || subtype.includes("begin")) {
      return { icon: Clock, color: "text-blue-500", bg: "bg-blue-500/10" };
    }
    if (subtype.includes("completed") || subtype.includes("success")) {
      return { icon: CheckCircle, color: "text-emerald-500", bg: "bg-emerald-500/10" };
    }
    if (subtype.includes("error") || subtype.includes("failed")) {
      return { icon: AlertCircle, color: "text-red-500", bg: "bg-red-500/10" };
    }
    return { icon: Info, color: "text-muted-foreground", bg: "bg-muted/50" };
  };

  const { icon: Icon, color, bg } = getSystemStyle();

  // Format human-readable message
  const getMessage = () => {
    if (hookName) return `Hook: ${hookName}`;
    if (subtype.includes("hook_started")) return "Bắt đầu xử lý...";
    if (subtype.includes("hook_completed")) return "Hoàn thành xử lý";
    if (subtype.includes("agent_")) return "Agent đang xử lý...";
    if (parsed.message) return String(parsed.message);
    return "Thông báo hệ thống";
  };

  return (
    <div className={`
      inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-[12px]
      ${bg} ${color} max-w-full
    `}>
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{getMessage()}</span>
    </div>
  );
}

// ── Typing Indicator ──
function TypingIndicator() {
  return (
    <div className="inline-flex items-center gap-1 px-3 py-2 bg-muted/50 rounded-2xl">
      <span className="w-2 h-2 bg-muted-foreground/60 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
      <span className="w-2 h-2 bg-muted-foreground/60 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
      <span className="w-2 h-2 bg-muted-foreground/60 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
    </div>
  );
}

// ── Image ──
function ImageMsg({ data }: { data: Record<string, unknown> }) {
  const { openImage } = useImageLightbox();
  const src = (data?.href || data?.thumb || data?.url || "") as string;
  let params: Record<string, unknown> = {};
  if (typeof data?.params === "string") {
    try { params = JSON.parse(data.params as string); } catch {}
  }
  const fullSrc = (data?.hdUrl as string) || src;

  if (!src) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-[13px]">
        <Image className="h-5 w-5" />
        <span>Hình ảnh</span>
      </div>
    );
  }

  return (
    <div className="max-w-[300px]">
      <img
        src={src}
        alt="Hình ảnh"
        className="rounded-xl max-h-72 cursor-pointer hover:opacity-90 transition-opacity shadow-sm"
        loading="lazy"
        data-lightbox=""
        data-lightbox-src={fullSrc}
        onClick={() => openImage(fullSrc, "Hình ảnh")}
        onError={(e) => {
          const el = e.currentTarget;
          el.style.display = "none";
          el.parentElement?.insertAdjacentHTML(
            "beforeend",
            '<div class="flex items-center gap-2 text-muted-foreground text-[13px] py-2"><span class="text-lg">📷</span><span>Không thể tải hình ảnh</span></div>',
          );
        }}
      />
      {Boolean(params.width) && Boolean(params.height) && (
        <div className="text-[10px] text-muted-foreground mt-1">
          {String(params.width)} × {String(params.height)}
        </div>
      )}
    </div>
  );
}

// ── Sticker ──
// Zalo sticker CDN requires authenticated API call to get image URL.
// For known public patterns (stickerUrl field), render directly; otherwise show
// a nice placeholder with sticker metadata.
function StickerMsg({ data }: { data: Record<string, unknown> }) {
  // Priority 1: Direct URL from server (enriched stickerUrl, spriteUrl, etc.)
  const directUrl = (data?.stickerUrl || data?.spriteUrl || data?.stickerWebpUrl || data?.url || data?.thumb || "") as string;

  if (directUrl && typeof directUrl === "string" && directUrl.startsWith("http")) {
    return (
      <img
        src={directUrl}
        alt="Sticker"
        className="w-32 h-32 object-contain"
        loading="lazy"
        onError={(e) => {
          // On load failure, replace with metadata placeholder
          const el = e.currentTarget;
          const parent = el.parentElement;
          if (parent) {
            el.remove();
            const info = data?.id ? `Sticker #${data.id}` : "Sticker";
            parent.innerHTML = `
              <div class="inline-flex flex-col items-center gap-1.5 p-3 bg-gradient-to-br from-blue-500/10 to-purple-500/10 rounded-xl border border-border/30 min-w-[120px]">
                <div class="text-2xl">🎨</div>
                <div class="text-[11px] text-muted-foreground font-medium">${info}</div>
              </div>
            `;
          }
        }}
      />
    );
  }

  // Fallback: Nice placeholder with sticker metadata (Zalo id+catId case)
  const stickerId = data?.id || data?.stickerId || "";
  const catId = data?.catId || data?.cateId || "";
  const label = stickerId ? `Sticker #${stickerId}` : "Zalo Sticker";

  return (
    <div className="inline-flex flex-col items-center gap-2 p-4 bg-gradient-to-br from-blue-500/10 via-indigo-500/10 to-purple-500/10 rounded-2xl border border-border/40 min-w-[120px] max-w-[140px]">
      <Palette className="h-8 w-8 text-blue-500/70" />
      <div className="text-center">
        <div className="text-[12px] font-semibold text-foreground">{label}</div>
        {catId !== "" && (
          <div className="text-[10px] text-muted-foreground mt-0.5">Pack: {String(catId)}</div>
        )}
      </div>
    </div>
  );
}

// ── File ──
function FileMsg({ data }: { data: Record<string, unknown> }) {
  const name = (data?.fileName || data?.title || "Tệp đính kèm") as string;
  const size = data?.fileSize ? formatFileSize(data.fileSize as number) : "";
  const url = (data?.href || data?.url || "") as string;

  // Get file extension for icon
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const getFileIcon = () => {
    if (["pdf"].includes(ext)) return <File className="h-5 w-5 text-red-500" />;
    if (["doc", "docx"].includes(ext)) return <FileText className="h-5 w-5 text-blue-500" />;
    if (["xls", "xlsx"].includes(ext)) return <FileSpreadsheet className="h-5 w-5 text-emerald-500" />;
    if (["ppt", "pptx"].includes(ext)) return <Presentation className="h-5 w-5 text-orange-500" />;
    if (["zip", "rar", "7z"].includes(ext)) return <Archive className="h-5 w-5 text-amber-500" />;
    if (["mp3", "wav", "m4a"].includes(ext)) return <Music className="h-5 w-5 text-pink-500" />;
    if (["mp4", "mov", "avi"].includes(ext)) return <Video className="h-5 w-5 text-violet-500" />;
    return <Paperclip className="h-5 w-5 text-muted-foreground" />;
  };

  return (
    <div className="flex items-center gap-3 bg-muted/40 rounded-xl p-3 max-w-[280px] border border-border/30">
      <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center shrink-0">
        {getFileIcon()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium truncate">{name}</div>
        {size && <div className="text-[11px] text-muted-foreground">{size}</div>}
      </div>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 p-2 rounded-lg hover:bg-muted transition-colors"
          title="Tải xuống"
        >
          <Download className="w-4 h-4 text-primary" />
        </a>
      )}
    </div>
  );
}

// ── Call ──
function CallMsg({ data }: { data: Record<string, unknown> }) {
  const isIncoming = data?.callType === "incoming";
  const dur = data?.callDuration as number | undefined;
  const duration = dur
    ? `${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, "0")}`
    : "Không nghe máy";

  return (
    <div className={`
      flex items-center gap-2.5 px-3 py-2 rounded-xl text-[13px]
      ${dur ? "bg-emerald-500/10 text-emerald-600" : "bg-muted/50 text-muted-foreground"}
    `}>
      <Phone className={`w-4 h-4 ${isIncoming ? "rotate-[135deg]" : ""}`} />
      <span>{isIncoming ? "Cuộc gọi đến" : "Cuộc gọi đi"}</span>
      <span className="text-[12px] opacity-70">{duration}</span>
    </div>
  );
}

// ── Link Preview ──
// new URL() THROWS on empty / scheme-less / relative hrefs. An unguarded call in
// render crashes the whole message list → white screen. Parse defensively.
function safeHostname(href: string): string {
  try {
    return new URL(href).hostname;
  } catch {
    return href.replace(/^https?:\/\//i, "").split("/")[0] || href;
  }
}

function LinkMsg({ data }: { data: Record<string, unknown> }) {
  const title = (data?.title || "") as string;
  const desc = (data?.description || "") as string;
  const href = (data?.href || "") as string;
  const thumb = (data?.thumb || "") as string;

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="block max-w-[280px] border border-border/50 rounded-xl overflow-hidden hover:bg-muted/20 transition-colors"
    >
      {thumb && (
        <img src={thumb} alt="" className="w-full h-36 object-cover" loading="lazy" />
      )}
      <div className="p-3">
        {title && <div className="text-[13px] font-medium line-clamp-2">{title}</div>}
        {desc && <div className="text-[12px] text-muted-foreground line-clamp-2 mt-0.5">{desc}</div>}
        <div className="text-[11px] text-primary truncate mt-1.5 flex items-center gap-1">
          <Link2 className="h-3 w-3" />
          {safeHostname(href)}
        </div>
      </div>
    </a>
  );
}

// ── Reaction ──
function ReactionMsg({ data }: { data: Record<string, unknown> }) {
  const emoji = (data?.content || data?.react || "👍") as string;
  return <span className="text-3xl">{emoji}</span>;
}

// ── Text with markdown & emoji support ──
function TextMsg({ content, onDark }: { content: string; onDark?: boolean }) {
  let fixed = content;

  // Color variants keyed by bubble background. On a dark bubble (outbound zinc-800)
  // brand `text-primary` + `bg-muted/50` are too dark to read → switch to light tones.
  const linkCls = onDark
    ? "text-sky-300 underline underline-offset-2 hover:text-sky-200" // dark-surface-ok
    : "text-primary underline underline-offset-2 hover:opacity-80";
  const codeCls = onDark
    ? "bg-white/15 text-zinc-50 px-1 py-0.5 rounded text-[13px] font-mono"
    : "bg-muted/50 px-1 py-0.5 rounded text-[13px] font-mono";
  const moreCls = onDark
    ? "flex items-center gap-1 mt-1.5 text-[12px] text-zinc-300 hover:text-white transition-colors"
    : "flex items-center gap-1 mt-1.5 text-[12px] text-primary hover:text-primary/80 transition-colors";

  // Fix mojibake: replacement character U+FFFD (�)
  if (/\uFFFD/.test(fixed)) {
    try {
      const bytes = new TextEncoder().encode(fixed);
      fixed = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch {
      // keep original
    }
  }

  // Parse markdown into React nodes
  const renderMarkdown = (text: string): React.ReactNode[] => {
    const result: React.ReactNode[] = [];
    let keyCounter = 0;

    // Combined pattern: bold, italic, code, markdown links, URLs
    // Order matters: check bold (**) before italic (*) to avoid conflicts
    const combinedPattern = /(\*\*(.+?)\*\*)|(__(.+?)__)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))|(https?:\/\/[^\s<>"]+)|(\*([^*]+)\*)|(_([^_\s][^_]*[^_\s])_)/g;

    let lastIndex = 0;
    let match;

    while ((match = combinedPattern.exec(text)) !== null) {
      // Add text before match
      if (match.index > lastIndex) {
        result.push(<span key={keyCounter++}>{text.slice(lastIndex, match.index)}</span>);
      }

      if (match[1] || match[3]) {
        // Bold: **text** or __text__
        const boldText = match[2] || match[4];
        result.push(<strong key={keyCounter++} className="font-semibold">{boldText}</strong>);
      } else if (match[5]) {
        // Code: `code`
        result.push(
          <code key={keyCounter++} className={codeCls}>
            {match[6]}
          </code>
        );
      } else if (match[7]) {
        // Markdown link: [text](url)
        result.push(
          <a
            key={keyCounter++}
            href={match[9]}
            target="_blank"
            rel="noreferrer"
            className={linkCls}
          >
            {match[8]}
          </a>
        );
      } else if (match[10]) {
        // URL
        result.push(
          <a
            key={keyCounter++}
            href={match[10]}
            target="_blank"
            rel="noreferrer"
            className={linkCls}
          >
            {match[10]}
          </a>
        );
      } else if (match[11] || match[13]) {
        // Italic: *text* or _text_
        const italicText = match[12] || match[14];
        result.push(<em key={keyCounter++} className="italic">{italicText}</em>);
      }

      lastIndex = combinedPattern.lastIndex;
    }

    // Add remaining text
    if (lastIndex < text.length) {
      result.push(<span key={keyCounter++}>{text.slice(lastIndex)}</span>);
    }

    return result.length > 0 ? result : [<span key={0}>{text}</span>];
  };

  // Expand/collapse for long messages
  const [expanded, setExpanded] = useState(false);
  const lineCount = fixed.split("\n").length;
  const isLong = fixed.length > 300 || lineCount > 5;

  return (
    <div>
      <p className={`text-[14px] leading-relaxed whitespace-pre-wrap break-words ${
        !expanded && isLong ? "line-clamp-5" : ""
      }`}>
        {renderMarkdown(fixed)}
      </p>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className={moreCls}
        >
          {expanded ? (
            <>
              <ChevronUp className="h-3.5 w-3.5" />
              Thu gọn
            </>
          ) : (
            <>
              <ChevronDown className="h-3.5 w-3.5" />
              Xem thêm
            </>
          )}
        </button>
      )}
    </div>
  );
}

// Helper: Format file size
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
