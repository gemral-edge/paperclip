import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  Video,
  Upload,
  Music,
  Mic,
  Brain,
  Scissors,
  Subtitles,
  Library,
  Play,
  CheckCircle,
  Loader2,
  File,
  Trash2,
  Download,
  Eye,
  Search,
  Grid,
  List,
  RefreshCw,
  Monitor,
  XCircle,
  FileText,
  Wand2,
  Copy,
  Edit3,
  HardDrive,
  Cpu,
  Zap,
  Info,
  X,
  FolderOpen,
  FilePlus,
} from 'lucide-react';
import CCSelect from './CCSelect';

// ============================================================================
// Constants
// ============================================================================

const PIPELINE_STEPS = [
  {
    id: 'upload',
    label: 'Upload Video',
    description: 'Kéo thả hoặc chọn file MP4, MOV, WebM',
    icon: Upload,
    status: 'idle',
  },
  {
    id: 'audio',
    label: 'Trích Xuất Audio',
    description: 'Tách audio track từ video (FFmpeg)',
    icon: Music,
    status: 'idle',
  },
  {
    id: 'whisper',
    label: 'Whisper STT',
    description: 'Chuyển giọng nói thành văn bản (OpenAI Whisper)',
    icon: Mic,
    status: 'idle',
  },
  {
    id: 'sentiment',
    label: 'Phân Tích Cảm Xúc',
    description: 'Phân tích sentiment từng đoạn văn bản',
    icon: Brain,
    status: 'idle',
  },
  {
    id: 'smartcut',
    label: 'Smart Cut',
    description: 'Gợi ý điểm cắt thông minh dựa trên nội dung',
    icon: Scissors,
    status: 'idle',
  },
  {
    id: 'subtitle',
    label: 'Xuất Phụ Đề',
    description: 'Tạo file SRT/VTT từ transcript',
    icon: Subtitles,
    status: 'idle',
  },
  {
    id: 'library',
    label: 'Thư Viện Video',
    description: 'Lưu và quản lý video đã xử lý',
    icon: Library,
    status: 'idle',
  },
];

const MOCK_TRANSCRIPT = [
  {
    id: 'seg-1',
    start: 0.0,
    end: 4.2,
    text: 'Xin chào các bạn, hôm nay chúng ta sẽ nói về Luật Hấp Dẫn và cách áp dụng trong giao dịch.',
    sentiment: 'positive',
    confidence: 0.95,
    isHighlight: true,
  },
  {
    id: 'seg-2',
    start: 4.2,
    end: 9.8,
    text: 'Nhiều người hỏi tôi rằng làm thế nào để kiếm được nhiều tiền hơn. Câu trả lời không nằm ở công cụ.',
    sentiment: 'neutral',
    confidence: 0.92,
    isHighlight: false,
  },
  {
    id: 'seg-3',
    start: 9.8,
    end: 15.3,
    text: 'Mà nằm ở tư duy của bạn. Khi bạn thay đổi cách suy nghĩ, kết quả giao dịch sẽ thay đổi.',
    sentiment: 'positive',
    confidence: 0.88,
    isHighlight: true,
  },
  {
    id: 'seg-4',
    start: 15.3,
    end: 21.7,
    text: 'Tôi đã từng thua lỗ rất nhiều. Nhưng mỗi lần thất bại, tôi học được một bài học quan trọng.',
    sentiment: 'negative',
    confidence: 0.91,
    isHighlight: false,
  },
  {
    id: 'seg-5',
    start: 21.7,
    end: 28.4,
    text: 'Và đây là 3 bước đơn giản để bạn có thể bắt đầu áp dụng ngay hôm nay.',
    sentiment: 'positive',
    confidence: 0.94,
    isHighlight: true,
  },
  {
    id: 'seg-6',
    start: 28.4,
    end: 35.0,
    text: 'Bước một: Thiết lập mục tiêu rõ ràng. Không phải "tôi muốn giàu", mà là "tôi muốn đạt 100 triệu trong 6 tháng".',
    sentiment: 'positive',
    confidence: 0.93,
    isHighlight: false,
  },
  {
    id: 'seg-7',
    start: 35.0,
    end: 42.1,
    text: 'Bước hai: Tạo kế hoạch hành động cụ thể. Mỗi ngày bạn cần làm gì để tiến gần hơn đến mục tiêu.',
    sentiment: 'neutral',
    confidence: 0.90,
    isHighlight: false,
  },
  {
    id: 'seg-8',
    start: 42.1,
    end: 48.5,
    text: 'Bước ba: Kiểm soát cảm xúc khi giao dịch. Đây là điều quan trọng nhất mà hầu hết mọi người bỏ qua.',
    sentiment: 'positive',
    confidence: 0.96,
    isHighlight: true,
  },
  {
    id: 'seg-9',
    start: 48.5,
    end: 55.0,
    text: 'Nếu bạn thích video này, hãy nhấn nút đăng ký và bật chuông thông báo để không bỏ lỡ những chia sẻ tiếp theo.',
    sentiment: 'positive',
    confidence: 0.97,
    isHighlight: true,
  },
];

