/**
 * ContentMetaShared — Shared components cho metadata editing
 * Dùng chung: ContentTab, CCScriptDetail, CCAIGen results tab
 *
 * Exports:
 *   - SlugUrlHandle : Hiển thị URL handle tự động từ slug
 *   - MetaSelect    : Dropdown với inline add + localStorage persistence
 */
import { useState, useMemo } from 'react';
import { copyToClipboard } from '@/lib/clipboard';

// ─── Constants ───────────────────────────────────────────────────
// ─── URL Patterns theo content type ──────────────────────────────
// Blog: https://www.gemral.com/blog/post/{slug}
// Forum: https://gemral.com/forum/thread/{id}
// Social/default: https://www.gemral.com/blog/post/{slug}
const URL_PATTERNS = {
  blog: 'https://www.gemral.com/blog/post',
  blog_post: 'https://www.gemral.com/blog/post',
  newsletter: 'https://www.gemral.com/blog/post',
  forum: 'https://gemral.com/forum/thread',
  thread: 'https://gemral.com/forum/thread',
};
const DEFAULT_BASE = 'https://www.gemral.com/blog/post';

// ─── SlugUrlHandle ────────────────────────────────────────────────
/**
 * Auto-derives a clean URL handle from a slug, shows full URL + copy button.
 *
 * Props:
 *   slug        — string: the raw slug value from the script/content record
 *   contentType — string (optional): 'blog'|'forum'|'newsletter' etc. để chọn đúng URL pattern
 *   baseUrl     — string (optional): override toàn bộ base URL
 */
export function generateSlug(text) {
  return (text || '').trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove accents
    .replace(/đ/g, "d").replace(/Đ/g, "d") // fix vietnamese d
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function SlugUrlHandle({ slug, contentType, baseUrl = null }) {
  const [copied, setCopied] = useState(false);

  const urlHandle = generateSlug(slug || '');

  // Chọn base URL theo content type
  const base = baseUrl || (contentType ? URL_PATTERNS[contentType] : null) || DEFAULT_BASE;
  const fullUrl = `${base}/${urlHandle}`;

  const copy = () => {
    void copyToClipboard(fullUrl).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  if (!urlHandle) return null;

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-[11px]">
      <span className="shrink-0 text-muted-foreground font-medium">URL handle:</span>
      <span className="font-mono text-primary/80 flex-1 min-w-0 truncate">{urlHandle}</span>
      <span className="text-muted-foreground/40 shrink-0">→</span>
      <a
        href={fullUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-blue-500 hover:text-blue-600 hover:underline flex-[2] min-w-0 truncate"
        title={fullUrl}
      >
        {fullUrl}
      </a>
      <button
        onClick={copy}
        title="Copy URL"
        className="shrink-0 px-2 py-0.5 rounded border border-border/50 hover:bg-accent transition-colors text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1"
      >
        {copied ? '✓ Copied' : '⎘ Copy'}
      </button>
    </div>
  );
}

// ─── MetaSelect ───────────────────────────────────────────────────
/**
 * Dropdown với:
 *   - Static options list
 *   - Inline add new value
 *   - Custom values persisted to localStorage per storageKey
 *   - Immediate DB sync via onCommit
 *
 * Props:
 *   value       — string: current value
 *   options     — string[]: static option list
 *   onCommit    — (value: string) => void | Promise<void>: called on change/add
 *   allowCustom — boolean: show ＋ button even without storageKey (default false)
 *   storageKey  — string: localStorage key suffix for custom options persistence
 *   placeholder — string: placeholder text (default '— chọn —')
 *   className   — string: extra classes for the select element
 */
export function MetaSelect({
  value,
  /** @type {string[]} */ options = [],
  onCommit,
  allowCustom = false,
  storageKey,
  placeholder = '— chọn —',
  className = '',
}) {
  // Merge static options with user-added custom options (persisted to localStorage)
  const [customOptions, setCustomOptions] = useState(() => {
    if (!storageKey) return [];
    try {
      return JSON.parse(localStorage.getItem(`metaSelect.${storageKey}`) || '[]');
    } catch {
      return [];
    }
  });

  const [adding, setAdding] = useState(false);
  const [newVal, setNewVal] = useState('');

  const allOptions = useMemo(() => {
    const merged = [...options];
    for (const c of customOptions) {
      if (!merged.includes(c)) merged.push(c);
    }
    return merged;
  }, [options, customOptions]);

  const addCustom = () => {
    const v = newVal.trim();
    if (!v) {
      setAdding(false);
      return;
    }
    const updated = customOptions.includes(v) ? customOptions : [...customOptions, v];
    setCustomOptions(updated);
    if (storageKey) {
      localStorage.setItem(`metaSelect.${storageKey}`, JSON.stringify(updated));
    }
    onCommit(v);
    setAdding(false);
    setNewVal('');
  };

  // Adding mode — show inline input
  if (adding) {
    return (
      <div className="flex gap-1">
        <input
          autoFocus
          value={newVal}
          onChange={e => setNewVal(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') addCustom();
            if (e.key === 'Escape') { setAdding(false); setNewVal(''); }
          }}
          placeholder="Giá trị mới..."
          className="flex-1 text-[11px] px-2 py-1 border rounded-l bg-white focus:outline-none focus:ring-1 focus:ring-primary/30"
        />
        <button
          onClick={addCustom}
          className="px-2 py-1 bg-primary text-primary-foreground text-[10px] rounded-r hover:bg-primary/90"
        >
          ✓
        </button>
        <button
          onClick={() => { setAdding(false); setNewVal(''); }}
          className="px-1.5 py-1 border rounded text-[10px] hover:bg-muted"
        >
          ✕
        </button>
      </div>
    );
  }

  // Normal select mode
  return (
    <div className="flex gap-1">
      <select
        value={allOptions.includes(value) ? value : (allowCustom || customOptions.length > 0 ? (value || '') : '')}
        onChange={e => onCommit(e.target.value)}
        className={`flex-1 text-[11px] px-2 py-1 border rounded-l bg-white focus:outline-none focus:ring-1 focus:ring-primary/30 ${className}`}
      >
        <option value="">{placeholder}</option>
        {!allOptions.includes(value) && value && (
          <option value={value}>{value}</option>
        )}
        {allOptions.map(o => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
      <button
        onClick={() => setAdding(true)}
        title="Thêm giá trị mới"
        className="px-2 py-1 border border-l-0 rounded-r text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
      >
        ＋
      </button>
    </div>
  );
}

export default { SlugUrlHandle, MetaSelect, generateSlug };
