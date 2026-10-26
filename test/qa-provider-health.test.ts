import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url)), scratch = realpathSync(mkdtempSync(join(tmpdir(), "codeflow-qa-health-")));
process.env.CODEFLOW_HOME = join(scratch, "state"); process.env.PATH = `${join(root, "test/fake-bin")}:${process.env.PATH}`;
after(() => rmSync(scratch, { recursive: true, force: true }));
const { quotaReason } = await import("../src/quota-status.js");
const { ModelCatalogStore } = await import("../src/model-catalog.js");
const { adapters, agentCatalog, invalidateAgentCatalogs } = await import("../src/adapters/index.js");
const { describeFailure, runJsonlProcess } = await import("../src/adapters/process.js");
const { managedPermissionProblem } = await import("../src/adapters/managed-permissions.js");
import type { ModelCatalog, RunOptions } from "../src/adapters/types.js";

test("synthetic usage limits use the same expiry rule as Auto, without requiring a utilization", () => {
  const now = Date.now(), quota = { status: "limited", windows: { limit: { resetsAt: now + 1000 } }, at: now };
  assert.equal(quotaReason(quota, now), "hit its usage limit"); assert.equal(quotaReason(quota, now + 1001), undefined);
  assert.equal(quotaReason({ status: "rejected", windows: {}, at: now }, now + 59 * 60_000), "hit its usage limit");
  assert.equal(quotaReason({ status: "rejected", windows: {}, at: now }, now + 61 * 60_000), undefined);
  assert.match(quotaReason({ status: "allowed", windows: { five_hour: { utilization: .95 } }, at: now }, now)!, /95%/);
});

test("a never-discovered catalog stays unknown on forced, offline and TTL refreshes", async () => {
  let now = 10_000, fail = true;
  const store = new ModelCatalogStore(join(scratch, "catalog"), async () => { if (fail) throw Error("unavailable"); return { models: [], efforts: [], allowCustom: false }; }, () => now);
  for (const options of [{}, { force: true }, { offline: true }]) { const result = await store.get("agy", options); assert.equal(result.state, "unknown"); assert.equal(result.discoveredAt, 0); }
  now += 11 * 60_000; assert.equal((await store.get("agy")).state, "unknown");
  fail = false; const discovered = await store.get("agy", { force: true }); assert.equal(discovered.state, "current"); assert.equal(discovered.models.length, 0, "a successful empty catalog is still evidence");
  fail = true; assert.equal((await store.get("agy", { force: true })).state, "stale"); assert.equal((await store.get("agy", { offline: true })).state, "stale");
});

test("explicit catalog invalidation refreshes evidence and an old rejected request cannot evict its replacement", async () => {
  const prior = adapters.agy.catalog; let calls = 0;
  const catalog = (name: string): ModelCatalog => ({ models: [{ id: name, label: name }], efforts: [], allowCustom: false });
  try {
    adapters.agy.catalog = async () => { calls++; return catalog("first"); }; invalidateAgentCatalogs();
    assert.equal((await agentCatalog("agy")).models[0]?.id, "first");
    adapters.agy.catalog = async () => { calls++; return catalog("second"); };
    assert.equal((await agentCatalog("agy")).models[0]?.id, "first"); assert.equal(calls, 1);
    invalidateAgentCatalogs(); assert.equal((await agentCatalog("agy")).models[0]?.id, "second");
    let reject!: (reason: Error) => void; adapters.agy.catalog = () => new Promise((_, no) => { reject = no; }); invalidateAgentCatalogs(); const old = agentCatalog("agy");
    adapters.agy.catalog = async () => catalog("replacement"); invalidateAgentCatalogs(); const fresh = agentCatalog("agy"); reject(Error("old probe failed")); await assert.rejects(old); await fresh;
    assert.equal(agentCatalog("agy"), fresh);
  } finally { adapters.agy.catalog = prior; invalidateAgentCatalogs(); }
});

test("import-only compatibility probes cannot recreate deleted state or overwrite an existing process registry", () => {
  const home = join(scratch, "probe"), state = join(home, "state"); mkdirSync(state, { recursive: true });
  const module = new URL("../src/adapters/process.ts", import.meta.url).href;
  const child = (code: string) => execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: root, env: { ...process.env, CODEFLOW_HOME: state } });
  writeFileSync(join(state, "processes.json"), "existing registry"); child(`await import(${JSON.stringify(module)})`); assert.equal(readFileSync(join(state, "processes.json"), "utf8"), "existing registry");
  child(`await import(${JSON.stringify(module)}); const {rmSync}=await import('node:fs'); rmSync(${JSON.stringify(home)},{recursive:true,force:true});`); assert.equal(existsSync(home), false);
});

