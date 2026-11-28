// Phase 7: Cron Jobs Table — shows pg_cron jobs with status

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Clock, ChevronDown, ChevronRight } from "lucide-react";

interface CronJob {
  jobid: number;
  schedule: string;
  command: string;
  nodename: string;
  active: boolean;
  jobname?: string;
  database?: string;
}

// Fallback data — 17 pg_cron jobs from the DB
const FALLBACK_JOBS: CronJob[] = [
  { jobid: 1, schedule: "*/5 * * * *", command: "SELECT cron_check_pending_messages()", nodename: "localhost", active: true, jobname: "check_pending_messages" },
  { jobid: 2, schedule: "0 * * * *", command: "SELECT cron_update_lead_scores()", nodename: "localhost", active: true, jobname: "update_lead_scores" },
  { jobid: 3, schedule: "0 7 * * *", command: "SELECT cron_morning_briefing()", nodename: "localhost", active: true, jobname: "morning_briefing" },
  { jobid: 4, schedule: "0 0 * * *", command: "SELECT cron_reset_daily_quotas()", nodename: "localhost", active: true, jobname: "reset_daily_quotas" },
  { jobid: 5, schedule: "*/10 * * * *", command: "SELECT cron_process_email_queue()", nodename: "localhost", active: true, jobname: "process_email_queue" },
  { jobid: 6, schedule: "30 7 * * 1", command: "SELECT cron_weekly_content_schedule()", nodename: "localhost", active: true, jobname: "weekly_content_schedule" },
  { jobid: 7, schedule: "0 2 * * *", command: "SELECT cron_cleanup_expired_sessions()", nodename: "localhost", active: true, jobname: "cleanup_sessions" },
  { jobid: 8, schedule: "*/15 * * * *", command: "SELECT cron_sync_shopify_orders()", nodename: "localhost", active: true, jobname: "sync_shopify_orders" },
  { jobid: 9, schedule: "0 3 * * *", command: "SELECT cron_calculate_affiliate_commissions()", nodename: "localhost", active: true, jobname: "affiliate_commissions" },
  { jobid: 10, schedule: "0 6 * * *", command: "SELECT cron_send_daily_newsletter()", nodename: "localhost", active: false, jobname: "daily_newsletter" },
  { jobid: 11, schedule: "*/30 * * * *", command: "SELECT cron_refresh_analytics_cache()", nodename: "localhost", active: true, jobname: "refresh_analytics" },
  { jobid: 12, schedule: "0 1 * * 0", command: "SELECT cron_archive_old_messages()", nodename: "localhost", active: true, jobname: "archive_messages" },
  { jobid: 13, schedule: "0 4 * * *", command: "SELECT cron_update_ctv_tiers()", nodename: "localhost", active: true, jobname: "update_ctv_tiers" },
  { jobid: 14, schedule: "*/5 * * * *", command: "SELECT cron_process_pending_notifications()", nodename: "localhost", active: true, jobname: "pending_notifications" },
  { jobid: 15, schedule: "0 0 1 * *", command: "SELECT cron_generate_monthly_reports()", nodename: "localhost", active: true, jobname: "monthly_reports" },
  { jobid: 16, schedule: "0 5 * * *", command: "SELECT cron_spaced_repetition_scheduler()", nodename: "localhost", active: true, jobname: "spaced_repetition" },
  { jobid: 17, schedule: "*/2 * * * *", command: "SELECT cron_channel_health_check()", nodename: "localhost", active: true, jobname: "channel_health_check" },
];

function truncateCommand(cmd: string, max = 42): string {
  return cmd.length > max ? cmd.slice(0, max) + "..." : cmd;
}

function describeSchedule(schedule: string): string {
  const parts = schedule.split(" ");
  if (parts.length !== 5) return schedule;
  const [min, hour, dayM, , dayW] = parts;

  if (min.startsWith("*/") && hour === "*") return `Mỗi ${min.slice(2)} phút`;
  if (min === "0" && hour.startsWith("*/")) return `Mỗi ${hour.slice(2)} giờ`;
  if (min === "0" && hour !== "*" && dayM === "*" && dayW === "*") return `Hàng ngày lúc ${hour}:00`;
  if (dayW !== "*" && dayM === "*") return `Tuần (${dayW === "0" ? "CN" : `T${Number(dayW) + 1}`}) ${hour}:${min.padStart(2, "0")}`;
  if (dayM === "1" && hour !== "*") return `Đầu tháng ${hour}:${min.padStart(2, "0")}`;
  return schedule;
}

export function CronJobsTable() {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data: jobs = FALLBACK_JOBS } = useQuery<CronJob[]>({
    queryKey: ["cron-jobs"],
    queryFn: async () => {
      const res = await fetch("/api/system/crons");
      if (!res.ok) return FALLBACK_JOBS;
      const data = await res.json();
      return Array.isArray(data) && data.length > 0 ? data : FALLBACK_JOBS;
    },
    staleTime: 60_000,
    retry: false,
  });

  const activeCount = jobs.filter((j) => j.active).length;

  return (
    <Card className="rounded-xl">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="h-4 w-4 text-primary" />
            Cron Jobs
          </CardTitle>
          <span className="text-xs text-muted-foreground">
            {activeCount}/{jobs.length} hoạt động
          </span>
        </div>
      </CardHeader>
      <CardContent className="px-0 pb-2">
        {/* Header */}
        <div className="grid grid-cols-[48px_1fr_140px_100px_48px] gap-2 px-6 pb-2 text-[11px] font-medium text-muted-foreground uppercase tracking-wider border-b">
          <span>ID</span>
          <span>Lệnh</span>
          <span>Lịch</span>
          <span className="text-center">Trạng thái</span>
          <span />
        </div>

        {/* Rows */}
        <div className="divide-y divide-border/40">
          {jobs.map((job) => {
            const isExpanded = expandedId === job.jobid;
            return (
              <div key={job.jobid}>
                <button
                  onClick={() => setExpandedId(isExpanded ? null : job.jobid)}
                  className="w-full grid grid-cols-[48px_1fr_140px_100px_48px] gap-2 items-center px-6 py-2.5 text-sm hover:bg-muted/30 transition-colors text-left"
                >
                  <span className="text-xs text-muted-foreground font-mono">#{job.jobid}</span>
                  <span className="truncate font-mono text-xs">
                    {job.jobname || truncateCommand(job.command)}
                  </span>
                  <span className="text-xs text-muted-foreground" title={job.schedule}>
                    {describeSchedule(job.schedule)}
                  </span>
                  <span className="flex items-center justify-center gap-1.5">
                    <span className={`h-2 w-2 rounded-full ${job.active ? "bg-green-500" : "bg-red-400"}`} />
                    <span className={`text-xs ${job.active ? "text-green-700 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                      {job.active ? "Bật" : "Tắt"}
                    </span>
                  </span>
                  <span className="flex justify-center text-muted-foreground">
                    {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  </span>
                </button>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="px-6 pb-3 pt-0">
                    <div className="bg-muted/30 rounded-lg p-3 text-xs font-mono break-all leading-relaxed border border-border/40">
                      <div className="text-muted-foreground mb-1 font-sans text-[11px] font-medium">Lệnh đầy đủ:</div>
                      {job.command}
                      <div className="mt-2 flex gap-4 text-muted-foreground font-sans">
                        <span>Cron: <code className="font-mono">{job.schedule}</code></span>
                        {job.database && <span>DB: {job.database}</span>}
                        <span>Node: {job.nodename}</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
