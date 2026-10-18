import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDeferredRuns, persistDeferredReceipt, recoverDeferredRuns, type DeferredLaunchHost } from "../src/deferred-launch.js";
import { sanitizeDeferredRequest, type DeferredRunRequest } from "../src/deferred-runs.js";
import type { Run, StartRunInput } from "../src/engine.js";

const directories: string[] = [];
after(() => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))));
async function directory() { const value = await mkdtemp(join(tmpdir(), "codeflow-deferred-bridge-")); directories.push(value); return value; }
const request = (): DeferredRunRequest => sanitizeDeferredRequest({ repo: "/project/fixture", project: "p-fixture", pattern: "solo", task: "Build fixture", roles: { agent: ["claude"] }, options: {}, loop: { check: "true" } });
const build = async (run: DeferredRunRequest): Promise<StartRunInput> => ({ ...run, pattern: { id: run.pattern, name: "Fixture", summary: "", description: "", roles: [], options: [], run: async () => "done" }, roles: { agent: ["claude"] } });
function fakeHost() {
  const runs: Run[] = [], inputs: StartRunInput[] = [], cancelled: string[] = [];
  const host: DeferredLaunchHost = { quota: {}, get: (id) => runs.find((run) => run.id === id), list: () => runs, start: async (input) => { inputs.push(input); const run = { id: `run-${inputs.length}`, repo: input.repo, project: input.project, deferred: input.deferred } as Run; runs.push(run); return run; }, cancel: (id) => { cancelled.push(id); return true; } };
  return { host, runs, inputs, cancelled };
}
const resolved = async () => ({ roles: { agent: ["claude" as const] }, installed: new Set(["claude" as const]) });

test("bridge pins unattended policy and launch identity and waits for a durable receipt", async () => {
  const { host, inputs } = fakeHost(); const events: string[] = [];
  const queue = createDeferredRuns(host, { file: join(await directory(), "queue.json"), resolveProviders: resolved, build: async (run) => ({ ...await build(run), trust: "full", allowUntrusted: true, approvals: { tools: true, plan: true }, loop: { copy: [".env"], check: "true" } }), persist: async (run) => { events.push(`persist:${run.id}`); assert.ok(run.deferred); } });
  await queue.load(); const job = await queue.enqueue({ run: request() }); await queue.tick();
  assert.equal(inputs.length, 1); assert.equal(inputs[0]!.trust, "safe"); assert.equal(inputs[0]!.allowUntrusted, false);
  assert.deepEqual(inputs[0]!.approvals, {}); assert.deepEqual(inputs[0]!.loop!.copy, []);
  assert.equal(inputs[0]!.trigger!.via, "deferred"); assert.equal(inputs[0]!.deferred!.jobId, job.id); assert.equal(inputs[0]!.deferred!.attempt, 1);
  assert.deepEqual(events, ["persist:run-1"]); assert.equal((await queue.list())[0]!.status, "started");
});

test("build rejection and missing parents are safe failures, while post-start or persistence errors remain unknown", async () => {
  for (const phase of ["build", "parent", "start", "persist"] as const) {
    const { host, runs, inputs } = fakeHost();
    if (phase === "start") host.start = async (input) => { inputs.push(input); runs.push({ id: "run-side-effect", repo: input.repo, project: input.project, deferred: input.deferred } as Run); throw new Error("Start failed after saving its initial snapshot"); };
    const queue = createDeferredRuns(host, { file: join(await directory(), "queue.json"), resolveProviders: resolved, build: async (run) => { if (phase === "build") throw new Error("Source reference unavailable"); return build(run); }, persist: async () => { if (phase === "persist") throw new Error("Receipt fsync failed"); } });
    await queue.load(); await queue.enqueue({ run: { ...request(), ...(phase === "parent" ? { parentRunId: "missing-parent" } : {}) } }); await queue.tick();
    assert.equal((await queue.list())[0]!.status, phase === "build" || phase === "parent" ? "failed" : "unknown", phase);
    assert.equal(inputs.length, phase === "build" || phase === "parent" ? 0 : 1, phase);
    await queue.tick(); assert.equal(inputs.length, phase === "build" || phase === "parent" ? 0 : 1, "ambiguous launch never repeats automatically");
  }
});

