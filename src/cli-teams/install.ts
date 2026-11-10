import { parse as parseToml } from "smol-toml";
import { mkdir, readFile, readdir, writeFile, rename, rm, rmdir, lstat, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CODEFLOW_HOME } from "../config.js";
import { repoRoot } from "../git.js";
import { acquireStateLock } from "../store.js";
import { digest, fail, type Provider } from "./model.js";
import { managedLauncher } from "../../bin/managed.mjs";

const BEGIN = "# BEGIN codeflow managed MCP", END = "# END codeflow managed MCP";
interface Edit { path: string; before?: string; after: string; kind: "json" | "toml" | "skill" | "preferences"; owned: string }
// Project manifests only exist for installs made before setup moved to user settings; uninstallProject cleans them up.
interface Manifest { version: 1; repo: string; state: "installing" | "installed"; edits: Edit[]; previous?: Manifest }
const read = (file: string) => readFile(file, "utf8").catch(e => { if (e.code === "ENOENT") return undefined; throw e; });
async function atomic(file: string, body: string) { await mkdir(dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.tmp`; try { await writeFile(temp, body, { mode: 0o600, flag: "wx" }); await rename(temp, file); } finally { await rm(temp, { force: true }); } }
async function checkPath(repo: string, path: string) {
  const local = relative(repo, path);
  if (!local || local.startsWith("..") || local.startsWith("/")) fail("installation_conflict", "Installation path is outside the project");
  let p = path;
  while (p !== repo) { const info = await lstat(p).catch(e => { if (e.code === "ENOENT") return; throw e; }); if (info?.isSymbolicLink()) fail("installation_conflict", `Move the symlink before configuring ${relative(repo, path)}`); p = dirname(p); }
}
/** The skill each CLI loads. Managed connections deliver the versioned rules at MCP start, so the skill stays small and stable. */
async function skillText(managed: boolean) {
  const workflow = await readFile(fileURLToPath(new URL("../../integrations/cli-teams/SKILL.md", import.meta.url)), "utf8");
  return managed ? `${workflow.match(/^---\r?\n[\s\S]*?\r?\n---/)![0]}\n\n# Code Flow\n\nUse the connected Code Flow MCP tools. They work on the Git repository you started this session in. Follow the short rules the server supplies at initialization, and call \`codeflow_get_guide\` with section \`candidate\` before your first proposal (section \`all\` for the full guide). The guide and tool schemas come from the active shared runtime release. Before opening approval, show the team, steps, and full proposal link in the conversation. A plain plan uses a finish node with outcome \`plan_ready\` and inputs pointing to the plan task; it needs no agreement gate. Obtain explicit approval of the exact proposal before starting work. Managed workers must never recursively start Code Flow runs. If the tools are unavailable, ask the user to run \`codeflow init\` and reconnect Code Flow from /mcp; do not bypass it by launching provider CLIs.\n` : workflow;
}

export interface UserPaths { claudeConfig: string; claudeSkill: string; codexConfig: string; codexSkill: string; agyConfig: string; agySkill: string }
/** Where each CLI keeps per-user settings. Nothing here is inside a repository. */
export function userPaths(env: NodeJS.ProcessEnv = process.env): UserPaths {
  const home = env.HOME || homedir(), claudeDir = env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : undefined, codexHome = env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(home, ".codex");
  // agy (Antigravity CLI) keeps user MCP servers and global skills in its shared ~/.gemini/config folder.
  const agyHome = join(home, ".gemini", "config");
  return { claudeConfig: join(claudeDir ?? home, ".claude.json"), claudeSkill: join(claudeDir ?? join(home, ".claude"), "skills", "codeflow", "SKILL.md"), codexConfig: join(codexHome, "config.toml"), codexSkill: join(codexHome, "skills", "codeflow", "SKILL.md"), agyConfig: join(agyHome, "mcp_config.json"), agySkill: join(agyHome, "skills", "codeflow", "SKILL.md") };
}
/** agy's mcp_config.json may contain comments and trailing commas, which agy itself accepts. */
export function parseJsonc(text: string): any {
  if (!text.trim()) return {};
  let plain = "", clean = "";
  for (let i = 0, quoted = false; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) { plain += c; if (c === "\\") plain += text[++i] ?? ""; else if (c === '"') quoted = false; }
    else if (c === '"') { quoted = true; plain += c; }
    else if (c === "/" && text[i + 1] === "/") { while (i + 1 < text.length && text[i + 1] !== "\n") i++; }
    else if (c === "/" && text[i + 1] === "*") { const end = text.indexOf("*/", i + 2); i = end < 0 ? text.length : end + 1; plain += " "; }
    else plain += c;
  }
  for (let i = 0, quoted = false; i < plain.length; i++) {
    const c = plain[i]!;
    if (quoted) { clean += c; if (c === "\\") clean += plain[++i] ?? ""; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    if (c === "," && /^\s*[}\]]/.test(plain.slice(i + 1))) continue;
    clean += c;
  }
  return JSON.parse(clean);
}
/** agy adds its own on/off switch to each server; whether the user turned Code Flow off is theirs, not part of the connection. */
const agyServer = (value: unknown) => { if (!value || typeof value !== "object" || Array.isArray(value)) return value; const { disabled: _disabled, ...connection } = value as Record<string, unknown>; return connection; };
type UserEdit = { kind: "claude-mcp"; owned: string } | { kind: "agy-mcp"; owned: string } | { kind: "codex-mcp" | "skill"; path: string; owned: string };
interface UserManifest { version: 1; scope: "user"; edits: UserEdit[] }
type Run = (command: string, args: string[]) => Promise<void>;
const runCli: Run = (command, args) => new Promise((done, failed) => execFile(command, args, { timeout: 30000 }, (error, _out, stderr) => error ? failed(new Error(`${command} ${args.slice(0, 2).join(" ")} failed: ${(stderr || error.message).trim().slice(0, 500)}`)) : done()));

