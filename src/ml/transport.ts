import { spawn } from "node:child_process";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SshTransport } from "../ssh-projects/transport.js";
import { hash, syncDir } from "../training-worker/files.js";
import { digest, InferenceInputError, type Target } from "./model.js";
interface Bundle { protocol: 1; version: string; files: Record<string, string> }
const legacyNames = ["worker.mjs", "recipe.py", "predict.py", "requirements.txt"];
const llmNames = [...legacyNames, "llm_recipe.py", "llm_predict.py", "llm_requirements.txt"];
const servingNames = [...llmNames, "inference.py"];
const names = [...servingNames, "holdout.py"];
export async function loadBundle(path = fileURLToPath(new URL("../../dist/training-worker.json", import.meta.url))): Promise<Bundle> {
  // In the packaged backend import.meta.url is src/server.mjs.
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch { text = await readFile(fileURLToPath(new URL("../dist/training-worker.json", import.meta.url)), "utf8"); }
  const b = JSON.parse(text) as Bundle;
  if (b.protocol !== 1 || ![names.join(), servingNames.join(), llmNames.join(), legacyNames.join()].includes(Object.keys(b.files).join()) || hash(JSON.stringify(b.files)) !== digest(b.version)) throw new Error("Training-worker package is invalid; rebuild it");
  return b;
}
// Fixed bootstrap; user paths and credentials travel only through bounded structured stdin.
const bootstrap = `
const {readFile,mkdir,open,rename}=await import('node:fs/promises');
const {join,resolve,isAbsolute}=await import('node:path');
const {homedir}=await import('node:os');
const {createHash,randomUUID}=await import('node:crypto');
const {pathToFileURL}=await import('node:url');
let body='';for await(const chunk of process.stdin){body+=chunk;if(body.length>2097152)throw Error('Request too large');}
const input=JSON.parse(body);let root=input.root.startsWith('~/')?join(homedir(),input.root.slice(2)):input.root;
if(!isAbsolute(root)||root==='/'||root===homedir())throw Error('Invalid worker directory');root=resolve(root);
const version=input.bundle?.version??input.version;if(!/^[a-f0-9]{64}$/.test(version))throw Error('Invalid bundle version');
const folder=join(root,'bundles',version);
const legacy=['worker.mjs','recipe.py','predict.py','requirements.txt'],llm=[...legacy,'llm_recipe.py','llm_predict.py','llm_requirements.txt'],serving=[...llm,'inference.py'],current=[...serving,'holdout.py'];
let names=input.bundle?Object.keys(input.bundle.files):legacy;
if(!input.bundle){try{await readFile(join(folder,'llm_recipe.py'));names=llm;try{await readFile(join(folder,'inference.py'));names=serving;try{await readFile(join(folder,'holdout.py'));names=current}catch(e){if(e.code!=='ENOENT')throw e}}catch(e){if(e.code!=='ENOENT')throw e}}catch(e){if(e.code!=='ENOENT')throw e}}
if(input.bundle){const b=input.bundle;if(b.protocol!==1||![legacy.join(),llm.join(),serving.join(),current.join()].includes(names.join())||createHash('sha256').update(JSON.stringify(b.files)).digest('hex')!==version)throw Error('Invalid bundle');await mkdir(folder,{recursive:true,mode:448});for(const name of names){const path=join(folder,name);let prior;try{prior=await readFile(path,'utf8')}catch(e){if(e.code!=='ENOENT')throw e}if(prior!==undefined&&prior!==b.files[name])throw Error('Installed bundle changed');if(prior===undefined){const temporary=path+'.'+randomUUID();const fd=await open(temporary,'wx',384);try{await fd.writeFile(b.files[name]);await fd.sync()}finally{await fd.close()}await rename(temporary,path)}}}
const installed={};for(const name of names)installed[name]=await readFile(join(folder,name),'utf8');if(createHash('sha256').update(JSON.stringify(installed)).digest('hex')!==version)throw Error('Installed bundle changed');
if(input.bundle){const fd=await open(folder,'r');try{await fd.sync()}finally{await fd.close()}}
const worker=await import(pathToFileURL(join(folder,'worker.mjs')).href);
try{process.stdout.write(JSON.stringify({ok:true,result:await worker.control(root,input.request)}))}catch(e){process.stdout.write(JSON.stringify({ok:false,error:e.message,...(e.name==='InferenceInputError'?{kind:'input'}:{})}));}
`;
export interface WorkerClient { call<T = any>(target: Target, request: Record<string, unknown>, enroll?: boolean): Promise<T>; close(): Promise<void> }
export class TrainingTransport implements WorkerClient {
  private transports = new Map<string, SshTransport>();
  constructor(private bundlePath?: string, private sshBinary = "ssh") {}
  async call<T>(target: Target, request: Record<string, unknown>, enroll = false): Promise<T> {
    const bundle = enroll ? await loadBundle(this.bundlePath) : undefined;
    const version = bundle?.version ?? digest(target.bundle);
    let output: string;
    if (target.kind === "ssh") {
      let transport = this.transports.get(target.id);
      if (!transport) { transport = new SshTransport(target.host!, this.sshBinary); await transport.init(); this.transports.set(target.id, transport); }
      output = await transport.bootstrap(bootstrap, JSON.stringify({ root: target.directory, version, ...(bundle ? { bundle } : {}), request }), false, 1024 * 1024);
    } else {
      const folder = join(target.directory, "bundles", version);
      if (bundle) {
        await mkdir(folder, { recursive: true, mode: 0o700 });
        for (const name of Object.keys(bundle.files)) {
          const path = join(folder, name), prior = await readFile(path, "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; });
          if (prior !== undefined && prior !== bundle.files[name]) throw new Error("Installed training bundle changed");
          if (prior === undefined) { const temp = path + "." + randomUUID(); const fd = await open(temp, "wx", 0o600); try { await fd.writeFile(bundle.files[name]!); await fd.sync(); } finally { await fd.close(); } await rename(temp, path); }
        }
      }
      const installed: Record<string, string> = {};
      const installedNames = await readFile(join(folder, "llm_recipe.py")).then(() => readFile(join(folder, "inference.py")).then(() => readFile(join(folder, "holdout.py")).then(() => names, (e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; return servingNames; }), (e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; return llmNames; }), (e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; return legacyNames; });
      for (const name of installedNames) installed[name] = await readFile(join(folder, name), "utf8");
      if (hash(JSON.stringify(installed)) !== version) throw new Error("Installed training bundle changed");
      if (bundle) await syncDir(folder);
      output = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, [join(folder, "worker.mjs"), "control", target.directory], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: process.env.HOME } });
        let data = "", error = "", settled = false;
        const finish = (failure?: Error) => { if (settled) return; settled = true; clearTimeout(timer); failure ? reject(failure) : resolve(data); };
        const timer = setTimeout(() => { child.kill(); finish(new Error("Worker response timed out; inspect the same job before retrying")); }, 120000);
        child.stdout.on("data", chunk => { data += chunk; if (data.length > 1024 * 1024) { child.kill(); finish(new Error("Worker response exceeds limit")); } });
        child.stderr.on("data", chunk => { error = (error + chunk).slice(-4000); });
        child.once("error", finish); child.once("close", code => finish(code && !data ? new Error(error || `Worker exited ${code}`) : undefined));
        child.stdin.on("error", () => {}); child.stdin.end(JSON.stringify(request));
      });
    }
    const result = JSON.parse(output);
    if (result.ok !== true) { if (result.kind === "input") throw new InferenceInputError(result.error); throw new Error(result.error || "Training worker rejected the request"); }
    return result.result;
  }
  async close() { await Promise.all([...this.transports.values()].map(t => t.close())); this.transports.clear(); }
}
