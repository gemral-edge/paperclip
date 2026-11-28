import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from '@/lib/router';
import {
  Mail,
  Send,
  MousePointer,
  DollarSign,
  Search,
  Filter,
  ChevronLeft,
  ChevronRight,
  Copy,
  Eye,
  Loader2,
  Trash2,
  AlertTriangle,
  X,
} from 'lucide-react';
import { supabase } from '../../lib/supabaseClient';

// ============================================================================
// Constants
// ============================================================================

const PAGE_SIZE = 15;

const STATUS_CONFIG = {
  draft: { label: 'Bản nháp', color: 'text-muted-foreground', bg: 'bg-bg-4' },
  sending: { label: 'Đang gửi', color: 'text-[#00F0FF]', bg: 'bg-[#00F0FF]/12' },
  sent: { label: 'Đã gửi', color: 'text-[#3AF7A6]', bg: 'bg-[#3AF7A6]/12' },
  failed: { label: 'Thất bại', color: 'text-[#FF6B6B]', bg: 'bg-[#FF6B6B]/10' },
};

const TRACK_CONFIG = {
  wealth: { label: 'Wealth', color: 'text-[#FFBD59]' },
  wellness: { label: 'Wellness', color: 'text-[#6A5BFF]' },
  integration: { label: 'Integration', color: 'text-[#3AF7A6]' },
};

// ============================================================================
// Helpers
// ============================================================================

function formatNumber(num) {
  if (num == null) return '0';
  return Number(num).toLocaleString('vi-VN');
}

function formatVND(amount) {
  if (amount == null) return '0 ₫';
  return Number(amount).toLocaleString('vi-VN') + ' ₫';
}

function formatPercent(val) {
  if (val == null) return '0%';
  return Number(val).toFixed(1) + '%';
}

