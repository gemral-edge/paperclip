// 29/10 chị Jennie: chat gemral.com (đăng nhập hay chưa) đều do agent kênh `cskh-web` trả lời;
// kênh `cskh-internal` (bong bóng tài khoản + app) chỉ còn giữ app gem-mobile.
// resolveAgent Tier 3: cskh-internal + metadata.source='web' → đọc agent của `cskh-web`.
import { describe, expect, it, vi, beforeEach } from "vitest";

const state: { nameLookups: string[] } = { nameLookups: [] };

vi.mock("../channels/zalo-personal/supabase.js", () => ({
  supabase: {
    from: (table: string) => {
      const thenable: any = {
        select: () => thenable,
        or: () => thenable,
        eq: (col: string, val: string) => {
          if (table === "channel_instances" && col === "name") state.nameLookups.push(val);
          return thenable;
        },
        order: () => thenable,
        limit: async () => ({ data: [], error: null }),
        single: async () => ({ data: null, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return thenable;
    },
  },
}));

import { resolveAgent } from "../channels/router.js";

function msg(channel: string, source?: string) {
  return {
    id: `m-${channel}-${source}`,
    channel,
    channelType: "cskh",
    chatId: "uid-1",
    senderId: `uid-${channel}-${source}`,
    senderName: "Khách Test",
    content: "hello",
    peerKind: "direct",
    metadata: source ? { source } : {},
    timestamp: new Date().toISOString(),
  } as any;
}

describe("resolveAgent — cskh-internal tách web sang agent cskh-web", () => {
  beforeEach(() => {
    state.nameLookups = [];
  });

  it("tin web từ khách đã đăng nhập → tra agent của kênh cskh-web", async () => {
    await resolveAgent(msg("cskh-internal", "web"));
    expect(state.nameLookups).toEqual(["cskh-web"]);
  });

  it("tin app gem-mobile → vẫn tra agent của cskh-internal", async () => {
    await resolveAgent(msg("cskh-internal", "mobile"));
    expect(state.nameLookups).toEqual(["cskh-internal"]);
  });

  it("kênh khác không bị ảnh hưởng", async () => {
    await resolveAgent(msg("fb-jennie", "web"));
    expect(state.nameLookups).toEqual(["fb-jennie"]);
  });
});
