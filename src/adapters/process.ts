import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface JsonlProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed. Prompts go here, not argv (Linux caps one arg at 128 KB). */
  input?: string;
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
/** After the CLI exits, how long its output pipes may stay open (held by leftover children). */
const DRAIN_MS = 3_000;

/** Process groups code-flow started and hasn't seen finish; killed if code-flow itself exits. */
const liveGroups = new Set<number>();
process.once("exit", () => {
  for (const pid of liveGroups) signalGroup(pid, "SIGKILL");
});

export function trackGroup(pid: number | undefined) {
  if (pid) liveGroups.add(pid);
}
export function untrackGroup(pid: number | undefined) {
  if (pid) liveGroups.delete(pid);
}

function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch {
    // the group is already gone
  }
}

/**
 * Stop a process started with `detached: true` and everything it started (test runners, dev
 * servers an agent left in the background): SIGTERM to the whole group, SIGKILL after a grace
 * period for anything that ignores it.
 */
export function killGroup(pid: number | undefined, graceMs = 5_000) {
  if (!pid) return;
  signalGroup(pid, "SIGTERM");
  setTimeout(() => signalGroup(pid, "SIGKILL"), graceMs).unref();
}

/**
 * Spawn a CLI and parse its stdout as JSON Lines. stdin carries the prompt when given, and is
 * otherwise closed (the CLIs would wait for piped input). The CLI runs in its own process group,
 * so cancelling or timing out stops whatever it started too, and a background process that keeps
 * the output pipe open can't keep the step running after the CLI has exited.
 */
export function runJsonlProcess(opts: JsonlProcessOptions): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      detached: true,
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    trackGroup(child.pid);
    if (opts.input !== undefined) {
      child.stdin?.on("error", () => {}); // the CLI may exit before reading everything
      child.stdin?.end(opts.input);
    }

    let stderr = "";
    let aborted = false;
    let timedOut = false;
    let settled = false;

    const kill = () => killGroup(child.pid);

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

    const lines = createInterface({ input: child.stdout! });
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

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
    });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      untrackGroup(child.pid);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode, stderr, aborted, timedOut });
    };

    child.on("error", (err) => {
      stderr += `\n${err.message}`;
      finish(null);
    });
    // "close" fires after stdout is drained, so every line has been handled. Anything the CLI
    // left running is stopped when it exits; if that still holds the pipes open, stop waiting.
    child.on("exit", (code) => {
      killGroup(child.pid, 2_000);
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code);
      }, DRAIN_MS).unref();
    });
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
