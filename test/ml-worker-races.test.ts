import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { control } from "../src/training-worker/main.js";
import { residentRequest, residentStatus } from "../src/training-worker/resident.js";
import { atomic, identity } from "../src/training-worker/files.js";
import type { ServingRelease } from "../src/ml/deployment-model.js";

const originalPath = process.env.PATH;
const realPs = execFileSync("which", ["ps"], { encoding: "utf8" }).trim();
const directories: string[] = [];
const exitedPid = 2147483000;
afterEach(async () => { process.env.PATH = originalPath; await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "codeflow-worker-race-")); directories.push(root);
  const self = (await identity())!;
  const owner = { ...self, pid: exitedPid }, controllerId = randomUUID(), workerId = randomUUID();
  await atomic(join(root, "worker.json"), { version: 1, controllerId, workerId });
  // Publish a final receipt precisely when the liveness check observes exit.
  async function finishDuringProbe(path: string, receipt: unknown, aliveProbes = 0) {
    const bin = join(root, "bin"); await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "ps"), `#!${process.execPath}\n
const fs = require('node:fs'), cp = require('node:child_process'), args = process.argv.slice(2);
if (args[0] === '-p' && args[1] === '${exitedPid}') {
  const counter = ${JSON.stringify(join(root, "probes"))};
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
  fs.writeFileSync(counter, String(n + 1));
  if (n < ${aliveProbes}) { console.log(${JSON.stringify(owner.started)}); process.exit(0); }
  fs.writeFileSync(${JSON.stringify(path + ".final")}, ${JSON.stringify(JSON.stringify(receipt))});
  fs.renameSync(${JSON.stringify(path + ".final")}, ${JSON.stringify(path)});
  process.exit(1);
}
const result = cp.spawnSync(${JSON.stringify(realPs)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 2);
`, { mode: 0o700 });
    process.env.PATH = `${bin}:${originalPath}`;
  }
  async function job() {
    const id = randomUUID(), now = Date.now(), directory = join(root, "jobs", id);
    await atomic(join(directory, "intent.json"), { version: 1, id, workerId, controllerId, bundle: "a".repeat(64), kind: "setup", createdAt: now, deadline: now + 60000, python: process.execPath });
    return { id, directory, status: { id, state: "preparing", updatedAt: now, runner: owner }, request: { action: "inspect", id, workerId, controllerId } };
  }
  return { root, owner, self, controllerId, workerId, finishDuringProbe, job };
}

test("job inspection uses the terminal receipt written while its supervisor exits", async () => {
  const f = await fixture(), job = await f.job(), path = join(job.directory, "status.json");
  await atomic(path, job.status);
  const final = { ...job.status, state: "succeeded", endedAt: Date.now() };
  await f.finishDuringProbe(path, final);
  assert.deepEqual(await control(f.root, job.request), final);
});

test("an admitted supervisor retains its slot before it publishes the first running status", async () => {
  const f = await fixture(), job = await f.job(), status = { id: job.id, state: "submitted", updatedAt: Date.now() };
  await atomic(join(job.directory, "status.json"), status);
  await atomic(join(job.directory, "supervisor.json"), f.self);
  assert.deepEqual(await control(f.root, job.request), status);
});

test("an exit without a terminal receipt remains unknown and cannot be treated as complete", async () => {
  const f = await fixture(), job = await f.job(), path = join(job.directory, "status.json");
  await atomic(path, job.status); await f.finishDuringProbe(path, job.status);
  assert.equal((await control(f.root, job.request) as { state: string }).state, "unknown");
});

async function residentFixture() {
  const f = await fixture();
  const release: ServingRelease = { id: randomUUID(), controllerId: f.controllerId, workerId: f.workerId, bundle: "a".repeat(64), versionId: randomUUID(), recipe: "tabular-autogluon-v1", artifact: { hash: "b".repeat(64), bytes: 10 }, modelHash: "c".repeat(64), trainingBundle: "a".repeat(64), features: ["x"], config: { mode: "persistent", device: "cpu", cpus: 1, timeoutSeconds: 5, maxRows: 1, maxInputTokens: 32, maxNewTokens: 8, memoryMiB: 256, idleSeconds: 10, lifetimeSeconds: 30 } };
  const record = { sessionId: randomUUID(), deploymentId: randomUUID(), revision: 1, release, owner: f.owner, startedAt: Date.now() }, path = join(f.root, "serving/resident.json");
  await atomic(path, record); return { ...f, record, path };
}
test("resident teardown reports its saved model-load failure when the socket disappears during inspection", async () => {
  const f = await residentFixture(), reason = "Fixture model failed to load";
  await f.finishDuringProbe(f.path, { ...f.record, reason }, 1);
  const status = await residentStatus(f.root);
  assert.equal(status.state, "unloaded"); assert.equal(status.reason, reason); assert.equal(status.sessionId, f.record.sessionId);
});

test("resident inspection does not reinterpret a socket failure as completion while its owner is alive", async () => {
  const f = await residentFixture();
  await atomic(f.path, { ...f.record, owner: f.self });
  await assert.rejects(residentStatus(f.root), { code: "ENOENT" });
});

test("a changed resident session cannot be mistaken for the inspected session's final receipt", async () => {
  const f = await residentFixture();
  await f.finishDuringProbe(f.path, { ...f.record, sessionId: randomUUID(), reason: "Another session" }, 1);
  await assert.rejects(residentStatus(f.root), /Resident generation changed/);
});

test("inference polling reports a memory-limit receipt when the resident exits during the request", async () => {
  const f = await residentFixture(), reason = "Serving exceeded its memory limit; resident model released";
  await f.finishDuringProbe(f.path, { ...f.record, reason }, 1);
  await assert.rejects(residentRequest(f.root, "resident-poll", { deploymentId: f.record.deploymentId, requestId: randomUUID(), cursor: 0 }), { message: reason });
});

test("a failed inference poll remains a response failure when the owner is still alive", async () => {
  const f = await residentFixture();
  await atomic(f.path, { ...f.record, owner: f.self });
  await assert.rejects(residentRequest(f.root, "resident-poll", { deploymentId: f.record.deploymentId, requestId: randomUUID(), cursor: 0 }), /Resident worker response failed/);
  await assert.rejects(residentStatus(f.root), { code: "ENOENT" });
});
