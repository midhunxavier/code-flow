import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MlService } from "../src/ml/service.js";
import { terminal, type Experiment } from "../src/ml/model.js";

for (const llm of [false, true]) {
  const python = process.env[llm ? "CODEFLOW_TEST_LLM_PYTHON" : "CODEFLOW_TEST_ML_PYTHON"];
  test(`real ${llm ? "LoRA" : "AutoGluon"} exports trained on different data pass a common holdout and roll back`, { skip: !python, timeout: 240000 }, async () => {
    execFileSync(process.execPath, ["scripts/build-training-worker.mjs"]);
    const home = await realpath(await mkdtemp(join(tmpdir(), "codeflow-real-holdout-")));
    const options = { home, enabled: () => true, authorize: async (_project: string, repo: string) => ({ repo, commit: "a".repeat(40) }) };
    let service = new MlService(options);
    const poll = async (job: Experiment) => {
      for (let i = 0; i < 360 && !terminal(job.status.state); i++) { await new Promise(r => setTimeout(r, 250)); job = await service.inspect(job.id); }
      assert.equal(job.status.state, "succeeded", JSON.stringify(job.status) + "\n" + (await service.logs(job.id, 0)).text); return job;
    };
    try {
      await service.load(); await service.configure("local", { python, revision: 1 });
      let base: Experiment | undefined;
      if (llm) {
        execFileSync(python!, ["-B", "training/recipes/llm-sft-lora/test_recipe.py", "fixture", join(home, "base")]);
        base = await poll(await service.startJob({ project: "p", repo: home, target: "local", path: join(home, "base"), operationId: randomUUID() }, "model"));
      }
      const source = join(home, llm ? "data.jsonl" : "data.csv"), jobs: Experiment[] = [];
      for (let i = 0; i < 2; i++) {
        const n = llm ? i ? 40 : 30 : i ? 120 : 100;
        await writeFile(source, llm ? Array.from({ length: n }, (_, k) => JSON.stringify({ prompt: `user: ${k} assistant: `, completion: `answer ${k}` })).join("\n") : "x,target\n" + Array.from({ length: n }, (_, k) => { const x = (k + (i ? .5 : .25)) / n; return `${x},${Number(x > (i ? .5 : .8))}`; }).join("\n"));
        const data = await service.snapshot({ project: "p", repo: home, target: "local", path: source, location: "target" });
        jobs.push(await poll(await service.startJob({ project: "p", repo: home, name: `New data ${i}`, dataset: data.id, operationId: randomUUID(), ...(llm ? { recipe: "llm-sft-lora-v1", model: base!.id, spec: { task: "sft", seed: 42, trainSeconds: 60, cpus: 2, device: "cpu", maxLength: 64, maxSteps: i ? 12 : 1, rank: 4, learningRate: .001, accumulation: 1 } } : { spec: { task: "classification", label: "target", split: { kind: "random" }, seed: 42, trainSeconds: 10, cpus: 2, forest: { trees: 32, depth: 8 } } }) })));
      }
      assert.notEqual(jobs[0]!.intent.dataset!.hash, jobs[1]!.intent.dataset!.hash);
      await writeFile(source, llm ? Array.from({ length: 30 }, (_, k) => JSON.stringify({ prompt: `user: ${k + 40} assistant: `, completion: `answer ${k + 40}` })).join("\n") : "x,target\n" + Array.from({ length: 60 }, (_, k) => { const x = (k + .375) / 60; return `${x},${Number(x > .5)}`; }).join("\n"));
      const holdout = await service.snapshot({ project: "p", repo: home, target: "local", path: source, location: "target", purpose: "holdout" });
      let model = await service.registry.register({ project: "p", repo: home, jobId: jobs[0]!.id, name: "Common holdout pilot", operationId: randomUUID() });
      model = await service.registry.select(model.id, "promote", { versionId: model.versions[0]!.id, revision: model.revision, operationId: randomUUID(), reason: "Reviewed incumbent", reviewed: true });
      model = await service.registry.register({ project: "p", repo: home, jobId: jobs[1]!.id, modelId: model.id, revision: model.revision, operationId: randomUUID() });
      const d = await service.deployments.create({ project: "p", repo: home, name: "Holdout endpoint", modelId: model.id, versionId: model.versions[0]!.id, target: "local", config: { mode: "persistent", device: "cpu", cpus: 2, timeoutSeconds: 60, memoryMiB: 4096, idleSeconds: 120, lifetimeSeconds: 600, maxRows: 4, maxInputTokens: 64, maxNewTokens: 8 }, operationId: randomUUID(), reason: "Verify common evaluation", reviewed: true });
      let p = await service.promotions.create({ deploymentId: d.id, revision: d.revision, operationId: randomUUID(), name: "Changed-data policy", source: { kind: "registry" }, mode: "approval", authorized: true, includeExisting: true, limits: { minImprovement: 0, maxAttempts: 1, cooldownSeconds: 60, approvalSeconds: 3600, observationSeconds: 180 }, health: { windowSeconds: 60, minRequests: 10, minSamples: 20, consecutiveWindows: 2, maxErrorRate: .2, maxLatencyMs: 100000, driftThreshold: .3, cooldownSeconds: 60, maxActions: 1 }, holdout: { datasetId: holdout.id, maxEvaluations: 2, seconds: 180, memoryMiB: 4096, maxLength: 64, allowServingPause: true } });
      for (let i = 0; i < 400 && !p.decisions.length && p.state === "enabled"; i++) { await service.promotions.tick(); p = service.store.read().promotions[0]!; await new Promise(r => setTimeout(r, 250)); }
      assert.equal(p.decisions[0]?.state, "awaiting_approval", JSON.stringify(p) + "\n" + JSON.stringify(service.store.read().experiments.at(-1)));
      const result = service.store.read().experiments.find(j => j.id === p.decisions[0]!.holdoutJobId)!.status.holdout!;
      console.log({ recipe: llm ? "LoRA" : "AutoGluon", ...result });
      assert.equal(result.rows, holdout.dataset.rows);
      assert.equal(service.store.read().deployments[0]!.revision, d.revision);
      await service.close(); service = new MlService(options); await service.load();
      p = await service.promotions.update(p.id, "approve", { revision: p.revision, decisionId: p.decisions[0]!.id, reason: "Approve paired evaluation on independent data" });
      assert.equal(p.decisions[0]!.state, "observing", JSON.stringify(p));
      assert.equal((await service.deployments.predict(d.id, llm ? { prompt: "user: 70 assistant: ", maxNewTokens: 2 } : { rows: [{ x: .7 }] })).versionId, model.versions[1]!.id);
      p = await service.promotions.update(p.id, "rollback", { revision: p.revision, decisionId: p.decisions[0]!.id, reason: "Verify rollback after real common holdout" });
      assert.equal(p.decisions[0]!.state, "rolled_back", JSON.stringify(p));
      assert.equal(service.store.read().deployments[0]!.current, d.current);
      assert.equal(service.store.read().registry[0]!.selectedVersionId, model.versions[0]!.id);
      assert.equal((await service.deployments.runtime(d.id)).state, "ready");
      assert.ok((await readFile(join(home, "ml/state.json"))).length);
      // A different snapshot hash cannot disguise even one original input.
      let endpoint = service.store.read().deployments[0]!;
      endpoint = await service.deployments.update(d.id, "stop", { revision: endpoint.revision, operationId: randomUUID(), reason: "Prepare overlap rejection check" });
      const lines = (await readFile(source, "utf8")).split("\n");
      if (llm) lines[0] = JSON.stringify({ prompt: "user: 0 assistant: ", completion: "changed reference answer" });
      else lines[1] = `${.25 / 100},1`;
      await writeFile(source, lines.join("\n"));
      const contaminated = await service.snapshot({ project: "p", repo: home, target: "local", path: source, location: "target", purpose: "holdout" });
      endpoint = await service.deployments.update(d.id, "resume", { revision: endpoint.revision, operationId: randomUUID(), reason: "Verify overlap rejection restores serving" });
      let rejected = await service.promotions.create({ deploymentId: d.id, revision: endpoint.revision, operationId: randomUUID(), name: "Overlap must fail", source: p.source, mode: "automatic", authorized: true, includeExisting: true, limits: p.limits, health: p.health, holdout: { ...p.holdout!, datasetId: contaminated.id } });
      for (let i = 0; i < 200 && rejected.state === "enabled"; i++) { await service.promotions.tick(); rejected = service.store.read().promotions.find(x => x.id === rejected.id)!; await new Promise(r => setTimeout(r, 100)); }
      assert.equal(rejected.evaluations![0]!.state, "failed", JSON.stringify(rejected));
      assert.match(rejected.reason!, /overlaps model training/);
      assert.equal(rejected.decisions.length, 0);
      assert.equal(service.store.read().deployments[0]!.current, d.current);
      assert.equal((await service.deployments.runtime(d.id)).state, "ready");
    } finally {
      for (const p of service.store.read().promotions) if (p.state === "enabled") await service.promotions.update(p.id, "pause", { revision: p.revision });
      for (let i = 0; i < 20 && service.promotions.active(); i++) { await service.promotions.tick(); await new Promise(r => setTimeout(r, 100)); }
      for (const d of service.store.read().deployments) if (d.enabled) await service.deployments.update(d.id, "stop", { revision: d.revision, operationId: randomUUID(), reason: "Pilot complete" });
      await service.close(); await rm(home, { recursive: true, force: true });
    }
  });
}
