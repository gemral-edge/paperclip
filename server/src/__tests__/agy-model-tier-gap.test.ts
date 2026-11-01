import { describe, expect, it } from "vitest";
import {
  detectAntigravityModelNotAvailable,
  findReadyAntigravityAccountByPlan,
  planForAntigravityAccount,
  shouldAntigravityFallback,
  useAntigravityAccount,
  type AntigravityPoolAccount,
} from "@paperclipai/adapter-antigravity-local/server";

// GEM-1763 — stderr nguyên văn run 7f1e65bd (Edge SEO Officer, 31/10 23:00, tài khoản PRO maow390).
const REAL_STDERR =
  'error: invalid model selection (--model "Gemini 4 Argon (Medium)" --effort ""): model Gemini 4 Argon (Medium) is not recognized as a known model or custom model in settings\n';

const NOW = new Date("2026-10-31T16:00:00Z");
const POOL: AntigravityPoolAccount[] = [
  { email: "ultra1@x.com", plan: "ultra", status: "cooldown", cooldownUntil: "2026-10-31T20:46:52Z" },
  { email: "ultra2@x.com", plan: "ultra", status: "cooldown", cooldownUntil: "2026-10-31T20:45:41Z" },
  { email: "pro1@x.com", plan: "pro", status: "ready", cooldownUntil: null },
];

describe("GEM-1763 model chỉ có ở gói ULTRA trên tài khoản PRO", () => {
  it("nhận diện đúng stderr thật + tên model", () => {
    expect(detectAntigravityModelNotAvailable({ stderr: REAL_STDERR })).toEqual({
      notAvailable: true,
      model: "Gemini 4 Argon (Medium)",
    });
  });

  it("không nhầm với lỗi quota / dòng log của paperclip / stderr rỗng", () => {
    expect(detectAntigravityModelNotAvailable({ stderr: "RESOURCE_EXHAUSTED (code 429)" }).notAvailable).toBe(false);
    expect(detectAntigravityModelNotAvailable({ stderr: `[paperclip] ${REAL_STDERR}` }).notAvailable).toBe(false);
    expect(detectAntigravityModelNotAvailable({ stderr: null }).notAvailable).toBe(false);
  });

  it("lỗi model KHÔNG kích hoạt vòng xoay quota (xoay = đặt nhầm cooldown cho tài khoản PRO còn quota)", () => {
    expect(shouldAntigravityFallback({ stderr: REAL_STDERR })).toBe(false);
  });

  it("đọc gói của tài khoản đang dùng", () => {
    expect(planForAntigravityAccount("PRO1@x.com", POOL)).toBe("pro");
    expect(planForAntigravityAccount("nobody@x.com", POOL)).toBeNull();
  });

  it("mọi ULTRA đang cooldown → không có tài khoản, trả giờ hồi quota sớm nhất để hẹn chạy lại", () => {
    expect(findReadyAntigravityAccountByPlan("ultra", { accounts: POOL, now: NOW })).toEqual({
      email: null,
      earliestCooldownUntil: "2026-10-31T20:45:41.000Z",
    });
  });

  it("ULTRA hết cooldown → chọn được tài khoản ULTRA", () => {
    const later = new Date("2026-10-31T20:50:00Z");
    expect(findReadyAntigravityAccountByPlan("ultra", { accounts: POOL, now: later }).email).toBe("ultra1@x.com");
    expect(
      findReadyAntigravityAccountByPlan("ultra", { accounts: POOL, now: later, excludeEmail: "ultra1@x.com" }).email,
    ).toBe("ultra2@x.com");
  });

  it("chuyển tài khoản gọi đúng `use <email> --json` và chỉ ok khi switcher trả ok:true", async () => {
    let seen: string[] = [];
    const res = await useAntigravityAccount("ultra1@x.com", {
      runner: async (_py, args) => {
        seen = args;
        return { exitCode: 0, stdout: '{"ok": true, "new_email": "ultra1@x.com"}', stderr: "" };
      },
    });
    expect(seen.slice(1)).toEqual(["use", "ultra1@x.com", "--json"]);
    expect(res.ok).toBe(true);
    const bad = await useAntigravityAccount("ultra1@x.com", {
      runner: async () => ({ exitCode: 1, stdout: "", stderr: "KeyError" }),
    });
    expect(bad.ok).toBe(false);
  });
});
