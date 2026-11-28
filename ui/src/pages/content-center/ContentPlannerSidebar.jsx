import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  Calendar, ChevronLeft, ChevronRight, Upload, Download,
  Copy, X, Plus, Clock, Trash2, FileText, Mail, Newspaper,
  Globe, Video, Hash, Pencil, Check, AlertTriangle, Loader2,
  Play, Square,
} from 'lucide-react';
import { plannerService } from '@gem/services';

// ─── Type config ────────────────────────────────────────
const TYPE_META = {
  news:        { label: 'Tin tức',  color: '#10B981', icon: Newspaper },
  email:       { label: 'Email',    color: '#d4a853', icon: Mail },
  social_post: { label: 'Social',   color: '#9b6dff', icon: Globe },
  script:      { label: 'Kịch bản', color: '#00F0FF', icon: FileText },
  short_clip:  { label: 'Short',    color: '#FF6B9D', icon: Video },
  other:       { label: 'Khác',     color: '#666666', icon: Hash },
};

const OUTPUT_TO_PLANNER_TYPE = {
  script_latc: 'script', script_tmt: 'script', script_short_clip: 'short_clip',
  title_latc: 'script', title_tmt: 'script',
  social_post: 'social_post', news_article: 'news', email_html: 'email',
};

const WEEKDAYS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

// Weekday name → JS getDay() value (0=Sun)
const WEEKDAY_MAP = {
  'thứ hai': 1, 'thứ 2': 1, 'monday': 1, 'mon': 1, 't2': 1,
  'thứ ba': 2, 'thứ 3': 2, 'tuesday': 2, 'tue': 2, 't3': 2,
  'thứ tư': 3, 'thứ 4': 3, 'wednesday': 3, 'wed': 3, 't4': 3,
  'thứ năm': 4, 'thứ 5': 4, 'thursday': 4, 'thu': 4, 't5': 4,
  'thứ sáu': 5, 'thứ 6': 5, 'friday': 5, 'fri': 5, 't6': 5,
  'thứ bảy': 6, 'thứ 7': 6, 'saturday': 6, 'sat': 6, 't7': 6,
  'chủ nhật': 0, 'cn': 0, 'sunday': 0, 'sun': 0,
};

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ─── Date helpers ───────────────────────────────────────
function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function getMonthDays(y, m) { return new Date(y, m + 1, 0).getDate(); }
function getFirstDayOffset(y, m) {
  const day = new Date(y, m, 1).getDay();
  return (day + 6) % 7;
}

// Get the next occurrence of a weekday from a base date
function getNextWeekday(targetDay, baseDate) {
  const d = new Date(baseDate);
  const current = d.getDay();
  let diff = targetDay - current;
  if (diff < 0) diff += 7;
  d.setDate(d.getDate() + diff);
  return d;
}

