import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const source = await readFile(new URL("../integrations/vscode/extension.cjs", import.meta.url), "utf8");
const turn = () => new Promise(resolve => setImmediate(resolve));

test("VS Code disconnect updates immediately and preflights before asking for a task", async () => {
  const commands = new Map<string, (...args: any[]) => Promise<any>>(), secrets = new Map<string, string>(), prompts: string[] = [], errors: string[] = [], output: string[] = [];
  let origin = "http://127.0.0.1:4467", offline = false, failStart = false, starts = 0;
  let beforeRealpath: (() => Promise<void>) | undefined, beforeCompatibility: (() => Promise<void>) | undefined;
  const view = { message: "", visible: false, onDidChangeVisibility() {}, dispose() {} };
  class Client { constructor(public origin: string) {} async compatibility() { await beforeCompatibility?.(); if (offline) throw new Error("Server unavailable"); } async runs() { return [{ id: "qa", task: "Test", repo: "/tmp" }]; } async start() { starts++; if (failStart) throw new Error("Launch failed"); return { id: "new" }; } }
  const vscode = { EventEmitter: class { event = () => {}; fire() {} dispose() {} }, ExtensionMode: { Test: 3 }, ConfigurationTarget: { Global: 1 }, workspace: { isTrusted: true, workspaceFolders: [{ name: "scratch", uri: { scheme: "file", fsPath: "/tmp" } }], getConfiguration: () => ({ inspect: () => ({ globalValue: origin }), update: async (_key: string, value: string) => { origin = value; } }) }, window: { createOutputChannel: () => ({ appendLine: (s: string) => output.push(s), show() {}, dispose() {} }), createTreeView: () => view, showInputBox: async ({ title }: any) => { prompts.push(title); return "Keep my task"; }, showErrorMessage: async (s: string) => errors.push(s), showInformationMessage() {} }, commands: { registerCommand: (name: string, action: any) => { commands.set(name, action); return { dispose() {} }; } } };
  const context = { subscriptions: [] as any[], extensionMode: 3, secrets: { get: async (key: string) => secrets.get(key), store: async (key: string, value: string) => { secrets.set(key, value); }, delete: async (key: string) => { secrets.delete(key); } } };
  const box = vm.createContext({ require: (name: string) => name === "vscode" ? vscode : name === "node:fs/promises" ? { realpath: async (path: string) => { await beforeRealpath?.(); return path; } } : name === "./client.cjs" ? { CodeFlowClient: Client, serverOrigin: (s: string) => s, localContextPath: () => undefined } : require(name), module: { exports: {} }, setInterval: () => 1, clearInterval() {} });
  vm.runInContext(source, box); const api = await box.module.exports.activate(context); await turn();
  await api.connect(origin, "token"); assert.match(view.message, /Recent 100 runs/);
  await commands.get("codeFlow.disconnect")!(); assert.match(view.message, /Disconnected/); assert.equal(api.runs().length, 0);
  await commands.get("codeFlow.start")!(); assert.deepEqual(prompts, []); assert.match(errors.at(-1)!, /Connect to Local Server first/);
  await api.connect(origin, "token"); offline = true; await commands.get("codeFlow.start")!(); assert.deepEqual(prompts, []); assert.match(errors.at(-1)!, /Server unavailable/);
  offline = false; failStart = true; await commands.get("codeFlow.start")!(); assert.deepEqual(prompts, ["Task for Code Flow"]); assert.ok(output.some(line => line.includes("Task not sent; retained here for retry:\nKeep my task")));
  let reached!: () => void, release!: () => void;
  const paused = new Promise<void>(resolve => reached = resolve), gate = new Promise<void>(resolve => release = resolve);
  beforeRealpath = async () => { reached(); await gate; }; failStart = false;
  const pending = commands.get("codeFlow.start")!(); await paused; await commands.get("codeFlow.disconnect")!(); release(); await pending;
  assert.equal(starts, 1, "disconnect during path resolution cannot submit with the retired token"); assert.match(errors.at(-1)!, /connection changed/);
  assert.ok(output.filter(line => line.includes("Task not sent; retained here for retry:")).length >= 2);
  beforeRealpath = undefined; await api.connect(origin, "replacement");
  const pausedProbe = new Promise<void>(resolve => reached = resolve), probeGate = new Promise<void>(resolve => release = resolve);
  beforeCompatibility = async () => { reached(); await probeGate; };
  const beforePrompts = prompts.length, probing = commands.get("codeFlow.start")!(); await pausedProbe; await commands.get("codeFlow.disconnect")!(); release(); await probing;
  assert.equal(prompts.length, beforePrompts); assert.equal(starts, 1);
  for (const item of context.subscriptions) item.dispose();
});

