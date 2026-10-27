import {test,before,after,afterEach} from "node:test";
import assert from "node:assert/strict";
import {spawn,execFileSync,type ChildProcess} from "node:child_process";
import {mkdirSync,mkdtempSync,writeFileSync,openSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {createServer,type Server} from "node:http";
import {chromium,type Browser,type Page,type Locator} from "playwright-core";
import {findChrome} from "../src/snapshot.js";
const root=fileURLToPath(new URL("..",import.meta.url));
const evidence=process.env.QA_SIDE_BROWSER_EVIDENCE??join(root,"output/playwright/qa-side-browser-unit");
mkdirSync(evidence,{recursive:true});
const home=mkdtempSync(join(evidence,"ui-home-")),repo=join(home,"repo"),token="qa-side-browser-token",base="http://127.0.0.1:4355",site="http://127.0.0.1:4357";
let server:ChildProcess,fixture:Server,browser:Browser,page:Page,side:Locator,surface:Locator,run:any,hits=0,queued=0;
const errors:string[]=[],apiFailures:string[]=[],requests:any[]=[];
const headers={authorization:`Bearer ${token}`,"content-type":"application/json",origin:base};
async function request(path:string,body?:unknown){const response=await fetch(base+path,{method:body===undefined?"GET":"POST",headers,...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();return {status:response.status,value};}
async function api(path:string,body?:unknown){const r=await request(path,body);assert.ok(r.status<400,JSON.stringify(r));return r.value as any;}
async function until(check:()=>Promise<boolean>,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,100));}throw new Error("QA browser condition timed out");}
async function shot(name:string){await page.screenshot({path:join(evidence,name+".png")});}
const endpoint=()=>`/api/browser?scope=run:${run.id}`;
async function ready(){
 let previous="",first=0;
 await until(async()=>{
  const state=await api(endpoint(),{action:"state"});
  const drawn=await surface.evaluate(el=>{const c=el as HTMLCanvasElement,b=c.getBoundingClientRect();return {width:c.width,height:c.height,bw:b.width,bh:b.height,ready:c.dataset.ready,tab:c.dataset.tab,view:c.dataset.view,frames:c.dataset.frames};});
  if(drawn.ready!=="true"||drawn.tab!==state.selected||Number(drawn.view)!==state.view){previous="";return false;}
  const version=`${drawn.tab}:${drawn.view}:${drawn.width}:${drawn.height}`;
  if(previous!==version){previous=version;first=Number(drawn.frames);return false;}
  return Number(drawn.frames)>first+1;
 });
}
async function point(x:number,y:number){return surface.evaluate((el,p)=>{const c=el as HTMLCanvasElement,b=c.getBoundingClientRect(),scale=Math.min(b.width/c.width,b.height/c.height);return {x:(b.width-c.width*scale)/2+p.x*scale,y:(b.height-c.height*scale)/2+p.y*scale};},{x,y});}
async function click(x:number,y:number){await ready();await surface.click({position:await point(x,y)});}
async function go(path:string){await side.getByLabel("Address",{exact:true}).fill(site+path);const navigated=page.waitForResponse(r=>r.url().includes("/api/browser?")&&r.request().method()==="POST"&&r.request().postDataJSON()?.action==="navigate"&&r.request().postDataJSON()?.url===site+path);await side.getByRole("button",{name:"Go",exact:true}).click();assert.equal((await navigated).status(),200);await until(async()=>{const state=await api(endpoint(),{action:"state"});return state.tabs.some((tab:any)=>tab.id===state.selected&&tab.url===site+path);});await ready();await side.getByRole("button",{name:"Pick",exact:true}).waitFor();}
async function openConsole(){const button=side.getByRole("button",{name:/^Console/});if(await button.getAttribute("aria-pressed")!=="true")await button.click();}
async function off(){for(const name of ["Pick","Box"]){const b=side.getByRole("button",{name,exact:true});if(await b.getAttribute("aria-pressed")==="true")await b.click();}}
async function clearPins(){const remove=side.getByRole("button",{name:/^Remove pin/});while(await remove.count())await remove.first().click();}
function observe(p:Page){p.on("pageerror",e=>errors.push(e.message));p.on("console",m=>{if(m.type()==="error"&&!m.text().includes("status of 400")&&!m.text().includes("status of 403"))errors.push(m.text());});p.on("response",r=>{if(r.url().includes("/api/")&&r.status()>=400)apiFailures.push(`${r.status()} ${r.request().postData()??r.url()}`);});p.on("request",r=>{if(r.method()==="POST"&&r.url().includes("/api/browser?"))requests.push(r.postDataJSON());});}
before(async()=>{
 console.log("Real Chrome UI; fake provider only for setup",home);
 mkdirSync(repo);mkdirSync(join(repo,".codeflow"));mkdirSync(join(home,"state"));writeFileSync(join(home,"state/.initialized"),"");
 writeFileSync(join(repo,"README.md"),"QA Browser\n");writeFileSync(join(repo,".codeflow/config.json"),JSON.stringify({run:{command:"node app.cjs"}}));writeFileSync(join(repo,"app.cjs"),"require('http').createServer((q,r)=>r.end('fixture')).listen(process.env.PORT,'127.0.0.1')");
 execFileSync("git",["init","-q","-b","main"],{cwd:repo});execFileSync("git",["add","."],{cwd:repo});execFileSync("git",["-c","user.name=QA","-c","user.email=qa@example.test","commit","-qm","fixture"],{cwd:repo});
 fixture=createServer((req,res)=>{const u=new URL(req.url!,site);if(u.pathname==="/hit"){hits++;return void res.end("ok");}if(u.pathname==="/poll"){const n=u.searchParams.get("page")==="/console"?queued:0;if(n)queued=0;return void res.end(String(n));}if(u.pathname==="/favicon.ico"){res.writeHead(204);return void res.end();}res.setHeader("content-type","text/html");res.end(`<!doctype html><title>QA browser ${u.pathname}</title><style>body{margin:20px;font:16px system-ui}h1{font-size:20px;margin:0}button{position:absolute;top:65px;left:20px;width:100px;height:32px}#log25{top:115px}#log305{top:115px;left:135px}#clock{position:absolute;top:160px}#below{margin-top:1500px}</style><h1>QA browser fixture</h1><button id="count" onclick="fetch('/hit')">Count</button><button id="log25" onclick="emit(25)">Log 25</button><button id="log305" onclick="emit(305)">Log 305</button><p id="clock"></p><p id="below">Long page</p><script>function emit(n){for(let i=1;i<=n;i++)console.error('qa-error-'+i)}setInterval(()=>document.querySelector('#clock').textContent='Frame '+Date.now(),250);setInterval(()=>fetch('/poll?page='+encodeURIComponent(location.pathname)).then(r=>r.text()).then(n=>emit(Number(n))),500)</script>`);});
 await new Promise<void>(r=>fixture.listen(4357,"127.0.0.1",r));
 const canonical=join(home,"chrome.sh"),legacy=join(home,"legacy-chrome.sh"),log=join(evidence,"chrome-launches.log");writeFileSync(log,"");
 // Keep the outer QA Chrome configuration while testing canonical/legacy precedence.
 // Raw Chrome under a scratch macOS HOME can wait indefinitely for Keychain authorization.
 const inheritedChrome=process.env.CODEFLOW_CHROME||undefined,chrome=findChrome();
 assert.ok(chrome,"Chrome is required for the browser fixture");
 const shellQuote=(value:string)=>`'${value.replace(/'/g,"'\\''")}'`;
 for(const [file,label] of [[canonical,"canonical"],[legacy,"legacy"]] as const)writeFileSync(file,`#!/bin/sh\necho ${label} >> ${shellQuote(log)}\nexec ${shellQuote(chrome)}${!inheritedChrome&&process.platform==="darwin"?" --use-mock-keychain":""} "$@"\n`,{mode:0o700});
 writeFileSync(join(home,"fake-gh.json"),'{"issues":[],"prs":{}}');
 execFileSync(process.execPath,["scripts/build-ui.mjs"],{cwd:root});
 const out=openSync(join(evidence,"ui-server.log"),"w");server=spawn(process.execPath,["--import","tsx","src/server.ts"],{cwd:root,env:{...process.env,PORT:"4355",CODEFLOW_HOME:join(home,"state"),CODEFLOW_TOKEN:token,HOME:home,PATH:`${root}/test/fake-bin:${process.env.PATH}`,FAKE_GH_STATE:join(home,"fake-gh.json"),CODEFLOW_CHROME:canonical,CODEFLOW_CHROME_PATH:legacy},stdio:["ignore",out,out]});
 await until(()=>fetch(base+"/api/health",{headers}).then(r=>r.ok,()=>false));
 run=await api("/api/runs",{repo,task:"QA browser run. Reply Ready.",pattern:"solo",roles:{agent:["claude"]},options:{},trust:"standard"});await until(async()=>{run=await api(`/api/runs/${run.id}`);return run.status!=="running";});assert.equal(run.status,"done",run.error);
 browser=await chromium.launch({channel:"chrome",headless:true});page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(20000);observe(page);
 await page.goto(`${base}/?token=${token}#/run/${run.id}`);const toggle=page.getByRole("button",{name:"Side panel",exact:true});if(await toggle.getAttribute("aria-pressed")!=="true")await toggle.click();side=page.getByRole("complementary",{name:"Side panel",exact:true});await side.getByRole("tab",{name:"Browser",exact:true}).click();surface=side.getByRole("img",{name:"Live browser page",exact:true});
});
afterEach(async c=>{if((c as any).error&&page){await shot("FAIL-"+c.name.slice(0,30).replace(/[^\w-]/g,"_"));console.error(await side.innerText());console.error("state/drawn",await api(endpoint(),{action:"state"}),await surface.evaluate(el=>({width:(el as HTMLCanvasElement).width,height:(el as HTMLCanvasElement).height,box:el.getBoundingClientRect().toJSON(),...(el as HTMLElement).dataset})));}});
after(async()=>{writeFileSync(join(evidence,"ui-observations.json"),JSON.stringify({errors,apiFailures,requests},null,2));await browser?.close();server?.kill("SIGTERM");if(server?.exitCode===null)await new Promise<void>(r=>{server.once("exit",()=>r());setTimeout(r,5000).unref();});fixture?.closeAllConnections();await new Promise<void>(r=>fixture?.close(()=>r()));});

