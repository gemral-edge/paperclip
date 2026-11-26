// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider } from "../../context/SidebarContext";
import { OperationsCenter } from "../OperationsCenter";
import { MyIssues } from "../MyIssues";
import { InstanceGeneralSettings } from "../InstanceGeneralSettings";

const issuesListMock = vi.fn();
const getGeneralMock = vi.fn();
const updateGeneralMock = vi.fn();

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/ops", search: "", hash: "" }),
  useParams: () => ({}),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "cmp-1" }),
}));

vi.mock("../../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../../api/issues", () => ({
  issuesApi: {
    list: (...args: unknown[]) => issuesListMock(...args),
  },
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: {
    getGeneral: (...args: unknown[]) => getGeneralMock(...args),
    updateGeneral: (...args: unknown[]) => updateGeneralMock(...args),
  },
}));

vi.mock("@/components/ops/ChannelStatusCards", () => ({
  ChannelStatusCards: () => <div data-testid="ops-channels" />,
}));
vi.mock("@/components/ops/AgentStatusGrid", () => ({
  AgentStatusGrid: () => <div data-testid="ops-agents" />,
}));
vi.mock("@/components/ops/CRMPipelineCard", () => ({
  CRMPipelineCard: () => <div data-testid="ops-crm" />,
}));
vi.mock("@/components/ops/ActivityFeed", () => ({
  ActivityFeed: () => <div data-testid="ops-activity" />,
}));
vi.mock("@/components/ops/CapabilitiesGrid", () => ({
  CapabilitiesGrid: () => <div data-testid="ops-capabilities" />,
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

describe("S3 UX Audit 2026-11-26 — Paperclip Pages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("OperationsCenter uses responsive breakpoints and min-w-0 cards", () => {
    const { container, unmount } = renderWithQuery(<OperationsCenter />);
    const html = container.innerHTML;
    expect(html).toContain("grid-cols-1 gap-4 md:grid-cols-2");
    expect(html).toContain("grid-cols-1 gap-4 lg:grid-cols-5");
    expect(html).toContain("lg:col-span-3");
    expect(html).toContain("lg:col-span-2");
    expect(container.querySelectorAll(".min-w-0").length).toBe(5);
    unmount();
  });

  it("MyIssues renders role=alert + Retry without misleading empty state on fetch error, then loads issues", async () => {
    issuesListMock.mockRejectedValueOnce(new Error("Issues database offline"));
    const { container, unmount } = renderWithQuery(<MyIssues />);
    await flush();
    await flush();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Issues database offline");
    expect(container.textContent).not.toContain("No issues assigned to you.");

    const retryBtn = Array.from(alert?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent === "Retry",
    );
    expect(retryBtn).toBeTruthy();

    issuesListMock.mockResolvedValueOnce([
      {
        id: "iss-1",
        identifier: "GEM-999",
        title: "Check S3 UX audit parity",
        status: "todo",
        assigneeAgentId: null,
        createdAt: "2026-11-26T00:00:00.000Z",
      },
    ]);
    act(() => {
      retryBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    await flush();

    expect(container.textContent).toContain("Check S3 UX audit parity");
    expect(container.textContent).toContain("1 open");
    unmount();
  });

  it("InstanceGeneralSettings exposes Retry on query failure and role=switch + alert on toggle failure", async () => {
    getGeneralMock.mockRejectedValueOnce(new Error("Settings API offline"));
    const { container, unmount } = renderWithQuery(<InstanceGeneralSettings />);
    await flush();
    await flush();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Settings API offline");
    const retryBtn = Array.from(alert?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent === "Retry",
    );
    expect(retryBtn).toBeTruthy();

    getGeneralMock.mockResolvedValueOnce({ censorUsernameInLogs: false });
    act(() => {
      retryBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    await flush();

    const toggle = container.querySelector('button[role="switch"]') as HTMLButtonElement | null;
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    expect(toggle?.getAttribute("type")).toBe("button");

    updateGeneralMock.mockRejectedValueOnce(new Error("Toggle rejected"));
    act(() => {
      toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    await flush();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Toggle rejected");
    unmount();
  });
});
