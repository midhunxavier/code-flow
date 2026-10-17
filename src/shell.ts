import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { killGroup, trackGroup, untrackGroup } from "./adapters/process.js";
import { childEnv } from "./env.js";

/**
 * The side panel's Terminal: shells that stay open between commands (so `cd`, exported variables
 * and virtualenvs stick), their output streamed back. Two kinds:
 *
 * - Interactive (the usual one): your login shell in a pseudo-terminal, so pagers, prompts,
 *   colours and full-screen programs (vim, htop, less, git log) work. Keystrokes go in as typed
 *   and the output is the terminal's own, escape codes and all; the browser draws it with xterm.
 *   There's no native npm module behind it: scripts/pty.py (Python 3's standard library) opens
 *   the pseudo-terminal and relays its bytes, with a control channel for the window size and
 *   for what's in the foreground. It's *busy* while a program other than the shell is in the
 *   terminal's foreground (the terminal's foreground process group isn't the shell's own, as a
 *   terminal app checks before closing a window); a background job (`npm run dev &`) or a
 *   builtin the shell runs itself (`read`) doesn't count.
 * - Line-based, when there's no python3: the shell is fed commands through a pipe, so pagers and
 *   full-screen programs don't work and colours are turned off. After every command the shell
 *   prints a marker with the exit code and the current folder, which becomes a `done` event (the
 *   prompt, in effect); it's busy from a command until its marker.
 */

export interface ShellInfo {
  id: string;
  cwd: string;
  /** The shell program running the commands. */
  shell: string;
  status: "running" | "exited";
  exitCode?: number | null;
  startedAt: number;
  /** Something is running: a command whose marker hasn't come back, or a program in the terminal's foreground. */
  busy: boolean;
  /** A real terminal (keystrokes in, escape codes out); false: the line-based shell. */
  interactive: boolean;
  /** Interactive: the terminal's size, in characters. */
  cols?: number;
  rows?: number;
  /** Interactive: the program in the foreground while busy ("vim", "less"). */
  running?: string;
}

export type ShellEvent =
  | { type: "input"; text: string }
  | { type: "output"; text: string }
  | { type: "done"; code: number; cwd: string }
  | { type: "busy"; busy: boolean; running?: string }
  | { type: "exit"; code: number | null };

const MARK = "\u001e";
const MARKER = new RegExp(`${MARK}(\\d+)${MARK}([^${MARK}]*)${MARK}\\n?`);
/** How much of a shell's output is kept for a client that (re)connects. */
const HISTORY_BYTES = 256 * 1024;
export const MAX_SHELLS = 12;
const PTY_SCRIPT = fileURLToPath(new URL("../scripts/pty.py", import.meta.url));
/** An interactive shell's helper hangs up its terminal within about a second; then it's killed. */
const PTY_CLOSE_MS = 3_000;
const clamp = (n: unknown, lo: number, hi: number, fallback: number) => (Number.isFinite(Number(n)) ? Math.min(hi, Math.max(lo, Math.round(Number(n)))) : fallback);

/** Every shell is busy and there's no room for another. */
export class ShellLimitError extends Error {}

interface Shell extends ShellInfo {
  child: ChildProcess;
  history: ShellEvent[];
  historyBytes: number;
  /** The oldest output was dropped: the first entry may start in the middle of a line. */
  trimmed: boolean;
  pending: string;
  clients: Set<(e: ShellEvent) => void>;
  /** Interactive: the shell's pid in the terminal (its process group too), once the helper says. */
  pid?: number;
  /** Interactive: the terminal's foreground process group. */
  fg?: number | null;
  decoder?: TextDecoder;
}

