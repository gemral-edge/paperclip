import fs from "node:fs";
import path from "node:path";
import { resolvePaperclipHomeDir } from "../home-paths.js";

export interface DiagnosticReportConfigResult {
  enabled: boolean;
  directory: string;
}

export function resolveDefaultCrashReportDir(): string {
  return path.join(resolvePaperclipHomeDir(), "logs", "crash-reports");
}

/**
 * GEM-2737: Ensure Node Diagnostic Report is enabled in-process as a second layer
 * alongside NODE_OPTIONS (--report-on-fatalerror --report-directory) so fatal native
 * errors (0xC0000409) capture nativeStack + javascriptStack whenever Node handles them.
 */
export function configureDiagnosticReport(opts?: {
  directory?: string;
  reportApi?: Pick<NodeJS.ProcessReport, "reportOnFatalError" | "directory">;
}): DiagnosticReportConfigResult {
  const reportApi = opts?.reportApi ?? process.report;
  const targetDir = (opts?.directory || reportApi?.directory || resolveDefaultCrashReportDir()).trim();

  try {
    fs.mkdirSync(targetDir, { recursive: true });
  } catch {
    // Non-fatal: directory may already exist or be created externally
  }

  if (reportApi) {
    reportApi.reportOnFatalError = true;
    if (!reportApi.directory) {
      reportApi.directory = targetDir;
    }
  }

  return {
    enabled: Boolean(reportApi?.reportOnFatalError),
    directory: reportApi?.directory || targetDir,
  };
}
