import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'codeflow-qa-pr-picker-'))), repo = join(root, 'repo'), origin = join(root, 'origin.git'), home = join(root, 'data'), bin = join(root, 'bin'), stateFile = join(root, 'gh.json'), argvFile = join(root, 'argv.jsonl');
mkdirSync(bin); mkdirSync(repo); mkdirSync(home);
const ghFixture = fileURLToPath(new URL('./qa-github-pr-open-picker-gh.mjs', import.meta.url)); chmodSync(ghFixture, 0o755); symlinkSync(ghFixture, join(bin, 'gh'));
process.env.CODEFLOW_HOME = home; process.env.FAKE_GH_STATE = stateFile; process.env.FAKE_GH_ARGV = argvFile; process.env.PATH = `${bin}:${fileURLToPath(new URL('./fake-bin', import.meta.url))}:${process.env.PATH}`;
const { listGitHubPicker, updatePullRequestBranch, prMergeInfo, PR_BODY_LIMIT } = await import('../src/github.js');
const { parsePullRequestUrl } = await import('../src/github-url.js');
const { pullRequestTitle, runTitle } = await import('../src/run-title.js');
const { publicationText, pullRequestDescription } = await import('../src/pull-request-description.js');
const { groupPrTargets } = await import('../src/pr-targets.js');
const { issueRepairTask, ciRepairTask } = await import('../src/repair-strategy.js');
const { templates } = await import('../src/templates.js');
const { templateParameters, fillTemplate } = await import('../ui/composer-tools.js');
const { RunManager } = await import('../src/engine.js'); const { findPattern } = await import('../src/patterns/index.js');
const { prDelivery } = await import('../src/result-delivery.js');
type Run = import('../src/engine.js').Run;
const git = (at: string, ...args: string[]) => execFileSync('git', args, { cwd: at, encoding: 'utf8' }).trim();
const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const setState = (fn: (state: any) => void) => { const next = state(); fn(next); writeFileSync(stateFile, JSON.stringify(next)); };
const argv = () => readFileSync(argvFile, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
let head: string;
before(() => {
  mkdirSync(origin); git(origin, 'init', '-q', '--bare', '-b', 'main'); git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 'QA'); git(repo, 'config', 'user.email', 'qa@test'); writeFileSync(join(repo, 'README.md'), 'fixture\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base'); git(repo, 'remote', 'add', 'origin', origin); git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'checkout', '-qb', 'feature'); writeFileSync(join(repo, 'feature.txt'), 'feature\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'feature'); head = git(repo, 'rev-parse', 'HEAD'); git(repo, 'push', '-q', 'origin', 'feature', 'feature:refs/pull/1/head'); git(repo, 'checkout', '-q', 'main');
  writeFileSync(stateFile, JSON.stringify({ issues: Array.from({length:60}, (_, i) => ({number:i+1, title:i === 54 ? 'Legacy parser crash' : `Issue ${i+1}`, body:'issue fixture', state:'OPEN', url:`https://github.com/o/r/issues/${i+1}`, labels:[]})), prs:Object.fromEntries(Array.from({length:60},(_,i)=>[i+1,{number:i+1,title:i===54?'Legacy parser fix':`PR ${i+1}`,body:'PR fixture',state:'OPEN',url:`https://ghe.example.com/o/r/pull/${i+1}`,headRefName:'feature',baseRefName:'main',isCrossRepository:false,mergeStateStatus:'BEHIND'}])), updatePending:true }));
});
after(() => rmSync(root, { recursive: true, force: true }));

test('picker reports the real cap and reaches old issues/PRs by exact number and search', async () => {
  for (const kind of ['issue','pr'] as const) { const listed=await listGitHubPicker(repo,kind); assert.equal(listed.items.length,50); assert.equal(listed.truncated,true); assert.equal((await listGitHubPicker(repo,kind,'#55')).items[0]!.number,55); assert.equal((await listGitHubPicker(repo,kind,'Legacy parser')).items[0]!.number,55); assert.equal((await listGitHubPicker(repo,kind,'',60)).truncated,false); }
  setState(s=>{s.issues[54].state='CLOSED';}); assert.deepEqual((await listGitHubPicker(repo,'issue','55')).items,[]); setState(s=>{s.issues[54].state='OPEN';});
});

test('GHE operations carry the URL host and exact head lock, malformed identities never update', async () => {
  await updatePullRequestBranch(repo,'https://ghe.example.com/o/r/pull/1',head); const call=argv().find(args=>args.includes('repos/o/r/pulls/1/update-branch'))!; assert.equal(call[call.indexOf('--hostname')+1],'ghe.example.com'); assert.equal(state().updates[0].expected_head_sha,head);
  await prMergeInfo(repo,'https://ghe.example.com/o/r/pull/1'); assert.ok(argv().some(args=>args[0]==='repo' && args[2]==='ghe.example.com/o/r'));
  for (const url of ['http://ghe.example.com/o/r/pull/1','https://user:secret@ghe.example.com/o/r/pull/1','https://ghe.example.com/o/r/pull/1?q=x','https://ghe.example.com/o/r/pull/1#x','https://ghe.example.com/o/r/pull/0','https://ghe.example.com/o/r/pull/1/other']) { assert.equal(parsePullRequestUrl(url),undefined); await assert.rejects(updatePullRequestBranch(repo,url,head),/cannot be updated/); }
  const info=await prMergeInfo(repo,'1'); assert.equal(prDelivery({...info,url:'invalid',mergeStateStatus:'BEHIND'}).action,'github');
});

