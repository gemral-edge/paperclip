// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Approvals } from "../Approvals";
import { Costs } from "../Costs";
import { Goals } from "../Goals";

const approvalsListMock = vi.fn();
const costsSummaryMock = vi.fn();
const budgetsOverviewMock = vi.fn();
const goalsListMock = vi.fn();
const navigateMock = vi.fn();

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => navigateMock,
  useLocation: () => ({ pathname: "/approvals/pending", search: "", hash: "" }),
}));

vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../../context/DialogContext", () => ({
  useDialog: () => ({ openNewGoal: vi.fn() }),
}));

vi.mock("../../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false }),
}));

vi.mock("../../api/approvals", () => ({
  approvalsApi: {
    list: (...args: unknown[]) => approvalsListMock(...args),
    approve: vi.fn(),
    reject: vi.fn(),
  },
}));

vi.mock("../../api/agents", () => ({
  agentsApi: { list: vi.fn(async () => []) },
}));

vi.mock("../../api/budgets", () => ({
  budgetsApi: {
    overview: (...args: unknown[]) => budgetsOverviewMock(...args),
    upsertPolicy: vi.fn(),
    resolveIncident: vi.fn(),
  },
}));

vi.mock("../../api/costs", () => ({
  costsApi: {
    summary: (...args: unknown[]) => costsSummaryMock(...args),
    byAgent: vi.fn(async () => []),
    byProject: vi.fn(async () => []),
    byAgentModel: vi.fn(async () => []),
    financeSummary: vi.fn(async () => ({ debitCents: 0, creditCents: 0, netCents: 0, estimatedDebitCents: 0, eventCount: 0 })),
    financeByBiller: vi.fn(async () => []),
    financeByKind: vi.fn(async () => []),
    financeEvents: vi.fn(async () => []),
    byProvider: vi.fn(async () => []),
    byBiller: vi.fn(async () => []),
    windowSpend: vi.fn(async () => []),
    quotaWindows: vi.fn(async () => []),
  },
}));

vi.mock("../../api/goals", () => ({
  goalsApi: {
    list: (...args: unknown[]) => goalsListMock(...args),
  },
}));

function renderWithQuery(element: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRoot(container);
  act(() => {
    root.render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("S3 UX Audit 2026-11-19 — Approvals, Costs, Goals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("Approvals: renders Retry button on load error and recovers", async () => {
    approvalsListMock
      .mockRejectedValueOnce(new Error("Approvals API down"))
      .mockResolvedValueOnce([]);

    const view = renderWithQuery(<Approvals />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    const alert = view.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Approvals API down");

    const retryBtn = Array.from(view.container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Retry"),
    );
    expect(retryBtn).toBeTruthy();

    await act(async () => {
      retryBtn?.click();
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(view.container.textContent).toContain("No pending approvals.");
    view.unmount();
  });

  it("Goals: renders Retry button on load error and recovers", async () => {
    goalsListMock
      .mockRejectedValueOnce(new Error("Goals API down"))
      .mockResolvedValueOnce([]);

    const view = renderWithQuery(<Goals />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    const alert = view.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Goals API down");

    const retryBtn = Array.from(view.container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Retry"),
    );
    expect(retryBtn).toBeTruthy();

    await act(async () => {
      retryBtn?.click();
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(view.container.textContent).toContain("No goals yet.");
    view.unmount();
  });

  it("Costs: renders Retry on overview failure and makes main TabsList horizontally scrollable", async () => {
    budgetsOverviewMock.mockResolvedValue({
      policies: [],
      activeIncidents: [],
      pendingApprovalCount: 0,
      pausedAgentCount: 0,
      pausedProjectCount: 0,
    });
    costsSummaryMock
      .mockRejectedValueOnce(new Error("Costs RPC down"))
      .mockResolvedValue({ spendCents: 1200, budgetCents: 0, utilizationPercent: 0 });

    const view = renderWithQuery(<Costs />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    const tablist = view.container.querySelector('[role="tablist"]');
    expect(tablist?.className).toContain("overflow-x-auto");

    const alert = view.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Costs RPC down");

    const retryBtn = Array.from(view.container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Retry"),
    );
    expect(retryBtn).toBeTruthy();

    await act(async () => {
      retryBtn?.click();
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(view.container.textContent).toContain("$12.00");
    view.unmount();
  });
});
