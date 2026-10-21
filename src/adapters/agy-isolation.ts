import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { agyCredentialFailure, inspectAgyAuthLog } from "./agy-auth.js";
import type { ModelCatalog, RunOptions } from "./types.js";
import { startJsonlProcess } from "./process.js";

const exec = promisify(execFile);
export const AGY_ISOLATION_VERSION = "macos-file-only-v1";
export const AGY_VERIFIED_CLI_VERSION = "1.4.4";
export const AGY_FILE_ONLY_LIMITATION = "Antigravity is limited to file tools in a fresh macOS sandbox. Terminal, browser, MCP, hooks and native delegation are disabled; Code Flow runs checks separately. Native sessions are not resumed.";

export interface AgyIsolationRuntime {
  binary: string;
  keychains: string;
  securityCache: string;
  securityLock: string;
}
export interface AgyIsolationPaths extends AgyIsolationRuntime {
  workspace: string;
  home: string;
  scratch: string;
}
const within = (path: string, parent: string) => path === parent || path.startsWith(parent + sep);
function validPath(path: string) {
  if (!isAbsolute(path) || path === "/" || resolve(path) !== path || /[\x00-\x1f\x7f]/.test(path)) throw new Error("Invalid Antigravity isolation path");
}

/** No login/token export. The official CLI invokes Apple's security helper itself. */
export async function inspectAgyIsolationRuntime(): Promise<AgyIsolationRuntime> {
  if (process.platform !== "darwin") throw new Error("Isolated Antigravity requires macOS; remote and container execution are unsupported");
  await access("/usr/bin/sandbox-exec", constants.X_OK);
  let binary: string | undefined;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, "agy");
    try { await access(candidate, constants.X_OK); binary = await realpath(candidate); break; } catch { /* next PATH entry */ }
  }
  if (!binary) throw new Error("Antigravity CLI is not installed");
  // Inspect on every launch: a prior catalog entry cannot attest to the installed runtime.
  await verifyAgyVersion(binary);
  const keychains = await realpath(join(userInfo().homedir, "Library", "Keychains"));
  const cache = await exec("/usr/bin/getconf", ["DARWIN_USER_CACHE_DIR"], { timeout: 5000, maxBuffer: 4096, env: { PATH: "/usr/bin:/bin" } });
  const securityCache = await realpath(join(cache.stdout.trim(), "mds"));
  const securityLock = join(securityCache, "mds.lock");
  // Never follow a replaced lock into some other shared file.
  const lock = await lstat(securityLock);
  if (!lock.isFile() || lock.isSymbolicLink() || lock.nlink !== 1) throw new Error("The macOS security cache lock is unavailable or unsafe");
  for (const path of [binary, keychains, securityCache, securityLock]) validPath(path);
  return { binary, keychains, securityCache, securityLock };
}

/** Captures diagnostics in memory only, with the same tracked process-group lifecycle as workers.
 * Callers must replace errors with safe messages: provider output can contain authentication data. */
async function isolatedOutput(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, maxBytes: number): Promise<string> {
  let output = "", overflow = false;
  const append = (line: string) => {
    if (overflow) return;
    if (Buffer.byteLength(output) + Buffer.byteLength(line) + 1 > maxBytes) { overflow = true; proc.kill(); return; }
    output += line + "\n";
  };
  const proc = startJsonlProcess({ command, args, cwd, env, timeoutMs, onText: append, onJson: value => append(JSON.stringify(value)) });
  const outcome = await proc.outcome;
  if (agyCredentialFailure(outcome.stderr + "\n" + output) || overflow || outcome.exitCode !== 0 || outcome.aborted || outcome.timedOut || outcome.stalled) throw new Error("Isolated Antigravity probe failed");
  return output;
}

/** Even a replaced/unsupported executable is inspected without host settings, credentials or network. */
export async function verifyAgyVersion(binary: string): Promise<void> {
  validPath(binary);
  const root = await realpath(await mkdtemp(join(tmpdir(), "codeflow-agy-version-")));
  try {
    const profile = join(root, "version.sb");
    await writeFile(profile, `(version 1)
(deny default)
(allow sysctl-read file-read-metadata)
(allow process-exec (literal ${JSON.stringify(binary)}))
(allow file-read* file-map-executable (literal "/") (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/Library/Apple") (subpath "/private/etc") (subpath "/dev") (literal ${JSON.stringify(binary)}))
(allow file-write* (literal "/dev/null"))
`, { mode: 0o400 });
    const version = await isolatedOutput("/usr/bin/sandbox-exec", ["-f", profile, binary, "--version"], root,
      { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root, AGY_CLI_DISABLE_AUTO_UPDATE: "true" }, 5000, 4096);
    if (version.trim() !== AGY_VERIFIED_CLI_VERSION) throw new Error(`Isolated Antigravity requires verified CLI ${AGY_VERIFIED_CLI_VERSION}`);
  } finally { await rm(root, { recursive: true, force: true }); }
}

