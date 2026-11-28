// Lead Score Badge — visual indicator for lead score + temperature

import { Flame, Snowflake, Sun, Thermometer } from "lucide-react";

const tempConfig: Record<string, { icon: typeof Flame; color: string; bg: string; label: string }> = {
  on_fire: { icon: Flame, color: "text-red-500", bg: "bg-red-500/10", label: "Nóng bỏng" },
  hot: { icon: Flame, color: "text-orange-500", bg: "bg-orange-500/10", label: "Nóng" },
  warm: { icon: Sun, color: "text-yellow-500", bg: "bg-yellow-500/10", label: "Ấm" },
  cold: { icon: Snowflake, color: "text-blue-700 dark:text-blue-400", bg: "bg-blue-400/10", label: "Lạnh" },
};

export function LeadScoreBadge({
  score,
  temperature,
  size = "sm",
}: {
  score: number;
  temperature: string;
  size?: "sm" | "md";
}) {
  const config = tempConfig[temperature] || tempConfig.cold;
  const Icon = config.icon;
  const isSmall = size === "sm";

  return (
    <div className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${config.bg}`}>
      <Icon className={`${config.color} ${isSmall ? "h-3 w-3" : "h-4 w-4"}`} />
      <span className={`font-medium ${config.color} ${isSmall ? "text-xs" : "text-sm"}`}>
        {score}
      </span>
    </div>
  );
}
