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
import { Timetable } from "../Timetable";
import { ToolAuditLogPage } from "../training/ToolAuditLogPage";
import { EmailCampaignsPage } from "../crm/EmailCampaignsPage";

const useTimetableMock = vi.fn();
const listAuditLogMock = vi.fn();

vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "cmp-1" }),
}));

vi.mock("../../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../../hooks/useTimetable", () => ({
  useTimetable: (...args: unknown[]) => useTimetableMock(...args),
}));

vi.mock("../../components/timetable/TimetableTable", () => ({
  HCM_TZ: "Asia/Ho_Chi_Minh",
  TimetableTable: ({ rows }: { rows: Array<{ id: string }> }) => (
    <div data-testid="timetable-table">{rows.length}</div>
  ),
}));

vi.mock("../../components/timetable/TimetableAuditTab", () => ({
  TimetableAuditTab: () => <div data-testid="timetable-audit-tab" />,
}));

vi.mock("../../components/timetable/TimetableUpcomingTab", () => ({
  TimetableUpcomingTab: () => <div data-testid="timetable-upcoming-tab" />,
}));

vi.mock("../../components/timetable/AddManualRowModal", () => ({
  AddManualRowModal: () => null,
}));

vi.mock("../../components/timetable/TimetableMenus", () => ({
  SortMenu: () => <div />,
  GroupMenu: () => <div />,
  ColumnMenu: () => <div />,
  FilterMenu: () => <div />,
}));

vi.mock("../../components/timetable/SmartSearch", () => ({
  SmartSearch: () => <div data-testid="smart-search" />,
}));

vi.mock("../../api/training", () => ({
  trainingApi: {
    listAuditLog: (...args: unknown[]) => listAuditLogMock(...args),
  },
}));

vi.mock("@/hooks/useUnsavedChangesGuard", () => ({
  useUnsavedChangesGuard: vi.fn(),
}));

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 15));
  });
}

function renderWithProviders(ui: ReactNode) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <SidebarProvider>{ui}</SidebarProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  return {
    container,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
      qc.clear();
    },
  };
}

describe("S3 UX Audit 2026-11-28 — Paperclip UI Pages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTimetableMock.mockReturnValue({
      data: { rows: [], kpis: { total: 0, done: 0, running: 0, scheduled: 0, failed: 0 } },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      isFetching: false,
      dataUpdatedAt: Date.now(),
    });
    listAuditLogMock.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("Timetable exposes role=alert + accessible Retry button on fetch error and uses tabular-nums", async () => {
    const refetchMock = vi.fn();
    useTimetableMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("timeout"),
      refetch: refetchMock,
      isFetching: false,
      dataUpdatedAt: 0,
    });

    const { container, cleanup } = renderWithProviders(<Timetable />);
    await flush();

    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl).not.toBeNull();
    expect(alertEl?.textContent).toContain("Lỗi tải lịch");

    const retryBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Thử lại"),
    );
    expect(retryBtn).toBeTruthy();
    act(() => {
      retryBtn?.click();
    });
    expect(refetchMock).toHaveBeenCalledTimes(1);

    const src = fs.readFileSync(path.resolve(__dirname, "..", "Timetable.tsx"), "utf8");
    expect(src).not.toContain('className="font-mono"');
    expect(src).toContain("Number.isNaN(dt.getTime())");
    cleanup();
  });

  it("ToolAuditLogPage shows role=alert + Retry when audit-log query fails and uses theme-aware tokens", async () => {
    listAuditLogMock.mockRejectedValueOnce(new Error("audit db down"));

    const { container, cleanup } = renderWithProviders(<ToolAuditLogPage />);
    await flush();

    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl).not.toBeNull();
    expect(alertEl?.textContent).toContain("Không thể tải tool audit log");

    const ths = Array.from(container.querySelectorAll("th"));
    expect(ths.length).toBe(6);
    expect(ths.every((th) => th.getAttribute("scope") === "col")).toBe(true);

    const src = fs.readFileSync(path.resolve(__dirname, "..", "training/ToolAuditLogPage.tsx"), "utf8");
    expect(src).not.toContain("bg-[#0A0B1A]");
    expect(src).not.toContain("text-white");
    expect(src).toContain("Number.isNaN(ms)");
    cleanup();
  });

  it("EmailCampaignsPage surfaces fetch failures with role=alert + Retry and wraps table in overflow-x-auto", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "server boom" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { container, cleanup } = renderWithProviders(<EmailCampaignsPage />);
    await flush();

    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl).not.toBeNull();
    expect(alertEl?.textContent).toContain("Không thể tải danh sách campaign");

    cleanup();

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            id: "cmp-1",
            name: "Welcome Flow",
            template: "welcome",
            sent_count: 12,
            opened_count: 6,
            clicked_count: 2,
            status: "draft",
            created_at: "bad-date",
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const second = renderWithProviders(<EmailCampaignsPage />);
    await flush();

    expect(second.container.querySelector(".overflow-x-auto table")).not.toBeNull();
    expect(second.container.textContent).toContain("Welcome Flow");
    expect(second.container.textContent).not.toContain("NaN");

    const src = fs.readFileSync(path.resolve(__dirname, "..", "crm/EmailCampaignsPage.tsx"), "utf8");
    expect(src).toContain('<th scope="col"');
    expect(src).toContain("dark:text-green-400");
    expect(src).not.toContain("font-mono");
    second.cleanup();
  });
});
