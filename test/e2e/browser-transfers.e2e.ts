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
const home=mkdtempSync(join(tmpdir(),"cf-browser-transfers-")),repo=join(home,"repo");
const live=process.env.CODEFLOW_TEST_LIVE_AGENTS === "1", token="browser-transfers-fixture";
let server:ChildProcess,fixture:Server,browser:Browser,page:Page,base:string,site:string,run:any;
const submissions:Array<{name:string;bytes:Buffer;cookie:string}>=[];
const downloadBytes=Buffer.from("Shared download \x00\xff proof: browser-cobalt-731");
const humanFiles=[{name:"human.txt",mimeType:"text/plain",buffer:Buffer.from("Human upload shared-cobalt-731")},{name:"binary.dat",mimeType:"application/octet-stream",buffer:Buffer.from([0,1,2,127,128,255])}];
const headers={authorization:`Bearer ${token}`,"content-type":"application/json"};
async function api(path:string,body?:unknown) { const response=await fetch(`${base}${path}`,{method:body===undefined?"GET":"POST",headers,...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value as any; }
async function until(check:()=>Promise<boolean>,ms=30000) {const deadline=Date.now()+ms;while(Date.now()<deadline){if(await check())return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error("Shared browser check timed out");}
async function done(id:string) {let result:any;await until(async()=>{result=await api(`/api/runs/${id}`);return result.status!=="running";},live?240000:30000);assert.equal(result.status,"done",result.error);return result;}
before(async()=>{
  console.log("Evidence:",home);
  fixture=createServer(async(req,res)=>{
    const url=new URL(req.url!,"http://fixture");
    if(url.pathname==="/upload") {const chunks=[];for await(const chunk of req)chunks.push(chunk);submissions.push({name:url.searchParams.get("name")!,bytes:Buffer.concat(chunks),cookie:req.headers.cookie??""});res.end("ok");return;}
    if(url.pathname==="/download") {if(!req.headers.cookie?.includes("proofSession=shared-cobalt-731")){res.writeHead(403);res.end("No cookie");return;}res.writeHead(200,{"content-type":"application/octet-stream","content-disposition":'attachment; filename="shared-proof.bin"'});res.end(downloadBytes);return;}
    if(url.pathname==="/slow") {res.writeHead(200,{"content-type":"application/octet-stream","content-disposition":'attachment; filename="slow.bin"',"content-length":10*1024*1024});const timer=setInterval(()=>res.write(Buffer.alloc(1024)),100);req.on("close",()=>clearInterval(timer));return;}
    res.writeHead(200,{"content-type":"text/html","x-frame-options":"DENY","content-security-policy":"frame-ancestors 'none'","set-cookie":"proofSession=shared-cobalt-731; HttpOnly; Path=/"});
    res.end(`<!doctype html><title>Browser transfer fixture</title><style>body{font:16px system-ui;margin:20px}h1{font-size:20px}input,a,button{position:absolute;left:20px;height:32px}input{top:70px;width:280px}a{top:130px}button{top:180px}output{position:absolute;top:290px;left:20px}</style><h1>Session shared-cobalt-731</h1><input aria-label="Upload files" type="file" multiple onchange="Promise.all([...this.files].map(file=>fetch('/upload?name='+encodeURIComponent(file.name),{method:'POST',body:file}))).then(()=>document.querySelector('output').textContent='Uploaded '+[...this.files].map(f=>f.name).join(', '))"><a href="/download">Download proof</a><button onclick="const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob(['Shared blob proof']));a.download='shared-proof.bin';a.click()">Download blob</button><a style="top:240px" href="/slow">Slow download</a><output>Waiting for upload</output>`);
  });
  await new Promise<void>(resolve=>fixture.listen(0,"127.0.0.1",resolve));site=`http://127.0.0.1:${(fixture.address() as any).port}/`;
  const probe=createServer();await new Promise<void>(resolve=>probe.listen(0,"127.0.0.1",resolve));base=`http://127.0.0.1:${(probe.address() as any).port}`;await new Promise<void>(resolve=>probe.close(()=>resolve()));
  mkdirSync(repo);execFileSync("git",["init","-q","-b","main"],{cwd:repo});writeFileSync(join(repo,"README.md"),"Shared browser test\n");execFileSync("git",["add","."],{cwd:repo});execFileSync("git",["-c","user.name=Test","-c","user.email=t@t","commit","-qm","fixture"],{cwd:repo});
  execFileSync(process.execPath,["scripts/build-ui.mjs"],{cwd:root});
  server=spawn(process.execPath,["--import","tsx","src/server.ts"],{cwd:root,env:{...process.env,PORT:new URL(base).port,CODEFLOW_HOME:join(home,"state"),CODEFLOW_TOKEN:token,...(live?{}:{PATH:`${root}/test/fake-bin:${process.env.PATH}`})},stdio:"ignore"});
  await until(()=>fetch(`${base}/api/health`,{headers}).then(r=>r.ok,()=>false));
  run=await api("/api/runs",{repo,pattern:"solo",roles:{agent:["claude"]},options:{},trust:"standard",...(live?{agentSettings:{claude:{model:"haiku"},codex:{model:"gpt-6-luna",effort:"medium"},agy:{model:"gemini-3.8-flash-low"}}}:{}),task:"Reply Ready. Do not use tools."});run=await done(run.id);for(const provider of ["claude","codex","antigravity"])writeFileSync(join(run.worktrees[0].path,`${provider}-upload.txt`),`${provider} upload shared-cobalt-731`);
  browser=await chromium.launch({channel:"chrome",headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(20000);
  await page.goto(`${base}/?token=${token}#/run/${run.id}`);
});
afterEach(async context=>{if((context as unknown as {error?:unknown}).error && page){console.error("Browser failure",await page.locator("#side-pane-browser").innerText());mkdirSync(join(root,"output/playwright"),{recursive:true});await page.screenshot({path:join(root,"output/playwright/browser-transfers-failure.png")});}});
after(async()=>{await browser?.close();server?.kill("SIGTERM");if(server?.exitCode===null)await new Promise<void>(resolve=>{server.once("exit",()=>resolve());setTimeout(resolve,5000).unref();});fixture?.closeAllConnections();await new Promise<void>(resolve=>fixture?.close(()=>resolve()));});
test("users, real Claude and Codex transfer files through the same browser session",{timeout:live?900000:90000},async()=>{
  const toggle=page.getByRole("button",{name:"Side panel",exact:true});if(await toggle.getAttribute("aria-pressed")!=="true")await toggle.click();
  const panel=page.getByRole("complementary",{name:"Side panel",exact:true});await panel.getByRole("tab",{name:"Browser",exact:true}).click();
  await panel.getByLabel("Address",{exact:true}).fill(site);await panel.getByRole("button",{name:"Go",exact:true}).click();
  await panel.getByRole("button",{name:"Browser transfer fixture",exact:true}).waitFor();
  const endpoint=`/api/browser?scope=run:${run.id}`,state=()=>api(endpoint,{action:"state"});
  const target=(await state()).selected;
  const surface=panel.getByRole("img",{name:"Live browser page",exact:true});
  const ready=()=>page.waitForFunction(()=>{const canvas=document.querySelector<HTMLCanvasElement>(".live-browser-surface canvas");return canvas?.dataset.ready==="true"&&Math.abs(canvas.width-canvas.getBoundingClientRect().width)<2&&Math.abs(canvas.height-Math.max(200,canvas.getBoundingClientRect().height))<2;});
  const click=async(x:number,y:number)=>{await ready();await surface.click({trial:true});const point=await surface.evaluate((element,point)=>{const canvas=element as HTMLCanvasElement,box=canvas.getBoundingClientRect(),scale=Math.min(box.width/canvas.width,box.height/canvas.height);return {x:(box.width-canvas.width*scale)/2+point.x*scale,y:(box.height-canvas.height*scale)/2+point.y*scale};},{x,y});await surface.click({position:point,force:true});};
  await click(65,82);
  await panel.getByLabel("Upload files to website").setInputFiles(humanFiles);
  await until(async()=>submissions.length===2);
  for(const file of humanFiles){const uploaded=submissions.find(item=>item.name===file.name)!;assert.deepEqual(uploaded.bytes,file.buffer);assert.match(uploaded.cookie,/proofSession=shared-cobalt-731/);}
  await panel.getByLabel("Upload files to website").waitFor({state:"hidden"});
  await click(65,82);await panel.getByLabel("Upload files to website").waitFor();const oldChooser=(await state()).chooser.id;
  await panel.getByRole("button",{name:"Cancel",exact:true}).click();await panel.getByLabel("Upload files to website").waitFor({state:"hidden"});
  const stale=await fetch(`${base}/api/browser/uploads?scope=run:${run.id}&chooser=${oldChooser}&name=x`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/octet-stream"},body:"stale"});assert.equal(stale.status,400);
  await click(65,140);await until(async()=>(await state()).downloads.some((d:any)=>d.state==="completed"));
  await panel.getByRole("button",{name:/Downloads/}).click();
  const saved=page.waitForEvent("download");await panel.getByRole("link",{name:"Save shared-proof.bin",exact:true}).click();const file=await saved;assert.equal(file.suggestedFilename(),"shared-proof.bin");assert.deepEqual(readFileSync((await file.path())!),downloadBytes);
  const downloadId=(await state()).downloads[0].id;
  const isolated=await fetch(`${base}/api/browser/downloads/${downloadId}?scope=none`,{headers});assert.equal(isolated.status,400,"another browser scope cannot read task downloads");
  const unauthorized=await fetch(`${base}/api/browser/downloads/${downloadId}?scope=run:${run.id}`);assert.equal(unauthorized.status,401);
  await click(65,195);await until(async()=>(await state()).downloads.filter((d:any)=>d.state==="completed").length===2);
  await click(65,250);await until(async()=>(await state()).downloads.some((d:any)=>d.name==="slow.bin"&&d.state==="inProgress"));
  await panel.getByRole("button",{name:"Cancel slow.bin",exact:true}).click();await until(async()=>(await state()).downloads.some((d:any)=>d.name==="slow.bin"&&d.state==="canceled"));
  await panel.getByRole("button",{name:"Remove slow.bin",exact:true}).click();await until(async()=>!(await state()).downloads.some((d:any)=>d.name==="slow.bin"));
  await page.reload();await panel.getByRole("button",{name:"Browser transfer fixture",exact:true}).waitFor();assert.equal((await state()).selected,target);assert.equal((await state()).downloads.length,2);
  console.log("Human transfers passed: multipart selection, binary bytes, authenticated download, blob, cancel, remove, reload and task isolation");
  if(live) {
    // The user opens a chooser; Claude must fill that exact pending chooser rather than making another browser.
    await click(65,82);await panel.getByLabel("Upload files to website").waitFor();
    const prompt=(provider:string)=>`Use only codeflow_agent browser tools for browser actions. Work in the CURRENT shared Browser panel, without navigating or opening another tab. Upload the workspace file ${provider.toLowerCase()}-upload.txt using browser_upload (use the pending chooser ID if present, otherwise the Upload files input ref). Confirm its name appears on the page. Use browser_downloads to save the existing completed download whose source URL ends /download (NOT the blob URL) to ${provider.toLowerCase()}-saved.bin in your workspace. Then click Download proof on the page to create one more authenticated download and verify it completes using browser_downloads. Report the session marker and the saved path. Do not use shell HTTP clients or a separate browser.`;
    await api(`/api/runs/${run.id}/followups`,{kind:"reply",worktree:"solo",agent:"claude",message:prompt("Claude")});const claude=await done(run.id);
    await until(async()=>submissions.filter(item=>item.name==="claude-upload.txt").length===1);assert.deepEqual(readFileSync(join(claude.worktrees[0].path,"claude-saved.bin")),downloadBytes);
    assert.equal((await state()).selected,target);await until(async()=>(await state()).downloads.filter((d:any)=>d.state==="completed").length===3);
    console.log("Real Claude uploaded to the user's pending chooser, saved a shared download and downloaded with the user's cookie");
    const codex=await api(`/api/runs/${run.id}/provider-chat`,{agent:"codex",message:prompt("Codex")});const result=await done(codex.id);
    await until(async()=>submissions.filter(item=>item.name==="codex-upload.txt").length===1);assert.deepEqual(readFileSync(join(result.worktrees[0].path,"codex-saved.bin")),downloadBytes);
    await until(async()=>(await state()).downloads.filter((d:any)=>d.state==="completed").length===4);
    await page.goto(`${base}/#/run/${codex.id}`);await panel.getByRole("button",{name:"Browser transfer fixture",exact:true}).waitFor();
    assert.equal((await api(`/api/browser?scope=run:${codex.id}`,{action:"state"})).selected,target);
    for(const item of submissions){assert.match(item.cookie,/proofSession=shared-cobalt-731/);if(["claude-upload.txt","codex-upload.txt"].includes(item.name))assert.equal(item.bytes.toString(),`${item.name.split("-")[0]} upload shared-cobalt-731`);}
    console.log("Real Codex preserved the same target, cookies and transfers across a provider fork; uploaded and saved exact bytes");
    if(process.env.CODEFLOW_TEST_AGY_SHARED === "1") {
      const agy=await api(`/api/runs/${codex.id}/provider-chat`,{agent:"agy",message:prompt("Antigravity")});const result=await done(agy.id);
      await until(async()=>submissions.filter(item=>item.name==="antigravity-upload.txt").length===1);
      assert.deepEqual(readFileSync(join(result.worktrees[0].path,"antigravity-saved.bin")),downloadBytes);
      const uploaded=submissions.find(item=>item.name==="antigravity-upload.txt")!;
      assert.equal(uploaded.bytes.toString(),"antigravity upload shared-cobalt-731");assert.match(uploaded.cookie,/proofSession=shared-cobalt-731/);
      await until(async()=>(await state()).downloads.filter((d:any)=>d.state==="completed").length===5);
      assert.equal((await api(`/api/browser?scope=run:${agy.id}`,{action:"state"})).selected,target);
      await page.goto(`${base}/#/run/${agy.id}`);await panel.getByRole("button",{name:"Browser transfer fixture",exact:true}).waitFor();
      console.log("Real Antigravity uploaded and saved exact bytes, then downloaded with the same cookie and Chrome target after Claude and Codex");
    }

  }
  if(await panel.getByRole("button",{name:/Downloads/}).getAttribute("aria-expanded")==="false")await panel.getByRole("button",{name:/Downloads/}).click();
  assert.equal(page.context().pages().length,1);mkdirSync(join(root,"output/playwright"),{recursive:true});await page.screenshot({path:join(root,`output/playwright/browser-transfers-${live?"live":"fixture"}.png`)});
  console.log("Transfer evidence",home);
});
