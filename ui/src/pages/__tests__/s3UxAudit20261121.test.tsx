// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Dashboard } from "../Dashboard";
import { Companies } from "../Companies";
import { ApprovalDetail } from "../ApprovalDetail";

const dashboardSummaryMock = vi.fn();
const companiesStatsMock = vi.fn();
const companiesUpdateMock = vi.fn();
const companiesRemoveMock = vi.fn();
const approvalGetMock = vi.fn();
const approvalCommentsMock = vi.fn();

let mockCompanyCtx: {
  companies: Array<{
    id: string;
    name: string;
    issuePrefix: string;
    status: string;
    budgetMonthlyCents: number;
    spentMonthlyCents: number;
    requireBoardApprovalForNewAgents: boolean;
    brandColor?: string | null;
    createdAt: string;
  }>;
  selectedCompanyId: string | null;
  selectedCompany: { id: string; name: string; issuePrefix: string } | null;
  setSelectedCompanyId: ReturnType<typeof vi.fn>;
  loading: boolean;
  error: Error | null;
} = {
  companies: [],
  selectedCompanyId: "cmp-1",
  selectedCompany: { id: "cmp-1", name: "Gemral", issuePrefix: "GEM" },
  setSelectedCompanyId: vi.fn(),
  loading: false,
  error: null,
};

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
  useParams: () => ({ approvalId: "appr-1" }),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => mockCompanyCtx,
}));

vi.mock("../../context/DialogContext", () => ({
  useDialog: () => ({ openOnboarding: vi.fn() }),
}));

vi.mock("../../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/components/ConfirmDialog", () => ({
  useConfirm: () => vi.fn(async () => true),
}));

vi.mock("../../api/dashboard", () => ({
  dashboardApi: { summary: (...args: unknown[]) => dashboardSummaryMock(...args) },
}));

vi.mock("../../api/activity", () => ({
  activityApi: { list: vi.fn(async () => []) },
}));

vi.mock("../../api/issues", () => ({
  issuesApi: { list: vi.fn(async () => []) },
}));

vi.mock("../../api/agents", () => ({
  agentsApi: { list: vi.fn(async () => []) },
}));

vi.mock("../../api/projects", () => ({
  projectsApi: { list: vi.fn(async () => []) },
}));

vi.mock("../../api/heartbeats", () => ({
  heartbeatsApi: { list: vi.fn(async () => []) },
}));

vi.mock("../../api/companies", () => ({
  companiesApi: {
    stats: (...args: unknown[]) => companiesStatsMock(...args),
    update: (...args: unknown[]) => companiesUpdateMock(...args),
    remove: (...args: unknown[]) => companiesRemoveMock(...args),
  },
}));

vi.mock("../../api/approvals", () => ({
  approvalsApi: {
    get: (...args: unknown[]) => approvalGetMock(...args),
    listComments: (...args: unknown[]) => approvalCommentsMock(...args),
    approve: vi.fn(),
    reject: vi.fn(),
    requestRevision: vi.fn(),
    resubmit: vi.fn(),
    addComment: vi.fn(),
  },
}));

