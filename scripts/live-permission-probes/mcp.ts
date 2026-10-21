import "./environment.js";
// Real-provider probe. Use only the temporary workspace printed by live.ts.
if (!process.argv[2]?.includes('codeflow-live-permissions-') || !process.argv[2].endsWith('/workspace')) throw new Error('Pass the temporary fixture workspace printed by live.ts');
import {claudeAdapter} from '../../src/adapters/claude.js';
import {codexAdapter} from '../../src/adapters/codex.js';
import {TeamToolBridge} from '../../src/team-tools.js';
import {createRunPermissions,resolveRunPermissions} from '../../src/run-permissions.js';
const cwd=process.argv[2]!;const bridge=new TeamToolBridge();
try { for(const adapter of [claudeAdapter,codexAdapter]) {
 const calls:string[]=[];const grant=await bridge.issue({identity:{runId:'permission-probe',memberId:adapter.id,attemptId:'fixture'},handler:async request=>{calls.push(request.name);return {messages:[{body:'LOCAL_MCP_FIXTURE'}]}}});
 const permissions=resolveRunPermissions({policy:createRunPermissions('safe',false,false,adapter.id==='claude'?['no-external-tools']:[]),provider:adapter.id,mode:'read',currentTrust:'safe',currentTools:false});
 const result=await adapter.run({cwd,mode:'read',trust:'safe',permissions,teamTools:grant.connection,model:adapter.id==='claude'?'claude-sonnet-5-5':'gpt-6.1-sol',effort:'low',timeoutMs:90000,prompt:'Authorized local MCP fixture check. Call only codeflow_team read_inbox once, if offered. It is a local test server, no messages are sent to people. Do not use shell, browser, other MCP tools, or spawn agents. Report its exact marker or that it was unavailable.'},e=>{if(e.kind==='tool_call'||e.kind==='tool_result'||e.kind==='status')console.log(JSON.stringify({provider:adapter.id,event:e}))});
 console.log(JSON.stringify({provider:adapter.id,result,calls}));grant.revoke();
 }}finally{await bridge.close()}
