import {test,before,after,afterEach} from "node:test";
import assert from "node:assert/strict";
import {createServer,type Server} from "node:http";
import {spawn,execFileSync,type ChildProcess} from "node:child_process";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {chromium,type Browser,type Page} from "playwright-core";
const root=fileURLToPath(new URL("../..",import.meta.url));
const home=mkdtempSync(join(tmpdir(),"cf-browser-folders-")),repo=join(home,"repo");
const live=process.env.CODEFLOW_TEST_LIVE_AGENTS === "1", token="browser-folders-fixture";
let server:ChildProcess,fixture:Server,browser:Browser,page:Page,base:string,site:string,run:any;
const submissions:Array<{name:string;bytes:Buffer;cookie:string}>=[];
const expected=new Map<string,Buffer>();
const humanFolder=join(home,"Human folder");
function makeFolder(parent:string,name:string,many=false) {
  const folder=join(parent,name);mkdirSync(join(folder,"nested"),{recursive:true});
  const files:Record<string,Buffer>={"same.txt":Buffer.from(`${name} root`),"nested/same.txt":Buffer.from(`${name} nested`),"nested/é.bin":Buffer.from([0,127,128,255]),"empty.txt":Buffer.alloc(0)};
  if(many)for(let i=0;i<21;i++)files[`nested/file-${i}.txt`]=Buffer.from(String(i));
  for(const [path,bytes] of Object.entries(files)){writeFileSync(join(folder,path),bytes);expected.set(`${name}/${path}`,bytes);}
  return folder;
}
const headers={authorization:`Bearer ${token}`,"content-type":"application/json"};
async function api(path:string,body?:unknown) { const response=await fetch(`${base}${path}`,{method:body===undefined?"GET":"POST",headers,...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value as any; }
async function until(check:()=>Promise<boolean>,ms=30000) {const deadline=Date.now()+ms;while(Date.now()<deadline){if(await check())return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error("Shared browser check timed out");}
async function done(id:string) {let result:any;await until(async()=>{result=await api(`/api/runs/${id}`);return result.status!=="running";},live?240000:30000);assert.equal(result.status,"done",result.error);return result;}
before(async()=>{
  console.log("Evidence:",home);
  fixture=createServer(async(req,res)=>{
    const url=new URL(req.url!,"http://fixture");
    if(url.pathname==="/upload") {const chunks=[];for await(const chunk of req)chunks.push(chunk);submissions.push({name:url.searchParams.get("path")!,bytes:Buffer.concat(chunks),cookie:req.headers.cookie??""});res.end("ok");return;}
    res.writeHead(200,{"content-type":"text/html","x-frame-options":"DENY","content-security-policy":"frame-ancestors 'none'","set-cookie":"proofSession=shared-cobalt-731; HttpOnly; Path=/"});
    res.end(`<!doctype html><title>Browser folder fixture</title><style>body{font:16px system-ui;margin:20px}h1{font-size:20px}input{position:absolute;left:20px;top:70px;height:32px;width:280px}output{display:block;margin-top:90px;font-size:13px;overflow-wrap:anywhere;white-space:pre-line}</style><h1>Session shared-cobalt-731</h1><input aria-label="Upload folder" type="file" webkitdirectory onchange="const files=[...this.files];Promise.all(files.map(file=>fetch('/upload?path='+encodeURIComponent(file.webkitRelativePath),{method:'POST',body:file}))).then(()=>document.querySelector('output').textContent='Uploaded '+files.length+' files: '+files.map(f=>f.webkitRelativePath).join(', '))"><output>Waiting for folder</output>`);
  });
  await new Promise<void>(resolve=>fixture.listen(0,"127.0.0.1",resolve));site=`http://127.0.0.1:${(fixture.address() as any).port}/`;
  const probe=createServer();await new Promise<void>(resolve=>probe.listen(0,"127.0.0.1",resolve));base=`http://127.0.0.1:${(probe.address() as any).port}`;await new Promise<void>(resolve=>probe.close(()=>resolve()));
  mkdirSync(repo);execFileSync("git",["init","-q","-b","main"],{cwd:repo});writeFileSync(join(repo,"README.md"),"Shared browser test\n");execFileSync("git",["add","."],{cwd:repo});execFileSync("git",["-c","user.name=Test","-c","user.email=t@t","commit","-qm","fixture"],{cwd:repo});
  execFileSync(process.execPath,["scripts/build-ui.mjs"],{cwd:root});
  server=spawn(process.execPath,["--import","tsx","src/server.ts"],{cwd:root,env:{...process.env,PORT:new URL(base).port,CODEFLOW_HOME:join(home,"state"),CODEFLOW_TOKEN:token,...(live?{}:{PATH:`${root}/test/fake-bin:${process.env.PATH}`})},stdio:"ignore"});
  await until(()=>fetch(`${base}/api/health`,{headers}).then(r=>r.ok,()=>false));
  run=await api("/api/runs",{repo,pattern:"solo",roles:{agent:["claude"]},options:{},trust:"standard",...(live?{agentSettings:{claude:{model:"haiku"},codex:{model:"gpt-6-luna",effort:"medium"},agy:{model:"gemini-3.8-flash-low"}}}:{}),task:"Reply Ready. Do not use tools."});run=await done(run.id);makeFolder(home,"Human folder",true);for(const provider of ["Claude folder","Codex folder","Antigravity folder"])makeFolder(run.worktrees[0].path,provider);
  browser=await chromium.launch({channel:"chrome",headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(20000);
  await page.goto(`${base}/?token=${token}#/run/${run.id}`);
});
afterEach(async context=>{if((context as unknown as {error?:unknown}).error && page){console.error("Browser failure",await page.locator("#side-pane-browser").innerText());mkdirSync(join(root,"output/playwright"),{recursive:true});await page.screenshot({path:join(root,"output/playwright/browser-folders-failure.png")});}});
after(async()=>{await browser?.close();server?.kill("SIGTERM");if(server?.exitCode===null)await new Promise<void>(resolve=>{server.once("exit",()=>resolve());setTimeout(resolve,5000).unref();});fixture?.closeAllConnections();await new Promise<void>(resolve=>fixture?.close(()=>resolve()));});
test("user folder picker and real Claude/Codex preserve nested paths in one shared Chrome session",{timeout:live?900000:90000},async()=>{
  const toggle=page.getByRole("button",{name:"Side panel",exact:true});if(await toggle.getAttribute("aria-pressed")!=="true")await toggle.click();
  const panel=page.getByRole("complementary",{name:"Side panel",exact:true});await panel.getByRole("tab",{name:"Browser",exact:true}).click();
  await panel.getByLabel("Address",{exact:true}).fill(site);await panel.getByRole("button",{name:"Go",exact:true}).click();
  await panel.getByRole("button",{name:"Browser folder fixture",exact:true}).waitFor();
  const endpoint=`/api/browser?scope=run:${run.id}`,state=()=>api(endpoint,{action:"state"});
  const target=(await state()).selected;
  const surface=panel.getByRole("img",{name:"Live browser page",exact:true});
  const ready=()=>page.waitForFunction(()=>{const canvas=document.querySelector<HTMLCanvasElement>(".live-browser-surface canvas");return canvas?.dataset.ready==="true"&&Math.abs(canvas.width-canvas.getBoundingClientRect().width)<2&&Math.abs(canvas.height-Math.max(200,canvas.getBoundingClientRect().height))<2;});
  const openChooser=async()=>{await ready();await surface.click({trial:true});const point=await surface.evaluate(element=>{const canvas=element as HTMLCanvasElement,box=canvas.getBoundingClientRect(),scale=Math.min(box.width/canvas.width,box.height/canvas.height);return {x:(box.width-canvas.width*scale)/2+65*scale,y:(box.height-canvas.height*scale)/2+82*scale};});await surface.click({position:point,force:true});await panel.getByLabel("Upload folder to website").waitFor();};
  const verify=(folder:string,count:number)=>{const files=submissions.filter(file=>file.name.startsWith(`${folder}/`));assert.equal(files.length,count);assert.equal(new Set(files.map(file=>file.name)).size,count);for(const file of files){assert.deepEqual(file.bytes,expected.get(file.name),file.name);assert.match(file.cookie,/proofSession=shared-cobalt-731/);}};
  await openChooser();assert.equal((await state()).chooser.directory,true);
  const nativePicker=page.waitForEvent("filechooser");await panel.getByText("Choose folder",{exact:true}).click();const picker=await nativePicker;await picker.setFiles(humanFolder);
  await until(async()=>submissions.length===25);verify("Human folder",25);await panel.getByLabel("Upload folder to website").waitFor({state:"hidden"});
  await openChooser();mkdirSync(join(home,"Canceled folder"));writeFileSync(join(home,"Canceled folder","first.txt"),"first");writeFileSync(join(home,"Canceled folder","second.txt"),"second");
  let pendingRequests=0,release!:()=>void;const hold=new Promise<void>(resolve=>release=resolve);
  const intercept="**/api/browser/uploads?**";
  await page.route(intercept,async route=>{if(++pendingRequests===2)await hold;await route.continue().catch(()=>{});});
  await panel.getByLabel("Upload folder to website").setInputFiles(join(home,"Canceled folder"));
  await until(async()=>pendingRequests===2);const canceled=(await state()).chooser.id;
  await panel.getByRole("button",{name:"Cancel",exact:true}).click();await panel.getByLabel("Upload folder to website").waitFor({state:"hidden"});release();await page.unroute(intercept);
  const stale=await fetch(`${base}/api/browser/uploads?scope=run:${run.id}&chooser=${canceled}&name=late.txt&relativePath=Canceled%20folder%2Flate.txt`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/octet-stream"},body:"late"});assert.equal(stale.status,400);assert.equal(submissions.length,25,"canceled staging never reached the website");
  await page.reload();await panel.getByRole("button",{name:"Browser folder fixture",exact:true}).waitFor();assert.equal((await state()).selected,target);
  console.log("Human folder passed: native chooser, 25 files, nested paths, Unicode, repeated basenames, zero-byte/binary contents, cancel during transfer and reload");
  if(live) {
    // The user's open chooser is filled by Claude. Codex then uses a fresh folder-input ref.
    await openChooser();
    const prompt=(provider:string)=>`Use only codeflow_agent browser tools for browser actions. Work in the CURRENT shared Browser panel; do not navigate, open another tab or use a separate browser. Read the existing upload confirmation and report which folder it shows. Upload the entire workspace folder "${provider} folder" using browser_upload_folder, preserving nested relative paths. Use the pending chooser ID if one exists; otherwise use the Upload folder input ref from browser_snapshot. Verify the website shows four uploaded files including nested/same.txt, nested/é.bin and empty.txt. Report the session marker and the resulting relative paths. Do not use shell HTTP clients.`;
    await api(`/api/runs/${run.id}/followups`,{kind:"reply",worktree:"solo",agent:"claude",message:prompt("Claude")});const claude=await done(run.id);
    await until(async()=>submissions.filter(file=>file.name.startsWith("Claude folder/")).length===4);verify("Claude folder",4);assert.equal((await state()).selected,target);
    assert.match(claude.steps.filter((step:any)=>step.kind==="agent").at(-1).finalText,/Human folder/);
    console.log("Real Claude filled the user's folder chooser; exact paths, bytes and session cookie passed");
    const codex=await api(`/api/runs/${run.id}/provider-chat`,{agent:"codex",message:prompt("Codex")});const result=await done(codex.id);
    await until(async()=>submissions.filter(file=>file.name.startsWith("Codex folder/")).length===4);verify("Codex folder",4);assert.match(result.summary,/Claude folder/);
    await page.goto(`${base}/#/run/${codex.id}`);await panel.getByRole("button",{name:"Browser folder fixture",exact:true}).waitFor();
    assert.equal((await api(`/api/browser?scope=run:${codex.id}`,{action:"state"})).selected,target);
    console.log("Real Codex uploaded its folder after switching providers; same Chrome target/cookie and prior folder context passed");
    if(process.env.CODEFLOW_TEST_AGY_SHARED === "1") {
      const agy=await api(`/api/runs/${codex.id}/provider-chat`,{agent:"agy",message:prompt("Antigravity")});const result=await done(agy.id);
      await until(async()=>submissions.filter(file=>file.name.startsWith("Antigravity folder/")).length===4);verify("Antigravity folder",4);assert.match(result.summary,/Codex folder/);
      assert.equal((await api(`/api/browser?scope=run:${agy.id}`,{action:"state"})).selected,target);
      await page.goto(`${base}/#/run/${agy.id}`);await panel.getByRole("button",{name:"Browser folder fixture",exact:true}).waitFor();
      console.log("Real Antigravity uploaded nested, Unicode, binary and empty files with the same cookie and Chrome target after Claude and Codex");
    }

  }
  await ready();assert.equal(page.context().pages().length,1);mkdirSync(join(root,"output/playwright"),{recursive:true});await page.screenshot({path:join(root,`output/playwright/browser-folders-${live?"live":"fixture"}.png`)});
  console.log("Folder evidence",home);
});
