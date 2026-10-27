import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { cycleLimitReason, cycleTerminal, proposal, type Cycle } from "../src/ml/cycle-model.js";
import { plannerInput } from "../src/ml/planner.js";
import { MlService, type MlOptions } from "../src/ml/service.js";
import { MlStore } from "../src/ml/store.js";
import { TrainingTransport } from "../src/ml/transport.js";
import { LLM_RECIPE, llmSpec, jobStatus, trainingSpec, intent, terminal, type Experiment } from "../src/ml/model.js";
import { hash } from "../src/training-worker/files.js";
import { fixture as sshFixture } from "./ssh-project-fixture.js";
const root = fileURLToPath(new URL("..", import.meta.url));
let directory: string, bundlePath: string, fixturePython: string;
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
  // The JS recipes emulate Python; answer the worker's independent version preflight.
  fixturePython = join(directory, "fixture-python");
  await writeFile(fixturePython, `#!/bin/sh\nif [ "$1" = "-c" ]; then printf '3.12.0\\n'; else exec '${process.execPath.replaceAll("'", "'\\''")}' "$@"; fi\n`, { mode: 0o700 });
  bundlePath = join(directory, "fixture-bundle.json"); await writeFile(bundlePath, JSON.stringify(bundle));
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
async function context(options: Partial<MlOptions> = {}) {
  const home = join(directory, randomUUID()); await mkdir(home);
  const source = join(home, "data.csv"); await writeFile(source, "x,target\n" + Array.from({ length: 100 }, (_, i) => `${i},${i % 2}`).join("\n"));
  let permitted = true, enabled = true;
  const create = async () => { const service = new MlService({ ...options, home, bundlePath, enabled: () => enabled, authorize: async (project, repo) => { if (!permitted || project !== "p" || repo !== home) throw new Error("Membership revoked"); return { repo, commit: "a".repeat(40) }; } }); await service.load(); return service; };
  const service = await create(); await service.store.change(s => { s.targets[0]!.python = fixturePython; });
  const snapshot = await service.snapshot({ project: "p", repo: home, target: "local", path: source, location: "target" });
  const request = (seconds = 10) => ({ project: "p", repo: home, name: "Test", dataset: snapshot.id, operationId: randomUUID(), spec: { task: "classification", label: "target", split: { kind: "random" }, seed: 42, trainSeconds: seconds, cpus: 1 } });
  return { home, source, service, create, snapshot, request, revoke: () => { permitted = false; }, disable: () => { enabled = false; } };
}
async function until(service: MlService, job: Experiment, predicate: (e: Experiment) => boolean = e => terminal(e.status.state), attempts = 120) {
  let current = job;
  for (let i = 0; i < attempts; i++) { current = await service.inspect(job.id); if (predicate(current)) return current; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(`Job did not settle: ${JSON.stringify(current.status)}`);
}
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

test("missing explicit worker bundle is an actionable 503 for probe and upgrade", async () => {
  const service = new MlService({ home: join(directory, "missing-home"), bundlePath: join(directory, "absent.json"), enabled: () => true, authorize: async (_project, repo) => ({ repo, commit: "a".repeat(40) }) });
  await service.load();
  try { for (const action of [() => service.probe("local"), () => service.upgrade("local")]) await assert.rejects(action(), (error: any) => error.status === 503 && /npm run build:training-worker/.test(error.message) && !/ENOENT/.test(error.message)); }
  finally { await service.close(); }
});
test("wrong or missing Python is diagnosed before packages and setup without a traceback", async () => {
  const home = join(directory, randomUUID()); await mkdir(home);
  const python = join(home, "python39"); await writeFile(python, "#!/bin/sh\nprintf '3.9.6\\n'\n", { mode: 0o700 });
  const service = new MlService({ home, bundlePath, enabled: () => true, authorize: async (_project, repo) => ({ repo, commit: "a".repeat(40) }) }); await service.load();
  try {
    await service.configure("local", { python, revision: service.store.read().targets[0]!.revision });
    const probe = await service.probe("local"); assert.equal(probe.ready, false); assert.match(probe.issue!, /Python 3.9.6.*Python 3.12/); assert.equal(probe.recipes!.every(r => /3.9.6/.test(r.issue!)), true);
    const job = await until(service, await service.startJob({ project: "p", repo: home, target: "local", operationId: randomUUID() }, true));
    assert.equal(job.status.state, "failed"); assert.match(job.status.error!, /Python 3.9.6.*Python 3.12/); assert.doesNotMatch(job.status.error!, /AssertionError|Traceback|Command failed/);
    await service.configure("local", { python: join(home, "missing"), revision: service.store.read().targets[0]!.revision });
    assert.match((await service.probe("local")).issue!, /could not be checked.*ENOENT/);
  } finally { await service.close(); }
});
test("last planner iteration explicitly fits one remaining trial", async () => {
  const c = await context();
  try {
    await c.service.close();
    const service = await c.create();
    // Input itself is allowlisted; dataset label and controller paths stay private.
    const cycle = await service.cycles.prepare(cycleRequest(c.request(120), { limits: { iterations: 2, trainSeconds: 240, elapsedSeconds: 1800, patience: 3, minImprovement: 0 } }));
    cycle.reservedTrainSeconds = 120; cycle.trials = [{ number: 1, state: "done" }, { number: 2, state: "planning" }];
    const input = plannerInput(cycle, []); assert.equal(input.currentIteration, 2); assert.equal(input.maxIterations, 2); assert.equal(input.iterationsLeftIncludingThis, 1); assert.equal(input.trialTrainSeconds, 120); assert.equal(input.trialsThatFitRemainingBudget, 1); assert.equal("iteration" in input, false); assert.doesNotMatch(JSON.stringify(input), /data.csv|"label"/);
    await service.close();
  } finally { await c.service.close(); }
});
for (const winner of [false, true]) test(`exhausted paused planner finalizes truthfully and preserves final test (winner=${winner})`, { timeout: 40000 }, async () => {
  let count = 0; const c = await context({ planner: async () => { if (winner && count++ === 0) return { stop: false, reason: "Measure validation", parameters: { trees: 64, depth: 16 } }; throw new Error("Fixture planner unavailable"); } });
  try {
    let cycle = await c.service.cycles.create(cycleRequest(c.request(), { limits: { iterations: 2, trainSeconds: 20, elapsedSeconds: 300, patience: 3, minImprovement: 0 } }));
    cycle = await settleCycle(c.service, cycle); if (cycle.trials.length === 1) { await c.service.cycles.resume(cycle.id); cycle = await settleCycle(c.service, cycle); }
    assert.equal(cycle.state, "paused"); assert.equal(cycle.trials.length, 2); assert.equal(!!cycle.bestJobId, winner);
    await c.service.cycles.resume(cycle.id); cycle = await settleCycle(c.service, cycle); assert.equal(cycle.state, "completed");
    const jobs = c.service.store.read().experiments.filter(e => e.intent.search?.cycleId === cycle.id);
    if (!winner) { assert.equal(jobs.length, 0); assert.match(cycle.reason!, /no model was trained/); assert.doesNotMatch(cycle.reason!, /no candidate beat/); }
    else { assert.equal(jobs.filter(j => j.intent.search?.partition === "test").length, 1); assert.ok(cycle.finalJobId); }
  } finally { await c.service.close(); }
});
test("SSH copy resumes after eight chunks and skips completed data; full hash stays authoritative", { timeout: 60000 }, async () => {
  const f = await sshFixture(); const transport = new TrainingTransport(bundlePath, f.ssh); let count = 0, fault = true; const offsets: number[] = [];
  const client = { close: () => transport.close(), call: async <T>(target: any, request: Record<string, unknown>, enroll?: boolean): Promise<T> => { if (request.action === "upload") { offsets.push(request.offset as number); if (fault && ++count === 9) throw new Error("Fixture connection refused"); } return transport.call<T>(target, request, enroll); } };
  const service = new MlService({ home: f.localHome, bundlePath, transport: client, enabled: () => true, authorize: async (_project, repo) => ({ repo, commit: "a".repeat(40) }) }); await service.load();
  try {
    const target = await service.register({ host: "fixture", name: "Transfer fixture", directory: join(f.remoteHome, "training"), python: fixturePython, standalone: true });
    const source = join(f.localHome, "large.csv"); await writeFile(source, "x,target\n" + "123456,1\n".repeat(540000));
    const input = { project: "p", repo: f.localHome, target: target.id, path: source, location: "controller" };
    await assert.rejects(service.snapshot(input), /Fixture connection refused/); assert.equal(offsets.at(-1), 8 * 256 * 1024);
    fault = false; offsets.length = 0; const saved = await service.snapshot(input); assert.equal(offsets[0], 8 * 256 * 1024); assert.equal(offsets.length, Math.ceil(saved.dataset.bytes / (256 * 1024)) - 8);
    offsets.length = 0; assert.equal((await service.snapshot(input)).id, saved.id); assert.deepEqual(offsets, []);
    await chmod(join(target.directory, "datasets", `${saved.dataset.hash}.csv`), 0o600);
    await writeFile(join(target.directory, "datasets", `${saved.dataset.hash}.csv`), "corrupt"); await assert.rejects(service.snapshot(input), /Cached dataset hash changed/);
  } finally { await service.close(); await f.cleanup(); }
});

test("rejected planning turns without a winner consume patience", async () => {
  const c = await context();
  try { const cycle = await c.service.cycles.prepare(cycleRequest(c.request(), { limits: { iterations: 3, trainSeconds: 30, elapsedSeconds: 300, patience: 1, minImprovement: 0 } })); cycle.trials = [{ number: 1, state: "rejected" }]; assert.match(cycleLimitReason(cycle)!, /Early stopping/); } finally { await c.service.close(); }
});
