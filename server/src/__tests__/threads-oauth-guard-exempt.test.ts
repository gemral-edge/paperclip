// EC-086: chỉ /channels/threads/oauth/callback được exempt khỏi remoteApiKeyGuard (Threads redirect
// trình duyệt về qua tunnel). /oauth/start phải bị chặn khi remote — chỉ bấm từ localhost.
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { remoteApiKeyGuard } from "../middleware/remote-api-key-guard.js";

function app() {
  const a = express();
  a.use(remoteApiKeyGuard("secret-key"));
  a.all("/channels/threads/oauth/start", (_req, res) => res.json({ reached: true }));
  a.all("/channels/threads/oauth/callback", (_req, res) => res.json({ reached: true }));
  return a;
}
const REMOTE = { "cf-ray": "test" };

describe("remoteApiKeyGuard — threads oauth boundary", () => {
  it("remote callback → exempt", async () => {
    const res = await request(app()).get("/channels/threads/oauth/callback").set(REMOTE);
    expect(res.status).toBe(200);
  });
  it("remote start WITHOUT key → 401", async () => {
    const res = await request(app()).get("/channels/threads/oauth/start").set(REMOTE);
    expect(res.status).toBe(401);
  });
  it("local start → pass", async () => {
    const res = await request(app()).get("/channels/threads/oauth/start");
    expect(res.status).toBe(200);
  });
});
