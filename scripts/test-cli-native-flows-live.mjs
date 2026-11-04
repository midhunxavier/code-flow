/** Full native-host flow matrix. Requires explicit live-test opt-in; all edits,
 * confirmations and recovery operations are limited to newly created disposable repos.
 * Native approval replies are automated test fixtures, not human TUI acceptance. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {randomBytes} from 'node:crypto';
import {nativeHost,until} from './cli-test-native-host.mjs';
if(process.env.CODEFLOW_TEST_LIVE_AGENTS!=='1')throw new Error('Set CODEFLOW_TEST_LIVE_AGENTS=1 for authorized live-provider fixture testing');
const root=fileURLToPath(new URL('..',import.meta.url));
const directory=await realpath(await mkdtemp(join(tmpdir(),'codeflow-native-flows-'))),home=join(directory,'state');
process.env.CODEFLOW_HOME=home;
const token=randomBytes(32).toString('hex');
const env={...process.env,CODEFLOW_HOME:home,CODEFLOW_TOKEN:token,CODEFLOW_CLI_HEADLESS:'1',CODEFLOW_NO_BROWSER:'1'};
const port=await new Promise(resolve=>{const s=createServer().listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const headers={authorization:`Bearer ${token}`},base=`http://127.0.0.1:${port}`;
let server,host,observer,log='',sequence=0;const reports=[];
const save=(name,value)=>writeFile(join(directory,name),JSON.stringify(value,null,2),{mode:0o600});
const {connectRuntime,runtimeRequest}=await import('../src/cli-teams/client.ts');
const heartbeat=setInterval(()=>{if(observer)void runtimeRequest(observer.runtime,'/heartbeat',{},observer.token).catch(()=>{});},10000).unref();
const api=async path=>{const r=await fetch(base+path,{headers});assert.ok(r.ok);return r.json();};
async function startOwner(){server=spawn(process.execPath,['--import','tsx','src/server.ts'],{cwd:root,env:{...env,PORT:String(port)},stdio:['ignore','pipe','pipe']});for(const s of [server.stdout,server.stderr])s.on('data',b=>log+=b);await until(()=>fetch(base+'/api/health',{headers}).then(r=>r.ok,()=>false),Boolean,'owner startup');}
async function stopOwner(){await observer?.close();observer=undefined;if(server&&server.exitCode===null&&server.signalCode===null){server.kill('SIGTERM');await until(async()=>server.exitCode!==null||server.signalCode!==null,Boolean,'owner shutdown',30000);}}
const people=[{id:'haiku',provider:'claude',model:'claude-haiku-5-5',effort:'high'},{id:'luna',provider:'codex',model:'gpt-6-luna',effort:'high'}];
const task=(id,operation,participant,instructions,inputs)=>({id,type:'task',operation,...(participant?{participant}:{}),...(instructions?{instructions}:{}),...(inputs?{inputs}:{})});
const op=()=>`native-flows-${++sequence}`;
const call=async(name,args={})=>(await host.call(name,args)).structuredContent.data;
const peek=runId=>observer.call('codeflow_get_run',{runId});
const terminal=runId=>until(()=>peek(runId),s=>s.runtimeStatus!=='running','run completed',8*60000);
const check=(provider,name,details={})=>{const r={provider,test:name,passed:true,...details};reports.push(r);console.log(JSON.stringify(r));};
async function begin(p,action='accept') {host.approve(action,p.proposalId);return host.call('start_run',{operationId:op(),proposalId:p.proposalId,expectedRevision:p.revision,proposalHash:p.proposalHash},action!=='accept');}
try{
 console.log(JSON.stringify({directory,port,models:people}));await save('metadata.json',{hosts:process.env.CODEFLOW_TEST_HOSTS??'codex,claude',focus:process.env.CODEFLOW_TEST_FOCUS??'all',claudeHostModel:env.CODEFLOW_TEST_CLAUDE_HOST_MODEL??'claude-sonnet-5-5',codexHostModel:'gpt-6-luna',workers:people,versions:Object.fromEntries(['claude','codex'].map(p=>[p,execFileSync(p,['--version'],{encoding:'utf8'}).trim()])),confirmations:'Automated native-protocol fixture responses; no human TUI claim'});await startOwner();
 for(const provider of (process.env.CODEFLOW_TEST_HOSTS??'codex,claude').split(',')){
  assert.ok(['claude','codex'].includes(provider));
  const repo=join(directory,`${provider} project with spaces`);await mkdir(repo);
  const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8'}).trim();
  git('init','-q','-b','main');
  const originalTest="import {test} from 'node:test';import assert from 'node:assert/strict';import {value} from './app.mjs';test('fixed contract',()=>assert.equal(value,2));\n";
  await writeFile(join(repo,'app.mjs'),'export const value = 1;\n');await writeFile(join(repo,'app.test.mjs'),originalTest);
  await writeFile(join(repo,'README.md'),'Disposable live-test repository. Change only app.mjs from value=1 to value=2. Tests are fixed. No dependencies, pushes, deployments or unrelated edits.\n');
  execFileSync(process.execPath,['--import',import.meta.resolve('tsx'),join(root,'src/cli-teams/cli.ts'),'init','--providers','claude,codex'],{cwd:repo,env,stdio:'pipe'});
  git('add','.');git('-c','user.name=Test','-c','user.email=test@localhost','commit','-qm','Disposable fixture and CLI setup');const original=git('rev-parse','HEAD');
  const recordFile=join(directory,`${provider}-wire.jsonl`),proxy=join(directory,`${provider}-mcp-proxy.mjs`);
  // Transparent observation: never alters MCP requests, responses or approval decisions.
  await writeFile(proxy,`import {spawn} from 'node:child_process';import {appendFileSync} from 'node:fs';
const child=spawn(${JSON.stringify(process.execPath)},${JSON.stringify(['--import',import.meta.resolve('tsx'),join(root,'src/cli-teams/cli.ts'),'mcp','--project-root',repo])},{stdio:['pipe','pipe','inherit']});let incoming='',outgoing='';const names=new Map();
process.stdin.on('data',b=>{child.stdin.write(b);incoming+=b;let i;while((i=incoming.indexOf('\\n'))>=0){let m;try{m=JSON.parse(incoming.slice(0,i));}catch{}incoming=incoming.slice(i+1);if(m?.method==='tools/call')names.set(m.id,m.params.name);}});
child.stdout.on('data',b=>{process.stdout.write(b);outgoing+=b;let i;while((i=outgoing.indexOf('\\n'))>=0){let m;try{m=JSON.parse(outgoing.slice(0,i));}catch{}outgoing=outgoing.slice(i+1);if(m?.result?.structuredContent){appendFileSync(${JSON.stringify(recordFile)},JSON.stringify({name:names.get(m.id),result:m.result})+'\\n',{mode:0o600});names.delete(m.id);}}});
process.stdin.on('end',()=>child.stdin.end());child.on('exit',c=>process.exit(c??0));`,{mode:0o600});
  const executable={command:process.execPath,args:[proxy],env:{CODEFLOW_HOME:home}};
  const launch=()=>nativeHost({provider,repo,env,executable,recordFile,onEvent:e=>{if(e.form)console.log(JSON.stringify({provider,confirmation:e.form}));if(e.correction)console.log(JSON.stringify({provider,hostArgumentCorrection:e.correction,reason:e.reason}));if(e.unexpectedForm)console.log(JSON.stringify({provider,unexpectedForm:true}));}});
  host=await launch();observer=await connectRuntime(repo,false,'terminal');
  await host.smoke();const connected=await call('list_providers');assert.equal(connected.connection.compatible,true);assert.equal(connected.connection.configuration.state,'current');check(provider,'connection and natural-language discovery',{tools:connected.connection.tools.length});
  const planCandidate={scope:'plan',participants:people,completion:['A concise plan to change only app.mjs to value 2, approved by an independent reviewer'],limits:{maxInvocations:4,maxMinutes:8,maxAttempts:1,concurrency:1},steps:[
   {id:'question',type:'user_decision',question:'Proceed with the dependency-free value fix?',options:['Proceed','Stop'],continueOn:'Proceed'},
   {id:'agreement',type:'loop',maxIterations:2,steps:[task('draft','propose','haiku','Read app.mjs and app.test.mjs. Plan only the one-line value=2 fix, fixed test, and independent review. Under 100 words. Incorporate any queued guidance, no optional scope.'),task('review','review_plan','luna','Approve if the plan changes only app.mjs value to 2, retains the fixed test and independent review. No optional scope.',['draft']),{id:'gate',type:'gate',policy:'agreement',target:'draft',reviews:['review']}]},
   {id:'result',type:'finish',outcome:'agreed_plan',inputs:['draft','gate']} ]};
  if(process.env.CODEFLOW_TEST_FOCUS==='cancellation'){
   const p=await call('propose_run',{operationId:op(),task:'Cancellation regression: stop before planning.',candidate:planCandidate});const id=(await begin(p)).structuredContent.data.runId;
   const waiting=await until(()=>peek(id),s=>s.progress.phase==='waiting_user','question ready');
   await call('control_run',{operationId:op(),runId:id,action:'cancel'});await terminal(id);
   const stopped=await call('get_run',{runId:id});assert.equal(stopped.progress.phase,'cancelled');assert.deepEqual(stopped.questions,[]);assert.deepEqual(stopped.assignments,[]);assert.equal(stopped.progress.recent.at(-1).status,'interrupted');
   const late=await host.call('steer_run',{operationId:op(),runId:id,questionId:waiting.questions[0].id,message:'Proceed'},true);assert.equal(late.structuredContent.error.code,'validation_failed');check(provider,'cancelled questions disappear and late answers are rejected');
   const candidate={scope:'write',participants:people,check:'node -e "setTimeout(()=>{},20000)"',completion:['Run the fixed verification'],limits:{maxInvocations:1,maxMinutes:2,maxAttempts:1,concurrency:1},steps:[task('snapshot','capture_snapshot'),task('check','verify'),{id:'gate',type:'gate',policy:'verified',target:'snapshot',reviews:[],verification:'check'},{id:'result',type:'finish',outcome:'verified_changes',inputs:['snapshot','check','gate']}]};
   const ap=await call('propose_run',{operationId:op(),task:'Cancel the active verification, preserving the checkout.',candidate});const aid=(await begin(ap)).structuredContent.data.runId;
   await until(()=>api('/api/runs/'+aid),r=>r.steps.some(s=>s.status==='running'&&s.kind==='check'),'active check');await call('control_run',{operationId:op(),runId:aid,action:'cancel'});await terminal(aid);
   const active=await call('get_run',{runId:aid});assert.equal(active.progress.phase,'cancelled');assert.equal(active.progress.recent.at(-1).status,'interrupted');assert.equal(git('status','--porcelain'),'');assert.equal(git('rev-parse','HEAD'),original);check(provider,'active cancellation is labelled clearly and preserves the checkout');
   await host.close();host=undefined;await observer.close();observer=undefined;continue;
  }
  const p=await call('propose_run',{operationId:op(),task:'Plan the fixed value change; do not implement.',candidate:planCandidate});assert.ok(p.summary);assert.equal(p.approvalMethod,'native_form');
  const declined=await begin(p,'decline');assert.equal(declined.structuredContent.error.code,'acceptance_declined');assert.equal((await call('list_runs')).runs.length,0);check(provider,'declined approval starts no work');
  const started=(await begin(p)).structuredContent.data,runId=started.runId;
  const recovered=await call('start_run',{operationId:op(),proposalId:p.proposalId,expectedRevision:p.revision,proposalHash:p.proposalHash});assert.equal(recovered.runId,runId);
  await until(()=>peek(runId),s=>s.progress.phase==='waiting_user','pending question');let waiting=await call('get_run',{runId});assert.equal(waiting.progress.phase,'waiting_user');assert.equal(waiting.questions.length,1);assert.equal(waiting.usage.managedInvocations,0);check(provider,'approval, duplicate start and unanswered question');
  await call('steer_run',{operationId:op(),runId,message:'Keep this dependency-free; the plan should explicitly say no new dependencies.'});
  await call('control_run',{operationId:op(),runId,action:'pause'});let paused=await call('get_run',{runId});assert.ok(['paused','pausing'].includes(paused.progress.phase));await call('control_run',{operationId:op(),runId,action:'resume'});check(provider,'pause and resume while awaiting input');
  await call('steer_run',{operationId:op(),runId,questionId:waiting.questions[0].id,message:'Proceed'});
  // Disconnect an actual native host while accepted managed work proceeds.
  const before=await peek(runId);assert.equal(before.runtimeStatus,'running');await host.close();host=undefined;host=await launch();
  const found=await call('list_runs');assert.ok(found.runs.some(r=>r.runId===runId));await terminal(runId);
  const planned=await call('get_run',{runId});assert.equal(planned.outcome,'agreed_plan');assert.ok(planned.progress.guidance.some(g=>g.status==='delivered'));check(provider,'active reconnect, planning, progress and delivered guidance',{runId,calls:planned.usage.managedInvocations});
  assert.equal(git('status','--porcelain'),'');
  const writer=provider==='codex'?'luna':'haiku',reviewer=writer==='luna'?'haiku':'luna';
  const buildCandidate={scope:'write',participants:people,check:`node -e "setTimeout(()=>{},20000)" && node --test app.test.mjs`,completion:['Only app.mjs changes to value=2, fixed test passes, independent review approves'],limits:{maxInvocations:2,maxMinutes:8,maxAttempts:1,concurrency:1},steps:[
   task('build','implement',writer,'Implement the inherited plan. Change only app.mjs from value=1 to value=2. Do not edit tests, README or CLI configuration. No extra scope, dependencies or agents. Codeflow runs the fixed check.'),task('check','verify'),task('review','review_code',reviewer,'Read the source and test; approve only if value is 2 and the fixed test is unchanged. No edits or optional scope.',['build']),{id:'gate',type:'gate',policy:'verified',target:'build',reviews:['review'],verification:'check'},{id:'result',type:'finish',outcome:'verified_changes',inputs:['build','check','review','gate']} ]};
  const bp=await call('propose_run',{operationId:op(),task:'Implement the previous plan and independently review it.',candidate:buildCandidate,context:planned.continuation.context});assert.equal(bp.workspace.chatId,planned.workspace.chatId);
  const bid=(await begin(bp)).structuredContent.data.runId;
  await until(()=>api('/api/runs/'+bid),r=>r.steps.some(s=>s.status==='running'&&s.kind==='check'),'verification running',240000);
  await call('control_run',{operationId:op(),runId:bid,action:'pause'});
  const settling=await call('get_run',{runId:bid});assert.ok(['pausing','paused'].includes(settling.progress.phase));
  await until(()=>peek(bid),s=>s.progress.phase==='paused','pause settled',60000);
  const settled=await call('get_run',{runId:bid});assert.equal(settled.progress.phase,'paused');await call('control_run',{operationId:op(),runId:bid,action:'resume'});check(provider,'active pause settles before resume');
  await terminal(bid);const built=await call('get_run',{runId:bid,artifactLimit:1});assert.equal(built.outcome,'verified_changes');assert.equal(built.handoff.check.passed,true);assert.ok(built.nextArtifactCursor!==undefined);check(provider,'continuation, implementation, verification and review',{runId:bid,calls:built.usage.managedInvocations});
  let cursor=0,body='',pages=0;do{const a=await call('get_artifact',{runId:bid,artifactId:built.result.id,sha256:built.result.sha256,cursor,maxBytes:256});body+=a.body;cursor=a.nextCursor;pages++;}while(cursor!==undefined);assert.ok(body.length>256);check(provider,'long result pagination',{pages,bytes:Buffer.byteLength(body)});
  const cancelCandidate={scope:'write',participants:people,check:'node -e "setTimeout(()=>{},20000)" && node --test app.test.mjs',completion:['Verify the preserved code'],limits:{maxInvocations:1,maxMinutes:2,maxAttempts:1,concurrency:1},steps:[task('snapshot','capture_snapshot'),task('check','verify'),{id:'gate',type:'gate',policy:'verified',target:'snapshot',reviews:[],verification:'check'},{id:'result',type:'finish',outcome:'verified_changes',inputs:['snapshot','check','gate']}]};
  const activeCancel=await call('propose_run',{operationId:op(),task:'Active cancellation fixture: verify preserved code without editing.',candidate:cancelCandidate,context:built.continuation.context});
  const activeCancelId=(await begin(activeCancel)).structuredContent.data.runId;
  await until(()=>api('/api/runs/'+activeCancelId),r=>r.steps.some(s=>s.status==='running'&&s.kind==='check'),'cancellable active check');
  await call('control_run',{operationId:op(),runId:activeCancelId,action:'cancel'});await terminal(activeCancelId);
  const activeCancelled=await call('get_run',{runId:activeCancelId});assert.equal(activeCancelled.runtimeStatus,'cancelled');assert.equal(activeCancelled.progress.phase,'cancelled');assert.deepEqual(activeCancelled.questions,[]);assert.equal(activeCancelled.usage.managedInvocations,0);check(provider,'cancellation during active execution preserves work');
  let preview=await call('preview_handoff',{runId:bid,maxBytes:256}),diff=preview.diff;cursor=preview.nextCursor;
  while(cursor!==undefined){const page=await call('preview_handoff',{runId:bid,previewHash:preview.previewHash,cursor,maxBytes:256});diff+=page.diff;cursor=page.nextCursor;}assert.ok(diff.includes('+export const value = 2;'));assert.equal(preview.ready,true);
  host.approve('decline',bid);let application=await host.call('apply_handoff',{operationId:op(),runId:bid,previewHash:preview.previewHash},true);assert.equal(application.structuredContent.error.code,'acceptance_declined');assert.equal(git('status','--porcelain'),'');check(provider,'complete diff and declined application');
  await writeFile(join(repo,'app.mjs'),'export const value = 99;\n');const dirty=await call('preview_handoff',{runId:bid});assert.equal(dirty.ready,false);assert.match(dirty.reason,/local|untracked/);
  const stale=await host.call('apply_handoff',{operationId:op(),runId:bid,previewHash:preview.previewHash},true);assert.equal(stale.structuredContent.ok,false);assert.equal(await readFile(join(repo,'app.mjs'),'utf8'),'export const value = 99;\n');
  git('add','app.mjs');git('-c','user.name=Test','-c','user.email=test@localhost','commit','-qm','Disposable conflicting destination');const conflict=await call('preview_handoff',{runId:bid});assert.equal(conflict.ready,false);assert.match(conflict.reason,/not apply cleanly/);check(provider,'dirty destination, stale preview and committed conflict');
  // Discard only the test-authored conflicting commit in this new disposable repo.
  git('reset','--hard',original);preview=await call('preview_handoff',{runId:bid});assert.equal(preview.ready,true);
  const applyArgs={operationId:op(),runId:bid,previewHash:preview.previewHash};host.approve('accept',bid);assert.equal((await call('apply_handoff',applyArgs)).applied,true);
  assert.equal((await call('apply_handoff',applyArgs)).applied,true);assert.equal((await call('apply_handoff',{...applyArgs,operationId:op()})).applied,true);
  assert.equal(git('rev-parse','HEAD'),original);assert.equal(git('diff','--cached','--name-only'),'app.mjs');assert.equal(await readFile(join(repo,'app.test.mjs'),'utf8'),originalTest);
  const checkEnv={...env};delete checkEnv.NODE_TEST_CONTEXT;const checkText=execFileSync(process.execPath,['--test','app.test.mjs'],{cwd:repo,env:checkEnv,encoding:'utf8'});await writeFile(join(directory,provider+'-destination-check.txt'),checkText);check(provider,'approved application, duplicate receipt and destination tests');
  // Fresh accepted checkpoint task is cancelled before any managed inference.
  const cp=await call('propose_run',{operationId:op(),task:'Cancellation fixture; wait for input before planning.',candidate:planCandidate});const cid=(await begin(cp)).structuredContent.data.runId;await until(()=>peek(cid),s=>s.progress.phase==='waiting_user','cancellable question');await call('control_run',{operationId:op(),runId:cid,action:'cancel'});await terminal(cid);const cancelled=await call('get_run',{runId:cid});assert.equal(cancelled.runtimeStatus,'cancelled');assert.equal(cancelled.progress.phase,'cancelled');assert.deepEqual(cancelled.questions,[]);assert.equal(cancelled.usage.managedInvocations,0);check(provider,'cancellation while awaiting input');
  const counts=host.counts;await host.close();host=undefined;await stopOwner();await startOwner();observer=await connectRuntime(repo,false,'terminal');host=await launch();assert.equal((await call('apply_handoff',applyArgs)).applied,true);assert.equal(git('rev-parse','HEAD'),original);check(provider,'owner restart preserves application receipt',{lastNativeSessionCounts:counts});
  await host.close();host=undefined;await observer.close();observer=undefined;
 }
 console.log(process.env.CODEFLOW_TEST_FOCUS==='cancellation'?'PASS: native cancellation regressions':'PASS: complete native CLI flow matrix');
}catch(e){await save('failure.json',{message:e.message,stack:e.stack});throw e;}
finally{clearInterval(heartbeat);await host?.close();await stopOwner();await save('report.json',reports);await writeFile(join(directory,'owner.log'),log,{mode:0o600});console.log(`Evidence: ${directory}`);}
