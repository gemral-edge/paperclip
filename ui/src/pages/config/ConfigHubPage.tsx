// Config Hub — 4-tab central configuration (Kênh & Agents, API, Email, Hệ thống)
import { useState, useMemo, useCallback, useRef } from "react";
import { useNavigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Settings,
  Radio,
  Bot,
  Key,
  Mail,
  Shield,
  CheckCircle2,
  XCircle,
  Send,
  Loader2,
  Info,
  Lock,
  Trash2,
  Copy,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Download,
  Upload,
  Plus,
  Search,
  Save,
  TestTube2,
  ServerCog,
  Webhook,
  FileCode,
  Thermometer,
  SlidersHorizontal,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import { useToast } from "@/context/ToastContext";
import { copyToClipboard } from "@/lib/clipboard";
import { fetchOk } from "@/lib/readJsonOrThrow";
import { useGuardedAction } from "@/lib/useGuardedAction";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";

// ─── Tab definitions ────────────────────────────────────────────────────

const TABS = [
  { key: "channels", label: "Kênh & Agents", icon: Radio },
  { key: "api", label: "API & Tích hợp", icon: Key },
  { key: "email", label: "Email & Templates", icon: Mail },
  { key: "system", label: "Hệ thống", icon: Shield },
] as const;

type TabKey = (typeof TABS)[number]["key"];

// ─── MCP Tools constant ────────────────────────────────────────────────

const MCP_TOOLS = [
  { key: "create_order", label: "Tạo đơn hàng", description: "Tạo đơn hàng mới cho khách hàng trong CRM" },
  { key: "create_ticket", label: "Tạo phiếu hỗ trợ", description: "Tạo phiếu hỗ trợ / escalate vấn đề" },
  { key: "search_product", label: "Tìm sản phẩm", description: "Tìm sản phẩm trên Shopify theo từ khóa" },
  { key: "crm_update", label: "Cập nhật CRM", description: "Cập nhật thông tin khách hàng CRM" },
  { key: "send_email", label: "Gửi email", description: "Gửi email cho khách qua Resend" },
  { key: "get_customer_info", label: "Thông tin khách", description: "Lấy chi tiết khách hàng CRM + Gemral data" },
  { key: "check_course_access", label: "Kiểm tra khoá học", description: "Kiểm tra quyền truy cập khoá học" },
  { key: "link_gemral_account", label: "Liên kết tài khoản", description: "Liên kết chat với tài khoản Gemral App" },
  { key: "search_knowledge", label: "Tìm Knowledge", description: "Tìm thông tin trong Knowledge Base" },
] as const;

// ─── Email templates constant ───────────────────────────────────────────

const EMAIL_TEMPLATES = [
  // Onboarding
  { key: "welcome_ctv", label: "Chào mừng CTV mới", category: "Onboarding" },
  { key: "welcome_kol", label: "Chào mừng KOL", category: "Onboarding" },
  { key: "welcome_new_user", label: "Chào mừng người dùng mới", category: "Onboarding" },
  { key: "welcome_student", label: "Chào mừng học viên", category: "Onboarding" },
  { key: "new_user_day0_welcome", label: "Ngày 0 — Chào mừng", category: "Onboarding" },
  // Partnership
  { key: "application_rejected", label: "Từ chối đăng ký", category: "Partnership" },
  { key: "tier_upgrade", label: "Nâng hạng CTV", category: "Partnership" },
  { key: "tier_downgrade", label: "Hạ hạng CTV", category: "Partnership" },
  { key: "commission_summary", label: "Tổng kết hoa hồng", category: "Partnership" },
  { key: "ctv_training_kit", label: "Kit training CTV", category: "Partnership" },
  // Orders
  { key: "order_thank_you", label: "Cảm ơn đặt hàng", category: "Đơn hàng" },
  { key: "order_review_request", label: "Yêu cầu đánh giá", category: "Đơn hàng" },
  { key: "withdrawal_approved", label: "Duyệt rút tiền", category: "Đơn hàng" },
  { key: "withdrawal_rejected", label: "Từ chối rút tiền", category: "Đơn hàng" },
  // Marketing
  { key: "webinar_confirmation", label: "Xác nhận webinar", category: "Marketing" },
  { key: "student_day7_upsell", label: "Ngày 7 — Upsell học viên", category: "Marketing" },
] as const;

type EmailTemplateKey = (typeof EMAIL_TEMPLATES)[number]["key"];

// ─── Drip sequences ─────────────────────────────────────────────────────

const DRIP_SEQUENCES = [
  {
    key: "new_user",
    label: "New User Drip",
    description: "Người dùng mới đăng ký",
    trigger: "welcome_new_user",
    steps: [
      { day: 0, template: "new_user_day0_welcome", subject: "Chào mừng bạn đến GEM!" },
      { day: 3, template: "new_user_day3_features", subject: "Khám phá tính năng nổi bật" },
      { day: 7, template: "new_user_day7_proof", subject: "Câu chuyện thành công của học viên" },
      { day: 14, template: "new_user_day14_offer", subject: "Ưu đãi đặc biệt dành cho bạn" },
      { day: 30, template: "new_user_day30_reengagement", subject: "Bạn còn nhớ mục tiêu của mình không?" },
    ],
  },
  {
    key: "free_tier",
    label: "Free Tier Drip",
    description: "Người dùng free tier",
    trigger: "free_tier_day0_welcome",
    steps: [
      { day: 0, template: "free_tier_day0_welcome", subject: "Bắt đầu hành trình với GEM Free" },
      { day: 3, template: "free_tier_day3_features", subject: "Những gì bạn có thể làm miễn phí" },
      { day: 7, template: "free_tier_day7_proof", subject: "Kết quả thực tế từ cộng đồng GEM" },
      { day: 14, template: "free_tier_day14_offer", subject: "Nâng cấp lên GEM Pro — giảm 20%" },
      { day: 30, template: "free_tier_day30_reengagement", subject: "Cơ hội cuối cùng của tháng này" },
    ],
  },
  {
    key: "paid_buyer",
    label: "Paid Buyer Drip",
    description: "Khách đã mua khoá học",
    trigger: "paid_buyer_day0_welcome",
    steps: [
      { day: 0, template: "paid_buyer_day0_welcome", subject: "Cảm ơn bạn đã tin tưởng GEM!" },
      { day: 3, template: "paid_buyer_day3_features", subject: "Khai thác tối đa khoá học của bạn" },
      { day: 7, template: "paid_buyer_day7_proof", subject: "Học viên đã thành công như thế nào" },
      { day: 14, template: "paid_buyer_day14_upsell", subject: "Nâng cấp lên gói cao hơn" },
      { day: 30, template: "paid_buyer_day30_reengagement", subject: "Tiếp tục hành trình của bạn" },
    ],
  },
] as const;

// ─── Helpers ────────────────────────────────────────────────────────────

async function apiGet<T>(url: string, fallback: T): Promise<T> {
  try {
    const r = await fetch(url);
    if (!r.ok) return fallback;
    return r.json();
  } catch {
    return fallback;
  }
}

function StatusDot({ status }: { status: string }) {
  const map: Record<string, { color: string; label: string }> = {
    running: { color: "bg-green-500", label: "Đang chạy" },
    connected: { color: "bg-green-500", label: "Kết nối" },
    handled: { color: "bg-green-500", label: "Đã xử lý" },
    pending: { color: "bg-yellow-500", label: "Chờ" },
    processing: { color: "bg-blue-500", label: "Đang xử lý" },
    error: { color: "bg-red-500", label: "Lỗi" },
    failed: { color: "bg-red-500", label: "Lỗi" },
    skipped: { color: "bg-zinc-400", label: "Bỏ qua" },
    stopped: { color: "bg-zinc-400", label: "Dừng" },
    disconnected: { color: "bg-zinc-400", label: "Ngắt" },
  };
  const c = map[status] || { color: "bg-zinc-400", label: status };
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`w-1.5 h-1.5 rounded-full ${c.color}`} />
      <span className="text-[10px] text-muted-foreground">{c.label}</span>
    </span>
  );
}

/** Bản nháp khác giá trị server? So từng field theo chuỗi — sau Lưu + refetch hai bên bằng nhau thì hết dirty. */
function draftDiffersFromServer(draft: Record<string, any> | undefined, server: Record<string, any> | undefined): boolean {
  if (!draft) return false;
  return Object.entries(draft).some(([k, v]) => String(v ?? "") !== String(server?.[k] ?? ""));
}

