// SSOT for the Pause/Resume (toggle) + Run Heartbeat disabled matrix on agent detail header & agents list rows.
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

// 11/11/2026 (chị Jennie): gộp Pause/Resume thành 1 nút bật-tắt; nút thứ 2 = Run Heartbeat.
// Nút bật-tắt: agent paused -> hành động "resume", còn lại -> "pause". Disabled theo đúng
// ma trận ở trên cho hành động hiện tại (không mở hành động API sẽ từ chối).
export function pauseToggleAction(status: string): "pause" | "resume" {
  return status === "paused" ? "resume" : "pause";
}

export function isPauseToggleDisabled(status: string, isMutating: boolean): boolean {
  return pauseToggleAction(status) === "resume"
    ? isResumeDisabled(status, isMutating)
    : isPauseDisabled(status, isMutating);
}

// Run Heartbeat: server bỏ qua (202 skipped) khi agent không chạy được, nên khoá sẵn
// cho paused / pending_approval / terminated để không bấm "chạy" mà không có gì xảy ra.
export function isRunHeartbeatDisabled(status: string, isMutating: boolean): boolean {
  return (
    isMutating ||
    status === "paused" ||
    status === "terminated" ||
    status === "pending_approval"
  );
}