export async function agyIsolationProblem(): Promise<string | undefined> {
  try { await inspectAgyIsolationRuntime(); }
  catch { return `Isolated Antigravity requires macOS, CLI ${AGY_VERIFIED_CLI_VERSION}, and an existing native Keychain login/security cache. No permissive fallback is available.`; }
}

export async function discoverIsolatedAgyModels(): Promise<ModelCatalog> {
  const workspace = await mkdtemp(join(tmpdir(), "codeflow-agy-catalog-"));
  let isolated: Awaited<ReturnType<typeof prepareAgyIsolation>> | undefined;
  try {
    isolated = await prepareAgyIsolation(workspace, "read", await inspectAgyIsolationRuntime());
    const logPath = join(isolated.paths.scratch, "native-auth.log");
    const stdout = await isolatedOutput(isolated.command, [...isolated.args, "--log-file", logPath, "models"], isolated.paths.workspace, isolated.env, 20000, 128 * 1024);
    const auth = await inspectAgyAuthLog(logPath);
    if (auth.credentialFailure || auth.interactiveAuthObserved) throw new Error("Native authentication could not be maintained");
    const models = stdout.split("\n").map(line => line.split("\t")).filter(cols => cols.length >= 2 && cols[0]!.trim()).map(([id, label]) => ({ id: id!.trim(), label: label!.trim() }));
    if (!models.length) throw new Error("No model candidates");
    return { models, efforts: [], allowCustom: false, discovery: { source: `agy models (${AGY_ISOLATION_VERSION}/1.4.4)`, confidence: "reported", verifiedAt: Date.now() } };
  } catch { throw new Error("Isolated Antigravity model discovery failed; check native login and runtime compatibility"); }
  finally { await isolated?.cleanup(); await rm(workspace, { recursive: true, force: true }); }
}

/** Policy/configuration builders accept canonical paths only; no caller-supplied SBPL. */
export function agyIsolationProfile(paths: AgyIsolationPaths, mode: "read" | "write"): string {
  for (const path of Object.values(paths)) validPath(path);
  const roots = [paths.workspace, paths.home, paths.scratch, paths.keychains, paths.securityCache];
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
    if (within(roots[i]!, roots[j]!) || within(roots[j]!, roots[i]!)) throw new Error("Antigravity isolation roots must not overlap");
  }
  if (paths.securityLock !== join(paths.securityCache, "mds.lock") || within(paths.binary, paths.workspace)) throw new Error("Unsafe Antigravity executable or security lock path");
  const q = JSON.stringify;
  const cli = join(paths.home, ".gemini", "antigravity-cli");
  // Do not allow replacement of policy ancestors. Runtime state below the CLI directory
  // is writable, but all policy-bearing files and customization directories are protected.
  const protectedFiles = [paths.home, join(paths.home, ".gemini"), cli, join(paths.home, "Library"), join(paths.home, "Library", "Keychains"), join(cli, "settings.json"), join(cli, "mcp_config.json")];
  return `(version 1)
(deny default)
(allow process-fork signal sysctl-read mach-lookup file-read-metadata)
(allow process-exec (literal ${q(paths.binary)}) (literal "/usr/bin/security"))
(allow file-read* file-map-executable
  (literal "/") (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin")
  (subpath "/Library/Apple") (subpath "/private/etc") (subpath "/dev")
  (literal ${q(paths.binary)}) (subpath ${q(paths.workspace)}) (subpath ${q(paths.home)}) (subpath ${q(paths.scratch)})
  (subpath ${q(paths.keychains)}) (subpath ${q(paths.securityCache)}) (subpath "/private/var/db/mds"))
(allow file-write* (subpath ${q(paths.home)}) (subpath ${q(paths.scratch)}) (literal "/dev/null")${mode === "write" ? ` (subpath ${q(paths.workspace)})` : ""})
(allow file-write-data (literal ${q(paths.securityLock)}))
(deny file-write* ${protectedFiles.map(p => `(literal ${q(p)})`).join(" ")}
  (subpath ${q(join(paths.home, ".gemini", "config"))}))
(deny file-read* file-write* (require-all (subpath ${q(paths.workspace)}) (regex #"/[.](agents|gemini)(/|$)")))
(deny file-write* (require-all (subpath ${q(paths.workspace)}) (regex #"/[.]git(/|$)")))
; Inference and native authentication need networking. Model command/browser/MCP tools
; are removed and denied in protected provider policy; this is not whole-process offline mode.
(allow network*)
`;
}

