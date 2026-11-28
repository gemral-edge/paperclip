import React, { useState } from 'react';
import {
  Shield,
  BookOpen,
  CheckCircle,
  XCircle,
  FileText,
  Edit3,
  Search,
  Loader2,
  Lock,
  Copy,
  Check,
  CircleDot,
  Square,
  CheckSquare,
} from 'lucide-react';
import { useBrandRules } from '@gem/hooks/useQueryHooks';

// ============================================================================
// Brand Voice Rules Screen + Lock Screen (Phase 4)
// ============================================================================

const categories = [
  { id: 'lock', label: 'Khóa Thương Hiệu', description: '10 tài liệu checklist', icon: Lock, color: 'text-cyan' },
  { id: 'golden_rule', label: '10 Quy Tắc Vàng', description: 'Các quy tắc bắt buộc cho mọi nội dung', icon: Shield, color: 'text-gold' },
  { id: 'forbidden_term', label: 'Từ Cấm', description: 'Thuật ngữ không được sử dụng', icon: XCircle, color: 'text-danger' },
  { id: 'terminology', label: 'Thuật Ngữ', description: 'Quy ước chuyển đổi Anh-Việt', icon: BookOpen, color: 'text-blue' },
  { id: 'structure', label: 'Cấu Trúc', description: 'Quy tắc cấu trúc nội dung', icon: FileText, color: 'text-purple' },
  { id: 'tone', label: 'Giọng Điệu', description: 'Quy tắc giọng điệu & phong cách', icon: Edit3, color: 'text-emerald' },
];

// ---------------------------------------------------------------------------
// Brand Documents Checklist (Phase 4: Brand Voice Lock)
// ---------------------------------------------------------------------------

const BRAND_DOCUMENTS = [
  { id: 1, name: 'Sổ Tay Giọng Thương Hiệu', desc: '2 Modes, patterns, forbidden/power phrases', category: 'voice' },
  { id: 2, name: 'Framework LATC Script', desc: 'Hook + 5 phần + CTA + Closing, dual examples', category: 'script' },
  { id: 3, name: 'Framework TMT Script', desc: '8-9 phần, climax, tôn kính rules', category: 'script' },
  { id: 4, name: 'Framework Short Clip', desc: '30-70s, Provocative formula', category: 'script' },
  { id: 5, name: 'Framework Social Media', desc: '30-day campaigns, 30 CTA patterns', category: 'social' },
  { id: 6, name: 'Hệ Thống Tiêu Đề & Thumbnail', desc: 'LATC 4 + TMT 5 formulas', category: 'title' },
  { id: 7, name: 'Bản Đồ Persona', desc: '7 personas, journey, LTV', category: 'persona' },
  { id: 8, name: 'Thư Viện Emotional Trigger', desc: 'Tần số, nghiệp, hooks', category: 'trigger' },
  { id: 9, name: 'Chiến Lược CTA & Phễu', desc: '3 funnels, 5-layer CTA', category: 'funnel' },
  { id: 10, name: 'Danh Sách Cấm & Tuân Thủ', desc: 'KHÔNG/NÊN, thuật ngữ VN, TMT rules', category: 'compliance' },
];

const DONT_RULES = [
  'Dùng từ "tâm linh" (dùng "tâm thức")',
  'CTA tải tài liệu/PDF tóm tắt',
  'Bullet points trong kịch bản',
  'Nói giá trong video ngắn',
  'Đặt sản phẩm trong tiêu đề',
  'Dùng emoji trong kịch bản',
  'Dồn GEM tools vào cuối',
  'CTA sau phần closing',
  'Tiếng Anh khi có từ Việt tương đương',
  'Gọi "ông/anh" cho Sư Minh Tuệ',
];

const DO_RULES = [
  'Dual examples: 1 crypto + 1 đời sống',
  'Dẫn vào bối cảnh trước ví dụ',
  'GEM tools rải đều mỗi phần',
  'Viết dạng prose flowing, văn xuôi',
  'Kết nối mọi concept về TẦN SỐ',
  'CTA khóa học TRƯỚC closing',
  'Giáo dục > Bán hàng',
  'Transition mượt giữa các phần',
  'Closing nhẹ nhàng, touching',
  'Tiếng Việt thuần túy cho mọi thuật ngữ',
];

