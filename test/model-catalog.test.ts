import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const runtimeHome = await mkdtemp(join(tmpdir(), 'codeflow-model-test-runtime-'));
process.env.CODEFLOW_HOME = runtimeHome;
after(() => rm(runtimeHome, {recursive:true,force:true}));
const { ModelCatalogStore, modelEnvironment, resolveModelAssignment, assignmentProblem, workerConstraintProblem, validateCapabilityCatalog } = await import('../src/model-catalog.js');
const { proposeDocumentation, validateDocumentation, researchModels } = await import('../src/model-research.js');
const { discoverModels } = await import('../src/adapters/model-discovery.js');
import type { ModelCatalog } from '../src/adapters/types.js';
const listed = (): ModelCatalog => ({ models: [{ id: 'exact-model', label: 'Exact', aliases: ['default'], efforts: ['low', 'high'] }, { id: 'no-effort', label: 'None', efforts: [] }, { id: 'unknown-effort', label: 'Unknown' }], efforts: [], defaultModel: 'exact-model', allowCustom: false, discovery: { source: 'fixture initialize', verifiedAt: 100, confidence: 'reported' } });
test('persistent discovery is cached, coalesced, offline-capable and preserves immutable provenance', async () => {
    const home = await mkdtemp(join(tmpdir(), 'catalog-test-'));
    let calls = 0, now = 1000000, fail = false;
    const discover = async () => { calls++; if (fail)
        throw Error('SECRET must never persist'); return listed(); };
    try {
        const store = new ModelCatalogStore(home, discover, () => now);
        const [a, b] = await Promise.all([store.get('claude'), store.get('claude')]);
        assert.equal(calls, 1);
        assert.equal(a.revision, b.revision);
        const restored = new ModelCatalogStore(home, discover, () => now);
        assert.equal((await restored.get('claude')).revision, 1);
        assert.equal(calls, 1);
        const selected = resolveModelAssignment(a, 'default', 'high', 'complex task');
        assert.equal(selected.model, 'exact-model');
        assert.equal(selected.catalogRevision, 1);
        assert.equal(workerConstraintProblem(a, selected, ['claude'], { model: 'default', effort: 'high' }), undefined);
        assert.match(workerConstraintProblem(a, selected, ['codex'])!, /allowed pool/);
        assert.match(workerConstraintProblem(a, selected, ['claude'], { model: 'no-effort' })!, /pins/);
        assert.match(workerConstraintProblem(a, selected, ['claude'], { effort: 'low' })!, /pins/);
        assert.match(assignmentProblem(a, 'exact-model', 'ultra')!, /does not report/);
        assert.match(assignmentProblem(a, 'no-effort', 'low')!, /does not report/);
        assert.match(assignmentProblem(a, 'unknown-effort', 'low')!, /does not report/);
        assert.equal(assignmentProblem(a, 'no-effort', ''), undefined);
        assert.match(assignmentProblem(a, 'invented', '')!, /not reported/);
        await Promise.all([store.observe(selected, { runId: 'one', at: 1, ok: true, effort: 'high', durationMs: 50 }), store.observe(selected, { runId: 'two', at: 2, ok: false, effort: 'high', durationMs: 20, errorKind: 'auth' })]);
        assert.equal((await store.read('claude', a.environment))!.models[0]!.observations.length, 2);
        now += 700000;
        fail = true;
        const stale = await store.get('claude');
        assert.equal(stale.state, 'stale');
        assert.equal(stale.issue, 'discovery-unavailable');
        assert.equal(stale.models.length, 3);
        assert.ok(!JSON.stringify(stale).includes('SECRET'));
        assert.throws(()=>validateCapabilityCatalog({...a,models:[a.models[0]!,{...a.models[1]!,aliases:['default']}]}),/Ambiguous/);
        const count = calls;
        assert.equal((await store.get('claude', { offline: true, force: true })).state, 'stale');
        assert.equal(calls, count);
        assert.equal((await store.get('codex', { offline: true })).state, 'unknown');
        assert.ok((await readdir(join(home, 'model-catalogs'))).some(f => f.endsWith('.v1.json')));
        for (const patch of [{ authority: 'full' }, { models: [{ ...a.models[0], permissions: 'all' }] }, { models: [{ ...a.models[0], efforts: ['ultracode'] }] }, { models: [{ ...a.models[0], aliases: [null] }] }])
            assert.throws(() => validateCapabilityCatalog({ ...a, ...patch }));
    }
    finally {
        await rm(home, { recursive: true, force: true });
    }
});
test('environment, account changes and removed models invalidate earlier eligibility', async () => {
    const home = await mkdtemp(join(tmpdir(), 'catalog-test-'));
    let data = listed();
    const store = new ModelCatalogStore(home, async () => data);
    try {
        const a = await store.get('codex');
        const selection = resolveModelAssignment(a, 'exact-model', 'low', 'test');
        await store.observe(selection, { runId: 'one', at: 1, ok: true, effort: 'low', durationMs: 1 });
        data = { ...listed(), accountKey: 'a'.repeat(64) };
        const b = await store.get('codex', { force: true });
        assert.equal(b.models[0]!.observations.length, 0);
        data = { ...data, models: [data.models[1]!], defaultModel: 'no-effort' };
        const c = await store.get('codex', { force: true });
        assert.match(assignmentProblem(c, selection.model, selection.effort)!, /not reported/);
        assert.notEqual(modelEnvironment(), modelEnvironment({}, 'remote-worker'));
        assert.notEqual(modelEnvironment(), modelEnvironment({ isolatedAgy: true }), 'host discovery cannot attest to the isolated worker environment');
        assert.equal((await store.get('codex', { environment: modelEnvironment({}, 'other'), offline: true })).models.length, 0);
    }
    finally {
        await rm(home, { recursive: true, force: true });
    }
});
test('official research rejects authority and untrusted origins; unrelated facts stay unknown', async () => {
    const source = 'https://developers.openai.com/api/docs/models/exact-model';
    const text = 'exact-model 128,000 context window 8,000 max output';
    const d = proposeDocumentation('codex', 'exact-model', source, text)!;
    assert.equal(d.contextTokens, 128000);
    assert.equal(d.maxOutputTokens, 8000);
    assert.equal(d.pricing, null);
    assert.throws(() => validateDocumentation({ ...d, permissions: 'full' }, 'codex', 'exact-model'));
    assert.throws(() => validateDocumentation({ ...d, source: 'https://example.com/fake' }, 'codex', 'exact-model'));
    assert.equal(proposeDocumentation('codex', 'other', source, text), undefined);
    assert.equal(proposeDocumentation('claude', 'exact-model', 'https://code.claude.com/docs/en/model-config', text)!.contextTokens, null);
    let calls = 0;
    const results = await researchModels('codex', ['exact-model'], (async () => { calls++; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }); }) as typeof fetch);
    assert.equal(calls, 1);
    assert.deepEqual(results, []);
});
test('real discovery protocol parsing with mocked CLIs retains exact IDs and aliases', { timeout: 10_000 }, async () => {
    const original = process.env.PATH;
    process.env.PATH = `${fileURLToPath(new URL('./fake-bin', import.meta.url))}:${original}`;
    try {
        for (const provider of ['claude', 'codex'] as const) {
            const catalog = await discoverModels(provider);
            assert.ok(catalog.models.length);
            assert.equal(catalog.discovery?.confidence, 'reported');
            assert.match(catalog.accountKey!, /^[a-f0-9]{64}$/);
            assert.ok(catalog.defaultModel);
            assert.ok(!JSON.stringify(catalog).includes('"account"'));
        }
        const { getAdapter } = await import('../src/adapters/index.js');
        const native = await getAdapter('agy').discoverModels!({});
        assert.deepEqual(native.models.map(model => model.id), ['model-one', 'model-two']);
        assert.equal(native.discovery?.source, 'agy models');
    }
    finally {
        process.env.PATH = original;
    }
});
