import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createServer} from "node:http";
const home=mkdtempSync(join(tmpdir(),"qa-side-browser-unit-"));process.env.CODEFLOW_HOME=home;
const {AgentBrowser,chromeExecutable}=await import("../src/agent-browser.js");
const {findChrome}=await import("../src/snapshot.js");
const {AgentComputer}=await import("../src/agent-computer.js");
const {AgentToolBridge}=await import("../src/agent-tools.js");
const signal=new AbortController().signal;
const call=async(grant:any,name:string,args={})=>{const r=await fetch(grant.connection.endpoint,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${grant.connection.token}`},body:JSON.stringify({name,arguments:args})});const body=await r.json() as any;return {status:r.status,body,value:body.content?.[0]?.text?JSON.parse(body.content[0].text.startsWith("{")?body.content[0].text:"null"):undefined};};
const issue=async(bridge:InstanceType<typeof AgentToolBridge>,id:string)=>{const receipts:any[]=[];const grant=await bridge.issue({runId:id,mode:"write",full:true,signal,active:()=>true,priorActions:receipts,onActionState:async receipt=>{const index=receipts.findIndex(r=>r.id===receipt.id);if(index<0)receipts.push(receipt);else receipts[index]=receipt;}});return {grant,receipts};};

test("live and capture Chrome discovery use the canonical setting, legacy alias and common fallback",()=>{
 const canonical=join(home,"chrome"),legacy=join(home,"legacy");writeFileSync(canonical,"");writeFileSync(legacy,"");
 for(const env of [{CODEFLOW_CHROME:canonical},{CODEFLOW_CHROME_PATH:legacy},{CODEFLOW_CHROME:canonical,CODEFLOW_CHROME_PATH:legacy}])assert.equal(chromeExecutable(env),findChrome(env));
 assert.equal(chromeExecutable({CODEFLOW_CHROME:canonical,CODEFLOW_CHROME_PATH:legacy}),canonical);
 assert.equal(chromeExecutable({CODEFLOW_CHROME_PATH:legacy}),legacy);
 assert.equal(chromeExecutable({CODEFLOW_CHROME:join(home,"missing"),CODEFLOW_CHROME_PATH:legacy}),undefined);
});

test("real Chrome: resize preserves refs, stale refs reject safely, fresh target identity detects different actions",{skip:!chromeExecutable(),timeout:60000},async()=>{
 let hits=0;
 const site=createServer((req,res)=>{if(req.url==="/hit"){hits++;res.end("ok");return;}res.setHeader("content-type","text/html");res.end(`<title>Receipt fixture</title><button onclick="fetch('/hit')">Count</button><button>Other</button><input aria-label="Name"><input type="file" aria-label="Upload">`);});
 await new Promise<void>(r=>site.listen(0,"127.0.0.1",r));const bridge=new AgentToolBridge(),{grant,receipts}=await issue(bridge,"real");
 try{
  const browser=await bridge.browser("run:real");const unwatch=browser.watch(()=>{});
  const first=await call(grant,"browser_navigate",{url:`http://127.0.0.1:${(site.address() as any).port}/`,operationId:"open"});assert.equal(first.status,200);
  const ref=(value:any,name:string)=>value.snapshot.find((n:any)=>n.name===name&&["button","textbox"].includes(n.role)).ref;
  const original=ref(first.value,"Count"),state=await browser.call("browser_ui",{action:"state"},signal);
  await browser.call("browser_ui",{action:"resize",width:420,height:300},signal);
  await assert.rejects(browser.call("browser_ui",{action:"mouse",tab:state.selected,view:state.view,type:"mousePressed",x:1,y:1,button:"left"},signal),/page changed/);
  assert.equal((await call(grant,"browser_click",{ref:original,operationId:"resized"})).status,200);assert.equal(hits,1);
  let snap=(await call(grant,"browser_snapshot")).value;
  assert.equal((await call(grant,"browser_click",{ref:original,operationId:"retry"})).status,400);assert.equal(receipts.at(-1).state,"rejected");assert.equal(hits,1);
  snap=(await call(grant,"browser_snapshot")).value;
  assert.equal((await call(grant,"browser_click",{ref:ref(snap,"Count"),operationId:"retry"})).status,200);assert.equal(hits,2);
  snap=(await call(grant,"browser_snapshot")).value;
  assert.match((await call(grant,"browser_click",{ref:ref(snap,"Other"),operationId:"retry"})).body.error,/different action/);assert.equal(hits,2);
  snap=(await call(grant,"browser_snapshot")).value;
  assert.match((await call(grant,"browser_click",{ref:ref(snap,"Count"),operationId:"retry"})).body.content[0].text,/already completed/);assert.equal(hits,2);
  for(const [name,args] of [["browser_navigate",{url:"file:///no"}],["browser_tabs",{action:"select",tab:"no-tab"}],["browser_tabs",{action:"close",tab:"no-tab"}],["browser_upload",{ref:"old",paths:["no"]}],["browser_downloads",{action:"save",id:"no",destination:"out"}] ] as const){await call(grant,"browser_snapshot");const r=await call(grant,name,{...args,operationId:name+JSON.stringify(args)});assert.equal(r.status,400);assert.equal(receipts.at(-1).state,"rejected",name);}
  // Transport/CDP failure after input dispatch remains uncertain, never blindly retried.
  snap=(await call(grant,"browser_snapshot")).value;
  const originalCall=browser.call.bind(browser);(browser as any).call=async()=>{throw new Error("Injected post-dispatch disconnect");};
  assert.equal((await call(grant,"browser_click",{ref:ref(snap,"Count"),operationId:"uncertain"})).status,400);assert.equal(receipts.at(-1).state,"uncertain");
  (browser as any).call=originalCall;await call(grant,"browser_snapshot");assert.match((await call(grant,"browser_click",{ref:ref(snap,"Count"),operationId:"uncertain"})).body.error,/uncertain/);
  unwatch();
 }finally{await bridge.close();site.closeAllConnections();await new Promise<void>(r=>site.close(()=>r()));}
});