test("tracked children are still killed and their registry cleared on process exit", async () => {
  const state = join(scratch, "tracked"); mkdirSync(state);
  const code = `const {spawn}=await import('node:child_process'); const {writeFileSync}=await import('node:fs'); const {trackGroup}=await import(${JSON.stringify(new URL("../src/adapters/process.ts", import.meta.url).href)}); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); trackGroup(child.pid); writeFileSync(${JSON.stringify(join(state, "pid"))},String(child.pid)); child.unref();`;
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: root, env: { ...process.env, CODEFLOW_HOME: state } });
  const pid = Number(readFileSync(join(state, "pid"), "utf8"));
  for (let n = 0; n < 40; n++) { try { process.kill(pid, 0); } catch { break; } await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.throws(() => process.kill(pid, 0)); assert.deepEqual(JSON.parse(readFileSync(join(state, "processes.json"), "utf8")).groups, []);
});

test("shutdown abort reasons reach provider failure text while user cancellation stays distinct", async () => {
  const controller = new AbortController();
  const result = runJsonlProcess({ command: process.execPath, args: ["-e", "console.log('ready');setInterval(()=>{},1000)"], cwd: scratch, signal: controller.signal, onText: () => controller.abort("codeflow-shutdown"), onJson: () => {} });
  const outcome = await result; assert.equal(outcome.abortReason, "shutdown"); assert.match(describeFailure("Claude Code", outcome), /interrupted because Code Flow shut down/); assert.doesNotMatch(describeFailure("Claude Code", outcome), /cancelled/);
  assert.equal(describeFailure("Claude Code", { ...outcome, abortReason: undefined }), "Claude Code was cancelled");
});

test("container capability failures preserve missing-image and daemon recovery without blaming CLI flags", async () => {
  const bin = join(scratch, "bin"); mkdirSync(bin); const previous = process.env.PATH;
  const fixture = `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(join(scratch, "docker-calls"))},JSON.stringify(a)+'\\n');if(a[0]==='rm')process.exit(0);process.stderr.write(a.includes('missing/image')?'docker: No such image: missing/image':'Cannot connect to the Docker daemon');process.exit(125);\n`;
  writeFileSync(join(bin, "docker"), fixture, { mode: 0o755 }); process.env.PATH = `${bin}:${previous}`;
  try {
    for (const provider of ["claude", "codex"] as const) for (const image of ["missing/image", "daemon/offline"]) {
      const options = { cwd: scratch, prompt: "Never reaches an agent", mode: "write", trust: "standard", permissions: { provider, nativeDelegation: false, mode: "write", trust: "standard", toolApprovals: false }, agentContainer: { image }, onEvent: () => {} } as unknown as RunOptions;
      const result = await managedPermissionProblem(provider, options); assert.equal(result?.errorKind, "other"); assert.match(result?.error ?? "", image.startsWith("missing") ? /not available locally.*never pulls.*build or load/ : /daemon is unavailable/);
    }
    const calls = readFileSync(join(scratch, "docker-calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    assert.equal(calls.filter(args => args[0] === "run").length, 4); assert.ok(calls.filter(args => args[0] === "run").every(args => args.includes("--pull=never"))); assert.ok(calls.every(args => ["run", "rm"].includes(args[0]!)));
  } finally { process.env.PATH = previous; }
});

test("fresh provider inventory survives an older response and health probes stay shared across writes", async () => {
  const { build } = await import("esbuild");
  const output = await build({ stdin: { contents: 'export { loadAgents, refreshProviders, loadHealth, agents } from "./state.ts"; export { post, SHORT } from "./lib.ts";', resolveDir: join(root, "ui"), loader: "ts" }, bundle: true, write: false, format: "esm", target: "es2022", jsx: "automatic", jsxImportSource: "preact", loader: { ".png": "dataurl", ".svg": "dataurl" }, logLevel: "silent" });
  const bundle = join(scratch, "ui.mjs"); writeFileSync(bundle, output.outputFiles[0]!.text);
  const script = `import assert from 'node:assert/strict';
const storage=new Map();let release;const gate=new Promise(r=>release=r);let healthRelease,healthGate,healthCalls=0;
Object.assign(globalThis,{window:globalThis,document:{addEventListener(){},hidden:false},BroadcastChannel:undefined,innerWidth:1440,addEventListener(){},removeEventListener(){},localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},location:{hostname:'127.0.0.1',hash:'',origin:'http://127.0.0.1',pathname:'/'},fetch:async path=>{
 const p=new URL(path,'http://127.0.0.1');let data={};
 if(p.pathname==='/api/agents'){if(!p.search)await gate;data=[{id:'claude',displayName:p.search?'Fresh':'Stale',available:!!p.search}];}
 if(p.pathname==='/api/doctor'){healthCalls++;if(healthGate)await healthGate;data=[];}
 return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
}});
const m=await import(${JSON.stringify(bundle)});const older=m.loadAgents();await m.refreshProviders();assert.equal(m.agents.value[0].available,true);release();await older;assert.equal(m.agents.value[0].available,true);assert.equal(m.SHORT.claude,'Fresh');
healthCalls=0;healthGate=new Promise(r=>healthRelease=r);const a=m.loadHealth();await m.post('/api/example-write',{});const b=m.loadHealth();assert.equal(a,b);assert.equal(healthCalls,1);healthRelease();await a;`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: scratch, env: { ...process.env, CODEFLOW_HOME: join(scratch, "ui-state") }, timeout: 15_000 });
});
