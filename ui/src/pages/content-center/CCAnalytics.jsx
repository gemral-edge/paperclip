import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { copyToClipboard } from '@/lib/clipboard';
import {
  BarChart3,
  Eye,
  MousePointerClick,
  Clock,
  Users,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  Youtube,
  Sparkles,
  AlertTriangle,
  Lightbulb,
  Target,
  Search,
  DollarSign,
  FileText,
  Calendar,
  ExternalLink,
  Play,
  ThumbsUp,
  MessageSquare,
  Globe,
  Monitor,
  CheckCircle,
  Zap,
  Download,
  Share2,
  Loader2,
  Info,
  ImageIcon,
  Layers,
  Activity,
  PieChart,
  X,
  ArrowRight,
  Wand2,
} from 'lucide-react';
import CCSelect from './CCSelect';
import { getSupabase } from '@gem/services';
import { supabase as mainSupabase } from '../../lib/supabaseClient';
import { youtubeService } from '@gem/services/api/youtubeService';
import { analyticsAI } from '@gem/services/content/analyticsAI';

// ===========================================================================
// Non-mock constants (keep as-is)
// ===========================================================================

const AI_PROVIDER_OPTIONS = [
  { value: 'claude', label: 'Claude Code (local)' },
  { value: 'gemini', label: 'Gemini CLI (local)' },
];

const AI_MODEL_OPTIONS = {
  claude: [
    { value: 'opus-4-7', label: 'Claude Opus 4.7' },
    { value: 'sonnet', label: 'Claude Sonnet 4.6' },
    { value: 'opus', label: 'Claude Opus 4.6' },
  ],
  gemini: [
    { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
    { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  ],
};

const TRACK_LABELS = {
  wealth: 'Tài Chính',
  wellness: 'Tâm Thức',
  integration: 'Tích Hợp',
};

const TRACK_COLORS = {
  wealth: 'text-gold',
  wellness: 'text-purple',
  integration: 'text-emerald',
};

const TRACK_BG = {
  wealth: 'bg-gold/10',
  wellness: 'bg-purple/10',
  integration: 'bg-emerald/10',
};

const RETENTION_TEMPLATE = [100, 92, 85, 78, 72, 65, 60, 55, 50, 46, 42, 38, 35, 32, 30];

const YT_CACHE_KEY = 'yt_analytics_cache';
const YT_CACHE_MAX_AGE = 10 * 60 * 1000; // 10 minutes

function saveAnalyticsCache(dateRange, data) {
  try {
    const cache = JSON.parse(sessionStorage.getItem(YT_CACHE_KEY) || '{}');
    cache[dateRange] = { ...data, _ts: Date.now() };
    sessionStorage.setItem(YT_CACHE_KEY, JSON.stringify(cache));
  } catch (_) { /* quota exceeded — ignore */ }
}

function loadAnalyticsCache(dateRange) {
  try {
    const cache = JSON.parse(sessionStorage.getItem(YT_CACHE_KEY) || '{}');
    const entry = cache[dateRange];
    if (entry && (Date.now() - entry._ts) < YT_CACHE_MAX_AGE) {
      return entry;
    }
  } catch (_) { /* parse error — ignore */ }
  return null;
}

// ===========================================================================
// Helpers
// ===========================================================================

function formatNumber(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString('vi-VN');
}

function formatCurrency(n) {
  return `$${n.toLocaleString('en-US')}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function getTrackHexColor(color) {
  const map = {
    gold: '#D4A843', purple: '#A855F7', emerald: '#34D399',
    blue: '#5B9CF5', cyan: '#22D3EE',
  };
  return map[color] ?? '#D4A843';
}

function getStartDate(range) {
  const now = new Date();
  switch (range) {
    case '7d': now.setDate(now.getDate() - 7); break;
    case '30d': now.setDate(now.getDate() - 30); break;
    case '90d': now.setDate(now.getDate() - 90); break;
    case '365d': now.setFullYear(now.getFullYear() - 1); break;
    case 'all': return '2020-01-01';
    default: now.setDate(now.getDate() - 90);
  }
  return now.toISOString().split('T')[0];
}

function getPrevStartDate(range, currentStart) {
  const start = new Date(currentStart);
  switch (range) {
    case '7d': start.setDate(start.getDate() - 7); break;
    case '30d': start.setDate(start.getDate() - 30); break;
    case '90d': start.setDate(start.getDate() - 90); break;
    case '365d': start.setFullYear(start.getFullYear() - 1); break;
    case 'all': return '2015-01-01';
    default: start.setDate(start.getDate() - 90);
  }
  return start.toISOString().split('T')[0];
}

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function parseSeconds(durationStr) {
  if (!durationStr) return 0;
  const parts = durationStr.split(':');
  return parseInt(parts[0] || '0') * 60 + parseInt(parts[1] || '0');
}

function mapTrafficSource(apiSource) {
  const map = {
    'YT_SEARCH': 'Tìm kiếm YouTube',
    'SUGGESTED': 'Đề xuất',
    'BROWSE': 'Duyệt trang chủ',
    'EXT_URL': 'Bên ngoài',
    'NOTIFICATION': 'Thông báo',
    'PLAYLIST': 'Playlist',
    'NO_LINK_OTHER': 'Khác',
    'SUBSCRIBER': 'Subscriber',
    'SHORTS': 'Shorts',
    'END_SCREEN': 'Màn hình kết thúc',
  };
  return map[apiSource] || apiSource;
}

function getTrafficIcon(sourceName) {
  if (sourceName.includes('Tìm kiếm') || sourceName.includes('SEARCH')) return Search;
  if (sourceName.includes('Đề xuất') || sourceName.includes('SUGGESTED')) return Sparkles;
  if (sourceName.includes('Duyệt') || sourceName.includes('BROWSE')) return Monitor;
  return Globe;
}

function getTrafficColor(index) {
  const colors = ['#D4A843', '#A855F7', '#22D3EE', '#34D399', '#5B9CF5', '#F472B6', '#FB923C', '#A3E635'];
  return colors[index % colors.length];
}

// ===========================================================================
// Sub-components: Shared
// ===========================================================================

function StatCardMini({
  label,
  value,
  change,
  icon: Icon,
  colorClass,
  scVariant,
}) {
  return (
    <div className={`sc ${scVariant}`}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-txt-2 uppercase tracking-wider font-medium">{label}</span>
        <div className={`p-2 rounded-card bg-glass-bg/50 ${colorClass}`}>
          <Icon size={18} />
        </div>
      </div>
      <div className="text-2xl font-heading font-bold text-txt mb-1">{value}</div>
      {change !== undefined && change !== null && (
        <div
          className={`flex items-center gap-1 text-xs font-medium ${
            change >= 0 ? 'text-success' : 'text-danger'
          }`}
        >
          {change >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
          <span>{change >= 0 ? '+' : ''}{change.toFixed(1)}%</span>
          <span className="text-txt-3 ml-1">so với kỳ trước</span>
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  children,
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2.5 text-sm font-medium rounded-card transition-all duration-200 inline-flex items-center gap-2 ${
        active
          ? 'bg-gold/20 text-gold border border-gold/30'
          : 'text-txt-2 hover:text-txt hover:bg-glass-bg/50 border border-transparent'
      }`}
    >
      <Icon size={16} />
      {children}
    </button>
  );
}

