import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,cp,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {PACKAGE,enableUpdates,updateState,updateStatus,checkUpdates,claimSession,configureUpdates,retireManagedOwner,newer,updateLock} from '../bin/managed.mjs';
const dirs=[];after(async()=>{await Promise.all(dirs.map(p=>rm(p,{recursive:true,force:true})));});
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'codeflow-updates-'));dirs.push(dir);const home=join(dir,'state');return {dir,home};}
async function release(dir,version,extra={}){
 const root=join(dir,version);await mkdir(join(root,'bin'),{recursive:true});await mkdir(join(root,'src/cli-teams'),{recursive:true});await mkdir(join(root,'integrations/cli-teams'),{recursive:true});
 await writeFile(join(root,'package.json'),JSON.stringify({name:PACKAGE,version,type:'module',codeflow:{managedRuntime:1},...extra}));
 await writeFile(join(root,'bin/codeflow.mjs'),`if(process.argv[2]==='--version')console.log(${JSON.stringify(version)});else console.log(JSON.stringify({version:${JSON.stringify(version)},args:process.argv.slice(2)}));`);
 await cp(new URL('../bin/managed.mjs',import.meta.url),join(root,'bin/managed.mjs'));
 for(const path of ['src/server.js','src/cli-teams/cli.js','src/cli-teams/mcp.js','integrations/cli-teams/SKILL.md'])await writeFile(join(root,path),path.endsWith('/mcp.js')?'export function serveMcp() {}':'');
 return root;
}
async function registry(source,version,{badIntegrity=false,badPackage=false,delay}={}){
 const bytes=Buffer.from('fixture verified archive');
 const metadata={name:PACKAGE,version,codeflow:{managedRuntime:1},dist:{tarball:'https://registry.npmjs.org/codeflow/-/release.tgz',integrity:'sha512-'+createHash('sha512').update(badIntegrity?'bad':bytes).digest('base64')}};
 return {fetch:async url=>{if(delay)await delay();return url.endsWith('.tgz')?new Response(bytes):Response.json(metadata);},install:async dir=>{await mkdir(join(dir,'node_modules/@midhunxavier'),{recursive:true});await cp(source,join(dir,'node_modules',PACKAGE),{recursive:true});if(badPackage)await writeFile(join(dir,'node_modules',PACKAGE,'package.json'),'{}');}};
}
const descriptor=(home,root)=>writeFile(join(home,'cli-teams-runtime.json'),JSON.stringify({pid:process.pid,...(root?{releaseRoot:root}:{})}));
test('release comparison handles preview numbers, stable promotion and downgrades',()=>{
 assert.equal(newer('0.1.0-preview.11','0.1.0-preview.9'),true);assert.equal(newer('0.1.0','0.1.0-preview.99'),true);assert.equal(newer('0.1.0-preview.11','0.1.0'),false);assert.equal(newer('0.0.9','0.1.0'),false);assert.equal(newer('bad','0.1.0'),false);
});
test('immutable seed, shared launcher, no downgrade and disable preserve working runtime',async()=>{
 const f=await fixture(),source=await release(f.dir,'0.1.0-preview.10');const state=await enableUpdates(f.home,source);
 await writeFile(join(source,'src/server.js'),'changed source');assert.equal(await readFile(join(state.releases[0].root,'src/server.js'),'utf8'),'');
 await checkUpdates(f.home,true,await registry(source,'0.1.0-preview.9'));assert.equal((await updateState(f.home)).current,state.current);
 await configureUpdates(f.home,false);let fetched=false;await checkUpdates(f.home,true,{fetch:()=>{fetched=true;throw Error('network');}});assert.equal(fetched,false);
 const output=execFileSync(process.execPath,[join(f.home,'integration-runtime/launcher.mjs'),'mcp','--project-root',f.dir],{encoding:'utf8'});assert.equal(JSON.parse(output).version,'0.1.0-preview.10');
 assert.equal((await updateStatus(f.home)).activeSessions,0);
});
test('connected sessions do not hold an update back; running work does, and status says why',async()=>{
 const f=await fixture(),old=await release(f.dir,'1.0.0'),next=await release(f.dir,'1.1.0');const initial=await enableUpdates(f.home,old);
 const a=await claimSession(f.home);await descriptor(f.home,a.root);
 await checkUpdates(f.home,true,await registry(next,'1.1.0'));
 // New sessions use the running backend's release so their tools match it.
 const b=await claimSession(f.home);assert.equal(b.root,a.root);
 let asked=0;assert.equal(await retireManagedOwner(f.home,a.root,async()=>{asked++;return 'a task is running';}),false);assert.equal(asked,1,'sessions alone no longer block');
 const status=await updateStatus(f.home);assert.equal(status.pending,true);assert.equal(status.waiting,'a task is running');assert.deepEqual(status.sessions.map(s=>s.release),[initial.current,initial.current]);assert.equal(status.backend.release,initial.current);
 await assert.rejects(access(join(f.home,'integration-runtime',`handover-${process.pid}.json`)),'nothing is handed over while waiting');
 await a.close();await b.close();
 await rm(join(f.home,'cli-teams-runtime.json'));const c=await claimSession(f.home);assert.notEqual(c.root,a.root);assert.equal((await updateStatus(f.home)).waiting,undefined);await c.close();
});
test('handover starts the selected release on the same port with the same sign-in',async()=>{
 const f=await fixture(),old=await release(f.dir,'1.0.0'),next=await release(f.dir,'1.1.0');
 // The successor records what it was given, then stays up briefly like a real owner.
 await writeFile(join(next,'src/server.js'),"import {readFileSync,writeFileSync} from 'node:fs';const file=process.env.CODEFLOW_HANDOVER_FILE;const token=JSON.parse(readFileSync(file,'utf8')).token;writeFileSync(process.env.CODEFLOW_HOME+'/cli-teams-runtime.json',JSON.stringify({pid:process.pid,releaseRoot:process.env.CODEFLOW_MANAGED_RELEASE,port:process.env.PORT,token}));setTimeout(()=>{},4000);");
 await enableUpdates(f.home,old);const state=await checkUpdates(f.home,true,await registry(next,'1.1.0'));
 const gone=spawn(process.execPath,['-e','']);await new Promise(r=>gone.once('exit',r));
 const token='ab'.repeat(24);await writeFile(join(f.home,'integration-runtime',`handover-${gone.pid}.json`),JSON.stringify({port:4567,token}));
 execFileSync(process.execPath,[join(f.home,'integration-runtime/launcher.mjs'),'--handover',String(gone.pid)],{env:{...process.env,CODEFLOW_HOME:f.home}});
 const owner=JSON.parse(await readFile(join(f.home,'cli-teams-runtime.json'),'utf8'));
 try {
  assert.equal(owner.port,'4567');assert.equal(owner.token,token);assert.equal(owner.releaseRoot,state.releases.find(r=>r.id===state.current).root);
  await assert.rejects(access(join(f.home,'integration-runtime',`handover-${gone.pid}.json`)),'the sign-in file is removed');
 } finally {process.kill(owner.pid);}
});
test('an open MCP session moves to the backend release once idle, without the host reconnecting',async()=>{
 const f=await fixture(),old=await release(f.dir,'1.0.0'),next=await release(f.dir,'1.1.0');
 // A minimal MCP server per release: answers with its version; "slow" takes a moment.
 const server=v=>`if(process.argv[2]==='--version'){console.log(${JSON.stringify(v)});}else{let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.id===undefined)continue;const reply=r=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:r})+'\\n');if(m.method==='initialize')reply({protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'code-flow',version:${JSON.stringify(v)}},seen:m.params});else if(m.method==='slow')setTimeout(()=>reply({version:${JSON.stringify(v)}}),4000);else reply({version:${JSON.stringify(v)}});}});}`;
 await writeFile(join(old,'bin/codeflow.mjs'),server('1.0.0'));await writeFile(join(next,'bin/codeflow.mjs'),server('1.1.0'));
 const initial=await enableUpdates(f.home,old),oldRoot=initial.releases[0].root;await descriptor(f.home,oldRoot);
 const state=await checkUpdates(f.home,true,await registry(next,'1.1.0')),nextRoot=state.releases.find(r=>r.id===state.current).root;
 const host=spawn(process.execPath,[join(f.home,'integration-runtime/launcher.mjs'),'mcp'],{env:{...process.env,CODEFLOW_HOME:f.home},stdio:['pipe','pipe','inherit']});
 const seen=[];let buffer='';host.stdout.setEncoding('utf8');host.stdout.on('data',d=>{buffer+=d;let i;while((i=buffer.indexOf('\n'))>=0){seen.push(JSON.parse(buffer.slice(0,i)));buffer=buffer.slice(i+1);}});
 const send=m=>host.stdin.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');
 const reply=async(id,ms=15000)=>{for(let t=0;t<ms/50;t++){const r=seen.find(m=>m.id===id);if(r)return r;await new Promise(r=>setTimeout(r,50));}throw new Error(`no reply to ${id}`);};
 try {
  send({id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{elicitation:{}}}});const init=await reply(1);
  assert.equal(init.result.serverInfo.version,'1.0.0');assert.equal(init.result.capabilities.tools.listChanged,true);
  send({method:'notifications/initialized'});
  // A request is open when the backend moves: the session waits for it rather than dropping it.
  send({id:2,method:'slow'});await descriptor(f.home,nextRoot);
  assert.equal((await reply(2)).result.version,'1.0.0');
  for(let t=0;t<200&&!seen.some(m=>m.method==='notifications/tools/list_changed');t++)await new Promise(r=>setTimeout(r,50));
  assert.ok(seen.some(m=>m.method==='notifications/tools/list_changed'),'the host is told the tools may have changed');
  send({id:3,method:'tools/list'});assert.equal((await reply(3)).result.version,'1.1.0');
  assert.equal(seen.filter(m=>m.id===1).length,1,'the repeated handshake stays private');
  assert.deepEqual((await updateStatus(f.home)).sessions.map(s=>s.release),[state.current]);
 } finally {host.stdin.end();await new Promise(r=>{host.once('exit',r);setTimeout(()=>{host.kill();r();},5000).unref();});}
});
test('legacy backend is never retired or signalled; all bridges use retained seed',async()=>{
 const f=await fixture(),old=await release(f.dir,'1.0.0'),next=await release(f.dir,'1.1.0');const initial=await enableUpdates(f.home,old);await descriptor(f.home);
 await checkUpdates(f.home,true,await registry(next,'1.1.0'));const session=await claimSession(f.home);assert.equal(session.root,initial.releases[0].root);await session.close();
 let called=false;assert.equal(await retireManagedOwner(f.home,initial.releases[0].root,async()=>{called=true;return true;}),false);assert.equal(called,false);
});
test('bad checksum, bad release, and offline checks retain selected runtime',async()=>{
 const f=await fixture(),old=await release(f.dir,'1.0.0'),next=await release(f.dir,'1.1.0');const initial=await enableUpdates(f.home,old);
 for(const options of [await registry(next,'1.1.0',{badIntegrity:true}),await registry(next,'1.1.0',{badPackage:true}),{fetch:async()=>{throw Error('offline');}}]){
  await assert.rejects(checkUpdates(f.home,true,options));assert.equal((await updateState(f.home)).current,initial.current);const session=await claimSession(f.home);await session.close();
 }
 assert.match((await updateState(f.home)).error,/offline/);
});
test('slow downloads do not hold the admission lock; disabling during download prevents activation',async()=>{
 const f=await fixture(),old=await release(f.dir,'1.0.0'),next=await release(f.dir,'1.1.0');const initial=await enableUpdates(f.home,old);
 let unblock,entered;const started=new Promise(r=>entered=r),wait=new Promise(r=>unblock=r);let first=true;
 const options=await registry(next,'1.1.0',{delay:async()=>{if(first){first=false;entered();await wait;}}});
 const checking=checkUpdates(f.home,true,options);await started;const session=await claimSession(f.home);await configureUpdates(f.home,false);unblock();await checking;
 assert.equal((await updateState(f.home)).current,initial.current);await session.close();
});
test('simultaneous startup leases select one generation and stale leases are reclaimed',async()=>{
 const f=await fixture(),old=await release(f.dir,'1.0.0');await enableUpdates(f.home,old);
 const active=await Promise.all(Array.from({length:5},()=>claimSession(f.home)));assert.equal(new Set(active.map(s=>s.root)).size,1);assert.equal((await updateStatus(f.home)).activeSessions,5);await Promise.all(active.map(s=>s.close()));
 await writeFile(join(f.home,'integration-runtime/sessions/dead.json'),JSON.stringify({pid:2147483647,root:'/dead'}));assert.equal((await updateStatus(f.home)).activeSessions,0);
});
test('idle handover keeps admission locked until the old process exits',async()=>{
 const f=await fixture(),old=await release(f.dir,'1.0.0'),next=await release(f.dir,'1.1.0');const initial=await enableUpdates(f.home,old);await checkUpdates(f.home,true,await registry(next,'1.1.0'));
 const script=`import {writeFile} from 'node:fs/promises';import {retireManagedOwner} from ${JSON.stringify(new URL('../bin/managed.mjs',import.meta.url).href)};await writeFile(${JSON.stringify(join(f.home,'cli-teams-runtime.json'))},JSON.stringify({pid:process.pid,releaseRoot:${JSON.stringify(initial.releases[0].root)}}));console.log(await retireManagedOwner(${JSON.stringify(f.home)},${JSON.stringify(initial.releases[0].root)},async()=>true));setTimeout(()=>process.exit(),700);`;
 const child=spawn(process.execPath,['--input-type=module','-e',script]);await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.once('data',resolve);});
 await assert.rejects(updateLock(f.home,0),/busy/);await new Promise(r=>child.once('exit',r));const unlock=await updateLock(f.home);await unlock();
});
test('real npm archive is integrity checked and installed offline without lifecycle scripts',async()=>{
 const f=await fixture(),old=await release(f.dir,'1.0.0');const marker=join(f.dir,'script-ran');
 const next=await release(f.dir,'1.1.0',{scripts:{postinstall:`node -e "require('fs').writeFileSync('${marker}','bad')"`}});
 const initial=await enableUpdates(f.home,old);
 const [packed]=JSON.parse(execFileSync('npm',['pack',next,'--ignore-scripts','--json','--pack-destination',f.dir],{encoding:'utf8'}));const bytes=await readFile(join(f.dir,packed.filename));
 const metadata={name:PACKAGE,version:'1.1.0',codeflow:{managedRuntime:1},dist:{tarball:'https://registry.npmjs.org/codeflow/-/release.tgz',integrity:packed.integrity}};
 const state=await checkUpdates(f.home,true,{fetch:async url=>url.endsWith('.tgz')?new Response(bytes):Response.json(metadata)});
 assert.notEqual(state.current,initial.current);await assert.rejects(access(marker));
 const current=state.releases.find(r=>r.id===state.current);assert.equal(JSON.parse(await readFile(join(current.root,'package.json'),'utf8')).version,'1.1.0');
});
test('concurrent stale-lock recovery never deletes the succeeding owner lock',async()=>{
 const f=await fixture();await mkdir(join(f.home,'integration-runtime'),{recursive:true});
 await writeFile(join(f.home,'integration-runtime/update.lock'),JSON.stringify({pid:2147483647,nonce:'dead'}));
 let inside=0,max=0;
 await Promise.all(Array.from({length:8},async()=>{const release=await updateLock(f.home);inside++;max=Math.max(max,inside);await new Promise(r=>setTimeout(r,15));inside--;await release();}));
 assert.equal(max,1);
});
