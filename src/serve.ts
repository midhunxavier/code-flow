import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { platform } from "node:os";
import { killGroup, trackGroup, untrackGroup } from "./adapters/process.js";
import { childEnv } from "./env.js";

/**
 * "Run app": start a worktree's dev server on a free port so you can try a result before
 * merging it, plus "open in Terminal / editor / Finder" for a worktree.
 */

export interface DevServer {
  key: string;
  command: string;
  cwd: string;
  port: number;
  url: string;
  status: "running" | "exited";
  exitCode?: number | null;
  startedAt: number;
  logs: string[];
}

const MAX_LOG_LINES = 400;

export class DevServers {
  private readonly servers = new Map<string, DevServer & { child: ChildProcess }>();

  get(key: string): DevServer | undefined {
    const s = this.servers.get(key);
    if (!s) return undefined;
    const { child: _child, ...rest } = s;
    return { ...rest, logs: [...rest.logs] };
  }

  /** Every server, without their logs: what the side panel's Browser can open. */
  list(): Omit<DevServer, "logs">[] {
    return [...this.servers.values()].map(({ child: _child, logs: _logs, ...rest }) => ({ ...rest }));
  }

  async start(key: string, cwd: string, command: string, preferredPort?: number): Promise<DevServer> {
    this.stop(key);
    const port = await freePort(preferredPort);
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      detached: true, // own process group: stopping it stops whatever the command started
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...childEnv(), PORT: String(port), BROWSER: "none", FORCE_COLOR: "0" },
    });
    trackGroup(child.pid);
    const server = { key, command, cwd, port, url: `http://localhost:${port}`, status: "running" as const, startedAt: Date.now(), logs: [] as string[], child };
    const collect = (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (!line.trim()) continue;
        server.logs.push(line);
        if (server.logs.length > MAX_LOG_LINES) server.logs.shift();
      }
    };
    child.stdout!.on("data", collect);
    child.stderr!.on("data", collect);
    child.on("exit", (code) => {
      untrackGroup(child.pid);
      (server as DevServer).status = "exited";
      (server as DevServer).exitCode = code;
    });
    child.on("error", (err) => server.logs.push(`Failed to start: ${err.message}`));
    this.servers.set(key, server);
    return this.get(key)!;
  }

  stop(key: string) {
    const s = this.servers.get(key);
    if (!s) return false;
    // The whole group: whatever the command started (a bundler, a watcher) stops too.
    killGroup(s.child.pid);
    untrackGroup(s.child.pid);
    this.servers.delete(key);
    return true;
  }

  /** Stop every server whose key starts with `prefix` (e.g. one run's). */
  stopMatching(prefix: string) {
    for (const key of [...this.servers.keys()]) if (key.startsWith(prefix)) this.stop(key);
  }

  stopAll() {
    for (const key of [...this.servers.keys()]) this.stop(key);
  }
}

/** A free TCP port, preferring `preferred` (and the next few) when available. */
export async function freePort(preferred?: number): Promise<number> {
  const tryPort = (port: number) =>
    new Promise<number | null>((resolve) => {
      const srv = createServer();
      srv.once("error", () => resolve(null));
      srv.listen(port, "127.0.0.1", () => {
        const actual = (srv.address() as { port: number }).port;
        srv.close(() => resolve(actual));
      });
    });
  if (preferred) {
    for (let p = preferred; p < preferred + 20; p++) {
      const ok = await tryPort(p);
      if (ok) return ok;
    }
  }
  return (await tryPort(0))!;
}

export type OpenTarget = "terminal" | "editor" | "finder";

/** Open a folder in the user's terminal, editor, or file manager. */
export async function openFolder(path: string, target: OpenTarget): Promise<string> {
  const os = platform();
  if (target === "editor") {
    for (const cli of ["cursor", "code", "zed", "subl"]) {
      if (await has(cli)) {
        await run(cli, [path]);
        return cli;
      }
    }
    throw new Error("No editor command found (cursor, code, zed or subl on PATH)");
  }
  if (os === "darwin") {
    if (target === "terminal") await run("open", ["-a", "Terminal", path]);
    else await run("open", [path]);
    return target === "terminal" ? "Terminal" : "Finder";
  }
  if (target === "terminal") {
    for (const term of ["x-terminal-emulator", "gnome-terminal", "konsole"]) {
      if (await has(term)) {
        spawn(term, [], { cwd: path, detached: true, stdio: "ignore" }).unref();
        return term;
      }
    }
    throw new Error("No terminal emulator found");
  }
  await run("xdg-open", [path]);
  return "file manager";
}

const has = (cmd: string) => new Promise<boolean>((resolve) => execFile("which", [cmd], (err) => resolve(!err)));
const run = (cmd: string, args: string[]) =>
  new Promise<void>((resolve, reject) => execFile(cmd, args, (err) => (err ? reject(new Error(`${cmd} failed: ${err.message}`)) : resolve())));