/**
 * Registers Code Flow once per user: one `codeflow` MCP connection per CLI plus its skill, all in the user's own settings.
 * The connection works on the repository the CLI was started in, so repositories stay free of personal paths.
 */
export async function installUser(providers: Provider[], dryRun = false, options: { home?: string; env?: NodeJS.ProcessEnv; run?: Run } = {}) {
  const home = options.home ?? CODEFLOW_HOME, env = options.env ?? process.env, run = options.run ?? runCli, paths = userPaths(env);
  const manifestPath = join(home, "cli-teams-installations", "user.json");
  const release = dryRun ? () => {} : await acquireStateLock(`${manifestPath}.lock`, 2000, () => "Another Code Flow installer is running");
  try {
    const manifestText = await read(manifestPath), prior = manifestText ? JSON.parse(manifestText) as UserManifest : undefined;
    if (prior && (prior.version !== 1 || prior.scope !== "user")) fail("installation_conflict", "Invalid private installation manifest");
    const owned = (kind: UserEdit["kind"], path?: string) => prior?.edits.find(e => e.kind === kind && (!path || "path" in e && e.path === path))?.owned;
    const managed = await managedLauncher(home);
    const explicitHome = env.CODEFLOW_HOME ? { CODEFLOW_HOME: resolve(env.CODEFLOW_HOME) } : undefined;
    const entry = { type: "stdio", command: managed ? process.execPath : "codeflow", args: managed ? [managed, "mcp"] : ["mcp"], ...(explicitHome ? { env: explicitHome } : {}) };
    const skill = await skillText(!!managed);
    const files: { path: string; before?: string; after: string; kind: "codex-mcp" | "skill"; owned: string }[] = [];
    const changes: { host: string; path: string }[] = [], kept: UserEdit[] = [];
    let claude: "add" | "replace" | undefined, previousClaude: unknown;
    // agy stores what `agy mcp add` is given: the command, its arguments and the environment, without Claude's type field.
    const agyEntry = { command: entry.command, args: entry.args, ...(entry.env ? { env: entry.env } : {}) };
    let agy: "add" | "replace" | undefined, agyBefore: string | undefined;
    if (providers.includes("claude")) {
      const config = await read(paths.claudeConfig), current = config ? JSON.parse(config)?.mcpServers?.codeflow : undefined;
      previousClaude = current;
      // A connection with the exact same settings is ours whether or not an earlier run finished recording it.
      if (current !== undefined && digest(current) !== digest(entry) && digest(current) !== owned("claude-mcp")) fail("installation_conflict", "Your Claude user settings already have a `codeflow` MCP server that Code Flow did not create. Remove it with `claude mcp remove -s user codeflow`, then run init again.");
      if (current === undefined) claude = "add"; else if (digest(current) !== digest(entry)) claude = "replace"; else kept.push({ kind: "claude-mcp", owned: digest(entry) });
      if (claude) changes.push({ host: "Claude Code", path: `${paths.claudeConfig} (user MCP server "codeflow")` });
    }
    if (providers.includes("codex")) {
      const existing = await read(paths.codexConfig), before = existing ?? "", data = parseToml(before) as any;
      const section = `${BEGIN}\n[mcp_servers.codeflow]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\nenv_vars = ["CODEFLOW_HOME"]\nstartup_timeout_sec = 60\ntool_timeout_sec = 420\n${END}`;
      const start = before.indexOf(BEGIN), end = before.indexOf(END), block = start >= 0 && end > start ? before.slice(start, end + END.length) : undefined;
      if (data.mcp_servers?.codeflow && (!block || digest(block) !== digest(section) && digest(block) !== owned("codex-mcp", paths.codexConfig))) fail("installation_conflict", `Your Codex settings (${paths.codexConfig}) already have a \`codeflow\` MCP server that Code Flow did not create. Rename or remove it, then run init again.`);
      const after = block ? before.slice(0, start) + section + before.slice(end + END.length) : `${before}${before && !before.endsWith("\n") ? "\n" : ""}\n${section}\n`;
      parseToml(after);
      if (after !== before) files.push({ path: paths.codexConfig, before: existing, after, kind: "codex-mcp", owned: digest(section) }); else kept.push({ kind: "codex-mcp", path: paths.codexConfig, owned: digest(section) });
    }
    if (providers.includes("agy")) {
      agyBefore = await read(paths.agyConfig);
      let data: any;
      try { data = parseJsonc(agyBefore ?? ""); } catch { fail("installation_conflict", `Antigravity's MCP settings (${paths.agyConfig}) could not be read. Check them with \`agy mcp list\`, then run init again.`); }
      const current = data?.mcpServers?.codeflow;
      if (current !== undefined && digest(agyServer(current)) !== digest(agyEntry) && digest(agyServer(current)) !== owned("agy-mcp")) fail("installation_conflict", "Your Antigravity settings already have a `codeflow` MCP server that Code Flow did not create. Remove it with `agy mcp remove codeflow`, then run init again.");
      if (current === undefined) agy = "add"; else if (digest(agyServer(current)) !== digest(agyEntry)) agy = "replace"; else kept.push({ kind: "agy-mcp", owned: digest(agyEntry) });
      if (agy) changes.push({ host: "Antigravity", path: `${paths.agyConfig} (MCP server "codeflow")` });
    }
    for (const [provider, path] of [["claude", paths.claudeSkill], ["codex", paths.codexSkill], ["agy", paths.agySkill]] as const) {
      if (!providers.includes(provider)) continue;
      const before = await read(path);
      if (before !== undefined && before !== skill && digest(before) !== owned("skill", path)) fail("installation_conflict", `${path} was changed by you; move it, then run init again.`);
      if (before !== skill) files.push({ path, before, after: skill, kind: "skill", owned: digest(skill) }); else kept.push({ kind: "skill", path, owned: digest(skill) });
    }
    for (const f of files) changes.push({ host: f.kind === "skill" ? "Skill" : "Codex", path: f.path });
    if (!dryRun && (files.length || claude || agy)) {
      const written: typeof files = [];
      let removed = false, agyTouched = false;
      try {
        for (const f of files) { if (await read(f.path) !== f.before) fail("installation_conflict", "Configuration changed during setup; run init again"); await atomic(f.path, f.after); written.push(f); }
        if (agy) {
          if (await read(paths.agyConfig) !== agyBefore) fail("installation_conflict", "Configuration changed during setup; run init again");
          // `agy mcp add` adds or updates in place. Flags go before the name, and `--` keeps the command's own arguments apart.
          agyTouched = true;
          await run("agy", ["mcp", "add", ...Object.entries(agyEntry.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]), "codeflow", "--", agyEntry.command, ...agyEntry.args]);
          const stored = parseJsonc(await read(paths.agyConfig) ?? "")?.mcpServers?.codeflow;
          if (digest(agyServer(stored)) !== digest(agyEntry)) fail("installation_conflict", "Antigravity did not record the Code Flow connection as expected; run `agy mcp list` to check it");
        }
        if (claude === "replace") { await run("claude", ["mcp", "remove", "-s", "user", "codeflow"]); removed = true; }
        if (claude) {
          await run("claude", ["mcp", "add-json", "-s", "user", "codeflow", JSON.stringify(entry)]);
          const stored = JSON.parse(await read(paths.claudeConfig) ?? "{}")?.mcpServers?.codeflow;
          if (digest(stored) !== digest(entry)) fail("installation_conflict", "Claude did not record the Code Flow connection as expected; run `claude mcp list` to check it");
        }
      } catch (error) {
        for (const f of written.reverse()) if (await read(f.path) === f.after) { if (f.before === undefined) await rm(f.path); else await atomic(f.path, f.before); }
        // agy's settings go back to exactly what they were, including anything else in that file.
        if (agyTouched && await read(paths.agyConfig).catch(() => undefined) !== agyBefore) { if (agyBefore === undefined) await rm(paths.agyConfig, { force: true }); else await atomic(paths.agyConfig, agyBefore); }
        // A failed replacement must not leave Claude without the connection that was working before.
        if (removed) {
          const stored = JSON.parse(await read(paths.claudeConfig).catch(() => undefined) ?? "{}")?.mcpServers?.codeflow;
          if (stored !== undefined && digest(stored) !== digest(previousClaude)) await run("claude", ["mcp", "remove", "-s", "user", "codeflow"]).catch(() => undefined);
          if (stored === undefined || digest(stored) !== digest(previousClaude)) await run("claude", ["mcp", "add-json", "-s", "user", "codeflow", JSON.stringify(previousClaude)]).catch(() => undefined);
        }
        throw error;
      }
    }
    if (!dryRun) {
      // Recorded even when nothing had to be written, so an entry that already matches stays ours
      // (a run interrupted before saving this would otherwise leave it unowned). Hosts not set up now keep their record.
      const edits: UserEdit[] = [...kept, ...(claude ? [{ kind: "claude-mcp" as const, owned: digest(entry) }] : []), ...(agy ? [{ kind: "agy-mcp" as const, owned: digest(agyEntry) }] : []), ...files.map(f => ({ kind: f.kind, path: f.path, owned: f.owned }))];
      const same = (a: UserEdit, b: UserEdit) => a.kind === b.kind && ("path" in a ? "path" in b && a.path === b.path : true);
      const all = [...(prior?.edits.filter(e => !edits.some(n => same(n, e))) ?? []), ...edits];
      if (!prior || digest(prior.edits) !== digest(all)) await atomic(manifestPath, JSON.stringify({ version: 1, scope: "user", edits: all } satisfies UserManifest));
    }
    return { dryRun, changes, connection: entry, message: "Start claude, codex or agy inside any Git repository and ask for a Code Flow task. Code Flow works on the repository you start the CLI in; open sessions need /mcp reconnect. No agent calls were made." };
  } finally { release(); }
}

