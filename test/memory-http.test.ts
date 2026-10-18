import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStore } from "../src/memory.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const token = "memory-test-token";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let child: ChildProcess;
let base: string;
let repo: string;
let projectId: string;
let store: MemoryStore;

async function api(path: string, body?: unknown) {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
}

before(async () => {
  const home = await mkdtemp(join(tmpdir(), "codeflow-memory-http-home-"));
  repo = await realpath(await mkdtemp(join(tmpdir(), "codeflow-memory-http-repo-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  await writeFile(join(repo, "README.md"), "memory\n");
  git("add", ".");
  git("-c", "user.name=test", "-c", "user.email=t@t", "commit", "-qm", "initial");
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
  base = `http://127.0.0.1:${port}`;
  child = spawn(join(root, "node_modules/.bin/tsx"), ["src/server.ts"], {
    cwd: root,
    env: { ...process.env, CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PORT: String(port), PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` },
    stdio: "pipe",
  });
  let output = "";
  child.stdout?.on("data", (data) => { output += String(data); });
  child.stderr?.on("data", (data) => { output += String(data); });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await fetch(`${base}/api/health`, { headers }).then((response) => response.ok, () => false)) break;
    if (attempt === 149 || child.exitCode !== null) throw new Error(`Memory test server did not start: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const project = await api("/api/projects", { name: "Memory tests", repos: [repo] });
  assert.equal(project.status, 201);
  projectId = project.body.id;
  store = new MemoryStore(join(home, "memory.json"));
});

after(async () => {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
});

test("project memory commands use authenticated scope and exact-revision approval", async () => {
  const path = `/api/projects/${projectId}/memory`;
  const candidate = await store.propose({ scope: "project", repo, projectId, title: "External lesson", body: "A proposal from an untrusted issue" }, { kind: "run", repo, projectId, runId: "untrusted-run", lockedDown: true, sourceTrust: "untrusted" });
  const unauthenticated = await fetch(`${base}${path}/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "approve", id: candidate.id, expectedRevision: 1 }) });
  assert.equal(unauthenticated.status, 401);
  const listing = await api(path + `?repo=${encodeURIComponent(repo)}`);
  assert.equal(listing.status, 200);
  assert.equal(listing.body.find((entry: any) => entry.id === candidate.id).status, "proposed");
  const accepted = await api(path + "/commands", { op: "approve", id: candidate.id, expectedRevision: 1, authority: { kind: "run" } });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.acceptedBy, "user");
  assert.ok(accepted.body.origins.some((origin: any) => origin.trust === "untrusted"));
  assert.equal((await api(path + "/commands", { op: "approve", id: candidate.id, expectedRevision: 1 })).status, 409);
});

test("memory routes cannot cross project membership or overwrite scope/provenance from request bodies", async () => {
  const path = `/api/projects/${projectId}/memory`;
  assert.equal((await api(path + "?repo=/outside/project")).status, 400);
  assert.equal((await api(path + "/commands", { op: "create", repo: "/outside/project", title: "X", body: "Y" })).status, 400);
  const created = await api(path + "/commands", { op: "create", repo, title: "User rule", body: "Use explicit interfaces", scope: "private", runId: "spoof", origins: [{ trust: "untrusted" }], verification: { passed: true } });
  assert.equal(created.status, 201);
  assert.equal(created.body.scope, "project");
  assert.equal(created.body.runId, undefined);
  assert.equal(created.body.acceptedBy, "user");
  assert.equal(created.body.verification, undefined);
  const another = await api("/api/projects", { name: "Other project", repos: [repo] });
  assert.equal((await api(`/api/projects/${another.body.id}/memory/commands`, { op: "delete", id: created.body.id, expectedRevision: 1 })).status, 404);
  const revised = await api(path + "/commands", { op: "update", id: created.body.id, expectedRevision: 1, body: "Use explicit public interfaces" });
  assert.equal(revised.status, 200);
  assert.equal(revised.body.revision, 2);
  assert.equal((await api(path + "/commands", { op: "delete", id: created.body.id, expectedRevision: 1 })).status, 409);
  assert.equal((await api(path + "/commands", { op: "delete", id: created.body.id, expectedRevision: 2 })).body.status, "deleted");
  assert.ok(!(await api(path)).body.some((entry: any) => entry.id === created.body.id));
});

test("memory feedback remains user scoped, revision bound, and cannot forge run attribution", async () => {
  const path = `/api/projects/${projectId}/memory/commands`;
  const created = await api(path, { op: "create", repo, title: "Retrieval rule", body: "Prefer explicit interfaces" });
  const id = created.body.id;
  const feedback = await api(path, { op: "feedback", id, expectedRevision: 1, rating: "useful", note: "Useful in this repository" });
  assert.equal(feedback.status, 200);
  assert.equal(feedback.body.revision, 1);
  assert.equal(feedback.body.feedback[0].origin, "user");
  assert.equal((await api(path, { op: "feedback", id, expectedRevision: 1, rating: "useful", runId: "forged-run" })).status, 400);
  assert.equal((await api(path, { op: "feedback", id, expectedRevision: 99, rating: "incorrect" })).status, 409);
});

test("evaluation and rollout API requires evidence and never promotes from a caller's claims", async () => {
  const rollout = await api("/api/team-rollout");
  assert.equal(rollout.status, 200);
  assert.equal(rollout.body.stage, "experimental");
  const reports = await api("/api/team-evaluations");
  assert.deepEqual(reports.body.reports, []);
  assert.equal(reports.body.assessment.eligibleDefault, false);
  assert.equal((await api("/api/team-rollout", { stage: "default", rationale: "Pretend all checks passed", evaluationIds: [] })).status, 400);
  assert.equal((await fetch(`${base}/api/team-rollout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "beta" }) })).status, 401);
  assert.equal((await api("/api/team-rollout", { stage: "experimental", rationale: "Await representative verified comparisons", evaluationIds: [] })).status, 200);
  const capabilities = await api("/api/team-capabilities");
  assert.equal(capabilities.status, 200);
  assert.deepEqual(capabilities.body.map((entry: any) => entry.provider), ["claude", "codex", "agy"]);
  assert.ok(capabilities.body.every((entry: any) => ["tested", "unsupported", "unknown"].includes(entry.scopedTools)));
});