function SectionHeader({ icon: Icon, title, right }: { icon: React.ComponentType<any>; title: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h3 className="font-semibold text-sm flex items-center gap-2">
        <Icon className="h-4 w-4" />
        {title}
      </h3>
      {right}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════

/**
 * @archetype form
 */
export function ConfigHubPage() {
  const [errors, setErrors] = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);


  const [activeTab, setActiveTab] = useState<TabKey>("channels");

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-bold flex items-center gap-2">
        <Settings className="h-6 w-6" /> Trung tâm Cấu hình
      </h1>

      <div className="flex border-b overflow-x-auto">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab.key
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab === "channels" && <ChannelsAgentsTab />}
      {activeTab === "api" && <APIIntegrationTab />}
      {activeTab === "email" && <EmailTemplatesTab />}
      {activeTab === "system" && <SystemTab />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// TAB 1: Kênh & Agents
// ═══════════════════════════════════════════════════════════════════════

function ChannelsAgentsTab() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const guard = useGuardedAction();

  // ── Section 1: Cài đặt chung ──
  const { data: config } = useQuery({
    queryKey: ["config-hub"],
    queryFn: () => apiGet<Record<string, any>>("/api/system/config", {}),
    staleTime: 60_000,
  });

  const defaults = useMemo(() => {
    if (!config?.channel_defaults) return {} as Record<string, number>;
    return typeof config.channel_defaults === "string"
      ? JSON.parse(config.channel_defaults)
      : config.channel_defaults;
  }, [config]);

  const saveSetting = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      await fetchOk("/api/system/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      }, "Lỗi lưu cấu hình");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["config-hub"] }),
    onError: (e: any) => pushToast({ title: "Lỗi lưu cấu hình", body: e.message, tone: "error" }),
  });

  const globalFields = [
    { label: "Debounce (giây)", key: "debounce_sec", fallback: 5 },
    { label: "Cooldown (giây)", key: "cooldown_sec", fallback: 8 },
    { label: "Quota / giờ", key: "quota_per_hour", fallback: 100 },
    { label: "Quota / ngày", key: "quota_per_day", fallback: 500 },
  ];

  // ── Section 2: Channels ──
  const { data: channels, isLoading: channelsLoading } = useQuery({
    queryKey: ["config-channels"],
    queryFn: () => apiGet<any[]>("/api/channels/instances", []),
    staleTime: 30_000,
  });

  const [expandedChannel, setExpandedChannel] = useState<string | null>(null);
  const [channelEdits, setChannelEdits] = useState<Record<string, any>>({});

  const saveChannel = useMutation({
    mutationFn: async ({ name, data }: { name: string; data: Record<string, any> }) => {
      await fetchOk(`/api/channels/settings/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }, "Lỗi lưu cấu hình kênh");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["config-channels"] });
    },
    onError: (e: any) => pushToast({ title: "Lỗi lưu cấu hình kênh", body: e.message, tone: "error" }),
  });

  const reconnectChannel = useMutation({
    mutationFn: async (name: string) => {
      await fetchOk(`/api/channels/zalo-personal/${name}/start`, { method: "POST" }, "Lỗi kết nối lại");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["config-channels"] }),
    onError: (e: any) => pushToast({ title: "Lỗi kết nối lại", body: e.message, tone: "error" }),
  });

  const toggleChannel = useMutation({
    mutationFn: async ({ name, enabled, channelType }: { name: string; enabled: boolean; channelType?: string }) => {
      // 1. Set enabled in DB
      await fetchOk(`/api/channels/settings/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      }, "Lỗi bật/tắt kênh");
      // 2. Actually stop/start WebSocket for Zalo channels
      if (channelType === "zalo_personal") {
        if (!enabled) {
          await fetchOk(`/api/channels/zalo-personal/${name}/stop`, { method: "POST" }).catch(() => {});
        } else {
          await fetchOk(`/api/channels/zalo-personal/${name}/start`, { method: "POST" }).catch(() => {});
        }
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["config-channels"] });
      qc.invalidateQueries({ queryKey: ["channels"] });
    },
    onError: (e: any) => pushToast({ title: "Lỗi bật/tắt kênh", body: e.message, tone: "error" }),
  });

  // ── Section 3: Agents ──
  const { data: agents, isLoading: agentsLoading } = useQuery({
    queryKey: ["config-agents"],
    queryFn: () => apiGet<any[]>("/api/channels/agent-configs", []),
    staleTime: 30_000,
  });

  const [agentSearch, setAgentSearch] = useState("");
  const [agentStatusFilter, setAgentStatusFilter] = useState("");
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [agentEdits, setAgentEdits] = useState<Record<string, any>>({});
  const [loadingSoul, setLoadingSoul] = useState<string | null>(null);
  // Nội dung SOUL.md đã tải/đã lưu — mốc để biết soul trong agentEdits có phải người dùng đã sửa hay chỉ là bản tải về.
  const [soulBaseline, setSoulBaseline] = useState<Record<string, string>>({});

  const patchAgent = useMutation({
    mutationFn: async ({ slug, data }: { slug: string; data: Record<string, any> }) => {
      await fetchOk(`/api/channels/agent-configs/${slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }, "Lỗi cập nhật agent");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["config-agents"] }),
    onError: (e: any) => pushToast({ title: "Lỗi cập nhật agent", body: e.message, tone: "error" }),
  });

  const deleteAgent = useMutation({
    mutationFn: async (slug: string) => {
      await fetchOk(`/api/channels/agent-configs/${slug}`, { method: "DELETE" }, "Lỗi xóa agent");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["config-agents"] }),
    onError: (e: any) => pushToast({ title: "Lỗi xóa agent", body: e.message, tone: "error" }),
  });

  const cloneAgent = useMutation({
    mutationFn: async (slug: string) => {
      await fetchOk(`/api/channels/agent-configs/${slug}/clone`, { method: "POST" }, "Lỗi nhân bản agent");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["config-agents"] }),
    onError: (e: any) => pushToast({ title: "Lỗi nhân bản agent", body: e.message, tone: "error" }),
  });

  const filteredAgents = useMemo(() => {
    return (agents || []).filter((a: any) => {
      if (agentSearch && !(a.display_name || a.slug || "").toLowerCase().includes(agentSearch.toLowerCase())) return false;
      if (agentStatusFilter === "active" && !a.enabled) return false;
      if (agentStatusFilter === "disabled" && a.enabled) return false;
      return true;
    });
  }, [agents, agentSearch, agentStatusFilter]);

  const loadSoul = useCallback(async (slug: string) => {
    setLoadingSoul(slug);
    try {
      const r = await fetch(`/api/channels/agent-configs/${slug}/files/SOUL.md`);
      if (r.ok) {
        const data = await r.json();
        setAgentEdits((prev) => ({
          ...prev,
          [slug]: { ...prev[slug], soul: data.content || "" },
        }));
        setSoulBaseline((prev) => ({ ...prev, [slug]: data.content || "" }));
      }
    } finally {
      setLoadingSoul(null);
    }
  }, []);

  const handleSaveAgent = useCallback(async (slug: string) => {
    const edit = agentEdits[slug] || {};
    const { soul, ...rest } = edit;
    if (Object.keys(rest).length > 0) {
      await patchAgent.mutateAsync({ slug, data: rest });
    }
    if (soul !== undefined) {
      // Chỉ coi SOUL.md là đã lưu khi server nhận — lỗi thì mốc giữ nguyên nên dirty-guard vẫn bật.
      await guard(async () => {
        await fetchOk(`/api/channels/agent-configs/${slug}/files/SOUL.md`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: soul }),
        }, "Lỗi lưu SOUL.md");
        setSoulBaseline((prev) => ({ ...prev, [slug]: soul }));
      }, "Lỗi lưu SOUL.md");
    }
    qc.invalidateQueries({ queryKey: ["config-agents"] });
  }, [agentEdits, patchAgent, qc, guard]);

  const getAgentEdit = (slug: string, field: string, fallback: any) => {
    return agentEdits[slug]?.[field] ?? fallback;
  };

  const setAgentEdit = (slug: string, field: string, value: any) => {
    setAgentEdits((prev) => ({
      ...prev,
      [slug]: { ...prev[slug], [field]: value },
    }));
  };

  // Dirty-guard cho cấu hình kênh + agent: đã chỉnh khác server mà chưa Lưu thì cảnh báo trước khi đóng/reload tab.
  // channelEdits/agentEdits không bị xoá sau Lưu nên phải so với server (không dùng "có key" làm dirty).
  const isDirty =
    Object.entries(channelEdits).some(([name, edit]) =>
      draftDiffersFromServer(edit, (channels || []).find((c: any) => c.name === name)))
    || Object.entries(agentEdits).some(([slug, edit]) => {
      const { soul, ...rest } = edit || {};
      return draftDiffersFromServer(rest, (agents || []).find((a: any) => a.slug === slug))
        || (soul !== undefined && soul !== (soulBaseline[slug] ?? ""));
    });
  useUnsavedChangesGuard(isDirty, saveChannel.isPending || patchAgent.isPending);

  return (
    <div className="space-y-4">
      {/* Section 1: Cài đặt chung */}
      <Card className="p-4">
        <SectionHeader icon={SlidersHorizontal} title="Cài đặt chung" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {globalFields.map((f) => (
            <div key={f.key}>
              <label className="text-xs font-medium text-muted-foreground">{f.label}</label>
              <Input
                type="number"
                defaultValue={defaults[f.key] ?? f.fallback}
                onBlur={(e) => {
                  const val = e.target.value;
                  if (val !== String(defaults[f.key] ?? f.fallback)) {
                    saveSetting.mutate({ key: `channel_defaults.${f.key}`, value: val });
                  }
                }}
                className="mt-1"
              />
            </div>
          ))}
        </div>
        {saveSetting.isPending && (
          <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" /> Đang lưu...
          </p>
        )}
        {saveSetting.isSuccess && (
          <p className="text-xs text-green-600 mt-2 flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3" /> Đã lưu
          </p>
        )}
      </Card>

      {/* Section 2: Kênh Chat */}
      <Card className="p-4">
        <SectionHeader icon={Radio} title="Kênh Chat" right={
          <span className="text-xs text-muted-foreground">{(channels || []).length} kênh</span>
        } />
        {channelsLoading ? (
          <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : (channels || []).length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">Chưa có kênh nào được cấu hình</p>
        ) : (
          <div className="space-y-1">
            {(channels || []).map((ch: any) => {
              const isExpanded = expandedChannel === ch.name;
              const edit = channelEdits[ch.name] || {};
              return (
                <div key={ch.name} className="rounded-lg border overflow-hidden">
                  <div
                    className="flex items-center justify-between p-3 cursor-pointer hover:bg-muted/30 transition-colors"
                    onClick={() => setExpandedChannel(isExpanded ? null : ch.name)}
                  >
                    <div className="flex items-center gap-3">
                      {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                      <StatusDot status={ch.status || "stopped"} />
                      <span className="text-sm font-medium">{ch.display_name || ch.name}</span>
                      <Badge variant="outline" className="text-[10px]">{ch.channel_type}</Badge>
                      {ch.agent_slug && <Badge variant="secondary" className="text-[10px]"><Bot className="h-3 w-3 mr-0.5" />{ch.agent_slug}</Badge>}
                    </div>
                    <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                      <button
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${ch.enabled ? "bg-green-500" : "bg-zinc-300 dark:bg-zinc-600"}`}
                        onClick={() => toggleChannel.mutate({ name: ch.name, enabled: !ch.enabled, channelType: ch.channel_type })}
                      >
                        <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${ch.enabled ? "translate-x-4.5" : "translate-x-0.5"}`} />
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="border-t p-4 bg-muted/10 space-y-3">
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                        <div>
                          <label className="text-xs font-medium text-muted-foreground">Agent</label>
                          <select
                            value={edit.agent_slug ?? ch.agent_slug ?? ""}
                            onChange={(e) => setChannelEdits((p) => ({ ...p, [ch.name]: { ...p[ch.name], agent_slug: e.target.value } }))}
                            className="w-full mt-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
                          >
                            <option value="">-- Không gán --</option>
                            {(agents || []).map((a: any) => (
                              <option key={a.slug} value={a.slug}>{a.display_name || a.slug}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="text-xs font-medium text-muted-foreground">Debounce (giây)</label>
                          <Input type="number" className="mt-1" value={edit.debounce_sec ?? ch.debounce_sec ?? ""} onChange={(e) => setChannelEdits((p) => ({ ...p, [ch.name]: { ...p[ch.name], debounce_sec: e.target.value } }))} placeholder={String(defaults.debounce_sec ?? 5)} />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-muted-foreground">Cooldown (giây)</label>
                          <Input type="number" className="mt-1" value={edit.cooldown_sec ?? ch.cooldown_sec ?? ""} onChange={(e) => setChannelEdits((p) => ({ ...p, [ch.name]: { ...p[ch.name], cooldown_sec: e.target.value } }))} placeholder={String(defaults.cooldown_sec ?? 8)} />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-muted-foreground">Quota / giờ</label>
                          <Input type="number" className="mt-1" value={edit.quota_hour ?? ch.quota_hour ?? ""} onChange={(e) => setChannelEdits((p) => ({ ...p, [ch.name]: { ...p[ch.name], quota_hour: e.target.value } }))} placeholder={String(defaults.quota_per_hour ?? 100)} />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-muted-foreground">Quota / ngày</label>
                          <Input type="number" className="mt-1" value={edit.quota_day ?? ch.quota_day ?? ""} onChange={(e) => setChannelEdits((p) => ({ ...p, [ch.name]: { ...p[ch.name], quota_day: e.target.value } }))} placeholder={String(defaults.quota_per_day ?? 500)} />
                        </div>
                        <div className="flex items-end gap-4">
                          <label className="flex items-center gap-2 text-sm cursor-pointer" title="Tick = bỏ qua tất cả tin nhắn nhóm, chỉ trả lời DM (tin nhắn riêng). Bỏ tick = trả lời cả nhóm lẫn DM.">
                            <Checkbox
                              checked={(edit.group_policy ?? ch.config?.group_policy ?? "disabled") === "disabled"}
                              onCheckedChange={(v) => setChannelEdits((p) => ({ ...p, [ch.name]: { ...p[ch.name], group_policy: v ? "disabled" : "open" } }))}
                            />
                            Bỏ qua tin nhắn nhóm
                            <span className="text-xs text-muted-foreground">(Tick ✓ = chỉ trả lời DM)</span>
                          </label>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => saveChannel.mutate({ name: ch.name, data: channelEdits[ch.name] || {} })} disabled={saveChannel.isPending}>
                          {saveChannel.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Save className="h-3 w-3 mr-1" />}
                          Lưu
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => reconnectChannel.mutate(ch.name)} disabled={reconnectChannel.isPending}>
                          <RefreshCw className={`h-3 w-3 mr-1 ${reconnectChannel.isPending ? "animate-spin" : ""}`} />
                          Kết nối lại
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Section 3: Agents */}
      <Card className="p-4">
        <SectionHeader icon={Bot} title="Agents" right={
          <Button size="sm" onClick={() => navigate("/agents-config/new")}>
            <Plus className="h-3 w-3 mr-1" /> Tạo agent
          </Button>
        } />
        <div className="flex items-center gap-2 mb-3">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Tìm agent..." value={agentSearch} onChange={(e) => setAgentSearch(e.target.value)} className="pl-8" />
          </div>
          <select value={agentStatusFilter} onChange={(e) => setAgentStatusFilter(e.target.value)} className="rounded-md border border-input bg-background px-3 py-2 text-sm">
            <option value="">Tất cả</option>
            <option value="active">Đang hoạt động</option>
            <option value="disabled">Đã tắt</option>
          </select>
        </div>

        {agentsLoading ? (
          <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
        ) : (
          <>
            <div className="rounded-lg border overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/30">
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground w-8" />
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Agent</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Provider</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Model</th>
                    <th className="px-3 py-2 text-center font-medium text-muted-foreground">Temp</th>
                    <th className="px-3 py-2 text-center font-medium text-muted-foreground">Trạng thái</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAgents.map((a: any) => (
                    <tr key={a.slug} className="border-b hover:bg-muted/30 cursor-pointer" onClick={() => navigate(`/agents-config/${a.slug}/edit`)}>
                      <td className="px-3 py-2">
                        <StatusDot status={a.enabled ? "running" : "stopped"} />
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{a.display_name || a.slug}</div>
                        <div className="text-xs text-muted-foreground">{a.slug}</div>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{a.provider || "claude"}</td>
                      <td className="px-3 py-2 text-muted-foreground">{a.model || "—"}</td>
                      <td className="px-3 py-2 text-center text-muted-foreground">{a.temperature ?? 0.7}</td>
                      <td className="px-3 py-2 text-center">
                        <Badge variant={a.enabled ? "default" : "secondary"}>{a.enabled ? "Active" : "Tắt"}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {filteredAgents.length} / {(agents || []).length} agents
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

// ─── Agent Row with expandable inline edit ──────────────────────────────

function AgentRow({
  agent,
  isExpanded,
  onToggleExpand,
  edit,
  onEditChange,
  onSave,
  onDelete,
  onClone,
  onTest,
  saving,
  loadingSoul,
  agents,
}: {
  agent: any;
  isExpanded: boolean;
  onToggleExpand: () => void;
  edit: Record<string, any>;
  onEditChange: (field: string, value: any) => void;
  onSave: () => void;
  onDelete: () => void;
  onClone: () => void;
  onTest: () => void;
  saving: boolean;
  loadingSoul: boolean;
  agents: any[];
}) {
  const a = agent;
  return (
    <>
      <tr className="border-b hover:bg-muted/30 cursor-pointer" onClick={onToggleExpand}>
        <td className="px-3 py-2 text-center">
          {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </td>
        <td className="px-3 py-2">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full shrink-0 ${a.enabled ? "bg-green-500" : "bg-zinc-400"}`} />
            <div>
              <div className="font-medium">{a.display_name || a.slug}</div>
              <div className="text-xs text-muted-foreground">{a.slug}</div>
            </div>
          </div>
        </td>
        <td className="px-3 py-2 text-muted-foreground">{a.provider || "claude"}</td>
        <td className="px-3 py-2 text-muted-foreground">{a.model || "sonnet-4-6"}</td>
        <td className="px-3 py-2 text-center text-muted-foreground">{a.temperature ?? 0.7}</td>
        <td className="px-3 py-2 text-center">
          <Badge variant={a.enabled ? "default" : "outline"} className="text-[10px]">
            {a.enabled ? "Active" : "Tắt"}
          </Badge>
        </td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={6} className="p-0">
            <div className="border-t bg-muted/10 p-4 space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Tên hiển thị</label>
                  <Input className="mt-1" value={edit.display_name ?? a.display_name ?? ""} onChange={(e) => onEditChange("display_name", e.target.value)} />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Provider</label>
                  <select
                    className="w-full mt-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={edit.provider ?? a.provider ?? "claude"}
                    onChange={(e) => onEditChange("provider", e.target.value)}
                  >
                    <option value="claude">Claude</option>
                    <option value="gemini">Gemini</option>
                    <option value="openrouter">OpenRouter</option>
                    <option value="ollama">Ollama (Local AI)</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Model</label>
                  <select
                    className="w-full mt-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={edit.model ?? a.model ?? "claude-sonnet-4-6"}
                    onChange={(e) => onEditChange("model", e.target.value)}
                  >
                    <option value="claude-opus-5-5">claude-opus-5-5</option>
                    <option value="claude-opus-4-8">claude-opus-4-8</option>
                    <option value="claude-opus-5">claude-opus-5</option>
                    <option value="claude-opus-4-7">claude-opus-4-7</option>
                    <option value="claude-sonnet-5-5">claude-sonnet-5-5</option>
                    <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
                    <option value="claude-opus-4-6">claude-opus-4-6</option>
                    <option value="claude-haiku-4-5-20251001">claude-haiku-4-5-20251001</option>
                    <option value="gemini-3.1-pro-preview">gemini-3.1-pro-preview</option>
                    <option value="gemini-3-flash-preview">gemini-3-flash-preview</option>
                    <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite</option>
                    <option value="gemma-4-31b">gemma-4-31b</option>
                    <option value="gemini-2.5-flash">gemini-2.5-flash</option>
                    <option value="gemini-2.5-pro">gemini-2.5-pro</option>
                    <option value="gemini-2.0-flash">gemini-2.0-flash</option>
                    <option value="gemma4:e2b">gemma4:e2b</option>
                    <option value="gemma4:e4b">gemma4:e4b</option>
                    <option value="gemma4:26b">gemma4:26b</option>
                    <option value="gemma4:31b">gemma4:31b</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                    <Thermometer className="h-3 w-3" /> Temperature: {edit.temperature ?? a.temperature ?? 0.7}
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="2"
                    step="0.1"
                    value={edit.temperature ?? a.temperature ?? 0.7}
                    onChange={(e) => onEditChange("temperature", parseFloat(e.target.value))}
                    className="w-full mt-2 accent-primary"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground">Trạng thái</label>
                <select
                  className="w-full mt-1 rounded-md border border-input bg-background px-3 py-2 text-sm max-w-xs"
                  value={edit.enabled !== undefined ? (edit.enabled ? "active" : "disabled") : (a.enabled ? "active" : "disabled")}
                  onChange={(e) => onEditChange("enabled", e.target.value === "active")}
                >
                  <option value="active">Active</option>
                  <option value="paused">Paused</option>
                  <option value="disabled">Disabled</option>
                </select>
              </div>

              {/* MCP Tools */}
              <TooltipProvider>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-2 block">MCP Tools</label>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                    {MCP_TOOLS.map((tool) => {
                      const currentTools: string[] = edit.tools ?? a.tools ?? [];
                      const isChecked = currentTools.includes(tool.key);
                      return (
                        <Tooltip key={tool.key}>
                          <TooltipTrigger asChild>
                            <label className="flex items-center gap-2 text-sm cursor-pointer p-2 rounded hover:bg-muted/30">
                              <Checkbox
                                checked={isChecked}
                                onCheckedChange={(checked) => {
                                  const next = checked
                                    ? [...currentTools, tool.key]
                                    : currentTools.filter((t) => t !== tool.key);
                                  onEditChange("tools", next);
                                }}
                              />
                              {tool.label}
                            </label>
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            <p className="max-w-[200px]">{tool.description}</p>
                          </TooltipContent>
                        </Tooltip>
                      );
                    })}
                  </div>
                </div>
              </TooltipProvider>

              {/* SOUL.md */}
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1">
                  <FileCode className="h-3 w-3" /> SOUL.md
                </label>
                {loadingSoul ? (
                  <div className="flex items-center gap-2 py-4">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Đang tải...</span>
                  </div>
                ) : (
                  <Textarea
                    className="mt-1 font-mono text-xs min-h-[120px]"
                    value={edit.soul ?? ""}
                    onChange={(e) => onEditChange("soul", e.target.value)}
                    placeholder="Nội dung SOUL.md cho agent..."
                  />
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 pt-2 border-t">
                <Button size="sm" onClick={onSave} disabled={saving}>
                  {saving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Save className="h-3 w-3 mr-1" />}
                  Lưu tất cả
                </Button>
                <Button size="sm" variant="outline" onClick={onClone}>
                  <Copy className="h-3 w-3 mr-1" /> Nhân bản
                </Button>
                <Button size="sm" variant="outline" onClick={onTest}>
                  <TestTube2 className="h-3 w-3 mr-1" /> Test
                </Button>
                <div className="flex-1" />
                <Button size="sm" variant="ghost" className="text-destructive" onClick={onDelete}>
                  <Trash2 className="h-3 w-3 mr-1" /> Xóa
                </Button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// TAB 2: API & Tích hợp
// ═══════════════════════════════════════════════════════════════════════

interface ApiKeyField {
  id: string;
  label: string;
  configKey: string;
  testEndpoint?: string;
}

const API_KEY_FIELDS: ApiKeyField[] = [
  { id: "supabase_url", label: "Supabase URL", configKey: "supabase_url" },
  { id: "supabase_key", label: "Supabase Key", configKey: "supabase_key", testEndpoint: "/api/health" },
  // CC Supabase removed — Phase 1 unified to Main Supabase
  { id: "shopify_url", label: "Shopify URL", configKey: "shopify_url" },
  { id: "shopify_token", label: "Shopify Token", configKey: "shopify_access_token", testEndpoint: "/api/health" },
  { id: "resend_key", label: "Resend API Key", configKey: "resend_api_key" },
  { id: "telegram_token", label: "Telegram Bot Token", configKey: "telegram_bot_token" },
  { id: "telegram_chat_id", label: "Telegram Chat ID", configKey: "telegram_chat_id" },
];

const WEBHOOK_ENDPOINTS = [
  { source: "Facebook Messenger", url: "/api/channels/facebook/webhook", methods: ["GET (verify)", "POST (events)"] },
  { source: "Zalo Personal", url: "/api/channels/zalo-personal", methods: ["WebSocket"] },
  { source: "Shopify", url: "Edge Function: shopify-webhook", methods: ["POST (orders/create, orders/paid)"] },
  { source: "Telegram", url: "/api/channels/telegram/webhook", methods: ["POST (updates)"] },
];

function APIIntegrationTab() {
  const qc = useQueryClient();
  const { pushToast } = useToast();

  const { data: config, isLoading } = useQuery({
    queryKey: ["config-hub"],
    queryFn: () => apiGet<Record<string, any>>("/api/system/config", {}),
    staleTime: 60_000,
  });

  const [visibility, setVisibility] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [testing, setTesting] = useState<string | null>(null);

  const saveKey = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      await fetchOk("/api/system/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      }, "Lỗi lưu API key");
    },
    onSuccess: () => {
      setEditing({});
      qc.invalidateQueries({ queryKey: ["config-hub"] });
    },
    onError: (e: any) => pushToast({ title: "Lỗi lưu API key", body: e.message, tone: "error" }),
  });

  // Dirty-guard: đang gõ dở API key khác giá trị đã lưu (bấm "Sửa" chưa gõ gì thì chưa dirty).
  const isDirty = API_KEY_FIELDS.some(
    (f) => f.id in editing && editing[f.id] !== (config?.[f.configKey] || ""),
  );
  useUnsavedChangesGuard(isDirty, saveKey.isPending);

  const testKey = async (field: ApiKeyField) => {
    setTesting(field.id);
    const start = Date.now();
    try {
      const r = await fetch(field.testEndpoint || "/api/health");
      const ms = Date.now() - start;
      setTestResults((prev) => ({
        ...prev,
        [field.id]: { ok: r.ok, message: r.ok ? `OK (${ms}ms)` : `Lỗi HTTP ${r.status}` },
      }));
    } catch (err: any) {
      setTestResults((prev) => ({
        ...prev,
        [field.id]: { ok: false, message: `Lỗi: ${err.message}` },
      }));
    } finally {
      setTesting(null);
    }
  };

  const maskValue = (val: string) => {
    if (!val || val.length < 8) return "●●●●●●●●";
    return val.slice(0, 4) + "●●●●●●●●" + val.slice(-4);
  };

  // Webhooks logs
  const { data: webhookLogs, refetch: refetchLogs } = useQuery({
    queryKey: ["webhook-logs"],
    queryFn: () => apiGet<any[]>("/api/channels/crm/webhooks/logs", []),
    staleTime: 30_000,
  });

  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [replayResult, setReplayResult] = useState<Record<string, { ok: boolean; msg: string }>>({});
  const replayWebhook = async (id: string) => {
    try {
      const r = await fetchOk(`/api/channels/crm/webhooks/replay/${id}`, { method: "POST" }, "Lỗi replay webhook");
      const data = await r.json();
      setReplayResult((p) => ({ ...p, [id]: { ok: !!data.ok, msg: data.ok ? "Đã replay" : data.error || `HTTP ${r.status}` } }));
      refetchLogs();
    } catch (err: any) {
      setReplayResult((p) => ({ ...p, [id]: { ok: false, msg: err.message } }));
    }
  };

  return (
    <div className="space-y-4">
      {/* Section 1: API Keys */}
      <Card className="p-4">
        <SectionHeader icon={Key} title="API Keys" />
        {isLoading ? (
          <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
        ) : (
          <div className="space-y-3">
            {API_KEY_FIELDS.map((field) => {
              const rawValue = config?.[field.configKey] || "";
              const isVisible = visibility[field.id];
              const isEditing = field.id in editing;
              const result = testResults[field.id];

              return (
                <div key={field.id} className="flex items-center gap-3">
                  <label className="text-sm font-medium w-40 shrink-0">{field.label}</label>
                  <div className="flex-1">
                    {isEditing ? (
                      <div className="flex gap-2">
                        <Input
                          value={editing[field.id]}
                          onChange={(e) => setEditing((p) => ({ ...p, [field.id]: e.target.value }))}
                          className="flex-1"
                          autoFocus
                        />
                        <Button size="sm" onClick={() => saveKey.mutate({ key: field.configKey, value: editing[field.id] })} disabled={saveKey.isPending}>
                          {saveKey.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing((p) => { const n = { ...p }; delete n[field.id]; return n; })}>
                          <XCircle className="h-3 w-3" />
                        </Button>
                      </div>
                    ) : (
                      <code className="text-sm text-muted-foreground bg-muted/30 px-2 py-1 rounded">
                        {isVisible ? rawValue || "(trống)" : maskValue(rawValue)}
                      </code>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button size="sm" variant="ghost" onClick={() => setVisibility((p) => ({ ...p, [field.id]: !isVisible }))} title={isVisible ? "Ẩn" : "Hiện"}>
                      {isVisible ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                    </Button>
                    {!isEditing && (
                      <Button size="sm" variant="ghost" onClick={() => setEditing((p) => ({ ...p, [field.id]: rawValue }))}>
                        Sửa
                      </Button>
                    )}
                    {field.testEndpoint && (
                      <Button size="sm" variant="ghost" onClick={() => testKey(field)} disabled={testing === field.id}>
                        {testing === field.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <TestTube2 className="h-3 w-3" />}
                      </Button>
                    )}
                    {result && (
                      <span className={`text-xs ${result.ok ? "text-green-600" : "text-red-500"}`}>{result.message}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Section 2: Webhooks */}
      <Card className="p-4">
        <SectionHeader icon={Webhook} title="Webhooks" />
        <div className="space-y-2 mb-4">
          {WEBHOOK_ENDPOINTS.map((ep) => (
            <div key={ep.source} className="flex items-center justify-between p-3 rounded-lg border bg-card">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-green-500" />
                  <span className="font-medium text-sm">{ep.source}</span>
                </div>
                <code className="text-xs text-muted-foreground block">{ep.url}</code>
                <div className="flex gap-1 flex-wrap">
                  {ep.methods.map((m) => (
                    <Badge key={m} variant="secondary" className="text-[10px]">{m}</Badge>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={() => {
                  void copyToClipboard(ep.url).then((ok) => {
                    if (!ok) return;
                    setCopyFeedback(ep.source);
                    setTimeout(() => setCopyFeedback(null), 2000);
                  });
                }}>
                  {copyFeedback === ep.source ? <CheckCircle2 className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => testKey({ id: ep.source, label: ep.source, configKey: "", testEndpoint: "/api/health" } as ApiKeyField)}>
                  <TestTube2 className="h-3 w-3" />
                </Button>
              </div>
            </div>
          ))}
        </div>

        {/* Webhook Logs */}
        <h4 className="text-xs font-medium text-muted-foreground mb-2">Log gần đây</h4>
        {(webhookLogs || []).length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">Chưa có log nào</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="py-1.5 px-2 text-xs font-medium text-muted-foreground">Thời gian</th>
                  <th className="py-1.5 px-2 text-xs font-medium text-muted-foreground">Nguồn</th>
                  <th className="py-1.5 px-2 text-xs font-medium text-muted-foreground">Sự kiện</th>
                  <th className="py-1.5 px-2 text-xs font-medium text-muted-foreground">Trạng thái</th>
                  <th className="py-1.5 px-2 text-xs font-medium text-muted-foreground text-right">Replay</th>
                </tr>
              </thead>
              <tbody>
                {(webhookLogs || []).slice(0, 10).map((log: any, i: number) => (
                  <tr key={log.id || i} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="py-1.5 px-2 text-xs text-muted-foreground whitespace-nowrap">
                      {log.created_at ? new Date(log.created_at).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }) : "—"}
                    </td>
                    <td className="py-1.5 px-2 text-xs">{log.source || "—"}</td>
                    <td className="py-1.5 px-2 text-xs truncate max-w-[200px]">{log.event || log.body || "—"}</td>
                    <td className="py-1.5 px-2"><StatusDot status={log.status || "pending"} /></td>
                    <td className="py-1.5 px-2 text-right">
                      {log.id && (
                        <div className="flex items-center justify-end gap-1">
                          {replayResult[log.id] && (
                            <span className={`text-[10px] ${replayResult[log.id].ok ? "text-green-600" : "text-red-500"}`}>
                              {replayResult[log.id].msg}
                            </span>
                          )}
                          <Button size="sm" variant="ghost" title="Replay" onClick={() => replayWebhook(log.id)}>
                            <RefreshCw className="h-3 w-3" />
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// TAB 3: Email & Templates
// ═══════════════════════════════════════════════════════════════════════

function EmailTemplatesTab() {
  const qc = useQueryClient();
  const { pushToast } = useToast();

  const { data: config } = useQuery({
    queryKey: ["config-hub"],
    queryFn: () => apiGet<Record<string, any>>("/api/system/config", {}),
    staleTime: 60_000,
  });

  // Config
  const [senderEmail, setSenderEmail] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const resolvedSender = senderEmail || (config?.email_sender as string) || "GEM Partnership <partnership@gemral.com>";
  const resolvedReplyTo = replyTo || (config?.email_reply_to as string) || "support@gemral.com";

  // Templates UI state
  const [search, setSearch] = useState("");
  const [testEmail, setTestEmail] = useState("");
  const [sendingTest, setSendingTest] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ key: string; ok: boolean; message: string } | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newTmpl, setNewTmpl] = useState({ key: "", label: "", html: "" });

  // Drip sequences
  const [expandedSeq, setExpandedSeq] = useState<string | null>(null);
  const [pausedSeqs, setPausedSeqs] = useState<Set<string>>(new Set());

  const saveConfig = useMutation({
    mutationFn: async (pairs: Record<string, string>) => {
      for (const [key, value] of Object.entries(pairs)) {
        await fetchOk("/api/system/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key, value }),
        }, `Lỗi lưu cấu hình ${key}`);
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["config-hub"] }),
    onError: (e: any) => pushToast({ title: e.message, tone: "error" }),
  });

  const handleSendTest = async (templateKey: string) => {
    if (!testEmail) { pushToast({ title: "Nhập email test trước", tone: "warn" }); return; }
    setSendingTest(templateKey);
    setTestResult(null);
    try {
      // send-email lockdown (2026-07-24): browser KHÔNG cầm secret → qua paperclip-server proxy
      // (giữ SB_SECRET_BACKEND server-side, forward tới send-email). Route sau remoteApiKeyGuard.
      const r = await fetchOk("/api/tools/send-test-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: testEmail, template: templateKey, data: { name: "Test User", tier: "Tier 1" } }),
      }, "Lỗi gửi email test");
      const result = await r.json();
      setTestResult({
        key: templateKey,
        ok: !!result.success,
        message: result.success ? "Đã gửi!" : result.error || `Lỗi ${r.status}`,
      });
    } catch (err: any) {
      setTestResult({ key: templateKey, ok: false, message: err.message });
    } finally {
      setSendingTest(null);
    }
  };

  const handleCopy = (text: string, feedbackKey: string) => {
    void copyToClipboard(text).then((ok) => {
      if (!ok) return;
      setCopyFeedback(feedbackKey);
      setTimeout(() => setCopyFeedback(null), 2000);
    });
  };

  const handleSaveTemplate = (key: string) => {
    saveConfig.mutate({ [`email_template.${key}`]: editContent });
    setEditKey(null);
    setEditContent("");
  };

  const handleCreateTemplate = () => {
    if (!newTmpl.key.trim() || !newTmpl.label.trim()) return;
    saveConfig.mutate({
      [`email_template.${newTmpl.key}`]: newTmpl.html,
      [`email_template_label.${newTmpl.key}`]: newTmpl.label,
    });
    setNewTmpl({ key: "", label: "", html: "" });
    setShowCreate(false);
  };

  // Dirty-guard cho khối soạn HTML template email (nội dung tốn công nhất trong Config Hub):
  // đang sửa HTML khác bản đã lưu, hoặc đang tạo template mới đã nhập dở.
  // Các khối còn lại (kênh, API key, cấu hình chung...) lưu riêng từng ô/onBlur nên không phủ.
  const isDirty =
    (editKey !== null && editContent !== ((config?.[`email_template.${editKey}`] as string) || ""))
    || (showCreate && (newTmpl.key.trim() !== "" || newTmpl.label.trim() !== "" || newTmpl.html.trim() !== ""));
  useUnsavedChangesGuard(isDirty, saveConfig.isPending);

  type TmplItem = { key: string; label: string; category: string };
  const allTemplates = EMAIL_TEMPLATES as unknown as TmplItem[];
  const filteredTemplates: TmplItem[] = search.trim()
    ? allTemplates.filter(t =>
        t.label.toLowerCase().includes(search.toLowerCase()) ||
        t.key.toLowerCase().includes(search.toLowerCase()) ||
        t.category.toLowerCase().includes(search.toLowerCase())
      )
    : allTemplates;

  // Group by category
  const grouped: Record<string, TmplItem[]> = {};
  for (const t of filteredTemplates) {
    if (!grouped[t.category]) grouped[t.category] = [];
    grouped[t.category].push(t);
  }

  return (
    <div className="space-y-4">
      {/* Section 1: Cấu hình Email */}
      <Card className="p-4">
        <SectionHeader icon={Mail} title="Cấu hình Email" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Người gửi (From)</label>
            <Input
              className="mt-1"
              value={resolvedSender}
              onChange={(e) => setSenderEmail(e.target.value)}
              onBlur={() => { if (senderEmail !== config?.email_sender) saveConfig.mutate({ email_sender: senderEmail }); }}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Reply-To</label>
            <Input
              className="mt-1"
              value={resolvedReplyTo}
              onChange={(e) => setReplyTo(e.target.value)}
              onBlur={() => { if (replyTo !== config?.email_reply_to) saveConfig.mutate({ email_reply_to: replyTo }); }}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Domain</label>
            <div className="mt-1 px-3 py-2 rounded-md border bg-muted/30 text-sm flex items-center gap-2">
              gemral.com
              <Badge variant="secondary" className="text-[10px]">
                <CheckCircle2 className="h-3 w-3 mr-0.5 text-green-600" /> Đã xác minh
              </Badge>
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Delivery Engine</label>
            <div className="mt-1 px-3 py-2 rounded-md border bg-muted/30 text-sm flex items-center gap-2">
              Resend API + Edge Functions + pg_cron
              <Badge variant="secondary" className="text-[10px]">
                <CheckCircle2 className="h-3 w-3 mr-0.5 text-green-600" /> Active
              </Badge>
            </div>
          </div>
        </div>
        {saveConfig.isPending && (
          <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Đang lưu...</p>
        )}
      </Card>

      {/* Section 2: Templates */}
      <Card className="p-4">
        <SectionHeader
          icon={FileCode}
          title={`Templates (${EMAIL_TEMPLATES.length} mẫu)`}
          right={
            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Tìm template..."
                  className="pl-8 w-44 text-xs h-8"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <Input
                type="email"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                placeholder="Email test..."
                className="w-44 text-xs h-8"
              />
              <Button size="sm" onClick={() => setShowCreate(!showCreate)}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Tạo template mới
              </Button>
            </div>
          }
        />

        {/* Create new template form */}
        {showCreate && (
          <div className="mb-4 p-4 rounded-lg border bg-muted/10 space-y-3">
            <h4 className="text-sm font-medium">Tạo template mới</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Key (snake_case)</label>
                <Input className="mt-1 text-xs font-mono" value={newTmpl.key} onChange={(e) => setNewTmpl(f => ({ ...f, key: e.target.value }))} placeholder="my_template_key" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Tên hiển thị</label>
                <Input className="mt-1 text-xs" value={newTmpl.label} onChange={(e) => setNewTmpl(f => ({ ...f, label: e.target.value }))} placeholder="Tên template" />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">HTML content</label>
              <Textarea className="mt-1 font-mono text-xs min-h-[100px]" value={newTmpl.html} onChange={(e) => setNewTmpl(f => ({ ...f, html: e.target.value }))} placeholder="<html>...</html>" />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleCreateTemplate} disabled={!newTmpl.key.trim() || !newTmpl.label.trim()}>
                <Save className="h-3 w-3 mr-1" /> Lưu template
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setShowCreate(false); setNewTmpl({ key: "", label: "", html: "" }); }}>Huỷ</Button>
            </div>
          </div>
        )}

        {/* Grouped template list */}
        {Object.entries(grouped).length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">Không tìm thấy template nào</p>
        ) : (
          <div className="space-y-4">
            {Object.entries(grouped).map(([category, templates]) => (
              <div key={category}>
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">{category}</h4>
                <div className="space-y-1">
                  {templates.map((tmpl) => (
                    <div key={tmpl.key} className="rounded-lg border overflow-hidden">
                      {/* Row */}
                      <div className="flex items-center gap-3 p-3 hover:bg-muted/20">
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-medium">{tmpl.label}</span>
                          <code className="block text-[10px] text-muted-foreground mt-0.5">{tmpl.key}</code>
                        </div>
                        {/* Test result inline */}
                        {testResult?.key === tmpl.key && testResult && (
                          <span className={`text-[11px] ${testResult.ok ? "text-green-600" : "text-red-500"}`}>{testResult.message}</span>
                        )}
                        <div className="flex items-center gap-0.5 shrink-0">
                          <Button size="sm" variant="ghost" title="Xem trước" onClick={() => setPreviewKey(previewKey === tmpl.key ? null : tmpl.key)}>
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" title="Sửa HTML" onClick={() => { setEditKey(editKey === tmpl.key ? null : tmpl.key); setEditContent((config?.[`email_template.${tmpl.key}`] as string) || ""); }}>
                            <FileCode className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" title="Copy key" onClick={() => handleCopy(tmpl.key, tmpl.key)}>
                            {copyFeedback === tmpl.key ? <CheckCircle2 className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
                          </Button>
                          <Button size="sm" variant="ghost" title="Gửi test" onClick={() => handleSendTest(tmpl.key)} disabled={sendingTest === tmpl.key}>
                            {sendingTest === tmpl.key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                          </Button>
                        </div>
                      </div>

                      {/* Preview expand */}
                      {previewKey === tmpl.key && (
                        <div className="border-t bg-muted/5 p-3">
                          <iframe
                            srcDoc={
                              (config?.[`email_template.${tmpl.key}`] as string) ||
                              `<html><body style="font-family:system-ui,sans-serif;padding:24px;color:#1a1a1a">
                                <div style="max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;padding:32px">
                                  <h2 style="margin:0 0 12px;font-size:18px">${tmpl.label}</h2>
                                  <p style="color:#6b7280;font-size:13px">Template: <code>${tmpl.key}</code></p>
                                  <hr style="margin:16px 0;border:none;border-top:1px solid #e5e7eb" />
                                  <p style="color:#9ca3af;font-size:12px">Nội dung template được render từ Edge Function send-email.<br>Sửa HTML và lưu để ghi đè.</p>
                                </div>
                              </body></html>`
                            }
                            className="w-full h-52 rounded border bg-white"
                            title={`Preview ${tmpl.key}`}
                            sandbox="allow-same-origin"
                          />
                          <p className="text-[10px] text-muted-foreground mt-1 flex items-center gap-1">
                            <Info className="h-3 w-3" />
                            Template override (nếu có) sẽ được dùng thay template mặc định trong Edge Function.
                          </p>
                        </div>
                      )}

                      {/* Edit HTML expand */}
                      {editKey === tmpl.key && (
                        <div className="border-t bg-muted/5 p-3 space-y-2">
                          <Textarea
                            className="font-mono text-xs min-h-[140px] resize-y"
                            value={editContent}
                            onChange={(e) => setEditContent(e.target.value)}
                            placeholder={`<html>\n  <body style="font-family:sans-serif;padding:20px">\n    <!-- Nội dung HTML cho ${tmpl.key} -->\n  </body>\n</html>`}
                          />
                          <div className="flex gap-2">
                            <Button size="sm" onClick={() => handleSaveTemplate(tmpl.key)} disabled={saveConfig.isPending}>
                              {saveConfig.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Save className="h-3 w-3 mr-1" />}
                              Lưu
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => { setEditKey(null); setEditContent(""); }}>Huỷ</Button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="text-xs text-muted-foreground flex items-center gap-1 mt-3">
          <Info className="h-3 w-3" />
          Nhập email test rồi nhấn <Send className="h-3 w-3 inline" /> để gửi thử trực tiếp qua Resend API.
        </p>
      </Card>

      {/* Section 3: Drip Sequences */}
      <Card className="p-4">
        <SectionHeader
          icon={Thermometer}
          title={`Drip Sequences (${DRIP_SEQUENCES.length} chuỗi)`}
          right={
            <Badge variant="secondary" className="text-[10px]">
              <CheckCircle2 className="h-3 w-3 mr-0.5 text-green-600" /> pg_cron Active
            </Badge>
          }
        />

        <div className="space-y-2">
          {DRIP_SEQUENCES.map((seq) => {
            const isPaused = pausedSeqs.has(seq.key);
            const isExpanded = expandedSeq === seq.key;
            return (
              <div key={seq.key} className="rounded-lg border overflow-hidden">
                {/* Sequence header */}
                <div
                  className="flex items-center gap-3 p-3 hover:bg-muted/20 cursor-pointer"
                  onClick={() => setExpandedSeq(isExpanded ? null : seq.key)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{seq.label}</span>
                      {isPaused && <Badge variant="secondary" className="text-[10px] text-amber-600">Tạm dừng</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground">{seq.description} — {seq.steps.length} bước</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                    <Button size="sm" variant="ghost" title="Sửa steps" onClick={() => setExpandedSeq(isExpanded ? null : seq.key)}>
                      <FileCode className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      title={isPaused ? "Tiếp tục" : "Tạm dừng"}
                      onClick={() => setPausedSeqs(prev => {
                        const next = new Set(prev);
                        next.has(seq.key) ? next.delete(seq.key) : next.add(seq.key);
                        return next;
                      })}
                    >
                      {isPaused ? <RefreshCw className="h-3.5 w-3.5 text-green-600" /> : <span className="text-xs">⏸</span>}
                    </Button>
                    <Button size="sm" variant="ghost" title="Thống kê">
                      <SlidersHorizontal className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <ChevronRight className={`h-4 w-4 text-muted-foreground transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                </div>

                {/* Steps table */}
                {isExpanded && (
                  <div className="border-t bg-muted/5">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b bg-muted/20">
                          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground w-16">Ngày</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Template</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Chủ đề</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground w-16">Test</th>
                        </tr>
                      </thead>
                      <tbody>
                        {seq.steps.map((step, i) => (
                          <tr key={i} className="border-b last:border-0 hover:bg-muted/10">
                            <td className="px-3 py-2 text-center">
                              <Badge variant="outline" className="text-[10px]">D+{step.day}</Badge>
                            </td>
                            <td className="px-3 py-2">
                              <code className="text-[11px] text-muted-foreground">{step.template}</code>
                            </td>
                            <td className="px-3 py-2 text-xs text-muted-foreground">{step.subject}</td>
                            <td className="px-3 py-2 text-right">
                              <Button size="sm" variant="ghost" onClick={() => handleSendTest(step.template)} disabled={sendingTest === step.template} title="Gửi test">
                                {sendingTest === step.template ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="p-3 border-t bg-muted/10">
                      <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                        <Info className="h-3 w-3" />
                        Trigger: <code className="ml-0.5">{seq.trigger}</code> — Được điều phối bởi pg_cron + Edge Function
                      </p>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// TAB 4: Hệ thống
// ═══════════════════════════════════════════════════════════════════════

function SystemTab() {
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const guard = useGuardedAction();

  // Access control
  const { data: channels, isLoading: channelsLoading } = useQuery({
    queryKey: ["system-channels"],
    queryFn: () => apiGet<any[]>("/api/channels/instances", []),
    staleTime: 30_000,
  });

  // PM2
  const { data: pm2List = [], isLoading: pm2Loading, refetch: refetchPm2 } = useQuery({
    queryKey: ["pm2-processes"],
    queryFn: () => apiGet<any[]>("/api/system/pm2", []),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
  const [pm2Action, setPm2Action] = useState<string | null>(null);
  const [pm2Logs, setPm2Logs] = useState<{ name: string; lines: string[] } | null>(null);

  const pm2Restart = async (name: string) => {
    setPm2Action(`restart:${name}`);
    try {
      await guard(async () => {
        await fetchOk(`/api/system/pm2/${name}/restart`, { method: "POST" }, "Lỗi khởi động lại tiến trình");
        await refetchPm2();
      }, "Lỗi khởi động lại tiến trình");
    } finally { setPm2Action(null); }
  };
  const pm2Stop = async (name: string) => {
    setPm2Action(`stop:${name}`);
    try {
      await guard(async () => {
        await fetchOk(`/api/system/pm2/${name}/stop`, { method: "POST" }, "Lỗi dừng tiến trình");
        await refetchPm2();
      }, "Lỗi dừng tiến trình");
    } finally { setPm2Action(null); }
  };
  const pm2FetchLogs = async (name: string) => {
    if (pm2Logs?.name === name) { setPm2Logs(null); return; }
    setPm2Action(`logs:${name}`);
    try {
      const r = await fetch(`/api/system/pm2/${name}/logs`);
      const data = await r.json();
      setPm2Logs({ name, lines: data.lines || [] });
    } finally { setPm2Action(null); }
  };

  // Cloudflare tunnel
  const { data: sysConfig } = useQuery({
    queryKey: ["config-hub"],
    queryFn: () => apiGet<Record<string, any>>("/api/system/config", {}),
    staleTime: 60_000,
  });
  const [tunnelUrl, setTunnelUrl] = useState("");
  const saveTunnel = useMutation({
    mutationFn: async (url: string) => {
      await fetchOk("/api/system/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "cloudflare_tunnel_url", value: url }),
      }, "Lỗi lưu tunnel URL");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["config-hub"] }),
    onError: (e: any) => pushToast({ title: "Lỗi lưu tunnel URL", body: e.message, tone: "error" }),
  });

  const saveChannelPolicy = useMutation({
    mutationFn: async ({ name, field, value }: { name: string; field: string; value: string }) => {
      await fetchOk(`/api/channels/settings/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      }, "Lỗi cập nhật chính sách kênh");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["system-channels"] }),
    onError: (e: any) => pushToast({ title: "Lỗi cập nhật chính sách kênh", body: e.message, tone: "error" }),
  });

  // System info
  const { data: health } = useQuery({
    queryKey: ["system-health"],
    queryFn: () => apiGet<Record<string, any>>("/api/health", {}),
    staleTime: 60_000,
  });

  // Export/Import
  const [importStatus, setImportStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = async () => {
    try {
      const r = await fetch("/api/system/config");
      if (!r.ok) throw new Error("Lỗi tải cấu hình");
      const data = await r.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `config-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      pushToast({ title: "Lỗi export", body: err.message, tone: "error" });
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportStatus(null);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const entries = Object.entries(data);
      let saved = 0;
      for (const [key, value] of entries) {
        try {
          await fetchOk("/api/system/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key, value: typeof value === "string" ? value : JSON.stringify(value) }),
          }, `Lỗi nhập cấu hình ${key}`);
          saved++;
        } catch { /* khóa lỗi không đếm — tổng kết "saved/entries" bên dưới */ }
      }
      setImportStatus({ ok: true, message: `Đã nhập ${saved}/${entries.length} cấu hình thành công` });
      qc.invalidateQueries({ queryKey: ["config-hub"] });
    } catch (err: any) {
      setImportStatus({ ok: false, message: `Lỗi: ${err.message}` });
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="space-y-4">
      {/* Section 1: Kiểm soát truy cập */}
      <Card className="p-4">
        <SectionHeader icon={Lock} title="Kiểm soát truy cập" />
        {channelsLoading ? (
          <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : (channels || []).length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">Chưa có kênh nào được cấu hình</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="py-2 px-3 text-xs font-medium text-muted-foreground">Kênh</th>
                  <th className="py-2 px-3 text-xs font-medium text-muted-foreground">Chính sách DM</th>
                  <th className="py-2 px-3 text-xs font-medium text-muted-foreground">Chính sách Group</th>
                  <th className="py-2 px-3 text-xs font-medium text-muted-foreground text-center">Yêu cầu mention</th>
                  <th className="py-2 px-3 text-xs font-medium text-muted-foreground text-center">Quota/giờ</th>
                  <th className="py-2 px-3 text-xs font-medium text-muted-foreground text-center">Quota/ngày</th>
                </tr>
              </thead>
              <tbody>
                {(channels || []).map((ch: any) => (
                  <tr key={ch.name} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="py-2 px-3 font-medium">{ch.display_name || ch.name}</td>
                    <td className="py-2 px-3">
                      <select
                        value={ch.dm_policy || "open"}
                        onChange={(e) => saveChannelPolicy.mutate({ name: ch.name, field: "dm_policy", value: e.target.value })}
                        className="rounded-md border border-input bg-background px-2 py-1 text-xs"
                      >
                        <option value="open">Mở</option>
                        <option value="allowlist">Allowlist</option>
                        <option value="pairing">Ghép nối</option>
                        <option value="disabled">Tắt</option>
                      </select>
                    </td>
                    <td className="py-2 px-3">
                      <select
                        value={ch.group_policy || "open"}
                        onChange={(e) => saveChannelPolicy.mutate({ name: ch.name, field: "group_policy", value: e.target.value })}
                        className="rounded-md border border-input bg-background px-2 py-1 text-xs"
                      >
                        <option value="open">Mở</option>
                        <option value="allowlist">Allowlist</option>
                        <option value="disabled">Tắt</option>
                      </select>
                    </td>
                    <td className="py-2 px-3 text-center">
                      <Checkbox
                        checked={ch.require_mention ?? false}
                        onCheckedChange={(checked) => saveChannelPolicy.mutate({ name: ch.name, field: "require_mention", value: String(checked === true) })}
                      />
                    </td>
                    <td className="py-2 px-3 text-center text-muted-foreground">{ch.quota_hour || 100}</td>
                    <td className="py-2 px-3 text-center text-muted-foreground">{ch.quota_day || 500}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {saveChannelPolicy.isPending && (
          <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" /> Đang lưu...
          </p>
        )}
      </Card>

      {/* Section 2: PM2 Processes */}
      <Card className="p-4">
        <SectionHeader icon={ServerCog} title="PM2 Processes" right={
          <Button size="sm" variant="ghost" onClick={() => refetchPm2()}>
            <RefreshCw className="h-3 w-3 mr-1" /> Làm mới
          </Button>
        } />
        {pm2Loading ? (
          <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
        ) : pm2List.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">PM2 không khả dụng hoặc chưa có process nào</p>
        ) : (
          <div className="space-y-1">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/30">
                    <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Process</th>
                    <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground">Status</th>
                    <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground">CPU</th>
                    <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground">Memory</th>
                    <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground">Uptime</th>
                    <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground">Restarts</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pm2List.map((p: any) => (
                    <>
                      <tr key={p.name} className="border-b last:border-0 hover:bg-muted/20">
                        <td className="px-3 py-2 font-medium">{p.name}</td>
                        <td className="px-3 py-2 text-center"><StatusDot status={p.status === "online" ? "running" : p.status === "stopped" ? "stopped" : "error"} /></td>
                        <td className="px-3 py-2 text-center text-muted-foreground">{p.cpu}%</td>
                        <td className="px-3 py-2 text-center text-muted-foreground">{p.memory ? `${Math.round(p.memory / 1024 / 1024)}MB` : "—"}</td>
                        <td className="px-3 py-2 text-center text-muted-foreground">
                          {p.uptime > 0 ? `${Math.floor(p.uptime / 86400)}d ${Math.floor((p.uptime % 86400) / 3600)}h` : "—"}
                        </td>
                        <td className="px-3 py-2 text-center text-muted-foreground">{p.restarts}</td>
                        <td className="px-3 py-2 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button size="sm" variant="ghost" title="Restart" onClick={() => pm2Restart(p.name)} disabled={pm2Action === `restart:${p.name}`}>
                              {pm2Action === `restart:${p.name}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                            </Button>
                            <Button size="sm" variant="ghost" title="Stop" onClick={() => pm2Stop(p.name)} disabled={pm2Action === `stop:${p.name}`}>
                              {pm2Action === `stop:${p.name}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <span className="text-xs">⏸</span>}
                            </Button>
                            <Button size="sm" variant="ghost" title="Logs" onClick={() => pm2FetchLogs(p.name)} disabled={pm2Action === `logs:${p.name}`}>
                              {pm2Action === `logs:${p.name}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileCode className="h-3 w-3" />}
                            </Button>
                          </div>
                        </td>
                      </tr>
                      {pm2Logs?.name === p.name && (
                        <tr key={`${p.name}-logs`}>
                          <td colSpan={7} className="p-0">
                            <div className="bg-zinc-950 text-zinc-200 font-mono text-[11px] p-3 max-h-48 overflow-y-auto border-b">
                              {pm2Logs?.lines.map((line, i) => <div key={i}>{line}</div>)}
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Card>

      {/* Section 3: Môi trường */}
      <Card className="p-4">
        <SectionHeader icon={ServerCog} title="Môi trường" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-3 rounded-lg border space-y-1">
            <div className="text-xs font-medium text-muted-foreground">NODE_ENV</div>
            <div className="text-sm font-semibold">{health?.env || "production"}</div>
          </div>
          <div className="p-3 rounded-lg border space-y-1">
            <div className="text-xs font-medium text-muted-foreground">Port</div>
            <div className="text-sm font-semibold">{health?.port || "3101"}</div>
          </div>
          <div className="p-3 rounded-lg border space-y-1">
            <div className="text-xs font-medium text-muted-foreground">Data Directory</div>
            <div className="text-sm font-semibold truncate">{health?.dataDir || "/data"}</div>
          </div>
          <div className="p-3 rounded-lg border space-y-1">
            <div className="text-xs font-medium text-muted-foreground">Uptime</div>
            <div className="text-sm font-semibold">{health?.uptime ? `${Math.floor(health.uptime / 3600)}h ${Math.floor((health.uptime % 3600) / 60)}m` : "—"}</div>
          </div>
          <div className="p-3 rounded-lg border space-y-1">
            <div className="text-xs font-medium text-muted-foreground">Version</div>
            <div className="text-sm font-semibold">{health?.version || "—"}</div>
          </div>
          <div className="p-3 rounded-lg border space-y-1">
            <div className="text-xs font-medium text-muted-foreground">Trạng thái</div>
            <div className="text-sm font-semibold flex items-center gap-1">
              {health?.status === "ok" ? (
                <><CheckCircle2 className="h-4 w-4 text-green-600" /> Hoạt động</>
              ) : (
                <><XCircle className="h-4 w-4 text-red-500" /> {health?.status || "Không xác định"}</>
              )}
            </div>
          </div>
        </div>
        {/* Cloudflare Tunnel — editable */}
        <div className="mt-4 pt-4 border-t">
          <label className="text-xs font-medium text-muted-foreground block mb-1">Cloudflare Tunnel URL</label>
          <div className="flex items-center gap-2">
            <Input
              className="flex-1 font-mono text-sm"
              value={tunnelUrl || sysConfig?.cloudflare_tunnel_url || ""}
              onChange={(e) => setTunnelUrl(e.target.value)}
              placeholder="https://xxx.trycloudflare.com"
            />
            <Button
              size="sm"
              onClick={() => saveTunnel.mutate(tunnelUrl || sysConfig?.cloudflare_tunnel_url || "")}
              disabled={saveTunnel.isPending}
            >
              {saveTunnel.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
            </Button>
          </div>
          {saveTunnel.isSuccess && <p className="text-xs text-green-600 mt-1 flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> Đã lưu</p>}
        </div>
      </Card>

      {/* Section 3: Export / Import */}
      <Card className="p-4">
        <SectionHeader icon={Download} title="Export / Import Cấu hình" />
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={handleExport}>
            <Download className="h-4 w-4 mr-2" /> Export JSON
          </Button>
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              className="hidden"
              onChange={handleImport}
            />
            <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
              <Upload className="h-4 w-4 mr-2" /> Import JSON
            </Button>
          </div>
          {importStatus && (
            <span className={`text-xs ${importStatus.ok ? "text-green-600" : "text-red-500"}`}>
              {importStatus.message}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-3 flex items-center gap-1">
          <Info className="h-3 w-3" />
          Export tải toàn bộ cấu hình hệ thống dưới dạng JSON. Import sẽ ghi đè các key trùng tên.
        </p>
      </Card>
    </div>
  );
}
