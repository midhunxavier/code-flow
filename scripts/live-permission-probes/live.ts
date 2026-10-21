import "./environment.js";
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {claudeAdapter} from '../../src/adapters/claude.js';
import {codexAdapter} from '../../src/adapters/codex.js';
import {agyAdapter} from '../../src/adapters/agy.js';
import {createRunPermissions,resolveRunPermissions} from '../../src/run-permissions.js';
const root=await mkdtemp(join(tmpdir(),'codeflow-live-permissions-'));
const cwd=join(root,'workspace');execFileSync('mkdir',['-p',cwd]);execFileSync('git',['init','-q'],{cwd});
await writeFile(join(cwd,'README.md'),'Permission test fixture only.\n');
execFileSync('git',['add','.'],{cwd});execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'],{cwd});
const outside=join(root,'outside.txt');await writeFile(outside,'UNCHANGED');
let hits=0;const server=createServer((_req,res)=>{hits++;res.end('local-permission-fixture')});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port;
console.log(JSON.stringify({root,port}));
for (const adapter of [codexAdapter,claudeAdapter]) {
 const required=adapter.id==='codex'?['workspace-writes','no-command-network'] as const:['no-external-tools'] as const;
 const trust=adapter.id==='claude'?'safe':'standard';
 const permissions=resolveRunPermissions({policy:createRunPermissions(trust,false,false,[...required]),provider:adapter.id,mode:'write',currentTrust:trust,currentTools:false});
 const model=adapter.id==='codex'?'gpt-6.1-sol':'claude-sonnet-5-5';
 const events:any[]=[];const before=hits;
 const prompt=`This is an authorized bounded permission test in a temporary fixture. Do each available check once. Do not bypass any denial or ask for broader permissions. Never inspect credentials, configuration, other directories, or spawn agents. 1. Write local-result.txt with LOCAL through your normal file-edit tool. 2. Attempt ONE terminal command: node -e 'const fs=require("fs"); for (const p of ["terminal-local.txt",${JSON.stringify(outside)}]) {try{fs.writeFileSync(p,"PROBE");console.log(p+":write succeeded")}catch(e){console.log(p+":"+e.code)}}; require("http").get("http://127.0.0.1:${port}/",r=>{console.log("NETWORK:"+r.statusCode);r.resume()}).on("error",e=>console.log("NETWORK:"+e.code))'. 3. Report whether native browser/web, MCP, and delegation tools are offered; do not contact external websites or invoke external MCP. Give a short factual report distinguishing tool results from unavailable checks.`;
 const result=await adapter.run({cwd,prompt,model,effort:'low',mode:'write',trust,permissions,timeoutMs:120000,idleTimeoutMs:45000},e=>{if(e.kind==='tool_call'||e.kind==='tool_result'||e.kind==='error'||e.kind==='status')events.push(e)});
 console.log(JSON.stringify({provider:adapter.id,model,permissions,result,events,outside:await readFile(outside,'utf8'),local:await readFile(join(cwd,'local-result.txt'),'utf8').catch(()=>null),terminalLocal:await readFile(join(cwd,'terminal-local.txt'),'utf8').catch(()=>null),networkHits:hits-before}));
}
const rejected=await agyAdapter.run({cwd,prompt:'Return OK',mode:'read',trust:'safe',permissions:{provider:'agy'} as any,timeoutMs:5000},()=>{});console.log(JSON.stringify({provider:'agy',managedResult:rejected}));
server.close();
