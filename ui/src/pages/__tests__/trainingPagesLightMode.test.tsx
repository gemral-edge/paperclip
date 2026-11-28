// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TrainingHistoryPage } from "../training/TrainingHistoryPage";
import { TrainingRoomPage } from "../training/TrainingRoomPage";

const listSessionsMock = vi.fn();
const getTurnsMock = vi.fn();
const getScoresMock = vi.fn();
const startMock = vi.fn();
const openSocketMock = vi.fn();

vi.mock("@/api/training", () => ({
  trainingApi: {
    listSessions: (...args: unknown[]) => listSessionsMock(...args),
    getTurns: (...args: unknown[]) => getTurnsMock(...args),
    getScores: (...args: unknown[]) => getScoresMock(...args),
    start: (...args: unknown[]) => startMock(...args),
  },
  openTrainingLiveSocket: (...args: unknown[]) => openSocketMock(...args),
}));

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });
}

function renderWithQuery(ui: ReactNode) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRoot(container);
  act(() => {
    root.render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
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

describe("GEM-2916: TrainingHistoryPage & TrainingRoomPage Light Mode + Error/A11y", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listSessionsMock.mockResolvedValue([]);
    getTurnsMock.mockResolvedValue([]);
    getScoresMock.mockResolvedValue([]);
    openSocketMock.mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("TrainingHistoryPage hiển thị role=alert + nút Thử lại khi listSessions lỗi", async () => {
    listSessionsMock.mockRejectedValueOnce(new Error("db down"));

    const { container, cleanup } = renderWithQuery(<TrainingHistoryPage />);
    await flush();

    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl).not.toBeNull();
    expect(alertEl?.textContent).toContain("Không thể tải lịch sử training");

    const retryBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Thử lại"),
    );
    expect(retryBtn).toBeTruthy();

    listSessionsMock.mockResolvedValueOnce([]);
    await act(async () => {
      retryBtn?.click();
      await new Promise((r) => setTimeout(r, 15));
    });
    expect(listSessionsMock).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("TrainingHistoryPage render 6 <th scope=col>, guard bad-date không ra NaN, mở rubric detail + error alert", async () => {
    listSessionsMock.mockResolvedValueOnce([
      {
        id: "sess-1",
        agent_slug: "sales-closer",
        scenario_focus: "S01_discovery_new_lead",
        ceo_model: "gemini",
        reviewer_model: "opus",
        status: "completed",
        total_turns: 4,
        max_turns: 10,
        opus_score: 88,
        started_at: "bad-date",
        ended_at: null,
      },
    ]);
    getScoresMock.mockRejectedValueOnce(new Error("scores timeout"));

    const { container, cleanup } = renderWithQuery(<TrainingHistoryPage />);
    await flush();

    const ths = Array.from(container.querySelectorAll("th"));
    expect(ths.length).toBe(6);
    expect(ths.every((th) => th.getAttribute("scope") === "col")).toBe(true);
    expect(container.textContent).not.toContain("NaN");
    expect(container.textContent).toContain("88");

    const row = container.querySelector("tbody tr");
    expect(row).not.toBeNull();
    await act(async () => {
      (row as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 50));
    });
    await flush();

    expect(getScoresMock).toHaveBeenCalledWith("sess-1");
    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl?.textContent).toContain("Không thể tải điểm số");

    const src = fs.readFileSync(path.resolve(__dirname, "..", "training/TrainingHistoryPage.tsx"), "utf8");
    expect(src).not.toContain("bg-[#0A0B1A]");
    expect(src).not.toContain("bg-[rgba(15,16,48");
    expect(src).not.toContain("text-white");
    expect(src).not.toContain("text-[#3AF7A6]");
    expect(src).not.toContain("text-[#00F0FF]");
    expect(src).not.toContain("text-[#FFB800]");
    expect(src).not.toContain("text-[#FF6B6B]");
    cleanup();
  });

  it("TrainingRoomPage có select aria-label + text-base, xử lý lỗi listSessions và startMutation", async () => {
    listSessionsMock.mockRejectedValueOnce(new Error("sessions down"));
    startMock.mockRejectedValueOnce(new Error("start failed"));

    const { container, cleanup } = renderWithQuery(<TrainingRoomPage />);
    await flush();

    const scenarioSelect = container.querySelector("#training-scenario-select");
    const agentSelect = container.querySelector("#training-agent-select");
    expect(scenarioSelect?.getAttribute("aria-label")).toBe("Chọn kịch bản training");
    expect(agentSelect?.getAttribute("aria-label")).toBe("Chọn agent training");
    expect(scenarioSelect?.className).toContain("text-base");
    expect(agentSelect?.className).toContain("text-base");

    const alertsBefore = container.querySelectorAll('[role="alert"]');
    expect(alertsBefore.length).toBe(1);
    expect(alertsBefore[0]?.textContent).toContain("Không thể tải lịch sử");

    const startBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Bắt đầu session"),
    );
    expect(startBtn).toBeTruthy();
    await act(async () => {
      startBtn?.click();
      await new Promise((r) => setTimeout(r, 15));
    });

    const alertsAfter = Array.from(container.querySelectorAll('[role="alert"]'));
    expect(alertsAfter.some((el) => el.textContent?.includes("Không thể bắt đầu session"))).toBe(true);

    const src = fs.readFileSync(path.resolve(__dirname, "..", "training/TrainingRoomPage.tsx"), "utf8");
    expect(src).not.toContain("bg-[#0A0B1A]");
    expect(src).not.toContain("bg-[rgba(15,16,48");
    expect(src).not.toContain("text-white");
    expect(src).not.toContain("text-[#E0E0F0]");
    cleanup();
  });
});
