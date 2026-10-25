import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MlService } from "../src/ml/service.js";
import { terminal } from "../src/ml/model.js";
const root = fileURLToPath(new URL("..", import.meta.url));
const python = process.env.CODEFLOW_TEST_ML_PYTHON;

test("pinned AutoGluon recipe preserves split contracts and exports a predictor usable in a fresh process", { skip: !python, timeout: 120000 }, async () => {
  execFileSync(python!, ["-B", "training/recipes/tabular-autogluon/test_recipe.py"], { cwd: root, timeout: 30000 });
  execFileSync(process.execPath, ["scripts/build-training-worker.mjs"], { cwd: root });
  const home = await realpath(await mkdtemp(join(tmpdir(), "codeflow-real-ml-")));
  const options = { home, enabled: () => true, authorize: async (_project: string, repo: string) => ({ repo, commit: "a".repeat(40) }) };
  let service = new MlService(options);
  let jobId: string | undefined;
  try {
    await service.load(); await service.configure("local", { python, revision: 1 });
    const source = join(home, "examples.csv");
    await writeFile(source, "feature,group,target\n" + Array.from({ length: 300 }, (_, i) => `${i},${Math.floor(i / 10)},${i * 2 + i % 3}`).join("\n"));
    const snapshot = await service.snapshot({ project: "p", repo: home, target: "local", path: source, location: "target" });
    const input = { project: "p", repo: home, name: "Regression with grouped rows", dataset: snapshot.id, operationId: randomUUID(), spec: { task: "regression", label: "target", split: { kind: "group", column: "group" }, seed: 42, trainSeconds: 20, cpus: 2 } };
    let job = await service.startJob(input); jobId = job.id;
    await service.close(); service = new MlService(options); await service.load();
    for (let i = 0; i < 90; i++) { job = await service.inspect(job.id); if (terminal(job.status.state)) break; await new Promise(resolve => setTimeout(resolve, 500)); }
    assert.equal(job.status.state, "succeeded", JSON.stringify(job.status));
    assert.equal(job.status.evaluation?.metric, "rmse");
    assert.ok(job.status.evaluation!.candidate < job.status.evaluation!.baseline);
    assert.equal((await service.startJob(input)).id, job.id);
    const artifact = await service.export(job.id), extracted = join(home, "exported"); await mkdir(extracted);
    execFileSync(python!, ["-c", "import tarfile,sys; tarfile.open(sys.argv[1]).extractall(sys.argv[2],filter='data')", artifact, extracted]);
    const output = join(home, "predictions.csv");
    execFileSync(python!, [join(extracted, "predict.py"), source, output], { timeout: 30000 });
    assert.equal((await readFile(output, "utf8")).trim().split("\n").length, 301);
    const manifest = JSON.parse(await readFile(join(extracted, "manifest.json"), "utf8"));
    assert.equal(manifest.datasetHash, snapshot.dataset.hash);
    assert.equal(manifest.bundle, job.intent.bundle);
    assert.ok(manifest.files.length > 0);
    const cycle = await service.cycles.create({ training: { ...input, operationId: randomUUID() }, objective: "Improve validation quality", planner: { kind: "builtin" }, limits: { iterations: 2, trainSeconds: input.spec.trainSeconds * 2, elapsedSeconds: 600, patience: 2, minImprovement: 0 } });
    for (let i = 0; i < 240; i++) {
      await service.reconcile(); await service.cycles.tick();
      const state = service.store.read().cycles.find(c => c.id === cycle.id)!;
      if (["completed", "stopped", "paused"].includes(state.state)) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const search = service.store.read().cycles.find(c => c.id === cycle.id)!;
    assert.equal(search.state, "completed", JSON.stringify(search));
    assert.equal(search.trials.length, 2); assert.ok(search.finalJobId, JSON.stringify(search));
    const final = service.store.read().experiments.find(e => e.id === search.finalJobId)!;
    const winner = service.store.read().experiments.find(e => e.id === search.bestJobId)!;
    assert.equal(final.status.state, "succeeded", JSON.stringify(final.status) + "\n" + (await service.logs(final.id, 0)).text);
    assert.equal(winner.status.evaluation?.partition, "validation"); assert.equal(final.status.evaluation?.partition, "test");
    assert.equal(final.status.evaluation?.modelHash, winner.status.evaluation?.modelHash);
    assert.equal(final.status.evaluation?.splitHash, winner.status.evaluation?.splitHash);
    assert.ok(final.status.artifact); assert.ok(!winner.status.artifact);
    const finalExport = await service.export(final.id); assert.ok((await readFile(finalExport)).length > 0);
  } finally {
    if (jobId) {
      const current = await service.inspect(jobId);
      if (!terminal(current.status.state)) { await service.cancel(jobId); for (let i = 0; i < 50; i++) { if (terminal((await service.inspect(jobId)).status.state)) break; await new Promise(resolve => setTimeout(resolve, 100)); } }
    }
    for (const cycle of service.store.read().cycles) if (!["completed", "stopped"].includes(cycle.state)) { await service.cycles.stop(cycle.id); for (let i = 0; i < 100 && service.active(); i++) { await service.reconcile(); await service.cycles.tick(); await new Promise(resolve => setTimeout(resolve, 100)); } }
    await service.close(); await rm(home, { recursive: true, force: true });
  }
});
