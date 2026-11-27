// JobLogViewerPanel — Content Pipeline job log viewer
// Uses Paperclip design tokens (bg-card/bg-muted/text-foreground) so it adapts
// to light & dark themes instead of hardcoded slate-* that looked wrong in both.
//
// Data sources:
//   GET /api/ops/content-pipeline/jobs/recent?limit=20
//   GET /api/ops/content-pipeline/jobs/:id/logs      → job meta + events + input_params + metadata + output_data
//   GET /api/ops/content-pipeline/jobs/:id/logs/stream  (SSE)
//
// Embed modes:
//   <JobLogViewerPanel mode="inline" selectedJobId={...} onSelectJob={...} />
//   <JobLogViewerPanel mode="modal"  jobId={...} open onClose={...} />

import { useEffect, useRef, useState, useMemo } from 'react';
import { copyToClipboard } from '@/lib/clipboard';

// Stage colors — semi-transparent tints that work on both light & dark backgrounds.
// Text uses foreground-aware variants so it never goes "light text on light bg".
const STAGE_META = {
  queued:           { icon: '🕒', tone: 'slate',   label: 'Queued' },
  start:            { icon: '▶️', tone: 'blue',    label: 'Start' },
  started:          { icon: '▶️', tone: 'blue',    label: 'Started' },
  'knowledge-load': { icon: '📚', tone: 'violet',  label: 'Knowledge Load' },
  'prompt-build':   { icon: '🔧', tone: 'violet',  label: 'Prompt Build' },
  'ai-call':        { icon: '🤖', tone: 'amber',   label: 'AI Call' },
  response:         { icon: '💬', tone: 'emerald', label: 'Response' },
  save:             { icon: '💾', tone: 'emerald', label: 'Save' },
  completed:        { icon: '✅', tone: 'emerald', label: 'Completed' },
  failed:           { icon: '❌', tone: 'red',     label: 'Failed' },
  retry:            { icon: '🔁', tone: 'amber',   label: 'Retry' },
  error:            { icon: '🔥', tone: 'red',     label: 'Error' },
  batch:            { icon: '📦', tone: 'cyan',    label: 'Batch' },
};

// Tone → Tailwind classes. Kept intentionally subtle — cards use the same
// neutral card background as Inputs panel; the stage color only appears as
// a 2px left accent stripe + small badge. Keeps the eye on content, not tint.
const TONE_CLASSES = {
  slate:   { stripe: 'bg-slate-400/60',   badge: 'bg-slate-500/15 text-slate-700 dark:text-slate-200' },
  blue:    { stripe: 'bg-blue-500/70',    badge: 'bg-blue-500/15 text-blue-700 dark:text-blue-200' },
  violet:  { stripe: 'bg-violet-500/70',  badge: 'bg-violet-500/15 text-violet-700 dark:text-violet-200' },
  amber:   { stripe: 'bg-amber-500/70',   badge: 'bg-amber-500/15 text-amber-700 dark:text-amber-200' },
  emerald: { stripe: 'bg-emerald-500/70', badge: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-200' },
  red:     { stripe: 'bg-red-500/70',     badge: 'bg-red-500/15 text-red-700 dark:text-red-200' },
  cyan:    { stripe: 'bg-cyan-500/70',    badge: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-200' },
};

const STATUS_TONE = {
  queued: 'slate',
  processing: 'blue',
  completed: 'emerald',
  failed: 'red',
  cancelled: 'slate',
};

function formatTs(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const opts = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Ho_Chi_Minh' };
    return d.toLocaleTimeString('vi-VN', opts);
  } catch { return ts; }
}

function formatDateTs(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('vi-VN', { hour12: false, timeZone: 'Asia/Ho_Chi_Minh' });
  } catch { return ts; }
}

// ────────────────────────── Inputs panel ──────────────────────────
// Read-only Inputs panel. Pulls from BOTH job columns AND input_params jsonb —
// many batch_processor versions store things like pillar/topic/voice inside
// input_params instead of their dedicated columns, so we always merge + fallback.
//
// Rendering strategy (no more raw JSON dumps):
//   - Short scalar values → compact FieldRow (label + value)
//   - Long text (userPrompt, systemPrompt, anything >200 chars) → TextBlock
//     with Copy button and its own scrollable pre
//   - Nested objects/arrays → pretty-formatted JSON block (readable whitespace,
//     syntax-highlighted-ish indent, still inside a card with a Copy button)

