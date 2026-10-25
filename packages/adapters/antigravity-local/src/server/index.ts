export { execute, runAntigravityLogin } from "./execute.js";
export { listAntigravitySkills, syncAntigravitySkills } from "./skills.js";
export { testEnvironment } from "./test.js";
export {
  parseAntigravityStdout,
  looksLikeSystemPromptLeak,
  readAntigravityReplyFromTranscript,
  findAntigravityReplyByTurnMarker,
  findAntigravityRunByTurnMarker,
  readAntigravityRunEntries,
  turnLineOffset,
  readAntigravityTranscriptUsage,
  antigravityTranscriptPath,
  detectAntigravityAuthRequired,
  detectAntigravityQuotaExhausted,
  detectAntigravityTransientDisconnect,
  shouldAntigravityFallback,
  countAntigravityActionCalls,
  ANTIGRAVITY_READ_ONLY_TOOLS,
  ANTIGRAVITY_CLEAN_EXIT_PATTERNS,
  isAntigravityCleanExitProse,
  countAntigravityMutationCalls,
  ANTIGRAVITY_MUTATION_TOOL_RE,
  isAntigravityUnfinishedPromise,
} from "./parse.js";
export { defaultAgyCommand } from "./execute.js";
export { DEFAULT_ANTIGRAVITY_FALLBACK_MODELS, DEFAULT_ANTIGRAVITY_MODEL } from "../index.js";
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readNonEmptyString(record.sessionId) ??
      readNonEmptyString(record.session_id) ??
      readNonEmptyString(record.sessionID);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(record.cwd) ??
      readNonEmptyString(record.workdir) ??
      readNonEmptyString(record.folder);
    const workspaceId = readNonEmptyString(record.workspaceId) ?? readNonEmptyString(record.workspace_id);
    const repoUrl = readNonEmptyString(record.repoUrl) ?? readNonEmptyString(record.repo_url);
    const repoRef = readNonEmptyString(record.repoRef) ?? readNonEmptyString(record.repo_ref);
    // BUG-052 fix 2026-04-22: persist personaHash so hash-based session
    // invalidation actually survives the sessionCodec round-trip. Without
    // this, adapter writes personaHash into sessionParams but the codec
    // strips it before DB write, making the invalidation check silently
    // inert (personaChanged always false → session never rotated).
    const personaHash = readNonEmptyString(record.personaHash);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
      ...(personaHash ? { personaHash } : {}),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId =
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.sessionID);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(params.cwd) ??
      readNonEmptyString(params.workdir) ??
      readNonEmptyString(params.folder);
    const workspaceId = readNonEmptyString(params.workspaceId) ?? readNonEmptyString(params.workspace_id);
    const repoUrl = readNonEmptyString(params.repoUrl) ?? readNonEmptyString(params.repo_url);
    const repoRef = readNonEmptyString(params.repoRef) ?? readNonEmptyString(params.repo_ref);
    const personaHash = readNonEmptyString(params.personaHash);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
      ...(personaHash ? { personaHash } : {}),
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return (
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.sessionID)
    );
  },
};
