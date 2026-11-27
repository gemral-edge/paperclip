import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { copyToClipboard } from '@/lib/clipboard';
import { useParams, useNavigate } from '@/lib/router';
import {
  ArrowLeft,
  Mail,
  Send,
  Copy,
  Users,
  Eye,
  MousePointerClick,
  AlertTriangle,
  DollarSign,
  Download,
  Search,
  ChevronDown,
  ChevronUp,
  Check,
  Loader2,
  Clock,
  RefreshCw,
  ShoppingCart,
  Target,
  FileText,
  X,
} from 'lucide-react';
import { supabase } from '../../lib/supabaseClient';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

// ============================================================================
// Helpers
// ============================================================================

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatNumber(n) {
  if (n == null) return '0';
  return Number(n).toLocaleString('vi-VN');
}

function formatVND(n) {
  if (n == null) return '0 ₫';
  return Number(n).toLocaleString('vi-VN') + ' ₫';
}

function pct(part, total) {
  if (!total) return '0';
  return ((part / total) * 100).toFixed(1);
}

// Build real chart data from cc_email_sends
function buildRealChartData(sends, mode) {
  if (!sends || sends.length === 0) return [];

  const buckets = {};

  sends.forEach((s) => {
    const openTs = s.first_opened_at;
    const clickTs = s.first_clicked_at;

    const addBucket = (ts, type) => {
      if (!ts) return;
      const d = new Date(ts);
      let key;
      if (mode === 'hourly') {
        key = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
      } else {
        key = d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
      }
      if (!buckets[key]) buckets[key] = { time: key, opens: 0, clicks: 0 };
      buckets[key][type]++;
    };

    addBucket(openTs, 'opens');
    addBucket(clickTs, 'clicks');
  });

  return Object.values(buckets).sort((a, b) => a.time.localeCompare(b.time));
}

// ============================================================================
// Status helpers
// ============================================================================

function statusIcon(status) {
  switch (status) {
    case 'opened':
      return <Check size={12} className="text-emerald-500" />;
    case 'delivered':
      return <Mail size={12} className="text-blue-500" />;
    case 'bounced':
      return <X size={12} className="text-red-500" />;
    default:
      return <Clock size={12} className="text-muted-foreground" />;
  }
}

function statusLabel(status) {
  switch (status) {
    case 'opened': return 'Đã mở';
    case 'delivered': return 'Đã nhận';
    case 'bounced': return 'Bounce';
    case 'sent': return 'Đã gửi';
    default: return status || '—';
  }
}