export async function uninstallUser(options: { home?: string; env?: NodeJS.ProcessEnv; run?: Run } = {}) {
  const home = options.home ?? CODEFLOW_HOME, run = options.run ?? runCli, paths = userPaths(options.env ?? process.env);
  const manifestPath = join(home, "cli-teams-installations", "user.json");
  const release = await acquireStateLock(`${manifestPath}.lock`, 2000, () => "Installer is busy");
  try {
    const text = await read(manifestPath); if (!text) return { removed: [], preserved: [], message: "No user-level Code Flow setup found" };
    const manifest = JSON.parse(text) as UserManifest, removed: string[] = [], preserved: string[] = [];
    for (const e of manifest.edits) {
      if (e.kind === "claude-mcp") {
        const current = JSON.parse(await read(paths.claudeConfig) ?? "{}")?.mcpServers?.codeflow;
        if (current === undefined) continue;
        if (digest(current) !== e.owned) { preserved.push(`${paths.claudeConfig} (codeflow)`); continue; }
        await run("claude", ["mcp", "remove", "-s", "user", "codeflow"]); removed.push(`${paths.claudeConfig} (codeflow)`); continue;
      }
      if (e.kind === "agy-mcp") {
        let current: unknown;
        try { current = parseJsonc(await read(paths.agyConfig) ?? "")?.mcpServers?.codeflow; } catch { preserved.push(`${paths.agyConfig} (codeflow)`); continue; }
        if (current === undefined) continue;
        if (digest(agyServer(current)) !== e.owned) { preserved.push(`${paths.agyConfig} (codeflow)`); continue; }
        await run("agy", ["mcp", "remove", "codeflow"]); removed.push(`${paths.agyConfig} (codeflow)`); continue;
      }
      const current = await read(e.path); if (current === undefined) continue;
      if (e.kind === "skill") { if (digest(current) !== e.owned) { preserved.push(e.path); continue; } await rm(e.path); await rmdir(dirname(e.path)).catch(() => undefined); removed.push(e.path); continue; }
      const start = current.indexOf(BEGIN), end = current.indexOf(END);
      if (start < 0 || end < start || digest(current.slice(start, end + END.length)) !== e.owned) { preserved.push(e.path); continue; }
      await atomic(e.path, (current.slice(0, start).replace(/\n+$/, "\n") + current.slice(end + END.length).replace(/^\n+/, "")).replace(/^\n$/, "")); removed.push(e.path);
    }
    await rm(manifestPath, { force: true });
    return { removed, preserved, message: "Run history, branches, worktrees and anything you edited are kept. Reconnect open CLI sessions." };
  } finally { release(); }
}

