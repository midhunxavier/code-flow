import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { prepareWslDesktop } from '../../scripts/prepare-desktop-wsl.mjs';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });

test('Windows-built WSL payload installs, runs a fixture agent, preserves history and stops only its owned processes', { skip: process.platform !== 'linux', timeout: 180000 }, async t => {
  const desktop = process.env.CODEFLOW_DESKTOP_BUNDLE ? resolve(process.env.CODEFLOW_DESKTOP_BUNDLE) : (await prepareWslDesktop(process.arch)).desktop;
  const config = JSON.parse(await readFile(join(desktop, 'wsl-config.json'), 'utf8'));
  assert.equal(config.arch, process.arch);
  const { fields, READY, identity } = require(join(desktop, 'wsl.cjs'));
  assert.equal(createHash('sha256').update(await readFile(join(desktop, 'wsl/node-linux.tar.gz'))).digest('hex'), config.nodeSha256);
  const directory = await mkdtemp(join(tmpdir(), 'codeflow WSL smoke ')), home = join(directory, 'home'); await mkdir(home);
  const id = identity(directory), env = { ...process.env, HOME: home, CODEFLOW_DESKTOP_CONTAINER: '', FAKE_SLEEP_MS: '100' };
  execFileSync('git', ['config', '--global', 'user.name', 'WSL fixture'], { env });
  execFileSync('git', ['config', '--global', 'user.email', 'wsl@example.invalid'], { env });
  const installed = execFileSync('/bin/sh', [join(desktop, 'wsl/bootstrap.sh'), desktop, config.bundleId, id, config.arch, config.nodeSha256], { env });
  const [node, runner] = fields(installed, 'CODEFLOW_WSL_RUNTIME', 2);
  assert.equal(execFileSync(node, ['--version'], { encoding: 'utf8' }).trim(), `v${config.nodeVersion}`);
  // Repeated startup reuses the complete installation instead of copying it again.
  assert.deepEqual(execFileSync('/bin/sh', [join(desktop, 'wsl/bootstrap.sh'), desktop, config.bundleId, id, config.arch, config.nodeSha256], { env }), installed);
  const path = [join(root, 'test/fake-bin'), dirname(node), process.env.PATH].join(':');
  const port = await freePort(), token = 'wsl-fixture-owner-private', origin = `http://localhost:${port}`, headers = { authorization: `Bearer ${token}` };
  const children = new Set(); let diagnostics = '';
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await rm(directory, { recursive: true, force: true });
  });
  async function launch(nodeArgs = []) {
    const child = spawn(node, [...nodeArgs, runner, id], { env, stdio: ['pipe', 'pipe', 'pipe'] }); children.add(child);
    child.stdout.on('data', data => { diagnostics += data; }); child.stderr.on('data', data => { diagnostics += data; });
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`WSL backend startup timed out.\n${diagnostics}`)), 60000);
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`WSL backend exited: ${code}\n${diagnostics}`)); });
      createInterface({ input: child.stdout }).on('line', line => { if (line.startsWith(READY)) { clearTimeout(timer); resolve(JSON.parse(line.slice(READY.length))); } });
    });
    child.stdin.write(JSON.stringify({ port, token, path }) + '\n');
    const message = await ready; assert.equal(message.id, id); assert.equal(message.port, port);
    return child;
  }
  let child = await launch(['--no-warnings']);
  assert.equal((await fetch(`${origin}/api/health`, { headers })).status, 200);
  const page = await fetch(origin, { headers }); assert.equal(page.status, 200);
  const html = await page.text(); assert.doesNotMatch(html, /\/\*__CSS__\*\/|\/\/__JS__/);
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match => match[1]);
  assert.ok(assets.length > 0); for (const asset of assets) assert.equal((await fetch(origin + asset)).status, 200, asset);
  const repo = join(home, 'project'); await mkdir(repo);
  await writeFile(join(repo, 'example.ts'), 'export function previewSymbol() { return 42; }\npreviewSymbol();\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['-c', 'user.name=WSL fixture', '-c', 'user.email=wsl@example.invalid', 'commit', '-qm', 'Fixture']]) execFileSync('git', args, { cwd: repo, env });
  for (const endpoint of [`/api/workspace/search?repo=${encodeURIComponent(repo)}&q=previewSymbol&mode=semantic`, `/api/workspace/dependencies?repo=${encodeURIComponent(repo)}`]) {
    const response = await fetch(origin + endpoint, { headers }); assert.equal(response.status, 200, await response.clone().text()); assert.match(await response.text(), /example\.ts/);
  }
  const response = await fetch(`${origin}/api/runs`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ repo, task: 'Inspect the WSL desktop fixture', pattern: 'solo', roles: { agent: ['claude'] }, options: {} }) });
  assert.equal(response.status, 201, await response.clone().text()); const run = await response.json(); let finished;
  for (let i = 0; i < 300; i++) { finished = await (await fetch(`${origin}/api/runs/${run.id}`, { headers })).json(); if (!['running', 'queued'].includes(finished.status)) break; await pause(100); }
  assert.equal(finished.status, 'done', JSON.stringify(finished)); assert.ok(finished.steps.some(step => step.kind === 'agent'));
  const oldExit = once(child, 'exit'); child = await launch(); await oldExit;
  assert.equal((await (await fetch(`${origin}/api/runs/${run.id}`, { headers })).json()).status, 'done');
  assert.equal(diagnostics.includes(token), false);
  const exited = once(child, 'exit'); child.stdin.end('stop\n'); await exited;
  const state = join(home, '.codeflow-desktop', id); await assert.rejects(access(join(state, 'desktop-process.json')));
  const unrelated = spawn(node, ['-e', 'setInterval(() => {}, 1000)'], { env, stdio: 'ignore' }); children.add(unrelated);
  await writeFile(join(state, 'desktop-process.json'), JSON.stringify({ pid: unrelated.pid, runner }));
  execFileSync(node, [runner, id, '--stop', 'SIGKILL'], { env });
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0), 'An unrelated process must not be killed by a stale PID record.');
  const unrelatedExit = once(unrelated, 'exit'); unrelated.kill(); await unrelatedExit;
});
