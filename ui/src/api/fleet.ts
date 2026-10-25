import type { QueryClient } from "@tanstack/react-query";
import { api } from "./client";

export interface FleetStatus {
  pausable: number;
  fleetPaused: number;
  otherPaused: number;
  running: number;
  queued: number;
  oldestQueuedAt: string | null;
  maxRunning: number;
}

export const fleetApi = {
  status: (companyId: string) => api.get<FleetStatus>(`/companies/${companyId}/fleet/status`),
  pause: (companyId: string) =>
    api.post<{ paused: number; cancelledRuns: number; status: FleetStatus }>(`/companies/${companyId}/fleet/pause`, {}),
  resume: (companyId: string) =>
    api.post<{ resumed: number; status: FleetStatus }>(`/companies/${companyId}/fleet/resume`, {}),
};

/** Pause/resume/cancel touches agents, runs and dashboard counts — refresh every view that shows them. */
export function invalidateAgentRuntimeQueries(queryClient: QueryClient) {
  for (const key of [["agents"], ["live-runs"], ["dashboard"], ["heartbeats"], ["fleet"]]) {
    queryClient.invalidateQueries({ queryKey: key });
  }
}