test("startup reconciliation requires one exact durable claim in the same repository and project", async () => {
  const { host, runs } = fakeHost(); const saved: string[] = [];
  const originalStart = host.start;
  host.start = async (input) => { await originalStart(input); throw new Error("Receipt lost"); };
  const queue = createDeferredRuns(host, { file: join(await directory(), "queue.json"), resolveProviders: resolved, build, persist: async () => {} });
  await queue.load(); await queue.enqueue({ run: request() }); await queue.tick();
  const job = (await queue.list())[0]!, actual = runs[0]!;
  const persist = async (run: Pick<Run, "id">) => { saved.push(run.id); };
  for (const mutation of [{ repo: "/other" }, { project: "other-project" }, { deferred: { ...actual.deferred!, claimId: "other-claim" } }, { deferred: { ...actual.deferred!, attempt: 2 } }]) {
    runs[0] = { ...actual, ...mutation }; await recoverDeferredRuns(queue, host, persist); assert.equal((await queue.list())[0]!.status, "unknown");
  }
  runs[0] = actual; runs.push({ ...actual, id: "run-duplicate-identity" }); await recoverDeferredRuns(queue, host, persist);
  assert.equal((await queue.list())[0]!.status, "unknown"); runs.pop();
  await recoverDeferredRuns(queue, host, persist); assert.equal((await queue.list())[0]!.status, "started"); assert.deepEqual(saved, [actual.id]);
  assert.equal((await queue.list())[0]!.claimId, job.claimId);
});

test("startup recovery of a cancellation claim sends cancellation and never revives it as started", async () => {
  const { host, runs, cancelled } = fakeHost(); const originalStart = host.start;
  host.start = async (input) => { await originalStart(input); throw new Error("Receipt lost"); };
  const file = join(await directory(), "queue.json");
  const queue = createDeferredRuns(host, { file, resolveProviders: resolved, build, persist: async () => {} }); await queue.load(); await queue.enqueue({ run: request() }); await queue.tick();
  const stored = JSON.parse(await readFile(file, "utf8")); stored.jobs[0].cancelRequested = true; await writeFile(file, JSON.stringify(stored));
  const recovered = createDeferredRuns(host, { file, resolveProviders: resolved, build, persist: async () => {} }); await recovered.load(); await recoverDeferredRuns(recovered, host, async () => {});
  assert.equal((await recovered.list())[0]!.status, "cancelled"); assert.equal((await recovered.list())[0]!.runId, runs[0]!.id); assert.deepEqual(cancelled, [runs[0]!.id]);
});

test("strict receipt persistence requires a complete matching first run snapshot and rejects symlinked logs", async () => {
  const folder = await directory();
  const run = { id: "run-fixture", repo: "/project/fixture", deferred: { jobId: "job", claimId: "claim", attempt: 1 } };
  const file = join(folder, `${run.id}.jsonl`);
  await writeFile(file, JSON.stringify({ type: "run", run }) + "\n", { mode: 0o600 }); await persistDeferredReceipt(run, folder);
  for (const body of ["", JSON.stringify({ type: "run", run }), JSON.stringify({ type: "run", run: { ...run, deferred: { ...run.deferred, claimId: "forged" } } }) + "\n", JSON.stringify({ type: "agent" }) + "\n" + JSON.stringify({ type: "run", run }) + "\n"]) {
    await writeFile(file, body); await assert.rejects(persistDeferredReceipt(run, folder));
  }
  await rm(file); const other = join(folder, "other.jsonl"); await writeFile(other, JSON.stringify({ type: "run", run }) + "\n"); await symlink(other, file); await assert.rejects(persistDeferredReceipt(run, folder));
});
