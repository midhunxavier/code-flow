import { parse as parseToml } from "smol-toml";
import { access, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { CODEFLOW_HOME } from "../config.js";
import { repoRoot } from "../git.js";
import { acquireStateLock } from "../store.js";
import { digest, fail } from "./model.js";
import { managedLauncher } from "../../bin/managed.mjs";

export const DESKTOP_HOSTS = ["claude-desktop", "codex-app"] as const;
export type DesktopHost = typeof DESKTOP_HOSTS[number];
export interface DesktopOptions {
  home?: string; userHome?: string; codexHome?: string; platform?: NodeJS.Platform;
  executable?: string; launcher?: string; path?: string;
}
export interface DesktopCommand { command: string; args: string[]; env: Record<string, string> }
interface Entry { host: DesktopHost; path: string; owned: string }
interface Edit extends Entry { before?: string; after?: string }
interface Manifest { version: 1; repo: string; entries: Entry[]; pending?: Edit[] }
const read = (path: string) => readFile(path, "utf8").catch(e => { if (e.code === "ENOENT") return undefined; throw e; });
const object = (value: any) => value && typeof value === "object" && !Array.isArray(value);
async function atomic(path: string, text: string | undefined) {
  if (text === undefined) { await rm(path, { force: true }); return; }
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try { await writeFile(temp, text, { flag: "wx", mode: 0o600 }); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}
async function checkPath(path: string) {
  // Do not replace a symlink or traverse a symlinked config directory.
  // realpath of the user home is resolved before constructing destinations.
  for (let p = path; dirname(p) !== p; p = dirname(p)) {
    const info = await lstat(p).catch(e => { if (e.code === "ENOENT") return; throw e; });
    if (info?.isSymbolicLink()) fail("installation_conflict", `Move the symlink before configuring ${path}`);
  }
}
export function desktopConfigPath(host: DesktopHost, userHome: string, platform: NodeJS.Platform, codexHome?: string) {
  if (host === "codex-app") return join(codexHome ? resolve(codexHome) : join(userHome, ".codex"), "config.toml");
  if (platform !== "darwin") fail("unsupported_host", "Automatic Claude Desktop setup currently supports macOS. Windows/WSL requires a separate cross-environment launcher; Linux has no supported Claude Desktop config location.");
  return join(userHome, "Library", "Application Support", "Claude", "claude_desktop_config.json");
}
async function context(path: string, hosts: DesktopHost[], options: DesktopOptions) {
  if (!hosts.length || hosts.some(h => !DESKTOP_HOSTS.includes(h))) fail("validation_failed", "Choose --hosts claude-desktop,codex-app or one host");
  const repo = await realpath(await repoRoot(path));
  const userHome = await realpath(options.userHome ?? homedir());
  const home = resolve(options.home ?? CODEFLOW_HOME);
  const name = `codeflow-${basename(repo).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 24) || "project"}-${digest(repo).slice(0, 10)}`;
  const targets = [...new Set(hosts)].map(host => ({ host, path: desktopConfigPath(host, userHome, options.platform ?? process.platform, options.codexHome ?? process.env.CODEX_HOME) }));
  return { repo, home, name, targets, manifestPath: join(home, "desktop-integrations", `${digest(repo)}.json`) };
}
export async function desktopCommand(repo: string, options: DesktopOptions = {}): Promise<DesktopCommand> {
  const command = await realpath(options.executable ?? process.execPath);
  const launcher = await realpath(options.launcher ?? await managedLauncher(options.home ?? CODEFLOW_HOME) ?? fileURLToPath(new URL("../../bin/codeflow.mjs", import.meta.url)));
  await access(command, constants.X_OK); await access(launcher, constants.R_OK);
  const path = [...new Set((options.path ?? process.env.PATH ?? "").split(delimiter).filter(p => isAbsolute(p)))].join(delimiter);
  const codexHome = options.codexHome ?? process.env.CODEX_HOME;
  return { command, args: [launcher, "mcp", "--project-root", repo], env: { CODEFLOW_HOME: resolve(options.home ?? CODEFLOW_HOME), PATH: path, ...(codexHome ? { CODEX_HOME: resolve(codexHome) } : {}) } };
}
function config(text: string | undefined, host: DesktopHost) {
  const data = host === "claude-desktop" ? JSON.parse(text ?? "{}") : parseToml(text ?? "");
  const key = host === "claude-desktop" ? "mcpServers" : "mcp_servers";
  if (!object(data) || data[key] !== undefined && !object(data[key])) fail("installation_conflict", `Invalid ${host} MCP configuration; repair it before setup`);
  return { data, key };
}
function markers(name: string) { return { begin: `# BEGIN ${name} managed MCP`, end: `# END ${name} managed MCP` }; }
function section(text: string, name: string) {
  const { begin, end } = markers(name), start = text.indexOf(begin), stop = text.indexOf(end);
  if (start < 0 && stop < 0) return undefined;
  if (start < 0 || stop < start || text.indexOf(begin, start + begin.length) >= 0 || text.indexOf(end, stop + end.length) >= 0) fail("installation_conflict", "Invalid managed MCP markers; preserve and repair the configuration before setup");
  return { start, stop: stop + end.length, text: text.slice(start, stop + end.length) };
}
function ownedValue(text: string | undefined, host: DesktopHost, name: string): string | undefined {
  const { data, key } = config(text, host);
  if (host === "claude-desktop") return Object.hasOwn(data[key] ?? {}, name) ? digest(data[key][name]) : undefined;
  const block = section(text ?? "", name);
  if (Object.hasOwn(data[key] ?? {}, name) && !block) return "unmanaged";
  // Include the parsed entry: additions outside the marked block must not be lost on removal.
  if (!block) return undefined;
  const entry = data[key]?.[name];
  // Codex's native toggle writes this preference inside our managed block.
  // It is not a transport edit and must not break ownership/repair/removal.
  // Keep all other fields and text covered by the ownership fingerprint.
  const withoutToggle = block.text.replace(/^[ \t]*enabled[ \t]*=[ \t]*(?:true|false)[ \t]*(?:#[^\r\n]*)?\r?\n/gm, "");
  if (entry && (entry.enabled === undefined || typeof entry.enabled === "boolean" && withoutToggle !== block.text)) {
    const { enabled: _enabled, ...transport } = entry;
    return digest({ block: withoutToggle, entry: transport });
  }
  return digest({ block: block.text, entry });
}
function update(text: string | undefined, host: DesktopHost, name: string, command?: DesktopCommand) {
  const { data, key } = config(text, host);
  if (host === "claude-desktop") {
    if (command) { data[key] ??= {}; data[key][name] = command; }
    else if (data[key]) { delete data[key][name]; if (!Object.keys(data[key]).length) delete data[key]; }
    return JSON.stringify(data, null, 2) + "\n";
  }
  const before = text ?? "", block = section(before, name), { begin, end } = markers(name);
  // JSON strings/arrays are valid TOML basic strings/arrays. Environment is an inline table
  // so appending another table cannot accidentally change the scope of existing settings.
  const body = command ? `${begin}\n[mcp_servers.${name}]\ncommand = ${JSON.stringify(command.command)}\nargs = ${JSON.stringify(command.args)}\nenv = { ${Object.entries(command.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(", ")} }\nstartup_timeout_sec = 60\ntool_timeout_sec = 420\n${end}` : "";
  const after = block ? before.slice(0, block.start) + body + before.slice(block.stop) : `${before}${before.endsWith("\n") || !before ? "" : "\n"}${body}\n`;
  parseToml(after); return after;
}
async function manifest(path: string, repo: string) {
  const text = await read(path);
  const value: Manifest = text ? JSON.parse(text) : { version: 1, repo, entries: [] };
  if (value.version !== 1 || value.repo !== repo || !Array.isArray(value.entries)) fail("installation_conflict", "Invalid desktop installation manifest");
  return value;
}
/** Global app configs contain one explicitly repository-bound entry per installation. */
export async function configureDesktop(path: string, hosts: DesktopHost[], action: "setup" | "remove", dryRun = false, options: DesktopOptions = {}) {
  const ctx = await context(path, hosts, options);
  // One lock across repositories: they share the same desktop config files.
  const release = dryRun ? () => {} : await acquireStateLock(join(ctx.home, "desktop-integrations", "installer.lock"), 2000, () => "Another desktop setup is in progress");
  try {
    const prior = await manifest(ctx.manifestPath, ctx.repo);
    if (prior.pending) {
      if (dryRun) fail("installation_conflict", "Interrupted desktop setup needs recovery; rerun without --dry-run");
      for (const edit of [...prior.pending].reverse()) {
        await checkPath(edit.path);
        if (await read(edit.path) === edit.after) await atomic(edit.path, edit.before);
      }
      delete prior.pending; await atomic(ctx.manifestPath, JSON.stringify(prior));
    }
    const command = action === "setup" ? await desktopCommand(ctx.repo, options) : undefined;
    const edits: Edit[] = [], preserved: string[] = [];
    let entries = [...prior.entries];
    for (const target of ctx.targets) {
      await checkPath(target.path);
      const before = await read(target.path), current = ownedValue(before, target.host, ctx.name);
      const old = prior.entries.find(e => e.path === target.path && e.host === target.host);
      if (current !== undefined && (!old || current !== old.owned)) {
        if (action === "setup") fail("installation_conflict", `Existing or modified ${ctx.name} in ${target.path} is preserved; rename the entry before setup`);
        preserved.push(target.path); continue;
      }
      if (action === "remove" && !old) continue;
      const after = action === "remove" && current === undefined ? before : update(before, target.host, ctx.name, command);
      entries = entries.filter(e => e.path !== target.path || e.host !== target.host);
      const owned = action === "setup" ? ownedValue(after, target.host, ctx.name)! : "";
      if (action === "setup") entries.push({ ...target, owned });
      if (before !== after) edits.push({ ...target, before, after, owned });
    }
    if (!dryRun) {
      // Journal before changing either app, then recover exact writes on interruption.
      await atomic(ctx.manifestPath, JSON.stringify({ ...prior, pending: edits }));
      try {
        for (const edit of edits) {
          await checkPath(edit.path);
          if (await read(edit.path) !== edit.before) fail("installation_conflict", "Desktop configuration changed during setup; retry after closing its settings editor");
          await atomic(edit.path, edit.after);
        }
        await atomic(ctx.manifestPath, JSON.stringify({ version: 1, repo: ctx.repo, entries } satisfies Manifest));
      } catch (error) {
        for (const edit of [...edits].reverse()) if (await read(edit.path) === edit.after) await atomic(edit.path, edit.before);
        await atomic(ctx.manifestPath, JSON.stringify(prior)); throw error;
      }
    }
    return { repo: ctx.repo, name: ctx.name, action, dryRun, changes: edits.map(e => ({ host: e.host, path: e.path })), preserved,
      message: action === "remove" ? "The connection is removed from configuration. Existing chats may retain it until reloaded. Existing work and run history are preserved; do not restart an app with active work." : "Enable the connection and open a fresh desktop chat to load its tools. Older chats can retain their original MCP configuration. Do not restart an app with active work. This connection always targets the displayed repository. No agent calls were made." };
  } finally { release(); }
}
export async function inspectDesktop(path: string, hosts: DesktopHost[], options: DesktopOptions = {}) {
  const ctx = await context(path, hosts, options), prior = await manifest(ctx.manifestPath, ctx.repo);
  const expected = await desktopCommand(ctx.repo, options);
  const connections = await Promise.all(ctx.targets.map(async target => {
    try {
      await checkPath(target.path);
      const text = await read(target.path), current = ownedValue(text, target.host, ctx.name);
      const old = prior.entries.find(e => e.path === target.path && e.host === target.host);
      const { data, key } = config(text, target.host), entry = data[key]?.[ctx.name];
      const state = prior.pending ? "interrupted" : current === undefined ? "missing" : !old || current !== old.owned ? "modified" : current !== ownedValue(update(text, target.host, ctx.name, expected), target.host, ctx.name) ? "needs_update" : entry?.enabled === false ? "disabled" : "configured";
      return { ...target, state, error: undefined, command: state === "configured" ? entry as DesktopCommand : undefined };
    } catch (error) { return { ...target, state: "invalid", command: undefined, error: error instanceof Error ? error.message : String(error) }; }
  }));
  return { repo: ctx.repo, name: ctx.name, connections };
}
