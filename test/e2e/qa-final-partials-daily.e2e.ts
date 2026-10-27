import { tmpdir } from "node:os";
import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { reserveQaPorts } from "../qa-port-block.js";
import axe from "axe-core";
const ports = await reserveQaPorts(2), root = fileURLToPath(new URL("../..", import.meta.url));
const scratch = mkdtempSync(join(realpathSync(tmpdir()), "codeflow-final-daily-")), home = join(scratch,"data"), repo = join(scratch,"repo"), bin = join(scratch,"bin"), gh = join(scratch,"gh.json"), shots = join(root,"output/playwright/qa-final-partials-daily");
const token = "final-daily-fixture", base = `http://127.0.0.1:${ports.port}`, headers = { authorization: `Bearer ${token}`, "content-type":"application/json", origin:base };
let server:ChildProcess, browser:Browser, project:string; let logs=""; let preload:string|undefined;
const errors:string[]=[], expected:string[]=[];
const probeConsole:{page:Page,text:string}[]=[], probeResponses:{page:Page,url:string,method:string,body:any}[]=[], probeReads:Promise<void>[]=[];
async function drainProbeReads(){for(let seen=0;seen<probeReads.length;){const batch=probeReads.slice(seen);seen+=batch.length;await Promise.all(batch);}}
const pause = (ms:number) => new Promise(resolve=>setTimeout(resolve,ms));
const git = (cwd:string,...args:string[])=>execFileSync("git",["-c","user.name=QA","-c","user.email=qa@example.test","-c","commit.gpgsign=false",...args],{cwd,encoding:"utf8",stdio:"pipe"}).trim();
async function request(path:string,body?:unknown,method=body===undefined?"GET":"POST") { const r=await fetch(base+path,{headers,method,...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()}; }
async function api(path:string,body?:unknown,method?:string):Promise<any>{const r=await request(path,body,method);assert.ok(r.status<300,`${path}: ${r.status} ${JSON.stringify(r.body)}`);return r.body;}
async function until<T>(read:()=>Promise<T>,ok:(x:T)=>boolean,timeout=30000):Promise<T>{const end=Date.now()+timeout;for(;;){const x=await read();if(ok(x))return x;assert.ok(Date.now()<end,JSON.stringify(x));await pause(100);}}
async function start(){await ports.release();const inherited=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(CODEFLOW_|FAKE_)/.test(k)));server=spawn(process.execPath,["--import","tsx",...(preload?["--import",preload]:[]),"src/server.ts"],{cwd:root,env:{...inherited,HOME:join(scratch,"os-home"),SHELL:join(scratch,"bash"),BASH_ENV:"",ENV:"",CODEFLOW_HOME:home,CODEFLOW_TOKEN:token,PORT:String(ports.port),CODEFLOW_REMOTE_PORT:String(ports.port+1),PATH:`${bin}:${join(root,"test/fake-bin")}:${process.env.PATH}`,FAKE_GH_STATE:gh,FAKE_RECORD_DIR:join(scratch,"records"),FAKE_DOCKER_DOWN:"1",CODEFLOW_REMOTE_WORKERS_JSON:JSON.stringify({version:1,workers:[{id:"offline",name:"Offline fixture worker",sshHost:"qa-offline-fixture",command:"true",repoMappings:["fixture"]}]})},stdio:"pipe"});for(const s of [server.stdout,server.stderr])s?.on("data",d=>logs+=d);await until(()=>fetch(base+"/api/health",{headers}).then(r=>r.ok,()=>false),Boolean);}
async function stop(signal:"SIGTERM"|"SIGKILL"="SIGTERM"){if(!server||server.exitCode!==null||server.signalCode!==null)return;const done=new Promise<void>(r=>server.once("exit",()=>r()));server.kill(signal);await done;}
async function page(hash="#/",setup?:(p:Page)=>Promise<void>){const c=await browser.newContext({viewport:{width:1440,height:1000}}),p=await c.newPage();p.setDefaultTimeout(12000);p.on("pageerror",e=>errors.push(e.message));p.on("console",m=>{if(m.type()!=="error")return;const text=`${m.text()} [${m.location().url}]`;if(m.location().url===base+"/api/remote-workers/offline/probe"&&m.text()==="Failed to load resource: the server responded with a status of 400 (Bad Request)")probeConsole.push({page:p,text});else errors.push(text);});p.on("response",r=>{if(r.url()===base+"/api/remote-workers/offline/probe"&&r.status()===400)probeReads.push(r.json().catch(()=>undefined).then(body=>{probeResponses.push({page:p,url:r.url(),method:r.request().method(),body});}));});await p.addInitScript(({repo,project})=>{localStorage.setItem("repo",repo);localStorage.setItem("project",project);localStorage.setItem("sideOpen","0");},{repo,project});await setup?.(p);await p.goto(`${base}/?token=${token}${hash}`);return p;}
const shot=(p:Page,name:string)=>p.screenshot({path:join(shots,name+".png"),fullPage:true,animations:"disabled"});
async function details(p:Page){const d=p.locator("details.composer-options");if(await d.getAttribute("open")===null)await d.locator(":scope > summary").click();const advanced=p.locator("details.advanced-controls");if(await advanced.getAttribute("open")===null)await advanced.locator(":scope > summary").click();}
const runInput=(task:string,extra:object={})=>({project,repo,pattern:"solo",task,roles:{agent:["codex"]},trust:"standard",loop:{check:"true",prove:false,maxSteps:4,maxMinutes:1},...extra});
const finished=(id:string)=>until(()=>api(`/api/runs/${id}`),r=>r.status!=="running");
before(async()=>{for(const p of [repo,bin,home,shots,join(scratch,"os-home"),join(scratch,"records")])mkdirSync(p,{recursive:true});writeFileSync(join(scratch,"bash"),'#!/bin/sh\nexec /bin/bash --noprofile --norc\n',{mode:0o755});writeFileSync(join(bin,"ssh"),'#!/bin/sh\nprintf "QA fixture worker is offline\\n" >&2\nexit 255\n',{mode:0o755});
 git(repo,"init","-qb","main");writeFileSync(join(repo,"README.md"),"# Daily fixture\n");mkdirSync(join(repo,".codeflow"));writeFileSync(join(repo,".codeflow/config.json"),'{"prove":false}');git(repo,"add",".");git(repo,"commit","-qm","base");git(repo,"checkout","-qb","feature");writeFileSync(join(repo,"feature.txt"),"PR source\n");git(repo,"add",".");git(repo,"commit","-qm","feature");const sha=git(repo,"rev-parse","HEAD");git(repo,"checkout","-q","main");git(scratch,"clone","--bare","-q",repo,join(scratch,"origin.git"));git(join(scratch,"origin.git"),"update-ref","refs/pull/7/head",sha);git(repo,"remote","add","origin",join(scratch,"origin.git"));writeFileSync(gh,JSON.stringify({issues:[],prs:{7:{number:7,title:"Outside PR fixture",body:"Untrusted fixture",url:"https://github.com/fixture/repo/pull/7",headRefName:"feature",baseRefName:"main",author:{login:"outsider"},authorAssociation:"NONE",state:"OPEN",isCrossRepository:false,comments:[]}}}));
 execFileSync(process.execPath,["scripts/build-ui.mjs"],{cwd:root,env:{...process.env,CODEFLOW_HOME:join(scratch,"build-home")}});await start();project=(await api("/api/projects",{name:"Final daily fixture",repos:[repo]})).id;browser=await chromium.launch({channel:"chrome",headless:true});});
