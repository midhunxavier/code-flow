import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MlService } from "../src/ml/service.js";
import { LLM_RECIPE, terminal, type Experiment } from "../src/ml/model.js";
const root = fileURLToPath(new URL("..", import.meta.url));
const python = process.env.CODEFLOW_TEST_LLM_PYTHON;
const device = process.env.CODEFLOW_TEST_LLM_DEVICE ?? "cpu";

test("offline LoRA fine-tunes, reconnects, evaluates and reloads its exported adapter", { skip: !python, timeout: 240000 }, async () => {
  execFileSync(python!, ["-B", "training/recipes/llm-sft-lora/test_recipe.py"], { cwd: root, timeout: 30000, stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-training-worker.mjs"], { cwd: root });
  const home = await realpath(await mkdtemp(join(tmpdir(), "codeflow-real-llm-"))), base = join(home, "base");
  execFileSync(python!, ["-B", "training/recipes/llm-sft-lora/test_recipe.py", "fixture", base], { cwd: root, timeout: 30000, stdio: "pipe" });
  const options = { home, enabled: () => true, authorize: async (_project: string, repo: string) => ({ repo, commit: "a".repeat(40) }) };
  let service = new MlService(options), active: Experiment | undefined;
  async function finish(job: Experiment) {
    for (let i = 0; i < 200; i++) {
      job = await service.inspect(job.id);
      if (terminal(job.status.state)) {
        assert.equal(job.status.state, "succeeded", JSON.stringify(job.status) + "\n" + (await service.logs(job.id, 0)).text);
        return job;
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new Error("Job did not finish: " + JSON.stringify(job.status));
  }
  try {
    await service.load(); await service.configure("local", { python, revision: 1 });
    const capability = await service.probe("local");
    assert.ok(capability.recipes?.find(r => r.id === LLM_RECIPE)?.devices?.includes(device));
    active = await service.startJob({ project: "p", repo: home, target: "local", path: base, operationId: randomUUID() }, "model");
    const model = await finish(active); assert.equal(model.status.model?.architecture, "llama");
    const snapshot = await service.snapshot({ project: "p", repo: home, target: "local", path: join(home, device === "mps" ? "messages.jsonl" : "prompt.jsonl"), location: "target" });
    const input = { project: "p", repo: home, name: "Offline tiny Llama LoRA", recipe: LLM_RECIPE, model: model.id, dataset: snapshot.id, operationId: randomUUID(), spec: { task: "sft", device, maxLength: 64, maxSteps: 3, rank: 4, learningRate: 0.001, accumulation: 1, seed: 42, trainSeconds: 30, cpus: 2 } };
    active = await service.startJob(input);
    await service.close(); service = new MlService(options); await service.load();
    const done = await finish(active), score = done.status.evaluation!;
    assert.equal(score.metric, "completion_nll"); assert.equal(score.baseModelHash, model.status.model?.hash);
    assert.ok(score.candidate < score.baseline, JSON.stringify(score));
    assert.equal(done.status.progress?.step, 3);
    assert.equal((await service.startJob(input)).id, done.id);
    const artifact = await service.export(done.id), exported = join(home, "export"); await mkdir(exported);
    execFileSync(python!, ["-c", "import tarfile,sys; tarfile.open(sys.argv[1]).extractall(sys.argv[2],filter='data')", artifact, exported]);
    const workerJob = join(home, "ml/worker/jobs", done.id);
    const verification = `import sys,json,importlib.util\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\nimport predict\nspec=importlib.util.spec_from_file_location('recipe',sys.argv[2]); recipe=importlib.util.module_from_spec(spec);spec.loader.exec_module(recipe)\nmodel,tokenizer=predict.load(sys.argv[3],sys.argv[4]); import torch; torch.set_num_threads(2)\nprint(json.dumps(recipe.score_model(model,json.loads(Path(sys.argv[5]).read_text()),sys.argv[4],tokenizer.pad_token_id)))`;
    const reloaded = JSON.parse(execFileSync(python!, ["-c", verification, exported, join(root, "training/recipes/llm-sft-lora/recipe.py"), base, device, join(workerJob, "test.json")], { encoding: "utf8", timeout: 30000 }));
    assert.ok(Math.abs(reloaded.loss - score.candidate) < 0.00001, "Fresh export reload preserves held-out score");
    assert.equal(reloaded.tokens, score.evaluatedTokens);
    const manifest = JSON.parse(await readFile(join(exported, "manifest.json"), "utf8"));
    assert.equal(manifest.bundle, done.intent.bundle); assert.equal(manifest.device, device);
    const members = execFileSync(python!, ["-c", "import tarfile,sys,json;print(json.dumps(tarfile.open(sys.argv[1]).getnames()))", artifact], { encoding: "utf8" });
    assert.ok(!JSON.parse(members).some((name: string) => ["train.json", "test.json", "tuning.json", "model.safetensors"].includes(name)));
    execFileSync(python!, [join(exported, "predict.py"), "--base-model", base, "--device", device, "--prompt", "user: 5 assistant:", "--max-new-tokens", "2"], { timeout: 30000, stdio: "pipe" });
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
    if (active && !terminal((await service.inspect(active.id)).status.state)) {
      await service.cancel(active.id);
      for (let i = 0; i < 100 && !terminal((await service.inspect(active.id)).status.state); i++) await new Promise(resolve => setTimeout(resolve, 100));
    }
    for (const cycle of service.store.read().cycles) if (!["completed", "stopped"].includes(cycle.state)) { await service.cycles.stop(cycle.id); for (let i = 0; i < 100 && service.active(); i++) { await service.reconcile(); await service.cycles.tick(); await new Promise(resolve => setTimeout(resolve, 100)); } }
    await service.close(); await rm(home, { recursive: true, force: true });
  }
});
