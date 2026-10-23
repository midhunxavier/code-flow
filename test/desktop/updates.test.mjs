import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DesktopUpdates, selectRelease, compareVersions, trustedSender } = require('../../integrations/desktop/updates.cjs');
const version = '0.1.0-preview.2';
function release(next = '0.1.0-preview.10', { arch = 'arm64', signed = true, draft = false, native = true } = {}) {
  const tag_name = `v${next}`, base = `https://github.com/midhunxavier/code-flow/releases/download/${tag_name}/`;
  const names = [`code-flow-${next}-macos-${arch}${signed ? '' : '-unnotarized'}.dmg`, ...(native ? [`code-flow-${next}-macos-${arch}.zip`, `releases-${arch}.json`] : [])];
  return { tag_name, draft, prerelease: next.includes('-'), assets: names.map(name => ({ name, size: 123, browser_download_url: base + name })) };
}
function fixture({ releases = [release()], nativeUpdates = true, enabled = true, fetch: fetchRelease, restart } = {}) {
  const autoUpdater = new EventEmitter();
  let checks = 0, feed, opened;
  autoUpdater.setFeedURL = value => { feed = value; };
  autoUpdater.checkForUpdates = () => { checks++; };
  const updates = new DesktopUpdates({ version, arch: 'arm64', enabled, nativeUpdates, autoUpdater,
    fetch: fetchRelease ?? (async () => ({ ok: true, json: async () => releases })), openExternal: async url => { opened = url; }, restart: restart ?? (async () => true) });
  return { updates, autoUpdater, checks: () => checks, feed: () => feed, opened: () => opened };
}

test('preview ordering is numeric, stable supersedes preview, and unsupported versions are rejected', () => {
  assert.equal(compareVersions('0.1.0-preview.10', version), 1);
  assert.equal(compareVersions('0.1.0', '0.1.0-preview.10'), 1);
  assert.equal(compareVersions('0.2.0-preview.1', '0.1.9'), 1);
  assert.equal(compareVersions(version, version), 0);
  assert.throws(() => compareVersions('0.1.0-preview.01', version));
});

test('selects the newest compatible release, excluding drafts, older builds and other architectures', () => {
  const selected = selectRelease([release(version), release('0.1.0-preview.1'), release(), release('0.1.0-preview.11', { draft: true }), release('0.1.0-preview.12', { arch: 'x64' })], version, 'arm64', true);
  assert.equal(selected.version, '0.1.0-preview.10');
  assert.equal(selected.canInstall, true);
  assert.equal(selectRelease([release()], '0.1.0', 'arm64', true), undefined);
  assert.equal(selectRelease([release('0.2.0-preview.1')], '0.1.0', 'arm64', true), undefined);
  assert.equal(selectRelease([release('0.2.0')], '0.1.0', 'arm64', true).version, '0.2.0');
});

test('unsigned installs and releases without native assets use matching installers; signed installs refuse unsigned downgrades', () => {
  assert.equal(selectRelease([release()], version, 'arm64', false).canInstall, false);
  assert.equal(selectRelease([release(undefined, { native: false })], version, 'arm64', true).canInstall, false);
  const unsigned = release(undefined, { signed: false });
  assert.match(selectRelease([unsigned], version, 'arm64', false).downloadUrl, /arm64-unnotarized\.dmg$/);
  assert.equal(selectRelease([unsigned], version, 'arm64', true), undefined);
  const bad = release(); bad.assets[0].browser_download_url = 'https://example.com/evil.dmg';
  assert.equal(selectRelease([bad], version, 'arm64', true), undefined);
  assert.equal(selectRelease([release('0.2.0-beta.1')], version, 'arm64', true), undefined);
});

test('checks are serialized, never download implicitly, and recover from offline/rate-limit errors', async () => {
  let resolveFetch, calls = 0;
  const f = fixture({ fetch: () => { calls++; return new Promise(resolve => { resolveFetch = resolve; }); } });
  const pending = f.updates.check();
  assert.equal((await f.updates.check()).phase, 'checking');
  assert.equal(calls, 1);
  resolveFetch({ ok: false, status: 403 }); await pending;
  assert.equal(f.updates.state.phase, 'error');
  const retry = f.updates.check();
  resolveFetch({ ok: true, json: async () => [release()] }); await retry;
  assert.equal(f.updates.state.phase, 'available');
  assert.equal(f.checks(), 0);
  assert.ok(f.updates.state.checkedAt);
});

test('native download, duplicate clicks, verification failure, retry and restart cancellation', async () => {
  let restarts = 0;
  const f = fixture({ restart: async () => { restarts++; return false; } });
  await f.updates.install(); assert.equal(restarts, 0);
  await f.updates.check();
  await f.updates.download(); await f.updates.download(); await f.updates.check();
  assert.equal(f.checks(), 1);
  assert.equal(f.updates.state.phase, 'downloading');
  assert.equal(f.feed().serverType, 'json');
  assert.match(f.feed().url, /releases-arm64\.json$/);
  f.autoUpdater.emit('error', new Error('signature verification failed'));
  assert.equal(f.updates.state.phase, 'error');
  await f.updates.download(); assert.equal(f.checks(), 2);
  f.autoUpdater.emit('update-downloaded');
  await f.updates.check(); assert.equal(f.updates.state.phase, 'downloaded');
  await f.updates.install();
  assert.equal(restarts, 1);
  assert.equal(f.updates.state.phase, 'downloaded');
  f.updates.options.restart = async () => true;
  await f.updates.install(); assert.equal(f.updates.state.phase, 'installing');
});

test('manual download opens only the selected release asset and disabled builds make no network calls', async () => {
  const f = fixture({ nativeUpdates: false });
  await f.updates.openInstaller(); assert.equal(f.opened(), undefined);
  await f.updates.check(); await f.updates.download();
  assert.equal(f.opened(), f.updates.state.downloadUrl);
  assert.equal(f.checks(), 0);
  const disabled = fixture({ enabled: false, fetch: () => { throw new Error('must not fetch'); } });
  assert.equal((await disabled.updates.check()).phase, 'unsupported');
  const current = fixture({ releases: [release(version)] });
  assert.equal((await current.updates.check()).phase, 'up-to-date');
});

test('IPC accepts only the trusted app main frame, never subframes or other windows/origins', () => {
  const mainFrame = { url: 'http://localhost:4318/#/settings/general' };
  const webContents = { mainFrame };
  const window = { webContents, isDestroyed: () => false };
  const event = { sender: webContents, senderFrame: mainFrame };
  assert.equal(trustedSender(event, window, 'http://localhost:4318'), true);
  assert.equal(trustedSender({ ...event, senderFrame: { url: mainFrame.url } }, window, 'http://localhost:4318'), false);
  assert.equal(trustedSender({ ...event, sender: {} }, window, 'http://localhost:4318'), false);
  assert.equal(trustedSender(event, window, 'http://localhost:9999'), false);
  assert.equal(trustedSender(event, { ...window, isDestroyed: () => true }, 'http://localhost:4318'), false);
  mainFrame.url = 'https://example.com';
  assert.equal(trustedSender(event, window, 'http://localhost:4318'), false);
});
