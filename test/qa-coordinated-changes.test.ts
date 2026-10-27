import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { stat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordinatedChanges, type CoordinatedChangesOptions, type CoordinatedNode, type CoordinationClaim, type CoordinationObservation } from "../src/repo-coordination.js";

const directories: string[] = [];
after(() => Promise.all(directories.map((path) => rm(path, { recursive: true, force: true }))));
const hash = (character: string) => character.repeat(40);
async function fixture(overrides: Partial<CoordinatedChangesOptions> = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-qa-coordination-"))); directories.push(directory);
  const repos = [join(directory, "api"), join(directory, "web")];
  for (const repo of repos) { await mkdir(repo); execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo }); await writeFile(join(repo, "README.md"), "Fixture\n"); execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repo }); }
  let now = Date.now(); const claims: CoordinationClaim[] = [], observations = new Map<string, CoordinationObservation>(), cancellations: string[] = [], shipping: string[] = [], targets = new Map(repos.map((repo) => [repo, hash("b")]));
  const options: CoordinatedChangesOptions = { file: join(directory, "coordinated-changes.json"), now: () => now, pin: async (run) => ({ repo: run.repo, commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: run.repo, encoding: "utf8" }).trim() }), ready: async () => ({ ready: true }), launch: async (run, claim) => { claims.push(claim); const saved = JSON.parse(await readFile(options.file!, "utf8")); const node = saved.jobs.find((job: any) => job.id === claim.jobId).nodes.find((node: any) => node.id === claim.nodeId); assert.equal(node.status, "claimed"); assert.equal(node.claimId, claim.claimId); const runId = `run-${claim.nodeId}-${claim.attempt}`; observations.set(runId, { status: "running" }); return { runId }; }, validateResult: async (node) => observations.get(node.runId!) ?? { status: "missing" }, previewShipping: async (node, into) => ({ source: node.result!.commit, target: targets.get(node.run.repo)!, tree: hash(node.id === "api" ? "c" : "d"), into, verificationId: "actual-merge-fixture", verifiedAt: now }), ship: async (node, validation) => { assert.equal(targets.get(node.run.repo), validation.target); targets.set(node.run.repo, hash(node.id === "api" ? "e" : "f")); shipping.push(node.id); return { commit: targets.get(node.run.repo)! }; }, cancelRun: async (runId) => { cancellations.push(runId); }, ...overrides };
  const service = new CoordinatedChanges(options); await service.load();
  const request = (repo: string) => ({ repo, pattern: "solo", task: "Implement bounded fixture", roles: { agent: ["claude"] }, options: {}, trust: "full", approvals: { tools: true }, loop: { maxSteps: 200, maxInvocations: 200, maxMinutes: 720, copy: [".env"] } });
  const create = (operationId?: string) => service.create({ project: "project-fixture", name: "API and web", nodes: [{ id: "api", run: request(repos[0]!), dependsOn: [] }, { id: "web", run: request(repos[1]!), dependsOn: ["api"] }], ...(operationId ? { operationId } : {}) });
  const latest = async () => (await service.list())[0]!;
  const verify = (node: CoordinatedNode, commit = hash(node.id === "api" ? "a" : "b")) => { observations.set(node.runId!, { status: "verified", runId: node.runId!, repo: node.run.repo, branch: `codeflow/${node.id}`, commit, verificationId: `check-${node.id}-${commit}`, verifiedAt: now }); };
  const tick = async () => { now += 1100; await service.tick(); return latest(); };
  const completed = async () => { await create(); let job = await tick(); verify(job.nodes[0]!); job = await tick(); verify(job.nodes[1]!); return tick(); };
  return { directory, repos, options, service, claims, observations, cancellations, shipping, targets, request, create, latest, verify, tick, completed, advance: (amount: number) => { now += amount; } };
}

test("idle dependency waits preserve revision, history and the storage file", async () => {
  const f = await fixture(); await f.create(); await f.tick(); const first = await f.tick();
  assert.equal(first.nodes[1]!.status, "waiting"); const before = await stat(f.options.file!);
  for (let i = 0; i < 4; i++) { f.advance(5000); const next = await f.tick(); assert.equal(next.revision, first.revision); assert.deepEqual(next.history, first.history); }
  assert.equal((await stat(f.options.file!)).mtimeMs, before.mtimeMs);
  assert.equal((await f.service.cancel(first.id, first.revision)).status, "cancelled");
});

