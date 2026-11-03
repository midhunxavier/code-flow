// Interactive helper for test-cli-crash-live.ts. Never auto-accepts native forms.
import {readFileSync} from 'node:fs';import {spawn} from 'node:child_process';
if (!process.stdin.isTTY) throw new Error("Run this helper in an interactive terminal to inspect the native form");
if (!process.argv[2]) throw new Error("Pass the native-current.json path printed by the crash test");
const r=JSON.parse(readFileSync(process.argv[2],'utf8'));
if (!['claude','codex'].includes(r.provider) || !r.repo.includes('/codeflow-crash-live-')) throw new Error("Expected a disposable crash test fixture");
const a={operationId:'native-dialog-'+r.provider,proposalId:r.proposal.proposalId,expectedRevision:r.proposal.revision,proposalHash:r.proposal.proposalHash};
const prompt='This is an explicitly authorized isolated Code Flow native approval test. Call ONLY the Code Flow MCP codeflow_start_run tool with these exact arguments: '+JSON.stringify(a)+'. Let Code Flow display its native approval form. Do not approve it yourself, do not use shell/files/browser or other tools, do not substitute a different workflow. If declined/cancelled, report that and stop; do not retry until I request it. If started, report the run ID then stop without polling or other calls.';
let args;
if(r.provider==='claude')args=['--model',r.model,'--effort','high','--permission-mode','manual','--strict-mcp-config','--mcp-config',r.directory+'/native-mcp.json','--settings','{"disableAllHooks":true,"disableWorkflows":true,"ultracode":false}','--no-chrome',prompt];
else { const e=r.executable;const c=`mcp_servers.codeflow={command=${JSON.stringify(e.command)},args=${JSON.stringify(e.args)},env={CODEFLOW_HOME=${JSON.stringify(r.home)}},enabled=true,startup_timeout_sec=30,tool_timeout_sec=600}`;args=['--no-daemon','--no-alt-screen','-C',r.repo,'-m',r.model,'-c','model_reasoning_effort="high"','-c','features.hooks=false','-c',c,'--sandbox','read-only','--ask-for-approval','on-request',prompt];}
const child=spawn(r.provider,args,{cwd:r.repo,env:{...process.env,CODEFLOW_HOME:r.home,TERM:'xterm-256color'},stdio:'inherit'});child.on('exit',c=>process.exit(c??0));
