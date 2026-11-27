// Phase 0: Customer Sidebar — right panel showing CRM mini profile
// Tags, stats, Gemral data, notes

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { X, ExternalLink, RefreshCw, ShoppingBag, Ticket, Pencil, Check, CalendarClock, History, Phone, Mail, MapPin, Search, Copy, ChevronDown, Tag, Plus, Loader2 } from "lucide-react";
import { TicketDetailPanel } from "./TicketDetailPanel";
import { type ChannelSession } from "@/api/channels";
import { crmApi } from "@/api/crm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SimpleModal } from "../../crm/components/SimpleModal";
import { CustomerNotes } from "../../crm/components/CustomerNotes";
import { getChannelVisual } from "./channelConfig";
import type { CommandCrmProfile } from "@/components/crm-messaging/command-center/types";
import { CommandCustomer360 } from "@/components/crm-messaging/command-center/CommandCustomer360";
import { mapCrm } from "@/components/crm-messaging/command-center/adapters";
import { useToast } from "@/context/ToastContext";
import { copyToClipboard } from "@/lib/clipboard";
import { fetchOk } from "@/lib/readJsonOrThrow";

import { useConfirm } from "@/components/ConfirmDialog";
const defaultTicketForm = { title: "", description: "", category: "general", priority: "medium", status: "open", assigned_to_agent: "" };

// SSOT enums (crm_customers) — khớp docs/design_and_architecture/CRM_AND_META_CAPI_SSOT.md
const STATUS_LABELS: Record<string, string> = {
  lead_moi: "Lead mới", quan_tam: "Quan tâm", can_follow_up: "Follow up",
  dang_tu_van: "Tư vấn", cho_thanh_toan: "Chờ TT", da_mua: "Đã mua",
  khach_vip: "VIP", khach_than_thiet: "Thân thiết", churned: "Churned", blacklist: "Blacklist",
};
const TEMP_LABELS: Record<string, string> = { cold: "Lạnh", warm: "Ấm", hot: "Nóng", on_fire: "Rất nóng" };
const tempLabel = (t?: string | null) => TEMP_LABELS[t || "cold"] || "Lạnh";

function timeAgo(d?: string): string {
  if (!d) return "—";
  const ms = Date.now() - new Date(d).getTime();
  if (ms < 3600000) return Math.round(ms / 60000) + " phút trước";
  if (ms < 86400000) return Math.round(ms / 3600000) + " giờ trước";
  return Math.round(ms / 86400000) + " ngày trước";
}

interface RecentOrder {
  id: string;
  order_number?: string;
  total?: number;
  currency?: string;
  status?: string;
  created_at: string;
}

interface RecentTicket {
  id: string;
  subject?: string;
  status?: string;
  priority?: string;
  created_at: string;
}

interface Props {
  conversation: ChannelSession;
  onClose: () => void;
}

// Ô liên hệ edit-inline (phone/email/địa chỉ) — bấm để sửa (autosave on blur/Enter) + nút copy nhanh.
function EditableField({
  icon: Icon, value, placeholder, type = "text", onSave,
}: {
  icon: typeof Phone;
  value?: string | null;
  placeholder: string;
  type?: string;
  onSave: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const current = value || "";
  const save = () => {
    const v = draft.trim();
    if (v !== current) onSave(v);
    setEditing(false);
  };
  const copy = () => {
    if (!current) return;
    void copyToClipboard(current).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div className="group/field flex items-center gap-2 text-xs">
      <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      {editing ? (
        <input
          autoFocus
          type={type}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
          className="flex-1 min-w-0 px-1.5 py-0.5 rounded border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
        />
      ) : (
        <>
          <button
            type="button"
            onClick={() => { setDraft(current); setEditing(true); }}
            className="group flex-1 min-w-0 flex items-center gap-1 text-left hover:text-primary"
            title="Bấm để sửa"
          >
            <span className={`truncate ${current ? "" : "text-muted-foreground italic"}`}>{current || placeholder}</span>
            <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60 shrink-0" />
          </button>
          {current && (
            <button
              type="button"
              onClick={copy}
              title="Sao chép"
              className="shrink-0 p-1 rounded hover:bg-muted opacity-0 group-hover/field:opacity-100 transition-opacity"
            >
              {copied ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
            </button>
          )}
        </>
      )}
    </div>
  );
}

// Ô custom field (metadata.custom_fields[label]=value): label cố định + value edit-inline + xoá.
function CustomFieldRow({
  label, value, onSave, onRemove,
}: {
  label: string; value: string; onSave: (v: string) => void; onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const save = () => { onSave(draft.trim()); setEditing(false); };
  return (
    <div className="group/cf flex items-center gap-2 text-xs">
      <Tag className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span className="text-muted-foreground shrink-0">{label}:</span>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
          className="flex-1 min-w-0 px-1.5 py-0.5 rounded border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
        />
      ) : (
        <button
          type="button"
          onClick={() => { setDraft(value); setEditing(true); }}
          className="flex-1 min-w-0 text-left truncate hover:text-primary"
          title="Bấm để sửa"
        >
          {value || <span className="italic text-muted-foreground">(trống)</span>}
        </button>
      )}
      <button
        type="button"
        onClick={onRemove}
        title="Xoá thông tin này"
        className="shrink-0 opacity-0 group-hover/cf:opacity-100 hover:text-destructive transition-opacity"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

// Nút "＋ Thêm thông tin" → mở 2 ô (tên field + giá trị) thêm custom field vào metadata.custom_fields.
function AddFieldInline({ onAdd }: { onAdd: (label: string, value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const submit = () => {
    const l = label.trim();
    if (l) onAdd(l, value.trim());
    setLabel(""); setValue(""); setOpen(false);
  };
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 text-[11px] text-primary hover:underline"
      >
        <Plus className="h-3 w-3" /> Thêm thông tin
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <input
        autoFocus
        placeholder="Tên (vd: Ngày sinh)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") setOpen(false); }}
        className="w-[42%] min-w-0 text-xs px-1.5 py-1 rounded border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
      />
      <input
        placeholder="Giá trị"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") setOpen(false); }}
        className="flex-1 min-w-0 text-xs px-1.5 py-1 rounded border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
      />
      <button onMouseDown={(e) => e.preventDefault()} onClick={submit} className="shrink-0 p-1 rounded hover:bg-muted" title="Thêm">
        <Check className="h-3.5 w-3.5 text-green-600" />
      </button>
    </div>
  );
}

// Tóm tắt AI — click để sửa inline (textarea) → lưu crm_customers.ai_summary.
// Exported: dùng chung với CustomerDetailPage (SSOT — trước đây page đó render <p> tĩnh
// riêng, drift khỏi component này — xem CustomerDetailPage.tsx tab Tổng quan + Memory).
export function EditableSummary({ value, onSave, pending }: { value: string; onSave: (v: string) => void; pending?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const save = () => { onSave(draft.trim()); setEditing(false); };
  if (editing) {
    return (
      <div className="space-y-1">
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); }}
          className="w-full text-xs rounded-md border bg-background p-2 min-h-[72px] focus:outline-none focus:ring-1 focus:ring-ring"
          placeholder="Nhập tóm tắt AI về khách…"
        />
        <div className="flex gap-1 justify-end">
          <button onClick={() => setEditing(false)} className="text-[11px] px-2 py-0.5 rounded hover:bg-muted">Huỷ</button>
          <button onMouseDown={(e) => e.preventDefault()} onClick={save} disabled={pending} className="text-[11px] px-2 py-0.5 rounded bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground disabled:opacity-50">Lưu</button>
        </div>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => { setDraft(value); setEditing(true); }}
      title="Bấm để sửa"
      className="group w-full text-left text-xs text-foreground/80 leading-relaxed bg-muted/30 rounded-md p-2 hover:bg-muted/50 flex items-start gap-1"
    >
      <span className={`flex-1 whitespace-pre-wrap break-words ${value ? "" : "italic text-muted-foreground"}`}>{value || "Thêm tóm tắt AI…"}</span>
      <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60 shrink-0 mt-0.5" />
    </button>
  );
}

