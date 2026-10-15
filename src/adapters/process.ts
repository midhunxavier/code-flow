import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface JsonlProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Called for every stdout line that parses as JSON. */
  onJson: (obj: any) => void;
  /** Called for stdout lines that are not JSON. */
  onText?: (line: string) => void;
}

export interface ProcessOutcome {
  exitCode: number | null;
  stderr: string;
  aborted: boolean;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT = 30 * 60_000;

/**
 * Spawn a CLI with stdin closed and parse its stdout as JSON Lines.
 * stdin is closed on purpose: the CLIs otherwise wait for piped input.
 */
export function runJsonlProcess(opts: JsonlProcessOptions): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let aborted = false;
    let timedOut = false;
    let settled = false;

    const kill = () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 5_000).unref();
      }
    };

    const onAbort = () => {
      aborted = true;
      kill();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT);
    timer.unref();

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        opts.onText?.(trimmed);
        return;
      }
      try {
        opts.onJson(parsed);
      } catch (err) {
        opts.onText?.(`[adapter error] ${(err as Error).message}`);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
    });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode, stderr, aborted, timedOut });
    };

    child.on("error", (err) => {
      stderr += `\n${err.message}`;
      finish(null);
    });
    // "close" fires after stdout is drained, so every line has been handled.
    child.on("close", (code) => finish(code));
  });
}

/** Run a short command and return its stdout (used for model listings). */
export function captureOutput(command: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${command} ${args.join(" ")} failed: ${stderr.toString().trim() || err.message}`));
      else resolve(stdout.toString());
    });
  });
}

export async function commandExists(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("which", [binary], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

export function describeFailure(name: string, outcome: ProcessOutcome): string {
  if (outcome.aborted) return `${name} was cancelled`;
  if (outcome.timedOut) return `${name} timed out`;
  const tail = outcome.stderr.trim().split("\n").slice(-5).join("\n");
  return `${name} exited with code ${outcome.exitCode}${tail ? `: ${tail}` : ""}`;
}

export function truncate(text: string, max = 4_000): string {
  return text.length > max ? `${text.slice(0, max)}\n… [${text.length - max} more chars]` : text;
}

export function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
