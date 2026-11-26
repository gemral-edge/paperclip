import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusIcon } from "../components/StatusIcon";

import { EntityRow } from "../components/EntityRow";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { formatDate } from "../lib/utils";
import { ListTodo } from "lucide-react";

export function MyIssues() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "My Issues" }]);
  }, [setBreadcrumbs]);

  const { data: issues, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId ?? ""),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={ListTodo} message="Select a company to view your issues." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  // Show issues that are not assigned (user-created or unassigned)
  const myIssues = (issues ?? []).filter(
    (i) => !i.assigneeAgentId && !["done", "cancelled"].includes(i.status)
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">My Issues</h1>
        {!error && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {myIssues.length} open
          </span>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          <span>{error instanceof Error ? error.message : "Failed to load issues."}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      )}

      {!error && myIssues.length === 0 && (
        <EmptyState icon={ListTodo} message="No issues assigned to you." />
      )}

      {!error && myIssues.length > 0 && (
        <div className="border border-border rounded-md overflow-hidden">
          {myIssues.map((issue) => (
            <EntityRow
              key={issue.id}
              identifier={issue.identifier ?? issue.id.slice(0, 8)}
              title={issue.title}
              to={`/issues/${issue.identifier ?? issue.id}`}
              leading={
                <StatusIcon status={issue.status} />
              }
              trailing={
                <span className="text-xs text-muted-foreground tabular-nums">
                  {formatDate(issue.createdAt)}
                </span>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
