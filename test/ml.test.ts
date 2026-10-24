import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { cycleTerminal, proposal, type Cycle } from "../src/ml/cycle-model.js";
import { plannerInput } from "../src/ml/planner.js";
import { MlService, type MlOptions } from "../src/ml/service.js";
import { MlStore } from "../src/ml/store.js";
import { TrainingTransport } from "../src/ml/transport.js";
import { LLM_RECIPE, llmSpec, jobStatus, trainingSpec, intent, terminal, type Experiment } from "../src/ml/model.js";
import { hash } from "../src/training-worker/files.js";
import { fixture as sshFixture } from "./ssh-project-fixture.js";
const root = fileURLToPath(new URL("..", import.meta.url));
let directory: string, bundlePath: string;
// This JavaScript recipe runs under Node; worker mechanics require no Python or model downloads.
const fixture = `
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const action=process.argv[2], job=process.argv[3];
const save=(name,value)=>fs.writeFileSync(path.join(job,name),JSON.stringify(value));
if(action==='probe')console.log(JSON.stringify({ready:true,devices:['cpu','mps','cuda']}));
else if(action==='inspect')console.log(JSON.stringify(job.endsWith('.jsonl')?{rows:100,columns:['prompt','completion'],missing:{prompt:0,completion:0},duplicateRows:0,schema:'prompt-completion'}:{rows:100,columns:['x','target'],missing:{x:0,target:0},duplicateRows:0}));
else if(action==='snapshot-model')save('model.json',{hash:'d'.repeat(64),bytes:1024,parameters:100000,architecture:'llama',contextLength:2048,files:4});
else if(action==='train'){
 const v=JSON.parse(fs.readFileSync(path.join(job,'intent.json')));
 fs.appendFileSync(path.join(job,'launch-count'),'1');
 const folder=v.recipe==='llm-sft-lora-v1'?'adapter':'model';fs.mkdirSync(path.join(job,folder),{recursive:true});fs.writeFileSync(path.join(job,folder,'weights'),'weights');
 if(v.recipe==='llm-sft-lora-v1')save('progress.json',{step:2,totalSteps:v.spec.maxSteps,loss:1.2});
 if(v.spec.trainSeconds===101 || v.spec.forest?.trees===256){const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(path.join(job,'descendant'),String(child.pid));setInterval(()=>{},1000)}
 else if(v.spec.trainSeconds===102){console.error('fixture confirmed failure');process.exitCode=1}
 else setTimeout(()=>console.log('fixture fit completed'),600);
}
else if(action==='evaluate'){
 const v=JSON.parse(fs.readFileSync(path.join(job,'intent.json')));
 const folder=v.recipe==='llm-sft-lora-v1'?'adapter':'model'; const files=[{bytes:7,hash:crypto.createHash('sha256').update('weights').digest('hex'),path:folder+'/weights'}];
 const modelHash=crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
 save('manifest.json',v.recipe==='llm-sft-lora-v1'?{adapterFiles:files,tokenizerFiles:[]}:{files});
 if(v.recipe==='llm-sft-lora-v1')save('evaluation.json',{metric:'completion_nll',direction:'lower',baseline:2,candidate:1.2,improved:true,trainRows:60,tuningRows:20,testRows:20,droppedDuplicates:0,datasetHash:v.dataset.hash,splitHash:'b'.repeat(64),modelHash,partition:v.search?.partition??'test',recipe:v.recipe,seed:42,evaluatedTokens:200,baseModelHash:v.model.hash});
 else save('evaluation.json',{metric:'accuracy',direction:'higher',baseline:0.5,candidate:0.8,improved:true,trainRows:60,tuningRows:20,testRows:20,droppedDuplicates:0,datasetHash:v.dataset.hash,splitHash:'b'.repeat(64),modelHash,partition:v.search?.partition??'test',recipe:'tabular-autogluon-v1',seed:42});
}
else if(action==='package'){const data=Buffer.from('fixture artifact');fs.writeFileSync(path.join(job,'model.tar.gz'),data);save('artifact.json',{hash:crypto.createHash('sha256').update(data).digest('hex'),bytes:data.length,filename:'model.tar.gz'});}
else if(action!=='prepare'&&action!=='baseline')throw Error('unexpected fixture action');
`;
const servingFixture = `
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const emit=value=>console.log(JSON.stringify(value));
if(process.argv[2]==='probe'){emit({ready:true,devices:['cpu','mps','cuda']});process.exit(0)}
if(process.argv[2]==='serve'){
 const lines=require('node:readline').createInterface({input:process.stdin});let context;
 lines.on('line',line=>{
  const value=JSON.parse(line);
  if(!context){context=value;const fail=path.join(context.root,'resident-load-fail');if(fs.existsSync(fail)&&fs.readFileSync(fail,'utf8')===context.release.versionId){emit({type:'error',error:'Fixture model failed to load'});process.exit(0)}fs.appendFileSync(path.join(context.root,'resident-loads'),String(process.pid)+'\\n');emit({type:'ready'});return}
  const input=value.input;
  if(input.rows?.[0]?.x==='inputfail'){emit({type:'error',kind:'input',error:'Prompt or generation exceeds the deployment token limits'});return}
  if(input.rows?.[0]?.x==='slow'||input.prompt==='slow'){const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(path.join(context.root,'resident-descendant'),String(child.pid));setInterval(()=>{},1000);return}
  if(input.rows?.[0]?.x==='memory'){global.allocation=Buffer.alloc(300*1024*1024,1);setInterval(()=>{},1000);return}
  if(context.release.recipe==='llm-sft-lora-v1'){
   if(value.stream){emit({type:'delta',text:'hello '});setTimeout(()=>emit({type:'delta',text:'world'}),300)}
   setTimeout(()=>emit({type:'done',result:{text:'hello world',inputTokens:3,outputTokens:2}}),500);
  }else emit({type:'done',result:{predictions:input.rows.map(row=>row.x)}});
 });
}else{
 let body='';process.stdin.on('data',c=>body+=c);process.stdin.on('end',()=>{const r=JSON.parse(body);if(r.input?.rows?.[0]?.x==='inputfail'){emit({ok:false,kind:'input',error:'Invalid input'});return}if(r.input?.rows?.[0]?.x==='fail'){emit({ok:false,error:'Fixture load or inference failure'});return}if(r.input?.rows?.[0]?.x==='slow'){const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(path.join(r.root,'inference-descendant'),String(child.pid));setInterval(()=>{},1000);return}emit({ok:true,result:r.mode==='prepare'?{ready:true}:r.release.recipe==='llm-sft-lora-v1'?{text:'fixture answer',inputTokens:3,outputTokens:2}:{predictions:r.input.rows.map(row=>row.x)}});});
}
`;
const holdoutFixture = `
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const job=process.argv[2],v=JSON.parse(fs.readFileSync(path.join(job,'intent.json')));
fs.appendFileSync(path.join(job,'launch-count'),'1');
if(v.holdout.maxLength===128){const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(path.join(job,'descendant'),String(child.pid));setInterval(()=>{},1000)}
else if(v.holdout.maxLength===256){global.allocation=Buffer.alloc(300*1024*1024,1);setInterval(()=>{},1000)}
else setTimeout(()=>fs.writeFileSync(path.join(job,'holdout.json'),JSON.stringify({version:1,datasetHash:v.dataset.hash,candidateHash:v.holdout.candidate.artifact.hash,incumbentHash:v.holdout.incumbent.artifact.hash,evaluator:v.bundle,populationHash:'e'.repeat(64),rows:v.dataset.rows,metric:'accuracy',direction:'higher',baseline:.5,incumbent:.7,candidate:.95})),1000);
`;
before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-ml-test-")));
  execFileSync(process.execPath, ["scripts/build-training-worker.mjs"], { cwd: root });
  const bundle = JSON.parse(await readFile(join(root, "dist/training-worker.json"), "utf8"));
  bundle.files["inference.py"] = servingFixture;
  bundle.files["holdout.py"] = holdoutFixture;
  bundle.files["recipe.py"] = fixture; bundle.files["llm_recipe.py"] = fixture; bundle.version = hash(JSON.stringify(bundle.files));
  bundlePath = join(directory, "fixture-bundle.json"); await writeFile(bundlePath, JSON.stringify(bundle));
});

for (const ssh of [false, true]) test(`common holdout uses one ${ssh ? "SSH" : "local"} worker job across restart, restores serving, then approves and rolls back`, { timeout: 60000 }, async () => {
  const f = ssh ? await sshFixture() : undefined, c = ssh ? undefined : await context();
  const options = f ? { home: f.localHome, bundlePath, transport: new TrainingTransport(bundlePath, f.ssh), enabled: () => true, authorize: async (_p: string, repo: string) => ({ repo, commit: "a".repeat(40) }) } : undefined;
  let service = c?.service ?? new MlService(options!); if (f) await service.load();
  try {
    const target = f ? await service.register({ host: "fixture", name: "Holdout SSH VM", directory: join(f.remoteHome, "holdout"), python: process.execPath, standalone: true }) : service.store.read().targets[0]!;
    const home = f?.remoteHome ?? c!.home, repo = f?.repo ?? c!.home, source = join(home, "holdout-input.csv"), jobs: Experiment[] = [];
    for (let k = 0; k < 2; k++) {
      await writeFile(source, "x,target\n" + `${k},1\n`.repeat(100));
      const data = await service.snapshot({ project: "p", repo, target: target.id, path: source, location: "target" });
      jobs.push(await until(service, await service.startJob({ project: "p", repo, name: "Changed training data", dataset: data.id, operationId: randomUUID(), spec: { task: "classification", label: "target", split: { kind: "random" }, seed: 42, trainSeconds: 10, cpus: 1 } })));
    }
    await writeFile(source, "x,target\n" + "99,1\n".repeat(100));
    const holdout = await service.snapshot({ project: "p", repo, target: target.id, path: source, location: "target", purpose: "holdout" });
    await assert.rejects(service.startJob({ project: "p", repo, name: "Leak attempt", dataset: holdout.id, operationId: randomUUID(), spec: jobs[0]!.intent.spec }), /reserved/);
    let model = await service.registry.register({ project: "p", repo, jobId: jobs[0]!.id, name: "Paired model", operationId: randomUUID() });
    model = await service.registry.select(model.id, "promote", { versionId: model.versions[0]!.id, revision: model.revision, operationId: randomUUID(), reason: "Reviewed incumbent" });
    model = await service.registry.register({ project: "p", repo, jobId: jobs[1]!.id, modelId: model.id, revision: model.revision, operationId: randomUUID() });
    const d = await service.deployments.create({ project: "p", repo, name: "Common endpoint", modelId: model.id, versionId: model.versions[0]!.id, target: target.id, config: residentLimits, operationId: randomUUID(), reason: "Verify common comparison" });
    let p = await service.promotions.create({ deploymentId: d.id, revision: d.revision, operationId: randomUUID(), name: "Common policy", source: { kind: "registry" }, mode: "approval", authorized: true, includeExisting: true, limits: { minImprovement: .01, maxAttempts: 1, cooldownSeconds: 60, approvalSeconds: 3600, observationSeconds: 180 }, health: { ...monitoringLimits, maxActions: 1 }, holdout: { datasetId: holdout.id, maxEvaluations: 2, seconds: 60, memoryMiB: 256, maxLength: 64, allowServingPause: true } });
    await service.promotions.tick(); await service.promotions.tick();
    p = service.store.read().promotions[0]!; assert.equal(p.evaluations![0]!.state, "running", JSON.stringify(p));
    const evaluation = service.store.read().experiments.find(j => j.id === p.evaluations![0]!.jobId)!;
    assert.match((await service.deployments.runtime(d.id)).reason!, /Common holdout/);
    await assert.rejects(service.deployments.predict(d.id, { rows: [{ x: 1 }] }), /using this computer|holdout|busy|progress|handling an inference/i);
    await service.close(); service = f ? new MlService(options!) : await c!.create(); if (f) await service.load();
    for (let i = 0; i < 80 && !p.decisions.length; i++) { await service.promotions.tick(); p = service.store.read().promotions[0]!; await new Promise(r => setTimeout(r, 50)); }
    assert.equal(p.decisions[0]?.state, "awaiting_approval", JSON.stringify(p));
    assert.equal(await readFile(join(target.directory, "jobs", evaluation.id, "launch-count"), "utf8"), "1");
    assert.equal((await service.deployments.runtime(d.id)).state, "ready");
    assert.equal(service.store.read().deployments[0]!.revision, d.revision);
    assert.equal((await service.deployments.predict(d.id, { rows: [{ x: 1 }] })).versionId, model.versions[0]!.id);
    p = await service.promotions.update(p.id, "approve", { revision: p.revision, decisionId: p.decisions[0]!.id, reason: "Approve paired holdout scores" });
    assert.equal(p.decisions[0]!.state, "observing", JSON.stringify(p));
    p = await service.promotions.update(p.id, "rollback", { revision: p.revision, decisionId: p.decisions[0]!.id, reason: "Verify rollback" });
    assert.equal(p.decisions[0]!.state, "rolled_back"); assert.equal(service.store.read().deployments[0]!.current, d.current);
    assert.equal(service.store.read().registry[0]!.selectedVersionId, model.versions[0]!.id);
  } finally { await stopResidents(service); await service.close(); if (f) await f.cleanup(); }
});

