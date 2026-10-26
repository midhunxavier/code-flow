import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PerformanceMetrics } from "../src/performance.js";
import { StreamSharingIdentity } from "../src/stream-sharing.js";
const scratch = mkdtempSync(join(tmpdir(), "codeflow-stream-health-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("health observers see the same stall without consuming each other's measurements", async () => {
  const metrics = new PerformanceMetrics();
  try {
    const empty = metrics.snapshot().eventLoop; assert.equal(empty.samples, 0); assert.equal(empty.p95Ms, null); assert.equal(empty.maxMs, null);
    await sleep(60); const end = performance.now() + 160; while (performance.now() < end) {}
    await sleep(50); const first = metrics.snapshot().eventLoop, second = metrics.snapshot().eventLoop;
    assert.ok(first.maxMs! >= 150); assert.equal(second.maxMs, first.maxMs); assert.equal(second.p95Ms, first.p95Ms); assert.ok(second.samples >= first.samples); assert.equal(second.window, "since-start"); assert.ok(second.windowSeconds >= first.windowSeconds);
  } finally { metrics.close(); }
});

test("broker identity survives restart but token changes and persisted rotations retire old groups", async () => {
  const file = join(scratch, "state", "stream-sharing.json"), token = "private-owner-token";
  const a = await StreamSharingIdentity.load(file, token), original = a.current;
  assert.match(original.channelKey, /^[a-f0-9]{64}$/); assert.match(original.lockId, /^[a-f0-9]{32}$/); assert.notEqual(original.channelKey.slice(0, 32), original.lockId);
  assert.deepEqual((await StreamSharingIdentity.load(file, token)).current, original);
  assert.notDeepEqual((await StreamSharingIdentity.load(file, "changed-token")).current, original);
  await Promise.all([a.rotate(), a.rotate()]); assert.notDeepEqual(a.current, original); assert.deepEqual((await StreamSharingIdentity.load(file, token)).current, a.current);
  assert.equal(statSync(file).mode & 0o777, 0o600); assert.doesNotMatch(readFileSync(file, "utf8"), new RegExp(token));
  writeFileSync(file, "damaged"); const recovered = await StreamSharingIdentity.load(file, token); assert.notDeepEqual(recovered.current, original); const temporary = recovered.current; await recovered.rotate(); assert.notDeepEqual(recovered.current, temporary); assert.equal(readFileSync(file, "utf8"), "damaged");
  rmSync(file); const active = await StreamSharingIdentity.load(file, token), previous = active.current; rmSync(file); mkdirSync(file);
  await active.rotate(); assert.notDeepEqual(active.current, previous, "a runtime save error must not block sign-out's capability rotation"); assert.equal(statSync(file).isDirectory(), true);
});

test("reconnect ignores diagnostics, times out identity probes and refuses a changed principal", async () => {
  const { build } = await import("esbuild"), root = fileURLToPath(new URL("..", import.meta.url));
  const output = await build({ stdin: { contents: 'export { subscribe, configureStreamSharing, onStreamState } from "./stream.ts";', resolveDir: join(root, "ui"), loader: "ts" }, bundle: true, write: false, format: "esm", target: "es2022", logLevel: "silent" });
  const file = join(scratch, "stream.mjs"); writeFileSync(file, output.outputFiles[0]!.text);
  const script = `import assert from 'node:assert/strict';
const sharing={channelKey:'a'.repeat(64),lockId:'b'.repeat(32)},handlers={};let diagnostics=0,mode='healthy',reloads=0,state;
class Source {static all=[];constructor(){Source.all.push(this)}close(){}send(){this.onmessage?.({data:JSON.stringify({s:0,d:{type:'hello',client:'fixture'}})})}}
const timeout=AbortSignal.timeout.bind(AbortSignal);AbortSignal.timeout=()=>timeout(40);
Object.assign(globalThis,{window:globalThis,addEventListener(name,handler){handlers[name]=handler},location:{hostname:'127.0.0.1',hash:'',origin:'http://127.0.0.1',pathname:'/',reload(){reloads++}},localStorage:{getItem(){return null},setItem(){},removeItem(){}},EventSource:Source,fetch:async(path,opts={})=>{
 if(path==='/api/health'){diagnostics++;return new Response(JSON.stringify({error:'diagnostics broken'}),{status:500});}
 if(path==='/api/auth/self'&&mode==='hang')return new Promise((_,reject)=>opts.signal.addEventListener('abort',()=>reject(opts.signal.reason)));
 return new Response(JSON.stringify(path==='/api/auth/self'?{kind:mode==='shared'?'shared':'owner',streamSharing:sharing}:{}),{headers:{'content-type':'application/json'}});
}});
const m=await import(${JSON.stringify(file)});m.configureStreamSharing(sharing);m.onStreamState(value=>state=value);m.subscribe('runs',()=>{});
const until=async(test)=>{const end=Date.now()+3000;while(!test()){assert.ok(Date.now()<end,JSON.stringify(state));await new Promise(r=>setTimeout(r,10));}};
await until(()=>Source.all.length===1);Source.all[0].send();Source.all[0].onerror();await until(()=>Source.all.length===2);assert.equal(diagnostics,0);Source.all[1].send();
mode='hang';Source.all[1].onerror();await until(()=>state.detail?.includes('Could not reconnect'));assert.match(state.detail,/timeout|timed out/i);assert.equal(Source.all.length,2);
mode='shared';handlers.online();await until(()=>reloads===1);assert.equal(Source.all.length,2);process.exit(0);`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: scratch, env: { ...process.env, CODEFLOW_HOME: join(scratch, "client") }, timeout: 12_000 });
});
