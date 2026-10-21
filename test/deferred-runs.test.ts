import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeferredRuns, DeferredRunConflictError, DeferredRunRejectedError, DEFERRED_RUN_LIMITS, deferredProviderReadiness, sanitizeDeferredRequest, type DeferredRunsOptions, type DeferredRunJob } from "../src/deferred-runs.js";

const directories: string[] = [];
after(() => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))));
const request = () => ({ repo: "/projects/deferred-fixture", project: "p-fixture", pattern: "fixture", task: "Implement the saved behavior", roles: { worker: ["claude"] }, options: {}, loop: { check: "npm test", maxMinutes: 10, maxSteps: 8 } });
async function fixture(options: Partial<DeferredRunsOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "codeflow-deferred-")); directories.push(directory);
  const file = join(directory, "queue.json");
  const queue = new DeferredRuns({ file, ready: async () => ({ ready: true }), launch: async () => ({ runId: "run-fixture" }), ...options });
  await queue.load(); return { queue, file, directory };
}
const latest = async (queue: DeferredRuns) => (await queue.list())[0]!;
async function until(condition: () => Promise<boolean> | boolean) { const end = Date.now() + 5000; while (!(await condition())) { if (Date.now() > end) throw new Error("Timed out waiting for deferred queue fixture"); await new Promise((resolve) => setTimeout(resolve, 5)); } }

test("saved requests preserve full bounded configuration and references while capping unattended authority", () => {
  const run = sanitizeDeferredRequest({ ...request(), roles: { worker: ["auto"], reviewer: ["codex"] }, trust: "full", allowUntrusted: true, approvals: { plan: true, tools: true }, loop: { ...request().loop, copy: [".env"], container: { image: "checks:local", network: false }, agentContainer: { image: "agents:local", authVolume: "agent-login" }, verification: { name: "quality", checks: [{ id: "type", kind: "typecheck", command: "npm run typecheck", required: true, timeoutMs: 1000 }] } }, agentSettings: { claude: { model: "fixture-model", effort: "high" } }, source: { kind: "pr", number: 42, ciLogs: true }, context: { paths: [{ path: "src/config.ts" }], attachments: [] } });
  assert.equal(run.trust, "safe"); assert.equal(run.allowUntrusted, false);
  assert.deepEqual(run.approvals, { plan: false, tools: false }); assert.deepEqual(run.loop.copy, []);
  assert.deepEqual(run.roles.worker, ["auto"]); assert.equal(run.loop.verification!.checks[0]!.command, "npm run typecheck");
  assert.deepEqual(run.source, { kind: "pr", number: 42, ciLogs: true });
  assert.deepEqual(run.context, { paths: [{ path: "src/config.ts" }] });
  assert.equal(sanitizeDeferredRequest({ ...request(), externalSourceRef: { integration: "linear-team", kind: "issue", key: "TEAM-1" } }).externalSourceRef!.key, "TEAM-1");
  assert.deepEqual(sanitizeDeferredRequest({ ...request(), loop: { remoteWorker: { workerId: "worker", repoMapping: "project" } } }).loop.remoteWorker, { workerId: "worker", repoMapping: "project" });
  assert.throws(() => sanitizeDeferredRequest({ ...request(), loop: { remoteWorker: { workerId: "worker", repoMapping: "project", sshHost: "forged" } } }));
  for (const extra of [{ externalSource: { body: "forged", trusted: true } }, { source: { kind: "issue", number: 1, trusted: true } }, { trigger: { via: "manual" } }, { context: { paths: [], attachments: [{ name: "secret", data: "eA==" }] } }, { context: { paths: [{ path: "../secret" }] } }, { loop: { container: { image: "checks", readOnly: ["/Users/me/.codex"] } } }]) assert.throws(() => sanitizeDeferredRequest({ ...request(), ...extra }));
});

