// @vitest-environment node

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import type { LiveRunForIssue } from "../api/heartbeats";
import {
  CancelRunButton,
  cancelRunAndLinkedIssue,
  isRunCancellable,
} from "./ActiveAgentsPanel";

function makeRun(overrides: Partial<LiveRunForIssue> = {}): LiveRunForIssue {
  return {
    id: "run-1",
    status: "queued",
    invocationSource: "assignment",
    triggerDetail: "system",
    startedAt: null,
    finishedAt: null,
    createdAt: "2026-11-15T00:00:00.000Z",
    agentId: "agent-1",
    agentName: "Yinyang SEO Officer",
    adapterType: "claude_local",
    issueId: "issue-12345678-aaaa-bbbb",
    ...overrides,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-12345678-aaaa-bbbb",
    identifier: "GEM-2200",
    companyId: "company-1",
    projectId: null,
    goalId: null,
    parentId: null,
    title: "Test issue",
    description: null,
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    issueNumber: 2200,
    createdAt: new Date("2026-11-15T00:00:00.000Z"),
    updatedAt: new Date("2026-11-15T00:00:00.000Z"),
    ...overrides,
  } as Issue;
}

describe("ActiveAgentsPanel cancel support", () => {
  it("treats only queued and running statuses as cancellable", () => {
    expect(isRunCancellable("queued")).toBe(true);
    expect(isRunCancellable("running")).toBe(true);
    expect(isRunCancellable("succeeded")).toBe(false);
    expect(isRunCancellable("failed")).toBe(false);
    expect(isRunCancellable("cancelled")).toBe(false);
    expect(isRunCancellable("timed_out")).toBe(false);
  });

  it("cancels run, sets linked issue to cancelled, and drains promoted queued/running wakeups", async () => {
    const cancelRun = vi.fn(async () => undefined);
    const updateIssue = vi.fn(async () => ({ id: "issue-12345678-aaaa-bbbb", status: "cancelled" }));
    const listLiveRunsForIssue = vi
      .fn<() => Promise<Array<{ id: string; status: string }>>>()
      .mockResolvedValueOnce([
        { id: "run-1", status: "cancelled" },
        { id: "run-promoted-1", status: "queued" },
        { id: "run-finished", status: "succeeded" },
      ])
      .mockResolvedValueOnce([]);

    await cancelRunAndLinkedIssue(
      { id: "run-1", issueId: "issue-12345678-aaaa-bbbb" },
      { cancelRun, updateIssue, listLiveRunsForIssue },
    );

    expect(cancelRun).toHaveBeenNthCalledWith(1, "run-1");
    expect(updateIssue).toHaveBeenCalledWith("issue-12345678-aaaa-bbbb", { status: "cancelled" });
    expect(cancelRun).toHaveBeenNthCalledWith(2, "run-promoted-1");
    expect(cancelRun).toHaveBeenCalledTimes(2);
    expect(listLiveRunsForIssue).toHaveBeenCalledTimes(2);
  });

  it("ignores 404 when linked issue was already deleted, rethrows non-404 errors, and skips issue steps when issueId is missing", async () => {
    const cancelRun = vi.fn(async () => undefined);
    const updateIssue404 = vi.fn(async () => {
      throw new ApiError("Not found", 404, {});
    });
    const listLiveRunsForIssue = vi.fn(async () => []);

    await expect(
      cancelRunAndLinkedIssue(
        { id: "run-1", issueId: "missing-issue" },
        { cancelRun, updateIssue: updateIssue404, listLiveRunsForIssue },
      ),
    ).resolves.toBeUndefined();
    expect(listLiveRunsForIssue).toHaveBeenCalledWith("missing-issue");

    const updateIssue500 = vi.fn(async () => {
      throw new ApiError("Server error", 500, {});
    });
    await expect(
      cancelRunAndLinkedIssue(
        { id: "run-1", issueId: "broken-issue" },
        { cancelRun, updateIssue: updateIssue500, listLiveRunsForIssue },
      ),
    ).rejects.toThrow("Server error");

    const cancelRunNoIssue = vi.fn(async () => undefined);
    const updateIssueUnused = vi.fn(async () => ({}));
    const listUnused = vi.fn(async () => []);
    await cancelRunAndLinkedIssue(
      { id: "run-no-issue", issueId: null },
      { cancelRun: cancelRunNoIssue, updateIssue: updateIssueUnused, listLiveRunsForIssue: listUnused },
    );
    expect(cancelRunNoIssue).toHaveBeenCalledWith("run-no-issue");
    expect(updateIssueUnused).not.toHaveBeenCalled();
    expect(listUnused).not.toHaveBeenCalled();
  });

  it("renders Hủy button only for queued and running runs with proper Vietnamese labels", () => {
    const queryClient = new QueryClient();
    const issue = makeIssue();

    const queuedHtml = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <CancelRunButton run={makeRun({ status: "queued" })} issue={issue} companyId="company-1" />
      </QueryClientProvider>,
    );
    expect(queuedHtml).toContain("Hủy");
    expect(queuedHtml).toContain('aria-label="Hủy lượt xếp hàng và hủy issue GEM-2200"');

    const runningHtml = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <CancelRunButton run={makeRun({ status: "running" })} companyId="company-1" />
      </QueryClientProvider>,
    );
    expect(runningHtml).toContain("Hủy");
    expect(runningHtml).toContain('aria-label="Hủy lượt đang chạy và hủy issue issue-12"');

    for (const status of ["succeeded", "failed", "cancelled", "timed_out"]) {
      const doneHtml = renderToStaticMarkup(
        <QueryClientProvider client={queryClient}>
          <CancelRunButton run={makeRun({ status })} issue={issue} companyId="company-1" />
        </QueryClientProvider>,
      );
      expect(doneHtml).toBe("");
    }
  });
});