test("failed Preview is consumed once; manual navigation and reload stay on the chosen page",{timeout:60000},async()=>{
 await page.getByText("More options",{exact:true}).click();await page.getByText("Preview settings",{exact:true}).click();
 // Inject one browser-navigation failure after a healthy preview becomes ready.
 // A process that dies before HTTP readiness no longer reaches browser navigation.
 await page.route("**/api/browser?**",async route=>{const body=route.request().postDataJSON();if(body?.action==="navigate"&&!body.url.startsWith(site))await route.fulfill({status:400,contentType:"application/json",body:JSON.stringify({error:"Could not open fixture preview"})});else await route.continue();});
 await page.getByLabel("App command",{exact:true}).fill("node app.cjs");
 await page.getByRole("button",{name:"Start preview",exact:true}).click();
 await until(async()=>requests.some(r=>r.action==="navigate"&&/^http:\/\/(?:localhost|127\.0\.0\.1):/.test(r.url)));
 const bad=requests.find(r=>r.action==="navigate"&&/^http:\/\/(?:localhost|127\.0\.0\.1):/.test(r.url)).url;
 await side.getByRole("alert").filter({hasText:"Could not open"}).waitFor({timeout:35000});await page.waitForTimeout(1000);assert.equal(requests.filter(r=>r.action==="navigate"&&r.url===bad).length,1);
 await shot("01-preview-failure"); await page.unroute("**/api/browser?**");
 for(const path of ["/manual-one","/manual-two"]){await go(path);await page.waitForTimeout(500);assert.equal(await side.getByLabel("Address",{exact:true}).inputValue(),site+path);}
 await page.reload();await ready();assert.equal(await side.getByLabel("Address",{exact:true}).inputValue(),site+"/manual-two");assert.equal(requests.filter(r=>r.action==="navigate"&&r.url===bad).length,1);
 const memories=await page.evaluate(()=>JSON.parse(localStorage.getItem("sideMemory")??"{}"));assert.ok(Object.values(memories).some((m:any)=>m.browserRequest?.id&&m.browserRequest.id===m.browserHandled));
 await shot("02-manual-page-after-reload");
});

