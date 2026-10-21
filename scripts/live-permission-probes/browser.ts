import "./environment.js";
// Real-provider probe. Use only the temporary workspace printed by live.ts.
if (!process.argv[2]?.includes('codeflow-live-permissions-') || !process.argv[2].endsWith('/workspace')) throw new Error('Pass the temporary fixture workspace printed by live.ts');
import {createServer} from 'node:http';
import {codexAdapter} from '../../src/adapters/codex.js';
import {createRunPermissions,resolveRunPermissions} from '../../src/run-permissions.js';
let hits=0;const server=createServer((_req,res)=>{hits++;res.setHeader('Content-Type','text/html');res.end('<html><title>Permission fixture</title><body>LOCAL_BROWSER_FIXTURE</body></html>')});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port;
try {const permissions=resolveRunPermissions({policy:createRunPermissions('standard',false,false,['no-command-network']),provider:'codex',mode:'read',currentTrust:'standard',currentTools:false});
const result=await codexAdapter.run({cwd:process.argv[2]!,mode:'read',trust:'standard',permissions,model:'gpt-6.1-sol',effort:'low',timeoutMs:90000,prompt:`Authorized browser permission test against our own temporary local server. Using ONLY native browser tools if offered, open http://127.0.0.1:${port}/ in a NEW test tab, read its body marker, then close only that test tab if possible. Do not inspect existing tabs. No shell, no files, no external sites, no other MCP services, no delegation. If no browser tool is callable, report unavailable. Do not bypass any denial.`},e=>{if(e.kind==='tool_call'||e.kind==='tool_result'||e.kind==='status')console.log(JSON.stringify(e))});console.log(JSON.stringify({result,hits}));}finally{server.closeAllConnections();server.close()}