function pick(...vals) {
  for (const v of vals) {
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

function InputsPanel({ job }) {
  if (!job) return null;
  const ip = job.input_params || {};
  const md = job.metadata || {};

  // Core fields — column first, fallback to input_params alias(es).
  const core = [
    { label: 'Job type',     value: pick(job.job_type),        mono: true },
    { label: 'Content type', value: pick(job.content_type, ip.content_type), mono: true },
    { label: 'Pillar',       value: pick(job.pillar, ip.pillar) },
    { label: 'Track',        value: pick(job.track, ip.track) },
    { label: 'Persona',      value: pick(job.persona, ip.persona) },
    { label: 'Writing mode', value: pick(job.writing_mode, ip.writingMode, ip.writing_mode) },
    { label: 'Model',        value: pick(job.model_used, ip.model, md.requested_model), mono: true },
    { label: 'Provider',     value: pick(ip.provider), mono: true },
    { label: 'Processor',    value: pick(job.processor), mono: true },
    { label: 'Priority',     value: pick(job.priority) },
    { label: 'Max tokens',   value: pick(ip.maxTokens, ip.max_tokens), mono: true },
    { label: 'Temperature',  value: pick(ip.temperature), mono: true },
    {
      label: 'Entity',
      value: job.entity_type && job.entity_id ? `${job.entity_type}:${job.entity_id}` : null,
      mono: true,
    },
  ];

  // Pick out long text prompts for their own blocks
  const LONG_TEXT_KEYS = ['userPrompt', 'user_prompt', 'systemPrompt', 'system_prompt', 'prompt', 'instruction', 'instructions'];
  const textBlocks = LONG_TEXT_KEYS
    .map((k) => ({ key: k, value: ip[k] }))
    .filter((r) => typeof r.value === 'string' && r.value.length > 0);

  // Topic-level short fields (one-line strings)
  const TOPIC_KEYS = ['topic', 'theme', 'audience', 'target_audience', 'voice', 'brand_voice', 'tone', 'cta', 'hashtags', 'length', 'word_count', 'language', 'framework', 'hook_type', 'format', 'platform', 'channel'];
  const topicFields = TOPIC_KEYS
    .map((k) => ({ label: k, value: ip[k] }))
    .filter((r) => r.value !== undefined && r.value !== null && r.value !== '' && typeof r.value !== 'object');

  // Remaining input_params — anything not already shown
  const shown = new Set([
    'content_type', 'pillar', 'track', 'persona', 'writingMode', 'writing_mode',
    'model', 'provider', 'maxTokens', 'max_tokens', 'temperature',
    ...LONG_TEXT_KEYS, ...TOPIC_KEYS,
  ]);
  const extraEntries = Object.entries(ip).filter(([k]) => !shown.has(k));

  return (
    <div className="border border-border rounded-md bg-card/50 mb-3">
      <details open>
        <summary className="cursor-pointer list-none px-3 py-2 flex items-center gap-2 hover:bg-accent/40 transition-colors select-none">
          <span className="text-sm">📥</span>
          <span className="text-xs font-semibold text-foreground">Inputs</span>
          <span className="text-[10px] text-muted-foreground">— mọi thông tin gửi vào batch_processor</span>
          <span className="ml-auto text-[10px] text-muted-foreground">chi tiết ▾</span>
        </summary>
        <div className="px-3 pb-3 space-y-3">
          {/* Core fields */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2">
            {core.map((f) => <FieldRow key={f.label} {...f} />)}
          </div>

          {/* Topic fields (if any) */}
          {topicFields.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Content inputs</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-2">
                {topicFields.map((f) => <FieldRow key={f.label} {...f} wide />)}
              </div>
            </div>
          )}

          {/* Long text blocks (system prompt, user prompt) */}
          {textBlocks.map((b) => (
            <TextBlock key={b.key} label={b.key} text={b.value} />
          ))}

          {/* Extra input_params — render as key-value rows */}
          {extraEntries.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                Input params khác ({extraEntries.length})
              </div>
              <KeyValueList entries={extraEntries} />
            </div>
          )}

          {/* Metadata */}
          {md && Object.keys(md).length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                Metadata ({Object.keys(md).length})
              </div>
              <KeyValueList entries={Object.entries(md)} />
            </div>
          )}
        </div>
      </details>
    </div>
  );
}