for (const action of ["cancel", "stop", "memory"] as const) test(`common holdout ${action} terminates the evaluator and preserves the serving owner's intent`, { timeout: 30000 }, async () => {
  const c = await context(), service = c.service;
  try {
    const first = await until(service, await service.startJob(c.request())), second = await until(service, await service.startJob(c.request()));
    await writeFile(c.source, "x,target\n" + "99,0\n".repeat(100));
    const data = await service.snapshot({ project: "p", repo: c.home, target: "local", path: c.source, location: "target", purpose: "holdout" });
    let model = await service.registry.register({ project: "p", repo: c.home, jobId: first.id, name: "Cancellation model", operationId: randomUUID() });
    model = await service.registry.select(model.id, "promote", { versionId: model.versions[0]!.id, revision: model.revision, operationId: randomUUID(), reason: "Reviewed incumbent" });
    model = await service.registry.register({ project: "p", repo: c.home, jobId: second.id, modelId: model.id, revision: model.revision, operationId: randomUUID() });
    const d = await service.deployments.create({ project: "p", repo: c.home, name: "Cancellation endpoint", modelId: model.id, versionId: model.versions[0]!.id, target: "local", config: residentLimits, operationId: randomUUID(), reason: "Verify cancellation" });
    let p = await service.promotions.create({ deploymentId: d.id, revision: d.revision, operationId: randomUUID(), name: "Bounded policy", source: { kind: "registry" }, mode: "approval", authorized: true, includeExisting: true, limits: { minImprovement: 0, maxAttempts: 1, cooldownSeconds: 60, approvalSeconds: 3600, observationSeconds: 180 }, health: { ...monitoringLimits, maxActions: 1 }, holdout: { datasetId: data.id, maxEvaluations: 1, seconds: 60, memoryMiB: 256, maxLength: action === "memory" ? 256 : 128, allowServingPause: true } });
    await service.promotions.tick(); await service.promotions.tick();
    p = service.store.read().promotions[0]!;
    const job = service.store.read().experiments.find(e => e.id === p.evaluations![0]!.jobId)!;
    const childFile = join(c.home, "ml/worker/jobs", job.id, "descendant");
    let child: number | undefined;
    if (action !== "memory") {
      for (let i = 0; i < 100; i++) { child = await readFile(childFile, "utf8").then(Number, () => undefined); if (child) break; await new Promise(r => setTimeout(r, 30)); }
      assert.ok(child);
      if (action === "stop") await service.deployments.update(d.id, "stop", { revision: d.revision, operationId: randomUUID(), reason: "Owner stopped serving during evaluation" });
      else await service.promotions.update(p.id, "pause", { revision: p.revision });
    }
    for (let i = 0; i < 100 && service.promotions.active(); i++) { await service.promotions.tick(); await new Promise(r => setTimeout(r, 50)); }
    p = service.store.read().promotions[0]!;
    assert.equal(p.evaluations![0]!.state, action === "memory" ? "failed" : "cancelled", JSON.stringify(p));
    assert.equal(p.decisions.length, 0); assert.equal(p.evaluations!.length, 1);
    if (child) assert.throws(() => process.kill(child!, 0), { code: "ESRCH" });
    assert.equal(service.store.read().deployments[0]!.enabled, action !== "stop");
    assert.equal((await service.deployments.runtime(d.id)).state, action === "stop" ? "stopped" : "ready");
    if (action === "memory") assert.match(service.store.read().experiments.find(e => e.id === job.id)!.status.error!, /memory/i);
  } finally { await stopResidents(service); await service.close(); }
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
async function context(options: Partial<MlOptions> = {}) {
  const home = join(directory, randomUUID()); await mkdir(home);
  const source = join(home, "data.csv"); await writeFile(source, "x,target\n" + Array.from({ length: 100 }, (_, i) => `${i},${i % 2}`).join("\n"));
  let permitted = true, enabled = true;
  const create = async () => { const service = new MlService({ ...options, home, bundlePath, enabled: () => enabled, authorize: async (project, repo) => { if (!permitted || project !== "p" || repo !== home) throw new Error("Membership revoked"); return { repo, commit: "a".repeat(40) }; } }); await service.load(); return service; };
  const service = await create(); await service.store.change(s => { s.targets[0]!.python = process.execPath; });
  const snapshot = await service.snapshot({ project: "p", repo: home, target: "local", path: source, location: "target" });
  const request = (seconds = 10) => ({ project: "p", repo: home, name: "Test", dataset: snapshot.id, operationId: randomUUID(), spec: { task: "classification", label: "target", split: { kind: "random" }, seed: 42, trainSeconds: seconds, cpus: 1 } });
  return { home, source, service, create, snapshot, request, revoke: () => { permitted = false; }, disable: () => { enabled = false; } };
}
async function until(service: MlService, job: Experiment, predicate: (e: Experiment) => boolean = e => terminal(e.status.state), attempts = 120) {
  let current = job;
  for (let i = 0; i < attempts; i++) { current = await service.inspect(job.id); if (predicate(current)) return current; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(`Job did not settle: ${JSON.stringify(current.status)}`);
}

test("training schema rejects scope widening, invalid resources and ambiguous split contracts", () => {
  const valid = { task: "classification", label: "target", split: { kind: "random" }, trainSeconds: 10, cpus: 1 };
  assert.equal(trainingSpec(valid).seed, 42);
  for (const patch of [{ command: "arbitrary" }, { cpus: 0 }, { trainSeconds: 4000 }, { split: { kind: "random", column: "x" } }, { split: { kind: "group", column: "target" } }]) assert.throws(() => trainingSpec({ ...valid, ...patch }));
});

test("durable state rejects a failed write without publishing a reservation", async () => {
  const home = join(directory, randomUUID()), store = new MlStore(home); await store.load();
  const before = store.read(); await rm(join(home, "state.json")); await mkdir(join(home, "state.json"));
  await assert.rejects(store.change(s => { s.defaults.p = "local"; }));
  assert.deepEqual(store.read(), before);
});

test("duplicate starts launch once, restart reconnects, export is checksummed and source edits do not change the snapshot", { timeout: 20000 }, async () => {
  const c = await context(), input = c.request();
  const [a, b] = await Promise.all([c.service.startJob(input), c.service.startJob(input)]);
  assert.equal(a.id, b.id); await writeFile(c.source, "changed source\n");
  await until(c.service, a, e => e.status.state === "training"); await c.service.close();
  const restarted = await c.create();
  try {
    const done = await until(restarted, a); assert.equal(done.status.state, "succeeded", done.status.error);
    assert.equal(done.status.evaluation?.datasetHash, c.snapshot.dataset.hash);
    assert.equal(await readFile(join(c.home, "ml/worker/jobs", a.id, "launch-count"), "utf8"), "1");
    assert.equal((await restarted.startJob(input)).id, a.id);
    const file = await restarted.export(a.id); assert.equal(await readFile(file, "utf8"), "fixture artifact");
    await assert.rejects(restarted.startJob({ ...input, name: "changed" }), /different inputs/);
  } finally { await restarted.close(); }
});

test("cancellation confirms descendant termination and remains available after creation is disabled", { timeout: 20000 }, async () => {
  const c = await context(); const job = await c.service.startJob(c.request(101));
  try {
    await until(c.service, job, e => e.status.state === "training");
    const childFile = join(c.home, "ml/worker/jobs", job.id, "descendant");
    for (let i = 0; i < 100; i++) { if (await readFile(childFile).then(() => true, () => false)) break; await new Promise(resolve => setTimeout(resolve, 30)); }
    const descendant = Number(await readFile(childFile, "utf8"));
    c.disable(); await assert.rejects(c.service.startJob(c.request()), /Enable the local training preview/);
    await c.service.cancel(job.id); const done = await until(c.service, job);
    assert.equal(done.status.state, "cancelled"); assert.throws(() => process.kill(descendant, 0));
    assert.equal((await c.service.cancel(job.id)).status.state, "cancelled");
  } finally { await c.service.cancel(job.id); await until(c.service, job); await c.service.close(); }
});

test("worker fences a missing receipt before reporting failure, so a delayed submit cannot launch", { timeout: 15000 }, async () => {
  const c = await context(); const transport = new TrainingTransport(bundlePath);
  const target = c.service.store.read().targets[0]!, now = Date.now();
  const accepted = intent({ version: 1, id: randomUUID(), workerId: target.workerId, controllerId: c.service.store.read().controllerId, bundle: target.bundle, kind: "training", createdAt: now, deadline: now + 30000, python: process.execPath, dataset: c.snapshot.dataset, spec: c.request().spec, source: { project: "p", commit: "a".repeat(40) } });
  const request = { controllerId: accepted.controllerId, workerId: accepted.workerId, python: process.execPath, intent: accepted };
  try {
    const fenced = await transport.call<any>(target, { ...request, action: "reconcile" }); assert.equal(fenced.state, "failed");
    const submitted = await transport.call<any>(target, { ...request, action: "submit" }); assert.equal(submitted.state, "failed");
    await assert.rejects(readFile(join(target.directory, "jobs", accepted.id, "launch-count")));
  } finally { await transport.close(); await c.service.close(); }
});

test("confirmed failures, explicit membership and worker identities do not silently fall back", { timeout: 15000 }, async () => {
  const c = await context();
  try {
    const job = await c.service.startJob(c.request(102)); const done = await until(c.service, job); assert.equal(done.status.state, "failed");
    await assert.rejects(c.service.export(job.id), /no evaluated/);
    const alias = join(c.home, "link.csv"); await symlink(c.source, alias);
    await assert.rejects(c.service.snapshot({ project: "p", repo: c.home, target: "local", path: alias, location: "target" }));
    c.revoke(); await assert.rejects(c.service.startJob(c.request()), /Membership revoked/);
    await assert.rejects(c.service.logs(job.id, 0), /Membership revoked/);
  } finally { await c.service.close(); }
});

test("SSH transfer, durable cancellation after disconnect, and project defaults use the selected worker", { timeout: 30000 }, async () => {
  const f = await sshFixture();
  const transport = new TrainingTransport(bundlePath, f.ssh);
  let disconnected = false;
  const client = { call: async <T>(...args: Parameters<TrainingTransport["call"]>): Promise<T> => { if (disconnected) throw new Error("SSH disconnected"); return transport.call<T>(...args); }, close: () => transport.close() };
  const options = { home: f.localHome, bundlePath, transport: client, enabled: () => true, authorize: async (_project: string, repo: string) => ({ repo, commit: "a".repeat(40) }) };
  const service = new MlService(options); await service.load(); let job: Experiment | undefined;
  let reconnected: MlService | undefined;
  try {
    await assert.rejects(service.register({ host: "fixture", name: "Cluster", standalone: false }), /standalone/);
    const target = await service.register({ host: "fixture", name: "GPU VM", directory: join(f.remoteHome, "training"), python: process.execPath, standalone: true });
    await service.setDefault({ project: "p", repo: f.repo, target: target.id, revision: service.store.read().revision });
    assert.equal(service.overview("p").defaultTarget, target.id);
    const source = join(f.localHome, "large.csv");
    await writeFile(source, "x,target\n" + "some-feature,1\n".repeat(30000));
    const snapshot = await service.snapshot({ project: "p", repo: f.repo, path: source, location: "controller" });
    assert.equal(snapshot.target.id, target.id);
    const remoteFile = join(target.directory, "datasets", `${snapshot.dataset.hash}.csv`);
    assert.equal(hash(await readFile(remoteFile)), snapshot.dataset.hash);
    const input = { project: "p", repo: f.repo, name: "Remote test", dataset: snapshot.id, operationId: randomUUID(), spec: { task: "classification", label: "target", split: { kind: "random" }, seed: 42, cpus: 1, trainSeconds: 101 } };
    job = await service.startJob(input);
    await until(service, job, e => e.status.state === "training");
    disconnected = true;
    const pending = await service.cancel(job.id); assert.equal(pending.status.state, "cancel_requested"); assert.ok(pending.cancelRequestedAt);
    await service.close();
    reconnected = new MlService({ ...options, transport: new TrainingTransport(bundlePath, f.ssh) }); await reconnected.load();
    const cancelled = await until(reconnected, job); assert.equal(cancelled.status.state, "cancelled");
    job = await reconnected.startJob({ ...input, operationId: randomUUID(), spec: { ...input.spec, trainSeconds: 10 } });
    const finished = await until(reconnected, job); assert.equal(finished.status.state, "succeeded", finished.status.error);
    assert.equal(await readFile(await reconnected.export(job.id), "utf8"), "fixture artifact");
    const audit: string[][] = (await readFile(f.audit, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(audit.some(args => args.includes("StrictHostKeyChecking=yes") && args.includes("ForwardAgent=no")));
    const enrolled = reconnected.store.read().targets.find(t => t.id === target.id)!;
    await writeFile(join(target.directory, "worker.json"), JSON.stringify({ version: 1, controllerId: reconnected.store.read().controllerId, workerId: randomUUID() }));
    await assert.rejects(reconnected.probe(enrolled.id), /identity/);
    assert.equal(reconnected.overview("p").defaultTarget, target.id, "identity mismatch never falls back to local");
  } finally {
    disconnected = false;
    const active = reconnected ?? service;
    if (job && !terminal((await active.inspect(job.id)).status.state)) { await active.cancel(job.id); await until(active, job); }
    await reconnected?.close(); await service.close(); await f.cleanup();
  }
});

test("worker deadline stops descendants without a connected controller", { timeout: 20000 }, async () => {
  const c = await context(), transport = new TrainingTransport(bundlePath);
  const target = c.service.store.read().targets[0]!, now = Date.now();
  const accepted = intent({ version: 1, id: randomUUID(), workerId: target.workerId, controllerId: c.service.store.read().controllerId, bundle: target.bundle, kind: "training", createdAt: now, deadline: now + 2500, python: process.execPath, dataset: c.snapshot.dataset, spec: c.request(101).spec, source: { project: "p", commit: "a".repeat(40) } });
  const authority = { controllerId: accepted.controllerId, workerId: accepted.workerId, python: process.execPath };
  try {
    await transport.call(target, { ...authority, action: "submit", intent: accepted });
    await transport.close(); await c.service.close();
    await new Promise(resolve => setTimeout(resolve, 3500));
    const result: any = await new TrainingTransport(bundlePath).call(target, { ...authority, action: "inspect", id: accepted.id });
    assert.equal(result.state, "failed"); assert.match(result.error, /deadline/);
    const child = Number(await readFile(join(target.directory, "jobs", accepted.id, "descendant"), "utf8"));
    assert.throws(() => process.kill(child, 0));
  } finally {
    await transport.call(target, { ...authority, action: "cancel", id: accepted.id }); await transport.close();
  }
});

test("lost supervisors remain unresolved across restart and block another admission", { timeout: 15000 }, async () => {
  const c = await context(), job = await c.service.startJob(c.request(101));
  let child: number | undefined;
  try {
    const running = await until(c.service, job, e => e.status.state === "training" && !!e.status.child);
    child = running.status.child!.pid; process.kill(running.status.runner!.pid, "SIGKILL");
    await c.service.close(); const restarted = await c.create();
    try {
      const unknown = await until(restarted, job, e => e.status.state === "unknown");
      assert.equal(unknown.status.state, "unknown");
      await assert.rejects(restarted.startJob(c.request()), /active or unresolved/);
      assert.equal((await restarted.startJob({ ...c.request(), operationId: job.operationId, spec: job.intent.spec })).id, job.id);
    } finally { await restarted.close(); }
  } finally { if (child) { try { process.kill(-child, "SIGKILL"); } catch {} } await c.service.close(); }
});

const fineTune = { task: "sft", device: "cpu", maxLength: 64, maxSteps: 2, rank: 4, learningRate: 0.0002, accumulation: 1, seed: 42, trainSeconds: 10, cpus: 1 };
test("LoRA contracts reject implicit GPU selection and invalid evaluation evidence", () => {
  assert.equal(llmSpec(fineTune).task, "sft");
  for (const patch of [{ device: "auto" }, { device: "cuda" }, { gpu: "GPU-12345678" }, { maxLength: 8192 }, { learningRate: 0 }, { quantization: "4bit" }, { rank: 0 }]) assert.throws(() => llmSpec({ ...fineTune, ...patch }));
  assert.equal(llmSpec({ ...fineTune, device: "cuda", gpu: "GPU-12345678" }).gpu, "GPU-12345678");
  assert.throws(() => jobStatus({ id: "job", state: "training", updatedAt: Date.now(), progress: { step: 3, totalSteps: 2 } }));
});

test("LLM model preparation, immutable input scope, progress and worker upgrade preserve durable jobs", { timeout: 30000 }, async () => {
  const c = await context();
  const currentBundle = JSON.parse(await readFile(bundlePath, "utf8"));
  const nextPath = join(c.home, "bundle.json"); await writeFile(nextPath, JSON.stringify(currentBundle));
  await c.service.close();
  const service = new MlService({ home: c.home, bundlePath: nextPath, enabled: () => true, authorize: async (_p, repo) => ({ repo, commit: "a".repeat(40) }) }); await service.load();
  try {
    const input = { project: "p", repo: c.home, target: "local", path: join(c.home, "base"), operationId: randomUUID() };
    const model = await until(service, await service.startJob(input, "model"));
    assert.equal(model.status.model?.architecture, "llama"); assert.equal((await service.startJob(input, "model")).id, model.id);
    const pendingId = randomUUID();
    const reservation = service.store.change(s => { s.experiments.push({ ...model, id: pendingId, operationId: randomUUID(), intent: { ...model.intent, id: pendingId }, status: { id: pendingId, state: "submitted", updatedAt: Date.now() } }); });
    const update = service.upgrade("local");
    await reservation; await assert.rejects(update, /Finish or reconcile/);
    await service.store.change(s => { s.experiments.find(e => e.id === pendingId)!.status.state = "cancelled"; });
    await assert.rejects(service.startJob({ project: "p", repo: c.home, name: "wrong format", recipe: LLM_RECIPE, dataset: c.snapshot.id, model: model.id, operationId: randomUUID(), spec: fineTune }), /selected recipe/);
    const source = join(c.home, "examples.jsonl"); await writeFile(source, '{"prompt":"x","completion":"y"}\n'.repeat(100));
    const snapshot = await service.snapshot({ project: "p", repo: c.home, target: "local", path: source, location: "target" });
    const start = { project: "p", repo: c.home, name: "LoRA", recipe: LLM_RECIPE, dataset: snapshot.id, model: model.id, operationId: randomUUID(), spec: fineTune };
    await assert.rejects(service.startJob({ ...start, model: "missing" }), /prepared base model/);
    await assert.rejects(service.startJob({ ...start, spec: { ...fineTune, device: "cuda", gpu: "GPU-12345678" } }), /available NVIDIA/);
    const job = await service.startJob(start);
    await assert.rejects(service.upgrade("local"), /Finish or reconcile/);
    const done = await until(service, job); assert.equal(done.status.state, "succeeded", done.status.error);
    assert.equal(done.status.progress?.step, 2); assert.equal(done.status.evaluation?.metric, "completion_nll");
    currentBundle.files["llm_recipe.py"] += "\n// newer fixed recipe\n"; currentBundle.version = hash(JSON.stringify(currentBundle.files)); await writeFile(nextPath, JSON.stringify(currentBundle));
    const upgraded = await service.upgrade("local"); assert.equal(upgraded.workerId, job.target.workerId);
    assert.equal(service.store.read().targets[0]!.bundle, currentBundle.version);
    assert.notEqual((await service.inspect(job.id)).target.bundle, currentBundle.version);
    assert.equal(await readFile(await service.export(job.id), "utf8"), "fixture artifact");
    const next = await until(service, await service.startJob({ ...start, operationId: randomUUID() }));
    assert.equal(next.status.state, "succeeded", next.status.error); assert.equal(next.intent.bundle, currentBundle.version);
  } finally { await service.close(); }
});

test("SSH fine-tuning transfers JSONL, retains model identity and cancels after reconnect", { timeout: 30000 }, async () => {
  const f = await sshFixture();
  const options = { home: f.localHome, bundlePath, enabled: () => true, authorize: async (_p: string, repo: string) => ({ repo, commit: "a".repeat(40) }) };
  let service = new MlService({ ...options, transport: new TrainingTransport(bundlePath, f.ssh) }); await service.load();
  let job: Experiment | undefined;
  try {
    const target = await service.register({ host: "fixture", name: "Fine-tuning VM", directory: join(f.remoteHome, "llm"), python: process.execPath, standalone: true });
    const model = await until(service, await service.startJob({ project: "p", repo: f.repo, target: target.id, path: join(f.remoteHome, "base"), operationId: randomUUID() }, "model"));
    const source = join(f.localHome, "examples.jsonl"); await writeFile(source, '{"prompt":"x","completion":"y"}\n'.repeat(10000));
    const data = await service.snapshot({ project: "p", repo: f.repo, target: target.id, path: source, location: "controller" });
    assert.equal(hash(await readFile(join(target.directory, "datasets", `${data.dataset.hash}.jsonl`))), data.dataset.hash);
    const input = { project: "p", repo: f.repo, name: "SSH LoRA", recipe: LLM_RECIPE, dataset: data.id, model: model.id, operationId: randomUUID(), spec: { ...fineTune, trainSeconds: 101 } };
    job = await service.startJob(input); await until(service, job, e => e.status.state === "training");
    await service.close(); service = new MlService({ ...options, transport: new TrainingTransport(bundlePath, f.ssh) }); await service.load();
    assert.equal((await service.startJob(input)).id, job.id);
    await service.cancel(job.id); assert.equal((await until(service, job)).status.state, "cancelled");
    job = await service.startJob({ ...input, operationId: randomUUID(), spec: fineTune });
    const done = await until(service, job); assert.equal(done.status.state, "succeeded", done.status.error);
    assert.equal(done.status.evaluation?.baseModelHash, model.status.model?.hash);
    assert.equal(done.target.id, target.id); assert.equal(await readFile(await service.export(done.id), "utf8"), "fixture artifact");
    const search = await service.cycles.create(cycleRequest({ ...input, operationId: randomUUID(), spec: fineTune }, { limits: { iterations: 2, trainSeconds: fineTune.trainSeconds * 2, elapsedSeconds: 300, patience: 2, minImprovement: 0 } }));
    const searched = await settleCycle(service, search); assert.equal(searched.state, "completed", searched.reason); assert.ok(searched.finalJobId);
    const final = service.store.read().experiments.find(e => e.id === searched.finalJobId)!;
    assert.equal(final.target.id, target.id); assert.equal(final.status.evaluation?.partition, "test"); assert.ok(final.status.artifact);
    assert.equal(final.intent.model?.hash, model.status.model?.hash);
  } finally {
    if (job && !terminal((await service.inspect(job.id)).status.state)) { await service.cancel(job.id); await until(service, job); }
    await service.close(); await f.cleanup();
  }
});

const cycleRequest = (training: unknown, overrides: Record<string, unknown> = {}) => ({ training, objective: "Improve validation accuracy", planner: { kind: "builtin" }, limits: { iterations: 3, trainSeconds: 30, elapsedSeconds: 300, patience: 3, minImprovement: 0 }, ...overrides });
async function settleCycle(service: MlService, cycle: Cycle) {
  for (let i = 0; i < 240; i++) {
    await service.reconcile(); await service.cycles.tick();
    const c = service.store.read().cycles.find(c => c.id === cycle.id)!;
    if (cycleTerminal(c) || c.state === "paused") return c;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Cycle did not settle: " + JSON.stringify(service.store.read().cycles));
}
test("automatic search bounds iterations, reserves time, evaluates validation only, and tests the winner without retraining", { timeout: 40000 }, async () => {
  const c = await context();
  try {
    const raw = cycleRequest(c.request()), search = await c.service.cycles.create(raw);
    assert.equal((await c.service.cycles.create(raw)).id, search.id);
    await assert.rejects(c.service.startJob(c.request()), /search|active|unresolved/);
    await assert.rejects(c.service.upgrade("local"), /job/);
    const done = await settleCycle(c.service, search);
    assert.equal(done.state, "completed", done.reason); assert.equal(done.trials.length, 3); assert.equal(done.reservedTrainSeconds, 30);
    const jobs = c.service.store.read().experiments;
    assert.equal(jobs.length, 4); assert.equal(done.bestJobId, done.trials[0]!.jobId, "ties keep earliest winner");
    for (const t of done.trials) { const e = jobs.find(e => e.id === t.jobId)!; assert.equal(e.status.evaluation?.partition, "validation"); assert.equal(e.status.artifact, undefined); await assert.rejects(c.service.export(e.id), /export/); await assert.rejects(c.service.registry.register({ project: e.project, repo: e.repo, jobId: e.id, name: "Trial", operationId: randomUUID() }), /successful final test/); }
    const final = jobs.find(e => e.id === done.finalJobId)!;
    assert.equal(final.status.evaluation?.partition, "test"); assert.ok(final.status.artifact);
    assert.equal(final.intent.search?.fromJob?.modelHash, jobs[0]!.status.evaluation?.modelHash);
    assert.equal(await readFile(join(c.home, "ml/worker/jobs", final.id, "launch-count")).then(() => true, () => false), false);
    assert.equal(await readFile(await c.service.export(final.id), "utf8"), "fixture artifact");
    let registered = await c.service.registry.register({ project: final.project, repo: final.repo, jobId: final.id, name: "Local search winner", operationId: randomUUID() });
    registered = await c.service.registry.select(registered.id, "promote", { versionId: registered.versions[0]!.id, revision: registered.revision, operationId: randomUUID(), reason: "Final held-out result reviewed" });
    assert.equal(registered.selectedVersionId, registered.versions[0]!.id);
    assert.equal(c.service.active(), false);
  } finally { await c.service.close(); }
});
test("planner proposals cannot widen compute, steps, data, or split; rejected iteration survives restart", { timeout: 30000 }, async () => {
  const c = await context({ planner: async () => ({ stop: false, reason: "widen limits", parameters: { trees: 64, depth: 8, cpus: 8 } }) });
  let service = c.service;
  try {
    const search = await service.cycles.create(cycleRequest(c.request()));
    const paused = await settleCycle(service, search);
    assert.equal(paused.state, "paused"); assert.equal(paused.trials.length, 1); assert.equal(paused.reservedTrainSeconds, 0); assert.equal(service.store.read().experiments.length, 0);
    await service.close(); service = await c.create();
    const persisted = service.store.read().cycles[0]!;
    assert.equal(persisted.expiresAt, search.expiresAt); assert.equal(persisted.trials.length, 1);
    await service.cycles.resume(search.id); await settleCycle(service, search);
    assert.equal(service.store.read().cycles[0]!.trials.length, 2);
    await service.cycles.stop(search.id); await service.cycles.tick(); assert.equal(service.store.read().cycles[0]!.state, "stopped");
    const base = llmSpec({ task: "sft", device: "cpu", maxLength: 64, maxSteps: 2, rank: 8, learningRate: 0.0002, accumulation: 1, cpus: 1, trainSeconds: 10 });
    for (const parameters of [{ maxSteps: 3 }, { device: "cuda" }, { seed: 1 }, { maxLength: 128 }, { model: "replacement" }, { trainSeconds: 100 }]) assert.throws(() => proposal({ stop: false, reason: "bad", parameters }, base));
  } finally { await service.close(); }
});
test("consumed budgets and feature disablement cannot authorize another trial after restart", { timeout: 30000 }, async () => {
  const c = await context(); let service = c.service;
  try {
    const search = await service.cycles.create(cycleRequest(c.request(101), { limits: { iterations: 3, trainSeconds: 202, elapsedSeconds: 600, patience: 3, minImprovement: 0 } }));
    await service.cycles.tick();
    const job = service.store.read().experiments[0]!; assert.ok(job);
    await until(service, job, e => e.status.state === "training");
    await service.close(); service = await c.create();
    assert.equal(service.store.read().cycles[0]!.reservedTrainSeconds, 101);
    await service.reconcile(); await service.cycles.tick(); assert.equal(service.store.read().experiments.length, 1);
    c.disable(); await service.cycles.tick(); assert.equal(service.store.read().cycles[0]!.state, "paused");
    await service.cycles.stop(search.id);
    const stopped = await settleCycle(service, search); assert.equal(stopped.state, "stopped"); assert.equal(stopped.reservedTrainSeconds, 101);
    assert.equal(service.store.read().experiments.length, 1);
  } finally { await service.close(); }
});
test("planner input omits paths, dataset values, test metrics and logs", { timeout: 20000 }, async () => {
  const c = await context();
  try {
    const search = await c.service.cycles.create(cycleRequest(c.request())); await c.service.cycles.tick();
    const current = c.service.store.read().cycles[0]!;
    const jobs = c.service.store.read().experiments;
    jobs[0]!.status.error = "secret worker output";
    const input = JSON.stringify(plannerInput(current, jobs));
    for (const forbidden of [c.home, c.source, c.snapshot.dataset.hash, "secret worker output", "splitHash", "workerId", "testRows", '"label"']) assert.ok(!input.includes(forbidden), forbidden);
    await c.service.cycles.stop(search.id); await settleCycle(c.service, search);
  } finally { await c.service.close(); }
});

test("worker enforces the reserved training-process time and does not retry failed trials", { timeout: 30000 }, async () => {
  const c = await context();
  try {
    const input = c.request(); input.spec = { ...input.spec, forest: { trees: 256, depth: 16 } } as typeof input.spec;
    const start = Date.now(); const search = await c.service.cycles.create(cycleRequest(input, { limits: { iterations: 3, trainSeconds: 10, elapsedSeconds: 300, patience: 3, minImprovement: 0 } }));
    const done = await settleCycle(c.service, search);
    assert.equal(done.state, "completed", done.reason); assert.equal(done.trials.length, 1); assert.equal(done.reservedTrainSeconds, 10);
    const job = c.service.store.read().experiments[0]!;
    assert.equal(job.status.state, "failed"); assert.match(job.status.error!, /training time/); assert.ok(Date.now() - start < 20000);
    const pid = Number(await readFile(join(c.home, "ml/worker/jobs", job.id, "descendant"), "utf8")); assert.throws(() => process.kill(pid, 0));
    assert.equal(done.finalJobId, undefined);
  } finally { await c.service.close(); }
});
test("restart consumes an interrupted planner claim and the original elapsed deadline expires", { timeout: 20000 }, async () => {
  let claimed!: () => void; const began = new Promise<void>(r => { claimed = r; });
  const c = await context({ planner: async (_c, _j, signal) => { claimed(); await new Promise<void>(resolve => { signal.addEventListener("abort", () => resolve(), { once: true }); }); throw new Error("interrupted"); } });
  let service = c.service;
  try {
    const cycle = await service.cycles.create(cycleRequest(c.request())); await began;
    const persisted = service.store.read(); assert.equal(persisted.cycles[0]!.trials[0]!.state, "planning");
    await service.close();
    // Recreate the crash-time durable claim, without a live planner process.
    await writeFile(join(c.home, "ml/state.json"), JSON.stringify(persisted)); service = await c.create();
    assert.equal(service.store.read().cycles[0]!.state, "paused"); assert.equal(service.store.read().cycles[0]!.trials[0]!.state, "rejected");
    await service.store.change(s => { const c = s.cycles[0]!; c.createdAt = Date.now() - c.limits.elapsedSeconds * 1000 - 1000; c.expiresAt = c.createdAt + c.limits.elapsedSeconds * 1000; });
    await assert.rejects(service.cycles.resume(cycle.id), /deadline/); await service.cycles.tick();
    assert.equal(service.store.read().cycles[0]!.state, "stopped"); assert.equal(service.store.read().experiments.length, 0);
  } finally { await service.close(); }
});
test("Claude planner uses an isolated text-only command with validated JSON output", { timeout: 25000 }, async () => {
  const bin = join(directory, randomUUID()); await mkdir(bin);
  const audit = join(bin, "invocation.json"), executable = join(bin, "claude"), path = process.env.PATH;
  const flags = ["--safe-mode", "--restricted", "--tools", "--disallowedTools", "--strict-mcp-config", "--mcp-config", "--disable-slash-commands", "--no-session-persistence", "--no-chrome", "--json-schema", "--settings"];
  await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv.includes('--help')){console.log(${JSON.stringify(flags.join(" "))});}else{let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(audit)},JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),input:JSON.parse(input)}));console.log(JSON.stringify({type:'result',structured_output:{stop:false,reason:'Try shallow trees',parameters:{trees:64,depth:8}}}));});}`);
  await chmod(executable, 0o700); process.env.PATH = `${bin}:${path}`;
  const c = await context();
  try {
    const search = await c.service.cycles.create(cycleRequest(c.request(), { planner: { kind: "claude", model: "fixture-model" }, limits: { iterations: 1, trainSeconds: 10, elapsedSeconds: 300, patience: 1, minImprovement: 0 } }));
    const done = await settleCycle(c.service, search); assert.equal(done.state, "completed", done.reason);
    const call = JSON.parse(await readFile(audit, "utf8"));
    assert.equal(call.args[call.args.indexOf("--tools") + 1], ""); assert.equal(call.args[call.args.indexOf("--disallowedTools") + 1], "mcp__*");
    assert.ok(call.args.includes("--safe-mode") && call.args.includes("--restricted"));
    assert.ok(call.cwd.startsWith(join(c.home, "ml/planner/turn-"))); assert.ok(!JSON.stringify(call.input).includes(c.home));
    assert.equal(done.trials[0]!.spec?.task === "sft" ? undefined : done.trials[0]!.spec?.forest?.depth, 8);
  } finally { process.env.PATH = path; await c.service.close(); }
});

test("a lost submit response retains one trial reservation through disconnect and restart", { timeout: 30000 }, async () => {
  const transport = new TrainingTransport(bundlePath); let disconnected = false;
  const client = { call: async <T>(...args: Parameters<TrainingTransport["call"]>): Promise<T> => {
    if (disconnected) throw new Error("Transport disconnected");
    const result = await transport.call<T>(...args);
    if (args[1].action === "submit") { disconnected = true; throw new Error("Submit reply lost"); }
    return result;
  }, close: () => transport.close() };
  const c = await context({ transport: client }); let service = c.service;
  try {
    const search = await service.cycles.create(cycleRequest(c.request())); await service.cycles.tick();
    await service.reconcile(); await service.cycles.tick();
    let current = service.store.read().cycles[0]!;
    assert.equal(current.state, "paused"); assert.equal(current.reservedTrainSeconds, 10); assert.equal(current.trials.length, 1);
    await assert.rejects(service.cycles.resume(search.id), /Reconcile/);
    await service.close(); service = new MlService({ home: c.home, bundlePath, enabled: () => true, authorize: async (_p, repo) => ({ repo, commit: "a".repeat(40) }) }); await service.load();
    const job = service.store.read().experiments[0]!; await until(service, job);
    assert.equal(await readFile(join(c.home, "ml/worker/jobs", job.id, "launch-count"), "utf8"), "1");
    await service.cycles.resume(search.id);
    current = await settleCycle(service, search); assert.equal(current.state, "completed", current.reason); assert.equal(current.reservedTrainSeconds, 30); assert.equal(current.trials.length, 3);
  } finally { disconnected = false; await service.close(); }
});

test("patience keeps the baseline when no candidate clears the minimum improvement", { timeout: 20000 }, async () => {
  const c = await context();
  try {
    const search = await c.service.cycles.create(cycleRequest(c.request(), { limits: { iterations: 3, trainSeconds: 30, elapsedSeconds: 300, patience: 1, minImprovement: 0.5 } }));
    const done = await settleCycle(c.service, search);
    assert.equal(done.state, "completed"); assert.equal(done.trials.length, 1); assert.equal(done.bestJobId, undefined); assert.equal(done.finalJobId, undefined);
    assert.match(done.reason!, /no candidate beat/); assert.equal(done.reservedTrainSeconds, 10);
    await assert.rejects(c.service.store.change(s => { s.cycles[0]!.reservedTrainSeconds = 0; }), /reservation changed/);
    await assert.rejects(c.service.store.change(s => { s.cycles = []; }), /Missing search ledger/);
  } finally { await c.service.close(); }
});
test("changed winning artifacts fail final testing without retraining or fallback", { timeout: 20000 }, async () => {
  const c = await context({ planner: async (cycle, jobs) => {
    if (cycle.trials.length === 1) return { stop: false, reason: "Initial configuration", parameters: { trees: 64, depth: 16 } };
    const winner = jobs.find(j => j.id === cycle.bestJobId)!;
    await writeFile(join(winner.target.directory, "jobs", winner.id, "model/weights"), "changed");
    return { stop: true, reason: "Conclude the search" };
  } });
  try {
    const search = await c.service.cycles.create(cycleRequest(c.request()));
    const done = await settleCycle(c.service, search); assert.equal(done.state, "completed", done.reason);
    assert.ok(done.finalJobId); assert.equal(done.reservedTrainSeconds, 10);
    const final = c.service.store.read().experiments.find(e => e.id === done.finalJobId)!;
    assert.equal(final.status.state, "failed"); assert.match(final.status.error!, /checksum changed/); assert.equal(final.status.artifact, undefined);
    assert.equal(await readFile(join(final.target.directory, "jobs", final.id, "launch-count")).then(() => true, () => false), false);
    assert.match(done.reason!, /no model recommended/);
  } finally { await c.service.close(); }
});

const scheduleRequest = (training: unknown, path: string, patch: Record<string, unknown> = {}) => ({ search: cycleRequest(training, { limits: { iterations: 1, trainSeconds: 10, elapsedSeconds: 300, patience: 1, minImprovement: 0 } }), source: { path, location: "target" }, cadence: { every: 5 }, stabilitySeconds: 60, maxCycles: 2, ...patch });
async function scheduledContext(options: Partial<MlOptions> = {}) {
  let now = Date.now();
  const c = await context({ ...options, scheduleClock: () => now });
  const policy = await c.service.schedules.create(scheduleRequest(c.request(), c.source));
  const check = async (service = c.service, advance = 300000) => { now += advance; await service.schedules.tick(); };
  return { ...c, policy, check };
}

test("scheduled retraining skips identical content, debounces new data, preserves budgets and exhausts its lifetime cap", { timeout: 30000 }, async () => {
  const c = await scheduledContext();
  try {
    assert.equal(c.service.active(), true); assert.equal(c.service.store.read().cycles.length, 0);
    const original = await readFile(c.source, "utf8");
    await writeFile(c.source, original); await c.check();
    assert.equal(c.service.store.read().schedules[0]!.candidate, undefined);
    await writeFile(c.source, original + "\n101,1"); await c.check();
    assert.ok(c.service.store.read().schedules[0]!.candidate); assert.equal(c.service.store.read().cycles.length, 0);
    await c.check(c.service, 59000); assert.equal(c.service.store.read().cycles.length, 0);
    await Promise.all([c.check(c.service, 1000), c.service.schedules.tick(), c.service.schedules.tick()]);
    const first = c.service.store.read().cycles[0]!; assert.ok(first.schedule); assert.deepEqual(first.limits, c.policy.limits);
    const completed = await settleCycle(c.service, first); assert.equal(completed.state, "completed", completed.reason); assert.equal(completed.reservedTrainSeconds, 10); assert.equal(completed.trials.length, 1); assert.ok(completed.finalJobId);
    await c.check(); assert.equal(c.service.store.read().cycles.length, 1);
    await writeFile(c.source, original); await c.check(); assert.equal(c.service.store.read().cycles.length, 1, "returning to the initial version is not new data");
    await writeFile(c.source, original + "\n102,0"); await c.check(); await c.check(c.service, 60000);
    const second = c.service.store.read().cycles[1]!; await settleCycle(c.service, second);
    const exhausted = c.service.store.read().schedules[0]!;
    assert.equal(exhausted.state, "exhausted"); assert.equal(exhausted.runs.length, 2); assert.equal(c.service.active(), false);
    await assert.rejects(c.service.schedules.update(exhausted.id, "resume", { revision: exhausted.revision }), /Lifetime/);
    await c.check(); assert.equal(c.service.store.read().cycles.length, 2);
    await assert.rejects(c.service.store.change(s => { s.schedules = []; }), /Missing schedule ledger/);
    await assert.rejects(c.service.store.change(s => { s.schedules[0]!.runs = []; }), /ledger/);
    await assert.rejects(c.service.store.change(s => { s.schedules[0]!.limits.trainSeconds = 20; }), /budget changed/);
  } finally { await c.service.close(); }
});

test("scheduled checks coalesce changing files and downtime; restart never duplicates an admitted version", { timeout: 25000 }, async () => {
  const c = await scheduledContext({ planner: async () => ({ stop: true, reason: "No further experiment needed" }) }); let service = c.service;
  try {
    const original = await readFile(c.source, "utf8");
    await writeFile(c.source, original + "\n101,1"); await c.check();
    await writeFile(c.source, original + "\n102,0"); await c.check(service, 60000);
    assert.equal(service.store.read().cycles.length, 0);
    await service.store.change(s => { s.schedules[0]!.pending = { id: randomUUID(), startedAt: Date.now() }; });
    await service.close(); service = await c.create();
    assert.equal(service.store.read().schedules[0]!.candidate, undefined); assert.equal(service.store.read().schedules[0]!.pending, undefined);
    await c.check(service, 86400000); assert.equal(service.store.read().cycles.length, 0);
    await c.check(service, 60000); await service.cycles.tick(); assert.equal(service.store.read().cycles.length, 1);
    const recorded = service.store.read().schedules[0]!.runs[0]!;
    assert.equal(recorded.hash, hash(await readFile(c.source)));
    await service.close(); service = await c.create(); await c.check(service, 86400000);
    assert.equal(service.store.read().cycles.length, 1); assert.equal(service.store.read().schedules[0]!.runs[0]!.cycleId, recorded.cycleId);
  } finally { await service.close(); }
});

test("pausing an in-flight data check fences late admission; resume retains the original limits", { timeout: 15000 }, async () => {
  const c = await scheduledContext();
  const original = c.service.fingerprint.bind(c.service); let release!: () => void, started!: () => void;
  const began = new Promise<void>(r => { started = r; }), gate = new Promise<void>(r => { release = r; });
  c.service.fingerprint = async raw => { started(); await gate; return original(raw); };
  try {
    await writeFile(c.source, (await readFile(c.source, "utf8")) + "\n101,1");
    const check = c.check(); await began;
    const paused = await c.service.schedules.update(c.policy.id, "pause", { revision: c.policy.revision });
    assert.equal(c.service.active(), true, "filesystem guard includes an in-flight check after pause");
    release(); await check; assert.equal(c.service.active(), false); assert.equal(c.service.store.read().cycles.length, 0);
    await assert.rejects(c.service.schedules.update(c.policy.id, "resume", { revision: c.policy.revision }), /changed/);
    const resumed = await c.service.schedules.update(c.policy.id, "resume", { revision: paused.revision });
    assert.deepEqual(resumed.limits, c.policy.limits); assert.equal(resumed.runs.length, 0);
    c.service.fingerprint = original; await c.check(); assert.equal(c.service.store.read().cycles.length, 0, "resume starts a new stability window");
  } finally { release?.(); await c.service.close(); }
});

test("late snapshot and planner preflight cannot launch after pausing a schedule", { timeout: 15000 }, async () => {
  const c = await scheduledContext(); let release!: () => void;
  try {
    await writeFile(c.source, (await readFile(c.source, "utf8")) + "\n101,1"); await c.check();
    const snapshot = c.service.snapshot.bind(c.service); let started!: () => void;
    const began = new Promise<void>(r => { started = r; }), gate = new Promise<void>(r => { release = r; });
    c.service.snapshot = async raw => { const result = await snapshot(raw); started(); await gate; return result; };
    const check = c.check(c.service, 60000); await began;
    await c.service.schedules.update(c.policy.id, "pause", { revision: c.policy.revision }); release(); await check;
    assert.equal(c.service.store.read().cycles.length, 0); assert.equal(c.service.store.read().schedules[0]!.runs.length, 0);
  } finally { release?.(); await c.service.close(); }
});

test("scheduled admission refuses schema drift and a file replaced during snapshot preparation", { timeout: 20000 }, async () => {
  const c = await scheduledContext();
  try {
    const original = await readFile(c.source, "utf8"); await writeFile(c.source, original + "\n101,1"); await c.check();
    const snapshot = c.service.snapshot.bind(c.service);
    c.service.snapshot = async raw => { await writeFile(c.source, original + "\n102,0"); return snapshot(raw); };
    await c.check(c.service, 60000); assert.equal(c.service.store.read().cycles.length, 0);
    assert.match(c.service.store.read().schedules[0]!.lastOutcome!, /changed during preparation/);
    c.service.snapshot = snapshot; await c.check(c.service, 60000);
    c.service.snapshot = async raw => { const result = await snapshot(raw); result.dataset.columns.push("unexpected"); return result; };
    await c.check(c.service, 60000);
    const paused = c.service.store.read().schedules[0]!; assert.equal(paused.state, "paused"); assert.match(paused.reason!, /columns or format/); assert.equal(paused.runs.length, 0);
  } finally { await c.service.close(); }
});

test("schedules enforce membership, feature availability, target pins and source readiness before new work", { timeout: 20000 }, async () => {
  for (const mode of ["membership", "disabled", "target", "missing"] as const) {
    const c = await scheduledContext(); let reads = 0;
    const fingerprint = c.service.fingerprint.bind(c.service); c.service.fingerprint = async raw => { reads++; return fingerprint(raw); };
    try {
      await assert.rejects(c.service.configure("local", { python: "/changed/python", revision: c.policy.template.target.revision }), /pause its schedules/);
      if (mode === "membership") c.revoke();
      if (mode === "disabled") c.disable();
      if (mode === "target") await c.service.store.change(s => { s.targets[0]!.revision++; });
      if (mode === "missing") await rm(c.source);
      await c.check(); const paused = c.service.store.read().schedules[0]!;
      assert.equal(paused.state, "paused", mode); assert.equal(reads, mode === "missing" ? 1 : 0); assert.equal(paused.runs.length, 0);
      await c.service.schedules.update(paused.id, "pause", { revision: paused.revision });
    } finally { await c.service.close(); }
  }
});

test("busy compute defers data checks and failed scheduled versions are never retried automatically", { timeout: 25000 }, async () => {
  const c = await scheduledContext({ planner: async () => ({ stop: false, reason: "Invalid agent output", parameters: { cpus: 99 } }) });
  try {
    const job = await c.service.startJob(c.request());
    await c.check(); assert.match(c.service.store.read().schedules[0]!.lastOutcome!, /Waiting for active/); assert.equal(c.service.store.read().schedules[0]!.lastCheckedAt, undefined);
    await until(c.service, job); await writeFile(c.source, (await readFile(c.source, "utf8")) + "\n101,1");
    await c.check(c.service, 60000); await c.check(c.service, 60000); await c.service.cycles.tick();
    const cycle = c.service.store.read().cycles[0]!; assert.equal(cycle.state, "paused"); assert.equal(cycle.trials.length, 1);
    let p = c.service.store.read().schedules[0]!;
    await c.service.schedules.update(p.id, "pause", { revision: p.revision, stopActive: true }); await c.service.cycles.tick();
    p = c.service.store.read().schedules[0]!; await c.service.schedules.update(p.id, "resume", { revision: p.revision }); await c.check();
    assert.equal(c.service.store.read().cycles.length, 1); assert.equal(c.service.store.read().schedules[0]!.runs.length, 1);
  } finally { await c.service.close(); }
});

test("scheduled source contracts require explicit time zones, finite caps and the prepared content", { timeout: 15000 }, async () => {
  const { cadence } = await import("../src/ml/schedule-model.js"); const { nextFire } = await import("../src/automation.js");
  for (const input of [{ every: 0 }, { every: 5, at: "02:00" }, { at: "02:00" }, { at: "25:00", timezone: "UTC" }, { at: "02:00", timezone: "invalid" }, { at: "02:00", timezone: "UTC", days: [] }]) assert.throws(() => cadence(input));
  const fall = cadence({ at: "02:30", timezone: "Europe/Stockholm" });
  assert.equal(new Date(nextFire(fall, Date.parse("2026-10-25T00:31:00Z"))).toISOString(), "2026-10-26T01:30:00.000Z", "fall-back does not run the repeated time twice");
  const c = await context();
  try {
    for (const patch of [{ maxCycles: 0 }, { maxCycles: 101 }, { stabilitySeconds: 0 }]) await assert.rejects(c.service.schedules.create(scheduleRequest(c.request(), c.source, patch)));
    await writeFile(c.source, "changed"); await assert.rejects(c.service.schedules.create(scheduleRequest(c.request(), c.source)), /source differs/);
    assert.equal(c.service.store.read().schedules.length, 0);
  } finally { await c.service.close(); }
});

test("dataset fingerprints reject symlinks, special files and oversize inputs", async () => {
  const { fingerprintFile } = await import("../src/ml/source.js");
  const folder = join(directory, randomUUID()); await mkdir(folder);
  const source = join(folder, "data.csv"), link = join(folder, "link.csv"), pipe = join(folder, "pipe.csv");
  await writeFile(source, "x,target\n1,0"); await symlink(source, link);
  await assert.rejects(fingerprintFile(link)); await assert.rejects(fingerprintFile(folder));
  execFileSync("mkfifo", [pipe]); await assert.rejects(fingerprintFile(pipe), /regular/);
  const { open } = await import("node:fs/promises"), fd = await open(source, "w"); await fd.truncate(129 * 1024 * 1024); await fd.close();
  await assert.rejects(fingerprintFile(source), /Dataset size/);
});

test("scheduled SSH data checks leave unchanged remote data in place and run tabular or LoRA searches on the pinned server", { timeout: 45000 }, async () => {
  const f = await sshFixture(), transport = new TrainingTransport(bundlePath, f.ssh); let now = Date.now(); const calls: string[] = [];
  const client = { call: async <T>(...args: Parameters<TrainingTransport["call"]>): Promise<T> => { calls.push(args[1].action as string); return transport.call<T>(...args); }, close: () => transport.close() };
  const service = new MlService({ home: f.localHome, bundlePath, transport: client, scheduleClock: () => now, enabled: () => true, authorize: async (_p, repo) => ({ repo, commit: "a".repeat(40) }) }); await service.load();
  try {
    const target = await service.register({ host: "fixture", name: "Training VM", directory: join(f.remoteHome, "scheduled-training"), python: process.execPath, standalone: true });
    for (const llm of [false, true]) {
      const location = llm ? "controller" : "target", source = join(llm ? f.localHome : f.remoteHome, llm ? "scheduled.jsonl" : "scheduled.csv");
      const content = llm ? '{"prompt":"x","completion":"y"}\n'.repeat(100) : "x,target\n" + "1,0\n".repeat(100); await writeFile(source, content);
      const data = await service.snapshot({ project: "p", repo: f.repo, target: target.id, path: source, location });
      const model = llm ? await until(service, await service.startJob({ project: "p", repo: f.repo, target: target.id, path: join(f.remoteHome, "base"), operationId: randomUUID() }, "model")) : undefined;
      const training = { project: "p", repo: f.repo, name: llm ? "Scheduled LoRA" : "Scheduled forest", dataset: data.id, operationId: randomUUID(), spec: llm ? fineTune : { task: "classification", label: "target", split: { kind: "random" }, seed: 42, trainSeconds: 10, cpus: 1 }, ...(llm ? { recipe: LLM_RECIPE, model: model!.id } : {}) };
      const policy = await service.schedules.create(scheduleRequest(training, source, { source: { path: source, location }, maxCycles: 1 }));
      calls.length = 0; now = policy.nextAt; await service.schedules.tick();
      assert.deepEqual(calls, llm ? [] : ["fingerprint"], "unchanged data needs no probe, snapshot, or upload");
      await writeFile(source, content + (llm ? '{"prompt":"new","completion":"answer"}\n' : "2,1\n")); now += 300000; await service.schedules.tick(); now += 60000; await service.schedules.tick();
      const search = service.store.read().cycles.at(-1)!; assert.equal(search.schedule?.id, policy.id); assert.equal(search.template.target.id, target.id);
      const done = await settleCycle(service, search); assert.equal(done.state, "completed", done.reason); assert.equal(done.reservedTrainSeconds, 10); assert.ok(done.finalJobId);
      const final = service.store.read().experiments.find(e => e.id === done.finalJobId)!;
      assert.equal(final.target.kind, "ssh"); assert.ok(final.status.artifact); assert.equal(final.intent.dataset!.hash, hash(await readFile(source)));
      if (llm) { assert.equal(final.intent.model!.hash, model!.status.model!.hash); assert.equal(final.status.evaluation!.metric, "completion_nll"); assert.ok(calls.includes("upload")); }
      else assert.ok(calls.includes("fingerprint"));
      let registered = await service.registry.register({ project: final.project, repo: final.repo, jobId: final.id, name: llm ? "SSH adapter" : "SSH predictor", operationId: randomUUID() });
      const transfers = calls.length;
      registered = await service.registry.select(registered.id, "promote", { versionId: registered.versions[0]!.id, revision: registered.revision, operationId: randomUUID(), reason: "Reviewed the scheduled final test" });
      await service.registry.withArchive(registered.selectedVersionId!, async fd => { assert.equal((await fd.stat()).size, final.status.artifact!.bytes); });
      assert.equal(calls.length, transfers, "registry selection and downloads use the retained export without SSH calls");
    }
  } finally { await service.close(); await f.cleanup(); }
});

test("scheduled local LoRA keeps its frozen base model, device, step cap and search limits", { timeout: 20000 }, async () => {
  let now = Date.now(); const c = await context({ scheduleClock: () => now });
  try {
    const model = await until(c.service, await c.service.startJob({ project: "p", repo: c.home, target: "local", path: join(c.home, "base"), operationId: randomUUID() }, "model"));
    const source = join(c.home, "data.jsonl"); await writeFile(source, '{"prompt":"x","completion":"y"}\n'.repeat(100));
    const data = await c.service.snapshot({ project: "p", repo: c.home, target: "local", path: source, location: "target" });
    const raw = scheduleRequest({ ...c.request(), recipe: LLM_RECIPE, model: model.id, dataset: data.id, spec: fineTune }, source, { maxCycles: 1 });
    const policy = await c.service.schedules.create(raw); assert.equal((await c.service.schedules.create(raw)).id, policy.id);
    await writeFile(source, (await readFile(source, "utf8")) + '{"prompt":"new","completion":"answer"}\n'); now = policy.nextAt; await c.service.schedules.tick(); now += 60000; await c.service.schedules.tick();
    const done = await settleCycle(c.service, c.service.store.read().cycles[0]!); assert.equal(done.state, "completed", done.reason);
    assert.deepEqual(done.template.intent.spec, fineTune); assert.equal(done.template.intent.model!.hash, model.status.model!.hash); assert.deepEqual(done.limits, policy.limits);
  } finally { await c.service.close(); }
});

test("pause during scheduled admission preflight prevents both the search and its occurrence claim", { timeout: 15000 }, async () => {
  const c = await scheduledContext(); let release!: () => void;
  try {
    await writeFile(c.source, (await readFile(c.source, "utf8")) + "\n101,1"); await c.check();
    const prepare = c.service.cycles.prepare.bind(c.service.cycles); let started!: () => void;
    const began = new Promise<void>(r => { started = r; }), gate = new Promise<void>(r => { release = r; });
    c.service.cycles.prepare = async raw => { const result = await prepare(raw); started(); await gate; return result; };
    const check = c.check(c.service, 60000); await began;
    await c.service.schedules.update(c.policy.id, "pause", { revision: c.policy.revision }); release(); await check;
    assert.equal(c.service.store.read().cycles.length, 0); assert.equal(c.service.store.read().schedules[0]!.runs.length, 0);
  } finally { release?.(); await c.service.close(); }
});

const servingLimits = { device: "cpu", cpus: 1, timeoutSeconds: 5, maxRows: 4, maxInputTokens: 32, maxNewTokens: 8 };
async function registeredResult(c: Awaited<ReturnType<typeof context>>, model?: import("../src/ml/registry-model.js").RegisteredModel) {
  const job = await until(c.service, await c.service.startJob(c.request()));
  return c.service.registry.register({ project: "p", repo: c.home, jobId: job.id, operationId: randomUUID(), ...(model ? { modelId: model.id, revision: model.revision } : { name: "Serving predictor" }) });
}
const deploymentChange = (d: import("../src/ml/deployment-model.js").Deployment, patch = {}) => ({ revision: d.revision, operationId: randomUUID(), reason: "Reviewed deployment behavior", ...patch });

test("deployments serve pinned versions, reject stale switches, preserve the registry, roll back and stop across restart", { timeout: 120000 }, async () => {
  const c = await context(); let service = c.service;
  try {
    let model = await registeredResult(c); model = await registeredResult(c, model);
    const raw = { project: "p", repo: c.home, name: "Prediction endpoint", modelId: model.id, versionId: model.versions[0]!.id, target: "local", config: servingLimits, operationId: randomUUID(), reason: "Reviewed the final test" };
    let d = await service.deployments.create(raw); assert.equal((await service.deployments.create(raw)).id, d.id);
    const first = await service.deployments.predict(d.id, { rows: [{ x: 7 }, { x: 2 }] }); assert.deepEqual(first.result.predictions, [7, 2]); assert.equal(first.versionId, model.versions[0]!.id);
    assert.equal(service.store.read().registry[0]!.selectedVersionId, undefined, "Deployment selection is independent of registry promotion");
    const change = deploymentChange(d, { versionId: model.versions[1]!.id });
    await assert.rejects(service.deployments.update(d.id, "switch", change), /Review this deployment/);
    d = await service.deployments.update(d.id, "switch", { ...change, reviewed: true });
    await assert.rejects(service.deployments.update(d.id, "rollback", { ...deploymentChange(d, { versionId: model.versions[0]!.id }), revision: 1 }), /changed/);
    assert.equal((await service.deployments.predict(d.id, { rows: [{ x: 9 }] })).versionId, model.versions[1]!.id);
    await service.close(); service = await c.create();
    d = await service.deployments.update(d.id, "rollback", deploymentChange(d, { versionId: model.versions[0]!.id }));
    assert.equal((await service.deployments.update(d.id, "switch", { ...change, reviewed: true })).current, d.current, "Delayed retry must not undo rollback");
    assert.deepEqual(d.history.map(h => h.action), ["deploy", "switch", "rollback"]);
    const failed = service.store.read(); await assert.rejects(service.store.change(s => { s.deployments[0]!.releases[0]!.artifact.hash = "f".repeat(64); }), /authority/); assert.deepEqual(service.store.read(), failed);
    d = await service.deployments.update(d.id, "stop", deploymentChange(d)); await assert.rejects(service.deployments.predict(d.id, { rows: [{ x: 1 }] }), /stopped/);
    d = await service.deployments.update(d.id, "resume", deploymentChange(d)); assert.equal((await service.deployments.predict(d.id, { rows: [{ x: 1 }] })).revision, d.revision);
    for (const input of [{ rows: [] }, { rows: [{ wrong: 1 }] }, { rows: [{ x: { code: "no" } }] }, { rows: Array.from({ length: 5 }, () => ({ x: 1 })) }]) await assert.rejects(service.deployments.predict(d.id, input));
    c.disable(); await assert.rejects(service.deployments.predict(d.id, { rows: [{ x: 1 }] }), /Enable/); await service.deployments.update(d.id, "stop", deploymentChange(d));
  } finally { await service.close(); }
});

test("inference owns the worker, enforces a process deadline, reaps descendants and stops new dispatches", { timeout: 90000 }, async () => {
  const c = await context();
  try {
    const model = await registeredResult(c), d = await c.service.deployments.create({ project: "p", repo: c.home, name: "Bounded inference", modelId: model.id, versionId: model.versions[0]!.id, target: "local", config: servingLimits, operationId: randomUUID(), reason: "Deadline verification" });
    const pending = c.service.deployments.predict(d.id, { rows: [{ x: "slow" }] }); const rejected = assert.rejects(pending, /timeout/);
    const marker = join(c.home, "ml/worker/inference-descendant"); let descendant = 0;
    for (let i = 0; i < 100; i++) { descendant = await readFile(marker, "utf8").then(Number, () => 0); if (descendant) break; await new Promise(r => setTimeout(r, 50)); } assert.ok(descendant);
    assert.equal(c.service.active(), true);
    await assert.rejects(c.service.deployments.predict(d.id, { rows: [{ x: 1 }] }), /handling an inference/);
    await assert.rejects(c.service.configure("local", { python: process.execPath, revision: c.service.store.read().targets[0]!.revision }), /job/);
    await c.service.deployments.update(d.id, "stop", deploymentChange(d)); await assert.rejects(c.service.deployments.predict(d.id, { rows: [{ x: 1 }] }), /stopped/);
    await rejected; assert.equal(c.service.active(), false);
    assert.throws(() => process.kill(descendant, 0), /ESRCH/);
    assert.equal(await readFile(join(c.home, "ml/worker/.control-lock/owner.json")).then(() => true, () => false), false);
    const current = c.service.store.read().deployments[0]!; await c.service.deployments.update(d.id, "resume", deploymentChange(current));
    assert.deepEqual((await c.service.deployments.predict(d.id, { rows: [{ x: 3 }] })).result.predictions, [3]);
  } finally { await c.service.close(); }
});

test("SSH deployments transfer verified exports and serve tabular or LoRA results without a public remote port", { timeout: 120000 }, async () => {
  const f = await sshFixture(), transport = new TrainingTransport(bundlePath, f.ssh), service = new MlService({ home: f.localHome, bundlePath, transport, enabled: () => true, authorize: async (_p, repo) => ({ repo, commit: "a".repeat(40) }) }); await service.load();
  try {
    await service.store.change(s => { s.targets[0]!.python = process.execPath; });
    const target = await service.register({ host: "fixture", name: "Inference VM", directory: join(f.remoteHome, "serving"), python: process.execPath, standalone: true });
    for (const llm of [false, true]) {
      const source = join(llm ? f.remoteHome : f.localHome, llm ? "inference.jsonl" : "inference.csv"); await writeFile(source, llm ? '{"prompt":"x","completion":"y"}\n'.repeat(100) : "x,target\n" + "1,0\n".repeat(100));
      const data = await service.snapshot({ project: "p", repo: f.repo, target: llm ? target.id : "local", path: source, location: "target" });
      const base = llm ? await until(service, await service.startJob({ project: "p", repo: f.repo, target: target.id, path: join(f.remoteHome, "base"), operationId: randomUUID() }, "model")) : undefined;
      const job = await until(service, await service.startJob({ project: "p", repo: f.repo, name: "Serving test", dataset: data.id, operationId: randomUUID(), spec: llm ? fineTune : { task: "classification", label: "target", split: { kind: "random" }, seed: 42, trainSeconds: 10, cpus: 1 }, ...(llm ? { recipe: LLM_RECIPE, model: base!.id } : {}) }));
      const model = await service.registry.register({ project: "p", repo: f.repo, jobId: job.id, name: llm ? "Adapter" : "Predictor", operationId: randomUUID() });
      const d = await service.deployments.create({ project: "p", repo: f.repo, name: llm ? "Chat endpoint" : "Tabular endpoint", modelId: model.id, versionId: model.versions[0]!.id, target: target.id, config: servingLimits, operationId: randomUUID(), reason: "Reviewed local owner deployment" });
      await service.monitors.create(monitorRequest(d));
      const result = await service.deployments.predict(d.id, llm ? { prompt: "Answer briefly", maxNewTokens: 2 } : { rows: [{ x: 2 }] });
      const monitored = () => service.store.read().monitors.find(m => m.deploymentId === d.id)!;
      assert.equal(monitored().window.requests, 1); assert.equal(monitored().window.samples, 1);
      assert.equal(JSON.stringify(monitored()).includes("Answer briefly"), false);
      if (!llm) {
        await assert.rejects(service.deployments.predict(d.id, { rows: [{ x: "inputfail" }] }), error => (error as Error).name === "InferenceInputError");
        assert.equal(monitored().window.requests, 1, "SSH input rejections are excluded from health failures");
        await assert.rejects(service.deployments.predict(d.id, { rows: [{ x: "fail" }] }), /Fixture load/);
        assert.equal(monitored().window.requests, 2); assert.equal(monitored().window.failures, 1);
      }
      if (!llm) assert.notEqual(job.target.workerId, d.target.workerId, "A locally trained export is transferred to a separate SSH serving worker");
      assert.equal(result.workerId, d.target.workerId); assert.equal(result.versionId, model.versions[0]!.id); assert.deepEqual(llm ? result.result.text : result.result.predictions, llm ? "fixture answer" : [2]);
      assert.equal(hash(await readFile(join(f.remoteHome, "serving/serving/uploads", job.status.artifact!.hash + ".tar.gz"))), job.status.artifact!.hash);
      if (llm) await assert.rejects(service.deployments.predict(d.id, { prompt: "Too many tokens", maxNewTokens: 9 }), /Output tokens/);
    }
  } finally { await service.close(); await f.cleanup(); }
});

test("failed deployment preflight and a stop racing preparation cannot replace the active version", { timeout: 90000 }, async () => {
  const c = await context();
  try {
    let model = await registeredResult(c); model = await registeredResult(c, model);
    let d = await c.service.deployments.create({ project: "p", repo: c.home, name: "Safe switching", modelId: model.id, versionId: model.versions[0]!.id, target: "local", config: servingLimits, operationId: randomUUID(), reason: "Known initial result" });
    const original = c.service.callWorker.bind(c.service); let release!: () => void, reached!: () => void;
    c.service.callWorker = async (target, action, values) => { if (action === "serve-prepare") throw new Error("Candidate failed to load"); return original(target, action, values); };
    const change = deploymentChange(d, { versionId: model.versions[1]!.id, reviewed: true });
    await assert.rejects(c.service.deployments.update(d.id, "switch", change), /failed to load/);
    assert.equal(c.service.store.read().deployments[0]!.current, d.current); assert.equal(c.service.store.read().deployments[0]!.history.length, 1);
    const gate = new Promise<void>(r => release = r), started = new Promise<void>(r => reached = r);
    c.service.callWorker = async (target, action, values) => { if (action === "serve-prepare") { reached(); await gate; } return original(target, action, values); };
    const switching = c.service.deployments.update(d.id, "switch", change), refused = assert.rejects(switching, /changed during preparation/);
    await started; d = await c.service.deployments.update(d.id, "stop", deploymentChange(d)); release(); await refused;
    assert.equal(c.service.store.read().deployments[0]!.enabled, false); assert.equal(c.service.store.read().deployments[0]!.current, d.current);
    c.service.callWorker = original;
    d = await c.service.deployments.update(d.id, "resume", deploymentChange(d));
    const authorize = c.service.authorize.bind(c.service); let checks = 0, dispatched = false;
    const authGate = new Promise<void>(r => release = r), authStarted = new Promise<void>(r => reached = r);
    c.service.authorize = async (project, repo) => { if (++checks === 2) { reached(); await authGate; } return authorize(project, repo); };
    c.service.callWorker = async (target, action, values) => { if (action === "serve-predict") dispatched = true; return original(target, action, values); };
    const prediction = c.service.deployments.predict(d.id, { rows: [{ x: 3 }] }), stopped = assert.rejects(prediction, /changed before inference/);
    await authStarted; d = await c.service.deployments.update(d.id, "stop", deploymentChange(d)); release(); await stopped;
    assert.equal(dispatched, false, "Stop during authorization must win before worker dispatch");
    c.service.authorize = authorize; c.service.callWorker = original; c.revoke(); await assert.rejects(c.service.deployments.update(d.id, "resume", deploymentChange(d)), /Membership revoked/);
  } finally { await c.service.close(); }
});

test("losing the control connection leaves inference supervised and the worker reserved until its deadline", { timeout: 90000 }, async () => {
  const c = await context(); let control: ReturnType<typeof spawn> | undefined, owner: { pid: number } | undefined;
  try {
    const model = await registeredResult(c), d = await c.service.deployments.create({ project: "p", repo: c.home, name: "Disconnect-safe endpoint", modelId: model.id, versionId: model.versions[0]!.id, target: "local", config: { ...servingLimits, timeoutSeconds: 8 }, operationId: randomUUID(), reason: "Supervision verification" });
    const root = d.target.directory, r = d.releases[0]!;
    control = spawn(process.execPath, [join(root, "bundles", d.target.bundle!, "worker.mjs"), "control", root], { stdio: ["pipe", "ignore", "ignore"] });
    control.stdin!.end(JSON.stringify({ action: "serve-predict", controllerId: r.controllerId, workerId: r.workerId, python: process.execPath, release: r, input: { rows: [{ x: "slow" }] } }));
    let descendant = 0;
    for (let i = 0; i < 100; i++) { descendant = await readFile(join(root, "inference-descendant"), "utf8").then(Number, () => 0); if (descendant) break; await new Promise(r => setTimeout(r, 50)); }
    assert.ok(descendant); owner = JSON.parse(await readFile(join(root, ".control-lock/owner.json"), "utf8")); assert.notEqual(owner!.pid, control.pid);
    control.kill("SIGKILL"); await new Promise<void>(resolve => control!.once("close", () => resolve()));
    assert.doesNotThrow(() => process.kill(owner!.pid, 0));
    // The bounded lock retry can either refuse while busy or acquire after the deadline.
    // It must never admit the probe while the detached inference child is still alive.
    const reservation = c.service.probe("local").then(() => { assert.throws(() => process.kill(descendant, 0), /ESRCH/); }, error => { assert.match(error.message, /busy/); });
    for (let i = 0; i < 120; i++) { try { process.kill(owner!.pid, 0); } catch { break; } await new Promise(r => setTimeout(r, 100)); }
    assert.throws(() => process.kill(descendant, 0), /ESRCH/);
    await reservation;
    assert.equal((await c.service.probe("local")).serving, 1, "verified dead lock owner can be recovered after inference finishes");
    assert.deepEqual((await c.service.deployments.predict(d.id, { rows: [{ x: 6 }] })).result.predictions, [6]);
  } finally { control?.kill("SIGTERM"); if (owner) { try { process.kill(owner.pid, "SIGTERM"); } catch {} } await c.service.close(); }
});


test("deployment history and storage capacity reserve the final stop operation", { timeout: 90000 }, async () => {
  const c = await context();
  try {
    const model = await registeredResult(c);
    let d = await c.service.deployments.create({ project: "p", repo: c.home, name: "Capacity check", modelId: model.id, versionId: model.versions[0]!.id, target: "local", config: servingLimits, operationId: randomUUID(), reason: "Verify stop reserve" });
    await c.service.store.change(s => {
      const saved = s.deployments[0]!;
      while (saved.history.length < 199) {
        const action = saved.enabled ? "stop" : "resume";
        saved.history.push({ operationId: randomUUID(), requestHash: hash(randomUUID()), action, from: saved.current, to: saved.current, at: Date.now(), reason: "Earlier reviewed action", reviewed: false, comparison: [] });
        saved.enabled = action !== "stop"; saved.revision++;
      }
    });
    // Simulate existing state growing into reserved space as outstanding work finishes.
    await c.service.store.change(s => { s.defaults.padding = "x".repeat(6 * 1024 * 1024); });
    d = c.service.store.read().deployments[0]!;
    await assert.rejects(c.service.deployments.update(d.id, "switch", deploymentChange(d, { versionId: model.versions[0]!.id })), /history is full/);
    d = await c.service.deployments.update(d.id, "stop", deploymentChange(d));
    assert.equal(d.history.length, 200); assert.equal(d.enabled, false);
    await assert.rejects(c.service.deployments.update(d.id, "resume", deploymentChange(d)), /history is full/);
    const loaded = new MlStore(join(c.home, "ml")); await loaded.load(); assert.equal(loaded.read().deployments[0]!.enabled, false);
  } finally { await c.service.close(); }
});

const residentLimits = { ...servingLimits, mode: "persistent" as const, timeoutSeconds: 10, memoryMiB: 256, idleSeconds: 60, lifetimeSeconds: 300 };
async function stopResidents(service: MlService) { for (const d of service.store.read().deployments) if (d.config.mode === "persistent") await service.callWorker(d.target, "resident-stop", { deploymentId: d.id, revision: d.revision + 1 }).catch(() => {}); }
async function residentDeployment(c: Awaited<ReturnType<typeof context>>, config = residentLimits) {
  const model = await registeredResult(c);
  const d = await c.service.deployments.create({ project: "p", repo: c.home, name: "Resident predictor", modelId: model.id, versionId: model.versions[0]!.id, target: "local", config, operationId: randomUUID(), reason: "Verify persistent model serving" });
  return { d, model };
}
async function unloaded(service: MlService, deploymentId: string, milliseconds = 20000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { const status = await service.deployments.runtime(deploymentId); if (status.state === "unloaded") return status; await new Promise(r => setTimeout(r, 150)); }
  throw new Error("Resident worker did not unload within its bound");
}

test("persistent deployments reuse a loaded process across requests and controller restart, switch and roll back, and fence stopped revisions", { timeout: 120000 }, async () => {
  const c = await context(); let service = c.service;
  try {
    let model = await registeredResult(c); model = await registeredResult(c, model);
    let d = await service.deployments.create({ project: "p", repo: c.home, name: "Resident versions", modelId: model.id, versionId: model.versions[0]!.id, target: "local", config: residentLimits, operationId: randomUUID(), reason: "Verify resident lifecycle" });
    const first = await service.deployments.runtime(d.id); assert.equal(first.state, "ready"); assert.ok(first.pid);
    for (let i = 0; i < 2; i++) assert.deepEqual((await service.deployments.predict(d.id, { rows: [{ x: i }] })).result.predictions, [i]);
    assert.equal((await service.deployments.runtime(d.id)).pid, first.pid);
    await assert.rejects(service.startJob(c.request()), /Inference|Persistent|computer/);
    await assert.rejects(service.configure("local", { revision: d.target.revision, python: process.execPath }), /persistent serving/);
    await service.close(); service = await c.create();
    assert.equal((await service.deployments.warm(d.id)).pid, first.pid, "Restart reconnects to the same resident model");
    d = await service.deployments.update(d.id, "switch", deploymentChange(d, { versionId: model.versions[1]!.id, reviewed: true }));
    assert.notEqual((await service.deployments.runtime(d.id)).pid, first.pid);
    assert.equal((await service.deployments.predict(d.id, { rows: [{ x: 5 }] })).versionId, model.versions[1]!.id);
    d = await service.deployments.update(d.id, "rollback", deploymentChange(d, { versionId: model.versions[0]!.id }));
    assert.equal((await service.deployments.predict(d.id, { rows: [{ x: 6 }] })).versionId, model.versions[0]!.id);
    const beforeStop = await service.deployments.runtime(d.id), revision = d.revision;
    d = await service.deployments.update(d.id, "stop", deploymentChange(d)); assert.equal(d.cleanupPending, undefined); assert.equal(service.deployments.busy(d.target.workerId), false);
    await assert.rejects(service.callWorker(d.target, "resident-prepare", { deploymentId: d.id, revision, release: d.releases.find(r => r.id === d.current), expectedSession: beforeStop.sessionId }), /stopped/);
    d = await service.deployments.update(d.id, "resume", deploymentChange(d));
    await service.callWorker(d.target, "resident-stop", { deploymentId: d.id, revision: d.revision - 1 });
    assert.equal((await service.deployments.runtime(d.id)).state, "ready", "A delayed old stop cannot kill the resumed model");
    const resumed = await service.deployments.runtime(d.id);
    for (const stale of [{ revision, expectedSession: resumed.sessionId }, { revision: d.revision, expectedSession: beforeStop.sessionId }]) {
      await assert.rejects(service.callWorker(d.target, "resident-start", { deploymentId: d.id, ...stale, requestId: randomUUID(), release: d.releases.find(r => r.id === d.current), input: { rows: [{ x: 1 }] } }), /revision or session changed/);
    }
  } finally { await stopResidents(service); await service.close(); }
});

test("persistent serving restores the previous resident after a failed candidate load", { timeout: 90000 }, async () => {
  const c = await context();
  try {
    let model = await registeredResult(c); model = await registeredResult(c, model);
    const d = await c.service.deployments.create({ project: "p", repo: c.home, name: "Load recovery", modelId: model.id, versionId: model.versions[0]!.id, target: "local", config: residentLimits, operationId: randomUUID(), reason: "Verify recovery" });
    await writeFile(join(d.target.directory, "resident-load-fail"), model.versions[1]!.id);
    await assert.rejects(c.service.deployments.update(d.id, "switch", deploymentChange(d, { versionId: model.versions[1]!.id, reviewed: true })), /failed to load/);
    assert.equal(c.service.store.read().deployments[0]!.revision, 1);
    assert.equal((await c.service.deployments.runtime(d.id)).releaseId, d.current);
    assert.deepEqual((await c.service.deployments.predict(d.id, { rows: [{ x: 4 }] })).result.predictions, [4]);
  } finally { await stopResidents(c.service); await c.service.close(); }
});

test("persistent memory and request limits release the entire process group and permit a fresh warm start", { timeout: 90000 }, async () => {
  const c = await context();
  try {
    const { d } = await residentDeployment(c, { ...residentLimits, timeoutSeconds: 5 });
    const first = await c.service.deployments.runtime(d.id);
    await assert.rejects(c.service.deployments.predict(d.id, { rows: [{ x: "memory" }] }), /memory limit|unloaded|response|stopped/);
    const memory = await unloaded(c.service, d.id); assert.match(memory.reason!, /memory limit/); assert.throws(() => process.kill(first.pid!, 0), /ESRCH/);
    await c.service.deployments.warm(d.id);
    await assert.rejects(c.service.deployments.predict(d.id, { rows: [{ x: "slow" }] }), /timeout|unloaded|response|stopped/);
    const expired = await unloaded(c.service, d.id); assert.match(expired.reason!, /timeout/);
    const descendant = Number(await readFile(join(d.target.directory, "resident-descendant"), "utf8")); assert.throws(() => process.kill(descendant, 0), /ESRCH/);
    assert.deepEqual((await c.service.deployments.predict(d.id, { rows: [{ x: 8 }] })).result.predictions, [8]);
  } finally { await stopResidents(c.service); await c.service.close(); }
});

test("persistent idle and lifetime limits expire without controller supervision", { timeout: 90000 }, async () => {
  const c = await context(); let service = c.service;
  try {
    const { d } = await residentDeployment(c, { ...residentLimits, idleSeconds: 10, lifetimeSeconds: 30 });
    const status = await service.deployments.runtime(d.id); await service.close();
    await new Promise(r => setTimeout(r, 11500)); service = await c.create();
    const idle = await unloaded(service, d.id); assert.match(idle.reason!, /idle timeout/); assert.throws(() => process.kill(status.pid!, 0), /ESRCH/);
    await service.deployments.warm(d.id);
    const receiptPath = join(d.target.directory, "serving/resident.json"), receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    // Test the lifetime separately with steady traffic; polls never reset the lifetime.
    const started = receipt.startedAt; let ended = false;
    while (Date.now() - started < 35000) {
      const runtime = await service.deployments.runtime(d.id);
      if (runtime.state === "unloaded") { assert.match(runtime.reason!, /maximum lifetime/); ended = true; break; }
      // Stop dispatching before expiry: a new request intentionally auto-warms an expired model.
      if (Date.now() - started < 27000) await service.deployments.predict(d.id, { rows: [{ x: 1 }] });
      await new Promise(r => setTimeout(r, 1500));
    }
    assert.equal(ended, true);
  } finally { await stopResidents(service); await service.close(); }
});

test("persistent SSH LLM serving streams text, cancels generation, reuses weights and recovers after a controller disconnect", { timeout: 120000 }, async () => {
  const f = await sshFixture(), transport = new TrainingTransport(bundlePath, f.ssh), service = new MlService({ home: f.localHome, bundlePath, transport, enabled: () => true, authorize: async (_p, repo) => ({ repo, commit: "a".repeat(40) }) }); await service.load();
  try {
    const target = await service.register({ host: "fixture", name: "Resident SSH VM", directory: join(f.remoteHome, "resident"), python: process.execPath, standalone: true });
    const source = join(f.remoteHome, "stream.jsonl"); await writeFile(source, '{"prompt":"x","completion":"y"}\n'.repeat(100));
    const data = await service.snapshot({ project: "p", repo: f.repo, target: target.id, path: source, location: "target" });
    const base = await until(service, await service.startJob({ project: "p", repo: f.repo, target: target.id, path: join(f.remoteHome, "base"), operationId: randomUUID() }, "model"));
    const job = await until(service, await service.startJob({ project: "p", repo: f.repo, name: "Streaming adapter", dataset: data.id, recipe: LLM_RECIPE, model: base.id, spec: fineTune, operationId: randomUUID() }));
    const model = await service.registry.register({ project: "p", repo: f.repo, jobId: job.id, name: "Streaming adapter", operationId: randomUUID() });
    const d = await service.deployments.create({ project: "p", repo: f.repo, name: "Streaming endpoint", modelId: model.id, versionId: model.versions[0]!.id, target: target.id, config: { ...residentLimits, timeoutSeconds: 30 }, operationId: randomUUID(), reason: "Verify streamed SSH inference" });
    const initial = await service.deployments.runtime(d.id), events: any[] = [];
    await service.monitors.create(monitorRequest(d));
    const result = await service.deployments.predict(d.id, { prompt: "Hello" }, { onEvent: async e => { events.push(e); } });
    assert.equal(events[0].type, "meta"); assert.equal(events[0].versionId, model.versions[0]!.id);
    assert.equal(events.filter(e => e.type === "delta").map(e => e.text).join(""), result.result.text);
    assert.equal((await service.deployments.runtime(d.id)).pid, initial.pid);
    const cancel = new AbortController();
    await assert.rejects(service.deployments.predict(d.id, { prompt: "Hello" }, { signal: cancel.signal, onEvent: async e => { if (e.type === "delta") { cancel.abort(); throw new Error("Reader cancelled"); } } }), /cancelled/);
    assert.equal(service.store.read().monitors[0]!.window.requests, 1, "cancelled streams are excluded from health monitoring");
    assert.equal(service.store.read().monitors[0]!.window.histograms.every(h => h.reduce((a, b) => a + b, 0) === 1), true);
    // Cancellation may arrive after a short fixture generation finished; either way no request stays active.
    assert.notEqual((await service.deployments.runtime(d.id)).state, "busy");
    await service.deployments.warm(d.id);
    const release = d.releases[0]!, requestId = randomUUID();
    await service.callWorker(d.target, "resident-start", { deploymentId: d.id, revision: d.revision, expectedSession: (await service.deployments.runtime(d.id)).sessionId, requestId, release, input: { prompt: "slow", maxNewTokens: 2 }, stream: true });
    const disappeared = await unloaded(service, d.id, 25000); assert.match(disappeared.reason!, /client disconnected/);
    assert.equal((await service.deployments.predict(d.id, { prompt: "Hello" })).result.text, "hello world");
  } finally { await stopResidents(service); await service.close(); await f.cleanup(); }
});

test("persistent supervisor death fences training until an explicit stop reaps its orphaned model", { timeout: 90000 }, async () => {
  const c = await context();
  try {
    let { d } = await residentDeployment(c);
    await c.service.callWorker(d.target, "resident-start", { deploymentId: d.id, revision: d.revision, expectedSession: (await c.service.deployments.runtime(d.id)).sessionId, requestId: randomUUID(), release: d.releases[0], input: { rows: [{ x: "slow" }] } });
    const descendantPath = join(d.target.directory, "resident-descendant");
    for (let i = 0; i < 100 && !await readFile(descendantPath).then(() => true, () => false); i++) await new Promise(r => setTimeout(r, 20));
    const descendant = Number(await readFile(descendantPath, "utf8"));
    const receipt = JSON.parse(await readFile(join(d.target.directory, "serving/resident.json"), "utf8"));
    process.kill(receipt.owner.pid, "SIGKILL"); await new Promise(r => setTimeout(r, 150));
    await assert.rejects(c.service.callWorker(d.target, "probe"), /Persistent|serving/);
    assert.equal((await c.service.deployments.runtime(d.id)).state, "unknown");
    d = await c.service.deployments.update(d.id, "stop", deploymentChange(d)); assert.equal(d.cleanupPending, undefined);
    assert.throws(() => process.kill(receipt.child.pid, 0), /ESRCH/);
    assert.throws(() => process.kill(descendant, 0), /ESRCH/);
    assert.equal((await c.service.probe("local")).ready, true);
  } finally { await stopResidents(c.service); await c.service.close(); }
});

test("persistent stop survives disconnected delivery and restart, blocking training until cleanup is confirmed", { timeout: 40000 }, async () => {
  const transport = new TrainingTransport(bundlePath); let disconnected = false;
  const client = { call: async <T>(...args: Parameters<TrainingTransport["call"]>): Promise<T> => { if (disconnected) throw new Error("SSH disconnected"); return transport.call<T>(...args); }, close: () => transport.close() };
  const c = await context({ transport: client }); let service = c.service;
  try {
    const { d } = await residentDeployment(c), status = await service.deployments.runtime(d.id);
    disconnected = true;
    const stopped = await service.deployments.update(d.id, "stop", deploymentChange(d));
    assert.equal(stopped.enabled, false); assert.equal(stopped.cleanupPending, true);
    await assert.rejects(service.startJob(c.request()), /Inference|serving/);
    await service.close(); service = await c.create();
    assert.equal(service.store.read().deployments[0]!.cleanupPending, true);
    disconnected = false; await service.reconcile();
    assert.equal(service.store.read().deployments[0]!.cleanupPending, undefined);
    assert.throws(() => process.kill(status.pid!, 0), /ESRCH/);
    await assert.rejects(service.callWorker(d.target, "resident-prepare", { deploymentId: d.id, revision: d.revision, release: d.releases[0], expectedSession: status.sessionId }), /stopped/);
    assert.equal((await service.probe("local")).ready, true);
  } finally { disconnected = false; await stopResidents(service); await service.close(); }
});

test("persistent stop wins a prepared version change before its controller commit", { timeout: 40000 }, async () => {
  const transport = new TrainingTransport(bundlePath); let hold = false, accepted!: () => void, release!: () => void;
  const prepared = new Promise<void>(resolve => { accepted = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const client = { call: async <T>(...args: Parameters<TrainingTransport["call"]>): Promise<T> => { const value = await transport.call<T>(...args); if (hold && args[1].action === "resident-prepare") { accepted(); await gate; } return value; }, close: () => transport.close() };
  const c = await context({ transport: client }); let change: Promise<unknown> | undefined;
  try {
    let model = await registeredResult(c); model = await registeredResult(c, model);
    const d = await c.service.deployments.create({ project: "p", repo: c.home, name: "Concurrent resident change", modelId: model.id, versionId: model.versions[0]!.id, target: "local", config: residentLimits, operationId: randomUUID(), reason: "Verify stop race" });
    hold = true;
    change = c.service.deployments.update(d.id, "switch", deploymentChange(d, { versionId: model.versions[1]!.id, reviewed: true })).catch(error => error);
    await prepared;
    const candidate = await c.service.deployments.runtime(d.id); assert.equal(candidate.state, "unknown");
    const stopped = await c.service.deployments.update(d.id, "stop", deploymentChange(d));
    release(); assert.match((await change as Error).message, /changed during preparation/);
    assert.equal(stopped.enabled, false); assert.equal(stopped.cleanupPending, undefined); assert.equal(stopped.current, d.current);
    assert.throws(() => process.kill(candidate.pid!, 0), /ESRCH/);
    assert.equal((await c.service.deployments.runtime(d.id)).state, "stopped");
  } finally { release(); await change; await stopResidents(c.service); await c.service.close(); }
});

test("persistent stop terminates active prediction and its descendants before releasing the worker", { timeout: 40000 }, async () => {
  const c = await context(); let request: Promise<unknown> | undefined;
  try {
    const { d } = await residentDeployment(c);
    request = c.service.deployments.predict(d.id, { rows: [{ x: "slow" }] }).catch(error => error);
    const path = join(d.target.directory, "resident-descendant");
    for (let i = 0; i < 100 && !await readFile(path).then(() => true, () => false); i++) await new Promise(r => setTimeout(r, 30));
    const descendant = Number(await readFile(path, "utf8"));
    const stopped = await c.service.deployments.update(d.id, "stop", deploymentChange(d));
    assert.equal(stopped.cleanupPending, undefined); assert.ok(await request instanceof Error);
    assert.throws(() => process.kill(descendant, 0), /ESRCH/);
    assert.equal(c.service.deployments.busy(d.target.workerId), false);
  } finally { await stopResidents(c.service); await request; await c.service.close(); }
});

const monitoringLimits = { windowSeconds: 60, minRequests: 10, minSamples: 20, consecutiveWindows: 2, maxErrorRate: 0.2, maxLatencyMs: 100000, driftThreshold: 0.3, cooldownSeconds: 60, maxActions: 2 };
const monitorRequest = (d: import("../src/ml/deployment-model.js").Deployment, patch = {}) => ({ deploymentId: d.id, revision: d.revision, operationId: randomUUID(), name: "Model monitor", limits: monitoringLimits, ...patch });
async function monitorTraffic(service: MlService, d: import("../src/ml/deployment-model.js").Deployment, x = 2, failed = false, count = 10) {
  for (let i = 0; i < count; i++) await service.monitors.record(d, d.releases.find(r => r.id === d.current)!, { rows: [{ x }, { x }] }, failed ? undefined : { predictions: [x, x] }, 5);
}
test("monitoring records real inference, requires a reviewed reference and fresh complete windows, and resets after restart", { timeout: 30000 }, async () => {
  let now = Date.now(); const c = await context({ monitorClock: () => now }); let service = c.service;
  try {
    const { d } = await residentDeployment(c), request = monitorRequest(d);
    let m = await service.monitors.create(request); assert.equal((await service.monitors.create(request)).id, m.id);
    await assert.rejects(service.monitors.create({ ...request, name: "changed" }), /inputs changed/);
    await service.deployments.predict(d.id, { rows: [{ x: 2 }, { x: 2 }] });
    assert.equal(service.store.read().monitors[0]!.window.requests, 1);
    await assert.rejects(service.deployments.predict(d.id, { rows: [{ x: "inputfail" }] }), error => (error as Error).name === "InferenceInputError");
    assert.equal(service.store.read().monitors[0]!.window.requests, 1, "invalid inputs do not inflate health failures");
    await assert.rejects(service.monitors.update(m.id, "reference", { revision: m.revision }), /enough/);
    await monitorTraffic(service, d, 2, false, 9);
    m = await service.monitors.update(m.id, "reference", { revision: m.revision });
    assert.equal(m.reference!.samples, 20); assert.equal(m.window.samples, 0);
    await monitorTraffic(service, d, 10000); now += 60000; await service.monitors.tick();
    assert.equal(service.store.read().monitors[0]!.driftStreak, 1);
    for (let i = 0; i < 3; i++) await service.monitors.tick(); assert.equal(service.store.read().monitors[0]!.driftStreak, 1, "rechecking a window cannot count it twice");
    now += 180000; await service.monitors.tick(); assert.equal(service.store.read().monitors[0]!.driftStreak, 0, "missing traffic resets confirmation");
    await service.close(); service = await c.create(); m = service.store.read().monitors[0]!;
    assert.equal(m.reference!.samples, 20); assert.equal(m.window.requests, 0); assert.equal(m.driftStreak, 0);
    assert.deepEqual(m.limits, monitoringLimits);
    await assert.rejects(service.store.change(s => { s.monitors[0]!.window.histograms[0]![0] = 1; }), /monitoring/);
    c.revoke(); await assert.rejects(service.monitors.update(m.id, "check", { revision: m.revision }), /Membership revoked/);
    await service.monitors.update(m.id, "pause", { revision: m.revision });
  } finally { await stopResidents(service); await service.close(); }
});

test("monitoring rolls back only the approved version after repeated unhealthy windows and pauses on the new revision", { timeout: 40000 }, async () => {
  let now = Date.now(); const c = await context({ monitorClock: () => now });
  try {
    let model = await registeredResult(c); model = await registeredResult(c, model);
    let d = await c.service.deployments.create({ project: "p", repo: c.home, name: "Monitored versions", modelId: model.id, versionId: model.versions[0]!.id, target: "local", config: residentLimits, operationId: randomUUID(), reason: "Verify automated rollback" });
    d = await c.service.deployments.update(d.id, "switch", deploymentChange(d, { versionId: model.versions[1]!.id, reviewed: true }));
    const m = await c.service.monitors.create(monitorRequest(d, { rollbackVersionId: model.versions[0]!.id }));
    await monitorTraffic(c.service, d, 2, true); now += 60000; await c.service.monitors.tick(); assert.equal(c.service.store.read().deployments[0]!.revision, d.revision);
    await monitorTraffic(c.service, d, 2, true); now += 60000; await c.service.monitors.tick();
    const state = c.service.store.read(), saved = state.monitors[0]!;
    assert.equal(state.deployments[0]!.current, d.releases[0]!.id); assert.equal(saved.actions.length, 1); assert.equal(saved.actions[0]!.state, "completed"); assert.equal(saved.state, "paused");
    await c.service.monitors.tick(); assert.equal(c.service.store.read().monitors[0]!.actions.length, 1);
    await assert.rejects(c.service.monitors.update(m.id, "resume", { revision: saved.revision }), /Deployment changed/);
  } finally { await stopResidents(c.service); await c.service.close(); }
});

test("monitoring retrains on new stable data within the original schedule budgets, survives restart and restores shared serving", { timeout: 60000 }, async () => {
  let now = Date.now(); const c = await context({ monitorClock: () => now, scheduleClock: () => now, promotionClock: () => now }); let service = c.service;
  try {
    let schedule = await service.schedules.create(scheduleRequest(c.request(), c.source, { maxCycles: 1 })); schedule = await service.schedules.update(schedule.id, "pause", { revision: schedule.revision });
    const { d, model } = await residentDeployment(c), retrain = { scheduleId: schedule.id, scheduleRevision: schedule.revision, allowServingPause: true };
    await service.registry.select(model.id, "promote", { versionId: model.versions[0]!.id, revision: model.revision, operationId: randomUUID(), reason: "Select the deployed incumbent" });
    await service.promotions.create({ deploymentId: d.id, revision: d.revision, operationId: randomUUID(), name: "Scheduled results", source: { kind: "schedule", id: schedule.id }, includeExisting: false, mode: "automatic", authorized: true, health: { ...monitoringLimits, maxActions: 1 }, limits: { minImprovement: 0, maxAttempts: 2, cooldownSeconds: 60, approvalSeconds: 3600, observationSeconds: 180 } });
    await assert.rejects(service.monitors.create(monitorRequest(d, { retrain: { ...retrain, allowServingPause: false } })), /serving pause/);
    let m = await service.monitors.create(monitorRequest(d, { retrain }));
    await assert.rejects(service.schedules.update(schedule.id, "resume", { revision: schedule.revision }), /monitor/);
    await monitorTraffic(service, d); m = await service.monitors.update(m.id, "reference", { revision: m.revision });
    for (let i = 0; i < 2; i++) { await monitorTraffic(service, d, 10000); now += 60000; await service.monitors.tick(); }
    assert.equal(service.store.read().cycles.length, 0, "drift alone cannot retrain unchanged data");
    await writeFile(c.source, (await readFile(c.source, "utf8")) + "\n101,1");
    now += 60000; await service.monitors.tick(); now += 60000; await service.monitors.tick();
    assert.equal(service.store.read().deployments[0]!.enabled, false); assert.equal(service.store.read().monitors[0]!.actions[0]!.stoppedRevision, d.revision + 1);
    await service.promotions.tick(); assert.equal(service.store.read().promotions[0]!.state, "enabled", "monitor-owned serving stop must not cancel promotion policy");
    await service.close(); service = await c.create();
    await service.promotions.tick(); await service.monitors.tick();
    const cycle = service.store.read().cycles[0]!; assert.ok(cycle); assert.deepEqual(cycle.limits, schedule.limits); assert.deepEqual(cycle.planner, schedule.planner);
    assert.equal(cycle.monitor!.drift, 1); assert.deepEqual(plannerInput(cycle, []).monitoring, { reason: "input-drift", distance: 1, requests: 10, samples: 20 });
    await settleCycle(service, cycle); await service.monitors.tick();
    await service.promotions.tick();
    const state = service.store.read(), restored = state.deployments[0]!;
    const promotion = state.promotions[0]!; assert.equal(promotion.state, "enabled"); assert.equal(promotion.deploymentRevision, restored.revision); assert.equal(promotion.decisions[0]!.state, "blocked"); assert.ok(promotion.decisions[0]!.concerns.includes("Dataset versions differ"));
    assert.equal(restored.enabled, true); assert.equal(restored.current, d.current); assert.equal(state.monitors[0]!.deploymentRevision, restored.revision);
    assert.equal(state.monitors[0]!.actions[0]!.state, "completed"); assert.equal(state.schedules[0]!.runs.length, 1); assert.equal(state.schedules[0]!.state, "exhausted");
    await service.monitors.tick(); assert.equal(service.store.read().cycles.length, 1, "reconciliation cannot duplicate a search");
    assert.deepEqual((await service.deployments.predict(d.id, { rows: [{ x: 7 }] })).result.predictions, [7]);
  } finally { await stopResidents(service); await service.close(); }
});

async function stoppedForRetraining(c: Awaited<ReturnType<typeof context>>, advance: () => void) {
  let schedule = await c.service.schedules.create(scheduleRequest(c.request(), c.source));
  schedule = await c.service.schedules.update(schedule.id, "pause", { revision: schedule.revision });
  const { d } = await residentDeployment(c);
  let m = await c.service.monitors.create(monitorRequest(d, { retrain: { scheduleId: schedule.id, scheduleRevision: schedule.revision, allowServingPause: true } }));
  await monitorTraffic(c.service, d); m = await c.service.monitors.update(m.id, "reference", { revision: m.revision });
  await writeFile(c.source, (await readFile(c.source, "utf8")) + "\n102,0");
  for (let i = 0; i < 2; i++) { await monitorTraffic(c.service, d, 10000); advance(); await c.service.monitors.tick(); }
  advance(); await c.service.monitors.tick();
  assert.equal(c.service.store.read().deployments[0]!.enabled, false);
  return { d, m: c.service.store.read().monitors[0]!, schedule };
}

test("monitoring pause wins a prepared rollback and retains the selected serving release", { timeout: 40000 }, async () => {
  const transport = new TrainingTransport(bundlePath); let hold = false, reached!: () => void, release!: () => void;
  const prepared = new Promise<void>(r => reached = r), gate = new Promise<void>(r => release = r);
  const client = { call: async <T>(...args: Parameters<TrainingTransport["call"]>): Promise<T> => { const value = await transport.call<T>(...args); if (hold && args[1].action === "resident-prepare") { hold = false; reached(); await gate; } return value; }, close: () => transport.close() };
  let now = Date.now(); const c = await context({ transport: client, monitorClock: () => now }); let action: Promise<void> | undefined;
  try {
    let model = await registeredResult(c); model = await registeredResult(c, model);
    let d = await c.service.deployments.create({ project: "p", repo: c.home, name: "Rollback race", modelId: model.id, versionId: model.versions[0]!.id, target: "local", config: residentLimits, operationId: randomUUID(), reason: "Verify monitor pause fencing" });
    d = await c.service.deployments.update(d.id, "switch", deploymentChange(d, { versionId: model.versions[1]!.id, reviewed: true }));
    const m = await c.service.monitors.create(monitorRequest(d, { rollbackVersionId: model.versions[0]!.id }));
    await monitorTraffic(c.service, d, 2, true); now += 60000; await c.service.monitors.tick();
    await monitorTraffic(c.service, d, 2, true); now += 60000; hold = true; action = c.service.monitors.tick(); await prepared;
    await c.service.monitors.update(m.id, "pause", { revision: m.revision }); release(); await action; await c.service.monitors.tick();
    assert.equal(c.service.store.read().deployments[0]!.current, d.current); assert.equal(c.service.store.read().deployments[0]!.revision, d.revision);
    assert.equal(c.service.store.read().monitors[0]!.actions[0]!.state, "cancelled");
    assert.equal((await c.service.deployments.runtime(d.id)).state, "ready");
  } finally { release(); await action; await stopResidents(c.service); await c.service.close(); }
});

test("monitoring stop-and-keep-stopped survives restart without admitting training or restoring serving", { timeout: 30000 }, async () => {
  let now = Date.now(); const c = await context({ monitorClock: () => now, scheduleClock: () => now }); let service = c.service;
  try {
    const { m } = await stoppedForRetraining(c, () => { now += 60000; });
    await service.monitors.update(m.id, "pause", { revision: m.revision, stopActive: true, keepServingStopped: true });
    await service.close(); service = await c.create(); await service.monitors.tick();
    assert.equal(service.store.read().cycles.length, 0); assert.equal(service.store.read().deployments[0]!.enabled, false);
    assert.equal(service.store.read().monitors[0]!.actions[0]!.state, "cancelled"); assert.equal(service.monitors.active(), false);
  } finally { await stopResidents(service); await service.close(); }
});

test("monitoring limits failed serving restoration attempts and preserves its training budget", { timeout: 30000 }, async () => {
  let now = Date.now(); const c = await context({ monitorClock: () => now, scheduleClock: () => now });
  try {
    const { m } = await stoppedForRetraining(c, () => { now += 60000; });
    await c.service.monitors.update(m.id, "pause", { revision: m.revision });
    const update = c.service.deployments.update.bind(c.service.deployments); let attempts = 0;
    c.service.deployments.update = (value, action, raw, guard) => { if (action === "resume") { attempts++; return Promise.reject(new Error("Worker unavailable")); } return update(value, action, raw, guard); };
    for (let i = 0; i < 8; i++) await c.service.monitors.tick();
    assert.equal(attempts, 3); assert.equal(c.service.store.read().deployments[0]!.enabled, false);
    const saved = c.service.store.read().monitors[0]!; assert.equal(saved.actions[0]!.state, "failed"); assert.equal(saved.actions.length, 1);
    assert.equal(c.service.store.read().schedules[0]!.runs.length, 0); assert.equal(c.service.store.read().cycles.length, 0);
  } finally { await stopResidents(c.service); await c.service.close(); }
});

test("monitoring keep-stopped wins a prepared restoration and releases its exact session without fencing manual resume", { timeout: 40000 }, async () => {
  let now = Date.now(); const c = await context({ monitorClock: () => now, scheduleClock: () => now }); let flight: Promise<void> | undefined, release = () => {};
  try {
    const { m, d } = await stoppedForRetraining(c, () => { now += 60000; });
    await c.service.monitors.update(m.id, "pause", { revision: m.revision });
    const call = c.service.callWorker.bind(c.service); let reached!: () => void, candidatePid = 0;
    const prepared = new Promise<void>(r => reached = r), gate = new Promise<void>(r => release = r);
    c.service.callWorker = async (target, action, values) => { const result: any = await call(target, action, values); if (action === "resident-prepare") { candidatePid = result.pid; reached(); await gate; } return result; };
    flight = c.service.monitors.tick(); await prepared;
    await c.service.monitors.update(m.id, "pause", { revision: c.service.store.read().monitors[0]!.revision, keepServingStopped: true });
    release(); await flight; await c.service.monitors.tick(); c.service.callWorker = call;
    assert.equal(c.service.store.read().monitors[0]!.actions[0]!.state, "cancelled");
    assert.equal(c.service.store.read().deployments[0]!.enabled, false); assert.throws(() => process.kill(candidatePid, 0), /ESRCH/);
    assert.equal((await c.service.probe("local")).ready, true);
    const resumed = await c.service.deployments.update(d.id, "resume", deploymentChange(c.service.store.read().deployments[0]!));
    assert.equal(resumed.enabled, true); assert.equal((await c.service.deployments.runtime(d.id)).state, "ready");
  } finally { release(); await flight; await stopResidents(c.service); await c.service.close(); }
});

test("monitoring waits for disconnected serving cleanup and a pause during snapshot prevents training admission", { timeout: 40000 }, async () => {
  const transport = new TrainingTransport(bundlePath); let disconnectStops = false;
  const client = { call: async <T>(...args: Parameters<TrainingTransport["call"]>): Promise<T> => { if (disconnectStops && args[1].action === "resident-stop") throw new Error("SSH disconnected"); return transport.call<T>(...args); }, close: () => transport.close() };
  let now = Date.now(); const c = await context({ transport: client, monitorClock: () => now, scheduleClock: () => now }); let flight: Promise<void> | undefined, release = () => {};
  try {
    disconnectStops = true; const { m, d } = await stoppedForRetraining(c, () => { now += 60000; });
    assert.equal(c.service.store.read().deployments[0]!.cleanupPending, true);
    await c.service.monitors.tick(); assert.equal(c.service.store.read().cycles.length, 0);
    disconnectStops = false; await c.service.deployments.reconcile(); assert.equal(c.service.store.read().deployments[0]!.cleanupPending, undefined);
    const snapshot = c.service.snapshot.bind(c.service); let reached!: () => void;
    const started = new Promise<void>(r => reached = r), gate = new Promise<void>(r => release = r);
    c.service.snapshot = async raw => { const value = await snapshot(raw); reached(); await gate; return value; };
    now += 60000; flight = c.service.monitors.tick(); await started;
    await c.service.monitors.update(m.id, "pause", { revision: m.revision }); release(); await flight; await c.service.monitors.tick();
    assert.equal(c.service.store.read().cycles.length, 0); assert.equal(c.service.store.read().deployments[0]!.enabled, true);
    assert.equal(c.service.store.read().deployments[0]!.current, d.current); assert.equal(c.service.store.read().schedules[0]!.runs.length, 0);
  } finally { disconnectStops = false; release(); await flight; await stopResidents(c.service); await c.service.close(); }
});

test("monitoring retrains on its owned SSH worker and restores the pinned deployment without cloud compute", { timeout: 60000 }, async () => {
  const f = await sshFixture(); let now = Date.now();
  const service = new MlService({ home: f.localHome, bundlePath, transport: new TrainingTransport(bundlePath, f.ssh), enabled: () => true, monitorClock: () => now, scheduleClock: () => now, authorize: async (_p, repo) => ({ repo, commit: "a".repeat(40) }) }); await service.load();
  try {
    const target = await service.register({ host: "fixture", name: "Monitored SSH VM", directory: join(f.remoteHome, "monitor"), python: process.execPath, standalone: true });
    const source = join(f.remoteHome, "monitor.csv"); await writeFile(source, "x,target\n" + "1,0\n".repeat(100));
    const data = await service.snapshot({ project: "p", repo: f.repo, target: target.id, path: source, location: "target" });
    const training = { project: "p", repo: f.repo, name: "SSH monitored model", dataset: data.id, operationId: randomUUID(), spec: { task: "classification", label: "target", split: { kind: "random" }, seed: 42, trainSeconds: 10, cpus: 1 } };
    const job = await until(service, await service.startJob(training));
    const model = await service.registry.register({ project: "p", repo: f.repo, jobId: job.id, name: "SSH monitored model", operationId: randomUUID() });
    let schedule = await service.schedules.create(scheduleRequest({ ...training, operationId: randomUUID() }, source, { maxCycles: 1 }));
    schedule = await service.schedules.update(schedule.id, "pause", { revision: schedule.revision });
    const d = await service.deployments.create({ project: "p", repo: f.repo, name: "SSH monitoring endpoint", modelId: model.id, versionId: model.versions[0]!.id, target: target.id, config: residentLimits, operationId: randomUUID(), reason: "Verify bounded monitoring on owned SSH compute" });
    let m = await service.monitors.create(monitorRequest(d, { retrain: { scheduleId: schedule.id, scheduleRevision: schedule.revision, allowServingPause: true } }));
    await monitorTraffic(service, d); m = await service.monitors.update(m.id, "reference", { revision: m.revision });
    await writeFile(source, (await readFile(source, "utf8")) + "102,0\n");
    for (let i = 0; i < 2; i++) { await monitorTraffic(service, d, 10000); now += 60000; await service.monitors.tick(); }
    now += 60000; await service.monitors.tick(); await service.monitors.tick();
    const cycle = service.store.read().cycles[0]!; assert.ok(cycle); assert.equal(cycle.template.target.id, target.id); assert.deepEqual(cycle.limits, schedule.limits);
    await settleCycle(service, cycle); await service.monitors.tick();
    assert.equal(service.store.read().monitors[0]!.actions[0]!.state, "completed"); assert.equal(service.store.read().deployments[0]!.current, d.current);
    assert.equal(service.store.read().schedules[0]!.state, "exhausted"); assert.equal(service.store.read().experiments.every(e => e.target.workerId === d.target.workerId && e.target.kind === "ssh"), true);
    assert.deepEqual((await service.deployments.predict(d.id, { rows: [{ x: 7 }] })).result.predictions, [7]);
  } finally { await stopResidents(service); await service.close(); await f.cleanup(); }
});

test("promotion deploys a qualifying model on persistent SSH compute and rolls both pointers back after approval", { timeout: 60000 }, async () => {
  const f = await sshFixture(); let now = Date.now();
  const service = new MlService({ home: f.localHome, bundlePath, transport: new TrainingTransport(bundlePath, f.ssh), enabled: () => true, promotionClock: () => now, monitorClock: () => now, authorize: async (_p, repo) => ({ repo, commit: "a".repeat(40) }) }); await service.load();
  try {
    const target = await service.register({ host: "fixture", name: "Promotion SSH VM", directory: join(f.remoteHome, "promote"), python: process.execPath, standalone: true });
    const source = join(f.remoteHome, "promotion.csv"); await writeFile(source, "x,target\n" + "1,0\n".repeat(100));
    const data = await service.snapshot({ project: "p", repo: f.repo, target: target.id, path: source, location: "target" });
    const training = () => ({ project: "p", repo: f.repo, name: "SSH promoted model", dataset: data.id, operationId: randomUUID(), spec: { task: "classification", label: "target", split: { kind: "random" }, seed: 42, trainSeconds: 10, cpus: 1 } });
    const first = await until(service, await service.startJob(training()));
    let model = await service.registry.register({ project: "p", repo: f.repo, jobId: first.id, name: "SSH promoted model", operationId: randomUUID() });
    model = await service.registry.select(model.id, "promote", { versionId: model.versions[0]!.id, revision: model.revision, operationId: randomUUID(), reason: "Reviewed incumbent" });
    const second = await until(service, await service.startJob(training()));
    // Deterministic fixture scores exercise policy mechanics, not a claim of trained model quality.
    await service.store.change(s => { s.experiments.find(e => e.id === second.id)!.status.evaluation!.candidate = .9; });
    model = await service.registry.register({ project: "p", repo: f.repo, jobId: second.id, modelId: model.id, revision: model.revision, operationId: randomUUID() });
    const d = await service.deployments.create({ project: "p", repo: f.repo, name: "SSH promotion endpoint", modelId: model.id, versionId: model.versions[0]!.id, target: target.id, config: residentLimits, operationId: randomUUID(), reason: "Verify promotion on owned SSH compute" });
    let p = await service.promotions.create({ deploymentId: d.id, revision: d.revision, operationId: randomUUID(), name: "SSH release policy", source: { kind: "registry" }, mode: "approval", authorized: true, includeExisting: true, limits: { minImprovement: .01, maxAttempts: 1, cooldownSeconds: 60, approvalSeconds: 3600, observationSeconds: 180 }, health: { ...monitoringLimits, maxActions: 1 } });
    await service.promotions.tick(); p = service.store.read().promotions[0]!;
    p = await service.promotions.update(p.id, "approve", { revision: p.revision, decisionId: p.decisions[0]!.id, reason: "Approve the comparable fixture evaluation" });
    assert.equal(p.decisions[0]!.state, "observing"); assert.equal((await service.deployments.predict(d.id, { rows: [{ x: 7 }] })).versionId, model.versions[1]!.id);
    for (let i = 0; i < 3; i++) { await monitorTraffic(service, service.store.read().deployments[0]!); now += 60000; await service.monitors.tick(); await service.promotions.tick(); }
    p = service.store.read().promotions[0]!; assert.equal(p.decisions[0]!.state, "promoted"); assert.equal(p.state, "paused");
    p = await service.promotions.update(p.id, "rollback", { revision: p.revision, decisionId: p.decisions[0]!.id, reason: "Owner requested rollback after the pilot" });
    assert.equal(p.decisions[0]!.state, "rolled_back"); assert.equal(service.store.read().registry[0]!.selectedVersionId, model.versions[0]!.id); assert.equal(service.store.read().deployments[0]!.current, d.current);
    assert.equal((await service.deployments.runtime(d.id)).state, "ready"); assert.equal((await service.deployments.predict(d.id, { rows: [{ x: 7 }] })).versionId, model.versions[0]!.id);
  } finally { await stopResidents(service); await service.close(); await f.cleanup(); }
});
