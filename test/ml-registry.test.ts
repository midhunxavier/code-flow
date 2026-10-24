import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MlService } from "../src/ml/service.js";
import { MlStore } from "../src/ml/store.js";
import { hash } from "../src/training-worker/files.js";
import { LLM_RECIPE, RECIPE, type Experiment, type Intent, type Target } from "../src/ml/model.js";
import { comparisonDifferences, rankVersions, type RegisteredModel } from "../src/ml/registry-model.js";
import type { WorkerClient } from "../src/ml/transport.js";
let directory: string;
before(async () => { directory = await mkdtemp(join(tmpdir(), "codeflow-registry-test-")); execFileSync(process.execPath, ["scripts/build-training-worker.mjs"]); });
after(async () => { await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const home = join(directory, randomUUID()); await mkdir(home);
  let permitted = true, enabled = true, online = true, score = 0.8, source = "original data", downloads = 0;
  const workers = new Map<string, string>(), artifacts = new Map<string, Buffer>();
  let duringDownload: (() => Promise<void>) | undefined;
  const transport: WorkerClient = { close: async () => {}, call: async <T>(target: Target, request: Record<string, any>): Promise<T> => {
    if (!online) throw new Error("SSH server unavailable");
    const workerId = workers.get(target.id) ?? randomUUID(); workers.set(target.id, workerId);
    if (["probe", "enroll"].includes(request.action)) return { protocol: 1, workerId, boundedSearch: 1, dataWatch: 1, cpus: 4, ready: true, recipes: [{ id: LLM_RECIPE, ready: true, devices: ["cpu", "cuda"] }], gpus: [{ uuid: "GPU-12345678", name: "Fixture GPU" }] } as T;
    if (request.action === "snapshot") return { id: hash(source + request.path), hash: hash(source + request.path), bytes: source.length, format: request.path.endsWith("jsonl") ? "jsonl" : "csv", ...(request.path.endsWith("jsonl") ? { schema: "prompt-completion" } : {}), rows: 100, columns: request.path.endsWith("jsonl") ? ["prompt", "completion"] : ["x", "target"], missing: request.path.endsWith("jsonl") ? { prompt: 0, completion: 0 } : { x: 0, target: 0 }, duplicateRows: 0 } as T;
    if (request.action === "submit") {
      const input = request.intent as Intent;
      if (input.kind === "model") return { id: input.id, state: "succeeded", updatedAt: Date.now(), model: { hash: hash(request.path ?? "base"), bytes: 1000, parameters: 1000, architecture: "llama", contextLength: 512, files: 4 } } as T;
      const llm = input.recipe === LLM_RECIPE, bytes = Buffer.from(`verified export ${input.id}`); artifacts.set(input.id, bytes);
      const baseline = llm ? 2 : 0.5;
      return { id: input.id, state: "succeeded", updatedAt: Date.now(), endedAt: Date.now(), artifact: input.search?.partition === "validation" ? undefined : { hash: hash(bytes), bytes: bytes.length, filename: "model.tar.gz" }, evaluation: { recipe: llm ? LLM_RECIPE : RECIPE, partition: input.search?.partition ?? "test", metric: llm ? "completion_nll" : "accuracy", direction: llm ? "lower" : "higher", baseline, candidate: score, improved: llm ? score < baseline : score > baseline, trainRows: 60, tuningRows: 20, testRows: 20, droppedDuplicates: 0, datasetHash: input.dataset!.hash, splitHash: hash(input.dataset!.hash + input.spec!.seed), modelHash: input.search?.fromJob?.modelHash ?? hash(input.id), seed: input.spec!.seed, ...(llm ? { evaluatedTokens: 200, baseModelHash: input.model!.hash } : {}) } } as T;
    }
    if (request.action === "artifact") { downloads++; await duringDownload?.(); const bytes = artifacts.get(request.id)!; return { data: bytes.subarray(request.cursor).toString("base64"), bytes: bytes.length, cursor: bytes.length } as T; }
    throw new Error(`Unexpected ${request.action}`);
  } };
  const create = async () => { const service = new MlService({ home, transport, enabled: () => enabled, authorize: async (project, repo) => { if (!permitted || project !== "p" || repo !== home) throw new Error("Project membership revoked"); return { repo, commit: "a".repeat(40) }; } }); await service.load(); return service; };
  const service = await create();
  async function job(value = 0.8, target = "local", llm = false, seed = 42, data = source) {
    score = value; source = data;
    const snapshot = await service.snapshot({ project: "p", repo: home, target, path: "/data." + (llm ? "jsonl" : "csv"), location: "target" });
    const model = llm ? await service.startJob({ project: "p", repo: home, target, path: "/base", operationId: randomUUID() }, "model") : undefined;
    return service.startJob({ project: "p", repo: home, name: "Predict", operationId: randomUUID(), dataset: snapshot.id, spec: llm ? { task: "sft", device: "cpu", maxLength: 64, maxSteps: 2, rank: 4, learningRate: 0.0002, accumulation: 1, seed, trainSeconds: 10, cpus: 1 } : { task: "classification", label: "target", split: { kind: "random" }, seed, trainSeconds: 10, cpus: 1 }, ...(llm ? { recipe: LLM_RECIPE, model: model!.id } : {}) });
  }
  const registration = (job: Experiment, model?: RegisteredModel) => ({ project: "p", repo: home, jobId: job.id, operationId: randomUUID(), ...(model ? { modelId: model.id, revision: model.revision } : { name: "Prediction model" }) });
  const selection = (model: RegisteredModel, version = model.versions.at(-1)!.id) => ({ operationId: randomUUID(), revision: model.revision, versionId: version, reason: "Reviewed evaluation and model behavior" });
  return { home, service, create, job, registration, selection, offline: () => { online = false; }, online: () => { online = true; }, revoke: () => { permitted = false; }, disable: () => { enabled = false; }, downloads: () => downloads, duringDownload: (f: () => Promise<void>) => { duringDownload = f; } };
}

test("registry versions retain verified receipts, compare scores, promote and roll back without training", async () => {
  const f = await fixture();
  try {
    const a = await f.job(0.7), b = await f.job(0.9); let model = await f.service.registry.register(f.registration(a));
    const first = model.versions[0]!.id; model = await f.service.registry.select(model.id, "promote", f.selection(model, first));
    model = await f.service.registry.register(f.registration(b, model)); const second = model.versions[1]!.id;
    assert.deepEqual(rankVersions(model, [a, b], first).map(r => r.version.id), [second, first]);
    model = await f.service.registry.select(model.id, "promote", f.selection(model, second)); assert.equal(model.selectedVersionId, second);
    model = await f.service.registry.select(model.id, "rollback", f.selection(model, first));
    assert.equal(model.selectedVersionId, first); assert.deepEqual(model.history.map(h => h.action), ["promote", "promote", "rollback"]);
    assert.deepEqual(model.versions.map(v => v.number), [1, 2]); assert.equal(f.service.store.read().experiments.length, 2);
    assert.equal(f.service.overview("p").registry[0]!.id, model.id);
    const content = await f.service.registry.withArchive(first, async file => { const chunks = []; for await (const c of file.createReadStream({ start: 0, autoClose: false })) chunks.push(c); return Buffer.concat(chunks); });
    assert.equal(hash(content), a.status.artifact!.hash);
  } finally { await f.service.close(); }
});

test("registration and selection retries are idempotent, including retries after a later promotion and restart", async () => {
  const f = await fixture(); let service = f.service;
  try {
    const a = await f.job(), b = await f.job(0.9), raw = f.registration(a);
    const [one, duplicate] = await Promise.all([service.registry.register(raw), service.registry.register(raw)]); assert.equal(one.id, duplicate.id); assert.equal(service.store.read().registry.length, 1);
    let model = one; const firstRequest = f.selection(model); model = await service.registry.select(model.id, "promote", firstRequest);
    model = await service.registry.register(f.registration(b, model)); model = await service.registry.select(model.id, "promote", f.selection(model));
    const selected = model.selectedVersionId; await service.close(); service = await f.create();
    assert.equal((await service.registry.select(model.id, "promote", firstRequest)).selectedVersionId, selected, "retry must not undo a newer selection");
    assert.equal((await service.registry.register(raw)).versions.length, 2);
    await assert.rejects(service.registry.select(model.id, "promote", { ...firstRequest, reason: "Changed request" }), /inputs changed/);
    await assert.rejects(service.registry.register({ ...raw, name: "Another model" }), /different inputs/);
  } finally { await service.close(); }
});

test("concurrent promotions use compare-and-swap; rollback accepts only previously selected versions", async () => {
  const f = await fixture();
  try {
    const a = await f.job(0.7), b = await f.job(0.8), c = await f.job(0.9);
    let model = await f.service.registry.register(f.registration(a)); model = await f.service.registry.register(f.registration(b, model)); model = await f.service.registry.register(f.registration(c, model));
    await assert.rejects(f.service.registry.select(model.id, "rollback", f.selection(model)), /previously selected/);
    const outcomes = await Promise.allSettled([f.service.registry.select(model.id, "promote", f.selection(model, model.versions[0]!.id)), f.service.registry.select(model.id, "promote", f.selection(model, model.versions[1]!.id))]);
    assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1); assert.equal(outcomes.filter(r => r.status === "rejected").length, 1);
    const current = (await f.service.registry.read(model.id)).model; assert.equal(current.history.length, 1);
    await assert.rejects(f.service.registry.register(f.registration(await f.job(), model)), /registry changed/);
  } finally { await f.service.close(); }
});

