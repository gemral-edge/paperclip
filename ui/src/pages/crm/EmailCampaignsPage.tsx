// Email Campaigns Page — list + create campaigns

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Mail, Send } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { SimpleModal } from "./components/SimpleModal";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import { readJsonOrThrow } from "./components/readJsonOrThrow";

function timeAgo(d?: string): string {
  if (!d) return '—';
  const ms = Date.now() - new Date(d).getTime();
  if (Number.isNaN(ms)) return '—';
  if (ms < 0) return 'vừa xong';
  if (ms < 86400000) return Math.round(ms / 3600000) + ' giờ trước';
  return Math.round(ms / 86400000) + ' ngày trước';
}

const templates = [
  { value: 'welcome', label: 'Chào mừng' },
  { value: 'thank_you', label: 'Cảm ơn mua hàng' },
  { value: 'follow_up', label: 'Follow up' },
  { value: 'promotion', label: 'Khuyến mãi' },
  { value: 'win_back', label: 'Win back' },
  { value: 'course_reminder', label: 'Nhắc khóa học' },
];

const SEGMENTS = [
  { value: 'all', label: 'Tất cả', desc: 'Toàn bộ subscribers' },
  { value: 'course_tinh_yeu', label: 'Khóa Tình Yêu', desc: 'Đã mua khóa Tần Số Tình Yêu' },
  { value: 'course_trading', label: 'Khóa Trading', desc: 'Đã mua khóa Trading 3 Tiers' },
  { value: 'course_trieu_phu', label: 'Khóa Tư Duy Triệu Phú', desc: 'Đã mua khóa Triệu Phú' },
  { value: 'course_7_ngay', label: 'Khóa 7 Ngày Tần Số Gốc', desc: 'Đã mua khóa 7 Ngày' },
  { value: 'crystal_customers', label: 'Crystal Customers YYM', desc: 'Khách mua tinh thể' },
  { value: 'general', label: 'General (CTV, affiliate)', desc: 'CTV, affiliates, partners' },
  { value: 'ctv_kol', label: 'CTV/KOL', desc: 'Chỉ CTV và KOL' },
  { value: 'lead_nurture', label: 'Lead nurture (chưa mua)', desc: 'Leads chưa convert' },
];

const defaultForm = { name: '', subject: '', template: 'welcome', segment: 'all', sendTime: 'now' as 'now' | 'schedule', scheduledAt: '', body: '' };

/**
 * @archetype form
 */
