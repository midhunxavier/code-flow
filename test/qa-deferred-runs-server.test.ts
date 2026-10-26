// QA regressions for the deferred-runs HTTP surface on real servers with fake agents: an unreadable
// queue file disables only deferred runs, composer-shaped requests save, AI team is refused
// instead of silently dropped, and finished records can be removed. Never ports 4317/4318.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeferredRunJob } from "../src/deferred-runs.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const token = "qa-deferred-server";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", connection: "close" };
interface Instance { base: string; home: string; child: ChildProcess; output: () => string }
const instances: Instance[] = [];
let directory: string, repo: string;

const freePort = async (): Promise<number> => {
  for (;;) {
    const port = await new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as AddressInfo; probe.close(() => resolve(port)); }); });
    if (port !== 4317 && port !== 4318) return port;
  }
};
async function start(name: string, files: Record<string, string> = {}): Promise<Instance> {
  const home = join(directory, name); await mkdir(home, { recursive: true });
  for (const [file, body] of Object.entries(files)) await writeFile(join(home, file), body, { mode: 0o600 });
  const port = await freePort(), remote = await freePort(), base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_REMOTE_PORT: String(remote), CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  let output = ""; child.stdout?.on("data", (chunk) => { output += String(chunk); }); child.stderr?.on("data", (chunk) => { output += String(chunk); });
  const instance = { base, home, child, output: () => output }; instances.push(instance);
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await fetch(base + "/api/health", { headers }).then((response) => response.ok, () => false)) return instance;
    if (child.exitCode !== null) throw new Error(`${name} server exited: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${name} server did not start: ${output}`);
}
async function call(instance: Instance, path: string, body?: unknown) {
  const response = await fetch(instance.base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
}

before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-qa-deferred-server-"))); repo = join(directory, "repo"); await mkdir(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "Deferred QA fixture\n");
  execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repo });
});
after(async () => {
  await Promise.all(instances.map((instance) => new Promise<void>((resolve) => { if (instance.child.exitCode !== null) return resolve(); const timer = setTimeout(() => { instance.child.kill("SIGKILL"); resolve(); }, 5000); instance.child.once("exit", () => { clearTimeout(timer); resolve(); }); instance.child.kill("SIGTERM"); })));
  await rm(directory, { recursive: true, force: true });
});

for (const [label, corrupt, reason] of [["an unsupported version", '{"version":2,"jobs":[]}', /invalid document/], ["truncated JSON", '{"version":1,"jobs":[{"id":"oops"', /JSON/]] as const) {
  test(`a deferred queue file with ${label} disables only deferred runs and is preserved for repair`, { timeout: 60_000 }, async () => {
    const instance = await start(`corrupt-${label.replace(/\W+/g, "-")}`, { "deferred-runs.json": corrupt });
    assert.equal((await call(instance, "/api/projects")).status, 200, "the rest of the application keeps serving");
    const listed = await call(instance, "/api/deferred-runs");
    assert.equal(listed.status, 503); assert.match(listed.body.error, /Deferred queue cannot be read/); assert.match(listed.body.error, reason); assert.match(listed.body.error, /deferred-runs\.json and restart/);
    for (const [path, body] of [["/api/deferred-runs", { run: { repo, pattern: "solo", task: "Queued while broken", roles: { agent: ["claude"] } } }], ["/api/deferred-runs/d-00000000-0000-0000-0000-000000000000/cancel", { expectedRevision: 1 }], ["/api/deferred-runs/remove", { jobs: [] }]] as const) {
      assert.equal((await call(instance, path, body)).status, 503, `${path} is refused while the queue is unavailable`);
    }
    assert.equal(await readFile(join(instance.home, "deferred-runs.json"), "utf8"), corrupt, "the unreadable file is never rewritten");
    for (let poll = 0; poll < 5; poll++) assert.equal((await call(instance, "/api/deferred-runs")).status, 503, "polls keep the same answer");
    assert.match(instance.output(), /Deferred runs disabled/); assert.doesNotMatch(instance.output(), /Uncaught/);
    assert.equal(instance.output().match(/Deferred queue cannot be read/g)?.length, 1, "the read error is logged once at startup");
    assert.doesNotMatch(instance.output(), /\/api\/deferred-runs\S* failed/, "refused deferred requests do not log the same fault again");
  });
}

