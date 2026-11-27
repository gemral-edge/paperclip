// Affiliate & CTV Page — approve/reject/pay/invite + full CRUD

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { Users, Check, X, DollarSign, Mail, Copy, Pause, Play, Search, Plus, Loader2, Trash2 } from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { opsApi } from "@/api/ops";
import { SimpleModal } from "../crm/components/SimpleModal";
import { useLiveInvalidate } from "@/hooks/useLiveInvalidate";
import { useGuardedAction } from "@/lib/useGuardedAction";
import { fetchOk } from "@/lib/readJsonOrThrow";

function formatVND(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'TR';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return new Intl.NumberFormat('vi-VN').format(n) + '₫';
}

const tierColors: Record<string, string> = {
  bronze: 'bg-orange-500/10 text-orange-600', silver: 'bg-gray-500/10 text-gray-600',
  gold: 'bg-yellow-500/10 text-yellow-700', platinum: 'bg-cyan-500/10 text-cyan-600',
  diamond: 'bg-violet-500/10 text-violet-600',
};

/**
 * @archetype form
 * @capability-skip dirty-guard: trang quản lý CTV: đổi tier, bật/tắt, thanh toán chạy mutation tức thì; hai modal chỉ có lý do từ chối (1 ô) và lời mời CTV (3 ô ngắn) gửi ngay, không có bản nháp dài
 */
