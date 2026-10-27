import { ActionNotPerformed } from "./agent-action-error.js";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, lstat, mkdir, open, opendir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertProjectFileAccess } from "./filesystem-policy.js";
import { CODEFLOW_HOME } from "./config.js";

export const MAX_BROWSER_UPLOAD = 100 * 1024 * 1024;
export const MAX_BROWSER_FOLDER_FILES = 1000;
export const MAX_BROWSER_FOLDER_BYTES = 500 * 1024 * 1024;
export const MAX_BROWSER_DOWNLOAD = 1024 * 1024 * 1024;
export type BrowserDownload = {id:string;name:string;url:string;state:"inProgress"|"completed"|"canceled";receivedBytes:number;totalBytes:number;startedAt:number;error?:string};
const safeName = (name:string) => basename(name.replace(/\\/g,"/")).replace(/[\x00-\x1f\x7f]/g,"_").slice(0,180).replace(/^\.+$/,"") || "download";

/** Preserve relative names exactly; never normalize away traversal or merge two trees. */
export function browserFolderPath(value:unknown):string {
  if(typeof value!=="string" || value.length>4096 || /[\\:\x00-\x1f\x7f]/.test(value))throw new Error("Invalid folder relative path");
  const parts=value.split("/");
  if(parts.length<2 || parts.length>32 || parts.some(part=>!part || part==="." || part===".." || Buffer.byteLength(part)>255))throw new Error("Invalid folder relative path");
  if(parts.some(part=>part.toLowerCase()===".git"))throw new Error("Choose a folder without .git internals");
  return value;
}

