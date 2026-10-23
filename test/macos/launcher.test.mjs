import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
const root = fileURLToPath(new URL('../..', import.meta.url));
const arch = process.env.CODEFLOW_MACOS_ARCH ?? process.arch;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
for (const signal of ['SIGTERM', 'SIGKILL']) test(`Electron desktop keeps its backend through window close/reopen and cleans up after ${signal}`, { skip: process.platform !== 'darwin' || arch !== process.arch, timeout: 120000 }, async () => {
  const bundle = join(root, `output/macos/${arch}/Code Flow.app`), contents = join(bundle, 'Contents');
  const executable = join(contents, 'MacOS/Code Flow'); await access(executable);
  execFileSync('codesign', ['--verify', '--deep', '--strict', bundle]);
  assert.match(execFileSync(join(contents, 'Resources/app/node/bin/node'), ['--version'], { encoding: 'utf8' }), /^v22\./);
  const directory = await mkdtemp(join(tmpdir(), 'cf-electron-smoke-')), home = join(directory, 'state');
  const repo = join(directory, "repo"); await mkdir(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "README.md"), "Desktop lifecycle fixture\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Fixture"], { cwd: repo });
  const instance = await electron.launch({ executablePath: executable, args: ['--disable-gpu'], timeout: 60000,
    env: { ...process.env, CODEFLOW_DESKTOP_TEST: '1', FAKE_SLEEP_MS: '10000', CODEFLOW_HOME: home, CODEFLOW_DESKTOP_DATA: join(directory, 'ui'), CODEFLOW_TOKEN: 'desktop-smoke-owner', PATH: `${root}/test/fake-bin:${process.env.PATH}` } });
  const applicationProcess = instance.process();
  let pid;
  try {
    let page = await instance.firstWindow(); await page.getByRole('main').waitFor({ timeout: 60000 });
    const origin = new URL(page.url()).origin, headers = { authorization: 'Bearer desktop-smoke-owner' };
    assert.equal((await fetch(`${origin}/api/health`, { headers })).status, 200);
    pid = JSON.parse(await readFile(join(home, 'server.lock'), 'utf8')).pid;
    const prefs = await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
    assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.sandbox, true);
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    assert.equal(await page.evaluate(() => typeof window.codeflowDesktop?.checkForUpdates), 'function');
    assert.equal(await page.evaluate(() => typeof window.codeflowDesktop?.invoke), 'undefined');
    assert.equal(await instance.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('check-updates').label), 'Check for Updates…');
    // Exercise the real sandbox/preload/IPC/UI path without contacting GitHub or opening a download.
    await instance.evaluate(({ shell }) => {
      const originalFetch = globalThis.fetch;
      globalThis.updateChecks = 0;
      globalThis.fetch = async (url, options) => {
        if (!String(url).startsWith('https://api.github.com/repos/midhunxavier/code-flow/releases')) return originalFetch(url, options);
        globalThis.updateChecks++;
        if (globalThis.updateChecks === 1) return new Response('', { status: 503 });
        const version = '99.0.0-preview.10', tag = `v${version}`, name = `code-flow-${version}-macos-${process.arch}.dmg`;
        return new Response(JSON.stringify([{ tag_name: tag, prerelease: true, assets: [{ name, size: 123, browser_download_url: `https://github.com/midhunxavier/code-flow/releases/download/${tag}/${name}` }] }]));
      };
      shell.openExternal = async url => { globalThis.openedUpdate = url; };
    });
    await page.goto(`${origin}/#/settings/general`);
    const updateCard = page.getByRole('region', { name: 'App updates' });
    await updateCard.getByRole('button', { name: 'Check for updates' }).click();
    await updateCard.getByText(/Could not check for updates/).waitFor();
    await instance.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('check-updates').click());
    await updateCard.getByRole('button', { name: 'Download installer' }).waitFor();
    await page.getByRole('link', { name: 'Update available', exact: true }).waitFor();
    await updateCard.getByRole('button', { name: 'Download installer' }).click();
    assert.match(await instance.evaluate(() => globalThis.openedUpdate), /99\.0\.0-preview\.10-macos-(arm64|x64)\.dmg$/);
    await page.reload();
    await updateCard.getByRole('button', { name: 'Download installer' }).waitFor();
    await mkdir(join(root, 'output/playwright'), { recursive: true });
    await page.screenshot({ path: join(root, `output/playwright/desktop-updates-${signal}.png`) });
    const started = await fetch(`${origin}/api/runs`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ repo, task: "Keep this agent turn running while the window closes", pattern: "solo", roles: { agent: ["claude"] }, options: {} }) });
    assert.equal(started.status, 201);
    const run = await started.json();
    await instance.evaluate(({ app, dialog }) => { globalThis.quitPrompts = 0; const original = dialog.showMessageBox; dialog.showMessageBox = async () => { globalThis.quitPrompts++; dialog.showMessageBox = original; return { response: 0, checkboxChecked: false }; }; app.quit(); });
    for (let i = 0; i < 50 && !await instance.evaluate(() => globalThis.quitPrompts); i++) await pause(100);
    assert.equal(await instance.evaluate(() => globalThis.quitPrompts), 1, "quit offers to keep active agents running");
    await page.reload(); await page.getByRole('main').waitFor();
    assert.equal(JSON.parse(await readFile(join(home, 'server.lock'), 'utf8')).pid, pid);
    await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    assert.equal(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
    assert.equal((await fetch(`${origin}/api/health`, { headers })).status, 200);
    await instance.evaluate(({ app }) => app.emit('activate')); await pause(200);
    assert.equal(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
    assert.equal(JSON.parse(await readFile(join(home, 'server.lock'), 'utf8')).pid, pid);
    let finished;
    for (let i = 0; i < 400; i++) { finished = await (await fetch(`${origin}/api/runs/${run.id}`, { headers })).json(); if (finished.status !== "running") break; await pause(100); }
    assert.equal(finished.status, "done", finished.error);
    assert.equal(finished.steps.filter(step => step.kind === "agent").length, 1, "closing and reopening does not restart an agent");
    await mkdir(join(root, "output/playwright"), { recursive: true });
    await page.screenshot({ path: join(root, `output/playwright/desktop-${signal}.png`) });
    applicationProcess.kill(signal);
    for (let i = 0; i < 150; i++) { try { process.kill(pid, 0); } catch { break; } await pause(100); }
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    await assert.rejects(access(join(home, 'server.lock'))); pid = undefined;
  } finally {
    if (applicationProcess.exitCode === null && applicationProcess.signalCode === null) { applicationProcess.kill('SIGTERM'); }
    if (pid) try { process.kill(pid, 'SIGTERM'); } catch {}
  }
});
