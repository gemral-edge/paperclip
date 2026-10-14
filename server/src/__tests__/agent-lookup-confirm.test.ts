import { describe, expect, it } from "vitest";
import { lookupAgentConfirmed } from "../services/agent-lookup-confirm.js";

const noSleep = async () => {};

function reader<T>(results: Array<T | null | Error>) {
  let calls = 0;
  const read = async () => {
    const next = results[calls++];
    if (next instanceof Error) throw next;
    return next ?? null;
  };
  return { read, calls: () => calls };
}

describe("lookupAgentConfirmed (GEM-1429)", () => {
  it("returns the agent on the first read without retrying", async () => {
    const r = reader([{ id: "a" }]);
    const out = await lookupAgentConfirmed(r.read, { sleep: noSleep });
    expect(out).toEqual({ kind: "found", agent: { id: "a" }, recoveredOnRetry: false });
    expect(r.calls()).toBe(1);
  });

  it("keeps the run when one read is empty but the re-read finds the agent (Edge X 09:00 case)", async () => {
    const r = reader([null, { id: "a" }]);
    const out = await lookupAgentConfirmed(r.read, { sleep: noSleep });
    expect(out).toEqual({ kind: "found", agent: { id: "a" }, recoveredOnRetry: true });
    expect(r.calls()).toBe(2);
  });

  it("reports missing only after two empty reads", async () => {
    const r = reader([null, null]);
    const out = await lookupAgentConfirmed(r.read, { sleep: noSleep });
    expect(out).toEqual({ kind: "missing" });
    expect(r.calls()).toBe(2);
  });

  it("propagates a DB error instead of treating it as a deleted agent", async () => {
    const r = reader([null, new Error("pooler stall")]);
    await expect(lookupAgentConfirmed(r.read, { sleep: noSleep })).rejects.toThrow("pooler stall");
  });

  it("waits the configured delay between the two reads", async () => {
    const waits: number[] = [];
    const r = reader([null, null]);
    await lookupAgentConfirmed(r.read, { retryDelayMs: 250, sleep: async (ms) => { waits.push(ms); } });
    expect(waits).toEqual([250]);
  });
});
