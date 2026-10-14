// EC-089: Instagram DM → hộp thư Paperclip. Test parse + route + bỏ echo + chữ ký (module thuần, không mạng).
import { createHmac } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildIgInbound, isIgEcho, loadIgAccounts, requireMetaSignature, verifyMetaSignature } from "../channels/facebook/instagram.js";

const accts = loadIgAccounts({} as NodeJS.ProcessEnv);
const byId = Object.fromEntries(accts.map((a) => [a.igId, a]));
const jennie = byId["17841444853573704"];

function dm(over: any = {}) {
  return {
    sender: { id: "IGSID_CUSTOMER_1" },
    recipient: { id: "17841444853573704" },
    timestamp: 1760430000000,
    message: { mid: "aWdfZAG1faXRlbTox", text: "Chị ơi khóa học giá bao nhiêu?" },
    ...over,
  };
}

describe("loadIgAccounts — route IG id → Page → kênh theo thương hiệu", () => {
  it("3 tài khoản IG map đúng Page + kênh", () => {
    expect(byId["17841444853573704"]).toMatchObject({ pageId: "101609408467458", channel: "ig-jennie" });
    expect(byId["17841411458556367"]).toMatchObject({ pageId: "893324337205554", channel: "ig-gemral" });
    // Yinyang IG nối Page THỨ 2, không phải Page fb-yinyang 844146582110162
    expect(byId["17841450342830812"]).toMatchObject({ pageId: "578361712032089", channel: "ig-yinyang" });
  });
  it("env ghi đè được", () => {
    const a = loadIgAccounts({ IG_USER_ID_JENNIE: "999", FB_PAGE_ID_JENNIE: "111" } as any);
    expect(a.find((x) => x.channel === "ig-jennie")).toMatchObject({ igId: "999", pageId: "111" });
  });
});

describe("buildIgInbound — parse", () => {
  it("DM text → InboundMessage kênh ig-jennie, chatId = IGSID", () => {
    const m = buildIgInbound(jennie, dm(), "Lan")!;
    expect(m.channel).toBe("ig-jennie");
    expect(m.channelType).toBe("facebook");
    expect(m.chatId).toBe("IGSID_CUSTOMER_1");
    expect(m.senderId).toBe("IGSID_CUSTOMER_1");
    expect(m.peerKind).toBe("direct");
    expect(m.content).toBe("Chị ơi khóa học giá bao nhiêu?");
    expect(m.metadata).toMatchObject({ platform: "instagram", page_id: "101609408467458", ig_user_id: "17841444853573704" });
    expect(m.dedupeKey).toBe("ig:ig-jennie:IGSID_CUSTOMER_1:aWdfZAG1faXRlbTox");
  });
  it("ảnh không chữ → contentType image + media", () => {
    const m = buildIgInbound(jennie, dm({ message: { mid: "m2", attachments: [{ type: "image", payload: { url: "https://x/y.jpg" } }] } }), "")!;
    expect(m.contentType).toBe("image");
    expect(m.media?.[0].url).toBe("https://x/y.jpg");
    expect(m.senderName).toBe("IGSID_CUSTOMER_1");
  });
  it("reply story → gắn fb_context (router không auto-reply)", () => {
    const m = buildIgInbound(jennie, dm({ message: { mid: "m3", text: "🔥", reply_to: { story: { url: "https://s", id: "1" } } } }), "A")!;
    expect(m.metadata?.fb_context).toBe("story_reply");
  });
  it("bỏ qua: read/reaction (không message), tin thu hồi, tin rỗng, thiếu sender", () => {
    expect(buildIgInbound(jennie, { sender: { id: "u" }, read: { mid: "x" } }, "")).toBeNull();
    expect(buildIgInbound(jennie, { sender: { id: "u" }, reaction: { mid: "x", action: "react" } }, "")).toBeNull();
    expect(buildIgInbound(jennie, dm({ message: { mid: "d", is_deleted: true } }), "")).toBeNull();
    expect(buildIgInbound(jennie, dm({ message: { mid: "e" } }), "")).toBeNull();
    expect(buildIgInbound(jennie, { message: { mid: "f", text: "hi" } }, "")).toBeNull();
  });
});