/** Earlier versions wrote connections into the repository. Remove the ones Code Flow owns; keep anything the user changed. */
export async function hasProjectInstall(path: string, home = CODEFLOW_HOME) {
  const repo = await realpath(await repoRoot(path)).catch(() => undefined);
  return !!repo && (await read(join(home, "cli-teams-installations", `${digest(repo)}.json`))) !== undefined;
}
/** Remove folders the installer left empty, stopping at the repository root or the first folder with other files. */
async function pruneEmpty(repo: string, folder: string) {
  for (let dir = folder; dir !== repo && relative(repo, dir) && !relative(repo, dir).startsWith(".."); dir = dirname(dir)) {
    if ((await readdir(dir).catch(() => ["?"])).length) return;
    await rmdir(dir).catch(() => undefined);
  }
}
export async function uninstallProject(path: string, home = CODEFLOW_HOME) {
  const repo = await realpath(await repoRoot(path)), manifestPath = join(home, "cli-teams-installations", `${digest(repo)}.json`);
  const release = await acquireStateLock(`${manifestPath}.lock`, 2000, () => "Installer is busy");
  try {
    const text = await read(manifestPath); if (!text) return { removed: [], preserved: [], message: "No owned installation found" };
    const manifest = JSON.parse(text) as Manifest;
    if (manifest.version !== 1 || manifest.repo !== repo || manifest.state !== "installed") fail("installation_conflict", "Repair the interrupted installation with init before uninstalling");
    const removed: string[] = [], preserved: string[] = [], remaining: Edit[] = [];
    for (const e of manifest.edits) {
      await checkPath(repo, e.path);
      const current = await read(e.path); if (current === undefined) continue;
      // The preferences file is kept unless it is still the empty default Code Flow created.
      if (e.kind === "preferences") { if (e.before === undefined && current === e.after) { await rm(e.path); await pruneEmpty(repo, dirname(e.path)); removed.push(relative(repo, e.path)); } else preserved.push(relative(repo, e.path)); continue; }
      let next: string | undefined;
      if (e.kind === "skill") { if (digest(current) !== e.owned) { preserved.push(relative(repo, e.path)); remaining.push(e); continue; } next = e.before; }
      else if (e.kind === "json") {
        const data = JSON.parse(current);
        if (digest(data.mcpServers?.codeflow) !== e.owned) { preserved.push(relative(repo, e.path)); remaining.push(e); continue; }
        delete data.mcpServers.codeflow; if (!Object.keys(data.mcpServers).length) delete data.mcpServers;
        next = current === e.after ? e.before : JSON.stringify(data, null, 2) + "\n";
      } else {
        parseToml(current); const start = current.indexOf(BEGIN), end = current.indexOf(END);
        if (start < 0 || end < start || digest(current.slice(start, end + END.length)) !== e.owned) { preserved.push(relative(repo, e.path)); remaining.push(e); continue; }
        next = current === e.after ? e.before : current.slice(0, start) + current.slice(end + END.length);
      }
      if (next === undefined) { await rm(e.path); await pruneEmpty(repo, dirname(e.path)); } else await atomic(e.path, next);
      removed.push(relative(repo, e.path));
    }
    if (remaining.length) await atomic(manifestPath, JSON.stringify({ ...manifest, edits: remaining })); else await rm(manifestPath);
    return { removed, preserved, message: "Run history, branches, worktrees, preferences, and user-modified entries are preserved." };
  } finally { release(); }
}
