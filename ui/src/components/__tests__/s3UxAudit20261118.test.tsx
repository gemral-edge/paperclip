// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, IssueComment } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentComposer, CommentThread } from "../CommentThread";
import { IssueProperties } from "../IssueProperties";

const deleteDocumentMock = vi.fn();
const createLabelMock = vi.fn();
const deleteLabelMock = vi.fn();

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => ({ pathname: "/issues/GEM-575", search: "", hash: "" }),
}));

vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../../api/agents", () => ({
  agentsApi: { list: vi.fn(async () => []) },
}));

vi.mock("../../api/auth", () => ({
  authApi: { getSession: vi.fn(async () => ({ user: { id: "user-1" } })) },
}));

vi.mock("../../api/projects", () => ({
  projectsApi: { list: vi.fn(async () => []) },
}));

vi.mock("../../api/issues", () => ({
  issuesApi: {
    listLabels: vi.fn(async () => []),
    listDocuments: vi.fn(async () => [
      { id: "doc-1", key: "spec", title: "Spec Doc", updatedAt: "2026-11-18T00:00:00Z" },
    ]),
    deleteDocument: (...args: unknown[]) => deleteDocumentMock(...args),
    createLabel: (...args: unknown[]) => createLabelMock(...args),
    deleteLabel: (...args: unknown[]) => deleteLabelMock(...args),
  },
}));

vi.mock("../../hooks/useProjectOrder", () => ({
  useProjectOrder: () => ({ orderedProjects: [] }),
}));

vi.mock("../MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => (
    <div data-testid="md-body">
      {children.includes("[ ]") ? (
        <ul>
          <li className="task-list-item">
            <input type="checkbox" defaultChecked /> Approve task
          </li>
        </ul>
      ) : (
        children
      )}
    </div>
  ),
}));

vi.mock("../MarkdownEditor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (val: string) => void;
    placeholder?: string;
  }) => (
    <textarea
      aria-label={placeholder ?? "markdown"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: () => null,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuRadioGroup: ({
    children,
    onValueChange,
  }: {
    children: ReactNode;
    value: string;
    onValueChange: (val: string) => void;
  }) => (
    <div
      onClick={(e) => {
        const target = (e.target as HTMLElement).closest("[data-radio-value]") as HTMLElement | null;
        if (target?.dataset.radioValue) onValueChange(target.dataset.radioValue);
      }}
    >
      {children}
    </div>
  ),
  DropdownMenuRadioItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <button type="button" data-radio-value={value}>
      {children}
    </button>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  for (let i = 0; i < 4; i += 1) {
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
    createdAt: new Date("2026-11-18T00:00:00.000Z"),
    updatedAt: new Date("2026-11-18T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    isUnreadForMe: false,
    ...overrides,
  };
}

function makeComment(overrides: Partial<IssueComment> = {}): IssueComment {
  return {
    id: "comment-1",
    companyId: "company-1",
    issueId: "issue-1",
    authorAgentId: null,
    authorUserId: "user-1",
    body: "Hello world",
    createdAt: new Date("2026-11-18T01:00:00.000Z"),
    updatedAt: new Date("2026-11-18T01:00:00.000Z"),
    ...overrides,
  };
}

describe("S3 UX Audit 2026-11-18 — CommentThread & IssueProperties", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    container.remove();
  });

  it("shows inline alert and restores draft when CommentComposer submit fails", async () => {
    const onAdd = vi.fn().mockRejectedValue(new Error("Network timeout"));
    const root = createRoot(container);

    await act(async () => {
      root.render(<CommentComposer onAdd={onAdd} />);
    });

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, "Draft reply");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const submitBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Comment",
    ) as HTMLButtonElement;
    await act(async () => {
      submitBtn.click();
    });
    await flush();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Network timeout");
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Draft reply");

    await act(async () => {
      root.unmount();
    });
  });

  it("shows Reset filter button on empty filtered timeline and restores items", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <CommentThread
          comments={[makeComment({ id: "c1", body: "Visible item" })]}
          onAdd={vi.fn(async () => {})}
        />,
      );
    });

    const onlyRunsBtn = container.querySelector('[data-radio-value="run"]') as HTMLButtonElement;
    await act(async () => {
      onlyRunsBtn.click();
    });
    await flush();

    expect(container.textContent).toContain("No comments or runs match the filter.");
    const resetBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Reset filter",
    ) as HTMLButtonElement;
    expect(resetBtn).toBeTruthy();

    await act(async () => {
      resetBtn.click();
    });
    await flush();

    expect(container.textContent).toContain("Visible item");

    await act(async () => {
      root.unmount();
    });
  });

  it("shows dismissible role=alert banner when IssueProperties deleteDocument fails", async () => {
    deleteDocumentMock.mockRejectedValueOnce(new Error("Delete forbidden"));
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <IssueProperties issue={makeIssue()} onUpdate={vi.fn()} inline />
        </QueryClientProvider>,
      );
    });
    await flush();

    const delBtn = container.querySelector('button[aria-label="Delete Spec Doc"]') as HTMLButtonElement;
    expect(delBtn).toBeTruthy();
    await act(async () => {
      delBtn.click();
    });
    await flush();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Delete forbidden");

    const dismissBtn = container.querySelector('button[aria-label="Dismiss error"]') as HTMLButtonElement;
    await act(async () => {
      dismissBtn.click();
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
});