test("different data, splits or weak results require explicit comparison review and never enter the same ranking", async () => {
  const f = await fixture();
  try {
    const a = await f.job(0.8), b = await f.job(0.95, "local", false, 42, "new data"), weak = await f.job(0.4);
    let model = await f.service.registry.register(f.registration(a)); model = await f.service.registry.select(model.id, "promote", f.selection(model));
    model = await f.service.registry.register(f.registration(b, model));
    assert.match(comparisonDifferences(a, b).join(" "), /Dataset versions differ/);
    assert.equal(rankVersions(model, [a, b], model.versions[0]!.id).length, 1);
    const request = f.selection(model); await assert.rejects(f.service.registry.select(model.id, "promote", request), /Review this comparison/);
    model = await f.service.registry.select(model.id, "promote", { ...request, reviewed: true }); assert.ok(model.history.at(-1)!.comparison.length);
    model = await f.service.registry.register(f.registration(weak, model));
    await assert.rejects(f.service.registry.select(model.id, "promote", f.selection(model)), /baseline/);
    const split = structuredClone(b); split.status.evaluation!.splitHash = "c".repeat(64); assert.ok(comparisonDifferences(b, split).includes("Evaluation splits differ"));
    split.status.evaluation!.splitHash = b.status.evaluation!.splitHash; split.intent.bundle = "d".repeat(64); assert.ok(comparisonDifferences(b, split).includes("Evaluator or recipe versions differ"));
  } finally { await f.service.close(); }
});

