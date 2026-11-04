import { parse as parseToml } from "smol-toml";
import { mkdir, readFile, writeFile, rename, rm, lstat, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CODEFLOW_HOME } from "../config.js";
import { repoRoot } from "../git.js";
import { acquireStateLock } from "../store.js";
import { digest, fail, type Provider } from "./model.js";
import { managedLauncher } from "../../bin/managed.mjs";

const BEGIN = "# BEGIN codeflow managed MCP", END = "# END codeflow managed MCP";
interface Edit { path: string; before?: string; after: string; kind: "json" | "toml" | "skill" | "preferences"; owned: string }
interface Manifest { version: 1; repo: string; state: "installing" | "installed"; edits: Edit[]; previous?: Manifest }
const read = (file: string) => readFile(file, "utf8").catch(e => { if (e.code === "ENOENT") return undefined; throw e; });
async function atomic(file: string, body: string) { await mkdir(dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.tmp`; try { await writeFile(temp, body, { mode: 0o600, flag: "wx" }); await rename(temp, file); } finally { await rm(temp, { force: true }); } }
async function checkPath(repo: string, path: string) {
  const local = relative(repo, path);
  if (!local || local.startsWith("..") || local.startsWith("/")) fail("installation_conflict", "Installation path is outside the project");
  let p = path;
  while (p !== repo) { const info = await lstat(p).catch(e => { if (e.code === "ENOENT") return; throw e; }); if (info?.isSymbolicLink()) fail("installation_conflict", `Move the symlink before configuring ${relative(repo, path)}`); p = dirname(p); }
}
export async function installProject(path: string, providers: Provider[], dryRun = false, home = CODEFLOW_HOME) {
  const repo = await realpath(await repoRoot(path)), manifestPath = join(home, "cli-teams-installations", `${digest(repo)}.json`);
  const release = dryRun ? () => {} : await acquireStateLock(`${manifestPath}.lock`, 2000, () => "Another Code Flow installer is updating this project");
  try {
    const priorText = await read(manifestPath); let prior = priorText ? JSON.parse(priorText) as Manifest : undefined;
    if (prior && (prior.version !== 1 || prior.repo !== repo)) fail("installation_conflict", "Invalid private installation manifest");
    // An interrupted transaction rolls back only files still equal to our exact written text.
    if (prior?.state === "installing") {
      if (dryRun) fail("installation_conflict", "An interrupted installation needs recovery; rerun init without --dry-run");
      for (const e of [...prior.edits].reverse()) { await checkPath(repo, e.path); if (await read(e.path) === e.after) { if (e.before === undefined) await rm(e.path); else await atomic(e.path, e.before); } }
      prior = prior.previous;
      if (prior) await atomic(manifestPath, JSON.stringify(prior)); else await rm(manifestPath, { force: true });
    }
    const owned = prior?.state === "installed" ? prior.edits : [];
    const managed = await managedLauncher(home);
    const edits: Edit[] = [], mcp = managed ? { command: process.execPath, args: [managed, "mcp", "--project-root", repo] } : { command: "codeflow", args: ["mcp", "--project-root", "."] };
    const workflow = await readFile(fileURLToPath(new URL("../../integrations/cli-teams/SKILL.md", import.meta.url)), "utf8");
    // Managed connections deliver the versioned contract at MCP initialization.
    // A small stable skill avoids pinning a second, stale copy in each repository.
    const skill = managed ? `${workflow.match(/^---\r?\n[\s\S]*?\r?\n---/)![0]}\n\n# Code Flow\n\nUse the connected Code Flow MCP tools and the workflow instructions supplied by that server during initialization. Those instructions and tool schemas come from the active shared runtime release. Stay in this conversation, respect the connection's bound repository, and obtain explicit approval of the exact proposal before starting work. Managed workers must never recursively start Code Flow runs. If the tools are unavailable, ask the user to reload this project's MCP connection; do not bypass it by launching provider CLIs.\n` : workflow;
    const prepare = async (file: string, kind: Edit["kind"], after: (before: string | undefined, previous?: Edit) => { text: string; owned: string }) => {
      const path = join(repo, file); await checkPath(repo, path);
      const before = await read(path), previous = owned.find(e => e.path === path), next = after(before, previous);
      if (before !== next.text) edits.push({ path, before, after: next.text, kind, owned: next.owned });
    };
    if (providers.includes("claude")) {
      await prepare(".mcp.json", "json", (before, previous) => {
        const data = before ? JSON.parse(before) : {};
        if (!data || typeof data !== "object" || Array.isArray(data) || data.mcpServers !== undefined && (!data.mcpServers || typeof data.mcpServers !== "object" || Array.isArray(data.mcpServers))) fail("installation_conflict", "Invalid .mcp.json; repair it before installing");
        data.mcpServers ??= {};
        if (Object.hasOwn(data.mcpServers, "codeflow") && (!previous || digest(data.mcpServers.codeflow) !== previous.owned)) fail("installation_conflict", "An existing or modified codeflow MCP entry is preserved; rename it before installing");
        data.mcpServers.codeflow = mcp; return { text: JSON.stringify(data, null, 2) + "\n", owned: digest(mcp) };
      });
    }
    if (providers.includes("codex")) {
      await prepare(".codex/config.toml", "toml", (before = "", previous) => {
        const data = parseToml(before) as any;
        const section = `${BEGIN}\n[mcp_servers.codeflow]\ncommand = ${JSON.stringify(mcp.command)}\nargs = ${JSON.stringify(mcp.args)}\nenv_vars = ["CODEFLOW_HOME"]\nstartup_timeout_sec = 60\ntool_timeout_sec = 420\n${END}`;
        const start = before.indexOf(BEGIN), end = before.indexOf(END);
        if (data.mcp_servers?.codeflow && (!previous || start < 0 || end < start || digest(before.slice(start, end + END.length)) !== previous.owned)) fail("installation_conflict", "An existing or modified Codex codeflow entry is preserved; rename it before installing");
        const updated = start >= 0 ? before.slice(0, start) + section + before.slice(end + END.length) : `${before}${before && !before.endsWith("\n") ? "\n" : ""}\n${section}\n`;
        parseToml(updated); return { text: updated, owned: digest(section) };
      });
    }
    for (const provider of providers) await prepare(`${provider === "claude" ? ".claude" : ".agents"}/skills/codeflow/SKILL.md`, "skill", (before, previous) => {
      if (before !== undefined && (!previous || digest(before) !== previous.owned)) fail("installation_conflict", "An existing or modified codeflow skill is preserved; move it before installing");
      return { text: skill, owned: digest(skill) };
    });
    await prepare(".codeflow/cli-teams.json", "preferences", before => ({ text: before ?? '{\n  "schemaVersion": 1,\n  "preferences": {}\n}\n', owned: "preferences-preserved" }));
    if (!dryRun && edits.length) {
      await atomic(manifestPath, JSON.stringify({ version: 1, repo, state: "installing", edits, ...(prior ? { previous: prior } : {}) } satisfies Manifest));
      try {
        for (const e of edits) { if (await read(e.path) !== e.before) fail("installation_conflict", "Configuration changed during installation; rerun init"); await atomic(e.path, e.after); }
        const combined = [...owned.filter(e => !edits.some(next => next.path === e.path)), ...edits.map(e => { const old = owned.find(old => old.path === e.path); return { ...e, before: old ? old.before : e.before }; })];
        await atomic(manifestPath, JSON.stringify({ version: 1, repo, state: "installed", edits: combined } satisfies Manifest));
      } catch (error) {
        for (const e of [...edits].reverse()) if (await read(e.path) === e.after) { if (e.before === undefined) await rm(e.path); else await atomic(e.path, e.before); }
        if (prior?.state === "installed") await atomic(manifestPath, JSON.stringify(prior)); else await rm(manifestPath, { force: true });
        throw error;
      }
    }
    return { repo, dryRun, changes: edits.map(e => ({ path: relative(repo, e.path), content: e.after })), message: "Trust this project in your CLI, approve the project MCP connection, and reload the host if the skill/connection does not appear. Start with a plain-language Code Flow task. No agent calls were made." };
  } finally { release(); }
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
      if (e.kind === "preferences") { preserved.push(relative(repo, e.path)); continue; }
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
      if (next === undefined) await rm(e.path); else await atomic(e.path, next);
      removed.push(relative(repo, e.path));
    }
    if (remaining.length) await atomic(manifestPath, JSON.stringify({ ...manifest, edits: remaining })); else await rm(manifestPath);
    return { removed, preserved, message: "Run history, branches, worktrees, preferences, and user-modified entries are preserved." };
  } finally { release(); }
}
