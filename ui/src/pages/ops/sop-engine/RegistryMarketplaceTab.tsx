// Registry Marketplace Tab — 8 sub-tabs central SSOT for:
//   • Agents       (live from paperclip_agents)
//   • Skills       (company_skills + GitHub import)
//   • Plugins      (plugin_registry + GitHub import)
//   • MCP Servers  (mcp_servers + Claude catalog import)
//   • Commands     (slash_commands + GitHub import)
//   • Hooks        (agent_hooks + manual add)
//   • Channels     (merged from ConfigHub - channel_instances)
//   • System       (merged from ConfigHub + cron_registry embed)
//
// Phase 3 scope: merge scattered config pages into 1 hub. User requested
// "tất cả đều có thể import trực tiếp từ GitHub repo hay plugin MCP chính
// thức từ Claude Code".

import { useState, useCallback, useMemo } from 'react';
import { SortableTabBar } from '@/components/SortableTabBar';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useToast } from '@/context/ToastContext';
import {
  Bot,
  Wrench,
  Puzzle,
  Server,
  Terminal,
  Zap,
  Radio,
  Cog,
  Github,
  Plus,
  Copy,
  Trash2,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  AlertCircle,
  ExternalLink,
  RefreshCw,
  HardDrive,
  FileCode,
  Bot as BotIcon,
  BookOpen,
  FileText,
  CloudCog,
  FolderOpen,
  GraduationCap,
  CalendarDays,
  Mail,
  ShoppingBag,
  Eye,
  Play,
  FlaskConical,
  Pencil,
  Pause,
  Power,
  PowerOff,
  ChevronRight,
} from 'lucide-react';
import { useNavigate } from '@/lib/router';
import { AgentListPage } from '@/pages/agents/AgentListPage';
import { ChannelsOverview } from '@/pages/channels/ChannelsOverview';
import { EntityDetailDrawer } from './EntityDetailDrawer';

// ─── Types ────────────────────────────────────────────────────────────────

type SubTab =
  | 'agents' | 'skills' | 'plugins' | 'mcp' | 'commands' | 'hooks'
  | 'scripts' | 'subagents' | 'rules' | 'docs' | 'edge_functions' | 'memory_files'
  | 'training' | 'calendar' | 'email' | 'shopify'
  | 'channels' | 'system';

interface SubTabDef {
  id: SubTab;
  label: string;
  icon: any;
  tooltip: string;
}

const SUB_TABS: SubTabDef[] = [
  { id: 'agents',         label: 'Cấu hình Agent LLM', icon: Bot,       tooltip: 'Cấu hình đầy đủ 27 agents: provider, model, temperature, system prompt, test chat, toggle enable/disable. Full editor (không phải read-only).' },
  { id: 'skills',         label: 'Skills',         icon: Wrench,        tooltip: 'Claude Code skills (125) — ~/.claude/skills/ + skills-store/ project root.' },
  { id: 'plugins',        label: 'Plugins',        icon: Puzzle,        tooltip: 'Claude Code plugins (83) từ installed_plugins.json + marketplaces.' },
  { id: 'mcp',            label: 'MCP',            icon: Server,        tooltip: 'MCP server endpoints (28). Import từ Claude catalog hoặc GitHub.' },
  { id: 'commands',       label: 'Commands',       icon: Terminal,      tooltip: 'Slash commands (76). ~/.claude/commands/*.md.' },
  { id: 'hooks',          label: 'Hooks',          icon: Zap,           tooltip: 'Agent lifecycle hooks (16). PreToolUse, PostToolUse, Stop, SessionStart, PreCompact.' },
  { id: 'scripts',        label: 'Scripts',        icon: FileCode,      tooltip: 'Scripts (175) — .py/.bat/.sh/.ps1/.mjs/.js từ crypto-pattern-scanner + paperclip + Desktop loose.' },
  { id: 'subagents',      label: 'Subagents',      icon: BotIcon,       tooltip: 'Claude Code subagents (42) — ~/.claude/agents/*.md. architect, code-reviewer, tdd-guide...' },
  { id: 'rules',          label: 'Rules',          icon: BookOpen,      tooltip: 'Rules (92) — ~/.claude/rules/ auto-inject (behaviors, skill-triggers, memory-flush) + common/web/python.' },
  { id: 'docs',           label: 'Docs',           icon: FileText,      tooltip: 'Reference docs (6) — ~/.claude/docs/ (task-routing, content-safety...).' },
  { id: 'edge_functions', label: 'Edge Fns',       icon: CloudCog,      tooltip: 'Supabase Edge Functions (68) — supabase/functions/* với verify_jwt + category tự detect.' },
  { id: 'memory_files',   label: 'Memory Files',   icon: FolderOpen,    tooltip: 'Memory files (413) — today.md, patterns.md, reports/, decisions/, sops/, agents/*/daily. Browse + search.' },
  { id: 'training',       label: 'Training',       icon: GraduationCap, tooltip: 'Training enrollments — agent training progress và spaced repetition lessons.' },
  { id: 'calendar',       label: 'Content Cal',    icon: CalendarDays,  tooltip: 'Content calendar — cc_calendar_events. Lịch post sắp tới theo schedule.' },
  { id: 'email',          label: 'Email Camp',     icon: Mail,          tooltip: 'Email campaigns — cc_email_campaigns + cc_email_sends. Active + scheduled.' },
  { id: 'shopify',        label: 'Shopify',        icon: ShoppingBag,   tooltip: 'Shopify products (73) SSOT pricing catalog + variants + orders.' },
  { id: 'channels',       label: 'Channels',       icon: Radio,         tooltip: 'Kênh chat (Zalo, Facebook, Email, Push). Merge từ /GEM/config cũ.' },
  { id: 'system',         label: 'System',         icon: Cog,           tooltip: 'System dashboard: full stats (15 registries), Cron Registry, PM2, database.' },
];

function Tip({ children, text }: { children: React.ReactNode; text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="max-w-xs">{text}</TooltipContent>
    </Tooltip>
  );
}

// ─── API fetchers ────────────────────────────────────────────────────────

async function fetchJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(path);
    if (!res.ok) return fallback;
    return res.json();
  } catch {
    return fallback;
  }
}

async function deleteItem(path: string): Promise<void> {
  const res = await fetch(path, { method: 'DELETE' });
  if (!res.ok) throw new Error((await res.json()).error || 'Delete failed');
}

