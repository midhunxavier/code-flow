import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright-core';
const root = fileURLToPath(new URL('..', import.meta.url));
const token = 'qa-projects-ui-store', headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
let home: string, data: string, repo: string, extra: string, base: string, browser: Browser, server: ChildProcess, a: any, b: any;
const evidence = process.env.QA_ARTIFACT_DIR;
let serverLog = '';
const errors: string[] = [], expectedFaults: string[] = [];
async function request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') { const response = await fetch(base + path, { headers, method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, value: await response.json() as any }; }
async function api(path: string, body?: unknown) { const r = await request(path, body); assert.ok(r.status < 400, JSON.stringify(r)); return r.value; }
async function until<T>(read: () => Promise<T>, check: (x: T) => boolean, what: string, ms = 20000) { const end = Date.now() + ms; let value: T; do {
    value = await read();
    if (check(value))
        return value;
    await new Promise(r => setTimeout(r, 100));
} while (Date.now() < end); throw new Error(`${what}: ${JSON.stringify(value!)}`); }
async function start() { server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: root, env: { ...process.env, HOME: home, ZDOTDIR: home, SHELL: '/bin/sh', PORT: base.split(':').at(-1), CODEFLOW_REMOTE_PORT: String(Number(base.split(':').at(-1)) + 1), CODEFLOW_HOME: data, CODEFLOW_TOKEN: token, PATH: `${root}/test/fake-bin:${process.env.PATH}`, FAKE_GH_STATE: join(home, 'fake-gh.json') }, stdio: ['ignore', 'pipe', 'pipe'] }); for (const stream of [server.stdout, server.stderr])
    stream?.on('data', chunk => serverLog += chunk); await until(() => fetch(base + '/api/health', { headers }).then(r => r.ok, () => false), Boolean, 'server startup'); }
async function stop() { if (server?.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise<void>(resolve => { server.once('exit', () => resolve()); setTimeout(resolve, 5000).unref(); });
} }
async function fresh(seed: Record<string, string> = {}, fallback = false) { const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); await context.addInitScript(({ seed, fallback }) => { if (fallback)
    Object.defineProperty(window, 'indexedDB', { value: undefined }); if (sessionStorage.getItem('seeded'))
    return; sessionStorage.setItem('seeded', '1'); localStorage.setItem('sideOpen', '0'); localStorage.setItem('pattern', 'solo'); for (const [k, v] of Object.entries(seed))
    localStorage.setItem(k, v); }, { seed, fallback }); const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message)); page.on('response', response => { if (response.status() >= 500) errors.push(`${response.status()} ${response.url()}`); }); page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of (400|403|404|409|500)/.test(m.text()))
    errors.push(m.text()); }); await page.goto(`${base}/?token=${token}`); return { context, page }; }
async function shot(page: Page, name: string) { if (evidence)
    await page.screenshot({ path: join(evidence, name + '.png'), fullPage: true }); }
async function composer(page: Page, id: string) { await page.goto(`${base}/#/project/${id}/new`); await page.getByLabel('Task', { exact: true }).waitFor(); }
async function edit(page: Page, id: string) { await page.goto(`${base}/#/project/${id}/settings`); await page.getByRole('button', { name: 'Edit project', exact: true }).click(); await page.getByLabel('Name', { exact: true }).waitFor(); return page.getByRole('dialog').filter({ has: page.getByLabel('Name', { exact: true }) }); }
async function chooseFolder(page: Page, path: string, label: string) { const dialog = page.getByRole('dialog', { name: label, exact: true }); await dialog.getByLabel('Folder path', { exact: true }).fill(path); await dialog.getByLabel('Folder path', { exact: true }).press('Enter'); await dialog.getByRole('button', { name: label === 'Add repository' ? 'Add this repository' : 'Open this repository', exact: true }).click(); }
before(async () => { home = await mkdtemp('/private/tmp/codeflow-qa-continue/projects-ui-'); data = join(home, 'state'); repo = join(home, 'repo'); extra = join(home, 'extra'); await mkdir(data); for (const folder of [repo, extra]) {
    await mkdir(folder);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: folder });
    await writeFile(join(folder, 'README.md'), 'QA only\n');
    await mkdir(join(folder, '.codeflow'));
    await writeFile(join(folder, '.codeflow/config.json'), '{"check":"true","setup":"true","prove":false}');
    execFileSync('git', ['add', '.'], { cwd: folder });
    execFileSync('git', ['-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', 'commit', '-qm', 'Fixture'], { cwd: folder });
} await writeFile(join(home, 'fake-gh.json'), '{"issues":[],"prs":{}}'); if (evidence)
    await mkdir(evidence, { recursive: true }); const port = Number(process.env.QA_PROJECTS_PORT) || await new Promise<number>(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => resolve(p)); }); }); assert.ok(![4317, 4318].includes(port)); base = `http://127.0.0.1:${port}`; execFileSync(process.execPath, ['scripts/build-ui.mjs'], { cwd: root }); await start(); a = await api('/api/projects', { name: 'Project Alpha', repos: [repo] }); b = await api('/api/projects', { name: 'Project Beta', repos: [repo] }); browser = await chromium.launch({ channel: 'chrome', headless: true }); });
