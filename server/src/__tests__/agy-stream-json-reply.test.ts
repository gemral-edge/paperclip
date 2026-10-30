import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGY_STREAM_ARGS,
  agyStreamFinalText,
  agyStreamUserMessage,
  feedAgyStream,
  newAgyStreamState,
} from "../channels/agy-stream-json.js";

// stdout nguyên văn của agy 1.4.12 `--input-format stream-json --output-format stream-json` (31/10, probe 40k ký tự).
const REAL_STDOUT = [
  '{"event":"init","conversation_id":"1370200a","init":{"model":"Gemini 3.8 Flash (Medium)","tools":["view_file"],"permission_mode":"always-proceed"}}',
  '{"event":"step_update","step_update":{"conversation_id":"1370200a","step_index":0,"state":"DONE","step_type":"user_input"}}',
  '{"event":"step_update","step_update":{"conversation_id":"1370200a","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"[[REPLY]]ORC"}}',
  '{"event":"step_update","step_update":{"conversation_id":"1370200a","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"HID-77[[/REPLY"}}',
  '{"event":"step_update","step_update":{"conversation_id":"1370200a","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"]]\\n","duration_seconds":3.1}}',
  '{"event":"result","result":{"conversation_id":"1370200a","status":"SUCCESS","response":"[[REPLY]]ORCHID-77[[/REPLY]]\\n","num_turns":1}}',
].join("\n") + "\n";

describe("agy stream-json reply path (live-terminal reply timeouts 31/10)", () => {
  it("input line matches the schema agy accepts (event=user, message.content)", () => {
    const line = JSON.parse(agyStreamUserMessage("xin chào"));
    expect(line).toEqual({ event: "user", message: { content: "xin chào" } });
    expect(AGY_STREAM_ARGS).toContain("stream-json");
  });

  it("marks the reply complete as soon as the agent step is DONE, before the result event", () => {
    const s = newAgyStreamState();
    const lines = REAL_STDOUT.split("\n");
    feedAgyStream(s, lines.slice(0, 5).join("\n") + "\n");
    expect(s.completedReply).toBe("[[REPLY]]ORCHID-77[[/REPLY]]\n");
    expect(s.resultResponse).toBeNull();
    expect(agyStreamFinalText(s)).toContain("ORCHID-77");
  });

  it("handles chunks split mid-line", () => {
    const s = newAgyStreamState();
    for (let i = 0; i < REAL_STDOUT.length; i += 17) feedAgyStream(s, REAL_STDOUT.slice(i, i + 17));
    expect(s.completedReply).toContain("ORCHID-77");
    expect(s.resultResponse).toContain("ORCHID-77");
  });

  it("a step without the closing tag is not treated as a finished reply", () => {
    const s = newAgyStreamState();
    feedAgyStream(s, '{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"Let me think"}}\n');
    expect(s.completedReply).toBeNull();
  });

  it("surfaces result.error so quota detection still sees it", () => {
    const s = newAgyStreamState();
    feedAgyStream(s, '{"event":"result","result":{"status":"ERROR","response":"","error":"RESOURCE_EXHAUSTED: quota"}}\n');
    expect(s.resultError).toContain("RESOURCE_EXHAUSTED");
    expect(agyStreamFinalText(s)).toBe("");
  });

  it("router uses the inline stdin path for sandboxed reply agents (regression guard)", () => {
    const src = readFileSync(resolve(__dirname, "../channels/router.ts"), "utf-8");
    expect(src).toMatch(/const inlineStdin = sandboxed && !mediaDirective;/);
    expect(src).toMatch(/feedAgyStream\(streamState/);
    expect(src).toMatch(/child\.kill\('SIGTERM'\)/);
  });
});
