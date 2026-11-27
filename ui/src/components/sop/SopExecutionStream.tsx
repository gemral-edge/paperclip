import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, CheckCircle, XCircle, Loader2, Terminal } from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/* ─── Types ─── */

type StreamEventType =
  | "step_start"
  | "stdout"
  | "step_complete"
  | "approval_gate"
  | "error"
  | "done";

interface StreamEvent {
  id: string;
  type: StreamEventType;
  ts: string;
  stepOrder?: number;
  stepName?: string;
  text?: string;
  exitCode?: number;
  approvalId?: string;
  error?: string;
}

type ExecutionStatus = "idle" | "running" | "paused" | "completed" | "failed";

interface SopExecutionStreamProps {
  executionId?: string;
  sopId?: string;
  onComplete?: () => void;
  maxHeight?: string;
}

/* ─── Status badge mapping ─── */

const STATUS_CONFIG: Record<ExecutionStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  idle: { label: "Chờ", variant: "secondary" },
  running: { label: "Đang chạy", variant: "default" },
  paused: { label: "Tạm dừng", variant: "outline" },
  completed: { label: "Hoàn thành", variant: "secondary" },
  failed: { label: "Lỗi", variant: "destructive" },
};

/* ─── Component ─── */

export function SopExecutionStream({
  executionId,
  sopId,
  onComplete,
  maxHeight = "420px",
}: SopExecutionStreamProps) {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [status, setStatus] = useState<ExecutionStatus>("idle");
  const [copied, setCopied] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState<Set<string>>(new Set());
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  // SSE connection
  useEffect(() => {
    if (!executionId) return;

    setEvents([]);
    setStatus("running");
    setPendingApprovals(new Set());

    const es = new EventSource(`/api/ops/sop-engine/executions/${executionId}/stream`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data: StreamEvent = JSON.parse(event.data);
        const id = data.id || `${data.type}-${Date.now()}-${Math.random()}`;

        setEvents((prev) => [...prev, { ...data, id }]);

        switch (data.type) {
          case "step_start":
            setStatus("running");
            break;
          case "approval_gate":
            setStatus("paused");
            if (data.approvalId) {
              setPendingApprovals((prev) => new Set(prev).add(data.approvalId!));
            }
            break;
          case "error":
            setStatus("failed");
            break;
          case "done":
            setStatus("completed");
            onComplete?.();
            es.close();
            break;
        }
      } catch {
        // Ignore parse errors from SSE
      }
    };

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        setStatus((prev) => (prev === "running" ? "failed" : prev));
      }
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [executionId, onComplete]);

  // Approval actions
  const handleApproval = useCallback(
    async (approvalId: string, action: "approve" | "reject") => {
      try {
        const res = await fetch(`/api/ops/sop-engine/executions/${executionId}/approve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ approvalId, action }),
        });
        if (res.ok) {
          setPendingApprovals((prev) => {
            const next = new Set(prev);
            next.delete(approvalId);
            return next;
          });
          if (action === "approve") setStatus("running");
        }
      } catch {
        // Network error — keep gate visible
      }
    },
    [executionId],
  );

  // Copy full log
  const handleCopy = useCallback(() => {
    const text = events
      .map((e) => {
        const ts = e.ts ? `[${e.ts}]` : "";
        switch (e.type) {
          case "step_start":
            return `${ts} ▶ Bước ${e.stepOrder}: ${e.stepName}`;
          case "stdout":
            return `${ts}   ${e.text}`;
          case "step_complete":
            return `${ts} ✓ Bước ${e.stepOrder} hoàn thành (exit=${e.exitCode ?? 0})`;
          case "approval_gate":
            return `${ts} ⏸ Chờ duyệt: ${e.stepName}`;
          case "error":
            return `${ts} ✗ Lỗi: ${e.error || e.text}`;
          case "done":
            return `${ts} ● Kết thúc`;
          default:
            return `${ts} ${e.text ?? ""}`;
        }
      })
      .join("\n");

    void copyToClipboard(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [events]);

  const statusCfg = STATUS_CONFIG[status];

  /* ─── Empty state ─── */
  if (!executionId) {
    return (
      <div
        className="rounded-lg border border-border bg-zinc-900 p-6 flex items-center justify-center"
        style={{ minHeight: "180px" }}
      >
        <div className="text-center space-y-2">
          <Terminal className="h-8 w-8 text-zinc-500 mx-auto" />
          <p className="text-sm text-zinc-400">
            Chưa chạy. Bấm ▶ Chạy SOP để bắt đầu.
          </p>
        </div>
      </div>
    );
  }

  /* ─── Render ─── */
  return (
    <div className="rounded-lg border border-border bg-zinc-900 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-700/60 bg-zinc-800/60">
        <div className="flex items-center gap-2">
          <Terminal className="h-3.5 w-3.5 text-zinc-400" />
          <span className="text-xs font-medium text-zinc-300">
            Execution #{executionId.slice(0, 8)}
          </span>
          <Badge variant={statusCfg.variant} className="text-[10px] px-1.5 py-0">
            {status === "running" && <Loader2 className="h-2.5 w-2.5 animate-spin mr-0.5" />}
            {statusCfg.label}
          </Badge>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-zinc-400 hover:text-zinc-200"
          onClick={handleCopy}
        >
          {copied ? <CheckCircle className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>

      {/* Log stream */}
      <div
        ref={containerRef}
        className="overflow-y-auto font-mono text-xs leading-relaxed px-3 py-2 space-y-0.5"
        style={{ maxHeight }}
      >
        {events.map((e) => (
          <StreamLine
            key={e.id}
            event={e}
            isPendingApproval={!!e.approvalId && pendingApprovals.has(e.approvalId)}
            onApprove={() => e.approvalId && handleApproval(e.approvalId, "approve")}
            onReject={() => e.approvalId && handleApproval(e.approvalId, "reject")}
          />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

/* ─── Individual stream line ─── */

function StreamLine({
  event: e,
  isPendingApproval,
  onApprove,
  onReject,
}: {
  event: StreamEvent;
  isPendingApproval: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  switch (e.type) {
    case "step_start":
      return (
        <div className="text-blue-400 pt-1">
          ▶ <span className="font-semibold">Bước {e.stepOrder}:</span> {e.stepName}
        </div>
      );
    case "stdout":
      return <div className="text-zinc-300 pl-3 whitespace-pre-wrap">{e.text}</div>;
    case "step_complete":
      return (
        <div className={cn("pl-3", e.exitCode === 0 ? "text-green-400" : "text-yellow-400")}>
          ✓ Bước {e.stepOrder} hoàn thành
          {e.exitCode != null && e.exitCode !== 0 && ` (exit=${e.exitCode})`}
        </div>
      );
    case "approval_gate":
      return (
        <div className="my-1 rounded bg-amber-900/30 border border-amber-700/50 px-3 py-2">
          <div className="text-amber-300 mb-1.5">⏸ Chờ duyệt: {e.stepName}</div>
          {isPendingApproval && (
            <div className="flex gap-2">
              <Button size="xs" className="bg-green-600 hover:bg-green-700 text-white" onClick={onApprove}>
                <CheckCircle className="h-3 w-3 mr-1" />
                Duyệt
              </Button>
              <Button size="xs" variant="destructive" onClick={onReject}>
                <XCircle className="h-3 w-3 mr-1" />
                Từ chối
              </Button>
            </div>
          )}
        </div>
      );
    case "error":
      return <div className="text-red-400 pl-3">✗ {e.error || e.text}</div>;
    case "done":
      return <div className="text-green-400 pt-1 border-t border-zinc-700/40 mt-1">● Kết thúc</div>;
    default:
      return <div className="text-zinc-500 pl-3">{e.text}</div>;
  }
}
