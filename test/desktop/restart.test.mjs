import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const source = await readFile(new URL('../../integrations/desktop/main.cjs', import.meta.url), 'utf8');

function fixture({ runs = [{ status: 'running' }], response = 0, offline = false, stalled = false, installFailures = 0, preview = false } = {}) {
  const calls = [], child = new EventEmitter();
  const timers = new Map(); let timerId = 0;
  child.connected = true;
  child.disconnect = () => { calls.push('disconnect'); if (!stalled) queueMicrotask(() => { calls.push('backend-exit'); child.emit('exit', 0); }); };
  child.kill = signal => { calls.push(signal); if (!stalled || signal === 'SIGKILL') { calls.push('backend-exit'); child.emit('exit', 0); } };
  const app = { setName() {}, setPath() {}, requestSingleInstanceLock: () => false, quit: () => calls.push('quit') };
  const electron = { app, autoUpdater: { quitAndInstall: () => { calls.push('install'); if (installFailures-- > 0) throw new Error('Installer unavailable'); } }, dialog: { showMessageBox: async (_window, options) => { calls.push(options.buttons); return { response }; } } };
  const context = vm.createContext({
    require: name => name === 'electron' ? electron : name === './updates.cjs' ? require('../../integrations/desktop/updates.cjs') : require(name),
    __dirname: '/fixture', process: { env: {}, platform: 'darwin', arch: 'arm64' }, fixtureChild: child,
    fetch: async () => { if (offline) throw new Error('offline'); return { ok: true, json: async () => runs }; },
    setTimeout: stalled ? callback => { timers.set(++timerId, callback); return timerId; } : setTimeout,
    clearTimeout: stalled ? id => timers.delete(id) : clearTimeout, setImmediate, URL, AbortSignal,
    fixtureUpdates: preview ? { quitAndInstall: async () => { calls.push('preview-helper-ready'); return false; } } : undefined,
  });
  vm.runInContext(`${source}\nupdates = fixtureUpdates; backend = fixtureChild; fixtureChild.once('exit', () => { backend = undefined; }); origin = 'http://localhost:4318'; globalThis.restart = () => quit(true);`, context);
  calls.length = 0;
  return { calls, restart: context.restart, advance: () => { const [id, callback] = timers.entries().next().value; timers.delete(id); callback(); } };
}

test('restart cancellation preserves working agents and never invokes the installer', async () => {
  const f = fixture();
  assert.equal(await f.restart(), false);
  assert.deepEqual(Array.from(f.calls[0]), ['Keep running', 'Save progress and restart']);
  assert.equal(f.calls.length, 1);
});

test('approved update waits for backend exit before installing and suppresses duplicate restart requests', async () => {
  const f = fixture({ response: 1 });
  const pending = f.restart();
  assert.equal(await f.restart(), false);
  assert.equal(await pending, true);
  assert.deepEqual(f.calls.slice(1), ['disconnect', 'backend-exit', 'install']);
});

test('unknown agent state requires confirmation; idle backend shuts down without a prompt', async () => {
  const offline = fixture({ offline: true });
  assert.equal(await offline.restart(), false);
  assert.equal(offline.calls.length, 1);
  const idle = fixture({ runs: [] });
  assert.equal(await idle.restart(), true);
  assert.deepEqual(idle.calls, ['disconnect', 'backend-exit', 'install']);
});

test('a stalled backend must exit after escalation before the updater can restart', async () => {
  const f = fixture({ runs: [], stalled: true });
  const pending = f.restart();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, ['disconnect']);
  f.advance();
  assert.deepEqual(f.calls, ['disconnect', 'SIGTERM']);
  f.advance();
  assert.equal(await pending, true);
  assert.deepEqual(f.calls, ['disconnect', 'SIGTERM', 'SIGKILL', 'backend-exit', 'install']);
});

test('a synchronous installer failure leaves restart retryable', async () => {
  const f = fixture({ runs: [], installFailures: 1 });
  await assert.rejects(f.restart(), /Installer unavailable/);
  assert.equal(await f.restart(), true);
  assert.deepEqual(f.calls, ['disconnect', 'backend-exit', 'install', 'install']);
});

test('preview helper starts only after backend exit, followed by a normal Electron quit', async () => {
  const cancelled = fixture({ preview: true });
  assert.equal(await cancelled.restart(), false);
  assert.equal(cancelled.calls.includes('preview-helper-ready'), false);
  const f = fixture({ preview: true, runs: [] });
  assert.equal(await f.restart(), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, ['disconnect', 'backend-exit', 'preview-helper-ready', 'quit']);
});
