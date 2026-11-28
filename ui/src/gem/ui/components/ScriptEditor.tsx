'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Save, Copy, Check, Clock, FileText, AlertCircle } from 'lucide-react';

// ============================================================================
// Script Editor — Rich textarea with live metrics
// ============================================================================

interface ScriptEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minWords?: number;
  maxWords?: number;
  wordsPerMinute?: number;
  autoSave?: boolean;
  autoSaveInterval?: number;
  onSave?: (content: string) => void;
  readOnly?: boolean;
  className?: string;
}

interface SectionInfo {
  title: string;
  wordCount: number;
  startLine: number;
}

function countWords(text: string): number {
  const cleaned = text
    .replace(/#{1,6}\s/g, '')
    .replace(/[*_~`]/g, '')
    .replace(/\[.*?\]\(.*?\)/g, '')
    .trim();

  if (!cleaned) return 0;
  return cleaned.split(/\s+/).filter(Boolean).length;
}

function extractSections(text: string): SectionInfo[] {
  const lines = text.split('\n');
  const sections: SectionInfo[] = [];
  let currentTitle = '';
  let currentContent = '';
  let currentStartLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const headerMatch = line.match(/^#{1,3}\s+(.+)/);

    if (headerMatch) {
      if (currentTitle) {
        sections.push({
          title: currentTitle,
          wordCount: countWords(currentContent),
          startLine: currentStartLine,
        });
      }
      currentTitle = headerMatch[1] ?? '';
      currentContent = '';
      currentStartLine = i + 1;
    } else {
      currentContent += line + '\n';
    }
  }

  if (currentTitle) {
    sections.push({
      title: currentTitle,
      wordCount: countWords(currentContent),
      startLine: currentStartLine,
    });
  }

  return sections;
}

export function ScriptEditor({
  value,
  onChange,
  placeholder = 'Bắt đầu viết kịch bản...',
  minWords,
  maxWords,
  wordsPerMinute = 150,
  autoSave = false,
  autoSaveInterval = 30000,
  onSave,
  readOnly = false,
  className = '',
}: ScriptEditorProps): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const wordCount = countWords(value);
  const sections = extractSections(value);
  const duration = Math.round((wordCount / wordsPerMinute) * 60);
  const durationMinutes = Math.floor(duration / 60);
  const durationSeconds = duration % 60;

  const isUnderMin = minWords !== undefined && wordCount < minWords;
  const isOverMax = maxWords !== undefined && wordCount > maxWords;

  // Auto-save
  useEffect(() => {
    if (!autoSave || !onSave) return;

    saveTimerRef.current = setInterval(() => {
      if (isDirty) {
        onSave(value);
        setLastSaved(new Date());
        setIsDirty(false);
      }
    }, autoSaveInterval);

    return () => {
      if (saveTimerRef.current) clearInterval(saveTimerRef.current);
    };
  }, [autoSave, autoSaveInterval, isDirty, onSave, value]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value);
      setIsDirty(true);
    },
    [onChange],
  );

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [value]);

  const handleManualSave = useCallback(() => {
    if (onSave) {
      onSave(value);
      setLastSaved(new Date());
      setIsDirty(false);
    }
  }, [onSave, value]);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = `${Math.max(400, ta.scrollHeight)}px`;
    }
  }, [value]);

  return (
    <div className={`space-y-3 ${className}`}>
      {/* Toolbar */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        {/* Word count & duration */}
        <div className="flex items-center gap-4 text-xs text-txt-3">
          <span className="flex items-center gap-1">
            <FileText size={14} />
            <span
              className={
                isUnderMin ? 'text-amber-700 dark:text-amber-400' : isOverMax ? 'text-danger' : 'text-txt-2'
              }
            >
              {wordCount.toLocaleString('vi-VN')} từ
            </span>
            {minWords !== undefined && maxWords !== undefined && (
              <span className="text-txt-3">
                ({minWords.toLocaleString('vi-VN')}-{maxWords.toLocaleString('vi-VN')})
              </span>
            )}
          </span>
          <span className="flex items-center gap-1">
            <Clock size={14} />
            ~{durationMinutes} phút {durationSeconds > 0 ? `${durationSeconds} giây` : ''}
          </span>
          {sections.length > 0 && (
            <span>{sections.length} phần</span>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {autoSave && lastSaved && (
            <span className="text-xxs text-txt-3">
              Đã lưu {lastSaved.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          {isDirty && (
            <span className="text-xxs text-amber-700 dark:text-amber-400 flex items-center gap-1">
              <AlertCircle size={10} />
              Chưa lưu
            </span>
          )}
          {onSave && (
            <button
              onClick={handleManualSave}
              className="btn btn-o text-xs px-3 py-1"
              title="Lưu (Ctrl+S)"
            >
              <Save size={14} />
            </button>
          )}
          <button
            onClick={handleCopy}
            className="btn btn-o text-xs px-3 py-1"
            title="Sao chép"
          >
            {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
          </button>
        </div>
      </div>

      {/* Word count warnings */}
      {isUnderMin && (
        <div className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1 p-2 rounded-card bg-amber-400/10">
          <AlertCircle size={14} />
          Kịch bản quá ngắn ({wordCount}/{minWords} từ)
        </div>
      )}
      {isOverMax && (
        <div className="text-xs text-danger flex items-center gap-1 p-2 rounded-card bg-danger/10">
          <AlertCircle size={14} />
          Kịch bản quá dài ({wordCount}/{maxWords} từ)
        </div>
      )}

      {/* Textarea */}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
        readOnly={readOnly}
        className="ft w-full min-h-[400px] font-mono text-sm leading-relaxed resize-none"
        spellCheck={false}
      />

      {/* Section breakdown */}
      {sections.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {sections.map((section, i) => (
            <div
              key={`${section.title}-${i}`}
              className="text-xxs px-2 py-1 rounded-badge bg-bg-3 text-txt-3 flex items-center gap-1"
            >
              <span className="text-txt-2 font-medium">
                {section.title.length > 20
                  ? `${section.title.substring(0, 20)}...`
                  : section.title}
              </span>
              <span className="text-txt-3">{section.wordCount} từ</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
