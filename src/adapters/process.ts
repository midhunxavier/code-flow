import { execFile, spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { CODEFLOW_HOME } from "../config.js";
import { childEnv } from "../env.js";

export interface JsonlProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed. Prompts go here, not argv (Linux caps one arg at 128 KB). */
  input?: string;
  /** Keep stdin open for `send` (a CLI that serves JSON-RPC on stdio) instead of closing it. */
  interactive?: boolean;
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

interface GroupRecord {
  pid: number;
  /** When code-flow started it (ms since epoch): tells it apart from a later process that got the same pid. */
  startedAt: number;
}

/**
 * Process groups code-flow started and hasn't seen finish (agent CLIs, checks, Run app, gh).
 * They're killed when code-flow exits, and also written to disk: after a crash, kill -9, or a
 * closed terminal, the next start kills what's left (`reapOrphanGroups`) before resuming
 * anything, so an orphaned agent can't keep editing a worktree a resumed run is using.
 */
const liveGroups = new Map<number, GroupRecord>();
/** Groups sent SIGTERM whose SIGKILL is still pending; killed outright if code-flow exits first. */
const dyingGroups = new Map<number, GroupRecord>();
const GROUPS_FILE = join(CODEFLOW_HOME, "processes.json");

process.once("exit", () => {
  for (const pid of [...liveGroups.keys(), ...dyingGroups.keys()]) signalGroup(pid, "SIGKILL");
  liveGroups.clear();
  dyingGroups.clear();
  persistGroups();
});

/** When this machine booted (ms since epoch); pids from before a reboot belong to someone else now. */
function bootTime(): number {
  return Date.now() - uptime() * 1000;
}

function persistGroups() {
  try {
    mkdirSync(CODEFLOW_HOME, { recursive: true });
    const groups = [...new Map([...dyingGroups, ...liveGroups]).values()];
    const tmp = `${GROUPS_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ server: process.pid, boot: Math.round(bootTime()), groups }));
    renameSync(tmp, GROUPS_FILE);
  } catch {
    // best effort: the in-memory list still covers a normal exit
  }
}

export function trackGroup(pid: number | undefined) {
  if (!pid) return;
  liveGroups.set(pid, { pid, startedAt: Date.now() });
  persistGroups();
}
export function untrackGroup(pid: number | undefined) {
  if (!pid || !liveGroups.delete(pid)) return;
  persistGroups();
}

function probe(command: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 10_000, env: { ...process.env, LC_ALL: "C" } }, (err, stdout) => {
      resolve({ code: err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0, stdout: String(stdout) });
    });
  });
}

/** Whether the group recorded as `g` is still the one code-flow started. */
async function isOurGroup(g: GroupRecord): Promise<boolean> {
  const members = (await probe("pgrep", ["-g", String(g.pid)])).stdout.split(/\s+/).filter(Boolean).map(Number);
  if (!members.length) return false;
  // The leader is gone but its group lives on: a group id isn't reused while the group has
  // members, so these are what code-flow's process left behind.
  if (!members.includes(g.pid)) return true;
  // The leader is alive: make sure it's the process code-flow started, not one that got its pid.
  const lstart = (await probe("ps", ["-o", "lstart=", "-p", String(g.pid)])).stdout.trim();
  const started = lstart ? Date.parse(lstart) : NaN;
  return Number.isFinite(started) && Math.abs(started - g.startedAt) < 5_000;
}

/**
 * Kill the process groups a previous code-flow left running (it crashed, was killed, or its
 * terminal closed). Call once at startup, before resuming or marking runs interrupted.
 * Returns how many groups were killed.
 */
export async function reapOrphanGroups(): Promise<number> {
  if (process.platform === "win32") return 0;
  let saved: { server?: number; boot?: number; groups?: GroupRecord[] } | undefined;
  try {
    saved = JSON.parse(readFileSync(GROUPS_FILE, "utf8"));
  } catch {
    return 0;
  }
  let killed = 0;
  const sameBoot = typeof saved?.boot === "number" && Math.abs(saved.boot - bootTime()) < 120_000;
  if (sameBoot && Array.isArray(saved?.groups)) {
    for (const g of saved!.groups) {
      if (!Number.isInteger(g?.pid) || g.pid <= 1 || g.pid === process.pid || liveGroups.has(g.pid)) continue;
      if (!(await isOurGroup(g))) continue;
      signalGroup(g.pid, "SIGKILL");
      killed++;
    }
  }
  persistGroups();
  return killed;
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
  if (dyingGroups.has(pid)) return; // a SIGKILL is already scheduled
  dyingGroups.set(pid, liveGroups.get(pid) ?? { pid, startedAt: Date.now() });
  persistGroups();
  setTimeout(() => {
    signalGroup(pid, "SIGKILL");
    dyingGroups.delete(pid);
    persistGroups();
  }, graceMs).unref();
}

/** A CLI started by `startJsonlProcess`. */
export interface JsonlProcess {
  /** Write one message as a JSON line on stdin (`interactive` only); false once stdin is closed. */
  send(message: unknown): boolean;
  /** Close stdin; a CLI serving requests on it exits when it sees EOF. */
  endInput(): void;
  /** Stop the CLI and everything it started. */
  kill(): void;
  readonly outcome: Promise<ProcessOutcome>;
}

/**
 * Spawn a CLI and parse its stdout as JSON Lines. stdin carries the prompt when given, stays open
 * for `send` when `interactive`, and is otherwise closed (the CLIs would wait for piped input).
 * The CLI runs in its own process group, so cancelling or timing out stops whatever it started
 * too, and a background process that keeps the output pipe open can't keep the step running
 * after the CLI has exited.
 */
export function runJsonlProcess(opts: JsonlProcessOptions): Promise<ProcessOutcome> {
  return startJsonlProcess(opts).outcome;
}

export function startJsonlProcess(opts: JsonlProcessOptions): JsonlProcess {
  const piped = opts.input !== undefined || !!opts.interactive;
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env ?? childEnv(),
    detached: true,
    stdio: [piped ? "pipe" : "ignore", "pipe", "pipe"],
  });
  trackGroup(child.pid);
  child.stdin?.on("error", () => {}); // the CLI may exit before reading everything
  if (opts.input !== undefined && !opts.interactive) child.stdin?.end(opts.input);

  const outcome = new Promise<ProcessOutcome>((resolve) => {
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

  return {
    send: (message) => {
      const stdin = child.stdin;
      if (!stdin || stdin.destroyed || stdin.writableEnded) return false;
      stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    },
    endInput: () => child.stdin?.end(),
    kill: () => killGroup(child.pid),
    outcome,
  };
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
