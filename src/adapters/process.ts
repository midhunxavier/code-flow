import { execFile, spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { isAbsolute, join } from "node:path";
import { CODEFLOW_HOME, timerMs } from "../config.js";
import { childEnv } from "../env.js";
import type { ErrorKind } from "./types.js";
import { agentContainerLaunch, isAgentContainerName, stopAgentContainer, stopAgentContainerSync, type AgentContainer } from "../agent-container.js";

export interface JsonlProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Stop the CLI (`stalled`) when it prints nothing, on stdout or stderr, for this long. */
  idleTimeoutMs?: number;
  /** Host-owned human/tool-resource wait; excludes waiting time from watchdogs. */
  isPaused?: () => boolean;
  /** After `resultSeen()`: how long the CLI gets to exit before it's stopped. Default 10 s. */
  resultGraceMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed. Prompts go here, not argv (Linux caps one arg at 128 KB). */
  input?: string;
  /** Keep stdin open for `send` (a CLI that serves JSON-RPC on stdio) instead of closing it. */
  interactive?: boolean;
  agentContainer?: { config: AgentContainer; mode: "read" | "write"; readOnly?: string[] };
  /** Called for every stdout line that parses as JSON. */
  onJson: (obj: any) => void;
  /** Called for stdout lines that are not JSON. */
  onText?: (line: string) => void;
}

export interface ProcessOutcome {
  exitCode: number | null;
  /** The process failed to start, rather than returning an exit code. */
  spawnError?: { code?: string; message: string; command: string };
  stderr: string;
  aborted: boolean;
  abortReason?: "shutdown";
  timedOut: boolean;
  /** Stopped for printing nothing for `idleMs`. */
  stalled: boolean;
  idleMs?: number;
  /** The adapter saw the CLI's final result (`resultSeen`); how the process ended after that doesn't matter. */
  resultSeen: boolean;
  /** It was still running `resultGraceMs` after its result, and was stopped. */
  killedAfterResult: boolean;
}

const DEFAULT_TIMEOUT = 30 * 60_000;
/** After the CLI exits, how long its output pipes may stay open (held by leftover children). */
const DRAIN_MS = 3_000;
/**
 * After its final result, how long a CLI gets to exit. A hook or MCP server that hangs on
 * shutdown mustn't turn a finished turn into a timeout.
 */
const RESULT_GRACE_MS = 10_000;
/** A longer stdout line is dropped, not buffered: one runaway tool output can't exhaust memory. */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