async function toggleEnabled(path: string, enabled: boolean): Promise<void> {
  const res = await fetch(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw new Error((await res.json()).error || 'Toggle failed');
}

// ─── Generic list view (used by most sub-tabs) ────────────────────────────
//
// IMPORTANT (Phase 9 / R-1 no-readonly rule, 2026-04-10):
// Every row MUST be interactive. The default Copy + Delete buttons are not
// enough — sub-tabs MUST pass `rowActions` (Run/Test/Edit/ViewOnDisk/Navigate)
// AND `onRowClick` (opens EntityDetailDrawer with metadata + file preview +
// inline edit). Pure list+toggle+delete violates Jennie's rule and was the
// reason 12 sub-tabs were rejected in S9 audit.

import type { LucideIcon } from 'lucide-react';

export type RowAction = {
  icon: LucideIcon;
  label: string;
  tone?: 'default' | 'primary' | 'destructive';
  show?: (row: any) => boolean;
  onClick: (row: any) => void | Promise<void>;
};

function GenericListView({
  title,
  fetchPath,
  entityPath,
  idField,
  columns,
  onImport,
  importHint,
  queryKey,
  rowActions,
  onRowClick,
}: {
  title: string;
  fetchPath: string;
  entityPath: string; // e.g. '/api/registry/mcp'
  idField?: string;
  columns: Array<{ header: string; field: string; width?: string }>;
  onImport?: () => void;
  importHint?: string;
  queryKey: string;
  rowActions?: RowAction[];
  onRowClick?: (row: any) => void;
}) {
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const idKey = idField || 'id';

  const query = useQuery({
    queryKey: ['registry', queryKey],
    queryFn: () => fetchJson<any[]>(fetchPath, []),
    refetchInterval: 15_000,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteItem(`${entityPath}/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['registry', queryKey] });
      pushToast({ title: '🗑️ Đã xóa', tone: 'success' });
    },
    onError: (err: Error) => pushToast({ title: 'Xóa thất bại', body: err.message, tone: 'error' }),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      toggleEnabled(`${entityPath}/${id}`, enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['registry', queryKey] }),
  });

  const items = query.data || [];

  const handleCopy = async (item: any) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(item, null, 2));
      pushToast({ title: '📋 Đã copy JSON', tone: 'success' });
    } catch {
      pushToast({ title: 'Copy thất bại', tone: 'error' });
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <span className="text-[11px] text-muted-foreground">
            {query.isLoading ? 'Đang tải...' : `${items.length} items`}
          </span>
          {query.isLoading && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
        </div>
        {onImport && (
          <Tip text={importHint || 'Import từ GitHub repo (public only)'}>
            <button
              onClick={onImport}
              className="px-3 py-1.5 text-xs bg-primary/10 border border-primary text-primary rounded-md hover:bg-primary/20 flex items-center gap-1.5"
            >
              <Github className="size-3.5" />
              Import GitHub
            </button>
          </Tip>
        )}
      </div>

      {items.length === 0 ? (
        <div className="p-8 text-center text-xs text-muted-foreground border border-dashed border-border rounded-lg">
          Chưa có item nào. {onImport && 'Bấm "Import GitHub" để thêm.'}
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                {columns.map((c) => (
                  <th key={c.field} className="text-left px-3 py-2 font-semibold" style={{ width: c.width }}>
                    {c.header}
                  </th>
                ))}
                <th className="text-right px-3 py-2 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item[idKey]}
                  className={`border-t border-border hover:bg-accent/30 transition-colors ${
                    onRowClick ? 'cursor-pointer' : ''
                  }`}
                  onClick={() => onRowClick?.(item)}
                >
                  {columns.map((c) => (
                    <td key={c.field} className="px-3 py-2 text-foreground" onClick={(e) => {
                      // toggle/link cells handle their own click; stop bubble to row drawer
                      if (c.field === 'enabled' || (c.field === 'source_locator' && item[c.field]?.startsWith('http'))) {
                        e.stopPropagation();
                      }
                    }}>
                      {c.field === 'enabled' ? (
                        <Tip text={item[c.field] ? 'Click để tắt' : 'Click để bật'}>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleMutation.mutate({ id: item[idKey], enabled: !item[c.field] });
                            }}
                          >
                            {item[c.field] ? (
                              <CheckCircle2 className="size-4 text-green-500" />
                            ) : (
                              <XCircle className="size-4 text-muted-foreground" />
                            )}
                          </button>
                        </Tip>
                      ) : c.field === 'source_locator' && item[c.field]?.startsWith('http') ? (
                        <a
                          href={item[c.field]}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 text-primary hover:underline font-mono text-[10px]"
                        >
                          {item[c.field].replace('https://github.com/', '')}
                          <ExternalLink className="size-3" />
                        </a>
                      ) : c.field === 'trust_level' ? (
                        <span
                          className={`px-1.5 py-0.5 text-[10px] rounded uppercase font-semibold ${
                            item[c.field] === 'official'
                              ? 'bg-green-500/20 text-green-700 dark:text-green-400'
                              : item[c.field] === 'verified'
                                ? 'bg-blue-500/20 text-blue-700 dark:text-blue-400'
                                : item[c.field] === 'community'
                                  ? 'bg-amber-500/20 text-amber-700 dark:text-amber-400'
                                  : 'bg-muted text-muted-foreground'
                          }`}
                        >
                          {item[c.field] || 'unknown'}
                        </span>
                      ) : (
                        <span className="truncate max-w-xs block">{
                          c.field.endsWith('_at') && item[c.field]
                            ? new Date(item[c.field]).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
                            : (item[c.field] ?? '—')
                        }</span>
                      )}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1">
                      {/* Custom row actions (Run/Test/Edit/ViewOnDisk/Navigate) — Phase 9 */}
                      {rowActions?.filter((a) => !a.show || a.show(item)).map((action, i) => {
                        const Icon = action.icon;
                        const toneClass =
                          action.tone === 'destructive'
                            ? 'text-muted-foreground hover:text-destructive'
                            : action.tone === 'primary'
                              ? 'text-primary hover:text-primary/80'
                              : 'text-muted-foreground hover:text-foreground';
                        return (
                          <Tip key={i} text={action.label}>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                action.onClick(item);
                              }}
                              className={`p-1 ${toneClass}`}
                            >
                              <Icon className="size-3.5" />
                            </button>
                          </Tip>
                        );
                      })}
                      <Tip text="Copy JSON vào clipboard">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCopy(item);
                          }}
                          className="p-1 text-muted-foreground hover:text-foreground"
                        >
                          <Copy className="size-3.5" />
                        </button>
                      </Tip>
                      <Tip text="Xóa item (cả DB và disk nếu có)">
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (await confirm({ title: `Xóa ${item.name || item[idKey]}?`, confirmLabel: "Xóa", destructive: true })) {
                              deleteMutation.mutate(item[idKey]);
                            }
                          }}
                          className="p-1 text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </Tip>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── ListWithDrawer wrapper — combines GenericListView + EntityDetailDrawer ──
//
// Phase 9: every sub-tab uses this wrapper instead of bare GenericListView so
// rows are clickable + actions show in both row + drawer footer. Eliminates
// the read-only anti-pattern across the entire Registry Marketplace.

function ListWithDrawer({
  rowActions,
  drawerActions,
  ...listProps
}: React.ComponentProps<typeof GenericListView> & {
  drawerActions?: RowAction[];
}) {
  const [selected, setSelected] = useState<any | null>(null);
  // Wire Eye icon actions to open drawer. Sub-tabs pass onClick: () => {} as
  // placeholder for "open detail" — ListWithDrawer replaces with drawer opener.
  // Detection: Eye icon actions always have icon === Eye (imported from lucide).
  const wiredActions = rowActions?.map((a) =>
    a.icon === Eye
      ? { ...a, onClick: (row: any) => setSelected(row) }
      : a
  );
  return (
    <>
      <GenericListView
        {...listProps}
        rowActions={wiredActions}
        onRowClick={(row) => setSelected(row)}
      />
      <EntityDetailDrawer
        open={!!selected}
        onClose={() => setSelected(null)}
        entity={selected}
        entityPath={listProps.entityPath}
        idField={listProps.idField}
        queryKey={listProps.queryKey}
        actions={drawerActions || rowActions}
      />
    </>
  );
}

// Copy disk path to clipboard. Browser cannot open OS file explorer directly.
function openFileInBrowser(diskPath: string, pushToast?: any) {
  if (!diskPath) {
    pushToast?.({ title: 'Item này không có disk_path', tone: 'error' });
    return;
  }
  navigator.clipboard.writeText(diskPath)
    .then(() => pushToast?.({ title: '📋 Đã copy path', body: diskPath, tone: 'success' }))
    .catch(() => pushToast?.({ title: 'Copy thất bại', tone: 'error' }));
}

// ─── GitHub Import Dialog ─────────────────────────────────────────────────

function GithubImportDialog({
  open,
  onClose,
  entity,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  entity: string;
  onSuccess: () => void;
}) {
  const { pushToast } = useToast();
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);

  if (!open) return null;

  const handleImport = async () => {
    if (!url.trim() || !url.includes('github.com/')) {
      pushToast({ title: 'URL không hợp lệ', body: 'Phải là https://github.com/owner/repo', tone: 'error' });
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/registry/import/github', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity, url: url.trim(), name: name.trim() || undefined }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const result = await res.json();
      pushToast({
        title: '✅ Import thành công',
        body: `${result.entity}: ${result.name}`,
        tone: 'success',
      });
      onSuccess();
      onClose();
      setUrl('');
      setName('');
    } catch (err: any) {
      pushToast({ title: 'Import thất bại', body: err.message, tone: 'error' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-background border border-border rounded-xl shadow-2xl w-full max-w-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
            <Github className="size-4" />
            Import từ GitHub — {entity}
          </h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1">
            ✕
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="text-xs font-semibold text-muted-foreground uppercase">
              GitHub URL <span className="text-destructive">*</span>
            </label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/owner/repo"
              className="mt-1 w-full px-3 py-2 bg-background border border-input rounded text-sm text-foreground focus:border-ring outline-none"
              autoFocus
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              Chỉ support public repos. Clone shallow (--depth 1) để nhanh + tiết kiệm disk.
            </p>
          </div>
          <div>
            <label className="text-xs font-semibold text-muted-foreground uppercase">Custom name (optional)</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Override tên tự detect"
              className="mt-1 w-full px-3 py-2 bg-background border border-input rounded text-sm text-foreground focus:border-ring outline-none"
            />
          </div>
          <div className="text-[10px] text-muted-foreground border border-border rounded p-2 bg-muted/30">
            ℹ️ Safety: 60s timeout, spawnHidden (không orphan cmd.exe), auto-detect entity type
            từ file structure (SKILL.md / .mcp.json / package.json / commands-*). Sau khi import,
            file nằm ở <code className="font-mono">~/.claude/{'{skills|mcp-configs|plugins|...}'}/name/</code>.
          </div>
        </div>
        <div className="p-4 border-t border-border flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-1.5 text-sm text-muted-foreground hover:text-foreground">
            Hủy
          </button>
          <button
            onClick={handleImport}
            disabled={loading || !url.trim()}
            className="px-4 py-1.5 text-sm bg-primary hover:bg-primary/90 text-primary-foreground rounded font-medium disabled:opacity-50 flex items-center gap-2"
          >
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Github className="size-3.5" />}
            {loading ? 'Đang clone...' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Sub-tab components ───────────────────────────────────────────────────

// Reuses the full Agent LLM config page (cards grid + Create/Edit/Test/Toggle/Delete).
// Do NOT replace with a read-only GenericListView — the full-featured page at
// /GEM/agents-config is the canonical editor; this tab just embeds it so Jennie
// can access the same editor from the Registry Marketplace hub.
function AgentsSubTab() {
  return <AgentListPage />;
}

function SkillsSubTab() {
  const [importOpen, setImportOpen] = useState(false);
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const rowActions: RowAction[] = [
    { icon: Eye, label: 'Mở chi tiết + xem SKILL.md', onClick: () => {} }, // drawer auto-opens via row click
    {
      icon: ExternalLink,
      label: 'Mở source GitHub',
      show: (r) => r.source_locator?.startsWith('http'),
      onClick: (r) => { window.open(r.source_locator, '_blank'); },
    },
    {
      icon: FolderOpen,
      label: 'Copy đường dẫn file',
      show: (r) => !!r.disk_path,
      onClick: (r) => openFileInBrowser(r.disk_path, pushToast),
    },
  ];
  return (
    <>
      <ListWithDrawer
        title="🔧 Skills"
        fetchPath="/api/registry/skills?limit=2000"
        entityPath="/api/registry/skills"
        queryKey="skills"
        onImport={() => setImportOpen(true)}
        importHint="Import skill từ GitHub repo (phải có SKILL.md)"
        columns={[
          { header: 'Name', field: 'name' },
          { header: 'Description', field: 'description' },
          { header: 'Source', field: 'source_locator' },
        ]}
        rowActions={rowActions}
      />
      <GithubImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        entity="skills"
        onSuccess={() => qc.invalidateQueries({ queryKey: ['registry', 'skills'] })}
      />
    </>
  );
}

function PluginsSubTab() {
  const [importOpen, setImportOpen] = useState(false);
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const rowActions: RowAction[] = [
    { icon: Eye, label: 'Mở chi tiết + manifest', onClick: () => {} },
    {
      icon: ExternalLink,
      label: 'Mở source repo',
      show: (r) => r.source_locator?.startsWith('http'),
      onClick: (r) => { window.open(r.source_locator, '_blank'); },
    },
    {
      icon: FolderOpen,
      label: 'Mở thư mục plugin',
      show: (r) => !!r.disk_path,
      onClick: (r) => openFileInBrowser(r.disk_path, pushToast),
    },
  ];
  return (
    <>
      <ListWithDrawer
        title="🧩 Plugins"
        fetchPath="/api/registry/plugins?limit=2000"
        entityPath="/api/registry/plugins"
        queryKey="plugins"
        onImport={() => setImportOpen(true)}
        importHint="Import Claude Code plugin từ GitHub (package.json / manifest.json)"
        columns={[
          { header: 'Name', field: 'name' },
          { header: 'Type', field: 'plugin_type', width: '120px' },
          { header: 'Version', field: 'version', width: '100px' },
          { header: 'Source', field: 'source_locator' },
          { header: 'Trust', field: 'trust_level', width: '100px' },
          { header: 'Enabled', field: 'enabled', width: '80px' },
        ]}
        rowActions={rowActions}
      />
      <GithubImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        entity="plugins"
        onSuccess={() => qc.invalidateQueries({ queryKey: ['registry', 'plugins'] })}
      />
    </>
  );
}

function MCPSubTab() {
  const [importOpen, setImportOpen] = useState(false);
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const testMcp = async (row: any) => {
    pushToast({ title: `🧪 Test MCP ${row.name}...`, tone: 'info' });
    try {
      const res = await fetch(`/api/registry/mcp/${row.id}/test`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const result = await res.json();
      pushToast({
        title: result.ok ? `✅ ${row.name} OK` : `❌ ${row.name} failed`,
        body: result.stdout?.slice(0, 100) || result.error || `exit ${result.exit_code}`,
        tone: result.ok ? 'success' : 'error',
      });
    } catch (err: any) {
      pushToast({ title: 'Test thất bại', body: err.message, tone: 'error' });
    }
  };
  const rowActions: RowAction[] = [
    { icon: Eye, label: 'Mở chi tiết + config_json', onClick: () => {} },
    { icon: FlaskConical, label: 'Test MCP server (probe --version)', tone: 'primary', onClick: testMcp },
    {
      icon: FolderOpen,
      label: 'Copy đường dẫn config',
      show: (r) => !!r.disk_path,
      onClick: (r) => openFileInBrowser(r.disk_path, pushToast),
    },
  ];
  return (
    <>
      <ListWithDrawer
        title="🖥️ MCP Servers"
        fetchPath="/api/registry/mcp?limit=2000"
        entityPath="/api/registry/mcp"
        queryKey="mcp"
        onImport={() => setImportOpen(true)}
        importHint="Import MCP server từ GitHub repo (phải có .mcp.json hoặc package.json với mcp field)"
        columns={[
          { header: 'Name', field: 'name' },
          { header: 'Description', field: 'description' },
          { header: 'Tools', field: 'tool_count', width: '80px' },
          { header: 'Source', field: 'source_locator' },
          { header: 'Trust', field: 'trust_level', width: '100px' },
          { header: 'Enabled', field: 'enabled', width: '80px' },
        ]}
        rowActions={rowActions}
      />
      <GithubImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        entity="mcp"
        onSuccess={() => qc.invalidateQueries({ queryKey: ['registry', 'mcp'] })}
      />
    </>
  );
}

function CommandsSubTab() {
  const [importOpen, setImportOpen] = useState(false);
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const rowActions: RowAction[] = [
    { icon: Eye, label: 'Mở chi tiết + preview command body', onClick: () => {} },
    {
      icon: FolderOpen,
      label: 'Mở file .md trên disk',
      show: (r) => !!r.disk_path,
      onClick: (r) => openFileInBrowser(r.disk_path, pushToast),
    },
  ];
  return (
    <>
      <ListWithDrawer
        title="📟 Slash Commands"
        fetchPath="/api/registry/commands?limit=2000"
        entityPath="/api/registry/commands"
        queryKey="commands"
        onImport={() => setImportOpen(true)}
        importHint="Import command bundle từ GitHub (phải có commands/ folder)"
        columns={[
          { header: 'Name', field: 'name' },
          { header: 'Scope', field: 'scope', width: '100px' },
          { header: 'Agent', field: 'agent_slug', width: '150px' },
          { header: 'Source', field: 'source_locator' },
          { header: 'Enabled', field: 'enabled', width: '80px' },
        ]}
        rowActions={rowActions}
      />
      <GithubImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        entity="commands"
        onSuccess={() => qc.invalidateQueries({ queryKey: ['registry', 'commands'] })}
      />
    </>
  );
}

function HooksSubTab() {
  const [importOpen, setImportOpen] = useState(false);
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const rowActions: RowAction[] = [
    { icon: Eye, label: 'Mở chi tiết hook', onClick: () => {} },
    {
      icon: FolderOpen,
      label: 'Mở script hook trên disk',
      show: (r) => !!r.disk_path,
      onClick: (r) => openFileInBrowser(r.disk_path, pushToast),
    },
  ];
  return (
    <>
      <ListWithDrawer
        title="⚡ Agent Hooks"
        fetchPath="/api/registry/hooks?limit=2000"
        entityPath="/api/registry/hooks"
        queryKey="hooks"
        onImport={() => setImportOpen(true)}
        importHint="Import hooks từ GitHub (settings.json với hooks field)"
        columns={[
          { header: 'Event', field: 'event', width: '140px' },
          { header: 'Matcher', field: 'matcher', width: '140px' },
          { header: 'Command', field: 'command' },
          { header: 'Scope', field: 'scope', width: '100px' },
          { header: 'Enabled', field: 'enabled', width: '80px' },
        ]}
        rowActions={rowActions}
      />
      <GithubImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        entity="hooks"
        onSuccess={() => qc.invalidateQueries({ queryKey: ['registry', 'hooks'] })}
      />
    </>
  );
}

function ScriptsSubTab() {
  const confirm = useConfirm();
  const [importOpen, setImportOpen] = useState(false);
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const runScript = async (row: any) => {
    if (!(await confirm({ title: `Chạy script "${row.name}" ngay bây giờ?`, body: `Path: ${row.disk_path || row.script_root + '/' + row.file_name}`, confirmLabel: "Chạy ngay" }))) return;
    pushToast({ title: `▶️ Running ${row.name}...`, tone: 'info' });
    try {
      const res = await fetch(`/api/registry/scripts/${row.id}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const result = await res.json();
      pushToast({
        title: result.ok ? `✅ ${row.name} done (exit ${result.exit_code})` : `❌ ${row.name} failed (exit ${result.exit_code})`,
        body: (result.stdout || result.stderr || '').slice(-200),
        tone: result.ok ? 'success' : 'error',
      });
      qc.invalidateQueries({ queryKey: ['registry', 'scripts'] });
    } catch (err: any) {
      pushToast({ title: 'Execute thất bại', body: err.message, tone: 'error' });
    }
  };
  const rowActions: RowAction[] = [
    { icon: Eye, label: 'Mở chi tiết + xem source', onClick: () => {} },
    { icon: Play, label: 'Chạy script ngay (spawnHidden, 120s timeout)', tone: 'primary', onClick: runScript },
    {
      icon: FolderOpen,
      label: 'Copy đường dẫn file',
      show: (r) => !!(r.disk_path || (r.script_root && r.file_name)),
      onClick: (r) => openFileInBrowser(r.disk_path || `${r.script_root}/${r.file_name}`, pushToast),
    },
  ];
  return (
    <>
      <ListWithDrawer
        title="📜 Scripts"
        fetchPath="/api/registry/scripts?limit=2000"
        entityPath="/api/registry/scripts"
        queryKey="scripts"
        onImport={() => setImportOpen(true)}
        importHint="Import script bundle từ GitHub repo"
        columns={[
          { header: 'Name', field: 'name' },
          { header: 'Language', field: 'language', width: '100px' },
          { header: 'Root', field: 'script_root', width: '180px' },
          { header: 'Description', field: 'description' },
          { header: 'Enabled', field: 'enabled', width: '80px' },
        ]}
        rowActions={rowActions}
      />
      <GithubImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        entity="scripts"
        onSuccess={() => qc.invalidateQueries({ queryKey: ['registry', 'scripts'] })}
      />
    </>
  );
}

function SubagentsSubTab() {
  const [importOpen, setImportOpen] = useState(false);
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const rowActions: RowAction[] = [
    { icon: Eye, label: 'Mở chi tiết + xem agent .md', onClick: () => {} },
    {
      icon: FlaskConical,
      label: 'Test trong Agent Test page',
      tone: 'primary',
      onClick: (r) => navigate(`/GEM/agents-config/${r.name}/test`),
    },
    {
      icon: FolderOpen,
      label: 'Copy đường dẫn file',
      show: (r) => !!r.disk_path,
      onClick: (r) => openFileInBrowser(r.disk_path, pushToast),
    },
  ];
  return (
    <>
      <ListWithDrawer
        title="🤖 Claude Subagents"
        fetchPath="/api/registry/subagents?limit=2000"
        entityPath="/api/registry/subagents"
        queryKey="subagents"
        onImport={() => setImportOpen(true)}
        importHint="Import subagent bundle từ GitHub"
        columns={[
          { header: 'Name', field: 'name' },
          { header: 'Description', field: 'description' },
          { header: 'Model', field: 'model', width: '140px' },
          { header: 'Category', field: 'category', width: '140px' },
          { header: 'Enabled', field: 'enabled', width: '80px' },
        ]}
        rowActions={rowActions}
      />
      <GithubImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        entity="subagents"
        onSuccess={() => qc.invalidateQueries({ queryKey: ['registry', 'subagents'] })}
      />
    </>
  );
}

function RulesSubTab() {
  const [importOpen, setImportOpen] = useState(false);
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const rowActions: RowAction[] = [
    { icon: Eye, label: 'Mở chi tiết + read full rule', onClick: () => {} },
    {
      icon: FolderOpen,
      label: 'Copy đường dẫn rule',
      show: (r) => !!r.disk_path,
      onClick: (r) => openFileInBrowser(r.disk_path, pushToast),
    },
  ];
  return (
    <>
      <ListWithDrawer
        title="📖 Rules — auto-inject behaviors"
        fetchPath="/api/registry/reference-docs?limit=2000"
        entityPath="/api/registry/reference-docs"
        queryKey="rules"
        onImport={() => setImportOpen(true)}
        importHint="Import rule bundle từ GitHub repo"
        columns={[
          { header: 'Name', field: 'name' },
          { header: 'Category', field: 'category', width: '160px' },
          { header: 'Auto-loaded', field: 'auto_loaded', width: '100px' },
          { header: 'Words', field: 'word_count', width: '80px' },
          { header: 'Description', field: 'description' },
        ]}
        rowActions={rowActions}
      />
      <GithubImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        entity="rules"
        onSuccess={() => qc.invalidateQueries({ queryKey: ['registry', 'rules'] })}
      />
    </>
  );
}

function DocsSubTab() {
  const [importOpen, setImportOpen] = useState(false);
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const rowActions: RowAction[] = [
    { icon: Eye, label: 'Mở chi tiết + đọc full doc', onClick: () => {} },
    {
      icon: FolderOpen,
      label: 'Copy đường dẫn doc',
      show: (r) => !!r.disk_path,
      onClick: (r) => openFileInBrowser(r.disk_path, pushToast),
    },
  ];
  return (
    <>
      <ListWithDrawer
        title="📄 Reference Docs"
        fetchPath="/api/registry/reference-docs?limit=2000"
        entityPath="/api/registry/reference-docs"
        queryKey="docs"
        onImport={() => setImportOpen(true)}
        importHint="Import docs từ GitHub repo"
        columns={[
          { header: 'Name', field: 'name' },
          { header: 'Type', field: 'doc_type', width: '80px' },
          { header: 'Category', field: 'category', width: '160px' },
          { header: 'Words', field: 'word_count', width: '80px' },
          { header: 'Description', field: 'description' },
        ]}
        rowActions={rowActions}
      />
      <GithubImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        entity="docs"
        onSuccess={() => qc.invalidateQueries({ queryKey: ['registry', 'docs'] })}
      />
    </>
  );
}

function EdgeFunctionsSubTab() {
  const [importOpen, setImportOpen] = useState(false);
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const rowActions: RowAction[] = [
    { icon: Eye, label: 'Mở chi tiết + xem source code', onClick: () => {} },
    {
      icon: ExternalLink,
      label: 'Mở Supabase Dashboard (Edge Functions)',
      onClick: (r) => {
        window.open(`https://supabase.com/dashboard/project/pgfkbcnzqozzkohwbgbk/functions/${r.name}`, '_blank');
      },
    },
    {
      icon: FolderOpen,
      label: 'Copy đường dẫn source',
      show: (r) => !!r.disk_path,
      onClick: (r) => openFileInBrowser(r.disk_path, pushToast),
    },
  ];
  return (
    <>
      <ListWithDrawer
        title="☁️ Supabase Edge Functions"
        fetchPath="/api/registry/edge-functions?limit=2000"
        entityPath="/api/registry/edge-functions"
        queryKey="edge_functions"
        onImport={() => setImportOpen(true)}
        importHint="Import edge function bundle từ GitHub"
        columns={[
          { header: 'Name', field: 'name' },
          { header: 'Category', field: 'category', width: '120px' },
          { header: 'Verify JWT', field: 'verify_jwt', width: '100px' },
          { header: 'Lines', field: 'lines_of_code', width: '80px' },
          { header: 'Description', field: 'description' },
        ]}
        rowActions={rowActions}
      />
      <GithubImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        entity="edge_functions"
        onSuccess={() => qc.invalidateQueries({ queryKey: ['registry', 'edge_functions'] })}
      />
    </>
  );
}

function MemoryFilesSubTab() {
  const { pushToast } = useToast();
  const rowActions: RowAction[] = [
    { icon: Eye, label: 'Mở chi tiết + đọc nội dung', onClick: () => {} },
    {
      icon: FolderOpen,
      label: 'Copy đường dẫn file',
      show: (r) => !!r.disk_path,
      onClick: (r) => openFileInBrowser(r.disk_path, pushToast),
    },
  ];
  return (
    <ListWithDrawer
      title="📁 Memory Files"
      fetchPath="/api/registry/memory-files?limit=5000"
      entityPath="/api/registry/memory-files"
      queryKey="memory_files"
      columns={[
        { header: 'Name', field: 'name' },
        { header: 'Type', field: 'file_type', width: '100px' },
        { header: 'Category', field: 'category', width: '200px' },
        { header: 'Lines', field: 'line_count', width: '80px' },
        { header: 'Description', field: 'description' },
      ]}
      rowActions={rowActions}
    />
  );
}

function TrainingSubTab() {
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const rowActions: RowAction[] = [
    { icon: Eye, label: 'Mở chi tiết enrollment', onClick: () => {} },
    {
      icon: ExternalLink,
      label: 'Mở Phòng Training',
      tone: 'primary',
      onClick: () => navigate('/GEM/training'),
    },
  ];
  return (
    <ListWithDrawer
      title="🎓 Training Enrollments"
      fetchPath="/api/registry/training/enrollments"
      entityPath="/api/registry/training/enrollments"
      queryKey="training_enrollments"
      columns={[
        { header: 'Agent', field: 'agent_slug', width: '160px' },
        { header: 'Topic', field: 'topic' },
        { header: 'Status', field: 'status', width: '100px' },
        { header: 'Progress', field: 'progress_pct', width: '80px' },
        { header: 'Created', field: 'created_at', width: '160px' },
      ]}
      rowActions={rowActions}
    />
  );
}

function CalendarSubTab() {
  const navigate = useNavigate();
  const rowActions: RowAction[] = [
    { icon: Eye, label: 'Mở chi tiết event', onClick: () => {} },
    {
      icon: ExternalLink,
      label: 'Mở Lịch Nội Dung',
      tone: 'primary',
      onClick: () => navigate('/GEM/cc/calendar'),
    },
  ];
  return (
    <ListWithDrawer
      title="📅 Content Calendar"
      fetchPath="/api/registry/content-calendar?limit=200"
      entityPath="/api/registry/content-calendar"
      queryKey="content_calendar"
      columns={[
        { header: 'Title', field: 'title' },
        { header: 'Platform', field: 'platform', width: '120px' },
        { header: 'Status', field: 'status', width: '100px' },
        { header: 'Scheduled', field: 'scheduled_at', width: '160px' },
        { header: 'Account', field: 'account', width: '140px' },
      ]}
      rowActions={rowActions}
    />
  );
}

function EmailCampaignsSubTab() {
  const navigate = useNavigate();
  const rowActions: RowAction[] = [
    { icon: Eye, label: 'Mở chi tiết campaign', onClick: () => {} },
    {
      icon: Pencil,
      label: 'Mở chi tiết edit (CCEmailCampaignDetail)',
      tone: 'primary',
      onClick: (r) => navigate(`/GEM/cc/email/${r.id}`),
    },
    {
      icon: ExternalLink,
      label: 'Mở danh sách CRM Email Campaigns',
      onClick: () => navigate('/GEM/crm/campaigns'),
    },
  ];
  return (
    <ListWithDrawer
      title="✉️ Email Campaigns"
      fetchPath="/api/registry/email-campaigns?limit=500"
      entityPath="/api/registry/email-campaigns"
      queryKey="email_campaigns"
      columns={[
        { header: 'Name', field: 'name' },
        { header: 'Subject', field: 'subject' },
        { header: 'Status', field: 'status', width: '100px' },
        { header: 'Segment', field: 'segment', width: '160px' },
        { header: 'Created', field: 'created_at', width: '160px' },
      ]}
      rowActions={rowActions}
    />
  );
}

function ShopifyProductsSubTab() {
  const navigate = useNavigate();
  const rowActions: RowAction[] = [
    { icon: Eye, label: 'Mở chi tiết + variants', onClick: () => {} },
    {
      icon: ExternalLink,
      label: 'Mở Shopify Admin (external)',
      tone: 'primary',
      onClick: (r) => {
        const handle = r.handle || r.shopify_id;
        if (handle) window.open(`https://admin.shopify.com/store/gemral/products/${handle}`, '_blank');
      },
    },
    {
      icon: ShoppingBag,
      label: 'Xem orders của product này',
      onClick: () => navigate('/GEM/crm/orders'),
    },
  ];
  return (
    <ListWithDrawer
      title="🛍 Shopify Products (SSOT)"
      fetchPath="/api/registry/shopify-products?limit=500"
      entityPath="/api/registry/shopify-products"
      queryKey="shopify_products"
      columns={[
        { header: 'Title', field: 'title' },
        { header: 'Type', field: 'product_type', width: '140px' },
        { header: 'Vendor', field: 'vendor', width: '140px' },
        { header: 'Status', field: 'status', width: '100px' },
        { header: 'Updated', field: 'updated_at', width: '160px' },
      ]}
      rowActions={rowActions}
    />
  );
}

function ChannelsSubTab() {
  // Phase 9: embed full ChannelsOverview component (mirror AgentsSubTab pattern)
  // — gives Jennie all channel cards, status, settings buttons, agent assignment
  // without leaving Registry Marketplace tab.
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-sm font-semibold text-foreground">📡 Channels</h3>
        <span className="text-[11px] text-muted-foreground">Embed of /GEM/channels — full overview + settings</span>
      </div>
      <ChannelsOverview />
    </div>
  );
}

function SystemSubTab() {
  const { data: cronStats } = useQuery({
    queryKey: ['registry', 'cron-summary'],
    queryFn: () => fetchJson<any[]>('/api/registry/crons', []),
    refetchInterval: 30_000,
  });

  const { data: allStats } = useQuery({
    queryKey: ['registry', 'stats-all'],
    queryFn: () =>
      fetchJson<Record<string, number>>(
        '/api/registry/stats/all',
        {
          mcp: 0, commands: 0, hooks: 0, plugins: 0, skills: 0, scripts: 0,
          subagents: 0, rules: 0, docs: 0, edge_functions: 0,
          memory_files: 0, training_enrollments: 0, content_calendar: 0,
          email_campaigns: 0, shopify_products: 0,
        },
      ),
    refetchInterval: 30_000,
  });

  const crons = cronStats || [];
  const enabledCrons = crons.filter((c) => c.enabled).length;
  const disabledCrons = crons.length - enabledCrons;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <Cog className="size-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">System Config</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            Sẽ merge toàn bộ setting từ <code className="font-mono">/GEM/config</code> Hệ thống tab vào đây.
          </p>
          <a
            href="/GEM/config"
            className="inline-flex items-center gap-1 mt-2 text-xs text-primary hover:underline"
          >
            <ExternalLink className="size-3" />
            Mở trang config cũ
          </a>
        </div>

        <div className="bg-card border border-border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <Clock className="size-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">Cron Registry</h3>
            <Tip text="Tất cả cron/heartbeat/scheduled jobs registered trong cron_registry table. Click row để xem chi tiết execution spec + copy.">
              <AlertCircle className="size-3 text-muted-foreground" />
            </Tip>
          </div>
          <div className="text-xs space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Tổng số jobs:</span>
              <span className="font-semibold text-foreground">{crons.length}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Active:</span>
              <span className="font-semibold text-green-500">{enabledCrons}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Disabled:</span>
              <span className="font-semibold text-muted-foreground">{disabledCrons}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Registry totals — 15 entities */}
      <div className="bg-card border border-border rounded-lg p-4">
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-sm font-semibold text-foreground">Registry Totals (15 entity types)</h3>
          <Tip text="Tổng số resources đã đăng ký trong Registry Marketplace. Click từng stat card để mở sub-tab tương ứng. Auto-refresh mỗi 30 giây.">
            <AlertCircle className="size-3 text-muted-foreground" />
          </Tip>
        </div>
        {(() => {
          const statCards: Array<{ key: string; label: string; tip: string }> = [
            { key: 'mcp', label: 'MCP', tip: 'MCP server endpoints (Model Context Protocol). Từ ~/.claude/mcp-configs/ + cloned repos.' },
            { key: 'commands', label: 'Commands', tip: 'Slash commands từ ~/.claude/commands/*.md.' },
            { key: 'hooks', label: 'Hooks', tip: 'Agent lifecycle hooks từ ~/.claude/hooks/*.json.' },
            { key: 'plugins', label: 'Plugins', tip: 'Claude Code plugins từ installed_plugins.json + cache/{marketplace}/.' },
            { key: 'skills', label: 'Skills', tip: 'Claude Code skills từ ~/.claude/skills/ + project skills-store/.' },
            { key: 'scripts', label: 'Scripts', tip: '.py/.bat/.sh/.ps1/.mjs/.js từ crypto-pattern-scanner + paperclip + Desktop.' },
            { key: 'subagents', label: 'Subagents', tip: 'Claude CLI subagents từ ~/.claude/agents/*.md (architect, code-reviewer...).' },
            { key: 'rules', label: 'Rules', tip: 'Auto-inject rules từ ~/.claude/rules/ (behaviors, skill-triggers, memory-flush, common/web/python...).' },
            { key: 'docs', label: 'Docs', tip: 'Reference docs từ ~/.claude/docs/ (task-routing, content-safety...).' },
            { key: 'edge_functions', label: 'Edge Fns', tip: 'Supabase Edge Functions từ supabase/functions/*. Auto-detect category + verify_jwt.' },
            { key: 'memory_files', label: 'Memory', tip: 'Project memory/ — today.md, patterns.md, reports/, decisions/, sops/, agents/*/daily.' },
            { key: 'training_enrollments', label: 'Training', tip: 'Agent training enrollments + spaced repetition lessons (training_enrollments table).' },
            { key: 'content_calendar', label: 'Calendar', tip: 'Content calendar events (cc_calendar_events) — scheduled posts sắp tới.' },
            { key: 'email_campaigns', label: 'Email', tip: 'Email campaigns (cc_email_campaigns) — active + scheduled.' },
            { key: 'shopify_products', label: 'Shopify', tip: 'Shopify products SSOT pricing catalog.' },
          ];
          return (
            <div className="grid grid-cols-5 gap-2 text-xs">
              {statCards.map((c) => (
                <Tip key={c.key} text={c.tip}>
                  <div className="text-center p-2 bg-muted rounded cursor-help">
                    <div className="text-lg font-bold text-foreground">{allStats?.[c.key] ?? 0}</div>
                    <div className="text-[10px] text-muted-foreground">{c.label}</div>
                  </div>
                </Tip>
              ))}
            </div>
          );
        })()}
      </div>

      {/* Cron Registry — full interactive table (Phase 9 — replaced read-only top-10 list) */}
      <CronRegistryListView />
    </div>
  );
}

