import { useEffect, useMemo, useCallback, useState } from "react";
import { useLocation, useSearchParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";
import { EmptyState } from "../components/EmptyState";
import { IssuesList } from "../components/IssuesList";
import { CircleDot } from "lucide-react";

export function Issues() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const initialSearch = searchParams.get("q") ?? "";
  const participantAgentId = searchParams.get("participantAgentId") ?? undefined;
  // 2026-04-17 — include hidden issues (e.g. heartbeat threads) toggle.
  // Use React state (NOT derived from searchParams) because the router hook
  // doesn't re-subscribe to window.history.replaceState — setting ?hidden=1
  // via replaceState didn't trigger a re-render → button looked dead. State
  // is seeded from URL once on mount so deep-links still work.
  const [activeTab, setActiveTab] = useState<"all" | "hidden" | "heartbeats" | "gem456">(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("gem456_only") === "1" || params.get("gem456_only") === "true") return "gem456";
    if (params.get("heartbeats_only") === "1" || params.get("heartbeats_only") === "true") return "heartbeats";
    if (params.get("hidden") === "1" || params.get("hidden") === "true") return "hidden";
    return "all";
  });

  const includeHidden = activeTab === "hidden" || activeTab === "heartbeats" || activeTab === "gem456";
  const onlyHeartbeats = activeTab === "heartbeats";
  const onlyGem456 = activeTab === "gem456";

  const handleSearchChange = useCallback((search: string) => {
    const trimmedSearch = search.trim();
    const currentSearch = new URLSearchParams(window.location.search).get("q") ?? "";
    if (currentSearch === trimmedSearch) return;

    const url = new URL(window.location.href);
    if (trimmedSearch) {
      url.searchParams.set("q", trimmedSearch);
    } else {
      url.searchParams.delete("q");
    }

    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(window.history.state, "", nextUrl);
  }, []);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 5000,
  });

  const liveIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of liveRuns ?? []) {
      if (run.status === "running" && run.issueId) ids.add(run.issueId);
    }
    return ids;
  }, [liveRuns]);

  const issueLinkState = useMemo(
    () =>
      createIssueDetailLocationState(
        "Issues",
        `${location.pathname}${location.search}${location.hash}`,
        "issues",
      ),
    [location.pathname, location.search, location.hash],
  );

  useEffect(() => {
    setBreadcrumbs([{ label: "Issues" }]);
  }, [setBreadcrumbs]);

  const { data: gem456Parent } = useQuery({
    queryKey: ["issues", "GEM-456"],
    queryFn: () => issuesApi.get("GEM-456"),
    enabled: onlyGem456,
  });

  const { data: issues, isLoading, error } = useQuery({
    queryKey: [
      ...queryKeys.issues.list(selectedCompanyId!),
      "participant-agent", participantAgentId ?? "__all__",
      "hidden", includeHidden || onlyHeartbeats || onlyGem456 ? "1" : "0",
      "heartbeats_only", onlyHeartbeats ? "1" : "0",
      "gem456_only", onlyGem456 ? "1" : "0",
    ],
    queryFn: () => issuesApi.list(selectedCompanyId!, { 
      participantAgentId, 
      includeHidden: includeHidden || onlyHeartbeats || onlyGem456,
      originKind: onlyHeartbeats ? "system" : undefined,
      parentId: onlyGem456 && gem456Parent ? gem456Parent.id : undefined,
    }),
    enabled: !!selectedCompanyId && (!onlyGem456 || !!gem456Parent),
  });

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={CircleDot} message="Select a company to view issues." />;
  }

  const handleTabChange = (tab: "all" | "hidden" | "heartbeats" | "gem456") => {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    url.searchParams.delete("hidden");
    url.searchParams.delete("heartbeats_only");
    url.searchParams.delete("gem456_only");

    if (tab === "hidden") url.searchParams.set("hidden", "1");
    if (tab === "heartbeats") url.searchParams.set("heartbeats_only", "1");
    if (tab === "gem456") url.searchParams.set("gem456_only", "1");

    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  };

  const combinedIssues = useMemo(() => {
    if (!issues) return [];
    if (onlyGem456 && gem456Parent) {
      // Avoid duplicate if the API somehow returns it (though parentId filter prevents that)
      if (issues.some(i => i.id === gem456Parent.id)) return issues;
      return [gem456Parent, ...issues];
    }
    return issues;
  }, [issues, onlyGem456, gem456Parent]);

  return (
    <div className="space-y-0">
      <div className="flex items-center gap-6 px-6 pt-4 border-b border-border">
        <button
          type="button"
          onClick={() => handleTabChange("all")}
          className={`pb-3 text-sm font-medium transition-colors border-b-2 ${
            activeTab === "all"
              ? "border-gold text-gold"
              : "border-transparent text-txt-3 hover:text-txt hover:border-border-2"
          }`}
        >
          All Issues
        </button>
        <button
          type="button"
          onClick={() => handleTabChange("hidden")}
          className={`pb-3 text-sm font-medium transition-colors border-b-2 ${
            activeTab === "hidden"
              ? "border-gold text-gold"
              : "border-transparent text-txt-3 hover:text-txt hover:border-border-2"
          }`}
        >
          Hidden
        </button>
        <button
          type="button"
          onClick={() => handleTabChange("heartbeats")}
          className={`pb-3 text-sm font-medium transition-colors border-b-2 ${
            activeTab === "heartbeats"
              ? "border-blue-500 text-blue-500"
              : "border-transparent text-txt-3 hover:text-txt hover:border-border-2"
          }`}
        >
          Heartbeats
        </button>
        <button
          type="button"
          onClick={() => handleTabChange("gem456")}
          className={`pb-3 text-sm font-medium transition-colors border-b-2 ${
            activeTab === "gem456"
              ? "border-purple-500 text-purple-500"
              : "border-transparent text-txt-3 hover:text-txt hover:border-border-2"
          }`}
        >
          Long-lived rivalry (GEM-456)
        </button>
      </div>
      <IssuesList
        issues={combinedIssues}
        isLoading={isLoading}
        error={error as Error | null}
        agents={agents}
        projects={projects}
        liveIssueIds={liveIssueIds}
        viewStateKey="paperclip:issues-view"
        issueLinkState={issueLinkState}
        initialAssignees={searchParams.get("assignee") ? [searchParams.get("assignee")!] : undefined}
        initialSearch={initialSearch}
        onSearchChange={handleSearchChange}
        onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
        searchFilters={participantAgentId ? { participantAgentId } : undefined}
      />
    </div>
  );
}