const MOCK_SMART_CUTS = [
  {
    id: 'cut-1',
    startTime: 0.0,
    endTime: 4.2,
    reason: 'Hook mở đầu — thu hút sự chú ý',
    type: 'hook',
    score: 95,
  },
  {
    id: 'cut-2',
    startTime: 9.8,
    endTime: 15.3,
    reason: 'Điểm chuyển tư duy — insight quan trọng',
    type: 'climax',
    score: 88,
  },
  {
    id: 'cut-3',
    startTime: 21.7,
    endTime: 28.4,
    reason: 'Bắt đầu hướng dẫn — giá trị cao',
    type: 'climax',
    score: 82,
  },
  {
    id: 'cut-4',
    startTime: 42.1,
    endTime: 48.5,
    reason: 'Điểm cảm xúc mạnh — emotional peak',
    type: 'emotional',
    score: 90,
  },
  {
    id: 'cut-5',
    startTime: 48.5,
    endTime: 55.0,
    reason: 'Call-to-Action cuối video',
    type: 'cta',
    score: 85,
  },
];

const MOCK_SUBTITLES = MOCK_TRANSCRIPT.map((seg, i) => ({
  id: `sub-${i + 1}`,
  index: i + 1,
  start: seg.start,
  end: seg.end,
  text: seg.text,
}));

const MOCK_LIBRARY = [
  {
    id: 'vid-1',
    title: 'LATC #47 — 3 Bước Áp Dụng Luật Hấp Dẫn Trong Trading',
    duration: '12:34',
    durationSec: 754,
    thumbnail: '',
    size: '245 MB',
    date: '2026-03-01',
    status: 'processed',
    hasSubtitles: true,
    segmentCount: 42,
    pillar: 'wealth',
  },
  {
    id: 'vid-2',
    title: 'TMT #23 — Thiền Định Và Cách Nâng Cao Tần Số Bản Thân',
    duration: '15:07',
    durationSec: 907,
    thumbnail: '',
    size: '312 MB',
    date: '2026-02-28',
    status: 'processed',
    hasSubtitles: true,
    segmentCount: 56,
    pillar: 'wellness',
  },
  {
    id: 'vid-3',
    title: 'GEM Integration — Cân Bằng Cuộc Sống Và Tài Chính',
    duration: '09:45',
    durationSec: 585,
    thumbnail: '',
    size: '178 MB',
    date: '2026-02-26',
    status: 'processed',
    hasSubtitles: true,
    segmentCount: 35,
    pillar: 'integration',
  },
  {
    id: 'vid-4',
    title: 'LATC #48 — Tư Duy Triệu Phú Và Tâm Lý Giao Dịch',
    duration: '18:22',
    durationSec: 1102,
    thumbnail: '',
    size: '402 MB',
    date: '2026-02-24',
    status: 'processing',
    hasSubtitles: false,
    segmentCount: 0,
    pillar: 'wealth',
  },
  {
    id: 'vid-5',
    title: 'TMT #24 — Chữa Lành Tổn Thương Nội Tâm',
    duration: '20:11',
    durationSec: 1211,
    thumbnail: '',
    size: '456 MB',
    date: '2026-02-22',
    status: 'processed',
    hasSubtitles: true,
    segmentCount: 68,
    pillar: 'wellness',
  },
];

// ============================================================================
// Helper Functions
// ============================================================================

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}

function getSentimentColor(sentiment) {
  switch (sentiment) {
    case 'positive':
      return 'text-emerald';
    case 'negative':
      return 'text-rose-700 dark:text-rose-400';
    default:
      return 'text-txt-3';
  }
}

function getSentimentBg(sentiment) {
  switch (sentiment) {
    case 'positive':
      return 'bg-emerald/10 border-emerald/20';
    case 'negative':
      return 'bg-rose-400/10 border-rose-400/20';
    default:
      return 'bg-bg-4 border-border';
  }
}

function getCutTypeColor(type) {
  switch (type) {
    case 'hook':
      return 'text-gold bg-gold/10';
    case 'climax':
      return 'text-purple bg-purple/10';
    case 'cta':
      return 'text-emerald bg-emerald/10';
    case 'emotional':
      return 'text-rose-700 dark:text-rose-400 bg-rose-400/10';
    default:
      return 'text-txt-3 bg-bg-4';
  }
}

function getCutTypeLabel(type) {
  switch (type) {
    case 'hook':
      return 'Hook';
    case 'climax':
      return 'Climax';
    case 'cta':
      return 'CTA';
    case 'emotional':
      return 'Cảm Xúc';
    default:
      return type;
  }
}

function getPillarBadge(pillar) {
  switch (pillar) {
    case 'wealth':
      return 'bg-gold/10 text-gold';
    case 'wellness':
      return 'bg-purple/10 text-purple';
    case 'integration':
      return 'bg-emerald/10 text-emerald';
    default:
      return 'bg-bg-4 text-txt-3';
  }
}

function getPillarLabel(pillar) {
  switch (pillar) {
    case 'wealth':
      return 'Wealth';
    case 'wellness':
      return 'Wellness';
    case 'integration':
      return 'Integration';
    default:
      return pillar;
  }
}

// ============================================================================
// Sub-Components
// ============================================================================