const GOLDEN_RULES = [
  { id: '1', name: 'DUAL EXAMPLES', description: 'Mỗi concept = 1 ví dụ crypto + 1 đời sống. Không được thiếu bất kỳ loại ví dụ nào.' },
  { id: '2', name: 'DẪN VÀO BỐI CẢNH', description: '"Trong thế giới đầu tư..." / "Ngoài thị trường..." — Luôn dẫn vào bối cảnh trước ví dụ.' },
  { id: '3', name: 'GEM TOOLS rải đều', description: 'Rải GEM tools trong từng phần, KHÔNG dồn cuối. Mỗi phần có ít nhất 1 tool reference.' },
  { id: '4', name: 'Tiếng Việt thuần túy', description: 'Không dùng từ tiếng Anh khi có tương đương tiếng Việt: entry→điểm mua, stop loss→điểm cắt lỗ...' },
  { id: '5', name: 'Prose flowing', description: 'KHÔNG bullet points, KHÔNG dạng liệt kê. Viết dạng văn xuôi mượt mà, chảy tràn.' },
  { id: '6', name: 'Tần số trung tâm', description: 'TẦN SỐ là USP cốt lõi của Jennie. Mọi concept đều phải kết nối về tần số & nghiệp lực.' },
  { id: '7', name: 'CTA trước closing', description: 'CTA khóa học phải đặt TRƯỚC phần closing. Không được đặt CTA sau lời kết.' },
  { id: '8', name: 'Giáo dục > Bán hàng', description: 'Sản phẩm KHÔNG trong tiêu đề. Ưu tiên giáo dục, share value trước khi mention sản phẩm.' },
  { id: '9', name: 'Pattern transition', description: '"Ok, đó là sự thật thứ [N]. Nhưng..." — Dùng câu chuyển mượt giữa các phần.' },
  { id: '10', name: 'Closing touching', description: 'Kết thúc nhẹ nhàng, touching, truyền cảm hứng. Không kêu gọi mạnh ở closing.' },
];

const FORBIDDEN_TERMS = [
  { term: 'tâm linh', replacement: 'tâm thức', severity: 'critical' },
  { term: 'dạy crypto', replacement: 'giúp bạn hiểu năng lượng đồng tiền', severity: 'critical' },
  { term: 'đảm bảo lợi nhuận', replacement: null, severity: 'critical' },
  { term: 'giàu nhanh', replacement: null, severity: 'critical' },
  { term: 'ông/anh (cho sư)', replacement: 'Thầy/Ngài', severity: 'high' },
];

const TERM_CONVERSIONS = [
  { en: 'entry', vi: 'điểm mua' },
  { en: 'stop loss', vi: 'điểm cắt lỗ' },
  { en: 'take profit', vi: 'điểm chốt lời' },
  { en: 'win rate', vi: 'tỷ lệ thành công' },
  { en: 'scanner', vi: 'công cụ quét' },
  { en: 'whale tracker', vi: 'theo dõi cá mập' },
  { en: 'support', vi: 'hỗ trợ' },
  { en: 'resistance', vi: 'kháng cự' },
  { en: 'breakout', vi: 'phá vỡ' },
  { en: 'trend', vi: 'xu hướng' },
  { en: 'portfolio', vi: 'danh mục' },
  { en: 'leverage', vi: 'đòn bẩy' },
  { en: 'mindset', vi: 'tư duy' },
  { en: 'healing', vi: 'chữa lành' },
  { en: 'meditation', vi: 'thiền định' },
  { en: 'frequency', vi: 'tần số' },
  { en: 'vibration', vi: 'rung động' },
  { en: 'karma', vi: 'nghiệp' },
];