test("Pick and Box follow reload, navigation, Escape and sending without clicking through",{timeout:60000},async()=>{
 await go("/annotations");const pick=side.getByRole("button",{name:"Pick",exact:true});await pick.click();await ready();const beforeHits=hits;
 await side.getByRole("button",{name:"Reload",exact:true}).click();await ready();await page.waitForTimeout(300);assert.equal(await pick.getAttribute("aria-pressed"),"true");await click(60,80);await until(async()=>await side.locator(".pin-row").count()===1);assert.equal(hits,beforeHits);
 await go("/annotations-next");await page.waitForTimeout(300);assert.equal(await pick.getAttribute("aria-pressed"),"true");await click(60,80);await until(async()=>await side.locator(".pin-row").count()===2);assert.equal(hits,beforeHits);
 await side.getByRole("button",{name:"Add to chat",exact:true}).click();await until(async()=>await pick.getAttribute("aria-pressed")==="false");assert.equal(await side.locator(".pin-row").count(),0);
 await pick.click();await click(60,80);await until(async()=>await side.locator(".pin-row").count()===1);await page.keyboard.press("Escape");await until(async()=>await pick.getAttribute("aria-pressed")==="false");await click(60,80);await until(async()=>hits===beforeHits+1);await clearPins();
 const box=side.getByRole("button",{name:"Box",exact:true});await box.click();await ready();await side.getByRole("button",{name:"Reload",exact:true}).click();await ready();await page.waitForTimeout(300);assert.equal(await box.getAttribute("aria-pressed"),"true");
 const bounds=await surface.boundingBox(),from=await point(20,60),to=await point(130,105);await page.mouse.move(bounds!.x+from.x,bounds!.y+from.y);await page.mouse.down();const dragView=(await api(endpoint(),{action:"state"})).view;await side.getByLabel("Browser viewport").selectOption("tablet");await page.waitForTimeout(300);assert.equal((await api(endpoint(),{action:"state"})).view,dragView,"viewport changes wait for the active annotation gesture");for(let step=1;step<=5;step++){await page.mouse.move(bounds!.x+from.x+(to.x-from.x)*step/5,bounds!.y+from.y+(to.y-from.y)*step/5);await page.waitForTimeout(100);}await page.mouse.up();await until(async()=>await side.locator(".pin-row").count()===1);assert.equal(hits,beforeHits+1);await side.getByLabel("Browser viewport").selectOption("full");await ready();await shot("03-box-after-reload");await off();await clearPins();
});

