import { useMemo, useState } from "react";
import { Link, useNavigate } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AGENT_ROLE_LABELS, type Agent, type AgentRole, type Issue } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { invalidateAgentRuntimeQueries } from "../api/fleet";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import type { TranscriptEntry } from "../adapters";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { ExternalLink, Pause, Play } from "lucide-react";
import { Identity } from "./Identity";
import { RunTranscriptView } from "./transcript/RunTranscriptView";
import { useLiveRunTranscripts } from "./transcript/useLiveRunTranscripts";

// Server caps minCount at 20; 12 keeps enough finished runs for the Lỗi / Xong filters.
const MIN_DASHBOARD_RUNS = 12;

// "Live" = đang chạy thật. `queued` = đang xếp hàng chờ chỗ (fleet-throttle) — KHÔNG phải live.
function isRunActive(run: LiveRunForIssue): boolean {
  return run.status === "running";
}

const RUN_FILTERS = [
  { id: "all", label: "Tất cả", match: () => true },
  { id: "running", label: "Đang chạy", match: (s: string) => s === "running" },
  { id: "queued", label: "Xếp hàng", match: (s: string) => s === "queued" },
  { id: "failed", label: "Lỗi", match: (s: string) => s === "failed" || s === "timed_out" },
  { id: "done", label: "Xong", match: (s: string) => s === "succeeded" || s === "cancelled" },
] as const;
type RunFilterId = (typeof RUN_FILTERS)[number]["id"];

function roleLabel(agent: Agent | undefined): string {
  if (!agent) return "Khác";
  return AGENT_ROLE_LABELS[agent.role as AgentRole] ?? agent.role ?? "Khác";
}

interface ActiveAgentsPanelProps {
  companyId: string;
}

