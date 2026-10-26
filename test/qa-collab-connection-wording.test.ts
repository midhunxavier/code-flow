import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
process.env.CODEFLOW_HOME=mkdtempSync(join(tmpdir(),'codeflow-qa-collab-wording-unit-'));
const address=new URL('http://localhost:4351/#/team/task/t-1111111111111111'), changes:{kind:string;href:string}[]=[];
Object.defineProperty(globalThis,'window',{configurable:true,value:{}});
Object.defineProperty(globalThis,'location',{configurable:true,value:{get href(){return address.href},get hash(){return address.hash},get search(){return address.search},hostname:'localhost',assign(href:string){changes.push({kind:'assign',href})},replace(href:string){changes.push({kind:'replace',href})}}});
Object.defineProperty(globalThis,'history',{configurable:true,value:{state:null,replaceState(_:unknown,__:string,href:string){address.href=href}}});
const storage=new Map<string,string>();Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)}});
Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>null,setItem(){}}});
const calls:string[]=[];globalThis.fetch=async input=>{calls.push(String(input));return Response.json({connections:[{id:'local',linked:false},{id:'c-1111111111111111',linked:true},{id:'c-2222222222222222',linked:true}]})};
const lib=await import('../ui/lib.js');const state=await import('../ui/collab-state.js');const drafts=await import('../ui/team-task-draft.js');
const {readError}=await import('../src/collab/hub-client.js');const {openSharedEvents,SHARED_EVENTS_RETRY_MS}=await import('../ui/shared-events.js');
test('ambiguous boot preserves an unscoped task URL and makes no guessed board/link/inbox subscription',async()=>{
 await lib.initializeTeamConnection();assert.equal(lib.selectedTeamConnection,'');assert.equal(lib.teamConnectionRequired.value,2);assert.equal(address.searchParams.has('team'),false);assert.match(address.hash,/task/);await state.loadBoard();await state.loadTeamLink();await state.loadInbox();state.watchTeam();assert.deepEqual(calls,['/api/team-link/connections']);assert.equal(state.boardError.value,'');
});
test('forced local navigation replaces an already-added hash entry but pushes a programmatic destination',()=>{
 address.hash='#/project/p-11111111/people';assert.equal(lib.ensureCollaborationSource(address.hash),false);assert.equal(changes.at(-1)!.kind,'replace');address.hash='#/team';assert.equal(lib.ensureCollaborationSource('#/project/p-11111111/people'),false);assert.equal(changes.at(-1)!.kind,'assign');assert.match(changes.at(-1)!.href,/team=local/);
});
test('draft storage separates viewers and projects, validates data and clears only the requested draft',()=>{
 const a=drafts.taskDraftKey('alice','p-1'),b=drafts.taskDraftKey('bob','p-1'),c=drafts.taskDraftKey('alice','p-2');assert.notEqual(a,b);assert.notEqual(a,c);const value={projectId:'p-1',repository:'app',title:'Keep title',goal:'Goal',acceptance:'Acceptance',baseRef:'main',owner:'alice',reviewer:'bob'};assert.equal(drafts.saveTaskDraft(a,value),true);assert.deepEqual(drafts.readTaskDraft(a),value);assert.equal(drafts.readTaskDraft(b),null);drafts.saveTaskDraft(c,value);drafts.saveTaskDraft(a,null);assert.equal(drafts.readTaskDraft(a),null);assert.deepEqual(drafts.readTaskDraft(c),value);storage.set(a,'{"title":1}');assert.equal(drafts.readTaskDraft(a),null);
});
test('credential errors normalize old duplicate advice once; wrong-password errors stay untouched',async()=>{
 const old='This runner credential is not valid; connect this computer again in Settings → Team; reconnect in Settings → Team';const error=await readError(Response.json({error:old},{status:401}));assert.doesNotMatch(error.message,/Settings → Team/);assert.equal(error.message.match(/connect this computer again/g)?.length,1);assert.match(error.message,/Connections → Share access → Join a team/);assert.equal(error.code,'runner-credential-invalid');const connecting=await readError(Response.json({error:'Wrong password'},{status:401}),true);assert.equal(connecting.message,'Wrong password');
});
class Source {static CLOSED=2;static instances:Source[]=[];readyState=1;onopen?:()=>void;onerror?:()=>void;onmessage?:(event:MessageEvent)=>void;closed=false;constructor(readonly path:string){Source.instances.push(this)}close(){this.closed=true;this.readyState=2}fail(){this.readyState=2;this.onerror?.()}}
Object.defineProperty(globalThis,'EventSource',{configurable:true,value:Source});
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('closed shared streams expose 429 reasons and automatically reopen; stop cancels retry and the probe',async()=>{
 const realSet=globalThis.setTimeout,realClear=globalThis.clearTimeout,timers=new Map<number,{fn:()=>void,ms:number}>();let seq=0;globalThis.setTimeout=((fn:()=>void,ms:number)=>{timers.set(++seq,{fn,ms});return seq}) as any;globalThis.clearTimeout=((id:number)=>{timers.delete(id)}) as any;
 const states:unknown[]=[];let signal:AbortSignal|undefined;globalThis.fetch=async(_path,init)=>{signal=init?.signal as AbortSignal;return Response.json({error:'Too many team event streams; close another tab and retry'},{status:429})};
 try{const stop=openSharedEvents('/api/team/events',()=>{},(s,r)=>states.push([s,r]));const first=Source.instances.at(-1)!;first.fail();await settle();assert.deepEqual(states.at(-1),['limited','Too many team event streams; close another tab and retry']);const retry=[...timers.values()].find(t=>t.ms===SHARED_EVENTS_RETRY_MS);assert.ok(retry);retry.fn();assert.equal(first.closed,true);const second=Source.instances.at(-1)!;second.onopen?.();assert.deepEqual(states.at(-1),['connected',undefined]);stop();assert.equal(second.closed,true);assert.equal(signal?.aborted,true);assert.equal(timers.size,0);}finally{globalThis.setTimeout=realSet;globalThis.clearTimeout=realClear;}
});
test('a successful diagnostic probe immediately cancels its stream body, retaining no extra slot',async()=>{
 let cancelled=false;globalThis.fetch=async()=>new Response(new ReadableStream({cancel(){cancelled=true}}),{headers:{'content-type':'text/event-stream'}});const stop=openSharedEvents('/api/events?limit=50',()=>{});Source.instances.at(-1)!.fail();await settle();assert.equal(cancelled,true);stop();
});
