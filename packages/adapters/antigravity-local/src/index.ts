export const type = "antigravity_local";
export const label = "Antigravity CLI (Gemini 3.8 Flash)";
// Verified 15/06/2026: truyền thẳng chuỗi `--model "Gemini 3.1 Pro (High)"` (nguyên văn,
// có ngoặc trong tên). KHÔNG dùng `agy models` (lệnh hay kẹt mở UI). User có thể nhập
// chuỗi model khác trong config (freeform) — adapter không hardcode danh sách để tránh
// đoán sai tên model Antigravity expose.
// 2026-10-21: "Gemini 3.1 Pro (High)" bị agy gỡ (invalid model selection) → 3.8 Flash (High). GEM-1583.
export const DEFAULT_ANTIGRAVITY_MODEL = "Gemini 3.8 Flash (High)";

// 22/10/2026 chị Jennie: CẤM fallback model — hết quota/model lỗi thì để lỗi nguyên (GEM-1241 đã gỡ).
// Hằng này PHẢI luôn rỗng; không code nào còn đọc nó. Máy gác paperclip_model_list_audit.py đỏ nếu ≠ rỗng.
export const DEFAULT_ANTIGRAVITY_FALLBACK_MODELS: readonly string[] = [];

// Full Antigravity model picker. Pass the string VERBATIM via `--model "<id>"`.
// Default = DEFAULT_ANTIGRAVITY_MODEL above.
//
// SOURCE OF TRUTH = `agy models` (second column = the display string agy accepts).
// The slug column (`gemini-3.7-flash-high`) is NOT accepted by --model; passing an
// unknown value makes agy print "invalid model selection" and list these exact
// display strings. Verified 15/08/2026 by passing a bogus --model on purpose.
//
// This list is a hand-kept COPY of a live source, so it drifts whenever agy ships
// new models. `scripts/paperclip_model_list_audit.py --provider antigravity
// --against-agy` (crypto-pattern-scanner repo) diffs `agy models` against this list
// plus the two PROVIDER_MODELS.antigravity copies, so the drift gets reported
// instead of silently sitting here.
//
// 2026-08-15: +Gemini 3.7 Flash (High/Medium/Low) +Gemini 3.6 Flash (High/Medium/Low)
// — agy had shipped them but all three lists still stopped at 3.5.
// 2026-09-03: +Gemini 3.8 Flash (High/Medium/Low) — agy shipped 3.8; verified verbatim
// via `agy models` (col 2). gem-master + sales-closer bumped 3.7→3.8 (High).
// 2026-10-14: +Gemini 4 Argon (High/Medium/Low) — verbatim via `agy models` (col 2).
// 2026-10-21: removed Gemini 4 Argon x3, 3.7 Flash x3, 3.6 Flash x3, 3.1 Pro x2 — `agy models` (agy 1.4.4) lists only 3.8 Flash x3 + Claude x2 + GPT-OSS; `agy --model` rejects them (invalid model selection). GEM-1583.
// 2026-11-13: +Gemini 4 Hydrogen + Gemini 4 Carbon (High/Medium/Low) — seen in the Antigravity model picker; tiers mirror Argon. Not yet verified via `agy models` (CLI signed out).
// 2026-11-14: +Orchestrator (Carbon) +Orchestrator (Argon) +Gemini 4 Hydrogen (XHigh) — verbatim via `agy models` col 2 (22 models).
// 2026-10-25: re-synced with live `agy models` (13 models). The 21/10 trim (GEM-1583) matched agy 1.4.4; agy now lists Gemini 4 Argon + Claude Opus/Sonnet 5.5 again — keep lists = `agy models` col 2.
// 2026-11-19: +Gemini 4 Neon (High/XHigh/Medium/Low) +Orchestrator (Neon) — verbatim via `agy models` col 2 (23 models).
// 2026-11-19: removed Claude Opus 5.5 x3 + Claude Sonnet 5.5 x3 — `agy models` no longer lists them (0 agents in `agents`/`paperclip_agents` used them).
// 2026-11-21: +Claude Sonnet 4.6 (Thinking) +Claude Opus 4.6 (Thinking) — verbatim via `agy models` col 2 (23 models).
// 2026-11-21 chị Jennie: agy 1.5.14 lets Orchestrator pick the PLANNER model + its thinking
// level (and the executor's), saved as settings `{"orchestrator":{"planner":"Gemini 4 Neon (High)",
// "executor":"Gemini 4 Hydrogen (XHigh)"}}` — verified by driving the agy `/model` picker and reading
// settings.json. `--effort` is REJECTED for Orchestrator ("not supported"), so the level can only
// travel through `--settings`. Paperclip exposes each planner+level as a virtual model id
// "Orchestrator (Neon · XHigh)"; resolveAntigravityModel() turns it into
// `--model "Orchestrator (Neon)" --settings '{"orchestrator":{...}}'`.
// Plain "Orchestrator (Neon)" stays valid (agy default levels).
export const ORCHESTRATOR_EXECUTOR_MODEL = "Gemini 4 Hydrogen (XHigh)";
export const ORCHESTRATOR_PLANNER_LEVELS: Record<string, readonly string[]> = {
  Neon: ["XHigh", "High", "Medium", "Low"],
  Carbon: ["High", "Medium", "Low"],
  Argon: ["High", "Medium", "Low"],
};
const ORCHESTRATOR_VIRTUAL_RE = /^Orchestrator \((Neon|Carbon|Argon) · (XHigh|High|Medium|Low)\)$/;

