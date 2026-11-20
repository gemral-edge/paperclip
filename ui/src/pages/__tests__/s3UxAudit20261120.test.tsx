// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Projects } from "../Projects";
import { Activity } from "../Activity";
import { CompanySettings } from "../CompanySettings";

const projectsListMock = vi.fn();
const activityListMock = vi.fn();
const companyUpdateMock = vi.fn();

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: {
      id: "company-1",
      name: "Gemral",
      description: "AI Ops",
      brandColor: "#6366f1",
      logoUrl: null,
      status: "active",
      requireBoardApprovalForNewAgents: false,
    },
    companies: [
      {
        id: "company-1",
        name: "Gemral",
        status: "active",
      },
    ],
    setSelectedCompanyId: vi.fn(),
  }),
}));

vi.mock("../../context/DialogContext", () => ({
  useDialog: () => ({ openNewProject: vi.fn() }),
}));

vi.mock("../../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("@/components/ConfirmDialog", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

vi.mock("../../api/projects", () => ({
  projectsApi: {
    list: (...args: unknown[]) => projectsListMock(...args),
  },
}));

vi.mock("../../api/activity", () => ({
  activityApi: {
    list: (...args: unknown[]) => activityListMock(...args),
  },
}));

vi.mock("../../api/agents", () => ({
  agentsApi: { list: vi.fn(async () => []) },
}));

vi.mock("../../api/issues", () => ({
  issuesApi: { list: vi.fn(async () => []) },
}));

vi.mock("../../api/goals", () => ({
  goalsApi: { list: vi.fn(async () => []) },
}));

vi.mock("../../api/companies", () => ({
  companiesApi: {
    update: (...args: unknown[]) => companyUpdateMock(...args),
    archive: vi.fn(),
  },
}));

vi.mock("../../api/access", () => ({
  accessApi: {
    createOpenClawInvitePrompt: vi.fn(),
    getInviteOnboarding: vi.fn(),
  },
}));

vi.mock("../../api/assets", () => ({
  assetsApi: {
    uploadCompanyLogo: vi.fn(),
  },
}));

function renderWithQuery(element: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
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

describe("S3 UX Audit 2026-11-20 — Projects, Activity & CompanySettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("Projects: hides EmptyState on query error and recovers when clicking Retry", async () => {
    projectsListMock
      .mockRejectedValueOnce(new Error("Projects RPC down"))
      .mockResolvedValueOnce([]);

    const { container, unmount } = renderWithQuery(<Projects />);
    await flush();

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("Projects RPC down");
    expect(container.textContent).not.toContain("No projects yet.");

    const retryBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Retry",
    );
    expect(retryBtn).toBeTruthy();
    await act(async () => {
      retryBtn!.click();
    });
    await flush();

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("No projects yet.");
    unmount();
  });

  it("Activity: shows Retry alert on query error instead of false EmptyState", async () => {
    activityListMock
      .mockRejectedValueOnce(new Error("Activity API timeout"))
      .mockResolvedValueOnce([]);

    const { container, unmount } = renderWithQuery(<Activity />);
    await flush();

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("Activity API timeout");
    expect(container.textContent).not.toContain("No activity yet.");

    const retryBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Retry",
    );
    expect(retryBtn).toBeTruthy();
    await act(async () => {
      retryBtn!.click();
    });
    await flush();

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("No activity yet.");
    unmount();
  });

  it("CompanySettings: renders visible role=alert error when hiring toggle mutation fails", async () => {
    companyUpdateMock.mockRejectedValueOnce(new Error("Update rejected by server"));

    const { container, unmount } = renderWithQuery(<CompanySettings />);
    await flush();

    const toggle = container.querySelector(
      '[data-testid="company-settings-team-approval-toggle"]',
    ) as HTMLElement | null;
    expect(toggle).toBeTruthy();
    await act(async () => {
      toggle!.click();
    });
    await flush();

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("Update rejected by server");
    unmount();
  });
});