// ─── Smart Import parser ────────────────────────────────
function parsePlanFile(text, fileName, startDate) {
  let clean = text;
  if (/\.html?$/i.test(fileName)) {
    clean = text
      .replace(/<h[1-6][^>]*>/gi, '\n## ')
      .replace(/<\/h[1-6]>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<\/li>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }

  const result = {};
  let currentDate = null;
  let itemsWithoutDate = [];
  const baseDate = startDate ? new Date(startDate + 'T00:00') : new Date();
  const currentYear = baseDate.getFullYear();
  let weekdayCounter = new Date(baseDate); // tracks sequential weekday assignment

  for (const rawLine of clean.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    // Try headings as date/weekday markers
    if (line.startsWith('#') || /^(thứ|monday|tuesday|wednesday|thursday|friday|saturday|sunday|t[2-7]|cn)\b/i.test(line)) {
      const heading = line.replace(/^#+\s*/, '');

      // 1) Try exact date
      const exactDate = tryParseDate(heading, currentYear);
      if (exactDate) { currentDate = exactDate; if (!result[currentDate]) result[currentDate] = []; continue; }

      // 2) Try weekday name → map to next occurrence from baseDate
      const weekday = tryParseWeekday(heading);
      if (weekday !== null) {
        const nextOccurrence = getNextWeekday(weekday, weekdayCounter);
        currentDate = fmtDate(nextOccurrence);
        weekdayCounter = new Date(nextOccurrence);
        weekdayCounter.setDate(weekdayCounter.getDate() + 1); // advance so next same weekday is +7
        if (!result[currentDate]) result[currentDate] = [];
        continue;
      }

      // 3) Heading but no date — use as section title, items go to "unassigned"
      // We'll collect items without a date below
      currentDate = null;
      continue;
    }

    // Content items (bullets or numbered lists)
    if (/^[-*•]\s+/.test(line) || /^\d+[.)]\s+/.test(line)) {
      const content = line.replace(/^[-*•]\s+/, '').replace(/^\d+[.)]\s+/, '').trim();
      if (!content) continue;

      const parsedItem = parseContentItem(content);

      if (currentDate) {
        result[currentDate].push(parsedItem);
      } else {
        itemsWithoutDate.push(parsedItem);
      }
      continue;
    }

    // Plain text line (not heading, not bullet) — treat as content if we have a date
    if (currentDate && line.length > 5 && !line.startsWith('---')) {
      result[currentDate].push({
        id: genId(), time: '', type: 'other',
        title: line.length > 60 ? line.slice(0, 57) + '...' : line,
        brief: line, source: 'import',
      });
    } else if (!currentDate && line.length > 5 && !line.startsWith('---') && !line.startsWith('#')) {
      itemsWithoutDate.push({
        id: genId(), time: '', type: 'other',
        title: line.length > 60 ? line.slice(0, 57) + '...' : line,
        brief: line, source: 'import',
      });
    }
  }

  // Assign undated items sequentially starting from baseDate
  if (itemsWithoutDate.length > 0) {
    const assignDate = new Date(baseDate);
    itemsWithoutDate.forEach((item, i) => {
      const dateKey = fmtDate(assignDate);
      if (!result[dateKey]) result[dateKey] = [];
      result[dateKey].push(item);
      // Move to next day every 3 items (or customize)
      if ((i + 1) % 3 === 0) assignDate.setDate(assignDate.getDate() + 1);
    });
  }

  return result;
}

function parseContentItem(content) {
  const parts = content.split('|').map(s => s.trim());
  let time = '', type = 'other', brief = content;

  if (parts.length >= 3) {
    if (/^\d{1,2}:\d{2}/.test(parts[0])) time = parts[0];
    const t = parts[1].toLowerCase().replace(/\s+/g, '_');
    if (TYPE_META[t]) type = t;
    brief = parts.slice(2).join(' | ');
  } else if (parts.length === 2) {
    if (/^\d{1,2}:\d{2}/.test(parts[0])) { time = parts[0]; brief = parts[1]; }
    else {
      const t = parts[0].toLowerCase().replace(/\s+/g, '_');
      if (TYPE_META[t]) { type = t; brief = parts[1]; } else { brief = content; }
    }
  }

  // Auto-detect type from keywords if still "other"
  if (type === 'other') {
    const lower = brief.toLowerCase();
    if (/email|newsletter|gửi mail/i.test(lower)) type = 'email';
    else if (/facebook|instagram|threads|social|đăng bài|post/i.test(lower)) type = 'social_post';
    else if (/tin tức|news|blog|bài viết|article/i.test(lower)) type = 'news';
    else if (/kịch bản|script|video|clip/i.test(lower)) type = 'script';
    else if (/short|reel|tiktok/i.test(lower)) type = 'short_clip';
  }

  return {
    id: genId(), time, type,
    title: brief.length > 60 ? brief.slice(0, 57) + '...' : brief,
    brief, source: 'import',
  };
}

function tryParseDate(text, defaultYear) {
  let m = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = text.match(/(\d{1,2})\/(\d{1,2})(?!\d)/);
  if (m) return `${defaultYear}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = text.match(/(\d{1,2})\s*tháng\s*(\d{1,2})/i);
  if (m) return `${defaultYear}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = text.match(/tháng\s*(\d{1,2}).*?ngày\s*(\d{1,2})/i);
  if (m) return `${defaultYear}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

function tryParseWeekday(text) {
  const lower = text.toLowerCase().trim();
  for (const [key, val] of Object.entries(WEEKDAY_MAP)) {
    if (lower.startsWith(key) || lower.includes(key)) return val;
  }
  return null;
}

// ─── Export formatter ───────────────────────────────────
function exportToMd(data) {
  const dates = Object.keys(data).sort();
  if (!dates.length) return '# Content Plan\n\n_Chưa có nội dung_\n';
  let md = '# Content Plan\n\n';
  for (const date of dates) {
    const items = data[date];
    if (!items?.length) continue;
    md += `## ${date}\n`;
    for (const item of items) {
      const parts = [];
      if (item.time) parts.push(item.time);
      if (item.type && item.type !== 'other') parts.push(item.type);
      parts.push(item.brief || item.title);
      md += `- ${parts.join(' | ')}\n`;
    }
    md += '\n';
  }
  return md;
}

