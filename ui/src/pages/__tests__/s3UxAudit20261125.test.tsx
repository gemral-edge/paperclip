// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider } from "../../context/SidebarContext";
import { Inbox } from "../Inbox";
import { OrgChart } from "../OrgChart";
import { NewAgent } from "../NewAgent";

const navigateMock = vi.fn();
const approvalsListMock = vi.fn();
const issuesListMock = vi.fn();
const agentsListMock = vi.fn();
const agentsOrgMock = vi.fn();
const agentsHireMock = vi.fn();
const agentsWakeupMock = vi.fn();
const dashboardSummaryMock = vi.fn();
const heartbeatsListMock = vi.fn();
const companySkillsListMock = vi.fn();

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => navigateMock,
  useLocation: () => ({ pathname: "/inbox/recent", search: "", hash: "" }),
  useParams: () => ({}),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "cmp-1" }),
}));

vi.mock("../../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../../api/approvals", () => ({
  approvalsApi: {
    list: (...args: unknown[]) => approvalsListMock(...args),
    approve: vi.fn(),
    reject: vi.fn(),
  },
}));

vi.mock("../../api/access", () => ({
  accessApi: {
    listJoinRequests: vi.fn(async () => []),
    approveJoinRequest: vi.fn(),
    rejectJoinRequest: vi.fn(),
  },
}));

vi.mock("../../api/dashboard", () => ({
  dashboardApi: {
    summary: (...args: unknown[]) => dashboardSummaryMock(...args),
  },
}));

vi.mock("../../api/issues", () => ({
  issuesApi: {
    list: (...args: unknown[]) => issuesListMock(...args),
    markRead: vi.fn(),
    markUnread: vi.fn(),
    archiveFromInbox: vi.fn(),
  },
}));

vi.mock("../../api/agents", () => ({
  agentsApi: {
    list: (...args: unknown[]) => agentsListMock(...args),
    org: (...args: unknown[]) => agentsOrgMock(...args),
    hire: (...args: unknown[]) => agentsHireMock(...args),
    wakeup: (...args: unknown[]) => agentsWakeupMock(...args),
    adapterModels: vi.fn(async () => []),
  },
}));

vi.mock("../../api/heartbeats", () => ({
  heartbeatsApi: {
    list: (...args: unknown[]) => heartbeatsListMock(...args),
  },
}));

vi.mock("../../api/companySkills", () => ({
  companySkillsApi: {
    list: (...args: unknown[]) => companySkillsListMock(...args),
  },
}));

vi.mock("../../hooks/useInboxBadge", () => ({
  useDismissedInboxItems: () => ({ dismissed: new Set<string>(), dismiss: vi.fn() }),
  useReadInboxItems: () => ({
    readItems: new Set<string>(),
    markRead: vi.fn(),
    markUnread: vi.fn(),
  }),
}));

vi.mock("../../components/AgentConfigForm", () => ({
  AgentConfigForm: () => <div data-testid="agent-config-form" />,
}));

vi.mock("../../adapters", () => ({
  getUIAdapter: () => ({
    buildAdapterConfig: () => ({}),
  }),
}));

vi.mock("../../components/ReportsToPicker", () => ({
  ReportsToPicker: () => <div data-testid="reports-to-picker" />,
}));

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function renderWithQuery(ui: ReactNode) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <SidebarProvider>
          <TooltipProvider>{ui}</TooltipProvider>
        </SidebarProvider>
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

describe("S3 UX Audit 2026-11-25 — Paperclip Pages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    approvalsListMock.mockResolvedValue([]);
    issuesListMock.mockResolvedValue([]);
    agentsListMock.mockResolvedValue([]);
    agentsOrgMock.mockResolvedValue([]);
    dashboardSummaryMock.mockResolvedValue({
      agents: { error: 0 },
      costs: { monthBudgetCents: 0, monthUtilizationPercent: 0 },
    });
    heartbeatsListMock.mockResolvedValue([]);
    companySkillsListMock.mockResolvedValue([]);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("Inbox surfaces issues/runs fetch errors with role=alert and Retry button", async () => {
    issuesListMock.mockRejectedValueOnce(new Error("Issues service unavailable"));
    const { container, unmount } = renderWithQuery(<Inbox />);
    await flush();
    await flush();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Issues service unavailable");
    const retryBtn = Array.from(alert?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent === "Retry",
    );
    expect(retryBtn).toBeTruthy();
    unmount();
  });

  it("OrgChart shows accessible error state and Retry button when org fetch fails, and keyboard-accessible cards + 36px zoom controls when loaded", async () => {
    agentsOrgMock.mockRejectedValueOnce(new Error("Org endpoint offline"));
    const errView = renderWithQuery(<OrgChart />);
    await flush();
    await flush();
    const alert = errView.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Org endpoint offline");
    errView.unmount();

    agentsOrgMock.mockResolvedValueOnce([
      { id: "ag-1", name: "UX Auditor", role: "qa", status: "active", reports: [] },
    ]);
    agentsListMock.mockResolvedValueOnce([
      { id: "ag-1", name: "UX Auditor", role: "qa", adapterType: "claude_local", status: "active" },
    ]);
    const okView = renderWithQuery(<OrgChart />);
    await flush();
    await flush();
    const zoomIn = okView.container.querySelector('button[aria-label="Zoom in"]');
    expect(zoomIn?.getAttribute("type")).toBe("button");
    expect(zoomIn?.className).toContain("w-9 h-9");
    const card = okView.container.querySelector("[data-org-card]") as HTMLElement | null;
    expect(card?.getAttribute("role")).toBe("button");
    expect(card?.getAttribute("tabindex")).toBe("0");
    act(() => {
      card?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(navigateMock).toHaveBeenCalled();
    okView.unmount();
  });

  it("NewAgent does not auto-lock role as CEO when agents list fails to load and surfaces retry alert", async () => {
    agentsListMock.mockRejectedValueOnce(new Error("Agents list unreachable"));
    const { container, unmount } = renderWithQuery(<NewAgent />);
    await flush();
    await flush();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Agents list unreachable");
    const nameInput = container.querySelector('input[aria-label="Agent name"]') as HTMLInputElement;
    expect(nameInput.value).toBe("");
    const roleBtn = container.querySelector('button[aria-label="Agent role"]') as HTMLButtonElement;
    expect(roleBtn.disabled).toBe(false);
    unmount();
  });
});