afterEach(async t=>{await drainProbeReads();for(const c of browser?.contexts()??[]){if((t as {error?:unknown}).error)for(const p of c.pages()){await shot(p,"failed-"+t.name.slice(0,30).replace(/[^a-z0-9]/gi,"-"));writeFileSync(join(shots,"failed-page.txt"),await p.locator("body").innerText());}await c.close();}});
after(async()=>{rmSync(join(scratch,"hold-history.json"),{force:true});writeFileSync(join(scratch,"reuse-release.json"),"{}");await browser?.close();await stop();await ports.release();writeFileSync(join(shots,"server.log"),logs);writeFileSync(join(shots,"browser.json"),JSON.stringify({errors,expected},null,2));writeFileSync(join(shots,"fixture.json"),JSON.stringify({base,project,scratch,source:git(root,"rev-parse","HEAD"),sourceChanges:git(root,"diff","--name-only"),method:"fake CLI + actual server + Chrome"}));if(!process.env.QA_KEEP_DAILY)rmSync(scratch,{recursive:true,force:true});});

test("CMP-02: all installed providers signed out blocks Send with setup guidance",async()=>{let dispatch=0;const p=await page("#/",async p=>{await p.route("**/api/doctor",async route=>{const response=await route.fetch();await route.fulfill({response,json:(await response.json()).map((item:any)=>["claude","codex","agy"].includes(item.id)?{...item,installed:true,signedIn:false}:item)});});p.on("request",r=>{if(r.method()==="POST"&&r.url()===base+"/api/runs")dispatch++;});});await p.getByRole("textbox",{name:"Task",exact:true}).fill("All providers are signed out");await p.locator(".composer-problem").getByText(/sign|provider/i).waitFor();assert.equal(await p.getByRole("button",{name:"Send",exact:true}).isDisabled(),true);await p.getByRole("button",{name:/^Provider:/}).click();for(const name of ["Claude Code","Codex"])assert.equal(await p.getByRole("menuitem",{name:new RegExp(name+".*Signed out")}).isDisabled(),true);assert.equal(dispatch,0);await shot(p,"all-signed-out");});

