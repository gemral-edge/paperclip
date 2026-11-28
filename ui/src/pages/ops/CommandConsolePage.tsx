// Command Console — terminal UI for pipeline operations
import { useState, useRef, useEffect, useCallback } from "react";
import { Terminal, Send, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { useToast } from "@/context/ToastContext";
import { fetchOk } from "@/lib/readJsonOrThrow";

interface LogEntry {
  id: string;
  time: string;
  type: "input" | "output" | "error" | "system";
  text: string;
}

const HELP_TEXT = `Lenh co san:
  run <script>     — Chay script (pipeline_audit, daily_push, batch_generate...)
  delegate <agent> <task> — Giao viec cho agent
  status           — Xem trang thai pipeline
  jobs             — Xem generation jobs
  approve-all      — Duyet tat ca bai dat compliance
  sync             — Sync CC -> Main Supabase
  help             — Hien danh sach lenh`;

/**
 * @archetype form
 * @capability-skip dirty-guard: ô gõ lệnh 1 dòng kiểu terminal, Enter là chạy ngay và xoá ô, không có dữ liệu nháp hay nút Lưu
 */
export function CommandConsolePage() {
  const [errors, setErrors] = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);


  const [logs, setLogs] = useState<LogEntry[]>([
    {
      id: "0",
      time: new Date().toLocaleTimeString("vi"),
      type: "system",
      text: 'Paperclip Command Console v1.0 — Go "help" de xem lenh.',
    },
  ]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { pushToast } = useToast();

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const addLog = useCallback((type: LogEntry["type"], text: string) => {
    setLogs((prev) => [
      ...prev,
      {
        id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
        time: new Date().toLocaleTimeString("vi"),
        type,
        text,
      },
    ]);
  }, []);

  const handleCommand = useCallback(
    async (cmd: string) => {
      addLog("input", `$ ${cmd}`);
      const parts = cmd.trim().split(/\s+/);
      const verb = parts[0]?.toLowerCase();

      if (verb === "help") {
        addLog("system", HELP_TEXT);
        return;
      }
      if (verb === "clear") {
        setLogs([]);
        return;
      }
      if (verb === "status") {
        setRunning(true);
        try {
          const res = await fetch("/api/ops/content-pipeline/stats");
          const stats = await res.json();
          addLog(
            "output",
            `Pipeline Status:\n  Dang hom nay: ${stats?.posted_today || 0}/${stats?.target_today || 9}\n  Cho duyet: ${stats?.pending_approval || 0}\n  Dang tao: ${stats?.generating || 0}\n  Tong scripts: ${stats?.total_scripts || 0}`,
          );
        } catch (e: any) {
          addLog("error", e.message);
        }
        setRunning(false);
        return;
      }
      if (verb === "jobs") {
        setRunning(true);
        try {
          const res = await fetch("/api/ops/content-pipeline/jobs-summary");
          const s = await res.json();
          addLog(
            "output",
            `Jobs: ${s?.queued || 0} queued | ${s?.processing || 0} processing | ${s?.completed || 0} done | ${s?.failed || 0} failed`,
          );
        } catch (e: any) {
          addLog("error", e.message);
        }
        setRunning(false);
        return;
      }
      if (verb === "run" && parts[1]) {
        setRunning(true);
        addLog("system", `Dang chay ${parts[1]}...`);
        try {
          const res = await fetch(
            `/api/ops/content-pipeline/execute/${parts[1]}`,
            { method: "POST" },
          );
          if (!res.ok) {
            addLog("error", `Loi: ${res.status}`);
            setRunning(false);
            return;
          }
          const reader = res.body?.getReader();
          if (reader) {
            const decoder = new TextDecoder();
            let buf = "";
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              const lines = buf.split("\n");
              buf = lines.pop() || "";
              for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                try {
                  const ev = JSON.parse(line.slice(6));
                  if (ev.type === "stdout" || ev.type === "stderr")
                    addLog("output", ev.text);
                  else if (ev.type === "exit")
                    addLog("system", `Ket thuc (exit code: ${ev.code})`);
                } catch {
                  /* ignore non-json lines */
                }
              }
            }
          } else {
            const text = await res.text();
            if (text) addLog("output", text);
          }
        } catch (e: any) {
          addLog("error", e.message);
        }
        setRunning(false);
        return;
      }
      if (verb === "delegate" && parts[1] && parts.slice(2).join(" ")) {
        setRunning(true);
        try {
          const res = await fetch("/api/ops/content-pipeline/delegate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agent_slug: parts[1],
              task: parts.slice(2).join(" "),
            }),
          });
          if (!res.ok) {
            addLog("error", `Loi: ${res.status}`);
          } else {
            addLog(
              "output",
              `Da giao viec cho ${parts[1]}: "${parts.slice(2).join(" ")}"`,
            );
            pushToast({
              title: `Giao viec cho ${parts[1]}`,
              tone: "success",
            });
          }
        } catch (e: any) {
          addLog("error", e.message);
        }
        setRunning(false);
        return;
      }
      if (verb === "approve-all") {
        setRunning(true);
        addLog("system", "Dang duyet compliance...");
        try {
          const sRes = await fetch(
            "/api/ops/content-pipeline/scripts?status=draft&limit=200",
          );
          const drafts = (await sRes.json()) || [];
          let passed = 0;
          let failed = 0;
          for (const s of drafts) {
            const cr = await fetchOk(
              "/api/ops/content-pipeline/compliance-check",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ content: s.body || s.caption || "" }),
              },
              "Lỗi compliance-check",
            );
            const check = await cr.json();
            if (check.pass) passed++;
            else failed++;
          }
          if (passed > 0) {
            addLog(
              "output",
              `Da duyet ${passed} bai. ${failed} can review thu cong.`,
            );
          } else {
            addLog("output", "Khong co bai nao dat compliance.");
          }
        } catch (e: any) {
          addLog("error", e.message);
        }
        setRunning(false);
        return;
      }
      if (verb === "sync") {
        setRunning(true);
        addLog("system", "Dang sync CC -> Main Supabase...");
        try {
          const res = await fetch("/api/ops/content-pipeline/sync", {
            method: "POST",
          });
          if (!res.ok) addLog("error", `Loi: ${res.status}`);
          else {
            const d = await res.json();
            addLog("output", d.message || "Sync thanh cong");
          }
        } catch (e: any) {
          addLog("error", e.message);
        }
        setRunning(false);
        return;
      }
      addLog(
        "error",
        `Khong hieu lenh: "${cmd}". Go "help" de xem danh sach.`,
      );
    },
    [addLog, pushToast],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || running) return;
    setHistory((prev) => [input.trim(), ...prev].slice(0, 50));
    setHistoryIdx(-1);
    handleCommand(input.trim());
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length === 0) return;
      const next = Math.min(historyIdx + 1, history.length - 1);
      setHistoryIdx(next);
      setInput(history[next]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIdx <= 0) {
        setHistoryIdx(-1);
        setInput("");
      } else {
        const next = historyIdx - 1;
        setHistoryIdx(next);
        setInput(history[next]);
      }
    }
  };

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-bold flex items-center gap-2">
        <Terminal className="h-6 w-6" /> Command Console
      </h1>
      <Card className={"bg-zinc-950 text-green-400 font-mono text-sm overflow-hidden" /* dark-surface-ok */}>
        <div
          className="max-h-[600px] overflow-y-auto p-4 space-y-1"
          onClick={() => inputRef.current?.focus()}
        >
          {logs.map((l) => (
            <div
              key={l.id}
              className={`whitespace-pre-wrap ${
                l.type === "input"
                  ? "text-white font-bold"
                  : l.type === "error"
                    ? "text-red-400" // dark-surface-ok
                    : l.type === "system"
                      ? "text-zinc-500"
                      : "text-green-400" // dark-surface-ok
              }`}
            >
              <span className="text-zinc-600 text-xs mr-2">[{l.time}]</span>
              {l.text}
            </div>
          ))}
          <div ref={endRef} />
        </div>
        <form
          onSubmit={handleSubmit}
          className="flex items-center gap-2 border-t border-zinc-800 px-4 py-2"
        >
          <span className="text-green-500">$</span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={running}
            className="flex-1 bg-transparent outline-none text-white placeholder-zinc-600"
            placeholder="Nhap lenh..."
            autoFocus
          />
          <button type="submit" disabled={running || !input.trim()}>
            {running ? (
              <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />
            ) : (
              <Send className="h-4 w-4 text-zinc-500 hover:text-white" />
            )}
          </button>
        </form>
      </Card>
    </div>
  );
}
