/**
 * Event-loop lag monitor — GEMRAL 26/10.
 *
 * 05:43-06:01 the DB pool "wedged": Supabase answered, but the process was too busy
 * (agy live-transcript poller re-parsing multi-MB files every 1.2s) to read the replies,
 * so postgres.js timed out connects/queries. Nothing logged the real cause. This logs a
 * WARN whenever the loop is blocked, so the next stall names itself in server.log.
 */
import { monitorEventLoopDelay } from "node:perf_hooks";
import { logger } from "../middleware/logger.js";

const WINDOW_MS = 60_000;
const WARN_P99_MS = 1_000;

export function startEventLoopMonitor(): () => void {
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  const timer = setInterval(() => {
    const p99 = h.percentile(99) / 1e6;
    const max = h.max / 1e6;
    if (p99 >= WARN_P99_MS) {
      logger.warn(
        { p50Ms: Math.round(h.percentile(50) / 1e6), p99Ms: Math.round(p99), maxMs: Math.round(max), windowMs: WINDOW_MS },
        "event loop lag high — server too busy to service DB/HTTP in time",
      );
    }
    h.reset();
  }, WINDOW_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    h.disable();
  };
}