test('repair titles identify the source without promoting its title into agent framing', () => {
  const task=issueRepairTask('issue #5'); assert.equal(task.split('\n')[0],'Fix issue #5.'); assert.equal(ciRepairTask('pull request #9').split('\n')[0],'Make CI pass on pull request #9.');
  const run={id:'run',task,source:{kind:'issue',number:5,title:'Crash on empty input'}} as Run; assert.equal(pullRequestTitle(run),'Fix #5: Crash on empty input'); assert.equal(runTitle(run),'Fix #5: Crash on empty input'); assert.doesNotMatch(task,/Crash on empty/);
  const long=pullRequestTitle({...run,source:{...run.source!,title:'Very long issue title '.repeat(30)}}); assert.ok(long.length<=100); assert.ok(long.endsWith('…')); assert.doesNotMatch(long,/First confirm/);
});

test('large task publication retains closure, summary, checks, provenance and balanced details without local paths', () => {
  const run={id:'run',task:issueRepairTask('issue #5')+'\n'+ '<attack>log</attack>\n'.repeat(8000),source:{kind:'issue',number:5,title:'Crash'},repo,worktrees:[{path:join(repo,'.worktrees/build')}],roles:{agent:['claude']},loop:{check:'true'},verdict:'passed',summary:`Cause: empty input. Fixed and tested. [README](file://${repo}/.worktrees/build/README.md#L3) [secret](file:///Users/another/private.txt) ${repo}/.worktrees/build/src/main.ts`} as unknown as Run;
  const body=pullRequestDescription(run,'Fix & review','## Visual evidence\nfixture.png'); assert.ok(body.length<=PR_BODY_LIMIT); assert.ok(body.startsWith('Closes #5')); assert.match(body,/Cause: empty input/); assert.match(body,/Check: true — passing/); assert.match(body,/Made by a code-flow team/); assert.match(body,/README.md#L3/); assert.doesNotMatch(body,/file:\/\/|\/Users\/another|\.worktrees\/build|<attack>/); assert.ok(body.endsWith('</pre>\n</details>')); assert.match(body,/Visual evidence/); assert.match(body,/truncated/);
  assert.equal(publicationText('file:///unknown/private.txt',[repo]),'[local file omitted]');
});

test('PR targets rank initial and default, group run branches and preserve stacked bases', () => {
  const all=['codeflow/old/build','feature/z','main','codeflow/self/build','custom/run/result']; const grouped=groupPrTargets(all,'main','main','codeflow/self/build',new Set(['custom/run/result'])); assert.deepEqual(grouped.branches,['main','feature/z']); assert.deepEqual(grouped.runBranches,['codeflow/old/build','custom/run/result']); const stacked=groupPrTargets(all,'codeflow/old/build','main','codeflow/self/build'); assert.deepEqual(stacked.branches.slice(0,2),['codeflow/old/build','main']); assert.ok(!stacked.runBranches.includes('codeflow/old/build'));
});

test('dependency upgrade is a required template parameter', () => {
  const template={...templates.find(item=>item.id==='upgrade-dependency')!,criteria:[]}; assert.deepEqual(templateParameters(template),['package']); assert.throws(()=>fillTemplate(template,{}),/package/); assert.match(fillTemplate(template,{package:'mqtt'}).task,/^Upgrade mqtt to/);
});

const manager=new RunManager(findPattern);
const idle=async(run:Run)=>{await new Promise<void>(resolve=>{const check=()=>run.status!=='running'&&resolve(); const off=manager.subscribe(run.id,check); check();});return run;};
test('real engine publication uses issue title and retains evidence from an oversized task', async () => {
  const run=await idle(await manager.start({repo,pattern:findPattern('solo')!,task:issueRepairTask('issue #5'),source:{kind:'issue',number:5},roles:{agent:['claude']},checkpointOnFinish:true,loop:{check:'true'},options:{}})); assert.equal(run.status,'done',run.error);
  run.task+='\n'+ 'large task detail\n'.repeat(7000); run.summary=`Cause fixed. [README](file://${run.worktrees[0]!.path}/README.md#L1)`; const url=await manager.pullRequest(run.id,{branch:run.artifacts[0]!.branch,into:'main'}); const created=state().prs[url.split('/').pop()!]; assert.equal(created.title,'Fix #5: Issue 5'); assert.ok(created.body.startsWith('Closes #5')); assert.match(created.body,/Cause fixed/); assert.doesNotMatch(created.body,/file:\/\//);
});

test('local unpushed commits do not claim the PR moved, remote-only commits do', async () => {
  const run=await idle(await manager.start({repo,pattern:findPattern('solo')!,task:ciRepairTask('pull request #1'),source:{kind:'pr',number:1},roles:{agent:['claude']},checkpointOnFinish:true,loop:{check:'true'},options:{}})); assert.equal(run.status,'done',run.error); const branch=run.artifacts[0]!.branch;
  const local=await manager.resultDelivery(run.id,branch); assert.equal(local.changedSinceRun,false); assert.equal(local.action,'review'); assert.match(local.detail,/not on the PR yet/);
  const tree=git(origin,'rev-parse',`${head}^{tree}`), commit=git(origin,'-c','user.name=QA','-c','user.email=qa@test','commit-tree',tree,'-p',head,'-m','remote-only'); git(origin,'update-ref','refs/heads/feature',commit);
  const remote=await manager.resultDelivery(run.id,branch); assert.equal(remote.changedSinceRun,true); assert.match(remote.detail,/not in this result/);
});
