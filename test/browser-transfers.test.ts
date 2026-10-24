import {test} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtempSync,writeFileSync,readFileSync,symlinkSync,mkdirSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
process.env.CODEFLOW_HOME=mkdtempSync(join(tmpdir(),"cf-transfers-unit-"));
const {AgentBrowser,chromeExecutable}=await import("../src/agent-browser.js");
const {BrowserFiles,browserWorkspacePath,MAX_BROWSER_DOWNLOAD}=await import("../src/browser-files.js");
const {AgentToolBridge,validateAgentTool}=await import("../src/agent-tools.js");
const workspace=join(process.env.CODEFLOW_HOME,"workspace");mkdirSync(workspace);writeFileSync(join(workspace,"upload.txt"),"agent-upload-proof");
async function until(check:()=>Promise<boolean>) {for(let i=0;i<150;i++){if(await check())return;await new Promise(r=>setTimeout(r,50));}throw new Error("Transfer timed out");}
test("workspace file transfers reject traversal, symlinks, directories, overwrites and malformed arguments",async()=>{
  symlinkSync(tmpdir(),join(workspace,"escape"));
  for(const path of ["../secret","escape/file",".git/config",workspace])await assert.rejects(browserWorkspacePath(workspace,path,true),/workspace|symbolic|\.git/);
  await assert.rejects(browserWorkspacePath(workspace,"escape"),/symbolic/);
  assert.throws(()=>validateAgentTool("browser_upload",{paths:"/etc/passwd"}),/Invalid/);
  assert.throws(()=>validateAgentTool("browser_upload",{paths:[42]}),/Invalid/);
  const files=new BrowserFiles("negative");await files.init();
  const staged=await files.stage("chooser","../../safe.txt",(async function*(){yield Buffer.from("safe");})(),()=>true);
  assert.equal(staged.name,"safe.txt");assert.throws(()=>files.staged("different",[staged.id]),/chooser/);
  files.consume([staged.id]);assert.throws(()=>files.staged("chooser",[staged.id]),/expired/);
  await assert.rejects(files.stage("closed","x",(async function*(){yield Buffer.from("x");})(),()=>false),/changed/);
  await files.begin({guid:"file-1",suggestedFilename:"../../proof.txt",url:"http://fixture"});writeFileSync(join(files.downloadDir,"file-1"),"bytes");await files.progress({guid:"file-1",state:"completed",receivedBytes:5,totalBytes:5});
  await assert.rejects(files.save("file-1",workspace,"upload.txt"),/already exists/);
  const saved=await files.save("file-1",workspace,"saved.txt");assert.equal(readFileSync(saved.path,"utf8"),"bytes");
  await files.begin({guid:"unfinished",suggestedFilename:"pending.bin",url:"http://fixture"});
  await files.progress({guid:"unfinished",state:"inProgress",receivedBytes:3,totalBytes:30});
  await files.begin({guid:"oversized",suggestedFilename:"big.bin",url:"http://fixture"});
  assert.match((await files.progress({guid:"oversized",state:"inProgress",receivedBytes:0,totalBytes:MAX_BROWSER_DOWNLOAD+1}))!.error!,/1 GB/);
  await files.close();const reopened=new BrowserFiles("negative");await reopened.init();assert.equal(reopened.get("unfinished").state,"canceled");assert.match(reopened.get("unfinished").error!,/session ended/);assert.equal((await reopened.downloaded("file-1")).item.name,"proof.txt");
  await reopened.remove("file-1");await assert.rejects(reopened.downloaded("file-1"),/Unknown/);await reopened.close();
  const bridge=new AgentToolBridge(),signal=new AbortController().signal;
  const grant=await bridge.issue({runId:"read",workspace,mode:"read",full:false,signal,active:()=>true});
  for(const [name,args] of [["browser_upload",{paths:["upload.txt"]}],["browser_downloads",{action:"save",id:"x",destination:"out"}],["browser_downloads",{action:"cancel",id:"x"}]] as const){const res=await fetch(grant.connection.endpoint,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${grant.connection.token}`},body:JSON.stringify({name,arguments:args})});assert.match((await res.json() as any).error,/read-only/);}
  await bridge.close();
});
test("real Chrome shares file choosers, workspace uploads, blob downloads and persistent transfer IDs",{skip:!chromeExecutable()},async()=>{
  const uploaded:string[]=[];
  const site=createServer(async(req,res)=>{
    if(req.url==="/upload"){const chunks=[];for await(const chunk of req)chunks.push(chunk);uploaded.push(Buffer.concat(chunks).toString());res.end("ok");return;}
    if(req.url==="/download"){res.writeHead(200,{"content-disposition":'attachment; filename="report.txt"'});res.end("download-proof");return;}
    res.setHeader("content-type","text/html");res.end(`<input aria-label="Upload" type="file" multiple onchange="Promise.all([...this.files].map(f=>fetch('/upload',{method:'POST',body:f})))"><a href="/download">Download</a><button onclick="const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob(['blob-proof']));a.download='report.txt';a.click()">Blob</button>`);
  });await new Promise<void>(r=>site.listen(0,"127.0.0.1",r));
  const browser=new AgentBrowser("chrome"),signal=new AbortController().signal;
  const call=(name:string,args={})=>browser.call(name,args,signal,workspace);
  const click=async(name:string)=>{const snapshot=await call("browser_snapshot");const node=snapshot.snapshot.find((item:any)=>item.name===name);assert.ok(node,JSON.stringify(snapshot));return call("browser_click",{ref:node.ref});};
  try {
    await call("browser_navigate",{url:`http://127.0.0.1:${(site.address() as any).port}`});
    await click("Upload");const chooser=(await call("browser_snapshot")).chooser;assert.ok(chooser);
    await call("browser_upload",{chooser:chooser.id,paths:["upload.txt"]});await until(async()=>uploaded.includes("agent-upload-proof"));
    await assert.rejects(call("browser_upload",{chooser:chooser.id,paths:["upload.txt"]}),/changed/);
    await click("Upload");const userChooser=(await call("browser_snapshot")).chooser;
    const staged=await browser.stageUpload(userChooser.id,"human.txt",(async function*(){yield Buffer.from("human-proof");})());
    await call("browser_ui",{action:"upload",chooser:userChooser.id,files:[staged.id]});await until(async()=>uploaded.includes("human-proof"));
    await click("Upload");await call("browser_ui",{action:"cancel-upload",chooser:(await call("browser_snapshot")).chooser.id});
    await click("Download");await until(async()=>(await call("browser_downloads",{action:"list"})).downloads.some((d:any)=>d.state==="completed"));await click("Blob");
    await until(async()=>(await call("browser_downloads",{action:"list"})).downloads.filter((d:any)=>d.state==="completed").length===2);
    const list=(await call("browser_downloads",{action:"list"})).downloads;assert.notEqual(list[0].id,list[1].id);assert.equal(list[0].name,list[1].name);
    for(const file of list){const saved=await call("browser_downloads",{action:"save",id:file.id,destination:`${file.id}.txt`});assert.match(readFileSync(saved.path,"utf8"),/blob-proof|download-proof/);}
    await click("Upload");const stale=(await call("browser_snapshot")).chooser;
    await call("browser_navigate",{url:`http://127.0.0.1:${(site.address() as any).port}`});
    await assert.rejects(browser.stageUpload(stale.id,"x",(async function*(){yield Buffer.from("x");})()),/changed/);
  }finally{await browser.close();site.closeAllConnections();await new Promise<void>(r=>site.close(()=>r()));}
});
