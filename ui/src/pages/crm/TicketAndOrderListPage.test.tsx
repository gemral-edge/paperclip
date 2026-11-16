// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TicketListPage } from "./TicketListPage";
import { OrderListPage } from "./OrderListPage";

vi.mock("@/lib/router", () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children, to }: any) => <a href={String(to)}>{children}</a>,
}));

vi.mock("@/hooks/useLiveInvalidate", () => ({
  useLiveInvalidate: () => {},
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function flush() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
}

const byText = (sel: string, text: string) =>
  Array.from(document.querySelectorAll<HTMLElement>(sel)).find((el) => el.textContent?.includes(text));

async function click(el: HTMLElement | undefined) {
  if (!el) throw new Error("Không tìm thấy phần tử để click");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

async function setSelectValue(el: HTMLSelectElement | undefined, value: string) {
  if (!el) throw new Error("Không tìm thấy select");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});

afterEach(() => {
  if (root) {
    act(() => root.unmount());
  }
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TicketListPage — retry, filter reset & bulk mutation error handling", () => {
  it("shows error with working Retry button when ticket list fails, then loads empty filtered reset", async () => {
    let failTickets = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/crm/tickets?") && failTickets) {
          return json(500, { error: "DB down" });
        }
        if (url.includes("/crm/tickets?")) {
          return json(200, { data: [], total: 0, totalPages: 1 });
        }
        return json(200, { data: [], total: 0 });
      }),
    );

    await mount(<TicketListPage />);
    expect(document.body.textContent).toContain("DB down");

    failTickets = false;
    await click(byText("button", "Thử lại"));
    expect(document.body.textContent).toContain("Chưa có phiếu hỗ trợ nào.");
  });

  it("shows bulk status error alert and keeps ticket selection when PUT fails", async () => {
    const ticket = {
      id: "t-1",
      ticket_number: "TK-01",
      title: "Cần hỗ trợ",
      priority: "high",
      status: "open",
      created_at: new Date().toISOString(),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          return json(500, { error: "Cập nhật thất bại" });
        }
        if (url.includes("/crm/tickets?")) {
          return json(200, { data: [ticket], total: 1, totalPages: 1 });
        }
        return json(200, { data: [], total: 0 });
      }),
    );

    await mount(<TicketListPage />);
    const checkbox = document.querySelector<HTMLInputElement>('input[aria-label="Chọn phiếu TK-01"]');
    expect(checkbox).toBeTruthy();
    await click(checkbox!);

    const bulkSelect = document.querySelector<HTMLSelectElement>('select[aria-label="Đổi trạng thái hàng loạt"]');
    expect(bulkSelect).toBeTruthy();
    await setSelectValue(bulkSelect!, "resolved");

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Cập nhật thất bại");
    expect(document.body.textContent).toContain("1 phiếu đã chọn");
  });
});

describe("OrderListPage — retry & modal create error visibility", () => {
  it("shows Retry on query error and displays createMut error inside modal without closing", async () => {
    let failList = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          return json(422, { error: "Thiếu địa chỉ thanh toán" });
        }
        if (url.includes("/crm/orders?") && failList) {
          return json(500, { error: "Orders timeout" });
        }
        if (url.includes("/crm/orders?")) {
          return json(200, { data: [], total: 0, totalPages: 1 });
        }
        return json(200, {});
      }),
    );

    await mount(<OrderListPage />);
    expect(document.body.textContent).toContain("Orders timeout");

    failList = false;
    await click(byText("button", "Thử lại"));
    expect(document.body.textContent).toContain("Chưa có đơn hàng nào.");

    await click(byText("button", "Tạo đơn hàng"));
    const productSelect = Array.from(document.querySelectorAll<HTMLSelectElement>("select")).find((s) =>
      Array.from(s.options).some((o) => o.value === "tier1"),
    );
    expect(productSelect).toBeTruthy();
    await setSelectValue(productSelect!, "tier1");

    const submitBtn = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .filter((b) => b.textContent?.includes("Tạo đơn "))
      .pop();
    expect(submitBtn?.textContent).toContain("10.999.000");
    await click(submitBtn);

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Thiếu địa chỉ thanh toán");
    expect(document.body.textContent).toContain("Tạo đơn hàng mới");
  });
});
