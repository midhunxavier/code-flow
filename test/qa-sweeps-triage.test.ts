import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultSweepPicks, selectSweepItems, matchesSweepFilter } from '../ui/sweep-selection.js';
import type { SweepItem } from '../src/sweeps.js';
const dir=mkdtempSync(join(tmpdir(),'codeflow-qa-sweeps-triage-'));
process.env.CODEFLOW_HOME=join(dir,'home');process.env.FAKE_GH_STATE=join(dir,'gh.json');
process.env.PATH=`${fileURLToPath(new URL('./fake-bin',import.meta.url))}:${process.env.PATH}`;
const {RunManager,RunConflictError}=await import('../src/engine.js');
const {findPattern}=await import('../src/patterns/index.js');
const {listSweep,nextSweepItems}=await import('../src/sweeps.js');
const {Automations}=await import('../src/automation.js');
const manager=new RunManager(findPattern);
const git=(...args:string[])=>execFileSync('git',args,{cwd:dir,encoding:'utf8'}).trim();
git('init','-q','-b','main');git('config','user.name','QA');git('config','user.email','qa@test');writeFileSync(join(dir,'README.md'),'fixture\n');git('add','README.md');git('commit','-qm','base');
after(async()=>{await manager.shutdown();rmSync(dir,{recursive:true,force:true});});
const item=(n:number,extra:Partial<SweepItem>={}):SweepItem=>({key:`issue#${n}`,ref:`#${n}`,title:'Title',detail:'Detail',url:'https://github.com/o/r/issues/'+n,selected:true,task:'Fix it',source:{kind:'issue',number:n},...extra});
const advisory=(n:number,name:string,severity:string)=>({number:n,html_url:`https://github.com/o/r/security/dependabot/${n}`,dependency:{package:{ecosystem:'pip',name}},security_advisory:{severity,summary:'advisory'},security_vulnerability:{first_patched_version:{identifier:'2.0'}}});

