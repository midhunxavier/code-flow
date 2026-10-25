import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MlService } from "../src/ml/service.js";
import { hash } from "../src/training-worker/files.js";
import { LLM_RECIPE, RECIPE, type Experiment, type Intent, type Target } from "../src/ml/model.js";
import type { WorkerClient } from "../src/ml/transport.js";
import { promotionHealth, promotionLimits } from "../src/ml/promotion-model.js";
let directory: string;
before(async () => { directory = await mkdtemp(join(tmpdir(), "codeflow-promotion-test-")); execFileSync(process.execPath, ["scripts/build-training-worker.mjs"]); });
after(async () => { await rm(directory, { recursive: true, force: true }); });
const health = { windowSeconds: 60, minRequests: 10, minSamples: 20, consecutiveWindows: 2, maxErrorRate: .2, maxLatencyMs: 1000, driftThreshold: 1, cooldownSeconds: 60, maxActions: 1 };
const limits = { minImprovement: .01, maxAttempts: 2, cooldownSeconds: 60, approvalSeconds: 3600, observationSeconds: 180 };
async function fixture(llm = false) {
  const home = join(directory, randomUUID()); await mkdir(home);
  let now = Date.now(), enabled = true, permitted = true, score = llm ? 1.5 : .7, data = "original", failLoad = false, loads = 0;
  let prepareHook: (() => Promise<void>) | undefined;
  const workers = new Map<string, string>(), artifacts = new Map<string, Buffer>();
  const transport: WorkerClient = { close: async () => {}, call: async <T>(target: Target, r: Record<string, any>): Promise<T> => {
    const workerId = workers.get(target.id) ?? randomUUID(); workers.set(target.id, workerId);
    if (["probe", "enroll"].includes(r.action)) return { protocol: 1, workerId, commonHoldout: 1, boundedSearch: 1, dataWatch: 1, serving: 1, cpus: 4, ready: true, recipes: [{ id: LLM_RECIPE, ready: true, devices: ["cpu"] }], gpus: [] } as T;
    if (r.action === "snapshot") return { id: hash(data), hash: hash(data), bytes: data.length, format: llm ? "jsonl" : "csv", ...(llm ? { schema: "prompt-completion" } : {}), rows: 100, columns: llm ? ["prompt", "completion"] : ["x", "target"], missing: llm ? { prompt: 0, completion: 0 } : { x: 0, target: 0 }, duplicateRows: 0 } as T;
    if (r.action === "submit") {
      const input = r.intent as Intent;
      if (input.kind === "holdout") return { id: input.id, state: "succeeded", updatedAt: Date.now(), endedAt: Date.now(), holdout: { version: 1, datasetHash: input.dataset!.hash, candidateHash: input.holdout!.candidate.artifact.hash, incumbentHash: input.holdout!.incumbent.artifact.hash, evaluator: input.bundle, populationHash: hash("common-population"), rows: input.dataset!.rows, metric: llm ? "completion_nll" : "accuracy", direction: llm ? "lower" : "higher", baseline: llm ? 2 : .5, incumbent: llm ? 1.5 : .7, candidate: score, ...(llm ? { tokens: 200 } : {}) } } as T;
      if (input.kind === "model") return { id: input.id, state: "succeeded", updatedAt: Date.now(), model: { hash: hash("base"), bytes: 1000, parameters: 1000, architecture: "llama", contextLength: 512, files: 4 } } as T;
      const bytes = Buffer.from(`export ${input.id}`); artifacts.set(input.id, bytes);
      return { id: input.id, state: "succeeded", updatedAt: Date.now(), endedAt: Date.now(), artifact: input.search?.partition === "validation" ? undefined : { hash: hash(bytes), bytes: bytes.length, filename: "model.tar.gz" }, evaluation: { recipe: llm ? LLM_RECIPE : RECIPE, partition: input.search?.partition ?? "test", metric: llm ? "completion_nll" : "accuracy", direction: llm ? "lower" : "higher", baseline: llm ? 2 : .5, candidate: score, improved: llm ? score < 2 : score > .5, trainRows: 60, tuningRows: 20, testRows: 20, droppedDuplicates: 0, datasetHash: input.dataset!.hash, splitHash: hash(input.dataset!.hash + input.spec!.seed), modelHash: input.search?.fromJob?.modelHash ?? hash(input.id), seed: input.spec!.seed, ...(llm ? { evaluatedTokens: 200, baseModelHash: input.model!.hash } : {}) } } as T;
    }
    if (r.action === "artifact") { const bytes = artifacts.get(r.id)!; return { data: bytes.subarray(r.cursor).toString("base64"), bytes: bytes.length, cursor: bytes.length } as T; }
    if (r.action === "serve-upload-status") return { present: true } as T;
    if (r.action === "serve-prepare") { loads++; await prepareHook?.(); if (failLoad) throw new Error("Candidate failed to load"); return { ready: true } as T; }
    if (r.action === "serve-predict") return (llm ? { text: "answer", inputTokens: 3, outputTokens: 2 } : { predictions: r.input.rows.map((v: any) => v.x) }) as T;
    throw new Error(`Unexpected worker request ${r.action}`);
  } };
  const create = async () => { const service = new MlService({ home, transport, enabled: () => enabled, promotionClock: () => now, monitorClock: () => now, authorize: async (p, repo) => { if (!permitted || p !== "p" || repo !== home) throw new Error("Membership revoked"); return { repo, commit: "a".repeat(40) }; } }); await service.load(); return service; };
  const service = await create();
  const snapshot = await service.snapshot({ project: "p", repo: home, target: "local", path: llm ? "/data.jsonl" : "/data.csv", location: "target" });
  const base = llm ? await service.startJob({ project: "p", repo: home, target: "local", path: "/base", operationId: randomUUID() }, "model") : undefined;
  const request = (dataset = snapshot.id) => ({ project: "p", repo: home, name: "Candidate", operationId: randomUUID(), dataset, spec: llm ? { task: "sft", device: "cpu", maxLength: 64, maxSteps: 2, rank: 4, learningRate: .0002, accumulation: 1, seed: 42, trainSeconds: 10, cpus: 1 } : { task: "classification", label: "target", split: { kind: "random" }, seed: 42, trainSeconds: 10, cpus: 1 }, ...(llm ? { recipe: LLM_RECIPE, model: base!.id } : {}) });
  const first = await service.startJob(request());
  let model = await service.registry.register({ project: "p", repo: home, jobId: first.id, name: "Promotion model", operationId: randomUUID() });
  model = await service.registry.select(model.id, "promote", { versionId: model.versions[0]!.id, revision: model.revision, operationId: randomUUID(), reason: "Reviewed incumbent" });
  const d = await service.deployments.create({ project: "p", repo: home, name: "Promotion endpoint", modelId: model.id, versionId: model.selectedVersionId, target: "local", config: { device: "cpu", cpus: 1, timeoutSeconds: 5, maxRows: 4, maxInputTokens: 32, maxNewTokens: 8 }, operationId: randomUUID(), reason: "Reviewed deployment" });
  async function candidate(value = llm ? 1 : .9, changed = false) {
    score = value; let dataset = snapshot.id;
    if (changed) { data = "changed"; dataset = (await service.snapshot({ project: "p", repo: home, target: "local", path: llm ? "/data.jsonl" : "/data.csv", location: "target" })).id; }
    const job = await service.startJob(request(dataset));
    model = service.store.read().registry[0]!;
    model = await service.registry.register({ project: "p", repo: home, jobId: job.id, modelId: model.id, revision: model.revision, operationId: randomUUID() }); return job;
  }
  async function common() { data = "holdout"; const result = await service.snapshot({ project: "p", repo: home, target: "local", path: llm ? "/holdout.jsonl" : "/holdout.csv", location: "target", purpose: "holdout" }); data = "original"; return { datasetId: result.id, maxEvaluations: 2, seconds: 180, memoryMiB: 1024, maxLength: 64, allowServingPause: true }; }
  const policy = (patch = {}) => ({ deploymentId: d.id, revision: d.revision, operationId: randomUUID(), name: "Release policy", source: { kind: "registry" }, includeExisting: true, authorized: true, mode: "approval", health, limits, ...patch });
  return { service, create, home, d, first, candidate, common, policy, request, advance: (ms = 60000) => { now += ms; }, setData: (value: string) => { data = value; }, setScore: (n: number) => { score = n; }, failLoad: () => { failLoad = true; }, loads: () => loads, hook: (f?: () => Promise<void>) => { prepareHook = f; }, disable: () => { enabled = false; }, revoke: () => { permitted = false; } };
}
async function traffic(service: MlService, fail = false) {
  const d = service.store.read().deployments[0]!;
  for (let i = 0; i < 10; i++) await service.monitors.record(d, d.releases.find(r => r.id === d.current)!, { rows: [{ x: 1 }, { x: 2 }] }, fail ? undefined : { predictions: [1, 2] }, 5);
}