// ─── Component ──────────────────────────────────────────
export default function ContentPlannerSidebar({
  plannerData = {},
  onPlannerChange,
  onCopyToBrief,
  collapsed = false,
  onToggleCollapse,
}) {
  const today = useMemo(() => fmtDate(new Date()), []);
  const [viewDate, setViewDate] = useState(() => new Date());
  const [selectedDate, setSelectedDate] = useState(today);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addType, setAddType] = useState('other');
  const [addTime, setAddTime] = useState('');
  const [addTitle, setAddTitle] = useState('');
  const [addBrief, setAddBrief] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editType, setEditType] = useState('other');
  const [editTime, setEditTime] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [editBrief, setEditBrief] = useState('');
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importStartDate, setImportStartDate] = useState('');
  const [importFile, setImportFile] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [hoveredBrief, setHoveredBrief] = useState(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchLoading, setBatchLoading] = useState(false);
  const sidebarRef = useRef(null);
  const fileInputRef = useRef(null);

  // Poll batch status every 5s
  useEffect(() => {
    let mounted = true;
    const poll = async () => {
      try {
        const r = await fetch('/api/ops/content-pipeline/batch/status');
        if (r.ok && mounted) {
          const data = await r.json();
          setBatchRunning(data.running);
        }
      } catch {}
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => { mounted = false; clearInterval(t); };
  }, []);

  const handleBatchToggle = useCallback(async () => {
    setBatchLoading(true);
    try {
      const endpoint = batchRunning
        ? '/api/ops/content-pipeline/batch/stop'
        : '/api/ops/content-pipeline/batch/start';
      const r = await fetch(endpoint, { method: 'POST' });
      if (r.ok) {
        const data = await r.json();
        setBatchRunning(data.running);
      }
    } catch {}
    setBatchLoading(false);
  }, [batchRunning]);

  // Find the active tooltip item
  const tooltipItem = useMemo(() => {
    if (!hoveredBrief) return null;
    for (const items of Object.values(plannerData)) {
      const found = items.find(i => i.id === hoveredBrief);
      if (found) return found;
    }
    return null;
  }, [hoveredBrief, plannerData]);

  // Close tooltip on Escape
  useEffect(() => {
    if (!hoveredBrief) return;
    const handler = (e) => { if (e.key === 'Escape') setHoveredBrief(null); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [hoveredBrief]);

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const monthLabel = ['Tháng 1','Tháng 2','Tháng 3','Tháng 4','Tháng 5','Tháng 6','Tháng 7','Tháng 8','Tháng 9','Tháng 10','Tháng 11','Tháng 12'][month];

  // Calendar grid
  const calendarGrid = useMemo(() => {
    const offset = getFirstDayOffset(year, month);
    const days = getMonthDays(year, month);
    const prevDays = month === 0 ? getMonthDays(year - 1, 11) : getMonthDays(year, month - 1);
    const cells = [];
    for (let i = offset - 1; i >= 0; i--) {
      const d = prevDays - i;
      const dt = month === 0 ? new Date(year - 1, 11, d) : new Date(year, month - 1, d);
      cells.push({ day: d, date: fmtDate(dt), out: true });
    }
    for (let d = 1; d <= days; d++) {
      cells.push({ day: d, date: fmtDate(new Date(year, month, d)), out: false });
    }
    const rem = 42 - cells.length;
    for (let d = 1; d <= rem; d++) {
      const dt = month === 11 ? new Date(year + 1, 0, d) : new Date(year, month + 1, d);
      cells.push({ day: d, date: fmtDate(dt), out: true });
    }
    return cells;
  }, [year, month]);

  const selectedEvents = useMemo(() =>
    (plannerData[selectedDate] || []).slice().sort((a, b) => (a.time || '').localeCompare(b.time || '')),
    [plannerData, selectedDate],
  );

  const monthEventCount = useMemo(() => {
    let n = 0;
    calendarGrid.forEach(c => { if (!c.out && plannerData[c.date]?.length) n += plannerData[c.date].length; });
    return n;
  }, [calendarGrid, plannerData]);

  // Handlers
  const prevMonth = () => setViewDate(new Date(year, month - 1, 1));
  const nextMonth = () => setViewDate(new Date(year, month + 1, 1));
  const goToday = () => { setViewDate(new Date()); setSelectedDate(today); };

  const [saving, setSaving] = useState(false);

  const addEvent = useCallback(async () => {
    if (!addTitle.trim() && !addBrief.trim()) return;
    setSaving(true);
    const title = addTitle.trim() || addBrief.trim().slice(0, 60);
    const brief = addBrief.trim() || addTitle.trim();
    // Optimistic update
    const tempId = genId();
    const newItem = { id: tempId, time: addTime, type: addType, title, brief, source: 'manual' };
    const updated = { ...plannerData };
    if (!updated[selectedDate]) updated[selectedDate] = [];
    updated[selectedDate] = [...updated[selectedDate], newItem];
    onPlannerChange(updated);
    setAddTitle(''); setAddBrief(''); setAddTime(''); setAddType('other');
    setShowAddForm(false);
    // Persist to Supabase
    await plannerService.create({
      scheduled_date: selectedDate, time_slot: addTime, content_type: addType,
      title, brief, source: 'manual',
    });
    setSaving(false);
  }, [addTitle, addBrief, addTime, addType, selectedDate, plannerData, onPlannerChange]);

  const deleteEvent = useCallback(async (itemId) => {
    // Optimistic update
    const updated = { ...plannerData };
    if (updated[selectedDate]) {
      updated[selectedDate] = updated[selectedDate].filter(i => i.id !== itemId);
      if (!updated[selectedDate].length) delete updated[selectedDate];
    }
    onPlannerChange(updated);
    // Persist to Supabase
    await plannerService.remove(itemId);
  }, [selectedDate, plannerData, onPlannerChange]);

  // Edit handlers
  const startEdit = useCallback((item) => {
    setEditingId(item.id);
    setEditType(item.type || 'other');
    setEditTime(item.time || '');
    setEditTitle(item.title || '');
    setEditBrief(item.brief || '');
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editingId) return;
    const title = editTitle.trim() || editBrief.trim().slice(0, 60);
    const brief = editBrief.trim() || editTitle.trim();
    // Optimistic update
    const updated = { ...plannerData };
    if (updated[selectedDate]) {
      updated[selectedDate] = updated[selectedDate].map(item =>
        item.id === editingId ? { ...item, type: editType, time: editTime, title, brief } : item
      );
    }
    onPlannerChange(updated);
    setEditingId(null);
    // Persist to Supabase
    await plannerService.update(editingId, {
      content_type: editType, time_slot: editTime, title, brief,
    });
  }, [editingId, editType, editTime, editTitle, editBrief, selectedDate, plannerData, onPlannerChange]);

  const cancelEdit = () => setEditingId(null);

  // Import flow
  const handleImportClick = useCallback(() => { fileInputRef.current?.click(); }, []);

  const onFileSelected = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportFile(file);
    setImportStartDate(selectedDate || today);
    setShowImportDialog(true);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [selectedDate, today]);

  const executeImport = useCallback(() => {
    if (!importFile) return;
    setSaving(true);
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const text = ev.target?.result;
      if (typeof text !== 'string') { setSaving(false); return; }
      const parsed = parsePlanFile(text, importFile.name, importStartDate);
      // Optimistic local update
      const merged = { ...plannerData };
      let totalItems = 0;
      let totalDays = 0;
      const dbInserts = [];
      for (const [date, items] of Object.entries(parsed)) {
        if (!items.length) continue;
        if (!merged[date]) { merged[date] = []; totalDays++; }
        else { totalDays++; }
        merged[date] = [...merged[date], ...items];
        totalItems += items.length;
        for (const item of items) {
          dbInserts.push({
            scheduled_date: date,
            time_slot: item.time || '',
            content_type: item.type || 'other',
            title: item.title,
            brief: item.brief || '',
            source: 'import',
          });
        }
      }
      onPlannerChange(merged);
      setImportResult({ items: totalItems, days: totalDays });
      setTimeout(() => setImportResult(null), 4000);
      setShowImportDialog(false);
      setImportFile(null);
      // Persist all to Supabase
      if (dbInserts.length) await plannerService.createMany(dbInserts);
      setSaving(false);
    };
    reader.readAsText(importFile);
  }, [importFile, importStartDate, plannerData, onPlannerChange]);

  const handleExport = useCallback(() => {
    const md = exportToMd(plannerData);
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `content-plan-${today}.md`; a.click();
    URL.revokeObjectURL(url);
  }, [plannerData, today]);

  // ─── Collapsed ────────────────────────────────────────
  if (collapsed) {
    return (
      <div className="shrink-0 w-10">
        <div className="sticky top-20">
          <button
            onClick={onToggleCollapse}
            className="w-10 h-10 rounded-card border border-border bg-glass-bg flex items-center justify-center text-txt-3 hover:text-gold hover:border-gold/30 transition-all"
            title="Mở Content Planner"
          >
            <Calendar size={16} />
          </button>
        </div>
      </div>
    );
  }

  // ─── Full view ────────────────────────────────────────
  return (
    <div className="shrink-0 w-[340px]" ref={sidebarRef}>
      <div className="sticky top-20 flex flex-col" style={{ maxHeight: 'calc(100vh - 100px)' }}>
        <div className="rounded-card border border-border bg-glass-bg overflow-hidden flex flex-col" style={{ maxHeight: '100%' }}>

          {/* Header */}
          <div className="px-3 py-2 border-b border-border flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Calendar size={14} className="text-gold" />
              <span className="text-xxs font-semibold text-txt-2 uppercase tracking-wider">Content Planner</span>
            </div>
            <button onClick={onToggleCollapse} className="p-1 rounded hover:bg-bg-3 text-txt-3 hover:text-txt transition-colors" title="Thu gọn">
              <X size={14} />
            </button>
          </div>

          {/* Month nav */}
          <div className="px-3 py-2 flex items-center justify-between">
            <button onClick={prevMonth} className="p-1 rounded hover:bg-bg-3 text-txt-3 hover:text-txt"><ChevronLeft size={14} /></button>
            <button onClick={goToday} className="text-xs font-semibold text-txt hover:text-gold transition-colors">{monthLabel} {year}</button>
            <button onClick={nextMonth} className="p-1 rounded hover:bg-bg-3 text-txt-3 hover:text-txt"><ChevronRight size={14} /></button>
          </div>

          {/* Calendar grid */}
          <div className="px-3 pb-2">
            <div className="grid grid-cols-7 gap-0.5 mb-1">
              {WEEKDAYS.map(d => (
                <div key={d} className="text-center text-[10px] font-medium text-txt-3 py-0.5">{d}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-0.5">
              {calendarGrid.map((cell, i) => {
                const hasEvents = plannerData[cell.date]?.length > 0;
                const isToday = cell.date === today;
                const isSel = cell.date === selectedDate;
                const eventTypes = hasEvents ? [...new Set(plannerData[cell.date].map(e => e.type))] : [];

                return (
                  <button
                    key={i}
                    onClick={() => setSelectedDate(cell.date)}
                    className={[
                      'relative flex flex-col items-center justify-center rounded h-8 text-[11px] transition-all',
                      cell.out ? 'text-txt-3/30' : isSel ? 'bg-gold/20 text-gold font-bold' : isToday ? 'text-gold font-semibold ring-1 ring-gold/40' : 'text-txt-2 hover:bg-bg-3',
                    ].join(' ')}
                  >
                    {cell.day}
                    {hasEvents && (
                      <div className="flex gap-px absolute bottom-0.5">
                        {eventTypes.slice(0, 3).map((t, j) => (
                          <span key={j} className="w-1 h-1 rounded-full" style={{ backgroundColor: TYPE_META[t]?.color || '#666' }} />
                        ))}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="border-t border-border" />

          {/* Import result toast */}
          {importResult && (
            <div className="mx-3 mt-2 p-2 rounded-md bg-emerald/10 border border-emerald/20 text-[11px] text-emerald font-medium flex items-center gap-1.5">
              <Check size={12} />
              Đã import {importResult.items} mục vào {importResult.days} ngày
            </div>
          )}

          {/* Selected day events */}
          <div className="flex-1 overflow-y-auto min-h-0" style={{ maxHeight: '400px' }}>
            <div className="px-3 py-2">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xxs font-medium text-txt-3">
                  {selectedDate === today ? 'Hôm nay' : (() => {
                    const d = new Date(selectedDate + 'T00:00');
                    return d.toLocaleDateString('vi-VN', { weekday: 'short', day: 'numeric', month: 'short' });
                  })()}
                  {selectedEvents.length > 0 && ` · ${selectedEvents.length} mục`}
                </span>
                <button
                  onClick={() => { setShowAddForm(!showAddForm); setEditingId(null); }}
                  className="p-0.5 rounded hover:bg-gold/10 text-txt-3 hover:text-gold transition-colors"
                  title="Thêm mục"
                >
                  {showAddForm ? <X size={14} /> : <Plus size={14} />}
                </button>
              </div>

              {/* Add form */}
              {showAddForm && (
                <div className="mb-2 p-2 rounded-md border border-gold/20 bg-gold/5 space-y-1.5">
                  <div className="flex gap-1.5">
                    <select value={addType} onChange={e => setAddType(e.target.value)} className="fi text-[11px] py-1 px-1.5 flex-1">
                      {Object.entries(TYPE_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                    </select>
                    <input type="time" value={addTime} onChange={e => setAddTime(e.target.value)} className="fi text-[11px] py-1 px-1.5 w-[72px]" />
                  </div>
                  <input type="text" value={addTitle} onChange={e => setAddTitle(e.target.value)} placeholder="Tiêu đề..." className="fi text-[11px] py-1 px-2 w-full" />
                  <textarea value={addBrief} onChange={e => setAddBrief(e.target.value)} placeholder="Nội dung / yêu cầu cho AI..." className="fi text-[11px] py-1 px-2 w-full resize-y" rows={4} />
                  <div className="flex gap-1.5">
                    <button onClick={addEvent} disabled={saving || (!addTitle.trim() && !addBrief.trim())} className="flex-1 text-[11px] py-1 rounded bg-gold/20 text-gold hover:bg-gold/30 font-medium disabled:opacity-40 transition-colors flex items-center justify-center gap-1">{saving ? <><Loader2 size={10} className="animate-spin" /> Đang lưu...</> : 'Thêm'}</button>
                    <button onClick={() => setShowAddForm(false)} className="text-[11px] py-1 px-2 rounded bg-bg-3/50 text-txt-3 hover:bg-bg-3 transition-colors">Hủy</button>
                  </div>
                </div>
              )}

              {/* Events list */}
              {selectedEvents.length === 0 && !showAddForm && (
                <p className="text-[10px] text-txt-3/50 text-center py-4">Chưa có nội dung cho ngày này</p>
              )}

              <div className="space-y-1.5">
                {selectedEvents.map(item => {
                  const meta = TYPE_META[item.type] || TYPE_META.other;
                  const isScheduled = item.status === 'scheduled';
                  const isPublished = item.status === 'published';
                  const isEditingThis = editingId === item.id;

                  // Inline edit form
                  if (isEditingThis) {
                    return (
                      <div key={item.id} className="p-2 rounded-md border border-purple/30 bg-purple/5 space-y-1.5" style={{ borderLeftWidth: '3px', borderLeftColor: meta.color }}>
                        <div className="flex gap-1.5">
                          <select value={editType} onChange={e => setEditType(e.target.value)} className="fi text-[11px] py-1 px-1.5 flex-1">
                            {Object.entries(TYPE_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                          </select>
                          <input type="time" value={editTime} onChange={e => setEditTime(e.target.value)} className="fi text-[11px] py-1 px-1.5 w-[72px]" />
                        </div>
                        <input type="text" value={editTitle} onChange={e => setEditTitle(e.target.value)} className="fi text-[11px] py-1 px-2 w-full" />
                        <textarea value={editBrief} onChange={e => setEditBrief(e.target.value)} className="fi text-[11px] py-1 px-2 w-full resize-y" rows={4} />
                        <div className="flex gap-1.5">
                          <button onClick={saveEdit} className="flex-1 text-[11px] py-1 rounded bg-purple/20 text-purple hover:bg-purple/30 font-medium transition-colors">Lưu</button>
                          <button onClick={cancelEdit} className="text-[11px] py-1 px-2 rounded bg-bg-3/50 text-txt-3 hover:bg-bg-3 transition-colors">Hủy</button>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={item.id}
                      className="group rounded-md border border-border/50 bg-bg-2/30 p-2 hover:border-border transition-all"
                      style={{ borderLeftWidth: '3px', borderLeftColor: meta.color }}
                    >
                      <div className="flex items-start justify-between gap-1">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1 mb-0.5 flex-wrap">
                            <span className="text-[9px] font-semibold uppercase px-1 rounded" style={{ backgroundColor: meta.color + '22', color: meta.color }}>{meta.label}</span>
                            {item.time && <span className="text-[10px] text-txt-3 flex items-center gap-0.5"><Clock size={8} /> {item.time}</span>}
                            {isScheduled && <span className="text-[9px] text-emerald font-medium">⏱ Lên lịch</span>}
                            {isPublished && <span className="text-[9px] text-cyan font-medium">✓ Đã đăng</span>}
                          </div>
                          <p
                            className="text-[11px] text-txt-2 leading-snug line-clamp-2 cursor-pointer hover:text-gold/80 transition-colors"
                            onClick={() => item.brief && item.brief.length > 40 && setHoveredBrief(hoveredBrief === item.id ? null : item.id)}
                          >{item.title || item.brief}</p>
                        </div>
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                          <button onClick={() => onCopyToBrief?.(item.brief, item.type)} className="p-0.5 rounded hover:bg-gold/10 text-txt-3 hover:text-gold" title="Copy vào Brief"><Copy size={11} /></button>
                          <button onClick={() => startEdit(item)} className="p-0.5 rounded hover:bg-purple/10 text-txt-3 hover:text-purple" title="Sửa"><Pencil size={11} /></button>
                          <button onClick={() => deleteEvent(item.id)} className="p-0.5 rounded hover:bg-red-500/10 text-txt-3 hover:text-red-600 dark:hover:text-red-400" title="Xóa"><Trash2 size={11} /></button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="border-t border-border px-3 py-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-txt-3">{monthEventCount} mục trong tháng</span>
              <div className="flex items-center gap-1">
                <button
                  onClick={handleBatchToggle}
                  disabled={batchLoading}
                  title={batchRunning ? 'Dừng Batch Processor' : 'Chạy Batch Processor'}
                  className={[
                    'flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold transition-all',
                    batchLoading ? 'opacity-50 cursor-wait' :
                    batchRunning
                      ? 'bg-red-500/15 text-red-600 dark:text-red-400 hover:bg-red-500/25 border border-red-500/20'
                      : 'bg-emerald/10 text-emerald hover:bg-emerald/20 border border-emerald/20',
                  ].join(' ')}
                >
                  {batchLoading
                    ? <Loader2 size={10} className="animate-spin" />
                    : batchRunning
                      ? <Square size={10} />
                      : <Play size={10} />}
                  {batchRunning ? 'Stop' : 'Batch'}
                </button>
                <button onClick={handleImportClick} className="p-1 rounded hover:bg-purple/10 text-txt-3 hover:text-purple transition-colors" title="Import (.md, .html)">
                  <Upload size={12} />
                </button>
                <button onClick={handleExport} className="p-1 rounded hover:bg-cyan/10 text-txt-3 hover:text-cyan transition-colors" title="Export (.md)">
                  <Download size={12} />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Hidden file input */}
        <input ref={fileInputRef} type="file" accept=".md,.html,.htm,.txt" onChange={onFileSelected} style={{ display: 'none' }} />

        {/* Import dialog — pick start date for undated content */}
        {showImportDialog && (
          <div className="mt-2 rounded-card border border-purple/30 bg-glass-bg p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-purple">
              <Upload size={14} />
              Import: {importFile?.name}
            </div>
            <p className="text-[10px] text-txt-3">
              Chọn ngày bắt đầu cho nội dung không có ngày cụ thể. Các mục có thứ/ngày sẽ tự động phân bổ.
            </p>
            <input
              type="date"
              value={importStartDate}
              onChange={e => setImportStartDate(e.target.value)}
              className="fi text-[11px] py-1 px-2 w-full"
            />
            <div className="flex gap-1.5">
              <button onClick={executeImport} disabled={saving} className="flex-1 text-[11px] py-1 rounded bg-purple/20 text-purple hover:bg-purple/30 font-medium transition-colors disabled:opacity-40 flex items-center justify-center gap-1">{saving ? <><Loader2 size={10} className="animate-spin" /> Đang import...</> : 'Import'}</button>
              <button onClick={() => { setShowImportDialog(false); setImportFile(null); }} className="text-[11px] py-1 px-2 rounded bg-bg-3/50 text-txt-3 hover:bg-bg-3 transition-colors">Hủy</button>
            </div>
          </div>
        )}
      </div>

      {/* Content detail panel — rendered via portal to avoid sidebar overflow/nesting */}
      {tooltipItem && createPortal(
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 9999,
          }}
          onClick={() => setHoveredBrief(null)}
        >
          {/* Backdrop */}
          <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.3)' }} />

          {/* Panel — positioned next to sidebar */}
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              top: '50%',
              left: sidebarRef.current
                ? sidebarRef.current.getBoundingClientRect().right + 12
                : 380,
              transform: 'translateY(-50%)',
              width: 'min(560px, calc(100vw - 420px))',
              maxHeight: '70vh',
              backgroundColor: '#0e0e1a',
              border: '1px solid rgba(212, 168, 83, 0.25)',
              borderRadius: '12px',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
            }}
          >
            {/* Header */}
            <div style={{
              padding: '12px 16px',
              borderBottom: '1px solid rgba(212, 168, 83, 0.15)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexShrink: 0,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{
                  fontSize: '10px',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  padding: '2px 6px',
                  borderRadius: '4px',
                  backgroundColor: (TYPE_META[tooltipItem.type]?.color || '#666') + '22',
                  color: TYPE_META[tooltipItem.type]?.color || '#666',
                }}>{TYPE_META[tooltipItem.type]?.label || 'Khác'}</span>
                <span style={{ fontSize: '13px', fontWeight: 600, color: '#e0e0e0' }}>
                  {tooltipItem.title}
                </span>
              </div>
              <button
                onClick={() => setHoveredBrief(null)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#888',
                  cursor: 'pointer',
                  padding: '4px',
                  borderRadius: '4px',
                  display: 'flex',
                  alignItems: 'center',
                }}
                onMouseEnter={e => e.currentTarget.style.color = '#d4a853'}
                onMouseLeave={e => e.currentTarget.style.color = '#888'}
              >
                <X size={16} />
              </button>
            </div>

            {/* Content — scrollable */}
            <div
              className="tooltip-content-scroll"
              style={{
                padding: '16px',
                overflowY: 'auto',
                flex: 1,
                fontSize: '13px',
                lineHeight: '1.7',
                color: '#c8c8d0',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {tooltipItem.brief}
            </div>
          </div>

          {/* Custom scrollbar styles */}
          <style>{`
            .tooltip-content-scroll::-webkit-scrollbar {
              width: 6px;
            }
            .tooltip-content-scroll::-webkit-scrollbar-track {
              background: rgba(255,255,255,0.03);
              border-radius: 3px;
            }
            .tooltip-content-scroll::-webkit-scrollbar-thumb {
              background: rgba(212, 168, 83, 0.25);
              border-radius: 3px;
            }
            .tooltip-content-scroll::-webkit-scrollbar-thumb:hover {
              background: rgba(212, 168, 83, 0.4);
            }
          `}</style>
        </div>,
        document.body
      )}
    </div>
  );
}

// Export helpers for CCAIGen to use
ContentPlannerSidebar.OUTPUT_TO_PLANNER_TYPE = OUTPUT_TO_PLANNER_TYPE;
ContentPlannerSidebar.genId = genId;
