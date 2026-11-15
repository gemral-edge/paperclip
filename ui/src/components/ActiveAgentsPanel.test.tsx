// @vitest-environment node

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Agent, Issue } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import type { LiveRunForIssue } from "../api/heartbeats";
import {
  CancelRunButton,
  RunNowButton,
  cancelRunAndLinkedIssue,
  isRunCancellable,
  runCardNow,
  type RunNowDeps,
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

  it("renders icon-only X cancel button only for queued and running runs with Vietnamese aria-label", () => {
    const queryClient = new QueryClient();
    const issue = makeIssue();

    const queuedHtml = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <CancelRunButton run={makeRun({ status: "queued" })} issue={issue} companyId="company-1" />
      </QueryClientProvider>,
    );
    expect(queuedHtml).toContain("<svg");
    expect(queuedHtml).toContain('aria-label="Hủy lượt xếp hàng và hủy issue GEM-2200"');
    expect(queuedHtml).not.toContain(">Hủy<");

    const runningHtml = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <CancelRunButton run={makeRun({ status: "running" })} companyId="company-1" />
      </QueryClientProvider>,
    );
    expect(runningHtml).toContain("<svg");
    expect(runningHtml).toContain('aria-label="Hủy lượt đang chạy và hủy issue issue-12"');
    expect(runningHtml).not.toContain(">Hủy<");

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

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Yinyang SEO Officer",
    urlKey: "yinyang-seo-officer",
    role: "general",
    status: "idle",
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: { canCreateAgents: false },
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    reportsTo: null,
    title: null,
    icon: null,
    capabilities: null,
    metadata: null,
    pauseReason: null,
    pausedAt: null,
    lastHeartbeatAt: null,
    createdAt: new Date("2026-11-15T00:00:00.000Z"),
    updatedAt: new Date("2026-11-15T00:00:00.000Z"),
    ...overrides,
  } as Agent;
}

function makeRunNowDeps(overrides: Partial<RunNowDeps> = {}): RunNowDeps {
  return {
    startNow: vi.fn(async (runId) => ({ id: runId, status: "running" })),
    wakeupAgent: vi.fn(async () => ({ id: "run-new", status: "queued" })),
    invokeAgent: vi.fn(async () => ({ id: "run-invoked", status: "queued" })),
    listLiveRunsForIssue: vi.fn(async () => []),
    listLiveRunsForCompany: vi.fn(async () => []),
    ...overrides,
  };
}