test("SSH versions can promote, export and roll back offline; corrupt or missing archives block selection until restored", async () => {
  const f = await fixture();
  try {
    const target = await f.service.register({ host: "gpu-vm", name: "GPU VM", standalone: true });
    const a = await f.job(0.7, target.id), b = await f.job(0.9, target.id); let model = await f.service.registry.register(f.registration(a));
    model = await f.service.registry.select(model.id, "promote", f.selection(model)); model = await f.service.registry.register(f.registration(b, model));
    f.offline(); const downloads = f.downloads(); model = await f.service.registry.select(model.id, "promote", f.selection(model));
    model = await f.service.registry.select(model.id, "rollback", f.selection(model, model.versions[0]!.id)); assert.equal(f.downloads(), downloads);
    await f.service.registry.withArchive(model.versions[0]!.id, async (fd, version) => { assert.equal(version.jobId, a.id); assert.equal((await fd.stat()).size, a.status.artifact!.bytes); });
    const archive = join(f.home, "ml/exports", b.id + ".tar.gz"); await writeFile(archive, Buffer.alloc(b.status.artifact!.bytes)); const history = model.history.length;
    await assert.rejects(f.service.registry.select(model.id, "promote", f.selection(model)), /archive checksum changed/);
    assert.equal((await f.service.registry.read(model.id)).model.history.length, history);
    f.online(); await f.service.registry.restore(model.versions[1]!.id); model = await f.service.registry.select(model.id, "promote", f.selection(model));
    await rm(join(f.home, "ml/exports", a.id + ".tar.gz")); await assert.rejects(f.service.registry.select(model.id, "rollback", f.selection(model, model.versions[0]!.id)), /unavailable/);
    await f.service.registry.restore(model.versions[0]!.id); f.disable(); model = await f.service.registry.select(model.id, "rollback", f.selection(model, model.versions[0]!.id)); assert.equal(model.selectedVersionId, model.versions[0]!.id);
    await assert.rejects(f.service.registry.select(model.id, "promote", f.selection(model)), /Enable/);
  } finally { await f.service.close(); }
});

test("registry admission enforces project membership and model contracts, and retains no metadata after revoked download", async () => {
  const f = await fixture();
  try {
    const job = await f.job(); await assert.rejects(f.service.registry.register({ ...f.registration(job), project: "other" }), /membership/);
    const llm = await f.job(1, "local", true); const model = await f.service.registry.register(f.registration(job));
    await assert.rejects(f.service.registry.register(f.registration(llm, model)), /input\/output contract/);
    f.duringDownload(async () => { assert.equal(f.service.active(), true); f.revoke(); });
    await assert.rejects(f.service.registry.register({ ...f.registration(llm), name: "Language model" }), /membership/);
    assert.equal(f.service.store.read().registry.length, 1);
    await assert.rejects(f.service.registry.read(model.id), /membership/);
    await assert.rejects(f.service.registry.withArchive(model.versions[0]!.id, async () => {}), /membership/);
  } finally { await f.service.close(); }
});

