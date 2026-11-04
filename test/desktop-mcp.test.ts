import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { configureDesktop, desktopConfigPath, inspectDesktop, type DesktopOptions } from "../src/cli-teams/desktop.js";
import { digest } from "../src/cli-teams/model.js";

const dirs: string[] = [];
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
const hosts = ["claude-desktop", "codex-app"] as const;
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "codeflow desktop "))); dirs.push(dir);
  const repo = join(dir, "repo with spaces"), userHome = join(dir, "user"), home = join(dir, "state");
  await mkdir(repo); await mkdir(userHome);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  const options: DesktopOptions = { userHome, home, codexHome: join(userHome, ".codex"), platform: "darwin", path: [".", "/usr/bin", "relative", "/bin", "/usr/bin"].join(delimiter) };
  const claude = desktopConfigPath("claude-desktop", userHome, "darwin"), codex = desktopConfigPath("codex-app", userHome, "darwin");
  return { dir, repo, options, claude, codex, home };
}
async function put(path: string, body: string) { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, body); }
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));

test("native Codex on/off preferences preserve installer ownership but transport edits remain protected", async () => {
  const f = await fixture();
  const installed = await configureDesktop(f.repo, ["codex-app"], "setup", false, f.options);
  const original = await readFile(f.codex, "utf8");
  const toggle = (enabled: boolean) => original.replace(`# END ${installed.name}`, `enabled = ${enabled}\n# END ${installed.name}`);
  await writeFile(f.codex, toggle(false));
  assert.equal((await inspectDesktop(f.repo, ["codex-app"], f.options)).connections[0]!.state, "disabled");
  await writeFile(f.codex, toggle(true));
  assert.equal((await inspectDesktop(f.repo, ["codex-app"], f.options)).connections[0]!.state, "configured");
  await writeFile(f.codex, toggle(false).replace("tool_timeout_sec = 420", "tool_timeout_sec = 900"));
  assert.equal((await inspectDesktop(f.repo, ["codex-app"], f.options)).connections[0]!.state, "modified");
  assert.deepEqual((await configureDesktop(f.repo, ["codex-app"], "remove", false, f.options)).preserved, [f.codex]);
  await writeFile(f.codex, toggle(false));
  await configureDesktop(f.repo, ["codex-app"], "setup", false, f.options);
  assert.equal((await inspectDesktop(f.repo, ["codex-app"], f.options)).connections[0]!.state, "configured");
  await writeFile(f.codex, toggle(true));
  assert.equal((await configureDesktop(f.repo, ["codex-app"], "remove", false, f.options)).changes.length, 1);
});

