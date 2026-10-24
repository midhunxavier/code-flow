import {test} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,truncateSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
process.env.CODEFLOW_HOME=mkdtempSync(join(tmpdir(),"cf-browser-folders-"));
const {AgentBrowser,chromeExecutable}=await import("../src/agent-browser.js");
const {BrowserFiles,browserFolderPath,MAX_BROWSER_UPLOAD}=await import("../src/browser-files.js");
const {AgentToolBridge,validateAgentTool}=await import("../src/agent-tools.js");
const workspace=join(process.env.CODEFLOW_HOME,"workspace");mkdirSync(workspace);
const data=Buffer.from([0,127,128,255]);
const tree=join(workspace,"agent folder");mkdirSync(join(tree,"nested"),{recursive:true});writeFileSync(join(tree,"same.txt"),"root");writeFileSync(join(tree,"nested","same.txt"),"nested");writeFileSync(join(tree,"nested","bytes.bin"),data);writeFileSync(join(tree,"empty.txt"),"");
const body=(value:string|Buffer)=>(async function*(){yield Buffer.from(value);})();
async function until(check:()=>boolean) {const end=Date.now()+10000;while(!check()){if(Date.now()>end)throw new Error("Folder upload timed out");await new Promise(r=>setTimeout(r,50));}}