function statusBadgeClasses(status) {
  switch (status) {
    case 'opened':
      return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
    case 'delivered':
      return 'bg-blue-500/10 text-blue-600 dark:text-blue-400';
    case 'bounced':
      return 'bg-red-500/10 text-red-600 dark:text-red-400';
    case 'sent':
      return 'bg-violet-500/10 text-violet-600 dark:text-violet-400';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

// ============================================================================
// Custom Tooltip for Chart
// ============================================================================

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-popover border border-border rounded-lg p-2.5 text-[11px] shadow-md">
      <div className="text-muted-foreground mb-1">{label}</div>
      {payload.map((entry) => (
        <div key={entry.dataKey} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
          <span className="text-muted-foreground">
            {entry.dataKey === 'opens' ? 'Lượt mở' : 'Lượt click'}:
          </span>
          <span className="text-foreground font-semibold">{entry.value}</span>
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

const SENDS_PER_PAGE = 15;

export default function CCEmailCampaignDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [campaign, setCampaign] = useState(null);
  const [sends, setSends] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [chartTab, setChartTab] = useState('hourly');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // --------------------------------------------------------------------------
  // Fetch
  // --------------------------------------------------------------------------

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [campaignRes, sendsRes] = await Promise.all([
        supabase.from('cc_email_campaigns').select('*').eq('id', id).single(),
        supabase.from('cc_email_sends').select('*').eq('campaign_id', id).order('created_at', { ascending: false }),
      ]);
      if (campaignRes.error) throw campaignRes.error;
      setCampaign(campaignRes.data);
      setSends(sendsRes.data || []);
    } catch (err) {
      setError(err.message || 'Không thể tải dữ liệu chiến dịch');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { if (id) fetchData(); }, [id, fetchData]);

  // --------------------------------------------------------------------------
  // Computed
  // --------------------------------------------------------------------------

  const kpis = useMemo(() => {
    if (!campaign) return null;
    // Compute live from cc_email_sends (campaign.total_* columns are not auto-updated)
    const sent = sends.length;
    const opened = sends.filter((s) => s.first_opened_at).length;
    const clicked = sends.filter((s) => s.first_clicked_at).length;
    const bounced = sends.filter((s) => s.status === 'bounced' || s.status === 'failed').length;
    const delivered = sent - bounced;
    const revenue = campaign.revenue_attributed || 0;
    return {
      sent,
      delivered,
      deliveredPct: pct(delivered, sent),
      opened,
      openRate: pct(opened, sent),
      clicked,
      clickRate: pct(clicked, sent),
      bounced,
      bounceRate: pct(bounced, sent),
      revenue,
    };
  }, [campaign, sends]);

  const chartData = useMemo(() => buildRealChartData(sends, chartTab), [sends, chartTab]);
  const hasChartData = chartData.length > 0;

  const roi = useMemo(() => {
    if (!campaign) return { cost: 0, revenue: 0, roiPct: 0, conversions: 0, conversionSends: [] };
    const cost = campaign.cost || 0;
    const revenue = campaign.revenue_attributed || 0;
    const roiPct = cost > 0 ? (((revenue - cost) / cost) * 100).toFixed(1) : 0;
    const conversionSends = sends.filter((s) => s.conversion_event);
    return { cost, revenue, roiPct, conversions: conversionSends.length, conversionSends };
  }, [campaign, sends]);

  const filteredSends = useMemo(() => {
    let result = sends;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (s) => (s.recipient_email || '').toLowerCase().includes(q) || (s.recipient_name || '').toLowerCase().includes(q)
      );
    }
    if (statusFilter !== 'all') result = result.filter((s) => s.status === statusFilter);
    return result;
  }, [sends, searchQuery, statusFilter]);

  const totalPages = Math.ceil(filteredSends.length / SENDS_PER_PAGE);
  const paginatedSends = filteredSends.slice((currentPage - 1) * SENDS_PER_PAGE, currentPage * SENDS_PER_PAGE);

  // --------------------------------------------------------------------------
  // Actions
  // --------------------------------------------------------------------------

  const handleCopyHTML = useCallback(() => {
    if (!campaign?.html_body) return;
    void copyToClipboard(campaign.html_body).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [campaign]);

  const handleDownloadHTML = useCallback(() => {
    if (!campaign?.html_body) return;
    const blob = new Blob([campaign.html_body], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `email-${campaign.name || id}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }, [campaign, id]);

  const handleExportCSV = useCallback(() => {
    if (!filteredSends.length) return;
    const header = 'Email,Trạng Thái,Lượt Mở,Lượt Click,Chuyển Đổi\n';
    const rows = filteredSends.map((s) =>
      `${s.recipient_email || ''},${statusLabel(s.status)},${s.open_count || 0},${s.click_count || 0},${s.conversion_event || ''}`
    ).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `recipients-${id}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredSends, id]);

  // --------------------------------------------------------------------------
  // Loading / Error
  // --------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={24} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-20 px-5">
        <AlertTriangle size={32} className="mx-auto mb-2.5 text-destructive/60" />
        <div className="text-[14px] text-muted-foreground">{error}</div>
        <button
          onClick={fetchData}
          className="mt-3 h-8 px-3.5 text-[12px] font-semibold rounded-lg border border-border bg-transparent text-foreground cursor-pointer inline-flex items-center gap-1.5 hover:bg-accent transition-colors"
        >
          <RefreshCw size={14} /> Thử lại
        </button>
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="text-center py-20 px-5">
        <Mail size={32} className="mx-auto mb-2.5 text-muted-foreground/30" />
        <div className="text-[14px] text-muted-foreground">Không tìm thấy chiến dịch</div>
      </div>
    );
  }

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <div className="max-w-[1000px] mx-auto px-6 py-5 max-md:px-4">

      {/* 1. Header */}
      <div className="flex items-start justify-between gap-3 mb-5 max-md:flex-col">
        <div className="flex items-start gap-3 min-w-0">
          <button
            onClick={() => navigate('/GEM/cc/email')}
            className="h-8 px-3 text-[12px] font-semibold rounded-lg border border-border bg-transparent text-foreground/70 cursor-pointer inline-flex items-center gap-1.5 hover:bg-accent hover:text-foreground transition-colors flex-shrink-0 mt-0.5"
          >
            <ArrowLeft size={14} /> Quay lại
          </button>
          <div className="min-w-0">
            <h1 className="text-[20px] font-bold text-foreground mb-0.5 truncate">
              {campaign.name || 'Chiến dịch email'}
            </h1>
            <p className="text-[12px] text-muted-foreground truncate">{campaign.subject}</p>
          </div>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <button
            onClick={() => navigate('/GEM/cc/ai-gen', { state: { prefill: { subject: campaign?.subject, html_body: campaign?.html_body, track: campaign?.track, pillar: campaign?.pillar } } })}
            className="h-8 px-3.5 text-[12px] font-semibold rounded-lg border-none cursor-pointer inline-flex items-center gap-1.5 bg-violet-500/10 text-violet-600 dark:text-violet-400 hover:bg-violet-500/20 transition-colors"
          >
            <RefreshCw size={14} /> Tái Sử Dụng
          </button>
          <button
            onClick={async () => {
              if (!campaign) return;
              const { id, created_at, updated_at, sent_at, sent_count, open_rate, click_rate, revenue_attributed, roi, cost, ...rest } = campaign;
              const { data: cloned, error: cloneErr } = await supabase
                .from('cc_email_campaigns')
                .insert({ ...rest, name: `${campaign.name} (Bản sao)`, status: 'draft' })
                .select()
                .single();
              if (cloneErr) { console.error('[Clone] error:', cloneErr); return; }
              if (cloned) navigate(`/GEM/cc/email/${cloned.id}`);
            }}
            className="h-8 px-3.5 text-[12px] font-semibold rounded-lg border-none cursor-pointer inline-flex items-center gap-1.5 bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 transition-colors"
          >
            <Copy size={14} /> Clone
          </button>
        </div>
      </div>

      {/* 2. Campaign Info */}
      <div className="bg-card border border-border rounded-xl p-4 mb-4">
        <h3 className="text-[15px] font-semibold text-foreground mb-3">Thông Tin Chiến Dịch</h3>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 max-md:grid-cols-1">
          <InfoRow label="Chủ đề" value={campaign.subject || '—'} />
          <InfoRow
            label="Từ"
            value={campaign.from_name ? `${campaign.from_name} <${campaign.from_email || ''}>` : campaign.from_email || '—'}
          />
          <InfoRow label="Gửi lúc" value={formatDate(campaign.sent_at)} />
          <InfoRow label="Đối tượng" value={`${campaign.audience_type || 'Tất cả'} (${formatNumber(campaign.audience_count || campaign.total_sent)} người)`} />
          <InfoRow label="Track" value={campaign.track || '—'} />
          <InfoRow
            label="Tags"
            value={
              campaign.tags?.length > 0 ? (
                <div className="flex gap-1 flex-wrap">
                  {(Array.isArray(campaign.tags) ? campaign.tags : [campaign.tags]).map((tag) => (
                    <span key={tag} className="inline-flex items-center h-[22px] px-2 text-[10px] font-semibold rounded bg-violet-500/10 text-violet-600 dark:text-violet-400">
                      {tag}
                    </span>
                  ))}
                </div>
              ) : '—'
            }
          />
        </div>
      </div>

      {/* 3. KPI Cards */}
      {kpis && (
        <div className="grid grid-cols-6 gap-2.5 mb-4 max-lg:grid-cols-3 max-md:grid-cols-2">
          <KPICard icon={Send} label="Gửi" value={formatNumber(kpis.sent)} color="text-cyan-500" />
          <KPICard icon={Mail} label="Nhận" value={formatNumber(kpis.delivered)} sub={`${kpis.deliveredPct}%`} color="text-emerald-500" />
          <KPICard icon={Eye} label="Mở" value={formatNumber(kpis.opened)} sub={`${kpis.openRate}%`} color="text-amber-500" />
          <KPICard icon={MousePointerClick} label="Click" value={formatNumber(kpis.clicked)} sub={`${kpis.clickRate}%`} color="text-violet-500" />
          <KPICard icon={AlertTriangle} label="Thoát" value={formatNumber(kpis.bounced)} sub={`${kpis.bounceRate}%`} color="text-red-500" />
          <KPICard icon={DollarSign} label="Doanh Thu" value={formatVND(kpis.revenue)} color="text-emerald-500" />
        </div>
      )}

      {/* 4. Performance Chart */}
      <div className="bg-card border border-border rounded-xl p-4 mb-4">
        <div className="flex items-center justify-between mb-3 max-md:flex-col max-md:items-start max-md:gap-2">
          <h3 className="text-[15px] font-semibold text-foreground">Hiệu Suất Gửi</h3>
          <div className="flex gap-0 bg-muted rounded-lg p-0.5 w-fit">
            {['hourly', 'daily'].map((tab) => (
              <button
                key={tab}
                onClick={() => setChartTab(tab)}
                className={`h-7 px-3.5 text-[11px] font-semibold rounded-md border-none cursor-pointer transition-colors ${
                  chartTab === tab
                    ? 'bg-background text-foreground shadow-sm'
                    : 'bg-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {tab === 'hourly' ? 'Theo Giờ' : 'Theo Ngày'}
              </button>
            ))}
          </div>
        </div>

        {hasChartData ? (
          <>
            <div className="h-[240px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 5, left: 0 }}>
                  <defs>
                    <linearGradient id="gradOpens" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gradClicks" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="time" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }} axisLine={{ stroke: 'hsl(var(--border))' }} tickLine={false} />
                  <YAxis tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }} axisLine={false} tickLine={false} />
                  <Tooltip content={<ChartTooltip />} />
                  <Area type="monotone" dataKey="opens" stroke="#f59e0b" strokeWidth={2} fill="url(#gradOpens)" name="Lượt mở" />
                  <Area type="monotone" dataKey="clicks" stroke="#8b5cf6" strokeWidth={2} fill="url(#gradClicks)" name="Lượt click" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="flex items-center gap-5 mt-2.5 justify-center">
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="w-3 h-[3px] rounded-full bg-amber-500" /> Lượt mở
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="w-3 h-[3px] rounded-full bg-violet-500" /> Lượt click
              </div>
            </div>
          </>
        ) : (
          <div className="text-center py-10">
            <Eye size={28} className="mx-auto mb-2 text-muted-foreground/30" />
            <div className="text-[13px] text-muted-foreground">Chưa có dữ liệu mở/click</div>
            <div className="text-[11px] text-muted-foreground/60 mt-1">Dữ liệu sẽ cập nhật khi người nhận tương tác với email</div>
          </div>
        )}
      </div>

      {/* 5. ROI & Conversions */}
      <div className="bg-card border border-border rounded-xl p-4 mb-4">
        <h3 className="text-[15px] font-semibold text-foreground mb-3">ROI & Chuyển Đổi</h3>
        <div className="grid grid-cols-4 gap-2.5 mb-4 max-md:grid-cols-2">
          <ROICard icon={DollarSign} label="Chi phí gửi" value={formatVND(roi.cost)} iconClass="text-red-500" />
          <ROICard icon={DollarSign} label="Doanh thu gán" value={formatVND(roi.revenue)} iconClass="text-emerald-500" />
          <ROICard icon={Target} label="ROI" value={`${roi.roiPct}%`} iconClass="text-amber-500" />
          <ROICard icon={ShoppingCart} label="Số đơn chuyển đổi" value={roi.conversions} iconClass="text-violet-500" />
        </div>

        {roi.conversionSends?.length > 0 ? (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="bg-muted/50">
                  <th className="text-left p-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border whitespace-nowrap">Email</th>
                  <th className="text-left p-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border whitespace-nowrap">Sự Kiện</th>
                  <th className="text-left p-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border whitespace-nowrap">Thời Gian</th>
                </tr>
              </thead>
              <tbody>
                {roi.conversionSends.map((s) => (
                  <tr key={s.id} className="hover:bg-accent transition-colors">
                    <td className="p-2.5 text-foreground border-b border-border/50 align-middle">{s.recipient_email || '—'}</td>
                    <td className="p-2.5 border-b border-border/50 align-middle">
                      <span className="inline-flex items-center h-[22px] px-2 text-[10px] font-semibold rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                        {s.conversion_event}
                      </span>
                    </td>
                    <td className="p-2.5 text-muted-foreground border-b border-border/50 align-middle">{formatDate(s.conversion_at || s.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-6">
            <ShoppingCart size={24} className="mx-auto mb-1.5 text-muted-foreground/30" />
            <div className="text-[12px] text-muted-foreground">Chưa có chuyển đổi nào</div>
          </div>
        )}
      </div>

      {/* 6. Recipients Table */}
      <div className="bg-card border border-border rounded-xl p-4 mb-4">
        <div className="flex items-center justify-between mb-3 max-md:flex-col max-md:items-start max-md:gap-2">
          <h3 className="text-[15px] font-semibold text-foreground">
            Danh Sách Người Nhận ({formatNumber(filteredSends.length)})
          </h3>
          <button
            onClick={handleExportCSV}
            className="h-8 px-3.5 text-[12px] font-semibold rounded-lg border-none cursor-pointer inline-flex items-center gap-1.5 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 transition-colors"
          >
            <Download size={14} /> Xuất CSV
          </button>
        </div>

        <div className="flex items-center gap-2.5 mb-3 max-md:flex-col max-md:items-stretch">
          <div className="relative flex-1 max-w-[280px] max-md:max-w-none">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
              className="h-8 w-full pl-8 pr-3 text-[12px] bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none transition-colors"
              placeholder="Tìm theo email..."
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setCurrentPage(1); }}
            className="h-8 px-2.5 pr-7 text-[12px] bg-background border border-border rounded-lg text-foreground focus:border-primary/40 focus:outline-none transition-colors cursor-pointer appearance-none"
          >
            <option value="all">Tất cả trạng thái</option>
            <option value="sent">Đã gửi</option>
            <option value="opened">Đã mở</option>
            <option value="delivered">Đã nhận</option>
            <option value="bounced">Bounce</option>
          </select>
        </div>

        {paginatedSends.length > 0 ? (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="bg-muted/50">
                  <th className="text-left p-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border whitespace-nowrap">Email</th>
                  <th className="text-left p-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border whitespace-nowrap">Trạng Thái</th>
                  <th className="text-center p-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border whitespace-nowrap">Mở</th>
                  <th className="text-center p-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border whitespace-nowrap">Click</th>
                  <th className="text-left p-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border whitespace-nowrap">Chuyển Đổi</th>
                </tr>
              </thead>
              <tbody>
                {paginatedSends.map((send) => (
                  <tr key={send.id} className="hover:bg-accent transition-colors">
                    <td className="p-2.5 text-foreground border-b border-border/50 align-middle font-medium">
                      {send.recipient_email || '—'}
                    </td>
                    <td className="p-2.5 border-b border-border/50 align-middle">
                      <span className={`inline-flex items-center gap-1 h-[22px] px-2 text-[10px] font-semibold rounded ${statusBadgeClasses(send.status)}`}>
                        {statusIcon(send.status)}
                        {statusLabel(send.status)}
                      </span>
                    </td>
                    <td className="p-2.5 text-center text-foreground border-b border-border/50 align-middle">{send.open_count || 0}</td>
                    <td className="p-2.5 text-center text-foreground border-b border-border/50 align-middle">{send.click_count || 0}</td>
                    <td className="p-2.5 border-b border-border/50 align-middle">
                      {send.conversion_event ? (
                        <span className="inline-flex items-center h-[22px] px-2 text-[10px] font-semibold rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                          {send.conversion_event}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-8">
            <Users size={32} className="mx-auto mb-2.5 text-muted-foreground/30" />
            <div className="text-[14px] text-muted-foreground">Không tìm thấy người nhận</div>
            <div className="text-[12px] text-muted-foreground/60 mt-1">Thử thay đổi bộ lọc</div>
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-3">
            <div className="text-[11px] text-muted-foreground">Trang {currentPage} / {totalPages}</div>
            <div className="flex gap-1">
              <button
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage <= 1}
                className="h-7 px-2.5 text-[11px] font-semibold rounded-md border border-border bg-transparent text-foreground/70 cursor-pointer hover:bg-accent transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >Trước</button>
              <button
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage >= totalPages}
                className="h-7 px-2.5 text-[11px] font-semibold rounded-md border border-border bg-transparent text-foreground/70 cursor-pointer hover:bg-accent transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >Sau</button>
            </div>
          </div>
        )}
      </div>

      {/* 7. Email Preview */}
      <div className="bg-card border border-border rounded-xl mb-4 overflow-hidden">
        <button
          onClick={() => setPreviewOpen(!previewOpen)}
          className="w-full flex items-center justify-between p-4 border-none bg-transparent cursor-pointer text-left hover:bg-accent transition-colors"
        >
          <h3 className="text-[15px] font-semibold text-foreground">Xem Trước Email</h3>
          {previewOpen ? <ChevronUp size={18} className="text-muted-foreground" /> : <ChevronDown size={18} className="text-muted-foreground" />}
        </button>

        {previewOpen && (
          <div className="px-4 pb-4">
            <div className="flex gap-2 mb-3">
              <button
                onClick={handleCopyHTML}
                className="h-7 px-2.5 text-[11px] font-semibold rounded-md border border-border bg-transparent text-foreground/70 cursor-pointer inline-flex items-center gap-1 hover:bg-accent hover:text-foreground transition-colors"
              >
                {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                {copied ? 'Đã copy' : 'Copy HTML'}
              </button>
              <button
                onClick={handleDownloadHTML}
                className="h-7 px-2.5 text-[11px] font-semibold rounded-md border border-border bg-transparent text-foreground/70 cursor-pointer inline-flex items-center gap-1 hover:bg-accent hover:text-foreground transition-colors"
              >
                <Download size={14} /> Tải Xuống
              </button>
            </div>

            {campaign.html_body ? (
              <div className="bg-white rounded-lg overflow-hidden max-h-[500px] overflow-y-auto border border-border">
                <div dangerouslySetInnerHTML={{ __html: campaign.html_body }} />
              </div>
            ) : (
              <div className="text-center py-8">
                <FileText size={24} className="mx-auto mb-1.5 text-muted-foreground/30" />
                <div className="text-[12px] text-muted-foreground">Không có nội dung HTML</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

function InfoRow({ label, value }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-[12px] text-muted-foreground min-w-[80px] flex-shrink-0">{label}:</span>
      <span className="text-[12px] text-foreground break-all">{value}</span>
    </div>
  );
}

function KPICard({ icon: Icon, label, value, sub, color }) {
  return (
    <div className="bg-muted/40 rounded-xl p-3.5 text-center">
      <Icon size={20} className={`mx-auto mb-1.5 opacity-80 ${color}`} />
      <div className="text-[17px] font-bold text-foreground">{value}</div>
      <div className="text-[11px] text-muted-foreground mt-0.5">{label}</div>
      {sub && <div className={`text-[10px] font-semibold mt-0.5 ${color}`}>{sub}</div>}
    </div>
  );
}

function ROICard({ icon: Icon, label, value, iconClass }) {
  return (
    <div className="bg-muted/40 rounded-xl p-3.5 text-center">
      <Icon size={20} className={`mx-auto mb-1.5 opacity-70 ${iconClass}`} />
      <div className="text-[18px] font-bold text-foreground">{value}</div>
      <div className="text-[11px] text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}
