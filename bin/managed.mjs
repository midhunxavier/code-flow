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
  const {stdout} = await exec(process.execPath,[join(root,'bin/codeflow.mjs'),'--version'],{cwd:root,timeout:15000,env:{...process.env,CODEFLOW_MANAGED_CHILD:'1'}});
  if (stdout.trim() !== pkg.version) throw new Error('Release startup validation failed');
  const probeHome = await mkdtemp(join(tmpdir(),'codeflow-release-check-'));
  try {
    // Import the MCP graph without starting a backend, worker or provider call.
    await exec(process.execPath,['--input-type=module','-e',"const m=await import(process.argv[1]);if(typeof m.serveMcp!=='function')process.exit(1)",pathToFileURL(join(root,'src/cli-teams/mcp.js')).href],{cwd:root,timeout:15000,env:{...process.env,CODEFLOW_HOME:probeHome,CODEFLOW_MANAGED_CHILD:'1'}});
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
const releaseOf=(state,root)=>state.releases.find(r=>r.root===root)?.id??null;
const waitFile=home=>join(base(home),'handover-wait.json');
export async function updateStatus(home) {
  const state=await updateState(home);if(!state)return {enabled:false,installed:false};
  const runtime=await owner(home),active=await sessions(home),selected=state.releases.find(r=>r.id===state.current)?.root;
  const wait=runtime?await read(waitFile(home)).catch(()=>undefined):undefined;
  const backend=runtime?{pid:runtime.pid,releaseRoot:runtime.releaseRoot??null,release:runtime.releaseRoot?releaseOf(state,runtime.releaseRoot):null}:null;
  // A backend started outside the managed runtime is never replaced; sessions still follow the selected release.
  const waiting=backend?.releaseRoot&&backend.releaseRoot!==selected&&wait?.pid===runtime.pid&&typeof wait.reason==='string'?wait.reason:undefined;
  return {...state,installed:true,activeSessions:active.length,sessions:active.map(s=>({pid:s.pid,release:releaseOf(state,s.root)})),backend,
    pending:!!runtime&&runtime.releaseRoot!==selected||active.some(s=>s.root!==selected),...(waiting?{waiting}:{})};
}
/** Each host session records the release it runs; it moves to the backend's release when that changes. */
export async function claimSession(home) {
  const unlock=await updateLock(home);
  try {
    const state=await updateState(home);if(!state)throw new Error('Managed runtime is not configured');
    const runtime=await owner(home);
    // Sessions use the running backend's release so tools match it; with no backend, the selected release.
    // A backend started outside the managed runtime keeps the retained seed.
    const selected=runtime?state.releases.find(r=>r.root===(runtime.releaseRoot??state.releases.find(x=>x.id===state.seed)?.root)):state.releases.find(r=>r.id===state.current);
    if(!selected)throw new Error('Running backend uses an unknown release; wait for it to exit');
    await access(join(selected.root,'bin/codeflow.mjs'));
    const path=join(base(home),'sessions',`${process.pid}-${randomBytes(8).toString('hex')}.json`);
    await atomic(path,JSON.stringify({pid:process.pid,root:selected.root}));
    return {root:selected.root,move:root=>atomic(path,JSON.stringify({pid:process.pid,root})),close:()=>rm(path,{force:true})};
  } finally {await unlock();}
}
// Called only by a managed headless owner. The lock excludes new MCP sessions
// until that owner exits. Never signal another process or infer idle from JSONL.
// Connected sessions and open browser tabs do not hold the update: they reconnect to the
// successor, which keeps this owner's port and sign-in. Only running work does.
// idleStop returns true once it has closed admission and begun exiting, or a reason it cannot yet.
export async function retireManagedOwner(home, root, idleStop) {
  const unlock=await updateLock(home,0);let claimed=false;
  try {
    const state=await updateState(home);if(!state||state.releases.find(r=>r.id===state.current)?.root===root){await rm(waitFile(home),{force:true});return false;}
    const runtime=await owner(home);if(runtime?.pid!==process.pid||runtime.releaseRoot!==root)return false;
    // On success idleStop has also written handover-<pid>.json (port and sign-in) for the successor.
    const result=await idleStop(state.releases.find(r=>r.id===state.current).root);
    if(result!==true){
      const reason=typeof result==='string'?result:'work is still running',old=await read(waitFile(home)).catch(()=>undefined);
      if(old?.pid!==process.pid||old.reason!==reason)await atomic(waitFile(home),JSON.stringify({pid:process.pid,reason,since:old?.pid===process.pid&&old.reason===reason?old.since:Date.now()}));
      return false;
    }
    await rm(waitFile(home),{force:true});
    // idleStop has atomically closed admission and initiated graceful exit.
    // Retain the lock; the next launcher recovers it after this PID exits.
    claimed=true;return true;
  } finally {if(!claimed)await unlock();}
}
/** The port a retiring owner passes on. Its sign-in stays in the file, which the successor reads and removes. */
async function handoverPort(path) {
  try {const {port}=await read(path);return Number.isInteger(port)&&port>0&&port<65536?port:undefined;}catch{return;}
}
export async function runManaged(args,home) {
  if(args[0]==='--check-updates'){await checkUpdates(home);return;}
  if(args[0]==='--handover'){
    const old=Number(args[1]);if(!Number.isInteger(old)||old<1)throw new Error('Invalid handover owner');
    const file=join(base(home),`handover-${old}.json`),deadline=Date.now()+120000;
    try {
    while(alive(old)){if(Date.now()>deadline)throw new Error('Old owner has not exited; handover deferred');await new Promise(r=>setTimeout(r,200));}
    const unlock=await updateLock(home);
    try {
      if(await owner(home))return;
      const state=await updateState(home),selected=state.releases.find(r=>r.id===state.current);
      // Same port and sign-in, so open tabs keep working once the successor answers.
      const port=await handoverPort(file),env={...process.env};delete env.CODEFLOW_HANDOVER_FILE;
      if(port){env.PORT=String(port);env.CODEFLOW_HANDOVER_FILE=file;}
      // Background processes start in Code Flow's own folder, never a project folder that may be moved or deleted.
      const child=spawn(process.execPath,[join(selected.root,'src/server.js')],{cwd:resolve(home),detached:true,stdio:'ignore',env:{...env,CODEFLOW_HOME:resolve(home),CODEFLOW_MANAGED_RELEASE:selected.root,CODEFLOW_CLI_HEADLESS:'1'}});child.unref();
      let error;child.once('error',e=>{error=e;});
      for(let i=0;i<200;i++){if(error)throw error;if(await owner(home))return;await new Promise(r=>setTimeout(r,100));}
      throw new Error('Updated owner did not become ready; next host connection will retry');
    } finally {await unlock();}
    } finally {await rm(file,{force:true});}
  }
  // Configuration commands use the selected release without pinning the backend.
  const state=['updates','desktop','init','uninstall','terminal','--help','--version'].includes(args[0])?await updateState(home):undefined;
  const session=state?{root:state.releases.find(r=>r.id===state.current).root,close:async()=>{}}:await claimSession(home);
  const requestCheck=()=>{const child=spawn(process.execPath,[join(base(home),'launcher.mjs'),'--check-updates'],{cwd:resolve(home),detached:true,stdio:'ignore',env:{...process.env,CODEFLOW_HOME:home}});child.on('error',()=>{});child.unref();};
  const autoCheck=args[0]==='mcp'||args[0]==='start'||args.length===0;
  if(autoCheck)requestCheck();const timer=autoCheck?setInterval(requestCheck,INTERVAL).unref():undefined;
  if(args[0]==='mcp'&&session.move){try{await serveMcpSession(args,home,session);}finally{clearInterval(timer);await session.close();}return;}
  const child=spawn(process.execPath,[join(session.root,'bin/codeflow.mjs'),...args],{stdio:'inherit',env:{...process.env,CODEFLOW_HOME:resolve(home),CODEFLOW_MANAGED_CHILD:'1',CODEFLOW_MANAGED_RELEASE:session.root}});
  const handlers=['SIGINT','SIGTERM','SIGHUP'].map(s=>{const f=()=>child.kill(s);process.on(s,f);return[s,f];});
  try {await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{process.exitCode=code??(signal==='SIGINT'?130:1);resolve();});});}
  finally{clearInterval(timer);for(const[s,f]of handlers)process.off(s,f);await session.close();}
}
/**
 * A host's MCP session follows the backend to a new release without the host reconnecting.
 * This launcher sits between the host and the release's MCP server. Once the backend runs a newer
 * release and no request is open in either direction, it starts that release, repeats the host's
 * handshake to it, retires the old server and tells the host the tool list may have changed.
 * A failed switch keeps the session on its current release.
 */
