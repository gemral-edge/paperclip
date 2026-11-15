// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, IssueDocument } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueDocumentsSection } from "./IssueDocumentsSection";

const listDocumentsMock = vi.fn();

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/issues/GEM-575", search: "", hash: "" }),
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    listDocuments: (...args: unknown[]) => listDocumentsMock(...args),
    listDocumentRevisions: vi.fn(async () => []),
    upsertDocument: vi.fn(),
    deleteDocument: vi.fn(),
  },
}));

vi.mock("../hooks/useAutosaveIndicator", () => ({
  useAutosaveIndicator: () => ({
    state: "idle",
    markDirty: vi.fn(),
    reset: vi.fn(),
    runSave: async (fn: () => Promise<void>) => {
      await fn();
    },
  }),
}));

vi.mock("@/hooks/useUnsavedChangesGuard", () => ({
  useUnsavedChangesGuard: vi.fn(),
}));

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div data-testid="md-body">{children}</div>,
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: () => <textarea data-testid="md-editor" />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushQueries() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "GEM-575",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Test issue",
    description: null,
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 575,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-11-15T00:00:00.000Z"),
    updatedAt: new Date("2026-11-15T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    isUnreadForMe: false,
    ...overrides,
  };
}

function makeDoc(overrides: Partial<IssueDocument> = {}): IssueDocument {
  return {
    id: "doc-1",
    companyId: "company-1",
    issueId: "issue-1",
    key: "spec-lock",
    title: "Spec Lock",
    format: "markdown",
    body: "# Spec",
    latestRevisionId: "rev-1",
    latestRevisionNumber: 1,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    createdAt: new Date("2026-11-15T00:00:00.000Z"),
    updatedAt: new Date("2026-11-15T00:00:00.000Z"),
    ...overrides,
  };
}

describe("IssueDocumentsSection", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    listDocumentsMock.mockReset();
  });

  afterEach(() => {
    container.remove();
  });

  it("renders loading state and error banner with retry", async () => {
    let resolvePending!: (docs: IssueDocument[]) => void;
    listDocumentsMock.mockImplementationOnce(
      () =>
        new Promise<IssueDocument[]>((resolve) => {
          resolvePending = resolve;
        }),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const root = createRoot(container);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDocumentsSection issue={makeIssue()} canDeleteDocuments />
        </QueryClientProvider>,
      );
    });

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();

    await act(async () => {
      resolvePending([]);
      await new Promise((r) => setTimeout(r, 10));
    });

    listDocumentsMock.mockRejectedValueOnce(new Error("Document store offline"));
    const root2Container = document.createElement("div");
    document.body.appendChild(root2Container);
    const root2 = createRoot(root2Container);
    const queryClient2 = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    act(() => {
      root2.render(
        <QueryClientProvider client={queryClient2}>
          <IssueDocumentsSection issue={makeIssue()} canDeleteDocuments />
        </QueryClientProvider>,
      );
    });
    await flushQueries();

    const alert = root2Container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Document store offline");
    const retryBtn = Array.from(alert?.querySelectorAll("button") ?? []).find((b) =>
      b.textContent?.includes("Retry"),
    );
    expect(retryBtn).toBeDefined();

    listDocumentsMock.mockResolvedValueOnce([]);
    act(() => {
      retryBtn?.click();
    });
    await flushQueries();
    expect(listDocumentsMock).toHaveBeenCalledTimes(3);

    act(() => {
      root.unmount();
      root2.unmount();
    });
    root2Container.remove();
    queryClient.clear();
    queryClient2.clear();
  });

  it("provides explicit aria-labels for icon-only document action buttons", async () => {
    listDocumentsMock.mockResolvedValue([makeDoc()]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const root = createRoot(container);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDocumentsSection issue={makeIssue()} canDeleteDocuments />
        </QueryClientProvider>,
      );
    });
    await flushQueries();

    expect(container.querySelector('button[aria-label="Edit document"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Copy document"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Delete document"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Document actions"]')).not.toBeNull();

    act(() => {
      root.unmount();
    });
    queryClient.clear();
  });
});