test("promotion limits require bounded attempts, approval expiry and enough health observation", () => {
  assert.deepEqual(promotionLimits(limits, promotionHealth(health)), limits);
  for (const patch of [{ minImprovement: NaN }, { minImprovement: -.1 }, { maxAttempts: 0 }, { maxAttempts: 21 }, { approvalSeconds: 0 }, { cooldownSeconds: 0 }, { observationSeconds: 60 }]) assert.throws(() => promotionLimits({ ...limits, ...patch }, health));
  assert.throws(() => promotionHealth({ ...health, maxActions: 2 }));
});
test("promotion approval binds evidence, atomically deploys and selects, and accepts healthy observation", async () => {
  const f = await fixture();
  try {
    const candidate = await f.candidate(), input = f.policy(); let p = await f.service.promotions.create(input);
    assert.equal((await f.service.promotions.create(input)).id, p.id); await assert.rejects(f.service.promotions.create({ ...input, mode: "automatic" }), /inputs changed/);
    await f.service.promotions.tick(); p = f.service.store.read().promotions[0]!;
    assert.equal(p.decisions[0]!.state, "awaiting_approval"); assert.equal(f.service.store.read().deployments[0]!.revision, f.d.revision);
    await assert.rejects(f.service.promotions.update(p.id, "approve", { revision: 1, decisionId: p.decisions[0]!.id, reason: "Review" }), /changed/);
    p = await f.service.promotions.update(p.id, "approve", { revision: p.revision, decisionId: p.decisions[0]!.id, reason: "Checked matching test results" });
    const a = p.decisions[0]!; assert.equal(a.state, "observing"); assert.equal(a.approval, "owner");
    assert.equal(f.service.store.read().registry[0]!.selectedVersionId, candidate.registry?.versionId ?? f.service.store.read().experiments.find(e => e.id === candidate.id)!.registry!.versionId);
    assert.equal(f.service.store.read().monitors[0]!.rollbackVersionId, a.incumbentVersionId);
    for (let i = 0; i < 3; i++) { await traffic(f.service); f.advance(); await f.service.monitors.tick(); await f.service.promotions.tick(); }
    assert.equal(f.service.store.read().promotions[0]!.decisions[0]!.state, "promoted"); assert.equal(f.service.store.read().monitors[0]!.state, "enabled");
    await assert.rejects(f.service.store.change(s => { s.promotions[0]!.decisions[0]!.candidate = .99; }), /promotion/);
  } finally { await f.service.close(); }
});
test("automatic promotion rejects ties, regression and incomparable data even with a better score", async () => {
  const f = await fixture();
  try {
    await f.candidate(.7); await f.candidate(.6); await f.candidate(.99, true);
    await f.service.promotions.create(f.policy({ mode: "automatic" })); await f.service.promotions.tick();
    const p = f.service.store.read().promotions[0]!; assert.equal(p.decisions.length, 3); assert.ok(p.decisions.every(a => a.state === "blocked")); assert.ok(p.decisions.some(a => a.concerns.includes("Dataset versions differ")));
    await assert.rejects(f.service.promotions.update(p.id, "approve", { revision: p.revision, decisionId: p.decisions[0]!.id, reason: "Override" }), /not awaiting/);
    assert.equal(f.service.store.read().deployments[0]!.revision, 1); assert.equal(f.loads(), 1);
  } finally { await f.service.close(); }
});
test("automatic LoRA promotion uses lower held-out loss and rolls back after insufficient health traffic", async () => {
  const f = await fixture(true);
  try {
    await f.candidate(); await f.service.promotions.create(f.policy({ mode: "automatic" })); await f.service.promotions.tick();
    const a = f.service.store.read().promotions[0]!.decisions[0]!; assert.equal(a.gain, .5); assert.equal(a.state, "observing");
    f.advance(180000); await f.service.monitors.tick(); await f.service.promotions.tick();
    const s = f.service.store.read(); assert.equal(s.promotions[0]!.decisions[0]!.state, "rolled_back"); assert.equal(s.deployments[0]!.current, f.d.current); assert.equal(s.registry[0]!.selectedVersionId, a.incumbentVersionId); assert.equal(s.promotions[0]!.state, "paused");
  } finally { await f.service.close(); }
});
test("health-triggered rollback synchronizes registry selection and survives a controller restart", async () => {
  const f = await fixture(); let service = f.service;
  try {
    await f.candidate(); await service.promotions.create(f.policy({ mode: "automatic" })); await service.promotions.tick();
    const a = service.store.read().promotions[0]!.decisions[0]!;
    await service.close(); service = await f.create(); await service.promotions.tick(); assert.equal(service.store.read().deployments[0]!.revision, a.deployedRevision);
    for (let i = 0; i < 2; i++) { await traffic(service, true); f.advance(); await service.monitors.tick(); }
    assert.equal(service.store.read().deployments[0]!.current, f.d.current);
    await service.close(); service = await f.create(); await service.promotions.tick(); await service.promotions.tick();
    assert.equal(service.store.read().promotions[0]!.decisions[0]!.state, "rolled_back"); assert.equal(service.store.read().registry[0]!.selectedVersionId, a.incumbentVersionId);
    assert.equal(service.store.read().registry[0]!.history.filter(h => h.operationId === a.rollbackSelection).length, 1);
  } finally { await service.close(); }
});
test("pause during candidate preparation prevents both registry selection and deployment commit", async () => {
  const f = await fixture(); let release = () => {}, flight: Promise<void> | undefined;
  try {
    await f.candidate(); const p = await f.service.promotions.create(f.policy({ mode: "automatic" }));
    let reached!: () => void; const started = new Promise<void>(r => reached = r), gate = new Promise<void>(r => release = r); f.hook(async () => { reached(); await gate; });
    flight = f.service.promotions.tick(); await started; await f.service.promotions.update(p.id, "pause", { revision: f.service.store.read().promotions[0]!.revision }); release(); await flight;
    const s = f.service.store.read(); assert.equal(s.deployments[0]!.current, f.d.current); assert.equal(s.registry[0]!.selectedVersionId, f.first.registry?.versionId ?? s.registry[0]!.versions[0]!.id); assert.equal(s.monitors.length, 0); assert.equal(s.promotions[0]!.decisions[0]!.state, "cancelled");
  } finally { release(); await flight; await f.service.close(); }
});
test("failed candidate load and paused rollout do not undo manual deployment or registry changes", async () => {
  const f = await fixture();
  try {
    await f.candidate(); await f.service.promotions.create(f.policy({ mode: "automatic" })); f.failLoad(); await f.service.promotions.tick();
    const s = f.service.store.read(); assert.equal(s.promotions[0]!.decisions[0]!.state, "failed"); assert.equal(s.promotions[0]!.state, "paused"); assert.equal(s.deployments[0]!.current, f.d.current); assert.equal(s.registry[0]!.selectedVersionId, s.registry[0]!.versions[0]!.id); assert.equal(s.monitors.length, 0);
  } finally { await f.service.close(); }
});
test("expired or rejected approvals consume no deployment attempt and cannot be replayed", async () => {
  const f = await fixture();
  try {
    await f.candidate(); let p = await f.service.promotions.create(f.policy({ limits: { ...limits, approvalSeconds: 60 } })); await f.service.promotions.tick(); p = f.service.store.read().promotions[0]!;
    f.advance(); await f.service.promotions.tick(); p = f.service.store.read().promotions[0]!; assert.equal(p.decisions[0]!.state, "cancelled"); assert.equal(p.decisions[0]!.attemptedAt, undefined);
    await assert.rejects(f.service.promotions.update(p.id, "approve", { revision: p.revision, decisionId: p.decisions[0]!.id, reason: "Late approval" }), /not awaiting/);
    await f.candidate(.95); await f.service.promotions.tick(); p = f.service.store.read().promotions[0]!; p = await f.service.promotions.update(p.id, "reject", { revision: p.revision, decisionId: p.decisions[1]!.id, reason: "Keep incumbent" });
    await f.service.promotions.tick(); assert.equal(f.service.store.read().promotions[0]!.decisions.length, 2); assert.equal(p.decisions[1]!.state, "rejected");
  } finally { await f.service.close(); }
});
test("feature disablement and access revocation cannot dispatch a pending promotion, while pause remains available", async () => {
  for (const revoke of [false, true]) {
    const f = await fixture();
    try { await f.candidate(); await f.service.promotions.create(f.policy()); await f.service.promotions.tick(); const p = f.service.store.read().promotions[0]!; revoke ? f.revoke() : f.disable(); await assert.rejects(f.service.promotions.update(p.id, "approve", { revision: p.revision, decisionId: p.decisions[0]!.id, reason: "Attempt" }), /Enable ML|Membership/); await f.service.promotions.update(p.id, "pause", { revision: p.revision }); assert.equal(f.service.store.read().deployments[0]!.revision, 1); } finally { await f.service.close(); }
  }
});
test("an approved search export registers automatically without changing its training budget", async () => {
  const f = await fixture();
  try {
    f.setScore(.9);
    const cycle = await f.service.cycles.create({ training: f.request(), objective: "Bounded improvement", planner: { kind: "builtin" }, limits: { iterations: 1, trainSeconds: 10, elapsedSeconds: 300, patience: 1, minImprovement: .02 } });
    for (let i = 0; i < 30 && f.service.store.read().cycles[0]!.state !== "completed"; i++) { await f.service.cycles.tick(); await new Promise(r => setTimeout(r, 5)); }
    assert.equal(f.service.store.read().cycles[0]!.state, "completed"); const before = f.service.store.read().cycles[0]!;
    await f.service.promotions.create(f.policy({ mode: "automatic", source: { kind: "searches" } })); await f.service.promotions.tick();
    const s = f.service.store.read(); assert.equal(s.promotions[0]!.decisions[0]!.state, "observing"); assert.equal(s.promotions[0]!.decisions[0]!.margin, .02); assert.equal(s.registry[0]!.versions.length, 2); assert.deepEqual(s.cycles[0], before); assert.equal(s.cycles[0]!.id, cycle.id);
  } finally { await f.service.close(); }
});
test("cooldown and lifetime attempts survive restart; manual rollback restores both pointers", async () => {
  const f = await fixture(); let service = f.service;
  try {
    await f.candidate(); await service.promotions.create(f.policy({ mode: "automatic", limits: { ...limits, maxAttempts: 1 } })); await service.promotions.tick();
    for (let i = 0; i < 3; i++) { await traffic(service); f.advance(); await service.monitors.tick(); await service.promotions.tick(); }
    let p = service.store.read().promotions[0]!; assert.equal(p.state, "paused"); assert.equal(p.decisions[0]!.state, "promoted");
    await service.close(); service = await f.create(); await assert.rejects(service.promotions.update(p.id, "resume", { revision: p.revision }), /Lifetime/);
    p = await service.promotions.update(p.id, "rollback", { revision: p.revision, decisionId: p.decisions[0]!.id, reason: "Owner rollback" }); assert.equal(p.decisions[0]!.state, "rolled_back"); assert.equal(service.store.read().deployments[0]!.current, f.d.current);
    assert.equal(p.decisions[0]!.rollbackReason, "Owner rollback"); assert.equal(service.store.read().deployments[0]!.history.at(-1)!.reason, "Owner rollback"); assert.equal(service.store.read().registry[0]!.history.at(-1)!.reason, "Owner rollback");
  } finally { await service.close(); }
});

