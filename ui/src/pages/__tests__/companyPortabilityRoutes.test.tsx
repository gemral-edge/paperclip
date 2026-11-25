// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider } from "../../context/SidebarContext";
import { OrgChart } from "../OrgChart";
import { CompanySettings } from "../CompanySettings";
import { CompanyImport } from "../CompanyImport";
import { CompanyExport } from "../CompanyExport";

const exportPreviewMock = vi.fn();
const agentsListMock = vi.fn();
const agentsOrgMock = vi.fn();
const projectsListMock = vi.fn();
const getSessionMock = vi.fn();
const pushToastMock = vi.fn();

vi.mock("../../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children?: ReactNode }) => <div data-testid="markdown-body">{children}</div>,
}));

vi.mock("../../components/AgentConfigForm", () => ({
  AgentConfigForm: () => <div data-testid="agent-config-form" />,
}));

vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "cmp-1", name: "GEMRAL", issuePrefix: "GEM", status: "active" }],
    selectedCompanyId: "cmp-1",
    selectedCompany: {
      id: "cmp-1",
      name: "GEMRAL",
      issuePrefix: "GEM",
      description: null,
      brandColor: null,
      logoUrl: null,
      status: "active",
      requireBoardApprovalForNewAgents: true,
    },
    setSelectedCompanyId: vi.fn(),
  }),
}));

vi.mock("../../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../../context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

vi.mock("@/components/ConfirmDialog", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

vi.mock("../../api/auth", () => ({
  authApi: {
    getSession: (...args: unknown[]) => getSessionMock(...args),
  },
}));

vi.mock("../../api/agents", () => ({
  agentsApi: {
    list: (...args: unknown[]) => agentsListMock(...args),
    org: (...args: unknown[]) => agentsOrgMock(...args),
  },
}));

vi.mock("../../api/projects", () => ({
  projectsApi: {
    list: (...args: unknown[]) => projectsListMock(...args),
  },
}));

vi.mock("../../api/companies", () => ({
  companiesApi: {
    exportPreview: (...args: unknown[]) => exportPreviewMock(...args),
    exportPackage: vi.fn(),
    importPreview: vi.fn(),
    importBundle: vi.fn(),
    get: vi.fn(),
  },
}));

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function renderWithProviders(ui: ReactNode, initialEntry = "/GEM/org") {
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
      <MemoryRouter initialEntries={[initialEntry]}>
        <QueryClientProvider client={queryClient}>
          <SidebarProvider>
            <TooltipProvider>{ui}</TooltipProvider>
          </SidebarProvider>
        </QueryClientProvider>
      </MemoryRouter>,
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

describe("Company portability routes & pages (GEM-2739)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue({
      session: { id: "s-1", userId: "local-board" },
      user: { id: "local-board", email: null, name: "Local Board" },
    });
    agentsListMock.mockResolvedValue([]);
    agentsOrgMock.mockResolvedValue([
      { id: "ag-1", name: "CEO", role: "ceo", status: "active", reports: [] },
    ]);
    projectsListMock.mockResolvedValue([]);
    exportPreviewMock.mockResolvedValue({
      rootPath: "gemral",
      manifest: {
        schemaVersion: 4,
        generatedAt: "2026-11-25T00:00:00.000Z",
        source: { companyId: "cmp-1", companyName: "GEMRAL" },
        includes: { company: true, agents: true, projects: true, issues: false, skills: true },
        company: { path: "COMPANY.md", name: "GEMRAL", description: null, brandColor: null, logoPath: null, requireBoardApprovalForNewAgents: true },
        sidebar: { agents: [], projects: [] },
        agents: [],
        projects: [],
        issues: [],
        skills: [],
      },
      files: {
        "README.md": "# GEMRAL\n\nCompany package.",
        "COMPANY.md": "---\nname: GEMRAL\n---\n",
      },
      warnings: [],
      paperclipExtensionPath: null,
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("App.tsx mounts company/export/* and company/import in boardRoutes() and unprefixed redirects in App()", () => {
    const appPath = path.resolve(__dirname, "../../App.tsx");
    const appSrc = fs.readFileSync(appPath, "utf-8");
    expect(appSrc).toContain('import { CompanyExport } from "./pages/CompanyExport"');
    expect(appSrc).toContain('import { CompanyImport } from "./pages/CompanyImport"');
    expect(appSrc).toContain('<Route path="company/export/*" element={<CompanyExport />} />');
    expect(appSrc).toContain('<Route path="company/import" element={<CompanyImport />} />');
    expect(appSrc).toContain('<Route path="company/export" element={<UnprefixedBoardRedirect />} />');
    expect(appSrc).toContain('<Route path="company/export/*" element={<UnprefixedBoardRedirect />} />');
    expect(appSrc).toContain('<Route path="company/import" element={<UnprefixedBoardRedirect />} />');
    expect(appSrc).toContain('<Route path="org" element={<UnprefixedBoardRedirect />} />');
  });

  it("OrgChart renders Import/Export links without nested <button> inside <a>", async () => {
    const { container, unmount } = renderWithProviders(<OrgChart />, "/GEM/org");
    await flush();
    await flush();
    const importLink = container.querySelector('a[href="/GEM/company/import"]');
    const exportLink = container.querySelector('a[href="/GEM/company/export"]');
    expect(importLink).toBeTruthy();
    expect(exportLink).toBeTruthy();
    expect(importLink?.querySelector("button")).toBeNull();
    expect(exportLink?.querySelector("button")).toBeNull();
    unmount();
  });

  it("CompanySettings uses SPA <Link> for Org Chart, Export, and Import", async () => {
    const { container, unmount } = renderWithProviders(<CompanySettings />, "/GEM/company/settings");
    await flush();
    expect(container.querySelector('a[href="/GEM/org"]')).toBeTruthy();
    expect(container.querySelector('a[href="/GEM/company/export"]')).toBeTruthy();
    expect(container.querySelector('a[href="/GEM/company/import"]')).toBeTruthy();
    unmount();
  });

  it("CompanyImport renders import source controls", async () => {
    const { container, unmount } = renderWithProviders(<CompanyImport />, "/GEM/company/import");
    await flush();
    expect(container.textContent).toContain("Import source");
    expect(container.textContent).toContain("GitHub repo");
    expect(container.textContent).toContain("Local zip");
    expect(container.textContent).toContain("Preview import");
    unmount();
  });

  it("CompanyExport loads preview files and surfaces error + Retry when preview fails", async () => {
    const okView = renderWithProviders(<CompanyExport />, "/GEM/company/export");
    await flush();
    await flush();
    expect(okView.container.textContent).toContain("GEMRAL export");
    expect(okView.container.textContent).toContain("Package files");
    expect(okView.container.textContent).toContain("README.md");
    okView.unmount();

    exportPreviewMock.mockRejectedValueOnce(new Error("Export preview offline"));
    const errView = renderWithProviders(<CompanyExport />, "/GEM/company/export");
    await flush();
    await flush();
    const alert = errView.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Export preview offline");
    const retryBtn = Array.from(alert?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent === "Retry",
    ) as HTMLButtonElement | undefined;
    expect(retryBtn).toBeTruthy();
    await act(async () => {
      retryBtn?.click();
    });
    expect(exportPreviewMock).toHaveBeenCalledTimes(3);
    errView.unmount();
  });
});
