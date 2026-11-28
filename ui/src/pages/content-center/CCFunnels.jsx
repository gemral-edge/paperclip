import React, { useState } from 'react';
import {
  GitBranch,
  TrendingUp,
  ArrowRight,
  ArrowDown,
  ChevronRight,
  Package,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Eye,
  Smartphone,
  GraduationCap,
  Crown,
  Star,
  Zap,
  Heart,
  ShieldAlert,
  ShieldCheck,
  RotateCcw,
  DollarSign,
  BarChart3,
  Layers,
  Grid3X3,
  MessageSquare,
  ThumbsUp,
  ThumbsDown,
  Lightbulb,
  Sparkles,
  Pencil,
  Check,
  X,
  Filter,
  Award,
} from 'lucide-react';
import CCSelect from './CCSelect';

// ============================================================================
// Funnel Data
// ============================================================================

const funnelTracks = [
  {
    id: 'wealth',
    label: 'Tài Chính',
    subtitle: 'Wealth Track',
    color: 'text-gold',
    bgColor: 'bg-gold',
    borderColor: 'border-gold',
    badgeColor: 'bg-gold/10',
    icon: DollarSign,
    totalConversion: 4.2,
    steps: [
      {
        id: 'w1',
        stepNumber: 1,
        name: 'Drama Content',
        price: 'Miễn phí',
        ctaType: 'Nội dung thu hút',
        conversionRate: 100,
        description: 'Video drama crypto, câu chuyện thị trường, phân tích xu hướng gây tò mò',
      },
      {
        id: 'w2',
        stepNumber: 2,
        name: 'Scanner Free Trial',
        price: 'Miễn phí (7 ngày)',
        ctaType: 'Dùng thử công cụ',
        conversionRate: 38,
        description: 'Dùng thử GEM Scanner miễn phí, trải nghiệm công cụ quét tín hiệu',
      },
      {
        id: 'w3',
        stepNumber: 3,
        name: '299K Starter',
        price: '299.000 VNĐ',
        ctaType: 'Khoá học cơ bản',
        conversionRate: 22,
        description: 'Khoá học nhập môn giao dịch, nền tảng kiến thức cơ bản',
      },
      {
        id: 'w4',
        stepNumber: 4,
        name: 'TIER 1',
        price: '11.000.000 VNĐ',
        ctaType: 'Khoá học nâng cao',
        conversionRate: 12,
        description: 'Chương trình đào tạo chuyên sâu về chiến lược giao dịch',
      },
      {
        id: 'w5',
        stepNumber: 5,
        name: 'TIER 2',
        price: '21.000.000 VNĐ',
        ctaType: 'Mentorship trực tiếp',
        conversionRate: 8.5,
        highlight: true,
        highlightLabel: '78% chọn',
        description: 'Chương trình mentorship 1:1, được lựa chọn nhiều nhất bởi học viên',
      },
      {
        id: 'w6',
        stepNumber: 6,
        name: 'TIER 3',
        price: '29.999.000 VNĐ',
        ctaType: 'VIP Inner Circle',
        conversionRate: 2.1,
        description: 'Chương trình VIP cao cấp nhất, truy cập toàn bộ hệ sinh thái GEM',
      },
    ],
  },
  {
    id: 'wellness',
    label: 'Tâm Thức',
    subtitle: 'Wellness Track',
    color: 'text-purple',
    bgColor: 'bg-purple',
    borderColor: 'border-purple',
    badgeColor: 'bg-purple/10',
    icon: Heart,
    totalConversion: 6.8,
    steps: [
      {
        id: 'wl1',
        stepNumber: 1,
        name: 'Tâm Thức Content',
        price: 'Miễn phí',
        ctaType: 'Nội dung giá trị',
        conversionRate: 100,
        description: 'Video về thiền định, tần số, chữa lành, nghiệp lực và tâm thức',
      },
      {
        id: 'wl2',
        stepNumber: 2,
        name: 'App Free',
        price: 'Miễn phí',
        ctaType: 'Tải ứng dụng',
        conversionRate: 45,
        description: 'Tải ứng dụng GEM miễn phí, trải nghiệm thiền và bài học cơ bản',
      },
      {
        id: 'wl3',
        stepNumber: 3,
        name: '399K Tần Số Tình Yêu',
        price: '399.000 VNĐ',
        ctaType: 'Khoá học chuyên đề',
        conversionRate: 28,
        description: 'Khoá học về tần số tình yêu, kết nối năng lượng trong mối quan hệ',
      },
      {
        id: 'wl4',
        stepNumber: 4,
        name: '7 Ngày Khai Mở',
        price: '1.990.000 VNĐ',
        ctaType: 'Chương trình chuyên sâu',
        conversionRate: 15,
        description: 'Chương trình 7 ngày khai mở tâm thức, thiền định chuyên sâu',
      },
      {
        id: 'wl5',
        stepNumber: 5,
        name: 'Crystals Shopify',
        price: 'Đa dạng',
        ctaType: 'Sản phẩm vật lý',
        conversionRate: 9.5,
        description: 'Cửa hàng đá phong thuỷ, pha lê năng lượng trên Shopify',
      },
    ],
  },
  {
    id: 'integration',
    label: 'Tích Hợp',
    subtitle: 'Integration Track',
    color: 'text-emerald',
    bgColor: 'bg-emerald',
    borderColor: 'border-emerald',
    badgeColor: 'bg-emerald/10',
    icon: Layers,
    totalConversion: 9.3,
    steps: [
      {
        id: 'i1',
        stepNumber: 1,
        name: 'Bridge Content',
        price: 'Miễn phí',
        ctaType: 'Nội dung cầu nối',
        conversionRate: 100,
        description: 'Nội dung kết hợp tài chính và tâm thức, lifestyle content hấp dẫn',
      },
      {
        id: 'i2',
        stepNumber: 2,
        name: 'App',
        price: 'Miễn phí',
        ctaType: 'Tải ứng dụng',
        conversionRate: 52,
        description: 'Tải ứng dụng GEM, trải nghiệm hệ sinh thái tích hợp',
      },
      {
        id: 'i3',
        stepNumber: 3,
        name: 'Tư Duy Triệu Phú',
        price: '1.990.000 / 499.000 VNĐ',
        ctaType: 'Khoá học flagship',
        conversionRate: 32,
        description: 'Khoá học Tư Duy Triệu Phú, kết hợp mindset tài chính và tâm thức',
      },
      {
        id: 'i4',
        stepNumber: 4,
        name: 'TIER 2',
        price: '21.000.000 VNĐ',
        ctaType: 'Mentorship nâng cao',
        conversionRate: 14,
        description: 'Chương trình mentorship chuyên sâu tài chính và phát triển bản thân',
      },
      {
        id: 'i5',
        stepNumber: 5,
        name: 'Crystals + Community',
        price: 'Đa dạng',
        ctaType: 'Hệ sinh thái đầy đủ',
        conversionRate: 11,
        description: 'Truy cập cộng đồng VIP, sản phẩm pha lê năng lượng và mentorship',
      },
    ],
  },
];

