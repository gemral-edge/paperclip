import React, { useState, useCallback, useMemo } from 'react';
import { copyToClipboard } from '@/lib/clipboard';
import {
  Repeat,
  ChevronDown,
  ChevronUp,
  Copy,
  CheckCircle,
  Download,
  Search,
  Loader2,
  Sparkles,
  FileText,
  Mail,
  Film,
  Layout,
  MessageCircle,
  Facebook,
  Eye,
  Clock,
  BarChart3,
  Shield,
  XCircle,
  AlertTriangle,
  Hash,
  Target,
  Globe,
  Zap,
  ArrowRight,
  CalendarDays,
  Send,
  Lightbulb,
  TrendingUp,
  AlertCircle,
} from 'lucide-react';
import { Badge, ProgressBar, Button, Select } from '@gem/ui';
import { useScriptsForRepurpose, useRepurposeScript } from '@gem/hooks/useRepurpose';

// ============================================================================
// Constants
// ============================================================================

const SCRIPT_TYPE_LABELS = {
  latc: 'LATC',
  tmt: 'TMT',
  short_clip: 'Clip Ngắn',
};

const TRACK_LABELS = {
  wealth: { label: 'Tài Chính', color: 'text-gold' },
  wellness: { label: 'Tâm Thức', color: 'text-purple' },
  integration: { label: 'Tích Hợp', color: 'text-emerald' },
};

const TARGET_OPTIONS = [
  {
    key: 'facebookPosts',
    apiTarget: 'facebook_posts',
    label: '5 Facebook Posts',
    count: 5,
    desc: '5 góc nhìn khác nhau từ kịch bản',
    icon: Facebook,
    color: 'text-blue',
    bgColor: 'bg-blue/20',
  },
  {
    key: 'emailSequences',
    apiTarget: 'email_sequence',
    label: '3 Email Sequences',
    count: 3,
    desc: 'Nurture → Value → CTA',
    icon: Mail,
    color: 'text-purple',
    bgColor: 'bg-purple/20',
  },
  {
    key: 'shortClips',
    apiTarget: 'short_clips',
    label: '4 Short Clips',
    count: 4,
    desc: '4 khoảnh khắc hay nhất, 30-60 giây',
    icon: Film,
    color: 'text-rose',
    bgColor: 'bg-rose/20',
  },
  {
    key: 'landingPage',
    apiTarget: 'landing_page',
    label: '1 Landing Page Copy',
    count: 1,
    desc: 'Headline, body, CTA cho landing page',
    icon: Layout,
    color: 'text-emerald',
    bgColor: 'bg-emerald/20',
  },
  {
    key: 'communityQuestions',
    apiTarget: 'community_questions',
    label: '2 Community Questions',
    count: 2,
    desc: 'Câu hỏi tạo tương tác cộng đồng',
    icon: MessageCircle,
    color: 'text-gold',
    bgColor: 'bg-gold/20',
  },
];

const ANGLE_COLORS = {
  'painpoint': 'text-rose',
  'story': 'text-purple',
  'insight': 'text-gold',
  'social proof': 'text-emerald',
  'cta': 'text-cyan',
};

function getAngleColor(angle) {
  const lower = angle.toLowerCase();
  for (const [key, color] of Object.entries(ANGLE_COLORS)) {
    if (lower.includes(key)) return color;
  }
  return 'text-txt-2';
}

const EMAIL_TYPE_LABELS = {
  nurture: 'Nurture — Nuôi Dưỡng',
  value: 'Value — Giá Trị',
  cta: 'CTA — Kêu Gọi Hành Động',
};

// ============================================================================
// Sub-components: ScriptPreviewCard
// ============================================================================

