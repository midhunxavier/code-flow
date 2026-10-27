import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { mkdtemp, mkdir, readFile, rm, cp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SshGateway, type Runtime } from "../src/ssh-projects/gateway.js";
import type { SshTransport } from "../src/ssh-projects/transport.js";
import { SshProjects } from "../src/ssh-projects/manager.js";
const root = fileURLToPath(new URL("..", import.meta.url));
const pause = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
async function scratch(t: any) { const dir = await mkdtemp(join(tmpdir(), "codeflow-clients-qa-")); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
function command(file: string, args: string[], env: NodeJS.ProcessEnv, cwd = root) {
  const child = spawn(process.execPath, [file, ...args], { cwd, env: { ...process.env, ...env }, stdio: "pipe" }); let stdout = "", stderr = "";
  child.stdout.on("data", v => stdout += v); child.stderr.on("data", v => stderr += v);
  const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
  const result = new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => child.on("exit", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); }));
  return { child, result, stdout: () => stdout, stderr: () => stderr };
}
const runtime: Runtime = { protocol: 1, port: 1, token: "a".repeat(64), instance: "b".repeat(32), version: "c".repeat(64), pid: 1 };

test("SSH health records transport failure, clears on HTTP responses and expires cached probes", async t => {
  let mode = "ok", calls = 0;
  const backend = createServer((_req, res) => { calls++; if (mode === "hang") return; res.writeHead(mode === "denied" ? 403 : 200, { "content-type": "application/json" }).end(JSON.stringify(mode === "denied" ? { error: "Denied" } : {})); });
  await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
  const port = (backend.address() as AddressInfo).port;
  const transport = { open: () => connect(port, "127.0.0.1"), close: async () => {} } as unknown as SshTransport;
  const gateway = new SshGateway(transport, { ...runtime, port }, async () => ({ transport, runtime }));
  t.after(async () => { await gateway.close(); backend.closeAllConnections(); backend.close(); });
  mode = "hang"; await assert.rejects(gateway.json("/api/projects", "GET", undefined, 30), /timed out/); assert.match(gateway.error!, /Connection interrupted/);
  mode = "denied"; await assert.rejects(gateway.json("/api/projects"), /Denied/); assert.equal(gateway.error, undefined, "remote permission refusal is not a disconnected computer");
  const before = calls; await Promise.all([gateway.checkHealth(), gateway.checkHealth()]); assert.equal(calls, before, "recent completed traffic supplies health");
  backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve()));
  await assert.rejects(gateway.json("/api/projects")); assert.match(gateway.error!, /Connection interrupted/);
});

test("SSH optional names consistently fall back and persist without truncating explicit names", async t => {
  const home = await scratch(t), manager = new SshProjects({ home, configPath: join(home, "absent-config") }); t.after(() => manager.close());
  assert.equal((await manager.add({ sshHost: "blank", name: "   " })).name, "blank");
  assert.equal((await manager.add({ sshHost: "empty", name: "" })).name, "empty");
  assert.equal((await manager.add({ sshHost: "x".repeat(100) })).name, "x".repeat(80));
  await assert.rejects(manager.add({ sshHost: "too-long", name: "a".repeat(81) }), /at most 80/);
  const restored = new SshProjects({ home, configPath: join(home, "absent-config") }); t.after(() => restored.close()); assert.equal((await restored.list()).hosts.length, 3);
});

test("CLI rejects invalid URL configuration without leaking credentials or stack traces", async t => {
  const home = await scratch(t);
  for (const url of ["http://u:S3cretPw@127.0.0.1:1", "not a url", "ftp://127.0.0.1:1", "127.0.0.1:1", "http://u:S3cretPw@bad host:1"]) {
    const r = await command("scripts/codeflow.mjs", ["status"], { CODEFLOW_HOME: home, CODEFLOW_TOKEN: "qa-token", CODEFLOW_URL: url }).result;
    assert.equal(r.code, 2); assert.equal(r.stderr.trim().split("\n").length, 1); assert.match(r.stderr, /CODEFLOW_URL must be an HTTP\(S\) origin/); assert.doesNotMatch(r.stderr, /S3cretPw| at |ERR_INVALID_URL/);
  }
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve()));
  const r = await command("scripts/codeflow.mjs", ["status"], { CODEFLOW_HOME: home, CODEFLOW_TOKEN: "qa-token", CODEFLOW_URL: `http://127.0.0.1:${port}` }).result;
  assert.equal(r.code, 1); assert.match(r.stderr, /ECONNREFUSED/); assert.match(r.stderr, new RegExp(`contacting http://127.0.0.1:${port}`));
});

test("documentation preview supports an ephemeral port and explains invalid or occupied ports", async t => {
  const home = await scratch(t);
  const running = command("scripts/preview-docs.mjs", [], { CODEFLOW_HOME: home, DOCS_PORT: "0" });
  t.after(async () => { running.child.kill("SIGTERM"); await running.result; });
  for (let i = 0; i < 300 && !running.stdout().includes("Documentation preview:"); i++) { assert.equal(running.child.exitCode, null, running.stderr()); await pause(); }
  const url = running.stdout().match(/Documentation preview: (http:\/\/127.0.0.1:\d+)/)?.[1]; assert.ok(url, running.stderr()); assert.ok(!["4317", "4318"].includes(new URL(url).port));
  const response = await fetch(url); assert.equal(response.status, 200); assert.match(response.headers.get("content-type")!, /text\/html/);
  const collision = await command("scripts/preview-docs.mjs", [], { CODEFLOW_HOME: home, DOCS_PORT: new URL(url).port }).result;
  assert.equal(collision.code, 1); assert.match(collision.stderr, /in use; set DOCS_PORT/); assert.doesNotMatch(collision.stderr, /Unhandled|node:events/);
  const invalid = await command("scripts/preview-docs.mjs", [], { CODEFLOW_HOME: home, DOCS_PORT: "-1" }).result; assert.equal(invalid.code, 2); assert.match(invalid.stderr, /DOCS_PORT must/);
});

test("project-team evaluation writes synthetic results outside a Git checkout", { timeout: 120_000 }, async t => {
  const directory = await scratch(t), copy = join(directory, "source"); await mkdir(copy);
  for (const name of ["src", "scripts", "test/fake-bin", "test/fake-agent.mjs", "test/fake-work.mjs", "test/fake-team-tools.mjs"]) await cp(join(root, name), join(copy, name), { recursive: true });
  await cp(join(root, "package.json"), join(copy, "package.json")); await symlink(join(root, "node_modules"), join(copy, "node_modules"));
  const out = join(directory, "out"), r = await command("--import", ["tsx", "scripts/evaluate-project-teams.ts", "--fake", "--cycles", "1", "--out", out], { CODEFLOW_HOME: join(directory, "outer") }, copy).result;
  assert.equal(r.code, 0, r.stderr); const report = JSON.parse(await readFile(join(out, "report.json"), "utf8")); assert.equal(report.applicationRevision, "unknown"); assert.equal(report.applicationDirty, null); assert.equal(report.cycles.length, 1); assert.equal(report.mode, "fake"); assert.match(r.stderr, /unknown provenance/);
  const real = await command("--import", ["tsx", "scripts/evaluate-project-teams.ts", "--real", "--confirm", "--cycles", "1", "--out", join(directory, "real")], { CODEFLOW_HOME: join(directory, "outer-real") }, copy).result;
  assert.notEqual(real.code, 0); assert.match(real.stderr, /requires a Git checkout/); assert.doesNotMatch(real.stdout, /Completed pilot/);
});