// ============================================================================
// CTA Rules Data
// ============================================================================

const ctaRules = [
  {
    id: 'cta1',
    rule: 'CTA khoá học TRƯỚC closing',
    severity: 'critical',
    description: 'CTA phải được đặt trước phần kết thúc. Không bao giờ đặt CTA sau lời kết.',
    goodExample: '...và đó chính là lý do tại sao khoá học GEM Scanner giúp bạn... [CTA]. Ok, vậy để Jennie gói lại...',
    badExample: '...cảm ơn các bạn đã xem. À nhân tiện, khoá học GEM Scanner đang giảm giá...',
  },
  {
    id: 'cta2',
    rule: 'KHÔNG CTA tải tài liệu',
    severity: 'critical',
    description: 'Tuyệt đối không đưa CTA tải tài liệu PDF, ebook. Chỉ CTA khoá học hoặc ứng dụng.',
    goodExample: 'Các bạn có thể trải nghiệm trực tiếp trên ứng dụng GEM...',
    badExample: 'Tải ngay ebook miễn phí 10 bí mật giao dịch...',
  },
  {
    id: 'cta3',
    rule: 'Video CTA không nói giá',
    severity: 'high',
    description: 'Trong video không bao giờ đề cập giá cụ thể. Chỉ nói về giá trị và trải nghiệm.',
    goodExample: 'Jennie đã chuẩn bị một chương trình đặc biệt cho các bạn...',
    badExample: 'Khoá học chỉ có 299K, quá rẻ so với giá trị nhận được...',
  },
  {
    id: 'cta4',
    rule: 'Tối đa 3 sản phẩm mỗi kịch bản',
    severity: 'high',
    description: 'Mỗi kịch bản chỉ đề cập tối đa 3 sản phẩm/dịch vụ. Quá nhiều sẽ gây phân tán.',
    goodExample: 'Đề cập GEM Scanner + Khoá Starter + App trong suốt video',
    badExample: 'Liệt kê 6 sản phẩm khác nhau trong một video duy nhất',
  },
  {
    id: 'cta5',
    rule: 'CTA pattern rotation (30 mẫu)',
    severity: 'medium',
    description: 'Xoay vòng 30 mẫu CTA khác nhau, không lặp lại cùng một mẫu trong 2 video liên tiếp.',
    goodExample: 'Video 1: "Nếu bạn muốn..." — Video 2: "Jennie có một món quà..." — Video 3: "Hãy tưởng tượng..."',
    badExample: 'Dùng đi dùng lại câu "Link khoá học ở dưới mô tả" cho mọi video',
  },
  {
    id: 'cta6',
    rule: 'Giáo dục trước bán hàng',
    severity: 'high',
    description: 'Cung cấp giá trị giáo dục thực sự trước khi nhắc đến bất kỳ sản phẩm nào.',
    goodExample: 'Giải thích khái niệm tần số — chia sẻ ví dụ thực tế — sau đó mới nhắc khoá học',
    badExample: 'Mở đầu video bằng "Hôm nay Jennie giới thiệu khoá học mới..."',
  },
];

// ============================================================================
// Product Catalog Data
// ============================================================================

const INITIAL_PRODUCTS = [
  { id: 'p1', name: 'GEM Scanner Free Trial', price: 'Miễn phí', track: 'wealth', funnelPosition: 'Bước 2', type: 'Công cụ' },
  { id: 'p2', name: 'Khoá Học Starter 299K', price: '299.000 VNĐ', track: 'wealth', funnelPosition: 'Bước 3', type: 'Khoá học' },
  { id: 'p3', name: 'TIER 1 — Đào Tạo Chuyên Sâu', price: '11.000.000 VNĐ', track: 'wealth', funnelPosition: 'Bước 4', type: 'Chương trình' },
  { id: 'p4', name: 'TIER 2 — Mentorship 1:1', price: '21.000.000 VNĐ', track: 'wealth', funnelPosition: 'Bước 5', type: 'Mentorship' },
  { id: 'p5', name: 'TIER 3 — VIP Inner Circle', price: '29.999.000 VNĐ', track: 'wealth', funnelPosition: 'Bước 6', type: 'VIP' },
  { id: 'p6', name: 'Ứng Dụng GEM (Free)', price: 'Miễn phí', track: 'wellness', funnelPosition: 'Bước 2', type: 'Ứng dụng' },
  { id: 'p7', name: 'Tần Số Tình Yêu', price: '399.000 VNĐ', track: 'wellness', funnelPosition: 'Bước 3', type: 'Khoá học' },
  { id: 'p8', name: '7 Ngày Khai Mở', price: '1.990.000 VNĐ', track: 'wellness', funnelPosition: 'Bước 4', type: 'Chương trình' },
  { id: 'p9', name: 'Crystals & Pha Lê', price: 'Đa dạng', track: 'wellness', funnelPosition: 'Bước 5', type: 'Sản phẩm' },
  { id: 'p10', name: 'Tư Duy Triệu Phú', price: '1.990.000 / 499.000 VNĐ', track: 'integration', funnelPosition: 'Bước 3', type: 'Khoá học' },
  { id: 'p11', name: 'TIER 2 (Integration)', price: '21.000.000 VNĐ', track: 'integration', funnelPosition: 'Bước 4', type: 'Mentorship' },
  { id: 'p12', name: 'Crystals + Community', price: 'Đa dạng', track: 'integration', funnelPosition: 'Bước 5', type: 'Hệ sinh thái' },
];