test("provider readiness respects actual reset windows and never claims unknown reset estimates as reset times", () => {
  const now = 1_000_000;
  const quota = { claude: { status: "limited", at: now, windows: { weekly: { resetsAt: now + 5000 }, daily: { resetsAt: now + 2000 } } }, codex: { status: "allowed", at: now, windows: { primary: { utilization: 0.95, resetsAt: now + 3000 } } } };
  assert.equal(deferredProviderReadiness(["claude", "codex"], quota, undefined, now).retryAt, now + 5000);
  assert.equal(deferredProviderReadiness(["claude", "codex"], quota, undefined, now + 5001).ready, true);
  const unknown = deferredProviderReadiness(["agy"], { agy: { status: "limited", at: now, windows: {} } }, undefined, now);
  assert.equal(unknown.ready, false); assert.equal(unknown.retryAt, now + 60_000);
  assert.match(unknown.reason!, /usage limit/); assert.doesNotMatch(unknown.reason!, /resets at/);
  assert.match(deferredProviderReadiness(["claude"], {}, new Set(), now).reason!, /not installed/);
});

test("deferred requests retain strict project selection across persistence and reject invalid authority", async () => {
  const run = { ...request(), projectSelection: "explicit" };
  const { queue, file } = await fixture();
  await queue.enqueue({ run, notBefore: Date.now() + 60_000 });
  const restored = new DeferredRuns({ file, ready: async () => ({ ready: true }), launch: async () => ({ runId: "unused" }) });
  await restored.load();
  assert.equal((await latest(restored)).run.projectSelection, "explicit");
  for (const change of [{ project: "" }, { projectSelection: "legacy" }, { requireProjectRepo: true }]) {
    assert.throws(() => sanitizeDeferredRequest({ ...run, ...change }));
  }
});

test("earliest start and provider waits survive reconstruction and launch only when both conditions hold", async () => {
  let now = Date.now(), checks = 0, launches = 0;
  const resetsAt = now + 3000;
  const ready: DeferredRunsOptions["ready"] = async (_run, providers) => { checks++; return deferredProviderReadiness(providers, { claude: { status: "limited", at: resetsAt - 3000, windows: { quota: { resetsAt } } } }, undefined, now); };
  const { queue, file } = await fixture({ now: () => now, ready, launch: async () => { launches++; return { runId: "run-ready" }; } });
  await queue.enqueue({ run: request(), notBefore: now + 1000, waitForProviders: ["claude"] });
  await queue.tick(); assert.equal(checks, 0); assert.equal((await latest(queue)).status, "waiting-time");
  now += 1500; await queue.tick(); assert.equal(checks, 1); assert.equal(launches, 0); assert.equal((await latest(queue)).status, "waiting-provider");
  const restored = new DeferredRuns({ file, now: () => now, ready, launch: async () => { launches++; return { runId: "run-ready" }; } }); await restored.load();
  await restored.tick(); assert.equal(checks, 1, "a future reported reset avoids repeated readiness work");
  now = resetsAt + 1; await restored.tick(); assert.equal(launches, 1); assert.equal((await latest(restored)).status, "started");
  await restored.tick(); assert.equal(launches, 1);
});

