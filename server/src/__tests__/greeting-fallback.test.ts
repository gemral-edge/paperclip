// GEM-1126 — lời chào dự phòng khi agent trả rỗng: chỉ tin CHÀO THUẦN mới nhận câu cố định.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildGreetingFallback, isShortGreeting } from "../channels/greeting-fallback.js";

describe("isShortGreeting", () => {
  it.each([
    "Hi Em", "hi em", "Xin chào", "xin chào shop ạ", "Chào bạn", "alo", "Alo có ai không", "Hello 👋",
    "hey!", "Shop ơi", "Good morning", "chào ad nhé", "Chào anh chị",
  ])("nhận %s là lời chào", (s) => expect(isShortGreeting(s)).toBe(true));

  it.each([
    "", "   ", "em", "shop", "ạ nhé", "có không",
    "Hi em cho mình hỏi khóa học", "chào shop, giá bao nhiêu?", "Hello 123", "xin chào mã đơn 4848",
    "hi em tư vấn giúp mình", "Hi?", "chào buổi sáng tốt lành nha cả nhà mình",
  ])("KHÔNG coi %j là lời chào thuần", (s) => expect(isShortGreeting(s)).toBe(false));

  it("null/undefined → false", () => {
    expect(isShortGreeting(null)).toBe(false);
    expect(isShortGreeting(undefined)).toBe(false);
  });
});

describe("buildGreetingFallback", () => {
  it("tin Việt (kể cả 'Hi Em') → trả lời tiếng Việt, không chứa giá/số", () => {
    const t = buildGreetingFallback("Hi Em");
    expect(t).toContain("Dạ em chào");
    expect(t).not.toMatch(/\d/);
  });
  it("tin thuần Anh → trả lời tiếng Anh", () => {
    expect(buildGreetingFallback("Hello")).toMatch(/^Hello!/);
    expect(buildGreetingFallback("good morning")).toMatch(/^Hello!/);
  });
});

describe("consumer.ts nối đúng ngoại lệ chào hỏi", () => {
  const src = readFileSync(new URL("../channels/consumer.ts", import.meta.url), "utf8");
  it("nhánh agent_silent gọi isShortGreeting + dedupeKey + vẫn handleEscalation", () => {
    const i = src.indexOf("markBatch('agent', 'skipped', isClosure ? 'closure_intent' : 'agent_silent')");
    expect(i).toBeGreaterThan(0);
    // Cắt đến hết nhánh agent_silent (`return;` đầu tiên sau handleEscalation), không phụ thuộc độ dài cố định —
    // 03/10 router-escalation chèn thêm ở trên làm cửa sổ 3200 ký tự cũ trượt mất `noPause: true`.
    const end = src.indexOf("noPause: true", i);
    expect(end).toBeGreaterThan(i);
    expect(end - i).toBeLessThan(6000);
    const block = src.slice(i, end + 40);
    expect(block).toContain("isShortGreeting(merged.content)");
    expect(block).toContain("buildReplyDedupeKey(sessionKey, buildBatchId(claimedIds))");
    expect(block).toContain("isSessionPaused(sessionKey)");
    expect(block).toContain("handleEscalation({");
    expect(block).toContain("noPause: true");
  });
});