test("CMP-11: directory drops give guidance while file drops stay scoped to the task",async()=>{const p=await page();await p.getByRole("textbox",{name:"Task",exact:true}).waitFor();await p.locator(".taskbox").evaluate(node=>{const transfer=new DataTransfer();transfer.items.add(new File([""],"drop-folder"));Object.defineProperty(DataTransferItem.prototype,"webkitGetAsEntry",{configurable:true,value:new Function("return this.getAsFile()?.name === 'drop-folder' ? {isDirectory:true} : null")});node.dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer:transfer}));});await p.getByText("drop-folder is a folder. From outside the repo, add individual files.",{exact:true}).waitFor();assert.equal(await p.getByRole("button",{name:/Remove drop-folder/}).count(),0);await p.locator("body").evaluate(node=>{const t=new DataTransfer();t.items.add(new File(["outside"],"outside.txt"));node.dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer:t}));});assert.equal(await p.getByRole("button",{name:/Remove outside.txt/}).count(),0);await p.locator(".taskbox").evaluate(node=>{const t=new DataTransfer();t.items.add(new File(["inside"],"inside.txt"));node.dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer:t}));});await p.getByRole("button",{name:"Remove inside.txt",exact:true}).waitFor();await p.reload();await p.getByRole("button",{name:"Remove inside.txt",exact:true}).waitFor();await shot(p,"directory-and-scoped-file-drop");});

test("CMP-17: registered offline worker blocks dispatch and local recovery clears its reason",async()=>{const p=await page();await p.getByRole("textbox",{name:"Task",exact:true}).fill("Offline worker fixture");await details(p);await p.getByLabel("Agent execution",{exact:true}).selectOption("offline");await p.locator(".composer-problem").getByText(/offline|SSH|worker/i).waitFor();assert.equal(await p.getByRole("button",{name:"Send",exact:true}).isDisabled(),true);await shot(p,"offline-worker");await p.getByLabel("Agent execution",{exact:true}).selectOption("");await until(()=>p.getByRole("button",{name:"Send",exact:true}).isEnabled(),Boolean);});

test("SOL-05 / RUN-14 / RUN-15: source PR details and reply permissions remain locked after reload",async()=>{const made=await api("/api/runs",runInput("Inspect outside PR",{roles:{agent:["claude"]},source:{kind:"pr",number:7},allowUntrusted:true,context:{paths:[{path:"README.md",type:"file"}]}}));const run=await finished(made.id);assert.equal(run.status,"done",run.error);assert.ok(run.lockdown);const p=await page(`#/run/${run.id}`);await p.getByText("Locked down.",{exact:true}).waitFor();await p.reload();await p.getByText("Locked down.",{exact:true}).waitFor();const reply=p.locator(".followup");const permission=p.locator(".chat-permissions > button").last();await permission.click();for(const name of ["Approve for me","Trusted","Full access"])assert.equal(await p.getByRole("menuitem",{name:new RegExp("^"+name)}).isDisabled(),true);await p.getByText("This run's permission restrictions stay in effect.",{exact:true}).waitFor();await shot(p,"locked-pr-reply");await p.keyboard.press("Escape");assert.ok(run.context.paths.some((x:any)=>x.path==="README.md"));assert.equal(run.trust,"safe");const review=await api("/api/runs",runInput("Review PR metadata",{pattern:"fix-review",roles:{builder:["claude"],reviewer:["codex"]},source:{kind:"pr",number:7},allowUntrusted:true}));await finished(review.id);await p.goto(base+`/#/run/${review.id}`);await p.locator("details.result-details > summary").click();await p.getByRole("link",{name:"PR #7",exact:true}).waitFor();await shot(p,"source-pr-details");});