describe("ActiveAgentsPanel runCardNow and RunNowButton", () => {
  it("calls startNow directly when queued run is still valid", async () => {
    const deps = makeRunNowDeps();
    const res = await runCardNow(
      makeRun({ id: "run-queued-1", status: "queued" }),
      "agent-1",
      "company-1",
      deps,
    );

    expect(deps.startNow).toHaveBeenCalledTimes(1);
    expect(deps.startNow).toHaveBeenCalledWith("run-queued-1");
    expect(deps.wakeupAgent).not.toHaveBeenCalled();
    expect(res).toEqual({ id: "run-queued-1", status: "running" });
  });

  it("recovers from stale 409 not_queued run after >5m idle by starting fresher queued run on the same issue", async () => {
    const startNow = vi
      .fn<RunNowDeps["startNow"]>()
      .mockRejectedValueOnce(new ApiError("Lượt này không còn ở hàng chờ", 409, { reason: "not_queued" }))
      .mockResolvedValueOnce({ id: "run-queued-fresh", status: "running" });
    const deps = makeRunNowDeps({
      startNow,
      listLiveRunsForIssue: vi.fn(async () => [
        { id: "run-1", status: "cancelled", agentId: "agent-1" },
        { id: "run-queued-fresh", status: "queued", agentId: "agent-1" },
      ]),
    });

    const res = await runCardNow(
      makeRun({ id: "run-1", status: "queued", issueId: "issue-123" }),
      "agent-1",
      "company-1",
      deps,
    );

    expect(deps.listLiveRunsForIssue).toHaveBeenCalledWith("issue-123");
    expect(startNow).toHaveBeenNthCalledWith(1, "run-1");
    expect(startNow).toHaveBeenNthCalledWith(2, "run-queued-fresh");
    expect(deps.wakeupAgent).not.toHaveBeenCalled();
    expect(res).toEqual({ id: "run-queued-fresh", status: "running" });
  });

  it("falls back to wakeup + startNow when stale queued run no longer exists or finished after >5m idle", async () => {
    const startNow = vi
      .fn<RunNowDeps["startNow"]>()
      .mockRejectedValueOnce(new ApiError("Lượt này không còn ở hàng chờ", 409, { reason: "not_queued" }))
      .mockResolvedValueOnce({ id: "run-woken-1", status: "running" });
    const deps = makeRunNowDeps({
      startNow,
      listLiveRunsForIssue: vi.fn(async () => [{ id: "run-1", status: "timed_out", agentId: "agent-1" }]),
      wakeupAgent: vi.fn(async () => ({ id: "run-woken-1", status: "queued" })),
    });

    const res = await runCardNow(
      makeRun({ id: "run-1", status: "queued", issueId: "issue-999" }),
      "agent-1",
      "company-1",
      deps,
    );

    expect(deps.wakeupAgent).toHaveBeenCalledWith(
      "agent-1",
      {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "rerun_from_dashboard",
        payload: { issueId: "issue-999" },
      },
      "company-1",
    );
    expect(startNow).toHaveBeenNthCalledWith(1, "run-1");
    expect(startNow).toHaveBeenNthCalledWith(2, "run-woken-1");
    expect(res).toEqual({ id: "run-woken-1", status: "running" });
  });

  it("recovers via invokeAgent + startNow when stale queued card has no issueId", async () => {
    const startNow = vi
      .fn<RunNowDeps["startNow"]>()
      .mockRejectedValueOnce(new ApiError("Not found", 404, {}))
      .mockResolvedValueOnce({ id: "run-invoked-1", status: "running" });
    const deps = makeRunNowDeps({
      startNow,
      listLiveRunsForCompany: vi.fn(async () => [
        { id: "run-other-agent", status: "queued", agentId: "agent-other", issueId: null },
      ]),
      invokeAgent: vi.fn(async () => ({ id: "run-invoked-1", status: "queued" })),
    });

    const res = await runCardNow(
      makeRun({ id: "run-stale-no-issue", status: "queued", issueId: null }),
      "agent-1",
      "company-1",
      deps,
    );

    expect(deps.listLiveRunsForCompany).toHaveBeenCalledWith("company-1", 16);
    expect(deps.invokeAgent).toHaveBeenCalledWith("agent-1", "company-1");
    expect(startNow).toHaveBeenNthCalledWith(2, "run-invoked-1");
    expect(res).toEqual({ id: "run-invoked-1", status: "running" });
  });

  it("returns already-running run when stale queued card is already active on server and rethrows non-stale errors", async () => {
    const startNowRunning = vi
      .fn<RunNowDeps["startNow"]>()
      .mockRejectedValueOnce(new ApiError("Not queued", 409, { reason: "not_queued" }));
    const depsRunning = makeRunNowDeps({
      startNow: startNowRunning,
      listLiveRunsForIssue: vi.fn(async () => [
        { id: "run-active-2", status: "running", agentId: "agent-1" },
      ]),
    });

    const activeRes = await runCardNow(
      makeRun({ id: "run-1", status: "queued", issueId: "issue-active" }),
      "agent-1",
      "company-1",
      depsRunning,
    );
    expect(activeRes).toEqual({ id: "run-active-2", status: "running", agentId: "agent-1" });
    expect(depsRunning.wakeupAgent).not.toHaveBeenCalled();

    const depsBusy = makeRunNowDeps({
      startNow: vi.fn(async () => {
        throw new ApiError("Agent busy", 409, { reason: "agent_busy" });
      }),
    });
    await expect(
      runCardNow(makeRun({ id: "run-1", status: "queued" }), "agent-1", "company-1", depsBusy),
    ).rejects.toThrow("Agent busy");
  });

  it("immediately calls startNow when clicking ▶ on finished card gets throttled as queued", async () => {
    for (const status of ["succeeded", "failed", "timed_out", "cancelled"]) {
      const deps = makeRunNowDeps({
        wakeupAgent: vi.fn(async () => ({ id: `run-rerun-${status}`, status: "queued" })),
        startNow: vi.fn(async (runId) => ({ id: runId, status: "running" })),
      });
      const res = await runCardNow(
        makeRun({ id: `run-${status}`, status, issueId: "issue-555" }),
        "agent-1",
        "company-1",
        deps,
      );
      expect(deps.wakeupAgent).toHaveBeenCalledTimes(1);
      expect(deps.startNow).toHaveBeenCalledWith(`run-rerun-${status}`);
      expect(res).toEqual({ id: `run-rerun-${status}`, status: "running" });
    }

    const noIssueDeps = makeRunNowDeps({
      invokeAgent: vi.fn(async () => ({ id: "run-invoke-queued", status: "queued" })),
      startNow: vi.fn(async (runId) => ({ id: runId, status: "running" })),
    });
    const noIssueRes = await runCardNow(
      makeRun({ id: "run-no-issue-done", status: "succeeded", issueId: null }),
      "agent-1",
      "company-1",
      noIssueDeps,
    );
    expect(noIssueDeps.invokeAgent).toHaveBeenCalledWith("agent-1", "company-1");
    expect(noIssueDeps.startNow).toHaveBeenCalledWith("run-invoke-queued");
    expect(noIssueRes).toEqual({ id: "run-invoke-queued", status: "running" });
  });

  it("renders RunNowButton enabled for queued/finished runs, disabled when agent paused, and hidden while running", () => {
    const queryClient = new QueryClient();
    const idleAgent = makeAgent({ status: "idle" });
    const pausedAgent = makeAgent({ status: "paused" });

    const queuedHtml = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <RunNowButton run={makeRun({ status: "queued" })} agent={idleAgent} companyId="company-1" />
      </QueryClientProvider>,
    );
    expect(queuedHtml).toContain("Chạy ngay lượt đang chờ (vượt giới hạn chạy cùng lúc)");
    expect(queuedHtml).not.toMatch(/\sdisabled(?:=|\s|>)/);

    const finishedHtml = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <RunNowButton run={makeRun({ status: "succeeded" })} agent={idleAgent} companyId="company-1" />
      </QueryClientProvider>,
    );
    expect(finishedHtml).toContain("Chạy lại việc này");
    expect(finishedHtml).not.toMatch(/\sdisabled(?:=|\s|>)/);

    const pausedHtml = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <RunNowButton run={makeRun({ status: "queued" })} agent={pausedAgent} companyId="company-1" />
      </QueryClientProvider>,
    );
    expect(pausedHtml).toMatch(/\sdisabled=""/);
    expect(pausedHtml).toContain("Agent đang dừng, bật lại agent trước");

    const runningHtml = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <RunNowButton run={makeRun({ status: "running" })} agent={idleAgent} companyId="company-1" />
      </QueryClientProvider>,
    );
    expect(runningHtml).toBe("");
  });
});
