import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPinoTransportTargets,
  redirectStdioToServerLog,
  resolvePrimaryServerLogFile,
} from "../middleware/logger.js";

describe("logger file-only transport (Windows PM2 pipe backpressure protection)", () => {
  it("routes Target 1 to primaryLogFile instead of fd 1 by default", () => {
    const primary = path.join(os.tmpdir(), "paperclip-test-logs", "server.log");
    const debug = path.join(os.tmpdir(), "paperclip-test-logs", "debug", "server.log");

    const targets = buildPinoTransportTargets({
      primaryLogFile: primary,
      debugLogFile: debug,
      logToStdout: false,
    });

    expect(targets).toHaveLength(2);
    expect(targets[0]?.options.destination).toBe(primary);
    expect(targets[0]?.options.destination).not.toBe(1);
    expect(targets[0]?.options.mkdir).toBe(true);
    expect(targets[1]?.options.destination).toBe(debug);
  });

  it("deduplicates targets when primaryLogFile and debugLogFile are identical", () => {
    const sameFile = path.join(os.tmpdir(), "paperclip-test-same", "server.log");
    const targets = buildPinoTransportTargets({
      primaryLogFile: sameFile,
      debugLogFile: sameFile,
      logToStdout: false,
    });

    expect(targets).toHaveLength(1);
    expect(targets[0]?.options.destination).toBe(sameFile);
  });

  it("redirects stdout.write and stderr.write to file without touching original pipe writers", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-stdio-test-"));
    const targetFile = path.join(tmpDir, "server.log");

    const pipeStdoutChunks: string[] = [];
    const pipeStderrChunks: string[] = [];

    const fakeStdout = {
      write: ((chunk: Uint8Array | string) => {
        pipeStdoutChunks.push(String(chunk));
        return true;
      }) as typeof process.stdout.write,
    };
    const fakeStderr = {
      write: ((chunk: Uint8Array | string) => {
        pipeStderrChunks.push(String(chunk));
        return true;
      }) as typeof process.stderr.write,
    };

    const handle = redirectStdioToServerLog(targetFile, {
      stdout: fakeStdout,
      stderr: fakeStderr,
    });

    fakeStdout.write("[ZaloListener] Frame check\n");
    fakeStderr.write("[FollowUp] Error check\n");

    await new Promise<void>((resolve) => {
      handle.logStream.write("", () => resolve());
    });
    handle.restore();

    expect(pipeStdoutChunks).toHaveLength(0);
    expect(pipeStderrChunks).toHaveLength(0);

    const written = fs.readFileSync(targetFile, "utf8");
    expect(written).toContain("[ZaloListener] Frame check");
    expect(written).toContain("[FollowUp] Error check");
    expect(resolvePrimaryServerLogFile()).toMatch(/server\.log$/);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
