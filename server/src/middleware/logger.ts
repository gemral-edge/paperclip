import path from "node:path";
import fs from "node:fs";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { readConfigFile } from "../config-file.js";
import {
  resolveDefaultLogsDir,
  resolveHomeAwarePath,
  resolvePaperclipHomeDir,
} from "../home-paths.js";

function resolveServerLogDir(): string {
  const envOverride = process.env.PAPERCLIP_LOG_DIR?.trim();
  if (envOverride) return resolveHomeAwarePath(envOverride);

  const fileLogDir = readConfigFile()?.logging.logDir?.trim();
  if (fileLogDir) return resolveHomeAwarePath(fileLogDir);

  return resolveDefaultLogsDir();
}

export function resolvePrimaryServerLogFile(): string {
  const envFile =
    process.env.PAPERCLIP_SERVER_LOG_FILE?.trim() ||
    process.env.pm_out_log_path?.trim();
  if (envFile) return resolveHomeAwarePath(envFile);
  return path.join(resolvePaperclipHomeDir(), "logs", "server.log");
}

const logDir = resolveServerLogDir();
fs.mkdirSync(logDir, { recursive: true });

export const logFile = path.join(logDir, "server.log");
export const primaryLogFile = resolvePrimaryServerLogFile();
fs.mkdirSync(path.dirname(primaryLogFile), { recursive: true });