vi.mock("@/components/knowledge-graph/KGMiniWidget", () => ({
  default: () => <div data-testid="kg-mini" />,
}));
vi.mock("@/components/timetable/TimetableWidget", () => ({
  default: () => <div data-testid="timetable-mini" />,
}));
vi.mock("@/components/ops/ChannelStatusCards", () => ({
  ChannelStatusCards: () => <div />,
}));
vi.mock("@/components/ops/AgentStatusGrid", () => ({
  AgentStatusGrid: () => <div />,
}));
vi.mock("@/components/ops/CRMPipelineCard", () => ({
  CRMPipelineCard: () => <div />,
}));
vi.mock("@/components/ops/ActivityFeed", () => ({
  ActivityFeed: () => <div />,
}));
vi.mock("@/components/ops/CapabilitiesGrid", () => ({
  CapabilitiesGrid: () => <div />,
}));
vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: () => null,
}));
vi.mock("@/hooks/useLiveInvalidate", () => ({
  useLiveInvalidate: vi.fn(),
}));
vi.mock("../../components/ActiveAgentsPanel", () => ({
  ActiveAgentsPanel: () => <div />,
}));
vi.mock("../../components/FleetControlBar", () => ({
  FleetControlBar: () => <div />,
}));
vi.mock("../../components/AttentionStrip", () => ({
  AttentionStrip: () => <div />,
}));
vi.mock("../../components/UnifiedTasksAndActivity", () => ({
  UnifiedTasksAndActivity: () => <div />,
}));
vi.mock("../../components/ActivityCharts", () => ({
  ChartCard: ({ title, children }: { title: string; children: ReactNode }) => (
    <div>
      <span>{title}</span>
      {children}
    </div>
  ),
  RunActivityChart: () => <div />,
  PriorityChart: () => <div />,
  IssueStatusChart: () => <div />,
  SuccessRateChart: () => <div />,
}));
vi.mock("../../components/ApprovalPayload", () => ({
  approvalLabel: (type: string) => type,
  typeIcon: {},
  defaultTypeIcon: () => <span />,
  ApprovalPayloadRenderer: () => <div />,
}));
vi.mock("../../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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

describe("S3 UX Audit 2026-11-21 — Dashboard, Companies & ApprovalDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mockCompanyCtx = {
      companies: [],
      selectedCompanyId: "cmp-1",
      selectedCompany: { id: "cmp-1", name: "Gemral", issuePrefix: "GEM" },
      setSelectedCompanyId: vi.fn(),
      loading: false,
      error: null,
    };
    companiesStatsMock.mockResolvedValue({});
    approvalCommentsMock.mockResolvedValue([]);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("Dashboard: renders Retry alert on summary error, recovers on Retry, and keeps Light Mode incident contrast", async () => {
    dashboardSummaryMock
      .mockRejectedValueOnce(new Error("Dashboard summary unavailable"))
      .mockRejectedValueOnce(new Error("Dashboard summary unavailable"))
      .mockResolvedValueOnce({
        agents: { active: 1, running: 0, paused: 0, error: 0 },
        tasks: { open: 2, inProgress: 1, blocked: 0, done: 4 },
        costs: { monthSpendCents: 1200, monthBudgetCents: 5000, monthUtilizationPercent: 24 },
        pendingApprovals: 0,
        budgets: { activeIncidents: 2, pausedAgents: 1, pausedProjects: 0, pendingApprovals: 1 },
      });

    const { container, unmount } = renderWithQuery(<Dashboard />);
    await flush();

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("Dashboard summary unavailable");

    const retryBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Retry",
    );
    expect(retryBtn).toBeTruthy();
    expect(retryBtn?.getAttribute("type")).toBe("button");

    await act(async () => {
      retryBtn!.click();
    });
    await flush();

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("2 active budget incidents");
    expect(container.innerHTML).toContain("text-red-900");
    expect(container.innerHTML).toContain("bg-red-50");
    unmount();
  });

  it("Companies: renders EmptyState when companies list is empty and role=alert on rename mutation error", async () => {
    const { container: emptyContainer, unmount: unmountEmpty } = renderWithQuery(<Companies />);
    await flush();
    expect(emptyContainer.textContent).toContain("No companies yet");
    unmountEmpty();

    mockCompanyCtx.companies = [
      {
        id: "cmp-1",
        name: "Gemral",
        issuePrefix: "GEM",
        status: "active",
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
        requireBoardApprovalForNewAgents: false,
        createdAt: "2026-11-01T00:00:00Z",
      },
    ];
    companiesUpdateMock.mockRejectedValueOnce(new Error("Rename company denied"));

    const { container, unmount } = renderWithQuery(<Companies />);
    await flush();

    const renameBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Rename Gemral",
    );
    expect(renameBtn).toBeTruthy();

    await act(async () => {
      renameBtn!.click();
    });
    await flush();

    const saveBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Save company name",
    );
    expect(saveBtn).toBeTruthy();

    await act(async () => {
      saveBtn!.click();
    });
    await flush();

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("Rename company denied");
    unmount();
  });

  it("ApprovalDetail: renders loadError Retry alert separately from not-found, handles invalid comment date, and labels comment textarea", async () => {
    approvalGetMock
      .mockRejectedValueOnce(new Error("Approval service timeout"))
      .mockResolvedValueOnce({
        id: "appr-1",
        companyId: "cmp-1",
        type: "hire_agent",
        status: "pending",
        payload: {},
        createdAt: "2026-11-21T00:00:00Z",
        requestedByAgentId: null,
        requestedByUserId: null,
        decisionNote: null,
      });
    approvalCommentsMock.mockResolvedValue([
      {
        id: "c-1",
        approvalId: "appr-1",
        authorAgentId: null,
        authorUserId: "user-1",
        body: "Looks good",
        createdAt: "not-a-valid-date",
      },
    ]);

    const { container, unmount } = renderWithQuery(<ApprovalDetail />);
    await flush();

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("Approval service timeout");
    expect(container.textContent).not.toContain("Approval not found.");

    const retryBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Retry",
    );
    expect(retryBtn).toBeTruthy();
    await act(async () => {
      retryBtn!.click();
    });
    await flush();

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain("Invalid Date");
    const textarea = container.querySelector('textarea[aria-label="Approval comment"]');
    expect(textarea).not.toBeNull();
    unmount();
  });
});