// Phase 10 — Grouped Cron Registry with inline drawer (log viewer).
// Groups crons by category, shows per-row quick actions, click row → CronLogDrawer.
// See SESSION_LOG_VIEWER_FEATURE_SPEC for the drawer design contract.
import { CronLogDrawer } from './CronLogDrawer';

import { useConfirm } from "@/components/ConfirmDialog";
import { fetchOk } from "@/lib/readJsonOrThrow";
type CronRow = {
  id: string;
  display_name: string;
  description?: string;
  schedule_type?: string;
  cron_humanized?: string;
  cron_expression?: string;
  category?: string;
  priority?: string;
  enabled?: boolean;
  last_run_at?: string;
  last_run_status?: string;
  execution_spec?: Record<string, any>;
  script_file_name?: string;
};

// Group order + label + emoji. Categories not listed fall into 'other'.
const CATEGORY_META: Array<{ key: string; label: string; emoji: string; hint: string }> = [
  { key: 'content_biweekly',   label: 'Content Biweekly Pipeline', emoji: '🔄', hint: '4-step sequential: Plan → Generate → Queue → Schedule (Meta BS). Chạy T2 hai tuần/lần.' },
  { key: 'content_daily',      label: 'Daily Content',             emoji: '📅', hint: 'Daily Facebook posting + push notifications + blog. Runs every day.' },
  { key: 'email',              label: 'Email Automation',          emoji: '✉️', hint: 'Drip sequences, newsletter schedulers, welcome flows.' },
  { key: 'crm',                label: 'CRM & Follow-up',           emoji: '📞', hint: 'Follow-up queues, lead nurturing, customer lifecycle jobs.' },
  { key: 'channel',            label: 'Channel Ops',               emoji: '📨', hint: 'Chat channel ops — reconnect, cleanup, agent session pings.' },
  { key: 'zalo',               label: 'Zalo',                      emoji: '💬', hint: 'Zalo Personal webhook / session maintenance jobs.' },
  { key: 'trading',            label: 'Trading Engine',            emoji: '📈', hint: 'Paper trade monitors, scanner jobs, market data sync.' },
  { key: 'analytics',          label: 'Analytics',                 emoji: '📊', hint: 'Data pipelines, metrics aggregation, weekly reports.' },
  { key: 'sync',               label: 'Sync & Integrations',       emoji: '🔗', hint: 'Notion↔Supabase poll, external API sync, cross-system bridges.' },
  { key: 'audit_monitoring',   label: 'Audit & Monitoring',        emoji: '🩺', hint: 'Health checks, pipeline audits.' },
  { key: 'monitoring',         label: 'Monitoring (legacy)',       emoji: '🛰️', hint: 'Legacy monitoring entries — candidates for migration to audit_monitoring.' },
  { key: 'memory_maintenance', label: 'Memory Maintenance',        emoji: '🧠', hint: 'Daily memory reset + weekly decision journal compress.' },
  { key: 'system',             label: 'System',                    emoji: '⚙️', hint: 'System-level cron: backups, cleanup, housekeeping.' },
];