test("manual changes after approval invalidate deployment and later observation without overwriting selection", async () => {
  const f = await fixture();
  try {
    await f.candidate(); await f.service.promotions.create(f.policy()); await f.service.promotions.tick();
    let p = f.service.store.read().promotions[0]!, model = f.service.store.read().registry[0]!;
    await f.service.registry.select(model.id, "promote", { versionId: model.versions[1]!.id, revision: model.revision, operationId: randomUUID(), reason: "Manual selection" });
    await assert.rejects(f.service.promotions.update(p.id, "approve", { revision: p.revision, decisionId: p.decisions[0]!.id, reason: "Stale review" }), /selection changed/);
    await f.service.promotions.tick(); assert.equal(f.service.store.read().promotions[0]!.decisions[0]!.state, "cancelled"); assert.equal(f.service.store.read().deployments[0]!.current, f.d.current);
  } finally { await f.service.close(); }
  const g = await fixture();
  try {
    await g.candidate(); await g.service.promotions.create(g.policy({ mode: "automatic" })); await g.service.promotions.tick();
    const d = g.service.store.read().deployments[0]!; await g.service.deployments.update(d.id, "stop", { revision: d.revision, operationId: randomUUID(), reason: "Manual stop" });
    await g.service.promotions.tick(); const p = g.service.store.read().promotions[0]!; assert.equal(p.decisions[0]!.state, "cancelled");
    await g.service.promotions.tick(); assert.equal(g.service.store.read().promotions[0]!.revision, p.revision, "finished manual override does not repeatedly write failures");
    assert.equal(g.service.store.read().deployments[0]!.enabled, false);
  } finally { await g.service.close(); }
});
test("automatic promotion chooses the largest comparable gain and honors cooldown before later releases", async () => {
  const f = await fixture();
  try {
    await f.candidate(.8); const best = await f.candidate(.9);
    await f.service.promotions.create(f.policy({ mode: "automatic", limits: { ...limits, cooldownSeconds: 600 } })); await f.service.promotions.tick();
    assert.equal(f.service.store.read().promotions[0]!.decisions[0]!.jobId, best.id);
    for (let i = 0; i < 3; i++) { await traffic(f.service); f.advance(); await f.service.monitors.tick(); await f.service.promotions.tick(); }
    const next = await f.candidate(.99); await f.service.promotions.tick(); assert.equal(f.service.store.read().promotions[0]!.decisions.some(a => a.jobId === next.id), false);
    f.advance(420000); await f.service.promotions.tick(); const p = f.service.store.read().promotions[0]!; assert.equal(p.decisions.find(a => a.jobId === next.id)?.state, "observing"); assert.equal(p.decisions.filter(a => a.attemptedAt !== undefined).length, 2);
    assert.equal(f.service.store.read().monitors[0]!.state, "paused"); assert.equal(f.service.store.read().monitors[1]!.state, "enabled");
  } finally { await f.service.close(); }
});
test("missing archives and exhausted health-guard capacity cannot change either selected or deployed model", async () => {
  for (const scenario of ["candidate", "incumbent", "capacity"]) {
    const f = await fixture();
    try {
      const job = await f.candidate(); await f.service.promotions.create(f.policy({ mode: "automatic" }));
      if (scenario === "capacity") for (let i = 0; i < 32; i++) { const m = await f.service.monitors.create({ deploymentId: f.d.id, revision: f.d.revision, operationId: randomUUID(), name: "Retained monitor", limits: health }); await f.service.monitors.update(m.id, "pause", { revision: m.revision }); }
      else await writeFile(join(f.home, "ml/exports", (scenario === "incumbent" ? f.first.id : job.id) + ".tar.gz"), "corrupt export");
      await f.service.promotions.tick(); const p = f.service.store.read().promotions[0]!;
      assert.equal(p.decisions[0]!.state, "failed"); assert.equal(f.service.store.read().deployments[0]!.current, f.d.current); assert.equal(f.service.store.read().registry[0]!.selectedVersionId, f.service.store.read().registry[0]!.versions[0]!.id);
    } finally { await f.service.close(); }
  }
});
test("rollback load failures stop after three attempts and expose recovery without silently accepting a model", async () => {
  const f = await fixture();
  try {
    await f.candidate(); await f.service.promotions.create(f.policy({ mode: "automatic" })); await f.service.promotions.tick(); f.failLoad(); f.advance(180000);
    const before = f.loads(); for (let i = 0; i < 7; i++) await f.service.promotions.tick();
    const p = f.service.store.read().promotions[0]!; assert.equal(f.loads() - before, 3); assert.equal(p.decisions[0]!.state, "failed"); assert.match(p.decisions[0]!.outcome!, /three attempts/); assert.equal(p.state, "paused");
  } finally { await f.service.close(); }
});

