import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Loader2, Pause, Play, X } from "lucide-react";
import { fleetApi, invalidateAgentRuntimeQueries } from "../api/fleet";
import { heartbeatsApi } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { SimpleModal } from "@/pages/crm/components/SimpleModal";

const POLL_MS = 15_000;

/**
 * Fleet controls on top of the Dashboard: pause/resume every heartbeat agent at once
 * + the run queue (how many runs wait, how long, free slots, cancel a waiting run).
 */
export function FleetControlBar({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<"pause" | "resume" | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: status, isLoading } = useQuery({
    queryKey: queryKeys.fleet(companyId),
    queryFn: () => fleetApi.status(companyId),
    refetchInterval: POLL_MS,
  });

  const { data: liveRuns } = useQuery({
    queryKey: [...queryKeys.liveRuns(companyId), "queue"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
    enabled: queueOpen,
    refetchInterval: queueOpen ? POLL_MS : false,
  });
  const queuedRuns = (liveRuns ?? [])
    .filter((r) => r.status === "queued")
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  const fleetMutation = useMutation({
    mutationFn: (action: "pause" | "resume"): Promise<unknown> =>
      action === "pause" ? fleetApi.pause(companyId) : fleetApi.resume(companyId),
    onSuccess: () => {
      setError(null);
      setConfirm(null);
      invalidateAgentRuntimeQueries(queryClient);
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Không thực hiện được"),
  });

  const cancelMutation = useMutation({
    mutationFn: (runId: string) => heartbeatsApi.cancel(runId),
    onSuccess: () => invalidateAgentRuntimeQueries(queryClient),
    onError: (err) => setError(err instanceof Error ? err.message : "Không huỷ được lượt chờ"),
  });

  if (isLoading || !status) {
    return <div className="h-14 animate-pulse rounded-xl border bg-card" />;
  }

  // Resume wins when anything is fleet-paused: avoids a half-paused fleet being paused "again".
  const mode: "pause" | "resume" = status.fleetPaused > 0 ? "resume" : "pause";
  const canAct = mode === "resume" ? status.fleetPaused > 0 : status.pausable > 0;
  const freeSlots = status.maxRunning > 0 ? Math.max(0, status.maxRunning - status.running) : null;

  return (
    <div className="rounded-xl border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0 text-sm">
          <p className="font-medium">
            {mode === "resume" ? (
              <span className="text-amber-600 dark:text-amber-400">
                Đội đang tạm dừng · {status.fleetPaused} agent chờ chạy lại
              </span>
            ) : (
              <span>{status.pausable} agent chạy lịch đang bật</span>
            )}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
            {status.running} đang chạy · {status.queued} xếp hàng
            {status.oldestQueuedAt ? ` (lâu nhất ${relativeTime(status.oldestQueuedAt)})` : ""}
            {freeSlots !== null ? ` · ${freeSlots}/${status.maxRunning} chỗ trống` : ""}
            {status.otherPaused > 0 ? ` · ${status.otherPaused} agent dừng vì lý do khác (nút này không đụng)` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setQueueOpen((v) => !v)} disabled={status.queued === 0 && !queueOpen}>
            Hàng chờ ({status.queued})
            {queueOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </Button>
          <Button
            size="sm"
            variant={mode === "pause" ? "destructive" : "default"}
            disabled={!canAct || fleetMutation.isPending}
            onClick={() => setConfirm(mode)}
          >
            {mode === "pause" ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {mode === "pause" ? "Tạm dừng toàn đội" : "Chạy lại toàn đội"}
          </Button>
        </div>
      </div>

      {error && <p className="border-t px-4 py-2 text-xs text-destructive">{error}</p>}

      {queueOpen && (
        <div className="border-t px-4 py-3">
          {queuedRuns.length === 0 ? (
            <p className="text-xs text-muted-foreground">Không có lượt nào đang chờ.</p>
          ) : (
            <ul className="space-y-1.5">
              {queuedRuns.map((run) => (
                <li key={run.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate">
                    <span className="font-medium">{run.agentName}</span>
                    <span className="text-xs text-muted-foreground"> · chờ {relativeTime(run.createdAt)} · {run.invocationSource}</span>
                  </span>
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={cancelMutation.isPending && cancelMutation.variables === run.id}
                    onClick={() => cancelMutation.mutate(run.id)}
                  >
                    <X /> Huỷ lượt chờ
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <SimpleModal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === "pause" ? "Tạm dừng toàn đội?" : "Chạy lại toàn đội?"}
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setConfirm(null)}>Thôi</Button>
            <Button
              size="sm"
              variant={confirm === "pause" ? "destructive" : "default"}
              disabled={fleetMutation.isPending}
              onClick={() => confirm && fleetMutation.mutate(confirm)}
            >
              {fleetMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {confirm === "pause" ? "Tạm dừng" : "Chạy lại"}
            </Button>
          </>
        }
      >
        <div className={cn("space-y-2 text-sm")}>
          {confirm === "pause" ? (
            <>
              <p>{status.pausable} agent chạy theo lịch sẽ dừng, không tự thức dậy cho tới khi chị bấm "Chạy lại toàn đội".</p>
              {status.running + status.queued > 0 && (
                <p className="text-amber-600 dark:text-amber-400">
                  {status.running} lượt đang chạy và {status.queued} lượt đang chờ sẽ bị huỷ.
                </p>
              )}
            </>
          ) : (
            <p>{status.fleetPaused} agent bị nút này dừng sẽ chạy lại theo lịch kế tiếp (không chạy bù lượt đã lỡ).</p>
          )}
          {status.otherPaused > 0 && (
            <p className="text-xs text-muted-foreground">
              {status.otherPaused} agent đang dừng vì lý do khác (hết quota, ngân sách, tự tay dừng) được giữ nguyên.
            </p>
          )}
        </div>
      </SimpleModal>
    </div>
  );
}