test("SOL-05 / RUN-15: a locked reply accepts supported model settings and Edit again retains its context", async () => {
  const made=await api("/api/runs",runInput("Locked conversation settings",{roles:{agent:["claude"]},source:{kind:"pr",number:7},allowUntrusted:true,context:{paths:[{path:"README.md",type:"file"}]}}));
  await finished(made.id); const p=await page(`#/run/${made.id}`),main=p.getByRole("main");
  const catalog=(await api("/api/models")).claude,model=catalog.models.find((m:any)=>m.id==="haiku"||m.aliases?.includes("haiku"));assert.ok(model);
  await main.getByRole("button",{name:/^Model:/}).click(); await main.getByRole("option",{name:model.label,exact:true}).click();
  await main.getByRole("button",{name:/^Effort:/}).click(); await main.getByRole("menuitem",{name:"low",exact:true}).click();
  await main.getByRole("textbox",{name:"Message agent",exact:true}).fill("Inspect README with these supported settings");
  await main.getByRole("button",{name:"Send",exact:true}).click();
  const run=await until(()=>api(`/api/runs/${made.id}`),r=>r.followUps.length>0&&r.status!=="running");
  assert.deepEqual(run.followUps.at(-1).settings,{model:model.id,effort:"low"});
  assert.equal(run.followUps.at(-1).trust,"safe"); assert.equal(run.steps.at(-1).permissions.trust,"safe");
  await p.reload(); await p.getByText("Locked down.",{exact:true}).waitFor(); await shot(p,"locked-model-effort-receipt");
  // Edit & run again belongs to completed workflows; an Agent chat continues
  // through its reply composer instead of exposing that workflow action.
  const workflow=await api("/api/runs",runInput("Locked workflow context",{pattern:"fix-review",roles:{builder:["claude"],reviewer:["codex"]},source:{kind:"pr",number:7},allowUntrusted:true,context:{paths:[{path:"README.md",type:"file"}]}}));
  await finished(workflow.id); await p.goto(base+`/#/run/${workflow.id}`);
  await p.getByRole("button",{name:"More run actions",exact:true}).click(); await p.getByRole("menuitem",{name:"Edit & run again",exact:true}).click();
  await p.getByRole("button",{name:"Remove README.md",exact:true}).waitFor();
  assert.match(await p.getByRole("button",{name:/^Permissions:/}).innerText(),/Safe/);
  await shot(p,"locked-rerun-context");
});

test("CMP-17: an empty team provider pool cannot be applied", async () => {
  const p=await page(); await p.getByRole("switch",{name:"AI team",exact:true}).click(); await p.getByRole("button",{name:"Advanced",exact:true}).click();
  const dialog=p.getByRole("dialog",{name:"AI team setup",exact:true}),checks=dialog.getByRole("group",{name:"Team providers",exact:true}).getByRole("checkbox");
  for(const checkbox of await checks.all())if(await checkbox.isChecked())await checkbox.uncheck();
  assert.equal(await dialog.getByRole("button",{name:"Apply team settings",exact:true}).isDisabled(),true);
  await dialog.getByRole("checkbox",{name:"Use Codex",exact:true}).check();
  assert.equal(await dialog.getByRole("button",{name:"Apply team settings",exact:true}).isEnabled(),true);
  await shot(p,"empty-pool-blocked-compatible-selection-recovers"); await dialog.getByRole("button",{name:"Cancel",exact:true}).click();
});

test("RUN-11: saved activity beyond 300 lines expands and reloads without losing endpoints",async()=>{const made=await api("/api/runs",runInput("Long daily activity",{pattern:"loop",roles:{workers:["codex"]}})),run=await finished(made.id);await stop();const file=join(home,"runs",`${run.id}.jsonl`);const events=readFileSync(file,"utf8").trim().split("\n").map(x=>JSON.parse(x));let seq=Math.max(...events.map(e=>e.seq));for(let i=0;i<305;i++)appendFileSync(file,JSON.stringify({seq:++seq,ts:Date.now(),runId:run.id,type:"log",level:"info",text:`Daily activity ${String(i).padStart(3,"0")}`})+"\n");await start();const p=await page(`#/run/${run.id}`);await p.locator("details.result-details > summary").click();const activity=p.locator("details.activity");await activity.locator("summary").click();assert.equal(await activity.getByText(/Daily activity 000/).count(),0);await activity.getByRole("button",{name:/Show all .* lines/}).click();await activity.getByText(/Daily activity 000/).waitFor();await activity.getByText(/Daily activity 304/).waitFor();await shot(p,"all-activity-lines");await p.reload();await p.locator("details.result-details > summary").click();await activity.locator("summary").click();await activity.getByRole("button",{name:/Show all .* lines/}).click();await activity.getByText(/Daily activity 000/).waitFor();});

