export const type = "antigravity_local";
export const label = "Antigravity CLI (Gemini 3.1 Pro)";
// Verified 15/06/2026: truyền thẳng chuỗi `--model "Gemini 3.1 Pro (High)"` (nguyên văn,
// có ngoặc trong tên). KHÔNG dùng `agy models` (lệnh hay kẹt mở UI). User có thể nhập
// chuỗi model khác trong config (freeform) — adapter không hardcode danh sách để tránh
// đoán sai tên model Antigravity expose.
export const DEFAULT_ANTIGRAVITY_MODEL = "Gemini 3.1 Pro (High)";

// Model dự phòng khi model chính (Gemini) đụng tường credits/quota (GEM-1241): 05/10 tín
// dụng Gemini cạn ở MỌI model Gemini → 17 agent + 2 bot CSKH đứng 5,5h vì adapter retry cùng
// model. Mặc định CHỈ áp cho model chính họ Gemini (Claude trong agy là hạn mức riêng — probe
// 05/10 OK). Ghi đè per-agent bằng adapterConfig.fallbackModels (mảng; [] = tắt dự phòng).
// 21/10: 5.5 (High) bi agy go khoi danh sach (invalid model selection) -> 4.6 (Thinking), verify `agy -p OK`.
export const DEFAULT_ANTIGRAVITY_FALLBACK_MODELS: readonly string[] = ["Claude Sonnet 4.6 (Thinking)"];

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
export const models = [
  { id: "Gemini 3.8 Flash (High)", label: "Gemini 3.8 Flash (High) — Fast" },
  { id: "Gemini 3.8 Flash (Medium)", label: "Gemini 3.8 Flash (Medium) — Fast" },
  { id: "Gemini 3.8 Flash (Low)", label: "Gemini 3.8 Flash (Low) — Fast" },
  { id: "Gemini 4 Argon (High)", label: "Gemini 4 Argon (High)" },
  { id: "Gemini 4 Argon (Medium)", label: "Gemini 4 Argon (Medium)" },
  { id: "Gemini 4 Argon (Low)", label: "Gemini 4 Argon (Low)" },
  { id: "Gemini 3.7 Flash (High)", label: "Gemini 3.7 Flash (High) — Fast" },
  { id: "Gemini 3.7 Flash (Medium)", label: "Gemini 3.7 Flash (Medium) — Fast" },
  { id: "Gemini 3.7 Flash (Low)", label: "Gemini 3.7 Flash (Low) — Fast" },
  { id: "Gemini 3.6 Flash (High)", label: "Gemini 3.6 Flash (High) — Fast" },
  { id: "Gemini 3.6 Flash (Medium)", label: "Gemini 3.6 Flash (Medium) — Fast" },
  { id: "Gemini 3.6 Flash (Low)", label: "Gemini 3.6 Flash (Low) — Fast" },
  // 2026-09-03: removed Gemini 3.5 Flash (High/Medium/Low) — agy no longer lists
  // them (`agy models` dropped 3.5), so passing them would fail --model. No agent
  // used 3.5 (verified paperclip_agents). Kept the mirror in sync with agy.
  { id: "Gemini 3.1 Pro (High)", label: "Gemini 3.1 Pro (High)" },
  { id: "Gemini 3.1 Pro (Low)", label: "Gemini 3.1 Pro (Low)" },
  { id: "Claude Sonnet 4.6 (Thinking)", label: "Claude Sonnet 4.6 (Thinking)" },
  { id: "Claude Opus 4.6 (Thinking)", label: "Claude Opus 4.6 (Thinking)" },
  { id: "GPT-OSS 120B (Medium)", label: "GPT-OSS 120B (Medium)" },
];

export const agentConfigurationDoc = `# antigravity_local agent configuration

Adapter: antigravity_local

Use when:
- You want Paperclip to run the Antigravity CLI (\`agy\`) locally on the host machine
- You want the Gemini 3.1 Pro (High) engine via Google AI Ultra (OAuth shared with Gemini CLI)
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
- model (string, optional): Antigravity model id. Defaults to "Gemini 3.1 Pro (High)".
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
