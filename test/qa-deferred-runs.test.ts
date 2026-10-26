// QA regressions for the deferred queue: composer-shaped null options, retention that keeps
// retryable failures, explicit removal of finished records, and idempotent repeat cancellation.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeferredRuns, DeferredRunConflictError, DEFERRED_RUN_LIMITS, sanitizeDeferredRequest, type DeferredRunJob, type DeferredRunStatus } from "../src/deferred-runs.js";

const directories: string[] = [];
after(() => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))));
const request = () => ({ repo: "/projects/deferred-fixture", project: "p-fixture", pattern: "fixture", task: "Implement the saved behavior", roles: { worker: ["claude"] }, options: {}, loop: { check: "npm test", maxMinutes: 10, maxSteps: 8 } });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "codeflow-qa-deferred-")); directories.push(directory);
  const file = join(directory, "queue.json");
  const queue = new DeferredRuns({ file, ready: async () => ({ ready: true }), launch: async () => ({ runId: "run-fixture" }) });
  await queue.load(); return { queue, file };
}
/** Write a queue whose records are copies of one real saved job with the given states, oldest first. */
async function seed(states: { status: DeferredRunStatus; attempts?: number }[]) {
  const { queue, file } = await fixture();
  const template = await queue.enqueue({ run: request(), notBefore: Date.now() + 60_000 });
  const base = Date.now() - 1_000_000;
  const jobs: DeferredRunJob[] = states.map(({ status, attempts = 0 }, index) => {
    const job: DeferredRunJob = { ...structuredClone(template), id: `d-${randomUUID()}`, name: `${status} ${index}`, status, attempts, createdAt: base + index, updatedAt: base + index, history: [] };
    if (status === "started") Object.assign(job, { claimId: randomUUID(), claimedAt: base, runId: `run-${index}`, attempts: Math.max(attempts, 1) });
    return job;
  });
  await writeFile(file, JSON.stringify({ version: 1, jobs }));
  return { queue, file, jobs };
}

test("composer bodies that send null for 'none' save like POST /api/runs accepts them", () => {
  // runBody() in ui/composer.tsx sends null for the default "Single configured check".
  const run = sanitizeDeferredRequest({ ...request(), loop: { ...request().loop, check: "", setup: "", verification: null, remoteWorker: null, agentContainer: null, contextBudget: null } });
  assert.equal(run.loop.verification, undefined); assert.equal(run.loop.remoteWorker, undefined); assert.equal(run.loop.agentContainer, undefined); assert.equal(run.loop.contextBudget, undefined);
  assert.equal(run.loop.check, undefined, "an empty check uses the project's configured check at launch");
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(run.loop))).sort(), ["copy", "maxMinutes", "maxSteps"]);
  // Malformed values are still refused; only null means "none".
  for (const verification of [{}, "x", 0, false]) assert.throws(() => sanitizeDeferredRequest({ ...request(), loop: { verification } }), /verification profile/i);
  assert.throws(() => sanitizeDeferredRequest({ ...request(), loop: { agentContainer: {} } }), /Docker image/);
  assert.equal(sanitizeDeferredRequest({ ...request(), loop: { verification: { name: "Lightweight", checks: [] } } }).loop.verification!.name, "Lightweight");
});

test("the queue saves a composer-shaped request with a null verification profile", async () => {
  const { queue } = await fixture();
  const job = await queue.enqueue({ run: { ...request(), loop: { ...request().loop, verification: null } }, notBefore: Date.now() + 60_000 });
  assert.equal(job.status, "waiting-time"); assert.equal(job.run.loop.verification, undefined);
});