// 1 card timeline "Hoạt động gần đây" — view (expand) / edit (title+content) / xoá inline.
function InteractionItem({
  it, expanded, onToggle, onSave, onDelete,
}: {
  it: any; expanded: boolean; onToggle: () => void;
  onSave: (patch: { title: string; content: string }) => void; onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const tone = it.type === "chat" ? "bg-blue-500" : it.type === "order" ? "bg-green-500"
    : it.type === "ticket" ? "bg-yellow-500" : "bg-primary";
  const hasMore = !!it.content || (it.title || "").length > 28;
  const startEdit = () => { setTitle(it.title || ""); setContent(it.content || ""); setEditing(true); };
  const save = () => { onSave({ title: title.trim(), content: content.trim() }); setEditing(false); };
  return (
    <div className="relative pl-5 group">
      <div className={`absolute left-0 top-1 w-2.5 h-2.5 rounded-full border-2 border-background transition-transform group-hover:scale-125 ${tone}`} />
      <div className="text-[9px] text-muted-foreground font-bold mb-0.5 tracking-wider uppercase flex items-center justify-between">
        <span>{timeAgo(it.created_at)}</span>
        {!editing && (
          <span className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button type="button" onClick={startEdit} title="Sửa"><Pencil className="h-3 w-3 hover:text-primary" /></button>
            <button type="button" onClick={onDelete} title="Xoá"><X className="h-3 w-3 hover:text-destructive" /></button>
          </span>
        )}
      </div>
      {editing ? (
        <div className="space-y-1 rounded-lg p-2 border border-border bg-muted/40">
          <input
            autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Tiêu đề"
            className="w-full text-xs font-semibold px-1.5 py-1 rounded border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <textarea
            value={content} onChange={(e) => setContent(e.target.value)} placeholder="Nội dung"
            className="w-full text-[11px] px-1.5 py-1 rounded border bg-background min-h-[54px] focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <div className="flex gap-1 justify-end">
            <button onClick={() => setEditing(false)} className="text-[11px] px-2 py-0.5 rounded hover:bg-muted">Huỷ</button>
            <button onMouseDown={(e) => e.preventDefault()} onClick={save} className="text-[11px] px-2 py-0.5 rounded bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground">Lưu</button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => hasMore && onToggle()}
          className={`w-full text-left rounded-lg p-2 border border-border bg-muted/40 hover:bg-muted/70 transition-colors ${hasMore ? "cursor-pointer" : "cursor-default"}`}
        >
          <div className="flex items-start gap-1">
            <p className={`text-xs font-semibold flex-1 ${expanded ? "whitespace-pre-wrap break-words" : "truncate"}`}>{it.title || it.type}</p>
            {hasMore && <ChevronDown className={`h-3 w-3 mt-0.5 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} />}
          </div>
          {it.content && (
            <p className={`text-[11px] text-muted-foreground ${expanded ? "whitespace-pre-wrap break-words mt-1" : "line-clamp-2"}`}>{it.content}</p>
          )}
        </button>
      )}
    </div>
  );
}

export function CustomerSidebar({ conversation: conv, onClose }: Props) {
  const confirm = useConfirm();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const customer = conv.customer;
  const channelCfg = getChannelVisual(conv.channel_name);
  const displayName = customer?.display_name || conv.sender_name || "Không rõ";
  // "Xem hồ sơ đầy đủ" + tag/quote (subsystem riêng) mới mở trang CRM full;
  // name/status/temperature/note đều sửa INLINE tại panel này.
  const goProfile = () => {
    if (customer?.id) navigate(`/crm/customers/${customer.id}?from=${encodeURIComponent(window.location.pathname)}`);
  };

  // ── Inline edit + autosave (PUT /customers/:id qua crmApi — không duplicate route) ──
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const updateMutation = useMutation({
    mutationFn: (patch: Record<string, any>) =>
      customer?.id ? crmApi.updateCustomer(customer.id, patch) : Promise.resolve(null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      if (customer?.id) queryClient.invalidateQueries({ queryKey: ["crm", "customer", customer.id] });
    },
  });
  const saveName = () => {
    const v = nameDraft.trim();
    if (v && v !== customer?.display_name) updateMutation.mutate({ display_name: v });
    setEditingName(false);
  };

  // ── Full CRM record (parity với trang detail: tags có id, lead_temperature_manual,
  //    stats, metadata, email_status...) — fetch riêng, KHÔNG phình payload conversations ──
  const { data: full } = useQuery({
    queryKey: ["crm", "customer", customer?.id],
    queryFn: () => crmApi.getCustomer(customer!.id),
    enabled: !!customer?.id,
  });
  const f = full || (customer as any) || {};

  // Tags (crm_tags) + segments (read-only) — như trang detail
  const { data: allTags = [] } = useQuery({ queryKey: ["crm", "tags"], queryFn: () => crmApi.getTags() });
  const { data: segments = [] } = useQuery({
    queryKey: ["crm", "customer-segments", customer?.id],
    queryFn: () => crmApi.getCustomerSegments(customer!.id),
    enabled: !!customer?.id,
  });
  const addTagMut = useMutation({
    mutationFn: (tagId: string) => crmApi.addTag(customer!.id, tagId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["crm", "customer", customer?.id] }),
  });
  const removeTagMut = useMutation({
    mutationFn: (tagId: string) => crmApi.removeTag(customer!.id, tagId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["crm", "customer", customer?.id] }),
  });
  // Tạo tag mới inline (ngoài preset) → dedup BE theo name → auto-gán cho khách.
  const [creatingTag, setCreatingTag] = useState(false);
  const [newTag, setNewTag] = useState("");
  const createTagMut = useMutation({
    mutationFn: (name: string) => crmApi.createTag(name),
    onSuccess: (tag: any) => {
      setCreatingTag(false);
      setNewTag("");
      queryClient.invalidateQueries({ queryKey: ["crm", "tags"] });
      if (tag?.id && customer?.id) addTagMut.mutate(tag.id);
    },
  });
  const submitNewTag = () => {
    const n = newTag.trim();
    if (n) createTagMut.mutate(n);
  };
  const fmtVND = (n: any) => (n && Number(n) > 0 ? `${Number(n).toLocaleString("vi-VN")}₫` : "0₫");

  // ── Hoạt động gần đây (crm_interactions) CRUD inline ──
  const invalidateCust = () => queryClient.invalidateQueries({ queryKey: ["crm", "customer", customer?.id] });
  const updateInteractionMut = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { title: string; content: string } }) => crmApi.updateInteraction(id, patch),
    onSettled: invalidateCust,
  });
  const deleteInteractionMut = useMutation({
    mutationFn: (id: string) => crmApi.deleteInteraction(id),
    onSettled: invalidateCust,
  });
  const addInteractionMut = useMutation({
    mutationFn: (data: { title: string; content: string }) => crmApi.addInteraction(customer!.id, data),
    onSettled: invalidateCust,
  });
  const [addingAct, setAddingAct] = useState(false);
  const [actTitle, setActTitle] = useState("");
  const [actContent, setActContent] = useState("");
  const submitNewAct = () => {
    const t = actTitle.trim();
    if (!t && !actContent.trim()) return;
    addInteractionMut.mutate({ title: t, content: actContent.trim() });
    setActTitle(""); setActContent(""); setAddingAct(false);
  };

  // ── Phiếu HT: ticket modal (move từ ChatHeader vào card) ──
  const [showTicketModal, setShowTicketModal] = useState(false);
  const [ticketForm, setTicketForm] = useState(defaultTicketForm);
  // ── Ticket detail overlay: click "Yêu cầu gần đây" → fetch full ticket → shared panel ──
  const [detailTicket, setDetailTicket] = useState<any>(null);
  const [loadingTicketId, setLoadingTicketId] = useState<string | null>(null);
  const openTicketDetail = async (t: RecentTicket) => {
    setLoadingTicketId(t.id);
    try {
      const full = await crmApi.getTicket(t.id);
      setDetailTicket(full || { ...t, title: t.subject });
    } catch {
      // Degraded fallback — still show the minimal fields we already have.
      setDetailTicket({ ...t, title: t.subject });
    } finally {
      setLoadingTicketId(null);
    }
  };
  const { data: agentList = [] } = useQuery({
    queryKey: ["agents-list"],
    queryFn: async () => {
      const res = await fetch("/api/channels/agent-configs");
      if (!res.ok) return [];
      return (await res.json()).map((a: any) => ({ slug: a.slug, name: a.display_name || a.slug }));
    },
    staleTime: 60_000,
    enabled: showTicketModal,
  });
  const createTicketMut = useMutation({
    mutationFn: (d: any) => crmApi.createTicket({ ...d, customer_id: customer?.id }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["crm"] });
      queryClient.invalidateQueries({ queryKey: ["customer-tickets", customer?.id] });
      setShowTicketModal(false);
      setTicketForm(defaultTicketForm);
    },
  });

  // Sync Gemral data
  const syncMutation = useMutation({
    mutationFn: () =>
      customer?.id
        ? fetchOk(`/api/channels/crm/customers/${customer.id}/sync-gemral`, { method: "POST" }, "Lỗi đồng bộ Gemral").then((r) => r.json())
        : Promise.resolve(null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      // Panel Gemral/khối đọc từ full record → phải refetch để hiện data vừa sync.
      if (customer?.id) queryClient.invalidateQueries({ queryKey: ["crm", "customer", customer.id] });
    },
    onError: (e: any) => pushToast({ title: e.message, tone: "error" }),
  });

  // ── Tra & liên kết user từ DB theo phone/email (link Gemral + sync) ──
  const [lookupVal, setLookupVal] = useState("");
  const lookupMut = useMutation({
    mutationFn: async (): Promise<{ ok: boolean; msg: string }> => {
      const v = lookupVal.trim();
      if (!v || !customer?.id) return { ok: false, msg: "Nhập SĐT hoặc email" };
      const isEmail = v.includes("@");
      // 1) Tìm crm_customer KHÁC đã có sẵn theo phone/email (vd record người mua đã có đơn —
      //    dedup split: lead Zalo không email vs record Shopify có email).
      const sres = await fetch(`/api/channels/crm/customers?search=${encodeURIComponent(v)}&limit=8`);
      const sdata = sres.ok ? await sres.json().catch(() => null) : null;
      const list: any[] = Array.isArray(sdata) ? sdata : (sdata?.customers ?? sdata?.data ?? []);
      const match = list.find((c) => c.id !== customer.id && (
        isEmail
          ? [c.email, c.shopify_customer_email].some((e: string) => e && e.toLowerCase() === v.toLowerCase())
          : c.phone === v
      ));
      if (match) {
        // 2a) GỘP record hiện tại (lead) vào record có sẵn (người mua) — di chuyển interactions/
        //     notes/tags/đơn + relink hội thoại + backfill field trống (KHÔNG mất timeline như re-link trơ;
        //     KHÔNG ghi email gây đụng unique-constraint).
        try {
          const r = await fetchOk(`/api/channels/conversations/${conv.session_key}/merge-customer`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ customer_id: match.id }),
          }, "Máy chủ từ chối");
          const jr = await r.json().catch(() => null);
          return !jr?.error
            ? { ok: true, msg: `Đã gộp sang khách "${match.display_name || v}" (giữ đủ lịch sử + đơn)` }
            : { ok: false, msg: `Lỗi gộp: ${jr.error}` };
        } catch (e) {
          return { ok: false, msg: `Lỗi gộp: ${e instanceof Error ? e.message : String(e)}` };
        }
      }
      // 2b) Không có record khác → lưu vào record hiện tại + link Gemral + sync.
      try {
        await fetchOk(`/api/channels/crm/customers/${customer.id}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(isEmail ? { email: v } : { phone: v }),
        }, "Máy chủ từ chối");
      } catch (e) {
        return { ok: false, msg: `Không lưu được: ${e instanceof Error ? e.message : String(e)}` };
      }
      await fetchOk(`/api/channels/crm/customers/${customer.id}/link-gemral`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isEmail ? { email: v } : { phone: v }),
      }, "Không liên kết được tài khoản Gemral").catch(() => {});
      await fetchOk(`/api/channels/crm/customers/${customer.id}/sync-gemral`, { method: "POST" }, "Lỗi đồng bộ Gemral").catch(() => {});
      return { ok: true, msg: "Đã lưu liên hệ & đồng bộ Gemral ✓" };
    },
    onSuccess: () => {
      setLookupVal("");
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      if (customer?.id) queryClient.invalidateQueries({ queryKey: ["crm", "customer", customer.id] });
    },
  });

  // ── Timeline "Hoạt động gần đây": toggle expand từng card để đọc full nội dung ──
  const [expandedActs, setExpandedActs] = useState<Set<string>>(new Set());
  const toggleAct = (id: string) =>
    setExpandedActs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // ── Search & gán CRM customer cho hội thoại CHƯA link khách ──
  const [custSearch, setCustSearch] = useState("");
  const { data: custResults = [] } = useQuery({
    queryKey: ["crm", "customer-search", custSearch],
    queryFn: async () => {
      const res = await fetch(`/api/channels/crm/customers?search=${encodeURIComponent(custSearch.trim())}&limit=8`);
      if (!res.ok) return [];
      const d = await res.json();
      return Array.isArray(d) ? d : (d?.customers ?? d?.data ?? []);
    },
    enabled: !customer && custSearch.trim().length >= 2,
    staleTime: 10_000,
  });
  const linkCustomerMut = useMutation({
    mutationFn: (customerId: string) =>
      fetchOk(`/api/channels/conversations/${conv.session_key}/link-customer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer_id: customerId }),
      }, "Lỗi liên kết khách hàng").then((r) => r.json()),
    onSuccess: () => {
      setCustSearch("");
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (e: any) => pushToast({ title: e.message, tone: "error" }),
  });

  // Đọc từ full record (getCustomer) — list /conversations KHÔNG select gemral_data → customer.gemral_data luôn undefined.
  const gemral = (f.gemral_data ?? customer?.gemral_data) as Record<string, any> | null | undefined;

  // Recent orders/tickets (last 3) — dùng THẲNG orders/tickets từ getCustomer (f).
  // (Endpoint /customers/:id/orders + /tickets KHÔNG tồn tại → fetch cũ luôn 404 → []).
  const recentOrders: RecentOrder[] = ((f.orders as RecentOrder[]) || []).slice(0, 3);
  const recentTickets: RecentTicket[] = ((f.tickets as RecentTicket[]) || []).slice(0, 3);

  return (
    <div className="p-3 space-y-4">
      {/* Header: avatar + name + close */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div
            className="w-9 h-9 rounded-full shrink-0 flex items-center justify-center text-sm font-medium text-white"
            style={{ backgroundColor: channelCfg.color }}
          >
            {displayName.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            {editingName ? (
              <div className="flex items-center gap-1">
                <input
                  autoFocus
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={saveName}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveName();
                    if (e.key === "Escape") setEditingName(false);
                  }}
                  className="w-full text-sm font-semibold px-1.5 py-0.5 rounded border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <button onMouseDown={(e) => e.preventDefault()} onClick={saveName} className="p-1 rounded hover:bg-muted shrink-0" title="Lưu">
                  <Check className="h-3.5 w-3.5 text-green-600" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => { setNameDraft(customer?.display_name || displayName); setEditingName(true); }}
                disabled={!customer?.id}
                className="group flex items-center gap-1 text-sm font-semibold truncate hover:text-primary disabled:cursor-default disabled:hover:text-foreground"
                title={customer?.id ? "Bấm để sửa tên" : undefined}
              >
                <span className="truncate">{displayName}</span>
                {customer?.id && <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60 shrink-0" />}
              </button>
            )}
            {customer?.status && (
              <div className="text-[11px] text-muted-foreground">{STATUS_LABELS[customer.status] || customer.status}</div>
            )}
          </div>
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-muted shrink-0">
          <X className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>

      {/* ── Liên hệ + Stats lên ĐẦU (data chính: copy nhanh phone/email/địa chỉ + đơn/doanh thu) ── */}
      {customer?.id && (
        <div className="space-y-2">
          <label className="text-[11px] text-muted-foreground font-medium">Liên hệ</label>
          <EditableField icon={Phone} type="tel" value={f.phone ?? customer.phone} placeholder="Thêm số điện thoại…" onSave={(v) => updateMutation.mutate({ phone: v || null })} />
          <EditableField icon={Mail} type="email" value={f.email ?? customer.email} placeholder="Thêm email…" onSave={(v) => updateMutation.mutate({ email: v || null })} />
          <EditableField icon={MapPin} value={(f.metadata as any)?.address} placeholder="Thêm địa chỉ…" onSave={(v) => updateMutation.mutate({ metadata: { address: v || null } })} />
          {/* Custom fields (metadata.custom_fields) — thêm thông tin tuỳ ý ngoài phone/email/địa chỉ.
              PUT merge metadata nông → gửi CẢ object custom_fields mỗi lần (đọc hiện tại + sửa + gửi trọn). */}
          {Object.entries(((f.metadata as any)?.custom_fields as Record<string, any>) || {}).map(([k, v]) => (
            <CustomFieldRow
              key={k}
              label={k}
              value={v == null ? "" : String(v)}
              onSave={(nv) => {
                const cur = { ...(((f.metadata as any)?.custom_fields as Record<string, any>) || {}) };
                cur[k] = nv;
                updateMutation.mutate({ metadata: { custom_fields: cur } });
              }}
              onRemove={() => {
                const cur = { ...(((f.metadata as any)?.custom_fields as Record<string, any>) || {}) };
                delete cur[k];
                updateMutation.mutate({ metadata: { custom_fields: cur } });
              }}
            />
          ))}
          <AddFieldInline
            onAdd={(fieldLabel, fieldValue) => {
              const cur = { ...(((f.metadata as any)?.custom_fields as Record<string, any>) || {}) };
              cur[fieldLabel] = fieldValue;
              updateMutation.mutate({ metadata: { custom_fields: cur } });
            }}
          />
          {(() => {
            const o = recentOrders[0] as any;
            const addr = o?.shipping_address
              ? [o.shipping_address, o.shipping_ward, o.shipping_district, o.shipping_province].filter(Boolean).join(", ")
              : null;
            return addr ? (
              <div className="flex items-start gap-2 text-[11px] text-muted-foreground" title="Địa chỉ giao hàng từ đơn gần nhất (Shopify)">
                <MapPin className="h-3 w-3 shrink-0 mt-0.5" />
                <span>Từ đơn: {addr}</span>
              </div>
            ) : null;
          })()}
          <div className="flex items-center gap-1.5 pt-1">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                value={lookupVal}
                onChange={(e) => setLookupVal(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && lookupVal.trim()) lookupMut.mutate(); }}
                placeholder="SĐT / email tra DB…"
                className="w-full text-xs pl-7 pr-2 py-1.5 rounded border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <button
              onClick={() => lookupMut.mutate()}
              disabled={!lookupVal.trim() || lookupMut.isPending}
              className="shrink-0 text-xs px-2 py-1.5 rounded border bg-primary/10 text-primary font-medium hover:bg-primary hover:text-primary-foreground disabled:opacity-50 transition-colors"
            >
              {lookupMut.isPending ? "Đang tra…" : "Tra & liên kết"}
            </button>
          </div>
          {lookupMut.data != null && (
            <div className={`text-[11px] ${lookupMut.data.ok ? "text-green-600" : "text-destructive"}`}>
              {lookupMut.data.msg}
            </div>
          )}
          <div className="grid grid-cols-2 gap-2 text-center text-xs pt-1">
            <div className="rounded-md bg-muted/30 p-2">
              <div className="font-bold text-base">{f.total_orders ?? 0}</div>
              <div className="text-muted-foreground">Đơn hàng</div>
            </div>
            <div className="rounded-md bg-muted/30 p-2">
              <div className="font-bold text-base">{fmtVND(f.total_revenue)}</div>
              <div className="text-muted-foreground">Doanh thu</div>
            </div>
          </div>
        </div>
      )}

      {/* ── Bộ control (nén gọn): Trạng thái + Nhiệt độ 2 cột, Follow-up, Tags, Segment ── */}
      {customer?.id && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            {/* Trạng thái */}
            <div>
              <label className="text-[11px] text-muted-foreground font-medium">Trạng thái</label>
              <select
                value={f.status || customer.status || "lead_moi"}
                onChange={(e) => updateMutation.mutate({ status: e.target.value })}
                disabled={updateMutation.isPending}
                className="w-full mt-0.5 text-xs px-2 py-1.5 rounded border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              >
                {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>

            {/* Nhiệt độ lead — override tay (lead_temperature_manual); __auto__ = về auto */}
            <div>
              <label className="text-[11px] text-muted-foreground font-medium truncate block" title={f.lead_temperature_manual ? "Đặt tay" : `Tự động (${f.lead_score ?? customer.lead_score ?? 0}đ)`}>
                Nhiệt độ {f.lead_temperature_manual ? "· tay" : `· auto`}
              </label>
              <select
                value={f.lead_temperature_manual || "__auto__"}
                onChange={(e) => updateMutation.mutate({ lead_temperature_manual: e.target.value === "__auto__" ? null : e.target.value })}
                className="w-full mt-0.5 text-xs px-2 py-1.5 rounded border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="__auto__">Tự động ({tempLabel(f.lead_temperature || customer.lead_temperature)})</option>
                {Object.entries(TEMP_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          </div>

          {/* Giới tính — structured metadata.gender (SSOT: KHÔNG cột mirror).
              → identity header "giới_tính=…" (buildIdentityHeader) → agy gender-aware xưng hô. */}
          <div>
            <label className="text-[11px] text-muted-foreground font-medium">Giới tính</label>
            <select
              value={(f.metadata as any)?.gender || ""}
              onChange={(e) => updateMutation.mutate({ metadata: { gender: e.target.value || null } })}
              disabled={updateMutation.isPending}
              className="w-full mt-0.5 text-xs px-2 py-1.5 rounded border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">Chưa rõ</option>
              <option value="nam">Nam</option>
              <option value="nu">Nữ</option>
            </select>
          </div>

          {/* Hẹn follow-up */}
          <div>
            <label className="text-[11px] text-muted-foreground font-medium flex items-center gap-1">
              <CalendarClock className="h-3 w-3" /> Hẹn follow-up
            </label>
            <input
              type="date"
              value={f.next_follow_up_at ? String(f.next_follow_up_at).slice(0, 10) : ""}
              onChange={(e) => updateMutation.mutate({ next_follow_up_at: e.target.value ? new Date(e.target.value).toISOString() : null })}
              className="w-full mt-0.5 text-xs px-2 py-1.5 rounded border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          {/* Phân loại (Tags) — add/remove inline */}
          <div>
            <label className="text-[11px] text-muted-foreground font-medium">Phân loại (Tags)</label>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {((f.tags as any[]) || []).map((t: any) => (
                <span key={t.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border bg-muted/40">
                  {t.name}
                  <button onClick={() => removeTagMut.mutate(t.id)} className="hover:text-destructive" title="Gỡ tag"><X className="h-3 w-3" /></button>
                </span>
              ))}
              {((f.tags as any[]) || []).length === 0 && <span className="text-[11px] text-muted-foreground">Chưa có tag</span>}
            </div>
            {creatingTag ? (
              <div className="flex items-center gap-1 mt-1">
                <input
                  autoFocus
                  value={newTag}
                  onChange={(e) => setNewTag(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") submitNewTag(); if (e.key === "Escape") { setCreatingTag(false); setNewTag(""); } }}
                  placeholder="Tên tag mới…"
                  className="flex-1 min-w-0 text-xs px-2 py-1.5 rounded border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <button onMouseDown={(e) => e.preventDefault()} onClick={submitNewTag} disabled={!newTag.trim() || createTagMut.isPending} className="shrink-0 p-1.5 rounded hover:bg-muted disabled:opacity-50" title="Tạo & gán tag">
                  <Check className="h-3.5 w-3.5 text-green-600" />
                </button>
                <button onClick={() => { setCreatingTag(false); setNewTag(""); }} className="shrink-0 p-1.5 rounded hover:bg-muted" title="Huỷ">
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              </div>
            ) : (
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value === "__new__") setCreatingTag(true);
                  else if (e.target.value) addTagMut.mutate(e.target.value);
                }}
                disabled={addTagMut.isPending}
                className="w-full mt-1 text-xs px-2 py-1.5 rounded border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="">+ Thêm tag...</option>
                {(allTags as any[])
                  .filter((t: any) => !((f.tags as any[]) || []).some((ct: any) => ct.id === t.id))
                  .map((t: any) => <option key={t.id} value={t.id}>{t.category ? `[${t.category}] ` : ""}{t.name}</option>)}
                <option value="__new__">➕ Tạo tag mới…</option>
              </select>
            )}
          </div>

          {/* Segment (read-only — audience động theo rule) */}
          {segments.length > 0 && (
            <div>
              <label className="text-[11px] text-muted-foreground font-medium" title="Nhóm động tự gom theo điều kiện — không gán tay">Segment (tự động)</label>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {segments.map((s) => (
                  <span key={s.id} className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border border-dashed bg-primary/5 text-primary">{s.name}</span>
                ))}
              </div>
            </div>
          )}

          {/* Newsletter (read-only — quản lý ở Resend) */}
          {f.email_status && customer.email && (
            <div className="flex items-center gap-2 text-[11px]" title="Newsletter quản lý ở Resend (suppression list), không sửa tại đây.">
              <span className="text-muted-foreground">Newsletter:</span>
              <span className={`px-1.5 py-0.5 rounded ${f.email_status === "active" ? "bg-green-500/10 text-green-600" : "bg-muted text-muted-foreground"}`}>
                {f.email_status === "active" ? "Đang nhận" : f.email_status === "unsubscribed" ? "Đã huỷ" : f.email_status}
              </span>
              <span className="text-muted-foreground/60">· qua Resend</span>
            </div>
          )}
        </div>
      )}

      {/* Rich Customer 360 card — LTV + journey + quick actions (Gọi · Phiếu HT).
          phone/email/tags ẩn ở đây (đã có khối Liên hệ + tag editable phía trên — tránh trùng surface). */}
      {customer && (
        <CommandCustomer360
          hideTitle
          hideLtv
          crm={{
            ...mapCrm(conv),
            phone: "",
            email: "",
            tags: [],
            quickActions: [
              ...(customer.phone ? [{ label: "Gọi Ngay", icon: "phone", tone: "success" as const }] : []),
              { label: "Phiếu HT", icon: "ticket", tone: "neutral" as const },
            ],
          } as CommandCrmProfile}
          onAddTag={goProfile}
          onCreateQuote={goProfile}
          onQuickAction={(a) => {
            if (a.icon === "phone" && customer.phone) window.location.href = `tel:${customer.phone}`;
            else if (a.icon === "ticket") { setTicketForm(defaultTicketForm); setShowTicketModal(true); }
          }}
        />
      )}

      {/* Gemral Data */}
      {gemral && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] text-muted-foreground font-medium">Gemral</span>
            <button
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
              className="p-0.5 rounded hover:bg-muted"
              title="Đồng bộ lại"
            >
              <RefreshCw className={`h-3 w-3 text-muted-foreground ${syncMutation.isPending ? "animate-spin" : ""}`} />
            </button>
          </div>
          <div className="space-y-1 text-xs">
            {(() => {
              // Shape canonical gemral_data (gemral-bridge.ts): course_tier/chatbot_tier/total_courses/affiliate_tier
              // — KHÔNG phải tier/enrollments/ctv_tier (không tồn tại → khối trống dù đã sync).
              const courseTier = String(gemral.course_tier || gemral.chatbot_tier || "").toUpperCase();
              return courseTier && courseTier !== "FREE" ? (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Gói</span>
                  <span className="font-medium uppercase">{courseTier}</span>
                </div>
              ) : null;
            })()}
            {gemral.scanner_tier && String(gemral.scanner_tier).toUpperCase() !== "FREE" && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Scanner</span>
                <span className="uppercase">{gemral.scanner_tier}</span>
              </div>
            )}
            {Number(gemral.total_courses) > 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Khóa học</span>
                <span>{gemral.total_courses} đăng ký</span>
              </div>
            )}
            {Number(gemral.shopify_orders_count) > 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Đã mua (Shopify)</span>
                <span>{gemral.shopify_orders_count} đơn</span>
              </div>
            )}
            {gemral.is_affiliate && gemral.affiliate_tier && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">CTV</span>
                <span className="capitalize">{gemral.affiliate_tier}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Recent Orders (last 3) */}
      {recentOrders.length > 0 && (
        <div>
          <div className="flex items-center gap-1 mb-1.5">
            <ShoppingBag className="h-3 w-3 text-muted-foreground" />
            <span className="text-[11px] text-muted-foreground font-medium">Đơn hàng gần đây</span>
          </div>
          <div className="space-y-1.5">
            {recentOrders.map((order) => (
              <div key={order.id} className="flex items-center justify-between text-xs bg-muted/20 rounded-md px-2 py-1.5">
                <div className="min-w-0">
                  <span className="font-medium">#{order.order_number || order.id.slice(0, 8)}</span>
                  <span className="text-muted-foreground ml-1.5">
                    {order.created_at ? new Date(order.created_at).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" }) : ""}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {order.total != null && (
                    <span className="font-medium">
                      {order.total.toLocaleString("vi-VN")}{order.currency === "VND" ? "đ" : ` ${order.currency || ""}`}
                    </span>
                  )}
                  {order.status && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                      order.status === "paid" || order.status === "fulfilled"
                        ? "bg-green-500/10 text-green-600"
                        : order.status === "pending"
                          ? "bg-amber-500/10 text-amber-600"
                          : "bg-muted/50 text-muted-foreground"
                    }`}>
                      {order.status === "paid" ? "Đã TT" : order.status === "fulfilled" ? "Hoàn thành" : order.status === "pending" ? "Chờ" : order.status}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Tickets (last 3) */}
      {recentTickets.length > 0 && (
        <div>
          <div className="flex items-center gap-1 mb-1.5">
            <Ticket className="h-3 w-3 text-muted-foreground" />
            <span className="text-[11px] text-muted-foreground font-medium">Yêu cầu gần đây</span>
          </div>
          <div className="space-y-1.5">
            {recentTickets.map((ticket) => (
              <button
                key={ticket.id}
                type="button"
                onClick={() => openTicketDetail(ticket)}
                disabled={loadingTicketId === ticket.id}
                title="Bấm để xem chi tiết phiếu"
                className="w-full text-left text-xs bg-muted/20 hover:bg-muted/40 focus:outline-none focus:ring-2 focus:ring-primary/30 rounded-md px-2 py-1.5 transition-colors cursor-pointer disabled:opacity-60"
              >
                <div className="flex items-center justify-between">
                  <span className="truncate font-medium flex-1 min-w-0 flex items-center gap-1">
                    {loadingTicketId === ticket.id && <Loader2 className="h-3 w-3 animate-spin shrink-0" />}
                    {ticket.subject || `Ticket #${ticket.id.slice(0, 8)}`}
                  </span>
                  {ticket.priority && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ml-1.5 ${
                      ticket.priority === "high" || ticket.priority === "urgent"
                        ? "bg-red-500/10 text-red-500"
                        : ticket.priority === "medium"
                          ? "bg-amber-500/10 text-amber-600"
                          : "bg-muted/50 text-muted-foreground"
                    }`}>
                      {ticket.priority === "urgent" ? "Gấp" : ticket.priority === "high" ? "Cao" : ticket.priority === "medium" ? "TB" : "Thấp"}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-0.5 text-muted-foreground">
                  <span>{ticket.status === "open" ? "Mở" : ticket.status === "closed" ? "Đóng" : ticket.status || "Mở"}</span>
                  <span>
                    {ticket.created_at ? new Date(ticket.created_at).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" }) : ""}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Tóm tắt AI — inline editable (crm_customers.ai_summary, whitelist BE sẵn) */}
      {customer?.id && (
        <div>
          <div className="text-[11px] text-muted-foreground font-medium mb-1">Tóm tắt AI</div>
          <EditableSummary
            value={String(f.ai_summary || customer?.ai_summary || "")}
            pending={updateMutation.isPending}
            onSave={(v) => updateMutation.mutate({ ai_summary: v || null })}
          />
        </div>
      )}

      {/* Hoạt động gần đây — timeline edit/xoá/thêm inline (crm_interactions). */}
      {customer?.id && (
        <div>
          <div className="text-[11px] text-muted-foreground font-medium mb-2 flex items-center justify-between">
            <span className="flex items-center gap-1.5"><History className="h-3.5 w-3.5" /> Hoạt động gần đây</span>
            {!addingAct && (
              <button onClick={() => setAddingAct(true)} className="flex items-center gap-0.5 text-[11px] text-primary hover:underline font-normal">
                <Plus className="h-3 w-3" /> Thêm
              </button>
            )}
          </div>
          {addingAct && (
            <div className="space-y-1 rounded-lg p-2 border border-border bg-muted/40 mb-2">
              <input autoFocus value={actTitle} onChange={(e) => setActTitle(e.target.value)} placeholder="Tiêu đề hoạt động"
                className="w-full text-xs font-semibold px-1.5 py-1 rounded border bg-background focus:outline-none focus:ring-1 focus:ring-ring" />
              <textarea value={actContent} onChange={(e) => setActContent(e.target.value)} placeholder="Nội dung (tuỳ chọn)"
                className="w-full text-[11px] px-1.5 py-1 rounded border bg-background min-h-[48px] focus:outline-none focus:ring-1 focus:ring-ring" />
              <div className="flex gap-1 justify-end">
                <button onClick={() => { setAddingAct(false); setActTitle(""); setActContent(""); }} className="text-[11px] px-2 py-0.5 rounded hover:bg-muted">Huỷ</button>
                <button onMouseDown={(e) => e.preventDefault()} onClick={submitNewAct} disabled={addInteractionMut.isPending} className="text-[11px] px-2 py-0.5 rounded bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground disabled:opacity-50">Thêm</button>
              </div>
            </div>
          )}
          {((f.interactions as any[]) || []).length > 0 ? (
            <div className="relative space-y-3 before:absolute before:inset-y-1.5 before:left-[5px] before:w-[2px] before:bg-border before:content-['']">
              {((f.interactions as any[]) || []).slice(0, 8).map((i: any) => (
                <InteractionItem
                  key={i.id}
                  it={i}
                  expanded={expandedActs.has(String(i.id))}
                  onToggle={() => toggleAct(String(i.id))}
                  onSave={(patch) => updateInteractionMut.mutate({ id: String(i.id), patch })}
                  onDelete={async () => { if (await confirm({ title: "Xoá hoạt động này?", confirmLabel: "Xoá", destructive: true })) deleteInteractionMut.mutate(String(i.id)); }}
                />
              ))}
            </div>
          ) : (
            !addingAct && <p className="text-[11px] text-muted-foreground italic">Chưa có hoạt động.</p>
          )}
        </div>
      )}

      {/* Ghi chú — CRUD đầy đủ (shared CustomerNotes: thêm/sửa inline/xoá/chọn nhiều) */}
      {customer?.id && (
        <CustomerNotes
          customerId={customer.id}
          notes={(f.notes as any[]) || []}
          onChanged={() => {
            queryClient.invalidateQueries({ queryKey: ["crm", "customer", customer.id] });
            queryClient.invalidateQueries({ queryKey: ["conversations"] });
          }}
        />
      )}

      {/* Link to full CRM profile */}
      {customer?.id && (
        <button
          onClick={goProfile}
          className="w-full flex items-center justify-center gap-1.5 text-xs text-primary hover:underline py-2"
        >
          Xem hồ sơ đầy đủ <ExternalLink className="h-3 w-3" />
        </button>
      )}

      {/* No customer linked — search & gán CRM customer có sẵn */}
      {!customer && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Hội thoại chưa gắn khách CRM. Tìm & liên kết:</p>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={custSearch}
              onChange={(e) => setCustSearch(e.target.value)}
              placeholder="Tìm tên / SĐT / email…"
              className="w-full text-xs pl-7 pr-2 py-1.5 rounded border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          {custSearch.trim().length >= 2 && (
            <div className="max-h-48 overflow-auto rounded border divide-y divide-border">
              {(custResults as any[]).length === 0 ? (
                <div className="px-2 py-2 text-[11px] text-muted-foreground">Không tìm thấy khách</div>
              ) : (
                (custResults as any[]).map((c: any) => (
                  <button
                    key={c.id}
                    onClick={() => linkCustomerMut.mutate(c.id)}
                    disabled={linkCustomerMut.isPending}
                    className="w-full text-left px-2 py-1.5 hover:bg-muted/50 disabled:opacity-50"
                  >
                    <div className="text-xs font-medium truncate">{c.display_name || c.phone || c.email || "Khách"}</div>
                    <div className="text-[11px] text-muted-foreground truncate">{[c.phone, c.email].filter(Boolean).join(" · ") || "—"}</div>
                  </button>
                ))
              )}
            </div>
          )}
          <p className="text-[10px] text-muted-foreground">Hoặc khách sẽ tự liên kết khi có thông tin CRM.</p>
        </div>
      )}

      {/* Ticket detail overlay (shared TicketDetailPanel) — read-only, no Sửa in inbox */}
      {detailTicket && (
        <TicketDetailPanel ticket={detailTicket} onClose={() => setDetailTicket(null)} />
      )}

      {/* Modal: Phiếu hỗ trợ (chuyển từ ChatHeader vào card — reuse SimpleModal) */}
      <SimpleModal open={showTicketModal} onClose={() => setShowTicketModal(false)} title="Tạo phiếu hỗ trợ mới" footer={<>
        <Button variant="outline" onClick={() => setShowTicketModal(false)}>Hủy</Button>
        <Button disabled={!ticketForm.title.trim() || createTicketMut.isPending} onClick={() => createTicketMut.mutate(ticketForm)}>
          {createTicketMut.isPending ? "Đang tạo..." : "Tạo phiếu"}
        </Button>
      </>}>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">Tiêu đề *</label>
            <Input value={ticketForm.title} onChange={(e) => setTicketForm((f) => ({ ...f, title: e.target.value }))} placeholder="Nhập tiêu đề..." />
          </div>
          <div>
            <label className="text-sm font-medium">Mô tả</label>
            <textarea value={ticketForm.description} onChange={(e) => setTicketForm((f) => ({ ...f, description: e.target.value }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[80px]" placeholder="Mô tả chi tiết..." />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium">Loại</label>
              <select value={ticketForm.category} onChange={(e) => setTicketForm((f) => ({ ...f, category: e.target.value }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                <option value="general">Chung</option>
                <option value="product_inquiry">Hỏi sản phẩm</option>
                <option value="order_issue">Vấn đề đơn hàng</option>
                <option value="payment_issue">Thanh toán</option>
                <option value="shipping_issue">Giao hàng</option>
                <option value="refund_request">Hoàn tiền</option>
                <option value="technical_support">Kỹ thuật</option>
                <option value="complaint">Khiếu nại</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium">Ưu tiên</label>
              <select value={ticketForm.priority} onChange={(e) => setTicketForm((f) => ({ ...f, priority: e.target.value }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                <option value="low">Thấp</option>
                <option value="medium">Trung bình</option>
                <option value="high">Cao</option>
                <option value="urgent">Khẩn cấp</option>
                <option value="critical">Nghiêm trọng</option>
              </select>
            </div>
          </div>
          <div>
            <label className="text-sm font-medium">Gán cho agent</label>
            <select value={ticketForm.assigned_to_agent} onChange={(e) => setTicketForm((f) => ({ ...f, assigned_to_agent: e.target.value }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
              <option value="">— Không gán —</option>
              {(agentList as Array<{ slug: string; name: string }>).map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}
            </select>
          </div>
        </div>
      </SimpleModal>
    </div>
  );
}