test("SHL-20: pending root, fork and side requests win within their loaded family; otherwise restore last viewed", async () => {
  const made = await api("/api/runs", runInput("Waiting chat navigation"));
  await finished(made.id);
  const fork = await api(`/api/runs/${made.id}/provider-chat`, {agent:"codex",kind:"tab",message:"ASK-QUESTION choose the badge"});
  const pending = (id:string) => until(()=>api(`/api/approvals?run=${id}`), rows=>rows.some((r:any)=>r.status==="pending"));
  await pending(fork.id);
  const p = await page(`#/run/${made.id}`);
  const openTask = async () => { await p.goto(base+"/#/inbox"); await p.locator(`button.run-item[data-task="${made.id}"]`).click(); };
  await openTask();
  await until(async()=>p.url(), url=>url.endsWith(`/run/${fork.id}`));
  await shot(p,"waiting-fork-wins");
  await api(`/api/runs/${fork.id}/cancel`,{}); await finished(fork.id);
  const side = await api(`/api/runs/${made.id}/provider-chat`, {agent:"codex",kind:"side",message:"ASK-QUESTION choose the side badge"});
  await pending(side.id); await openTask();
  const panel = p.getByRole("complementary",{name:"Side panel",exact:true});
  await panel.waitFor();
  await panel.getByText("ASK-QUESTION choose the side badge",{exact:true}).first().waitFor();
  await p.getByText("Which color should the badge use?",{exact:true}).waitFor();
  await shot(p,"waiting-side-opens-panel");
  await api(`/api/runs/${side.id}/cancel`,{}); await finished(side.id);
  await p.goto(base+`/#/run/${fork.id}`); await p.locator(".run-head").waitFor();
  await api(`/api/runs/${made.id}/followups`,{kind:"reply",worktree:"solo",agent:"codex",message:"ASK-QUESTION choose the root badge"});
  await pending(made.id); await openTask();
  await until(async()=>p.url(), url=>url.endsWith(`/run/${made.id}`));
  await shot(p,"waiting-root-wins");
  await api(`/api/runs/${made.id}/cancel`,{}); await finished(made.id);
  const unrelated = await api("/api/runs",runInput("ASK-QUESTION unrelated task"));
  await pending(unrelated.id);
  await p.goto(base+`/#/run/${fork.id}`); await p.locator(".run-head").waitFor();
  await openTask();
  await until(async()=>p.url(), url=>url.endsWith(`/run/${fork.id}`));
  await shot(p,"last-viewed-fallback-unrelated-wait-ignored");
  await api(`/api/runs/${unrelated.id}/cancel`,{}); await finished(unrelated.id);
});

test("RUN--GAP-05: actual webhook HTML and unsafe links stay inert in history and run text", async () => {
  const payload = '<script>window.dailyInjected=1</script><img src=x onerror="window.dailyInjected=2"> [bad](javascript:alert(1)) [data](data:text/html,x) [safe](https://example.test/receipt)';
  const a = await api("/api/automations", {name:"Hostile daily webhook",enabled:true,webhook:true,isolate:false,run:runInput("Inspect webhook details",{roles:{agent:["claude"]}})});
  const response = await fetch(base+a.hookPath,{method:"POST",headers:{authorization:`Bearer ${a.token}`,"content-type":"application/json"},body:JSON.stringify({details:payload})});
  assert.equal(response.status,202);
  const events = await until(()=>api(`/api/automations/${a.id}/events`),rows=>rows.some((e:any)=>e.state==="started"));
  const id = events.find((e:any)=>e.state==="started").runIds[0]; await finished(id);
  const p = await page("#/settings/automations"); let dialogs=0; p.on("dialog",async dialog=>{dialogs++;await dialog.dismiss();});
  const row = p.locator(".auto-row").filter({hasText:a.name}); await row.getByRole("button",{name:"Preview and events",exact:true}).click();
  const history = p.getByRole("region",{name:`Preview and events for ${a.name}`,exact:true});
  await history.getByText(/<script>window.dailyInjected=1/).waitFor(); await shot(p,"hostile-webhook-history");
  await history.getByRole("link",{name:`Open run ${id}`,exact:true}).click();
  const task=p.getByRole("region",{name:"Your task",exact:true}); await task.getByText(/<script>window.dailyInjected=1/).waitFor();
  assert.equal(await p.locator('a[href^="javascript:"], a[href^="data:"]').count(),0);
  assert.equal(await p.evaluate(()=>"dailyInjected" in window),false); assert.equal(dialogs,0);
  await shot(p,"hostile-webhook-run");
});