export function AffiliatePage() {
  const guard = useGuardedAction();
  const [errors, setErrors] = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);


  const navigate = useNavigate();
  const qc = useQueryClient();
  const [tierFilter, setTierFilter] = useState('');
  const [search, setSearch] = useState('');
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('ctv');
  const [inviteNote, setInviteNote] = useState('');

  const inv = () => qc.invalidateQueries({ queryKey: ['ops', 'affiliate'] });

  const { data: stats } = useQuery({ queryKey: ['ops', 'affiliate', 'stats'], queryFn: () => opsApi.getAffiliateStats(), staleTime: 30_000 });
  const { data: pending } = useQuery({ queryKey: ['ops', 'affiliate', 'pending'], queryFn: () => opsApi.getAffiliatePending(), staleTime: 15_000 });
  const { data: list, isLoading } = useQuery({
    queryKey: ['ops', 'affiliate', 'list', tierFilter, search],
    queryFn: () => opsApi.getAffiliateList({ ...(tierFilter && { tier: tierFilter }), ...(search && { search }) }),
    staleTime: 15_000,
  });
  const { data: unpaid } = useQuery({ queryKey: ['ops', 'affiliate', 'unpaid'], queryFn: () => opsApi.getAffiliateList({ unpaid: 'true' }), staleTime: 30_000 });

  // Live: auto-refresh on partnership_applications + affiliate_commissions changes
  useLiveInvalidate({
    tables: ['partnership_applications', 'affiliate_commissions', 'profiles'],
    queryKeys: [
      ['ops', 'affiliate', 'stats'],
      ['ops', 'affiliate', 'pending'],
      ['ops', 'affiliate', 'list'],
      ['ops', 'affiliate', 'unpaid'],
    ],
  });

  const approveMut = useMutation({ mutationFn: (id: string) => opsApi.approveAffiliate(id), onSettled: inv });
  const rejectMut = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => opsApi.rejectAffiliate(id, reason),
    onSettled: () => { inv(); setRejectId(null); setRejectReason(''); },
  });
  const tierMut = useMutation({ mutationFn: ({ id, tier }: { id: string; tier: string }) => opsApi.updateAffiliateTier(id, tier), onSettled: inv });
  const statusMut = useMutation({ mutationFn: ({ id, active }: { id: string; active: boolean }) => opsApi.updateAffiliateStatus(id, active), onSettled: inv });
  const payMut = useMutation({ mutationFn: (id: string) => opsApi.payCommission(id), onSettled: inv });

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Affiliate & CTV</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Quản lý CTV · KOL · Hoa hồng · Mời CTV mới</p>
        </div>
        <Button size="sm" onClick={() => setShowInviteModal(true)}><Plus className="h-4 w-4 mr-1" /> Mời CTV</Button>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card className="p-3 text-center"><div className="text-xl font-bold">{stats.ctv || 0}</div><div className="text-[10px] text-muted-foreground">CTV</div></Card>
          <Card className="p-3 text-center"><div className="text-xl font-bold">{stats.kol || 0}</div><div className="text-[10px] text-muted-foreground">KOL</div></Card>
          <Card className="p-3 text-center"><div className="text-xl font-bold">{stats.pending || 0}</div><div className="text-[10px] text-muted-foreground">Chờ duyệt</div></Card>
          <Card className="p-3 text-center"><div className="text-xl font-bold">{formatVND(stats.month_sales || 0)}</div><div className="text-[10px] text-muted-foreground">Doanh số tháng</div></Card>
        </div>
      )}

      {/* Pending applications */}
      {(pending || []).length > 0 && (
        <Card className="p-4">
          <h3 className="text-sm font-semibold mb-3">Đơn đăng ký chờ duyệt ({(pending || []).length})</h3>
          <div className="space-y-2">
            {(pending || []).map((app: any) => (
              <div key={app.id} className="flex items-center justify-between p-3 rounded-lg bg-muted/30">
                <div>
                  <div className="text-sm font-medium">{app.full_name || app.email || 'Ứng viên'}</div>
                  <div className="text-xs text-muted-foreground">{app.application_type || 'CTV'} · {app.phone || app.email || '—'}</div>
                </div>
                <div className="flex gap-1">
                  <Button size="sm" disabled={approveMut.isPending} onClick={() => approveMut.mutate(app.id)}>
                    <Check className="h-3 w-3 mr-1" /> Duyệt
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setRejectId(app.id)}>
                    <X className="h-3 w-3 mr-1" /> Từ chối
                  </Button>
                  {app.user_id && (
                    <Button size="sm" variant="ghost" onClick={() => navigate(`/crm/customers/${app.user_id}`)}>Xem CRM</Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Filters */}
      <div className="flex gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Tìm CTV/KOL..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <select value={tierFilter} onChange={e => setTierFilter(e.target.value)} className="rounded-md border border-input bg-background px-3 py-2 text-sm">
          <option value="">Tất cả tier</option>
          <option value="bronze">Bronze</option>
          <option value="silver">Silver</option>
          <option value="gold">Gold</option>
          <option value="platinum">Platinum</option>
          <option value="diamond">Diamond</option>
        </select>
      </div>

      {/* List */}
      <Card>
        {isLoading ? (
          <div className="p-4 space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
        ) : (list || []).length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Chưa có CTV/KOL nào.</div>
        ) : (
          <table className="w-full text-sm">
            <thead><tr className="border-b bg-muted/30">
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Tên</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Tier</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Doanh số</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Hoa hồng</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Mã</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Hành động</th>
            </tr></thead>
            <tbody>
              {(list || []).map((ctv: any) => (
                <tr key={ctv.id} className="border-b hover:bg-muted/30">
                  <td className="px-4 py-3 font-medium">{ctv.full_name || ctv.display_name || '—'}</td>
                  <td className="px-4 py-3">
                    <select
                      value={ctv.ctv_tier || 'bronze'}
                      onChange={e => tierMut.mutate({ id: ctv.id, tier: e.target.value })}
                      className={`rounded-full px-2 py-0.5 text-xs font-medium border-none ${tierColors[ctv.ctv_tier] || 'bg-muted'}`}
                    >
                      <option value="bronze">Bronze</option>
                      <option value="silver">Silver</option>
                      <option value="gold">Gold</option>
                      <option value="platinum">Platinum</option>
                      <option value="diamond">Diamond</option>
                    </select>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatVND(ctv.total_sales || 0)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatVND(ctv.total_commission || 0)}</td>
                  <td className="px-4 py-3">
                    <button onClick={() => { void copyToClipboard(ctv.referral_code || ''); }} className="text-xs text-primary hover:underline flex items-center gap-1">
                      {ctv.referral_code || '—'} <Copy className="h-3 w-3" />
                    </button>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex gap-1 justify-end">
                      <Button size="sm" variant="outline" onClick={() => payMut.mutate(ctv.id)} disabled={payMut.isPending}>
                        <DollarSign className="h-3 w-3" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => statusMut.mutate({ id: ctv.id, active: !ctv.is_active })}>
                        {ctv.is_active ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* Unpaid commissions */}
      {(unpaid || []).filter((c: any) => (c.unpaid_commission || 0) > 0).length > 0 && (
        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold">Hoa hồng chưa thanh toán</h3>
            <Button size="sm" variant="outline" onClick={() => (unpaid || []).filter((c: any) => (c.unpaid_commission || 0) > 0).forEach((c: any) => payMut.mutate(c.id))} disabled={payMut.isPending}>
              <DollarSign className="h-3 w-3 mr-1" /> Thanh toán tất cả
            </Button>
          </div>
          <div className="space-y-2">
            {(unpaid || []).filter((c: any) => (c.unpaid_commission || 0) > 0).map((c: any) => (
              <div key={c.id} className="flex items-center justify-between p-3 rounded-lg bg-muted/30">
                <div>
                  <span className="text-sm font-medium">{c.full_name || c.display_name || '—'}</span>
                  <span className="text-xs text-muted-foreground ml-2">{formatVND(c.unpaid_commission || c.total_commission || 0)}</span>
                </div>
                <div className="flex gap-1">
                  <Button size="sm" onClick={() => payMut.mutate(c.id)} disabled={payMut.isPending}>
                    <DollarSign className="h-3 w-3 mr-1" /> Thanh toán
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => navigate(`/crm/customers/${c.user_id || c.id}`)}>Chi tiết</Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Cron Jobs */}
      <Card className="p-4">
        <h3 className="text-sm font-semibold mb-3">Tác vụ tự động</h3>
        <div className="space-y-2">
          {[
            { name: 'Auto Approve', schedule: 'Mỗi giờ', desc: 'Tự động duyệt đơn đủ điều kiện' },
            { name: 'Tier Upgrade', schedule: 'CN 17:00', desc: 'Nâng tier theo doanh số tháng' },
            { name: 'Monthly Reset', schedule: 'Ngày 1 hàng tháng', desc: 'Reset doanh số tháng mới' },
          ].map(cron => (
            <div key={cron.name} className="flex items-center justify-between p-3 rounded-lg bg-muted/30">
              <div>
                <div className="text-sm font-medium">{cron.name}</div>
                <div className="text-xs text-muted-foreground">{cron.schedule} · {cron.desc}</div>
              </div>
              <div className="flex gap-1">
                <Button size="sm" variant="outline" onClick={() => guard(async () => { await fetchOk(`/api/ops/affiliate/cron/${cron.name.toLowerCase().replace(/\s/g, '-')}/run`, { method: 'POST' }, 'Lỗi chạy cron'); }, `Không chạy được cron ${cron.name}`)}>
                  <Play className="h-3 w-3 mr-1" /> Chạy ngay
                </Button>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Reject modal */}
      <SimpleModal open={!!rejectId} onClose={() => setRejectId(null)} title="Từ chối đơn đăng ký" footer={<>
        <Button variant="outline" onClick={() => setRejectId(null)}>Hủy</Button>
        <Button variant="destructive" disabled={!rejectReason.trim() || rejectMut.isPending} onClick={() => rejectId && rejectMut.mutate({ id: rejectId, reason: rejectReason })}>
          Từ chối
        </Button>
      </>}>
        <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder="Lý do từ chối..." className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[80px]" />
      </SimpleModal>

      {/* Invite modal */}
      <SimpleModal open={showInviteModal} onClose={() => setShowInviteModal(false)} title="Mời CTV mới" footer={<>
        <Button variant="outline" onClick={() => setShowInviteModal(false)}>Hủy</Button>
        <Button disabled={!inviteEmail.trim()} onClick={() => {
          guard(async () => {
            await fetchOk('/api/ops/affiliate/invite', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email: inviteEmail, role: inviteRole, note: inviteNote }),
            }, 'Lỗi gửi lời mời');
            setShowInviteModal(false); setInviteEmail(''); setInviteNote(''); inv();
          }, 'Không gửi được lời mời CTV');
        }}>
          <Mail className="h-4 w-4 mr-1" /> Gửi lời mời
        </Button>
      </>}>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">Email hoặc SĐT</label>
            <Input value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} placeholder="email@example.com hoặc 0912345678" />
          </div>
          <div>
            <label className="text-sm font-medium">Vai trò</label>
            <div className="flex gap-3 mt-1">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="radio" name="role" value="ctv" checked={inviteRole === 'ctv'} onChange={() => setInviteRole('ctv')} /> CTV
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="radio" name="role" value="kol" checked={inviteRole === 'kol'} onChange={() => setInviteRole('kol')} /> KOL
              </label>
            </div>
          </div>
          <div>
            <label className="text-sm font-medium">Ghi chú</label>
            <textarea value={inviteNote} onChange={e => setInviteNote(e.target.value)} placeholder="Ghi chú thêm..." className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[60px]" />
          </div>
        </div>
      </SimpleModal>
    </div>
  );
}
