import { describe, expect, it } from "vitest";
import { isPauseDisabled, isResumeDisabled } from "./agent-action-availability";

// Expected Pause/Resume disabled state per agent status (isMutating = false).
// Matches server guards agents.ts pause()/resume(). GEM-622.
const MATRIX: Array<{
  status: string;
  pauseDisabled: boolean;
  resumeDisabled: boolean;
}> = [
  { status: "active", pauseDisabled: false, resumeDisabled: true },
  { status: "idle", pauseDisabled: false, resumeDisabled: true },
  { status: "running", pauseDisabled: false, resumeDisabled: true },
  // error is a badge, agent still runs -> Pause available, Resume not.
  { status: "error", pauseDisabled: false, resumeDisabled: true },
  { status: "paused", pauseDisabled: true, resumeDisabled: false },
  { status: "pending_approval", pauseDisabled: true, resumeDisabled: true },
  // terminated: server throws on both -> both buttons disabled.
  { status: "terminated", pauseDisabled: true, resumeDisabled: true },
];

describe("agent action availability — Pause/Resume disabled matrix", () => {
  for (const row of MATRIX) {
    it(`status "${row.status}" -> pause disabled=${row.pauseDisabled}, resume disabled=${row.resumeDisabled}`, () => {
      expect(isPauseDisabled(row.status, false)).toBe(row.pauseDisabled);
      expect(isResumeDisabled(row.status, false)).toBe(row.resumeDisabled);
    });
  }

  it("terminated never exposes an action the API would reject", () => {
    expect(isPauseDisabled("terminated", false)).toBe(true);
    expect(isResumeDisabled("terminated", false)).toBe(true);
  });

  it("an in-flight mutation disables both buttons regardless of status", () => {
    for (const row of MATRIX) {
      expect(isPauseDisabled(row.status, true)).toBe(true);
      expect(isResumeDisabled(row.status, true)).toBe(true);
    }
  });

  // Behavior note (Codex R1 finding-1): resuming an 'error' agent lands it in
  // 'idle', clearing the agent-level error badge. That is intentional — the
  // durable failure record lives in heartbeat_runs history, not agents.status.
  // We therefore do NOT assert error survives a pause/resume cycle here.
});
