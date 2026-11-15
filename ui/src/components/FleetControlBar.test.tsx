// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetControlBar, FleetQueueList } from "./FleetControlBar";

const fleetStatusMock = vi.fn();
const fleetPauseMock = vi.fn();
const fleetResumeMock = vi.fn();
const liveRunsForCompanyMock = vi.fn();
const cancelRunMock = vi.fn();

vi.mock("../api/fleet", () => ({
  fleetApi: {
    status: (...args: unknown[]) => fleetStatusMock(...args),
    pause: (...args: unknown[]) => fleetPauseMock(...args),
    resume: (...args: unknown[]) => fleetResumeMock(...args),
  },
  invalidateAgentRuntimeQueries: vi.fn(),
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: {
    liveRunsForCompany: (...args: unknown[]) => liveRunsForCompanyMock(...args),
    cancel: (...args: unknown[]) => cancelRunMock(...args),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushQueries() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

describe("FleetQueueList", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders loading, error with retry button, and empty states", () => {
    const onRetry = vi.fn();
    const onCancel = vi.fn();
    const root = createRoot(container);

    act(() => {
      root.render(
        <FleetQueueList
          isLoading
          isError={false}
          queuedRuns={[]}
          onRetry={onRetry}
          cancellingRunId={null}
          onCancel={onCancel}
        />,
      );
    });
    expect(container.textContent).toContain("Đang tải hàng chờ…");

    act(() => {
      root.render(
        <FleetQueueList
          isLoading={false}
          isError
          errorMessage="Mất kết nối API"
          queuedRuns={[]}
          onRetry={onRetry}
          cancellingRunId={null}
          onCancel={onCancel}
        />,
      );
    });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Mất kết nối API");
    const retryBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Thử lại"),
    );
    expect(retryBtn).toBeDefined();
    act(() => {
      retryBtn?.click();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(
        <FleetQueueList
          isLoading={false}
          isError={false}
          queuedRuns={[]}
          onRetry={onRetry}
          cancellingRunId={null}
          onCancel={onCancel}
        />,
      );
    });
    expect(container.textContent).toContain("Không có lượt nào đang chờ.");

    act(() => {
      root.unmount();
    });
  });

  it("renders queued runs with shrink-0 cancel button", () => {
    const onCancel = vi.fn();
    const root = createRoot(container);

    act(() => {
      root.render(
        <FleetQueueList
          isLoading={false}
          isError={false}
          queuedRuns={[
            {
              id: "run-q1",
              agentName: "Kiểm Định UX",
              createdAt: "2026-11-15T00:00:00.000Z",
              invocationSource: "timer",
            },
          ]}
          onRetry={vi.fn()}
          cancellingRunId={null}
          onCancel={onCancel}
        />,
      );
    });

    const cancelBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Huỷ lượt chờ"),
    );
    expect(cancelBtn?.className).toContain("shrink-0");
    act(() => {
      cancelBtn?.click();
    });
    expect(onCancel).toHaveBeenCalledWith("run-q1");

    act(() => {
      root.unmount();
    });
  });
});

describe("FleetControlBar", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    fleetStatusMock.mockReset();
    fleetPauseMock.mockReset();
    fleetResumeMock.mockReset();
    liveRunsForCompanyMock.mockReset();
    cancelRunMock.mockReset();
  });

  afterEach(() => {
    container.remove();
  });

  it("shows mutation error inside confirmation modal and clears it when dismissed", async () => {
    fleetStatusMock.mockResolvedValue({
      pausable: 3,
      fleetPaused: 0,
      otherPaused: 0,
      running: 1,
      queued: 0,
      maxRunning: 4,
      oldestQueuedAt: null,
      pendingRequeue: 0,
    });
    fleetPauseMock.mockRejectedValue(new Error("Pause rejected by server"));
    liveRunsForCompanyMock.mockResolvedValue([]);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const root = createRoot(container);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <FleetControlBar companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushQueries();

    const openBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Tạm dừng toàn đội"),
    );
    expect(openBtn).toBeDefined();
    act(() => {
      openBtn?.click();
    });

    const confirmBtn = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Tạm dừng",
    );
    expect(confirmBtn).toBeDefined();
    act(() => {
      confirmBtn?.click();
    });
    await flushQueries();

    const alerts = document.body.querySelectorAll('[role="alert"]');
    expect(alerts.length).toBe(1);
    expect(alerts[0]?.textContent).toContain("Pause rejected by server");

    const cancelModalBtn = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Thôi",
    );
    act(() => {
      cancelModalBtn?.click();
    });

    expect(document.body.querySelectorAll('[role="alert"]').length).toBe(0);

    act(() => {
      root.unmount();
    });
    queryClient.clear();
  });
});