test("switching tabs resets old interception without stale-tab cleanup errors",{timeout:45000},async()=>{
 await go("/tab-a");await side.getByRole("button",{name:"Pick",exact:true}).click();const marker=apiFailures.length;const original=(await api(endpoint(),{action:"state"})).selected;
 await side.getByRole("button",{name:"New browser tab",exact:true}).click();await go("/tab-b");await side.getByRole("button",{name:"QA browser /tab-a",exact:true}).click();await until(async()=>await side.getByLabel("Address",{exact:true}).inputValue()===site+"/tab-a");await ready();assert.equal(await side.getByRole("button",{name:"Pick",exact:true}).getAttribute("aria-pressed"),"false");const beforeHits=hits;await click(60,80);await until(async()=>hits===beforeHits+1);assert.equal(await side.locator(".pin-row").count(),0);assert.equal(apiFailures.slice(marker).length,0,apiFailures.slice(marker).join("\n"));
 assert.equal((await api(endpoint(),{action:"state"})).selected,original);await shot("04-tabs-clean");
});

test("console survives hide, reload and pop-out; caps and attachments are honest; drawers keep canvas and Send usable",{timeout:90000},async()=>{
 await go("/console");await click(60,130);await openConsole();await until(async()=>await side.locator(".bc-line").count()===25);
 await side.getByRole("tab",{name:"Chat",exact:true}).click();queued=3;await until(async()=>queued===0);await side.getByRole("tab",{name:"Browser",exact:true}).click();await openConsole();await until(async()=>await side.locator(".bc-line").count()===28);
 await page.reload();await ready();await openConsole();await until(async()=>await side.locator(".bc-line").count()===28);await shot("05-console-reconnected");
 // A second authenticated page is the same pop-out Browser route used by the panel button.
 const pop=await browser.newPage({viewport:{width:900,height:900}});observe(pop);await pop.goto(`${base}/?token=${token}#/side/browser/${encodeURIComponent(`run:${run.id}`)}`);await pop.getByRole("button",{name:/^Console/}).click();await until(async()=>await pop.locator(".bc-line").count()===28);await pop.screenshot({path:join(evidence,"06-console-popout.png")});await pop.close();
 await click(180,130);await until(async()=>await side.locator(".bc-line").count()===300);assert.match(await side.getByRole("button",{name:/^Console/}).innerText(),/300\+/);assert.match(await side.locator(".bc-head").innerText(),/older entries omitted/);
 await side.getByRole("button",{name:"Pick",exact:true}).click();await click(60,80);await until(async()=>await side.locator(".pin-row").count()===1);await side.getByRole("button",{name:"Adjust",exact:true}).click();
 const label=side.getByLabel("with last 20 of 300+ console errors",{exact:true});await label.check();
 const dimensions=await side.locator(".live-browser-surface").boundingBox(),send=await side.getByRole("button",{name:"Add to chat",exact:true}).boundingBox();console.log("1440x900 layout",dimensions,send);assert.ok(dimensions!.height>=200);assert.ok(send!.y+send!.height<=900);await shot("07-console-adjust-layout");
 await side.getByRole("button",{name:"Add to chat",exact:true}).click();
 const savedDrafts=()=>page.evaluate(()=>new Promise<unknown[]>((resolve,reject)=>{const open=indexedDB.open("codeflow-project-drafts",1);open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result,read=db.transaction("drafts","readonly").objectStore("drafts").getAll();read.onerror=()=>{db.close();reject(read.error);};read.onsuccess=()=>{db.close();resolve(read.result);};};}));
 await until(async()=>JSON.stringify(await savedDrafts()).includes("consoleOmitted"));
 await page.reload(); await ready();
 const stored=await savedDrafts(); await openConsole(); writeFileSync(join(evidence,"attachment-storage.json"),JSON.stringify(stored));const all=JSON.stringify(stored);assert.match(all,/consoleOmitted/);assert.match(all,/qa-error-305/);assert.match(all,/qa-error-286/);
 await side.getByRole("button",{name:"Clear",exact:true}).click();await until(async()=>await side.locator(".bc-line").count()===0);await page.reload();await ready();await openConsole();assert.equal(await side.locator(".bc-line").count(),0);
 await click(60,130);await until(async()=>await side.locator(".bc-line").count()===25);await go("/console-reset");await openConsole();assert.equal(await side.locator(".bc-line").count(),0);
 await click(60,130);await side.getByRole("button",{name:"Pick",exact:true}).click();await click(60,80);await until(async()=>await side.locator(".pin-row").count()===1);await side.getByRole("button",{name:"Adjust",exact:true}).click();await page.setViewportSize({width:1100,height:650});await ready();const short=await side.locator(".live-browser-surface").boundingBox();assert.ok(short!.height>=200);await side.getByRole("button",{name:"Add to chat",exact:true}).scrollIntoViewIfNeeded();assert.ok(await side.getByRole("button",{name:"Add to chat",exact:true}).isVisible());await shot("08-short-drawers-scroll");await page.setViewportSize({width:1440,height:900});
});