test("composer-shaped requests save, AI team is refused instead of dropped, and finished records can be removed", { timeout: 60_000 }, async () => {
  const instance = await start("healthy");
  const project = (await call(instance, "/api/projects", { name: "Deferred QA", repos: [repo] })).body.id;
  const team = { enabled: true, preset: "adaptive", coordinator: "claude", providers: ["claude", "codex"], settings: {}, maxMembers: 4, maxCalls: 20, maxMinutes: 30, approvePlan: false };
  // The body runBody() in ui/composer.tsx builds with the default "Single configured check" (older clients send null).
  const composer = { repo, project, projectSelection: "explicit", task: "Deferred from the composer", pattern: "solo", taskTeam: { ...team, enabled: false }, roles: { agent: ["claude"] }, options: {}, baseRef: "", branchPrefix: "", context: { paths: [], attachments: [] }, agentSettings: { claude: {} }, approvals: { plan: false, tools: false }, trust: "standard", permissionRequirements: [], antigravityExecution: "isolated", roleSettings: {}, loop: { check: "", setup: "", maxMinutes: 240, maxSteps: 200, verification: null } };
  const saved = await call(instance, "/api/deferred-runs", { run: composer, notBefore: Date.now() + 60 * 60_000, waitForProviders: [] });
  assert.equal(saved.status, 201, JSON.stringify(saved.body)); assert.equal(saved.body.status, "waiting-time"); assert.equal(saved.body.run.loop.verification, undefined);

  for (const [path, body] of [["/api/deferred-runs", { run: { ...composer, taskTeam: team }, notBefore: Date.now() + 60_000 }], ["/api/automations", { name: "Team nightly", run: { ...composer, taskTeam: team }, webhook: true }]] as const) {
    const refused = await call(instance, path, body);
    assert.equal(refused.status, 400, path); assert.match(refused.body.error, /AI team works only in a live Agent conversation/);
  }
  assert.equal((await call(instance, "/api/automations")).body.length, 0, "nothing is saved without the team");
  assert.equal((await call(instance, "/api/automations", { name: "One agent nightly", run: composer, webhook: true })).status, 201, "a switched-off AI team needs no change");

  // A stale second cancel (another tab) already has its outcome.
  const job = saved.body as DeferredRunJob;
  const first = await call(instance, `/api/deferred-runs/${job.id}/cancel`, { expectedRevision: job.revision });
  const second = await call(instance, `/api/deferred-runs/${job.id}/cancel`, { expectedRevision: job.revision });
  assert.equal(first.status, 200); assert.equal(second.status, 200); assert.equal(second.body.status, "cancelled"); assert.equal(second.body.revision, first.body.revision);

  const waiting = (await call(instance, "/api/deferred-runs", { run: composer, notBefore: Date.now() + 60_000 })).body as DeferredRunJob;
  const refused = await call(instance, "/api/deferred-runs/remove", { jobs: [{ id: waiting.id, expectedRevision: waiting.revision }] });
  assert.equal(refused.status, 400); assert.match(refused.body.error, /cancel or resolve this job first/);
  const removed = await call(instance, "/api/deferred-runs/remove", { jobs: [{ id: job.id, expectedRevision: first.body.revision }] });
  assert.equal(removed.status, 200); assert.deepEqual(removed.body, { removed: 1 });
  assert.deepEqual((await call(instance, "/api/deferred-runs")).body.map((item: DeferredRunJob) => item.id), [waiting.id]);
  assert.equal((await call(instance, "/api/runs")).body.length, 0, "nothing launched");
});