interface GroupRecord {
  pid: number;
  /** When code-flow started it (ms since epoch): tells it apart from a later process that got the same pid. */
  startedAt: number;
  containerName?: string;
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
  const pending = liveGroups.size + dyingGroups.size > 0;
  for (const record of [...liveGroups.values(), ...dyingGroups.values()]) if (record.containerName) stopAgentContainerSync(record.containerName);
  for (const pid of [...liveGroups.keys(), ...dyingGroups.keys()]) signalGroup(pid, "SIGKILL");
  liveGroups.clear();
  dyingGroups.clear();
  if (pending) persistGroups();
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

export function trackGroup(pid: number | undefined, containerName?: string) {
  if (!pid) return;
  liveGroups.set(pid, { pid, startedAt: Date.now(), ...(containerName ? { containerName } : {}) });
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

/** Signal 0 to a pid (or, negative, a process group): true when it exists and is ours to signal. */
function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Whether the group recorded as `g` is still the one code-flow started. */
async function isOurGroup(g: GroupRecord): Promise<boolean> {
  if (!exists(-g.pid)) return false;
  // The leader is gone but its group lives on: a group id isn't reused while the group has
  // members, so these are what code-flow's process left behind.
  if (!exists(g.pid)) return true;
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
      if (isAgentContainerName(g.containerName)) await stopAgentContainer(g.containerName);
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
  const record = liveGroups.get(pid) ?? { pid, startedAt: Date.now() };
  dyingGroups.set(pid, record);
  if (record.containerName) {
    void stopAgentContainer(record.containerName);
    // Cancellation can race daemon-side creation after the client was killed.
    setTimeout(() => void stopAgentContainer(record.containerName!), 300).unref();
  }
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
  /**
   * The CLI reported its final result: the timeout and stall timers stop, and if it hasn't
   * exited within `resultGraceMs`, it's stopped and the outcome resolves anyway.
   */
  resultSeen(): void;
  /** Pause only the idle watchdog while an explicit user decision is pending. */
  pauseIdle(paused: boolean): void;
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
  const container = opts.agentContainer ? agentContainerLaunch(opts.command, opts.args, opts.cwd, opts.agentContainer.mode, opts.agentContainer.config, opts.agentContainer.readOnly) : undefined;
  const child = spawn(container?.command ?? opts.command, container?.args ?? opts.args, {
    cwd: opts.cwd,
    env: opts.env ?? childEnv(),
    detached: true,
    stdio: [piped ? "pipe" : "ignore", "pipe", "pipe"],
  });
  trackGroup(child.pid, container?.name);
  child.stdin?.on("error", () => {}); // the CLI may exit before reading everything
  if (opts.input !== undefined && !opts.interactive) child.stdin?.end(opts.input);

  let markResult = () => {};
  let pauseIdle = (_paused: boolean) => {};

  const outcome = new Promise<ProcessOutcome>((resolve) => {
    let stderr = "";
    let spawnError: ProcessOutcome["spawnError"];
    let aborted = false;
    let timedOut = false;
    let stalled = false;
    let resultSeen = false;
    let killedAfterResult = false;
    let settled = false;

    const kill = () => killGroup(child.pid);

    const onAbort = () => {
      aborted = true;
      kill();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();

    let remaining = timerMs(validMs(opts.timeoutMs) ?? DEFAULT_TIMEOUT), lastTick = Date.now();
    let timer: NodeJS.Timeout;
    const tick = () => {
      const now = Date.now(); if (!opts.isPaused?.()) remaining -= now - lastTick; lastTick = now;
      if (remaining <= 0) { timedOut = true; kill(); return; }
      timer = setTimeout(tick, Math.min(1000, remaining)); timer.unref();
    };
    timer = setTimeout(tick, Math.min(1000, remaining)); timer.unref();

    // Any output at all, a partial line or stderr included, is a sign of life.
    const idleMs = validMs(opts.idleTimeoutMs);
    let idle: NodeJS.Timeout | undefined;
    let idlePaused = false;
    const alive = () => {
      if (idleMs === undefined || resultSeen || settled || idlePaused) return;
      clearTimeout(idle);
      idle = setTimeout(() => {
        if (opts.isPaused?.()) { alive(); return; }
        stalled = true;
        kill();
      }, timerMs(idleMs));
      idle.unref();
    };
    pauseIdle = (paused) => {
      idlePaused = paused;
      clearTimeout(idle);
      if (!paused) alive();
    };
    alive();

    let grace: NodeJS.Timeout | undefined;
    markResult = () => {
      if (resultSeen || settled) return;
      resultSeen = true;
      clearTimeout(timer);
      clearTimeout(idle);
      grace = setTimeout(() => {
        // Still running after its result: stop it, and don't wait for it to go.
        killedAfterResult = true;
        killGroup(child.pid, 1_000);
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null);
      }, timerMs(validMs(opts.resultGraceMs) ?? RESULT_GRACE_MS));
      grace.unref();
    };

    const handleLine = (line: string) => {
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
    };
    const lines = lineSplitter(MAX_LINE_BYTES, handleLine, (bytes) =>
      opts.onText?.(`[code-flow skipped a ${Math.round(bytes / 1024 / 1024)} MB line of ${opts.command} output: lines over ${MAX_LINE_BYTES / 1024 / 1024} MB aren't read]`),
    );
    child.stdout!.on("data", (chunk: Buffer) => {
      alive();
      if (!settled) lines.push(chunk);
    });
    child.stdout!.on("end", () => {
      if (!settled) lines.end();
    });

    // Decoded as a stream, so a UTF-8 character split across two chunks isn't garbled.
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      alive();
      stderr += chunk;
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
    });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      lines.end();
      settled = true;
      clearTimeout(timer);
      clearTimeout(idle);
      clearTimeout(grace);
      untrackGroup(child.pid);
      opts.signal?.removeEventListener("abort", onAbort);
      const outcome = { exitCode, ...(spawnError ? { spawnError } : {}), stderr, aborted, ...(aborted && opts.signal?.reason === "codeflow-shutdown" ? { abortReason: "shutdown" as const } : {}), timedOut, stalled, idleMs: stalled ? idleMs : undefined, resultSeen, killedAfterResult };
      if (container) {
        void (async () => {
          await stopAgentContainer(container.name);
          if (aborted || timedOut || stalled || exitCode !== 0) {
            await new Promise((done) => setTimeout(done, 300));
            await stopAgentContainer(container.name);
          }
          resolve(outcome);
        })();
      } else resolve(outcome);
    };

    child.on("error", (err) => {
      spawnError = { code: (err as NodeJS.ErrnoException).code, message: err.message, command: opts.command };
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
    resultSeen: () => markResult(),
    pauseIdle: (paused) => pauseIdle(paused),
    outcome,
  };
}

/** A positive, finite number of milliseconds, else undefined (a NaN delay would fire at once). */
function validMs(ms: number | undefined): number | undefined {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/**
 * Splits a byte stream into lines at "\n" (a byte that never occurs inside a UTF-8 character),
 * holding at most `maxBytes` of one line: a longer line is dropped and reported, never buffered.
 */
export function lineSplitter(maxBytes: number, onLine: (line: string) => void, onDropped: (bytes: number) => void) {
  let parts: Buffer[] = [];
  let size = 0;
  /** Bytes of the current line thrown away so far; 0 while it still fits. */
  let dropped = 0;
  let ended = false;
  const emit = () => {
    if (dropped) onDropped(dropped);
    else if (size) onLine(Buffer.concat(parts, size).toString("utf8"));
    parts = [];
    size = 0;
    dropped = 0;
  };
  return {
    push(chunk: Buffer) {
      if (ended) return;
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(10, start);
        const piece = chunk.subarray(start, nl === -1 ? chunk.length : nl);
        if (dropped) dropped += piece.length;
        else if (size + piece.length > maxBytes) {
          dropped = size + piece.length;
          parts = [];
          size = 0;
        } else if (piece.length) {
          parts.push(piece);
          size += piece.length;
        }
        if (nl === -1) return;
        emit();
        start = nl + 1;
      }
    },
    /** The stream ended: a last line without a newline still counts. */
    end() {
      if (ended) return;
      ended = true;
      emit();
    },
  };
}

/** Run a short command and return its stdout (used for model listings). */
export function captureOutput(command: string, args: string[], timeoutMs = 30_000): Promise<string> {
  if (args.includes("--help")) return captureHelp(command, args, timeoutMs);
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: childEnv() }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${command} ${args.join(" ")} failed: ${stderr.toString().trim() || err.message}`));
      else resolve(stdout.toString());
    });
  });
}

/** Some vendor CLIs exit before flushing pipe stdout; a private regular file preserves full help. */
async function captureHelp(command: string, args: string[], timeoutMs: number): Promise<string> {
  const fs = await import("node:fs/promises");
  const dir = await fs.mkdtemp(join((await import("node:os")).tmpdir(), "codeflow-cli-help-"));
  const path = join(dir, "help.txt");
  const file = await fs.open(path, "wx", 0o600);
  try {
    await new Promise<void>((resolve,reject)=> {
      const child=spawn(command,args,{env:childEnv(),stdio:["ignore",file.fd,file.fd],timeout:timeoutMs,killSignal:"SIGKILL"});
      child.on("error",reject);child.on("close",code=>code===0?resolve():reject(new Error(`${command} help failed: process stopped (${code})`)));
    });
    if ((await file.stat()).size>2_000_000) throw new Error("CLI help exceeds limit");
    return await fs.readFile(path,"utf8");
  } finally { await file.close();await fs.rm(dir,{recursive:true,force:true}); }
}

export async function commandExists(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    // On the PATH the CLI will actually get (childEnv), so "installed" means it can be started.
    const child = spawn("which", [binary], { stdio: "ignore", env: childEnv() });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/** What the Docker client says when it can't reach its daemon (stopped, or no access to it). */
export const DOCKER_UNREACHABLE = /Cannot connect to the Docker daemon|Is the docker daemon running\?|permission denied while trying to connect to the Docker daemon|^(?:docker: )?error during connect\b/im;

/**
 * Whether Docker can run a container here: its CLI is on the PATH commands get (`missing`), and
 * its daemon answers (`running`). `unreachable` only when the client says it can't reach the
 * daemon, with the line that says so; a probe that fails some other way (slow to answer, an
 * unusual client) is `unknown`, and the container run itself then says what's wrong.
 */
export function dockerStatus(): Promise<{ state: "running" | "unreachable" | "missing" | "unknown"; detail?: string }> {
  return new Promise((resolve) => {
    execFile("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 5_000, maxBuffer: 64 * 1024, env: childEnv() }, (error, stdout, stderr) => {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return resolve({ state: "missing" });
      const unreachable = `${stdout}\n${stderr}`.split("\n").map((line) => line.trim()).find((line) => DOCKER_UNREACHABLE.test(line));
      if (unreachable) return resolve({ state: "unreachable", detail: unreachable.slice(0, 200) });
      resolve({ state: !error && /^\d+\.\d+/.test(String(stdout).trim()) ? "running" : "unknown" });
    });
  });
}

export function describeFailure(name: string, outcome: ProcessOutcome): string {
  if (outcome.aborted) return outcome.abortReason === "shutdown" ? `${name} was interrupted because Code Flow shut down. Resume to continue.` : `${name} was cancelled`;
  if (outcome.timedOut) return `${name} timed out`;
  if (outcome.stalled) return `${name} printed nothing for ${duration(outcome.idleMs ?? 0)} and was stopped (stalled)`;
  if (outcome.spawnError) {
    const { code, command, message } = outcome.spawnError;
    if (code === "ENOENT") return isAbsolute(command) ? `${name} could not start: the executable was not found at ${command}. Choose its installed path.` : `${name} could not start: ${command} was not found on this computer's PATH. Install it or enter its absolute path.`;
    if (code === "EACCES") return `${name} could not start: ${command} is not executable. Check its permissions or choose the CLI's executable.`;
    return `${name} could not start: ${message}`;
  }
  const tail = stderrTail(outcome);
  return `${name} exited with code ${outcome.exitCode}${tail ? `: ${tail}` : ""}`;
}