export function orchestratorVirtualModelIds(): string[] {
  return Object.entries(ORCHESTRATOR_PLANNER_LEVELS).flatMap(([base, levels]) =>
    levels.map((lv) => `Orchestrator (${base} · ${lv})`),
  );
}

// 2026-11-21: executor (Gemini 4 Hydrogen) level is chosen per agent via adapterConfig
// `orchestratorExecutorEffort` (Low|Medium|High|XHigh). Empty = agy default (XHigh — the agy
// `/model` picker shows "Gemini 4 Hydrogen (XHigh) executes" when nothing is set).
export const ORCHESTRATOR_EXECUTOR_LEVELS = ["Low", "Medium", "High", "XHigh"] as const;
const ORCHESTRATOR_PLAIN_RE = /^Orchestrator \((Neon|Carbon|Argon)\)$/;

function executorModelFor(level: string | null | undefined): string | null {
  const lv = (level ?? "").trim();
  return (ORCHESTRATOR_EXECUTOR_LEVELS as readonly string[]).includes(lv) ? `Gemini 4 Hydrogen (${lv})` : null;
}

/** Map a Paperclip model id (+ optional executor level) to the agy `--model` value + optional `--settings` JSON. */
export function resolveAntigravityModel(
  model: string,
  executorLevel?: string | null,
): { model: string; settings: string | null } {
  const trimmed = model.trim();
  const executor = executorModelFor(executorLevel);
  const m = ORCHESTRATOR_VIRTUAL_RE.exec(trimmed);
  if (m) {
    const [, base, level] = m;
    if (!ORCHESTRATOR_PLANNER_LEVELS[base]?.includes(level)) return { model, settings: null };
    return {
      model: `Orchestrator (${base})`,
      settings: JSON.stringify({
        orchestrator: { planner: `Gemini 4 ${base} (${level})`, executor: executor ?? ORCHESTRATOR_EXECUTOR_MODEL },
      }),
    };
  }
  // Plain "Orchestrator (Neon)" keeps agy's default planner level; only the executor is overridden.
  if (executor && ORCHESTRATOR_PLAIN_RE.test(trimmed)) {
    return { model: trimmed, settings: JSON.stringify({ orchestrator: { executor } }) };
  }
  return { model, settings: null };
}