test("mock desktop: no input on stale screenshot or bad bounds; fresh grounding reuses rejected operation",async()=>{
 const bridge=new AgentToolBridge();let writes=0;
 (bridge as any).computer=new AgentComputer(async(input:any)=>{if(input.action!=="screenshot")writes++;return {data:"fixture",width:1000,height:600,pointWidth:1000,pointHeight:600,app:"Mock"};});
 const {grant,receipts}=await issue(bridge,"desktop");
 try{
  await call(grant,"computer_screenshot");
  assert.equal((await call(grant,"computer_action",{action:"click",screenshot:"stale",x:10,y:10,operationId:"click"})).status,400);assert.equal(receipts.at(-1).state,"rejected");assert.equal(writes,0);
  let shot=(await call(grant,"computer_screenshot")).value.screenshot;
  assert.equal((await call(grant,"computer_action",{action:"click",screenshot:shot,x:1001,y:10,operationId:"bounds"})).status,400);assert.equal(receipts.at(-1).state,"rejected");assert.equal(writes,0);
  shot=(await call(grant,"computer_screenshot")).value.screenshot;
  assert.equal((await call(grant,"computer_action",{action:"click",screenshot:shot,x:10,y:10,operationId:"bounds"})).status,200);assert.equal(writes,1);
  shot=(await call(grant,"computer_screenshot")).value.screenshot;
  assert.equal((await call(grant,"computer_action",{action:"click",screenshot:shot,x:10,y:10,operationId:"click"})).status,200);assert.equal(writes,2);
  assert.match((await call(grant,"computer_action",{action:"click",screenshot:shot,x:10,y:10,operationId:"click"})).body.content[0].text,/already completed/);assert.equal(writes,2);
 }finally{await bridge.close();}
});