test("a downstream retry cannot clear cancellation while its upstream cannot progress", async () => {
  const f = await fixture(); await f.create(); await f.tick(); let job = await f.tick();
  job = await f.service.cancel(job.id, job.revision); const before = await readFile(f.options.file!, "utf8");
  await assert.rejects(f.service.retryNode(job.id, "web", job.revision), /Retry api first/);
  assert.equal(await readFile(f.options.file!, "utf8"), before);
  job = await f.service.retryNode(job.id, "api", job.revision); assert.equal(job.cancelRequested, false); assert.deepEqual(job.nodes.map(node => node.status), ["pending", "pending"]);
  job = await f.tick(); assert.equal(job.nodes[0]!.status, "running"); assert.equal(job.nodes[0]!.attempts, 2);
});

test("ready cancellation withdraws receipts without cancelling finished runs; siblings retry explicitly", async () => {
  const f = await fixture(); let job = await f.completed(); job = await f.service.previewShipping(job.id, job.revision, { api: "main", web: "main" });
  job = await f.service.cancel(job.id, job.revision); assert.deepEqual(f.cancellations, []); assert.equal(job.shipping, undefined);
  assert.equal(job.history.filter(entry => /Withdrew this verified result/.test(entry.detail)).length, 2);
  assert.ok(job.nodes.every(node => node.result && node.status === "cancelled"));
  const g = await fixture(); let independent = await g.service.create({ project: "project-fixture", name: "Independent", nodes: g.repos.map((repo, i) => ({ id: i ? "web" : "api", run: g.request(repo), dependsOn: [] })) });
  independent = await g.service.cancel(independent.id, independent.revision);
  independent = await g.service.retryNode(independent.id, "api", independent.revision); assert.deepEqual(independent.nodes.map(node => node.status), ["pending", "cancelled"]);
  independent = await g.service.retryNode(independent.id, "web", independent.revision); assert.equal(independent.status, "running"); assert.deepEqual(independent.nodes.map(node => node.status), ["pending", "pending"]);
});

test("invalid startup storage is named, preserved and prevents every dispatch or mutation", async () => {
  for (const malformed of ["truncated", "inconsistent"]) {
    const f = await fixture(); await f.create(); const good = await readFile(f.options.file!, "utf8"), document = JSON.parse(good); document.jobs[0].status = "cancelled";
    const bad = malformed === "truncated" ? '{"version":1,"jobs":[' : JSON.stringify(document); await writeFile(f.options.file!, bad);
    const restart = new CoordinatedChanges(f.options); await assert.rejects(restart.load(), /coordinated-changes.json.*cannot be read/);
    assert.doesNotThrow(() => restart.start(100)); await assert.rejects(restart.list(), /cannot be read/); await assert.rejects(restart.create({ project: "p", name: "blocked", nodes: [] }), /cannot be read/); await restart.stop();
    assert.equal(await readFile(f.options.file!, "utf8"), bad); assert.equal(f.claims.length, 0);
    await writeFile(f.options.file!, good); await assert.rejects(restart.list(), /cannot be read/);
    const recovered = new CoordinatedChanges(f.options); await recovered.load(); assert.equal((await recovered.list()).length, 1); await recovered.stop();
  }
});

test("a moved upstream result blocks already verified downstream evidence too", async () => {
  const f = await fixture(); let job = await f.completed();
  f.observations.set(job.nodes[0]!.runId!, { status: "blocked", reason: "api result changed after it was verified" });
  job = await f.tick(); assert.deepEqual(job.nodes.map(node => node.status), ["blocked", "blocked"]); assert.match(job.nodes[1]!.reason!, /Dependency api/);
  await assert.rejects(f.service.retryNode(job.id, "web", job.revision), /Retry api first/);
  job = await f.service.retryNode(job.id, "api", job.revision); assert.deepEqual(job.nodes.map(node => node.status), ["pending", "pending"]);
});

test("retry rejects an exhausted dependent before invalidating any retained evidence", async () => {
  const f = await fixture(); let job = await f.completed();
  for (let attempt = 1; attempt <= 3; attempt++) {
    f.observations.set(job.nodes[1]!.runId!, { status: "failed", reason: "verification failed" }); job = await f.tick();
    if (attempt < 3) { job = await f.service.retryNode(job.id, "web", job.revision); job = await f.tick(); }
  }
  f.observations.set(job.nodes[0]!.runId!, { status: "blocked", reason: "api branch changed" }); job = await f.tick();
  assert.deepEqual(job.nodes.map(node => node.attempts), [1, 3]); const before = await readFile(f.options.file!, "utf8");
  await assert.rejects(f.service.retryNode(job.id, "api", job.revision), /dependent task reached its three-attempt limit \(3\): web/);
  assert.equal(await readFile(f.options.file!, "utf8"), before);
});
