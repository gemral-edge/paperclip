// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Issues } from "../Issues";
import { Routines } from "../Routines";
import { GoalDetail } from "../GoalDetail";

const navigateMock = vi.fn();
const issuesListMock = vi.fn();
const issuesGetMock = vi.fn();
const issuesUpdateMock = vi.fn();
const routinesListMock = vi.fn();
const goalsGetMock = vi.fn();
const goalsListMock = vi.fn();
const goalsUpdateMock = vi.fn();

let mockCompanyCtx: {
  selectedCompanyId: string | null;
  setSelectedCompanyId: ReturnType<typeof vi.fn>;
} = {
  selectedCompanyId: "cmp-1",
  setSelectedCompanyId: vi.fn(),
};

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => navigateMock,
  useLocation: () => ({ pathname: "/GEM/issues", search: "", hash: "" }),
  useParams: () => ({ goalId: "goal-1" }),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => mockCompanyCtx,
}));

vi.mock("../../context/DialogContext", () => ({
  useDialog: () => ({ openNewGoal: vi.fn(), openNewIssue: vi.fn() }),
}));

vi.mock("../../context/PanelContext", () => ({
  usePanel: () => ({ openPanel: vi.fn(), closePanel: vi.fn() }),
}));

vi.mock("../../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("../../api/issues", () => ({
  issuesApi: {
    list: (...args: unknown[]) => issuesListMock(...args),
    get: (...args: unknown[]) => issuesGetMock(...args),
    update: (...args: unknown[]) => issuesUpdateMock(...args),
  },
}));

vi.mock("../../api/agents", () => ({
  agentsApi: { list: vi.fn(async () => []) },
}));

vi.mock("../../api/projects", () => ({
  projectsApi: { list: vi.fn(async () => []) },
}));

vi.mock("../../api/heartbeats", () => ({
  heartbeatsApi: { liveRunsForCompany: vi.fn(async () => []) },
}));

vi.mock("../../api/routines", () => ({
  routinesApi: {
    list: (...args: unknown[]) => routinesListMock(...args),
    create: vi.fn(),
    update: vi.fn(),
    run: vi.fn(),
  },
}));

vi.mock("../../api/goals", () => ({
  goalsApi: {
    get: (...args: unknown[]) => goalsGetMock(...args),
    list: (...args: unknown[]) => goalsListMock(...args),
    update: (...args: unknown[]) => goalsUpdateMock(...args),
  },
}));

vi.mock("../../api/assets", () => ({
  assetsApi: { uploadImage: vi.fn() },
}));

vi.mock("../../components/IssuesList", () => ({
  IssuesList: ({
    issues,
    onUpdateIssue,
  }: {
    issues: Array<{ id: string; title: string }>;
    onUpdateIssue: (id: string, data: Record<string, unknown>) => void;
  }) => (
    <div data-testid="issues-list-mock">
      <span>count:{issues.length}</span>
      <button type="button" onClick={() => onUpdateIssue("iss-1", { status: "done" })}>
        Trigger update
      </button>
    </div>
  ),
}));

vi.mock("../../components/GoalProperties", () => ({
  GoalProperties: () => <div />,
}));

vi.mock("../../components/GoalTree", () => ({
  GoalTree: () => <div />,
}));

vi.mock("../../components/InlineEditor", () => ({
  InlineEditor: ({
    value,
    onSave,
  }: {
    value: string;
    onSave: (val: string) => void;
  }) => (
    <div>
      <span>{value}</span>
      <button type="button" onClick={() => onSave("Updated Goal Title")}>
        Save goal field
      </button>
    </div>
  ),
}));

vi.mock("../../components/MarkdownEditor", () => ({
  MarkdownEditor: () => <textarea aria-label="Markdown editor" />,
}));

function renderWithQuery(element: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 5 }, mutations: { retry: false } },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>{element}</TooltipProvider>
      </QueryClientProvider>,
    );
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