test("real Chrome: console history survives absent viewers, reconnect and tab switches; clear and navigation reset it",{skip:!chromeExecutable(),timeout:60000},async()=>{
 const site=createServer((_req,res)=>{res.setHeader("content-type","text/html");res.end('<title>Console</title><button onclick="console.error(\'hidden error\')">Emit</button>');});await new Promise<void>(r=>site.listen(0,"127.0.0.1",r));const browser=new AgentBrowser("history");
 try{
  const first=await browser.call("browser_navigate",{url:`http://127.0.0.1:${(site.address() as any).port}/`},signal);
  await browser.call("browser_click",{ref:first.snapshot.find((n:any)=>n.role==="button").ref},signal);
  let events:any[]=[];let stop=browser.watch(e=>events.push(e));await browser.call("browser_ui",{action:"state"},signal);
  assert.equal(events.find(e=>e.message?.type==="console-history").message.lines[0].text,"hidden error");stop();
  const cdp=(browser as any).cdp,session=(browser as any).session;
  await cdp.send("Runtime.evaluate",{expression:"for(let i=0;i<305;i++)console.error('error-'+i)"},session);
  events=[];stop=browser.watch(e=>events.push(e));await browser.call("browser_ui",{action:"state"},signal);
  const history=events.find(e=>e.message?.type==="console-history").message;assert.equal(history.lines.length,300);assert.equal(history.dropped,6);assert.equal(history.lines.at(-1).text,"error-304");stop();
  const tab=first.tab;await browser.call("browser_tabs",{action:"new"},signal);await browser.call("browser_tabs",{action:"select",tab},signal);
  events=[];stop=browser.watch(e=>events.push(e));await browser.call("browser_ui",{action:"state"},signal);assert.equal(events[0]?.message?.lines?.length??events.find(e=>e.message?.type==="console-history").message.lines.length,300);
  await browser.call("browser_ui",{action:"clear-console",tab},signal);assert.equal(events.at(-2)?.message?.lines?.length??events.filter(e=>e.message?.type==="console-history").at(-1).message.lines.length,0);stop();
  events=[];stop=browser.watch(e=>events.push(e));await browser.call("browser_ui",{action:"state"},signal);assert.equal(events.find(e=>e.message?.type==="console-history").message.lines.length,0);
  await browser.call("browser_navigate",{url:`http://127.0.0.1:${(site.address() as any).port}/new`},signal);assert.equal(events.filter(e=>e.message?.type==="console-history").at(-1).message.dropped,0);stop();
 }finally{await browser.close();site.closeAllConnections();await new Promise<void>(r=>site.close(()=>r()));}
});

test("real Chrome: old tab Pick cannot intercept agent input after tab switching without a viewer",{skip:!chromeExecutable(),timeout:60000},async()=>{
 let hits=0;const site=createServer((req,res)=>{if(req.url==="/hit"){hits++;return void res.end("ok");}res.setHeader("content-type","text/html");res.end('<button onclick="fetch(\'/hit\')">Count</button>');});await new Promise<void>(r=>site.listen(0,"127.0.0.1",r));const browser=new AgentBrowser("old-pick");
 try{
  const first=await browser.call("browser_navigate",{url:`http://127.0.0.1:${(site.address() as any).port}`},signal);
  await browser.call("browser_ui",{action:"overlay",tab:first.tab,message:{type:"mode",mode:"pick"}},signal);
  await browser.call("browser_tabs",{action:"new"},signal);
  // Harmless delayed cleanup is accepted, while other stale-tab commands remain refused.
  await browser.call("browser_ui",{action:"overlay",tab:first.tab,message:{type:"mode",mode:"off"}},signal);
  await assert.rejects(browser.call("browser_ui",{action:"overlay",tab:first.tab,message:{type:"mode",mode:"pick"}},signal),/tab changed/);
  await browser.call("browser_tabs",{action:"select",tab:first.tab},signal);
  const snap=await browser.call("browser_snapshot",{},signal);
  await browser.call("browser_click",{ref:snap.snapshot.find((n:any)=>n.role==="button").ref},signal);assert.equal(hits,1);
 }finally{await browser.close();site.closeAllConnections();await new Promise<void>(r=>site.close(()=>r()));}
});
