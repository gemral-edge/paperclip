// GEM-1429 (IMP-1014-W122-02): Edge X 09:00 timer run 928439a9 was cancelled with
// "agent no longer exists" while the agent row existed (created 10/09, never deleted).
// startNextQueuedRunForAgent had just read the agent successfully; the second read inside
// claimQueuedRun came back empty WITHOUT throwing (transaction pooler :6543, prepare:false).
// One empty read is not proof of deletion: cancelling on it destroys a scheduled post.
// Rule: an agent is "missing" only when TWO reads, separated by a short delay, both return
// nothing. A read that throws propagates (caller leaves the run queued for the next tick).

export type AgentLookupOutcome<T> =
  | { kind: "found"; agent: T; recoveredOnRetry: boolean }
  | { kind: "missing" };

export async function lookupAgentConfirmed<T>(
  read: () => Promise<T | null>,
  opts: { retryDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<AgentLookupOutcome<T>> {
  const first = await read();
  if (first) return { kind: "found", agent: first, recoveredOnRetry: false };
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  await sleep(opts.retryDelayMs ?? 300);
  const second = await read();
  if (second) return { kind: "found", agent: second, recoveredOnRetry: true };
  return { kind: "missing" };
}
