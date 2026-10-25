import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { AlertTriangle } from "lucide-react";
import type { Agent, HeartbeatRunSummary } from "@paperclipai/shared";
import { heartbeatsApi } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { relativeTime } from "../lib/utils";

const STUCK_QUEUE_MS = 30 * 60 * 1000;

interface AttentionItem {
  key: string;
  label: string;
  detail: string;
  to: string;
}

/** Latest run per agent: a quota failure only matters while it is the agent's last word. */
function latestRunByAgent(runs: HeartbeatRunSummary[]) {
  const map = new Map<string, HeartbeatRunSummary>();
  for (const run of runs) {
    const prev = map.get(run.agentId);
    if (!prev || new Date(run.createdAt) > new Date(prev.createdAt)) map.set(run.agentId, run);
  }
  return map;
}

/**
 * "Cần chú ý" — agents in error, runs stuck in the queue > 30 min, agents whose last
 * run died on provider quota. Each row links straight to the agent / run. Hidden when empty.
 */
export function AttentionStrip({
  companyId,
  agents,
  runs,
}: {
  companyId: string;
  agents: Agent[] | undefined;
  runs: HeartbeatRunSummary[] | undefined;
}) {
  const { data: liveRuns } = useQuery({
    queryKey: [...queryKeys.liveRuns(companyId), "attention"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
    refetchInterval: 30_000,
  });

  const items = useMemo<AttentionItem[]>(() => {
    const out: AttentionItem[] = [];
    const agentById = new Map((agents ?? []).map((a) => [a.id, a]));

    for (const agent of agents ?? []) {
      if (agent.status === "error") {
        out.push({ key: `err-${agent.id}`, label: agent.name, detail: "đang lỗi", to: `/agents/${agent.id}` });
      }
    }

    const now = Date.now();
    for (const run of liveRuns ?? []) {
      if (run.status === "queued" && now - new Date(run.createdAt).getTime() > STUCK_QUEUE_MS) {
        out.push({
          key: `q-${run.id}`,
          label: run.agentName,
          detail: `xếp hàng ${relativeTime(run.createdAt)}`,
          to: `/agents/${run.agentId}/runs/${run.id}`,
        });
      }
    }

    for (const [agentId, run] of latestRunByAgent(runs ?? [])) {
      const agent = agentById.get(agentId);
      if (!agent || agent.status === "paused" || agent.status === "terminated") continue;
      if (run.status === "failed" && run.errorCode?.includes("quota")) {
        out.push({
          key: `quota-${run.id}`,
          label: agent.name,
          detail: `hết quota ${relativeTime(run.finishedAt ?? run.createdAt)}`,
          to: `/agents/${agentId}/runs/${run.id}`,
        });
      }
    }
    return out;
  }, [agents, liveRuns, runs]);

  if (items.length === 0) return null;

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3">
      <p className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-300">
        <AlertTriangle className="h-4 w-4" /> Cần chú ý ({items.length})
      </p>
      <div className="flex flex-wrap gap-2">
        {items.map((item) => (
          <Link
            key={item.key}
            to={item.to}
            className="rounded-full border border-amber-500/30 bg-background/70 px-3 py-1 text-xs hover:bg-amber-500/10"
          >
            <span className="font-medium">{item.label}</span>
            <span className="text-muted-foreground"> · {item.detail}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
