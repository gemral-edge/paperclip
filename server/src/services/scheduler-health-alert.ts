/**
 * GEM-1443: Telegram alert when the heartbeat scheduler itself is unhealthy.
 *
 * 14/10 the timer tick timed out (60s) for ~2.5h and, when it recovered, cron slots
 * were silently dropped as "stale" — nobody was told. Two signals, decided here and
 * unit-tested; the sender is injected so tests never hit the network.
 *   (a) ≥ TICK_TIMEOUT_THRESHOLD "timer tick timed out" inside TICK_TIMEOUT_WINDOW_MS
 *   (b) a "Skipping stale cron catch-up" that is NOT right after process start
 *       (right after a restart it is the intended behaviour).
 * Each signal has its own cooldown so a long outage sends one message, not hundreds.
 */
export const TICK_TIMEOUT_WINDOW_MS = 30 * 60_000;
export const TICK_TIMEOUT_THRESHOLD = 3;
export const ALERT_COOLDOWN_MS = 60 * 60_000;
export const RESTART_QUIET_MS = 10 * 60_000;

type Send = (text: string) => Promise<void>;

export function createSchedulerHealthAlerts(opts: {
  processStartMs: number;
  send: Send;
  now?: () => number;
}) {
  const now = opts.now ?? Date.now;
  let timeouts: number[] = [];
  const lastSentAt: Record<"timeouts" | "stale", number | null> = { timeouts: null, stale: null };

  const fire = (kind: "timeouts" | "stale", text: string): boolean => {
    const t = now();
    const last = lastSentAt[kind];
    if (last !== null && t - last < ALERT_COOLDOWN_MS) return false;
    lastSentAt[kind] = t;
    // Alert failure must never break the scheduler.
    void opts.send(text).catch(() => undefined);
    return true;
  };

  return {
    /** Returns true when an alert was sent. */
    recordTickTimeout(): boolean {
      const t = now();
      timeouts = [...timeouts.filter((x) => t - x < TICK_TIMEOUT_WINDOW_MS), t];
      if (timeouts.length < TICK_TIMEOUT_THRESHOLD) return false;
      return fire(
        "timeouts",
        `⚠️ Paperclip: vòng hẹn giờ agent quá hạn 60s ${timeouts.length} lần trong 30 phút — DB/pooler đang nghẽn, lịch agent có thể trễ. ` +
          `Kiểm: python scripts/audit_paperclip_pooler_stall.py`,
      );
    },
    /** Returns true when an alert was sent. */
    recordStaleSkip(count: number): boolean {
      if (count <= 0) return false;
      if (now() - opts.processStartMs < RESTART_QUIET_MS) return false;
      return fire(
        "stale",
        `⚠️ Paperclip: ${count} lịch cron agent bị BỎ (quá hạn ngoài grace) dù server không vừa khởi động — ` +
          `có thể lỡ khung giờ đăng. Kiểm log '[tickTimers] Skipping stale cron catch-up'.`,
      );
    },
  };
}

const BOARD_CHAT_ID = "6486938519"; // Jennie

/** Plain-text Telegram send (no Markdown: log text breaks legacy parsing). No token → no-op. */
export async function sendSchedulerAlertTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: BOARD_CHAT_ID, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}`);
}
