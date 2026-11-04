// Native CLI driver for disposable, explicitly opted-in integration tests.
// Approval replies are test fixtures, not evidence of a person operating a TUI.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
export const delay=ms=>new Promise(r=>setTimeout(r,ms));
export async function until(read,match,label,timeout=60000){const end=Date.now()+timeout;do{const v=await read();if(match(v))return v;await delay(200);}while(Date.now()<end);throw new Error(`Timeout: ${label}`);}
export async function nativeHost({provider,repo,env,executable,recordFile,onEvent=()=>{}}){
 assert.equal(env.CODEFLOW_TEST_LIVE_AGENTS,'1');assert.ok(repo.includes('/codeflow-native-flows-'));
 const config=`mcp_servers.codeflow={command=${JSON.stringify(executable.command)},args=${JSON.stringify(executable.args)},env={CODEFLOW_HOME=${JSON.stringify(env.CODEFLOW_HOME)}},enabled=true,startup_timeout_sec=30,tool_timeout_sec=420}`;
 const control=provider==='claude';
 const args=control?['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--model',env.CODEFLOW_TEST_CLAUDE_HOST_MODEL??'claude-sonnet-5-5','--effort','high','--permission-prompt-tool','stdio','--strict-mcp-config','--mcp-config',JSON.stringify({mcpServers:{codeflow:executable}}),'--tools','','--allowedTools','mcp__codeflow','--no-chrome','--settings','{"disableAllHooks":true,"disableWorkflows":true,"ultracode":false}']:
 ['app-server','--listen','stdio://','-c',config,'-c','features.hooks=false'];
 const child=spawn(provider,args,{cwd:repo,env,detached:true,stdio:['pipe','pipe','pipe']});
 let lastTurnText='';let buffer='',seq=0,turnWaiter,expectedApproval,formCount=0,turnCount=0,threadId;const pending=new Map();let stderr='';
 const send=m=>child.stdin.write(JSON.stringify(m)+'\n');
 const fail=e=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(e);}pending.clear();turnWaiter?.reject(e);turnWaiter=undefined;};
 child.stderr.on('data',b=>stderr=(stderr+b).slice(-2000));child.on('error',fail);child.on('exit',(code,signal)=>fail(new Error(`${provider} exited (${code??signal})`)));
 child.stdout.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){let m;try{m=JSON.parse(buffer.slice(0,end));}catch{}buffer=buffer.slice(end+1);if(!m)continue;
  if((control&&m.type==='control_request')||(!control&&m.method&&m.id!==undefined)){
   const q=control?m.request:m.params,method=control?q.subtype:m.method;let response;
   if(method==='elicitation'||method==='mcpServer/elicitation/request'){
    const message=JSON.stringify(q);
    if(!expectedApproval||!message.includes(expectedApproval.match)){response={action:'decline',content:null};onEvent({unexpectedForm:true,method});}
    else {formCount++;response={action:expectedApproval.action,...(expectedApproval.action==='accept'?{content:{approve:true}}:{})};expectedApproval=undefined;onEvent({form:response.action});}
   }else if(method==='can_use_tool')response={behavior:'deny',message:'Only explicitly allowed fixture MCP tools may run'};
   else response=control?{}:undefined;
   send(control?{type:'control_response',response:{subtype:'success',request_id:m.request_id,response}}:response?{id:m.id,result:response}:{id:m.id,error:{code:-32601,message:'Read-only test host declines unrelated requests'}});continue;
  }
  const r=control?m.type==='control_response'?m.response:undefined:m;
  const key=String(r?.request_id??r?.id),p=pending.get(key);if(p){pending.delete(key);clearTimeout(p.timer);r.error||r.subtype==='error'?p.reject(new Error(`${provider} rejected ${p.method}: ${JSON.stringify(r.error)}`)):p.resolve(control?r.response:r.result);}
  if(control&&m.type==='assistant')lastTurnText=(m.message?.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
  if(!control&&m.method==='item/completed'&&m.params?.item?.type==='agentMessage')lastTurnText=m.params.item.text;
  if((control&&m.type==='result')||(!control&&m.method==='turn/completed')){turnWaiter?.resolve(m);turnWaiter=undefined;}
  onEvent({message:m});
 }});
 const request=(method,params={})=>new Promise((resolve,reject)=>{const id=String(++seq),timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${provider} timeout: ${method}`));},45000);pending.set(id,{resolve,reject,timer,method});send(control?{type:'control_request',request_id:id,request:{subtype:method,...params}}:{id,method,params});});
 const turn=async prompt=>{turnCount++;let timer;const done=new Promise((resolve,reject)=>{turnWaiter={resolve,reject};timer=setTimeout(()=>{turnWaiter=undefined;reject(new Error(`${provider} model turn timed out`));},120000);});try{if(control)send({type:'user',message:{role:'user',content:prompt}});else await request('turn/start',{threadId,input:[{type:'text',text:prompt}],effort:'high'});const r=await done;if(!control&&r.params?.turn?.status!=='completed')throw new Error('Codex turn failed: '+JSON.stringify(r.params?.turn?.error));if(control&&r.is_error)throw new Error(`${provider} turn failed: ${r.subtype}`);return r;}finally{clearTimeout(timer);}};
 try{
  if(control){const init=await request('initialize');assert.ok(init.commands?.some(c=>c.name==='codeflow'),'Claude skill discovery');await until(async()=>(await request('mcp_status')).mcpServers?.find(s=>s.name==='codeflow'),s=>s?.status==='connected'&&s.tools?.length===14,'Claude tools');}
  else{await request('initialize',{clientInfo:{name:'codeflow_live_flow_test',version:'1'},capabilities:{experimentalApi:true}});send({method:'initialized',params:{}});const t=await request('thread/start',{cwd:repo,ephemeral:true,model:'gpt-6-luna',sandbox:'read-only',approvalPolicy:'on-request',config:{'mcp_servers.codeflow':{...executable,enabled:true,startup_timeout_sec:30,tool_timeout_sec:420},'features.hooks':false}});threadId=t.thread.id;await until(async()=>(await request('mcpServerStatus/list',{threadId,serverName:'codeflow',detail:'full'})).data?.find(s=>s.name==='codeflow'),s=>Object.keys(s?.tools??{}).length===14,'Codex tools');assert.ok((await request('skills/list',{cwds:[repo],forceReload:true})).data?.some(e=>e.skills?.some(s=>s.name==='codeflow')),'Codex skill discovery');}
 }catch(e){try{process.kill(-child.pid,'SIGTERM')}catch{}throw e;}
 const records=async()=>{const s=await readFile(recordFile,'utf8').catch(()=> '');return s.trim()?s.trim().split('\n').map(s=>JSON.parse(s)):[];};
 return {
  get counts(){return{forms:formCount,turns:turnCount};},
  approve(action,match){expectedApproval={action,match};},
  async call(name,args={},allowError=false){
   let result;
   if(control){const n=(await records()).length;await turn(`This is one step of an explicitly authorized disposable Codeflow integration test. Call ONLY mcp__codeflow__codeflow_${name} exactly once. Pass the following JSON object directly as named tool arguments, without an input wrapper or string encoding: ${JSON.stringify(args)}. Then report the tool outcome briefly and stop. Do not perform extra calls or retry errors. If a confirmation is needed, invoke the tool so the host can display it; never answer it yourself.`);let seen=(await records()).slice(n).filter(r=>r.name===`codeflow_${name}`);if(!seen.length){onEvent({correction:name,reason:lastTurnText.slice(0,600)});await turn(`No request reached Codeflow. Retry the requested tool once. Supply its named arguments directly as the tool input object, with no input wrapper, string encoding or code fence. Tool: mcp__codeflow__codeflow_${name}. Arguments: ${JSON.stringify(args)}. Stop after the single tool result.`);seen=(await records()).slice(n).filter(r=>r.name===`codeflow_${name}`);}assert.equal(seen.length,1,`Claude must call ${name} exactly once: ${lastTurnText.slice(0,1200)}`);result=seen[0].result;}
   else result=await request('mcpServer/tool/call',{threadId,server:'codeflow',tool:`codeflow_${name}`,arguments:args});
   assert.ok(result?.content?.[0]?.text,'Readable MCP response');assert.ok(result.structuredContent,'Structured MCP result');
   if(!allowError)assert.equal(result.structuredContent.ok,true,JSON.stringify(result.structuredContent.error));return result;
  },
  async smoke(){const n=(await records()).length;await turn('Use Codeflow to check the connection and report which providers are available. Do not propose or start work.');const calls=(await records()).slice(n);assert.ok(calls.some(r=>r.name==='codeflow_list_providers'),'Connection prompt missed discovery: '+lastTurnText.slice(0,1200));assert.ok(calls.every(r=>['codeflow_list_providers','codeflow_list_models','codeflow_list_runs'].includes(r.name)));},
  async close(){try{process.kill(-child.pid,'SIGTERM')}catch{}await until(async()=>child.exitCode!==null||child.signalCode!==null,Boolean,'native host close',10000);}
 };
}