export function EmailCampaignsPage() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(defaultForm);
  const [errors, setErrors] = useState<{ name?: string; subject?: string; scheduledAt?: string }>({});
  const [sendingId, setSendingId] = useState<string | null>(null);

  const { data: campaigns, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['crm', 'campaigns'],
    queryFn: async () => {
      const res = await fetch('/api/channels/crm/campaigns');
      return readJsonOrThrow(res, 'Không thể tải danh sách campaign');
    },
    staleTime: 30_000,
  });

  const createMut = useMutation({
    mutationFn: async (d: typeof defaultForm) => {
      const res = await fetch('/api/channels/crm/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(d),
      });
      return readJsonOrThrow(res, 'Lỗi tạo campaign');
    },
    // Chỉ đóng modal + xoá form khi API thành công; lỗi → giữ nguyên dữ liệu nhập, báo lỗi trong modal.
    onSuccess: () => { setShowCreate(false); setForm(defaultForm); setErrors({}); },
    onSettled: () => { qc.invalidateQueries({ queryKey: ['crm', 'campaigns'] }); },
  });

  const sendMut = useMutation({
    mutationFn: async (id: string) => {
      setSendingId(id);
      const res = await fetch(`/api/channels/crm/campaigns/${id}/send`, { method: 'POST' });
      return readJsonOrThrow(res, 'Lỗi gửi campaign');
    },
    onSettled: () => {
      setSendingId(null);
      qc.invalidateQueries({ queryKey: ['crm', 'campaigns'] });
    },
  });

  // Dirty-guard: modal tạo campaign đang mở và có ô khác giá trị mặc định (tên, tiêu đề, nội dung email...)
  const isDirty =
    showCreate && (Object.keys(defaultForm) as (keyof typeof defaultForm)[]).some((k) => form[k] !== defaultForm[k]);
  useUnsavedChangesGuard(isDirty, createMut.isPending);

  const list = Array.isArray(campaigns) ? campaigns : [];

  // Stats
  const totalSent = list.reduce((s: number, c: any) => s + (c.sent_count || 0), 0);
  const totalOpened = list.reduce((s: number, c: any) => s + (c.opened_count || 0), 0);
  const totalClicked = list.reduce((s: number, c: any) => s + (c.clicked_count || 0), 0);
  const openRate = totalSent > 0 ? ((totalOpened / totalSent) * 100).toFixed(1) : '0';
  const clickRate = totalSent > 0 ? ((totalClicked / totalSent) * 100).toFixed(1) : '0';

  const handleCreateSubmit = () => {
    if (createMut.isPending) return;
    const nextErrors: { name?: string; subject?: string; scheduledAt?: string } = {};
    if (!form.name.trim()) nextErrors.name = 'Vui lòng nhập tên campaign.';
    if (!form.subject.trim()) nextErrors.subject = 'Vui lòng nhập tiêu đề email.';
    if (form.sendTime === 'schedule' && !form.scheduledAt) {
      nextErrors.scheduledAt = 'Vui lòng chọn thời gian lên lịch gửi.';
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    setErrors({});
    createMut.mutate(form);
  };

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Email Campaigns</h1>
        <Button type="button" size="sm" onClick={() => { createMut.reset(); setErrors({}); setForm(defaultForm); setShowCreate(true); }}>
          <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" /> Tạo Campaign
        </Button>
      </div>

      {sendMut.isError && <p role="alert" className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{(sendMut.error as Error)?.message || 'Lỗi gửi campaign'}</p>}

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card className="p-4 text-center"><div className="text-2xl font-bold tabular-nums">{totalSent}</div><div className="text-xs text-muted-foreground">Tổng gửi</div></Card>
        <Card className="p-4 text-center"><div className="text-2xl font-bold tabular-nums">{openRate}%</div><div className="text-xs text-muted-foreground">Tỉ lệ mở</div></Card>
        <Card className="p-4 text-center"><div className="text-2xl font-bold tabular-nums">{clickRate}%</div><div className="text-xs text-muted-foreground">Tỉ lệ click</div></Card>
        <Card className="p-4 text-center"><div className="text-2xl font-bold tabular-nums">{list.length}</div><div className="text-xs text-muted-foreground">Campaigns</div></Card>
      </div>

      {/* List */}
      <Card>
        {isLoading ? (
          <div className="p-4 space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : isError ? (
          <div role="alert" className="flex flex-col items-center gap-3 p-10 text-center text-sm text-destructive">
            <span>Không thể tải danh sách campaign: {(error as Error)?.message || 'Lỗi kết nối'}</span>
            <Button type="button" size="sm" variant="outline" onClick={() => refetch()}>
              Thử lại
            </Button>
          </div>
        ) : list.length === 0 ? (
          <div className="flex flex-col items-center gap-3 p-12">
            <Mail className="h-10 w-10 text-muted-foreground/40" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">Chưa có campaign nào.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-muted/30">
                <th scope="col" className="px-4 py-3 text-left font-medium text-muted-foreground">Campaign</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-muted-foreground">Template</th>
                <th scope="col" className="px-4 py-3 text-right font-medium text-muted-foreground">Gửi</th>
                <th scope="col" className="px-4 py-3 text-right font-medium text-muted-foreground">Mở</th>
                <th scope="col" className="px-4 py-3 text-right font-medium text-muted-foreground">Click</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-muted-foreground">Trạng thái</th>
                <th scope="col" className="px-4 py-3 text-right font-medium text-muted-foreground">Ngày</th>
                <th scope="col" className="px-4 py-3 text-right font-medium text-muted-foreground">Hành động</th>
              </tr></thead>
              <tbody>{list.map((c: any) => (
                <tr key={c.id} className="border-b hover:bg-muted/30">
                  <td className="px-4 py-3 font-medium">{c.name}</td>
                  <td className="px-4 py-3 text-xs">{c.template}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{c.sent_count || 0}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{c.opened_count || 0}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{c.clicked_count || 0}</td>
                  <td className="px-4 py-3"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${c.status === 'completed' ? 'bg-green-500/10 text-green-700 dark:text-green-400' : c.status === 'sending' ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400' : 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300'}`}>{c.status}</span></td>
                  <td className="px-4 py-3 text-right text-xs text-muted-foreground tabular-nums">{timeAgo(c.created_at)}</td>
                  <td className="px-4 py-3 text-right">
                    {(c.status === 'draft' || c.status === 'created') && (
                      <Button type="button" size="sm" variant="outline" disabled={sendMut.isPending} onClick={(e) => { e.stopPropagation(); sendMut.mutate(c.id); }}>
                        <Send className="h-3 w-3 mr-1" aria-hidden="true" /> {sendingId === c.id && sendMut.isPending ? 'Đang gửi...' : 'Gửi'}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Create */}
      <SimpleModal open={showCreate} onClose={() => setShowCreate(false)} title="Tạo Email Campaign" footer={<>
        <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>Hủy</Button>
        <Button type="button" disabled={createMut.isPending} onClick={handleCreateSubmit}>
          <Send className="mr-1.5 h-4 w-4" aria-hidden="true" /> {createMut.isPending ? 'Đang tạo...' : 'Tạo Campaign'}
        </Button>
      </>}>
        <div className="space-y-4">
          {createMut.isError && (
            <p role="alert" className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
              {(createMut.error as Error)?.message}
            </p>
          )}
          <div>
            <label htmlFor="camp-name" className="text-sm font-medium">Tên campaign *</label>
            <Input id="camp-name" aria-invalid={!!errors.name} value={form.name} onChange={e => { setForm(f => ({ ...f, name: e.target.value })); setErrors(er => ({ ...er, name: undefined })); }} placeholder="VD: Welcome Q1 2026" />
            {errors.name && <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">{errors.name}</p>}
          </div>
          <div>
            <label htmlFor="camp-subject" className="text-sm font-medium">Tiêu đề email *</label>
            <Input id="camp-subject" aria-invalid={!!errors.subject} value={form.subject} onChange={e => { setForm(f => ({ ...f, subject: e.target.value })); setErrors(er => ({ ...er, subject: undefined })); }} placeholder="VD: Chào mừng bạn đến Gemral!" />
            {errors.subject && <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">{errors.subject}</p>}
          </div>
          <div><label htmlFor="camp-template" className="text-sm font-medium">Template</label>
            <select id="camp-template" value={form.template} onChange={e => setForm(f => ({ ...f, template: e.target.value }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-base sm:text-sm mt-1">
              {templates.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select></div>
          <div><label htmlFor="camp-segment" className="text-sm font-medium">Đối tượng</label>
            <select id="camp-segment" value={form.segment} onChange={e => setForm(f => ({ ...f, segment: e.target.value }))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-base sm:text-sm mt-1">
              {SEGMENTS.map(s => <option key={s.value} value={s.value}>{s.label} — {s.desc}</option>)}
            </select></div>
          <div>
            <span className="text-sm font-medium">Thời gian gửi</span>
            <div className="flex gap-4 mt-1">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="radio" name="sendTime" value="now" checked={form.sendTime === 'now'} onChange={() => setForm(f => ({ ...f, sendTime: 'now' }))} /> Gửi ngay
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="radio" name="sendTime" value="schedule" checked={form.sendTime === 'schedule'} onChange={() => setForm(f => ({ ...f, sendTime: 'schedule' }))} /> Lên lịch
              </label>
            </div>
            {form.sendTime === 'schedule' && (
              <>
                <Input id="camp-scheduled-at" aria-label="Thời gian lên lịch gửi" aria-invalid={!!errors.scheduledAt} type="datetime-local" className="mt-2" value={form.scheduledAt} onChange={e => { setForm(f => ({ ...f, scheduledAt: e.target.value })); setErrors(er => ({ ...er, scheduledAt: undefined })); }} />
                {errors.scheduledAt && <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">{errors.scheduledAt}</p>}
              </>
            )}
          </div>
          <div>
            <label htmlFor="camp-body" className="text-sm font-medium">Nội dung email</label>
            <textarea
              id="camp-body"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-base sm:text-sm min-h-[120px] mt-1"
              placeholder="Nhập nội dung email hoặc chỉnh sửa template..."
              value={form.body}
              onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
            />
          </div>
        </div>
      </SimpleModal>
    </div>
  );
}
