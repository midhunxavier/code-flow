import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright-core';
import axe from 'axe-core';
import { settleFiniteAnimations } from './qa-animation-settlement.js';
const root = fileURLToPath(new URL('../..', import.meta.url)), dir = realpathSync(mkdtempSync(join(tmpdir(), 'codeflow-a11y48-'))), home = join(dir, 'home'), repo = join(dir, 'repo');
const token = 'qa-a11y48', headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, evidence = process.env.CODEFLOW_QA_EVIDENCE_DIR;
let base: string, server: ChildProcess, browser: Browser, page: Page | undefined, project: string, solo: string, long: string, plan: string, logs = '';
const errors: string[] = [];
async function api(path: string, body?: unknown): Promise<any> {
  const r = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  assert.ok(r.ok, `${path}: ${r.status} ${await r.clone().text()}`);
  return r.json();
}
async function until<T>(get: () => Promise<T>, accept: (v: T) => boolean): Promise<T> {
  const end = Date.now() + 35000;
  for (;;) {
    const v = await get();
    if (accept(v))
      return v;
    assert.ok(Date.now() < end, JSON.stringify(v).slice(0, 1000));
    await new Promise(r => setTimeout(r, 60));
  }
}
const done = (id: string) => until(() => api(`/api/runs/${id}`), r => r.status !== 'running' && !!r.endedAt);
const start = (extra: Record<string, unknown> = {}) => api('/api/runs', { repo, project, pattern: 'solo', task: 'Keyboard fixture', roles: { agent: ['claude'] }, toolApprovals: false, loop: { check: 'true', maxSteps: 20 }, ...extra });
async function open(hash: string, opts: Record<string, any> = {}, init: Record<string, string> = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', ...opts });
  await ctx.addInitScript(values => {
    localStorage.setItem('sideOpen', '0');
    for (const [k, v] of Object.entries(values))
      localStorage.setItem(k, v);
  }, init);
  page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/?token=${token}#/${hash}`);
  await page.locator('#main-content').waitFor();
  return page;
}
async function shot(name: string) {
  if (evidence && page) {
    mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, name + '.png'), animations: 'disabled' });
  }
}
async function audit(p: Page, name: string, selector = 'body') {
  await settleFiniteAnimations(p);
  await p.addScriptTag({ content: axe.source });
  const result = await p.evaluate(async (selector) => (window as any).axe.run(selector, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }), selector);
  if (evidence)
    writeFileSync(join(evidence, name + '.json'), JSON.stringify(result, null, 2));
  assert.deepEqual(result.violations.map((v: any) => ({ id: v.id, nodes: v.nodes.map((n: any) => n.target) })), []);
}
before(async () => {
  for (const folder of [home, repo])
    mkdirSync(folder);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), 'Keyboard QA\n');
  mkdirSync(join(repo, '.codeflow'));
  writeFileSync(join(repo, '.codeflow', 'config.json'), JSON.stringify({ prove: false }));
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=QA', '-c', 'user.email=qa@test', 'commit', '-qm', 'base'], { cwd: repo });
  execFileSync(process.execPath, ['scripts/build-ui.mjs'], { cwd: root, env: { ...process.env, CODEFLOW_HOME: home } });
  const port = await new Promise<number>(resolve => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
  assert.ok(port !== 4317 && port !== 4318);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: root, env: { ...process.env, CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PORT: String(port), PATH: `${join(root, 'test/fake-bin')}:${process.env.PATH}`, FAKE_NO_APP_SERVER: '1' }, stdio: 'pipe' });
  for (const s of [server.stdout, server.stderr])
    s?.on('data', v => logs += String(v));
  await until(() => fetch(base + '/api/health', { headers }).then(r => r.ok, () => false), Boolean);
  project = (await api('/api/projects', { name: 'Keyboard QA', repos: [repo] })).id;
  solo = (await done((await start()).id)).id;
  long = (await done((await start({ task: Array.from({ length: 35 }, (_, n) => `Line ${n + 1}: Review keyboard access to each part of the project and preserve every requirement.`).join('\n') })).id)).id;
  plan = (await start({ pattern: 'auto-team', task: 'AUTO-USER-QUESTION add a greeting', roles: { coordinator: ['claude'], pool: ['claude'] }, approvals: { plan: true } })).id;
  await until(() => api(`/api/runs/${plan}`), r => !!r.awaiting);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  if (evidence)
    mkdirSync(evidence, { recursive: true });
}, { timeout: 60000 });
afterEach(async (t) => {
  if (page) {
    await shot(t.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 90));
    await page.context().close();
    page = undefined;
  }
}, { timeout: 20000 });
after(async () => {
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise(r => server.once('exit', r));
    server.kill('SIGTERM');
    await exited;
  }
  if (evidence) {
    writeFileSync(join(evidence, 'server.log'), logs);
    writeFileSync(join(evidence, 'page-errors.json'), JSON.stringify(errors));
  }
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(errors, []);
  assert.doesNotMatch(logs, /uncaughtException|unhandledRejection|ReferenceError|TypeError:/);
}, { timeout: 20000 });
test('visible provider, model, branch and permission choices are in accessible names in both themes and phone layout', { timeout: 45000 }, async () => {
  const p = await open(`project/${project}/new`, {}, { repo });
  const provider = p.locator('.taskbox').getByRole('button', { name: /^Provider: Claude Code/ });
  await provider.waitFor();
  await p.getByRole('button', { name: /^Model: Default model/ }).waitFor();
  await p.getByRole('button', { name: /^Permissions: Ask for approval/ }).waitFor();
  for (const colorScheme of ['light', 'dark'] as const) {
    await p.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await p.waitForFunction(color => document.documentElement.dataset.theme === color, colorScheme);
    await audit(p, `composer-${colorScheme}`);
  }
  await p.setViewportSize({ width: 390, height: 844 });
  await audit(p, 'composer-phone');
});
test('long tasks, plan text, fenced code and phone shortcut lists are named keyboard scrollers', { timeout: 45000 }, async () => {
  const p = await open(`run/${long}`, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const task = p.locator('.run-task');
  await task.waitFor();
  assert.equal(await task.getAttribute('tabindex'), '0');
  assert.equal(await task.getAttribute('aria-label'), 'Your task');
  await task.focus();
  await p.keyboard.press('End');
  await until(() => task.evaluate(e => e.scrollTop), v => v > 0);
  await audit(p, 'long-task');
  await p.goto(`${base}/#/run/${plan}`);
  const body = p.locator('.aw-body');
  await body.waitFor();
  assert.equal(await body.getAttribute('tabindex'), '0');
  await body.focus();
  await p.keyboard.press('PageDown');
  await until(() => body.evaluate(e => e.scrollTop), v => v > 0);
  await audit(p, 'approval-phone');
  await p.locator('#main-content').focus();
  await p.keyboard.press('?');
  const shortcuts = p.getByRole('region', { name: 'Shortcut list' });
  await shortcuts.waitFor();
  assert.equal(await shortcuts.getAttribute('tabindex'), '0');
  await shortcuts.focus();
  await p.keyboard.press('End');
  await until(() => shortcuts.evaluate(e => e.scrollTop), value => value > 0);
  await audit(p, 'shortcuts-phone');
});
test('memory provenance nodes receive Tab, Enter and Space', { timeout: 45000 }, async () => {
  for (const title of ['Alpha guidance', 'Beta guidance', 'Gamma guidance'])
    await api(`/api/projects/${project}/memory/commands`, { op: 'create', repo, title, body: 'Review the project requirements carefully.\n\n```txt\n' + Array.from({ length: 35 }, (_, n) => 'Example ' + n).join('\n') + '\n```' });
  const p = await open('settings/projects');
  await p.locator('.project-memory > summary').click();
  await p.getByText('Advanced memory tools', { exact: true }).click();
  await p.getByText('Source and derived-entry graph', { exact: true }).click();
  const graph = p.locator('.memory-graph'), nodes = graph.locator('g.mem-node');
  await nodes.first().waitFor();
  assert.equal(await nodes.first().evaluate(e => (e as unknown as HTMLElement).tabIndex), 0);
  await graph.focus();
  await p.keyboard.press('Tab');
  assert.equal(await nodes.first().evaluate(e => e === document.activeElement), true);
  await p.keyboard.press('Enter');
  await p.locator('.memory-analysis [role=status]').getByText(/guidance · revision/).waitFor();
  await nodes.nth(1).focus();
  await p.keyboard.press('Space');
  assert.equal(await nodes.nth(1).evaluate(e => e.classList.contains('on')), true);
  await audit(p, 'memory-graph', '.memory-analysis');
  const code = p.locator('.memory-card pre').first();
  assert.equal(await code.getAttribute('tabindex'), '0');
  await code.focus();
  await p.keyboard.press('End');
  await until(() => code.evaluate(e => e.scrollTop), value => value > 0);
});
test('j and k preserve a navigation sequence when opening unseen runs reorders the rail', { timeout: 45000 }, async () => {
  for (const group of ['status', 'project']) {
    const ids = [];
    for (let n = 0; n < 3; n++)
      ids.push((await done((await start({ task: `Navigate ${group} ${n}` })).id)).id);
    const p = await open('', {}, { railView: JSON.stringify({ group, archived: false, collapsed: [] }), runFilter: JSON.stringify({ status: 'all', pattern: 'solo', agent: '', repo: '' }) });
    await until(() => p.locator('.rail .run-item').count(), n => n >= 3);
    const order = [...ids].reverse();
    for (const id of order.slice(0, 3)) {
      await p.locator('#main-content').focus();
      await p.keyboard.press('j');
      await p.waitForURL(new RegExp(`#/run/${id}$`));
      await until(() => api(`/api/runs/${id}`), r => r.seen === true);
    }
    await p.locator('#main-content').focus();
    await p.keyboard.press('k');
    await p.waitForURL(new RegExp(`#/run/${order[1]}$`));
    await p.context().close();
    page = undefined;
  }
});
test('brackets focus actual chat turns and continue to select workflow steps without stealing typed brackets', { timeout: 45000 }, async () => {
  await api(`/api/runs/${solo}/followups`, { kind: 'reply', agent: 'claude', worktree: 'solo', message: 'One more useful answer' });
  await until(() => api(`/api/runs/${solo}`), r => r.status !== 'running' && r.followUps.at(-1)?.status === 'done');
  const p = await open(`run/${solo}`);
  await until(() => p.locator('.fu .show-work').count(), n => n === 2);
  await p.locator('#main-content').focus();
  await p.keyboard.press('[');
  assert.equal(await p.locator('.fu .show-work').first().evaluate(e => e === document.activeElement), true);
  await p.keyboard.press(']');
  assert.equal(await p.locator('.fu .show-work').last().evaluate(e => e === document.activeElement), true);
  const draft = p.locator('main .convo textarea');
  await draft.fill('');
  await draft.press('[');
  assert.equal(await draft.inputValue(), '[');
  await p.goto(`${base}/#/run/${plan}`);
  await p.locator('.tl-step').first().waitFor();
  await p.locator('#main-content').focus();
  await p.keyboard.press('[');
  assert.equal(await p.locator('.tl-step.selected').count(), 1);
});
test('reduced motion changes JS scrolling immediately and normal motion remains available', { timeout: 45000 }, async () => {
  const p = await open(`run/${plan}`, { viewport: { width: 1280, height: 520 } });
  await p.getByRole('button', { name: 'Review plan', exact: true }).waitFor();
  await p.evaluate(() => {
    const original = Element.prototype.scrollIntoView;
    (window as any).scrollOptions = [];
    Element.prototype.scrollIntoView = function (options) {
      (window as any).scrollOptions.push(options);
      return original.call(this, options);
    };
  });
  for (const reducedMotion of ['reduce', 'no-preference'] as const) {
    await p.emulateMedia({ reducedMotion });
    await p.getByRole('button', { name: 'Review plan', exact: true }).click();
    assert.equal(await p.evaluate(() => (window as any).scrollOptions.at(-1).behavior), reducedMotion === 'reduce' ? 'auto' : 'smooth');
  }
});
test('phone controls stay 16px and landscape leaves transcript room while typing', { timeout: 45000 }, async () => {
  const p = await open(`run/${solo}`, { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
  await p.locator('main .convo textarea').waitFor();
  assert.notEqual(await p.locator('.run-head').evaluate(e => getComputedStyle(e).position), 'sticky');
  for (const value of ['', 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5']) {
    await p.locator('main .convo textarea').fill(value);
    const visible = await p.locator('.run-scroll').evaluate(e => e.clientHeight);
    assert.ok(visible >= 140, `conversation has ${visible}px`);
  }
  await shot('landscape-844-390-draft');
  await p.setViewportSize({ width: 844, height: 340 });
  await p.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  const shortLayout = await p.evaluate(() => Object.fromEntries(['.run-scroll', '.convo', '.chatbox textarea', '.chatbox-bar'].map(selector => {
    const e = document.querySelector(selector)!;
    return [selector, { height: e.clientHeight, max: getComputedStyle(e).maxHeight }];
  })));
  assert.ok((shortLayout['.run-scroll'] as {
    height: number;
  }).height >= 120, JSON.stringify(shortLayout));
  await shot('landscape-844-340-draft');
  await p.setViewportSize({ width: 390, height: 844 });
  await p.goto(`${base}/#/settings/runs`);
  await p.getByRole('heading', { name: 'Run defaults', exact: true }).waitFor();
  const sizes = await p.locator('main select').evaluateAll(nodes => nodes.filter(e => e.getClientRects().length).map(e => ({ name: e.getAttribute('aria-label') || e.id, size: parseFloat(getComputedStyle(e).fontSize) })));
  assert.ok(sizes.length);
  assert.deepEqual(sizes.filter(v => v.size < 16), []);
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});
test('a failed lazy settings chunk has padded recovery on desktop and phone', { timeout: 45000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await ctx.newPage();
  await page.route(/\/assets\/settings-[^/]*\.js/, route => route.abort());
  await page.goto(`${base}/?token=${token}#/settings/general`);
  const alert = page.getByRole('alert').filter({ hasText: 'This view could not load' });
  await alert.waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await alert.evaluate(e => parseFloat(getComputedStyle(e).paddingLeft)) >= 16);
    await alert.getByRole('button', { name: 'Reload app' }).waitFor();
  }
  await page.unroute(/\/assets\/settings-[^/]*\.js/);
  await alert.getByRole('button', { name: 'Reload app' }).click();
  await page.getByRole('heading', { name: 'General', exact: true }).waitFor();
});
