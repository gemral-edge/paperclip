// GEM-1037 — agent trả rỗng (agent_silent) phải BÁO NGƯỜI mà KHÔNG khoá phiên.
// Pin hành vi handleEscalation({ noPause: true }): 0 lần pause/containment, vẫn tạo ticket + ping
// Telegram, câu trạng thái ghi đè hiển thị đúng. Offline: mock supabase + fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpcCalls: string[] = [];
const inserts: Array<{ table: string; row: any }> = [];

vi.mock("../channels/zalo-personal/supabase.js", () => {
  // Builder thenable: mọi phương thức lọc trả lại chính nó; .maybeSingle()/.single() chốt kết quả.
  const builder = (table: string) => {
    const b: any = {
      select: () => b,
      eq: () => b,
      in: () => b,
      order: () => b,
      limit: () => b,
      insert: (row: any) => {
        inserts.push({ table, row });
        return b;
      },
      maybeSingle: async () => ({ data: table === "channel_sessions" ? { metadata: {} } : null }),
      single: async () => ({ data: { id: "t-1", ticket_number: "TK-1" }, error: null }),
    };
    return b;
  };
  return {
    supabase: {
      from: (table: string) => builder(table),
      rpc: async (name: string) => {
        rpcCalls.push(name);
        return { data: 1, error: null };
      },
    },
  };
});

import { handleEscalation } from "../channels/crm/escalation-handler.js";

const baseCtx = {
  agentSlug: "sales-closer",
  sessionKey: "zalo-personal-x:1:1",
  channelName: "zalo-personal-x",
  chatId: "1",
  customerId: null,
  customerName: "Khách A",
  reason: "agent_silent",
  priority: "high" as const,
  summary: "Agent trả rỗng",
  triggerMessage: "Kiểm tra đơn giúp mình",
  agentReply: "(rỗng)",
};

describe("handleEscalation noPause (agent_silent alert)", () => {
  const realFetch = globalThis.fetch;
  let sentText = "";

  beforeEach(() => {
    rpcCalls.length = 0;
    inserts.length = 0;
    sentText = "";
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      sentText = JSON.parse(init.body).text;
      return { ok: true, text: async () => "" } as any;
    }) as any;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("noPause: không gọi cskh_toggle_bot / channel_session_merge_meta để KHOÁ, vẫn ticket + ping", async () => {
    const r = await handleEscalation({
      ...baseCtx,
      noPause: true,
      statusLine: "Bot KHÔNG bị tắt (test)",
    });
    expect(rpcCalls).not.toContain("cskh_toggle_bot");
    // merge_meta duy nhất được phép = ghi mốc ping (last_escalation_ping_at), không phải khoá phiên.
    expect(rpcCalls.filter((n) => n === "channel_session_merge_meta").length).toBeLessThanOrEqual(1);
    expect(inserts.some((i) => i.table === "crm_tickets")).toBe(true);
    expect(r.ticketDisplayId).toBe("TK-1");
    expect(sentText).toContain("agent_silent");
    expect(sentText).toContain("Bot KHÔNG bị tắt (test)");
  });

  it("Telegram 400 'can't parse entities' (URL có _) → gửi lại text thuần, KHÔNG mất cảnh báo", async () => {
    const bodies: any[] = [];
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      const b = JSON.parse(init.body);
      bodies.push(b);
      return b.parse_mode
        ? ({ ok: false, status: 400, text: async () => "Bad Request: can't parse entities" } as any)
        : ({ ok: true, status: 200, text: async () => "" } as any);
    }) as any;
    await handleEscalation({
      ...baseCtx,
      noPause: true,
      triggerMessage: "[Hình ảnh khách gửi: https://x.co/a_b_c.jpg",
    });
    expect(bodies.length).toBe(2);
    expect(bodies[0].parse_mode).toBe("Markdown");
    expect(bodies[1].parse_mode).toBeUndefined();
    expect(bodies[1].text).toContain("a_b_c.jpg");
  });

  it("closureIntent: tạo ticket status='resolved', không pause, và BỎ QUA Telegram ping (GEM-1572)", async () => {
    const r = await handleEscalation({
      ...baseCtx,
      closureIntent: true,
      triggerMessage: "Ok",
    });
    expect(rpcCalls).not.toContain("cskh_toggle_bot");
    const ticketInsert = inserts.find((i) => i.table === "crm_tickets");
    expect(ticketInsert).toBeDefined();
    expect(ticketInsert?.row.status).toBe("resolved");
    expect(ticketInsert?.row.metadata.closure_intent).toBe(true);
    expect(ticketInsert?.row.resolved_at).toBeTruthy();
    expect(sentText).toBe("");
  });

  it("mặc định (không noPause): vẫn pause qua cskh_toggle_bot — hành vi cũ không đổi", async () => {
    await handleEscalation({ ...baseCtx, reason: "customer_hostile" });
    expect(rpcCalls).toContain("cskh_toggle_bot");
  });
});