const sharedOpts = {
  translateTime: "HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

export interface PinoTransportBuildOptions {
  primaryLogFile?: string;
  debugLogFile?: string;
  logToStdout?: boolean;
}

/**
 * Build pino transport targets.
 * On Windows under PM2, writing to stdout (fd 1) pushes bytes into an anonymous
 * 64 KB pipe owned by PM2's Daemon.js. If Daemon.js wedges (e.g. wmic/pidusage
 * stall), the pipe fills and blocks the Node.js event loop mid-transaction.
 * Therefore Target 1 writes directly to primaryLogFile (~/.paperclip/logs/server.log)
 * unless PAPERCLIP_LOG_STDOUT=true is explicitly set.
 */
export function buildPinoTransportTargets(opts: PinoTransportBuildOptions = {}) {
  const primaryDest = opts.primaryLogFile ?? primaryLogFile;
  const debugDest = opts.debugLogFile ?? logFile;
  const logToStdout =
    opts.logToStdout ?? process.env.PAPERCLIP_LOG_STDOUT === "true";

  const primaryDestination: string | number = logToStdout ? 1 : primaryDest;
  const sameFileTarget =
    !logToStdout && path.resolve(primaryDest) === path.resolve(debugDest);

  const targets: Array<{
    target: string;
    options: Record<string, unknown>;
    level: string;
  }> = [
    {
      target: "pino-pretty",
      options: {
        ...sharedOpts,
        ignore: "pid,hostname,req,res,responseTime",
        colorize: true,
        destination: primaryDestination,
        ...(typeof primaryDestination === "string" ? { mkdir: true } : {}),
      },
      level: "info",
    },
  ];

  if (!sameFileTarget) {
    targets.push({
      target: "pino-pretty",
      options: {
        ...sharedOpts,
        colorize: false,
        destination: debugDest,
        mkdir: true,
      },
      level: "debug",
    });
  }

  return targets;
}

const STDIO_REDIRECTED_SYMBOL = Symbol.for("paperclip.stdioRedirectedToFile");

export function redirectStdioToServerLog(
  targetFile: string = primaryLogFile,
  streams: {
    stdout: Pick<NodeJS.WriteStream, "write">;
    stderr: Pick<NodeJS.WriteStream, "write">;
  } = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): { logStream: fs.WriteStream; restore: () => void } {
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  const logStream = fs.createWriteStream(targetFile, { flags: "a" });
  logStream.on("error", () => {
    // Ignore file stream errors so logging never crashes the server
  });

  const stdoutAny = streams.stdout as Record<symbol, unknown> & {
    write: typeof process.stdout.write;
  };
  const stderrAny = streams.stderr as Record<symbol, unknown> & {
    write: typeof process.stderr.write;
  };

  if (stdoutAny[STDIO_REDIRECTED_SYMBOL]) {
    return stdoutAny[STDIO_REDIRECTED_SYMBOL] as {
      logStream: fs.WriteStream;
      restore: () => void;
    };
  }

  const origStdoutWrite = streams.stdout.write.bind(streams.stdout);
  const origStderrWrite = streams.stderr.write.bind(streams.stderr);

  const writeToFile = ((
    chunk: Uint8Array | string,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => {
    if (typeof encodingOrCb === "function") {
      return logStream.write(chunk, encodingOrCb);
    }
    if (encodingOrCb !== undefined) {
      return logStream.write(chunk, encodingOrCb, cb);
    }
    return logStream.write(chunk, cb);
  }) as typeof process.stdout.write;

  streams.stdout.write = writeToFile;
  streams.stderr.write = writeToFile;

  const handle = {
    logStream,
    restore: () => {
      streams.stdout.write = origStdoutWrite;
      streams.stderr.write = origStderrWrite;
      delete stdoutAny[STDIO_REDIRECTED_SYMBOL];
      delete stderrAny[STDIO_REDIRECTED_SYMBOL];
      logStream.end();
    },
  };

  stdoutAny[STDIO_REDIRECTED_SYMBOL] = handle;
  stderrAny[STDIO_REDIRECTED_SYMBOL] = handle;
  return handle;
}

// ── Custom formatter for console output ──
// Replaces pino-pretty's default with cleaner, emoji-tagged format

const METHOD_STYLE: Record<string, string> = {
  POST:   "\x1b[1;33m POST \x1b[0m",   // bold yellow
  PATCH:  "\x1b[1;36m PATCH\x1b[0m",    // bold cyan
  PUT:    "\x1b[1;35m PUT  \x1b[0m",    // bold magenta
  DELETE: "\x1b[1;31m DEL  \x1b[0m",    // bold red
  GET:    "\x1b[2m GET  \x1b[0m",       // dim
};

function statusColor(code: number): string {
  if (code >= 500) return `\x1b[1;31m${code}\x1b[0m`;  // red
  if (code >= 400) return `\x1b[1;33m${code}\x1b[0m`;  // yellow
  if (code >= 300) return `\x1b[2m${code}\x1b[0m`;     // dim
  return `\x1b[32m${code}\x1b[0m`;                      // green
}

function shortUrl(url: string): string {
  // Strip long UUIDs and query params for readability
  return url
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '•••')
    .replace(/\?.*$/, (q) => q.length > 40 ? q.substring(0, 40) + '…' : q);
}

export const logger = pino(
  {
    level: "debug",
  },
  pino.transport({
    targets: buildPinoTransportTargets(),
  }),
);

export const httpLogger = pinoHttp({
  logger,
  autoLogging: {
    ignore(req) {
      // Skip GET requests — too noisy (polling, cache hits)
      return req.method === "GET";
    },
  },
  customLogLevel(_req, res, err) {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage(req, res) {
    const method = METHOD_STYLE[req.method || "GET"] || req.method;
    const status = statusColor(res.statusCode);
    const url = shortUrl(req.url || "");
    const time = (res as any).responseTime ? `${Math.round((res as any).responseTime)}ms` : "";
    return `${method} ${status} ${url} ${time}`.trim();
  },
  customErrorMessage(req, res, err) {
    const ctx = (res as any).__errorContext;
    const errMsg = ctx?.error?.message || err?.message || (res as any).err?.message || "unknown error";
    const method = METHOD_STYLE[req.method || "GET"] || req.method;
    const status = statusColor(res.statusCode);
    const url = shortUrl(req.url || "");
    return `${method} ${status} ${url} — ${errMsg}`;
  },
  customProps(req, res) {
    if (res.statusCode >= 400) {
      const ctx = (res as any).__errorContext;
      if (ctx) {
        return {
          errorContext: ctx.error,
          reqBody: ctx.reqBody,
          reqParams: ctx.reqParams,
          reqQuery: ctx.reqQuery,
        };
      }
      const props: Record<string, unknown> = {};
      const { body, params, query } = req as any;
      if (body && typeof body === "object" && Object.keys(body).length > 0) {
        props.reqBody = body;
      }
      if (params && typeof params === "object" && Object.keys(params).length > 0) {
        props.reqParams = params;
      }
      if (query && typeof query === "object" && Object.keys(query).length > 0) {
        props.reqQuery = query;
      }
      if ((req as any).route?.path) {
        props.routePath = (req as any).route.path;
      }
      return props;
    }
    return {};
  },
});