test("visual captures give direct own-port guidance and use the same Chrome override",{timeout:45000},async()=>{
 const more=page.locator("details.result-more");if(await more.getAttribute("open")===null)await more.locator(":scope > summary").click();
 const preview=more.locator("details").filter({has:page.getByText("Preview settings",{exact:true})});if(await preview.getAttribute("open")===null)await preview.locator("summary").click();
 await page.getByLabel("App command",{exact:true}).fill("node app.cjs");await page.getByRole("button",{name:"Start preview",exact:true}).click();
 await page.getByText("Show me what changed",{exact:true}).click();await page.getByLabel("Original app URL (optional)",{exact:true}).fill(base);
 await page.getByRole("button",{name:"Capture comparison",exact:true}).click();await page.locator(".visual-comparison").getByRole("alert").filter({hasText:"Code Flow itself"}).waitFor();await page.getByAltText("Result app at 1280 by 900 pixels").waitFor();await shot("09-visual-comparison-guidance");
 const refused=await request("/api/snapshot",{url:base,width:800});assert.equal(refused.status,403);assert.match(refused.value.error,/Code Flow itself/);assert.doesNotMatch(refused.value.error,/Snapshot works|Browser tab/);
 const captured=await request("/api/snapshot",{url:site+"/capture",width:800});assert.equal(captured.status,200);assert.ok(captured.value.image.length>100);
 const launches=readFileSync(join(evidence,"chrome-launches.log"),"utf8");assert.ok(launches.trim().split("\n").length>=2);assert.doesNotMatch(launches,/legacy/);
 assert.equal(await side.getByRole("button",{name:/^(Snapshot|Whole page|Retake|Live page|Draw|Compare)$/}).count(),0);
 assert.deepEqual(errors,[]);assert.equal(apiFailures.filter(x=>!x.includes('"action":"navigate"')&&!x.includes('"url":"http://127.0.0.1:4355"')).length,0,apiFailures.join("\n"));console.log("UI console errors",errors,"expected failures",apiFailures);
});

