import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { downloadAsset, replaceBundle, verifyBundle, waitForExit, MacUpdateInstaller } = require('../../integrations/desktop/macos-update.cjs');

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'codeflow-update-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function downloadFixture({ checksum, size = 6, body = 'update', filename = 'update.dmg' } = {}) {
  const candidate = { downloadUrl: 'https://github.com/example/update.dmg', checksumUrl: 'https://github.com/example/update.dmg.sha256', size };
  const digest = checksum ?? createHash('sha256').update(body).digest('hex');
  return { candidate, fetch: async url => new Response(url === candidate.checksumUrl ? `${digest}  ${filename}\n` : body) };
}

test('download streams to disk, verifies checksum and published size, and reports progress', async t => {
  const dir = await directory(t), f = downloadFixture(), progress = [];
  await downloadAsset(f.candidate, join(dir, 'update.dmg'), value => progress.push(value), f.fetch);
  assert.equal(await readFile(join(dir, 'update.dmg'), 'utf8'), 'update');
  assert.equal(progress.at(-1), 100);
  // Existing files must never be overwritten by a retry.
  await assert.rejects(downloadAsset(f.candidate, join(dir, 'update.dmg'), undefined, f.fetch), /EEXIST/);
});

test('download rejects tampering, truncation, oversized streams and wrong checksum filenames', async t => {
  const dir = await directory(t);
  for (const [i, options] of [{ checksum: '0'.repeat(64) }, { size: 7 }, { size: 5 }, { filename: 'other.dmg' }, { size: 2 ** 40 }, { checksum: 'x'.repeat(1100) }].entries()) {
    const f = downloadFixture(options);
    await assert.rejects(downloadAsset(f.candidate, join(dir, `${i}.dmg`), undefined, f.fetch));
  }
});

async function bundles(t) {
  const root = await directory(t);
  const paths = { appPath: join(root, 'Code Flow.app'), staged: join(root, 'staged.app'), backup: join(root, 'backup.app') };
  for (const [path, text] of [[paths.appPath, 'old'], [paths.staged, 'new']]) { await mkdir(path); await writeFile(join(path, 'version'), text); }
  return paths;
}

test('replacement keeps the previous app and launches only after the new bundle is in place', async t => {
  const paths = await bundles(t);
  await replaceBundle(paths, async path => {
    assert.equal(path, paths.appPath);
    assert.equal(await readFile(join(path, 'version'), 'utf8'), 'new');
    assert.equal(await readFile(join(paths.backup, 'version'), 'utf8'), 'old');
  });
});

test('failed replacement or launch restores the previous app without deleting recovery files', async t => {
  const paths = await bundles(t);
  await assert.rejects(replaceBundle(paths, async () => { throw new Error('Launch failed'); }), /Launch failed/);
  assert.equal(await readFile(join(paths.appPath, 'version'), 'utf8'), 'old');
  assert.equal(await readFile(join(paths.staged, 'version'), 'utf8'), 'new');
  await rm(paths.staged, { recursive: true });
  await assert.rejects(replaceBundle(paths, async () => assert.fail('must not launch')), /ENOENT/);
  assert.equal(await readFile(join(paths.appPath, 'version'), 'utf8'), 'old');
});

test('helper refuses to install while the app is alive and only proceeds after exit', async () => {
  await assert.rejects(waitForExit(123, { alive: () => true, timeout: 0 }), /did not exit/);
  let alive = true;
  await waitForExit(123, { alive: () => alive, pause: async () => { alive = false; } });
});

test('disk images, translocated apps and symlinked installations use the manual fallback', async t => {
  const root = await directory(t), appPath = join(root, 'Code Flow.app');
  await mkdir(appPath);
  const canonical = await require('node:fs/promises').realpath(appPath);
  assert.equal(await new MacUpdateInstaller({ appPath: canonical }).supported(), true);
  for (const appPath of ['/Volumes/Code Flow/Code Flow.app', '/private/AppTranslocation/random/Code Flow.app', join(root, 'missing.app')]) {
    assert.equal(await new MacUpdateInstaller({ appPath }).supported(), false);
  }
  if (process.platform !== 'win32') {
    await symlink(appPath, join(root, 'link.app'));
    assert.equal(await new MacUpdateInstaller({ appPath: join(root, 'link.app') }).supported(), false);
  }
});

test('bundle verification rejects wrong application, version, architecture, signature and publisher', async t => {
  const bundle = join(await directory(t), 'Code Flow.app'); await mkdir(bundle);
  const run = ({ id = 'io.github.midhunxavier.code-flow', version = '0.1.0-preview.9', executable = 'Code Flow', fail = '', oldTeam = 'not set', newTeam = 'not set' } = {}) => async (command, args) => {
    if (command.includes(fail) && fail) throw new Error('verification failed');
    if (command.endsWith('plutil')) return { stdout: { CFBundleIdentifier: id, CFBundleShortVersionString: version, CFBundleExecutable: executable }[args[1]] };
    if (command.endsWith('codesign') && args[0] === '-dv') return { stderr: `TeamIdentifier=${args.at(-1) === '/old.app' ? oldTeam : newTeam}\n` };
    if (command.endsWith('lipo')) assert.equal(args[2], 'arm64');
    return { stdout: '', stderr: '' };
  };
  await verifyBundle(bundle, '0.1.0-preview.9', 'arm64', '/old.app', run());
  for (const options of [{ id: 'other' }, { version: '0.0.0' }, { executable: 'other' }, { fail: 'codesign' }, { fail: 'lipo' }, { oldTeam: 'TEAM', newTeam: 'not set' }]) {
    await assert.rejects(verifyBundle(bundle, '0.1.0-preview.9', 'arm64', '/old.app', run(options)));
  }
});

test('quitting cancels an in-flight download and cleans its temporary files', async t => {
  const root = await realpath(await directory(t)), appPath = join(root, 'Code Flow.app'), cachePath = join(root, 'cache');
  await mkdir(appPath);
  let started;
  const fetching = new Promise(resolve => { started = resolve; });
  const installer = new MacUpdateInstaller({ appPath, cachePath,
    fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      started();
    }),
  });
  const preparing = installer.prepare(downloadFixture().candidate);
  const rejected = assert.rejects(preparing);
  await fetching;
  await installer.dispose();
  await rejected;
  assert.deepEqual(await readdir(cachePath), []);
});
