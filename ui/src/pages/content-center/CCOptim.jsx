import React, { useState, useMemo } from 'react';
import {
  Zap,
  Brain,
  Cpu,
  Eye,
  Search,
  Database,
  Globe,
  ChevronDown,
  ChevronRight,
  CheckCircle,
  Clock,
  CircleDot,
  Route,
  Fingerprint,
  Target,
  Scissors,
  FlaskConical,
  Network,
  Radio,
  MonitorPlay,
  HardDrive,
  Layers,
  Cog,
  AlertTriangle,
  Tag,
  Link2,
  Copy,
  MessageSquare,
  Keyboard,
  Command,
  Palette,
  Smartphone,
  GripVertical,
  FileEdit,
  Cloud,
  Youtube,
  Download,
  Webhook,
  Archive,
  FileSearch,
  Timer,
  PieChart,
  Server,
  BookOpen,
  Languages,
  Hash,
  Type,
  ListChecks,
  TrendingUp,
} from 'lucide-react';
import CCSelect from './CCSelect';

// ============================================================================
// Data — All 37 Optimizations across 7 Categories
// ============================================================================

const CATEGORIES = [
  {
    id: 'ai',
    name: 'Thuật Toán AI',
    description: '7 tối ưu hoá liên quan đến AI và machine learning',
    icon: Brain,
    color: 'text-gold',
    borderColor: 'border-l-gold',
    optimizations: [
      {
        id: 'ai-1',
        name: 'Cascading Pipeline',
        description: 'Pipeline phân tầng: Haiku cho phân loại nhanh, Sonnet cho tạo nội dung, Opus cho phân tích phức tạp. Tự động chuyển model theo độ khó của tác vụ.',
        status: 'done',
        priority: 'critical',
        icon: Route,
      },
      {
        id: 'ai-2',
        name: 'Model Router',
        description: 'Hệ thống định tuyến tự động chọn model phù hợp dựa trên loại nội dung, độ dài yêu cầu, và độ phức tạp của prompt. Giảm chi phí 40% mà vẫn đảm bảo chất lượng.',
        status: 'done',
        priority: 'critical',
        icon: Network,
      },
      {
        id: 'ai-3',
        name: 'Brand Voice Embeddings',
        description: 'Vector hoá 10 quy tắc vàng và brand voice documents. So sánh semantic similarity để đảm bảo mọi nội dung phù hợp thương hiệu Jennie.',
        status: 'in-progress',
        priority: 'high',
        icon: Fingerprint,
      },
      {
        id: 'ai-4',
        name: 'CTR Prediction',
        description: 'Mô hình dự đoán Click-Through Rate cho tiêu đề và thumbnail dựa trên dữ liệu YouTube Analytics lịch sử. Gợi ý tiêu đề có CTR tiềm năng cao nhất.',
        status: 'planned',
        priority: 'high',
        icon: Target,
      },
      {
        id: 'ai-5',
        name: 'Smart Clip Scoring',
        description: 'Chấm điểm tự động các đoạn video dựa trên sentiment analysis, nội dung và mức độ tương tác dự kiến. Ưu tiên các đoạn có điểm cao cho clip ngắn.',
        status: 'in-progress',
        priority: 'medium',
        icon: Scissors,
      },
      {
        id: 'ai-6',
        name: 'Prompt A/B Testing',
        description: 'Hệ thống thử nghiệm A/B cho prompt templates. Tự động so sánh kết quả của 2+ biến thể prompt và chọn prompt hiệu quả nhất theo tiêu chí đã định.',
        status: 'planned',
        priority: 'medium',
        icon: FlaskConical,
      },
      {
        id: 'ai-7',
        name: 'Knowledge Graph',
        description: 'Xây dựng đồ thị tri thức từ tất cả nội dung đã tạo. Liên kết các chủ đề, từ khoá, và concepts để gợi ý nội dung liên quan và tránh trùng lặp.',
        status: 'planned',
        priority: 'low',
        icon: Network,
      },
    ],
  },
  {
    id: 'performance',
    name: 'Hiệu Suất',
    description: '6 tối ưu hoá về tốc độ và hiệu suất hệ thống',
    icon: Cpu,
    color: 'text-purple',
    borderColor: 'border-l-purple',
    optimizations: [
      {
        id: 'perf-1',
        name: 'Streaming Response',
        description: 'Hiển thị kết quả AI theo thời gian thực khi đang tạo. Người dùng thấy nội dung xuất hiện từng dòng thay vì đợi hết 30-45 giây. UX tốt hơn 10x.',
        status: 'done',
        priority: 'critical',
        icon: Radio,
      },
      {
        id: 'perf-2',
        name: 'GPU Video Processing',
        description: 'Sử dụng GPU acceleration (CUDA/Metal) cho FFmpeg video processing trên Desktop app. Giảm thời gian xử lý video 5-8x so với CPU.',
        status: 'planned',
        priority: 'high',
        icon: MonitorPlay,
      },
      {
        id: 'perf-3',
        name: 'Prefetch & Preload',
        description: 'Tự động tải trước dữ liệu của trang tiếp theo khi hover link. Preload fonts, icons và critical CSS cho First Contentful Paint nhanh hơn.',
        status: 'done',
        priority: 'medium',
        icon: Zap,
      },
      {
        id: 'perf-4',
        name: 'SQLite WAL Mode',
        description: 'Write-Ahead Logging cho SQLite trên Desktop. Cho phép đọc và ghi đồng thời, tăng throughput database 2-3x. Kết hợp với offline-first architecture.',
        status: 'planned',
        priority: 'medium',
        icon: HardDrive,
      },
      {
        id: 'perf-5',
        name: 'Lazy Loading',
        description: 'Chỉ tải components và dữ liệu khi cần thiết. Code splitting theo route, lazy load images và heavy components. Giảm initial bundle size 60%.',
        status: 'done',
        priority: 'high',
        icon: Layers,
      },
      {
        id: 'perf-6',
        name: 'Web Workers',
        description: 'Chuyển các tác vụ nặng (markdown parsing, word count, text analysis) sang background thread. Giữ main thread luôn mượt cho UI interactions.',
        status: 'planned',
        priority: 'low',
        icon: Cog,
      },
    ],
  },
  {
    id: 'detection',
    name: 'Phát Hiện Logic',
    description: '5 tối ưu hoá về phát hiện và xử lý tự động',
    icon: Eye,
    color: 'text-emerald',
    borderColor: 'border-l-emerald',
    optimizations: [
      {
        id: 'det-1',
        name: 'Anomaly Detection',
        description: 'Phát hiện bất thường trong nội dung: từ cấm xuất hiện, giọng điệu sai, cấu trúc không đúng. Tự động cảnh báo trước khi xuất bản.',
        status: 'done',
        priority: 'critical',
        icon: AlertTriangle,
      },
      {
        id: 'det-2',
        name: 'Auto Classifier',
        description: 'Tự động phân loại nội dung vào trụ cột (Wealth/Wellness/Integration) dựa trên nội dung. Gán tag và danh mục không cần nhập thủ công.',
        status: 'done',
        priority: 'high',
        icon: Tag,
      },
      {
        id: 'det-3',
        name: 'Series Linker',
        description: 'Tự động liên kết các tập trong cùng series. Phát hiện khi tiêu đề có số thứ tự và gợi ý liên kết với các tập trước/sau.',
        status: 'in-progress',
        priority: 'medium',
        icon: Link2,
      },
      {
        id: 'det-4',
        name: 'Duplicate Detection',
        description: 'Phát hiện nội dung trùng lặp hoặc quá giống nhau. Cảnh báo khi người dùng tạo kịch bản có cùng chủ đề hoặc cấu trúc với kịch bản đã tồn tại.',
        status: 'planned',
        priority: 'medium',
        icon: Copy,
      },
      {
        id: 'det-5',
        name: 'Feedback Loop',
        description: 'Thu thập phản hồi từ người dùng về chất lượng nội dung. Sử dụng để tinh chỉnh prompt templates và cải thiện kết quả AI theo thời gian.',
        status: 'planned',
        priority: 'high',
        icon: MessageSquare,
      },
    ],
  },
  {
    id: 'uiux',
    name: 'UI/UX',
    description: '6 tối ưu hoá về trải nghiệm người dùng',
    icon: Palette,
    color: 'text-blue',
    borderColor: 'border-l-blue',
    optimizations: [
      {
        id: 'ui-1',
        name: 'Keyboard Shortcuts',
        description: 'Phím tắt cho mọi thao tác chính: Ctrl+N tạo mới, Ctrl+S lưu, Ctrl+G tạo AI, Ctrl+P xem trước. Tăng tốc độ làm việc 30% cho power users.',
        status: 'done',
        priority: 'high',
        icon: Keyboard,
      },
      {
        id: 'ui-2',
        name: 'Command Palette',
        description: 'Palette lệnh nhanh (Ctrl+K) để truy cập mọi chức năng, chuyển trang, tìm kiếm kịch bản, và thực hiện hành động nhanh. Giống VS Code / Notion.',
        status: 'in-progress',
        priority: 'high',
        icon: Command,
      },
      {
        id: 'ui-3',
        name: 'Theme Toggle',
        description: 'Chuyển đổi giữa Dark mode (mặc định) và Light mode. Lưu preference vào localStorage và Supabase profile. Hỗ trợ system preference.',
        status: 'planned',
        priority: 'low',
        icon: Palette,
      },
      {
        id: 'ui-4',
        name: 'Mobile Responsive',
        description: 'Giao diện responsive cho tablet và mobile. Sidebar thu gọn, card stack, touch-friendly buttons. Hỗ trợ PWA cho mobile browsers.',
        status: 'in-progress',
        priority: 'medium',
        icon: Smartphone,
      },
      {
        id: 'ui-5',
        name: 'Drag & Drop',
        description: 'Kéo thả để sắp xếp thứ tự sections trong kịch bản, di chuyển items trong calendar, và upload files. Sử dụng dnd-kit cho performance tốt.',
        status: 'done',
        priority: 'medium',
        icon: GripVertical,
      },
      {
        id: 'ui-6',
        name: 'Rich Text Editor',
        description: 'Editor WYSIWYG cho kịch bản với formatting, headings, lists, highlights. Hỗ trợ markdown shortcuts và real-time collaboration (tương lai).',
        status: 'in-progress',
        priority: 'high',
        icon: FileEdit,
      },
    ],
  },
  {
    id: 'integration',
    name: 'Tích Hợp',
    description: '5 tối ưu hoá về kết nối và tích hợp bên ngoài',
    icon: Globe,
    color: 'text-rose-700 dark:text-rose-400',
    borderColor: 'border-l-rose-400',
    optimizations: [
      {
        id: 'int-1',
        name: 'Supabase MCP',
        description: 'Model Context Protocol cho Supabase. Tự động sync schema, generate types, và thao tác database trực tiếp từ development environment.',
        status: 'done',
        priority: 'critical',
        icon: Cloud,
      },
      {
        id: 'int-2',
        name: 'YouTube Sync',
        description: 'Đồng bộ hai chiều với YouTube: pull analytics data, push metadata updates. Tự động cập nhật tiêu đề và mô tả khi nội dung thay đổi.',
        status: 'planned',
        priority: 'high',
        icon: Youtube,
      },
      {
        id: 'int-3',
        name: 'Multi-Format Export',
        description: 'Xuất nội dung ra nhiều định dạng: PDF, DOCX, HTML, Markdown, SRT, VTT. Template tuỳ chỉnh cho từng loại nội dung và nền tảng.',
        status: 'in-progress',
        priority: 'medium',
        icon: Download,
      },
      {
        id: 'int-4',
        name: 'Webhook Events',
        description: 'Hệ thống webhook thông báo khi có sự kiện: nội dung mới, duyệt xong, xuất bản. Kết nối với Slack, Discord, Zapier, hoặc hệ thống riêng.',
        status: 'planned',
        priority: 'low',
        icon: Webhook,
      },
      {
        id: 'int-5',
        name: 'Scheduled Backup',
        description: 'Tự động sao lưu dữ liệu định kỳ lên S3-compatible storage. Hỗ trợ point-in-time recovery và disaster recovery plan.',
        status: 'in-progress',
        priority: 'high',
        icon: Archive,
      },
    ],
  },
  {
    id: 'data',
    name: 'Dữ Liệu',
    description: '4 tối ưu hoá về quản lý và xử lý dữ liệu',
    icon: Database,
    color: 'text-amber-700 dark:text-amber-400',
    borderColor: 'border-l-amber-400',
    optimizations: [
      {
        id: 'data-1',
        name: 'Full-Text Search',
        description: 'Tìm kiếm toàn văn với PostgreSQL tsvector. Tìm kiếm kịch bản theo nội dung, tiêu đề, tags với ranking kết quả theo relevance. Hỗ trợ tiếng Việt.',
        status: 'done',
        priority: 'high',
        icon: FileSearch,
      },
      {
        id: 'data-2',
        name: 'Data Retention Policy',
        description: 'Chính sách lưu trữ dữ liệu tự động: Archive kịch bản cũ sau 90 ngày, xoá draft sau 30 ngày không hoạt động. Tiết kiệm storage 40%.',
        status: 'planned',
        priority: 'medium',
        icon: Timer,
      },
      {
        id: 'data-3',
        name: 'Analytics Aggregation',
        description: 'Tự động tổng hợp dữ liệu analytics theo ngày/tuần/tháng. Pre-compute các metrics thường dùng để dashboard load nhanh hơn 5x.',
        status: 'in-progress',
        priority: 'high',
        icon: PieChart,
      },
      {
        id: 'data-4',
        name: 'Response Cache',
        description: 'Cache kết quả AI cho các prompt tương tự. Sử dụng semantic similarity để tìm cache hit. Giảm API calls 25% và tiết kiệm chi phí.',
        status: 'planned',
        priority: 'medium',
        icon: Server,
      },
    ],
  },
  {
    id: 'vietnamese',
    name: 'Tiếng Việt',
    description: '4 tối ưu hoá đặc biệt cho ngôn ngữ tiếng Việt',
    icon: Languages,
    color: 'text-cyan',
    borderColor: 'border-l-cyan',
    optimizations: [
      {
        id: 'vn-1',
        name: 'Term Conversion',
        description: 'Hệ thống chuyển đổi thuật ngữ Anh-Việt tự động và nhất quán. Bảng thuật ngữ riêng cho trading, tâm linh, lifestyle. Tích hợp vào AI prompts.',
        status: 'done',
        priority: 'critical',
        icon: BookOpen,
      },
      {
        id: 'vn-2',
        name: 'Diacritics Handling',
        description: 'Xử lý chính xác dấu tiếng Việt trong tất cả text processing. Tìm kiếm không phân biệt dấu, tự động sửa lỗi dấu khi nhập liệu.',
        status: 'done',
        priority: 'high',
        icon: Languages,
      },
      {
        id: 'vn-3',
        name: 'Vietnamese Word Count',
        description: 'Đếm từ chính xác cho tiếng Việt (khác với đếm từ tiếng Anh). Sử dụng cho LATC 4000-5500 từ và TMT 4500-5500 từ. Tính cả từ ghép.',
        status: 'done',
        priority: 'high',
        icon: Hash,
      },
      {
        id: 'vn-4',
        name: 'UI Strings Vietnamese',
        description: 'Toàn bộ giao diện bằng tiếng Việt có dấu. Không dùng emoji, chỉ dùng Lucide icons. Sẵn sàng cho i18n nếu cần hỗ trợ đa ngôn ngữ.',
        status: 'done',
        priority: 'critical',
        icon: Type,
      },
    ],
  },
];