function formatDate(dateStr) {
  if (!dateStr) return '\u2014';
  const date = new Date(dateStr);
  return date.toLocaleDateString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

// ============================================================================
// KPI Card
// ============================================================================

function KPICard({ icon: Icon, label, value, iconColor, iconBg }) {
  return (
    <div className="bg-card border border-border rounded-xl p-3.5 text-center shadow-sm">
      <div className={`w-9 h-9 rounded-lg ${iconBg} flex items-center justify-center mx-auto mb-2`}>
        <Icon size={20} className={iconColor} />
      </div>
      <div className="text-[22px] font-bold text-foreground">{value}</div>
      <div className="text-[11px] text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}

// ============================================================================
// Progress Bar (mini, inline in table)
// ============================================================================

function MiniProgressBar({ value, color }) {
  const clampedValue = Math.min(Math.max(value || 0, 0), 100);
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full ${color}`}
          style={{ width: `${clampedValue}%` }}
        />
      </div>
      <span className="text-[11px] text-muted-foreground w-[36px] text-right">{formatPercent(value)}</span>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export default function CCEmailCampaigns() {
  const navigate = useNavigate();

  // --- State ---
  const [campaigns, setCampaigns] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [kpis, setKpis] = useState({
    total_sent: 0,
    avg_open_rate: 0,
    avg_click_rate: 0,
    total_revenue: 0,
  });
  const [kpiLoading, setKpiLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [trackFilter, setTrackFilter] = useState('');
  const [page, setPage] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  // --- Fetch KPIs ---
  useEffect(() => {
    let cancelled = false;

    async function fetchKPIs() {
      setKpiLoading(true);
      try {
        // Compute real stats directly from cc_email_sends
        const [sentRes, openedRes, clickedRes, revenueRes] = await Promise.all([
          supabase.from('cc_email_sends').select('*', { count: 'exact', head: true }),
          supabase.from('cc_email_sends').select('*', { count: 'exact', head: true }).not('first_opened_at', 'is', null),
          supabase.from('cc_email_sends').select('*', { count: 'exact', head: true }).not('first_clicked_at', 'is', null),
          supabase.from('cc_email_campaigns').select('revenue_attributed').eq('status', 'sent'),
        ]);
        const total_sent = sentRes.count || 0;
        const total_opened = openedRes.count || 0;
        const total_clicked = clickedRes.count || 0;
        const avg_open_rate = total_sent > 0 ? (total_opened / total_sent) * 100 : 0;
        const avg_click_rate = total_sent > 0 ? (total_clicked / total_sent) * 100 : 0;
        const total_revenue = (revenueRes.data || []).reduce((s, r) => s + (r.revenue_attributed || 0), 0);
        if (!cancelled) {
          setKpis({ total_sent, avg_open_rate, avg_click_rate, total_revenue });
        }
      } catch (err) {
        console.error('KPI fetch error:', err);
      } finally {
        if (!cancelled) setKpiLoading(false);
      }
    }

    fetchKPIs();
    return () => { cancelled = true; };
  }, []);

  // --- Fetch Campaigns ---
  useEffect(() => {
    let cancelled = false;

    async function fetchCampaigns() {
      setLoading(true);
      setError(null);
      try {
        let query = supabase
          .from('cc_email_campaigns')
          .select('*', { count: 'exact' })
          .order('created_at', { ascending: false })
          .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

        if (search.trim()) {
          query = query.ilike('name', `%${search.trim()}%`);
        }
        if (statusFilter) {
          query = query.eq('status', statusFilter);
        }
        if (trackFilter) {
          query = query.eq('track', trackFilter);
        }

        const { data, count, error: fetchErr } = await query;
        if (fetchErr) throw fetchErr;
        const rows = data ?? [];

        // Enrich with real stats from cc_email_sends
        let enriched = rows;
        if (rows.length > 0) {
          const ids = rows.map((c) => c.id);
          const { data: sends } = await supabase
            .from('cc_email_sends')
            .select('campaign_id, first_opened_at, first_clicked_at')
            .in('campaign_id', ids);
          if (sends?.length) {
            const statsMap = {};
            sends.forEach((s) => {
              if (!statsMap[s.campaign_id]) statsMap[s.campaign_id] = { sent: 0, opened: 0, clicked: 0 };
              statsMap[s.campaign_id].sent++;
              if (s.first_opened_at) statsMap[s.campaign_id].opened++;
              if (s.first_clicked_at) statsMap[s.campaign_id].clicked++;
            });
            enriched = rows.map((c) => {
              const st = statsMap[c.id];
              if (!st) return c;
              return {
                ...c,
                sent_count: st.sent,
                open_rate: st.sent > 0 ? (st.opened / st.sent) * 100 : 0,
                click_rate: st.sent > 0 ? (st.clicked / st.sent) * 100 : 0,
              };
            });
          }
        }

        if (!cancelled) {
          setCampaigns(enriched);
          setTotalCount(count ?? 0);
        }
      } catch (err) {
        console.error('Campaign fetch error:', err);
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchCampaigns();
    return () => { cancelled = true; };
  }, [search, statusFilter, trackFilter, page]);

  // Reset page when filters change
  useEffect(() => {
    setPage(0);
  }, [search, statusFilter, trackFilter]);

  // --- Handlers ---
  const handleRowClick = useCallback((id) => {
    navigate(`/GEM/cc/email/${id}`);
  }, [navigate]);

  const handleClone = useCallback(async (e, campaign) => {
    e.stopPropagation();
    try {
      const { id, created_at, updated_at, ...rest } = campaign;
      const { data, error: cloneErr } = await supabase
        .from('cc_email_campaigns')
        .insert({
          ...rest,
          name: `${campaign.name} (Bản sao)`,
          status: 'draft',
        })
        .select()
        .single();
      if (cloneErr) throw cloneErr;
      if (data) {
        setCampaigns((prev) => [data, ...prev]);
        setTotalCount((prev) => prev + 1);
      }
    } catch (err) {
      console.error('Clone error:', err);
    }
  }, []);

  const handleDeleteClick = useCallback((e, campaign) => {
    e.stopPropagation();
    setDeleteTarget(campaign);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const { error: delErr } = await supabase
        .from('cc_email_campaigns')
        .delete()
        .eq('id', deleteTarget.id);
      if (delErr) throw delErr;
      setCampaigns((prev) => prev.filter((c) => c.id !== deleteTarget.id));
      setTotalCount((prev) => prev - 1);
      setDeleteTarget(null);
    } catch (err) {
      console.error('Delete error:', err);
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget]);

  // --- Render ---
  return (
    <div className="space-y-5">
      {/* Page Title */}
      <div>
        <h1 className="text-[20px] font-bold text-foreground mb-1">Email Campaigns</h1>
        <p className="text-[12px] text-muted-foreground">Quản lý và theo dõi các chiến dịch email marketing</p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-4 gap-2.5 max-md:grid-cols-2">
        <KPICard
          icon={Send}
          label="Đã Gửi"
          value={kpiLoading ? '\u2014' : formatNumber(kpis.total_sent)}
          iconColor="text-[#00F0FF]"
          iconBg="bg-[#00F0FF]/12"
        />
        <KPICard
          icon={Mail}
          label="Tỷ Lệ Mở"
          value={kpiLoading ? '\u2014' : formatPercent(kpis.avg_open_rate)}
          iconColor="text-[#FFBD59]"
          iconBg="bg-[#FFBD59]/15"
        />
        <KPICard
          icon={MousePointer}
          label="Tỷ Lệ Click"
          value={kpiLoading ? '\u2014' : formatPercent(kpis.avg_click_rate)}
          iconColor="text-[#6A5BFF]"
          iconBg="bg-[#6A5BFF]/12"
        />
        <KPICard
          icon={DollarSign}
          label="Doanh Thu"
          value={kpiLoading ? '\u2014' : formatVND(kpis.total_revenue)}
          iconColor="text-[#3AF7A6]"
          iconBg="bg-[#3AF7A6]/12"
        />
      </div>

      {/* Filters Row */}
      <div className="flex items-center gap-2.5 flex-wrap">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px] max-w-[320px]">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-txt-3" />
          <input
            className="h-8 w-full pl-8 pr-3 text-[12px] bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none transition-colors"
            placeholder="Tìm tên campaign..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* Status Filter */}
        <div className="w-[150px] shrink-0">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="h-8 w-full px-2.5 text-[12px] bg-background border border-border rounded-lg text-foreground focus:outline-none focus:border-primary/40 transition-colors"
          >
            <option value="">Tất cả trạng thái</option>
            <option value="draft">Bản nháp</option>
            <option value="sending">Đang gửi</option>
            <option value="sent">Đã gửi</option>
            <option value="failed">Thất bại</option>
          </select>
        </div>

        {/* Track Filter */}
        <div className="w-[140px] shrink-0">
          <select
            value={trackFilter}
            onChange={(e) => setTrackFilter(e.target.value)}
            className="h-8 w-full px-2.5 text-[12px] bg-background border border-border rounded-lg text-foreground focus:outline-none focus:border-primary/40 transition-colors"
          >
            <option value="">Tất cả track</option>
            <option value="wealth">Wealth</option>
            <option value="wellness">Wellness</option>
            <option value="integration">Integration</option>
          </select>
        </div>
      </div>

      {/* Campaigns Table */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 size={24} className="animate-spin text-txt-3" />
        </div>
      ) : error ? (
        <div className="text-center py-10 px-5">
          <Mail size={32} className="mx-auto mb-2.5 text-[#FF6B6B]/40" />
          <div className="text-[14px] text-muted-foreground">Không thể tải dữ liệu</div>
          <div className="text-[12px] text-muted-foreground/70 mt-1">{error}</div>
          <button
            onClick={() => setPage((p) => p)}
            className="mt-3 h-8 px-3.5 text-[12px] font-semibold rounded-lg border-none cursor-pointer inline-flex items-center gap-1.5 bg-[#FFBD59]/15 text-[#FFBD59] hover:bg-[#FFBD59]/25 transition-colors"
          >
            Thử lại
          </button>
        </div>
      ) : campaigns.length === 0 ? (
        <div className="text-center py-10 px-5">
          <Mail size={32} className="mx-auto mb-2.5 text-muted-foreground/30" />
          <div className="text-[14px] text-muted-foreground">Chưa có chiến dịch email</div>
          <div className="text-[12px] text-muted-foreground/70 mt-1">
            {search || statusFilter || trackFilter
              ? 'Không tìm thấy kết quả phù hợp với bộ lọc hiện tại'
              : 'Tạo chiến dịch email đầu tiên để bắt đầu'}
          </div>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="bg-muted/50">
                  <th className="text-left p-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border whitespace-nowrap">
                    Chiến dịch
                  </th>
                  <th className="text-left p-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border whitespace-nowrap">
                    Gửi
                  </th>
                  <th className="text-left p-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border whitespace-nowrap min-w-[120px]">
                    Mở
                  </th>
                  <th className="text-left p-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border whitespace-nowrap min-w-[120px]">
                    Click
                  </th>
                  <th className="text-left p-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border whitespace-nowrap">
                    ROI
                  </th>
                  <th className="text-left p-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border whitespace-nowrap">
                    Thao tác
                  </th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => {
                  const statusCfg = STATUS_CONFIG[c.status] || STATUS_CONFIG.draft;
                  const trackCfg = TRACK_CONFIG[c.track];

                  return (
                    <tr
                      key={c.id}
                      onClick={() => handleRowClick(c.id)}
                      className="cursor-pointer hover:[&>td]:bg-muted/50 transition-colors"
                    >
                      {/* Campaign name + subject + date + track */}
                      <td className="p-2.5 border-b border-border align-middle max-w-[300px]">
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[12px] font-semibold text-foreground truncate">
                              {c.name || 'Chiến dịch không tên'}
                            </span>
                            <span className={`inline-flex items-center h-[22px] px-2 text-[10px] font-semibold rounded ${statusCfg.bg} ${statusCfg.color}`}>
                              {statusCfg.label}
                            </span>
                          </div>
                          <div className="text-[11px] text-muted-foreground truncate">
                            {c.subject || '\u2014'}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-[10px] text-muted-foreground">{formatDate(c.created_at)}</span>
                            {trackCfg && (
                              <span className={`text-[10px] font-medium ${trackCfg.color}`}>
                                {trackCfg.label}
                              </span>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* Sent count */}
                      <td className="p-2.5 border-b border-border align-middle whitespace-nowrap">
                        <span className="text-[12px] font-medium text-foreground">
                          {formatNumber(c.sent_count)}
                        </span>
                      </td>

                      {/* Open rate with progress bar */}
                      <td className="p-2.5 border-b border-border align-middle">
                        <MiniProgressBar value={c.open_rate} color="bg-[#FFBD59]" />
                      </td>

                      {/* Click rate with progress bar */}
                      <td className="p-2.5 border-b border-border align-middle">
                        <MiniProgressBar value={c.click_rate} color="bg-[#6A5BFF]" />
                      </td>

                      {/* ROI */}
                      <td className="p-2.5 border-b border-border align-middle whitespace-nowrap">
                        <span className={`text-[12px] font-medium ${
                          (c.roi ?? 0) > 0 ? 'text-[#3AF7A6]' : (c.roi ?? 0) < 0 ? 'text-[#FF6B6B]' : 'text-txt-3'
                        }`}>
                          {c.roi != null ? `${Number(c.roi).toFixed(1)}%` : '\u2014'}
                        </span>
                      </td>

                      {/* Actions */}
                      <td className="p-2.5 border-b border-border align-middle">
                        <div className="flex gap-1">
                          <button
                            onClick={(e) => { e.stopPropagation(); handleRowClick(c.id); }}
                            className="h-7 px-2.5 text-[11px] font-semibold rounded-md border border-border bg-transparent text-txt-2 hover:bg-bg-3 hover:text-txt transition-colors cursor-pointer inline-flex items-center gap-1"
                          >
                            <Eye size={12} />
                            Xem
                          </button>
                          <button
                            onClick={(e) => handleClone(e, c)}
                            className="h-7 px-2.5 text-[11px] font-semibold rounded-md border border-border bg-transparent text-txt-2 hover:bg-bg-3 hover:text-txt transition-colors cursor-pointer inline-flex items-center gap-1"
                          >
                            <Copy size={12} />
                            Clone
                          </button>
                          <button
                            onClick={(e) => handleDeleteClick(e, c)}
                            className="h-7 px-2.5 text-[11px] font-semibold rounded-md border border-[#FF6B6B]/20 bg-transparent text-[#FF6B6B]/60 hover:bg-[#FF6B6B]/10 hover:text-[#FF6B6B] transition-colors cursor-pointer inline-flex items-center gap-1"
                          >
                            <Trash2 size={12} />
                            Xóa
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-1">
              <span className="text-[11px] text-txt-3">
                Trang {page + 1} / {totalPages} ({formatNumber(totalCount)} chiến dịch)
              </span>
              <div className="flex items-center gap-1">
                <button
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  className="h-7 px-2 text-[11px] font-semibold rounded-md border border-border bg-transparent text-txt-2 hover:bg-bg-3 hover:text-txt transition-colors cursor-pointer inline-flex items-center gap-1 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <ChevronLeft size={14} />
                  Trước
                </button>
                <button
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  className="h-7 px-2 text-[11px] font-semibold rounded-md border border-border bg-transparent text-txt-2 hover:bg-bg-3 hover:text-txt transition-colors cursor-pointer inline-flex items-center gap-1 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Sau
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Delete Confirmation Dialog */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-card border border-border rounded-xl p-5 w-full max-w-[380px] shadow-2xl">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-destructive/12 flex items-center justify-center">
                  <AlertTriangle size={16} className="text-destructive" />
                </div>
                <h3 className="text-[14px] font-bold text-foreground">Xác nhận xóa</h3>
              </div>
              <button
                onClick={() => setDeleteTarget(null)}
                className="w-7 h-7 rounded-md bg-transparent border-none text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer flex items-center justify-center"
              >
                <X size={14} />
              </button>
            </div>
            <p className="text-[12px] text-muted-foreground mb-1">Bạn có chắc muốn xóa chiến dịch này?</p>
            <p className="text-[12px] font-semibold text-foreground mb-4 truncate">
              {deleteTarget.name || 'Chiến dịch không tên'}
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="h-8 px-3.5 text-[12px] font-semibold rounded-lg border border-border bg-transparent text-foreground/70 hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
              >
                Hủy
              </button>
              <button
                onClick={handleDeleteConfirm}
                disabled={deleting}
                className="h-8 px-3.5 text-[12px] font-semibold rounded-lg border-none bg-[#FF6B6B]/15 text-[#FF6B6B] hover:bg-[#FF6B6B]/25 transition-colors cursor-pointer inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                {deleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                {deleting ? 'Đang xóa...' : 'Xóa chiến dịch'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
