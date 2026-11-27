// Global Registry Search — unified search across all 15 registries + SOPs
// + pipelines + agents + crons. Press ⌘K or Ctrl+K to open. Debounced 250ms.
// Groups results by entity type. Click row to copy disk_path or navigate.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, Copy, ExternalLink } from 'lucide-react';
import { useToast } from '@/context/ToastContext';
import { copyToClipboard } from '@/lib/clipboard';

interface SearchResult {
  entity: string;
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  disk_path: string | null;
  raw: any;
}

interface SearchResponse {
  query: string;
  results: SearchResult[];
  counts: Record<string, number>;
}

const ENTITY_LABELS: Record<string, { emoji: string; label: string }> = {
  mcp: { emoji: '🖥️', label: 'MCP Servers' },
  commands: { emoji: '📟', label: 'Commands' },
  hooks: { emoji: '⚡', label: 'Hooks' },
  plugins: { emoji: '🧩', label: 'Plugins' },
  skills: { emoji: '🔧', label: 'Skills' },
  scripts: { emoji: '📜', label: 'Scripts' },
  subagents: { emoji: '🤖', label: 'Subagents' },
  reference_docs: { emoji: '📖', label: 'Rules/Docs' },
  edge_functions: { emoji: '☁️', label: 'Edge Functions' },
  memory_files: { emoji: '📁', label: 'Memory Files' },
  dropdown_options: { emoji: '📋', label: 'Dropdown Options' },
  sops: { emoji: '🗂', label: 'SOPs' },
  pipelines: { emoji: '🔗', label: 'Pipelines' },
  agents: { emoji: '🧠', label: 'Agents' },
  crons: { emoji: '⏰', label: 'Crons' },
};

export function GlobalRegistrySearch({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { pushToast } = useToast();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number | null>(null);

  // Focus input when modal opens
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQuery('');
      setResults([]);
    }
  }, [open]);

  // Debounced search
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    setLoading(true);
    debounceRef.current = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/registry/search?q=${encodeURIComponent(query)}&limit=100`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: SearchResponse = await res.json();
        setResults(data.results || []);
        setCounts(data.counts || {});
      } catch (err: any) {
        pushToast({ title: 'Search failed', body: err.message, tone: 'error' });
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [query, open, pushToast]);

  const grouped = useMemo(() => {
    const groups: Record<string, SearchResult[]> = {};
    for (const r of results) {
      if (!groups[r.entity]) groups[r.entity] = [];
      groups[r.entity].push(r);
    }
    return groups;
  }, [results]);

  const totalCount = Object.values(counts).reduce((a, b) => a + b, 0);

  const copyDiskPath = (path: string) => {
    void copyToClipboard(path).then((ok) => {
      pushToast(
        ok
          ? { title: '📋 Copied', body: path, tone: 'success' }
          : { title: 'Không thể sao chép', body: 'Trình duyệt chặn quyền truy cập clipboard.', tone: 'error' },
      );
    });
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-start justify-center p-4 pt-[10vh]"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-lg shadow-xl w-full max-w-3xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="p-3 border-b border-border flex items-center gap-2">
          <Search className="size-5 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Tìm kiếm trong 15+ registries... (tên, mô tả, nội dung)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && onClose()}
            className="flex-1 bg-transparent border-0 outline-0 text-base text-foreground placeholder:text-muted-foreground"
          />
          {loading && (
            <div className="size-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          )}
          <button
            onClick={onClose}
            className="p-1 hover:bg-muted rounded"
            title="Đóng (Esc)"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto">
          {query.trim().length < 2 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              Nhập ít nhất 2 ký tự để tìm kiếm. Search sẽ quét tên, mô tả, preview, path trong tất cả 15 registries (MCP, Commands, Hooks, Plugins, Skills, Scripts, Subagents, Rules/Docs, Edge Fns, Memory, Dropdowns) + SOPs + Pipelines + Agents + Crons.
            </div>
          ) : results.length === 0 && !loading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              Không tìm thấy kết quả cho "{query}"
            </div>
          ) : (
            <>
              {totalCount > 0 && (
                <div className="sticky top-0 bg-card border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">{totalCount}</span> kết quả từ{' '}
                  {Object.entries(counts).filter(([, c]) => c > 0).length} registries
                </div>
              )}
              {Object.entries(grouped).map(([entity, rows]) => {
                const meta = ENTITY_LABELS[entity] || { emoji: '📦', label: entity };
                return (
                  <div key={entity} className="border-b border-border/50">
                    <div className="px-3 py-1.5 bg-muted/30 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide sticky top-[29px]">
                      {meta.emoji} {meta.label} ({rows.length})
                    </div>
                    {rows.map((r) => (
                      <div
                        key={`${entity}-${r.id}`}
                        className="px-3 py-2 hover:bg-muted/40 border-b border-border/30 flex items-start gap-2 group"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-foreground truncate">{r.name || r.id}</div>
                          {r.description && (
                            <div className="text-xs text-muted-foreground line-clamp-2">{r.description}</div>
                          )}
                          <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-foreground/70 font-mono">
                            {r.category && <span className="px-1 py-0 bg-muted rounded">{r.category}</span>}
                            {r.disk_path && <span className="truncate">{r.disk_path}</span>}
                          </div>
                        </div>
                        {r.disk_path && (
                          <button
                            onClick={() => copyDiskPath(r.disk_path!)}
                            className="opacity-0 group-hover:opacity-100 p-1 hover:bg-muted rounded shrink-0 text-muted-foreground hover:text-foreground"
                            title="Copy path"
                          >
                            <Copy className="size-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })}
            </>
          )}
        </div>

        {/* Footer hint */}
        <div className="px-3 py-2 border-t border-border text-[10px] text-muted-foreground flex items-center justify-between">
          <span>
            <kbd className="px-1 py-0.5 bg-muted rounded font-mono">Esc</kbd> để đóng
          </span>
          <span>
            Search ILIKE trên name/description/preview của 15 registries + SOPs/pipelines/agents/crons
          </span>
        </div>
      </div>
    </div>
  );
}

// Hook to manage keyboard shortcut (Cmd/Ctrl+K)
export function useGlobalSearchShortcut(onOpen: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        onOpen();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onOpen]);
}
