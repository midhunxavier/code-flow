import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-dependencies-module-"));
process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
const { discoverDependencies, optionalDependencyHealth } = await import("../src/dependency-health.js");
const { ptyAvailable } = await import("../src/shell.js");
async function fixture(t: { after: (fn: () => unknown) => void }) {
  const root = await mkdtemp(join(tmpdir(), "codeflow-dependencies-")); t.after(() => rm(root, { recursive: true, force: true }));
  const log = join(root, "commands.jsonl");
  async function executable(name: string, body: string) {
    const path = join(root, name);
    await writeFile(path, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs'; const args=process.argv.slice(2); appendFileSync(${JSON.stringify(log)},JSON.stringify({name:${JSON.stringify(name)},args,token:process.env.CODEFLOW_TOKEN??null})+'\\n');\n${body}\n`, { mode: 0o755 });
    return path;
  }
  return { root, log, executable };
}

test("dependency probes inspect versions, pseudo-terminal support and the Docker daemon using fixed argument arrays", async (t) => {
  const { log, executable } = await fixture(t);
  const python = await executable("python", "if(args[0]==='--version') console.log('Python 3.12.1'); else if(args[0]==='-I'&&args[1]==='-c') console.log(process.argv[1]); else process.exit(2);");
  const chrome = await executable("chrome", "if(args.length===1&&args[0]==='--version') console.log('Chromium 130.0.0.0'); else process.exit(2);");
  const docker = await executable("docker", "if(args[0]==='--version') console.log('Docker version 27.0.1'); else if(args[0]==='info'&&args[1]==='--format'&&args[2]==='{{.ServerVersion}}') console.log('27.0.1'); else process.exit(2);");
  const previous = process.env.CODEFLOW_TOKEN; process.env.CODEFLOW_TOKEN = "private-server-session";
  try {
    const report = await optionalDependencyHealth({ python, chrome, docker });
    assert.equal(report.every((entry) => entry.ready && entry.installed), process.platform !== "win32");
    assert.match(report.find((entry) => entry.id === "snapshots")!.version!, /Chromium/);
    assert.match(report.find((entry) => entry.id === "docker")!.detail, /daemon responds/);
    const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(calls.some((call) => call.name === "docker" && call.args.join(" ") === "info --format {{.ServerVersion}}"));
    assert.equal(calls.every((call) => call.token === null), true, "server sessions never reach health subprocesses");
    assert.equal(calls.some((call) => call.args.includes("run") || call.args.includes("pull") || call.args.includes("login")), false);
  } finally { if (previous === undefined) delete process.env.CODEFLOW_TOKEN; else process.env.CODEFLOW_TOKEN = previous; }
});

test("missing optional tools and a stopped Docker daemon remain distinct from required provider health", async (t) => {
  const { root, executable } = await fixture(t);
  const docker = await executable("docker-stopped", "if(args[0]==='--version') console.log('Docker version 27.0.1'); else {console.error('daemon unavailable');process.exit(1);}");
  const report = await optionalDependencyHealth({ python: join(root, "missing-python"), chrome: null, docker });
  const terminal = report.find((entry) => entry.id === "terminal")!; assert.equal(terminal.ready, false); assert.equal(terminal.installed, false); assert.match(terminal.detail, /fallback/);
  assert.equal(report.find((entry) => entry.id === "snapshots")!.installed, false);
  const isolation = report.find((entry) => entry.id === "docker")!; assert.equal(isolation.installed, true); assert.equal(isolation.ready, false); assert.match(isolation.detail, /daemon/);
  const missing = await optionalDependencyHealth({ python: join(root, "missing-python"), chrome: join(root, "missing-browser"), docker: join(root, "missing-docker") });
  assert.equal(missing.find((entry) => entry.id === "docker")!.installed, false);
  assert.equal(missing.find((entry) => entry.id === "snapshots")!.ready, false);
});

test("the complete discovery report reuses actual provider authentication/compatibility and Git checks", async () => {
  const report = await discoverDependencies({});
  assert.ok(report.checkedAt > 0); assert.equal(report.node.version, process.version); assert.equal(report.git.installed, true);
  assert.equal(report.providers.length, 3); assert.equal(report.providers.every((entry) => entry.installed && entry.compatible === true && entry.signedIn === true), true);
  assert.deepEqual(report.optional.map((entry) => entry.id), ["terminal", "snapshots", "docker"]);
});

test("explicit terminal discovery refreshes repaired executables while ordinary terminal checks retain their cache", async (t) => {
  const { executable } = await fixture(t);
  const python = await executable("repairable-python", "process.exit(1);");
  assert.equal(await ptyAvailable(python), false);
  await executable("repairable-python", "if(args[0]==='--version')console.log('Python 3.12.1');else console.log(process.argv[1]);");
  assert.equal(await ptyAvailable(python), false, "normal calls keep the stable existing probe");
  const refreshed = await optionalDependencyHealth({ python, chrome: null, docker: "/missing/docker" });
  assert.equal(refreshed.find((entry) => entry.id === "terminal")!.ready, process.platform !== "win32");
  assert.equal(await ptyAvailable(python), process.platform !== "win32", "subsequent shells reuse the refreshed interpreter");
});
