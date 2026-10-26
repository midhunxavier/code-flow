import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
process.env.CODEFLOW_HOME = await mkdtemp('/private/tmp/codeflow-qa-continue/projects-store-log-');
const { Projects } = await import('../src/projects.js');
const fresh = async () => { const home = await mkdtemp('/private/tmp/codeflow-qa-continue/projects-store-'); return { home, file: join(home, 'projects.json') }; };
test('stale metadata cannot undo rename or newly included repository; legacy revisions start at zero', async () => {
    const { file } = await fresh();
    await writeFile(file, JSON.stringify([{ id: 'a', name: 'A', repos: [], createdAt: 1 }]));
    const projects = new Projects(file);
    await projects.load();
    assert.equal(projects.get('a')!.revision, 0);
    const renamed = await projects.update('a', { name: 'First edit' }, 0);
    assert.equal(renamed.revision, 1);
    await assert.rejects(projects.update('a', { name: 'Stale edit' }, 0), /changed.*reload/i);
    const added = await projects.include('a', '/scratch');
    assert.equal(added.project.revision, 2);
    await assert.rejects(projects.update('a', { repos: [] }, 1), /changed.*reload/i);
    assert.deepEqual(projects.get('a')!.repos, ['/scratch']);
});
test('corrupt recovery names its retained backup and distinguishes unreadable storage', async () => {
    const { file } = await fresh();
    await writeFile(file, '{broken');
    const projects = new Projects(file);
    await projects.load();
    assert.equal(projects.status.recovery?.kind, 'set-aside');
    assert.match(projects.status.recovery!.aside!, /^projects.json.corrupt-/);
    assert.equal(await readFile(join(file, '..', projects.status.recovery!.aside!), 'utf8'), '{broken');
    const dir = await fresh();
    await mkdir(dir.file);
    const off = new Projects(dir.file);
    await off.load();
    assert.equal(off.available, false);
    assert.match(off.status.reason!, /couldn't be read.*EISDIR/);
});
test('all storage mutations fail atomically with typed storage errors', async () => {
    const { home, file } = await fresh();
    const projects = new Projects(file);
    await projects.load();
    const p = await projects.create({ name: 'Saved' });
    const before = await readFile(file, 'utf8');
    await chmod(home, 0o500);
    try {
        for (const action of [() => projects.create({ name: 'New' }), () => projects.update(p.id, { name: 'Edited' }), () => projects.include(p.id, '/scratch'), () => projects.remove(p.id)])
            await assert.rejects(action(), e => (e as Error).constructor.name === 'ProjectsStorageError' && /couldn't save/.test((e as Error).message));
    }
    finally {
        await chmod(home, 0o700);
    }
    assert.equal(await readFile(file, 'utf8'), before);
    assert.equal(projects.get(p.id)!.name, 'Saved');
});
test('invalid immovable file reports the actual failed rename, retaining raw bytes', async () => {
    const { home, file } = await fresh();
    await writeFile(file, 'not json');
    await chmod(home, 0o500);
    const projects = new Projects(file);
    try {
        await projects.load();
        assert.equal(projects.available, false);
        assert.match(projects.status.reason!, /valid JSON.*couldn't be moved aside/);
        await assert.rejects(projects.create({ name: 'No' }), /valid JSON.*couldn't be moved aside/);
        assert.equal(await readFile(file, 'utf8'), 'not json');
    }
    finally {
        await chmod(home, 0o700);
    }
});
test('placement increments membership revisions, while defaults and no-op edits preserve them', async () => {
    const { file } = await fresh();
    const projects = new Projects(file);
    await projects.load();
    const p = await projects.create({ name: 'Placement' });
    const placed = await projects.place('/placement', { requested: p.id });
    assert.equal(placed.project.revision, 1);
    await assert.rejects(projects.update(p.id, { name: 'Stale' }, 0), /changed.*reload/i);
    await projects.remember(p.id, { pattern: 'solo', roles: { agent: ['claude'] } });
    assert.equal(projects.get(p.id)!.revision, 1);
    assert.equal((await projects.update(p.id, { name: 'Placement' }, 1)).revision, 1);
    await assert.rejects(projects.update(p.id, { name: 'Bad' }, -1), /nonnegative integer/);
});
test('partially corrupt projects retain usable entries and disclose the rejected backup', async () => {
    const { file } = await fresh();
    await writeFile(file, JSON.stringify([{ id: 'good', name: 'Good', repos: [], createdAt: 1 }, { bad: true }]));
    const projects = new Projects(file);
    await projects.load();
    assert.equal(projects.list().length, 1);
    assert.equal(projects.status.available, true);
    assert.match(projects.status.recovery!.reason, /1 project/);
    assert.ok(projects.status.recovery!.aside);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).length, 1);
});
