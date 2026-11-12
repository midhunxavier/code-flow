import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
const root = fileURLToPath(new URL('../..', import.meta.url));
const arch = process.env.CODEFLOW_LINUX_ARCH ?? process.arch;
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const base = join(root, 'output/linux', `code-flow-${pkg.version}-linux-${arch}-unsigned`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const skip = process.platform !== 'linux' || arch !== process.arch || (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && 'Needs a display; run under xvfb-run.');
// Chromium needs user namespaces unless its helper is setuid, which only an installed .deb provides.
const namespaces = () => { try { execFileSync('unshare', ['--user', '--map-root-user', 'true'], { stdio: 'ignore' }); return true; } catch { return false; } };
function installedDeb() {
  try { return execFileSync('dpkg-query', ['-W', '-f=${Version}', 'code-flow'], { encoding: 'utf8' }) === pkg.version.replace('-preview.', '~preview.'); } catch { return false; }
}

async function unpack(format, directory) {
  if (format === 'AppImage') {
    // Exercise the real AppImage runtime and AppRun; extraction avoids requiring FUSE on CI hosts.
    execFileSync(`${base}.AppImage`, ['--appimage-extract'], { cwd: directory, stdio: 'ignore' });
    return { executable: join(directory, 'squashfs-root/AppRun'), args: [] };
  }
  if (installedDeb()) return { executable: '/usr/bin/code-flow', args: [] };
  execFileSync('dpkg-deb', ['-x', `${base}.deb`, join(directory, 'deb')]);
  return { executable: join(directory, 'deb/opt/code-flow/code-flow'), args: namespaces() ? [] : ['--no-sandbox'] };
}

for (const format of ['AppImage', 'deb']) test(`Linux ${format} keeps its backend when the window closes, stops it on quit and keeps history in ~/.codeflow`, { skip, timeout: 240000 }, async t => {
  await access(`${base}.${format}`);
  const directory = await mkdtemp(join(tmpdir(), `cf-linux-${format}-`)), home = join(directory, 'home'), state = join(home, '.codeflow');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(home);
  const { executable, args } = await unpack(format, directory);
  const repo = join(directory, 'repo'); await mkdir(repo);
  await writeFile(join(home, '.gitconfig'), '[user]\n\tname = Linux fixture\n\temail = linux@example.invalid\n');
  // A fresh HOME proves the app uses the default ~/.codeflow store, not a test override.
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), CODEFLOW_DESKTOP_TEST: '1', FAKE_SLEEP_MS: '8000',
    CODEFLOW_DESKTOP_DATA: join(directory, 'ui'), CODEFLOW_TOKEN: 'linux-desktop-owner', PATH: `${root}/test/fake-bin:${process.env.PATH}` };
  delete env.CODEFLOW_HOME;
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
  await writeFile(join(repo, 'README.md'), 'Linux desktop lifecycle fixture\n');
  execFileSync('git', ['add', '.'], { cwd: repo, env });
  execFileSync('git', ['commit', '-qm', 'Fixture'], { cwd: repo, env });
  const headers = { authorization: 'Bearer linux-desktop-owner' };
  const launched = new Set();
  t.after(() => { for (const child of launched) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  async function launch() {
    // Playwright adds --no-sandbox on Linux unless told otherwise; launch exactly as users do.
    const instance = await electron.launch({ executablePath: executable, args: [...args, '--disable-gpu'], chromiumSandbox: true, env, timeout: 90000 });
    launched.add(instance.process());
    const page = await instance.firstWindow(); await page.getByRole('main').waitFor({ timeout: 90000 });
    const origin = new URL(page.url()).origin;
    assert.equal((await fetch(`${origin}/api/health`, { headers })).status, 200);
    return { instance, page, origin, pid: JSON.parse(await readFile(join(state, 'server.lock'), 'utf8')).pid };
  }
  async function quit(instance, pid) {
    const child = instance.process(), exited = new Promise(resolve => child.once('exit', resolve));
    await instance.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); }).catch(() => {});
    await Promise.race([exited, pause(30000)]);
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'Code Flow exits after Quit');
    for (let i = 0; i < 100 && alive(pid); i++) await pause(100);
    assert.equal(alive(pid), false, 'Quit stops the backend');
    await assert.rejects(access(join(state, 'server.lock')));
  }

  let { instance, page, origin, pid } = await launch();
  const prefs = await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.sandbox, true);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  const started = await fetch(`${origin}/api/runs`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ repo, task: 'Keep this agent turn running while the window closes', pattern: 'solo', roles: { agent: ['claude'] }, options: {} }) });
  assert.equal(started.status, 201);
  const run = await started.json();

  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await pause(500);
  assert.equal(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false, 'closing hides the window');
  assert.equal(instance.process().exitCode, null, 'closing the window keeps the app running');
  assert.equal((await fetch(`${origin}/api/health`, { headers })).status, 200, 'closing the window keeps the backend');
  // Opening Code Flow again from the launcher hands off to the running instance and shows its window.
  const second = spawn(executable, [...args, '--disable-gpu'], { env, stdio: ['ignore', 'ignore', 'pipe'] }); launched.add(second);
  let secondErrors = ''; second.stderr.on('data', data => { secondErrors = (secondErrors + data).slice(-4000); });
  const [code, signal] = await new Promise(resolve => second.once('exit', (...result) => resolve(result)));
  assert.equal(code, 0, `the second launch exits after handing off (signal ${signal}):\n${secondErrors}`);
  for (let i = 0; i < 50 && !await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()); i++) await pause(100);
  assert.equal(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true, 'reopening shows the window');
  assert.equal(JSON.parse(await readFile(join(state, 'server.lock'), 'utf8')).pid, pid, 'the same backend keeps running');

  let finished;
  for (let i = 0; i < 400; i++) { finished = await (await fetch(`${origin}/api/runs/${run.id}`, { headers })).json(); if (finished.status !== 'running') break; await pause(100); }
  assert.equal(finished.status, 'done', finished.error);
  assert.equal(finished.steps.filter(step => step.kind === 'agent').length, 1, 'closing and reopening does not restart an agent');
  await mkdir(join(root, 'output/playwright'), { recursive: true });
  await page.screenshot({ path: join(root, `output/playwright/linux-${format}.png`) });
  await quit(instance, pid);

  ({ instance, page, origin, pid } = await launch());
  const history = await (await fetch(`${origin}/api/runs`, { headers })).json();
  assert.equal(history.find(item => item.id === run.id)?.status, 'done', 'history survives quitting and reopening');
  await quit(instance, pid);
});