function DateRangePicker({
  value,
  onChange,
}) {
  const options = [
    { value: '7d', label: '7 ngày' },
    { value: '30d', label: '30 ngày' },
    { value: '90d', label: '90 ngày' },
    { value: '365d', label: '1 năm' },
    { value: 'all', label: 'Tất cả' },
  ];

  return (
    <div className="flex items-center gap-1 bg-glass-bg/30 rounded-card p-1">
      <Calendar size={14} className="text-txt-3 ml-2 mr-1" />
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`px-3 py-1.5 text-xs rounded-sm transition-all ${
            value === opt.value
              ? 'bg-bg-4 text-txt font-medium shadow-sm'
              : 'text-txt-3 hover:text-txt-2'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function StaleBadge() {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-badge bg-warning/10 border border-warning/20">
      <AlertTriangle size={14} className="text-warning" />
      <span className="text-xs text-warning font-medium">Dữ liệu cũ hơn 24 giờ</span>
    </div>
  );
}

function EmptyState({ message }) {
  return (
    <div className="glass-card p-12 text-center">
      <div className="inline-flex p-4 rounded-full bg-glass-bg/50 mb-4">
        <BarChart3 size={36} className="text-txt-3" />
      </div>
      <p className="text-sm text-txt-2 font-medium mb-2">Chưa có dữ liệu</p>
      <p className="text-xs text-txt-3 max-w-md mx-auto">{message}</p>
    </div>
  );
}

function LoadingOverlay() {
  return (
    <div className="glass-card p-16 text-center">
      <Loader2 size={36} className="mx-auto mb-4 text-gold animate-spin" />
      <p className="text-sm text-txt-2 font-medium">Đang tải dữ liệu phân tích...</p>
      <p className="text-xs text-txt-3 mt-1">Vui lòng chờ trong giây lát</p>
    </div>
  );
}

// ===========================================================================
// CTR Chart (CSS-based visualization)
// ===========================================================================

function CTRChart({ data }) {
  if (!data || data.length === 0) {
    return (
      <div className="glass-card p-6">
        <h3 className="font-heading text-lg font-semibold text-txt mb-4">% Xem Theo Thời Gian</h3>
        <EmptyState message="Chưa có dữ liệu % xem. Dữ liệu sẽ hiển thị sau khi đồng bộ." />
      </div>
    );
  }

  const maxCtr = Math.max(...data.map((d) => d.ctr));
  const minCtr = Math.min(...data.map((d) => d.ctr));
  const maxViews = Math.max(...data.map((d) => d.views));
  const chartHeight = 200;

  return (
    <div className="glass-card p-6">
      <div className="flex items-center justify-between mb-5">
        <h3 className="font-heading text-lg font-semibold text-txt">
          % Xem Theo Thời Gian
        </h3>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-gold" />
            <span className="text-xs text-txt-3">% Xem</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-purple/60" />
            <span className="text-xs text-txt-3">Lượt xem</span>
          </div>
        </div>
      </div>
      <div className="relative" style={{ height: chartHeight + 40 }}>
        {/* Y-axis labels */}
        <div className="absolute left-0 top-0 bottom-10 w-10 flex flex-col justify-between text-right pr-2">
          <span className="text-[10px] text-txt-3">{maxCtr.toFixed(0)}%</span>
          <span className="text-[10px] text-txt-3">{((maxCtr + minCtr) / 2).toFixed(0)}%</span>
          <span className="text-[10px] text-txt-3">{minCtr.toFixed(0)}%</span>
        </div>
        {/* Grid lines */}
        <div className="absolute left-12 right-0 top-0 bottom-10">
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="absolute left-0 right-0 border-t border-border/30"
              style={{ top: `${(i / 4) * 100}%` }}
            />
          ))}
        </div>
        {/* Bars */}
        <div className="absolute left-12 right-0 top-0 bottom-10 flex items-end justify-between gap-1 px-1">
          {data.map((d, i) => {
            const ctrRatio = (d.ctr - minCtr + 1) / (maxCtr - minCtr + 2);
            const viewsRatio = d.views / maxViews;
            return (
              <div key={i} className="flex-1 flex flex-col items-center gap-0.5 group relative">
                {/* Tooltip */}
                <div className="absolute -top-16 left-1/2 -translate-x-1/2 bg-bg-4 border border-border rounded-card px-3 py-2 opacity-0 group-hover:opacity-100 transition-opacity z-10 pointer-events-none whitespace-nowrap shadow-lg">
                  <p className="text-xs text-gold font-medium">% Xem: {d.ctr}%</p>
                  <p className="text-xs text-purple">{formatNumber(d.views)} lượt xem</p>
                </div>
                {/* CTR bar */}
                <div className="w-full flex gap-0.5" style={{ height: chartHeight }}>
                  <div
                    className="flex-1 rounded-t-sm bg-gradient-to-t from-gold/40 to-gold/80 transition-all duration-500 self-end group-hover:from-gold/60 group-hover:to-gold"
                    style={{ height: `${ctrRatio * 100}%` }}
                  />
                  <div
                    className="flex-1 rounded-t-sm bg-gradient-to-t from-purple/20 to-purple/50 transition-all duration-500 self-end group-hover:from-purple/40 group-hover:to-purple/70"
                    style={{ height: `${viewsRatio * 100}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
        {/* X-axis labels */}
        <div className="absolute left-12 right-0 bottom-0 flex justify-between px-1">
          {data.map((d, i) => (
            <span key={i} className="flex-1 text-center text-[10px] text-txt-3">
              {d.label}
            </span>
          ))}
        </div>
      </div>
      {/* Summary row */}
      <div className="flex items-center gap-6 mt-4 pt-4 border-t border-border">
        <div className="flex items-center gap-2">
          <TrendingUp size={14} className="text-success" />
          <span className="text-xs text-txt-2">% Xem cao nhất: <strong className="text-gold">{maxCtr}%</strong></span>
        </div>
        <div className="flex items-center gap-2">
          <Activity size={14} className="text-txt-3" />
          <span className="text-xs text-txt-2">% Xem trung bình: <strong className="text-txt">{(data.reduce((s, d) => s + d.ctr, 0) / data.length).toFixed(1)}%</strong></span>
        </div>
        <div className="flex items-center gap-2">
          <Eye size={14} className="text-purple" />
          <span className="text-xs text-txt-2">Tổng lượt xem: <strong className="text-txt">{formatNumber(data.reduce((s, d) => s + d.views, 0))}</strong></span>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// Traffic Sources Display
// ===========================================================================

function TrafficSourcesDisplay({ trafficSources }) {
  if (!trafficSources || trafficSources.length === 0) {
    return (
      <div className="glass-card p-6">
        <div className="flex items-center gap-2 mb-5">
          <PieChart size={18} className="text-gold" />
          <h3 className="font-heading text-lg font-semibold text-txt">Nguồn Lưu Lượng</h3>
        </div>
        <EmptyState message="Chưa có dữ liệu nguồn lưu lượng." />
      </div>
    );
  }

  const total = trafficSources.reduce((s, t) => s + t.percentage, 0);

  return (
    <div className="glass-card p-6">
      <div className="flex items-center gap-2 mb-5">
        <PieChart size={18} className="text-gold" />
        <h3 className="font-heading text-lg font-semibold text-txt">
          Nguồn Lưu Lượng
        </h3>
      </div>
      {/* Visual pie representation with stacked bar */}
      <div className="h-4 rounded-full overflow-hidden flex mb-5">
        {trafficSources.map((src, idx) => (
          <div
            key={src.source}
            className="h-full transition-all duration-700 first:rounded-l-full last:rounded-r-full"
            style={{ width: `${total > 0 ? (src.percentage / total) * 100 : 0}%`, backgroundColor: src.color || getTrafficColor(idx) }}
            title={`${src.source}: ${src.percentage}%`}
          />
        ))}
      </div>
      <div className="space-y-3">
        {trafficSources.map((src, idx) => {
          const Icon = src.icon || getTrafficIcon(src.source);
          const color = src.color || getTrafficColor(idx);
          return (
            <div key={src.source} className="flex items-center gap-3 group">
              <div
                className="w-8 h-8 rounded-card flex items-center justify-center flex-shrink-0"
                style={{ backgroundColor: `${color}20` }}
              >
                <Icon size={14} style={{ color }} />
              </div>
              <span className="text-sm text-txt-2 flex-1 group-hover:text-txt transition-colors">{src.source}</span>
              <div className="flex items-center gap-3 w-48">
                <div className="flex-1 h-2 bg-bg-4 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-700"
                    style={{ width: `${src.percentage}%`, backgroundColor: color }}
                  />
                </div>
                <span className="text-sm font-semibold text-txt w-10 text-right">
                  {src.percentage}%
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ===========================================================================
// Retention Display
// ===========================================================================

function RetentionDisplay({ videoId, videos, accessToken }) {
  const [retention, setRetention] = useState(RETENTION_TEMPLATE);
  const [title, setTitle] = useState('Trung bình toàn kênh');
  const [loadingRetention, setLoadingRetention] = useState(false);

  useEffect(() => {
    if (!videoId || !accessToken) {
      setRetention(RETENTION_TEMPLATE);
      setTitle('Trung bình toàn kênh');
      return;
    }

    const video = videos.find((v) => v.id === videoId);
    if (video && video.retention && video.retention.length > 0) {
      setRetention(video.retention);
      setTitle(video.title || videoId);
      return;
    }

    // Fetch retention from YouTube Analytics API
    setLoadingRetention(true);
    youtubeService.getRetentionData(accessToken, videoId)
      .then((data) => {
        if (data && data.length > 0) {
          // Convert timeRatio/watchRatio to percentage array (15 buckets)
          const buckets = 15;
          const retArr = [];
          for (let i = 0; i < buckets; i++) {
            const ratio = i / (buckets - 1);
            const closest = data.reduce((prev, curr) =>
              Math.abs(curr.timeRatio - ratio) < Math.abs(prev.timeRatio - ratio) ? curr : prev
            );
            retArr.push(Math.round((closest.watchRatio || 0) * 100));
          }
          setRetention(retArr);
        } else {
          setRetention(RETENTION_TEMPLATE);
        }
        setTitle(video?.title || videoId);
      })
      .catch(() => {
        setRetention(RETENTION_TEMPLATE);
        setTitle(video?.title || videoId);
      })
      .finally(() => setLoadingRetention(false));
  }, [videoId, accessToken, videos]);

  return (
    <div className="glass-card p-6">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Activity size={18} className="text-gold" />
          <h3 className="font-heading text-lg font-semibold text-txt">
            Đường Cong Giữ Chân
          </h3>
        </div>
        {loadingRetention && <Loader2 size={14} className="text-gold animate-spin" />}
      </div>
      <p className="text-xs text-txt-3 mb-4 truncate">{title}</p>
      {/* Retention visualization */}
      <div className="relative h-40 flex items-end gap-0.5">
        {retention.map((val, i) => {
          const isDropOff = i > 0 && (retention[i - 1] ?? 0) - val > 5;
          return (
            <div
              key={i}
              className="flex-1 relative group"
              style={{ height: '100%' }}
            >
              <div
                className={`absolute bottom-0 left-0 right-0 rounded-t-sm transition-all duration-500 ${
                  isDropOff
                    ? 'bg-gradient-to-t from-danger/30 to-danger/60'
                    : 'bg-gradient-to-t from-emerald/20 to-emerald/60'
                }`}
                style={{ height: `${val}%` }}
              />
              {/* Tooltip */}
              <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-bg-4 border border-border rounded px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity z-10 pointer-events-none whitespace-nowrap">
                <span className="text-[10px] text-txt">{val}%</span>
              </div>
              {isDropOff && (
                <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-3">
                  <AlertTriangle size={10} className="text-danger" />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {/* X-axis */}
      <div className="flex justify-between mt-2">
        <span className="text-[10px] text-txt-3">Bắt đầu</span>
        <span className="text-[10px] text-txt-3">Giữa video</span>
        <span className="text-[10px] text-txt-3">Kết thúc</span>
      </div>
      {/* Key metrics */}
      <div className="flex items-center gap-4 mt-4 pt-3 border-t border-border">
        <div className="text-center flex-1">
          <p className="text-lg font-heading font-bold text-emerald">{retention[Math.floor(retention.length / 2)] ?? 0}%</p>
          <p className="text-[10px] text-txt-3">Giữ chân giữa video</p>
        </div>
        <div className="w-px h-8 bg-border" />
        <div className="text-center flex-1">
          <p className="text-lg font-heading font-bold text-txt">{retention[retention.length - 1] ?? 0}%</p>
          <p className="text-[10px] text-txt-3">Giữ chân cuối video</p>
        </div>
        <div className="w-px h-8 bg-border" />
        <div className="text-center flex-1">
          <p className={`text-lg font-heading font-bold ${(retention[3] ?? 0) > 75 ? 'text-success' : 'text-danger'}`}>
            {retention[3] ?? 0}%
          </p>
          <p className="text-[10px] text-txt-3">Sau 30 giây đầu</p>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// Demographics Display
// ===========================================================================

function DemographicsDisplay({ demographics }) {
  if (!demographics || demographics.length === 0) {
    return (
      <div className="glass-card p-6">
        <div className="flex items-center gap-2 mb-5">
          <Users size={18} className="text-gold" />
          <h3 className="font-heading text-lg font-semibold text-txt">Đối Tượng Khán Giả</h3>
        </div>
        <EmptyState message="Chưa có dữ liệu đối tượng khán giả." />
      </div>
    );
  }

  const maxTotal = Math.max(...demographics.map((d) => d.total), 1);
  const totalMale = demographics.reduce((s, d) => s + (d.male || 0), 0);
  const totalFemale = demographics.reduce((s, d) => s + (d.female || 0), 0);
  const grandTotal = totalMale + totalFemale || 1;
  const malePct = Math.round((totalMale / grandTotal) * 100);
  const femalePct = 100 - malePct;

  // Find largest age group
  const largestGroup = demographics.reduce((max, d) => d.total > (max?.total || 0) ? d : max, demographics[0]);

  return (
    <div className="glass-card p-6">
      <div className="flex items-center gap-2 mb-5">
        <Users size={18} className="text-gold" />
        <h3 className="font-heading text-lg font-semibold text-txt">
          Đối Tượng Khán Giả
        </h3>
      </div>
      {/* Gender split summary */}
      <div className="flex items-center gap-3 mb-5 p-3 rounded-card bg-glass-bg/30">
        <div className="flex-1 text-center">
          <p className="text-sm font-semibold text-cyan">{malePct}%</p>
          <p className="text-[10px] text-txt-3">Nam</p>
        </div>
        <div className="w-px h-8 bg-border" />
        <div className="flex-1 text-center">
          <p className="text-sm font-semibold text-purple">{femalePct}%</p>
          <p className="text-[10px] text-txt-3">Nữ</p>
        </div>
      </div>
      {/* Age groups */}
      <div className="space-y-4">
        {demographics.map((demo) => (
          <div key={demo.ageGroup}>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm text-txt font-medium">{demo.ageGroup} tuổi</span>
              <span className="text-sm font-semibold text-txt">{demo.total}%</span>
            </div>
            <div className="flex gap-1 h-3">
              {/* Male bar */}
              <div
                className="rounded-l-sm bg-gradient-to-r from-cyan/40 to-cyan/70 transition-all duration-700"
                style={{ width: `${(demo.male / maxTotal) * 100}%` }}
                title={`Nam: ${demo.male}%`}
              />
              {/* Female bar */}
              <div
                className="rounded-r-sm bg-gradient-to-r from-purple/40 to-purple/70 transition-all duration-700"
                style={{ width: `${(demo.female / maxTotal) * 100}%` }}
                title={`Nữ: ${demo.female}%`}
              />
              {/* Remaining space */}
              <div className="flex-1 bg-bg-4 rounded-r-sm" />
            </div>
          </div>
        ))}
      </div>
      {/* Legend */}
      <div className="flex items-center justify-center gap-6 mt-4 pt-3 border-t border-border">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-sm bg-cyan/60" />
          <span className="text-xs text-txt-3">Nam</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-sm bg-purple/60" />
          <span className="text-xs text-txt-3">Nữ</span>
        </div>
      </div>
      {/* Insight */}
      {largestGroup && (
        <div className="mt-4 p-3 rounded-card bg-gold/5 border border-gold/10">
          <div className="flex items-start gap-2">
            <Info size={14} className="text-gold mt-0.5 flex-shrink-0" />
            <p className="text-xs text-txt-2 leading-relaxed">
              Nhóm <strong className="text-gold">{largestGroup.ageGroup} tuổi</strong> chiếm tỷ lệ lớn nhất ({largestGroup.total}%).
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Thumbnail A/B Test Results (empty state — needs YouTube built-in feature)
// ===========================================================================

function ThumbnailABResults({ thumbnailTests }) {
  if (!thumbnailTests || thumbnailTests.length === 0) {
    return (
      <div className="glass-card p-6">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <ImageIcon size={18} className="text-gold" />
            <h3 className="font-heading text-lg font-semibold text-txt">
              A/B Test Thumbnail
            </h3>
          </div>
        </div>
        <EmptyState message="Chưa có dữ liệu A/B test thumbnail. Tính năng này cần YouTube Studio API." />
      </div>
    );
  }

  return (
    <div className="glass-card p-6">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2">
          <ImageIcon size={18} className="text-gold" />
          <h3 className="font-heading text-lg font-semibold text-txt">
            A/B Test Thumbnail
          </h3>
        </div>
        <span className="badge badge-new">
          {thumbnailTests.filter((t) => t.status === 'running').length} đang chạy
        </span>
      </div>
      <div className="space-y-4">
        {thumbnailTests.map((test) => (
          <div key={test.id} className="p-4 rounded-card bg-glass-bg/30 border border-border">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm text-txt font-medium truncate flex-1">{test.videoTitle}</p>
              <span
                className={`badge ml-3 ${
                  test.status === 'running' ? 'badge-new' : 'badge-gold'
                }`}
              >
                {test.status === 'running' ? 'Đang chạy' : 'Hoàn thành'}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {/* Variant A */}
              <div
                className={`p-3 rounded-card border transition-all ${
                  test.winner === 'A'
                    ? 'border-success/30 bg-success/5'
                    : 'border-border bg-glass-bg/20'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-txt-2">Phiên bản A</span>
                  {test.winner === 'A' && (
                    <CheckCircle size={14} className="text-success" />
                  )}
                </div>
                <p className="text-xs text-txt-3 mb-2">{test.variantA.label}</p>
                <div className="flex items-baseline gap-1">
                  <span className={`text-lg font-heading font-bold ${test.winner === 'A' ? 'text-success' : 'text-txt'}`}>
                    {test.variantA.ctr}%
                  </span>
                  <span className="text-[10px] text-txt-3">% Xem</span>
                </div>
                <p className="text-[10px] text-txt-3 mt-1">
                  {formatNumber(test.variantA.impressions)} lượt hiển thị
                </p>
              </div>
              {/* Variant B */}
              <div
                className={`p-3 rounded-card border transition-all ${
                  test.winner === 'B'
                    ? 'border-success/30 bg-success/5'
                    : 'border-border bg-glass-bg/20'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-txt-2">Phiên bản B</span>
                  {test.winner === 'B' && (
                    <CheckCircle size={14} className="text-success" />
                  )}
                </div>
                <p className="text-xs text-txt-3 mb-2">{test.variantB.label}</p>
                <div className="flex items-baseline gap-1">
                  <span className={`text-lg font-heading font-bold ${test.winner === 'B' ? 'text-success' : 'text-txt'}`}>
                    {test.variantB.ctr}%
                  </span>
                  <span className="text-[10px] text-txt-3">% Xem</span>
                </div>
                <p className="text-[10px] text-txt-3 mt-1">
                  {formatNumber(test.variantB.impressions)} lượt hiển thị
                </p>
              </div>
            </div>
            {/* Difference */}
            <div className="mt-3 pt-3 border-t border-border flex items-center gap-2">
              <Zap size={12} className="text-gold" />
              <span className="text-xs text-txt-2">
                Chênh lệch % Xem:{' '}
                <strong className="text-success">
                  +{Math.abs(test.variantA.ctr - test.variantB.ctr).toFixed(1)}%
                </strong>{' '}
                cho phiên bản {test.winner}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ===========================================================================
// Tab: Tong Quan (Overview)
// ===========================================================================

function OverviewTab({
  dateRange,
  selectedVideoId,
  onSelectVideo,
  ctrTrend,
  trafficSources,
  demographics,
  videos,
  accessToken,
}) {
  const dateLabel = dateRange === '7d'
    ? '7 ngày' : dateRange === '30d'
    ? '30 ngày' : dateRange === '90d'
    ? '90 ngày' : dateRange === '365d'
    ? '1 năm' : 'toàn bộ';

  return (
    <div className="space-y-6">
      {/* CTR Chart */}
      <CTRChart data={ctrTrend} />

      {/* Traffic + Demographics row */}
      <div className="g2">
        <TrafficSourcesDisplay trafficSources={trafficSources} />
        <DemographicsDisplay demographics={demographics} />
      </div>

      {/* Retention + Top Videos row */}
      <div className="g2">
        <RetentionDisplay videoId={selectedVideoId} videos={videos} accessToken={accessToken} />
        {/* Top Videos */}
        <div className="glass-card p-6">
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2">
              <Play size={18} className="text-gold" />
              <h3 className="font-heading text-lg font-semibold text-txt">
                Top Video ({dateLabel})
              </h3>
            </div>
            <span className="text-xs text-txt-3">{videos.length} video</span>
          </div>
          {videos.length === 0 ? (
            <EmptyState message="Chưa có dữ liệu video. Nhấn Đồng bộ dữ liệu để bắt đầu." />
          ) : (
            <div className="space-y-2">
              {videos.slice(0, 6).map((video, i) => (
                <button
                  key={video.id}
                  onClick={() => onSelectVideo(selectedVideoId === video.id ? null : video.id)}
                  className={`w-full flex items-start gap-3 p-3 rounded-card transition-all text-left ${
                    selectedVideoId === video.id
                      ? 'bg-gold/10 border border-gold/20'
                      : 'bg-glass-bg/20 hover:bg-glass-bg/40 border border-transparent'
                  }`}
                >
                  <span className="text-lg font-heading font-bold text-txt-3 w-6 text-center flex-shrink-0">
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-txt font-medium truncate">{video.title}</p>
                    <div className="flex items-center gap-3 mt-1.5">
                      <span className={`text-xs font-medium ${TRACK_COLORS[video.track] || 'text-txt-3'}`}>
                        {TRACK_LABELS[video.track] || video.track || 'N/A'}
                      </span>
                      <span className="text-xs text-txt-3 flex items-center gap-1">
                        <Eye size={10} /> {formatNumber(video.views || 0)}
                      </span>
                      <span className="text-xs text-txt-3">% Xem {video.ctr || 0}%</span>
                      <span className="text-xs text-success flex items-center gap-1">
                        <DollarSign size={10} /> {formatCurrency(video.revenue || 0)}
                      </span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
          <p className="text-[10px] text-txt-3 mt-3 text-center">
            Nhấn vào video để xem đường cong giữ chân chi tiết
          </p>
        </div>
      </div>

      {/* Thumbnail A/B Results — empty since no data without YouTube Studio */}
      <ThumbnailABResults thumbnailTests={[]} />
    </div>
  );
}

// ===========================================================================
// Tab: Theo Video (sortable table)
// ===========================================================================

function ByVideoTab({ videos }) {
  const [sortBy, setSortBy] = useState('views');
  const [sortOrder, setSortOrder] = useState('desc');
  const [page, setPage] = useState(1);
  const [filterTrack, setFilterTrack] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const perPage = 8;

  const handleSort = useCallback((key) => {
    if (sortBy === key) {
      setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(key);
      setSortOrder('desc');
    }
    setPage(1);
  }, [sortBy]);

  const filteredAndSorted = useMemo(() => {
    let list = [...videos];

    // Filter by track
    if (filterTrack !== 'all') {
      list = list.filter((v) => v.track === filterTrack);
    }

    // Filter by search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((v) => (v.title || '').toLowerCase().includes(q));
    }

    // Sort
    list.sort((a, b) => {
      const aVal = a[sortBy];
      const bVal = b[sortBy];
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortOrder === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      const aNum = Number(aVal) || 0;
      const bNum = Number(bVal) || 0;
      return sortOrder === 'asc' ? aNum - bNum : bNum - aNum;
    });

    return list;
  }, [videos, sortBy, sortOrder, filterTrack, searchQuery]);

  const totalPages = Math.ceil(filteredAndSorted.length / perPage);
  const paginatedVideos = filteredAndSorted.slice((page - 1) * perPage, page * perPage);

  const totalViews = filteredAndSorted.reduce((s, v) => s + (v.views || 0), 0);
  const totalRevenue = filteredAndSorted.reduce((s, v) => s + (v.revenue || 0), 0);
  const avgCtr = filteredAndSorted.length > 0
    ? filteredAndSorted.reduce((s, v) => s + (v.ctr || 0), 0) / filteredAndSorted.length
    : 0;

  function SortHeader({
    label,
    sortKey,
    align = 'left',
  }) {
    const isActive = sortBy === sortKey;
    return (
      <th
        className={`cursor-pointer select-none hover:text-txt transition-colors ${
          align === 'right' ? 'text-right' : 'text-left'
        }`}
        onClick={() => handleSort(sortKey)}
      >
        <span className="inline-flex items-center gap-1">
          {label}
          {isActive ? (
            sortOrder === 'asc' ? (
              <ArrowUp className="w-3 h-3 text-gold" />
            ) : (
              <ArrowDown className="w-3 h-3 text-gold" />
            )
          ) : (
            <ArrowUpDown className="w-3 h-3 opacity-40" />
          )}
        </span>
      </th>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filters and summary */}
      <div className="glass-card p-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
          <h3 className="font-heading text-lg font-semibold text-txt">
            Hiệu Suất Theo Video
          </h3>
          <div className="flex items-center gap-3">
            {/* Search */}
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-txt-3" />
              <input
                type="text"
                placeholder="Tìm video..."
                value={searchQuery}
                onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
                className="fi pl-9 !w-48 text-xs"
              />
            </div>
            {/* Track filter */}
            <CCSelect
              value={filterTrack}
              onChange={(e) => { setFilterTrack(e.target.value); setPage(1); }}
              className="text-xs !w-36"
            >
              <option value="all">Tất cả track</option>
              <option value="wealth">Tài Chính</option>
              <option value="wellness">Tâm Thức</option>
              <option value="integration">Tích Hợp</option>
            </CCSelect>
          </div>
        </div>
        {/* Summary chips */}
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-badge bg-glass-bg/40">
            <Eye size={12} className="text-gold" />
            <span className="text-xs text-txt-2">{formatNumber(totalViews)} lượt xem</span>
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-badge bg-glass-bg/40">
            <MousePointerClick size={12} className="text-purple" />
            <span className="text-xs text-txt-2">% Xem TB: {avgCtr.toFixed(1)}%</span>
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-badge bg-glass-bg/40">
            <DollarSign size={12} className="text-emerald" />
            <span className="text-xs text-txt-2">{formatCurrency(totalRevenue)} doanh thu</span>
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-badge bg-glass-bg/40">
            <FileText size={12} className="text-txt-3" />
            <span className="text-xs text-txt-2">{filteredAndSorted.length} video</span>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="glass-card p-6">
        {filteredAndSorted.length === 0 ? (
          <EmptyState message="Không tìm thấy video nào phù hợp với bộ lọc hiện tại." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="dt">
                <thead>
                  <tr>
                    <th className="w-8 text-center">#</th>
                    <SortHeader label="Tiêu Đề" sortKey="title" />
                    <SortHeader label="Track" sortKey="track" />
                    <SortHeader label="Lượt Xem" sortKey="views" align="right" />
                    <SortHeader label="% Xem" sortKey="ctr" align="right" />
                    <SortHeader label="Thời Gian TB" sortKey="avgDurationSec" align="right" />
                    <SortHeader label="Doanh Thu" sortKey="revenue" align="right" />
                    <SortHeader label="Ngày Đăng" sortKey="publishedAt" align="right" />
                  </tr>
                </thead>
                <tbody>
                  {paginatedVideos.map((video, idx) => (
                    <tr key={video.id} className="cursor-pointer group">
                      <td className="text-center">
                        <span className="text-xs text-txt-3">{(page - 1) * perPage + idx + 1}</span>
                      </td>
                      <td>
                        <div className="flex items-center gap-3 max-w-sm">
                          {video.thumbnailUrl && (
                            <img
                              src={video.thumbnailUrl}
                              alt=""
                              className="w-16 h-9 rounded object-cover flex-shrink-0"
                              loading="lazy"
                            />
                          )}
                          <div className="min-w-0">
                            <p className="text-sm text-txt font-medium truncate group-hover:text-gold transition-colors">
                              {video.title}
                            </p>
                            <div className="flex items-center gap-2 mt-1">
                              <span className="text-[10px] text-txt-3 flex items-center gap-0.5">
                                <ThumbsUp size={9} /> {formatNumber(video.likes || 0)}
                              </span>
                              <span className="text-[10px] text-txt-3 flex items-center gap-0.5">
                                <MessageSquare size={9} /> {formatNumber(video.comments || 0)}
                              </span>
                              <span className="text-[10px] text-txt-3 flex items-center gap-0.5">
                                <Users size={9} /> +{video.subscribers || 0}
                              </span>
                            </div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span
                          className={`inline-flex items-center gap-1.5 text-xs font-bold px-2 py-0.5 rounded-badge ${TRACK_BG[video.track] || 'bg-glass-bg/30'} ${TRACK_COLORS[video.track] || 'text-txt-3'}`}
                        >
                          {TRACK_LABELS[video.track] || video.track || 'N/A'}
                        </span>
                      </td>
                      <td className="text-right">
                        <span className="text-sm text-txt font-medium">{formatNumber(video.views || 0)}</span>
                      </td>
                      <td className="text-right">
                        <span
                          className={`text-sm font-semibold ${
                            (video.ctr || 0) >= 10 ? 'text-success' : (video.ctr || 0) >= 7 ? 'text-txt' : 'text-danger'
                          }`}
                        >
                          {video.ctr || 0}%
                        </span>
                        {/* Mini bar */}
                        <div className="w-16 h-1 bg-bg-4 rounded-full overflow-hidden mt-1 ml-auto">
                          <div
                            className={`h-full rounded-full ${
                              (video.ctr || 0) >= 10 ? 'bg-success' : (video.ctr || 0) >= 7 ? 'bg-gold' : 'bg-danger'
                            }`}
                            style={{ width: `${Math.min((video.ctr || 0) * 7, 100)}%` }}
                          />
                        </div>
                      </td>
                      <td className="text-right">
                        <span className="text-sm text-txt-2">{video.avgDuration || formatDuration(video.avgDurationSec || 0)}</span>
                      </td>
                      <td className="text-right">
                        <span className="text-sm text-success font-medium">
                          {formatCurrency(video.revenue || 0)}
                        </span>
                      </td>
                      <td className="text-right">
                        <span className="text-sm text-txt-3">{formatDate(video.publishedAt)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-border">
                <span className="text-xs text-txt-3">
                  Trang {page} / {totalPages} &mdash; Hiển thị {paginatedVideos.length} / {filteredAndSorted.length} video
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="p-1.5 rounded-card text-txt-2 hover:text-txt hover:bg-glass-bg/50 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                  >
                    <ChevronLeft size={16} />
                  </button>
                  {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                    <button
                      key={p}
                      onClick={() => setPage(p)}
                      className={`w-7 h-7 rounded-card text-xs font-medium transition-all ${
                        p === page
                          ? 'bg-gold/20 text-gold border border-gold/30'
                          : 'text-txt-3 hover:text-txt hover:bg-glass-bg/50'
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                    className="p-1.5 rounded-card text-txt-2 hover:text-txt hover:bg-glass-bg/50 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// Tab: Theo Track
// ===========================================================================

function ByTrackTab({ trackMetrics }) {
  if (!trackMetrics || trackMetrics.length === 0) {
    return (
      <div className="space-y-6">
        <EmptyState message="Chưa có dữ liệu track. Dữ liệu sẽ hiển thị sau khi đồng bộ video." />
      </div>
    );
  }

  const totalViews = trackMetrics.reduce((s, t) => s + (t.totalViews || 0), 0);
  const totalRevenue = trackMetrics.reduce((s, t) => s + (t.revenue || 0), 0);

  // Build a map for the comparison table — fill missing tracks with zeros
  const trackMap = {};
  for (const tm of trackMetrics) {
    trackMap[tm.track] = tm;
  }
  const wealthTm = trackMap['wealth'] || { totalViews: 0, avgCtr: 0, avgDuration: '0:00', subscribersGained: 0, revenue: 0, engagement: 0, growth: 0 };
  const wellnessTm = trackMap['wellness'] || { totalViews: 0, avgCtr: 0, avgDuration: '0:00', subscribersGained: 0, revenue: 0, engagement: 0, growth: 0 };
  const integrationTm = trackMap['integration'] || { totalViews: 0, avgCtr: 0, avgDuration: '0:00', subscribersGained: 0, revenue: 0, engagement: 0, growth: 0 };

  // Best track for recommendation
  const bestTrack = trackMetrics.reduce((best, t) => (t.avgCtr || 0) > (best.avgCtr || 0) ? t : best, trackMetrics[0]);

  return (
    <div className="space-y-6">
      {/* Track Performance Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {trackMetrics.map((tm) => {
          const colorClassMap = {
            gold: { text: 'text-gold', bg: 'bg-gold/10', border: 'border-gold/20', hex: '#D4A843' },
            purple: { text: 'text-purple', bg: 'bg-purple/10', border: 'border-purple/20', hex: '#A855F7' },
            emerald: { text: 'text-emerald', bg: 'bg-emerald/10', border: 'border-emerald/20', hex: '#34D399' },
          };
          const colors = colorClassMap[tm.color] ?? colorClassMap['gold'];
          const viewShare = totalViews > 0 ? ((tm.totalViews / totalViews) * 100).toFixed(1) : '0.0';
          const revenueShare = totalRevenue > 0 ? ((tm.revenue / totalRevenue) * 100).toFixed(1) : '0.0';
          const engagement = tm.videoCount > 0 ? ((tm.totalViews / tm.videoCount / 10000) || 0).toFixed(1) : '0.0';

          return (
            <div
              key={tm.track}
              className={`glass-card p-6 border ${colors.border}`}
            >
              {/* Track header */}
              <div className="flex items-center gap-3 mb-5">
                <div className={`p-2.5 rounded-card ${colors.bg}`}>
                  <Layers size={20} className={colors.text} />
                </div>
                <div className="flex-1">
                  <h3 className={`font-heading text-base font-semibold ${colors.text}`}>
                    {tm.label}
                  </h3>
                  <span className="text-xs text-txt-3">{tm.videoCount} video</span>
                </div>
              </div>

              {/* Metrics grid */}
              <div className="space-y-3.5">
                <div className="flex justify-between items-center">
                  <span className="text-xs text-txt-3">Tổng lượt xem</span>
                  <span className="text-sm font-semibold text-txt">{formatNumber(tm.totalViews)}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-txt-3">% tổng lượt xem</span>
                  <span className="text-sm font-semibold text-txt">{viewShare}%</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-txt-3">% Xem TB</span>
                  <span className={`text-sm font-semibold ${tm.avgCtr >= 9 ? 'text-success' : 'text-txt'}`}>
                    {tm.avgCtr}%
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-txt-3">Thời gian xem TB</span>
                  <span className="text-sm font-semibold text-txt">{tm.avgDuration}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-txt-3">Subscribers mới</span>
                  <span className="text-sm font-semibold text-success">+{formatNumber(tm.subscribersGained)}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-txt-3">Doanh thu</span>
                  <span className="text-sm font-semibold text-success">{formatCurrency(tm.revenue)}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-txt-3">% doanh thu</span>
                  <span className="text-sm font-semibold text-txt">{revenueShare}%</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-txt-3">Engagement</span>
                  <span className="text-sm font-semibold text-txt">{engagement}%</span>
                </div>

                {/* Separator */}
                <div className="border-t border-border pt-3">
                  <p className="text-xs text-txt-3 mb-1">Video tốt nhất</p>
                  <p className="text-sm text-txt font-medium truncate">{tm.topVideo || 'N/A'}</p>
                </div>
              </div>

              {/* Performance bar */}
              <div className="mt-5">
                <div className="flex justify-between text-xs text-txt-3 mb-1.5">
                  <span>Hiệu suất tổng thể</span>
                  <span>{engagement}/10</span>
                </div>
                <div className="h-2 bg-bg-4 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-700"
                    style={{
                      width: `${Math.min(parseFloat(engagement) * 10, 100)}%`,
                      background: `linear-gradient(90deg, ${colors.hex}, ${colors.hex}cc)`,
                    }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Track Distribution Visual */}
      <div className="glass-card p-6">
        <h3 className="font-heading text-lg font-semibold text-txt mb-4">
          Phân Bổ Lượt Xem Theo Track
        </h3>
        <div className="h-6 rounded-full overflow-hidden flex mb-4">
          {trackMetrics.map((tm) => (
            <div
              key={tm.track}
              className="h-full transition-all duration-700 first:rounded-l-full last:rounded-r-full relative group"
              style={{
                width: `${totalViews > 0 ? (tm.totalViews / totalViews) * 100 : 0}%`,
                backgroundColor: getTrackHexColor(tm.color),
              }}
            >
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-[10px] font-bold text-bg">
                  {totalViews > 0 ? ((tm.totalViews / totalViews) * 100).toFixed(0) : 0}%
                </span>
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-center gap-6">
          {trackMetrics.map((tm) => (
            <div key={tm.track} className="flex items-center gap-2">
              <div
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: getTrackHexColor(tm.color) }}
              />
              <span className="text-xs text-txt-2">{tm.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Comparison Table */}
      <div className="glass-card p-6">
        <h3 className="font-heading text-lg font-semibold text-txt mb-4">
          So Sánh Chi Tiết Giữa Các Track
        </h3>
        <div className="overflow-x-auto">
          <table className="dt">
            <thead>
              <tr>
                <th className="text-left">Chỉ Số</th>
                <th className="text-right text-gold">Tài Chính</th>
                <th className="text-right text-purple">Tâm Thức</th>
                <th className="text-right text-emerald">Tích Hợp</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="text-sm text-txt-2">Tổng lượt xem</td>
                <td className="text-right text-sm font-medium text-txt">{formatNumber(wealthTm.totalViews)}</td>
                <td className="text-right text-sm font-medium text-txt">{formatNumber(wellnessTm.totalViews)}</td>
                <td className="text-right text-sm font-medium text-txt">{formatNumber(integrationTm.totalViews)}</td>
              </tr>
              <tr>
                <td className="text-sm text-txt-2">% Xem TB</td>
                <td className="text-right text-sm font-medium text-txt">{wealthTm.avgCtr || 0}%</td>
                <td className="text-right text-sm font-medium text-txt">{wellnessTm.avgCtr || 0}%</td>
                <td className="text-right text-sm font-medium text-txt">{integrationTm.avgCtr || 0}%</td>
              </tr>
              <tr>
                <td className="text-sm text-txt-2">Thời gian xem TB</td>
                <td className="text-right text-sm font-medium text-txt">{wealthTm.avgDuration || '0:00'}</td>
                <td className="text-right text-sm font-medium text-txt">{wellnessTm.avgDuration || '0:00'}</td>
                <td className="text-right text-sm font-medium text-txt">{integrationTm.avgDuration || '0:00'}</td>
              </tr>
              <tr>
                <td className="text-sm text-txt-2">Subscribers mới</td>
                <td className="text-right text-sm font-medium text-success">+{formatNumber(wealthTm.subscribersGained || 0)}</td>
                <td className="text-right text-sm font-medium text-success">+{formatNumber(wellnessTm.subscribersGained || 0)}</td>
                <td className="text-right text-sm font-medium text-success">+{formatNumber(integrationTm.subscribersGained || 0)}</td>
              </tr>
              <tr>
                <td className="text-sm text-txt-2">Doanh thu</td>
                <td className="text-right text-sm font-medium text-success">{formatCurrency(wealthTm.revenue || 0)}</td>
                <td className="text-right text-sm font-medium text-txt">{formatCurrency(wellnessTm.revenue || 0)}</td>
                <td className="text-right text-sm font-medium text-txt">{formatCurrency(integrationTm.revenue || 0)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {/* Recommendation */}
        {bestTrack && (
          <div className="mt-4 p-3 rounded-card bg-gold/5 border border-gold/10">
            <div className="flex items-start gap-2">
              <Lightbulb size={14} className="text-gold mt-0.5 flex-shrink-0" />
              <p className="text-xs text-txt-2 leading-relaxed">
                <strong className="text-gold">Khuyến nghị:</strong> Track {bestTrack.label} dẫn đầu về % Xem ({bestTrack.avgCtr}%).
                Xem xét tăng sản lượng nội dung cho track này.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// Tab: AI Phan Tich
// ===========================================================================

// ===========================================================================
// Insight Action Buttons — integrate with Content Center features
// ===========================================================================
const AI_INSIGHTS_CACHE_KEY = 'cc_ai_insights_cache';

function InsightActions({ type, data }) {
  const btnClass = "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-card text-xs font-medium transition-all";
  const primary = `${btnClass} bg-gold/10 text-gold border border-gold/30 hover:bg-gold/20`;
  const secondary = `${btnClass} text-txt-3 hover:text-txt hover:bg-bg-4 border border-border`;

  const goTo = (path, params) => {
    const url = new URL(window.location.origin + path);
    if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    window.location.href = url.toString();
  };

  switch (type) {
    case 'summary':
      return (
        <div className="mt-4 pt-3 border-t border-border flex items-center gap-2 flex-wrap">
          <button className={primary} onClick={() => goTo('/admin/cc/ai-gen')}>
            <Sparkles size={13} /> Tạo nội dung từ insight
          </button>
          <button className={secondary} onClick={() => {
            void copyToClipboard(data.content.join('\n'));
          }}>
            <Download size={13} /> Copy tóm tắt
          </button>
        </div>
      );
    case 'top':
      return (
        <div className="mt-4 pt-3 border-t border-border flex items-center gap-2 flex-wrap">
          <button className={primary} onClick={() => goTo('/admin/cc/ai-gen', { ref: 'top_video' })}>
            <Wand2 size={13} /> Tạo script tương tự
          </button>
          <button className={secondary} onClick={() => goTo('/admin/cc/repurpose')}>
            <RefreshCw size={13} /> Tái sử dụng nội dung
          </button>
        </div>
      );
    case 'underperform':
      return (
        <div className="mt-4 pt-3 border-t border-border flex items-center gap-2 flex-wrap">
          <button className={primary} onClick={() => goTo('/admin/cc/ai-gen', { ref: 'improve' })}>
            <Wand2 size={13} /> Tạo script cải thiện
          </button>
          <button className={secondary} onClick={() => goTo('/admin/cc/optim')}>
            <Zap size={13} /> Tối ưu tiêu đề & CTA
          </button>
        </div>
      );
    case 'action':
      return (
        <div className="mt-4 pt-3 border-t border-border flex items-center gap-2 flex-wrap">
          <button className={primary} onClick={() => goTo('/admin/cc/calendar')}>
            <Calendar size={13} /> Tạo lịch hành động
          </button>
          <button className={secondary} onClick={() => goTo('/admin/cc/ai-gen')}>
            <ArrowRight size={13} /> Bắt đầu thực hiện
          </button>
          <button className={secondary} onClick={() => {
            void copyToClipboard(data.content.join('\n'));
          }}>
            <Download size={13} /> Copy kế hoạch
          </button>
        </div>
      );
    case 'gap':
      return (
        <div className="mt-4 pt-3 border-t border-border flex items-center gap-2 flex-wrap">
          <button className={primary} onClick={() => goTo('/admin/cc/ai-gen', { ref: 'fill_gap' })}>
            <Sparkles size={13} /> Tạo nội dung mới
          </button>
          <button className={secondary} onClick={() => goTo('/admin/cc/calendar')}>
            <Calendar size={13} /> Lên lịch đăng
          </button>
        </div>
      );
    case 'title':
      return (
        <div className="mt-4 pt-3 border-t border-border flex items-center gap-2 flex-wrap">
          <button className={primary} onClick={() => goTo('/admin/cc/optim')}>
            <Zap size={13} /> Tối ưu tiêu đề
          </button>
          <button className={secondary} onClick={() => goTo('/admin/cc/ai-gen', { ref: 'titles' })}>
            <Wand2 size={13} /> Tạo tiêu đề mới
          </button>
        </div>
      );
    case 'revenue':
      return (
        <div className="mt-4 pt-3 border-t border-border flex items-center gap-2 flex-wrap">
          <button className={primary} onClick={() => goTo('/admin/cc/funnels')}>
            <TrendingUp size={13} /> Xem phễu chuyển đổi
          </button>
          <button className={secondary} onClick={() => goTo('/admin/cc/optim')}>
            <Zap size={13} /> Tối ưu CTA & doanh thu
          </button>
        </div>
      );
    default:
      return null;
  }
}

function AIAnalysisTab({ stats, channelStats, insights, onReanalyze, onClearInsights, analyzingAI, aiProvider, aiModel, onProviderChange, onModelChange }) {
  const [expandedId, setExpandedId] = useState(null);

  // Build insight cards from real AI data or show empty state
  const insightCards = useMemo(() => {
    if (!insights || insights.length === 0) return [];

    // Map the latest AI insight to display cards
    const latest = insights[0];
    const dp = latest.data_points || latest;
    const cards = [];

    // Summary card
    if (latest.description || dp.summary) {
      cards.push({
        id: 'summary', type: 'summary', icon: BarChart3, color: 'text-emerald',
        title: 'Tổng Quan Hiệu Suất',
        content: (latest.description || dp.summary || '').split('. ').filter(Boolean).map(s => s.endsWith('.') ? s : s + '.'),
      });
    }

    // Top performers
    if (dp.top_performers && dp.top_performers.length > 0) {
      cards.push({
        id: 'top', type: 'top', icon: TrendingUp, color: 'text-gold',
        title: 'Video Hiệu Suất Cao',
        content: dp.top_performers.map(tp => `"${tp.title}" -- ${tp.metric}: ${tp.value}. ${tp.why || ''}`),
      });
    }

    // Underperformers
    if (dp.underperformers && dp.underperformers.length > 0) {
      cards.push({
        id: 'underperform', type: 'underperform', icon: AlertTriangle, color: 'text-danger',
        title: 'Cần Cải Thiện',
        content: dp.underperformers.map(up => `"${up.title}" -- ${up.issue}. ${up.fix || ''}`),
      });
    }

    // Action plan
    if (dp.action_plan && dp.action_plan.length > 0) {
      cards.push({
        id: 'action', type: 'action', icon: Target, color: 'text-cyan',
        title: 'Kế Hoạch Hành Động',
        content: dp.action_plan.map(ap => `[${ap.priority}] ${ap.action} (${ap.deadline})`),
      });
    }

    // Content gaps
    if (dp.content_gaps) {
      const gapItems = [
        ...(dp.content_gaps.missing_tracks || []),
        ...(dp.content_gaps.missing_personas || []),
      ];
      if (gapItems.length > 0) {
        cards.push({
          id: 'gap', type: 'gap', icon: Search, color: 'text-purple',
          title: 'Khoảng Trống Nội Dung',
          content: gapItems,
        });
      }
    }

    // Title insights
    if (dp.title_insights && dp.title_insights.recommendation) {
      cards.push({
        id: 'title', type: 'title', icon: Lightbulb, color: 'text-gold',
        title: 'Phân Tích Tiêu Đề & Thumbnail',
        content: [
          `Công thức tốt nhất: ${dp.title_insights.best_formula}`,
          `Công thức kém nhất: ${dp.title_insights.worst_formula}`,
          `Khuyến nghị: ${dp.title_insights.recommendation}`,
        ],
      });
    }

    // Revenue insights
    if (dp.revenue_insights && dp.revenue_insights.optimization) {
      cards.push({
        id: 'revenue', type: 'revenue', icon: DollarSign, color: 'text-emerald',
        title: 'Gợi Ý Tối Ưu Doanh Thu',
        content: [
          `RPM trend: ${dp.revenue_insights.rpm_trend}`,
          `Track doanh thu tốt nhất: ${dp.revenue_insights.best_revenue_track}`,
          `Tối ưu: ${dp.revenue_insights.optimization}`,
        ],
      });
    }

    return cards;
  }, [insights]);

  return (
    <div className="space-y-4">
      {/* AI banner */}
      <div className="flex items-center gap-3 p-4 rounded-card bg-purple/10 border border-purple/20">
        <Sparkles size={20} className="text-gold flex-shrink-0" />
        <div className="flex-1">
          <p className="text-sm text-txt font-medium">
            Phân tích được tạo bởi AI dựa trên dữ liệu YouTube thực
          </p>
          <p className="text-xs text-txt-3 mt-0.5">
            {insights.length > 0 && insights[0].created_at
              ? `Cập nhật lần cuối: ${new Date(insights[0].created_at).toLocaleString('vi-VN')}`
              : 'Chưa có phân tích — nhấn "Phân tích lại" để bắt đầu'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {insights.length > 0 && (
            <button
              onClick={onClearInsights}
              className="btn btn-gh text-xs !px-3 !py-1.5"
              title="Xóa phân tích"
            >
              <X size={12} />
              Xóa
            </button>
          )}
          <button
            onClick={onReanalyze}
            disabled={analyzingAI}
            className="btn btn-o text-xs !px-3 !py-1.5"
          >
            {analyzingAI ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {analyzingAI ? 'Đang phân tích...' : 'Phân tích lại'}
          </button>
        </div>
      </div>

      {/* AI Model Selection */}
      <div className="flex items-center gap-3 flex-wrap">
        <CCSelect
          label="AI Provider"
          options={AI_PROVIDER_OPTIONS}
          value={aiProvider}
          onChange={(e) => onProviderChange(e.target.value)}
          disabled={analyzingAI}
        />
        <CCSelect
          label={aiProvider === 'gemini' ? 'Gemini Model' : 'Claude Model'}
          options={AI_MODEL_OPTIONS[aiProvider] ?? []}
          value={aiModel}
          onChange={(e) => onModelChange(e.target.value)}
          disabled={analyzingAI}
        />
      </div>

      {/* Quick stats for AI context */}
      <div className="g4">
        <div className="card text-center">
          <p className="text-2xl font-heading font-bold text-gold">{stats?.ctr || 0}%</p>
          <p className="text-[10px] text-txt-3 mt-1">% Xem TB</p>
        </div>
        <div className="card text-center">
          <p className="text-2xl font-heading font-bold text-purple">{stats?.avgDuration || '0:00'}</p>
          <p className="text-[10px] text-txt-3 mt-1">Thời gian xem TB</p>
        </div>
        <div className="card text-center">
          <p className="text-2xl font-heading font-bold text-emerald">{formatNumber(channelStats?.subscriberCount || stats?.subscribers || 0)}</p>
          <p className="text-[10px] text-txt-3 mt-1">Subscribers</p>
          {stats?.subscribersGained ? (
            <p className="text-[10px] text-txt-3">+{formatNumber(stats.subscribersGained)} trong kỳ</p>
          ) : null}
        </div>
        <div className="card text-center">
          <p className="text-2xl font-heading font-bold text-cyan">{formatCurrency(stats?.revenue || 0)}</p>
          <p className="text-[10px] text-txt-3 mt-1">Doanh thu</p>
          {stats?.revenueChange ? (
            <p className={`text-[10px] ${stats.revenueChange >= 0 ? 'text-success' : 'text-danger'}`}>
              {stats.revenueChange >= 0 ? '+' : ''}{stats.revenueChange}% so với kỳ trước
            </p>
          ) : null}
        </div>
      </div>

      {/* Insight Cards */}
      {insightCards.length === 0 ? (
        <EmptyState message="Chưa có phân tích AI. Nhấn 'Phân tích lại' để AI phân tích dữ liệu YouTube của bạn." />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {insightCards.map((insight) => {
            const Icon = insight.icon;
            const isExpanded = expandedId === insight.id;
            const isFullWidth = insight.type === 'action' || insight.type === 'summary';
            const displayItems = isExpanded ? insight.content : insight.content.slice(0, 3);

            return (
              <div
                key={insight.id}
                className={`glass-card p-5 transition-all duration-300 ${
                  isFullWidth ? 'lg:col-span-2' : ''
                }`}
              >
                <div className="flex items-center gap-3 mb-4">
                  <div className={`p-2 rounded-card bg-glass-bg/50 ${insight.color}`}>
                    <Icon size={18} />
                  </div>
                  <h3 className="font-heading text-base font-semibold text-txt flex-1">
                    {insight.title}
                  </h3>
                  {insight.content.length > 3 && (
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : insight.id)}
                      className="text-xs text-gold hover:text-gold-l transition-colors"
                    >
                      {isExpanded ? 'Thu gọn' : `+${insight.content.length - 3} mục`}
                    </button>
                  )}
                </div>
                <ul className="space-y-2.5">
                  {displayItems.map((item, i) => (
                    <li key={i} className="flex items-start gap-2.5">
                      <span
                        className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${
                          insight.type === 'action' ? 'bg-cyan' :
                          insight.type === 'top' ? 'bg-gold' :
                          insight.type === 'underperform' ? 'bg-danger' :
                          'bg-txt-3'
                        }`}
                      />
                      <span className="text-sm text-txt-2 leading-relaxed">{item}</span>
                    </li>
                  ))}
                </ul>
                {/* Action buttons per insight type */}
                <InsightActions type={insight.type} data={insight} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Connect YouTube CTA
// ===========================================================================

function ConnectYouTubeCTA() {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');

  const handleConnect = useCallback(() => {
    const clientId = (import.meta.env.VITE_GOOGLE_CLIENT_ID || '').trim();
    if (!clientId) {
      setError('Chưa cấu hình Google Client ID. Vui lòng thêm VITE_GOOGLE_CLIENT_ID vào .env.local');
      return;
    }

    setConnecting(true);
    setError('');

    // Google OAuth 2.0 Authorization Code Flow (with refresh token)
    const redirectUri = `${window.location.origin}/admin`;
    const scope = [
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/yt-analytics.readonly',
      'https://www.googleapis.com/auth/yt-analytics-monetary.readonly',
    ].join(' ');

    const state = crypto.randomUUID();
    sessionStorage.setItem('yt_oauth_state', state);

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope,
      state,
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'consent',
    });

    window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }, []);

  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="glass-card p-12 text-center max-w-lg">
        <div className="inline-flex p-5 rounded-full bg-danger/10 mb-6">
          <Youtube size={56} className="text-danger" />
        </div>
        <h2 className="font-heading text-3xl font-semibold text-txt mb-3">
          Kết Nối YouTube Analytics
        </h2>
        <p className="text-sm text-txt-2 max-w-md mx-auto mb-4 leading-relaxed">
          Kết nối kênh <strong className="text-gold">Jennie Uyên Chu — Thức Tỉnh Tâm Thức</strong> để
          xem phân tích chi tiết về lượt xem, % xem, thời gian xem, doanh thu, và nhiều chỉ số khác.
        </p>
        <div className="flex items-center justify-center gap-4 mb-6">
          <div className="flex items-center gap-2 text-xs text-txt-3">
            <CheckCircle size={14} className="text-success" />
            <span>Chỉ đọc dữ liệu</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-txt-3">
            <CheckCircle size={14} className="text-success" />
            <span>An toàn & bảo mật</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-txt-3">
            <CheckCircle size={14} className="text-success" />
            <span>Hủy bất kỳ lúc nào</span>
          </div>
        </div>
        <button
          onClick={handleConnect}
          disabled={connecting}
          className="btn btn-primary inline-flex items-center gap-2 text-base !px-8 !py-3"
        >
          {connecting ? (
            <>
              <Loader2 size={20} className="animate-spin" />
              Đang kết nối...
            </>
          ) : (
            <>
              <Youtube size={20} />
              Kết Nối Kênh YouTube
            </>
          )}
        </button>
        {error && (
          <p className="text-xs text-danger mt-3 bg-danger/10 p-2 rounded-card">{error}</p>
        )}
        <p className="text-xs text-txt-3 mt-5 leading-relaxed">
          Chúng tôi sử dụng OAuth 2.0 để kết nối an toàn. Ứng dụng chỉ đọc dữ liệu phân tích, không chỉnh sửa kênh của bạn.
        </p>
        {/* Features preview */}
        <div className="mt-8 pt-6 border-t border-border">
          <p className="text-xs text-txt-3 mb-4">Sau khi kết nối, bạn sẽ có:</p>
          <div className="grid grid-cols-2 gap-3">
            {[
              { icon: Eye, label: 'Phân tích lượt xem' },
              { icon: MousePointerClick, label: 'Theo dõi % xem' },
              { icon: Activity, label: 'Đường cong giữ chân' },
              { icon: DollarSign, label: 'Báo cáo doanh thu' },
              { icon: Users, label: 'Phân tích đối tượng' },
              { icon: Sparkles, label: 'AI phân tích tự động' },
            ].map(({ icon: FIcon, label }) => (
              <div key={label} className="flex items-center gap-2 p-2 rounded-card bg-glass-bg/20">
                <FIcon size={14} className="text-gold" />
                <span className="text-xs text-txt-2">{label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// Main Page Component
// ===========================================================================

export default function AnalyticsPage() {
  const [activeTab, setActiveTab] = useState('ai_analysis');
  const [dateRange, setDateRange] = useState('90d');
  const [selectedVideoId, setSelectedVideoId] = useState(null);

  // Real data state
  const [isConnected, setIsConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [accessToken, setAccessToken] = useState(null);
  const [tokenExpired, setTokenExpired] = useState(false);
  const [channelStats, setChannelStats] = useState(null);
  const [videos, setVideos] = useState([]);
  const [stats, setStats] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState(null);
  const [insights, setInsights] = useState(() => {
    try {
      const cached = localStorage.getItem(AI_INSIGHTS_CACHE_KEY);
      return cached ? JSON.parse(cached) : [];
    } catch { return []; }
  });
  const [trafficSources, setTrafficSources] = useState([]);
  const [demographics, setDemographics] = useState([]);
  const [ctrTrend, setCtrTrend] = useState([]);
  const [analyzingAI, setAnalyzingAI] = useState(false);
  const [dataStale, setDataStale] = useState(false);
  const [aiProvider, setAiProvider] = useState('claude');
  const [aiModel, setAiModel] = useState('sonnet');

  // Persist AI insights to localStorage whenever they change
  useEffect(() => {
    if (insights.length > 0) {
      try { localStorage.setItem(AI_INSIGHTS_CACHE_KEY, JSON.stringify(insights)); } catch { /* ignore */ }
    }
  }, [insights]);

  // Clear AI insights handler
  const handleClearInsights = useCallback(() => {
    setInsights([]);
    localStorage.removeItem(AI_INSIGHTS_CACHE_KEY);
  }, []);

  // Helper: clear expired token and reset state
  const clearExpiredToken = useCallback(() => {
    localStorage.removeItem('yt_access_token');
    localStorage.removeItem('yt_token_expires_at');
    setAccessToken(null);
    setIsConnected(false);
    setTokenExpired(true);
  }, []);

  // Helper: check if stored token is expired
  const isTokenExpired = useCallback(() => {
    const expiresAt = localStorage.getItem('yt_token_expires_at');
    if (!expiresAt) return false; // No expiry info — try using the token anyway
    return Date.now() >= parseInt(expiresAt, 10);
  }, []);

  // Track metrics computed from videos
  const trackMetrics = useMemo(() => {
    const tracks = {};
    for (const v of videos) {
      const t = v.track || 'integration';
      if (!tracks[t]) {
        tracks[t] = {
          track: t,
          label: TRACK_LABELS[t] || t,
          totalViews: 0,
          totalCtr: 0,
          ctrCount: 0,
          totalDuration: 0,
          durationCount: 0,
          videoCount: 0,
          subscribersGained: 0,
          revenue: 0,
          topVideo: '',
          topViews: 0,
        };
      }
      tracks[t].totalViews += v.views || 0;
      tracks[t].totalCtr += v.ctr || 0;
      tracks[t].ctrCount += v.ctr ? 1 : 0;
      tracks[t].totalDuration += v.avgDurationSec || 0;
      tracks[t].durationCount += v.avgDurationSec ? 1 : 0;
      tracks[t].videoCount++;
      tracks[t].subscribersGained += v.subscribers || 0;
      tracks[t].revenue += v.revenue || 0;
      if ((v.views || 0) > tracks[t].topViews) {
        tracks[t].topViews = v.views;
        tracks[t].topVideo = v.title;
      }
    }
    return Object.values(tracks).map((t) => ({
      ...t,
      avgCtr: t.ctrCount > 0 ? parseFloat((t.totalCtr / t.ctrCount).toFixed(1)) : 0,
      avgDuration: t.durationCount > 0 ? formatDuration(t.totalDuration / t.durationCount) : '0:00',
      color: t.track === 'wealth' ? 'gold' : t.track === 'wellness' ? 'purple' : 'emerald',
    }));
  }, [videos]);

  // --------------------------------------------------------------------------
  // YouTube OAuth helpers (must be before fetchAllData)
  // --------------------------------------------------------------------------
  const callYouTubeOAuth = useCallback(async (action, extraBody = {}) => {
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    const { data: { session } } = await mainSupabase.auth.getSession();
    if (!session) return null;

    const res = await fetch(`${supabaseUrl}/functions/v1/youtube-oauth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ action, ...extraBody }),
    });
    return res.json();
  }, []);

  const tryRefreshToken = useCallback(async () => {
    console.log('[Analytics] Attempting token refresh...');
    const result = await callYouTubeOAuth('refresh');
    if (result?.success && result.access_token) {
      console.log('[Analytics] Token refreshed successfully');
      const expiresAt = Date.now() + (result.expires_in || 3600) * 1000;
      localStorage.setItem('yt_access_token', result.access_token);
      localStorage.setItem('yt_token_expires_at', String(expiresAt));
      setAccessToken(result.access_token);
      setIsConnected(true);
      setTokenExpired(false);
      return result.access_token;
    }
    console.warn('[Analytics] Token refresh failed:', result?.error);
    return null;
  }, [callYouTubeOAuth]);

  // --------------------------------------------------------------------------
  // Fetch all data from YouTube APIs
  // --------------------------------------------------------------------------
  const fetchAllData = useCallback(async (token, range) => {
    try {
      const currentRange = range || dateRange;

      // 1. Channel stats — also serves as token validity check
      try {
        const channel = await youtubeService.getChannelStats(token);
        setChannelStats(channel);
        setTokenExpired(false);
      } catch (err) {
        console.error('[Analytics] Channel stats error:', err);
        // Detect expired/invalid token (YouTube API returns 401 or message contains 401)
        if (err?.message?.includes('401') || err?.message?.includes('Unauthorized')) {
          console.warn('[Analytics] Token expired — attempting auto-refresh...');
          const newToken = await tryRefreshToken();
          if (newToken) {
            // Retry with new token
            try {
              const channel = await youtubeService.getChannelStats(newToken);
              setChannelStats(channel);
              token = newToken; // Use refreshed token for remaining calls
            } catch (retryErr) {
              console.error('[Analytics] Retry after refresh failed:', retryErr);
              clearExpiredToken();
              return;
            }
          } else {
            clearExpiredToken();
            return;
          }
        }
      }

      // 2. Get synced videos from CC Supabase cache (optional, may fail)
      try {
        const syncedVideos = await youtubeService.getSyncedVideos(50).catch(() => []);
        if (syncedVideos.length > 0) {
          setVideos(syncedVideos.map((v) => ({
            ...v,
            avgDurationSec: v.durationSeconds || 0,
            avgDuration: formatDuration(v.durationSeconds || 0),
            ctr: 0, revenue: 0, subscribers: 0,
            track: 'integration', retention: [],
          })));
        }
      } catch (_) { /* CC Supabase cache — non-critical */ }

      // 3. Last sync time (optional)
      try {
        const syncTime = await youtubeService.getLastSyncTime().catch(() => null);
        setLastSync(syncTime);
        if (syncTime) {
          const syncDate = new Date(syncTime);
          setDataStale((Date.now() - syncDate.getTime()) / 3600000 > 24);
        }
      } catch (_) { /* non-critical */ }

      // 4. YouTube Analytics API -- channel analytics
      const endDate = new Date().toISOString().split('T')[0];
      const startDate = getStartDate(currentRange);

      try {
        // Valid YT Analytics API v2 metrics (impressions/impressionClickThroughRate are NOT valid)
        const analyticsUrl = `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=${startDate}&endDate=${endDate}&metrics=views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost,estimatedRevenue&sort=-views`;
        let analyticsRes = await fetch(analyticsUrl, { headers: { Authorization: `Bearer ${token}` } });
        if (analyticsRes.status === 401 || analyticsRes.status === 403) {
          const newToken = await tryRefreshToken();
          if (newToken) {
            token = newToken;
            analyticsRes = await fetch(analyticsUrl, { headers: { Authorization: `Bearer ${token}` } });
          } else {
            clearExpiredToken();
            return;
          }
        }
        if (!analyticsRes.ok) {
          const errBody = await analyticsRes.text().catch(() => '');
          console.error(`[Analytics] Channel analytics API ${analyticsRes.status}:`, errBody);
        }
        if (analyticsRes.ok) {
          const analyticsData = await analyticsRes.json();
          // metrics order: views, estimatedMinutesWatched, averageViewDuration, averageViewPercentage, subscribersGained, subscribersLost, estimatedRevenue
          const row = analyticsData.rows?.[0];
          if (row) {
            const totalViews = row[0] || 0;
            const avgViewDuration = row[2] || 0;
            const avgViewPercentage = row[3] || 0;
            const subscribersGained = row[4] || 0;
            const estimatedRevenue = row[6] || 0;

            setStats({
              views: totalViews,
              viewsChange: 0,
              ctr: parseFloat(avgViewPercentage.toFixed(1)), // Use avg view % as engagement proxy
              ctrChange: 0,
              avgDuration: formatDuration(avgViewDuration),
              avgDurationChange: 0,
              revenue: Math.round(estimatedRevenue),
              revenueChange: 0,
              subscribers: 0,
              subscribersGained,
              subscribersChange: 0,
            });
          }
        }
      } catch (err) {
        console.error('[Analytics] Channel analytics error:', err);
      }

      // 5. Traffic sources
      try {
        const trafficUrl = `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=${startDate}&endDate=${endDate}&metrics=views&dimensions=insightTrafficSourceType&sort=-views&maxResults=10`;
        const trafficRes = await fetch(trafficUrl, { headers: { Authorization: `Bearer ${token}` } });
        if (!trafficRes.ok) {
          const errBody = await trafficRes.text().catch(() => '');
          console.error(`[Analytics] Traffic API ${trafficRes.status}:`, errBody);
        }
        if (trafficRes.ok) {
          const trafficData = await trafficRes.json();
          const totalTrafficViews = (trafficData.rows || []).reduce((sum, r) => sum + r[1], 0);
          setTrafficSources((trafficData.rows || []).map((r, idx) => ({
            source: mapTrafficSource(r[0]),
            percentage: totalTrafficViews > 0 ? Math.round((r[1] / totalTrafficViews) * 100) : 0,
            views: r[1],
            color: getTrafficColor(idx),
          })));
        }
      } catch (err) {
        console.error('[Analytics] Traffic sources error:', err);
      }

      // 6. Demographics
      try {
        const demoUrl = `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=${startDate}&endDate=${endDate}&metrics=viewerPercentage&dimensions=ageGroup,gender&sort=ageGroup`;
        const demoRes = await fetch(demoUrl, { headers: { Authorization: `Bearer ${token}` } });
        if (!demoRes.ok) {
          console.error(`[Analytics] Demographics API ${demoRes.status}:`, await demoRes.text().catch(() => ''));
        } else {
          const demoData = await demoRes.json();
          console.log('[Analytics] Demographics data:', demoData.rows?.length, 'rows');
          const ageMap = {};
          for (const row of (demoData.rows || [])) {
            const [age, gender, pct] = row;
            if (!ageMap[age]) ageMap[age] = { ageGroup: age, male: 0, female: 0, total: 0 };
            if (gender === 'male') ageMap[age].male = Math.round(pct);
            else ageMap[age].female = Math.round(pct);
            ageMap[age].total = ageMap[age].male + ageMap[age].female;
          }
          setDemographics(Object.values(ageMap));
        }
      } catch (err) {
        console.error('[Analytics] Demographics error:', err);
      }

      // 7. CTR trend (monthly)
      try {
        const trendUrl = `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=${startDate}&endDate=${endDate}&metrics=views,averageViewPercentage&dimensions=month&sort=month`;
        const trendRes = await fetch(trendUrl, { headers: { Authorization: `Bearer ${token}` } });
        if (!trendRes.ok) {
          console.error(`[Analytics] CTR trend API ${trendRes.status}:`, await trendRes.text().catch(() => ''));
        }
        if (trendRes.ok) {
          const trendData = await trendRes.json();
          console.log('[Analytics] CTR trend data:', trendData.rows?.length, 'rows');
          setCtrTrend((trendData.rows || []).map((r) => ({
            label: `T${parseInt(r[0].split('-')[1])}`,
            views: r[1],
            ctr: parseFloat((r[2] || 0).toFixed(1)),
          })));
        }
      } catch (err) {
        console.error('[Analytics] CTR trend error:', err);
      }

      // 8. Per-video analytics (CTR, revenue, watch time per video)
      try {
        // video dimension: impressionClickThroughRate not available, use averageViewPercentage instead
        const videoAnalyticsUrl = `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=${startDate}&endDate=${endDate}&metrics=views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,estimatedRevenue,subscribersGained,likes,comments&dimensions=video&sort=-views&maxResults=50`;
        const videoAnalyticsRes = await fetch(videoAnalyticsUrl, { headers: { Authorization: `Bearer ${token}` } });
        if (!videoAnalyticsRes.ok) {
          const errBody = await videoAnalyticsRes.text().catch(() => '');
          console.error(`[Analytics] Video analytics API ${videoAnalyticsRes.status}:`, errBody);
        }
        if (videoAnalyticsRes.ok) {
          const videoAnalyticsData = await videoAnalyticsRes.json();
          const videoRows = videoAnalyticsData.rows || [];

          if (videoRows.length > 0) {
            // Get video details (title, thumbnail, etc.) from Data API
            const videoIds = videoRows.map((r) => r[0]);
            let detailMap = {};
            try {
              const videoDetails = await youtubeService.getVideoPerformance(token, videoIds);
              detailMap = Object.fromEntries(videoDetails.map((v) => [v.id, v]));

              // Sync to Supabase
              await youtubeService.syncToSupabase(videoDetails).catch(() => {});
            } catch (detailErr) {
              console.error('[Analytics] Video details error:', detailErr);
            }

            const enrichedVideos = videoRows.map((r) => {
              const detail = detailMap[r[0]] || {};
              // r[1..8] = Analytics API period-specific data (only for selected date range)
              // detail.views/likes/comments = Data API v3 lifetime totals (all-time)
              // Use lifetime totals for display & AI; keep period data as separate fields
              return {
                id: r[0],
                title: detail.title || r[0],
                publishedAt: detail.publishedAt || '',
                thumbnailUrl: detail.thumbnailUrl || '',
                views: detail.views || r[1] || 0,           // lifetime total
                likes: detail.likes || r[7] || 0,           // lifetime total
                comments: detail.comments || r[8] || 0,     // lifetime total
                // Period-specific metrics from Analytics API v2
                periodViews: r[1] || 0,
                avgDurationSec: r[3],
                avgDuration: formatDuration(r[3]),
                ctr: parseFloat((r[4] || 0).toFixed(1)),    // averageViewPercentage (period)
                revenue: parseFloat(r[5]?.toFixed(2) || '0'),
                subscribers: r[6] || 0,
                periodLikes: r[7] || 0,
                periodComments: r[8] || 0,
                durationSeconds: detail.durationSeconds || 0,
                track: 'integration', // Default, can be enriched from cc_yt_videos
                retention: [],
              };
            });

            setVideos(enrichedVideos);
          }
        }
      } catch (err) {
        console.error('[Analytics] Video analytics error:', err);
      }

      // 9. Previous period comparison for stats changes
      try {
        const prevStartDate = getPrevStartDate(currentRange, startDate);
        const prevEndDate = startDate;
        // Same metrics as main query: views, estimatedMinutesWatched, averageViewDuration, averageViewPercentage, subscribersGained, subscribersLost, estimatedRevenue
        const prevAnalyticsUrl = `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=${prevStartDate}&endDate=${prevEndDate}&metrics=views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost,estimatedRevenue`;
        const prevRes = await fetch(prevAnalyticsUrl, { headers: { Authorization: `Bearer ${token}` } });
        if (prevRes.ok) {
          const prevData = await prevRes.json();
          const prevRow = prevData.rows?.[0];
          if (prevRow) {
            setStats((prev) => {
              if (!prev) return prev;
              const calcChange = (current, previous) =>
                previous > 0 ? parseFloat(((current - previous) / previous * 100).toFixed(1)) : 0;
              return {
                ...prev,
                viewsChange: calcChange(prev.views, prevRow[0]),
                ctrChange: calcChange(prev.ctr, prevRow[3] || 0),
                avgDurationChange: calcChange(parseSeconds(prev.avgDuration), prevRow[2]),
                revenueChange: calcChange(prev.revenue, prevRow[6]),
              };
            });
          }
        }
      } catch (err) {
        console.error('[Analytics] Prev period comparison error:', err);
      }

      // 10. Load AI insights from Supabase
      try {
        const insightHistory = await analyticsAI.getInsightHistory(5);
        if (insightHistory && insightHistory.length > 0) {
          setInsights(insightHistory);
        }
      } catch (err) {
        console.error('[Analytics] Insights error:', err);
      }

    } catch (err) {
      console.error('[Analytics] Fetch error:', err);
    }
  }, [dateRange, clearExpiredToken, tryRefreshToken]);

  // Save to cache whenever key data changes
  useEffect(() => {
    if (!isConnected || !channelStats) return;
    saveAnalyticsCache(dateRange, {
      channelStats, videos, stats, trafficSources, demographics, ctrTrend, insights, lastSync,
    });
  }, [isConnected, dateRange, channelStats, videos, stats, trafficSources, demographics, ctrTrend, insights, lastSync]);

  // --------------------------------------------------------------------------
  // Restore cached data instantly, then refresh in background
  // --------------------------------------------------------------------------
  const restoreCache = useCallback((range) => {
    const cached = loadAnalyticsCache(range || dateRange);
    if (!cached) return false;
    console.log('[Analytics] Restoring cached data (age:', Math.round((Date.now() - cached._ts) / 1000), 's)');
    if (cached.channelStats) setChannelStats(cached.channelStats);
    if (cached.videos?.length) setVideos(cached.videos);
    if (cached.stats) setStats(cached.stats);
    if (cached.trafficSources?.length) setTrafficSources(cached.trafficSources);
    if (cached.demographics?.length) setDemographics(cached.demographics);
    if (cached.ctrTrend?.length) setCtrTrend(cached.ctrTrend);
    if (cached.insights?.length) setInsights(cached.insights);
    if (cached.lastSync) setLastSync(cached.lastSync);
    return true;
  }, [dateRange]);

  // --------------------------------------------------------------------------
  // Initialize: check YouTube connection and fetch data
  // --------------------------------------------------------------------------
  useEffect(() => {
    async function init() {
      try {
        // Use MAIN Supabase for profiles (not CC Supabase)
        if (!mainSupabase) {
          console.error('[Analytics] Main Supabase not initialized');
          setLoading(false);
          return;
        }

        // 1. Check for Authorization Code callback (?code=xxx&state=xxx)
        const urlParams = new URLSearchParams(window.location.search);
        const authCode = urlParams.get('code');
        const returnedState = urlParams.get('state');
        const savedState = sessionStorage.getItem('yt_oauth_state');

        if (authCode) {
          // Clean URL
          window.history.replaceState(null, '', window.location.pathname);
          sessionStorage.removeItem('yt_oauth_state');

          if (!savedState || returnedState === savedState) {
            console.log('[Analytics] Authorization code received, exchanging...');
            const redirectUri = `${window.location.origin}/admin`;
            const result = await callYouTubeOAuth('exchange', { code: authCode, redirect_uri: redirectUri });

            if (result?.success && result.access_token) {
              const expiresAt = Date.now() + (result.expires_in || 3600) * 1000;
              localStorage.setItem('yt_access_token', result.access_token);
              localStorage.setItem('yt_token_expires_at', String(expiresAt));
              setAccessToken(result.access_token);
              setIsConnected(true);
              setTokenExpired(false);
              console.log(`[Analytics] Token received (expires in ${result.expires_in}s, refresh: ${result.has_refresh_token})`);
              await fetchAllData(result.access_token);
              setLoading(false);
              return;
            } else {
              console.error('[Analytics] Code exchange failed:', result?.error);
            }
          }
        }

        // 1b. Legacy: check for implicit flow hash token (backward compat)
        const stashedHash = sessionStorage.getItem('yt_oauth_token');
        if (stashedHash) {
          const params = new URLSearchParams(stashedHash);
          const oauthToken = params.get('access_token');
          sessionStorage.removeItem('yt_oauth_token');
          sessionStorage.removeItem('yt_oauth_state');
          if (oauthToken) {
            const expiresIn = parseInt(params.get('expires_in') || '3600', 10);
            localStorage.setItem('yt_access_token', oauthToken);
            localStorage.setItem('yt_token_expires_at', String(Date.now() + expiresIn * 1000));
            setAccessToken(oauthToken);
            setIsConnected(true);
            setTokenExpired(false);
            await fetchAllData(oauthToken);
            setLoading(false);
            return;
          }
        }

        // 2. Check existing token from localStorage or Supabase
        let token = localStorage.getItem('yt_access_token');
        if (!token) {
          const { data: { user } } = await mainSupabase.auth.getUser();
          if (user) {
            const { data } = await mainSupabase.from('profiles').select('youtube_access_token').eq('id', user.id).single();
            token = data?.youtube_access_token;
          }
        }
        if (token) {
          // If token is expired, try auto-refresh first
          if (isTokenExpired()) {
            console.warn('[Analytics] Stored token expired — trying refresh...');
            // Show cached data while refreshing token
            const hadCache = restoreCache();
            if (hadCache) {
              setIsConnected(true);
              setLoading(false);
            }
            const newToken = await tryRefreshToken();
            if (newToken) {
              await fetchAllData(newToken);
              setLoading(false);
              return;
            }
            // Refresh failed — clear and prompt re-connect
            localStorage.removeItem('yt_access_token');
            localStorage.removeItem('yt_token_expires_at');
            setTokenExpired(true);
            setLoading(false);
            return;
          }

          setAccessToken(token);
          setIsConnected(true);

          // Restore cached data immediately → no loading spinner
          const hadCache = restoreCache();
          if (hadCache) {
            setLoading(false);
            // Background refresh — update data silently
            fetchAllData(token).catch(console.error);
            return;
          }

          // No cache — must wait for fetch
          await fetchAllData(token);
        }
      } catch (err) {
        console.error('[Analytics] Init error:', err);
      } finally {
        setLoading(false);
      }
    }
    init();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --------------------------------------------------------------------------
  // Re-fetch when dateRange changes — show cache first, then refresh
  // --------------------------------------------------------------------------
  const initialMount = React.useRef(true);
  useEffect(() => {
    if (initialMount.current) {
      initialMount.current = false;
      return; // Skip on mount — init() handles it
    }
    if (accessToken) {
      // Show cached data for new range instantly if available
      restoreCache(dateRange);
      fetchAllData(accessToken, dateRange);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateRange, accessToken]);

  // --------------------------------------------------------------------------
  // Sync handler
  // --------------------------------------------------------------------------
  const handleSync = useCallback(async () => {
    if (!accessToken) return;
    setSyncing(true);
    try {
      await fetchAllData(accessToken);
      setLastSync(new Date().toISOString());
      setDataStale(false);
    } catch (err) {
      console.error('[Analytics] Sync error:', err);
    } finally {
      setSyncing(false);
    }
  }, [accessToken, fetchAllData]);

  // --------------------------------------------------------------------------
  // AI re-analyze handler
  // --------------------------------------------------------------------------
  const handleReanalyze = useCallback(async () => {
    setAnalyzingAI(true);
    try {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 90);
      // Pass already-loaded video data with both lifetime and period metrics
      const videoData = videos.map((v) => ({
        youtube_id: v.id,
        title: v.title,
        content_type: v.contentType || 'latc',
        track: v.track || 'integration',
        views: v.views || 0,
        likes: v.likes || 0,
        comments: v.comments || 0,
        ctr: v.ctr || 0,
        avg_view_duration_sec: v.avgDurationSec || 0,
        published_at: v.publishedAt || '',
        last_synced_at: new Date().toISOString(),
        // Period-specific metrics (for date range comparison)
        period_views: v.periodViews || 0,
        period_likes: v.periodLikes || 0,
        period_comments: v.periodComments || 0,
        revenue_in_period: v.revenue || 0,
        subscribers_gained_in_period: v.subscribers || 0,
      }));
      const result = await analyticsAI.generateWeeklyInsights(startDate, endDate, videoData, {
        provider: aiProvider,
        model: aiModel,
      });
      if (result) {
        setInsights((prev) => [result, ...prev.slice(0, 4)]);
      }
    } catch (err) {
      console.error('[Analytics] AI analysis error:', err);
    } finally {
      setAnalyzingAI(false);
    }
  }, [videos, aiProvider, aiModel]);

  // Not connected or token expired state
  if (!loading && (!isConnected || tokenExpired)) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-card bg-emerald/10">
            <BarChart3 size={24} className="text-emerald" />
          </div>
          <div>
            <h2 className="font-heading text-2xl font-semibold text-txt">
              Phân Tích YouTube
            </h2>
            <p className="text-xs text-txt-3 mt-0.5">
              Jennie Uyên Chu — Thức Tỉnh Tâm Thức
            </p>
          </div>
        </div>
        {tokenExpired && (
          <div className="flex items-center gap-3 p-4 rounded-card bg-warning/10 border border-warning/30">
            <AlertTriangle size={18} className="text-warning flex-shrink-0" />
            <div className="flex-1">
              <p className="text-sm text-warning font-medium">Phiên YouTube đã hết hạn</p>
              <p className="text-xs text-txt-3 mt-0.5">Token truy cập YouTube chỉ có hiệu lực ~1 giờ. Vui lòng kết nối lại để xem dữ liệu phân tích.</p>
            </div>
          </div>
        )}
        <ConnectYouTubeCTA />
      </div>
    );
  }

  // Loading state
  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-card bg-emerald/10">
            <BarChart3 size={24} className="text-emerald" />
          </div>
          <h2 className="font-heading text-2xl font-semibold text-txt">
            Phân Tích YouTube
          </h2>
        </div>
        <LoadingOverlay />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-card bg-emerald/10">
            <BarChart3 size={24} className="text-emerald" />
          </div>
          <div>
            <h2 className="font-heading text-2xl font-semibold text-txt">
              Phân Tích YouTube
            </h2>
            <p className="text-xs text-txt-3 mt-0.5 flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-success animate-pulse" />
              {channelStats?.title || 'Jennie Uyên Chu — Thức Tỉnh Tâm Thức'} &bull; {formatNumber(channelStats?.subscriberCount || 0)} subscribers &bull; Cập nhật: {lastSync ? new Date(lastSync).toLocaleString('vi-VN') : 'Chưa đồng bộ'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {dataStale && <StaleBadge />}
          <DateRangePicker value={dateRange} onChange={setDateRange} />
          <button
            onClick={handleSync}
            disabled={syncing}
            className="btn btn-o inline-flex items-center gap-2"
          >
            <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Đang đồng bộ...' : 'Đồng bộ dữ liệu'}
          </button>
        </div>
      </div>

      {/* Sync animation bar */}
      {syncing && (
        <div className="h-1 rounded-full overflow-hidden bg-glass-bg">
          <div className="h-full bg-gradient-to-r from-gold via-purple to-emerald animate-pulse rounded-full" style={{ width: '60%' }} />
        </div>
      )}

      {/* KPI Stat Cards */}
      <div className="g4">
        <StatCardMini
          label="Lượt Xem"
          value={formatNumber(stats?.views || 0)}
          change={stats?.viewsChange ?? null}
          icon={Eye}
          colorClass="text-gold"
          scVariant="gd"
        />
        <StatCardMini
          label="% XEM TRUNG BÌNH"
          value={`${stats?.ctr || 0}%`}
          change={stats?.ctrChange ?? null}
          icon={MousePointerClick}
          colorClass="text-purple"
          scVariant="pu"
        />
        <StatCardMini
          label="Thời Gian Xem TB"
          value={stats?.avgDuration || '0:00'}
          change={stats?.avgDurationChange ?? null}
          icon={Clock}
          colorClass="text-cyan"
          scVariant="bl"
        />
        <StatCardMini
          label="Doanh Thu"
          value={formatCurrency(stats?.revenue || 0)}
          change={stats?.revenueChange ?? null}
          icon={DollarSign}
          colorClass="text-emerald"
          scVariant="em"
        />
      </div>

      {/* Tab Navigation */}
      <div className="flex items-center gap-2 flex-wrap border-b border-border pb-3">
        <TabButton
          active={activeTab === 'ai_analysis'}
          onClick={() => setActiveTab('ai_analysis')}
          icon={Sparkles}
        >
          AI Phân Tích
        </TabButton>
        <TabButton
          active={activeTab === 'overview'}
          onClick={() => setActiveTab('overview')}
          icon={BarChart3}
        >
          Tổng Quan
        </TabButton>
        <TabButton
          active={activeTab === 'by_video'}
          onClick={() => setActiveTab('by_video')}
          icon={Play}
        >
          Theo Video
        </TabButton>
        <TabButton
          active={activeTab === 'by_track'}
          onClick={() => setActiveTab('by_track')}
          icon={Layers}
        >
          Theo Track
        </TabButton>
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <OverviewTab
          dateRange={dateRange}
          selectedVideoId={selectedVideoId}
          onSelectVideo={setSelectedVideoId}
          ctrTrend={ctrTrend}
          trafficSources={trafficSources}
          demographics={demographics}
          videos={videos}
          accessToken={accessToken}
        />
      )}
      {activeTab === 'by_video' && <ByVideoTab videos={videos} />}
      {activeTab === 'by_track' && <ByTrackTab trackMetrics={trackMetrics} />}
      {activeTab === 'ai_analysis' && (
        <AIAnalysisTab
          stats={stats}
          channelStats={channelStats}
          insights={insights}
          onReanalyze={handleReanalyze}
          onClearInsights={handleClearInsights}
          analyzingAI={analyzingAI}
          aiProvider={aiProvider}
          aiModel={aiModel}
          onProviderChange={(p) => {
            setAiProvider(p);
            const models = AI_MODEL_OPTIONS[p] ?? [];
            setAiModel(models[0]?.value ?? '');
          }}
          onModelChange={setAiModel}
        />
      )}

      {/* Footer */}
      <div className="flex items-center gap-3 p-4 rounded-card bg-glass-bg/20 border border-border">
        <FileText size={14} className="text-txt-3 flex-shrink-0" />
        <div className="flex-1">
          <p className="text-xs text-txt-3">
            Dữ liệu được lấy trực tiếp từ YouTube Analytics API.
            Kênh: <strong className="text-txt-2">{channelStats?.title || 'Jennie Uyên Chu — Thức Tỉnh Tâm Thức'}</strong>.
            {lastSync ? ` Đồng bộ lần cuối: ${new Date(lastSync).toLocaleString('vi-VN')}.` : ' Chưa đồng bộ.'}
          </p>
        </div>
        <a href="#" className="text-gold hover:text-gold-l text-xs inline-flex items-center gap-1 whitespace-nowrap transition-colors">
          Hướng dẫn kết nối <ExternalLink size={10} />
        </a>
      </div>
    </div>
  );
}