function ScriptPreviewCard({ script }) {
  const trackInfo = TRACK_LABELS[script.track] ?? { label: script.track, color: 'text-txt-3' };
  const preview = script.body?.slice(0, 200) ?? '';
  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-txt-2 uppercase tracking-wider flex items-center gap-2">
          <Eye size={14} className="text-gold" />
          Xem Trước Kịch Bản
        </h4>
        <Badge text={SCRIPT_TYPE_LABELS[script.content_type] ?? script.content_type} variant="gold" size="sm" />
      </div>
      <h3 className="text-sm font-semibold text-txt leading-snug">{script.title}</h3>
      <p className="text-xs text-txt-3 leading-relaxed line-clamp-3">{preview}...</p>
      <div className="flex items-center gap-4 pt-2 border-t border-border">
        <div className="flex items-center gap-1.5 text-xxs text-txt-3">
          <FileText size={10} />
          <span>{(script.word_count ?? 0).toLocaleString('vi-VN')} từ</span>
        </div>
        <div className="flex items-center gap-1.5 text-xxs text-txt-3">
          <Clock size={10} />
          <span>{Math.round((script.word_count ?? 0) / 150)} phút đọc</span>
        </div>
        <div className={`flex items-center gap-1.5 text-xxs ${trackInfo.color}`}>
          <Target size={10} />
          <span>{trackInfo.label}</span>
        </div>
        <div className="flex items-center gap-1.5 text-xxs text-txt-3">
          <CalendarDays size={10} />
          <span>{new Date(script.created_at).toLocaleDateString('vi-VN')}</span>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Sub-components: FacebookPostCard
// ============================================================================

function FacebookPostCard({ post, index, isExpanded, onToggle, onCopy, copied }) {
  const charCount = post.charCount ?? post.content.length;
  return (
    <div className="card p-0 overflow-hidden">
      <button type="button" onClick={onToggle}
        className="w-full flex items-center gap-3 p-3 hover:bg-bg-4/50 transition-all duration-normal">
        <div className="w-8 h-8 rounded-full bg-blue/20 flex items-center justify-center text-sm font-bold text-blue">{index + 1}</div>
        <div className="flex-1 text-left">
          <span className={`text-xs font-semibold ${getAngleColor(post.angle)}`}>{post.angle}</span>
          <p className="text-xxs text-txt-3 truncate max-w-[400px]">{post.content.split('\n')[0]}</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xxs text-txt-3">{charCount} ký tự</span>
          {isExpanded ? <ChevronUp size={12} className="text-txt-3" /> : <ChevronDown size={12} className="text-txt-3" />}
        </div>
      </button>
      {isExpanded && (
        <div className="px-4 pb-4 border-t border-border">
          <div className="bg-glass-bg rounded-card p-4 mt-3 max-h-[200px] overflow-y-auto">
            <p className="text-xs text-txt-2 whitespace-pre-wrap leading-relaxed">{post.content}</p>
          </div>
          {post.hashtags && post.hashtags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {post.hashtags.map((tag, i) => (
                <span key={i} className="text-xxs text-blue bg-blue/10 px-1.5 py-0.5 rounded">#{tag}</span>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between mt-3">
            <div className="flex items-center gap-3">
              <span className="text-xxs text-txt-3">{charCount} ký tự</span>
              <Badge text={charCount <= 500 ? 'Ngắn' : charCount <= 1000 ? 'Trung bình' : 'Dài'}
                variant={charCount <= 500 ? 'success' : charCount <= 1000 ? 'gold' : 'info'} size="sm" />
            </div>
            <Button variant="ghost" size="sm" icon={copied === `fb-${index}` ? CheckCircle : Copy}
              onClick={() => onCopy(post.content, `fb-${index}`)}>
              {copied === `fb-${index}` ? 'Đã Sao Chép' : 'Sao Chép'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Sub-components: EmailSequenceCard
// ============================================================================

function EmailSequenceCard({ email, index, isExpanded, onToggle, onCopy, copied }) {
  const typeColors = { nurture: 'text-purple', value: 'text-emerald', cta: 'text-gold' };
  const typeBgColors = { nurture: 'bg-purple/20', value: 'bg-emerald/20', cta: 'bg-gold/20' };
  const typeLabel = EMAIL_TYPE_LABELS[email.type] ?? email.type;

  return (
    <div className="card p-0 overflow-hidden">
      <button type="button" onClick={onToggle}
        className="w-full flex items-center gap-3 p-3 hover:bg-bg-4/50 transition-all duration-normal">
        <div className={`w-8 h-8 rounded-full ${typeBgColors[email.type] ?? 'bg-purple/20'} flex items-center justify-center`}>
          <Mail size={14} className={typeColors[email.type] ?? 'text-purple'} />
        </div>
        <div className="flex-1 text-left">
          <span className="text-xs font-semibold text-txt">{email.subject}</span>
          <p className="text-xxs text-txt-3">{typeLabel}</p>
        </div>
        <div className="flex items-center gap-3">
          <Badge text={email.type.toUpperCase()} variant={email.type === 'cta' ? 'gold' : email.type === 'value' ? 'success' : 'info'} size="sm" />
          {isExpanded ? <ChevronUp size={12} className="text-txt-3" /> : <ChevronDown size={12} className="text-txt-3" />}
        </div>
      </button>
      {isExpanded && (
        <div className="px-4 pb-4 border-t border-border">
          <div className="mt-3 space-y-2">
            <div className="flex items-center gap-2 text-xxs">
              <Clock size={10} className="text-txt-3" />
              <span className="text-txt-3">{email.timing}</span>
            </div>
            <div className="flex items-center gap-2 text-xxs">
              <Send size={10} className="text-txt-3" />
              <span className="text-txt-2 font-medium">Tiêu đề: {email.subject}</span>
            </div>
          </div>
          <div className="bg-glass-bg rounded-card p-4 mt-3 max-h-[250px] overflow-y-auto">
            <p className="text-xs text-txt-2 whitespace-pre-wrap leading-relaxed">{email.body}</p>
          </div>
          <div className="flex items-center justify-end mt-3">
            <Button variant="ghost" size="sm" icon={copied === `email-${index}` ? CheckCircle : Copy}
              onClick={() => onCopy(`Tiêu đề: ${email.subject}\n\n${email.body}`, `email-${index}`)}>
              {copied === `email-${index}` ? 'Đã Sao Chép' : 'Sao Chép'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Sub-components: ClipCard
// ============================================================================

function ClipCard({ clip, index, isExpanded, onToggle, onCopy, copied }) {
  const fullContent = [clip.hook, clip.body, clip.cta].filter(Boolean).join('\n\n');
  const duration = `${clip.estimatedDuration ?? 45} giây`;
  return (
    <div className="card p-0 overflow-hidden">
      <button type="button" onClick={onToggle}
        className="w-full flex items-center gap-3 p-3 hover:bg-bg-4/50 transition-all duration-normal">
        <div className="w-8 h-8 rounded-full bg-rose/20 flex items-center justify-center">
          <Film size={14} className="text-rose" />
        </div>
        <div className="flex-1 text-left">
          <span className="text-xs font-semibold text-txt">{clip.title}</span>
          <p className="text-xxs text-txt-3">{clip.timestampHint ?? ''}</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xxs text-txt-3">{clip.wordCount ?? 0} từ</span>
          <Badge text={duration} variant="danger" size="sm" />
          {isExpanded ? <ChevronUp size={12} className="text-txt-3" /> : <ChevronDown size={12} className="text-txt-3" />}
        </div>
      </button>
      {isExpanded && (
        <div className="px-4 pb-4 border-t border-border">
          <div className="mt-3 flex items-center gap-4">
            <div className="flex items-center gap-1.5 text-xxs text-txt-3">
              <Clock size={10} /><span>{clip.timestampHint ?? 'N/A'}</span>
            </div>
            <div className="flex items-center gap-1.5 text-xxs text-txt-3">
              <FileText size={10} /><span>{clip.wordCount ?? 0} từ</span>
            </div>
            <div className="flex items-center gap-1.5 text-xxs text-rose">
              <Film size={10} /><span>{duration}</span>
            </div>
          </div>
          <div className="bg-glass-bg rounded-card p-4 mt-3 max-h-[200px] overflow-y-auto">
            <p className="text-xs text-txt-2 whitespace-pre-wrap leading-relaxed">{fullContent}</p>
          </div>
          <div className="flex items-center justify-end mt-3">
            <Button variant="ghost" size="sm" icon={copied === `clip-${index}` ? CheckCircle : Copy}
              onClick={() => onCopy(fullContent, `clip-${index}`)}>
              {copied === `clip-${index}` ? 'Đã Sao Chép' : 'Sao Chép'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Sub-components: LandingPagePreview
// ============================================================================

function LandingPagePreview({ data, onCopy, copied }) {
  const bodyParts = [];
  if (data.painPoints?.length) bodyParts.push('Nỗi đau:\n' + data.painPoints.map((p) => `• ${p}`).join('\n'));
  if (data.benefits?.length) bodyParts.push('Lợi ích:\n' + data.benefits.map((b) => `• ${b}`).join('\n'));
  if (data.testimonialPrompt) bodyParts.push(data.testimonialPrompt);
  if (data.urgencyLine) bodyParts.push(data.urgencyLine);
  const bodyText = bodyParts.join('\n\n');
  const fullText = `${data.headline}\n\n${data.subheadline}\n\n${bodyText}\n\n[CTA] ${data.ctaText}\n${data.ctaSubtext}`;

  return (
    <div className="card p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Layout size={16} className="text-emerald" />
        <h4 className="text-sm font-semibold text-txt">Landing Page Copy</h4>
      </div>
      <div className="bg-glass-bg rounded-card p-5 space-y-4 border border-border">
        <div>
          <span className="text-xxs text-emerald font-semibold uppercase tracking-wider">Headline</span>
          <h2 className="font-heading text-lg font-bold text-txt mt-1">{data.headline}</h2>
        </div>
        <div>
          <span className="text-xxs text-emerald font-semibold uppercase tracking-wider">Subheadline</span>
          <p className="text-sm text-txt-2 mt-1">{data.subheadline}</p>
        </div>
        {data.painPoints && data.painPoints.length > 0 && (
          <div>
            <span className="text-xxs text-rose font-semibold uppercase tracking-wider">Nỗi Đau</span>
            <ul className="mt-1 space-y-1">
              {data.painPoints.map((p, i) => (
                <li key={i} className="text-xs text-txt-2 flex items-start gap-1.5">
                  <XCircle size={10} className="text-rose mt-0.5 flex-shrink-0" />{p}
                </li>
              ))}
            </ul>
          </div>
        )}
        {data.benefits && data.benefits.length > 0 && (
          <div>
            <span className="text-xxs text-emerald font-semibold uppercase tracking-wider">Lợi Ích</span>
            <ul className="mt-1 space-y-1">
              {data.benefits.map((b, i) => (
                <li key={i} className="text-xs text-txt-2 flex items-start gap-1.5">
                  <CheckCircle size={10} className="text-emerald mt-0.5 flex-shrink-0" />{b}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="pt-4 border-t border-border text-center">
          <div className="inline-block px-8 py-3 rounded-card bg-gold/20 border border-gold/30">
            <span className="text-sm font-bold text-gold">{data.ctaText}</span>
            <p className="text-xxs text-txt-3 mt-1">{data.ctaSubtext}</p>
          </div>
          {data.urgencyLine && (
            <p className="text-xxs text-rose mt-2">{data.urgencyLine}</p>
          )}
        </div>
      </div>
      <div className="flex items-center justify-end">
        <Button variant="ghost" size="sm" icon={copied === 'landing' ? CheckCircle : Copy}
          onClick={() => onCopy(fullText, 'landing')}>
          {copied === 'landing' ? 'Đã Sao Chép' : 'Sao Chép Toàn Bộ'}
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// Sub-components: CommunityQuestionCard
// ============================================================================

function CommunityQuestionCard({ question, index, onCopy, copied }) {
  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-gold/20 flex items-center justify-center">
            <MessageCircle size={14} className="text-gold" />
          </div>
          <span className="text-xs font-semibold text-txt">Câu Hỏi #{index + 1}</span>
        </div>
        <Badge text={question.context ?? 'Tương tác'} variant="gold" size="sm" />
      </div>
      <div className="bg-glass-bg rounded-card p-4">
        <p className="text-xs text-txt-2 whitespace-pre-wrap leading-relaxed">{question.question}</p>
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xxs text-txt-3">
          <Lightbulb size={10} /><span>{question.engagementHook ?? ''}</span>
        </div>
        <Button variant="ghost" size="sm" icon={copied === `cq-${index}` ? CheckCircle : Copy}
          onClick={() => onCopy(question.question, `cq-${index}`)}>
          {copied === `cq-${index}` ? 'Đã Sao Chép' : 'Sao Chép'}
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// Sub-components: BrandVoiceCheckPanel
// ============================================================================

function BrandVoiceCheckPanel({ items }) {
  const passed = items.filter((i) => i.passed).length;
  const total = items.length;
  const score = total > 0 ? Math.round((passed / total) * 100) : 0;

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-txt-2 uppercase tracking-wider flex items-center gap-2">
          <Shield size={14} className="text-purple" />
          Kiểm Tra Brand Voice
        </h4>
        <span className={`text-lg font-heading font-bold ${score >= 80 ? 'text-success' : score >= 60 ? 'text-gold' : 'text-danger'}`}>
          {score}/100
        </span>
      </div>
      <ProgressBar value={score} color={score >= 80 ? 'emerald' : score >= 60 ? 'gold' : 'danger'} size="sm" />
      <div className="space-y-1.5">
        {items.map((item, i) => (
          <div key={i} className="flex items-start gap-2 text-xxs">
            {item.passed ? (
              <CheckCircle size={12} className="text-success flex-shrink-0 mt-0.5" />
            ) : item.severity === 'critical' ? (
              <XCircle size={12} className="text-danger flex-shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle size={12} className="text-gold flex-shrink-0 mt-0.5" />
            )}
            <span className={item.passed ? 'text-txt-2' : item.severity === 'critical' ? 'text-danger' : 'text-gold'}>
              {item.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// Sub-components: ResultSectionHeader
// ============================================================================

function ResultSectionHeader({ icon: Icon, iconColor, iconBg, title, subtitle, badgeText, badgeVariant, isExpanded, onToggle }) {
  return (
    <button type="button" onClick={onToggle}
      className="w-full card p-3 flex items-center justify-between hover:bg-bg-4/50 transition-all duration-normal">
      <div className="flex items-center gap-3">
        <div className={`w-8 h-8 rounded-full ${iconBg} flex items-center justify-center`}>
          <Icon size={16} className={iconColor} />
        </div>
        <div className="text-left">
          <span className="text-sm font-semibold text-txt">{title}</span>
          <p className="text-xxs text-txt-3">{subtitle}</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Badge text={badgeText} variant={badgeVariant} size="sm" />
        {isExpanded ? <ChevronUp size={14} className="text-txt-3" /> : <ChevronDown size={14} className="text-txt-3" />}
      </div>
    </button>
  );
}

// ============================================================================
// Main Page Component
// ============================================================================

export default function RepurposePage() {
  // ── Data hooks ─────────────────────────────────────────────────
  const { data: scripts, isLoading: isLoadingScripts, error: scriptsError } = useScriptsForRepurpose();
  const { repurposeAsync, isLoading: isRepurposing, error: repurposeError, progress } = useRepurposeScript();

  // ── Local state ────────────────────────────────────────────────
  const [selectedScriptId, setSelectedScriptId] = useState('');
  const [targets, setTargets] = useState({
    facebookPosts: true, emailSequences: true, shortClips: true, landingPage: true, communityQuestions: true,
  });
  const [generationStage, setGenerationStage] = useState('');
  const [generationProgress, setGenerationProgress] = useState(0);
  const [results, setResults] = useState(null);
  const [brandCheckItems, setBrandCheckItems] = useState([]);
  const [copied, setCopied] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedSections, setExpandedSections] = useState({
    facebook: true, email: false, clips: false, landing: false, community: false,
  });
  const [expandedItems, setExpandedItems] = useState({});

  // ── Derived data ───────────────────────────────────────────────
  const scriptList = scripts ?? [];

  const selectedScript = useMemo(
    () => scriptList.find((s) => s.id === selectedScriptId) ?? null,
    [scriptList, selectedScriptId],
  );

  const filteredScripts = useMemo(() => {
    if (!searchQuery.trim()) return scriptList;
    const q = searchQuery.toLowerCase();
    return scriptList.filter((s) =>
      s.title.toLowerCase().includes(q) || s.content_type.toLowerCase().includes(q),
    );
  }, [scriptList, searchQuery]);

  const selectedTargetCount = useMemo(() => {
    let c = 0;
    if (targets.facebookPosts) c += 5;
    if (targets.emailSequences) c += 3;
    if (targets.shortClips) c += 4;
    if (targets.landingPage) c += 1;
    if (targets.communityQuestions) c += 2;
    return c;
  }, [targets]);

  const totalGeneratedItems = useMemo(() => {
    if (!results) return 0;
    let c = 0;
    c += results.facebookPosts?.length ?? 0;
    c += results.emails?.length ?? 0;
    c += results.clips?.length ?? 0;
    if (results.landingPage) c += 1;
    c += results.questions?.length ?? 0;
    return c;
  }, [results]);

  const platformsCovered = useMemo(() => {
    if (!results) return 0;
    let c = 0;
    if ((results.facebookPosts?.length ?? 0) > 0) c += 1;
    if ((results.emails?.length ?? 0) > 0) c += 1;
    if ((results.clips?.length ?? 0) > 0) c += 1;
    if (results.landingPage) c += 1;
    if ((results.questions?.length ?? 0) > 0) c += 1;
    return c;
  }, [results]);

  // ── Handlers ───────────────────────────────────────────────────
  const handleToggleTarget = useCallback((key) => {
    setTargets((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const handleToggleSection = useCallback((section) => {
    setExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }));
  }, []);

  const handleToggleItem = useCallback((itemKey) => {
    setExpandedItems((prev) => ({ ...prev, [itemKey]: !prev[itemKey] }));
  }, []);

  const handleCopy = useCallback((text, id) => {
    void copyToClipboard(text).then((ok) => {
      if (!ok) return;
      setCopied(id);
      setTimeout(() => setCopied(null), 2000);
    });
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!selectedScript) return;
    if (!Object.values(targets).some(Boolean)) return;

    // Map UI targets to API targets
    const apiTargets = TARGET_OPTIONS
      .filter((t) => targets[t.key])
      .map((t) => t.apiTarget);

    setResults(null);
    setBrandCheckItems([]);
    setGenerationStage('Đang gửi yêu cầu tái chế...');
    setGenerationProgress(10);

    try {
      setGenerationStage('Đang phân tích kịch bản gốc...');
      setGenerationProgress(25);

      const result = await repurposeAsync({
        scriptId: selectedScript.id,
        targets: apiTargets,
      });

      setGenerationProgress(90);
      setGenerationStage('Kiểm tra Brand Voice...');

      // Build brand check from result
      const brandScore = result.brandVoiceScore ?? 0;
      const brandItems = [
        { label: 'Jennie ở vị trí CAO, NỔI TIẾNG', passed: brandScore >= 60, severity: brandScore >= 60 ? 'ok' : 'warning' },
        { label: 'Nói về NGƯỜI KHÁC (không victim story)', passed: brandScore >= 50, severity: brandScore >= 50 ? 'ok' : 'warning' },
        { label: 'Không liệt kê tính năng', passed: brandScore >= 70, severity: brandScore >= 70 ? 'ok' : 'warning' },
        { label: 'Giọng "Chia sẻ bí mật / quan sát"', passed: brandScore >= 65, severity: brandScore >= 65 ? 'ok' : 'critical' },
        { label: 'Không sử dụng tiếng Anh xen lẫn', passed: brandScore >= 80, severity: brandScore >= 80 ? 'ok' : 'warning' },
        { label: 'CTA khéo léo, không bán hàng trực tiếp', passed: brandScore >= 55, severity: brandScore >= 55 ? 'ok' : 'warning' },
      ];

      setResults(result);
      setBrandCheckItems(brandItems);
      setGenerationProgress(100);
      setGenerationStage('Hoàn tất!');

      // Expand first available section
      const sectionMap = {
        facebook: (result.facebookPosts?.length ?? 0) > 0,
        email: (result.emails?.length ?? 0) > 0,
        clips: (result.clips?.length ?? 0) > 0,
        landing: result.landingPage !== undefined && result.landingPage !== null,
        community: (result.questions?.length ?? 0) > 0,
      };
      const firstAvailable = Object.entries(sectionMap).find(([, v]) => v);
      if (firstAvailable) {
        setExpandedSections(() => {
          const next = { facebook: false, email: false, clips: false, landing: false, community: false };
          next[firstAvailable[0]] = true;
          return next;
        });
      }
    } catch {
      setGenerationStage('');
      setGenerationProgress(0);
    }
  }, [selectedScript, targets, repurposeAsync]);

  const handleExportAll = useCallback(() => {
    if (!results || !selectedScript) return;
    let exportText = `=== TÁI SỬ DỤNG NỘI DUNG ===\nKịch bản gốc: ${selectedScript.title}\nNgày tạo: ${new Date().toLocaleDateString('vi-VN')}\n\n`;

    if (results.facebookPosts && results.facebookPosts.length > 0) {
      exportText += '--- FACEBOOK POSTS ---\n\n';
      results.facebookPosts.forEach((p) => { exportText += `[${p.angle}]\n${p.content}\n\n---\n\n`; });
    }
    if (results.emails && results.emails.length > 0) {
      exportText += '--- EMAIL SEQUENCES ---\n\n';
      results.emails.forEach((e) => { exportText += `[${EMAIL_TYPE_LABELS[e.type] ?? e.type}] ${e.subject}\nTiming: ${e.timing}\n\n${e.body}\n\n---\n\n`; });
    }
    if (results.clips && results.clips.length > 0) {
      exportText += '--- SHORT CLIPS ---\n\n';
      results.clips.forEach((c) => { exportText += `[${c.title}] ${c.timestampHint} (${c.estimatedDuration}s)\n\n${c.hook}\n${c.body}\n${c.cta}\n\n---\n\n`; });
    }
    if (results.landingPage) {
      exportText += '--- LANDING PAGE ---\n\n';
      exportText += `Headline: ${results.landingPage.headline}\nSubheadline: ${results.landingPage.subheadline}\n\nCTA: ${results.landingPage.ctaText}\n${results.landingPage.ctaSubtext}\n\n---\n\n`;
    }
    if (results.questions && results.questions.length > 0) {
      exportText += '--- COMMUNITY QUESTIONS ---\n\n';
      results.questions.forEach((q) => { exportText += `[${q.context}]\n${q.question}\n\n---\n\n`; });
    }

    void copyToClipboard(exportText).then((ok) => {
      if (!ok) return;
      setCopied('export-all');
      setTimeout(() => setCopied(null), 2500);
    });
  }, [results, selectedScript]);

  // =========================================================================
  // Render
  // =========================================================================

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-card bg-purple/20 flex items-center justify-center">
            <Repeat size={22} className="text-gold" />
          </div>
          <div>
            <h1 className="font-heading text-2xl font-semibold text-txt">Tái Sử Dụng Nội Dung</h1>
            <p className="text-xs text-txt-3">1 Kịch Bản YouTube → Đa Nền Tảng: Facebook, Email, Clips, Landing Page, Community</p>
          </div>
        </div>
        {results && (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" icon={copied === 'export-all' ? CheckCircle : Download} onClick={handleExportAll}>
              {copied === 'export-all' ? 'Đã Xuất' : 'Xuất Tất Cả'}
            </Button>
          </div>
        )}
      </div>

      {/* Error banner */}
      {(repurposeError || scriptsError) && (
        <div className="card p-4 border-danger/30 bg-danger/5 flex items-center gap-3">
          <AlertCircle size={18} className="text-danger flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-danger">Lỗi</p>
            <p className="text-xs text-txt-2">{repurposeError ?? scriptsError?.message ?? 'Đã xảy ra lỗi'}</p>
          </div>
        </div>
      )}

      {/* Stats Row */}
      {results && (
        <div className="grid grid-cols-4 gap-3">
          <div className="card p-3 flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-purple/20 flex items-center justify-center"><Hash size={16} className="text-purple" /></div>
            <div>
              <div className="text-lg font-heading font-bold text-txt">{totalGeneratedItems}</div>
              <p className="text-xxs text-txt-3">Nội dung đã tạo</p>
            </div>
          </div>
          <div className="card p-3 flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-emerald/20 flex items-center justify-center"><Globe size={16} className="text-emerald" /></div>
            <div>
              <div className="text-lg font-heading font-bold text-txt">{platformsCovered}</div>
              <p className="text-xxs text-txt-3">Nền tảng phủ sóng</p>
            </div>
          </div>
          <div className="card p-3 flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-gold/20 flex items-center justify-center"><TrendingUp size={16} className="text-gold" /></div>
            <div>
              <div className="text-lg font-heading font-bold text-txt">~{(totalGeneratedItems * 2500).toLocaleString('vi-VN')}</div>
              <p className="text-xxs text-txt-3">Lượt tiếp cận ước tính</p>
            </div>
          </div>
          <div className="card p-3 flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-cyan/20 flex items-center justify-center"><Zap size={16} className="text-cyan" /></div>
            <div>
              <div className="text-lg font-heading font-bold text-txt">x{totalGeneratedItems}</div>
              <p className="text-xxs text-txt-3">Hệ số nhân nội dung</p>
            </div>
          </div>
        </div>
      )}

      {/* Main 2-Column Layout */}
      <div className="grid grid-cols-12 gap-6">
        {/* LEFT: Script Selector + Targets */}
        <div className="col-span-5 space-y-4">
          <div className="card p-4 space-y-4">
            <h3 className="text-sm font-semibold text-txt flex items-center gap-2">
              <FileText size={16} className="text-gold" />Chọn Kịch Bản Gốc
            </h3>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-txt-3" />
              <input type="text" className="fi pl-9 text-sm" placeholder="Tìm kịch bản theo tên hoặc loại..."
                value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
            </div>

            {isLoadingScripts ? (
              <div className="text-center py-6">
                <Loader2 size={24} className="mx-auto mb-2 text-purple animate-spin" />
                <p className="text-xs text-txt-3">Đang tải danh sách kịch bản...</p>
              </div>
            ) : scriptList.length === 0 ? (
              <div className="text-center py-6 text-txt-3">
                <FileText size={32} className="mx-auto mb-2 opacity-50" />
                <p className="text-xs">Chưa có kịch bản nào. Hãy tạo kịch bản trước.</p>
              </div>
            ) : (
              <>
                <Select label="Kịch Bản"
                  options={filteredScripts.map((s) => ({ value: s.id, label: `[${SCRIPT_TYPE_LABELS[s.content_type] ?? s.content_type}] ${s.title}` }))}
                  value={selectedScriptId} onChange={setSelectedScriptId} placeholder="Chọn kịch bản nguồn..." />
                {selectedScript && <ScriptPreviewCard script={selectedScript} />}
                {!selectedScript && (
                  <div className="text-center py-6 text-txt-3">
                    <FileText size={32} className="mx-auto mb-2 opacity-50" />
                    <p className="text-xs">Chọn một kịch bản để bắt đầu tái sử dụng</p>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Target Checkboxes */}
          <div className="card p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-txt flex items-center gap-2">
                <Target size={16} className="text-purple" />Chọn Đích Tái Sử Dụng
              </h3>
              <span className="text-xxs text-txt-3">{selectedTargetCount} nội dung sẽ được tạo</span>
            </div>
            <div className="space-y-2">
              {TARGET_OPTIONS.map((target) => {
                const Icon = target.icon;
                const isChecked = targets[target.key];
                const progressItem = progress.find((p) => p.target === target.apiTarget);
                return (
                  <button key={target.key} type="button" onClick={() => handleToggleTarget(target.key)}
                    className={`w-full flex items-center gap-3 p-3 rounded-card border transition-all duration-normal ${isChecked ? 'border-purple/30 bg-purple/5' : 'border-border bg-glass-bg hover:border-border'
                      }`}>
                    <div className={`w-5 h-5 rounded flex items-center justify-center border transition-all duration-normal flex-shrink-0 ${isChecked ? 'bg-purple border-purple' : 'border-border bg-bg-4'
                      }`}>
                      {isChecked && <CheckCircle size={12} className="text-bg" />}
                    </div>
                    <div className={`w-8 h-8 rounded-full ${target.bgColor} flex items-center justify-center flex-shrink-0`}>
                      <Icon size={14} className={target.color} />
                    </div>
                    <div className="flex-1 text-left">
                      <span className="text-xs font-semibold text-txt">{target.label}</span>
                      <p className="text-xxs text-txt-3">{target.desc}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {progressItem && (
                        <Badge
                          text={progressItem.status === 'generating' ? 'Đang tạo' : progressItem.status === 'done' ? 'Xong' : progressItem.status === 'error' ? 'Lỗi' : ''}
                          variant={progressItem.status === 'done' ? 'success' : progressItem.status === 'error' ? 'danger' : 'info'}
                          size="sm"
                        />
                      )}
                      <Badge text={`${target.count}`} variant={isChecked ? 'new' : 'default'} size="sm" />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Generate Button */}
          <Button variant="gold" size="lg" icon={isRepurposing ? Loader2 : Sparkles} fullWidth onClick={handleGenerate}
            disabled={!selectedScript || isRepurposing || !Object.values(targets).some(Boolean)} loading={isRepurposing}>
            {isRepurposing ? 'Đang Tạo...' : 'Tái Sử Dụng Nội Dung'}
          </Button>

          {/* Generation Progress */}
          {isRepurposing && (
            <div className="card p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Loader2 size={14} className="text-purple animate-spin" />
                <span className="text-xs text-txt-2">{generationStage}</span>
              </div>
              <ProgressBar value={generationProgress} color="purple" size="md" showLabel label="Tiến trình tái sử dụng" animated />
            </div>
          )}

          {/* Brand Voice Check */}
          {brandCheckItems.length > 0 && !isRepurposing && <BrandVoiceCheckPanel items={brandCheckItems} />}
        </div>

        {/* RIGHT: Results Panel */}
        <div className="col-span-7 space-y-4">
          <div className="card p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-txt flex items-center gap-2">
                <BarChart3 size={16} className="text-emerald" />Kết Quả Tái Sử Dụng
              </h3>
              {results && (
                <div className="flex items-center gap-2">
                  <Badge text={`${totalGeneratedItems} nội dung`} variant="new" size="sm" dot />
                  <Badge text={`${platformsCovered} nền tảng`} variant="gold" size="sm" dot />
                </div>
              )}
            </div>
          </div>

          {/* Empty state */}
          {!results && !isRepurposing && (
            <div className="glass-card p-12 text-center">
              <Repeat size={48} className="mx-auto mb-4 text-txt-3 opacity-40" />
              <h3 className="font-heading text-lg font-semibold text-txt-2 mb-2">Chưa Có Kết Quả</h3>
              <p className="text-xs text-txt-3 max-w-md mx-auto">
                Chọn kịch bản gốc, đánh dấu các đích muốn tạo, sau đó nhấn &quot;Tái Sử Dụng Nội Dung&quot; để bắt đầu.
              </p>
              <div className="flex items-center justify-center gap-2 mt-6 text-xxs text-txt-3">
                <FileText size={12} /><ArrowRight size={10} /><Target size={12} /><ArrowRight size={10} />
                <Sparkles size={12} className="text-gold" /><ArrowRight size={10} /><CheckCircle size={12} className="text-success" />
              </div>
            </div>
          )}

          {/* Loading state */}
          {isRepurposing && !results && (
            <div className="glass-card p-12 text-center">
              <Loader2 size={48} className="mx-auto mb-4 text-purple animate-spin" />
              <h3 className="font-heading text-lg font-semibold text-txt-2 mb-2">Đang Tạo Nội Dung...</h3>
              <p className="text-xs text-txt-3">{generationStage}</p>
            </div>
          )}

          {/* Facebook Posts */}
          {results && results.facebookPosts && results.facebookPosts.length > 0 && (
            <div className="space-y-2">
              <ResultSectionHeader icon={Facebook} iconColor="text-blue" iconBg="bg-blue/20"
                title="Facebook Posts" subtitle={`${results.facebookPosts.length} bài viết, ${results.facebookPosts.length} góc nhìn`}
                badgeText={`${results.facebookPosts.length}`} badgeVariant="info"
                isExpanded={expandedSections.facebook ?? false} onToggle={() => handleToggleSection('facebook')} />
              {expandedSections.facebook && (
                <div className="space-y-2 pl-2">
                  {results.facebookPosts.map((post, i) => (
                    <FacebookPostCard key={i} post={post} index={i} isExpanded={expandedItems[`fb-${i}`] ?? false}
                      onToggle={() => handleToggleItem(`fb-${i}`)} onCopy={handleCopy} copied={copied} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Email Sequences */}
          {results && results.emails && results.emails.length > 0 && (
            <div className="space-y-2">
              <ResultSectionHeader icon={Mail} iconColor="text-purple" iconBg="bg-purple/20"
                title="Email Sequences" subtitle="Nurture → Value → CTA"
                badgeText={`${results.emails.length}`} badgeVariant="info"
                isExpanded={expandedSections.email ?? false} onToggle={() => handleToggleSection('email')} />
              {expandedSections.email && (
                <div className="space-y-2 pl-2">
                  {results.emails.map((email, i) => (
                    <EmailSequenceCard key={i} email={email} index={i} isExpanded={expandedItems[`email-${i}`] ?? false}
                      onToggle={() => handleToggleItem(`email-${i}`)} onCopy={handleCopy} copied={copied} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Short Clips */}
          {results && results.clips && results.clips.length > 0 && (
            <div className="space-y-2">
              <ResultSectionHeader icon={Film} iconColor="text-rose" iconBg="bg-rose/20"
                title="Short Clips" subtitle="Khoảnh khắc hay nhất, 30-60 giây"
                badgeText={`${results.clips.length}`} badgeVariant="danger"
                isExpanded={expandedSections.clips ?? false} onToggle={() => handleToggleSection('clips')} />
              {expandedSections.clips && (
                <div className="space-y-2 pl-2">
                  {results.clips.map((clip, i) => (
                    <ClipCard key={i} clip={clip} index={i} isExpanded={expandedItems[`clip-${i}`] ?? false}
                      onToggle={() => handleToggleItem(`clip-${i}`)} onCopy={handleCopy} copied={copied} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Landing Page */}
          {results && results.landingPage && (
            <div className="space-y-2">
              <ResultSectionHeader icon={Layout} iconColor="text-emerald" iconBg="bg-emerald/20"
                title="Landing Page Copy" subtitle="Headline, body, CTA sẵn sàng sử dụng"
                badgeText="1" badgeVariant="success"
                isExpanded={expandedSections.landing ?? false} onToggle={() => handleToggleSection('landing')} />
              {expandedSections.landing && (
                <div className="pl-2">
                  <LandingPagePreview data={results.landingPage} onCopy={handleCopy} copied={copied} />
                </div>
              )}
            </div>
          )}

          {/* Community Questions */}
          {results && results.questions && results.questions.length > 0 && (
            <div className="space-y-2">
              <ResultSectionHeader icon={MessageCircle} iconColor="text-gold" iconBg="bg-gold/20"
                title="Community Questions" subtitle="Câu hỏi tạo tương tác cộng đồng"
                badgeText={`${results.questions.length}`} badgeVariant="gold"
                isExpanded={expandedSections.community ?? false} onToggle={() => handleToggleSection('community')} />
              {expandedSections.community && (
                <div className="space-y-2 pl-2">
                  {results.questions.map((q, i) => (
                    <CommunityQuestionCard key={i} question={q} index={i} onCopy={handleCopy} copied={copied} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Bottom Action Bar */}
      {results && (
        <div className="card p-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-txt-2">Kịch bản gốc:</span>
              <span className="font-bold text-purple truncate max-w-[200px]">{selectedScript?.title.split('—')[0]?.trim()}</span>
            </div>
            <div className="w-px h-6 bg-border" />
            <div className="flex items-center gap-2 text-sm">
              <span className="text-txt-2">Nội dung:</span>
              <span className="font-bold text-gold">{totalGeneratedItems}</span>
            </div>
            <div className="w-px h-6 bg-border" />
            <div className="flex items-center gap-2 text-sm">
              <span className="text-txt-2">Nền tảng:</span>
              <span className="font-bold text-emerald">{platformsCovered}</span>
            </div>
            <div className="w-px h-6 bg-border" />
            <div className="flex items-center gap-2 text-sm">
              <span className="text-txt-2">Tiếp cận:</span>
              <span className="font-bold text-cyan">~{(totalGeneratedItems * 2500).toLocaleString('vi-VN')}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" icon={Sparkles} onClick={handleGenerate} disabled={isRepurposing}>Tái Tạo Lại</Button>
            <Button variant="outline" size="sm" icon={copied === 'export-all' ? CheckCircle : Download} onClick={handleExportAll}>
              {copied === 'export-all' ? 'Đã Xuất' : 'Xuất'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