function FieldRow({ label, value, mono, wide }) {
  const display =
    value === null || value === undefined || value === '' ? '—' : String(value);
  const isMissing = display === '—';
  return (
    <div className={wide ? 'col-span-1 md:col-span-2' : ''}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
        {label}
      </div>
      <div
        className={`text-xs break-all ${mono ? 'font-mono' : ''} ${
          isMissing ? 'text-muted-foreground/60' : 'text-foreground'
        }`}
      >
        {display}
      </div>
    </div>
  );
}

// Render a list of key → value pairs nicely. Values that are objects/arrays
// get pretty-printed in an indented, monospaced block; primitives render inline.
function KeyValueList({ entries }) {
  return (
    <div className="border border-border rounded bg-muted/30 divide-y divide-border/60 overflow-hidden">
      {entries.map(([k, v]) => (
        <KeyValueRow key={k} k={k} v={v} />
      ))}
    </div>
  );
}

function KeyValueRow({ k, v }) {
  const isObject = v !== null && typeof v === 'object';
  const isLongString = typeof v === 'string' && (v.length > 120 || v.includes('\n'));
  const [open, setOpen] = useState(false);

  if (isObject) {
    const pretty = JSON.stringify(v, null, 2);
    return (
      <div className="px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((x) => !x)}
          className="w-full flex items-center gap-2 text-left"
        >
          <span className="text-[10px] text-muted-foreground shrink-0">{open ? '▼' : '▶'}</span>
          <span className="text-[11px] font-mono font-semibold text-foreground">{k}</span>
          <span className="text-[10px] text-muted-foreground ml-auto">
            {Array.isArray(v) ? `array[${v.length}]` : `object · ${Object.keys(v).length} key`}
          </span>
        </button>
        {open && (
          <pre className="mt-2 text-[11px] leading-relaxed p-2 rounded border border-border bg-background text-foreground overflow-x-auto whitespace-pre-wrap">
{pretty}
          </pre>
        )}
      </div>
    );
  }

  if (isLongString) {
    return (
      <div className="px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((x) => !x)}
          className="w-full flex items-center gap-2 text-left"
        >
          <span className="text-[10px] text-muted-foreground shrink-0">{open ? '▼' : '▶'}</span>
          <span className="text-[11px] font-mono font-semibold text-foreground">{k}</span>
          <span className="text-[10px] text-muted-foreground ml-auto">string · {v.length} chars</span>
        </button>
        {open ? (
          <pre className="mt-2 text-[11px] leading-relaxed p-2 rounded border border-border bg-background text-foreground overflow-x-auto whitespace-pre-wrap max-h-72 overflow-y-auto">
{v}
          </pre>
        ) : (
          <div className="text-[11px] text-muted-foreground mt-1 line-clamp-1">{v.slice(0, 120)}…</div>
        )}
      </div>
    );
  }

  // Primitive
  return (
    <div className="px-3 py-1.5 flex items-baseline gap-3">
      <span className="text-[11px] font-mono font-semibold text-foreground shrink-0">{k}</span>
      <span className="text-[11px] text-muted-foreground">=</span>
      <span className="text-[11px] font-mono text-foreground break-all">
        {v === null ? <em className="text-muted-foreground">null</em> :
         v === '' ? <em className="text-muted-foreground">(empty)</em> :
         typeof v === 'boolean' ? (v ? 'true' : 'false') :
         String(v)}
      </span>
    </div>
  );
}

