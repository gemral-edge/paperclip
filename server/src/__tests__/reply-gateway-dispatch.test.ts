// Reply Gateway Contract — deliverReplyOnce dispatch (P2, offline).
//
// Mocks the supabase client so the claim-before-send state machine is verified
// without a live DB: insert→send→sent, 23505→skip (no send), send-throw→failed,
// no-key→send-once. The real 23505 round-trip against the live UNIQUE index is a
// P2 verify step done with the owner (deploy-time).
import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Mock the supabase client deliver-once.ts imports ──
// A tiny chainable stub. `insertResult` is set per-test; update calls are recorded.
const state: {
  insertResult: { data: any; error: any };
  insertResultsQueue: Array<{ data: any; error: any }>;
  inserts: Array<Record<string, any>>;
  updates: Array<Record<string, any>>;
  deletes: string[];
} = {
  insertResult: { data: { id: "row-1" }, error: null },
  insertResultsQueue: [],
  inserts: [],
  updates: [],
  deletes: [],
};

vi.mock("../channels/zalo-personal/supabase.js", () => ({
  supabase: {
    from: () => ({
      insert: (payload: Record<string, any>) => {
        state.inserts.push(payload);
        return {
          select: () => ({
            single: async () =>
              state.insertResultsQueue.length > 0
                ? state.insertResultsQueue.shift()!
                : state.insertResult,
          }),
        };
      },
      update: (payload: Record<string, any>) => {
        state.updates.push(payload);
        return { eq: async () => ({ data: null, error: null }) };
      },
      delete: () => ({
        eq: async (_col: string, id: string) => {
          state.deletes.push(id);
          return { data: null, error: null };
        },
      }),
    }),
  },
}));

const mirrorCustomerCalls: Array<any[]> = [];
vi.mock("../channels/cskh/mirror.js", () => ({
  mirrorReplyToCustomer: vi.fn(async (...args: any[]) => {
    mirrorCustomerCalls.push(args);
    return { error: null };
  }),
  mirrorReplyToVisitor: vi.fn(async () => ({ error: null })),
}));

vi.mock("../channels/cskh/push.js", () => ({
  pushSupportReply: vi.fn(async () => undefined),
}));

vi.mock("../channels/cskh/edge-call.js", () => ({
  goiEdgeGemral: vi.fn(async () => undefined),
}));

vi.mock("../channels/media-util.js", () => ({
  isImageMedia: (item: any) => !!(item?.mimeType?.startsWith("image/") || /\.(jpg|jpeg|png|webp)$/i.test(item?.url || item?.filename || "")),
  resolveMediaToLocalPath: vi.fn(async () => ({ localPath: null, cleanup: false })),
}));

import { deliverReplyOnce } from "../channels/deliver-once.js";
import { CskhChannel } from "../channels/cskh/channel.js";

const logRow = {
  channel_name: "cskh-internal",
  thread_id: "u1",
  body: "Dạ em chào chị ạ.",
  sent_by: "sales-closer", // BARE slug (SSOT 2026-08-03, no `agent:` prefix)
};

describe("deliverReplyOnce (P2 claim-before-send)", () => {
  beforeEach(() => {
    state.insertResult = { data: { id: "row-1" }, error: null };
    state.insertResultsQueue = [];
    state.inserts = [];
    state.updates = [];
    state.deletes = [];
    mirrorCustomerCalls.length = 0;
  });

  it("insert ok → runs deliverFn → marks sent + stamps platform id", async () => {
    const deliverFn = vi.fn(async () => ({ platformMessageId: "pmid-42" }));
    const outcome = await deliverReplyOnce("reply:cskh-internal:u1:b1", logRow, deliverFn);
    expect(outcome).toBe("sent");
    expect(deliverFn).toHaveBeenCalledTimes(1);
    expect(state.updates).toEqual([{ status: "sent", platform_message_id: "pmid-42" }]);
  });

  it("23505 unique violation → SKIP, deliverFn NOT called (double blocked)", async () => {
    state.insertResult = { data: null, error: { code: "23505", message: "duplicate key" } };
    const deliverFn = vi.fn(async () => ({ platformMessageId: "x" }));
    const outcome = await deliverReplyOnce("reply:cskh-internal:u1:b1", logRow, deliverFn);
    expect(outcome).toBe("duplicate_skipped");
    expect(deliverFn).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]); // no update — we never claimed the row
  });

  it("deliverFn throws → marks failed, no retry", async () => {
    const deliverFn = vi.fn(async () => {
      throw new Error("zalo protocol timeout");
    });
    const outcome = await deliverReplyOnce("reply:cskh-internal:u1:b1", logRow, deliverFn);
    expect(outcome).toBe("failed");
    expect(deliverFn).toHaveBeenCalledTimes(1);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].status).toBe("failed");
    expect(state.updates[0].error_message).toContain("zalo protocol timeout");
  });

  it("non-dup insert error → throws (never swallow a real DB error)", async () => {
    state.insertResult = { data: null, error: { code: "23503", message: "fk violation" } };
    const deliverFn = vi.fn(async () => ({ platformMessageId: "x" }));
    await expect(
      deliverReplyOnce("reply:cskh-internal:u1:b1", logRow, deliverFn),
    ).rejects.toMatchObject({ code: "23503" });
    expect(deliverFn).not.toHaveBeenCalled();
  });

  it("no dedupeKey (manual/human path) → deliver once, no claim", async () => {
    const deliverFn = vi.fn(async () => ({ platformMessageId: "x" }));
    const outcome = await deliverReplyOnce("", logRow, deliverFn);
    expect(outcome).toBe("sent");
    expect(deliverFn).toHaveBeenCalledTimes(1);
    expect(state.updates).toEqual([]); // no DB claim for manual path
  });
});

