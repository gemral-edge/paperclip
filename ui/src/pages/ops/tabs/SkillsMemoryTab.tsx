// Tab 6: Skills & Memory — Skills editor + ReMe injection + Compliance rules

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Eye, Pencil, Copy, RefreshCw, Shield, FileText, Brain, Plus, Save, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SimpleModal } from "../../crm/components/SimpleModal";
import { useToast } from "@/context/ToastContext";
import { copyToClipboard } from "@/lib/clipboard";
import { readJsonOrThrow } from "@/lib/readJsonOrThrow";

const SKILL_FILES = [
  { name: "SKILL-FACEBOOK-POSTING-PLAYWRIGHT.md", desc: "Quy trình đăng Facebook qua Playwright" },
  { name: "SKILL-batch-processor.md", desc: "Batch processor usage guide" },
  { name: "SKILL-schedule-meta-business-suite.md", desc: "Meta Business Suite scheduling" },
  { name: "social-channels.md", desc: "Danh sách kênh social" },
  { name: "IMPORTANT_LINKS.md", desc: "Links + CTA mapping" },
];

const AGENTS_WITH_CONTEXT = [
  "content-strategist", "social-media-manager", "designer",
  "email-crm-manager", "ceo", "community-engagement",
];

const BANNED_WORDS = [
  "giàu nhanh", "kiếm tiền dễ dàng", "thu nhập thụ động",
  "bí mật làm giàu", "đảm bảo lợi nhuận", "get rich quick",
  "bói toán", "phán số mệnh", "ma quỷ",
];

export function SkillsMemoryTab() {
  const { pushToast } = useToast();
  const [viewFile, setViewFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [complianceText, setComplianceText] = useState("");
  const [showCompliance, setShowCompliance] = useState(false);

  const { data: skillContent, isLoading: loadingSkill } = useQuery({
    queryKey: ["ops", "skill", viewFile],
    queryFn: async () => {
      if (!viewFile) return "";
      const res = await fetch(`/api/ops/content-pipeline/skills/${encodeURIComponent(viewFile)}`);
      if (!res.ok) return "(Không thể đọc file)";
      const data = await res.json();
      return data?.content || data || "";
    },
    enabled: !!viewFile,
  });

  const saveMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/ops/content-pipeline/skills/${encodeURIComponent(viewFile!)}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: fileContent }),
      });
      return readJsonOrThrow(res, "Lỗi lưu skill");
    },
    onSuccess: () => { pushToast({ title: "Đã lưu", tone: "success" }); setEditing(false); },
    onError: (e: any) => pushToast({ title: e.message, tone: "error" }),
  });

  const complianceMut = useMutation({
    mutationFn: async (text: string) => {
      const res = await fetch("/api/ops/content-pipeline/compliance-check", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
      });
      return readJsonOrThrow(res, "Lỗi kiểm tra compliance");
    },
    onSuccess: (data) => pushToast({
      title: data?.pass ? "✅ Compliance OK" : `❌ Vi phạm: ${(data?.violations || []).join(", ")}`,
      tone: data?.pass ? "success" : "error",
    }),
    onError: (e: any) => pushToast({ title: e.message, tone: "error" }),
  });

  return (
    <div className="space-y-4">
      {/* Skill Files */}
      <Card className="p-4">
        <h3 className="text-sm font-semibold mb-3">Skill Files</h3>
        <div className="space-y-1.5">
          {SKILL_FILES.map(f => (
            <div key={f.name} className="flex items-center justify-between p-2.5 rounded-lg hover:bg-muted/30">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
                <FileText className="h-4 w-4 text-muted-foreground" />
                <div>
                  <div className="text-xs font-medium">{f.name}</div>
                  <div className="text-[10px] text-muted-foreground">{f.desc}</div>
                </div>
              </div>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => { setViewFile(f.name); setEditing(false); }}><Eye className="h-3 w-3" /></Button>
                <Button size="sm" variant="ghost" onClick={() => { setViewFile(f.name); setEditing(true); }}><Pencil className="h-3 w-3" /></Button>
                <Button size="sm" variant="ghost" onClick={() => { void copyToClipboard(f.name).then((ok) => { pushToast(ok ? { title: "Copied path", tone: "success" } : { title: "Không thể sao chép", body: "Trình duyệt chặn quyền truy cập clipboard.", tone: "error" }); }); }}><Copy className="h-3 w-3" /></Button>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Memory / ReMe Injection */}
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Brain className="h-4 w-4 text-violet-500" />
          <h3 className="text-sm font-semibold">Context Injection</h3>
        </div>
        <div className="text-xs text-muted-foreground mb-2">Agents nhận context từ pipeline:</div>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {AGENTS_WITH_CONTEXT.map(a => (
            <span key={a} className="px-2 py-1 rounded-full bg-violet-500/10 text-violet-600 text-[10px] font-medium">{a}</span>
          ))}
        </div>
        <Button size="sm" variant="outline"><RefreshCw className="h-3 w-3 mr-1" /> Reload agent context</Button>
      </Card>

      {/* Compliance Rules */}
      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-red-500" />
            <h3 className="text-sm font-semibold">Compliance Rules</h3>
          </div>
          <Button size="sm" variant="outline" onClick={() => setShowCompliance(true)}>
            <Shield className="h-3 w-3 mr-1" /> Test compliance
          </Button>
        </div>
        <div className="text-xs text-muted-foreground mb-2">Từ bị cấm trên Facebook:</div>
        <div className="flex flex-wrap gap-1.5">
          {BANNED_WORDS.map(w => (
            <span key={w} className="px-2 py-1 rounded bg-red-500/10 text-red-600 text-[10px]">{w}</span>
          ))}
        </div>
      </Card>

      {/* View/Edit Skill Modal */}
      <SimpleModal open={!!viewFile} onClose={() => setViewFile(null)} title={viewFile || ""} footer={<>
        <Button variant="outline" onClick={() => setViewFile(null)}>Đóng</Button>
        {editing && <Button disabled={saveMut.isPending} onClick={() => saveMut.mutate()}>
          {saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />} Lưu
        </Button>}
      </>}>
        {loadingSkill ? (
          <div className="text-center py-4 text-sm text-muted-foreground">Đang tải...</div>
        ) : editing ? (
          <textarea
            value={fileContent || (typeof skillContent === 'string' ? skillContent : '')}
            onChange={e => setFileContent(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono min-h-[400px] resize-y"
            onFocus={() => { if (!fileContent) setFileContent(typeof skillContent === 'string' ? skillContent : ''); }}
          />
        ) : (
          <pre className="text-xs font-mono whitespace-pre-wrap bg-muted/30 p-3 rounded-lg max-h-[500px] overflow-y-auto">
            {typeof skillContent === 'string' ? skillContent : JSON.stringify(skillContent, null, 2)}
          </pre>
        )}
      </SimpleModal>

      {/* Compliance Test Modal */}
      <SimpleModal open={showCompliance} onClose={() => setShowCompliance(false)} title="Test Compliance" footer={<>
        <Button variant="outline" onClick={() => setShowCompliance(false)}>Đóng</Button>
        <Button disabled={!complianceText.trim() || complianceMut.isPending} onClick={() => complianceMut.mutate(complianceText)}>
          {complianceMut.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Shield className="h-4 w-4 mr-1" />} Kiểm tra
        </Button>
      </>}>
        <textarea value={complianceText} onChange={e => setComplianceText(e.target.value)} placeholder="Paste nội dung cần kiểm tra..." className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[120px]" />
      </SimpleModal>
    </div>
  );
}