// Output panel — mirrors InputsPanel layout so they feel consistent.
// Handles 3 shapes: plain string, array, plain object. Long string values
// inside an object become TextBlocks; primitives/nested objects go through
// KeyValueList; the wrapping object itself is NOT dumped as raw JSON.
function OutputPanel({ output }) {
  let data = output;
  if (typeof data === 'string') {
    // If it's a JSON string, parse so we can render structured.
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === 'object') data = parsed;
    } catch { /* keep as string */ }
  }

  const isString = typeof data === 'string';
  const isArray = Array.isArray(data);
  const entries = isString || isArray ? null : Object.entries(data || {});

  // Inside the object, long text fields get their own TextBlock; short ones
  // plus primitives/nested go to KeyValueList.
  const longTextKeys = entries
    ? entries.filter(([, v]) => typeof v === 'string' && (v.length > 200 || v.includes('\n')))
    : [];
  const otherEntries = entries
    ? entries.filter(
        ([, v]) => !(typeof v === 'string' && (v.length > 200 || v.includes('\n')))
      )
    : [];

  return (
    <div className="mt-3 border border-border rounded-md bg-card/50">
      <details open>
        <summary className="cursor-pointer list-none px-3 py-2 flex items-center gap-2 hover:bg-accent/40 select-none">
          <span className="text-sm">📤</span>
          <span className="text-xs font-semibold text-foreground">Output data</span>
          <span className="text-[10px] text-muted-foreground">
            — kết quả AI trả về
          </span>
          <span className="ml-auto text-[10px] text-muted-foreground">chi tiết ▾</span>
        </summary>
        <div className="px-3 pb-3 space-y-2">
          {isString && <TextBlock label="output" text={data} defaultOpen />}
          {isArray && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                Array · {data.length} item
              </div>
              <KeyValueList entries={data.map((v, i) => [String(i), v])} />
            </div>
          )}
          {entries && (
            <>
              {longTextKeys.map(([k, v]) => (
                <TextBlock key={k} label={k} text={v} />
              ))}
              {otherEntries.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                    Fields ({otherEntries.length})
                  </div>
                  <KeyValueList entries={otherEntries} />
                </div>
              )}
            </>
          )}
        </div>
      </details>
    </div>
  );
}

