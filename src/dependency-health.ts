import { execFile } from "node:child_process";
import { doctor, checkGit, type HealthEntry, type GitHealth } from "./doctor.js";
import { childEnv } from "./env.js";
import { ptyAvailable, shellProgram } from "./shell.js";
import { findChrome } from "./snapshot.js";
import type { AgentId } from "./adapters/types.js";

export interface OptionalDependencyHealth {
  id: "terminal" | "snapshots" | "docker";
  name: string;
  installed: boolean;
  ready: boolean;
  path?: string;
  version?: string;
  detail: string;
  fix?: string;
}
export interface DependencyHealthReport { checkedAt: number; node: { version: string; ok: boolean }; git: GitHealth; providers: HealthEntry[]; optional: OptionalDependencyHealth[] }
const versionLine = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).find((line) => /\d+\.\d+/.test(line))?.slice(0, 160);
function capture(command: string, args: string[]) {
  return new Promise<{ ok: boolean; missing: boolean; stdout: string; stderr: string }>((resolve) => {
    execFile(command, args, { timeout: 5000, maxBuffer: 64 * 1024, env: childEnv() }, (error, stdout, stderr) => resolve({ ok: !error, missing: (error as NodeJS.ErrnoException | null)?.code === "ENOENT", stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
  });
}

/** Bounded, read-only process probes; no shells, installations, sign-ins or repository commands. */
export async function optionalDependencyHealth(options: { chrome?: string | null; python?: string; docker?: string } = {}): Promise<OptionalDependencyHealth[]> {
  const browser = options.chrome === undefined ? findChrome() : options.chrome;
  const [terminal, python, chrome, docker] = await Promise.all([
    ptyAvailable(options.python, { refresh: true }),
    capture(options.python ?? process.env.CODEFLOW_PYTHON ?? "python3", ["--version"]),
    browser ? capture(browser, ["--version"]) : undefined,
    capture(options.docker ?? "docker", ["--version"]),
  ]);
  const runtime = docker.ok ? await capture(options.docker ?? "docker", ["info", "--format", "{{.ServerVersion}}"] ) : undefined;
  const daemonReady = !!runtime?.ok && /^\d+\.\d+/.test(runtime.stdout.trim());
  return [
    { id: "terminal", name: "Interactive terminal", installed: !python.missing, ready: terminal, path: shellProgram(), version: versionLine(python.stdout || python.stderr), detail: terminal ? "Python 3 can load the pseudo-terminal modules; interactive shells are available." : "Interactive pseudo-terminals are unavailable. The terminal can still use its line-based fallback.", ...(!terminal ? { fix: "Install Python 3 with pty, termios and fcntl support, or choose its executable with CODEFLOW_PYTHON. Windows does not support this terminal helper." } : {}) },
    { id: "snapshots", name: "Browser snapshots", installed: !!browser, ready: !!chrome?.ok, ...(browser ? { path: browser } : {}), ...(chrome ? { version: versionLine(chrome.stdout || chrome.stderr) } : {}), detail: !browser ? "No supported local browser was found for snapshots." : chrome?.ok ? "The configured Chrome-compatible browser responds to its version probe." : "The browser file exists but its version probe failed or timed out.", ...(!browser || !chrome?.ok ? { fix: "Install Chrome, Chromium, Edge or Brave, or set CODEFLOW_CHROME to its executable. The embedded preview remains available without browser snapshots." } : {}) },
    { id: "docker", name: "Optional Docker isolation", installed: !docker.missing, ready: !!docker.ok && daemonReady, ...(docker.ok ? { version: versionLine(docker.stdout || docker.stderr) } : {}), detail: docker.missing ? "Docker was not found. Host CLI execution remains available." : !docker.ok ? "Docker's version probe failed or timed out." : daemonReady ? `The Docker daemon responds (${runtime!.stdout.trim().slice(0, 80)}). Images and authenticated volumes must still be prepared deliberately.` : "Docker is installed, but its daemon is unavailable or access is denied.", ...(!docker.ok || !daemonReady ? { fix: "Install or start Docker and check access to its daemon before choosing isolated agents. This check does not pull images or change Docker configuration." } : {}) },
  ];
}

/** Reuses the application's provider authentication/compatibility and Git health checks. */
export async function discoverDependencies(quota: Partial<Record<AgentId, HealthEntry["quota"]>> = {}): Promise<DependencyHealthReport> {
  const [providers, git, optional] = await Promise.all([doctor(quota), checkGit(), optionalDependencyHealth()]);
  return { checkedAt: Date.now(), node: { version: process.version, ok: Number(process.versions.node.split(".")[0]) >= 20 }, git, providers, optional };
}