test("health rollback uses reserved receipt space after new admissions reach the storage threshold", async () => {
  const f = await fixture();
  try {
    await f.candidate(); await f.service.promotions.create(f.policy({ mode: "automatic" })); await f.service.promotions.tick();
    await f.service.store.change(s => { (s as any).capacityFixture = "x".repeat(6 * 1024 * 1024); });
    for (let i = 0; i < 2; i++) { await traffic(f.service, true); f.advance(); await f.service.monitors.tick(); }
    await f.service.promotions.tick();
    assert.equal(f.service.store.read().promotions[0]!.decisions[0]!.state, "rolled_back"); assert.equal(f.service.store.read().deployments[0]!.current, f.d.current);
  } finally { await f.service.close(); }
});
test("pausing promotion keeps an admitted release protected until its observation terminates", async () => {
  const f = await fixture();
  try {
    await f.candidate(); await f.service.promotions.create(f.policy({ mode: "automatic" })); await f.service.promotions.tick();
    const p = f.service.store.read().promotions[0]!; await f.service.promotions.update(p.id, "pause", { revision: p.revision });
    f.advance(180000); await f.service.promotions.tick(); assert.equal(f.service.store.read().promotions[0]!.decisions[0]!.state, "rolled_back");
  } finally { await f.service.close(); }
});