test("folder staging preserves paths and rejects traversal, mixing, duplicates, symlinks, internals and limits",async()=>{
  for(const path of ["/a/file","../a","a/../file","a//file","a/./file","a\\b","C:/file","a/.git/config","a\0/file"])assert.throws(()=>browserFolderPath(path),/path|internals/);
  assert.equal(browserFolderPath("Photos/nested/photo.bin"),"Photos/nested/photo.bin");
  const files=new BrowserFiles("folders");await files.init();
  const first=await files.stage("chooser","same.txt",body("first"),()=>true,"My folder/same.txt");
  const second=await files.stage("chooser","same.txt",body("second"),()=>true,"My folder/nested/same.txt");
  const prepared=await files.folder("chooser",[first.id,second.id]);assert.equal(prepared.files,2);assert.equal(readFileSync(join(prepared.path,"nested","same.txt"),"utf8"),"second");await prepared.cleanup();
  await assert.rejects(files.folder("other",[first.id]),/chooser/);
  const duplicate=await files.stage("chooser","same.txt",body("duplicate"),()=>true,"My folder/SAME.txt");await assert.rejects(files.folder("chooser",[first.id,duplicate.id]),/duplicate/);
  const unrelated=await files.stage("chooser","x",body("x"),()=>true,"Other/x");await assert.rejects(files.folder("chooser",[first.id,unrelated.id]),/one folder/);
  await files.discardChooser("chooser");await assert.rejects(files.folder("chooser",[first.id]),/expired/);
  for(const name of ["linked","git-folder","empty","huge","many"])mkdirSync(join(workspace,name));
  symlinkSync(join(tree,"same.txt"),join(workspace,"linked","secret.txt"));mkdirSync(join(workspace,"git-folder",".git"));
  writeFileSync(join(workspace,"huge","big"),"");truncateSync(join(workspace,"huge","big"),MAX_BROWSER_UPLOAD+1);
  for(let i=0;i<1001;i++)writeFileSync(join(workspace,"many",String(i)),"");
  await assert.rejects(files.agentFolder(workspace,"linked",()=>true),/symbolic/);
  await assert.rejects(files.agentFolder(workspace,"git-folder",()=>true),/internals/);
  await assert.rejects(files.agentFolder(workspace,"empty",()=>true),/no files/);
  await assert.rejects(files.agentFolder(workspace,"huge",()=>true),/100 MB/);
  await assert.rejects(files.agentFolder(workspace,"many",()=>true),/1,000/);
  await assert.rejects(files.agentFolder(workspace,"../",()=>true),/workspace/);
  await assert.rejects(files.agentFolder(workspace,"agent folder",()=>false),/ended/);
  const good=await files.agentFolder(workspace,"agent folder",()=>true);assert.equal(good.files,4);assert.deepEqual(readFileSync(join(good.path,"nested","bytes.bin")),data);await good.cleanup();
  assert.throws(()=>validateAgentTool("browser_upload_folder",{folder:["x"]}),/Invalid/);
  const bridge=new AgentToolBridge(),grant=await bridge.issue({runId:"read",workspace,mode:"read",full:false,signal:new AbortController().signal,active:()=>true});
  try {const response=await fetch(grant.connection.endpoint,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${grant.connection.token}`},body:JSON.stringify({name:"browser_upload_folder",arguments:{folder:"agent folder",ref:"e1"}})});assert.match((await response.json() as any).error,/read-only/);}finally{await bridge.close();await files.close();}
});

test("real Chrome accepts staged and agent folders with exact relative paths through the same chooser",{skip:!chromeExecutable()},async()=>{
  const uploads:Array<{path:string;bytes:Buffer}>=[];let formBody="";
  const site=createServer(async(req,res)=>{const url=new URL(req.url!,"http://fixture");if(url.pathname==="/upload"){const chunks=[];for await(const chunk of req)chunks.push(chunk);uploads.push({path:url.searchParams.get("path")!,bytes:Buffer.concat(chunks)});res.end("ok");return;}
    if(url.pathname==="/posted"){const chunks=[];for await(const chunk of req)chunks.push(chunk);formBody=Buffer.concat(chunks).toString();res.end("Folder form submitted");return;}
    if(url.pathname==="/form"){res.setHeader("content-type","text/html");res.end('<form method="POST" action="/posted" enctype="multipart/form-data"><input name="folder" aria-label="Folder" type="file" webkitdirectory onchange="this.form.submit()"></form>');return;}
    res.setHeader("content-type","text/html");res.end(`<title>Folder fixture</title><input aria-label="Folder" type="file" webkitdirectory onchange="Promise.all([...this.files].map(f=>fetch('/upload?path='+encodeURIComponent(f.webkitRelativePath),{method:'POST',body:f})))"><input aria-label="Files" type="file">`);
  });await new Promise<void>(r=>site.listen(0,"127.0.0.1",r));
  const browser=new AgentBrowser("chrome-folders"),signal=new AbortController().signal;
  const call=(name:string,args={})=>browser.call(name,args,signal,workspace);
  const click=async(name:string)=>{const snapshot=await call("browser_snapshot");return call("browser_click",{ref:snapshot.snapshot.find((item:any)=>item.role==="button"&&item.name===name).ref});};
  try {
    await call("browser_navigate",{url:`http://127.0.0.1:${(site.address() as any).port}`});
    const opened=await click("Folder");assert.equal(opened.chooser.directory,true);const chooser=opened.chooser.id;
    const first=await browser.stageUpload(chooser,"same.txt",body("human root"),"Human folder/same.txt");
    const second=await browser.stageUpload(chooser,"same.txt",body("human nested"),"Human folder/nested/same.txt");
    const binary=await browser.stageUpload(chooser,"binary.bin",body(data),"Human folder/nested/é.bin");
    await call("browser_ui",{action:"upload",chooser,files:[first.id,second.id,binary.id]});await until(()=>uploads.length===3);
    assert.deepEqual(uploads.map(file=>file.path).sort(),["Human folder/same.txt","Human folder/nested/same.txt","Human folder/nested/é.bin"].sort());assert.deepEqual(uploads.find(file=>file.path.endsWith("é.bin"))!.bytes,data);
    const before=uploads.length,agentChooser=(await click("Folder")).chooser;
    await call("browser_upload_folder",{folder:"agent folder",chooser:agentChooser.id});await until(()=>uploads.length===before+4);
    assert.deepEqual(uploads.find(file=>file.path==="agent folder/nested/bytes.bin")!.bytes,data);assert.equal(uploads.find(file=>file.path==="agent folder/empty.txt")!.bytes.length,0);
    const cancel=(await click("Folder")).chooser;const abandoned=await browser.stageUpload(cancel.id,"x",body("x"),"Canceled/x");await call("browser_ui",{action:"cancel-upload",chooser:cancel.id});
    await assert.rejects(call("browser_ui",{action:"upload",chooser:cancel.id,files:[abandoned.id]}),/changed/);
    const ordinary=(await click("Files")).chooser;assert.equal(ordinary.directory,false);await assert.rejects(call("browser_upload_folder",{folder:"agent folder",chooser:ordinary.id}),/folder input/);
    const stale=(await click("Folder")).chooser;await call("browser_tabs",{action:"new"});await assert.rejects(browser.stageUpload(stale.id,"x",body("x"),"Stale/x"),/changed/);
    assert.equal(uploads.length,7);
    await call("browser_navigate",{url:`http://127.0.0.1:${(site.address() as any).port}/form`});
    const formChooser=(await click("Folder")).chooser;
    const formFile=await browser.stageUpload(formChooser.id,"form.txt",body("form bytes"),"Form folder/nested/form.txt");
    await call("browser_ui",{action:"upload",chooser:formChooser.id,files:[formFile.id]});await until(()=>formBody.includes("form bytes"));assert.match(formBody,/Form folder\/nested\/form.txt/);
  }finally{await browser.close();site.closeAllConnections();await new Promise<void>(r=>site.close(()=>r()));}
});