test("daily scheduling: save and cancel through the composer, then one deferred launch survives restart", async () => {
  const p=await page(); await p.getByRole("textbox",{name:"Task",exact:true}).fill("Daily deferred fixture");
  await p.locator("#main-content").getByRole("button",{name:"Run actions",exact:true}).click(); await p.getByRole("menuitem",{name:"Schedule…",exact:true}).click();
  await p.getByRole("button",{name:/Run once later/}).click();
  const dialog=p.getByRole("dialog",{name:"Start later",exact:true});
  await dialog.getByText("Queue this run configuration",{exact:true}).click();
  await dialog.getByLabel("Deferred run label",{exact:true}).fill("Daily saved for later");
  await dialog.getByLabel("Deferred start condition",{exact:true}).selectOption("at");
  await dialog.getByRole("button",{name:"Save deferred run",exact:true}).click();
  const card=dialog.getByRole("article",{name:"Deferred run Daily saved for later",exact:true});
  await card.getByText("Waiting for start time",{exact:true}).waitFor(); await shot(p,"deferred-composer-waiting");
  await card.getByRole("button",{name:"Cancel deferred run",exact:true}).click(); await card.getByText("Cancelled",{exact:true}).waitFor();
  const job=await api("/api/deferred-runs",{name:"Daily restart launch",run:runInput("Start once after restart",{loop:{check:"true",maxSteps:4,maxMinutes:1}}),notBefore:Date.now()+1500});
  await p.context().close(); await stop(); await pause(1550); await start();
  const started=await until(()=>api("/api/deferred-runs"),rows=>rows.some((j:any)=>j.id===job.id&&j.status==="started"));
  const launched=started.find((j:any)=>j.id===job.id),run=await finished(launched.runId);
  assert.equal(run.status,"done",run.error); assert.equal(run.trust,"safe"); assert.equal(run.deferred.attempt,1);
  assert.equal((await api("/api/runs")).filter((r:any)=>r.deferred?.jobId===job.id).length,1);
  const result=await page(`#/run/${run.id}`); await result.locator(".run-head").waitFor(); await shot(result,"deferred-after-restart");
});

test("RUN--GAP-02: an owned hard crash interrupts its tracked check and retains the worktree", async () => {
  const marker=join(scratch,"check.pid"), script=join(scratch,"held-check.cjs");
  writeFileSync(script,`require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid)); setTimeout(()=>{},60000);\n`);
  const made=await api("/api/runs",runInput("Crash during tracked check",{pattern:"loop",roles:{workers:["codex"]},loop:{check:`node ${script}`,prove:false,maxSteps:4,maxMinutes:2}}));
  await until(async()=>existsSync(marker),Boolean); const pid=Number(readFileSync(marker,"utf8"));
  const before=await api(`/api/runs/${made.id}`); assert.ok(before.worktrees.length); process.kill(pid,0);
  const p=await page(`#/run/${made.id}`); await p.locator(".run-head").waitFor(); await shot(p,"owned-check-before-crash"); await p.context().close();
  await stop("SIGKILL"); await start();
  const run=await until(()=>api(`/api/runs/${made.id}`),r=>r.status!=="running");
  assert.equal(run.status,"interrupted"); for(const tree of before.worktrees)assert.ok(existsSync(tree.path));
  await until(async()=>{try{process.kill(pid,0);return false;}catch{return true;}},Boolean);
  const recovered=await page(`#/run/${made.id}`); await recovered.getByRole("button",{name:/Resume/}).first().waitFor(); await shot(recovered,"owned-check-recovered");
  writeFileSync(join(shots,"hard-crash-receipt.json"),JSON.stringify({before,after:run,ownedCheckPid:pid},null,2));
});

