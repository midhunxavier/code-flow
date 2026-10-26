import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const scratch = mkdtempSync(join(tmpdir(), 'codeflow-qa-start-feedback-'));
process.env.CODEFLOW_HOME = join(scratch, 'data');
after(() => rmSync(scratch, { recursive: true, force: true }));
const { validModelId, modelIdProblem } = await import('../src/model-id.js');
const { validateAgentSettings } = await import('../src/adapters/index.js');
const { improveInstructions } = await import('../src/improve.js');
const { directoryPath, listDirectories } = await import('../src/fs.js');
const { listTree } = await import('../src/repo-tree.js');
const { providerProblem, providerSetupProblem } = await import('../ui/provider-readiness.js');
const { startBranchLabel } = await import('../ui/start-branch.js');

test('model editor and CLI dispatch agree on valid, invalid and bounded model IDs', () => {
  for (const model of ['', 'opus', 'claude-sonnet-4-5', 'openrouter/x@y:free', ' x ', 'bad model!!', '--inject', '"q"', 'x'.repeat(101), 'line\nfeed']) {
    const valid = validModelId('claude', model);
    assert.equal(!modelIdProblem('claude', model), valid);
    if (valid) assert.doesNotThrow(() => validateAgentSettings({ claude: { model } }));
    else assert.throws(() => validateAgentSettings({ claude: { model } }), /Invalid model name/);
  }
  assert.equal(validModelId('acp:fixture', 'opaque model with spaces'), true);
  assert.equal(validModelId('acp:fixture', 'x'.repeat(256)), true);
  assert.equal(validModelId('acp:fixture', 'x'.repeat(257)), false);
  assert.equal(validModelId('acp:fixture', 'x\u0001y'), false);
});

test('provider menu and setup reason distinguish installation, sign-in and compatibility', () => {
  const claude = { id: 'claude', displayName: 'Claude Code', binary: 'claude', available: true } as const;
  const signedOut = [{ id: 'claude', name: 'Claude Code', installed: true, signedIn: false }] as const;
  assert.match(providerProblem(claude, signedOut), /Signed out/);
  assert.match(providerSetupProblem([claude], signedOut), /Claude Code isn't signed in/);
  assert.match(providerSetupProblem([{ ...claude, available: false }], null), /Connect a provider/);
  assert.equal(providerSetupProblem([claude], null), '');
  assert.match(providerProblem(claude, [{ ...signedOut[0], signedIn: true, compatible: false }]), /Update CLI/);
});

test('Quick Improve cannot imply an empty user repository and receives separate completion criteria', () => {
  const plain = improveInstructions({ repo: '/not-read', mode: 'quick', text: 'add a version flag' });
  assert.doesNotMatch(plain, /repository is empty|empty (?:private )?(?:Git )?repository/i);
  assert.match(plain, /cannot see the author's project/);
  assert.match(plain, /how to tell it's done/);
  const criteria = improveInstructions({ repo: '/not-read', mode: 'quick', text: 'add a version flag', criteria: ['Print only the pyproject.toml version', 'Exit code is 0'] });
  assert.match(criteria, /Print only the pyproject.toml version/);
  assert.match(criteria, /do not repeat, restate or contradict/);
  assert.doesNotMatch(criteria, /and how to tell it's done/);
  assert.ok(criteria.endsWith('## Task to improve\n\nadd a version flag'));
});

test('directory aliases and tilde expansion produce one canonical selectable path', async () => {
  const repo = join(scratch, 'repo'); mkdirSync(repo); mkdirSync(join(repo, 'child'));
  for (const path of [repo, repo + '/', repo + '/.', repo + '/child/..', repo + '//']) assert.equal((await listDirectories(path)).path, repo);
  assert.equal(directoryPath('~', scratch), scratch);
  assert.equal(directoryPath('~/repo/child/..', scratch), repo);
  assert.equal(directoryPath('~other', scratch).endsWith('/~other'), true, 'other-user shell expansion is deliberately unsupported');
});

test('PR source labels override remembered branches without changing the remembered value', () => {
  const remembered = 'local-topic';
  assert.equal(startBranchLabel({ kind: 'pr', number: 7, headRefName: 'remote-topic' }, remembered, 'main'), 'PR #7 · remote-topic');
  assert.equal(startBranchLabel(null, remembered, 'main'), remembered);
  assert.equal(startBranchLabel(null, '', 'main'), 'main');
});

test('large nested tree reports its cap while exact-cap folders remain complete', async () => {
  const repo = join(scratch, 'tree'); mkdirSync(repo); mkdirSync(join(repo, 'many'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  for (let i = 0; i < 1001; i++) writeFileSync(join(repo, 'many', `file${String(i).padStart(4, '0')}.txt`), 'fixture');
  const large = await listTree(repo, 'many'); assert.equal(large.entries.length, 1000); assert.equal(large.truncated, true);
  rmSync(join(repo, 'many', 'file1000.txt')); assert.equal((await listTree(repo, 'many')).truncated, false);
});
