// Training History — list tất cả training sessions với rubric chart trend.
//
// Layout:
//   ┌──────────────────────────────────────────────────────────┐
//   │  Trend chart: average score per session (sparkline)      │
//   ├──────────────────────────────────────────────────────────┤
//   │  Sessions table: scenario | agent | status | score | ts  │
//   ├──────────────────────────────────────────────────────────┤
//   │  Detail panel (when row clicked): full rubric breakdown  │
//   └──────────────────────────────────────────────────────────┘

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  History,
  Star,
  TrendingUp,
  CheckCircle,
  XCircle,
  Loader2,
  ChevronRight,
} from "lucide-react";
import {
  trainingApi,
  type TrainingSession,
  type TrainingScore,
} from "@/api/training";

const RUBRIC_LABELS: Record<string, string> = {
  language_correctness: "Tiếng Việt có dấu",
  tone_alignment: "Tone sales closer",
  hallucination_free: "Không bịa info/marker",
  marker_compliance: "SEND_MEDIA + CALL đúng",
  factual_accuracy: "Giá / khóa đúng",
  empathy: "Đồng cảm khách",
  actionability: "Đề xuất bước rõ",
  brand_voice_jennie: "Brand voice Jennie",
  escalation_correctness: "Escalate đúng lúc",
  conciseness: "Ngắn gọn 2-4 câu",
};