function priorityWeight(p?: string): number {
  switch ((p || 'normal').toLowerCase()) {
    case 'critical': return 0;
    case 'high':     return 1;
    case 'normal':   return 2;
    case 'low':      return 3;
    default:         return 4;
  }
}

function StatusDotMini({ s }: { s?: string }) {
  const cls = (() => {
    switch ((s || '').toLowerCase()) {
      case 'success': return 'bg-emerald-500';
      case 'running': return 'bg-blue-500 animate-pulse';
      case 'failed':
      case 'error':   return 'bg-red-500';
      case 'timeout': return 'bg-orange-500';
      default:        return 'bg-muted-foreground/40';
    }
  })();
  return <span className={`inline-block size-1.5 rounded-full ${cls}`} />;
}

function CronRegistryListView() {
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const { data: rowsData } = useQuery({
    queryKey: ['registry', 'crons', 'grouped'],
    queryFn: async () => {
      const r = await fetch('/api/registry/crons');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      return (j.items ?? j) as CronRow[];
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  const groups = useMemo(() => {
    const rows = rowsData ?? [];
    const bucket = new Map<string, CronRow[]>();
    for (const r of rows) {
      const key = r.category && CATEGORY_META.some((c) => c.key === r.category) ? r.category : 'other';
      if (!bucket.has(key)) bucket.set(key, []);
      bucket.get(key)!.push(r);
    }
    // Sort within group: priority → flow_step → name
    for (const [, arr] of bucket) {
      arr.sort((a, b) => {
        const pa = priorityWeight(a.priority);
        const pb = priorityWeight(b.priority);
        if (pa !== pb) return pa - pb;
        const sa = a.execution_spec?.flow_step ?? 999;
        const sb = b.execution_spec?.flow_step ?? 999;
        if (sa !== sb) return sa - sb;
        return (a.display_name || '').localeCompare(b.display_name || '');
      });
    }
    // Build ordered list
    const ordered = CATEGORY_META
      .filter((m) => bucket.has(m.key))
      .map((m) => ({ ...m, rows: bucket.get(m.key)! }));
    if (bucket.has('other')) {
      ordered.push({ key: 'other', label: 'Other / Uncategorized', emoji: '📦', hint: 'Cron entries chưa có category.', rows: bucket.get('other')! });
    }
    return ordered;
  }, [rowsData]);

  const runNow = async (row: CronRow, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!(await confirm({ title: `Chạy cron "${row.display_name}" NGAY?`, body: `Schedule: ${row.cron_humanized || row.cron_expression}`, confirmLabel: "Chạy ngay" }))) return;
    pushToast({ title: `▶️ ${row.display_name}...`, tone: 'info' });
    try {
      const r = await fetchOk(`/api/registry/crons/${row.id}/execute`, { method: 'POST' }, 'Lỗi chạy cron');
      const j = await r.json();
      pushToast({
        title: j.status === 'success' ? `✅ Done` : `❌ Failed`,
        body: (j.output || '').slice(-200),
        tone: j.status === 'success' ? 'success' : 'error',
      });
      qc.invalidateQueries({ queryKey: ['registry', 'crons'] });
    } catch (err: any) {
      pushToast({ title: 'Trigger thất bại', body: err.message, tone: 'error' });
    }
  };

  const toggle = async (row: CronRow, enable: boolean, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!(await confirm({ title: `${enable ? 'Bật' : 'Tắt'} "${row.display_name}"?`, confirmLabel: enable ? 'Bật' : 'Tắt' }))) return;
    try {
      const r = await fetch(`/api/registry/crons/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enable }),
      });
      if (!r.ok) throw new Error((await r.json()).error || 'Toggle failed');
      pushToast({ title: enable ? `✅ Bật ${row.display_name}` : `⏸ Tắt ${row.display_name}`, tone: 'success' });
      qc.invalidateQueries({ queryKey: ['registry', 'crons'] });
    } catch (err: any) {
      pushToast({ title: 'Toggle thất bại', body: err.message, tone: 'error' });
    }
  };

  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="flex items-center gap-2 mb-3">
        <Clock className="size-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">⏰ Cron Registry — Tất cả scheduled jobs</h3>
        <span className="text-[11px] text-muted-foreground/60">(pg_cron + node_timer + schtasks, grouped by category, click row → log viewer)</span>
      </div>

      <div className="space-y-3">
        {groups.map((g) => {
          const isCollapsed = collapsed[g.key];
          const enabledCount = g.rows.filter((r) => r.enabled).length;
          const failedCount = g.rows.filter((r) => r.last_run_status === 'failed').length;
          return (
            <div key={g.key} className="border border-border rounded-md">
              <button
                type="button"
                onClick={() => setCollapsed((c) => ({ ...c, [g.key]: !c[g.key] }))}
                className="w-full flex items-center gap-2 px-3 py-2 text-left bg-muted/40 hover:bg-muted/70 rounded-t-md"
              >
                <span className={`transition-transform ${isCollapsed ? '' : 'rotate-90'}`}>
                  <ChevronRight className="size-3.5 text-muted-foreground/60" />
                </span>
                <span className="text-base">{g.emoji}</span>
                <span className="text-sm font-semibold text-foreground">{g.label}</span>
                <span className="text-[11px] text-muted-foreground/60">({g.rows.length})</span>
                <span className="text-[11px] text-emerald-500 ml-2">{enabledCount} active</span>
                {failedCount > 0 && <span className="text-[11px] text-red-500">· {failedCount} failed</span>}
                <span className="ml-auto text-[11px] text-muted-foreground/60 italic max-w-md truncate">{g.hint}</span>
              </button>
              {!isCollapsed && (
                <div className="divide-y divide-border">
                  {g.rows.map((row) => (
                    <div
                      key={row.id}
                      onClick={() => setSelectedId(row.id)}
                      className="px-3 py-2 flex items-center gap-3 text-sm hover:bg-accent/30 cursor-pointer group"
                    >
                      <StatusDotMini s={row.last_run_status} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          {row.execution_spec?.flow_step && (
                            <span className="text-[10px] font-mono text-muted-foreground/60 bg-muted px-1 rounded">#{row.execution_spec.flow_step}</span>
                          )}
                          <span className={`font-medium ${row.enabled ? 'text-foreground' : 'text-muted-foreground/60 line-through'}`}>
                            {row.display_name}
                          </span>
                          <span className="text-[11px] text-muted-foreground/60 truncate">{row.cron_humanized || row.cron_expression}</span>
                          {row.priority && row.priority !== 'normal' && (
                            <span className={`text-[10px] px-1 py-0.5 rounded border ${
                              row.priority === 'critical' ? 'bg-red-500/10 text-red-500 border-red-500/30' :
                              row.priority === 'high' ? 'bg-orange-500/10 text-orange-600 border-orange-500/30' :
                              'bg-muted text-muted-foreground/70 border-border'
                            }`}>{row.priority}</span>
                          )}
                          {row.execution_spec?.silent && (
                            <span className="text-[10px] px-1 py-0.5 rounded bg-muted text-muted-foreground/60 border border-border">silent</span>
                          )}
                        </div>
                        {row.description && (
                          <div className="text-[11px] text-muted-foreground/60 truncate mt-0.5">{row.description}</div>
                        )}
                      </div>
                      <div className="flex items-center gap-1 opacity-50 group-hover:opacity-100 transition-opacity shrink-0">
                        <button
                          onClick={(e) => runNow(row, e)}
                          className="size-6 rounded flex items-center justify-center text-primary hover:bg-primary/10"
                          title="Chạy ngay"
                        >
                          <Play className="size-3" />
                        </button>
                        <button
                          onClick={(e) => toggle(row, !row.enabled, e)}
                          className={`size-6 rounded flex items-center justify-center ${row.enabled ? 'text-muted-foreground hover:bg-muted' : 'text-emerald-500 hover:bg-emerald-500/10'}`}
                          title={row.enabled ? 'Tắt' : 'Bật'}
                        >
                          {row.enabled ? <PowerOff className="size-3" /> : <Power className="size-3" />}
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setSelectedId(row.id); }}
                          className="size-6 rounded flex items-center justify-center text-muted-foreground hover:bg-muted"
                          title="Mở log viewer"
                        >
                          <Eye className="size-3" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {groups.length === 0 && (
          <div className="text-center py-8 text-muted-foreground/60 text-sm">Chưa có cron nào trong registry.</div>
        )}
      </div>

      {selectedId && (
        <CronLogDrawer
          cronId={selectedId}
          open
          onClose={() => setSelectedId(null)}
          onOpenRelated={(id) => setSelectedId(id)}
        />
      )}
    </div>
  );
}

// ─── Disk Sync Button ─────────────────────────────────────────────────────

function DiskSyncButton() {
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const [loading, setLoading] = useState(false);

  const handleSync = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/registry/sync/scan', { method: 'POST' });
      if (!res.ok) throw new Error((await res.json()).error || 'Sync failed');
      const result = await res.json();
      const u = result.upserted || {};
      const total = Object.values(u).reduce((a: number, b: any) => a + (b || 0), 0);
      pushToast({
        title: '✅ Disk sync complete',
        body: `${total} items · skills ${u.skills || 0} · scripts ${u.scripts || 0} · plugins ${u.plugins || 0} · subagents ${u.subagents || 0} · rules ${u.rules || 0} · edge fns ${u.edge_functions || 0} · memory ${u.memory_files || 0}${result.stale_marked > 0 ? ` · ${result.stale_marked} stale disabled` : ''}`,
        tone: 'success',
      });
      qc.invalidateQueries({ queryKey: ['registry'] });
    } catch (err: any) {
      pushToast({ title: 'Disk sync failed', body: err.message, tone: 'error' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Tip text="Scan ~/.claude/{skills,mcp-configs,commands,hooks,plugins}/ và upsert DB. Không phải cron — chỉ chạy khi chị bấm nút hoặc lúc server start.">
      <button
        onClick={handleSync}
        disabled={loading}
        className="px-3 py-1.5 text-xs bg-muted border border-border text-foreground rounded-md hover:border-primary hover:text-primary disabled:opacity-50 flex items-center gap-1.5"
      >
        {loading ? <Loader2 className="size-3.5 animate-spin" /> : <HardDrive className="size-3.5" />}
        {loading ? 'Đang scan...' : 'Sync from disk'}
      </button>
    </Tip>
  );
}

// ─── Main Registry Marketplace Tab ────────────────────────────────────────

export default function RegistryMarketplaceTab() {
  const [activeSubTab, setActiveSubTab] = useState<SubTab>('agents');

  return (
    <TooltipProvider delayDuration={300}>
      <div className="p-4 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-foreground">📋 Registry Marketplace</h2>
          <Tip text="Central SSOT hub cho tất cả Agents, Skills, Plugins, MCP, Commands, Hooks, Channels, System. Merge từ /GEM/agents-config + /GEM/config cũ. Import từ GitHub và sync với disk.">
            <AlertCircle className="size-3 text-muted-foreground" />
          </Tip>
          <div className="ml-auto">
            <DiskSyncButton />
          </div>
        </div>

        {/* Sub-tab bar (drag-drop reorderable, persisted to localStorage) */}
        <SortableTabBar
          storageKey="registry-subtabs"
          tabs={SUB_TABS}
          activeTab={activeSubTab}
          onTabChange={(id) => setActiveSubTab(id as SubTab)}
          tipComponent={Tip}
        />

        {/* Active sub-tab content */}
        <div className="bg-card border border-border rounded-xl p-4">
          {activeSubTab === 'agents' && <AgentsSubTab />}
          {activeSubTab === 'skills' && <SkillsSubTab />}
          {activeSubTab === 'plugins' && <PluginsSubTab />}
          {activeSubTab === 'mcp' && <MCPSubTab />}
          {activeSubTab === 'commands' && <CommandsSubTab />}
          {activeSubTab === 'hooks' && <HooksSubTab />}
          {activeSubTab === 'scripts' && <ScriptsSubTab />}
          {activeSubTab === 'subagents' && <SubagentsSubTab />}
          {activeSubTab === 'rules' && <RulesSubTab />}
          {activeSubTab === 'docs' && <DocsSubTab />}
          {activeSubTab === 'edge_functions' && <EdgeFunctionsSubTab />}
          {activeSubTab === 'memory_files' && <MemoryFilesSubTab />}
          {activeSubTab === 'training' && <TrainingSubTab />}
          {activeSubTab === 'calendar' && <CalendarSubTab />}
          {activeSubTab === 'email' && <EmailCampaignsSubTab />}
          {activeSubTab === 'shopify' && <ShopifyProductsSubTab />}
          {activeSubTab === 'channels' && <ChannelsSubTab />}
          {activeSubTab === 'system' && <SystemSubTab />}
        </div>
      </div>
    </TooltipProvider>
  );
}
