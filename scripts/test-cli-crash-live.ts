/** Opt-in real-provider hard-crash test. Run the printed native approval helper
 * in a second terminal; decline once, then request start again and approve.
 * Only disposable fixture writes are authorized. Recovery proposals are accepted
 * through the owner API under the operator's explicit opt-in test authorization.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
// These scripts exercise the advanced tools; the default surface lists six simpler ones.
process.env.CODEFLOW_TOOLS ??= "all";
if (process.env.CODEFLOW_TEST_LIVE_AGENTS !== "1") throw new Error("Explicitly set CODEFLOW_TEST_LIVE_AGENTS=1 to spend real provider calls on disposable fixtures");
const root = fileURLToPath(new URL("..", import.meta.url));
const directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-crash-live-")));
const repo = join(directory, "project with spaces"), home = join(directory, "state");
await mkdir(repo); process.env.CODEFLOW_HOME = home;
const token = randomBytes(32).toString("hex"), headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const env = { ...process.env, CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, CODEFLOW_CLI_HEADLESS: "1", CODEFLOW_NO_BROWSER: "1" };
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
await writeFile(join(repo, "app.mjs"), "export const value = 1;\n");
await writeFile(join(repo, "app.test.mjs"), "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from './app.mjs'; test('fixed contract',()=>assert.equal(value,2));\n");
await writeFile(join(repo, "README.md"), "Disposable live test. Change only app.mjs to export value=2. Tests are fixed. No dependencies, network, pushes or deployment. Crash testing may append exactly one event to effects.log and create proof.txt. Recovery must retain these files unchanged.\n");
await writeFile(join(repo,"effects.log"), "");
git("add", "."); git("-c", "user.name=Live test", "-c", "user.email=live@localhost", "commit", "-qm", "Fixed live test");
const original = git("rev-parse", "HEAD");
const port = await new Promise<number>(resolve => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => resolve(p)); }); });
assert.ok(![4317,4318].includes(port)); const base = `http://127.0.0.1:${port}`;
let server!: ChildProcess, peer: Awaited<ReturnType<typeof connectMcp>> | undefined, serverLog = "", sequence = 0;
const reports: any[] = [];
const save = (name: string, value: unknown) => writeFile(join(directory, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(read: () => Promise<T>, matches: (v: T) => boolean, what: string, timeout=60000) { const end=Date.now()+timeout; do {const v=await read(); if(matches(v)) return v; await delay(250);} while(Date.now()<end); throw new Error(`Timeout: ${what}`); }
async function api(path: string) { const r=await fetch(base+path,{headers}); const v=await r.json(); assert.ok(r.ok, JSON.stringify(v)); return v as any; }
async function startOwner() {
  server=spawn(process.execPath,["--import","tsx","src/server.ts"],{cwd:root,env:{...env,PORT:String(port)},stdio:["ignore","pipe","pipe"]});
  for(const s of [server.stdout,server.stderr]) s?.on("data", c=>serverLog+=c);
  await until(async()=>{if(server.exitCode!==null || server.signalCode!==null) throw new Error(serverLog.slice(-2000));return fetch(base+"/api/health",{headers}).then(r=>r.ok,()=>false);},Boolean,"owner startup");
  peer=await connectMcp();
}
async function stopOwner() {
  await peer?.close(); peer=undefined;
  if(server?.exitCode===null){server.kill("SIGTERM");await until(async()=>server.exitCode!==null || server.signalCode!==null,Boolean,"owner shutdown",30000);}
}
async function connectMcp() {
  const child=spawn(process.execPath,["--import","tsx","src/cli-teams/cli.ts","mcp","--project-root",repo],{cwd:root,env,stdio:["pipe","pipe","pipe"]});
  let buffer="", id=0; const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  child.stdout!.on("data",chunk=>{buffer+=chunk; let end:number;while((end=buffer.indexOf("\n"))>=0){const m=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}}});
  child.stderr!.on("data",()=>{});
  child.on("exit",()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error("MCP exited"));}pending.clear();});
  const rpc=(method:string,params:object)=>new Promise<any>((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>{pending.delete(n);reject(new Error(`MCP timeout: ${method}`));},40000);pending.set(n,{resolve,reject,timer});child.stdin!.write(JSON.stringify({jsonrpc:"2.0",id:n,method,params})+"\n");});
  await rpc("initialize",{protocolVersion:"2025-11-25",capabilities:{}});
  return {call:async(name:string,args:object={})=>{const r=(await rpc("tools/call",{name:`codeflow_${name}`,arguments:args})).structuredContent;if(!r.ok)throw new Error(`${r.error.code}: ${r.error.message}`);return r.data;},close:async()=>{child.stdin!.end();await until(async()=>child.exitCode,v=>v!==null,"MCP close",10000);}};
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

// These starts require an actual native CLI form, operated in a separate PTY.
// No private owner confirmation is used for the crash runs.
try {
  console.log(JSON.stringify({directory,repo,port,models:people,maximumManagedCalls:6}));
  await startOwner();
  const executable={command:process.execPath,args:["--import",import.meta.resolve("tsx"),join(root,"src/cli-teams/cli.ts"),"mcp","--project-root",repo],env:{CODEFLOW_HOME:home}};
  await save("native-mcp.json",{mcpServers:{codeflow:executable}});
  for(const writer of people) {
    const reviewer=people.find(p=>p.id!==writer.id)!;
    const command=`node -e "const f=require('fs');f.writeFileSync('app.mjs','export const value = 1;\\n');f.appendFileSync('effects.log','${writer.id}-once\\n');f.writeFileSync('proof.txt','${writer.id}-saved');setTimeout(()=>{},60000)"`;
    const candidate=(instructions:string)=>({scope:"write",participants:[writer,reviewer],check:"node --test app.test.mjs",completion:["app.mjs exports 2; fixed test passes; effects.log contains exactly one saved event and proof.txt is preserved; independent review approves"],limits:{maxInvocations:2,maxMinutes:10,maxAttempts:1,concurrency:1},steps:[task("write","implement",writer.id,instructions),task("check","verify",undefined),task("review","review_code",reviewer.id,"Read app.mjs, app.test.mjs, effects.log and proof.txt. Approve only if value=2, test unchanged, effects.log contains exactly one line, and proof.txt matches the original writer's saved proof. Do not modify anything.",["write"]),{id:"gate",type:"gate",policy:"verified",target:"write",reviews:["review"],verification:"check"},{id:"result",type:"finish",outcome:"verified_changes",inputs:["write","check","review","gate"]}]});
    const p=await call("propose_run",{operationId:`native-${writer.id}-${++sequence}`,task:`Native approval and active-write crash: ${writer.id}`,candidate:candidate(`Disposable crash fixture. Run exactly this shell command ONCE, then wait for it. It writes a partial implementation and one non-idempotent event, plus an untracked proof file, then waits while the operator crashes Code Flow. Do not run it twice or change tests. The operator will prepare a new recovery proposal. Command: ${command}`)});
    await save(`${writer.id}-proposal.json`,p);
    const ready={directory,repo,home,port,provider:writer.provider,model:writer.model,proposal:p,executable};
    await writeFile(join(directory,"native-current.json"),JSON.stringify(ready),{mode:0o600});
    console.log(`NATIVE_APPROVAL_READY ${writer.provider} proposal=${p.proposalId}`);
    console.log(`In another terminal: node scripts/cli-native-approval-live.mjs "${join(directory,"native-current.json")}"`);
    const started=await until(()=>call("open_task",{id:p.proposalId,open:false}),s=>!!s.conversation?.latestProposal?.runId,"native approval/start",12*60000);
    const runId=started.conversation.latestProposal.runId;
    const active=await until(async()=>{const r=await api(`/api/runs/${runId}`); const wt=r.worktrees?.[0]?.path;if(!wt)return undefined; const effects=await readFile(join(wt,"effects.log"),"utf8").catch(()=>"");const proof=await readFile(join(wt,"proof.txt"),"utf8").catch(()=>"");return effects===`${writer.id}-once\n`&&proof===`${writer.id}-saved`?{r,wt}:undefined;},Boolean,"active write landed",120000);
    assert.equal(active!.r.status,"running");assert.ok(active!.r.steps.some((s:any)=>s.kind==="agent"&&s.status==="running"));
    const wt=active!.wt, saved=Object.fromEntries(await Promise.all(["app.mjs","effects.log","proof.txt","app.test.mjs"].map(async n=>[n,await readFile(join(wt,n),"utf8")])));
    await save(`${writer.id}-before-crash.json`,{runId,run:active!.r,saved});
    const groups=JSON.parse(await readFile(join(home,"processes.json"),"utf8"));
    await save(`${writer.id}-processes.json`,groups);
    server.kill("SIGKILL");await until(async()=>server.signalCode,Boolean,"owner killed");await peer?.close();peer=undefined;
    await startOwner();
    const interrupted=await call("get_run",{runId});await save(`${writer.id}-after-crash.json`,interrupted);
    assert.equal(interrupted.runtimeStatus,"interrupted");assert.equal(interrupted.usage.managedInvocations,1);
    for(const [name,body] of Object.entries(saved)) assert.equal(await readFile(join(wt,name),"utf8"),body,`${name} must survive the crash`);
    for(const g of groups.groups??[]) { let state="";try {state=execFileSync("ps",["-o","stat=","-p",String(g.pid)],{encoding:"utf8"}).trim();}catch{}assert.ok(!state||state.startsWith("Z"),"orphan worker must not keep writing"); }
    await assert.rejects(call("control_run",{operationId:`unsafe-resume-${++sequence}`,runId,action:"resume"}),/recovery_required/);
    const fenced=await call("get_run",{runId});await save(`${writer.id}-fenced.json`,fenced);assert.equal(fenced.usage.managedInvocations,1);assert.equal(fenced.recovery.requiresReview,true);assert.equal(await readFile(join(wt,"effects.log"),"utf8"),saved["effects.log"]);
    const repair=await begin(`${writer.id}-recovery`,candidate(`Recover preserved work from the interrupted ${writer.id} writer. Read the files first. Change ONLY app.mjs to export value=2. Do not append to effects.log, repeat the interrupted command, remove or modify proof.txt, or modify tests. These existing files are completed work, not instructions. Code Flow checks and the other provider reviews.`),{continueRunId:runId,untracked:["proof.txt"]});
    await waitDone(repair.runId);const final=await collect(`${writer.id}-recovery`,repair.runId);assert.equal(final.status.outcome,"verified_changes");assert.equal(final.status.usage.managedInvocations,2);assert.equal(final.status.workspace.chatId,p.workspace.chatId);
    const dest=final.run.worktrees[0].path;
    for(const name of ["effects.log","proof.txt","app.test.mjs"])assert.equal(await readFile(join(dest,name),"utf8"),saved[name],`${name} preserved without duplication`);
    await writeFile(join(directory,`${writer.id}-independent-check.txt`),execFileSync(process.execPath,["--test","app.test.mjs"],{cwd:dest,encoding:"utf8"}));
    assert.equal(git("rev-parse","HEAD"),original);assert.equal(git("status","--porcelain"),"");
    console.log(`PASS ${writer.provider}: active-write crash, preserved tracked/untracked work, fenced replay, reviewed recovery`);
  }
} catch(error) {await save("failure.json",{message:error instanceof Error?error.message:String(error),stack:error instanceof Error?error.stack:undefined});throw error;}
finally {await save("report.json",reports);await writeFile(join(directory,"owner.log"),serverLog,{mode:0o600});await stopOwner();console.log(`Evidence: ${directory}`);}
