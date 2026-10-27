import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright-core';
const root = fileURLToPath(new URL('..', import.meta.url)), token = 'qa-acp-extension-providers', headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const evidence = process.env.QA_ARTIFACT_DIR;
let home: string, data: string, repo: string, base: string, config: string, bundle: string, bundleText: string, manifest: any, project: string, wrapper: string, argvFile: string;
let server: ChildProcess, browser: Browser, page: Page, logs = '';
const errors: string[] = [], expectedRequests: string[] = [];
async function until<T>(read: () => Promise<T>, check: (v: T) => boolean, what: string, ms = 30000) {
  const end = Date.now() + ms;
  let value: T; do {
    value = await read();
    if (check(value))
      return value;
    await new Promise(r => setTimeout(r, 100));
  } while (Date.now() < end); throw new Error(`${what}: ${JSON.stringify(value!)}`);
}
async function request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const r = await fetch(base + path, { headers, method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, value: await r.json() as any };
}
async function api(path: string, body?: unknown, method?: string) {
  const result = await request(path, body, method);
  assert.ok(result.status < 400, JSON.stringify(result));
  return result.value;
}
async function setPolicy(body: unknown) {
  await page.goto('about:blank');
  // Startup provider probes hold the execution fence briefly. Retry only that explicit busy response.
  const result = await until(() => request(`/api/projects/${project}/filesystem-policy`, body, 'PUT'), r => r.status !== 409 || !r.value.error.includes('active application operations'), 'idle filesystem policy update');
  assert.equal(result.status, 200, JSON.stringify(result));
}
async function start(source = config) {
  server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: root, env: { ...process.env, HOME: home, ZDOTDIR: home, SHELL: '/bin/sh', CODEFLOW_HOME: data, CODEFLOW_TOKEN: token, PORT: base.split(':').at(-1), CODEFLOW_REMOTE_PORT: String(Number(base.split(':').at(-1)) === 4355 ? 4357 : Number(base.split(':').at(-1)) + 1), CODEFLOW_EXTENSIONS_FILE: source, CODEFLOW_EXTENSIONS_JSON: '', PATH: `${root}/test/fake-bin:${process.env.PATH}`, FAKE_GH_STATE: join(home, 'gh.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [server.stdout, server.stderr])
    stream?.on('data', c => logs += c);
  await until(() => fetch(base + '/api/health', { headers }).then(r => r.ok, () => false), Boolean, 'server startup');
}
async function stop() {
  // Detach the browser before a deliberate restart so live SSE reconnects are not reported as app failures.
  if (page && !page.isClosed()) await page.goto('about:blank');
  if (server?.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 5000);
      server.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}
async function shot(name: string) {
  if (evidence)
    await page.screenshot({ path: join(evidence, name + '.png'), fullPage: true });
}
async function settings() {
  await page.goto(`${base}/?token=${token}#/settings/agents`);
  const panel = page.getByRole('region', { name: 'ACP connections', exact: true });
  await panel.getByRole('button', { name: 'Add compatible CLI', exact: true }).waitFor();
  return panel;
}
async function fill(panel: ReturnType<Page['locator']>, id: string, name: string, command = process.execPath, args = wrapper + '\nhappy\n') {
  await panel.getByRole('button', { name: 'Add compatible CLI', exact: true }).click();
  await panel.getByLabel('ACP connection ID').fill(id);
  await panel.getByLabel('ACP connection name').fill(name);
  await panel.getByLabel('ACP executable').fill(command);
  await panel.getByLabel('ACP arguments').fill(args);
}
async function extensions() {
  await page.goto(`${base}/?token=${token}#/settings/extensions`);
  const panel = page.getByRole('region', { name: 'Provider and workflow extensions', exact: true });
  await panel.waitFor();
  return panel;
}
before(async () => {
  home = await mkdtemp(join(tmpdir(), 'codeflow-qa-acp-ui-'));
  data = join(home, 'state');
  repo = join(home, 'repo');
  bundle = join(home, 'fixture.mjs');
  config = join(home, 'extensions.json');
  wrapper = join(home, 'argv-fixture.mjs');
  argvFile = join(home, 'argv.jsonl');
  await mkdir(data);
  await mkdir(repo);
  await writeFile(join(home, 'gh.json'), '{"issues":[],"prs":{}}');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await writeFile(join(repo, 'README.md'), 'Fixture\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', 'commit', '-qm', 'Initial'], { cwd: repo });
  await writeFile(wrapper, `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(argvFile)},JSON.stringify(process.argv.slice(2))+'\\n');await import(${JSON.stringify(pathToFileURL(join(root, 'test/fake-acp.mjs')).href)});`);
  bundleText = `export default {api:{major:1,minor:0},providers:[{id:'plugin:qa-providers/local',displayName:'Fixture Extension',binary:'node',available:async()=>true,catalog:async()=>({models:[],efforts:[],allowCustom:true}),run:async()=>{throw new Error('An unverified provider must never run')}}],workflows:[{id:'plugin:qa-providers/workflow',name:'Fixture workflow',summary:'QA workflow',description:'QA local workflow',roles:[{id:'agent',label:'Provider',description:'Built-in provider',default:['claude']}],options:[],run:async(ctx)=>{const tree=await ctx.worktree('result');const result=await ctx.ask({title:'Fixture turn',role:'agent',agent:ctx.agent('agent'),mode:'write',cwd:tree,prompt:ctx.task});await ctx.commit(tree,'Fixture checkpoint');if(ctx.task.includes('PLUGIN-FAIL'))throw new Error('QA fixture failed intentionally');return result.finalText;}}]};`;
  manifest = { id: 'qa-providers', version: '1.0.0', module: bundle, sha256: createHash('sha256').update(bundleText).digest('hex'), api: { major: 1, minimumMinor: 0 }, requires: ['provider-adapter', 'workflow-pattern'] };
  await writeFile(bundle, bundleText);
  await writeFile(config, JSON.stringify({ version: 1, extensions: [manifest] }));
  if (evidence)
    await mkdir(evidence, { recursive: true });
  const port = Number(process.env.QA_PROVIDERS_PORT) || await new Promise<number>(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => resolve(p)); }); });
  assert.ok(![4317, 4318].includes(port));
  base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ['scripts/build-ui.mjs'], { cwd: root });
  await start();
  project = (await api('/api/projects', { name: 'Provider QA', repos: [repo] })).id;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.setDefaultTimeout(15000);
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {
    if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of (400|403|404|409)/.test(m.text()))
      errors.push(m.text());
  });
  page.on('response', r => {
    if (r.status() >= 500)
      errors.push(`${r.status()} ${r.url()}`);
    if (r.status() >= 400 && r.status() < 500)
      expectedRequests.push(`${r.status()} ${r.url()}`);
  });
  await page.addInitScript(() => { if (location.protocol === 'http:') localStorage.setItem('sideOpen', '0'); });
});
after(async () => {
  await browser?.close();
  await stop();
  if (evidence) {
    await writeFile(join(evidence, 'ui-server.log'), logs);
    await writeFile(join(evidence, 'ui-observations.json'), JSON.stringify({ errors, expectedRequests, home }, null, 2));
  } assert.deepEqual(errors, []);
  assert.doesNotMatch(logs, /UnhandledPromiseRejection|uncaught exception/i);
});
test('ACP field validation blocks check/save, blank argument lines never reach argv, removal confirms and clears probe state', async () => {
  const panel = await settings();
  await fill(panel, 'Bad ID', 'Fixture ACP');
  for (const id of ['Bad ID', 'acp:fixture', 'fixture!']) {
    await panel.getByLabel('ACP connection ID').fill(id);
    assert.equal(await panel.getByLabel('ACP connection ID').evaluate((e: HTMLInputElement) => e.validity.patternMismatch), true);
    await panel.getByRole('button', { name: 'Check connection', exact: true }).click();
    assert.equal(await panel.getByRole('alert').count(), 0);
    await panel.getByRole('button', { name: 'Save connection', exact: true }).click();
    assert.equal((await api('/api/acp-connections')).revision, 0);
  } await shot('01-invalid-id');
  await panel.getByLabel('ACP connection ID').fill('fixture');
  await panel.getByLabel('ACP arguments').fill(wrapper + '\n\n   \nhappy\n  keep spaces  \n');
  await panel.getByRole('button', { name: 'Check connection', exact: true }).click();
  await panel.getByText('Fixture ACP: connected', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Save connection', exact: true }).click();
  await panel.getByRole('button', { name: 'Edit Fixture ACP', exact: true }).waitFor();
  let document = await api('/api/acp-connections');
  assert.deepEqual(document.connections[0].args, [wrapper, 'happy', '  keep spaces  ']);
  for (const line of (await readFile(argvFile, 'utf8')).trim().split('\n'))
    assert.deepEqual(JSON.parse(line), ['happy', '  keep spaces  ']);
  await panel.getByRole('button', { name: 'Edit Fixture ACP', exact: true }).click();
  assert.equal(await panel.getByLabel('ACP arguments').inputValue(), wrapper + '\nhappy\n  keep spaces  ');
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  await panel.getByRole('button', { name: 'Check Fixture ACP', exact: true }).click();
  await panel.getByText('Fixture ACP: connected', { exact: true }).waitFor();
  await shot('02-checked-connection-unavailable-copy');
  await panel.getByRole('button', { name: 'Remove Fixture ACP', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Remove ACP connection?', exact: true });
  await confirm.waitFor();
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await api('/api/acp-connections')).revision, document.revision);
  await panel.getByRole('button', { name: 'Remove Fixture ACP', exact: true }).click();
  await confirm.getByRole('button', { name: 'Remove connection', exact: true }).click();
  await panel.getByRole('button', { name: 'Edit Fixture ACP', exact: true }).waitFor({ state: 'detached' });
  assert.equal(await panel.getByText('Fixture ACP: connected', { exact: true }).count(), 0);
  await page.getByText('Removed Fixture ACP', { exact: true }).waitFor();
  await shot('03-confirmed-removal'); document = await api('/api/acp-connections');
  await api('/api/acp-connections', { revision: document.revision, connection: { id: 'acp:fixture', name: 'Fixture ACP', command: process.execPath, args: [wrapper, 'happy'], enabled: true } });
});
test('missing executable name, absolute path and execute permission give actionable UI guidance', async () => {
  const panel = await settings();
  await fill(panel, 'missing', 'Missing Fixture', 'missing-acp-qa-executable', 'acp');
  await panel.getByRole('button', { name: 'Check connection', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: "not found on this computer's PATH" }).waitFor();
  await panel.getByLabel('ACP executable').fill(join(home, 'does-not-exist'));
  await panel.getByRole('button', { name: 'Check connection', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: 'not found at' }).waitFor();
  const file = join(home, 'not-executable');
  await writeFile(file, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
  await panel.getByLabel('ACP executable').fill(file);
  await panel.getByRole('button', { name: 'Check connection', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: 'not executable' }).waitFor();
  assert.doesNotMatch(await panel.innerText(), /exited with code null|ENOENT|EACCES/);
  await shot('04-missing-executable-guidance');
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
});
async function disabledProviders(container: ReturnType<Page['locator']>, shotName: string) {
  await container.getByRole('button', { name: /^Provider:/ }).click();
  for (const name of ['Fixture ACP', 'Fixture Extension']) {
    const item = page.getByRole('menuitem', { name: new RegExp(name) });
    await item.waitFor();
    assert.equal(await item.isDisabled(), true);
    assert.match(await item.innerText(), /Claude Code, Codex or Antigravity/);
  } await shot(shotName);
  await page.keyboard.press('Escape');
}
test('ACP and extension entries are disabled in composer, reply and fork while supported providers remain usable', { timeout: 60000 }, async () => {
  await page.goto(`${base}/?token=${token}#/project/${project}/new`);
  await page.getByLabel('Task', { exact: true }).fill('Reply ready');
  await disabledProviders(page.locator('.composer'), '05-composer-disabled-providers');
  const listing = await api('/api/agents');
  for (const id of ['acp:fixture', 'plugin:qa-providers/local']) {
    const info = listing.find((a: any) => a.id === id);
    assert.equal(info.available, true);
    assert.match(info.blockedReason, /unavailable for runs/);
  } const catalogs = await api('/api/model-catalog');
  for (const provider of ['acp:fixture', 'plugin:qa-providers/local']) assert.match(catalogs.providers.find((entry: any) => entry.provider === provider).blockedReason, /Fixture.*unavailable for runs.*Antigravity/);
  const diagnostics = await api('/api/doctor');
  assert.match(diagnostics.find((x: any) => x.id === 'acp:fixture').warnings.join(' '), /unavailable for runs/);
  const before = (await api('/api/runs')).length;
  for (const provider of ['acp:fixture', 'plugin:qa-providers/local'])
    for (const trust of ['safe', 'standard', 'trusted', 'full']) {
      const r = await request('/api/runs', { repo, project, pattern: 'solo', roles: { agent: [provider] }, task: 'Must not start', options: {}, trust });
      assert.equal(r.status, 400);
      assert.match(r.value.error, /Fixture.*unavailable for runs/);
      assert.doesNotMatch(r.value.error, /require Full access/);
    } assert.equal((await api('/api/runs')).length, before);
  const run = await api('/api/runs', { repo, project, pattern: 'solo', roles: { agent: ['claude'] }, task: 'Reply ready', options: {}, trust: 'standard' });
  await until(() => api(`/api/runs/${run.id}`), r => r.status === 'done', 'Claude completion');
  await page.goto(`${base}/#/run/${run.id}`);
  const reply = page.locator('.runview .chat-controls').last();
  await disabledProviders(reply, '06-reply-disabled-providers');
  await reply.getByRole('button', { name: /^Provider:/ }).click();
  await page.getByRole('menuitem', { name: 'Codex', exact: true }).click();
  const fork = page.getByRole('dialog', { name: 'Fork chat', exact: true });
  await fork.waitFor();
  await disabledProviders(fork, '07-fork-disabled-providers');
  await fork.getByRole('button', { name: 'Cancel', exact: true }).click();
  for (const trust of ['standard', 'full']) {
    const r = await request(`/api/runs/${run.id}/provider-chat`, { agent: 'acp:fixture', trust, message: 'No fork' });
    assert.equal(r.status, 400);
    assert.match(r.value.error, /Fixture ACP.*unavailable for runs/);
  } const control = await api('/api/runs', { repo, project, pattern: 'plugin:qa-providers/workflow', roles: { agent: ['claude'] }, task: 'Reply ready', options: {} });
  await until(() => api(`/api/runs/${control.id}`), r => r.status === 'done', 'workflow with built-in provider');
});
test('rejected, changed and absent workflow bundles give pin recovery guidance on Retry', { timeout: 60000 }, async () => {
  const run = await api('/api/runs', { repo, project, pattern: 'plugin:qa-providers/workflow', roles: { agent: ['claude'] }, task: 'PLUGIN-FAIL Reply ready', options: {} });
  await until(() => api(`/api/runs/${run.id}`), r => r.status === 'failed', 'fixture failure');
  await stop();
  await appendFile(bundle, '\n// intentionally rejected bytes\n');
  await start();
  let panel = await extensions();
  await panel.getByText('Rejected', { exact: true }).waitFor();
  await shot('08-rejected-extension');
  await page.goto(`${base}/?token=${token}#/run/${run.id}`);
  await page.getByRole('button', { name: 'Retry unfinished work', exact: true }).click();
  await page.getByText(/workflow extension.*isn't loaded/).waitFor();
  assert.match(await page.locator('.runview').innerText(), /exact reviewed bundle and SHA-256 pin.*create a new run/);
  await shot('09-retry-pin-guidance');
  await stop();
  await start('');
  const absent = await request(`/api/runs/${run.id}/resume`, {});
  assert.equal(absent.status, 400);
  assert.match(absent.value.error, /Settings.*Extensions.*SHA-256 pin.*new run/);
  await stop();
  const changed = { ...manifest, sha256: createHash('sha256').update(await readFile(bundle)).digest('hex') };
  await writeFile(config, JSON.stringify({ version: 1, extensions: [changed] }));
  await start();
  const mismatch = await request(`/api/runs/${run.id}/resume`, {});
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.value.error, /version changed.*SHA-256 pin.*new run/);
  await stop();
  await writeFile(bundle, bundleText);
  await writeFile(config, JSON.stringify({ version: 1, extensions: [manifest] }));
  await start();
  const restored = await request(`/api/runs/${run.id}/resume`, {});
  assert.equal(restored.status, 200, JSON.stringify(restored));
  await until(() => api(`/api/runs/${run.id}`), r => r.status === 'failed', 'restored workflow ran again');
});
test('Extensions distinguishes invalid configuration, absent configuration, policy deferral and loaded control', { timeout: 60000 }, async () => {
  await stop();
  await writeFile(config, JSON.stringify({ version: 1, extensions: [{ ...manifest, id: 'Bad_ID' }] }));
  await start();
  let panel = await extensions();
  await panel.getByRole('alert').filter({ hasText: 'Extension configuration could not be loaded' }).waitFor();
  assert.equal(await panel.getByText('No extensions configured.', { exact: true }).count(), 0);
  assert.equal((await api('/api/extensions')).configuration.state, 'error');
  await shot('10-invalid-config');
  await stop();
  await writeFile(config, '{"private":"DO-NOT-ECHO-RAW-DOCUMENT", BROKEN');
  await start(); panel = await extensions();
  await panel.getByRole('alert').filter({ hasText: 'not valid JSON' }).waitFor();
  assert.doesNotMatch(await panel.innerText(), /DO-NOT-ECHO/);
  await stop();
  await start(''); panel = await extensions();
  await panel.getByText('No extensions configured.', { exact: true }).waitFor();
  let policy = await api(`/api/projects/${project}/filesystem-policy`);
  await setPolicy({ revision: policy.revision, read: { allow: ['.'], deny: ['secrets'] }, write: { allow: ['.'], deny: [] } });
  await stop();
  await writeFile(config, JSON.stringify({ version: 1, extensions: [manifest] }));
  await start(); panel = await extensions();
  await panel.getByRole('alert').filter({ hasText: 'Extensions deferred' }).waitFor();
  assert.equal((await api('/api/extensions')).configuration.state, 'deferred');
  assert.equal(await panel.getByText('No extensions configured.', { exact: true }).count(), 0);
  await shot('11-policy-deferral'); policy = await api(`/api/projects/${project}/filesystem-policy`);
  await setPolicy({ revision: policy.revision, read: { allow: ['.'], deny: [] }, write: { allow: ['.'], deny: [] } });
  await stop();
  await start(); panel = await extensions();
  await panel.getByText('Loaded', { exact: true }).waitFor();
  assert.equal((await api('/api/extensions')).configuration.state, 'loaded');
  await shot('12-loaded-control');
});
