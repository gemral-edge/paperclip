// 31/10/2026 (live-terminal reply timeouts): agy >= 1.4.11 holds every model/tool step after the first
// behind an internal "policy_guardian" monitor whose init went from median 33s (1.4.10) to 98s (1.4.11)
// and 189s (1.4.12) on this machine. The old reply path handed agy a FILE POINTER, so the answer needed
// a second step (read_file → answer) that sat behind that gate past the 240s cap
// (cu-phuc-reply 2/2, quant-pit-reply 28, jennie-desk-reply 12 timeouts on 30–31/10).
// Sandboxed reply agents now send the whole context on stdin (`--input-format stream-json`), so the
// answer is the FIRST agent step, and we stop agy as soon as that step is DONE with a complete
// [[REPLY]]…[[/REPLY]] envelope instead of waiting for the process to exit.
// Same model, same provider, same account — this only changes how the prompt is delivered.

export const AGY_STREAM_ARGS = ['--input-format', 'stream-json', '--output-format', 'stream-json'] as const;

/** One NDJSON line for agy `--input-format stream-json` (schema verified on agy 1.4.12). */
export function agyStreamUserMessage(text: string): string {
  return JSON.stringify({ event: 'user', message: { content: text } }) + '\n';
}

export interface AgyStreamState {
  /** text of agent_response steps, keyed by step index */
  steps: Map<number, string>;
  /** text of the first agent_response step that finished with a full reply envelope */
  completedReply: string | null;
  /** `result.response` from the final event, if agy got that far */
  resultResponse: string | null;
  resultError: string | null;
  buffer: string;
}

export function newAgyStreamState(): AgyStreamState {
  return { steps: new Map(), completedReply: null, resultResponse: null, resultError: null, buffer: '' };
}

const ENVELOPE_CLOSE = /\[\[\/REPLY\]\]/;

/** Feed a stdout chunk; returns the text deltas seen in this chunk (for live streaming). */
export function feedAgyStream(state: AgyStreamState, chunk: string): string {
  state.buffer += chunk;
  let deltas = '';
  let nl: number;
  while ((nl = state.buffer.indexOf('\n')) >= 0) {
    const line = state.buffer.slice(0, nl).trim();
    state.buffer = state.buffer.slice(nl + 1);
    if (!line.startsWith('{')) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev?.event === 'step_update') {
      const su = ev.step_update || {};
      if (su.step_type !== 'agent_response') continue;
      const idx = Number(su.step_index) || 0;
      const delta = typeof su.text_delta === 'string' ? su.text_delta : '';
      if (delta) {
        state.steps.set(idx, (state.steps.get(idx) || '') + delta);
        deltas += delta;
      }
      if (su.state === 'DONE' && state.completedReply === null) {
        const text = state.steps.get(idx) || '';
        if (ENVELOPE_CLOSE.test(text)) state.completedReply = text;
      }
    } else if (ev?.event === 'result') {
      const r = ev.result || {};
      if (typeof r.response === 'string') state.resultResponse = r.response;
      if (typeof r.error === 'string' && r.error) state.resultError = r.error;
    }
  }
  return deltas;
}

/** Best reply text available once agy has exited (or been stopped). */
export function agyStreamFinalText(state: AgyStreamState): string {
  if (state.completedReply) return state.completedReply;
  if (state.resultResponse) return state.resultResponse;
  const all = [...state.steps.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t);
  return all.length ? all[all.length - 1] : '';
}
