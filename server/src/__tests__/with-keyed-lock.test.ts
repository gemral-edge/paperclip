import { describe, expect, it, vi } from "vitest";
import { withKeyedLock, KEYED_LOCK_WAIT_TIMEOUT_MS } from "../services/fleet-throttle.js";

describe("withKeyedLock (unit)", () => {
  it("executes functions sequentially for the same key", async () => {
    const order: number[] = [];
    const p1 = withKeyedLock("test-seq", async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push(1);
      return 1;
    });
    const p2 = withKeyedLock("test-seq", async () => {
      order.push(2);
      return 2;
    });

    const results = await Promise.all([p1, p2]);
    expect(results).toEqual([1, 2]);
    expect(order).toEqual([1, 2]);
  });

  it("recovers and runs subsequent calls if previous call is permanently hung (anti-deadlock)", async () => {
    vi.useFakeTimers();
    try {
      const key = "test-hung";
      // First call simulates a hung promise that never resolves
      void withKeyedLock(key, () => new Promise<never>(() => {}));

      let secondExecuted = false;
      const secondCall = withKeyedLock(key, async () => {
        secondExecuted = true;
        return "recovered";
      });

      // Advance time past KEYED_LOCK_WAIT_TIMEOUT_MS
      await vi.advanceTimersByTimeAsync(KEYED_LOCK_WAIT_TIMEOUT_MS + 100);

      const result = await secondCall;
      expect(secondExecuted).toBe(true);
      expect(result).toBe("recovered");
    } finally {
      vi.useRealTimers();
    }
  });
});
