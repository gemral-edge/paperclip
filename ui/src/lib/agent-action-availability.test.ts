import { describe, expect, it } from "vitest";
import {
  isPauseDisabled,
  isResumeDisabled,
  isPauseToggleDisabled,
  isRunHeartbeatDisabled,
  pauseToggleAction,
} from "./agent-action-availability";

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

describe("pause toggle + run heartbeat (11/11/2026)", () => {
  it("toggle picks resume only for paused agents", () => {
    expect(pauseToggleAction("paused")).toBe("resume");
    for (const s of ["active", "idle", "running", "error", "terminated", "pending_approval"]) {
      expect(pauseToggleAction(s)).toBe("pause");
    }
  });

  it("toggle is enabled for active/idle/running/error/paused, disabled for terminal states", () => {
    for (const s of ["active", "idle", "running", "error", "paused"]) {
      expect(isPauseToggleDisabled(s, false)).toBe(false);
    }
    expect(isPauseToggleDisabled("terminated", false)).toBe(true);
    expect(isPauseToggleDisabled("pending_approval", false)).toBe(true);
    expect(isPauseToggleDisabled("idle", true)).toBe(true);
  });

  it("run heartbeat is blocked for paused/terminated/pending_approval or while mutating", () => {
    for (const s of ["active", "idle", "running", "error"]) {
      expect(isRunHeartbeatDisabled(s, false)).toBe(false);
    }
    for (const s of ["paused", "terminated", "pending_approval"]) {
      expect(isRunHeartbeatDisabled(s, false)).toBe(true);
    }
    expect(isRunHeartbeatDisabled("idle", true)).toBe(true);
  });
});