test("concurrent ticks and queue instances make one durable claim before invoking launch", async () => {
  let release!: () => void, calls = 0;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let file: string;
  const launch: DeferredRunsOptions["launch"] = async (_run, claim) => {
    calls++;
    const persisted = JSON.parse(await readFile(file, "utf8")).jobs[0] as DeferredRunJob;
    assert.equal(persisted.status, "claimed"); assert.equal(persisted.claimId, claim.claimId); assert.equal(persisted.id, claim.jobId); assert.equal(claim.attempt, 1);
    return { runId: "run-once" };
  };
  const first = await fixture({ ready: async () => { await barrier; return { ready: true }; }, launch }); file = first.file;
  const second = new DeferredRuns({ file, ready: async () => { await barrier; return { ready: true }; }, launch }); await second.load();
  await first.queue.enqueue({ run: request() });
  const one = first.queue.tick(), duplicateTick = first.queue.tick(), two = second.tick();
  assert.equal(one, duplicateTick); release(); await Promise.all([one, two]);
  assert.equal(calls, 1); assert.equal((await latest(first.queue)).runId, "run-once");
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("a real process exit after claim loads unknown and never automatically launches again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codeflow-deferred-crash-")); directories.push(directory);
  const file = join(directory, "queue.json");
  const module = new URL("../src/deferred-runs.ts", import.meta.url).href;
  const script = `import {DeferredRuns} from ${JSON.stringify(module)}; const queue=new DeferredRuns({file:${JSON.stringify(file)},ready:async()=>({ready:true}),launch:async()=>process.exit(23)}); await queue.load(); await queue.enqueue({run:${JSON.stringify(request())}}); await queue.tick();`;
  const code = await new Promise<number | null>((resolve, reject) => { const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] }); let error = ""; child.stderr.on("data", (data) => { error += data; }); child.on("error", reject); child.on("exit", (code) => code === 23 ? resolve(code) : reject(new Error(error))); });
  assert.equal(code, 23); assert.equal(JSON.parse(await readFile(file, "utf8")).jobs[0].status, "claimed");
  let launches = 0; const restored = new DeferredRuns({ file, ready: async () => ({ ready: true }), launch: async () => { launches++; return { runId: "duplicate" }; } });
  await restored.load(); const job = await latest(restored); assert.equal(job.status, "unknown"); assert.ok(job.claimId);
  await restored.tick(); assert.equal(launches, 0);
  await assert.rejects(restored.retry(job.id, job.revision), /acknowledge/);
  const linked = await restored.attach(job.id, job.revision, "run-existing-matching-claim"); assert.equal(linked.status, "started");
  await assert.rejects(restored.cancel(job.id, job.revision), DeferredRunConflictError);
});

test("known rejections require explicit retry, ambiguous failures require acknowledgement, and attempt limits hold", async () => {
  let calls = 0;
  const { queue } = await fixture({ launch: async () => { calls++; if (calls === 1) throw new DeferredRunRejectedError("Missing parent run"); throw new Error("Lost receipt after starting"); } });
  await queue.enqueue({ run: request() }); await queue.tick(); let job = await latest(queue);
  assert.equal(job.status, "failed"); await queue.tick(); assert.equal(calls, 1);
  job = await queue.retry(job.id, job.revision); await queue.tick(); job = await latest(queue);
  assert.equal(job.status, "unknown"); await assert.rejects(queue.retry(job.id, job.revision), /acknowledge/);
  await queue.retry(job.id, job.revision, { acknowledgeUnknown: true }); await queue.tick(); job = await latest(queue);
  assert.equal(job.attempts, 3); assert.equal(calls, 3);
  await assert.rejects(queue.retry(job.id, job.revision, { acknowledgeUnknown: true }), /attempt limit/);
});

test("cancelling before and during readiness prevents launch without consuming an attempt", async () => {
  let entered = false, launches = 0;
  const { queue } = await fixture({ ready: async (_run, _providers, signal) => { entered = true; await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })); return { ready: true }; }, launch: async () => { launches++; return { runId: "unexpected" }; } });
  let job = await queue.enqueue({ run: request() }); const checking = queue.tick(); await until(() => entered);
  job = await queue.cancel(job.id, job.revision); await checking;
  assert.equal(job.status, "cancelled"); assert.equal((await latest(queue)).attempts, 0); assert.equal(launches, 0);
  const future = await queue.enqueue({ run: request(), notBefore: Date.now() + 60_000 }); await queue.cancel(future.id, future.revision); await queue.tick(); assert.equal(launches, 0);
});

test("launch cancellation preserves unknown outcome and a late receipt reaches run cancellation", async () => {
  let complete!: (value: { runId: string }) => void;
  const cancelled: string[] = [];
  const { queue } = await fixture({ launch: async () => new Promise((resolve) => { complete = resolve; }), cancelRun: async (id) => { cancelled.push(id); } });
  await queue.enqueue({ run: request() }); const ticking = queue.tick(); await until(() => !!complete);
  let job = await latest(queue); await queue.cancel(job.id, job.revision); await ticking;
  job = await latest(queue); assert.equal(job.status, "unknown"); assert.equal(job.cancelRequested, true);
  complete({ runId: "run-late-cancel" }); await until(async () => (await latest(queue)).runId === "run-late-cancel" && cancelled.length === 1);
  assert.deepEqual(cancelled, ["run-late-cancel"]); assert.equal((await latest(queue)).status, "unknown", "cancellation request is distinct from a confirmed stopped run");
});