test("VS Code validates the active connection immediately before the real client POST", async () => {
const {CodeFlowClient}=require('../integrations/vscode/client.cjs');
const commands=new Map<string, () => Promise<any>>(), secrets=new Map<string, string>(), output: string[]=[]; let starts=0, loseResponse=false;
let reached!: () => void, release!: () => void;
const paused=new Promise<void>(r=>reached=r), gate=new Promise<void>(r=>release=r);
const transport=async (url: string, options: RequestInit)=>{
 const path=new URL(url).pathname;
 if(path==='/api/v1/check'){reached();await gate;return Response.json({command:'true'});}
 if(path==='/api/v1/capabilities')return Response.json({version:1});
 if(path==='/api/v1/runs'&&options.method==='POST'){starts++;if (loseResponse) throw new TypeError('response lost after acceptance');return Response.json({id:'sent-after-disconnect'});}
 return Response.json({runs:[]});
};
class Client extends CodeFlowClient{constructor(origin: string,token: string){super(origin,token,transport);}}
const origin='http://127.0.0.1:4467', view={message:'',visible:false,onDidChangeVisibility(){},dispose(){}};
const vscode={EventEmitter:class{event=()=>{};fire(){}dispose(){}},ExtensionMode:{Test:3},ConfigurationTarget:{Global:1},workspace:{isTrusted:true,workspaceFolders:[{name:'scratch',uri:{scheme:'file',fsPath:'/tmp'}}],getConfiguration:()=>({inspect:()=>({globalValue:origin}),update:async()=>{}})},window:{createOutputChannel:()=>({appendLine:(s: string)=>output.push(s),show(){},dispose(){}}),createTreeView:()=>view,showInputBox:async()=> 'QA task',showErrorMessage:async (s: string)=>output.push(s),showInformationMessage:(s: string)=>output.push(s)},commands:{registerCommand:(n: string,a: () => Promise<any>)=>{commands.set(n,a);return{dispose(){}};}}};
const context={subscriptions:[] as any[],extensionMode:3,secrets:{get:async (k: string)=>secrets.get(k),store:async(k: string,v: string)=>secrets.set(k,v),delete:async (k: string)=>secrets.delete(k)}};
const box=vm.createContext({require:(n: string)=>n==='vscode'?vscode:n==='node:fs/promises'?{realpath:async (x: string)=>x}:n==='./client.cjs'?{CodeFlowClient:Client,serverOrigin:(s: string)=>s,localContextPath:()=>undefined}:require(n),module:{exports:{}},setInterval:()=>1,clearInterval(){}});
vm.runInContext(source,box);
const api=await box.module.exports.activate(context);await new Promise(r=>setImmediate(r));await api.connect(origin,'qa-scratch-token');
const pending=commands.get('codeFlow.start')!();await paused;await commands.get('codeFlow.disconnect')!();release();await pending;
assert.equal(starts, 0); assert.equal(secrets.size, 0); assert.ok(output.some(line => line.includes('Task not sent; retained here for retry:')));
await api.connect(origin,'replacement'); loseResponse=true;
await commands.get('codeFlow.start')!(); assert.equal(starts,1); assert.ok(output.some(line => line.includes('Task submission outcome is unconfirmed. Check recent runs before retrying; retained task:')));
for (const item of context.subscriptions) item.dispose();

});