test("RUN--GAP-03: actual Team checks invalidate reuse for repository and settings changes", async () => {
  const gate=join(scratch,"reuse-gate.json"),release=join(scratch,"reuse-release.json");
  preload=join(scratch,"hold-check.mjs");
  writeFileSync(preload,`import {TeamContext} from ${JSON.stringify(join(root,"src/engine.ts"))}; import {existsSync,readFileSync,writeFileSync} from 'node:fs';
const original=TeamContext.prototype.check,seen=new Set(); TeamContext.prototype.check=async function(...args){const result=await original.apply(this,args);if(this.run.task.startsWith('DAILY-REUSE:')&&String(args[1]).startsWith('Check after ')&&!seen.has(this.run.id)){seen.add(this.run.id);writeFileSync(${JSON.stringify(gate)},JSON.stringify({id:this.run.id,path:args[0].path,checks:this.run.usage.checks}));const deadline=Date.now()+30000;while(!existsSync(${JSON.stringify(release)})&&!this.signal.aborted&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));const patch=existsSync(${JSON.stringify(release)})?JSON.parse(readFileSync(${JSON.stringify(release)},'utf8')):{};if(patch.check)this.run.loop.check=patch.check;if(patch.verification)this.run.loop.verification=patch.verification;}return result;};\n`);
  await stop(); await start(); const results:any[]=[];
  for(const mode of ["none","commit","dirty","staged","untracked","hidden","command","profile","failed"]){
    rmSync(gate,{force:true});rmSync(release,{force:true});
    const counter=join(scratch,`reuse-${mode}.count`),script=join(scratch,`reuse-${mode}.cjs`);
    writeFileSync(script,`const fs=require('fs'),p=${JSON.stringify(counter)},n=fs.existsSync(p)?Number(fs.readFileSync(p)):0;fs.writeFileSync(p,String(n+1));process.exit(${mode==="failed"?"n===0?1:0":"0"});\n`);
    const command=`node ${script}`;
    const made=await api("/api/runs",runInput(`DAILY-REUSE:${mode}`,{pattern:"auto-team",roles:{coordinator:["claude"],pool:["claude"]},approvals:{plan:false,tools:false},options:{maxMembers:3,maxInvocations:8},loop:{check:command,prove:false,maxSteps:8,maxMinutes:2}}));
    const waiting=await until(()=>api(`/api/runs/${made.id}`),run=>existsSync(gate)||run.status!=="running"||!!run.awaiting);
    assert.ok(existsSync(gate),JSON.stringify(waiting)); const held=JSON.parse(readFileSync(gate,"utf8"));assert.equal(held.id,made.id);
    const p=await page(`#/run/${made.id}`);await p.locator(".run-head").waitFor();
    if(["dirty","staged","commit"].includes(mode))writeFileSync(join(held.path,"README.md"),`External edit after completed ${mode} check\n`);
    if(mode==="staged"||mode==="commit")git(held.path,"add","README.md");
    if(mode==="commit")git(held.path,"commit","-qm","External verified-input change");
    if(mode==="untracked")writeFileSync(join(held.path,"fresh-input.txt"),"New input after check\n");
    if(mode==="hidden")git(held.path,"update-index","--assume-unchanged","README.md");
    // A running task has no settings editor. These two cases inject the saved
    // setting change at the same boundary, while real command execution and UI
    // receipts still use the production runtime.
    writeFileSync(release,JSON.stringify(mode==="command"?{check:command+" changed"}:mode==="profile"?{verification:{name:"Changed profile",checks:[{id:"extra",kind:"custom",command,required:true,timeoutMs:10000}]}}:{}));
    const run=await finished(made.id),count=Number(readFileSync(counter,"utf8"));
    assert.ok(count>=(mode==="none"?1:2),`${mode}: ${count}, ${run.error}`);if(mode==="none")assert.equal(count,1);
    const checks=run.steps.filter((step:any)=>step.kind==="check");if(mode==="failed")assert.equal(checks[0].status,"failed");
    await p.reload();await p.locator(".run-head").waitFor();await shot(p,`check-reuse-${mode}`);
    results.push({mode,runId:run.id,status:run.status,commandExecutions:count,usageChecks:run.usage.checks,checks:checks.map((step:any)=>({title:step.title,status:step.status,command:step.command})),method:mode==="command"||mode==="profile"?"saved settings injected at held boundary":"actual scratch Git/file mutation at held boundary"});
    await p.context().close();
  }
  writeFileSync(join(shots,"check-reuse-matrix.json"),JSON.stringify(results,null,2));
});

test("UX-15: real run-page replay overflow reports 503 and reload restores a deduplicated snapshot", async () => {
  const hold=join(scratch,"hold-history.json"), held=join(scratch,"history-held");
  preload=join(scratch,"hold-history.mjs");
  writeFileSync(preload,`import fs from 'node:fs/promises'; import {existsSync,readFileSync,writeFileSync} from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const open=fs.open; fs.open=async function(path,...args){ if(existsSync(${JSON.stringify(hold)}) && String(path)===JSON.parse(readFileSync(${JSON.stringify(hold)},'utf8')).file && typeof args[0]==='number' && (args[0]&3)===0){ writeFileSync(${JSON.stringify(held)},'held'); while(existsSync(${JSON.stringify(hold)})) await new Promise(r=>setTimeout(r,25)); } return open.call(this,path,...args); }; syncBuiltinESMExports();\n`);
  await stop(); await start();
  const made=await api("/api/runs",runInput("Replay buffer fixture",{pattern:"loop",roles:{workers:["codex"]},loop:{check:"sleep 60",prove:false,maxSteps:4,maxMinutes:2}}));
  await until(()=>api(`/api/runs/${made.id}`),r=>r.steps.some((s:any)=>s.kind==="check"&&s.status==="running"));
  writeFileSync(hold,JSON.stringify({file:join(home,"runs",`${made.id}.jsonl`)}));
  const frames:any[]=[];
  const p=await page(`#/run/${made.id}`,async p=>{const cdp=await p.context().newCDPSession(p);await cdp.send("Network.enable");cdp.on("Network.eventSourceMessageReceived",e=>{try{frames.push(JSON.parse(e.data));}catch{}});});
  await until(async()=>existsSync(held),Boolean);
  for(let i=0;i<24;i++)await api(`/api/runs/${made.id}/notes`,{text:`overflow-note-${String(i).padStart(2,"0")} ${"x".repeat(19000)}`});
  rmSync(hold); await p.getByText("Couldn't load this run: Run updates exceeded the replay buffer; reconnect to catch up",{exact:true}).waitFor();
  assert.ok(frames.some(f=>f.d?.type==="error"&&f.d.status===503&&/replay buffer/.test(f.d.message)));
  await shot(p,"run-page-replay-overflow");
  await p.reload(); await p.locator(".run-head").waitFor();
  const snapshot=await until<any>(async()=>frames.filter(f=>f.d?.type==="hello"&&f.d.snapshot?.run.id===made.id).at(-1),Boolean);
  const seqs=snapshot.d.transcript.events.map((event:any)=>event.seq); assert.equal(new Set(seqs).size,seqs.length);
  assert.equal(snapshot.d.snapshot.run.notes.length,24);
  await shot(p,"run-page-overflow-recovered"); writeFileSync(join(shots,"overflow-frames.json"),JSON.stringify(frames.filter(f=>f.d?.type==="error"||f.d?.snapshot).map(f=>({type:f.d.type,status:f.d.status,message:f.d.message,notes:f.d.snapshot?.run.notes.length,events:f.d.transcript?.events.length})),null,2));
  await api(`/api/runs/${made.id}/cancel`,{}); await finished(made.id);
});