test("launch timeout never retries automatically and receipts from an earlier attempt remain discoverable", async () => {
  let firstReceipt!: (value: { runId: string }) => void, calls = 0;
  const { queue } = await fixture({ launchTimeoutMs: 20, launch: async () => ++calls === 1 ? new Promise((resolve) => { firstReceipt = resolve; }) : { runId: "run-second" } });
  await queue.enqueue({ run: request() }); await queue.tick(); let job = await latest(queue);
  assert.equal(job.status, "unknown"); const oldClaim = job.claimId;
  await queue.tick(); assert.equal(calls, 1);
  await queue.retry(job.id, job.revision, { acknowledgeUnknown: true }); await queue.tick(); job = await latest(queue);
  assert.equal(job.runId, "run-second"); assert.notEqual(job.claimId, oldClaim);
  firstReceipt({ runId: "run-first-late" }); await until(async () => (await latest(queue)).history.some((event) => event.runId === "run-first-late"));
  job = await latest(queue); assert.equal(job.runId, "run-second"); assert.equal(job.status, "started");
  assert.ok(job.history.some((event) => event.claimId === oldClaim && event.runId === "run-first-late"));
});

test("failed claim persistence never launches, queue failures recover, and corrupt files remain untouched", async () => {
  let launches = 0, disrupt = true;
  const directory = await mkdtemp(join(tmpdir(), "codeflow-deferred-io-")); directories.push(directory);
  const file = join(directory, "queue.json"), backup = join(directory, "backup.json");
  const queue = new DeferredRuns({ file, ready: async () => { if (disrupt) { disrupt = false; await rename(file, backup); await mkdir(file); } return { ready: true }; }, launch: async () => { launches++; return { runId: "run-after-repair" }; } });
  await queue.load(); await queue.enqueue({ run: request() }); await assert.rejects(queue.tick(), /cannot be read/); assert.equal(launches, 0);
  await rm(file, { recursive: true }); await rename(backup, file); await queue.tick(); assert.equal(launches, 1);
  const corrupt = '{"version":99,"jobs":[]}'; await writeFile(file, corrupt);
  await assert.rejects(queue.enqueue({ run: request() }), /cannot be read/); assert.equal(await readFile(file, "utf8"), corrupt);
  await writeFile(file, '{"version":1,"jobs":[]}'); assert.equal((await queue.enqueue({ run: request() })).status, "queued");
});

test("explicit enqueue retries deduplicate, stale actions conflict, active jobs and history are bounded", async () => {
  let calls = 0;
  const { queue } = await fixture({ ready: async () => ({ ready: false, reason: `Quota observation ${++calls}` }) });
  const input = { run: request(), operationId: "same-click" };
  const first = await queue.enqueue(input), replay = await queue.enqueue(input); assert.equal(first.id, replay.id);
  await assert.rejects(queue.enqueue({ ...input, run: { ...request(), task: "different" } }), /different content/);
  for (let index = 0; index < 40; index++) await queue.tick(true);
  let job = await latest(queue); assert.equal(job.history.length, DEFERRED_RUN_LIMITS.history);
  await assert.rejects(queue.cancel(first.id, first.revision), DeferredRunConflictError);
  for (let index = 1; index < DEFERRED_RUN_LIMITS.active; index++) await queue.enqueue({ run: request() });
  await assert.rejects(queue.enqueue({ run: request() }), /queue is full/);
  job = (await queue.list()).find((job) => job.id === first.id)!; await queue.cancel(job.id, job.revision);
  assert.equal((await queue.enqueue({ run: request() })).status, "queued");
});
