import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
process.env.CODEFLOW_HOME = await mkdtemp(join(tmpdir(), 'codeflow-qa-acp-unit-'));
const { probeAcp } = await import('../src/adapters/acp.js');
const { Extensions } = await import('../src/extensions.js');
const { validateAcpConnection } = await import('../src/acp-connections.js');
const permissions = await import('../src/run-permissions.js');
test('unverified provider reason names the provider and all supported choices without a Full access dead end', () => {
  const policy = permissions.createRunPermissions('full', false, true);
  assert.match(permissions.permissionProviderProblem('acp:fixture', policy)!, /Claude Code, Codex or Antigravity/);
  assert.equal(permissions.runProviderProblem('acp:fixture', 'Fixture ACP')?.startsWith('Fixture ACP'), true);
  assert.equal(permissions.runProviderProblem('claude'), undefined);
});
test('ACP validation names the invalid field while existing empty arguments remain readable', () => {
  const c = { id: 'acp:fixture', name: 'Fixture', command: process.execPath, args: [''], enabled: true };
  assert.deepEqual(validateAcpConnection(c).args, ['']);
  assert.throws(() => validateAcpConnection({ ...c, id: 'acp:Bad ID' }), /Connection ID/);
  assert.throws(() => validateAcpConnection({ ...c, command: 'node acp' }), /Executable/);
});
test('missing and non-executable ACP CLIs have actionable start failure messages', async () => {
  const home = process.env.CODEFLOW_HOME!, file = join(home, 'no-execute');
  await writeFile(file, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
  for (const [command, expected] of [['missing-acp-fixture-qa', /not found on this computer.s PATH.*absolute path/], [join(home, 'missing'), /not found at/], [file, /not executable.*permissions/]] as const) {
    await assert.rejects(probeAcp({ id: 'acp:fixture', name: 'Fixture ACP', command, args: [], enabled: true }), e => { assert.match((e as Error).message, expected); assert.doesNotMatch((e as Error).message, /exited with code null|ENOENT|EACCES/); return true; });
  }
});
test('extension configuration failure and policy deferral are distinct from no configured extensions', async () => {
  const loader = new Extensions({ environment: { CODEFLOW_EXTENSIONS_JSON: '{bad' }, register() { assert.fail('must not execute'); } });
  await assert.rejects(loader.load());
  assert.equal(loader.configuration().state, 'error');
  assert.match(loader.configuration().error!, /JSON/i);
  assert.deepEqual(loader.list(), []);
  const absent = new Extensions({ environment: {}, register() { } });
  await absent.load();
  assert.equal(absent.configuration().state, 'none');
  absent.defer('Policy blocks extension startup');
  assert.equal(absent.configuration().state, 'none');
  const deferred = new Extensions({ environment: { CODEFLOW_EXTENSIONS_JSON: '{"version":1,"extensions":[]}' }, register() { } });
  deferred.defer('Policy blocks extension startup');
  assert.equal(deferred.configuration().state, 'deferred');
  assert.match(deferred.configuration().error!, /Policy/);
});
test('HTML ACP and repository identifiers compile in unicodeSets mode', async () => {
  const ts = await import('typescript'), { readFile } = await import('node:fs/promises');
  let count = 0;
  for (const path of ['../ui/acp-connections.tsx', '../ui/collab-settings.tsx']) {
    const source = ts.createSourceFile(path, await readFile(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (n: import('typescript').Node) => {
      if (ts.isJsxAttribute(n) && n.name.getText(source) === 'pattern') {
        const v = n.initializer && ts.isJsxExpression(n.initializer) ? n.initializer.expression : n.initializer;
        if (v && ts.isStringLiteral(v)) {
          const pattern = new RegExp(`^(?:${v.text})$`, 'v');
          assert.equal(pattern.test('good-id'), true);
          assert.equal(pattern.test('Bad ID'), false);
          assert.equal(pattern.test('acp:fixture'), false);
          count++;
        }
      } ts.forEachChild(n, visit);
    };
    visit(source);
  }
  assert.equal(count, 2);
});
test('live ACP acceptance refuses every preset before probing, launching or writing process state', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { readdir } = await import('node:fs/promises');
  const guardHome = await mkdtemp(join(process.env.CODEFLOW_HOME!, 'guard-'));
  for (const args of [[], ['--agent', 'kilo'], ['--agent', 'cline']]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/test-acp-live.mjs', ...args], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, CODEFLOW_HOME: guardHome, CODEFLOW_LIVE_OPENCODE: 'must-not-probe-a-real-cli', CODEFLOW_LIVE_KILO: 'must-not-probe-a-real-cli', CODEFLOW_LIVE_CLINE: 'must-not-probe-a-real-cli' }, encoding: 'utf8'
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ACP live acceptance is unavailable/);
    assert.match(result.stderr, /No provider was started/);
    assert.doesNotMatch(result.stderr, /executable not found/);
    assert.deepEqual(await readdir(guardHome), [], 'a policy refusal never starts process tracking');
  }
});
test('extension configuration errors are bounded and never echo the configured document or source path', async () => {
  const manifest = { id: 'Bad_ID', version: '1.0.0', module: '/private/path/never-load.mjs', sha256: '0'.repeat(64), api: { major: 1, minimumMinor: 0 }, requires: [] };
  for (const environment of [{ CODEFLOW_EXTENSIONS_JSON: JSON.stringify({ version: 1, extensions: [manifest] }) }, { CODEFLOW_EXTENSIONS_JSON: '{"secret":"never-echo-this-secret", BROKEN' }, { CODEFLOW_EXTENSIONS_FILE: '/private/never-echo-this-file.json' }, { CODEFLOW_EXTENSIONS_FILE: 'relative.json' }, { CODEFLOW_EXTENSIONS_JSON: '{}', CODEFLOW_EXTENSIONS_FILE: '/both.json' }]) {
    const loader = new Extensions({ environment, register() { assert.fail('must not register'); } });
    await assert.rejects(loader.load());
    assert.equal(loader.configuration().state, 'error');
    assert.ok(loader.configuration().error!.length <= 1000);
    assert.doesNotMatch(JSON.stringify(loader.configuration()), /never-echo-this|private\/path/);
  }
});

test('an explicitly configured empty file is invalid, while an empty extension list is loaded', async () => {
  const file = join(process.env.CODEFLOW_HOME!, 'empty-extensions.json');
  await writeFile(file, '');
  const empty = new Extensions({ environment: { CODEFLOW_EXTENSIONS_FILE: file }, register() { assert.fail('must not register'); } });
  await assert.rejects(empty.load(), /not valid JSON/);
  assert.equal(empty.configuration().state, 'error');
  const list = new Extensions({ environment: { CODEFLOW_EXTENSIONS_JSON: '{"version":1,"extensions":[]}' }, register() { } });
  await list.load();
  assert.equal(list.configuration().state, 'loaded');
  assert.deepEqual(list.list(), []);
});

test('unattended provider eligibility retains the managed execution restriction at every trust level', async () => {
  const { providerEligibility } = await import('../src/provider-eligibility.js');
  for (const provider of ['acp:fixture', 'plugin:fixture/local'] as const) for (const trust of ['safe', 'standard', 'trusted', 'full'] as const) {
    assert.match(providerEligibility(provider, { trust, unattended: true, projectTeam: true })!, /unavailable for runs.*Antigravity/);
    assert.doesNotMatch(providerEligibility(provider, { trust, unattended: true })!, /require.*Full access/);
  }
  assert.equal(providerEligibility('claude', { trust: 'standard', unattended: true }), undefined);
});
