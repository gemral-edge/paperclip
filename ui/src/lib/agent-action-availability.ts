// SSOT for the Pause/Resume button disabled matrix on agent detail header & agents list rows.
// Kept in sync with the server guards in server/src/services/agents.ts:
//   - pause()  throws for terminated
//   - resume() throws for terminated AND pending_approval
// so the UI must never enable an action the API would reject.
// See docs/plans_reports/2026-08-31-PAPERCLIP-NO-AUTOPAUSE-ON-ERROR-SPLIT-BUTTON.
//
// Matrix (status -> [pause, resume]):
//   active          -> [enabled,  disabled]
//   idle            -> [enabled,  disabled]
//   running         -> [enabled,  disabled]
//   error           -> [enabled,  disabled]   (error is a badge, agent still runs)
//   paused          -> [disabled, enabled]
//   pending_approval-> [disabled, disabled]
//   terminated      -> [disabled, disabled]

export function isPauseDisabled(status: string, isMutating: boolean): boolean {
  return (
    isMutating ||
    status === "paused" ||
    status === "terminated" ||
    status === "pending_approval"
  );
}

export function isResumeDisabled(status: string, isMutating: boolean): boolean {
  // Resume is only valid from an explicitly paused agent.
  return isMutating || status !== "paused";
}