export function agyIsolatedSettings(paths: AgyIsolationPaths, mode: "read" | "write") {
  return {
    enableTerminalSandbox: true, toolPermission: "request-review", allowNonWorkspaceAccess: false,
    permissions: {
      allow: [`read_file(${paths.workspace})`, ...(mode === "write" ? [`write_file(${paths.workspace})`] : [])],
      ask: [],
      deny: ["unsandboxed(*)", "command(*)", "mcp(*)", "read_url(*)", "execute_url(*)",
        ...[paths.home, paths.scratch, paths.keychains, paths.securityCache, "/private/var/db/mds"].map(p => `read_file(${p})`),
        ...(mode === "read" ? ["write_file(*)"] : [])],
    },
  };
}

export async function prepareAgyIsolation(workspace: string, mode: "read" | "write", runtime: AgyIsolationRuntime) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codeflow-agy-managed-")));
  const cleanup = () => rm(root, { recursive: true, force: true });
  try {
    const home = join(root, "home"), scratch = join(root, "scratch");
    const paths = { ...runtime, workspace: await realpath(workspace), home, scratch };
    const profile = agyIsolationProfile(paths, mode);
    const cli = join(home, ".gemini", "antigravity-cli"), config = join(home, ".gemini", "config");
    for (const path of [scratch, cli, join(config, "agents"), join(config, "projects"), join(home, "Library")]) await mkdir(path, { recursive: true, mode: 0o700 });
    // CLI 1.4.4 requires this record even in headless mode. Seed it before sealing config;
    // allowing runtime writes to the whole config tree would also allow policy mutation.
    await writeFile(join(config, "projects", "default-cli-project.json"), JSON.stringify({ id: "default-cli-project", name: "CLI Project", projectResources: {} }), { mode: 0o400 });
    await writeFile(join(cli, "settings.json"), JSON.stringify(agyIsolatedSettings(paths, mode)), { mode: 0o400 });
    await writeFile(join(config, "hooks.json"), "{}", { mode: 0o400 });
    for (const path of [join(config, "mcp_config.json"), join(cli, "mcp_config.json")]) await writeFile(path, '{"mcpServers":{}}', { mode: 0o400 });
    await writeFile(join(config, "agents", "codeflow-isolated.md"), `---
name: codeflow-isolated
description: Code Flow isolated file worker
tools:
  - view_file
  - list_dir
${mode === "write" ? "  - write_to_file\n  - replace_file_content\n" : ""}mainAgent: true
subagent: false
commandExecutionPolicy: off
mcpServers: []
skills: []
plugins: []
---
Use the available file tools for this task. Code Flow runs checks separately. Report limitations when a task needs unavailable tools. Never attempt to bypass a denied tool.
`, { mode: 0o400 });
    // Read-only in the kernel profile. Code Flow never extracts or copies the keychain item.
    await symlink(runtime.keychains, join(home, "Library", "Keychains"));
    const profilePath = join(root, "worker.sb");
    await writeFile(profilePath, profile, { mode: 0o400 });
    const env: NodeJS.ProcessEnv = {
      HOME: home, TMPDIR: scratch, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8",
      AGY_CLI_DISABLE_AUTO_UPDATE: "true", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    };
    return { root, paths, env, command: "/usr/bin/sandbox-exec", args: ["-f", profilePath, runtime.binary], cleanup };
  } catch (error) { await cleanup(); throw error; }
}

export function agyManagedOptionsProblem(opts: RunOptions): string | undefined {
  const p = opts.permissions;
  if (!p || p.provider !== "agy" || p.mode !== opts.mode || p.trust !== (opts.trust ?? "standard") || p.nativeDelegation !== false || p.isolation !== "os-sandbox" || p.implementation !== AGY_ISOLATION_VERSION || p.commandNetwork !== "denied" || p.externalTools !== "disabled") return "Antigravity options do not match the isolated run permission policy";
  if (opts.agentContainer || opts.interactiveApprovals || p.toolApprovals) return "Isolated Antigravity does not support containers or interactive approvals";
}
