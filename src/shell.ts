import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { killGroup, trackGroup, untrackGroup } from "./adapters/process.js";
import { childEnv } from "./env.js";

/**
 * The side panel's Terminal: a shell that stays open between commands (so `cd`, exported
 * variables and virtualenvs stick), fed through stdin, its output streamed back. There is no
 * pseudo-terminal behind it: programs see a pipe, so pagers and full-screen programs don't
 * work, and colours are turned off. After every command the shell prints a marker with the
 * exit code and the current folder, which becomes a `done` event (the prompt, in effect).
 */

export interface ShellInfo {
  id: string;
  cwd: string;
  /** The shell program running the commands. */
  shell: string;
  status: "running" | "exited";
  exitCode?: number | null;
  startedAt: number;
  /** A command was sent and no marker has come back yet. */
  busy: boolean;
}

export type ShellEvent =
  | { type: "input"; text: string }
  | { type: "output"; text: string }
  | { type: "done"; code: number; cwd: string }
  | { type: "exit"; code: number | null };

const MARK = "\u001e";
const MARKER = new RegExp(`${MARK}(\\d+)${MARK}([^${MARK}]*)${MARK}\\n?`);
/** How much of a shell's output is kept for a client that (re)connects. */
const HISTORY_BYTES = 256 * 1024;
export const MAX_SHELLS = 12;

/** Every shell is busy and there's no room for another. */
export class ShellLimitError extends Error {}

interface Shell extends ShellInfo {
  child: ChildProcess;
  history: ShellEvent[];
  historyBytes: number;
  pending: string;
  clients: Set<(e: ShellEvent) => void>;
}

/** Your login shell when it's a Bourne-style one (the marker is `printf` and `$?`), else sh. */
export function shellProgram(env = process.env): string {
  const own = env.SHELL ?? "";
  if (["bash", "zsh", "sh", "dash", "ksh"].includes(basename(own)) && existsSync(own)) return own;
  return existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

export class Shells {
  private readonly shells = new Map<string, Shell>();

  list(): ShellInfo[] {
    return [...this.shells.values()].map(describe);
  }

  get(id: string): ShellInfo | undefined {
    const s = this.shells.get(id);
    return s && describe(s);
  }

  /** What a client needs to catch up: the kept output, in order. */
  history(id: string): ShellEvent[] {
    return [...(this.shells.get(id)?.history ?? [])];
  }

  open(cwd: string): ShellInfo {
    if (this.shells.size >= MAX_SHELLS) {
      // Make room with a shell that's done, else the oldest one waiting for a command; never one
      // that's running something.
      const byAge = [...this.shells.values()].sort((a, b) => a.startedAt - b.startedAt);
      const spare = byAge.find((s) => s.status === "exited") ?? byAge.find((s) => !s.busy);
      if (!spare) throw new ShellLimitError(`${MAX_SHELLS} terminals are open and each is running something: stop or close one first`);
      this.close(spare.id);
    }
    const program = shellProgram();
    const child = spawn(program, [], {
      cwd,
      detached: true, // its own group: closing the shell closes whatever it started
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv({ TERM: "dumb", NO_COLOR: "1", FORCE_COLOR: "0", PAGER: "cat", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }),
    });
    trackGroup(child.pid);
    const id = `sh${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
    const shell: Shell = { id, cwd, shell: program, status: "running", startedAt: Date.now(), busy: false, child, history: [], historyBytes: 0, pending: "", clients: new Set() };
    child.stdout!.on("data", (chunk: Buffer) => this.onStdout(shell, chunk.toString()));
    child.stderr!.on("data", (chunk: Buffer) => this.emit(shell, { type: "output", text: chunk.toString() }));
    child.on("error", (err) => this.emit(shell, { type: "output", text: `Couldn't start ${program}: ${err.message}\n` }));
    child.on("exit", (code) => {
      untrackGroup(child.pid);
      if (shell.pending) this.emit(shell, { type: "output", text: shell.pending });
      shell.pending = "";
      shell.status = "exited";
      shell.exitCode = code;
      shell.busy = false;
      this.emit(shell, { type: "exit", code });
    });
    this.shells.set(id, shell);
    return describe(shell);
  }

  /** Send a command. Its exit code and the folder it left the shell in come back as `done`. */
  write(id: string, text: string): boolean {
    const s = this.shells.get(id);
    if (!s || s.status !== "running" || !s.child.stdin?.writable) return false;
    const command = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
    this.emit(s, { type: "input", text: command });
    s.busy = true;
    // The marker is printed by the shell itself after the command, whatever the command did.
    s.child.stdin.write(`${command}\nprintf '\\036%s\\036%s\\036\\n' "$?" "$PWD"\n`);
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
    if (s.status === "running") killGroup(s.child.pid, 2_000);
    untrackGroup(s.child.pid);
    this.shells.delete(id);
    return true;
  }

  closeAll() {
    for (const id of [...this.shells.keys()]) this.close(id);
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
    const last = s.history.at(-1);
    // Output arrives in many small pieces: one entry per burst keeps the history short.
    if (event.type === "output" && last?.type === "output" && last.text.length < 8_192) last.text += event.text;
    else s.history.push(event.type === "output" ? { ...event } : event);
    s.historyBytes += event.type === "output" || event.type === "input" ? event.text.length : 16;
    while (s.historyBytes > HISTORY_BYTES && s.history.length > 1) {
      const dropped = s.history.shift()!;
      s.historyBytes -= dropped.type === "output" || dropped.type === "input" ? dropped.text.length : 16;
    }
    for (const client of s.clients) client(event);
  }
}

function describe(s: Shell): ShellInfo {
  return { id: s.id, cwd: s.cwd, shell: s.shell, status: s.status, exitCode: s.exitCode, startedAt: s.startedAt, busy: s.busy };
}