// ============================================================================
// CTA Pattern Examples Data
// ============================================================================

const ctaPatterns = [
  { id: 1, pattern: 'Nếu bạn muốn hiểu sâu hơn về [chủ đề], Jennie đã chuẩn bị...', category: 'Mời khám phá', usage: 'LATC, TMT' },
  { id: 2, pattern: 'Jennie có một món quà đặc biệt cho các bạn đang xem video này...', category: 'Tặng quà', usage: 'TMT Drama' },
  { id: 3, pattern: 'Hãy tưởng tượng trong 7 ngày tới, bạn có thể...', category: 'Vẽ viễn cảnh', usage: 'Wellness' },
  { id: 4, pattern: 'Đây chính là lý do Jennie đã tạo ra [sản phẩm]...', category: 'Kể câu chuyện', usage: 'LATC' },
  { id: 5, pattern: 'Và nếu bạn đã sẵn sàng bước tiếp, GEM Scanner sẽ giúp bạn...', category: 'Chuyển tiếp tự nhiên', usage: 'Wealth' },
  { id: 6, pattern: 'Nhiều bạn đã hỏi Jennie làm sao để bắt đầu, và câu trả lời là...', category: 'Trả lời câu hỏi', usage: 'Tất cả' },
  { id: 7, pattern: 'Các bạn có thể trải nghiệm trực tiếp trên ứng dụng GEM...', category: 'Trải nghiệm', usage: 'Integration' },
  { id: 8, pattern: 'Jennie muốn chia sẻ thêm một công cụ mà team đang dùng mỗi ngày...', category: 'Chia sẻ nội bộ', usage: 'Wealth' },
  { id: 9, pattern: 'Trong cộng đồng GEM, các bạn sẽ được kết nối với những người cùng tần số...', category: 'Cộng đồng', usage: 'Wellness, Integration' },
  { id: 10, pattern: 'Nếu bạn cảm thấy nội dung hôm nay chạm được vào bạn, hãy thử...', category: 'Cảm xúc', usage: 'TMT, Wellness' },
  { id: 11, pattern: 'Bước tiếp theo đơn giản nhất mà bạn có thể làm ngay bây giờ là...', category: 'Hành động ngay', usage: 'Tất cả' },
  { id: 12, pattern: 'Jennie đã đúc kết tất cả những gì chia sẻ hôm nay vào một chương trình...', category: 'Đúc kết', usage: 'LATC' },
  { id: 13, pattern: 'Để không bỏ lỡ tần số này, bạn có thể khám phá thêm tại...', category: 'Tần số', usage: 'Wellness' },
  { id: 14, pattern: 'Một người bạn trong community mới chia sẻ kết quả sau khi áp dụng...', category: 'Social proof', usage: 'Tất cả' },
  { id: 15, pattern: 'Và đây là phần Jennie thích nhất — bạn không cần phải làm một mình...', category: 'Đồng hành', usage: 'Integration' },
];

// ============================================================================
// Conversion Metrics Data
// ============================================================================

const conversionMetrics = {
  wealth: { views: 125000, appDownloads: 18750, courseEnroll: 4125, tierUpgrade: 1237, topConversion: 'TIER 2 (78% chọn)' },
  wellness: { views: 98000, appDownloads: 24500, courseEnroll: 6860, tierUpgrade: 2058, topConversion: 'Tần Số Tình Yêu (28%)' },
  integration: { views: 87000, appDownloads: 26100, courseEnroll: 8352, tierUpgrade: 3340, topConversion: 'Tư Duy Triệu Phú (32%)' },
};

// ============================================================================
// FunnelStepCard Component
// ============================================================================