async function finishHoldout(service: MlService) { for (let i = 0; i < 8; i++) await service.promotions.tick(); }
test("common holdout automatically registers a changed-data search winner without changing its budget", async () => {
  const f = await fixture();
  try {
    const holdout = await f.common(); f.setScore(.95); f.setData("updated data");
    const data = await f.service.snapshot({ project: "p", repo: f.home, target: "local", path: "/updated.csv", location: "target" });
    const cycle = await f.service.cycles.create({ training: f.request(data.id), objective: "Improve with new data", planner: { kind: "builtin" }, limits: { iterations: 1, trainSeconds: 10, elapsedSeconds: 300, patience: 1, minImprovement: .02 } });
    for (let i = 0; i < 30 && f.service.store.read().cycles[0]!.state !== "completed"; i++) { await f.service.cycles.tick(); await new Promise(r => setTimeout(r, 5)); }
    const before = f.service.store.read().cycles[0]!; assert.equal(before.state, "completed");
    await f.service.promotions.create(f.policy({ mode: "automatic", source: { kind: "searches" }, holdout })); await finishHoldout(f.service);
    const s = f.service.store.read(), decision = s.promotions[0]!.decisions[0]!;
    assert.equal(decision.state, "observing"); assert.equal(decision.margin, .02); assert.ok(decision.holdoutJobId);
    assert.equal(s.registry[0]!.versions.length, 2); assert.equal(s.registry[0]!.versions[1]!.jobId, before.finalJobId);
    assert.deepEqual(s.cycles[0], before); assert.equal(s.cycles[0]!.id, cycle.id);
    assert.notEqual(s.experiments.find(e => e.id === before.finalJobId)!.intent.dataset!.hash, f.first.intent.dataset!.hash);
  } finally { await f.service.close(); }
});
test("common holdout compares new data and binds owner approval before deploying and rolling back", async () => {
  const f = await fixture();
  try {
    const holdout = await f.common(); await f.candidate(.95, true);
    await f.service.promotions.create(f.policy({ holdout })); await finishHoldout(f.service);
    let p = f.service.store.read().promotions[0]!; const a = p.decisions[0]!;
    assert.equal(p.evaluations![0]!.state, "completed"); assert.equal(a.state, "awaiting_approval"); assert.equal(a.candidate, .95); assert.ok(a.holdoutJobId); assert.equal(f.service.store.read().deployments[0]!.revision, 1);
    p = await f.service.promotions.update(p.id, "approve", { revision: p.revision, decisionId: a.id, reason: "Reviewed common holdout" }); assert.equal(p.decisions[0]!.state, "observing");
    p = await f.service.promotions.update(p.id, "rollback", { revision: p.revision, decisionId: a.id, reason: "Review rollback" }); assert.equal(p.decisions[0]!.state, "rolled_back"); assert.equal(f.service.store.read().deployments[0]!.current, f.d.current);
  } finally { await f.service.close(); }
});
test("common holdout has separate lifetime evaluation limits, blocks regression and survives restart", async () => {
  const f = await fixture(); let service = f.service;
  try {
    const holdout = await f.common(); await f.candidate(.6, true); await f.candidate(.65); await service.promotions.create(f.policy({ holdout: { ...holdout, maxEvaluations: 1 }, mode: "automatic" }));
    await service.promotions.tick(); assert.equal(service.store.read().promotions[0]!.evaluations!.length, 1);
    await service.close(); service = await f.create(); await finishHoldout(service);
    const p = service.store.read().promotions[0]!; assert.equal(p.decisions[0]!.state, "blocked"); assert.match(p.decisions[0]!.concerns.join(" "), /common holdout/); assert.equal(service.store.read().deployments[0]!.revision, 1);
    assert.equal(p.state, "paused"); assert.match(p.reason!, /evaluation limit/); assert.equal(p.evaluations!.length, 1);
    await assert.rejects(service.store.change(s => { s.experiments.find(e => e.id === p.evaluations![0]!.jobId)!.status.holdout!.datasetHash = hash("changed"); }), /Holdout|holdout/);
  } finally { await service.close(); }
});
test("common holdout is not available to training and pause cancels its reservation without deployment", async () => {
  const f = await fixture();
  try {
    const holdout = await f.common(); await assert.rejects(f.service.startJob(f.request(holdout.datasetId)), /reserved for evaluation/);
    await f.candidate(.95, true); await f.service.promotions.create(f.policy({ holdout, mode: "automatic" })); await f.service.promotions.tick();
    const p = f.service.store.read().promotions[0]!; assert.equal(f.service.deployments.busy(f.d.target.workerId, f.d.id), true);
    await f.service.promotions.update(p.id, "pause", { revision: p.revision }); await finishHoldout(f.service);
    assert.equal(f.service.store.read().promotions[0]!.evaluations![0]!.state, "cancelled"); assert.equal(f.service.store.read().experiments.some(e => e.intent.kind === "holdout"), false); assert.equal(f.service.store.read().deployments[0]!.revision, 1);
  } finally { await f.service.close(); }
});
test("common LoRA holdout uses a fixed token population and lower loss before automatic promotion", async () => {
  const f = await fixture(true);
  try {
    const holdout = await f.common(); await f.candidate(1, true); await f.service.promotions.create(f.policy({ holdout, mode: "automatic" })); await finishHoldout(f.service);
    const p = f.service.store.read().promotions[0]!; assert.equal(p.decisions[0]!.state, "observing"); assert.equal(p.decisions[0]!.direction, "lower"); assert.equal(p.decisions[0]!.gain, .5);
  } finally { await f.service.close(); }
});
