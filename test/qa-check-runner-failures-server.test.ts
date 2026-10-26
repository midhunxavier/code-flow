// QA regressions for the check runner's HTTP surface on a real server with fake agents: slot
// limits read once at start warn about values they ignore, and an invalid package.json is a
// detection warning, not a 500. Never ports 4317/4318.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const token = "qa-check-runner-server";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", connection: "close" };
const folders: string[] = [];
let child: ChildProcess, base = "", output = "";

const freePort = async (): Promise<number> => {
  for (;;) {
    const port = await new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as AddressInfo; probe.close(() => resolve(port)); }); });
    if (port !== 4317 && port !== 4318) return port;
  }
};
function gitRepo(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), "codeflow-qa-check-runner-server-repo-")); folders.push(repo);
  for (const [path, body] of Object.entries(files)) writeFileSync(join(repo, path), body);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  return repo;
}
const get = async (path: string) => { const response = await fetch(base + path, { headers }); return { status: response.status, body: await response.json() as any }; };

before(async () => {
  const home = mkdtempSync(join(tmpdir(), "codeflow-qa-check-runner-server-home-")); folders.push(home);
  const port = await freePort(), remote = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_REMOTE_PORT: String(remote), CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, CODEFLOW_MAX_AGENTS: "30m", CODEFLOW_MAX_CHECKS: "2.5", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await fetch(base + "/api/health", { headers }).then((response) => response.ok, () => false)) return;
    if (child.exitCode !== null) throw new Error(`server exited: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not start: ${output}`);
});
after(async () => {
  if (child.exitCode === null) { child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)); }
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

test("invalid slot limits fall back to their defaults with a warning", async () => {
  assert.match(output, /ignoring CODEFLOW_MAX_AGENTS="30m" \(must be a whole number, at least 1\); using 6/);
  assert.match(output, /ignoring CODEFLOW_MAX_CHECKS="2.5" \(must be a whole number, at least 1\); using 3/);
  const { body } = await get("/api/health");
  assert.equal(body.busy.agents.max, 6);
  assert.equal(body.busy.checks.max, 3);
});

test("an invalid package.json is a detection warning, and other runners are still found", async () => {
  const broken = gitRepo({ "package.json": "{ not json" });
  const alone = await get(`/api/check?repo=${encodeURIComponent(broken)}`);
  assert.equal(alone.status, 200);
  assert.deepEqual(alone.body, { command: null, warning: "package.json is not valid JSON, so its test script was skipped" });
  const withMake = await get(`/api/check?repo=${encodeURIComponent(gitRepo({ "package.json": "{ not json", Makefile: "test:\n\techo ok\n" }))}`);
  assert.equal(withMake.status, 200);
  assert.equal(withMake.body.command, "make test");
  assert.match(withMake.body.warning, /not valid JSON/);
  const readiness = await fetch(`${base}/api/readiness`, { method: "POST", headers, body: JSON.stringify({ repo: broken }) });
  assert.equal(readiness.status, 200, "readiness answers for the rest of the repository");
  assert.ok(((await readiness.json()) as { items: { id: string }[] }).items.some((item) => item.id === "git"));
  assert.doesNotMatch(output, /GET \/api\/check failed/);
});