function TextBlock({ label, text, defaultOpen = false }) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(defaultOpen);
  const copy = (e) => {
    e.stopPropagation();
    void copyToClipboard(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const preview = text.split('\n').slice(0, 2).join(' ').slice(0, 140);

  return (
    <div className="border border-border rounded bg-muted/30 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((x) => !x)}
          className="flex items-center gap-2 text-left flex-1 min-w-0"
        >
          <span className="text-[10px] text-muted-foreground shrink-0">{open ? '▼' : '▶'}</span>
          <span className="text-[11px] font-mono font-semibold text-foreground shrink-0">{label}</span>
          <span className="text-[10px] text-muted-foreground shrink-0">
            · {text.length.toLocaleString()} chars
          </span>
          {!open && (
            <span className="text-[11px] text-muted-foreground truncate">{preview}…</span>
          )}
        </button>
        <button
          type="button"
          onClick={copy}
          className="text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40 shrink-0"
        >
          {copied ? '✓' : '📋 Copy'}
        </button>
      </div>
      {open && (
        <pre className="text-[11px] leading-relaxed px-3 pb-3 text-foreground overflow-x-auto whitespace-pre-wrap max-h-96 overflow-y-auto">
{text}
        </pre>
      )}
    </div>
  );
}

// ────────────────────────── Stage card ──────────────────────────
// Prompt-build events get special treatment: full prompt text is always
// visible (no truncation) when the card is open, with a Copy button.
function StageCard({ event, defaultOpen = false }) {
  const meta = STAGE_META[event.stage] || STAGE_META.start;
  const tone = TONE_CLASSES[meta.tone] || TONE_CLASSES.slate;
  const [open, setOpen] = useState(defaultOpen);

  const isPromptStage = event.stage === 'prompt-build' || event.stage === 'ai-call';
  const promptText =
    event.metadata?.prompt ||
    event.metadata?.full_prompt ||
    event.metadata?.rendered_prompt ||
    (isPromptStage && event.message && event.message.length > 200 ? event.message : null);

  const hasDetails =
    (event.metadata && Object.keys(event.metadata).length > 0) ||
    (event.message && event.message.length > 80) ||
    !!promptText;

  // Remaining metadata fields — exclude the prompt key we already surfaced
  // as its own TextBlock, otherwise it would appear twice.
  const metaEntries = event.metadata
    ? Object.entries(event.metadata).filter(
        ([k]) => !['prompt', 'full_prompt', 'rendered_prompt'].includes(k)
      )
    : [];

  return (
    <div className="relative border border-border rounded-md bg-card/50 mb-2 overflow-hidden">
      {/* 2px tone stripe on the left — single visual cue for stage category */}
      <span
        aria-hidden
        className={`absolute left-0 top-0 bottom-0 w-0.5 ${tone.stripe}`}
      />

      {/* Header (toggle). Interactive children live OUTSIDE to avoid nested buttons. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start gap-2 p-2.5 pl-3 text-left hover:bg-accent/40 transition-colors"
      >
        <span className="text-base shrink-0 leading-none mt-0.5">{meta.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase ${tone.badge}`}>
              {meta.label}
            </span>
            <span className="text-[10px] text-muted-foreground font-mono">{formatTs(event.ts)}</span>
            {event.level && event.level !== 'info' && (
              <span
                className={`text-[9px] px-1 py-0.5 rounded uppercase font-bold ${
                  event.level === 'error'
                    ? TONE_CLASSES.red.badge
                    : event.level === 'warn'
                    ? TONE_CLASSES.amber.badge
                    : TONE_CLASSES.cyan.badge
                }`}
              >
                {event.level}
              </span>
            )}
          </div>
          <div className={`text-xs text-foreground mt-1 ${open ? 'whitespace-pre-wrap wrap-break-word' : 'line-clamp-2'}`}>
            {event.message}
          </div>
        </div>
        {hasDetails && (
          <span className="text-[10px] text-muted-foreground shrink-0 mt-0.5">{open ? '▲' : '▼'}</span>
        )}
      </button>

      {/* Expanded body — separate block so nested buttons are valid */}
      {open && (promptText || metaEntries.length > 0) && (
        <div className="px-3 pb-2.5 space-y-2">
          {promptText && <PromptBlock text={promptText} />}
          {metaEntries.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                Metadata ({metaEntries.length})
              </div>
              <KeyValueList entries={metaEntries} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PromptBlock({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = (e) => {
    e.stopPropagation();
    void copyToClipboard(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Prompt ({text.length.toLocaleString()} chars)
        </span>
        <button
          type="button"
          onClick={copy}
          className="text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
        >
          {copied ? '✓ Copied' : '📋 Copy prompt'}
        </button>
      </div>
      <pre className="text-[11px] p-2 rounded border border-border bg-muted/60 text-foreground overflow-x-auto whitespace-pre-wrap max-h-96 overflow-y-auto">
{text}
      </pre>
    </div>
  );
}

// ────────────────────────── Header ──────────────────────────
function JobMetaHeader({ job, isLive, onClose }) {
  if (!job) return null;
  const status = job.status || 'unknown';
  const statusTone = TONE_CLASSES[STATUS_TONE[status] || 'slate'];
  return (
    <div className="px-4 py-3 bg-card border-b border-border">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-base">📜</span>
        <h2 className="text-sm font-semibold text-foreground">Job Transcript</h2>
        <span className={`text-[10px] px-2 py-0.5 rounded-full uppercase font-bold ${statusTone.badge} ${status === 'processing' ? 'animate-pulse' : ''}`}>
          {status}
        </span>
        {isLive && (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-700 dark:text-red-200 border border-red-400/40 animate-pulse flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-red-500" /> Live
          </span>
        )}
        {onClose && (
          <>
            <div className="flex-1" />
            <button
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground text-lg leading-none px-2"
              aria-label="Close"
            >
              ×
            </button>
          </>
        )}
      </div>
      <div className="text-[11px] text-muted-foreground flex flex-wrap gap-x-3 gap-y-1">
        <span>id: <code className="text-foreground">{job.id?.slice(0, 8)}…</code></span>
        <span>type: <code className="text-foreground">{job.job_type}/{job.content_type || '—'}</code></span>
        <span>model: <code className="text-foreground">{job.model_used || '?'}</code></span>
        {job.pillar && <span>pillar: <code className="text-foreground">{job.pillar}</code></span>}
        {job.persona && <span>persona: <code className="text-foreground">{job.persona}</code></span>}
        {job.total_tokens ? <span>tokens: {job.total_tokens}</span> : null}
        {job.generation_time_ms ? <span>elapsed: {(job.generation_time_ms / 1000).toFixed(1)}s</span> : null}
        {job.retry_count ? <span>retries: {job.retry_count}/{job.max_retries ?? '?'}</span> : null}
        {job.error_message && (
          <span className="text-red-600 dark:text-red-300">⚠ {job.error_message.slice(0, 80)}</span>
        )}
      </div>
      <div className="text-[10px] text-muted-foreground mt-1 flex flex-wrap gap-x-3">
        <span>created: <code className="text-foreground/80">{formatDateTs(job.created_at)}</code></span>
        {job.started_at && <span>started: <code className="text-foreground/80">{formatDateTs(job.started_at)}</code></span>}
        {job.completed_at && <span>completed: <code className="text-foreground/80">{formatDateTs(job.completed_at)}</code></span>}
      </div>
    </div>
  );
}

// ────────────────────────── Body ──────────────────────────
function JobLogBody({ jobId, recentJobs, onSelectJob, embedded }) {
  const [events, setEvents] = useState([]);
  const [currentJob, setCurrentJob] = useState(null);
  const [isLive, setIsLive] = useState(false);
  const [levelFilter, setLevelFilter] = useState('');
  const [stageFilter, setStageFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const scrollRef = useRef(null);
  const shouldAutoScroll = useRef(true);
  const esRef = useRef(null);

  useEffect(() => {
    if (!jobId) {
      setEvents([]);
      setCurrentJob(null);
      setIsLive(false);
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setEvents([]);

    const load = async () => {
      try {
        const r = await fetch(`/api/ops/content-pipeline/jobs/${jobId}/logs`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (cancelled) return;
        setCurrentJob(data.job);
        setEvents(data.events || []);
        setIsLive(!!data.isLive);
        setLoading(false);

        if (data.isLive) {
          const es = new EventSource(`/api/ops/content-pipeline/jobs/${jobId}/logs/stream`);
          esRef.current = es;
          es.onmessage = (ev) => {
            try {
              const msg = JSON.parse(ev.data);
              if (msg.type === 'event' && msg.event) {
                setEvents((prev) => [...prev, msg.event]);
              } else if (msg.type === 'done') {
                setIsLive(false);
                es.close();
                esRef.current = null;
              }
            } catch {}
          };
          es.onerror = () => { es.close(); esRef.current = null; setIsLive(false); };
        }
      } catch (e) {
        if (!cancelled) { setError(e.message); setLoading(false); }
      }
    };
    load();
    return () => {
      cancelled = true;
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
    };
  }, [jobId]);

  useEffect(() => {
    if (shouldAutoScroll.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events.length]);

  const onScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    shouldAutoScroll.current = scrollTop + clientHeight >= scrollHeight - 80;
  };

  const filtered = useMemo(() => {
    return events.filter(
      (e) => (!levelFilter || e.level === levelFilter) && (!stageFilter || e.stage === stageFilter)
    );
  }, [events, levelFilter, stageFilter]);

  const transcript = useMemo(
    () =>
      filtered
        .map((e) => `[${formatTs(e.ts)}] [${(e.level || 'info').toUpperCase().padEnd(5)}] (${e.stage || '-'}) ${e.message}`)
        .join('\n'),
    [filtered]
  );

  const handleCopy = () => { void copyToClipboard(transcript); };
  const handleDownload = () => {
    const blob = new Blob([transcript], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `job-${jobId?.slice(0, 8) || 'latest'}-${Date.now()}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const allStages = useMemo(() => Array.from(new Set(events.map((e) => e.stage).filter(Boolean))), [events]);

  return (
    <>
      {/* Recent jobs picker */}
      {recentJobs && onSelectJob && (
        <div className="px-4 py-2 border-b border-border bg-card">
          <label htmlFor="job-picker" className="sr-only">Chọn job</label>
          <select
            id="job-picker"
            value={jobId || ''}
            onChange={(e) => onSelectJob(e.target.value || null)}
            className="w-full text-xs bg-background border border-border text-foreground rounded px-2 py-1.5"
          >
            <option value="">— Chọn job gần đây —</option>
            {recentJobs.map((j) => (
              <option key={j.id} value={j.id}>
                {new Date(j.created_at).toLocaleString('vi-VN', { hour12: false, timeZone: 'Asia/Ho_Chi_Minh' })} · {j.job_type}/{j.content_type || '-'} · {j.status} · {(j.topic || '').slice(0, 40)}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Toolbar */}
      {currentJob && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border bg-card text-[11px]">
          <label htmlFor="level-filter" className="sr-only">Level filter</label>
          <select
            id="level-filter"
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
            className="bg-background border border-border rounded px-1.5 py-0.5 text-[11px] text-foreground"
          >
            <option value="">All levels</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
            <option value="debug">Debug</option>
          </select>
          <label htmlFor="stage-filter" className="sr-only">Stage filter</label>
          <select
            id="stage-filter"
            value={stageFilter}
            onChange={(e) => setStageFilter(e.target.value)}
            className="bg-background border border-border rounded px-1.5 py-0.5 text-[11px] text-foreground"
          >
            <option value="">All stages</option>
            {allStages.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <div className="flex-1" />
          <button
            type="button"
            onClick={handleCopy}
            disabled={!transcript}
            className="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40 disabled:opacity-40"
          >
            📋 Copy
          </button>
          <button
            type="button"
            onClick={handleDownload}
            disabled={!transcript}
            className="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40 disabled:opacity-40"
          >
            ⬇ .log
          </button>
          <span className="text-[10px] text-muted-foreground">{filtered.length}/{events.length} events</span>
        </div>
      )}

      {/* Body */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-auto p-3 bg-background"
        style={{ minHeight: embedded ? 320 : undefined }}
      >
        {loading && <div className="text-muted-foreground px-2 py-1 text-xs">Đang tải logs...</div>}
        {error && <div className="text-red-600 dark:text-red-300 px-2 py-1 text-xs">Lỗi: {error}</div>}
        {!loading && !error && !jobId && (
          <div className="text-muted-foreground px-3 py-8 text-center text-xs">
            Chưa chọn job. Chọn từ dropdown ở trên hoặc bấm "Tạo" để sinh content — job mới sẽ hiện ở đây.
          </div>
        )}

        {/* Inputs panel — always visible when a job is loaded */}
        {!loading && !error && currentJob && <InputsPanel job={currentJob} />}

        {!loading && !error && jobId && filtered.length === 0 && (
          <div className="text-muted-foreground px-3 py-8 text-center text-xs italic">
            Job này chưa có log entry nào (batch_processor có thể chưa support write_job_log cho job_type này).
          </div>
        )}
        {filtered.map((ev, i) => (
          <StageCard
            key={i}
            event={ev}
            defaultOpen={i === filtered.length - 1 || ev.level === 'error' || ev.level === 'warn' || ev.stage === 'prompt-build'}
          />
        ))}

        {/* Output preview — same pretty treatment as Inputs */}
        {!loading && !error && currentJob?.output_data && (
          <OutputPanel output={currentJob.output_data} />
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-1.5 border-t border-border text-[10px] text-muted-foreground bg-card flex justify-between items-center">
        <span>{filtered.length} / {events.length} events</span>
        <span>{isLive ? '● Job đang chạy — auto-refresh SSE' : 'Snapshot (history)'}</span>
      </div>
    </>
  );
}

// ────────────────────────── Wrapper ──────────────────────────
export default function JobLogViewerPanel({
  mode = 'inline',
  selectedJobId,
  onSelectJob,
  jobId,
  open = true,
  onClose,
}) {
  const [recentJobs, setRecentJobs] = useState([]);

  useEffect(() => {
    if (mode !== 'inline') return;
    let mounted = true;
    const loadRecent = async () => {
      try {
        const r = await fetch('/api/ops/content-pipeline/jobs/recent?limit=20');
        const data = await r.json();
        if (mounted) setRecentJobs(data.jobs || []);
      } catch {}
    };
    loadRecent();
    const interval = setInterval(loadRecent, 10000);
    return () => { mounted = false; clearInterval(interval); };
  }, [mode]);

  const [modalJob, setModalJob] = useState(null);
  useEffect(() => {
    if (mode !== 'modal' || !jobId) { setModalJob(null); return; }
    let cancelled = false;
    fetch(`/api/ops/content-pipeline/jobs/${jobId}/logs`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setModalJob(d.job); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [mode, jobId]);

  if (mode === 'modal') {
    if (!open || !jobId) return null;
    return (
      <div
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] flex items-center justify-center p-4"
        onClick={onClose}
      >
        <div
          className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-5xl flex flex-col overflow-hidden"
          style={{ height: '88vh' }}
          onClick={(e) => e.stopPropagation()}
        >
          <JobMetaHeader
            job={modalJob}
            isLive={modalJob?.status === 'queued' || modalJob?.status === 'processing'}
            onClose={onClose}
          />
          <JobLogBody jobId={jobId} recentJobs={null} onSelectJob={null} embedded={false} />
        </div>
      </div>
    );
  }

  return (
    <div className="border border-border rounded-xl bg-card overflow-hidden flex flex-col" style={{ minHeight: 420 }}>
      <div className="px-4 py-2 bg-card border-b border-border flex items-center gap-2">
        <span className="text-base">📜</span>
        <h2 className="text-sm font-semibold text-foreground">Job Log Viewer</h2>
        <span className="text-[10px] text-muted-foreground">batch_processor + AI generation transcript</span>
      </div>
      <JobLogBody jobId={selectedJobId} recentJobs={recentJobs} onSelectJob={onSelectJob} embedded={true} />
    </div>
  );
}
