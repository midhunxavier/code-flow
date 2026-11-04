/** Opt-in real-provider test. Only the new disposable repository is authorized for edits.
 * The operator's explicit live-test authorization accepts these fixed bounded approaches
 * through the owner API. This does NOT simulate or certify a native human approval UI.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
if (process.env.CODEFLOW_TEST_LIVE_AGENTS !== "1") throw new Error("Explicitly set CODEFLOW_TEST_LIVE_AGENTS=1 to spend real provider calls on disposable fixtures");
const root = fileURLToPath(new URL("..", import.meta.url));
const directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-ux-live-")));
const repo = join(directory, "project with spaces"), home = join(directory, "state");
await mkdir(repo); process.env.CODEFLOW_HOME = home;
const token = randomBytes(32).toString("hex"), headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const env = { ...process.env, CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, CODEFLOW_CLI_HEADLESS: "1", CODEFLOW_NO_BROWSER: "1" };
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
await writeFile(join(repo, "app.mjs"), "export const value = 1;\n");
await writeFile(join(repo, "app.test.mjs"), "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from './app.mjs'; test('fixed contract',()=>assert.equal(value,2));\n");
await writeFile(join(repo, "README.md"), "Disposable live test. Change only app.mjs to export value=2. Tests are fixed. No dependencies, network, pushes or deployment. Permission probes may only target permission-probe.txt inside this test worktree.\n");
git("add", "."); git("-c", "user.name=Live test", "-c", "user.email=live@localhost", "commit", "-qm", "Fixed live test");
const original = git("rev-parse", "HEAD"), originalTest = await readFile(join(repo, "app.test.mjs"), "utf8");
const port = await new Promise<number>(resolve => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => resolve(p)); }); });
assert.ok(![4317,4318].includes(port)); const base = `http://127.0.0.1:${port}`;
let server: ChildProcess, peer: Awaited<ReturnType<typeof connectMcp>> | undefined, serverLog = "", sequence = 0;
const reports: any[] = [];
const save = (name: string, value: unknown) => writeFile(join(directory, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(read: () => Promise<T>, matches: (v: T) => boolean, what: string, timeout=60000) { const end=Date.now()+timeout; do {const v=await read(); if(matches(v)) return v; await delay(250);} while(Date.now()<end); throw new Error(`Timeout: ${what}`); }
async function api(path: string) { const r=await fetch(base+path,{headers}); const v=await r.json(); assert.ok(r.ok, JSON.stringify(v)); return v as any; }
async function startOwner() {
  server=spawn(process.execPath,["--import","tsx","src/server.ts"],{cwd:root,env:{...env,PORT:String(port)},stdio:["ignore","pipe","pipe"]});
  for(const s of [server.stdout,server.stderr]) s?.on("data", c=>serverLog+=c);
  await until(async()=>{if(server.exitCode!==null) throw new Error(serverLog.slice(-2000));return fetch(base+"/api/health",{headers}).then(r=>r.ok,()=>false);},Boolean,"owner startup");
  peer=await connectMcp();
}
async function stopOwner() {
  await peer?.close(); peer=undefined;
  if(server?.exitCode===null){server.kill("SIGTERM");await until(async()=>server.exitCode,v=>v!==null,"owner shutdown",30000);}
}
async function connectMcp() {
  const child=spawn(process.execPath,["--import","tsx","src/cli-teams/cli.ts","mcp","--project-root",repo],{cwd:root,env,stdio:["pipe","pipe","pipe"]});
  let buffer="", id=0; const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  child.stdout!.on("data",chunk=>{buffer+=chunk; let end:number;while((end=buffer.indexOf("\n"))>=0){const m=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}}});
  child.stderr!.on("data",()=>{});
  child.on("exit",()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error("MCP exited"));}pending.clear();});
  const rpc=(method:string,params:object)=>new Promise<any>((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>{pending.delete(n);reject(new Error(`MCP timeout: ${method}`));},40000);pending.set(n,{resolve,reject,timer});child.stdin!.write(JSON.stringify({jsonrpc:"2.0",id:n,method,params})+"\n");});
  await rpc("initialize",{protocolVersion:"2025-11-25",capabilities:{}});
  return {call:async(name:string,args:object={})=>{const reply=await rpc("tools/call",{name:`codeflow_${name}`,arguments:args}); assert.equal(reply.content[0].text.startsWith('{"protocolVersion"'), false); const r=reply.structuredContent;if(!r.ok)throw new Error(`${r.error.code}: ${r.error.message}`);return r.data;},close:async()=>{child.stdin!.end();await until(async()=>child.exitCode,v=>v!==null,"MCP close",10000);}};
}
async function call(name:string,args:object={}) {return peer!.call(name,args);}
const task=(id:string,operation:string,participant:string|undefined,instructions?:string,inputs?:string[])=>({id,type:"task",operation,...(participant?{participant}:{}),...(instructions?{instructions}:{}),...(inputs?{inputs}:{})});
const people=[{id:"haiku",provider:"claude",model:"claude-haiku-5-5",effort:"high"},{id:"luna",provider:"codex",model:"gpt-6-luna",effort:"high"}];
async function begin(name:string,candidate:any,context:object={}) {
  const p=await call("propose_run",{operationId:`live-propose-${++sequence}`,task:name,candidate,context}); await save(`${name}-proposal.json`,p);
  const descriptor=JSON.parse(await readFile(join(home,"cli-teams-runtime.json"),"utf8"));
  const owner=async(path:string,body:object)=>{const r=await fetch(descriptor.endpoint+path,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${descriptor.bootstrap}`},body:JSON.stringify({projectRoot:repo,...body})});const v=await r.json() as any;assert.equal(v.ok,true,JSON.stringify(v));return v.data;};
  const preview=await owner("/preview",{proposalId:p.proposalId,revision:p.revision});
  assert.equal(preview.hash,p.proposalHash);
  // Exact bounded test candidate accepted by the explicit opt-in operator authorization.
  await owner("/confirm",{proposalId:p.proposalId,revision:p.revision,hash:p.proposalHash});
  const started=await call("start_run",{operationId:`live-start-${++sequence}`,proposalId:p.proposalId,expectedRevision:p.revision,proposalHash:p.proposalHash});
  console.log(JSON.stringify({phase:name,runId:started.runId,workspace:started.workspace?.url})); return {p,runId:started.runId};
}
async function collect(name:string,runId:string) {
  const status=await call("get_run",{runId}); const artifacts:any[]=[];let cursor:number|undefined=0;
  do { const page=await call("get_run",{runId,artifactCursor:cursor,artifactLimit:100});for(const a of page.artifacts){let body="",next:number|undefined=0,data:any;do {const part=await call("get_artifact",{runId,artifactId:a.id,sha256:a.sha256,cursor:next,maxBytes:24000});body+=part.body;data??=part.data;next=part.nextCursor;}while(next!==undefined);artifacts.push({...a,body,data});}cursor=page.nextArtifactCursor;}while(cursor!==undefined);
  const run=await api(`/api/runs/${runId}`);await save(`${name}-status.json`,status);await save(`${name}-artifacts.json`,artifacts);await save(`${name}-run.json`,run);
  assert.deepEqual(status.evidence.participants.map((p:any)=>p.id).sort(),["haiku","luna"]);
  for(const p of status.evidence.participants){assert.equal(p.resolved.effort,"high");assert.ok(p.assignments.some((a:any)=>a.invocations>0&&a.sessionId),`${p.id} must have a native session receipt`);}
  const report={phase:name,runId,outcome:status.outcome,calls:status.usage.managedInvocations,participants:status.evidence.participants,artifacts:artifacts.map(a=>({id:a.id,kind:a.kind,participant:a.participant,verdict:a.data?.verdict,findings:a.data?.findings})),workspace:status.workspace};reports.push(report);return {status,artifacts,run};
}
async function waitDone(runId:string,hook?:(state:any)=>Promise<void>) {let last="";const end=Date.now()+18*60000;while(Date.now()<end){const s=await call("get_run",{runId});const progress=JSON.stringify({status:s.status,calls:s.usage.managedInvocations,steps:s.evidence.participants.flatMap((p:any)=>p.assignments.map((a:any)=>`${p.id}:${a.status}`))});if(progress!==last){console.log(progress);last=progress;}if(s.runtimeStatus!=="running")return s;await hook?.(s);await delay(1500);}throw new Error("Live run timeout");}
try {
  console.log(JSON.stringify({directory, repo, port, models:people, maximumCalls:6}));
  await startOwner();
  const connection = await call("list_providers"); assert.equal(connection.connection.live, true);
  await save("connection.json", connection);
  const plan = await begin("ux-plan", {scope:"plan", participants:people, completion:["A concise independently reviewed plan for changing only app.mjs value to 2"], limits:{maxInvocations:4,maxMinutes:8,maxAttempts:1,concurrency:1}, steps:[{id:"agreement",type:"loop",maxIterations:2,steps:[
    task("draft","propose","haiku","Read app.mjs and app.test.mjs. Plan only: change value to 2, retain the test, have Code Flow run it and Luna independently review the change. Under 150 words. No optional scope, extra-module checks, or merge work. Address any prior blocking feedback."),
    task("review","review_plan","luna","Read the tiny source and test. Approve if the plan changes only value to 2 and checks the fixed test. No optional scope.",["draft"]),
    {id:"gate",type:"gate",policy:"agreement",target:"draft",reviews:["review"]}]},
    {id:"result",type:"finish",outcome:"agreed_plan",inputs:["draft","gate"]}
  ]});
  await waitDone(plan.runId); const planned = await collect("ux-plan",plan.runId);
  assert.equal(planned.status.outcome,"agreed_plan"); assert.equal(planned.status.progress.phase,"completed");
  const build = await begin("ux-build", {scope:"write", participants:people, check:"node --test app.test.mjs", completion:["Only app.mjs changes to value 2, the original test passes, and Luna approves the exact code"], limits:{maxInvocations:2,maxMinutes:8,maxAttempts:1,concurrency:1}, steps:[
    task("build","implement","haiku","Implement the accepted plan. Change only app.mjs export value from 1 to 2. Do not edit tests or README. Code Flow runs checks; do not spawn other agents. Summarize what changed and why."),
    task("check","verify",undefined),
    task("review","review_code","luna","Read app.mjs and app.test.mjs. Approve if value is 2 and the original test remains unchanged; report actual evidence. No edits or optional scope.",["build"]),
    {id:"gate",type:"gate",policy:"verified",target:"build",reviews:["review"],verification:"check"},
    {id:"result",type:"finish",outcome:"verified_changes",inputs:["build","check","review","gate"]}
  ]}, planned.status.continuation.context);
  await waitDone(build.runId); const built = await collect("ux-build",build.runId);
  assert.equal(built.status.outcome,"verified_changes"); assert.equal(built.status.handoff.check.passed,true);
  assert.equal(built.status.workspace.chatId,planned.status.workspace.chatId);
  assert.equal(git("rev-parse","HEAD"),original); assert.equal(git("status","--porcelain"),"");
  const preview = await call("preview_handoff",{runId:build.runId}); assert.equal(preview.ready,true,preview.reason);
  await save("handoff-preview.json",preview);
  const descriptor=JSON.parse(await readFile(join(home,"cli-teams-runtime.json"),"utf8"));
  // Fixed disposable-fixture application is covered by the operator's opt-in test authorization.
  const confirmation=await fetch(descriptor.endpoint+"/handoff-confirm",{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${descriptor.bootstrap}`},body:JSON.stringify({projectRoot:repo,runId:build.runId,previewHash:preview.previewHash})});
  assert.equal((await confirmation.json() as any).ok,true);
  const args={operationId:"live-ux-apply",runId:build.runId,previewHash:preview.previewHash};
  await save("applied.json",await call("apply_handoff",args));
  assert.equal((await call("apply_handoff",args)).applied,true);
  assert.equal(git("rev-parse","HEAD"),original); assert.equal(git("diff","--cached","--name-only"),"app.mjs");
  assert.equal(await readFile(join(repo,"app.test.mjs"),"utf8"),originalTest);
  const checkEnv={...process.env};delete checkEnv.NODE_TEST_CONTEXT;
  await writeFile(join(directory,"destination-check.txt"),execFileSync(process.execPath,["--test","--test-reporter=tap","app.test.mjs"],{cwd:repo,env:checkEnv,encoding:"utf8"}));
  await stopOwner(); await startOwner();
  assert.equal((await call("apply_handoff",args)).applied,true,"application receipt survives owner restart");
  console.log("PASS: live Claude/Codex plan, continuation, verified result, exact diff, staged application and restart reconciliation");
} catch(error) {await save("failure.json",{message:error instanceof Error?error.message:String(error),stack:error instanceof Error?error.stack:undefined});throw error;}
finally {await save("report.json",reports);await stopOwner();await writeFile(join(directory,"owner.log"),serverLog,{mode:0o600});console.log(`Evidence: ${directory}`);}