after(async () => { await browser?.close(); await stop(); await chmod(data, 0o700).catch(() => { }); if (process.platform === 'darwin') execFileSync('chflags', ['nouchg', join(data, 'projects.json')]); if (evidence) {
    await writeFile(join(evidence, 'ui-server.log'), serverLog);
    await writeFile(join(evidence, 'ui-observations.json'), JSON.stringify({ errors, expectedFaults, home }, null, 2));
} assert.deepEqual(errors, []); assert.doesNotMatch(serverLog, /UnhandledPromiseRejection|uncaught exception/i); });
test('solo, provider tabs and side chats move as one family; team run chip is visible', { timeout: 60000 }, async () => {
    const run = await api('/api/runs', { repo, project: a.id, pattern: 'solo', task: 'Reply ready', roles: { agent: ['claude'] }, options: {} });
    await until(() => api(`/api/runs/${run.id}`), r => r.status === 'done', 'solo finish');
    const tab = await api(`/api/runs/${run.id}/provider-chat`, { agent: 'codex' });
    await until(() => api(`/api/runs/${tab.id}`), r => r.status === 'done', 'tab finish');
    const side = await api(`/api/runs/${run.id}/provider-chat`, { agent: 'claude', kind: 'side' });
    await until(() => api(`/api/runs/${side.id}`), r => r.status === 'done', 'side finish');
    const { context, page } = await fresh();
    try {
        await page.goto(`${base}/#/run/${tab.id}`);
        await page.locator('.run-kicker').getByRole('button', { name: 'Project Alpha', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Move to another project' });
        await dialog.getByRole('radio').nth(1).check();
        await dialog.getByRole('button', { name: 'Move', exact: true }).click();
        await page.locator('.run-kicker').getByRole('button', { name: 'Project Beta', exact: true }).waitFor();
        await page.locator('a.crumb').filter({hasText:'Project Beta'}).waitFor();
        for (const id of [run.id, tab.id, side.id])
            assert.equal((await api(`/api/runs/${id}`)).project, b.id);
        assert.equal((await request(`/api/runs/${side.id}/project`, { project: a.id })).status, 400);
        await shot(page, '01-solo-family-moved');
        const team = await api('/api/runs', { repo, project: a.id, pattern: 'pipeline', task: 'Reply ready', roles: { planner: ['claude'], builder: ['codex'], reviewer: ['claude'] }, options: {} });
        await page.goto(`${base}/#/run/${team.id}`);
        await page.locator('.run-kicker').getByRole('button', { name: 'Project Alpha', exact: true }).waitFor();
        await shot(page, '02-team-header-chip');
    }
    finally {
        await context.close();
    }
});
test('Add repository stays in project tools, including existing membership, and never replaces the draft', async () => { const { context, page } = await fresh(); try {
    await composer(page, a.id);
    await page.getByLabel('Task', { exact: true }).fill('Keep this draft');
    await page.goto(`${base}/#/project/${a.id}/repositories`);
    await page.getByRole('button', { name: 'Add repository', exact: true }).click();
    await chooseFolder(page, extra, 'Add repository');
    await page.waitForURL(u => u.hash.includes('/repositories') && u.hash.includes(encodeURIComponent(extra)));
    assert.equal((await api('/api/projects')).length, 2);
    assert.ok((await api('/api/projects')).find((p: any) => p.id === a.id).repos.includes(extra));
    await shot(page, '03-repository-added');
    await page.getByRole('button', { name: 'Add repository', exact: true }).click();
    await chooseFolder(page, extra, 'Add repository');
    await page.getByText('This repository is already in Project Alpha', { exact: true }).waitFor();
    await composer(page, a.id);
    assert.equal(await page.getByLabel('Task', { exact: true }).inputValue(), 'Keep this draft');
}
finally {
    await context.close();
} });
test('overview reads another project saved draft and restores it after reload', async () => { const { context, page } = await fresh(); try {
    await composer(page, a.id);
    await page.getByLabel('Task', { exact: true }).fill('Draft Alpha preview');
    await composer(page, b.id);
    await page.getByLabel('Task', { exact: true }).fill('Draft Beta retained');
    await page.goto(`${base}/#/project/${a.id}`);
    await page.getByText('Continue your draft', { exact: true }).waitFor();
    assert.equal(await page.locator('.draft-preview').innerText(), 'Draft Alpha preview');
    await page.reload();
    await page.getByText('Continue your draft', { exact: true }).waitFor();
    await shot(page, '04-overview-draft-after-reload');
    await page.getByRole('button', { name: 'Continue draft', exact: true }).click();
    assert.equal(await page.getByLabel('Task', { exact: true }).inputValue(), 'Draft Alpha preview');
    await composer(page, b.id);
    assert.equal(await page.getByLabel('Task', { exact: true }).inputValue(), 'Draft Beta retained');
}
finally {
    await context.close();
} });
test('stale editors cannot restore removed repositories or undo a concurrent rename', async () => { const one = await fresh(), two = await fresh(); try {
    const first = await edit(one.page, a.id), second = await edit(two.page, a.id);
    await first.getByRole('button', { name: 'Remove extra', exact: true }).click();
    await first.getByLabel('Name', { exact: true }).fill('Alpha latest');
    await first.getByRole('button', { name: 'Save', exact: true }).click();
    await first.waitFor({ state: 'detached' });
    await second.getByLabel('Name', { exact: true }).fill('Stale name');
    await second.getByRole('button', { name: 'Save', exact: true }).click();
    await second.getByRole('button', { name: 'Reload current project', exact: true }).waitFor();
    assert.equal(await second.getByLabel('Name', { exact: true }).inputValue(), 'Stale name');
    let current = (await api('/api/projects')).find((p: any) => p.id === a.id);
    assert.equal(current.name, 'Alpha latest');
    assert.deepEqual(current.repos, [repo]);
    await shot(two.page, '05-conflict-retains-form');
    await second.getByRole('button', { name: 'Reload current project', exact: true }).click();
    assert.equal(await second.getByLabel('Name', { exact: true }).inputValue(), 'Alpha latest');
    await api(`/api/projects/${a.id}/repositories`, { repo: extra });
    await second.getByLabel('Name', { exact: true }).fill('Another stale');
    await second.getByRole('button', { name: 'Save', exact: true }).click();
    await second.getByRole('button', { name: 'Reload current project', exact: true }).waitFor();
    current = (await api('/api/projects')).find((p: any) => p.id === a.id);
    assert.ok(current.repos.includes(extra));
}
finally {
    await one.context.close();
    await two.context.close();
} });
test('missing project with no repository gives a usable destination prompt', async () => { const { context, page } = await fresh(); try {
    await composer(page, 'missing-project');
    await page.getByLabel('Task', { exact: true }).fill('Preserve my missing project draft');
    await page.locator('.banner').filter({ hasText: 'project is unavailable' }).waitFor();
    assert.equal(await page.locator('.task-start').isDisabled(), true);
    assert.match(await page.locator('.task-start').getAttribute('title') ?? '', /unavailable/);
    await shot(page, '06-missing-project-destination');
    await page.getByRole('button', { name: 'Choose destination', exact: true }).click();
    await page.getByRole('dialog', { name: 'Projects', exact: true }).getByRole('button', { name: /^Project Beta/ }).click();
    assert.equal(await page.getByLabel('Task', { exact: true }).inputValue(), 'Preserve my missing project draft');
}
finally {
    await context.close();
} });
test('corrupt local draft and unsupported IndexedDB draft remain retained while healthy drafts work', async () => {
    const { context, page } = await fresh({ projectDraftVersion: '1', composerProject: a.id, [`project-draft-v1:${a.id}`]: '{corrupt' }, true);
    try {
        await page.getByRole('alert').filter({ hasText: 'stored data has been retained' }).waitFor();
        await composer(page, b.id);
        await page.getByLabel('Task', { exact: true }).fill('Healthy draft still works');
        await page.reload();
        assert.equal(await page.getByLabel('Task', { exact: true }).inputValue(), 'Healthy draft still works');
        assert.equal(await page.evaluate(id => localStorage.getItem(`project-draft-v1:${id}`), a.id), '{corrupt');
        await page.goto(`${base}/#/project/${a.id}/new`);
        await page.getByRole('alert').filter({ hasText: 'stored data has been retained' }).waitFor();
        await page.waitForTimeout(250);
        assert.equal(await page.getByLabel('Task', { exact: true }).inputValue(), 'Healthy draft still works');
        await shot(page, '07-corrupt-draft-healthy-project');
    }
    finally {
        await context.close();
    }
    const second = await fresh();
    try {
        await composer(second.page, b.id);
        await second.page.getByLabel('Task', { exact: true }).fill('IDB healthy draft');
        await second.page.evaluate(async (id) => { await new Promise<void>((resolve, reject) => { const open = indexedDB.open('codeflow-project-drafts', 1); open.onsuccess = () => { const db = open.result, tx = db.transaction('drafts', 'readwrite'); tx.objectStore('drafts').put({ version: 2, task: 'Future draft' }, `project-draft-v1:${id}`); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); }; }); }, a.id);
        await second.page.goto(`${base}/#/project/${a.id}/new`);
        await second.page.getByRole('alert').filter({ hasText: 'unsupported format' }).waitFor();
        assert.equal(await second.page.getByLabel('Task', { exact: true }).inputValue(), 'IDB healthy draft');
        await shot(second.page, '08-unsupported-draft');
        await second.page.evaluate(id => localStorage.setItem('composerProject', id), a.id);
        await second.page.reload();
        await second.page.getByRole('alert').filter({ hasText: 'unsupported format' }).waitFor();
        await composer(second.page, b.id);
        assert.equal(await second.page.getByLabel('Task', { exact: true }).inputValue(), 'IDB healthy draft');
    }
    finally {
        await second.context.close();
    }
});
test('HTTP storage failures consistently return500 and preserve every committed project', async () => { const before = await readFile(join(data, 'projects.json'), 'utf8'); await chmod(data, 0o500); try {
    for (const [path, body, method] of [['/api/projects', { name: 'Blocked' }, 'POST'], [`/api/projects/${b.id}`, { name: 'Blocked' }, 'POST'], [`/api/projects/${b.id}/repositories`, { repo: extra }, 'POST'], [`/api/projects/${b.id}`, undefined, 'DELETE']] as const) {
        const result = await request(path, body, method);
        assert.equal(result.status, 500, JSON.stringify(result));
        assert.match(result.value.error, /couldn't save projects/);
        expectedFaults.push(path);
    }
}
finally {
    await chmod(data, 0o700);
} assert.equal(await readFile(join(data, 'projects.json'), 'utf8'), before); });
test('corrupt file recovery is visible; projects-off UI can launch an unassigned run', { timeout: 60000 }, async () => {
    await stop();
    const file = join(data, 'projects.json');
    await writeFile(file, '{broken');
    await start();
    let health = await api('/api/health');
    assert.equal(health.projects.recovery.kind, 'set-aside');
    assert.equal(await readFile(join(data, health.projects.recovery.aside), 'utf8'), '{broken');
    const first = await fresh();
    try {
        await first.page.getByRole('alert').filter({ hasText: 'Project storage recovered' }).waitFor();
        assert.equal(await first.page.getByText('Your first project', { exact: true }).count(), 0);
        await shot(first.page, '09-corrupt-store-notice');
    }
    finally {
        await first.context.close();
    }
    await stop();
    await writeFile(file, 'not json at all');
    if (process.platform === 'darwin') execFileSync('chflags', ['uchg', file]); else await chmod(file, 0o000);
    try {
        await start();
        health = await api('/api/health');
        assert.equal(health.projects.available, false);
        assert.match(health.projects.reason, process.platform === 'darwin' ? /couldn't be moved aside/ : /couldn't be read/);
        const off = await fresh();
        try {
            await off.page.getByRole('alert').filter({ hasText: 'Projects are off' }).waitFor();
            assert.equal(await off.page.getByText('Your first project', { exact: true }).count(), 0);
            await off.page.getByRole('button', { name: 'Open another repository', exact: true }).click();
            await chooseFolder(off.page, repo, 'Open repository');
            await off.page.getByRole('dialog', { name: 'Open repository', exact: true }).waitFor({ state: 'detached' });
            await off.page.getByLabel('Task', { exact: true }).fill('Reply ready while projects off');
            await off.page.locator('.task-start').click();
            await off.page.waitForURL(u => u.hash.startsWith('#/run/'));
            const run = await api(`/api/runs/${off.page.url().split('#/run/')[1]}`);
            assert.equal(run.project, undefined);
            await shot(off.page, '10-projects-off-unassigned-run');
            if (process.platform === 'darwin') assert.equal(await readFile(file, 'utf8'), 'not json at all');
        }
        finally {
            await off.context.close();
        }
    }
    finally {
        await stop();
        if (process.platform === 'darwin') execFileSync('chflags', ['nouchg', file]); else await chmod(file, 0o600);
    }
    await rm(file);
    await mkdir(file);
    await start();
    health = await api('/api/health');
    assert.match(health.projects.reason, /couldn't be read.*EISDIR/);
    const warm = await fresh({ repo, projectDraftVersion: '1', composerProject: 'gone' });
    try {
        await warm.page.getByRole('alert').filter({ hasText: "couldn't be read" }).waitFor();
        await warm.page.getByRole('button', { name: 'Open unassigned draft', exact: true }).click();
        await warm.page.waitForURL(u => u.hash === '#/new/unassigned');
        await warm.page.getByLabel('Task', { exact: true }).fill('Warm profile recovers');
        await warm.page.locator('.task-start').click();
        await warm.page.waitForURL(u => u.hash.startsWith('#/run/'));
        await shot(warm.page, '11-unreadable-store-warm-profile');
    }
    finally {
        await warm.context.close();
    }
});