export async function serveMcpSession(args,home,session,{interval=3000}={}) {
  const fromHost=new Set(),toHost=new Set(),failed=new Set(),key=id=>JSON.stringify(id);
  let root=session.root,init,initialized=false,child,held=null,ended=false,switching=false,finish,fault;
  const lines=(stream,onLine)=>{let buffer='';stream.setEncoding('utf8');stream.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);onLine(line);}});};
  const parse=line=>{try{const m=JSON.parse(line);return m&&typeof m==='object'&&!Array.isArray(m)?m:undefined;}catch{return;}};
  const start=release=>{
    const c=spawn(process.execPath,[join(release,'bin/codeflow.mjs'),...args],{stdio:['pipe','pipe','inherit'],env:{...process.env,CODEFLOW_HOME:resolve(home),CODEFLOW_MANAGED_CHILD:'1',CODEFLOW_MANAGED_RELEASE:release}});
    c.stdin.on('error',()=>{});
    lines(c.stdout,line=>{
      const m=parse(line);
      if(c.handshake&&m?.method===undefined&&m?.id===c.handshake.id){const h=c.handshake;c.handshake=undefined;h.done(!m.error);return;}
      if(c!==child)return; // a retired server says nothing more to the host
      if(typeof m?.method==='string'){if(m.id!==undefined)toHost.add(key(m.id));}
      else if(m&&m.id!==undefined){
        fromHost.delete(key(m.id));
        if(init&&key(m.id)===key(init.id)&&m.result){m.result.capabilities={...m.result.capabilities,tools:{...m.result.capabilities?.tools,listChanged:true}};line=JSON.stringify(m);}
      }
      process.stdout.write(line+'\n');
    });
    c.once('error',e=>{if(c===child&&!switching){fault=e;finish?.();}});
    c.once('exit',(code,signal)=>{if(c===child&&!switching){process.exitCode=code??(signal==='SIGINT'?130:1);finish?.();}});
    return c;
  };
  const deliver=line=>{if(held)held.push(line);else child.stdin.write(line+'\n');};
  const release=()=>{const queue=held;held=null;for(const line of queue)child.stdin.write(line+'\n');if(ended)child.stdin.end();};
  const runtime=async()=>{try{const r=await read(join(home,'cli-teams-runtime.json'));return alive(r.pid)?r:undefined;}catch{return;}};
  const idle=()=>!switching&&!ended&&init&&initialized&&!fromHost.size&&!toHost.size;
  const check=async()=>{
    if(!idle())return;
    const target=(await runtime())?.releaseRoot;
    if(!target||target===root||failed.has(target))return;
    const state=await updateState(home).catch(()=>undefined);
    if(!state?.releases.some(r=>r.root===target)||!await access(join(target,'bin/codeflow.mjs')).then(()=>true,()=>false)||!idle())return;
    switching=true;held=[];
    const next=start(target),id=`codeflow-switch-${randomBytes(8).toString('hex')}`;
    const ok=await new Promise(done=>{
      const timer=setTimeout(()=>done(false),30000);
      next.handshake={id,done:value=>{clearTimeout(timer);done(value);}};
      next.once('exit',()=>{clearTimeout(timer);done(false);});next.once('error',()=>{clearTimeout(timer);done(false);});
      next.stdin.write(JSON.stringify({...init,id})+'\n');
    });
    if(!ok){next.kill();failed.add(target);switching=false;release();return;}
    next.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    const old=child;child=next;root=target;switching=false;
    old.stdin.end();setTimeout(()=>old.kill(),60000).unref();
    await session.move(target).catch(()=>undefined);
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/tools/list_changed'})+'\n');
    release();
  };
  child=start(root);
  lines(process.stdin,line=>{
    const m=parse(line);
    if(typeof m?.method==='string'){
      if(m.id!==undefined){fromHost.add(key(m.id));if(m.method==='initialize'&&!init)init=m;}
      else if(m.method==='notifications/initialized')initialized=true;
      else if(m.method==='notifications/cancelled'&&m.params?.requestId!==undefined)fromHost.delete(key(m.params.requestId));
    } else if(m&&m.id!==undefined)toHost.delete(key(m.id));
    deliver(line);
  });
  process.stdin.on('end',()=>{ended=true;if(!held)child.stdin.end();});
  const handlers=['SIGINT','SIGTERM','SIGHUP'].map(s=>{const f=()=>child.kill(s);process.on(s,f);return[s,f];});
  const timer=setInterval(()=>{void check().catch(()=>{switching=false;if(held)release();});},interval);
  try {await new Promise(resolve=>{finish=resolve;});if(fault)throw fault;}
  finally {clearInterval(timer);for(const[s,f]of handlers)process.off(s,f);process.stdin.destroy();}
}