export default function BrandVoicePage() {
  const [activeCategory, setActiveCategory] = useState('lock');
  const [searchQuery, setSearchQuery] = useState('');
  const [checkedDocs, setCheckedDocs] = useState(new Set());
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const { data: dbRules, isLoading } = useBrandRules();

  const toggleDoc = (id) => {
    setCheckedDocs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const lockProgress = Math.round((checkedDocs.size / BRAND_DOCUMENTS.length) * 100);
  const isLocked = checkedDocs.size === BRAND_DOCUMENTS.length;

  const handleCopyPrompt = async () => {
    const promptText = `Bạn là Jennie Uyen Chu — "Thức Tỉnh Tâm Thức" YouTube (277K+ subscribers).
USP: Jennie giải mã TẦN SỐ và NGHIỆP LỰC đằng sau mọi sự kiện.
3 Track: Wealth 30% / Wellness 30% / Integration 40%.
2 Modes: MODE 1 (Trầm-Tĩnh-Thủ Thỉ) + MODE 2 (Đanh-Thép-Provocative).
10 Quy Tắc Vàng: Dual Examples, Context Lead-in, GEM Tools Spread, Vietnamese Purity, Prose Flowing, Frequency-Centered, CTA Before Closing, Education > Sales, Pattern Transitions, Touching Closing.
Forbidden: "tâm linh"→"tâm thức", NO document CTAs, NO bullet points, NO English terms.`;
    try { await navigator.clipboard.writeText(promptText); } catch { /* ignore */ }
    setCopiedPrompt(true);
    setTimeout(() => setCopiedPrompt(false), 2000);
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-2xl font-bold text-txt flex items-center gap-3">
            <Shield size={24} className="text-gold" />
            Brand Voice Rules
          </h1>
          <p className="text-sm text-txt-3 mt-1">
            Quản lý quy tắc giọng điệu thương hiệu Jennie Uyen Chu
          </p>
        </div>
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-txt-3" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Tìm kiếm quy tắc..."
            className="fi pl-9 text-sm w-64"
          />
        </div>
      </div>

      {/* Category tabs */}
      <div className="flex gap-2 overflow-x-auto pb-2">
        {categories.map((cat) => {
          const Icon = cat.icon;
          const isActive = activeCategory === cat.id;
          return (
            <button
              key={cat.id}
              onClick={() => setActiveCategory(cat.id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-card text-sm whitespace-nowrap transition-all
                ${isActive
                  ? 'bg-bg-2 border border-gold/30 text-txt'
                  : 'bg-glass-bg border border-border text-txt-3 hover:text-txt hover:border-border-2'
                }`}
            >
              <Icon size={16} className={isActive ? cat.color : 'text-txt-3'} />
              {cat.label}
            </button>
          );
        })}
      </div>

      {/* Brand Voice Lock Screen */}
      {activeCategory === 'lock' && (
        <div className="space-y-6">
          {/* Lock Status */}
          <div className={`glass-card p-6 border ${isLocked ? 'border-success/30' : 'border-gold/20'}`}>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className={`w-12 h-12 rounded-card flex items-center justify-center ${isLocked ? 'bg-success/10' : 'bg-gold/10'}`}>
                  {isLocked ? (
                    <CheckCircle size={24} className="text-success" />
                  ) : (
                    <Lock size={24} className="text-gold" />
                  )}
                </div>
                <div>
                  <h2 className="font-heading text-lg font-semibold text-txt">
                    {isLocked ? 'Thương Hiệu Đã Khóa' : 'Khóa Giọng Thương Hiệu'}
                  </h2>
                  <p className="text-xs text-txt-3">
                    {isLocked
                      ? 'Tất cả 10 tài liệu đã được xác nhận. AI sẽ tuân thủ nghiêm ngặt.'
                      : `Xác nhận ${checkedDocs.size}/10 tài liệu để khóa thương hiệu.`}
                  </p>
                </div>
              </div>
              <div className="text-right">
                <span className={`text-2xl font-bold ${isLocked ? 'text-success' : 'text-gold'}`}>
                  {lockProgress}%
                </span>
              </div>
            </div>
            {/* Progress bar */}
            <div className="h-2 bg-bg-4 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${isLocked ? 'bg-success' : 'bg-gradient-to-r from-gold to-purple'}`}
                style={{ width: `${lockProgress}%` }}
              />
            </div>
          </div>

          {/* Document Checklist */}
          <div className="space-y-2">
            <h3 className="font-heading text-md font-semibold text-txt mb-3">
              10 Tài Liệu Thương Hiệu
            </h3>
            {BRAND_DOCUMENTS.map((doc) => {
              const checked = checkedDocs.has(doc.id);
              return (
                <button
                  key={doc.id}
                  onClick={() => toggleDoc(doc.id)}
                  className={`card p-4 w-full flex items-center gap-4 text-left transition-all ${
                    checked ? 'border-success/20 bg-success/5' : 'hover:border-border-2'
                  }`}
                >
                  {checked ? (
                    <CheckSquare size={20} className="text-success shrink-0" />
                  ) : (
                    <Square size={20} className="text-txt-3 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium ${checked ? 'text-success' : 'text-txt'}`}>
                      {doc.id}. {doc.name}
                    </p>
                    <p className="text-xxs text-txt-3 mt-0.5">{doc.desc}</p>
                  </div>
                  <span className="text-xxs text-txt-3 bg-glass-bg px-2 py-0.5 rounded-badge shrink-0">
                    {doc.category}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Master Prompt */}
          <div className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-heading text-md font-semibold text-txt flex items-center gap-2">
                <FileText size={16} className="text-gold" />
                Master System Prompt
              </h3>
              <button
                onClick={handleCopyPrompt}
                className="btn btn-gh text-xs flex items-center gap-1.5"
              >
                {copiedPrompt ? (
                  <><Check size={14} className="text-success" /> Đã sao chép</>
                ) : (
                  <><Copy size={14} /> Sao chép</>
                )}
              </button>
            </div>
            <div className="p-3 rounded-card bg-glass-bg font-mono text-xs text-txt-2 leading-relaxed max-h-48 overflow-y-auto">
              <p>Bạn là Jennie Uyen Chu — &quot;Thức Tỉnh Tâm Thức&quot; YouTube (277K+ subscribers).</p>
              <p className="mt-2">USP: Jennie giải mã TẦN SỐ và NGHIỆP LỰC đằng sau mọi sự kiện.</p>
              <p className="mt-2">3 Track: Wealth 30% / Wellness 30% / Integration 40%.</p>
              <p className="mt-2">2 Modes: MODE 1 (Trầm-Tĩnh-Thủ Thỉ) + MODE 2 (Đanh-Thép-Provocative).</p>
              <p className="mt-2">10 Quy Tắc Vàng: Dual Examples, Context Lead-in, GEM Tools Spread, Vietnamese Purity, Prose Flowing, Frequency-Centered, CTA Before Closing, Education &gt; Sales, Pattern Transitions, Touching Closing.</p>
              <p className="mt-2">Forbidden: &quot;tâm linh&quot;→&quot;tâm thức&quot;, NO document CTAs, NO bullet points, NO English terms.</p>
            </div>
          </div>

          {/* KHÔNG / NÊN Quick View */}
          <div className="g2">
            <div className="card p-4">
              <h3 className="font-heading text-md font-semibold text-danger mb-3 flex items-center gap-2">
                <XCircle size={16} />
                KHÔNG
              </h3>
              <div className="space-y-2">
                {DONT_RULES.map((rule) => (
                  <div key={rule} className="flex items-start gap-2">
                    <XCircle size={14} className="text-danger shrink-0 mt-0.5" />
                    <span className="text-xs text-txt-2">{rule}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="card p-4">
              <h3 className="font-heading text-md font-semibold text-success mb-3 flex items-center gap-2">
                <CheckCircle size={16} />
                NÊN
              </h3>
              <div className="space-y-2">
                {DO_RULES.map((rule) => (
                  <div key={rule} className="flex items-start gap-2">
                    <CheckCircle size={14} className="text-success shrink-0 mt-0.5" />
                    <span className="text-xs text-txt-2">{rule}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Compliance Score Overview */}
          <div className="card p-4">
            <h3 className="font-heading text-md font-semibold text-txt mb-4 flex items-center gap-2">
              <CircleDot size={16} className="text-gold" />
              Tổng Quan Tuân Thủ
            </h3>
            <div className="g4">
              {[
                { label: 'Quy Tắc Vàng', count: '10/10', pct: 100, color: 'text-gold', bg: 'bg-gold' },
                { label: 'Từ Cấm', count: '5 terms', pct: 100, color: 'text-danger', bg: 'bg-danger' },
                { label: 'Thuật Ngữ', count: '18 entries', pct: 100, color: 'text-blue', bg: 'bg-blue' },
                { label: 'Cấu Trúc', count: '2 formats', pct: 100, color: 'text-purple', bg: 'bg-purple' },
              ].map((item) => (
                <div key={item.label} className="text-center">
                  <div className={`text-lg font-bold ${item.color}`}>{item.count}</div>
                  <div className="text-xxs text-txt-3 mt-1">{item.label}</div>
                  <div className="h-1 bg-bg-4 rounded-full mt-2 overflow-hidden">
                    <div className={`h-full rounded-full ${item.bg}`} style={{ width: `${item.pct}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Golden Rules */}
      {activeCategory === 'golden_rule' && (
        <div className="space-y-3">
          <p className="text-sm text-txt-2">
            10 quy tắc vàng bắt buộc áp dụng cho mọi nội dung LATC, TMT, và Clip Ngắn.
          </p>
          {GOLDEN_RULES.map((rule) => (
            <div key={rule.id} className="card p-4 border-l-[3px] border-l-gold">
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-badge bg-gold/10 flex items-center justify-center shrink-0">
                  <span className="text-sm font-bold text-gold">{rule.id}</span>
                </div>
                <div className="flex-1">
                  <h3 className="text-sm font-semibold text-txt mb-1">{rule.name}</h3>
                  <p className="text-xs text-txt-2 leading-relaxed">{rule.description}</p>
                </div>
                <CheckCircle size={18} className="text-success shrink-0" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Forbidden Terms */}
      {activeCategory === 'forbidden_term' && (
        <div className="space-y-3">
          <p className="text-sm text-txt-2">
            Các thuật ngữ bị cấm tuyệt đối trong mọi nội dung. Vi phạm sẽ bị đánh dấu nghiêm trọng.
          </p>
          <div className="card overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-glass-bg">
                  <th className="text-left text-xs font-medium text-txt-3 px-4 py-3">Từ cấm</th>
                  <th className="text-left text-xs font-medium text-txt-3 px-4 py-3">Thay thế</th>
                  <th className="text-left text-xs font-medium text-txt-3 px-4 py-3">Mức độ</th>
                </tr>
              </thead>
              <tbody>
                {FORBIDDEN_TERMS.map((item) => (
                  <tr key={item.term} className="border-b border-border last:border-0">
                    <td className="px-4 py-3">
                      <code className="text-sm text-danger bg-danger/10 px-2 py-0.5 rounded">{item.term}</code>
                    </td>
                    <td className="px-4 py-3">
                      {item.replacement ? (
                        <code className="text-sm text-success bg-success/10 px-2 py-0.5 rounded">{item.replacement}</code>
                      ) : (
                        <span className="text-xs text-txt-3">Xóa hoàn toàn</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-medium ${item.severity === 'critical' ? 'text-danger' : 'text-amber-700 dark:text-amber-400'}`}>
                        {item.severity === 'critical' ? 'Nghiêm trọng' : 'Cao'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Terminology */}
      {activeCategory === 'terminology' && (
        <div className="space-y-3">
          <p className="text-sm text-txt-2">
            Bảng chuyển đổi thuật ngữ Anh-Việt. Tất cả nội dung phải sử dụng tiếng Việt thuần túy.
          </p>
          <div className="card overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-glass-bg">
                  <th className="text-left text-xs font-medium text-txt-3 px-4 py-3">English</th>
                  <th className="text-left text-xs font-medium text-txt-3 px-4 py-3">Tiếng Việt</th>
                </tr>
              </thead>
              <tbody>
                {TERM_CONVERSIONS.filter(
                  (t) => !searchQuery || t.en.includes(searchQuery.toLowerCase()) || t.vi.includes(searchQuery.toLowerCase()),
                ).map((item) => (
                  <tr key={item.en} className="border-b border-border last:border-0">
                    <td className="px-4 py-3">
                      <code className="text-sm text-amber-700 dark:text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded">{item.en}</code>
                    </td>
                    <td className="px-4 py-3">
                      <code className="text-sm text-success bg-success/10 px-2 py-0.5 rounded">{item.vi}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Structure */}
      {activeCategory === 'structure' && (
        <div className="g2">
          <div className="card p-4">
            <h3 className="font-heading text-md font-semibold text-gold mb-3">Cấu Trúc LATC</h3>
            <p className="text-xxs text-txt-3 mb-3">4.000-5.500 từ, 20-35 phút</p>
            <div className="space-y-2">
              {[
                { name: 'HOOK', words: '500 từ', pct: '10%', color: 'bg-gold' },
                { name: 'PHẦN 1-5', words: '600-800 từ/phần', pct: '70%', color: 'bg-purple' },
                { name: 'CTA KHÓA HỌC', words: '~400 từ', pct: '10%', color: 'bg-blue' },
                { name: 'CLOSING', words: '200 từ', pct: '5%', color: 'bg-emerald' },
              ].map((s) => (
                <div key={s.name} className="flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full ${s.color}`} />
                  <span className="text-xs text-txt-2 flex-1">{s.name}</span>
                  <span className="text-xxs text-txt-3">{s.words}</span>
                  <span className="text-xxs text-txt-3 w-8 text-right">{s.pct}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="card p-4">
            <h3 className="font-heading text-md font-semibold text-purple mb-3">Cấu Trúc TMT</h3>
            <p className="text-xxs text-txt-3 mb-3">4.500-5.500 từ, 30-40 phút</p>
            <div className="space-y-2">
              {[
                { name: 'INTRO', words: '300-400 từ', color: 'bg-gold' },
                { name: 'TỔNG QUAN', words: '400-500 từ', color: 'bg-purple' },
                { name: 'MAIN x4', words: '500-700 từ/phần', color: 'bg-blue' },
                { name: 'CLIMAX', words: '700-900 từ', color: 'bg-danger' },
                { name: 'CLOSING', words: '500-600 từ', color: 'bg-emerald' },
                { name: 'CTA 4 lớp', words: '200-250 từ', color: 'bg-cyan' },
              ].map((s) => (
                <div key={s.name} className="flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full ${s.color}`} />
                  <span className="text-xs text-txt-2 flex-1">{s.name}</span>
                  <span className="text-xxs text-txt-3">{s.words}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Tone */}
      {activeCategory === 'tone' && (
        <div className="space-y-4">
          <div className="g2">
            <div className="card p-4 border-l-[3px] border-l-purple">
              <h3 className="font-heading text-md font-semibold text-purple mb-2">MODE 1: Trầm - Tĩnh - Thủ Thỉ</h3>
              <p className="text-xs text-txt-2 mb-3">Sang, Thấm, Sâu — Giọng của người dẫn đường trầm tĩnh.</p>
              <div className="space-y-1 text-xs text-txt-3">
                <p>Phù hợp: LATC, Wellness content, Healing</p>
                <p>Personas: mentor, storyteller, confidante</p>
              </div>
            </div>
            <div className="card p-4 border-l-[3px] border-l-gold">
              <h3 className="font-heading text-md font-semibold text-gold mb-2">MODE 2: Đanh - Thép - Provocative</h3>
              <p className="text-xs text-txt-2 mb-3">Brutal Honesty — Pattern-interrupt, thách thức tư duy.</p>
              <div className="space-y-1 text-xs text-txt-3">
                <p>Phù hợp: TMT Drama, Short Clips</p>
                <p>Personas: provocateur, analyst</p>
              </div>
            </div>
          </div>
          <div className="card p-4 border-l-[3px] border-l-cyan">
            <h3 className="font-heading text-md font-semibold text-cyan mb-2">USP Cốt Lõi</h3>
            <blockquote className="text-sm text-txt-2 italic leading-relaxed border-l-2 border-cyan/30 pl-3">
              &ldquo;Jennie không chỉ giải thích CHUYỆN GÌ xảy ra, mà còn giải mã TẦN SỐ và NGHIỆP LỰC
              đằng sau — để bạn không chỉ HIỂU, mà còn KHÔNG LẶP LẠI sai lầm đó.&rdquo;
            </blockquote>
          </div>
        </div>
      )}

      {/* DB Rules */}
      {isLoading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={24} className="animate-spin text-txt-3" />
        </div>
      )}
      {dbRules && dbRules.length > 0 && (
        <section>
          <h2 className="font-heading text-lg font-semibold text-txt mb-3 flex items-center gap-2">
            <BookOpen size={18} className="text-gold" />
            Quy Tắc Từ Cơ Sở Dữ Liệu ({dbRules.length})
          </h2>
          <div className="space-y-2">
            {dbRules.slice(0, 10).map((rule) => (
              <div key={rule.id} className="card p-3 flex items-center gap-3">
                <div className={`w-2 h-2 rounded-full ${
                  rule.rule_type === 'forbidden' ? 'bg-danger' :
                  rule.rule_type === 'required' ? 'bg-success' :
                  'bg-amber-400'
                }`} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-txt font-medium truncate">{rule.name}</p>
                  <p className="text-xxs text-txt-3 truncate">{rule.description}</p>
                </div>
                <span className="text-xxs text-txt-3">{rule.category}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