// ============================================================================
// Helpers
// ============================================================================

function getStatusConfig(status) {
  switch (status) {
    case 'done':
      return { label: 'Hoàn Thành', className: 'bg-emerald/10 text-emerald', icon: CheckCircle };
    case 'in-progress':
      return { label: 'Đang Làm', className: 'bg-gold/10 text-gold', icon: Clock };
    case 'planned':
      return { label: 'Dự Kiến', className: 'bg-purple/10 text-purple', icon: CircleDot };
  }
}

function getPriorityConfig(priority) {
  switch (priority) {
    case 'critical':
      return { label: 'Cực Kỳ Quan Trọng', className: 'bg-rose-400/10 text-rose-700 dark:text-rose-400' };
    case 'high':
      return { label: 'Cao', className: 'bg-amber-400/10 text-amber-700 dark:text-amber-400' };
    case 'medium':
      return { label: 'Trung Bình', className: 'bg-blue/10 text-blue' };
    case 'low':
      return { label: 'Thấp', className: 'bg-bg-4 text-txt-3' };
  }
}

// ============================================================================
// Sub-Components
// ============================================================================

function OverallProgressBar({
  total,
  done,
  inProgress,
  planned,
}) {
  const donePct = (done / total) * 100;
  const inProgressPct = (inProgress / total) * 100;

  return (
    <div className="card p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-heading text-sm font-semibold text-txt flex items-center gap-2">
          <TrendingUp size={16} className="text-gold" />
          Tiến Độ Tổng Thể
        </h3>
        <span className="text-sm font-heading font-bold text-gold">
          {done}/{total} hoàn thành
        </span>
      </div>
      <div className="w-full bg-bg-4 rounded-full h-3 overflow-hidden mb-4">
        <div className="h-full flex">
          <div
            className="bg-emerald h-full transition-all duration-500"
            style={{ width: `${donePct}%` }}
          />
          <div
            className="bg-gold h-full transition-all duration-500"
            style={{ width: `${inProgressPct}%` }}
          />
        </div>
      </div>
      <div className="flex items-center gap-6 text-xs">
        <span className="flex items-center gap-1.5">
          <CheckCircle size={12} className="text-emerald" />
          <span className="text-txt-2">{done} Hoàn Thành</span>
        </span>
        <span className="flex items-center gap-1.5">
          <Clock size={12} className="text-gold" />
          <span className="text-txt-2">{inProgress} Đang Làm</span>
        </span>
        <span className="flex items-center gap-1.5">
          <CircleDot size={12} className="text-purple" />
          <span className="text-txt-2">{planned} Dự Kiến</span>
        </span>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------

function CategoryProgressBar({
  category,
}) {
  const total = category.optimizations.length;
  const done = category.optimizations.filter((o) => o.status === 'done').length;
  const inProgress = category.optimizations.filter((o) => o.status === 'in-progress').length;
  const donePct = (done / total) * 100;
  const inProgressPct = (inProgress / total) * 100;

  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 bg-bg-4 rounded-full h-1.5 overflow-hidden">
        <div className="h-full flex">
          <div className="bg-emerald h-full" style={{ width: `${donePct}%` }} />
          <div className="bg-gold h-full" style={{ width: `${inProgressPct}%` }} />
        </div>
      </div>
      <span className="text-xxs text-txt-3 w-12 text-right">
        {done}/{total}
      </span>
    </div>
  );
}

// --------------------------------------------------------------------------

function OptimizationCard({ optim }) {
  const statusCfg = getStatusConfig(optim.status);
  const priorityCfg = getPriorityConfig(optim.priority);
  const Icon = optim.icon;
  const StatusIcon = statusCfg.icon;

  return (
    <div className="p-4 rounded-card bg-glass-bg border border-border hover:border-border-2 transition-all">
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded flex items-center justify-center bg-bg-4 shrink-0 mt-0.5">
          <Icon size={16} className="text-txt-2" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-1">
            <h4 className="text-xs font-semibold text-txt">{optim.name}</h4>
            <div className="flex items-center gap-1.5 shrink-0">
              <span className={`text-xxs px-1.5 py-0.5 rounded-badge ${priorityCfg.className}`}>
                {priorityCfg.label}
              </span>
              <span className={`text-xxs px-1.5 py-0.5 rounded-badge flex items-center gap-1 ${statusCfg.className}`}>
                <StatusIcon size={10} />
                {statusCfg.label}
              </span>
            </div>
          </div>
          <p className="text-xxs text-txt-3 leading-relaxed">{optim.description}</p>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Main Page Component
// ============================================================================

export default function OptimizationsPage() {
  const [expandedCategories, setExpandedCategories] = useState(
    new Set(CATEGORIES.map((c) => c.id)),
  );
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterPriority, setFilterPriority] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  // --- Computed values ---
  const allOptims = useMemo(
    () => CATEGORIES.flatMap((c) => c.optimizations),
    [],
  );
  const totalDone = allOptims.filter((o) => o.status === 'done').length;
  const totalInProgress = allOptims.filter((o) => o.status === 'in-progress').length;
  const totalPlanned = allOptims.filter((o) => o.status === 'planned').length;

  const filteredCategories = useMemo(() => {
    return CATEGORIES.map((cat) => ({
      ...cat,
      optimizations: cat.optimizations.filter((o) => {
        const matchStatus = filterStatus === 'all' || o.status === filterStatus;
        const matchPriority = filterPriority === 'all' || o.priority === filterPriority;
        const matchSearch =
          !searchQuery ||
          o.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          o.description.toLowerCase().includes(searchQuery.toLowerCase());
        return matchStatus && matchPriority && matchSearch;
      }),
    })).filter((cat) => cat.optimizations.length > 0);
  }, [filterStatus, filterPriority, searchQuery]);

  const toggleCategory = (id) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const expandAll = () => {
    setExpandedCategories(new Set(CATEGORIES.map((c) => c.id)));
  };

  const collapseAll = () => {
    setExpandedCategories(new Set());
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-2xl font-bold text-txt flex items-center gap-3">
            <Zap size={24} className="text-gold" />
            37 Tối Ưu Hoá
          </h1>
          <p className="text-sm text-txt-3 mt-1">
            7 danh mục, 37 tối ưu hoá cho GEM Content Control Center
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={expandAll} className="btn btn-gh text-xs">
            Mở tất cả
          </button>
          <button onClick={collapseAll} className="btn btn-gh text-xs">
            Đóng tất cả
          </button>
        </div>
      </div>

      {/* Overall Progress */}
      <OverallProgressBar
        total={allOptims.length}
        done={totalDone}
        inProgress={totalInProgress}
        planned={totalPlanned}
      />

      {/* Category KPI Cards */}
      <div className="grid grid-cols-7 gap-2">
        {CATEGORIES.map((cat) => {
          const Icon = cat.icon;
          const done = cat.optimizations.filter((o) => o.status === 'done').length;
          const total = cat.optimizations.length;
          return (
            <div
              key={cat.id}
              className="card p-3 text-center cursor-pointer hover:border-border-2 transition-all"
              onClick={() => {
                const el = document.getElementById(`cat-${cat.id}`);
                el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                setExpandedCategories((prev) => {
                  const next = new Set(prev);
                  next.add(cat.id);
                  return next;
                });
              }}
            >
              <Icon size={18} className={`${cat.color} mx-auto mb-1.5`} />
              <p className="text-xxs text-txt-2 font-medium mb-1 leading-tight">{cat.name}</p>
              <p className="text-xs font-heading font-bold text-txt">
                {done}/{total}
              </p>
            </div>
          );
        })}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-txt-3" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Tìm kiếm tối ưu hoá..."
            className="fi pl-10 w-full"
          />
        </div>
        <CCSelect
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="text-xs"
        >
          <option value="all">Tất cả trạng thái</option>
          <option value="done">Hoàn Thành</option>
          <option value="in-progress">Đang Làm</option>
          <option value="planned">Dự Kiến</option>
        </CCSelect>
        <CCSelect
          value={filterPriority}
          onChange={(e) => setFilterPriority(e.target.value)}
          className="text-xs"
        >
          <option value="all">Tất cả ưu tiên</option>
          <option value="critical">Cực Kỳ Quan Trọng</option>
          <option value="high">Cao</option>
          <option value="medium">Trung Bình</option>
          <option value="low">Thấp</option>
        </CCSelect>
        {(filterStatus !== 'all' || filterPriority !== 'all' || searchQuery) && (
          <button
            onClick={() => {
              setFilterStatus('all');
              setFilterPriority('all');
              setSearchQuery('');
            }}
            className="btn btn-gh text-xxs"
          >
            Xoá bộ lọc
          </button>
        )}
      </div>

      {/* Categories List */}
      <div className="space-y-4">
        {filteredCategories.map((cat) => {
          const Icon = cat.icon;
          const isExpanded = expandedCategories.has(cat.id);
          const originalCat = CATEGORIES.find((c) => c.id === cat.id);

          return (
            <div key={cat.id} id={`cat-${cat.id}`} className="card overflow-hidden">
              {/* Category Header */}
              <button
                onClick={() => toggleCategory(cat.id)}
                className={`w-full flex items-center gap-3 p-4 text-left transition-all hover:bg-glass-bg border-l-[3px] ${originalCat.borderColor}`}
              >
                {isExpanded ? (
                  <ChevronDown size={16} className="text-txt-3 shrink-0" />
                ) : (
                  <ChevronRight size={16} className="text-txt-3 shrink-0" />
                )}
                <div className="w-8 h-8 rounded-card bg-bg-4 flex items-center justify-center shrink-0">
                  <Icon size={18} className={originalCat.color} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-txt">{originalCat.name}</h3>
                    <span className="text-xxs text-txt-3">
                      ({cat.optimizations.length} tối ưu hoá)
                    </span>
                  </div>
                  <p className="text-xxs text-txt-3">{originalCat.description}</p>
                </div>
                <div className="w-32 shrink-0">
                  <CategoryProgressBar category={originalCat} />
                </div>
              </button>

              {/* Category Content */}
              {isExpanded && (
                <div className="p-4 pt-0 space-y-2">
                  {cat.optimizations.map((optim) => (
                    <OptimizationCard key={optim.id} optim={optim} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* No Results */}
      {filteredCategories.length === 0 && (
        <div className="card p-12 text-center">
          <Search size={48} className="mx-auto mb-4 text-txt-3" />
          <p className="text-sm text-txt-2 mb-1">Không tìm thấy tối ưu hoá nào</p>
          <p className="text-xs text-txt-3">Thử thay đổi bộ lọc hoặc từ khoá tìm kiếm</p>
        </div>
      )}

      {/* Summary Table */}
      <div className="card overflow-hidden">
        <div className="p-4 border-b border-border">
          <h3 className="font-heading text-sm font-semibold text-txt flex items-center gap-2">
            <ListChecks size={16} className="text-gold" />
            Bảng Tổng Hợp
          </h3>
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-glass-bg">
              <th className="text-left text-xxs text-txt-3 font-medium p-3">Danh Mục</th>
              <th className="text-center text-xxs text-txt-3 font-medium p-3">Tổng</th>
              <th className="text-center text-xxs text-txt-3 font-medium p-3">Hoàn Thành</th>
              <th className="text-center text-xxs text-txt-3 font-medium p-3">Đang Làm</th>
              <th className="text-center text-xxs text-txt-3 font-medium p-3">Dự Kiến</th>
              <th className="text-center text-xxs text-txt-3 font-medium p-3">Tỉ Lệ</th>
            </tr>
          </thead>
          <tbody>
            {CATEGORIES.map((cat) => {
              const Icon = cat.icon;
              const done = cat.optimizations.filter((o) => o.status === 'done').length;
              const inProg = cat.optimizations.filter((o) => o.status === 'in-progress').length;
              const planned = cat.optimizations.filter((o) => o.status === 'planned').length;
              const total = cat.optimizations.length;
              const pct = Math.round((done / total) * 100);
              return (
                <tr key={cat.id} className="border-b border-border last:border-0 hover:bg-glass-bg transition-all">
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <Icon size={14} className={cat.color} />
                      <span className="text-xs text-txt font-medium">{cat.name}</span>
                    </div>
                  </td>
                  <td className="p-3 text-center text-xs text-txt-2">{total}</td>
                  <td className="p-3 text-center text-xs text-emerald">{done}</td>
                  <td className="p-3 text-center text-xs text-gold">{inProg}</td>
                  <td className="p-3 text-center text-xs text-purple">{planned}</td>
                  <td className="p-3 text-center">
                    <span className={`text-xs font-medium ${pct === 100 ? 'text-emerald' : pct >= 50 ? 'text-gold' : 'text-txt-3'}`}>
                      {pct}%
                    </span>
                  </td>
                </tr>
              );
            })}
            <tr className="bg-glass-bg font-semibold">
              <td className="p-3 text-xs text-txt">Tổng Cộng</td>
              <td className="p-3 text-center text-xs text-txt">{allOptims.length}</td>
              <td className="p-3 text-center text-xs text-emerald">{totalDone}</td>
              <td className="p-3 text-center text-xs text-gold">{totalInProgress}</td>
              <td className="p-3 text-center text-xs text-purple">{totalPlanned}</td>
              <td className="p-3 text-center text-xs text-gold">
                {Math.round((totalDone / allOptims.length) * 100)}%
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