export const models = [
  { id: "Gemini 3.8 Flash (High)", label: "Gemini 3.8 Flash (High) — Fast" },
  { id: "Gemini 3.8 Flash (Medium)", label: "Gemini 3.8 Flash (Medium) — Fast" },
  { id: "Gemini 3.8 Flash (Low)", label: "Gemini 3.8 Flash (Low) — Fast" },
  { id: "Gemini 4 Neon (High)", label: "Gemini 4 Neon (High)" },
  { id: "Gemini 4 Neon (XHigh)", label: "Gemini 4 Neon (XHigh)" },
  { id: "Gemini 4 Neon (Medium)", label: "Gemini 4 Neon (Medium)" },
  { id: "Gemini 4 Neon (Low)", label: "Gemini 4 Neon (Low)" },
  { id: "Orchestrator (Neon)", label: "Orchestrator (Neon)" },
  { id: "Orchestrator (Neon · XHigh)", label: "Orchestrator — planner Gemini 4 Neon (XHigh)" },
  { id: "Orchestrator (Neon · High)", label: "Orchestrator — planner Gemini 4 Neon (High)" },
  { id: "Orchestrator (Neon · Medium)", label: "Orchestrator — planner Gemini 4 Neon (Medium)" },
  { id: "Orchestrator (Neon · Low)", label: "Orchestrator — planner Gemini 4 Neon (Low)" },
  { id: "Orchestrator (Carbon · High)", label: "Orchestrator — planner Gemini 4 Carbon (High)" },
  { id: "Orchestrator (Carbon · Medium)", label: "Orchestrator — planner Gemini 4 Carbon (Medium)" },
  { id: "Orchestrator (Carbon · Low)", label: "Orchestrator — planner Gemini 4 Carbon (Low)" },
  { id: "Orchestrator (Argon · High)", label: "Orchestrator — planner Gemini 4 Argon (High)" },
  { id: "Orchestrator (Argon · Medium)", label: "Orchestrator — planner Gemini 4 Argon (Medium)" },
  { id: "Orchestrator (Argon · Low)", label: "Orchestrator — planner Gemini 4 Argon (Low)" },
  { id: "Gemini 4 Argon (High)", label: "Gemini 4 Argon (High)" },
  { id: "Gemini 4 Argon (Medium)", label: "Gemini 4 Argon (Medium)" },
  { id: "Gemini 4 Argon (Low)", label: "Gemini 4 Argon (Low)" },
  { id: "Gemini 4 Hydrogen (XHigh)", label: "Gemini 4 Hydrogen (XHigh)" },
  { id: "Gemini 4 Hydrogen (High)", label: "Gemini 4 Hydrogen (High)" },
  { id: "Gemini 4 Hydrogen (Medium)", label: "Gemini 4 Hydrogen (Medium)" },
  { id: "Gemini 4 Hydrogen (Low)", label: "Gemini 4 Hydrogen (Low)" },
  { id: "Gemini 4 Carbon (High)", label: "Gemini 4 Carbon (High)" },
  { id: "Gemini 4 Carbon (Medium)", label: "Gemini 4 Carbon (Medium)" },
  { id: "Gemini 4 Carbon (Low)", label: "Gemini 4 Carbon (Low)" },
  { id: "Orchestrator (Carbon)", label: "Orchestrator (Carbon)" },
  { id: "Orchestrator (Argon)", label: "Orchestrator (Argon)" },
  { id: "Claude Sonnet 4.6 (Thinking)", label: "Claude Sonnet 4.6 (Thinking)" },
  { id: "Claude Opus 4.6 (Thinking)", label: "Claude Opus 4.6 (Thinking)" },
  { id: "GPT-OSS 120B (Medium)", label: "GPT-OSS 120B (Medium)" },
];

export const agentConfigurationDoc = `# antigravity_local agent configuration

Adapter: antigravity_local

Use when:
- You want Paperclip to run the Antigravity CLI (\`agy\`) locally on the host machine
- You want the Antigravity engine (Gemini 3.8 Flash by default) via Google AI Ultra (OAuth shared with Gemini CLI)
- You want chat sessions resumed across heartbeats via --conversation
- You want Paperclip skills injected locally without polluting the global environment

Don't use when:
- You need webhook-style external invocation (use http or openclaw_gateway)
- You only need a one-shot script without an AI coding agent loop (use process)
- Antigravity CLI (\`agy\`) is not installed on the machine that runs Paperclip

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file (AGENTS.md) — its folder is granted via --add-dir so the agent reads its own persona/sop/knowledge
- promptTemplate (string, optional): run prompt template
- model (string, optional): Antigravity model id. Defaults to "Gemini 3.8 Flash (High)".
- command (string, optional): defaults to "agy"
- extraArgs (string[], optional): additional CLI args (gemini/claude-only flags are filtered out)
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- agy follows the Claude Code model: it auto-reads GEMINI.md/AGENTS.md at cwd and reads project files on demand. The adapter writes the full persona/memory/skill-pointer context to a temp file and passes a short \`-p "Đọc <file> rồi thực hiện"\` pointer (no stdin, no argv length limit).
- CWD = PROJECT_ROOT is safe (agy uses native file tools, no recursive cwd scan/crash).
- Sessions resume via \`--conversation <id>\`; if the id is new, agy creates a fresh brain at ~/.gemini/antigravity-cli/brain/<id>/. No transcript parsing needed to obtain the session.
- MCP tools load globally from ~/.gemini (mcp-server-enablement.json). Tool naming uses a SINGLE underscore: mcp_<server>_<tool> (e.g. mcp_supabase_execute_sql).
- Paperclip auto-injects local skills into \`~/.gemini/skills/\` via symlinks (agy reads them via view_file).
- Authentication uses the shared Google OAuth login (Ultra) under ~/.gemini.
`;