function FunnelStepCard({
  step,
  color,
  bgColor,
  isLast,
  totalSteps,
}) {
  const widthPercent = 100 - ((step.stepNumber - 1) / (totalSteps - 1)) * 40;

  return (
    <div className="flex flex-col items-center">
      <div
        className="relative w-full transition-all duration-300"
        style={{ maxWidth: `${widthPercent}%` }}
      >
        <div
          className={`card p-4 border-l-[3px] ${step.highlight ? 'border-l-gold shadow-lg shadow-gold/5' : `border-l-${color.replace('text-', '')}`
            } hover:shadow-glass-hover transition-all duration-300 group`}
        >
          {step.highlight && step.highlightLabel && (
            <div className="absolute -top-2.5 right-3">
              <span className="badge bg-gold/20 text-gold text-xxs px-2 py-0.5 flex items-center gap-1">
                <Star size={10} />
                {step.highlightLabel}
              </span>
            </div>
          )}

          <div className="flex items-start gap-3">
            <div
              className={`w-8 h-8 rounded-badge ${step.highlight ? 'bg-gold/15' : `${bgColor}/10`
                } flex items-center justify-center shrink-0`}
            >
              <span className={`text-xs font-bold ${step.highlight ? 'text-gold' : color}`}>
                {step.stepNumber}
              </span>
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h4 className="text-sm font-semibold text-txt">{step.name}</h4>
                <span className="text-xxs text-txt-3 bg-glass-bg px-1.5 py-0.5 rounded">{step.ctaType}</span>
              </div>
              <p className="text-xs text-txt-3 leading-relaxed mb-2">{step.description}</p>
              <div className="flex items-center justify-between">
                <span className={`text-xs font-medium ${color}`}>{step.price}</span>
                <div className="flex items-center gap-1.5">
                  <div className="w-16 h-1.5 bg-bg-4 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${step.highlight ? 'bg-gold' : bgColor
                        }`}
                      style={{ width: `${Math.min(step.conversionRate, 100)}%` }}
                    />
                  </div>
                  <span className="text-xxs text-txt-3 w-10 text-right">
                    {step.conversionRate}%
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {!isLast && (
        <div className="py-1.5">
          <ArrowDown size={16} className="text-txt-3 opacity-50" />
        </div>
      )}
    </div>
  );
}

// ============================================================================
// FunnelVisualizer Component
// ============================================================================

function FunnelVisualizer({ track }) {
  const TrackIcon = track.icon;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-3 mb-4">
        <div className={`w-10 h-10 rounded-card ${track.badgeColor} flex items-center justify-center`}>
          <TrackIcon size={20} className={track.color} />
        </div>
        <div>
          <h3 className={`font-heading text-lg font-semibold ${track.color}`}>
            Phễu {track.label}
          </h3>
          <p className="text-xxs text-txt-3">{track.subtitle}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xxs text-txt-3">Tổng chuyển đổi:</span>
          <span className={`text-sm font-bold ${track.color}`}>{track.totalConversion}%</span>
        </div>
      </div>

      <div className="space-y-0">
        {track.steps.map((step, idx) => (
          <FunnelStepCard
            key={step.id}
            step={step}
            color={track.color}
            bgColor={track.bgColor}
            isLast={idx === track.steps.length - 1}
            totalSteps={track.steps.length}
          />
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// CTARuleCard Component
// ============================================================================

function CTARuleCard({ rule }) {
  const severityConfig = {
    critical: {
      label: 'Nghiêm trọng',
      color: 'text-danger',
      bg: 'bg-danger/10',
      border: 'border-l-danger',
      icon: ShieldAlert,
    },
    high: {
      label: 'Cao',
      color: 'text-amber-700 dark:text-amber-400',
      bg: 'bg-amber-400/10',
      border: 'border-l-amber-400',
      icon: AlertTriangle,
    },
    medium: {
      label: 'Trung bình',
      color: 'text-cyan',
      bg: 'bg-cyan/10',
      border: 'border-l-cyan',
      icon: ShieldCheck,
    },
  };

  const config = severityConfig[rule.severity];
  const SeverityIcon = config.icon;

  return (
    <div className={`card p-4 border-l-[3px] ${config.border}`}>
      <div className="flex items-start gap-3">
        <div className={`w-8 h-8 rounded-badge ${config.bg} flex items-center justify-center shrink-0`}>
          <SeverityIcon size={16} className={config.color} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h4 className="text-sm font-semibold text-txt">{rule.rule}</h4>
            <span className={`badge ${config.bg} ${config.color} text-xxs px-2 py-0.5`}>
              {config.label}
            </span>
          </div>
          <p className="text-xs text-txt-3 leading-relaxed mb-3">{rule.description}</p>

          {(rule.goodExample || rule.badExample) && (
            <div className="space-y-2">
              {rule.goodExample && (
                <div className="flex items-start gap-2 p-2.5 rounded-card bg-success/5 border border-success/10">
                  <ThumbsUp size={14} className="text-success shrink-0 mt-0.5" />
                  <div>
                    <span className="text-xxs font-medium text-success block mb-0.5">Nên làm</span>
                    <span className="text-xxs text-txt-2 leading-relaxed">{rule.goodExample}</span>
                  </div>
                </div>
              )}
              {rule.badExample && (
                <div className="flex items-start gap-2 p-2.5 rounded-card bg-danger/5 border border-danger/10">
                  <ThumbsDown size={14} className="text-danger shrink-0 mt-0.5" />
                  <div>
                    <span className="text-xxs font-medium text-danger block mb-0.5">Không nên</span>
                    <span className="text-xxs text-txt-2 leading-relaxed">{rule.badExample}</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// ProductMapper Component
// ============================================================================

function ProductMapper({
  trackFilter,
  products,
  onUpdateProduct,
}) {
  const filteredProducts =
    trackFilter === 'all' ? products : products.filter((p) => p.track === trackFilter);

  const trackColorMap = {
    wealth: 'text-gold',
    wellness: 'text-purple',
    integration: 'text-emerald',
  };

  const trackLabelMap = {
    wealth: 'Tài Chính',
    wellness: 'Tâm Thức',
    integration: 'Tích Hợp',
  };

  const [editingCell, setEditingCell] = useState(null);
  const [editValue, setEditValue] = useState('');

  const startEdit = (id, field, currentValue) => {
    setEditingCell({ id, field });
    setEditValue(currentValue);
  };

  const saveEdit = () => {
    if (editingCell) {
      onUpdateProduct(editingCell.id, editingCell.field, editValue);
      setEditingCell(null);
    }
  };

  const cancelEdit = () => setEditingCell(null);

  const isEditing = (id, field) =>
    editingCell?.id === id && editingCell?.field === field;

  const EditableCell = ({ product, field, className, children }) => (
    <td className="px-4 py-2">
      {isEditing(product.id, field) ? (
        <div className="flex items-center gap-1">
          {field === 'track' ? (
            <CCSelect
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              className="text-xs py-1 px-2 w-full"
              autoFocus
            >
              <option value="wealth">Tài Chính</option>
              <option value="wellness">Tâm Thức</option>
              <option value="integration">Tích Hợp</option>
            </CCSelect>
          ) : (
            <input
              type="text"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') cancelEdit(); }}
              className="fs text-xs py-1 px-2 w-full"
              autoFocus
            />
          )}
          <button onClick={saveEdit} className="p-1 text-success hover:bg-success/10 rounded" title="Lưu">
            <Check size={12} />
          </button>
          <button onClick={cancelEdit} className="p-1 text-danger hover:bg-danger/10 rounded" title="Hủy">
            <X size={12} />
          </button>
        </div>
      ) : (
        <span
          className={`cursor-pointer hover:bg-gold/5 px-1 py-0.5 rounded transition-colors group inline-flex items-center gap-1 ${className ?? ''}`}
          onClick={() => startEdit(product.id, field, product[field])}
          title="Bấm để chỉnh sửa"
        >
          {children}
          <Pencil size={10} className="text-txt-3 opacity-0 group-hover:opacity-100 transition-opacity" />
        </span>
      )}
    </td>
  );

  return (
    <div className="card overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="border-b border-border bg-glass-bg">
            <th className="text-left text-xs font-medium text-txt-3 px-4 py-3">Sản phẩm</th>
            <th className="text-left text-xs font-medium text-txt-3 px-4 py-3">Giá</th>
            <th className="text-left text-xs font-medium text-txt-3 px-4 py-3">Track</th>
            <th className="text-left text-xs font-medium text-txt-3 px-4 py-3">Vị trí phễu</th>
            <th className="text-left text-xs font-medium text-txt-3 px-4 py-3">Loại</th>
          </tr>
        </thead>
        <tbody>
          {filteredProducts.map((product) => (
            <tr key={product.id} className="border-b border-border last:border-0 hover:bg-glass-bg/50 transition-colors">
              <EditableCell product={product} field="name" className="text-sm text-txt font-medium">
                {product.name}
              </EditableCell>
              <EditableCell product={product} field="price" className="text-xs text-txt-2">
                {product.price}
              </EditableCell>
              <EditableCell product={product} field="track">
                <span className={`text-xs font-medium ${trackColorMap[product.track]}`}>
                  {trackLabelMap[product.track]}
                </span>
              </EditableCell>
              <EditableCell product={product} field="funnelPosition">
                <span className="text-xs text-txt-3 bg-bg-4 px-2 py-0.5 rounded">
                  {product.funnelPosition}
                </span>
              </EditableCell>
              <EditableCell product={product} field="type" className="text-xs text-txt-3">
                {product.type}
              </EditableCell>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================================
// ConversionTracker Component
// ============================================================================

function ConversionTracker({
  trackId,
}) {
  const metrics = conversionMetrics[trackId];
  const track = funnelTracks.find((t) => t.id === trackId);

  const stages = [
    { label: 'Lượt xem', value: metrics.views, icon: Eye, pct: 100 },
    { label: 'Tải app', value: metrics.appDownloads, icon: Smartphone, pct: Math.round((metrics.appDownloads / metrics.views) * 100) },
    { label: 'Đăng ký khoá học', value: metrics.courseEnroll, icon: GraduationCap, pct: Math.round((metrics.courseEnroll / metrics.views) * 100) },
    { label: 'Nâng cấp Tier', value: metrics.tierUpgrade, icon: Crown, pct: Math.round((metrics.tierUpgrade / metrics.views) * 100) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-2">
        <h4 className={`text-sm font-semibold ${track.color}`}>
          Chỉ số chuyển đổi — {track.label}
        </h4>
        <span className="text-xxs text-txt-3">
          Sản phẩm tốt nhất: <span className={`font-medium ${track.color}`}>{metrics.topConversion}</span>
        </span>
      </div>

      <div className="g4">
        {stages.map((stage, idx) => {
          const StageIcon = stage.icon;
          return (
            <React.Fragment key={stage.label}>
              <div className="card p-3 text-center">
                <StageIcon size={18} className={`mx-auto mb-2 ${track.color}`} />
                <p className="text-lg font-bold font-heading text-txt">
                  {stage.value.toLocaleString('vi-VN')}
                </p>
                <p className="text-xxs text-txt-3 mt-1">{stage.label}</p>
                <p className={`text-xxs font-medium mt-0.5 ${track.color}`}>{stage.pct}%</p>
              </div>
              {idx < stages.length - 1 && (
                <div className="hidden lg:flex items-center justify-center -mx-3">
                  <ChevronRight size={16} className="text-txt-3 opacity-40" />
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>

      <div className="w-full h-2 bg-bg-4 rounded-full overflow-hidden flex">
        {stages.map((stage, idx) => {
          const segmentWidth = idx === 0 ? stage.pct : stages[idx - 1].pct - stage.pct;
          const opacityClass = idx === 0 ? 'opacity-30' : idx === 1 ? 'opacity-50' : idx === 2 ? 'opacity-75' : 'opacity-100';
          return (
            <div
              key={stage.label}
              className={`h-full ${track.bgColor} ${opacityClass} transition-all duration-500`}
              style={{ width: `${Math.max(segmentWidth, 2)}%` }}
            />
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// Section Navigation Tabs
// ============================================================================

const sectionTabs = [
  { id: 'overview', label: 'Tổng Quan', icon: GitBranch },
  { id: 'rules', label: 'Quy Tắc CTA', icon: ShieldAlert },
  { id: 'products', label: 'Sản Phẩm', icon: Package },
  { id: 'patterns', label: 'Mẫu CTA', icon: MessageSquare },
];

// ============================================================================
// Main Page Component
// ============================================================================

export default function FunnelsPage() {
  const [activeFunnel, setActiveFunnel] = useState('wealth');
  const [activeSection, setActiveSection] = useState('overview');
  const [productTrackFilter, setProductTrackFilter] = useState('all');
  const [products, setProducts] = useState(INITIAL_PRODUCTS);

  const handleUpdateProduct = (id, field, value) => {
    setProducts((prev) =>
      prev.map((p) => (p.id === id ? { ...p, [field]: value } : p))
    );
  };

  const activeTrack = funnelTracks.find((t) => t.id === activeFunnel);

  const totalProducts = products.length;
  const avgConversion = (
    funnelTracks.reduce((sum, t) => sum + t.totalConversion, 0) / funnelTracks.length
  ).toFixed(1);
  const activeFunnelsCount = funnelTracks.length;
  const totalPatterns = 30;

  return (
    <div className="space-y-6 animate-fade-in">
      {/* ================================================================ */}
      {/* Page Header                                                       */}
      {/* ================================================================ */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-2xl font-bold text-txt flex items-center gap-3">
            <GitBranch size={24} className="text-gold" />
            Phễu Chuyển Đổi & CTA
          </h1>
          <p className="text-sm text-txt-3 mt-1">
            Quản lý phễu bán hàng Wealth / Wellness / Integration và quy tắc CTA
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="badge bg-success/10 text-success text-xxs px-2 py-1 flex items-center gap-1">
            <Zap size={10} />
            Tốt nhất: Integration (9.3%)
          </span>
        </div>
      </div>

      {/* ================================================================ */}
      {/* Stats Overview Row                                                */}
      {/* ================================================================ */}
      <div className="g4">
        <div className="card p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-txt-2 uppercase tracking-wider">Sản phẩm</span>
            <Package size={16} className="text-gold" />
          </div>
          <p className="text-2xl font-heading font-bold text-txt">{totalProducts}</p>
          <p className="text-xxs text-txt-3 mt-1">Trên 3 phễu bán hàng</p>
        </div>

        <div className="card p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-txt-2 uppercase tracking-wider">Chuyển đổi TB</span>
            <TrendingUp size={16} className="text-emerald" />
          </div>
          <p className="text-2xl font-heading font-bold text-txt">{avgConversion}%</p>
          <p className="text-xxs text-txt-3 mt-1">Trung bình 3 track</p>
        </div>

        <div className="card p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-txt-2 uppercase tracking-wider">Phễu hoạt động</span>
            <Filter size={16} className="text-gold" />
          </div>
          <p className="text-2xl font-heading font-bold text-txt">{activeFunnelsCount}</p>
          <p className="text-xxs text-txt-3 mt-1">Wealth / Wellness / Integration</p>
        </div>

        <div className="card p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-txt-2 uppercase tracking-wider">Mẫu CTA</span>
            <RotateCcw size={16} className="text-cyan" />
          </div>
          <p className="text-2xl font-heading font-bold text-txt">{totalPatterns}</p>
          <p className="text-xxs text-txt-3 mt-1">Xoay vòng mỗi video</p>
        </div>
      </div>

      {/* ================================================================ */}
      {/* Funnel Track Tabs                                                 */}
      {/* ================================================================ */}
      <div className="flex gap-2 overflow-x-auto pb-2">
        {funnelTracks.map((track) => {
          const TrackIcon = track.icon;
          const isActive = activeFunnel === track.id;
          return (
            <button
              key={track.id}
              onClick={() => setActiveFunnel(track.id)}
              className={`flex items-center gap-2 px-5 py-2.5 rounded-card text-sm whitespace-nowrap transition-all
                ${isActive
                  ? `bg-bg-2 border ${track.borderColor}/30 text-txt shadow-sm`
                  : 'bg-glass-bg border border-border text-txt-3 hover:text-txt hover:border-border-2'
                }`}
            >
              <TrackIcon size={16} className={isActive ? track.color : 'text-txt-3'} />
              <span className="font-medium">{track.label}</span>
              <span className={`text-xxs ${isActive ? track.color : 'text-txt-3'}`}>
                ({track.subtitle})
              </span>
            </button>
          );
        })}
      </div>

      {/* ================================================================ */}
      {/* Section Navigation                                                */}
      {/* ================================================================ */}
      <div className="flex gap-1 bg-glass-bg p-1 rounded-card">
        {sectionTabs.map((tab) => {
          const TabIcon = tab.icon;
          const isActive = activeSection === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveSection(tab.id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-card text-xs whitespace-nowrap transition-all flex-1 justify-center
                ${isActive ? 'bg-bg text-txt shadow-sm' : 'text-txt-3 hover:text-txt'}`}
            >
              <TabIcon size={14} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* ================================================================ */}
      {/* SECTION: Tổng Quan (Phễu + Chuyển đổi)                           */}
      {/* ================================================================ */}
      {activeSection === 'overview' && (
        <div className="space-y-6">
          {/* Funnel Visualizer */}
          <section className="glass-card p-6">
            <FunnelVisualizer track={activeTrack} />
          </section>

          {/* Conversion Tracker */}
          <section className="glass-card p-6">
            <div className="flex items-center gap-2 mb-4">
              <BarChart3 size={18} className="text-gold" />
              <h3 className="font-heading text-md font-semibold text-txt">
                Theo Dõi Chuyển Đổi
              </h3>
            </div>
            <ConversionTracker trackId={activeFunnel} />
          </section>

          {/* Funnel Comparison Summary */}
          <section>
            <h3 className="font-heading text-md font-semibold text-txt mb-3 flex items-center gap-2">
              <Grid3X3 size={16} className="text-gold" />
              So Sánh 3 Phễu
            </h3>
            <div className="g2">
              {funnelTracks.map((track) => {
                const TrackIcon = track.icon;
                const m = conversionMetrics[track.id];
                return (
                  <div
                    key={track.id}
                    className={`card p-4 border-l-[3px] border-l-${track.id === 'wealth' ? 'gold' : track.id === 'wellness' ? 'purple' : 'emerald'} cursor-pointer transition-all hover:shadow-glass-hover ${activeFunnel === track.id ? 'ring-1 ring-offset-0 ring-border' : ''
                      }`}
                    onClick={() => setActiveFunnel(track.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') setActiveFunnel(track.id); }}
                  >
                    <div className="flex items-center gap-2 mb-3">
                      <TrackIcon size={16} className={track.color} />
                      <h4 className={`text-sm font-semibold ${track.color}`}>{track.label}</h4>
                      {track.id === 'integration' && (
                        <span className="badge bg-success/10 text-success text-xxs px-1.5 py-0.5">
                          Tốt nhất
                        </span>
                      )}
                    </div>
                    <div className="space-y-2">
                      <div className="flex justify-between text-xs">
                        <span className="text-txt-3">Bước</span>
                        <span className="text-txt font-medium">{track.steps.length} bước</span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-txt-3">Chuyển đổi</span>
                        <span className={`font-medium ${track.color}`}>{track.totalConversion}%</span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-txt-3">Lượt xem</span>
                        <span className="text-txt font-medium">{m.views.toLocaleString('vi-VN')}</span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-txt-3">Khoá học</span>
                        <span className="text-txt font-medium">{m.courseEnroll.toLocaleString('vi-VN')}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {/* ================================================================ */}
      {/* SECTION: Quy Tắc CTA                                             */}
      {/* ================================================================ */}
      {activeSection === 'rules' && (
        <div className="space-y-6">
          <div className="flex items-center gap-2 mb-2">
            <ShieldAlert size={18} className="text-danger" />
            <h3 className="font-heading text-md font-semibold text-txt">
              Quy Tắc CTA ({ctaRules.length} quy tắc)
            </h3>
          </div>
          <p className="text-sm text-txt-3">
            Các quy tắc bắt buộc khi tạo CTA trong mọi kịch bản nội dung. Vi phạm quy tắc nghiêm trọng sẽ bị từ chối duyệt.
          </p>

          {/* Severity Legend */}
          <div className="flex gap-4">
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-danger" />
              <span className="text-xxs text-txt-3">Nghiêm trọng</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-amber-400" />
              <span className="text-xxs text-txt-3">Cao</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-cyan" />
              <span className="text-xxs text-txt-3">Trung bình</span>
            </div>
          </div>

          {/* Rule Cards */}
          <div className="space-y-3">
            {ctaRules.map((rule) => (
              <CTARuleCard key={rule.id} rule={rule} />
            ))}
          </div>

          {/* Quick Reference */}
          <div className="card p-5 border-l-[3px] border-l-gold">
            <div className="flex items-center gap-2 mb-3">
              <Lightbulb size={16} className="text-gold" />
              <h4 className="text-sm font-semibold text-gold">Ghi Nhớ Nhanh</h4>
            </div>
            <div className="g2">
              <div className="space-y-2">
                <div className="flex items-start gap-2">
                  <CheckCircle size={14} className="text-success shrink-0 mt-0.5" />
                  <span className="text-xs text-txt-2">CTA trước closing, không bao giờ sau</span>
                </div>
                <div className="flex items-start gap-2">
                  <CheckCircle size={14} className="text-success shrink-0 mt-0.5" />
                  <span className="text-xs text-txt-2">Giáo dục trước, sản phẩm sau</span>
                </div>
                <div className="flex items-start gap-2">
                  <CheckCircle size={14} className="text-success shrink-0 mt-0.5" />
                  <span className="text-xs text-txt-2">Tối đa 3 sản phẩm mỗi video</span>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-start gap-2">
                  <XCircle size={14} className="text-danger shrink-0 mt-0.5" />
                  <span className="text-xs text-txt-2">Không nói giá trong video</span>
                </div>
                <div className="flex items-start gap-2">
                  <XCircle size={14} className="text-danger shrink-0 mt-0.5" />
                  <span className="text-xs text-txt-2">Không CTA tải tài liệu</span>
                </div>
                <div className="flex items-start gap-2">
                  <XCircle size={14} className="text-danger shrink-0 mt-0.5" />
                  <span className="text-xs text-txt-2">Không lặp lại cùng mẫu CTA</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ================================================================ */}
      {/* SECTION: Sản Phẩm                                                 */}
      {/* ================================================================ */}
      {activeSection === 'products' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Package size={18} className="text-gold" />
              <h3 className="font-heading text-md font-semibold text-txt">
                Bảng Sản Phẩm ({products.length} sản phẩm)
              </h3>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xxs text-txt-3">Lọc theo track:</span>
              <CCSelect
                value={productTrackFilter}
                onChange={(e) =>
                  setProductTrackFilter(e.target.value)
                }
                className="text-xs py-1.5 px-3"
              >
                <option value="all">Tất cả</option>
                <option value="wealth">Tài Chính</option>
                <option value="wellness">Tâm Thức</option>
                <option value="integration">Tích Hợp</option>
              </CCSelect>
            </div>
          </div>

          <ProductMapper trackFilter={productTrackFilter} products={products} onUpdateProduct={handleUpdateProduct} />

          {/* Product Distribution */}
          <div className="g2">
            {funnelTracks.map((track) => {
              const trackProducts = products.filter((p) => p.track === track.id);
              const TrackIcon = track.icon;
              return (
                <div key={track.id} className={`card p-4 border-l-[3px] border-l-${track.id === 'wealth' ? 'gold' : track.id === 'wellness' ? 'purple' : 'emerald'}`}>
                  <div className="flex items-center gap-2 mb-3">
                    <TrackIcon size={16} className={track.color} />
                    <h4 className={`text-sm font-semibold ${track.color}`}>{track.label}</h4>
                    <span className="text-xxs text-txt-3 ml-auto">{trackProducts.length} sản phẩm</span>
                  </div>
                  <div className="space-y-2">
                    {trackProducts.map((product) => (
                      <div key={product.id} className="flex items-center justify-between py-1.5 border-b border-border last:border-0">
                        <div className="flex items-center gap-2">
                          <div className={`w-1.5 h-1.5 rounded-full ${track.bgColor}`} />
                          <span className="text-xs text-txt">{product.name}</span>
                        </div>
                        <span className="text-xxs text-txt-3">{product.price}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Price Progression Visualization */}
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-4">
              <TrendingUp size={16} className="text-emerald" />
              <h4 className="text-sm font-semibold text-txt">Lộ Trình Giá</h4>
            </div>
            <p className="text-xs text-txt-3 mb-4">
              Mỗi phễu được thiết kế với lộ trình giá từ thấp đến cao, giúp khách hàng nâng cấp tự nhiên.
            </p>
            <div className="space-y-3">
              {funnelTracks.map((track) => (
                <div key={track.id} className="flex items-center gap-3">
                  <span className={`text-xs font-medium ${track.color} w-20 shrink-0`}>{track.label}</span>
                  <div className="flex-1 flex items-center gap-1">
                    {track.steps.map((step, idx) => {
                      const widthPct = Math.max(
                        8,
                        step.price === 'Miễn phí' || step.price === 'Đa dạng' || step.price.includes('Miễn phí')
                          ? 8
                          : Math.min(35, (idx + 1) * 7)
                      );
                      return (
                        <React.Fragment key={step.id}>
                          <div
                            className={`h-6 rounded ${track.bgColor} flex items-center justify-center transition-all hover:opacity-80`}
                            style={{ width: `${widthPct}%`, opacity: 0.3 + idx * 0.15 }}
                            title={`${step.name}: ${step.price}`}
                          >
                            <span className="text-xxs text-white font-medium truncate px-1">
                              {step.price === 'Miễn phí' || step.price.includes('Miễn phí')
                                ? 'Free'
                                : step.price === 'Đa dạng'
                                  ? 'Var'
                                  : step.name.includes('TIER')
                                    ? step.name
                                    : step.price.split(' ')[0]}
                            </span>
                          </div>
                          {idx < track.steps.length - 1 && (
                            <ArrowRight size={10} className="text-txt-3 opacity-40 shrink-0" />
                          )}
                        </React.Fragment>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ================================================================ */}
      {/* SECTION: Mẫu CTA                                                  */}
      {/* ================================================================ */}
      {activeSection === 'patterns' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MessageSquare size={18} className="text-cyan" />
              <h3 className="font-heading text-md font-semibold text-txt">
                Mẫu CTA Rotation ({totalPatterns} mẫu)
              </h3>
            </div>
            <span className="text-xxs text-txt-3 bg-glass-bg px-3 py-1.5 rounded-card">
              Hiển thị {ctaPatterns.length} / {totalPatterns} mẫu
            </span>
          </div>

          <p className="text-sm text-txt-3">
            Xoay vòng các mẫu CTA để không lặp lại. Mỗi video sử dụng mẫu khác nhau, đảm bảo sự tươi mới cho người xem.
          </p>

          {/* Pattern Cards */}
          <div className="space-y-2">
            {ctaPatterns.map((pattern) => (
              <div
                key={pattern.id}
                className="card p-4 hover:shadow-glass-hover transition-all duration-300 group"
              >
                <div className="flex items-start gap-3">
                  <div className="w-7 h-7 rounded-badge bg-cyan/10 flex items-center justify-center shrink-0">
                    <span className="text-xxs font-bold text-cyan">
                      {String(pattern.id).padStart(2, '0')}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-txt leading-relaxed mb-2 italic">
                      &ldquo;{pattern.pattern}&rdquo;
                    </p>
                    <div className="flex items-center gap-3">
                      <span className="badge bg-bg-4 text-txt-3 text-xxs px-2 py-0.5">
                        {pattern.category}
                      </span>
                      <span className="text-xxs text-txt-3">
                        Sử dụng cho: <span className="text-txt-2">{pattern.usage}</span>
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Pattern Categories Summary */}
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-4">
              <Sparkles size={16} className="text-gold" />
              <h4 className="text-sm font-semibold text-txt">Phân Loại Mẫu CTA</h4>
            </div>
            <div className="g2">
              {[
                { category: 'Mời khám phá', count: 4, color: 'bg-gold' },
                { category: 'Tặng quà', count: 2, color: 'bg-purple' },
                { category: 'Vẽ viễn cảnh', count: 3, color: 'bg-emerald' },
                { category: 'Kể câu chuyện', count: 3, color: 'bg-cyan' },
                { category: 'Chuyển tiếp tự nhiên', count: 4, color: 'bg-blue' },
                { category: 'Social proof', count: 3, color: 'bg-amber-400' },
                { category: 'Cảm xúc', count: 4, color: 'bg-purple' },
                { category: 'Hành động ngay', count: 4, color: 'bg-danger' },
                { category: 'Cộng đồng', count: 3, color: 'bg-emerald' },
              ].map((cat) => (
                <div key={cat.category} className="flex items-center gap-3 py-1.5">
                  <div className={`w-2 h-2 rounded-full ${cat.color}`} />
                  <span className="text-xs text-txt-2 flex-1">{cat.category}</span>
                  <span className="text-xxs text-txt-3 bg-bg-4 px-1.5 py-0.5 rounded">{cat.count} mẫu</span>
                </div>
              ))}
            </div>
          </div>

          {/* Usage Tips */}
          <div className="card p-5 border-l-[3px] border-l-cyan">
            <div className="flex items-center gap-2 mb-3">
              <Award size={16} className="text-cyan" />
              <h4 className="text-sm font-semibold text-cyan">Mẹo Sử Dụng</h4>
            </div>
            <div className="space-y-2">
              <div className="flex items-start gap-2">
                <CheckCircle size={14} className="text-success shrink-0 mt-0.5" />
                <span className="text-xs text-txt-2">
                  Chọn mẫu phù hợp với loại nội dung (LATC, TMT, Clip Ngắn)
                </span>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle size={14} className="text-success shrink-0 mt-0.5" />
                <span className="text-xs text-txt-2">
                  Không sử dụng cùng một mẫu trong 2 video liên tiếp
                </span>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle size={14} className="text-success shrink-0 mt-0.5" />
                <span className="text-xs text-txt-2">
                  Tuỳ chỉnh mẫu theo ngữ cảnh cụ thể của video, giữ nguyên cơ cấu
                </span>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle size={14} className="text-success shrink-0 mt-0.5" />
                <span className="text-xs text-txt-2">
                  Kết hợp 2-3 mẫu CTA trong cùng một kịch bản dài (LATC)
                </span>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle size={14} className="text-success shrink-0 mt-0.5" />
                <span className="text-xs text-txt-2">
                  Mẫu &ldquo;Social proof&rdquo; và &ldquo;Cảm xúc&rdquo; có tỉ lệ chuyển đổi cao nhất
                </span>
              </div>
            </div>
          </div>

          {/* Rotation Schedule */}
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-4">
              <RotateCcw size={16} className="text-gold" />
              <h4 className="text-sm font-semibold text-txt">Lịch Xoay Vòng Mẫu</h4>
            </div>
            <p className="text-xs text-txt-3 mb-3">
              Hệ thống tự động gợi ý mẫu CTA mới dựa trên lịch sử sử dụng.
              Dưới đây là ví dụ lịch xoay vòng cho 1 tuần.
            </p>
            <div className="space-y-2">
              {[
                { day: 'Thứ 2', track: 'Wealth', pattern: 'Mời khám phá', color: 'text-gold', bg: 'bg-gold/10' },
                { day: 'Thứ 3', track: 'Clip Ngắn', pattern: 'Hành động ngay', color: 'text-cyan', bg: 'bg-cyan/10' },
                { day: 'Thứ 4', track: 'Wellness', pattern: 'Cảm xúc', color: 'text-purple', bg: 'bg-purple/10' },
                { day: 'Thứ 5', track: 'TMT Drama', pattern: 'Kể câu chuyện', color: 'text-gold', bg: 'bg-gold/10' },
                { day: 'Thứ 6', track: 'Integration', pattern: 'Social proof', color: 'text-emerald', bg: 'bg-emerald/10' },
                { day: 'Thứ 7', track: 'Clip Ngắn', pattern: 'Cộng đồng', color: 'text-cyan', bg: 'bg-cyan/10' },
                { day: 'Chủ Nhật', track: 'Deep Dive', pattern: 'Vẽ viễn cảnh', color: 'text-purple', bg: 'bg-purple/10' },
              ].map((item) => (
                <div key={item.day} className="flex items-center gap-3 py-2 border-b border-border last:border-0">
                  <span className="text-xs text-txt-3 w-20 shrink-0">{item.day}</span>
                  <span className={`text-xs font-medium ${item.color} w-24 shrink-0`}>{item.track}</span>
                  <span className={`badge ${item.bg} ${item.color} text-xxs px-2 py-0.5`}>
                    {item.pattern}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