/** What ended the process when code-flow ended it: that says more than anything it printed. */
export function processErrorKind(outcome: ProcessOutcome): ErrorKind | undefined {
  if (outcome.aborted) return "cancelled";
  if (outcome.timedOut) return "timeout";
  if (outcome.stalled) return "stalled";
  if (outcome.spawnError) return "cli_incompatible";
  return undefined;
}

/** The last `lines` lines of what the CLI wrote to stderr. */
export function stderrTail(outcome: ProcessOutcome, lines = 5): string {
  return outcome.stderr.trim().split("\n").slice(-lines).join("\n");
}

/**
 * Event and item types a CLI printed that its adapter doesn't know, over one turn. Adapters
 * skip what they don't recognise, so a CLI update that renames an event (the agent's answer, a
 * tool call) would otherwise only show as a turn with something missing. `report` gives one
 * status line per turn naming them, or nothing when every event was known.
 */
export function unknownEvents(cli: string) {
  const counts = new Map<string, number>();
  let total = 0;
  return {
    add(type: unknown) {
      const name = typeof type === "string" && type.trim() ? type.trim().slice(0, 60) : "(no type)";
      total++;
      if (counts.has(name) || counts.size < 20) counts.set(name, (counts.get(name) ?? 0) + 1);
    },
    get count() {
      return total;
    },
    /** The status line for the turn (once: later calls return undefined). */
    report(): string | undefined {
      if (!total) return undefined;
      const names = [...counts.entries()].map(([name, n]) => (n > 1 ? `${name} (${n})` : name)).join(", ");
      const line = `${cli} emitted ${total} event${total === 1 ? "" : "s"} code-flow doesn't know: ${names}. If this turn's output looks incomplete, the CLI's format may have changed: update code-flow.`;
      total = 0;
      counts.clear();
      return line;
    },
  };
}

function duration(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`;
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