test("registry validates lineage, selection and migration on restart", async () => {
  const f = await fixture();
  try {
    const job = await f.job(); const model = await f.service.registry.register(f.registration(job));
    await assert.rejects(f.service.store.change(s => { s.registry[0]!.selectedVersionId = model.versions[0]!.id; }), /differs from its history/);
    await assert.rejects(f.service.store.change(s => { s.experiments[0]!.status.evaluation!.candidate = 0.9; }), /receipt/);
    await assert.rejects(f.service.store.change(s => { s.registry = []; }), /Missing model registry/);
    const saved = f.service.store.read(); await f.service.close(); delete (saved as any).registry; await writeFile(join(f.home, "ml/state.json"), JSON.stringify(saved));
    await assert.rejects(f.create(), /Missing model registry/);
    const emptyHome = join(directory, randomUUID()); const old = new MlStore(emptyHome); await old.load(); const legacy = old.read(); delete (legacy as any).registry; await writeFile(join(emptyHome, "state.json"), JSON.stringify(legacy)); const migrated = new MlStore(emptyHome); await migrated.load(); assert.deepEqual(migrated.read().registry, []);
  } finally { await f.service.close(); }
});

test("registry downloads hold the verified inode and do not follow replaced paths or symlinks", async () => {
  const f = await fixture();
  try {
    const job = await f.job(), model = await f.service.registry.register(f.registration(job)), version = model.versions[0]!;
    const archive = join(f.home, "ml/exports", job.id + ".tar.gz");
    const result = await f.service.registry.withArchive(version.id, async fd => { assert.equal(f.service.active(), true); await rename(archive, archive + ".original"); await writeFile(archive, "untrusted replacement"); const data = []; for await (const chunk of fd.createReadStream({ start: 0, autoClose: false })) data.push(chunk); return Buffer.concat(data); });
    assert.equal(hash(result), job.status.artifact!.hash); assert.equal(f.service.active(), false);
    await rm(archive); await symlink(archive + ".original", archive); await assert.rejects(f.service.registry.withArchive(version.id, async () => {}), /unavailable/);
  } finally { await f.service.close(); }
});

test("LoRA ranks lower loss first across local and SSH, and requires the same evaluation tokens and frozen base", async () => {
  const f = await fixture();
  try {
    const target = await f.service.register({ host: "gpu-vm", name: "GPU VM", standalone: true });
    const a = await f.job(1.5, "local", true), b = await f.job(1, target.id, true);
    let model = await f.service.registry.register(f.registration(a)); model = await f.service.registry.select(model.id, "promote", f.selection(model));
    model = await f.service.registry.register(f.registration(b, model));
    assert.deepEqual(rankVersions(model, [a, b], model.versions[0]!.id).map(r => r.version.number), [2, 1]);
    model = await f.service.registry.select(model.id, "promote", f.selection(model)); assert.equal(model.selectedVersionId, model.versions[1]!.id);
    const changed = structuredClone(b); changed.status.evaluation!.evaluatedTokens!++;
    assert.match(comparisonDifferences(a, changed).join(" "), /tokens/);
    changed.intent.model!.hash = "b".repeat(64); changed.status.evaluation!.baseModelHash = changed.intent.model!.hash;
    assert.match(comparisonDifferences(a, changed).join(" "), /Base models differ/);
    const downloads = f.downloads(); await assert.rejects(f.service.registry.register(f.registration(await f.job(0.8, "local", true))), /name already exists/); assert.equal(f.downloads(), downloads);
  } finally { await f.service.close(); }
});

test("missing final evaluation or export and base snapshots cannot become registered versions", async () => {
  const f = await fixture();
  try {
    const a = await f.job(), b = await f.job(1, "local", true), base = f.service.store.read().experiments.find(e => e.intent.kind === "model")!;
    await f.service.store.change(s => { delete s.experiments.find(e => e.id === a.id)!.status.evaluation; delete s.experiments.find(e => e.id === b.id)!.status.artifact; });
    for (const job of [a, b, base]) await assert.rejects(f.service.registry.register(f.registration(job)), /successful final test/);
    assert.equal(f.downloads(), 0); assert.equal(f.service.store.read().registry.length, 0);
  } finally { await f.service.close(); }
});