/** Your login shell when it's a Bourne-style one (the marker is `printf` and `$?`), else sh. */
export function shellProgram(env = process.env): string {
  const own = env.SHELL ?? "";
  if (["bash", "zsh", "sh", "dash", "ksh"].includes(basename(own)) && existsSync(own)) return own;
  return existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

/** For a real terminal any login shell will do (fish too): nothing is parsed from its output. */
function loginShell(env = process.env): string {
  const own = env.SHELL ?? "";
  return own.startsWith("/") && existsSync(own) ? own : shellProgram(env);
}

const probes = new Map<string, Promise<boolean>>();
/** Whether `python` can run scripts/pty.py: Python 3 with its pty, termios and fcntl modules. Checked once. */
export function ptyAvailable(python = defaultPython()): Promise<boolean> {
  if (process.platform === "win32") return Promise.resolve(false);
  let probe = probes.get(python);
  if (!probe) {
    probe = new Promise((resolve) => {
      execFile(python, ["-I", "-c", "import sys, pty, termios, fcntl, select; sys.exit(sys.version_info < (3, 6))"], { timeout: 10_000, env: childEnv() }, (err) => resolve(!err));
    });
    probes.set(python, probe);
  }
  return probe;
}

function defaultPython(): string {
  return process.env.CODEFLOW_PYTHON || "python3";
}

export class Shells {
  private readonly shells = new Map<string, Shell>();
  private readonly python: string;

  constructor(opts: { python?: string } = {}) {
    this.python = opts.python ?? defaultPython();
  }

  /** Whether new terminals can be interactive (python3 is there to run the pseudo-terminal). */
  interactive(): Promise<boolean> {
    return ptyAvailable(this.python);
  }

  list(): ShellInfo[] {
    return [...this.shells.values()].map(describe);
  }

  get(id: string): ShellInfo | undefined {
    const s = this.shells.get(id);
    return s && describe(s);
  }

  /** What a client needs to catch up: the kept output, in order. */
  history(id: string): ShellEvent[] {
    const s = this.shells.get(id);
    if (!s) return [];
    const events = [...s.history];
    // A terminal's output cut at an arbitrary byte can start inside an escape sequence: start
    // the replay at the next line instead.
    const first = events[0];
    if (s.interactive && s.trimmed && first?.type === "output") {
      const nl = first.text.indexOf("\n");
      events[0] = { type: "output", text: nl < 0 ? "" : first.text.slice(nl + 1) };
    }
    return events;
  }

  /**
   * A new shell in `cwd`. `pty` asks for a real terminal of `cols` × `rows`; without python3 it's
   * a line-based one (`interactive: false`).
   */
  async open(cwd: string, opts: { pty?: boolean; cols?: number; rows?: number } = {}): Promise<ShellInfo> {
    const pty = !!opts.pty && (await this.interactive());
    if (this.shells.size >= MAX_SHELLS) {
      // Make room with a shell that's done, else the oldest one waiting for a command; never one
      // that's running something.
      const byAge = [...this.shells.values()].sort((a, b) => a.startedAt - b.startedAt);
      const spare = byAge.find((s) => s.status === "exited") ?? byAge.find((s) => !s.busy);
      if (!spare) throw new ShellLimitError(`${MAX_SHELLS} terminals are open and each is running something: stop or close one first`);
      this.close(spare.id);
    }
    const id = `sh${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
    const shell = pty ? this.startPty(id, cwd, clamp(opts.cols, 2, 1000, 80), clamp(opts.rows, 1, 500, 24)) : this.startLines(id, cwd);
    shell.child.stdin?.on("error", () => {}); // it exited while a write was on its way: the exit event says so
    // An interactive shell's helper owns its pipes (the shell's programs have the terminal), so
    // wait for them to close: its last output comes before `exit`. A line-based shell's
    // background jobs can hold its pipes open, so there it's the process exiting.
    const ended = (code: number | null) => {
      if (shell.status === "exited") return;
      untrackGroup(shell.child.pid);
      untrackGroup(shell.pid);
      if (shell.pending) this.emit(shell, { type: "output", text: shell.pending });
      const rest = shell.decoder?.decode();
      if (rest) this.emit(shell, { type: "output", text: rest });
      shell.pending = "";
      shell.status = "exited";
      shell.exitCode = code;
      shell.busy = false;
      shell.running = undefined;
      this.emit(shell, { type: "exit", code });
    };
    shell.child.on(pty ? "close" : "exit", ended);
    // It never started (the program vanished since it was checked): nothing will exit.
    shell.child.on("error", () => shell.child.pid === undefined && ended(null));
    this.shells.set(id, shell);
    return describe(shell);
  }

  /** Send a command to a line-based shell. Its exit code and the folder it left the shell in come back as `done`. */
  write(id: string, text: string): boolean {
    const s = this.shells.get(id);
    if (!s || s.status !== "running" || !s.child.stdin?.writable) return false;
    if (s.interactive) return this.type(id, `${text.replace(/\r\n?|\n/g, "\r").replace(/\r$/, "")}\r`);
    const command = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
    this.emit(s, { type: "input", text: command });
    s.busy = true;
    // The marker is printed by the shell itself after the command, whatever the command did.
    s.child.stdin.write(`${command}\nprintf '\\036%s\\036%s\\036\\n' "$?" "$PWD"\n`);
    return true;
  }

  /** Keystrokes for an interactive shell, as typed (a paste, an escape sequence, Ctrl-C as \x03). */
  type(id: string, data: string): boolean {
    const s = this.shells.get(id);
    if (!s || !s.interactive || s.status !== "running" || !s.child.stdin?.writable) return false;
    s.child.stdin.write(Buffer.from(data, "utf8"));
    return true;
  }

  /** An interactive shell's window changed size: the programs in it get SIGWINCH. */
  resize(id: string, cols: number, rows: number): boolean {
    const s = this.shells.get(id);
    const control = s?.child.stdio[3] as Writable | null | undefined; // a socket: both ways
    if (!s || !s.interactive || s.status !== "running" || !control?.writable) return false;
    s.cols = clamp(cols, 2, 1000, s.cols ?? 80);
    s.rows = clamp(rows, 1, 500, s.rows ?? 24);
    control.write(`${JSON.stringify({ resize: [s.cols, s.rows] })}\n`);
    return true;
  }

  subscribe(id: string, client: (e: ShellEvent) => void): (() => void) | undefined {
    const s = this.shells.get(id);
    if (!s) return undefined;
    s.clients.add(client);
    return () => s.clients.delete(client);
  }

  close(id: string): boolean {
    const s = this.shells.get(id);
    if (!s) return false;
    if (s.status === "running") {
      if (s.interactive) {
        // As when a terminal window closes: the shell hangs up its jobs. The helper then hangs
        // up whatever is still in the shell's session and kills what ignores that.
        if (s.pid) signalGroup(s.pid, "SIGHUP");
        killGroup(s.child.pid, PTY_CLOSE_MS);
      } else killGroup(s.child.pid, 2_000);
    }
    untrackGroup(s.child.pid);
    this.shells.delete(id);
    return true;
  }

  closeAll() {
    for (const id of [...this.shells.keys()]) this.close(id);
  }

  private startLines(id: string, cwd: string): Shell {
    const program = shellProgram();
    const child = spawn(program, [], {
      cwd,
      detached: true, // its own group: closing the shell closes whatever it started
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv({ TERM: "dumb", NO_COLOR: "1", FORCE_COLOR: "0", PAGER: "cat", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }),
    });
    trackGroup(child.pid);
    const shell = newShell(id, cwd, program, child, false);
    child.stdout!.on("data", (chunk: Buffer) => this.onStdout(shell, chunk.toString()));
    child.stderr!.on("data", (chunk: Buffer) => this.emit(shell, { type: "output", text: chunk.toString() }));
    child.on("error", (err) => this.emit(shell, { type: "output", text: `Couldn't start ${program}: ${err.message}\n` }));
    return shell;
  }

  private startPty(id: string, cwd: string, cols: number, rows: number): Shell {
    const program = loginShell();
    const env = childEnv({ TERM: "xterm-256color", COLORTERM: "truecolor" });
    // A server started outside a terminal (launchd, systemd) may have no locale: the shell then
    // garbles anything that isn't ASCII.
    if (!env.LC_ALL && !env.LC_CTYPE && !env.LANG) env.LANG = process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
    // A login shell (argv[0] starting with "-"), as a terminal app opens: your PATH from .zprofile.
    const child = spawn(this.python, ["-I", PTY_SCRIPT, String(cols), String(rows), program, `-${basename(program)}`], {
      cwd,
      detached: true, // the helper's own group; the shell gets a session of its own in the terminal
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      env,
    });
    trackGroup(child.pid);
    const shell = newShell(id, cwd, program, child, true);
    shell.cols = cols;
    shell.rows = rows;
    shell.decoder = new TextDecoder("utf-8"); // a character split across two reads comes out whole
    child.stdout!.on("data", (chunk: Buffer) => {
      const text = shell.decoder!.decode(chunk, { stream: true });
      if (text) this.emit(shell, { type: "output", text });
    });
    // Only the helper itself writes here (the shell's stderr is the terminal): a Python error.
    child.stderr!.on("data", (chunk: Buffer) => this.emit(shell, { type: "output", text: chunk.toString().replace(/\r?\n/g, "\r\n") }));
    child.on("error", (err) => this.emit(shell, { type: "output", text: `Couldn't start the terminal (${this.python}): ${err.message}\r\n` }));
    let control = "";
    child.stdio[3]?.on("data", (chunk: Buffer) => {
      control += chunk.toString();
      const lines = control.split("\n");
      control = lines.pop()!;
      for (const line of lines) {
        let msg: { pid?: number; fg?: number | null };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof msg.pid === "number") {
          shell.pid = msg.pid;
          // The shell leads its own process group: if code-flow dies, the next start kills it too.
          if (shell.status === "running") trackGroup(msg.pid);
        }
        if ("fg" in msg) this.onForeground(shell, msg.fg ?? null);
      }
    });
    child.stdio[3]?.on("error", () => {});
    return shell;
  }

  /** The terminal's foreground changed: busy unless it's the shell itself; name what's running. */
  private onForeground(s: Shell, fg: number | null) {
    s.fg = fg;
    const busy = fg !== null && s.pid !== undefined && fg !== s.pid;
    if (busy === s.busy && !busy) return;
    s.busy = busy;
    s.running = undefined;
    this.emit(s, { type: "busy", busy });
    if (!busy) return;
    execFile("ps", ["-o", "comm=", "-p", String(fg)], { timeout: 5_000, env: { ...process.env, LC_ALL: "C" } }, (err, stdout) => {
      const name = basename(String(stdout).trim()).replace(/^-/, "");
      if (err || !name || s.fg !== fg || s.status !== "running") return;
      s.running = name;
      this.emit(s, { type: "busy", busy: true, running: name });
    });
  }

  private onStdout(s: Shell, chunk: string) {
    s.pending += chunk;
    for (;;) {
      const m = MARKER.exec(s.pending);
      if (!m) break;
      const before = s.pending.slice(0, m.index);
      if (before) this.emit(s, { type: "output", text: before });
      s.pending = s.pending.slice(m.index + m[0].length);
      s.busy = false;
      s.cwd = m[2] || s.cwd;
      this.emit(s, { type: "done", code: Number(m[1]), cwd: s.cwd });
    }
    // Everything before a marker that may still be arriving can go out now.
    const partial = s.pending.indexOf(MARK);
    const ready = partial < 0 ? s.pending : s.pending.slice(0, partial);
    if (ready) {
      this.emit(s, { type: "output", text: ready });
      s.pending = s.pending.slice(ready.length);
    }
  }

  private emit(s: Shell, event: ShellEvent) {
    if (event.type === "busy") {
      // A state change, not output: clients that connect later get it from `hello`.
      for (const client of s.clients) client(event);
      return;
    }
    const last = s.history.at(-1);
    // Output arrives in many small pieces: one entry per burst keeps the history short.
    if (event.type === "output" && last?.type === "output" && last.text.length < 8_192) last.text += event.text;
    else s.history.push(event.type === "output" ? { ...event } : event);
    s.historyBytes += event.type === "output" || event.type === "input" ? event.text.length : 16;
    while (s.historyBytes > HISTORY_BYTES && s.history.length > 1) {
      const dropped = s.history.shift()!;
      s.historyBytes -= dropped.type === "output" || dropped.type === "input" ? dropped.text.length : 16;
      s.trimmed = true;
    }
    for (const client of s.clients) client(event);
  }
}

function newShell(id: string, cwd: string, program: string, child: ChildProcess, interactive: boolean): Shell {
  return { id, cwd, shell: program, status: "running", startedAt: Date.now(), busy: false, interactive, child, history: [], historyBytes: 0, trimmed: false, pending: "", clients: new Set() };
}

function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
}

function describe(s: Shell): ShellInfo {
  return { id: s.id, cwd: s.cwd, shell: s.shell, status: s.status, exitCode: s.exitCode, startedAt: s.startedAt, busy: s.busy, interactive: s.interactive, cols: s.cols, rows: s.rows, running: s.running };
}
