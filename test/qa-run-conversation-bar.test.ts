import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), 'codeflow-conversation-unit-'));
const root = fileURLToPath(new URL('..', import.meta.url));
let m: any;
before(async () => {
  Object.assign(globalThis, { window: globalThis, innerWidth: 1440, location: { hostname:'localhost', hash:'', origin:'http://localhost', pathname:'/' }, addEventListener(){}, removeEventListener(){}, localStorage: {getItem:()=>null,setItem(){},removeItem(){}}, sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}} });
  const result=await build({stdin:{contents:'export {markdownNodes} from "./bits.tsx"; export {BrowserMessage} from "./browser-context-cards.tsx"; export * from "./conversation-feedback.ts"; export {plural,agentName,SHORT} from "./lib.ts";',resolveDir:join(root,'ui'),loader:'ts'},bundle:true,write:false,format:'esm',target:'es2022',jsx:'automatic',jsxImportSource:'preact',loader:{'.png':'dataurl','.svg':'dataurl'},logLevel:'error'});
  const file=join(mkdtempSync(join(tmpdir(),'codeflow-conversation-bundle-')),'ui.mjs');writeFileSync(file,result.outputFiles[0]!.text);m=await import(pathToFileURL(file).href);
});
function rendered(nodes: any) {const elements:any[]=[],texts:string[]=[];const walk=(node:any)=>{if(Array.isArray(node))node.forEach(walk);else if(typeof node==='string'||typeof node==='number')texts.push(String(node));else if(node?.props){elements.push(node);walk(node.props.children);}};walk(nodes);return{elements,text:texts.join('')};}
test('file links show parsed labels without granting local or unsafe URL navigation',()=>{
 const out=rendered(m.markdownNodes('Created [`a.ts`](file:///tmp/a.ts) [space](file:///tmp/a%20b.ts) [line](src/c.ts:12) [absolute](/tmp/d.ts) [`web`](https://example.test/a) [evil](javascript:alert(1)) [data](data:text/html,hi) [numeric](javascript:123).'));
 assert.deepEqual(out.elements.filter(e=>e.type==='a').map(e=>e.props.href),['https://example.test/a']);assert.match(out.text,/Created a.ts space line absolute web/);assert.doesNotMatch(out.text,/file:\/\/|src\/c.ts/);assert.match(out.text,/\[evil\]\(javascript:alert\(1\)\)/);assert.match(out.text,/\[data\]\(data:text\/html,hi\)/);assert.match(out.text,/\[numeric\]\(javascript:123\)/);assert.ok(out.elements.some(e=>e.props.title==='file:///tmp/a b.ts'));assert.equal(out.elements.filter(e=>e.type==='code').length,2);
});
test('nested command code inside bold stays formatted, including asterisk globs',()=>{
 for(const command of['true','sleep 1; ! ls broken-*.txt','echo hi; false','codeflow/x/claude']){const out=rendered(m.markdownNodes(`**Approved, and \`${command}\` passes**`));const bold=out.elements.find(e=>e.type==='b');assert.ok(bold);assert.ok(rendered(bold).elements.some(e=>e.type==='code'&&e.props.children===command));assert.doesNotMatch(out.text,/\*\*|`/);}
 const literal=rendered(m.markdownNodes('`**not bold**`'));assert.equal(literal.elements.some(e=>e.type==='b'),false);
});
test('user text is verbatim and agent Markdown preserves dunder identifiers',()=>{
 const text='Update __init__.py so __all__ lists snake_case names.\nRemove __pycache__ and foo__bar__baz. **typed**';const user=rendered(m.BrowserMessage({text}));assert.equal(user.text,text);assert.equal(user.elements.some(e=>e.type==='b'),false);const agent=rendered(m.markdownNodes(text.replace(' **typed**','')));for(const name of['__init__.py','__all__','__pycache__','foo__bar__baz'])assert.ok(agent.text.includes(name));assert.equal(agent.elements.some(e=>e.type==='b'),false);assert.equal(rendered(m.markdownNodes('__real bold__ and **bold**')).elements.filter(e=>e.type==='b').length,2);
});
test('prepared feedback is idempotent without removing user text or later edits',()=>{
 const fix='Investigate and fix the failing checks (false).';let draft=m.appendDraftText('MY OWN NOTE 42',[fix,fix]);draft=m.appendDraftText(draft,[fix]);assert.equal(draft,`MY OWN NOTE 42\n\n${fix}`);assert.equal(m.appendDraftText(draft+'\nKeep this later note',[fix]),draft+'\nKeep this later note');assert.equal(m.appendDraftText('',[fix]),fix);
});
test('error echoes are suppressed while useful partial answers and distinct run errors survive',()=>{
 const raw='Invalid API key · Please run /login',error=`Claude Code isn't signed in. Sign in, then resume. (${raw})`;assert.equal(m.conversationAnswer(raw,error),undefined);assert.equal(m.conversationAnswer(raw,raw),undefined);assert.equal(m.conversationAnswer('I saved the first file.',error),'I saved the first file.');assert.equal(m.conversationAnswer('The API returned 500 and timed out.','error during execution'),'The API returned 500 and timed out.');assert.equal(m.recoveryMessage({error},[{kind:'agent',error}]),"Work is saved. Resume when you're ready.");assert.equal(m.recoveryMessage({error:'A separate run failure'},[{kind:'agent',error}]),'A separate run failure');
});
test('reply sign-in warning uses the selected local provider and singular display labels',()=>{
 const diagnostics=[{id:'claude',name:'Claude Code',installed:true,signedIn:false}];assert.equal(m.replySignInIssue({loop:{}},'claude',diagnostics)?.name,'Claude Code');assert.equal(m.replySignInIssue({loop:{remoteWorker:{workerId:'remote'}}},'claude',diagnostics),undefined);assert.equal(m.replySignInIssue({loop:{agentContainer:'image'}},'claude',diagnostics),undefined);assert.equal(m.replySignInIssue({loop:{}},'codex',diagnostics),undefined);m.SHORT.claude='Claude Code';assert.equal(m.agentName('claude'),'Claude Code');assert.equal(m.agentName('unknown'),'unknown');assert.equal(m.plural(1,'call'),'1 call');assert.equal(m.plural(2,'step'),'2 steps');
});
test('Claude failed result text is an error only; genuine partial output remains an answer',async()=>{
 const previous={path:process.env.PATH,mode:process.env.FAKE_CLAUDE_FAIL};process.env.PATH=`${join(root,'test/fake-bin')}:${previous.path}`;const {getAdapter}=await import('../src/adapters/index.js');
 try{process.env.FAKE_CLAUDE_FAIL='auth';const auth=await getAdapter('claude').run({prompt:'QA auth',cwd:mkdtempSync(join(tmpdir(),'cf-conversation-auth-')),mode:'read'},()=>{});assert.equal(auth.ok,false);assert.equal(auth.errorKind,'auth');assert.equal(auth.finalText,'');assert.match(auth.error!,/Invalid API key/);process.env.FAKE_CLAUDE_FAIL='agent-says-500';const partial=await getAdapter('claude').run({prompt:'QA partial output',cwd:mkdtempSync(join(tmpdir(),'cf-conversation-partial-')),mode:'read'},()=>{});assert.equal(partial.finalText,'The API returned 500 and the request timed out, so I stopped.');}finally{process.env.PATH=previous.path;if(previous.mode===undefined)delete process.env.FAKE_CLAUDE_FAIL;else process.env.FAKE_CLAUDE_FAIL=previous.mode;}
});