test("Reload queued behind a resize uses the current view of the same tab", { timeout: 45000 }, async () => {
 await go("/queued-reload"); const marker=apiFailures.length;
 let release!:()=>void,entered!:()=>void,first=true;
 const held=new Promise<void>(resolve=>release=resolve),captured=new Promise<void>(resolve=>entered=resolve);
 await page.route("**/api/browser?**",async route=>{if(route.request().postDataJSON()?.action==="resize"&&first){first=false;entered();await held;}await route.continue();});
 try {
  await side.getByLabel("Browser viewport").selectOption("tablet");await captured;assert.notEqual(await surface.getAttribute("data-ready"),"true","queued resizing must not advertise a clickable old frame");await shot("10-pending-resize");await surface.hover({position:await point(60,80)});await page.mouse.wheel(0,120);
  const reloaded=page.waitForResponse(response=>response.url().includes("/api/browser?")&&response.request().postDataJSON()?.action==="reload");
  await side.getByRole("button",{name:"Reload",exact:true}).click();release();assert.equal((await reloaded).status(),200);await ready();
  assert.deepEqual(apiFailures.slice(marker),[]);
 } finally {release();await page.unrouteAll({behavior:"wait"});await side.getByLabel("Browser viewport").selectOption("full");await ready();}
});
