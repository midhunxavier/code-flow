import { useEffect, useRef, useState } from "preact/hooks";
import { api, apiPath } from "./lib.js";

export type BrowserChooser = {id:string;tab:string;mode:string;directory?:boolean};
export type BrowserDownload = {id:string;name:string;url:string;state:string;receivedBytes:number;totalBytes:number;error?:string};
const size=(bytes:number)=>bytes<1024?`${bytes} B`:bytes<1024*1024?`${(bytes/1024).toFixed(1)} KB`:`${(bytes/1024/1024).toFixed(1)} MB`;

export function BrowserTransfers({scope,chooser,downloads,send}:{scope:string;chooser?:BrowserChooser;downloads:BrowserDownload[];send:(args:Record<string,unknown>)=>Promise<any>}) {
  const [expanded,setExpanded]=useState(false),[busy,setBusy]=useState(""),[error,setError]=useState("");
  const controller=useRef<AbortController>();
  useEffect(()=>{setError("");return ()=>controller.current?.abort();},[chooser?.id]);
  const upload=async(files:File[])=>{
    if(!chooser || !files.length)return;
    const abort=new AbortController();controller.current=abort;
    setError("");
    try {
      if(chooser.directory) {
        if(files.length>1000 || files.reduce((bytes,file)=>bytes+file.size,0)>500*1024*1024)throw new Error("Choose a folder with up to 1,000 files and 500 MB total.");
        if(files.some(file=>!file.webkitRelativePath))throw new Error("This browser did not provide folder paths. Choose a folder again.");
      } else if(files.length>20)throw new Error("Choose up to 20 files.");
      if(files.some(file=>file.size>100*1024*1024))throw new Error("Each file must be under 100 MB.");
      const ids:string[]=[];
      for(const [index,file] of files.entries()) {
        setBusy(`Uploading ${index+1} of ${files.length}: ${file.webkitRelativePath||file.name}`);
        const staged=await api<{id:string}>(`/api/browser/uploads?scope=${encodeURIComponent(scope)}&chooser=${encodeURIComponent(chooser.id)}&name=${encodeURIComponent(file.name)}${chooser.directory?`&relativePath=${encodeURIComponent(file.webkitRelativePath)}`:""}`,{method:"POST",headers:{"content-type":"application/octet-stream"},body:file,signal:abort.signal});
        ids.push(staged.id);
      }
      await send({action:"upload",chooser:chooser.id,files:ids});
    } catch(error) {if(!abort.signal.aborted)setError((error as Error).message);}
    finally {setBusy("");}
  };
  const action=(action:string,id:string)=>void send({action,id}).catch(error=>setError(error.message));
  return <section class="browser-transfers" aria-label="Browser file transfers">
    {chooser ? <div class="browser-upload" aria-label="Website file upload">
      <div><strong>{chooser.directory?"Choose a folder for this website":"Choose files for this website"}</strong><span class="help">{chooser.directory?"Up to 1,000 files · 500 MB total · 100 MB per file":`${chooser.mode==="selectMultiple"?"Multiple files allowed":"One file"} · up to 100 MB each`}</span></div>
      <label class={`btn small${busy?" disabled":""}`}>Choose {chooser.directory?"folder":chooser.mode==="selectMultiple"?"files":"file"}<input key={chooser.id} type="file" aria-label={chooser.directory?"Upload folder to website":"Upload files to website"} {...(chooser.directory?{webkitdirectory:true}:{})} multiple={!chooser.directory && chooser.mode==="selectMultiple"} disabled={!!busy} onChange={event=>{const files=Array.from(event.currentTarget.files??[]);event.currentTarget.value="";void upload(files);}} /></label>
      <button class="btn small" onClick={()=>{controller.current?.abort();void send({action:"cancel-upload",chooser:chooser.id}).catch(error=>setError(error.message));}}>Cancel</button>
      {busy ? <span class="help" role="status">{busy}</span>:null}
    </div>:null}
    <button class="browser-download-toggle" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}><span aria-hidden="true">{expanded?"▾":"▸"} ↓</span> Downloads <span class="help">{downloads.length}{downloads.some(file=>file.state==="inProgress")?" · downloading…":""}</span></button>
    {expanded ? <div class="browser-downloads" aria-label="Downloads">
      {!downloads.length?<p class="help">Files you or an agent download will appear here.</p>:downloads.map(file=><div class="browser-download" key={file.id} data-download-id={file.id}>
        <div class="browser-download-info"><strong title={file.name}>{file.name}</strong><span class="help">{file.error || (file.state==="completed"?size(file.receivedBytes):file.state==="canceled"?"Canceled":`${size(file.receivedBytes)}${file.totalBytes?` of ${size(file.totalBytes)}`:""}`)}</span>{file.state==="inProgress"?<progress aria-label={`Downloading ${file.name}`} max={file.totalBytes||undefined} value={file.totalBytes?file.receivedBytes:undefined}/>:null}</div>
        {file.state==="completed"?<a class="btn small" href={apiPath(`/api/browser/downloads/${encodeURIComponent(file.id)}?scope=${encodeURIComponent(scope)}`)} download={file.name} aria-label={`Save ${file.name}`}>Save</a>:null}
        <button class="icon-btn" title={file.state==="inProgress"?"Cancel download":"Remove download"} aria-label={`${file.state==="inProgress"?"Cancel":"Remove"} ${file.name}`} onClick={()=>action(file.state==="inProgress"?"cancel-download":"remove-download",file.id)}>×</button>
      </div>)}
    </div>:null}
    {error?<div class="msg err" role="alert">{error}</div>:null}
  </section>;
}
