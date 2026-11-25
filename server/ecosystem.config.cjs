// PM2 ecosystem config for Paperclip server.
// Docs: https://pm2.keymetrics.io/docs/usage/application-declaration/
//
// Usage:
//   cd server && pm2 start ecosystem.config.cjs && pm2 save
//   pm2 status | pm2 logs paperclip-server | pm2 restart paperclip-server
//
// Override log dir via env: PAPERCLIP_PM2_LOG_DIR=/path/to/logs pm2 start ...

const path = require('path');
const os = require('os');

// Default log dir: ~/.paperclip/logs (portable across machines/users)
const LOG_DIR =
  process.env.PAPERCLIP_PM2_LOG_DIR ||
  path.join(os.homedir(), '.paperclip', 'logs');
const CRASH_REPORT_DIR = path.join(LOG_DIR, 'crash-reports').replace(/\\/g, '/');

module.exports = {
  apps: [
    {
      name: 'paperclip-server',
      script: 'node_modules/tsx/dist/cli.mjs',
      args: 'src/index.ts',
      cwd: __dirname,
      interpreter: 'node',

      // Restart policy
      autorestart: true,
      watch: false,
      max_memory_restart: '2G',
      // 2026-08-01: min_uptime 30s -> 120s. Sự cố cạn pooler 31/07: khi DB kẹt, paperclip sống
      // ~40s (quét khởi động 67s bị cắt giữa chừng) rồi chết. min_uptime=30s < 40s ⇒ PM2 coi mỗi
      // lần là "start thành công rồi mới sập" ⇒ reset bộ đếm ⇒ max_restarts=10 KHÔNG BAO GIỜ kích
      // ⇒ crash-loop vô hạn dội vào pooler. 120s > survival window ⇒ death-in-40s tính là unstable
      // ⇒ phanh max_restarts:10 dừng loop. Report: crypto-pattern-scanner/memory/reports/
      // 2026-08-01-supabase-pooler-connection-exhaustion-incident.md §8.
      min_uptime: '120s',
      max_restarts: 10,
      restart_delay: 2000,
      exp_backoff_restart_delay: 100,

      // Logging — merge stdout+stderr into one file for easy tail -f
      out_file: path.join(LOG_DIR, 'server.log'),
      error_file: path.join(LOG_DIR, 'server.log'),
      merge_logs: true,
      // No log_date_format — pino already adds [HH:mm:ss] prefix itself

      env: {
        NODE_ENV: 'development',
        NODE_OPTIONS: `--max-old-space-size=4096 --report-on-fatalerror --report-directory="${CRASH_REPORT_DIR}"`,
        // Force ANSI colors from pino-pretty even though stdout isn't a TTY
        // (PM2 captures stdout into a file, which would normally disable colors).
        FORCE_COLOR: '1',
        // Redirect paperclip's own file logger to a separate debug folder.
        // The app's logger.ts writes server.log too — without this redirect,
        // PM2 (colored) and the app's logger (uncolored) race to append to
        // the same file, producing mixed/garbled output.
        PAPERCLIP_LOG_DIR: path.join(LOG_DIR, 'debug'),
        // Delegation feature (P4 rollout 2026-04-21). Enables inline CEO→subagent
        // delegation via MCP tools. See runbook: crypto-pattern-scanner/memory/
        // reports/2026-04-21-delegation-rollout-runbook.md for rollback procedure.
        PAPERCLIP_DELEGATION_ENABLED: 'true',
        // 2026-04-22 — revert to static-ui mode. Defender exclusion allows
        // `npx vite build` to succeed directly; serve the built ui/dist/ bundle.
        // Set to 'true' only if build fails and Vite dev middleware is needed.
        PAPERCLIP_UI_DEV_MIDDLEWARE: 'false',
        // 2026-04-26 — auto-apply pending Drizzle migrations on startup. Without
        // this, any new migration file in packages/db/src/migrations causes the
        // server to refuse to start and crash-loop until db:migrate is run by
        // hand. Trade-off: very small risk that a half-written local migration
        // gets applied on next restart — acceptable on this single-machine
        // single-developer setup. If/when a team works on the same DB, flip
        // back to false and require explicit `pnpm db:migrate`.
        PAPERCLIP_MIGRATION_AUTO_APPLY: 'true',
      },
    },
  ],
};
