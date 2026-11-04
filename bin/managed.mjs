// Shared, dependency-free launcher for desktop and project MCP connections.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
const exec = promisify(execFile);
export const PACKAGE = '@midhunxavier/code-flow';
const REGISTRY = 'https://registry.npmjs.org';
const INTERVAL = 6 * 60 * 60 * 1000;
const base = home => join(resolve(home), 'integration-runtime');
const read = async path => JSON.parse(await readFile(path, 'utf8'));
export async function updateState(home) {
  try { const s = await read(join(base(home), 'state.json')); if (s.schema !== 1 || !s.seed || !s.current || !Array.isArray(s.releases)) throw new Error('Invalid managed runtime state'); return s; }
  catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
}
async function atomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try { await writeFile(temp, value, { mode: 0o600, flag: 'wx' }); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}
const save = (home, state) => atomic(join(base(home), 'state.json'), JSON.stringify(state, null, 2)+'\n');
export function alive(pid) { if (!Number.isInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch(e) { return e.code !== 'ESRCH'; } }
export async function updateLock(home, waitMs = 15000, name = 'update.lock') {
  const path = join(base(home), name); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const value = JSON.stringify({ pid: process.pid, nonce: randomBytes(12).toString('hex') });
  const start = Date.now();
  while (true) {
    try { await writeFile(path, value, { flag: 'wx', mode: 0o600 }); break; }
    catch(e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const old = await readFile(path, 'utf8'), lock = JSON.parse(old);
        if (!alive(lock.pid)) {
          // Serialize stale-lock recovery: a delayed contender must never unlink
          // a new owner's lock after another contender reclaimed the old one.
          const guard=path+'.reclaim';
          await writeFile(guard,value,{flag:'wx',mode:0o600});
          try {if(await readFile(path,'utf8').catch(()=>undefined)===old&&!alive(lock.pid))await rm(path);}
          finally {await rm(guard,{force:true});}
          continue;
        }
      } catch {}
      if (Date.now()-start >= waitMs) throw new Error('Shared runtime is busy; retry shortly');
      await new Promise(r => setTimeout(r, 100));
    }
  }
  return async () => { if (await readFile(path, 'utf8').catch(()=>undefined) === value) await rm(path, { force: true }); };
}
export async function managedLauncher(home) {
  const state = await updateState(home); if (!state) return undefined;
  const launcher = join(base(home), 'launcher.mjs'); await access(launcher); return launcher;
}
async function files(root, prefix = '') {
  const result = [];
  for (const entry of (await readdir(join(root,prefix), {withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    const name = join(prefix,entry.name); if (entry.isSymbolicLink()) throw new Error('Managed releases must not contain symbolic links');
    if (entry.isDirectory()) result.push(...await files(root,name)); else if (entry.isFile()) result.push(name); else throw new Error('Unsupported release entry');
  }
  return result;
}
async function validate(root, expectedVersion) {
  const pkg = await read(join(root,'package.json'));
  if (pkg.name !== PACKAGE || pkg.codeflow?.managedRuntime !== 1 || !version(pkg.version) || expectedVersion && pkg.version !== expectedVersion || Object.keys(pkg.dependencies??{}).length || Object.keys(pkg.optionalDependencies??{}).length) throw new Error('Release does not support the managed MCP runtime protocol');
  for (const p of ['bin/codeflow.mjs','bin/managed.mjs','src/server.js','src/cli-teams/cli.js','src/cli-teams/mcp.js','integrations/cli-teams/SKILL.md']) await access(join(root,p));
  const {stdout} = await exec(process.execPath,[join(root,'bin/codeflow.mjs'),'--version'],{timeout:15000,env:{...process.env,CODEFLOW_MANAGED_CHILD:'1'}});
  if (stdout.trim() !== pkg.version) throw new Error('Release startup validation failed');
  const probeHome = await mkdtemp(join(tmpdir(),'codeflow-release-check-'));
  try {
    // Import the MCP graph without starting a backend, worker or provider call.
    await exec(process.execPath,['--input-type=module','-e',"const m=await import(process.argv[1]);if(typeof m.serveMcp!=='function')process.exit(1)",pathToFileURL(join(root,'src/cli-teams/mcp.js')).href],{timeout:15000,env:{...process.env,CODEFLOW_HOME:probeHome,CODEFLOW_MANAGED_CHILD:'1'}});
  } finally {await rm(probeHome,{recursive:true,force:true});}
  return pkg;
}
async function stage(home, source, expectedVersion) {
  const pkg = await validate(source,expectedVersion), names = await files(source), hash = createHash('sha256');
  for (const name of names) {hash.update(name+'\0');hash.update(await readFile(join(source,name)));}
  const id = `${pkg.version}-${hash.digest('hex').slice(0,16)}`, root = join(base(home),'releases',id);
  try { await access(root); } catch {
    const temp = root+'.'+randomBytes(8).toString('hex')+'.tmp';
    await mkdir(dirname(root),{recursive:true,mode:0o700});
    try { await cp(source,temp,{recursive:true,errorOnExist:true,force:false}); await validate(temp,pkg.version); await rename(temp,root); }
    finally {await rm(temp,{recursive:true,force:true});}
  }
  return {id,root,version:pkg.version,installedAt:Date.now()};
}
export async function enableUpdates(home, source, channel='preview') {
  if (!['preview','latest'].includes(channel)) throw new Error('Choose channel preview or latest');
  const release = await updateLock(home);
  try {
    let state=await updateState(home);
    const seed=await stage(home,await realpath(source));
    state ??= {schema:1,seed:seed.id,current:seed.id,releases:[]};
    if (!state.releases.some(r=>r.id===seed.id))state.releases.push(seed);
    // Explicit installation adopts the local build; network checks never downgrade it.
    state.current=seed.id; state.enabled=true; state.channel=channel; state.lastChecked=0;
    await atomic(join(base(home),'launcher.mjs'), `#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const home=${JSON.stringify(resolve(home))};
const state=JSON.parse(await readFile(${JSON.stringify(join(base(home),'state.json'))},'utf8'));
const selected=state.releases.find(r=>r.id===state.current);
const {runManaged}=await import(pathToFileURL(selected.root+'/bin/managed.mjs'));
runManaged(process.argv.slice(2),home).catch(e=>{console.error('Code Flow update: '+e.message);process.exitCode=1;});
`);
    await chmod(join(base(home),'launcher.mjs'),0o700);
    await save(home,state);return state;
  } finally {await release();}
}
function version(v) {return typeof v==='string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.test(v);}
export function newer(a,b) {
  if(!version(a)||!version(b))return false;
  const [,ac,ap]=/^(\d+\.\d+\.\d+)(?:-(.*))?$/.exec(a),[,bc,bp]=/^(\d+\.\d+\.\d+)(?:-(.*))?$/.exec(b); const aa=ac.split('.').map(Number),bb=bc.split('.').map(Number);
  for(let i=0;i<3;i++)if(aa[i]!==bb[i])return aa[i]>bb[i];
  if(ap===undefined||bp===undefined)return ap===undefined&&bp!==undefined;
  const x=ap.split('.'),y=bp.split('.');for(let i=0;i<Math.max(x.length,y.length);i++){if(x[i]===undefined)return false;if(y[i]===undefined)return true;if(x[i]===y[i])continue;const xn=/^\d+$/.test(x[i]),yn=/^\d+$/.test(y[i]);return xn&&yn?Number(x[i])>Number(y[i]):xn!==yn?!xn:x[i]>y[i];}return false;
}
export async function checkUpdates(home, force=false, options={}) {
  // Network and unpacking hold a separate lock: hosts can still start while offline.
  const release=await updateLock(home,force?15000:0,'check.lock');
  let stageDir, original;
  const change=async operation=>{const unlock=await updateLock(home);try{const state=await updateState(home);return await operation(state);}finally{await unlock();}};
  try {
    original=await change(async state=>{
      if(!state)throw new Error('Enable shared updates first');
      if(!state.enabled||!force&&Date.now()-(state.lastChecked??0)<INTERVAL)return;
      state.lastChecked=Date.now();delete state.error;await save(home,state);return state;
    });
    if(!original)return await updateState(home);
    const fetcher=options.fetch??fetch;
    const response=await fetcher(`${REGISTRY}/${encodeURIComponent(PACKAGE)}/${original.channel}`,{redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error(`Release registry returned ${response.status}`);
    const metadata=await response.json(),current=original.releases.find(r=>r.id===original.current);
    if(metadata.name!==PACKAGE||!version(metadata.version))throw new Error('Invalid release metadata');
    if(!newer(metadata.version,current.version))return await updateState(home);
    if(metadata.codeflow?.managedRuntime!==1||Object.keys(metadata.dependencies??{}).length||Object.keys(metadata.optionalDependencies??{}).length||!/^sha512-[A-Za-z0-9+/]+=*$/.test(metadata.dist?.integrity??''))throw new Error('Published release lacks compatible runtime metadata or integrity');
    const tarball=new URL(metadata.dist.tarball);if(tarball.protocol!=='https:'||tarball.hostname!=='registry.npmjs.org'||tarball.username||tarball.password)throw new Error('Release tarball must come from the official npm registry');
    stageDir=join(base(home),'download-'+randomBytes(8).toString('hex'));await mkdir(stageDir,{mode:0o700});
    const download=await fetcher(tarball.href,{redirect:'error',signal:AbortSignal.timeout(120000)});if(!download.ok)throw new Error(`Release download returned ${download.status}`);
    const chunks=[];let size=0;for await(const chunk of download.body){size+=chunk.length;if(size>200*1024*1024)throw new Error('Release exceeds download limit');chunks.push(chunk);}
    const bytes=Buffer.concat(chunks);if('sha512-'+createHash('sha512').update(bytes).digest('base64')!==metadata.dist.integrity)throw new Error('Release integrity check failed');
    const archive=join(stageDir,'release.tgz');await writeFile(archive,bytes,{mode:0o600});
    // Offline installation forbids extra network dependencies; lifecycle scripts never run.
    await (options.install??(async()=>exec('npm',['install','--prefix',stageDir,'--ignore-scripts','--offline','--no-audit','--no-fund','--package-lock=false',archive],{cwd:stageDir,timeout:120000,maxBuffer:1024*1024})))(stageDir,archive);
    const next=await stage(home,join(stageDir,'node_modules',PACKAGE),metadata.version);
    return await change(async state=>{
      if(!state.enabled||state.channel!==original.channel)return state;
      const now=state.releases.find(r=>r.id===state.current);if(!newer(next.version,now.version))return state;
      if(!state.releases.some(r=>r.id===next.id))state.releases.push(next);
      state.previous=state.current;state.current=next.id;delete state.error;await save(home,state);return state;
    });
  } catch(e) {
    if(original)await change(async state=>{state.error=String(e.message).slice(0,500);await save(home,state);});
    if(force)throw e;return await updateState(home);
  } finally {if(stageDir)await rm(stageDir,{recursive:true,force:true});await release();}
}
export async function configureUpdates(home, enabled) {const unlock=await updateLock(home);try{const state=await updateState(home);if(!state)throw new Error('Enable shared updates first');state.enabled=enabled;await save(home,state);return state;}finally{await unlock();}}
async function sessions(home) {
  const dir=join(base(home),'sessions');await mkdir(dir,{recursive:true,mode:0o700});const active=[];
  for(const file of await readdir(dir)){const path=join(dir,file);try{const session=await read(path);if(alive(session.pid))active.push(session);else await rm(path);}catch(e){if(e.code!=='ENOENT')throw new Error('Cannot establish managed session safety');}}
  return active;
}
async function owner(home) {
  try {const r=await read(join(home,'cli-teams-runtime.json'));return alive(r.pid)?r:undefined;}catch(e){if(e.code==='ENOENT')return;throw new Error('Cannot establish backend ownership; retaining installed release');}
}
export async function updateStatus(home) {
  const state=await updateState(home);if(!state)return {enabled:false,installed:false};
  const runtime=await owner(home),active=await sessions(home);
  return {...state,installed:true,activeSessions:active.length,backend:runtime?{pid:runtime.pid,releaseRoot:runtime.releaseRoot??null}:null,pending:!!runtime&&runtime.releaseRoot!==state.releases.find(r=>r.id===state.current)?.root||active.some(s=>s.root!==state.releases.find(r=>r.id===state.current)?.root)};
}
export async function claimSession(home) {
  const unlock=await updateLock(home);
  try {
    const state=await updateState(home);if(!state)throw new Error('Managed runtime is not configured');
    const active=await sessions(home),runtime=await owner(home);
    // Same backend generation for all hosts, even during concurrent startup.
    const pinned=runtime?.releaseRoot??active[0]?.root;
    const selected=pinned?state.releases.find(r=>r.root===pinned):state.releases.find(r=>r.id===(runtime?state.seed:state.current));
    if(!selected)throw new Error('Running backend uses an unknown release; wait for it to exit');
    await access(join(selected.root,'bin/codeflow.mjs'));
    const path=join(base(home),'sessions',`${process.pid}-${randomBytes(8).toString('hex')}.json`);
    await atomic(path,JSON.stringify({pid:process.pid,root:selected.root}));
    return {root:selected.root,close:()=>rm(path,{force:true})};
  } finally {await unlock();}
}
// Called only by a managed headless owner. The lock excludes new MCP sessions
// until that owner exits. Never signal another process or infer idle from JSONL.
export async function retireManagedOwner(home, root, idleStop) {
  const unlock=await updateLock(home,0);let claimed=false;
  try {
    const state=await updateState(home);if(!state||state.releases.find(r=>r.id===state.current)?.root===root||(await sessions(home)).length)return false;
    const runtime=await owner(home);if(runtime?.pid!==process.pid||runtime.releaseRoot!==root)return false;
    if(!await idleStop(state.releases.find(r=>r.id===state.current).root))return false;
    // idleStop has atomically closed admission and initiated graceful exit.
    // Retain the lock; the next launcher recovers it after this PID exits.
    claimed=true;return true;
  } finally {if(!claimed)await unlock();}
}
export async function runManaged(args,home) {
  if(args[0]==='--check-updates'){await checkUpdates(home);return;}
  if(args[0]==='--handover'){
    const old=Number(args[1]);if(!Number.isInteger(old)||old<1)throw new Error('Invalid handover owner');
    const deadline=Date.now()+120000;
    while(alive(old)){if(Date.now()>deadline)throw new Error('Old owner has not exited; handover deferred');await new Promise(r=>setTimeout(r,200));}
    const unlock=await updateLock(home);
    try {
      if(await owner(home))return;
      const state=await updateState(home),selected=state.releases.find(r=>r.id===state.current);
      const child=spawn(process.execPath,[join(selected.root,'src/server.js')],{detached:true,stdio:'ignore',env:{...process.env,CODEFLOW_HOME:resolve(home),CODEFLOW_MANAGED_RELEASE:selected.root,CODEFLOW_CLI_HEADLESS:'1'}});child.unref();
      let error;child.once('error',e=>{error=e;});
      for(let i=0;i<200;i++){if(error)throw error;if(await owner(home))return;await new Promise(r=>setTimeout(r,100));}
      throw new Error('Updated owner did not become ready; next host connection will retry');
    } finally {await unlock();}
  }
  // Configuration commands use the selected release without pinning the backend.
  const state=['updates','desktop','init','uninstall','terminal','--help','--version'].includes(args[0])?await updateState(home):undefined;
  const session=state?{root:state.releases.find(r=>r.id===state.current).root,close:async()=>{}}:await claimSession(home);
  const requestCheck=()=>{const child=spawn(process.execPath,[join(base(home),'launcher.mjs'),'--check-updates'],{detached:true,stdio:'ignore',env:{...process.env,CODEFLOW_HOME:home}});child.on('error',()=>{});child.unref();};
  const autoCheck=args[0]==='mcp'||args[0]==='start'||args.length===0;
  if(autoCheck)requestCheck();const timer=autoCheck?setInterval(requestCheck,INTERVAL).unref():undefined;
  const child=spawn(process.execPath,[join(session.root,'bin/codeflow.mjs'),...args],{stdio:'inherit',env:{...process.env,CODEFLOW_HOME:resolve(home),CODEFLOW_MANAGED_CHILD:'1',CODEFLOW_MANAGED_RELEASE:session.root}});
  const handlers=['SIGINT','SIGTERM','SIGHUP'].map(s=>{const f=()=>child.kill(s);process.on(s,f);return[s,f];});
  try {await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{process.exitCode=code??(signal==='SIGINT'?130:1);resolve();});});}
  finally{clearInterval(timer);for(const[s,f]of handlers)process.off(s,f);await session.close();}
}
