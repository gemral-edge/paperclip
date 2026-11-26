// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider } from "../../context/SidebarContext";
import { Agents } from "../Agents";
import { RoutineDetail } from "../RoutineDetail";
import { CompanySkills } from "../CompanySkills";

const agentsListMock = vi.fn();
const routineGetMock = vi.fn();
const skillsListMock = vi.fn();
const pushToastMock = vi.fn();

vi.mock("@codesandbox/sandpack-react", () => ({
  SandpackProvider: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SandpackCodeEditor: () => <div />,
}));

vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: () => <div data-testid="mock-md-editor" />,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/agents/all", search: "", hash: "" }),
  useParams: () => ({ routineId: "rt-1" }),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "cmp-1" }),
}));

vi.mock("../../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../../context/DialogContext", () => ({
  useDialog: () => ({ openNewAgent: vi.fn() }),
}));

vi.mock("../../context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

vi.mock("../../api/agents", () => ({
  agentsApi: {
    list: (...args: unknown[]) => agentsListMock(...args),
    org: vi.fn().mockResolvedValue([]),
    adapterModels: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../../api/heartbeats", () => ({
  heartbeatsApi: {
    list: vi.fn().mockResolvedValue([]),
    liveRunsForIssue: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../../api/routines", () => ({
  routinesApi: {
    get: (...args: unknown[]) => routineGetMock(...args),
    listRuns: vi.fn().mockResolvedValue([]),
    activity: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../../api/projects", () => ({
  projectsApi: {
    list: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../../api/companySkills", () => ({
  companySkillsApi: {
    list: (...args: unknown[]) => skillsListMock(...args),
    detail: vi.fn(),
    file: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
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
        <TooltipProvider>
          <SidebarProvider>{ui}</SidebarProvider>
        </TooltipProvider>
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

describe("S3 UX Audit 2026-11-27 — Paperclip SSOT pages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    agentsListMock.mockResolvedValue([]);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("Agents renders role=alert + Retry on list error and exposes accessible List/Org toggle buttons", async () => {
    agentsListMock.mockRejectedValueOnce(new Error("Agents load failed"));
    const mounted = renderWithQuery(<Agents />);
    await flush();
    await flush();

    const alert = mounted.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Agents load failed");
    const retryBtn = Array.from(alert?.querySelectorAll("button") ?? []).find((b) =>
      b.textContent?.includes("Retry"),
    );
    expect(retryBtn).toBeTruthy();

    const listToggle = mounted.container.querySelector('button[aria-label="List view"]');
    const orgToggle = mounted.container.querySelector('button[aria-label="Org chart view"]');
    expect(listToggle).toBeTruthy();
    expect(orgToggle).toBeTruthy();
    mounted.unmount();
  });

  it("RoutineDetail renders role=alert + Retry when routine load fails and fixes light mode status contrast", async () => {
    routineGetMock.mockRejectedValueOnce(new Error("Routine not found"));
    const mounted = renderWithQuery(<RoutineDetail />);
    await flush();
    await flush();

    const alert = mounted.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Routine not found");
    const retryBtn = Array.from(alert?.querySelectorAll("button") ?? []).find((b) =>
      b.textContent?.includes("Retry"),
    );
    expect(retryBtn).toBeTruthy();
    mounted.unmount();

    const src = fs.readFileSync(path.resolve(__dirname, "../RoutineDetail.tsx"), "utf8");
    expect(src).toContain("text-emerald-600 dark:text-emerald-400");
    expect(src).toContain('aria-label="Routine title"');
    expect(src).toContain("!Number.isNaN(new Date(trigger.nextRunAt).getTime())");
  });

  it("CompanySkills renders role=alert + Retry on error, aria-labels icon buttons, and fixes responsive sidebar border", async () => {
    skillsListMock.mockRejectedValueOnce(new Error("Skills API down"));
    const mounted = renderWithQuery(<CompanySkills />);
    await flush();
    await flush();

    const alert = mounted.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Skills API down");
    expect(mounted.container.querySelector('button[aria-label="New skill"]')).toBeTruthy();
    expect(
      mounted.container.querySelector('button[aria-label="Scan project workspaces for skills"]'),
    ).toBeTruthy();
    expect(mounted.container.querySelector('input[aria-label="Filter skills"]')).toBeTruthy();
    mounted.unmount();

    const src = fs.readFileSync(path.resolve(__dirname, "../CompanySkills.tsx"), "utf8");
    expect(src).toContain("border-b xl:border-b-0 xl:border-r border-border");
    expect(src).toContain("pt-4 xl:pt-0 xl:pl-6");
    expect(src).toContain('aria-label="Copy source path to clipboard"');
  });
});
