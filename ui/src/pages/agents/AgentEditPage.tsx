import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { useNavigate } from "../../lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Save,
  CheckCircle,
  Loader2,
  Bot,
  FileText,
  Settings,
  Copy,
  Play,
  Trash2,
} from "lucide-react";
import { AgentFilesTab } from "./AgentFilesTab";
import {
  agentConfigsApi,
  PROVIDER_LABELS,
  PROVIDER_MODELS,
  type AgentConfig,
  type AgentProvider,
} from "../../api/agentConfigs";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";

import { useToast } from "@/context/ToastContext";
import { copyToClipboard } from "@/lib/clipboard";
const PROVIDERS: AgentProvider[] = ["claude", "gemini", "antigravity", "openrouter"];

export function AgentEditPage() {
  const { pushToast } = useToast();
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isCreate = !slug;

  // Form state
  const [activeTab, setActiveTab] = useState<"config" | "files">("config");
  const [form, setForm] = useState({
    slug: "",
    display_name: "",
    description: "",
    avatar: "",
    provider: "claude" as AgentProvider,
    model: PROVIDER_MODELS.claude[0],
    temperature: 0.7,
    max_tokens: 4096,
    effort_mode: "auto",
    max_turns: 1,
    system_prompt: "",
    persona_file: "",
    language: "vi",
    tools: [] as string[],
    can_escalate_to: [] as string[],
    fallback_message: "Xin lỗi, em không thể xử lý yêu cầu này.",
    history_limit: 20,
    session_timeout: 3600,
    enabled: true,
    chrome: false,
    skip_permissions: true,
    can_create_agents: false,
    extra_args: "",
    command: "",
    bootstrap_prompt: "",
    conversation_id: "",
  });
  const [saved, setSaved] = useState(false);

  // Load existing agent data (edit mode)
  const { data: agent, isLoading } = useQuery({
    queryKey: ["agent-configs", slug],
    queryFn: () => agentConfigsApi.fetchBySlug(slug!),
    enabled: !!slug,
  });

  // All agents for escalation checkboxes
  const { data: allAgents = [] } = useQuery({
    queryKey: ["agent-configs-all"],
    queryFn: () => agentConfigsApi.fetchAll(),
    staleTime: 60_000,
  });

  // Populate form on load
  useEffect(() => {
    if (agent) {
      setForm({
        slug: agent.slug,
        display_name: agent.display_name,
        description: agent.description || "",
        avatar: agent.avatar || "",
        provider: agent.provider,
        model: agent.model,
        temperature: agent.temperature,
        max_tokens: agent.max_tokens,
        effort_mode: (agent as any).effort_mode || "auto",
        max_turns: (agent as any).max_turns ?? 1,
        system_prompt: agent.system_prompt || "",
        persona_file: agent.persona_file || "",
        language: agent.language || "vi",
        tools: Array.isArray(agent.tools) ? agent.tools : [],
        can_escalate_to: Array.isArray(agent.can_escalate_to) ? agent.can_escalate_to : [],
        fallback_message: agent.fallback_message || "",
        history_limit: agent.history_limit ?? 20,
        session_timeout: agent.session_timeout ?? 3600,
        enabled: agent.enabled ?? true,
        chrome: (agent as any).chrome === true,
        skip_permissions: (agent as any).skip_permissions === true,
        can_create_agents: (agent as any).can_create_agents === true,
        extra_args: Array.isArray((agent as any).extra_args) ? (agent as any).extra_args.join(", ") : ((agent as any).extra_args || ""),
        command: (agent as any).command || "",
        bootstrap_prompt: (agent as any).bootstrap_prompt || "",
        conversation_id: (agent as any).conversation_id || "",
      });
    }
  }, [agent]);

  // Save mutation
  const saveMut = useMutation({
    mutationFn: () => {
      if (isCreate) {
        return agentConfigsApi.create(form);
      }
      return agentConfigsApi.update(slug!, form);
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["agent-configs"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      if (isCreate && data?.slug) {
        navigate(`/agents-config/${data.slug}/edit`, { replace: true });
      }
    },
  });

  function updateField<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleProviderChange(provider: AgentProvider) {
    const models = PROVIDER_MODELS[provider] || [];
    updateField("provider", provider);
    updateField("model", models[0] || "");
    // Auto-set command from provider (no need for separate Command field).
    // antigravity reply provider uses the agy binary internally (full-path
    // fallback), so the command field stays empty.
    updateField(
      "command",
      provider === "gemini" ? "gemini" : (provider === "openrouter" || provider === "antigravity") ? "" : "claude",
    );
  }

  if (!isCreate && isLoading) {
    return (
      <div className="p-6 max-w-2xl mx-auto space-y-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-14 rounded-lg" />
        ))}
      </div>
    );
  }

  if (!isCreate && !isLoading && !agent) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <div className="border border-dashed rounded-lg p-8 text-center">
          <Bot className="h-8 w-8 mx-auto text-muted-foreground mb-2 opacity-50" />
          <p className="text-muted-foreground">Không tìm thấy agent: {slug}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => navigate("/ops/sop-engine")}
          >
            Quay lại
          </Button>
        </div>
      </div>
    );
  }

  const availableModels = PROVIDER_MODELS[form.provider] || [];

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate("/ops/sop-engine")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-lg font-semibold">
            {isCreate ? "Tạo agent mới" : `Chỉnh sửa: ${agent?.display_name}`}
          </h1>
          <p className="text-xs text-muted-foreground">
            {isCreate ? "Cấu hình agent AI mới cho hệ thống" : `Slug: ${slug}`}
          </p>
        </div>
      </div>

      {/* Tabs */}
      {!isCreate && (
        <div className="flex gap-1 border-b">
          <button
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "config"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setActiveTab("config")}
          >
            <Settings className="h-3.5 w-3.5 inline mr-1.5" />
            Cấu hình
          </button>
          <button
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "files"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setActiveTab("files")}
          >
            <FileText className="h-3.5 w-3.5 inline mr-1.5" />
            Tệp Agent
          </button>
        </div>
      )}

      {/* Files Tab */}
      {!isCreate && activeTab === "files" && slug && (
        <AgentFilesTab slug={slug} />
      )}

      {/* Config Tab */}
      {(isCreate || activeTab === "config") && (
        <>
      {/* Form sections */}
      <FormSection title="Thông tin cơ bản">
        <Field label="Slug (định danh)" hint="Chỉ chữ thường, số và dấu gạch ngang">
          <input
            className="input-field"
            placeholder="vd: customer-success"
            value={form.slug}
            onChange={(e) => updateField("slug", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
            disabled={!isCreate}
          />
        </Field>
        <Field label="Tên hiển thị">
          <input
            className="input-field"
            placeholder="vd: Chuyên viên hỗ trợ khách hàng"
            value={form.display_name}
            onChange={(e) => updateField("display_name", e.target.value)}
          />
        </Field>
        <Field label="Mô tả">
          <textarea
            className="input-field min-h-[60px] resize-y"
            placeholder="Mô tả ngắn về vai trò của agent..."
            value={form.description}
            onChange={(e) => updateField("description", e.target.value)}
            rows={2}
          />
        </Field>
        <Field label="Avatar" hint="Emoji hoặc URL ảnh">
          <input
            className="input-field"
            placeholder="vd: 🤖 hoặc https://..."
            value={form.avatar}
            onChange={(e) => updateField("avatar", e.target.value)}
          />
        </Field>
        <Field label="Ngôn ngữ">
          <select
            className="input-field"
            value={form.language}
            onChange={(e) => updateField("language", e.target.value)}
          >
            <option value="vi">Tiếng Việt</option>
            <option value="en">English</option>
            <option value="auto">Tự động</option>
          </select>
        </Field>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="rounded border-border"
              checked={form.enabled}
              onChange={(e) => updateField("enabled", e.target.checked)}
            />
            <span className="text-sm">Bật agent</span>
          </label>
        </div>
      </FormSection>

      <FormSection title="Cấu hình LLM">
        <Field label="Nhà cung cấp (Provider)">
          <div className="grid grid-cols-3 gap-2">
            {PROVIDERS.map((p) => (
              <button
                key={p}
                type="button"
                className={`rounded-md border px-3 py-2 text-xs text-center transition-colors ${
                  form.provider === p
                    ? "border-primary bg-primary/10 text-foreground font-medium"
                    : "border-border text-muted-foreground hover:border-foreground/30"
                }`}
                onClick={() => handleProviderChange(p)}
              >
                {PROVIDER_LABELS[p]}
              </button>
            ))}
          </div>
        </Field>
        <Field label={`Nhiệt độ (Temperature): ${form.temperature}`} hint="0 = chính xác, 2 = sáng tạo">
          <input
            type="range"
            className="w-full accent-primary"
            min={0}
            max={2}
            step={0.1}
            value={form.temperature}
            onChange={(e) => updateField("temperature", parseFloat(e.target.value))}
          />
          <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
            <span>0 (Chính xác)</span>
            <span>1.0</span>
            <span>2.0 (Sáng tạo)</span>
          </div>
        </Field>
        <Field label="Model">
          <select
            className="input-field"
            value={form.model}
            onChange={(e) => updateField("model", e.target.value)}
          >
            {availableModels.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </Field>
        {form.provider === "antigravity" && (
          <Field
            label="Antigravity brain ID (conversation_id)"
            hint="agy không tạo brain headless — mồi 1 lần bằng `agy --conversation <id>` (interactive) rồi /exit, sau đó dán id vào đây. Mỗi agent 1 brain riêng."
          >
            <input
              type="text"
              className="input-field font-mono"
              value={form.conversation_id}
              onChange={(e) => updateField("conversation_id", e.target.value)}
              placeholder="vd: 18dbe41e-5838-44e6-9fcc-57fba1bc573f"
            />
          </Field>
        )}
        <Field label="Max tokens">
          <input
            type="number"
            className="input-field w-40"
            value={form.max_tokens}
            onChange={(e) => updateField("max_tokens", Number(e.target.value))}
            min={100}
            max={128000}
          />
        </Field>
      </FormSection>

      <FormSection title="Permissions & Configuration">
        
        <Field label="Thinking effort" hint="Mức độ suy nghĩ của agent. Auto = tự quyết định.">
          <div className="flex gap-2">
            {["auto", "none", "low", "medium", "high"].map((mode) => (
              <button
                key={mode}
                type="button"
                className={`px-3 py-1.5 rounded-md text-xs border transition-colors ${
                  form.effort_mode === mode
                    ? "border-primary bg-primary/10 text-foreground font-medium"
                    : "border-border text-muted-foreground hover:border-foreground/30"
                }`}
                onClick={() => updateField("effort_mode", mode)}
              >
                {mode === "auto" ? "Tự động" : mode === "none" ? "None" : mode === "low" ? "Thấp" : mode === "medium" ? "Trung bình" : "Cao"}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Bootstrap prompt (first run)" hint="Thiết lập hành vi chỉ áp dụng cho lần khởi tạo session đầu tiên.">
          <textarea
            className="input-field min-h-[80px] resize-y font-mono text-xs"
            placeholder=""
            value={form.bootstrap_prompt || ""}
            onChange={(e) => updateField("bootstrap_prompt", e.target.value)}
            rows={4}
          />
        </Field>

        <div className="grid grid-cols-2 gap-4 mt-2 mb-2">
          <label className="flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/30 cursor-pointer" title="Cho phép agent mở Chrome browser (Playwright) để thao tác web">
            <input type="checkbox" className="rounded" checked={form.chrome} onChange={e => updateField("chrome", e.target.checked)} />
            <div>
              <div className="text-sm font-medium">Enable Chrome</div>
              <div className="text-[10px] text-muted-foreground">Browser access</div>
            </div>
          </label>
          <label className="flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/30 cursor-pointer" title="Bỏ qua hỏi quyền — agent tự do thực thi (--dangerously-skip-permissions)">
            <input type="checkbox" className="rounded" checked={form.skip_permissions} onChange={e => updateField("skip_permissions", e.target.checked)} />
            <div>
              <div className="text-sm font-medium">Skip permissions</div>
              <div className="text-[10px] text-muted-foreground">--dangerously-skip-permissions</div>
            </div>
          </label>
        </div>

        <Field label="Max turns per run" hint="Số lượt agent tự chạy tool trong 1 phiên (mặc định 1).">
          <input
            type="number"
            className="input-field w-32"
            value={form.max_turns}
            onChange={(e) => updateField("max_turns", Number(e.target.value))}
            min={1}
            max={50}
          />
        </Field>

        <Field label="Extra args (comma-separated)" hint="Các arguments thêm (cách nhau bằng dấu phẩy)">
          <input
            className="input-field font-mono text-xs"
            placeholder="vd: --verbose, --channels plugin:telegram"
            value={form.extra_args || ""}
            onChange={e => updateField("extra_args", e.target.value)}
          />
        </Field>

        <div className="mt-4 pt-4 border-t border-border">
          <h4 className="text-sm font-medium mb-3">Permissions</h4>
          <label className="flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/30 cursor-pointer">
            <input type="checkbox" className="rounded" checked={form.can_create_agents} onChange={e => updateField("can_create_agents", e.target.checked)} />
            <div>
              <div className="text-sm font-medium">Can create new agents</div>
              <div className="text-[10px] text-muted-foreground">Agent có quyền tạo agent khác</div>
            </div>
          </label>
        </div>
      </FormSection>

      <FormSection title="Lệnh chạy Agent (thật — đang dùng trên server)">
        <p className="text-[10px] text-muted-foreground mb-2">
          <strong>Auto-reply (Zalo/FB):</strong> server/channels/router.ts spawn agent khi khách nhắn tin.<br/>
          <strong>Heartbeat (Paperclip):</strong> server/services/heartbeat.ts spawn agent theo lịch từ adapter_config.
        </p>
        <div className="relative">
          <textarea
            className="input-field font-mono text-xs min-h-[120px] resize-y bg-zinc-950 text-green-400 p-3 rounded-lg"
            value={(() => {
              const s = form.slug || slug || "agent";
              // Phân tích extra_args: tách subcommands (không có --) khỏi flags (có --)
              const extraArgsList = form.extra_args
                ? form.extra_args.split(",").map((a: string) => a.trim()).filter(Boolean)
                : [];
              const subCmds = extraArgsList.filter((a: string) => !a.startsWith("-"));
              const flagArgs = extraArgsList.filter((a: string) => a.startsWith("-"));
              // cmdPrefix: nếu là ollama thì nhúng subcommands vào ngay sau lệnh
              const baseCmd = form.command || "claude";
              const cmdPrefix = subCmds.length > 0
                ? `${baseCmd} ${subCmds.join(" ")} `
                : `${baseCmd} `;
              const lines: string[] = [];
              const projectRoot = "C:/Users/Jennie Chu/Desktop/Projects/crypto-pattern-scanner";

              // ── Auto-reply command (router.ts — Phase 1 pattern) ──
              // Claude provider: --print - (stdin), stream-json, --add-dir skills, PROJECT_ROOT CWD
              // Gemini provider: --output-format stream-json, --resume session, --approval-mode yolo
              if (form.provider === "gemini") {
                lines.push("# === Auto-reply (Zalo/FB chat) — Gemini ===");
                lines.push("gemini \\");
                lines.push("  -o stream-json \\");
                if (form.model) lines.push(`  -m ${form.model} \\`);
                lines.push("  -y \\");
                lines.push("  -r <session_id> \\");
                lines.push("  -p @<temp>/prompt.txt");
                lines.push(`  # CWD: ${projectRoot}`);
                lines.push("  # prompt.txt = system_prompt + history + tin nhắn khách");
              } else {
                lines.push("# === Auto-reply (Zalo/FB chat) — Claude ===");
                lines.push(`${cmdPrefix}\\`);
                lines.push("  --print - \\");        // ← stdin (KHÔNG phải -p)
                lines.push("  --output-format stream-json \\");  // ← stream (KHÔNG phải json)
                lines.push("  --verbose \\");
                lines.push("  --dangerously-skip-permissions \\");
                if (form.model) lines.push(`  --model ${form.model} \\`);
                lines.push(`  --max-turns ${form.max_turns || 5} \\`);
                lines.push("  --append-system-prompt-file <tmp>/agent-instructions.md \\");
                lines.push("  --add-dir <tmp>/paperclip-chat-skills-XXXXXX \\");
                lines.push(`  --mcp-config agents/${s}/mcp.json \\`);
                if (flagArgs.length > 0) lines.push(`  ${flagArgs.join(" ")} \\`);
                lines.push("  # stdin: <tin nhắn từ khách> (via --print -)");
                lines.push(`  # CWD: ${projectRoot}`);  // ← PROJECT ROOT (KHÔNG phải agents/{slug}/)
              }
              lines.push("");

              // Heartbeat command
              lines.push("# === Heartbeat (Paperclip tasks/issues) ===");
              lines.push(cmdPrefix + "\\");
              lines.push("  --print - \\");
              lines.push("  --output-format stream-json \\");
              lines.push("  --verbose \\");
              if (form.skip_permissions) lines.push("  --dangerously-skip-permissions \\");
              if (form.chrome) lines.push("  --chrome \\");
              if (form.model) lines.push(`  --model ${form.model} \\`);
              if (form.max_turns && form.max_turns > 0) lines.push(`  --max-turns ${form.max_turns} \\`);
              if (form.persona_file) lines.push(`  --append-system-prompt-file <temp>/agent-instructions.md \\`);
              lines.push("  --add-dir <temp>/paperclip-skills-XXXXXX \\");
              if (flagArgs.length > 0) lines.push(`  ${flagArgs.join(" ")} \\`);
              lines.push("  # stdin: prompt (via --print -)");
              lines.push(`  # CWD: ${(agent as any)?.cwd || "C:/Users/Jennie Chu/Desktop/Projects/crypto-pattern-scanner"}`);
              if (form.persona_file) lines.push(`  # Instructions: ${form.persona_file} (copied to temp file + path directive appended)`);
              
              return lines.join("\n");
            })()}
            onChange={e => {
              const cmd = e.target.value;
              const modelMatch = cmd.match(/--model\s+(\S+)/);
              if (modelMatch) updateField("model", modelMatch[1]);
              const turnsMatch = cmd.match(/--max-turns\s+(\d+)/);
              if (turnsMatch) updateField("max_turns", parseInt(turnsMatch[1]));
            }}
          />
          <button
            className="absolute top-2 right-2 text-[10px] px-2 py-1 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
            onClick={() => {
              const s = form.slug || slug || "agent";
              let cmd: string;
              if (form.provider === "gemini") {
                const parts = ["gemini", "--output-format stream-json"];
                if (form.model) parts.push(`--model ${form.model}`);
                parts.push("--approval-mode yolo", "--sandbox=none", "--prompt \"<tin nhắn>\"");
                cmd = parts.join(" ");
              } else {
                const baseCmd = form.command || "claude";
                const parts = [baseCmd, "--print -", "--output-format stream-json", "--verbose", "--dangerously-skip-permissions"];
                if (form.model) parts.push(`--model ${form.model}`);
                parts.push(`--max-turns ${form.max_turns || 5}`);
                parts.push("--append-system-prompt-file <tmp>/agent-instructions.md");
                parts.push("--add-dir <tmp>/paperclip-chat-skills-XXXXXX");
                parts.push(`--mcp-config agents/${s}/mcp.json`);
                if (form.extra_args) parts.push(form.extra_args);
                cmd = parts.join(" ");
              }
              void copyToClipboard(cmd).then((ok) => {
                pushToast(
                  ok
                    ? { title: "Đã sao chép lệnh", tone: "success" }
                    : { title: "Không thể sao chép", body: "Trình duyệt chặn quyền truy cập clipboard.", tone: "error" },
                );
              });
            }}
          >
            Sao chép
          </button>
          <p className="text-[10px] text-muted-foreground mt-1">
            Lệnh thật từ <code>server/src/channels/router.ts</code> — Phase 1 pattern:
            Claude dùng <code>--print -</code> (stdin) + <code>stream-json</code> + <code>--add-dir</code> (skills) + CWD=PROJECT_ROOT.
            Gemini dùng <code>--output-format stream-json --approval-mode yolo --sandbox=none --resume session</code>.
          </p>
        </div>
      </FormSection>

      <FormSection title="Prompt & Persona">
        <Field label="System prompt" hint="Hướng dẫn chính cho agent. Nếu trống sẽ dùng persona_file hoặc fallback.">
          <textarea
            className="input-field min-h-[120px] resize-y font-mono text-xs"
            placeholder="Bạn là trợ lý chăm sóc khách hàng..."
            value={form.system_prompt}
            onChange={(e) => updateField("system_prompt", e.target.value)}
            rows={6}
          />
        </Field>
        <Field label="Persona file" hint="Tên file trong thư mục agents/{slug}/ (vd: AGENTS.md)">
          <input
            className="input-field"
            placeholder="vd: AGENTS.md"
            value={form.persona_file}
            onChange={(e) => updateField("persona_file", e.target.value)}
          />
        </Field>
        <Field label="Tin nhắn fallback" hint="Hiển thị khi agent gặp lỗi">
          <input
            className="input-field"
            value={form.fallback_message}
            onChange={(e) => updateField("fallback_message", e.target.value)}
          />
        </Field>
      </FormSection>

      <FormSection title="Phiên hội thoại">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Giới hạn lịch sử">
            <input
              type="number"
              className="input-field"
              value={form.history_limit}
              onChange={(e) => updateField("history_limit", Number(e.target.value))}
              min={1}
              max={500}
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              Số tin nhắn giữ cho ngữ cảnh
            </p>
          </Field>
          <Field label="Thời gian hết phiên (giây)">
            <input
              type="number"
              className="input-field"
              value={form.session_timeout}
              onChange={(e) => updateField("session_timeout", Number(e.target.value))}
              min={60}
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              Mặc định: 3600 (1 giờ)
            </p>
          </Field>
        </div>
      </FormSection>

      <FormSection title="MCP Tools">
        <Field label="Công cụ MCP" hint="Chọn tools agent được phép sử dụng khi chat với khách">
          <div className="grid grid-cols-2 gap-2">
            {[
              { key: "create_order", label: "Tạo đơn hàng", desc: "Tạo đơn hàng trong CRM" },
              { key: "create_ticket", label: "Tạo phiếu hỗ trợ", desc: "Tạo phiếu hỗ trợ / escalate" },
              { key: "search_product", label: "Tìm sản phẩm", desc: "Tìm sản phẩm trên Shopify" },
              { key: "crm_update", label: "Cập nhật CRM", desc: "Cập nhật thông tin khách hàng" },
              { key: "send_email", label: "Gửi email", desc: "Gửi email qua Resend" },
              { key: "get_customer_info", label: "Thông tin khách", desc: "Lấy chi tiết khách CRM + Gemral" },
              { key: "check_course_access", label: "Kiểm tra khoá học", desc: "Kiểm tra quyền truy cập" },
              { key: "link_gemral_account", label: "Liên kết tài khoản", desc: "Liên kết chat ↔ Gemral App" },
              { key: "search_knowledge", label: "Tìm Knowledge", desc: "Tìm trong Knowledge Base" },
            ].map(tool => (
              <label key={tool.key} className="flex items-start gap-2 p-2 rounded border hover:bg-muted/30 cursor-pointer" title={tool.desc}>
                <input
                  type="checkbox"
                  className="mt-0.5 rounded"
                  checked={form.tools.includes(tool.key)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...form.tools, tool.key]
                      : form.tools.filter(t => t !== tool.key);
                    updateField("tools", next);
                  }}
                />
                <div>
                  <div className="text-sm font-medium">{tool.label}</div>
                  <div className="text-[10px] text-muted-foreground">{tool.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </Field>
      </FormSection>

      <FormSection title="Chuyển tiếp (Escalation)">
        <Field label="Có thể chuyển tiếp tới" hint="Chọn agents mà agent này có thể escalate vấn đề">
          <div className="grid grid-cols-2 gap-1.5 max-h-48 overflow-y-auto">
            {allAgents.filter((a: any) => a.slug !== slug).map((a: any) => (
              <label key={a.slug} className="flex items-center gap-2 p-1.5 rounded hover:bg-muted/30 cursor-pointer text-sm">
                <input
                  type="checkbox"
                  className="rounded"
                  checked={form.can_escalate_to.includes(a.slug)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...form.can_escalate_to, a.slug]
                      : form.can_escalate_to.filter(s => s !== a.slug);
                    updateField("can_escalate_to", next);
                  }}
                />
                {a.display_name || a.slug}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Công cụ tuỳ chỉnh" hint="Nhập tên tools khác (ngoài MCP), mỗi dòng một tool">
          <textarea
            className="input-field min-h-[40px] resize-y font-mono text-xs"
            placeholder="search&#10;calculator"
            value={form.tools.filter(t => !["create_order","create_ticket","search_product","crm_update","send_email","get_customer_info","check_course_access","link_gemral_account","search_knowledge"].includes(t)).join("\n")}
            onChange={(e) => {
              const mcpTools = form.tools.filter(t => ["create_order","create_ticket","search_product","crm_update","send_email","get_customer_info","check_course_access","link_gemral_account","search_knowledge"].includes(t));
              const customTools = e.target.value.split("\n").map(t => t.trim()).filter(Boolean);
              updateField("tools", [...mcpTools, ...customTools]);
            }}
            rows={3}
          />
        </Field>
      </FormSection>

      {/* Action buttons */}
      <div className="flex items-center justify-between pt-4 border-t">
        <div className="flex items-center gap-3">
          <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
            {saveMut.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                Đang lưu...
              </>
            ) : (
              <>
                <Save className="h-4 w-4 mr-1.5" />
                {isCreate ? "Tạo agent" : "Lưu thay đổi"}
              </>
            )}
          </Button>
          {!isCreate && (
            <>
              <Button variant="outline" onClick={async () => {
                const r = await fetch(`/api/channels/agent-configs/${slug}/clone`, { method: "POST" });
                if (r.ok) {
                  const d = await r.json();
                  navigate(`/agents-config/${d.slug || d.data?.slug}/edit`);
                }
              }}>
                <Copy className="h-4 w-4 mr-1.5" />
                Nhân bản
              </Button>
              <Button variant="outline" onClick={() => navigate(`/agents-config/${slug}/test`)}>
                <Play className="h-4 w-4 mr-1.5" />
                Thử nghiệm
              </Button>
            </>
          )}
          {saved && (
            <span className="text-sm text-green-600 flex items-center gap-1">
              <CheckCircle className="h-4 w-4" /> Đã lưu
            </span>
          )}
          {saveMut.isError && (
            <span className="text-sm text-destructive">
              Lỗi: {saveMut.error instanceof Error ? saveMut.error.message : "Không thể lưu"}
            </span>
          )}
        </div>
        {!isCreate && (
          <Button variant="destructive" size="sm" onClick={async () => {
            const r = await fetch(`/api/channels/agent-configs/${slug}`, { method: "DELETE" });
            if (r.ok) {
              qc.invalidateQueries({ queryKey: ["agent-configs"] });
              navigate("/ops/sop-engine");
            } else {
              const err = await r.json().catch(() => ({ error: "Lỗi xóa agent" }));
              pushToast({
                title: "Không thể xóa agent",
                body: err.error || "Có thể agent đang được gán cho kênh.",
                tone: "error",
              });
            }
          }}>
            <Trash2 className="h-4 w-4 mr-1.5" />
            Xóa
          </Button>
        )}
      </div>

      {/* Inline styles for input-field class */}
      <style>{`
        .input-field {
          width: 100%;
          border-radius: 0.375rem;
          border: 1px solid hsl(var(--border));
          background: hsl(var(--background));
          padding: 0.5rem 0.75rem;
          font-size: 0.875rem;
          color: hsl(var(--foreground));
          outline: none;
          transition: box-shadow 0.15s;
        }
        .input-field:focus {
          box-shadow: 0 0 0 1px hsl(var(--ring));
        }
        .input-field:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      `}</style>
        </>
      )}
    </div>
  );
}

function FormSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border rounded-lg p-4 space-y-4">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-foreground">{label}</label>
      {hint && <p className="text-[10px] text-muted-foreground mb-1">{hint}</p>}
      <div className="mt-1">{children}</div>
    </div>
  );
}