test("retention removes the oldest finished records and keeps failures you can still retry", async () => {
  const states = [
    { status: "failed" as const, attempts: 1 }, // oldest, but still actionable
    { status: "failed" as const, attempts: 3 }, // exhausted: finished
    ...Array.from({ length: DEFERRED_RUN_LIMITS.retained - 2 }, () => ({ status: "cancelled" as const })),
  ];
  const { queue, jobs } = await seed(states);
  const [retry, exhausted, oldestCancelled] = jobs;
  await queue.enqueue({ run: request(), notBefore: Date.now() + 60_000 });
  let listed = await queue.list();
  assert.equal(listed.length, DEFERRED_RUN_LIMITS.retained);
  assert.ok(listed.some((job) => job.id === retry!.id && job.status === "failed"), "a retryable failure is never evicted");
  assert.ok(!listed.some((job) => job.id === exhausted!.id), "the oldest finished record goes first");
  await queue.enqueue({ run: request(), notBefore: Date.now() + 60_000 });
  listed = await queue.list();
  assert.ok(listed.some((job) => job.id === retry!.id), "still kept ahead of newer cancelled records");
  assert.ok(!listed.some((job) => job.id === oldestCancelled!.id));
  const card = listed.find((job) => job.id === retry!.id)!;
  assert.equal((await queue.retry(card.id, card.revision)).status, "queued", "it is still retryable");
});

test("retryable failures count toward the open-job limit so retention can always drop a finished record", async () => {
  const { queue } = await seed([...Array.from({ length: DEFERRED_RUN_LIMITS.active - 1 }, () => ({ status: "waiting-time" as const })), { status: "failed", attempts: 1 }]);
  await assert.rejects(queue.enqueue({ run: request() }), /queue is full/);
  const failed = (await queue.list()).find((job) => job.status === "failed")!;
  assert.equal((await queue.cancel(failed.id, failed.revision)).status, "cancelled", "a retryable failure can be given up deliberately");
  assert.equal((await queue.enqueue({ run: request(), notBefore: Date.now() + 60_000 })).status, "waiting-time");
});

test("finished records can be removed explicitly; open work and stale revisions are refused without partial removal", async () => {
  const { queue, file, jobs } = await seed([{ status: "cancelled" }, { status: "started" }, { status: "failed", attempts: 3 }, { status: "failed", attempts: 1 }, { status: "waiting-time" }, { status: "queued" }, { status: "unknown", attempts: 1 }]);
  const [cancelled, started, exhausted, retryable, waiting, queued, unknown] = jobs;
  // "unknown" needs a claim to be a valid saved record.
  const stored = JSON.parse(await readFile(file, "utf8")); Object.assign(stored.jobs[6], { claimId: randomUUID(), claimedAt: Date.now() }); await writeFile(file, JSON.stringify(stored));
  for (const open of [retryable, waiting, queued, unknown]) {
    await assert.rejects(queue.remove([{ id: cancelled!.id, expectedRevision: cancelled!.revision }, { id: open!.id, expectedRevision: open!.revision }]), /Only started, cancelled or exhausted/);
  }
  assert.equal((await queue.list()).length, 7, "a refused removal removes nothing");
  await assert.rejects(queue.remove([{ id: cancelled!.id, expectedRevision: cancelled!.revision + 1 }]), DeferredRunConflictError);
  await assert.rejects(queue.remove([{ id: "d-missing", expectedRevision: 1 }]), /not found/);
  await assert.rejects(queue.remove([]), /Choose deferred records/);
  assert.equal(await queue.remove([cancelled!, started!, exhausted!].map((job) => ({ id: job.id, expectedRevision: job.revision }))), 3);
  assert.deepEqual((await queue.list()).map((job) => job.status).sort(), ["failed", "queued", "unknown", "waiting-time"]);
});

test("cancelling an already-cancelled job from a stale view succeeds; other stale actions still conflict", async () => {
  const { queue } = await fixture();
  const job = await queue.enqueue({ run: request(), notBefore: Date.now() + 60_000 });
  const cancelled = await queue.cancel(job.id, job.revision);
  const again = await queue.cancel(job.id, job.revision);
  assert.equal(again.status, "cancelled"); assert.equal(again.revision, cancelled.revision, "a repeat cancel changes nothing");
  await assert.rejects(queue.retry(job.id, job.revision), DeferredRunConflictError);
  const other = await queue.enqueue({ run: request(), notBefore: Date.now() + 60_000 });
  await assert.rejects(queue.cancel(other.id, other.revision + 1), DeferredRunConflictError, "a pending job with a stale revision still conflicts");
});
