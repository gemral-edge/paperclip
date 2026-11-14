import { describe, expect, it } from "vitest";
import { matchesFilter } from "./Agents";

describe("Agents tab filter", () => {
  it("Active keeps agents that are running on schedule, including ones in error", () => {
    for (const status of ["active", "running", "idle", "error"]) {
      expect(matchesFilter(status, "active", false)).toBe(true);
    }
    expect(matchesFilter("paused", "active", false)).toBe(false);
    expect(matchesFilter("terminated", "active", false)).toBe(false);
  });

  it("Error and Paused tabs stay narrow", () => {
    expect(matchesFilter("error", "error", false)).toBe(true);
    expect(matchesFilter("idle", "error", false)).toBe(false);
    expect(matchesFilter("paused", "paused", false)).toBe(true);
  });
});
