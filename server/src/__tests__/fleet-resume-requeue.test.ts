import { describe, expect, it } from "vitest";
import {
  FLEET_PAUSE_CANCEL_REASON,
  selectRunsToRequeue,
  type PauseCancelledRun,
  type RequeueIssueState,
} from "../services/fleet-pause.js";

const PAUSED_AT = new Date("2026-11-13T15:06:50Z");
const at = (sec: number) => new Date(PAUSED_AT.getTime() + sec * 1000);

function run(id: string, agentId: string, issueId: string | null, finishedAt: Date, error = FLEET_PAUSE_CANCEL_REASON): PauseCancelledRun {
  return {
    id,
    agentId,
    invocationSource: "assignment",
    error,
    finishedAt,
    contextSnapshot: issueId ? { issueId } : {},
  };
}

const paused = new Map<string, Date | null>([
  ["eng", PAUSED_AT],
  ["be", PAUSED_AT],
]);

describe("fleet resume requeue selection", () => {
  it("hands back open issues still assigned to the same agent", () => {
    const issues = new Map<string, RequeueIssueState>([
      ["i-open", { status: "todo", assigneeAgentId: "eng" }],
      ["i-progress", { status: "in_progress", assigneeAgentId: "be" }],
    ]);
    const picked = selectRunsToRequeue(
      [run("r1", "eng", "i-open", at(5)), run("r2", "be", "i-progress", at(160))],
      paused,
      issues,
      new Set(),
    );
    expect(picked.map((r) => r.id).sort()).toEqual(["r1", "r2"]);
  });

  it("skips done/cancelled issues, re-assigned issues, busy issues and runs without an issue", () => {
    const issues = new Map<string, RequeueIssueState>([
      ["i-done", { status: "done", assigneeAgentId: "eng" }],
      ["i-cancel", { status: "cancelled", assigneeAgentId: "eng" }],
      ["i-moved", { status: "todo", assigneeAgentId: "someone-else" }],
      ["i-busy", { status: "todo", assigneeAgentId: "eng" }],
    ]);
    const picked = selectRunsToRequeue(
      [
        run("r1", "eng", "i-done", at(5)),
        run("r2", "eng", "i-cancel", at(5)),
        run("r3", "eng", "i-moved", at(5)),
        run("r4", "eng", "i-busy", at(5)),
        run("r5", "eng", null, at(5)),
        run("r6", "eng", "i-missing", at(5)),
      ],
      paused,
      issues,
      new Set(["i-busy"]),
    );
    expect(picked).toEqual([]);
  });

  it("only takes runs cut by THIS pause, with the pause reason, one per issue", () => {
    const issues = new Map<string, RequeueIssueState>([["i1", { status: "todo", assigneeAgentId: "eng" }]]);
    const picked = selectRunsToRequeue(
      [
        run("old", "eng", "i1", new Date("2026-11-10T00:00:00Z")),
        run("other-reason", "eng", "i1", at(5), "Cancelled due to budget pause"),
        run("first", "eng", "i1", at(3)),
        run("latest", "eng", "i1", at(9)),
        run("not-paused-agent", "ghost", "i1", at(5)),
      ],
      paused,
      issues,
      new Set(),
    );
    expect(picked.map((r) => r.id)).toEqual(["latest"]);
  });
});
