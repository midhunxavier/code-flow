import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareDockerDesktop } from '../../scripts/prepare-desktop-docker.mjs';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 15 * 60 * 1000 });
const freePort = () => new Promise(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });

test('Docker desktop runs a fixture agent, preserves history, redacts logs, and recovers its owned container', { timeout: 20 * 60 * 1000 }, async t => {
  const desktop = process.env.CODEFLOW_DESKTOP_BUNDLE ? resolve(process.env.CODEFLOW_DESKTOP_BUNDLE) : (await prepareDockerDesktop()).desktop;
  const { image } = JSON.parse(await readFile(join(desktop, 'docker-config.json'), 'utf8'));
  const { startDockerBackend, identity } = require(join(desktop, 'docker.cjs'));
  t.diagnostic(`Testing desktop bundle: ${desktop}`);
  const directory = await mkdtemp(join(tmpdir(), 'codeflow desktop smoke '));
  const workspace = join(directory, 'My projects'), userData = join(directory, 'ui');
  await mkdir(workspace); await chmod(directory, 0o755); await chmod(workspace, 0o777);
  const id = identity(userData), name = `codeflow-desktop-${id}`, volume = `codeflow-desktop-home-${id}-${identity(workspace)}`;
  const fixtureImage = `code-flow-desktop:fixture-${id}`;
  t.after(async () => {
    try { if (docker(['ps', '--all', '--quiet', '--filter', `name=^/${name}$`]).trim()) docker(['rm', '--force', name]); } catch {}
    for (const args of [['volume', 'rm', volume], ['image', 'rm', fixtureImage]]) try { docker(args); } catch {}
    await rm(directory, { recursive: true, force: true });
  });
  t.diagnostic('Building the bundled runtime with pinned official agent CLIs.');
  execFileSync('docker', ['build', '--tag', image, join(desktop, 'docker')], { stdio: 'inherit', timeout: 15 * 60 * 1000 });
  assert.match(docker(['run', '--rm', '--entrypoint', 'claude', image, '--version']), /2\.1\.302/);
  assert.match(docker(['run', '--rm', '--entrypoint', 'codex', image, '--version']), /0\.162\.1/);
  // The lifecycle test uses deterministic CLIs and never signs in or invokes a provider.
  const fixtures = join(directory, 'fixtures'); await mkdir(fixtures);
  for (const file of await readdir(join(root, 'test'))) if (/^fake.*\.mjs$/.test(file)) await cp(join(root, 'test', file), join(fixtures, file));
  await cp(join(root, 'test/fake-bin'), join(fixtures, 'fake-bin'), { recursive: true });
  await writeFile(join(directory, 'Dockerfile'), `FROM ${image}\nCOPY fixtures /opt/fixtures\nENV PATH=/opt/fixtures/fake-bin:/home/node/.local/bin:/usr/local/bin:/usr/bin:/bin FAKE_SLEEP_MS=1000\n`);
  execFileSync('docker', ['build', '--tag', fixtureImage, directory], { stdio: 'inherit', timeout: 60000 });
  const port = await freePort(), token = 'docker-desktop-smoke-owner';
  const options = { workspace, port, token, userData, context: join(desktop, 'docker'), image: fixtureImage };
  let diagnostics = '';
  async function launch() {
    const backend = await startDockerBackend(options);
    backend.stdout.on('data', data => { diagnostics += data; }); backend.stderr.on('data', data => { diagnostics += data; });
    const timeout = setTimeout(() => backend.kill('SIGKILL'), 90000);
    try { await once(backend, 'message', { signal: AbortSignal.timeout(90000) }); }
    catch (error) { throw new Error(`${error.message}\n${diagnostics}`); }
    finally { clearTimeout(timeout); }
    return backend;
  }
  let backend = await launch();
  const origin = `http://localhost:${port}`, headers = { authorization: `Bearer ${token}` };
  assert.equal((await fetch(`${origin}/api/health`, { headers })).status, 200);
  const page = await fetch(origin, { headers }); assert.equal(page.status, 200);
  const assets = [...(await page.text()).matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match => match[1]);
  assert.ok(assets.length > 0, 'The packaged page references generated UI assets.');
  for (const asset of assets) assert.equal((await fetch(origin + asset)).status, 200, asset);
  const inspection = JSON.parse(docker(['inspect', name]))[0];
  assert.deepEqual(inspection.NetworkSettings.Ports[`${port}/tcp`], [{ HostIp: '127.0.0.1', HostPort: String(port) }]);
  assert.equal(inspection.Config.User, 'node');
  assert.equal(inspection.Mounts.some(mount => /docker\.sock/.test(mount.Destination)), false);
  docker(['exec', name, 'node', '-e', `
    const fs = require('node:fs'), { execFileSync: run } = require('node:child_process');
    fs.mkdirSync('/workspace/project'); fs.writeFileSync('/workspace/project/README.md', 'Desktop fixture\\n');
    fs.writeFileSync('/workspace/project/example.ts', 'export function previewSymbol() { return 42; }\\npreviewSymbol();\\n');
    run('git', ['init', '-q', '-b', 'main', '/workspace/project']);
    run('git', ['config', '--global', 'user.name', 'Desktop fixture']);
    run('git', ['config', '--global', 'user.email', 'desktop@example.invalid']);
    run('git', ['add', '.'], { cwd: '/workspace/project' });
    run('git', ['commit', '-qm', 'Fixture'], { cwd: '/workspace/project' });
    fs.writeFileSync('/home/node/desktop-sentinel', 'preserved');
  `]);
  for (const endpoint of ['/api/workspace/search?repo=/workspace/project&q=previewSymbol&mode=semantic', '/api/workspace/dependencies?repo=/workspace/project']) {
    const result = await fetch(origin + endpoint, { headers });
    assert.equal(result.status, 200, await result.clone().text());
    assert.match(await result.text(), /example\.ts/);
  }
  const response = await fetch(`${origin}/api/runs`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ repo: '/workspace/project', task: 'Inspect the desktop fixture and report completion', pattern: 'solo', roles: { agent: ['claude'] }, options: {} }) });
  assert.equal(response.status, 201, await response.clone().text());
  const run = await response.json(); let finished;
  for (let i = 0; i < 300; i++) {
    finished = await (await fetch(`${origin}/api/runs/${run.id}`, { headers })).json();
    if (!['running', 'queued'].includes(finished.status)) break;
    await pause(100);
  }
  assert.equal(finished.status, 'done', JSON.stringify(finished));
  assert.ok(finished.steps.some(step => step.kind === 'agent'));
  // A replacement desktop must remove the previous owned container before reusing its volume.
  const previousExit = once(backend, 'exit'); backend = await launch(); await previousExit;
  assert.equal(docker(['exec', name, 'cat', '/home/node/desktop-sentinel']).trim(), 'preserved');
  assert.equal((await (await fetch(`${origin}/api/runs/${run.id}`, { headers })).json()).status, 'done');
  const logs = docker(['logs', name]);
  assert.equal(logs.includes(token), false); assert.equal(diagnostics.includes(token), false);
  const exited = once(backend, 'exit'); backend.disconnect(); await exited;
  assert.equal(docker(['ps', '--all', '--quiet', '--filter', `name=^/${name}$`]).trim(), '');
  assert.equal(docker(['volume', 'inspect', '--format', '{{.Name}}', volume]).trim(), volume);
  if (process.env.CODEFLOW_DESKTOP_UI_TEST === '1') {
    const { _electron: electron } = await import('playwright-core');
    const ui = join(directory, 'desktop'); await cp(desktop, ui, { recursive: true });
    await writeFile(join(ui, 'docker-config.json'), JSON.stringify({ image: fixtureImage }));
    const instance = await electron.launch({ executablePath: require('electron'), args: [ui, '--disable-gpu'], timeout: 90000,
      env: { ...process.env, CODEFLOW_DESKTOP_DOCKER: '1', CODEFLOW_DESKTOP_DATA: userData, CODEFLOW_DESKTOP_WORKSPACE: workspace, PORT: String(port), CODEFLOW_TOKEN: token, CODEFLOW_DESKTOP_TEST: '1' } });
    t.after(() => instance.close().catch(() => {}));
    let page;
    for (let i = 0; i < 180; i++) { page = instance.windows().find(page => page.url().startsWith(origin)); if (page) break; await pause(500); }
    assert.ok(page, 'The Docker desktop window reached its local service.');
    await page.getByRole('main').waitFor({ timeout: 30000 });
    const preferences = await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('http')).webContents.getLastWebPreferences());
    assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.sandbox, true);
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    await mkdir(join(root, 'output/playwright'), { recursive: true });
    await page.screenshot({ path: join(root, 'output/playwright/windows-docker-desktop.png') });
    await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('http')).close());
    assert.equal((await fetch(`${origin}/api/health`, { headers })).status, 200);
    await instance.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('show-window').click());
    for (let i = 0; i < 50; i++) { if (await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible()))) break; await pause(100); }
    assert.equal(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible())), true);
    const appExited = once(instance.process(), 'exit', { signal: AbortSignal.timeout(30000) });
    await instance.evaluate(({ app }) => app.quit()); await appExited;
    assert.equal(docker(['ps', '--all', '--quiet', '--filter', `name=^/${name}$`]).trim(), '');
  }
});