export function ActiveAgentsPanel({ companyId }: ActiveAgentsPanelProps) {
  const [filter, setFilter] = useState<RunFilterId>("all");
  const [groupByRole, setGroupByRole] = useState(false);

  const { data: liveRuns } = useQuery({
    queryKey: [...queryKeys.liveRuns(companyId), "dashboard"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId, MIN_DASHBOARD_RUNS),
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  const agentById = useMemo(() => new Map((agents ?? []).map((a) => [a.id, a])), [agents]);

  const allRuns = liveRuns ?? [];
  const counts = useMemo(() => {
    const map = new Map<RunFilterId, number>();
    for (const f of RUN_FILTERS) map.set(f.id, allRuns.filter((r) => f.match(r.status)).length);
    return map;
  }, [allRuns]);
  const activeFilter = RUN_FILTERS.find((f) => f.id === filter) ?? RUN_FILTERS[0];
  const runs = allRuns.filter((r) => activeFilter.match(r.status));

  const groups = useMemo(() => {
    if (!groupByRole) return [{ label: null as string | null, runs }];
    const map = new Map<string, LiveRunForIssue[]>();
    for (const run of runs) {
      const label = roleLabel(agentById.get(run.agentId));
      map.set(label, [...(map.get(label) ?? []), run]);
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], "vi"))
      .map(([label, groupRuns]) => ({ label: label as string | null, runs: groupRuns }));
  }, [groupByRole, runs, agentById]);
  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(companyId),
    queryFn: () => issuesApi.list(companyId),
    enabled: runs.length > 0,
  });

  const issueById = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const issue of issues ?? []) {
      map.set(issue.id, issue);
    }
    return map;
  }, [issues]);

  const { transcriptByRun, hasOutputForRun } = useLiveRunTranscripts({
    runs,
    companyId,
    maxChunksPerRun: 120,
  });

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Agents</h3>
        <div className="flex flex-wrap items-center gap-1.5">
          {RUN_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-xs tabular-nums transition-colors",
                filter === f.id
                  ? "border-foreground/30 bg-accent text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {f.label} {counts.get(f.id) ?? 0}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setGroupByRole((v) => !v)}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
              groupByRole ? "border-foreground/30 bg-accent text-foreground" : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            Nhóm theo vai trò
          </button>
        </div>
      </div>
      {runs.length === 0 ? (
        <div className="rounded-xl border border-border p-4">
          <p className="text-sm text-muted-foreground">
            {allRuns.length === 0 ? "No recent agent runs." : `Không có lượt nào ở mục "${activeFilter.label}".`}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <div key={group.label ?? "all"}>
              {group.label && (
                <p className="mb-2 text-xs font-medium text-muted-foreground">
                  {group.label} · {group.runs.length}
                </p>
              )}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
                {group.runs.map((run) => (
                  <AgentRunCard
                    key={run.id}
                    run={run}
                    agent={agentById.get(run.agentId)}
                    companyId={companyId}
                    issue={run.issueId ? issueById.get(run.issueId) : undefined}
                    transcript={transcriptByRun.get(run.id) ?? []}
                    hasOutput={hasOutputForRun(run.id)}
                    isActive={isRunActive(run)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AgentPauseToggle({ agent, companyId }: { agent: Agent; companyId: string }) {
  const queryClient = useQueryClient();
  const paused = agent.status === "paused";
  const mutation = useMutation({
    mutationFn: () => (paused ? agentsApi.resume(agent.id, companyId) : agentsApi.pause(agent.id, companyId)),
    onSuccess: () => invalidateAgentRuntimeQueries(queryClient),
  });
  if (agent.status === "terminated" || agent.status === "pending_approval") return null;
  const label = paused ? `Chạy lại ${agent.name}` : `Tạm dừng ${agent.name}`;
  return (
    <button
      type="button"
      title={mutation.isError ? "Không thực hiện được, bấm thử lại" : label}
      aria-label={label}
      disabled={mutation.isPending}
      onClick={(e) => {
        e.stopPropagation();
        mutation.mutate();
      }}
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-1 text-[10px] transition-colors disabled:opacity-50",
        mutation.isError
          ? "border-red-500/40 text-red-600 dark:text-red-400"
          : paused
            ? "border-amber-500/40 text-amber-600 hover:bg-amber-500/10 dark:text-amber-400"
            : "border-border/70 bg-background/70 text-muted-foreground hover:text-foreground",
      )}
    >
      {paused ? <Play className="h-2.5 w-2.5" /> : <Pause className="h-2.5 w-2.5" />}
    </button>
  );
}

function AgentRunCard({
  run,
  agent,
  companyId,
  issue,
  transcript,
  hasOutput,
  isActive,
}: {
  run: LiveRunForIssue;
  agent?: Agent;
  companyId: string;
  issue?: Issue;
  transcript: TranscriptEntry[];
  hasOutput: boolean;
  isActive: boolean;
}) {
  const navigate = useNavigate();
  const cardLink = run.issueId
    ? `/issues/${issue?.identifier ?? run.issueId}`
    : `/agents/${run.agentId}`;

  return (
    <div
      className={cn(
        "flex h-[320px] flex-col overflow-hidden rounded-xl border shadow-sm cursor-pointer transition-colors",
        isActive
          ? "border-cyan-500/25 bg-cyan-500/[0.04] shadow-[0_16px_40px_rgba(6,182,212,0.08)] hover:bg-cyan-500/[0.07]"
          : "border-border bg-background/70 hover:bg-accent/30",
      )}
      onClick={() => navigate(cardLink)}
    >
      <div className="border-b border-border/60 px-3 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {isActive ? (
                <span className="relative flex h-2.5 w-2.5 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-70" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-cyan-500" />
                </span>
              ) : (
                <span className="inline-flex h-2.5 w-2.5 rounded-full bg-muted-foreground/35" />
              )}
              <Identity name={run.agentName} size="sm" className="[&>span:last-child]:!text-[11px]" />
            </div>
            <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>{isActive ? "Live now" : run.status === "queued" ? `Queued ${relativeTime(run.createdAt)}` : run.finishedAt ? `Finished ${relativeTime(run.finishedAt)}` : `Started ${relativeTime(run.createdAt)}`}</span>
              {!isActive && run.status && (
                <span className={cn(
                  "px-1.5 py-[1px] rounded text-[9px] font-medium uppercase tracking-wider",
                  run.status === "succeeded" || run.status === "success" || run.status === "completed" ? "bg-green-500/10 text-green-600 dark:text-green-400" :
                  run.status === "failed" || run.status === "timed_out" || run.status === "error" ? "bg-red-500/10 text-red-600 dark:text-red-400" :
                  run.status === "cancelled" || run.status === "queued" ? "bg-amber-500/10 text-amber-600 dark:text-amber-400" :
                  "bg-muted text-muted-foreground"
                )}>
                  {run.status}
                </span>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {agent && <AgentPauseToggle agent={agent} companyId={companyId} />}
            <Link
              to={`/agents/${run.agentId}`}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <ExternalLink className="h-2.5 w-2.5" />
            </Link>
          </div>
        </div>

        {run.issueId && (
          <div className="mt-3 rounded-lg border border-border/60 bg-background/60 px-2.5 py-2 text-xs">
            <Link
              to={`/issues/${issue?.identifier ?? run.issueId}`}
              className={cn(
                "line-clamp-2 hover:underline",
                isActive ? "text-cyan-700 dark:text-cyan-300" : "text-muted-foreground hover:text-foreground",
              )}
              title={issue?.title ? `${issue?.identifier ?? run.issueId.slice(0, 8)} - ${issue.title}` : issue?.identifier ?? run.issueId.slice(0, 8)}
            >
              {issue?.identifier ?? run.issueId.slice(0, 8)}
              {issue?.title ? ` - ${issue.title}` : ""}
            </Link>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <RunTranscriptView
          entries={transcript}
          density="compact"
          limit={5}
          streaming={isActive}
          collapseStdout
          thinkingClassName="!text-[10px] !leading-4"
          emptyMessage={hasOutput ? "Waiting for transcript parsing..." : isActive ? "Waiting for output..." : run.status === "queued" ? "Queued — waiting for a free run slot." : "No transcript captured."}
        />
      </div>
    </div>
  );
}