describe("CskhChannel.send media-only mirror parity (GEM-1423)", () => {
  beforeEach(() => {
    state.insertResult = { data: { id: "row-1" }, error: null };
    state.insertResultsQueue = [];
    state.inserts = [];
    state.updates = [];
    state.deletes = [];
    mirrorCustomerCalls.length = 0;
  });

  it("reuses claimed deliverReplyOnce row for first media item (1:1 sent==mirror, no orphan [media] row)", async () => {
    state.insertResultsQueue = [
      { data: { id: "claimed-row-1" }, error: null },
      { data: { id: "extra-row-2" }, error: null },
    ];
    const ch = new CskhChannel();
    await ch.send({
      channel: "cskh-internal",
      chatId: "u-970",
      content: "",
      dedupeKey: "reply:cskh-internal:u-970:u-970:b1:c2",
      metadata: { agentSlug: "sales-closer" },
      media: [
        { url: "https://example.com/a.jpg", filename: "a.jpg", mimeType: "image/jpeg" },
        { url: "https://example.com/b.pdf", filename: "b.pdf", mimeType: "application/pdf" },
      ],
    });

    // Exactly 2 inserts into channel_sent_messages (1 claim row + 1 second media row) == 2 mirrors
    expect(state.inserts).toHaveLength(2);
    expect(mirrorCustomerCalls).toHaveLength(2);
    expect(state.inserts.some((r) => r.body === "[media]")).toBe(false);
    // First mirror links directly to claimed-row-1; second links to extra-row-2
    expect(mirrorCustomerCalls[0][3]).toBe("claimed-row-1");
    expect(mirrorCustomerCalls[1][3]).toBe("extra-row-2");
    // Claimed row was updated with real image payload before final 'sent' stamp
    expect(state.updates[0]).toEqual({
      body: "[Hình ảnh]",
      content_type: "image",
      media: ["https://example.com/a.jpg"],
    });
  });

  it("skips all media when media-only chunk hits 23505 duplicate dedupeKey", async () => {
    state.insertResult = { data: null, error: { code: "23505", message: "duplicate key" } };
    const ch = new CskhChannel();
    await ch.send({
      channel: "cskh-internal",
      chatId: "u-970",
      content: "",
      dedupeKey: "reply:cskh-internal:u-970:u-970:b1:c2",
      metadata: { agentSlug: "sales-closer" },
      media: [{ url: "https://example.com/a.jpg", filename: "a.jpg", mimeType: "image/jpeg" }],
    });

    expect(mirrorCustomerCalls).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it("deletes temporary claimed row if no media item has a servable URL", async () => {
    state.insertResult = { data: { id: "claimed-empty-1" }, error: null };
    const ch = new CskhChannel();
    await ch.send({
      channel: "cskh-internal",
      chatId: "u-970",
      content: "",
      dedupeKey: "reply:cskh-internal:u-970:u-970:b1:c3",
      metadata: { agentSlug: "sales-closer" },
      media: [{ filename: "missing.jpg" } as any],
    });

    expect(mirrorCustomerCalls).toHaveLength(0);
    expect(state.deletes).toEqual(["claimed-empty-1"]);
  });
});