describe("isIgEcho — bỏ echo tin của chính mình", () => {
  it("is_echo=true là echo", () => {
    expect(isIgEcho(jennie.igId, dm({ sender: { id: jennie.igId }, recipient: { id: "IGSID_CUSTOMER_1" }, message: { mid: "e1", text: "Dạ", is_echo: true } }))).toBe(true);
  });
  it("sender = chính IG account (thiếu cờ is_echo) vẫn là echo", () => {
    expect(isIgEcho(jennie.igId, dm({ sender: { id: jennie.igId } }))).toBe(true);
  });
  it("tin khách không phải echo", () => {
    expect(isIgEcho(jennie.igId, dm())).toBe(false);
  });
});

describe("verifyMetaSignature", () => {
  const secret = "test_secret";
  const raw = Buffer.from(JSON.stringify({ object: "instagram", entry: [] }));
  const sig = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  it("chữ ký đúng → true", () => expect(verifyMetaSignature(raw, sig, secret)).toBe(true));
  it("sai secret / thiếu header / sai định dạng → false", () => {
    expect(verifyMetaSignature(raw, sig, "other")).toBe(false);
    expect(verifyMetaSignature(raw, undefined, secret)).toBe(false);
    expect(verifyMetaSignature(raw, "sha1=abc", secret)).toBe(false);
    expect(verifyMetaSignature(raw, sig, "")).toBe(false);
  });
});

describe("wiring guard — webhook.ts + manager.ts", () => {
  const dir = path.resolve(__dirname, "../channels");
  const webhook = readFileSync(path.join(dir, "facebook/webhook.ts"), "utf8");
  const manager = readFileSync(path.join(dir, "manager.ts"), "utf8");
  it("POST /webhook nhận object instagram (không 404) + chữ ký ở middleware cho MỌI object", () => {
    expect(webhook).toMatch(/body\.object === 'instagram'/);
    expect(webhook).toMatch(/router\.post\('\/webhook', requireMetaSignature\(/);
  });
  it("Page Yinyang thứ 2 (578361712032089) có kênh fb-yinyang-ig (không 'Unknown page ID')", () => {
    expect(webhook).toMatch(/'578361712032089'\]: 'fb-yinyang-ig'/);
  });
  it("ig-* có trong CHANNEL_PAGE để outbound gửi qua Page", () => {
    expect(webhook).toMatch(/CHANNEL_PAGE\[a\.channel\] = a\.pageId/);
  });
  it("manager không ghi 'failed Channel not found' cho ig-*", () => {
    expect(manager).toMatch(/startsWith\('ig-'\)\) return;/);
  });
});

describe("requireMetaSignature — POST /webhook mọi object (object=page lẫn instagram)", () => {
  const secret = "test_secret";
  function app() {
    const a = express();
    a.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
    a.post("/webhook", requireMetaSignature(() => secret), (req, res) => res.json({ reached: true, object: req.body.object }));
    return a;
  }
  const body = JSON.stringify({ object: "page", entry: [{ id: "101609408467458", messaging: [] }] });
  const sign = (b: string, s = secret) => "sha256=" + createHmac("sha256", s).update(b).digest("hex");
  const post = () => request(app()).post("/webhook").set("content-type", "application/json");

  it("object=page KHÔNG chữ ký → 401", async () => {
    const res = await post().send(body);
    expect(res.status).toBe(401);
  });
  it("object=page chữ ký sai secret → 401", async () => {
    const res = await post().set("x-hub-signature-256", sign(body, "wrong")).send(body);
    expect(res.status).toBe(401);
  });
  it("object=page chữ ký ký trên body KHÁC (body bị sửa) → 401", async () => {
    const res = await post().set("x-hub-signature-256", sign(body)).send(body.replace("101609408467458", "1"));
    expect(res.status).toBe(401);
  });
  it("object=page chữ ký đúng → 200 qua handler", async () => {
    const res = await post().set("x-hub-signature-256", sign(body)).send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reached: true, object: "page" });
  });
  it("thiếu FB_APP_SECRET → 401 (fail-closed)", async () => {
    const a = express();
    a.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
    a.post("/webhook", requireMetaSignature(() => ""), (_req, res) => res.json({ reached: true }));
    const res = await request(a).post("/webhook").set("content-type", "application/json").set("x-hub-signature-256", sign(body)).send(body);
    expect(res.status).toBe(401);
  });
});