describe("S3 UX Audit 2026-11-24 — Issues, Routines & GoalDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mockCompanyCtx = {
      selectedCompanyId: "cmp-1",
      setSelectedCompanyId: vi.fn(),
    };
    issuesListMock.mockResolvedValue([]);
    issuesGetMock.mockResolvedValue(null);
    routinesListMock.mockResolvedValue([]);
    goalsListMock.mockResolvedValue([]);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("Issues: avoids hook-order crash when selectedCompanyId transitions, provides tablist a11y, and renders Retry + mutation role=alert", async () => {
    mockCompanyCtx.selectedCompanyId = null;
    const { container: emptyContainer, unmount: unmountEmpty } = renderWithQuery(<Issues />);
    await flush();
    expect(emptyContainer.textContent).toContain("Select a company to view issues.");
    unmountEmpty();

    mockCompanyCtx.selectedCompanyId = "cmp-1";
    issuesListMock
      .mockRejectedValueOnce(new Error("Issues service unavailable"))
      .mockResolvedValueOnce([{ id: "iss-1", title: "Audit item" }]);
    issuesUpdateMock.mockRejectedValueOnce(new Error("Issue update forbidden"));

    const { container, unmount } = renderWithQuery(<Issues />);
    await flush();

    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist).not.toBeNull();
    const tabs = container.querySelectorAll('[role="tab"]');
    expect(tabs.length).toBe(4);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Issues service unavailable");

    const retryBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Retry",
    );
    expect(retryBtn).toBeTruthy();
    await act(async () => {
      retryBtn!.click();
    });
    await flush();

    expect(container.textContent).toContain("count:1");

    const updateBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Trigger update",
    );
    await act(async () => {
      updateBtn!.click();
    });
    await flush();

    const mutAlert = container.querySelector('[role="alert"]');
    expect(mutAlert?.textContent).toContain("Issue update forbidden");
    unmount();
  });

  it("Routines: hides EmptyState on query error, recovers via Retry, guards invalid dates & supports Enter row navigation", async () => {
    routinesListMock
      .mockRejectedValueOnce(new Error("Routines fetch failed"))
      .mockResolvedValueOnce([
        {
          id: "rt-1",
          companyId: "cmp-1",
          title: "Daily Digest",
          status: "active",
          projectId: "p-1",
          assigneeAgentId: "a-1",
          lastTriggeredAt: "invalid-date-string",
        },
      ]);

    const { container, unmount } = renderWithQuery(<Routines />);
    await flush();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Routines fetch failed");
    expect(container.textContent).not.toContain("No routines yet.");

    const retryBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Retry",
    );
    await act(async () => {
      retryBtn!.click();
    });
    await flush();

    expect(container.textContent).toContain("Daily Digest");
    expect(container.textContent).not.toContain("Invalid Date");
    expect(container.querySelectorAll('th[scope="col"]').length).toBeGreaterThanOrEqual(5);

    const row = container.querySelector("tbody tr");
    expect(row?.getAttribute("tabindex")).toBe("0");
    await act(async () => {
      row!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(navigateMock).toHaveBeenCalledWith("/routines/rt-1");
    unmount();
  });

  it("GoalDetail: renders Retry alert on error, handles null goal safely, and surfaces update errors via role=alert", async () => {
    goalsGetMock.mockResolvedValueOnce(null);
    const { container: nullContainer, unmount: unmountNull } = renderWithQuery(<GoalDetail />);
    await flush();
    expect(nullContainer.textContent).toContain("Goal not found.");
    unmountNull();

    goalsGetMock
      .mockRejectedValueOnce(new Error("Goal load error"))
      .mockResolvedValueOnce({
        id: "goal-1",
        companyId: "cmp-1",
        title: "Increase Retention",
        description: "Goal description",
        level: "company",
        status: "active",
      });
    goalsUpdateMock.mockRejectedValueOnce(new Error("Goal update failed"));

    const { container, unmount } = renderWithQuery(<GoalDetail />);
    await flush();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Goal load error");
    const retryBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Retry",
    );
    await act(async () => {
      retryBtn!.click();
    });
    await flush();

    expect(container.textContent).toContain("Increase Retention");
    const saveBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Save goal field",
    );
    await act(async () => {
      saveBtn!.click();
    });
    await flush();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Goal update failed");
    unmount();
  });
});
