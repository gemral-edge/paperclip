import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { configureDiagnosticReport } from "../services/diagnostic-report.js";

const require = createRequire(import.meta.url);

describe("diagnostic-report (GEM-2737)", () => {
  it("enables reportOnFatalError, creates directory with spaces, and preserves existing directory", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pc-diag-report-"));
    try {
      const targetDir = path.join(tmpRoot, "crash reports");
      const mockApi = { reportOnFatalError: false, directory: "" };
      const res1 = configureDiagnosticReport({ directory: targetDir, reportApi: mockApi });
      expect(res1.enabled).toBe(true);
      expect(res1.directory).toBe(targetDir);
      expect(fs.existsSync(targetDir)).toBe(true);

      const presetApi = { reportOnFatalError: false, directory: "C:/preset/dir" };
      const res2 = configureDiagnosticReport({ reportApi: presetApi });
      expect(res2.enabled).toBe(true);
      expect(res2.directory).toBe("C:/preset/dir");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("writes a real Node diagnostic report JSON containing nativeStack and javascriptStack", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pc-diag-write-"));
    try {
      const reportFile = path.join(tmpRoot, "test-report.json");
      const written = process.report.writeReport(reportFile);
      expect(written).toBe(reportFile);
      const parsed = JSON.parse(fs.readFileSync(reportFile, "utf8")) as Record<string, unknown>;
      expect(parsed).toHaveProperty("nativeStack");
      expect(parsed).toHaveProperty("javascriptStack");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("keeps ecosystem.config.cjs synced with 2G restart limit and POSIX NODE_OPTIONS", () => {
    const ecoPath = path.resolve(__dirname, "../../ecosystem.config.cjs");
    const eco = require(ecoPath) as {
      apps: Array<{ name: string; max_memory_restart: string; env: Record<string, string> }>;
    };
    const app = eco.apps.find((a) => a.name === "paperclip-server");
    expect(app).toBeDefined();
    expect(app?.max_memory_restart).toBe("2G");
    const nodeOpts = app?.env?.NODE_OPTIONS ?? "";
    expect(nodeOpts).toContain("--max-old-space-size=4096");
    expect(nodeOpts).toContain("--report-on-fatalerror");
    expect(nodeOpts).toContain("--report-directory=");
    expect(nodeOpts).not.toContain("\\");
  });
});