function formatDate(d: string): string {
  if (!d) return "—";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function scoreColor(score: number): string {
  if (score >= 90) return "text-emerald-700 dark:text-emerald-400";
  if (score >= 75) return "text-cyan-700 dark:text-cyan-400";
  if (score >= 60) return "text-amber-700 dark:text-amber-400";
  return "text-red-700 dark:text-red-400";
}

function scoreBarColor(score: number): string {
  if (score >= 90) return "bg-emerald-600 dark:bg-emerald-400";
  if (score >= 75) return "bg-cyan-600 dark:bg-cyan-400";
  if (score >= 60) return "bg-amber-500 dark:bg-amber-400";
  return "bg-red-600 dark:bg-red-400";
}

export function TrainingHistoryPage() {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  const {
    data: sessions = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["training", "history-sessions"],
    queryFn: () => trainingApi.listSessions(100),
    refetchInterval: 10_000,
  });

  const {
    data: selectedScores = [],
    isLoading: isScoresLoading,
    isError: isScoresError,
    error: scoresError,
    refetch: refetchScores,
  } = useQuery({
    queryKey: ["training", "scores", selectedSessionId],
    queryFn: () => trainingApi.getScores(selectedSessionId!),
    enabled: !!selectedSessionId,
  });

  // Build sparkline data: last 30 sessions with completed status + opus_score
  const trendData = useMemo(() => {
    const completed = sessions
      .filter((s) => s.status === "completed" && typeof s.opus_score === "number")
      .slice(0, 30)
      .reverse();
    return completed;
  }, [sessions]);

  const avgScore = useMemo(() => {
    if (trendData.length === 0) return 0;
    return Math.round(
      trendData.reduce((sum, s) => sum + (s.opus_score || 0), 0) / trendData.length,
    );
  }, [trendData]);

  return (
    <div className="min-h-[calc(100vh-48px)] bg-background p-4 sm:p-5 text-foreground">
      {/* Header */}
      <div className="mb-4">
        <h1 className="text-[20px] font-bold text-foreground mb-1">Lịch sử Training</h1>
        <p className="text-[12px] text-muted-foreground">
          Tất cả training session đã chạy. Mỗi session được Opus 4.6 chấm 10 tiêu chí.
          Click 1 row để xem chi tiết feedback per criterion.
        </p>
      </div>

      {/* Stats + trend chart */}
      <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-3 mb-4">
        {/* Avg score card */}
        <div className="rounded-xl border border-border bg-card p-3.5 text-center">
          <Star size={20} className="mx-auto mb-1.5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
          <div className={`text-[22px] font-bold tabular-nums ${scoreColor(avgScore)}`}>{avgScore}</div>
          <div className="text-[11px] text-muted-foreground mt-0.5 tabular-nums">
            Avg score ({trendData.length} session)
          </div>
        </div>

        {/* Sparkline trend */}
        <div className="rounded-xl border border-border bg-card p-3.5">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp size={14} className="text-cyan-700 dark:text-cyan-400" aria-hidden="true" />
            <span className="text-[12px] font-semibold text-foreground">Trend score qua thời gian</span>
          </div>
          <Sparkline data={trendData.map((s) => s.opus_score || 0)} />
        </div>
      </div>

      {/* Sessions table + detail panel */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-3">
        {/* Table */}
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr>
                <th scope="col" className="text-left p-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border whitespace-nowrap">
                  Scenario
                </th>
                <th scope="col" className="text-left p-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border whitespace-nowrap">
                  Agent
                </th>
                <th scope="col" className="text-center p-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border">
                  Status
                </th>
                <th scope="col" className="text-center p-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border">
                  Turns
                </th>
                <th scope="col" className="text-right p-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border">
                  Score
                </th>
                <th scope="col" className="text-left p-2.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border whitespace-nowrap">
                  Bắt đầu
                </th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={6} className="text-center py-10 text-muted-foreground">
                    Đang tải...
                  </td>
                </tr>
              )}
              {!isLoading && isError && (
                <tr>
                  <td colSpan={6} className="text-center py-10 px-4">
                    <div role="alert" className="inline-flex flex-col items-center gap-2 text-sm text-destructive">
                      <span>Không thể tải lịch sử training: {(error as Error)?.message || "Lỗi kết nối"}</span>
                      <button
                        type="button"
                        onClick={() => refetch()}
                        className="min-h-[36px] rounded-md border border-destructive/40 px-3 py-1.5 text-xs font-medium hover:bg-destructive/10 cursor-pointer"
                      >
                        Thử lại
                      </button>
                    </div>
                  </td>
                </tr>
              )}
              {!isLoading && !isError && sessions.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center py-10">
                    <History size={32} className="mx-auto mb-2 text-muted-foreground/30" aria-hidden="true" />
                    <div className="text-[14px] text-muted-foreground">Chưa có session nào</div>
                  </td>
                </tr>
              )}
              {sessions.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  active={s.id === selectedSessionId}
                  onClick={() => setSelectedSessionId(s.id)}
                />
              ))}
            </tbody>
          </table>
        </div>

        {/* Detail panel */}
        <div className="rounded-xl border border-border bg-card p-3.5 lg:sticky lg:top-3 self-start max-h-[calc(100vh-100px)] overflow-y-auto">
          {!selectedSessionId ? (
            <div className="text-center py-10">
              <Star size={32} className="mx-auto mb-2 text-muted-foreground/30" aria-hidden="true" />
              <div className="text-[12px] text-muted-foreground">Chọn 1 session để xem rubric chi tiết</div>
            </div>
          ) : isScoresLoading ? (
            <div className="text-center py-10">
              <Loader2 size={20} className="mx-auto mb-2 text-muted-foreground animate-spin" aria-hidden="true" />
              <div className="text-[11px] text-muted-foreground">Đang tải điểm số...</div>
            </div>
          ) : isScoresError ? (
            <div className="text-center py-10 px-2">
              <div role="alert" className="inline-flex flex-col items-center gap-2 text-xs text-destructive">
                <span>Không thể tải điểm số: {(scoresError as Error)?.message || "Lỗi kết nối"}</span>
                <button
                  type="button"
                  onClick={() => refetchScores()}
                  className="min-h-[36px] rounded-md border border-destructive/40 px-3 py-1.5 text-xs font-medium hover:bg-destructive/10 cursor-pointer"
                >
                  Thử lại
                </button>
              </div>
            </div>
          ) : selectedScores.length === 0 ? (
            <div className="text-center py-10">
              <Star size={24} className="mx-auto mb-2 text-muted-foreground/30" aria-hidden="true" />
              <div className="text-[11px] text-muted-foreground">
                Chưa có điểm số (hoặc Opus chưa review xong)
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2 mb-3 pb-2 border-b border-border">
                <Star size={14} className="text-amber-600 dark:text-amber-400" aria-hidden="true" />
                <h3 className="text-[13px] font-bold text-foreground">Rubric chi tiết</h3>
              </div>
              <div className="space-y-2">
                {selectedScores.map((score) => (
                  <RubricDetail key={score.rubric_key} score={score} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

interface SessionRowProps {
  session: TrainingSession;
  active: boolean;
  onClick: () => void;
}

function SessionRow({ session, active, onClick }: SessionRowProps) {
  const statusBadge =
    session.status === "completed"
      ? { color: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400", icon: <CheckCircle size={10} aria-hidden="true" /> }
      : session.status === "running"
        ? { color: "bg-amber-500/12 text-amber-700 dark:text-amber-400", icon: <Loader2 size={10} className="animate-spin" aria-hidden="true" /> }
        : session.status === "reviewing"
          ? { color: "bg-indigo-500/12 text-indigo-700 dark:text-indigo-300", icon: <Loader2 size={10} className="animate-spin" aria-hidden="true" /> }
          : { color: "bg-red-500/12 text-red-700 dark:text-red-400", icon: <XCircle size={10} aria-hidden="true" /> };

  return (
    <tr
      onClick={onClick}
      tabIndex={0}
      aria-selected={active}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={`cursor-pointer hover:[&>td]:bg-muted/40 focus-visible:outline-none focus-visible:[&>td]:bg-muted/50 ${
        active ? "[&>td]:bg-amber-500/10" : ""
      }`}
    >
      <td className="p-2.5 border-b border-border/50 align-middle">
        <div className="flex items-center gap-1.5">
          {active && <ChevronRight size={12} className="text-amber-600 dark:text-amber-400 flex-shrink-0" aria-hidden="true" />}
          <span className="text-[12px] font-semibold text-foreground truncate">
            {(session.scenario_focus || "—").slice(0, 40)}
          </span>
        </div>
      </td>
      <td className="p-2.5 border-b border-border/50 align-middle whitespace-nowrap">
        <span className="inline-flex items-center h-[22px] px-2 text-[10px] font-semibold rounded bg-indigo-500/10 text-indigo-700 dark:text-indigo-300">
          {session.agent_slug}
        </span>
      </td>
      <td className="p-2.5 border-b border-border/50 align-middle text-center">
        <span
          className={`inline-flex items-center gap-1 h-[22px] px-2 text-[10px] font-bold rounded uppercase ${statusBadge.color}`}
        >
          {statusBadge.icon}
          {session.status}
        </span>
      </td>
      <td className="p-2.5 border-b border-border/50 align-middle text-center text-[11px] text-muted-foreground tabular-nums">
        {session.total_turns ?? 0}/{session.max_turns ?? 10}
      </td>
      <td className="p-2.5 border-b border-border/50 align-middle text-right">
        {session.opus_score !== null ? (
          <span className={`text-[14px] font-bold tabular-nums ${scoreColor(session.opus_score)}`}>
            {session.opus_score}
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground/60">—</span>
        )}
      </td>
      <td className="p-2.5 border-b border-border/50 align-middle text-[11px] text-muted-foreground whitespace-nowrap tabular-nums">
        {formatDate(session.started_at)}
      </td>
    </tr>
  );
}

interface RubricDetailProps {
  score: TrainingScore;
}

function RubricDetail({ score }: RubricDetailProps) {
  const label = RUBRIC_LABELS[score.rubric_key] || score.rubric_key;
  const pct = Math.min(Math.max(score.score_0_100, 0), 100);
  return (
    <div className="bg-muted/40 border border-border/50 rounded-md p-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] font-semibold text-foreground">{label}</span>
        <span className={`text-[12px] font-bold tabular-nums ${scoreColor(score.score_0_100)}`}>
          {score.score_0_100}
        </span>
      </div>
      <div className="w-full h-1 bg-muted rounded overflow-hidden mb-1.5">
        <div
          className={`h-full ${scoreBarColor(score.score_0_100)} transition-all`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {score.opus_feedback && (
        <div className="text-[10px] text-muted-foreground leading-relaxed">{score.opus_feedback}</div>
      )}
    </div>
  );
}

interface SparklineProps {
  data: number[];
}

function Sparkline({ data }: SparklineProps) {
  if (data.length === 0) {
    return (
      <div className="h-16 flex items-center justify-center text-[11px] text-muted-foreground">
        (chưa có dữ liệu)
      </div>
    );
  }

  const max = 100;
  const min = 0;
  const width = 100;
  const height = 100;
  const step = data.length > 1 ? width / (data.length - 1) : width;

  const points = data
    .map((value, i) => {
      const x = i * step;
      const y = height - ((value - min) / (max - min)) * height;
      return `${x},${y}`;
    })
    .join(" ");

  const latest = data[data.length - 1] || 0;

  return (
    <div className="relative h-16">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className={`w-full h-full ${scoreColor(latest)}`}
        role="img"
        aria-label="Biểu đồ xu hướng điểm số"
      >
        {/* Threshold line at 75 (pass) */}
        <line
          x1="0"
          y1={height - ((75 - min) / (max - min)) * height}
          x2={width}
          y2={height - ((75 - min) / (max - min)) * height}
          stroke="currentColor"
          className="text-border"
          strokeWidth="0.5"
          strokeDasharray="2,2"
        />
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
        {data.map((value, i) => {
          const x = i * step;
          const y = height - ((value - min) / (max - min)) * height;
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r="1.2"
              fill="currentColor"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>
    </div>
  );
}
