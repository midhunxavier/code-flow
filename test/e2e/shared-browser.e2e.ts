import {test,before,after,afterEach} from "node:test";
import assert from "node:assert/strict";
import {createServer,type Server} from "node:http";
import {spawn,execFileSync,type ChildProcess} from "node:child_process";
import {mkdtempSync,mkdirSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {chromium,type Browser,type Page} from "playwright-core";
const root=fileURLToPath(new URL("../..",import.meta.url));
const home=mkdtempSync(join(tmpdir(),"cf-shared-browser-")),repo=join(home,"repo");
const live=process.env.CODEFLOW_TEST_LIVE_AGENTS === "1", token="shared-browser-fixture";
let server:ChildProcess,fixture:Server,browser:Browser,page:Page,base:string,site:string,run:any;
const submissions:Array<{value:string;cookie:string}>=[];
const headers={authorization:`Bearer ${token}`,"content-type":"application/json"};
async function api(path:string,body?:unknown) { const response=await fetch(`${base}${path}`,{method:body===undefined?"GET":"POST",headers,...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value as any; }
async function until(check:()=>Promise<boolean>,ms=30000) {const deadline=Date.now()+ms;while(Date.now()<deadline){if(await check())return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error("Shared browser check timed out");}
async function done(id:string) {let result:any;await until(async()=>{result=await api(`/api/runs/${id}`);return result.status!=="running";},live?240000:30000);assert.equal(result.status,"done",result.error);return result;}
before(async()=>{
  console.log("Evidence:",home);
  fixture=createServer((req,res)=>{
    const url=new URL(req.url!,"http://fixture");
    if(url.pathname==="/submit"){submissions.push({value:url.searchParams.get("value")!,cookie:req.headers.cookie??""});res.end("ok");return;}
    res.writeHead(200,{"content-type":"text/html","x-frame-options":"DENY","content-security-policy":"frame-ancestors 'none'","set-cookie":"proofSession=shared-cobalt-731; HttpOnly; Path=/"});
    res.end(`<!doctype html><title>Shared browser fixture${url.pathname==="/other"?" second":""}</title><style>body{font:16px system-ui;margin:20px;min-height:1800px}h1{font-size:20px;margin:0}label{position:absolute;top:58px;left:20px}input{width:190px;height:28px}button{position:absolute;left:20px;top:115px;height:34px;width:120px}output{display:block;position:absolute;top:165px;left:20px}a{position:absolute;top:220px;left:20px}</style><h1>Session shared-cobalt-731</h1><label>Name <input aria-label="Name"></label><button onclick="const value=document.querySelector('input').value;fetch('/submit?value='+encodeURIComponent(value)).then(()=>document.querySelector('output').textContent='Submitted '+value)">Submit</button><output>Waiting</output><a href="/other">Second page</a><button style="top:320px" onclick="window.open('/other','_blank')">Open popup</button><button style="top:370px" onclick="document.querySelector('output').textContent=prompt('Browser prompt','Default')">Prompt</button><p style="position:absolute;top:270px" id="clock"></p><script>setInterval(()=>document.getElementById('clock').textContent='Live '+new Date().toISOString(),350)</script>`);
  });
  await new Promise<void>(resolve=>fixture.listen(0,"127.0.0.1",resolve));site=`http://127.0.0.1:${(fixture.address() as any).port}/`;
  const probe=createServer();await new Promise<void>(resolve=>probe.listen(0,"127.0.0.1",resolve));base=`http://127.0.0.1:${(probe.address() as any).port}`;await new Promise<void>(resolve=>probe.close(()=>resolve()));
  mkdirSync(repo);execFileSync("git",["init","-q","-b","main"],{cwd:repo});writeFileSync(join(repo,"README.md"),"Shared browser test\n");execFileSync("git",["add","."],{cwd:repo});execFileSync("git",["-c","user.name=Test","-c","user.email=t@t","commit","-qm","fixture"],{cwd:repo});
  execFileSync(process.execPath,["scripts/build-ui.mjs"],{cwd:root});
  server=spawn(process.execPath,["--import","tsx","src/server.ts"],{cwd:root,env:{...process.env,PORT:new URL(base).port,CODEFLOW_HOME:join(home,"state"),CODEFLOW_TOKEN:token,...(live?{}:{PATH:`${root}/test/fake-bin:${process.env.PATH}`})},stdio:"ignore"});
  await until(()=>fetch(`${base}/api/health`,{headers}).then(r=>r.ok,()=>false));
  run=await api("/api/runs",{repo,pattern:"solo",roles:{agent:["claude"]},options:{},trust:"standard",...(live?{agentSettings:{claude:{model:"haiku"},codex:{model:"gpt-6-luna",effort:"medium"},agy:{model:"gemini-3.8-flash-low"}}}:{}),task:"Reply Ready. Do not use tools."});await done(run.id);
  browser=await chromium.launch({channel:"chrome",headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(20000);
  await page.goto(`${base}/?token=${token}#/run/${run.id}`);
});
afterEach(async context=>{if((context as unknown as {error?:unknown}).error && page){console.error("Browser failure",await page.locator("#side-pane-browser").innerText());console.error("Browser state",await api(`/api/browser?scope=run:${run.id}`,{action:"state"}),await page.locator(".live-browser-surface canvas").evaluate((canvas:HTMLCanvasElement)=>({width:canvas.width,height:canvas.height,box:canvas.getBoundingClientRect().toJSON(),...canvas.dataset})));mkdirSync(join(root,"output/playwright"),{recursive:true});await page.screenshot({path:join(root,"output/playwright/shared-browser-failure.png")});}});
after(async()=>{await browser?.close();server?.kill("SIGTERM");if(server?.exitCode===null)await new Promise<void>(resolve=>{server.once("exit",()=>resolve());setTimeout(resolve,5000).unref();});fixture?.closeAllConnections();await new Promise<void>(resolve=>fixture?.close(()=>resolve()));});
test("live in-app Chrome accepts input on frame-blocked pages and is shared across providers",{timeout:live?1200000:60000},async()=>{
  const toggle=page.getByRole("button",{name:"Side panel",exact:true});if(await toggle.getAttribute("aria-pressed")!=="true")await toggle.click();
  const panel=page.getByRole("complementary",{name:"Side panel",exact:true});await panel.getByRole("tab",{name:"Browser",exact:true}).click();
  await panel.getByLabel("Address",{exact:true}).fill(site);await panel.getByRole("button",{name:"Go",exact:true}).click();
  await panel.getByRole("button",{name:"Shared browser fixture",exact:true}).waitFor().catch(async error=>{console.error("Browser state",await panel.innerText(),await api(`/api/browser?scope=run:${run.id}`,{action:"state"}));throw error;});
  const surface=panel.getByRole("img",{name:"Live browser page",exact:true});
  const endpoint=`/api/browser?scope=run:${run.id}`;
  const ready=async(expectedTab?:string)=>{
    let version="",firstFrame=0;
    await until(async()=>{
      const state=await api(endpoint,{action:"state"});
      const drawn=await surface.evaluate((canvas:HTMLCanvasElement)=>({width:canvas.width,height:canvas.height,boxWidth:canvas.getBoundingClientRect().width,boxHeight:canvas.getBoundingClientRect().height,ready:canvas.dataset.ready,tab:canvas.dataset.tab,view:canvas.dataset.view,frames:canvas.dataset.frames}));
      if(drawn.ready!=="true"||drawn.tab!==state.selected||(expectedTab&&drawn.tab!==expectedTab)||Number(drawn.view)!==state.view||Math.abs(drawn.width-drawn.boxWidth)>=2||Math.abs(drawn.height-Math.max(200,drawn.boxHeight))>=2){version="";return false;}
      const current=`${drawn.tab}:${drawn.view}:${drawn.width}:${drawn.height}`;
      if(current!==version){version=current;firstFrame=Number(drawn.frames);return false;}
      // Tab selection arrives over SSE, and panel layout queues a debounced resize.
      // Wait for fresh frames of the current server view before sending coordinates.
      return Number(drawn.frames)>firstFrame+1;
    });
  };
  await ready();
  assert.equal(await panel.locator("iframe").count(),0);assert.equal(await panel.getByText("Snapshot",{exact:true}).count(),0);assert.equal(page.context().pages().length,1);
  const frameCount=await surface.getAttribute("data-frames");await until(async()=>Number(await surface.getAttribute("data-frames"))>Number(frameCount)+2);
  const click=async(x:number,y:number)=>{const point=await surface.evaluate((element,point)=>{const canvas=element as HTMLCanvasElement,box=canvas.getBoundingClientRect(),scale=Math.min(box.width/canvas.width,box.height/canvas.height);return {x:(box.width-canvas.width*scale)/2+point.x*scale,y:(box.height-canvas.height*scale)/2+point.y*scale};},{x,y});await surface.click({position:point});};
  await click(100,75);await page.keyboard.type("Human shared state");await click(60,130);
  await until(async()=>submissions.some(item=>item.value==="Human shared state"));
  assert.match(submissions.at(-1)!.cookie,/proofSession=shared-cobalt-731/);
  const initial=await api(endpoint,{action:"state"});const target=initial.selected;
  await panel.getByRole("button",{name:"Expand side panel",exact:true}).click();
  await panel.getByRole("button",{name:"Restore side panel",exact:true}).click();
  assert.equal((await api(endpoint,{action:"state"})).selected,target);
  await page.reload();await panel.getByRole("button",{name:"Shared browser fixture",exact:true}).waitFor();
  assert.equal((await api(endpoint,{action:"state"})).selected,target,"reload reconnects to the same live tab");
  if(live){
    const pauseBrowser = async () => { await panel.getByRole("button", {name:"Take control",exact:true}).click(); await panel.getByRole("button", {name:"Let agents continue",exact:true}).waitFor(); };
    const resumeBrowser = async () => { await until(async () => (await api(`/api/browser/control?scope=run:${run.id}`)).waiting > 0, 90000); assert.equal((await api(`/api/browser/control?scope=run:${run.id}`)).user, true); await panel.getByRole("button", {name:"Let agents continue",exact:true}).click(); };
    console.log("Shared browser: human input passed; asking real Claude with user takeover held");
    await pauseBrowser();
    await api(`/api/runs/${run.id}/followups`,{kind:"reply",worktree:"solo",agent:"claude",message:"Use the codeflow_agent browser tools to inspect the CURRENT shared Browser panel. Do not navigate, open a new page, or use shell HTTP clients. Read the visible session marker and existing Name field, then replace Name with Claude shared state and click Submit. Report the previous field value, session marker and confirmation."});
    await resumeBrowser();
    const claude=await done(run.id);assert.match(claude.steps.filter((s:any)=>s.kind==="agent").at(-1).finalText,/Human shared state/);await until(async()=>submissions.some(item=>item.value==="Claude shared state"));
    assert.equal((await api(endpoint,{action:"state"})).selected,target);
    console.log("Shared browser: Claude passed; switching to real Codex");
    await pauseBrowser();
    const codex=await api(`/api/runs/${run.id}/provider-chat`,{agent:"codex",message:"Use the codeflow_agent browser tools to inspect the CURRENT shared Browser panel. Do not navigate, open a new page, or use shell HTTP clients. Read the session marker and existing Name field, replace Name with Codex shared state and click Submit. Report the previous field value, session marker and confirmation."});
    await resumeBrowser();
    const result=await done(codex.id);assert.match(result.summary,/Claude shared state/);await until(async()=>submissions.some(item=>item.value==="Codex shared state"));
    await page.goto(`${base}/#/run/${codex.id}`);await panel.getByRole("button",{name:"Shared browser fixture",exact:true}).waitFor();
    assert.equal((await api(`/api/browser?scope=run:${codex.id}`,{action:"state"})).selected,target,"provider forks use the same real Chrome target");
    for(const item of submissions)assert.match(item.cookie,/proofSession=shared-cobalt-731/);
    console.log("Shared browser: real Claude and Codex controlled the user's exact tab with its cookies and state");
    if(process.env.CODEFLOW_TEST_AGY_SHARED === "1") {
      await pauseBrowser();
      const agy=await api(`/api/runs/${codex.id}/provider-chat`,{agent:"agy",settings:{model:"gemini-3.8-flash-low"},message:"Use codeflow_agent browser tools to inspect the CURRENT shared Browser panel. Do not navigate, open a new page, or use native browser tools. Read the session marker and existing Name field, replace Name with Antigravity shared state and click Submit exactly once. Report the previous field value, session marker and confirmation."});
      await resumeBrowser();
      const agyResult=await done(agy.id);assert.match(agyResult.summary,/Codex shared state/);
      await until(async()=>submissions.some(item=>item.value==="Antigravity shared state"));
      assert.equal((await api(`/api/browser?scope=run:${agy.id}`,{action:"state"})).selected,target);
      assert.ok(agyResult.steps.some((step:any)=>step.permissions?.implementation==="macos-task-tools-v2"));
      console.log("Shared browser: real Antigravity Agent continued the exact tab after Claude and Codex");
      await page.goto(`${base}/#/run/${agy.id}`);
      await api(`/api/runs/${agy.id}/task-team`,{enabled:true,preset:"build-review",coordinator:"codex",providers:["agy","codex"],settings:{codex:{model:"gpt-6-luna",effort:"medium"},agy:{model:"gemini-3.8-flash-low"}},maxMembers:3,maxCalls:14,maxMinutes:8,approvePlan:false});
      await api(`/api/runs/${agy.id}/followups`,{kind:"reply",worktree:"solo",agent:"agy",message:"Run one Antigravity implementation worker to operate the current shared browser. This authorized synthetic interaction needs a WRITE task despite no source edits: inspect codeflow_agent browser_snapshot, report the previous Name value, replace Name with Team shared state and click Submit exactly once. Do not navigate or create tabs. Use a separate Codex independent reviewer to inspect only the confirmation. Do not repeat the submission. No source changes, packages, commits, tests or external services are needed; the visible confirmation is the acceptance evidence."});
      let teamResult:any;
      await until(async()=>{teamResult=await api(`/api/runs/${agy.id}`);return teamResult.status!=="running";},600000);
      assert.equal(teamResult.status,"done",teamResult.error);
      assert.equal(teamResult.followUps.at(-1)?.status,"done",teamResult.followUps.at(-1)?.result);
      const execution=await api(`/api/runs/${teamResult.teamTurns.at(-1).executionId}`);
      assert.equal(execution.status,"done",execution.error);
      assert.ok(execution.steps.some((step:any)=>step.agent==="agy"&&step.kind==="agent"));
      assert.equal(submissions.filter(item=>item.value==="Team shared state").length,1,"one team submission, without replaying the side effect");
      assert.equal((await api(endpoint,{action:"state"})).selected,target);
      const owner=await api(`/api/runs/${run.id}`);await api(`/api/runs/${agy.id}/task-team`,{...owner.taskTeam,enabled:false});
      await page.screenshot({path:join(root,"output/playwright/agy-shared-team-live.png")});
      writeFileSync(join(home,"agy-team-evidence.json"),JSON.stringify({parent:teamResult,execution,submissions},null,2));
      console.log("Shared browser: real Antigravity teammate used the same tab and submitted once; returned to Agent");
    }
    for(const item of submissions)assert.match(item.cookie,/proofSession=shared-cobalt-731/);
    mkdirSync(join(root,"output/playwright"),{recursive:true});await page.screenshot({path:join(root,"output/playwright/shared-browser-handoff.png")});
  }
  await ready();
  await panel.getByRole("button",{name:"New browser tab",exact:true}).click();
  await panel.getByRole("button",{name:"New tab",exact:true}).waitFor();
  await until(async()=>{const state=await api(endpoint,{action:"state"});return state.tabs.length===2&&state.selected!==target&&state.tabs.find((tab:any)=>tab.id===state.selected).url==="about:blank";});
  await panel.getByRole("button",{name:"Close New tab",exact:true}).click();
  await until(async()=>(await api(endpoint,{action:"state"})).selected===target);await ready(target);
  await click(60,230);
  await panel.getByRole("button",{name:"Shared browser fixture second",exact:true}).waitFor();await ready();
  await panel.getByRole("button",{name:"Back",exact:true}).click();
  await panel.getByRole("button",{name:"Shared browser fixture",exact:true}).waitFor();await ready();
  await panel.getByRole("button",{name:"Forward",exact:true}).click();
  await panel.getByRole("button",{name:"Shared browser fixture second",exact:true}).waitFor();await ready();
  await panel.getByRole("button",{name:"Back",exact:true}).click();
  await panel.getByRole("button",{name:"Shared browser fixture",exact:true}).waitFor();await ready();
  const dialogStarted=Date.now();
  const viewportBeforeDialog=await surface.boundingBox();
  await click(60,385);await panel.getByRole("form",{name:"Website dialog"}).waitFor();
  assert.deepEqual(await surface.boundingBox(),viewportBeforeDialog,"a website dialog must not resize the live viewport or invalidate queued input");
  await panel.getByLabel("Website prompt").fill("Dialog confirmed");await panel.getByRole("button",{name:"OK",exact:true}).click();
  await panel.getByRole("form",{name:"Website dialog"}).waitFor({state:"hidden"});assert.ok(Date.now()-dialogStarted<5000,"dialogs are answered without waiting for a CDP timeout");await ready();
  await click(60,335);
  await until(async()=>{const state=await api(endpoint,{action:"state"});return state.tabs.length===2&&state.selected!==target;});
  assert.equal(page.context().pages().length,1,"website popups also stay inside the app");
  await until(async()=>await panel.getByRole("button",{name:"Shared browser fixture second",exact:true}).getAttribute("aria-current")==="true");await ready();
  mkdirSync(join(root,"output/playwright"),{recursive:true});await page.screenshot({path:join(root,`output/playwright/shared-browser-${live?"live":"fixture"}.png`)});
  console.log("Evidence",home);
});
