'use client';

import React from 'react';
import { Shield, AlertTriangle, CheckCircle, XCircle, ChevronDown, ChevronUp } from 'lucide-react';

// ============================================================================
// Brand Voice Score Gauge + Violation List
// ============================================================================

interface Violation {
  type: string;
  term?: string;
  replacement?: string | null;
  count?: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
  suggestion: string;
  lineNumber?: number;
  excerpt?: string;
}

interface BrandVoiceScoreProps {
  score: number;
  violations: Violation[];
  passed: boolean;
  wordCount?: number;
  sectionCount?: number;
  compact?: boolean;
  onAutoFix?: () => void;
}

const severityColors: Record<string, string> = {
  critical: 'text-danger',
  high: 'text-amber-700 dark:text-amber-400',
  medium: 'text-yellow-700 dark:text-yellow-400',
  low: 'text-txt-3',
};

const severityLabels: Record<string, string> = {
  critical: 'Nghiêm trọng',
  high: 'Cao',
  medium: 'Trung bình',
  low: 'Thấp',
};

function getScoreColor(score: number): string {
  if (score >= 90) return 'text-success';
  if (score >= 70) return 'text-amber-700 dark:text-amber-400';
  if (score >= 50) return 'text-yellow-700 dark:text-yellow-400';
  return 'text-danger';
}

function getScoreLabel(score: number): string {
  if (score >= 90) return 'Xuất sắc';
  if (score >= 70) return 'Tốt';
  if (score >= 50) return 'Cần cải thiện';
  return 'Không đạt';
}

function getScoreTrackColor(score: number): string {
  if (score >= 90) return 'bg-success';
  if (score >= 70) return 'bg-amber-400';
  if (score >= 50) return 'bg-yellow-400';
  return 'bg-danger';
}

export function BrandVoiceScore({
  score,
  violations,
  passed,
  wordCount,
  sectionCount,
  compact = false,
  onAutoFix,
}: BrandVoiceScoreProps): React.JSX.Element {
  const [expanded, setExpanded] = React.useState(!compact);

  const criticalCount = violations.filter(v => v.severity === 'critical').length;
  const autoFixable = violations.filter(v => v.type === 'forbidden_term' || v.type === 'english_term').length;

  return (
    <div className="card p-4 space-y-3">
      {/* Score Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield size={18} className={getScoreColor(score)} />
          <span className="text-sm font-semibold text-txt">Brand Voice</span>
        </div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-txt-3 hover:text-txt transition-button"
        >
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
      </div>

      {/* Score Gauge */}
      <div className="flex items-center gap-3">
        <div className={`text-3xl font-heading font-bold ${getScoreColor(score)}`}>
          {score}
        </div>
        <div className="flex-1">
          <div className="flex items-center justify-between mb-1">
            <span className={`text-xs font-medium ${getScoreColor(score)}`}>
              {getScoreLabel(score)}
            </span>
            <span className="text-xxs text-txt-3">/100</span>
          </div>
          <div className="w-full h-2 bg-bg-4 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${getScoreTrackColor(score)}`}
              style={{ width: `${score}%` }}
            />
          </div>
        </div>
      </div>

      {/* Status */}
      <div className="flex items-center gap-2">
        {passed ? (
          <>
            <CheckCircle size={14} className="text-success" />
            <span className="text-xs text-success">Đạt yêu cầu Brand Voice</span>
          </>
        ) : (
          <>
            <XCircle size={14} className="text-danger" />
            <span className="text-xs text-danger">
              {criticalCount} lỗi nghiêm trọng cần sửa
            </span>
          </>
        )}
      </div>

      {/* Quick Stats */}
      {(wordCount !== undefined || sectionCount !== undefined) && (
        <div className="flex gap-4 text-xxs text-txt-3">
          {wordCount !== undefined && (
            <span>{wordCount.toLocaleString('vi-VN')} từ</span>
          )}
          {sectionCount !== undefined && (
            <span>{sectionCount} phần</span>
          )}
          {violations.length > 0 && (
            <span>{violations.length} cảnh báo</span>
          )}
        </div>
      )}

      {/* Expanded: Violation List */}
      {expanded && violations.length > 0 && (
        <div className="space-y-2 pt-2 border-t border-border">
          {/* Auto-fix button */}
          {autoFixable > 0 && onAutoFix && (
            <button
              onClick={onAutoFix}
              className="btn btn-o text-xs w-full"
            >
              Tự động sửa {autoFixable} lỗi
            </button>
          )}

          {/* Violation items */}
          {violations.map((v, i) => (
            <div
              key={`${v.type}-${i}`}
              className="flex items-start gap-2 p-2 rounded-card bg-bg-3"
            >
              <AlertTriangle
                size={14}
                className={`mt-0.5 shrink-0 ${severityColors[v.severity]}`}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className={`text-xxs font-medium ${severityColors[v.severity]}`}>
                    {severityLabels[v.severity]}
                  </span>
                  {v.term && (
                    <code className="text-xxs bg-bg-4 px-1 rounded text-danger">
                      {v.term}
                    </code>
                  )}
                </div>
                <p className="text-xs text-txt-2">{v.message}</p>
                {v.suggestion && (
                  <p className="text-xxs text-txt-3 mt-0.5">
                    Gợi ý: {v.suggestion}
                  </p>
                )}
                {v.replacement && (
                  <p className="text-xxs text-success mt-0.5">
                    Thay thế: <code className="bg-bg-4 px-1 rounded">{v.replacement}</code>
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {expanded && violations.length === 0 && (
        <div className="text-center py-3 text-xs text-txt-3">
          Không có vi phạm nào
        </div>
      )}
    </div>
  );
}