/** Agent transfers never interpret a website-supplied filename as a workspace path. */
export async function browserWorkspacePath(workspace:string|undefined, path:unknown, writing=false, directory=false) {
  if (!workspace) throw new Error("File transfers need a task workspace");
  if (typeof path !== "string" || !path || path.length>4096 || path.includes("\0")) throw new Error("Choose a file in the task workspace");
  const root=await realpath(workspace), absolute=resolve(root,path), rel=relative(root,absolute);
  if (!rel || rel===".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.split(sep).some(part=>part.toLowerCase()===".git")) throw new Error("File transfers must stay inside the task workspace, outside .git");
  let current=root;
  for (const [index,part] of rel.split(sep).entries()) {
    current=join(current,part);
    const info=await lstat(current).catch(error=>{if(writing && index===rel.split(sep).length-1 && error.code==="ENOENT")return undefined;throw error;});
    if(info?.isSymbolicLink()) throw new Error("File transfers cannot follow symbolic links");
    if(info && index<rel.split(sep).length-1 && !info.isDirectory()) throw new Error("Choose an existing workspace folder");
    if(info && index===rel.split(sep).length-1 && !(directory?info.isDirectory():info.isFile())) throw new Error(directory?"Choose a workspace folder":"Choose a regular file");
  }
  await assertProjectFileAccess(root,rel,writing?"write":"read");
  return absolute;
}

export class BrowserFiles {
  readonly root:string;
  readonly downloadDir:string;
  private uploads=new Map<string,{path:string;chooser:string;consumed:boolean;bytes:number;relativePath?:string}>();
  private uploadBytes=0;
  private downloads=new Map<string,BrowserDownload>();
  private ready?:Promise<void>;
  private saving:Promise<void>=Promise.resolve();
  constructor(id:string) {this.root=join(CODEFLOW_HOME,"browser-files",id);this.downloadDir=join(this.root,"downloads");}
  async init() {
    return this.ready ??= (async()=>{
      await mkdir(this.downloadDir,{recursive:true,mode:0o700});
      const saved=await readFile(join(this.root,"downloads.json"),"utf8").catch(()=>"[]");
      try {for(const item of JSON.parse(saved)) if(/^[\w-]{1,80}$/.test(item.id)) {
        if(item.state==="inProgress") {item.state="canceled";item.error="Browser session ended before the download finished";item.receivedBytes=(await stat(join(this.downloadDir,`${item.id}.crdownload`)).catch(()=>undefined))?.size??item.receivedBytes;}
        this.downloads.set(item.id,item);
      }} catch { /* A damaged index cannot authorize arbitrary file reads. */ }
      await rm(join(this.root,"uploads"),{recursive:true,force:true});
    })();
  }
  list() {return [...this.downloads.values()].reverse();}
  private persist() {
    const body=JSON.stringify([...this.downloads.values()]);
    const save=this.saving.catch(()=>{}).then(async()=>{
      const temp=join(this.root,"downloads.json.tmp");await writeFile(temp,body,{mode:0o600});await rename(temp,join(this.root,"downloads.json"));
    });
    this.saving=save;return save;
  }
  async begin(input:{guid:string;suggestedFilename:string;url:string}) {
    if(!/^[\w-]{1,80}$/.test(input.guid)) throw new Error("Invalid download ID");
    if(this.downloads.size>=100 || this.list().reduce((n,item)=>n+item.receivedBytes,0)>=5*MAX_BROWSER_DOWNLOAD)throw new Error("Remove old downloads before starting more (100 files or 5 GB per task)");
    const item:BrowserDownload={id:input.guid,name:safeName(input.suggestedFilename),url:input.url.slice(0,8192),state:"inProgress",receivedBytes:0,totalBytes:0,startedAt:Date.now()};
    this.downloads.set(item.id,item);await this.persist();return item;
  }
  async progress(input:{guid:string;state:BrowserDownload["state"];receivedBytes:number;totalBytes:number}) {
    const item=this.downloads.get(input.guid);if(!item)return;
    item.receivedBytes=input.receivedBytes;item.totalBytes=input.totalBytes;
    if(item.state!=="canceled")item.state=input.state;
    if(Math.max(item.receivedBytes,item.totalBytes)>MAX_BROWSER_DOWNLOAD) {item.state="canceled";item.error="Downloads are limited to 1 GB per file";}
    if(this.list().reduce((n,file)=>n+file.receivedBytes,0)>5*MAX_BROWSER_DOWNLOAD){item.state="canceled";item.error="Task downloads reached 5 GB; remove old downloads to free space";}
    if(item.state!=="inProgress") await this.persist();
    return item;
  }
  async cancel(id:string,error="Canceled") {const item=this.get(id);item.state="canceled";item.error=error;await this.persist();return item;}
  get(id:string) {const item=this.downloads.get(id);if(!item)throw new Error("Unknown download in this task");return item;}
  async downloaded(id:string) {
    const item=this.get(id);if(item.state!=="completed")throw new Error("Wait for the download to finish");
    const path=join(this.downloadDir,item.id),info=await lstat(path);
    if(!info.isFile() || info.isSymbolicLink())throw new Error("Download file is unavailable");
    return {item,path,size:info.size};
  }
  async save(id:string,workspace:string|undefined,destination:unknown) {
    const [source,path]=await Promise.all([this.downloaded(id),browserWorkspacePath(workspace,destination,true)]).catch(error=>{throw new ActionNotPerformed(error.message);});
    await copyFile(source.path,path,constants.COPYFILE_EXCL).catch(error=>{if(error.code==="EEXIST")throw new ActionNotPerformed("Destination already exists; choose another filename");throw error;});
    return {path,bytes:source.size,name:source.item.name};
  }
  async remove(id:string) {
    const item=this.get(id);if(item.state==="inProgress")throw new Error("Cancel this download before removing it");
    await rm(join(this.downloadDir,item.id),{force:true});await rm(join(this.downloadDir,`${item.id}.crdownload`),{force:true});
    this.downloads.delete(id);await this.persist();
  }
  async stage(chooser:string,name:string,source:AsyncIterable<Uint8Array>,active:()=>boolean,relativePath?:string) {
    if(relativePath!==undefined)browserFolderPath(relativePath);
    await this.init();
    if(this.uploads.size>=2000)throw new Error("This browser session has reached its upload limit; restart the app to clear staged files");
    const id=randomUUID(),path=join(this.root,"uploads",id,relativePath?relativePath.split("/").at(-1)!:safeName(name));
    await mkdir(dirname(path),{recursive:true,mode:0o700});
    const file=await open(path,"wx",0o600);let bytes=0;
    try {
      for await(const chunk of source) {
        if(!active())throw new Error("The file chooser changed; select your files again");
        bytes+=chunk.length;this.uploadBytes+=chunk.length;
        if(bytes>MAX_BROWSER_UPLOAD || this.uploadBytes>500*1024*1024)throw new Error("Uploads are limited to 100 MB per file and 500 MB per browser session");
        await file.writeFile(chunk);
      }
      if(!active())throw new Error("The file chooser changed; select your files again");
      this.uploads.set(id,{path,chooser,consumed:false,bytes,relativePath});return {id,name:basename(path),bytes};
    } catch(error) {this.uploadBytes-=bytes;await rm(dirname(path),{recursive:true,force:true});throw error;}
    finally {await file.close();}
  }
  private selection(chooser:string,ids:unknown,folder=false) {
    if(!Array.isArray(ids) || !ids.length || ids.length>(folder?MAX_BROWSER_FOLDER_FILES:20) || new Set(ids).size!==ids.length)throw new Error(folder?"Choose a folder with 1–1,000 files":"Choose between 1 and 20 files");
    return ids.map(id=>{const upload=this.uploads.get(id);if(!upload || upload.chooser!==chooser || upload.consumed)throw new Error("Upload expired or belongs to another file chooser");
      if(!!upload.relativePath!==folder)throw new Error(folder?"Folder uploads need relative paths":"Use a folder input for folder uploads");return upload;});
  }
  staged(chooser:string,ids:unknown) {return this.selection(chooser,ids).map(upload=>upload.path);}
  async folder(chooser:string,ids:unknown) {
    const uploads=this.selection(chooser,ids,true), names=uploads.map(file=>browserFolderPath(file.relativePath));
    const root=names[0]!.split("/")[0]!;
    if(names.some(name=>name.split("/")[0]!==root))throw new Error("Choose one folder at a time");
    if(new Set(names.map(name=>name.normalize("NFC").toLowerCase())).size!==names.length)throw new Error("Folder contains duplicate relative paths");
    const bytes=uploads.reduce((n,file)=>n+file.bytes,0);
    if(bytes>MAX_BROWSER_FOLDER_BYTES)throw new Error("Folders are limited to 500 MB");
    const container=join(this.root,"uploads","folders",randomUUID()),path=join(container,root);
    try {
      for(const [index,file] of uploads.entries()) {
        const target=join(container,names[index]!);await mkdir(dirname(target),{recursive:true,mode:0o700});
        // Link only private staged files. Chrome never recursively reads the original workspace.
        await link(file.path,target);
      }
      return {path,files:uploads.length,bytes,cleanup:()=>rm(container,{recursive:true,force:true})};
    } catch(error) {await rm(container,{recursive:true,force:true});throw error;}
  }
  async discard(ids:string[]) {
    for(const id of ids) {const file=this.uploads.get(id);if(file && !file.consumed){this.uploads.delete(id);this.uploadBytes-=file.bytes;await rm(dirname(file.path),{recursive:true,force:true});}}
  }
  async discardChooser(chooser:string) {await this.discard([...this.uploads].filter(([,file])=>file.chooser===chooser).map(([id])=>id));}
  async agentFolder(workspace:string|undefined,folder:unknown,active:()=>boolean) {
    const root=await browserWorkspacePath(workspace,folder,false,true),files:Array<{path:string;relativePath:string}>=[];
    let bytes=0,entries=0;
    const visit=async(path:string)=>{
      const directory=await opendir(path);
      for await(const entry of directory) {
        if(!active())throw new Error("This browser turn has ended");
        if(++entries>2000)throw new Error("Folder contains too many entries (maximum 2,000)");
        const source=join(path,entry.name),rel=browserFolderPath(`${basename(root)}/${relative(root,source).split(sep).join("/")}`);
        const info=await lstat(source);
        if(info.isSymbolicLink())throw new Error("Folder uploads cannot follow symbolic links");
        await browserWorkspacePath(workspace,source,false,info.isDirectory());
        if(info.isDirectory())await visit(source);
        else {
          if(!info.isFile())throw new Error("Folder uploads require regular files");
          if(info.size>MAX_BROWSER_UPLOAD)throw new Error("Uploads are limited to 100 MB per file");
          bytes+=info.size;
          if(bytes>MAX_BROWSER_FOLDER_BYTES || files.length>=MAX_BROWSER_FOLDER_FILES)throw new Error("Folders are limited to 1,000 files and 500 MB");
          files.push({path:source,relativePath:rel});
        }
      }
    };
    await visit(root);
    if(!files.length)throw new Error("This folder contains no files");
    const chooser=`agent-folder-${randomUUID()}`,ids:string[]=[];
    try {
      for(const file of files) {
        if(!active())throw new Error("This browser turn has ended");
        await browserWorkspacePath(workspace,file.path);
        const handle=await open(file.path,constants.O_RDONLY|constants.O_NOFOLLOW);
        try {
          if(!(await handle.stat()).isFile())throw new Error("Folder uploads require regular files");
          ids.push((await this.stage(chooser,basename(file.path),handle.createReadStream({autoClose:false}),active,file.relativePath)).id);
        } finally {await handle.close();}
      }
      return {...await this.folder(chooser,ids),ids};
    } catch(error) {await this.discard(ids);throw error;}
  }
  consume(ids:string[]) {
    const files=ids.map(id=>{const file=this.uploads.get(id);if(!file || file.consumed)throw new Error("Upload expired or already selected");return file;});
    for(const file of files)file.consumed=true;
  }
  async agentUploads(workspace:string|undefined,paths:unknown) {
    if(!Array.isArray(paths) || paths.length>20 || !paths.length)throw new Error("Choose between 1 and 20 workspace files");
    return Promise.all(paths.map(async path=>{const absolute=await browserWorkspacePath(workspace,path);if((await stat(absolute)).size>MAX_BROWSER_UPLOAD)throw new Error("Uploads are limited to 100 MB per file");return absolute;}));
  }
  async close() {
    await this.ready;
    for(const item of this.downloads.values())if(item.state==="inProgress"){item.state="canceled";item.error="Browser session ended before the download finished";}
    if(this.ready) {await this.persist();await rm(join(this.root,"uploads"),{recursive:true,force:true});}
  }
}