test("SCH-45: older history is silent and its fresh finish sends exactly one correctly targeted notification", async () => {
  const made=await api("/api/runs",runInput("Old daily notification target")); const target=await finished(made.id);
  await stop();
  for(let i=0;i<110;i++){
    const id=`daily-history-${String(i).padStart(3,"0")}`,createdAt=Date.now()+1000+i;
    const run={...target,id,task:`Historical daily run ${i}`,createdAt,endedAt:createdAt+1,seen:true,worktrees:[],steps:[],followUps:[],notes:[],artifacts:[],branchPrefix:`codeflow/${id}`,worktreeDir:join(scratch,"unused",id)};
    writeFileSync(join(home,"runs",`${id}.jsonl`),JSON.stringify({seq:1,ts:createdAt,runId:id,type:"run",run})+"\n");
  }
  await start();
  const p=await page("#/inbox",async p=>{await p.addInitScript(()=>{
    const w=window as any; w.dailyNotifications=[];
    w.Notification=class {static permission="granted";static async requestPermission(){return "granted";}onclick?:()=>void;constructor(public title:string,public options:any){w.dailyNotifications.push(this);}close(){}};
    localStorage.setItem("notify","1");
  });});
  await p.getByRole("button",{name:"Load older runs",exact:true}).click();
  await p.locator(`button.run-item[data-task="${target.id}"]`).waitFor();
  assert.equal(await p.evaluate(()=>(window as any).dailyNotifications.length),0);
  await api(`/api/runs/${target.id}/followups`,{kind:"reply",worktree:"solo",agent:"codex",message:"One fresh follow-up on the older run"});
  await finished(target.id); await until(()=>p.evaluate(()=>(window as any).dailyNotifications.length),n=>n===1);
  assert.equal(await p.evaluate(()=>(window as any).dailyNotifications[0].options.tag),target.id);
  await p.evaluate(()=>(window as any).dailyNotifications[0].onclick());
  await until(async()=>p.url(),url=>url.endsWith(`/run/${target.id}`)); await p.locator(".run-head").waitFor(); await shot(p,"older-run-notification-target");
  assert.equal(await p.evaluate(()=>(window as any).dailyNotifications.length),1);
});

test("archived rail count preserves the visible button name for assistive technology", async () => {
  const made=await api("/api/runs",runInput("Archive label fixture")); await finished(made.id);
  await api(`/api/runs/${made.id}/archive`,{cleanup:false});
  const p=await page(); const toggle=p.getByRole("button",{name:/^Show archived runs(?: \d+)?$/}); await toggle.waitFor();
  await p.addScriptTag({content:axe.source});
  for(const name of ["Show archived runs","Hide archived runs"]){
    const button=p.getByRole("button",{name:new RegExp("^"+name+"(?: \\d+)?$")}); await button.waitFor();
    assert.match(await button.innerText(),/archived runs\s+1/);
    const result=await p.evaluate(async()=>await (window as any).axe.run(".rail-archive-toggle",{runOnly:{type:"rule",values:["label-content-name-mismatch"]}}));
    assert.deepEqual(result.violations,[]); await button.click();
  }
  await shot(p,"archive-toggle-accessible-name");
});

test("daily browser replays have no unclassified console failures",async()=>{await drainProbeReads();const records=[...probeResponses];for(const response of records){assert.equal(response.method,"POST");assert.match(String(response.body?.error),/QA fixture worker is offline/);}for(const event of probeConsole){const index=records.findIndex(record=>record.page===event.page);assert.ok(index>=0,event.text);records.splice(index,1);expected.push(event.text);}assert.deepEqual(errors,[]);});