function DesktopOnlyGate({ children }) {
  const [isTauri, setIsTauri] = useState(null);

  useEffect(() => {
    // Check for Tauri runtime
    const hasTauri = typeof window !== 'undefined' && '__TAURI__' in window;
    setIsTauri(hasTauri);
  }, []);

  // Loading state
  if (isTauri === null) {
    return (
      <div className="flex items-center justify-center py-20">
      {false && <EmptyState />}
        <Loader2 size={32} className="animate-spin text-txt-3" />
      </div>
    );
  }

  // Web fallback
  if (!isTauri) {
    return (
      <div className="space-y-6 animate-fade-in">
        <div className="glass-card p-12 text-center max-w-lg mx-auto">
          <div className="w-20 h-20 rounded-full bg-purple/10 flex items-center justify-center mx-auto mb-6">
            <Monitor size={40} className="text-gold" />
          </div>
          <h2 className="font-heading text-2xl font-bold text-txt mb-3">
            Chức Năng Desktop
          </h2>
          <p className="text-sm text-txt-2 mb-6 leading-relaxed">
            Chức năng xử lý video chỉ khả dụng trên ứng dụng Desktop.
            Phiên bản web không hỗ trợ xử lý video cục bộ vì giới hạn trình duyệt.
          </p>
          <div className="p-4 rounded-card bg-glass-bg border border-border mb-6">
            <div className="flex items-start gap-3">
              <Info size={18} className="text-gold shrink-0 mt-0.5" />
              <div className="text-left">
                <p className="text-sm text-txt font-medium mb-1">Tại sao cần Desktop?</p>
                <ul className="space-y-1 text-xs text-txt-3">
                  <li className="flex items-center gap-2">
                    <Cpu size={12} /> Xử lý FFmpeg cục bộ — không cần upload lên server
                  </li>
                  <li className="flex items-center gap-2">
                    <HardDrive size={12} /> Truy cập trực tiếp hệ thống file
                  </li>
                  <li className="flex items-center gap-2">
                    <Zap size={12} /> GPU acceleration cho video processing
                  </li>
                </ul>
              </div>
            </div>
          </div>
          <button className="btn btn-p flex items-center gap-2 mx-auto">
            <Download size={16} />
            Tải Ứng Dụng Desktop
          </button>
          <p className="text-xxs text-txt-3 mt-3">
            Hỗ trợ Windows 10+, macOS 12+, Linux (Ubuntu 22.04+)
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

// --------------------------------------------------------------------------

function UploadZone({
  onFileSelect,
  isDragging,
  setIsDragging,
}) {
  const inputRef = useRef(null);

  const handleDragOver = useCallback(
    (e) => {
      e.preventDefault();
      setIsDragging(true);
    },
    [setIsDragging],
  );

  const handleDragLeave = useCallback(
    (e) => {
      e.preventDefault();
      setIsDragging(false);
    },
    [setIsDragging],
  );

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('video/')) {
        onFileSelect(file);
      }
    },
    [onFileSelect, setIsDragging],
  );

  const handleClick = () => {
    inputRef.current?.click();
  };

  const handleChange = (e) => {
    const file = e.target.files?.[0];
    if (file) onFileSelect(file);
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={handleClick}
      className={`
        relative cursor-pointer rounded-card border-2 border-dashed p-12 text-center
        transition-all duration-300
        ${
          isDragging
            ? 'border-gold bg-gold/5 scale-[1.01]'
            : 'border-border-2 hover:border-gold/40 hover:bg-glass-bg'
        }
      `}
    >
      <input
        ref={inputRef}
        type="file"
        accept="video/mp4,video/mov,video/webm,video/quicktime"
        onChange={handleChange}
        className="hidden"
      />
      <div className="w-16 h-16 rounded-full bg-bg-4 flex items-center justify-center mx-auto mb-4">
        <Upload size={28} className={isDragging ? 'text-gold' : 'text-txt-3'} />
      </div>
      <p className="text-sm text-txt font-medium mb-1">
        {isDragging ? 'Thả file ở đây...' : 'Kéo thả video vào đây'}
      </p>
      <p className="text-xs text-txt-3 mb-4">
        hoặc nhấn để chọn file từ máy tính
      </p>
      <div className="flex items-center justify-center gap-4 text-xxs text-txt-3">
        <span className="flex items-center gap-1">
          <File size={12} /> MP4, MOV, WebM
        </span>
        <span className="flex items-center gap-1">
          <HardDrive size={12} /> Tối đa 2 GB
        </span>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------

function PipelineProgress({ steps }) {
  return (
    <div className="card p-4">
      <h3 className="font-heading text-sm font-semibold text-txt mb-4 flex items-center gap-2">
        <Zap size={16} className="text-gold" />
        Pipeline Xử Lý
      </h3>
      <div className="space-y-2">
        {steps.map((step, index) => {
          const Icon = step.icon;
          const isLast = index === steps.length - 1;
          return (
            <div key={step.id}>
              <div className="flex items-center gap-3">
                <div
                  className={`
                    w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-all
                    ${step.status === 'complete' ? 'bg-emerald/20' : ''}
                    ${step.status === 'active' ? 'bg-gold/20 animate-pulse' : ''}
                    ${step.status === 'error' ? 'bg-rose-400/20' : ''}
                    ${step.status === 'idle' ? 'bg-bg-4' : ''}
                  `}
                >
                  {step.status === 'complete' ? (
                    <CheckCircle size={16} className="text-emerald" />
                  ) : step.status === 'active' ? (
                    <Loader2 size={16} className="text-gold animate-spin" />
                  ) : step.status === 'error' ? (
                    <XCircle size={16} className="text-rose-600 dark:text-rose-400" />
                  ) : (
                    <Icon size={16} className="text-txt-3" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span
                      className={`text-xs font-medium ${
                        step.status === 'active'
                          ? 'text-gold'
                          : step.status === 'complete'
                            ? 'text-emerald'
                            : 'text-txt-2'
                      }`}
                    >
                      {step.label}
                    </span>
                    {step.status === 'active' && step.progress !== undefined && (
                      <span className="text-xxs text-gold">{step.progress}%</span>
                    )}
                  </div>
                  {step.status === 'active' && step.progress !== undefined && (
                    <div className="w-full bg-bg-4 rounded-full h-1 mt-1">
                      <div
                        className="bg-gold h-1 rounded-full transition-all duration-300"
                        style={{ width: `${step.progress}%` }}
                      />
                    </div>
                  )}
                </div>
              </div>
              {!isLast && (
                <div className="ml-4 border-l border-border-2 h-2" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------

function TranscriptViewer({
  segments,
  activeSegment,
  onSegmentClick,
}) {
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-heading text-sm font-semibold text-txt flex items-center gap-2">
          <FileText size={16} className="text-gold" />
          Transcript
        </h3>
        <div className="flex items-center gap-2">
          <button className="btn btn-gh text-xxs flex items-center gap-1">
            <Copy size={12} /> Sao Chép
          </button>
          <button className="btn btn-gh text-xxs flex items-center gap-1">
            <Download size={12} /> Xuất TXT
          </button>
        </div>
      </div>
      <div className="space-y-2 max-h-[400px] overflow-y-auto pr-2">
        {segments.map((seg) => (
          <div
            key={seg.id}
            onClick={() => onSegmentClick(seg.id)}
            className={`
              p-3 rounded-card border cursor-pointer transition-all
              ${activeSegment === seg.id ? 'border-gold/40 bg-gold/5' : getSentimentBg(seg.sentiment)}
              hover:border-gold/30
            `}
          >
            <div className="flex items-center justify-between mb-1">
              <span className="text-xxs text-txt-3 font-mono">
                {formatTime(seg.start)} — {formatTime(seg.end)}
              </span>
              <div className="flex items-center gap-2">
                {seg.isHighlight && (
                  <span className="text-xxs bg-gold/10 text-gold px-1.5 py-0.5 rounded-badge">
                    Highlight
                  </span>
                )}
                <span className={`text-xxs ${getSentimentColor(seg.sentiment)}`}>
                  {seg.confidence > 0.9 ? 'Cao' : seg.confidence > 0.8 ? 'TB' : 'Thấp'}
                </span>
              </div>
            </div>
            <p className="text-xs text-txt-2 leading-relaxed">{seg.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------

function SmartCutPanel({ suggestions }) {
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-heading text-sm font-semibold text-txt flex items-center gap-2">
          <Scissors size={16} className="text-gold" />
          Gợi Ý Smart Cut
        </h3>
        <span className="text-xxs text-txt-3">{suggestions.length} gợi ý</span>
      </div>
      <div className="space-y-2">
        {suggestions.map((cut) => (
          <div
            key={cut.id}
            className="p-3 rounded-card bg-glass-bg border border-border hover:border-border-2 transition-all"
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className={`text-xxs px-2 py-0.5 rounded-badge ${getCutTypeColor(cut.type)}`}>
                  {getCutTypeLabel(cut.type)}
                </span>
                <span className="text-xxs text-txt-3 font-mono">
                  {formatTime(cut.startTime)} — {formatTime(cut.endTime)}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-8 h-1.5 rounded-full bg-bg-4">
                  <div
                    className="h-1.5 rounded-full bg-gold"
                    style={{ width: `${cut.score}%` }}
                  />
                </div>
                <span className="text-xxs text-gold">{cut.score}</span>
              </div>
            </div>
            <p className="text-xs text-txt-2">{cut.reason}</p>
          </div>
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <button className="btn btn-p text-xs flex-1 flex items-center justify-center gap-1.5">
          <Wand2 size={14} /> Tạo Clip Tự Động
        </button>
        <button className="btn btn-o text-xs flex items-center gap-1.5">
          <Download size={14} /> EDL
        </button>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------

function SubtitleEditor({ subtitles }) {
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');

  const handleEdit = (sub) => {
    setEditingId(sub.id);
    setEditText(sub.text);
  };

  const handleSave = () => {
    setEditingId(null);
    setEditText('');
  };

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-heading text-sm font-semibold text-txt flex items-center gap-2">
          <Subtitles size={16} className="text-emerald" />
          Chỉnh Sửa Phụ Đề
        </h3>
        <div className="flex items-center gap-2">
          <button className="btn btn-gh text-xxs flex items-center gap-1">
            <Download size={12} /> SRT
          </button>
          <button className="btn btn-gh text-xxs flex items-center gap-1">
            <Download size={12} /> VTT
          </button>
        </div>
      </div>
      <div className="space-y-1.5 max-h-[350px] overflow-y-auto pr-2">
        {subtitles.map((sub) => (
          <div
            key={sub.id}
            className="flex items-start gap-2 p-2 rounded-card bg-glass-bg hover:bg-bg-4 transition-all group"
          >
            <span className="text-xxs text-txt-3 font-mono w-6 shrink-0 pt-0.5 text-right">
              {sub.index}
            </span>
            <span className="text-xxs text-txt-3 font-mono w-24 shrink-0 pt-0.5">
              {formatTime(sub.start)}
              <br />
              {formatTime(sub.end)}
            </span>
            <div className="flex-1 min-w-0">
              {editingId === sub.id ? (
                <div className="flex gap-1">
                  <textarea
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    className="ft text-xs flex-1 min-h-[40px]"
                    autoFocus
                  />
                  <button
                    onClick={handleSave}
                    className="btn btn-p text-xxs px-2"
                  >
                    <CheckCircle size={12} />
                  </button>
                </div>
              ) : (
                <p className="text-xs text-txt-2 leading-relaxed">{sub.text}</p>
              )}
            </div>
            {editingId !== sub.id && (
              <button
                onClick={() => handleEdit(sub)}
                className="opacity-0 group-hover:opacity-100 transition-all text-txt-3 hover:text-gold"
              >
                <Edit3 size={12} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------

function VideoLibraryGrid({
  videos,
  viewMode,
}) {
  if (viewMode === 'grid') {
    return (
      <div className="g2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
        {videos.map((video) => (
          <div
            key={video.id}
            className="card overflow-hidden hover:shadow-glass-hover transition-all group"
          >
            {/* Thumbnail placeholder */}
            <div className="relative aspect-video bg-bg-4 flex items-center justify-center">
              <Video size={32} className="text-txt-3" />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all flex items-center justify-center">
                <Play
                  size={36}
                  className="text-white opacity-0 group-hover:opacity-100 transition-all"
                />
              </div>
              <span className="absolute bottom-2 right-2 text-xxs bg-black/70 text-white px-1.5 py-0.5 rounded">
                {video.duration}
              </span>
              {video.status === 'processing' && (
                <span className="absolute top-2 left-2 text-xxs bg-gold/90 text-bg px-1.5 py-0.5 rounded-badge flex items-center gap-1">
                  <Loader2 size={10} className="animate-spin" /> Đang xử lý
                </span>
              )}
            </div>
            <div className="p-3">
              <h4 className="text-xs text-txt font-medium mb-2 line-clamp-2 leading-relaxed">
                {video.title}
              </h4>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`text-xxs px-1.5 py-0.5 rounded-badge ${getPillarBadge(video.pillar)}`}>
                    {getPillarLabel(video.pillar)}
                  </span>
                  {video.hasSubtitles && (
                    <span className="text-xxs text-txt-3 flex items-center gap-0.5">
                      <Subtitles size={10} /> Phụ đề
                    </span>
                  )}
                </div>
                <span className="text-xxs text-txt-3">{video.size}</span>
              </div>
              <div className="flex items-center justify-between mt-2 pt-2 border-t border-border">
                <span className="text-xxs text-txt-3">{video.date}</span>
                <div className="flex items-center gap-1">
                  <button className="p-1 rounded text-txt-3 hover:text-gold transition-all">
                    <Eye size={12} />
                  </button>
                  <button className="p-1 rounded text-txt-3 hover:text-gold transition-all">
                    <Download size={12} />
                  </button>
                  <button className="p-1 rounded text-txt-3 hover:text-rose-600 dark:hover:text-rose-400 transition-all">
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  // List mode
  return (
    <div className="card overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left text-xxs text-txt-3 font-medium p-3">Video</th>
            <th className="text-left text-xxs text-txt-3 font-medium p-3">Trụ Cột</th>
            <th className="text-left text-xxs text-txt-3 font-medium p-3">Thời Lượng</th>
            <th className="text-left text-xxs text-txt-3 font-medium p-3">Kích Thước</th>
            <th className="text-left text-xxs text-txt-3 font-medium p-3">Trạng Thái</th>
            <th className="text-left text-xxs text-txt-3 font-medium p-3">Ngày</th>
            <th className="text-right text-xxs text-txt-3 font-medium p-3">Thao Tác</th>
          </tr>
        </thead>
        <tbody>
          {videos.map((video) => (
            <tr
              key={video.id}
              className="border-b border-border last:border-0 hover:bg-glass-bg transition-all"
            >
              <td className="p-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded bg-bg-4 flex items-center justify-center shrink-0">
                    <Video size={16} className="text-txt-3" />
                  </div>
                  <span className="text-xs text-txt font-medium line-clamp-1">
                    {video.title}
                  </span>
                </div>
              </td>
              <td className="p-3">
                <span className={`text-xxs px-1.5 py-0.5 rounded-badge ${getPillarBadge(video.pillar)}`}>
                  {getPillarLabel(video.pillar)}
                </span>
              </td>
              <td className="p-3 text-xs text-txt-2">{video.duration}</td>
              <td className="p-3 text-xs text-txt-3">{video.size}</td>
              <td className="p-3">
                {video.status === 'processed' ? (
                  <span className="text-xxs text-emerald flex items-center gap-1">
                    <CheckCircle size={12} /> Hoàn thành
                  </span>
                ) : video.status === 'processing' ? (
                  <span className="text-xxs text-gold flex items-center gap-1">
                    <Loader2 size={12} className="animate-spin" /> Đang xử lý
                  </span>
                ) : (
                  <span className="text-xxs text-rose-700 dark:text-rose-400 flex items-center gap-1">
                    <XCircle size={12} /> Lỗi
                  </span>
                )}
              </td>
              <td className="p-3 text-xs text-txt-3">{video.date}</td>
              <td className="p-3">
                <div className="flex items-center justify-end gap-1">
                  <button className="p-1.5 rounded text-txt-3 hover:text-gold transition-all">
                    <Eye size={14} />
                  </button>
                  <button className="p-1.5 rounded text-txt-3 hover:text-gold transition-all">
                    <Download size={14} />
                  </button>
                  <button className="p-1.5 rounded text-txt-3 hover:text-rose-600 dark:hover:text-rose-400 transition-all">
                    <Trash2 size={14} />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================================
// Main Page Component
// ============================================================================

/**
 * @archetype list
 * @size small
 * @navigable
 */
export default function VideoReelsPage() {
  const EmptyState = () => null;


  // --- State ---
  const [activeSection, setActiveSection] = useState('pipeline');
  const [selectedFile, setSelectedFile] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [pipelineSteps, setPipelineSteps] = useState(PIPELINE_STEPS);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingComplete, setProcessingComplete] = useState(false);
  const [activeSegment, setActiveSegment] = useState(null);

  // Library state
  const [viewMode, setViewMode] = useState('grid');
  const [librarySearch, setLibrarySearch] = useState('');
  const [pillarFilter, setPillarFilter] = useState('all');

  // --- Handlers ---

  const handleFileSelect = useCallback((file) => {
    setSelectedFile(file);
    setPipelineSteps((prev) =>
      prev.map((s) => (s.id === 'upload' ? { ...s, status: 'complete' } : s)),
    );
  }, []);

  const simulateProcessing = useCallback(async () => {
    if (!selectedFile) return;
    setIsProcessing(true);
    setProcessingComplete(false);

    const stepOrder = [
      'audio',
      'whisper',
      'sentiment',
      'smartcut',
      'subtitle',
      'library',
    ];

    for (const stepId of stepOrder) {
      // Set current step to active
      setPipelineSteps((prev) =>
        prev.map((s) =>
          s.id === stepId ? { ...s, status: 'active', progress: 0 } : s,
        ),
      );

      // Simulate progress
      for (let p = 0; p <= 100; p += 20) {
        await new Promise((r) => setTimeout(r, 200));
        setPipelineSteps((prev) =>
          prev.map((s) => (s.id === stepId ? { ...s, progress: p } : s)),
        );
      }

      // Mark complete
      setPipelineSteps((prev) =>
        prev.map((s) =>
          s.id === stepId
            ? { ...s, status: 'complete', progress: undefined }
            : s,
        ),
      );
    }

    setIsProcessing(false);
    setProcessingComplete(true);
  }, [selectedFile]);

  const handleReset = useCallback(() => {
    setSelectedFile(null);
    setIsProcessing(false);
    setProcessingComplete(false);
    setActiveSegment(null);
    setPipelineSteps(PIPELINE_STEPS);
  }, []);

  // --- Library filtering ---
  const filteredLibrary = MOCK_LIBRARY.filter((v) => {
    const matchSearch =
      !librarySearch || v.title.toLowerCase().includes(librarySearch.toLowerCase());
    const matchPillar = pillarFilter === 'all' || v.pillar === pillarFilter;
    return matchSearch && matchPillar;
  });

  // --- Render ---
  return (
    <DesktopOnlyGate>
      <div className="space-y-6 animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-heading text-2xl font-bold text-txt flex items-center gap-3">
              <Video size={24} className="text-emerald" />
              Xử Lý Video
            </h1>
            <p className="text-sm text-txt-3 mt-1">
              Upload, trích xuất audio, Whisper STT, smart cut và xuất phụ đề
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setActiveSection('pipeline')}
              className={`btn ${activeSection === 'pipeline' ? 'btn-p' : 'btn-gh'} text-xs flex items-center gap-1.5`}
            >
              <Zap size={14} />
              Pipeline
            </button>
            <button
              onClick={() => setActiveSection('library')}
              className={`btn ${activeSection === 'library' ? 'btn-p' : 'btn-gh'} text-xs flex items-center gap-1.5`}
            >
              <Library size={14} />
              Thư Viện ({MOCK_LIBRARY.length})
            </button>
          </div>
        </div>

        {/* ================================================================ */}
        {/* PIPELINE SECTION                                                 */}
        {/* ================================================================ */}
        {activeSection === 'pipeline' && (
          <>
            {/* Upload + Pipeline Status Row */}
            <div className="g2" style={{ gridTemplateColumns: '1fr 300px' }}>
              {/* Upload / File Info */}
              <div>
                {!selectedFile ? (
                  <UploadZone
                    onFileSelect={handleFileSelect}
                    isDragging={isDragging}
                    setIsDragging={setIsDragging}
                  />
                ) : (
                  <div className="card p-6">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="font-heading text-sm font-semibold text-txt flex items-center gap-2">
                        <File size={16} className="text-gold" />
                        File Đã Chọn
                      </h3>
                      <button
                        onClick={handleReset}
                        className="text-txt-3 hover:text-rose-600 dark:hover:text-rose-400 transition-all"
                        title="Xóa và chọn file mới"
                      >
                        <X size={16} />
                      </button>
                    </div>
                    <div className="p-4 rounded-card bg-glass-bg border border-border">
                      <div className="flex items-center gap-4">
                        <div className="w-16 h-16 rounded-card bg-bg-4 flex items-center justify-center">
                          <Video size={24} className="text-emerald" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-txt font-medium truncate">
                            {selectedFile.name}
                          </p>
                          <div className="flex items-center gap-3 mt-1 text-xxs text-txt-3">
                            <span>{(selectedFile.size / (1024 * 1024)).toFixed(1)} MB</span>
                            <span>{selectedFile.type}</span>
                          </div>
                        </div>
                        <CheckCircle size={20} className="text-emerald shrink-0" />
                      </div>
                    </div>

                    {/* Action buttons */}
                    <div className="flex gap-2 mt-4">
                      {!isProcessing && !processingComplete && (
                        <button
                          onClick={simulateProcessing}
                          className="btn btn-p flex-1 flex items-center justify-center gap-2"
                        >
                          <Zap size={16} />
                          Bắt Đầu Xử Lý
                        </button>
                      )}
                      {isProcessing && (
                        <button disabled className="btn btn-p flex-1 flex items-center justify-center gap-2 opacity-60">
                          <Loader2 size={16} className="animate-spin" />
                          Đang Xử Lý...
                        </button>
                      )}
                      {processingComplete && (
                        <div className="flex gap-2 flex-1">
                          <button className="btn btn-g flex-1 flex items-center justify-center gap-2">
                            <CheckCircle size={16} />
                            Hoàn Thành
                          </button>
                          <button
                            onClick={handleReset}
                            className="btn btn-o flex items-center gap-2"
                          >
                            <RefreshCw size={16} />
                            Xử Lý Mới
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Pipeline Steps */}
              <PipelineProgress steps={pipelineSteps} />
            </div>

            {/* Processing Results — show after processing complete */}
            {processingComplete && (
              <div className="space-y-6">
                {/* Stats summary */}
                <div className="g4">
                  <div className="card p-4 text-center">
                    <Mic size={20} className="text-gold mx-auto mb-2" />
                    <p className="text-xl font-heading font-bold text-txt">
                      {MOCK_TRANSCRIPT.length}
                    </p>
                    <p className="text-xxs text-txt-3">Đoạn Transcript</p>
                  </div>
                  <div className="card p-4 text-center">
                    <Brain size={20} className="text-purple mx-auto mb-2" />
                    <p className="text-xl font-heading font-bold text-txt">
                      {MOCK_TRANSCRIPT.filter((s) => s.sentiment === 'positive').length}
                    </p>
                    <p className="text-xxs text-txt-3">Đoạn Tích Cực</p>
                  </div>
                  <div className="card p-4 text-center">
                    <Scissors size={20} className="text-emerald mx-auto mb-2" />
                    <p className="text-xl font-heading font-bold text-txt">
                      {MOCK_SMART_CUTS.length}
                    </p>
                    <p className="text-xxs text-txt-3">Gợi Ý Smart Cut</p>
                  </div>
                  <div className="card p-4 text-center">
                    <Subtitles size={20} className="text-blue mx-auto mb-2" />
                    <p className="text-xl font-heading font-bold text-txt">
                      {MOCK_SUBTITLES.length}
                    </p>
                    <p className="text-xxs text-txt-3">Dòng Phụ Đề</p>
                  </div>
                </div>

                {/* Transcript + Smart Cut row */}
                <div className="g2">
                  <TranscriptViewer
                    segments={MOCK_TRANSCRIPT}
                    activeSegment={activeSegment}
                    onSegmentClick={setActiveSegment}
                  />
                  <SmartCutPanel suggestions={MOCK_SMART_CUTS} />
                </div>

                {/* Subtitle Editor */}
                <SubtitleEditor subtitles={MOCK_SUBTITLES} />

                {/* Export actions */}
                <div className="card p-6">
                  <h3 className="font-heading text-sm font-semibold text-txt mb-4 flex items-center gap-2">
                    <Download size={16} className="text-gold" />
                    Xuất Kết Quả
                  </h3>
                  <div className="g4">
                    <button className="btn btn-o flex items-center justify-center gap-2 py-3">
                      <FileText size={16} />
                      <div className="text-left">
                        <p className="text-xs font-medium">Transcript TXT</p>
                        <p className="text-xxs text-txt-3">Văn bản thường</p>
                      </div>
                    </button>
                    <button className="btn btn-o flex items-center justify-center gap-2 py-3">
                      <Subtitles size={16} />
                      <div className="text-left">
                        <p className="text-xs font-medium">Phụ Đề SRT</p>
                        <p className="text-xxs text-txt-3">SubRip format</p>
                      </div>
                    </button>
                    <button className="btn btn-o flex items-center justify-center gap-2 py-3">
                      <Subtitles size={16} />
                      <div className="text-left">
                        <p className="text-xs font-medium">Phụ Đề VTT</p>
                        <p className="text-xxs text-txt-3">WebVTT format</p>
                      </div>
                    </button>
                    <button className="btn btn-g flex items-center justify-center gap-2 py-3">
                      <Scissors size={16} />
                      <div className="text-left">
                        <p className="text-xs font-medium">Smart Clips</p>
                        <p className="text-xxs text-txt-3">EDL + Markers</p>
                      </div>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {/* ================================================================ */}
        {/* LIBRARY SECTION                                                  */}
        {/* ================================================================ */}
        {activeSection === 'library' && (
          <>
            {/* Library toolbar */}
            <div className="flex items-center justify-between gap-4">
              <div className="relative flex-1 max-w-sm">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-txt-3" />
                <input
                  type="text"
                  value={librarySearch}
                  onChange={(e) => setLibrarySearch(e.target.value)}
                  placeholder="Tìm kiếm video..."
                  className="fi pl-10 w-full"
                />
              </div>
              <div className="flex items-center gap-2">
                <CCSelect
                  value={pillarFilter}
                  onChange={(e) => setPillarFilter(e.target.value)}
                  className="text-xs"
                >
                  <option value="all">Tất cả trụ cột</option>
                  <option value="wealth">Wealth</option>
                  <option value="wellness">Wellness</option>
                  <option value="integration">Integration</option>
                </CCSelect>
                <div className="flex items-center border border-border rounded-card overflow-hidden">
                  <button
                    onClick={() => setViewMode('grid')}
                    className={`p-2 transition-all ${
                      viewMode === 'grid' ? 'bg-glass-bg text-gold' : 'text-txt-3 hover:text-txt'
                    }`}
                  >
                    <Grid size={16} />
                  </button>
                  <button
                    onClick={() => setViewMode('list')}
                    className={`p-2 transition-all ${
                      viewMode === 'list' ? 'bg-glass-bg text-gold' : 'text-txt-3 hover:text-txt'
                    }`}
                  >
                    <List size={16} />
                  </button>
                </div>
                <button
                  onClick={() => setActiveSection('pipeline')}
                  className="btn btn-p text-xs flex items-center gap-1.5"
                >
                  <FilePlus size={14} />
                  Upload Mới
                </button>
              </div>
            </div>

            {/* Library summary */}
            <div className="g4">
              <div className="card p-3 flex items-center gap-3">
                <div className="w-10 h-10 rounded-card bg-emerald/10 flex items-center justify-center">
                  <Video size={18} className="text-emerald" />
                </div>
                <div>
                  <p className="text-lg font-heading font-bold text-txt">{MOCK_LIBRARY.length}</p>
                  <p className="text-xxs text-txt-3">Tổng Video</p>
                </div>
              </div>
              <div className="card p-3 flex items-center gap-3">
                <div className="w-10 h-10 rounded-card bg-gold/10 flex items-center justify-center">
                  <CheckCircle size={18} className="text-gold" />
                </div>
                <div>
                  <p className="text-lg font-heading font-bold text-txt">
                    {MOCK_LIBRARY.filter((v) => v.status === 'processed').length}
                  </p>
                  <p className="text-xxs text-txt-3">Đã Xử Lý</p>
                </div>
              </div>
              <div className="card p-3 flex items-center gap-3">
                <div className="w-10 h-10 rounded-card bg-purple/10 flex items-center justify-center">
                  <Subtitles size={18} className="text-purple" />
                </div>
                <div>
                  <p className="text-lg font-heading font-bold text-txt">
                    {MOCK_LIBRARY.filter((v) => v.hasSubtitles).length}
                  </p>
                  <p className="text-xxs text-txt-3">Có Phụ Đề</p>
                </div>
              </div>
              <div className="card p-3 flex items-center gap-3">
                <div className="w-10 h-10 rounded-card bg-blue/10 flex items-center justify-center">
                  <HardDrive size={18} className="text-blue" />
                </div>
                <div>
                  <p className="text-lg font-heading font-bold text-txt">1.59 GB</p>
                  <p className="text-xxs text-txt-3">Tổng Dung Lượng</p>
                </div>
              </div>
            </div>

            {/* Video grid/list */}
            {filteredLibrary.length > 0 ? (
              <VideoLibraryGrid videos={filteredLibrary} viewMode={viewMode} />
            ) : (
              <div className="card p-12 text-center">
                <FolderOpen size={48} className="mx-auto mb-4 text-txt-3" />
                <p className="text-sm text-txt-2 mb-1">Không tìm thấy video nào</p>
                <p className="text-xs text-txt-3">Thử thay đổi bộ lọc hoặc từ khóa tìm kiếm</p>
              </div>
            )}
          </>
        )}
      </div>
    </DesktopOnlyGate>
  );
}