test('default and bulk sweep picks cap at 25 eligible items while preserving manual selections',()=>{
 const items=[item(0,{manual:true}),item(50,{existingRun:'r'}),item(51,{blockedReason:'busy'}),...Array.from({length:32},(_,n)=>item(n+1))];
 const picks=defaultSweepPicks(items);assert.equal(picks.size,25);assert.ok(picks.has('issue#25'));assert.ok(!picks.has('issue#0'));assert.ok(!picks.has('issue#26'));
 assert.equal(selectSweepItems(new Set(),items,true).size,25);assert.equal(selectSweepItems(picks,items,false).size,0);
 const old=new Set(['issue#32']);const next=selectSweepItems(old,items,true);assert.equal(next.size,25);assert.ok(next.has('issue#32'));assert.equal(old.size,1);
});
test('sweep filters search labels and severity; exact low does not match note alerts',()=>{
 assert.equal(matchesSweepFilter(item(1,{severity:'critical'}),' CRITICAL '),true);
 assert.equal(matchesSweepFilter(item(2,{severity:'note',note:'Low severity'}),'low'),false);
 assert.equal(matchesSweepFilter(item(3,{severity:'low'}),'LOW'),true);
 assert.equal(matchesSweepFilter(item(4,{labels:['only-a-label']}),'only-a-label'),true);
 assert.equal(matchesSweepFilter(item(5,{labels:['high']}),'high'),true);
});
test('low and unknown Dependabot severity with fixes stays manual; grouped high and low stay picked in scheduled/webhook previews',async()=>{
 writeFileSync(process.env.FAKE_GH_STATE!,JSON.stringify({prs:{},dependabotAlerts:[advisory(1,'low','low'),advisory(2,'unknown','unknown'),advisory(3,'medium','medium'),advisory(4,'mixed','low'),advisory(5,'mixed','high')],codeScanningAlerts:[],secretAlerts:[]}));
 const list=await listSweep(dir,'alerts',[]);const by=Object.fromEntries(list.items.map(i=>[i.key,i]));assert.equal(by['dependabot#1']!.selected,false);assert.match(by['dependabot#1']!.note!,/Low severity/);assert.match(by['dependabot#1']!.task!,/upgrade it to 2.0/);assert.equal(by['dependabot#2']!.selected,false);assert.equal(by['dependabot#4']!.selected,true);assert.deepEqual(nextSweepItems(list,new Set(),25).map(i=>i.key),['dependabot#4','dependabot#3']);
 const auto=new Automations(manager,async()=>{throw new Error('preview must not start');},async()=>list);await auto.load();const saved=await auto.create({name:'Alerts preview',enabled:true,webhook:true,isolate:false,sweep:{kind:'alerts',max:5},run:{repo:dir,pattern:'solo',task:'Fix alerts',roles:{agent:['claude']}}});
 assert.deepEqual((await auto.dryRun(saved.id,{via:'manual'})).selected.map(i=>i.key),['dependabot#4','dependabot#3']);
 assert.deepEqual((await auto.dryRun(saved.id,{via:'webhook',source:{kind:'alert',tool:'dependabot',number:1}})).selected,[]);
 assert.equal((await auto.dryRun(saved.id,{via:'webhook',source:{kind:'alert',tool:'dependabot',number:3}})).selected.length,1);
});
async function pending(){const r=await manager.start({pattern:findPattern('solo')!,repo:dir,task:'Make a useful change',roles:{agent:['claude']},options:{},trigger:{id:'qa',name:'QA',via:'sweep'},loop:{check:'true',maxSteps:5,maxMinutes:10}});for(let n=0;n<300&&(!r.endedAt||r.status==='running');n++)await new Promise(resolve=>setTimeout(resolve,30));assert.equal(r.triage?.state,'pending',r.error);return r;}
test('approved, rejected, empty and non-inbox results reject later decisions without mutations or publication',async()=>{
 for(const state of ['approved','rejected','empty',undefined] as const){const r=await pending();if(state==='rejected')await manager.triage(r.id,{decision:'reject'});else r.triage=state?{state,at:0}:undefined;const before=JSON.stringify(r);for(const decision of ['approve','reject','revise'] as const)await assert.rejects(manager.triage(r.id,{decision,note:'late',openPr:true,pushPr:true}),RunConflictError);assert.equal(JSON.stringify(r),before);}
});
test('a triage claim blocks overlapping publication and is released after failure; warning is explicit',async()=>{
 const r=await pending();const original=manager.pushToPr;let release!:()=>void,entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);let count=0;
 manager.pushToPr=async()=>{count++;entered();await new Promise<void>(resolve=>release=resolve);throw new Error('fixture publication failure');};
 try{const first=manager.triage(r.id,{decision:'approve',pushPr:true});await started;await assert.rejects(manager.triage(r.id,{decision:'reject'}),/decision.*in progress/);release();await assert.rejects(first,/publication failure/);assert.equal(r.triage?.state,'pending');assert.equal(count,1);
 const warning='The fix was pushed, but visual evidence could not be added to the PR: fixture';manager.pushToPr=async()=>({url:'https://github.com/o/r/pull/7',sha:'abc',warning});const approved=await manager.triage(r.id,{decision:'approve',pushPr:true,note:'Reviewed the fix'});assert.equal(approved.triage?.warning,warning);assert.equal(approved.triage?.note,'Reviewed the fix');assert.equal(approved.triage?.state,'approved');await assert.rejects(manager.triage(r.id,{decision:'approve',pushPr:true}),/already approved/);
 }finally{manager.pushToPr=original;}
});

test('a rejected cleanup admission keeps the result pending and releases its decision claim',async()=>{
 const r=await pending();const archive=manager.archive;
 manager.archive=async()=>{throw new RunConflictError('Wait for the new chat');};
 try {await assert.rejects(manager.triage(r.id,{decision:'reject'}),/Wait for the new chat/);assert.equal(r.triage?.state,'pending');}
 finally {manager.archive=archive;}
 await manager.triage(r.id,{decision:'reject'});assert.equal(r.triage?.state,'rejected');assert.equal(r.archived,true);
});