test("desktop setup merges both configs, binds absolute paths, is idempotent and removes only owned entries", async () => {
  const f = await fixture();
  await put(f.claude, JSON.stringify({ preferences: { theme: "dark" }, mcpServers: { other: { command: "other", env: { SECRET: "keep-private" } } } }));
  await put(f.codex, '# retain this comment\nmodel = "existing"\n[mcp_servers.other]\ncommand = "other"\n');
  const before = await readFile(f.claude, "utf8");
  const dry = await configureDesktop(f.repo, [...hosts], "setup", true, f.options);
  assert.equal(dry.changes.length, 2); assert.equal(await readFile(f.claude, "utf8"), before);
  assert.ok(!JSON.stringify(dry).includes("keep-private"), "never print unrelated config/secrets");
  await assert.rejects(readFile(join(f.home, "desktop-integrations", `${digest(f.repo)}.json`)), { code: "ENOENT" });
  const installed = await configureDesktop(f.repo, [...hosts], "setup", false, f.options);
  const c = await json(f.claude), x: any = parseToml(await readFile(f.codex, "utf8"));
  const entry = c.mcpServers[installed.name];
  assert.equal(entry.command, await realpath(process.execPath));
  assert.equal(entry.args[0], await realpath(fileURLToPath(new URL("../bin/codeflow.mjs", import.meta.url))));
  assert.deepEqual(entry.args.slice(1), ["mcp", "--project-root", f.repo]);
  assert.deepEqual(entry.env, { CODEFLOW_HOME: f.home, PATH: ["/usr/bin", "/bin"].join(delimiter), CODEX_HOME: f.options.codexHome });
  assert.deepEqual(JSON.parse(JSON.stringify(x.mcp_servers[installed.name])), { ...entry, startup_timeout_sec: 60, tool_timeout_sec: 420 });
  assert.equal(c.mcpServers.other.env.SECRET, "keep-private"); assert.equal(x.model, "existing");
  assert.equal((await configureDesktop(f.repo, [...hosts], "setup", false, f.options)).changes.length, 0);
  assert.deepEqual((await inspectDesktop(f.repo, [...hosts], f.options)).connections.map(c => c.state), ["configured", "configured"]);
  c.preferences.theme = "light"; c.mcpServers.later = { command: "later" }; await put(f.claude, JSON.stringify(c));
  await configureDesktop(f.repo, [...hosts], "remove", false, f.options);
  const remaining = await json(f.claude);
  assert.equal(remaining.preferences.theme, "light"); assert.equal(remaining.mcpServers.later.command, "later");
  assert.equal(remaining.mcpServers[installed.name], undefined);
  assert.match(await readFile(f.codex, "utf8"), /^# retain this comment/);
  assert.equal((parseToml(await readFile(f.codex, "utf8")) as any).mcp_servers.other.command, "other");
  assert.equal((await configureDesktop(f.repo, [...hosts], "remove", false, f.options)).changes.length, 0);
});

test("desktop setup validates all files before writing and rejects symlinked destinations", async () => {
  const f = await fixture(); await put(f.codex, "broken = [");
  await assert.rejects(configureDesktop(f.repo, [...hosts], "setup", false, f.options));
  await assert.rejects(readFile(f.claude), { code: "ENOENT" });
  await rm(f.codex); const sentinel = join(f.dir, "sentinel"); await writeFile(sentinel, "{}");
  await mkdir(join(f.claude, ".."), { recursive: true }); await symlink(sentinel, f.claude);
  await assert.rejects(configureDesktop(f.repo, [...hosts], "setup", false, f.options), /symlink/);
  assert.equal(await readFile(sentinel, "utf8"), "{}");
  assert.throws(() => desktopConfigPath("claude-desktop", f.dir, "linux"), /macOS/);
});

test("modified entries survive setup/removal, including TOML changes outside managed markers", async () => {
  const f = await fixture(), installed = await configureDesktop(f.repo, [...hosts], "setup", false, f.options);
  const c = await json(f.claude); c.mcpServers[installed.name].env.EXTRA = "user-setting"; await put(f.claude, JSON.stringify(c));
  await put(f.codex, (await readFile(f.codex, "utf8")) + 'enabled = false\n');
  await assert.rejects(configureDesktop(f.repo, [...hosts], "setup", false, f.options), /preserved/);
  const status = await inspectDesktop(f.repo, [...hosts], f.options);
  assert.deepEqual(status.connections.map(c => c.state), ["modified", "modified"]);
  const removed = await configureDesktop(f.repo, [...hosts], "remove", false, f.options);
  assert.equal(removed.preserved.length, 2); assert.equal(removed.changes.length, 0);
  assert.equal((await json(f.claude)).mcpServers[installed.name].env.EXTRA, "user-setting");
});

test("multiple repositories have separate connections and removing one preserves the other", async () => {
  const f = await fixture(), first = await configureDesktop(f.repo, [...hosts], "setup", false, f.options);
  const secondRepo = join(f.dir, "second"); await mkdir(secondRepo); execFileSync("git", ["init", "-q"], { cwd: secondRepo });
  const second = await configureDesktop(secondRepo, [...hosts], "setup", false, f.options);
  assert.notEqual(first.name, second.name);
  await configureDesktop(f.repo, [...hosts], "remove", false, f.options);
  assert.deepEqual((await inspectDesktop(secondRepo, [...hosts], f.options)).connections.map(c => c.state), ["configured", "configured"]);
  const updated = { ...f.options, path: "/usr/local/bin:/usr/bin" };
  assert.deepEqual((await inspectDesktop(secondRepo, [...hosts], updated)).connections.map(c => c.state), ["needs_update", "needs_update"]);
  await configureDesktop(secondRepo, [...hosts], "setup", false, updated);
  assert.equal((await json(f.claude)).mcpServers[second.name].env.PATH, updated.path);
});

test("interrupted desktop installation rolls back exact writes before retrying", async () => {
  const f = await fixture(); const installed = await configureDesktop(f.repo, [...hosts], "setup", false, f.options);
  const manifestPath = join(f.home, "desktop-integrations", `${digest(f.repo)}.json`), manifest = await json(manifestPath);
  const before = await readFile(f.claude, "utf8"), after = '{"interrupted":true}\n';
  await writeFile(f.claude, after);
  manifest.pending = [{ ...manifest.entries.find((e: any) => e.host === "claude-desktop"), before, after }];
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(configureDesktop(f.repo, [...hosts], "setup", true, f.options), /Interrupted/);
  await configureDesktop(f.repo, [...hosts], "setup", false, f.options);
  assert.ok((await json(f.claude)).mcpServers[installed.name]);
  assert.equal((await json(manifestPath)).pending, undefined);
});

test("launcher exposes desktop setup/doctor/remove without opening the UI", async () => {
  const f = await fixture(), launcher = fileURLToPath(new URL("../bin/codeflow.mjs", import.meta.url));
  const env = { ...process.env, HOME: f.options.userHome!, CODEX_HOME: f.options.codexHome!, CODEFLOW_HOME: f.home };
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [launcher, "desktop", ...args, "--hosts", "codex-app", "--project-root", f.repo, "--json"], { env, cwd: "/", encoding: "utf8" }));
  assert.equal(cli("setup", "--dry-run").changes.length, 1);
  assert.equal(cli("setup").changes.length, 1);
  assert.equal(cli("doctor").connections[0].state, "configured");
  assert.equal(cli("disable").changes.length, 1);
  assert.equal(cli("enable").changes.length, 1);
  assert.equal(cli("remove").changes.length, 1);
  assert.throws(() => cli("doctor"), (error: any) => error.status === 1 && JSON.parse(error.stdout).connections[0].state === "missing");
});
