import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { CODEFLOW_HOME } from "./config.js";

/**
 * code-flow's own log, `~/.codeflow/server.log`: errors that would otherwise only reach the
 * terminal (or nowhere): failed requests, unhandled rejections, failed writes, reaped
 * processes. One line per entry, JSON, rotated to `server.log.1` past 5 MB.
 */
export const LOG_FILE = join(CODEFLOW_HOME, "server.log");
/** Keep phone capability paths out of request-failure logs, including encoded route names. */
export function requestLogPath(value: string): string {
  const path = value.split("?")[0] ?? "/";
  const parts = path.split("/");
  try { if (decodeURIComponent(parts[1] ?? "") === "r" && parts.length > 2) parts[2] = "[redacted]"; } catch { /* malformed paths have not been accepted as capabilities */ }
  return parts.join("/");
}
const MAX_BYTES = 5 * 1024 * 1024;
let writes = 0;

function write(level: "info" | "warn" | "error", message: string, detail?: Record<string, unknown>) {
  try {
    mkdirSync(CODEFLOW_HOME, { recursive: true });
    // Checking the size on every write would be a stat per line; every 50 is plenty.
    if (writes++ % 50 === 0) {
      const size = statSync(LOG_FILE, { throwIfNoEntry: false })?.size ?? 0;
      if (size > MAX_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
    appendFileSync(LOG_FILE, `${JSON.stringify({ at: new Date().toISOString(), level, message, ...detail })}\n`, { mode: 0o600 });
  } catch {
    // the log is best effort; never let it take the server down
  }
}

function describe(err: unknown): Record<string, unknown> {
  if (err instanceof Error) return { error: err.message, stack: err.stack?.split("\n").slice(0, 12).join("\n") };
  return { error: String(err) };
}

export function logInfo(message: string, detail?: Record<string, unknown>) {
  write("info", message, detail);
}

export function logWarn(message: string, detail?: Record<string, unknown>) {
  write("warn", message, detail);
}

/** Log an error to server.log and the terminal. */
export function logError(message: string, err?: unknown, detail?: Record<string, unknown>) {
  const info = err === undefined ? {} : describe(err);
  write("error", message, { ...info, ...detail });
  console.error(`code-flow: ${message}${info.error ? `: ${info.error}` : ""}`);
}
