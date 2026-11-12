import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../..', import.meta.url));
const arch = process.env.CODEFLOW_LINUX_ARCH ?? process.arch;
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const base = join(root, 'output/linux', `code-flow-${pkg.version}-linux-${arch}-unsigned`);
const elfMachine = { x64: 0x3e, arm64: 0xb7 }[arch];

async function verifyChecksum(file) {
  const bytes = await readFile(file), name = file.split('/').at(-1);
  assert.equal((await readFile(`${file}.sha256`, 'utf8')).trim(), `${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
  return bytes;
}
async function verifyApp(app) {
  // Every user must be able to open an installed copy.
  for (const path of [app, join(app, 'code-flow'), join(app, 'resources'), join(app, 'resources/app/node/bin/node')]) assert.equal((await stat(path)).mode & 0o005, 0o005, `${path} is readable and executable by everyone`);
  const executable = await readFile(join(app, 'code-flow'));
  assert.equal(executable.subarray(0, 4).toString('latin1'), '\x7fELF');
  assert.equal(executable.readUInt16LE(18), elfMachine, 'Electron matches the target architecture');
  const resources = join(app, 'resources/app');
  for (const path of ['main.cjs', 'preload.cjs', 'updates.cjs', 'icon.png', 'backend/src/server.js', 'backend/public/index.html', 'node/LICENSE']) await access(join(resources, path));
  const node = await readFile(join(resources, 'node/bin/node'));
  assert.equal(node.readUInt16LE(18), elfMachine, 'bundled Node matches the target architecture');
  if (arch === process.arch) assert.match(execFileSync(join(resources, 'node/bin/node'), ['--version'], { encoding: 'utf8' }), /^v22\./);
  const manifest = JSON.parse(await readFile(join(resources, 'package.json'), 'utf8'));
  assert.equal(manifest.version, pkg.version); assert.equal(manifest.desktopName, 'code-flow.desktop');
  assert.equal(JSON.parse(await readFile(join(resources, 'update-config.json'), 'utf8')).nativeUpdates, false);
  const html = await readFile(join(resources, 'backend/public/index.html'), 'utf8');
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1]);
  assert.ok(assets.some(asset => asset.endsWith('.js')) && assets.some(asset => asset.endsWith('.css')));
  for (const asset of assets) await access(join(resources, 'backend/public', asset));
}

test('Linux AppImage is a static runtime plus squashfs AppDir with a sandbox-aware AppRun and matching checksum', { skip: process.platform !== 'linux', timeout: 120000 }, async t => {
  const bytes = await verifyChecksum(`${base}.AppImage`);
  assert.equal(bytes.subarray(0, 4).toString('latin1'), '\x7fELF');
  assert.equal(bytes.subarray(8, 11).toString('latin1'), 'AI\x02', 'AppImage type 2 magic');
  assert.equal(bytes.readUInt16LE(18), elfMachine);
  const directory = await mkdtemp(join(tmpdir(), 'cf-appimage-')); t.after(() => rm(directory, { recursive: true, force: true }));
  // The squashfs payload starts where the runtime's ELF section headers end.
  const offset = Number(bytes.readBigUInt64LE(0x28)) + bytes.readUInt16LE(0x3a) * bytes.readUInt16LE(0x3c);
  assert.equal(bytes.subarray(offset, offset + 4).toString('latin1'), 'hsqs');
  execFileSync('unsquashfs', ['-q', '-n', '-o', String(offset), '-d', join(directory, 'squashfs-root'), `${base}.AppImage`], { stdio: 'ignore' });
  const appDir = join(directory, 'squashfs-root');
  assert.match(await readFile(join(appDir, 'AppRun'), 'utf8'), /--no-sandbox/);
  const entry = await readFile(join(appDir, 'code-flow.desktop'), 'utf8');
  assert.match(entry, /^Exec=code-flow %U$/m); assert.match(entry, /^Icon=code-flow$/m);
  await access(join(appDir, 'code-flow.png')); await access(join(appDir, '.DirIcon'));
  await verifyApp(join(appDir, 'usr/lib/code-flow'));
});

test('Linux .deb installs to /opt/code-flow with a launcher, desktop entry, setuid sandbox step and matching checksum', { skip: process.platform !== 'linux', timeout: 120000 }, async t => {
  const bytes = await verifyChecksum(`${base}.deb`);
  assert.equal(bytes.subarray(0, 8).toString('latin1'), '!<arch>\n');
  const field = name => execFileSync('dpkg-deb', ['--field', `${base}.deb`, name], { encoding: 'utf8' }).trim();
  assert.equal(field('Package'), 'code-flow');
  assert.equal(field('Version'), pkg.version.replace('-preview.', '~preview.'));
  assert.equal(field('Architecture'), { x64: 'amd64', arm64: 'arm64' }[arch]);
  assert.doesNotMatch(field('Depends'), /\bgit\b/, 'Git stays user-installed');
  const directory = await mkdtemp(join(tmpdir(), 'cf-deb-')); t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync('dpkg-deb', ['-x', `${base}.deb`, join(directory, 'root')]);
  execFileSync('dpkg-deb', ['-e', `${base}.deb`, join(directory, 'DEBIAN')]);
  assert.match(await readFile(join(directory, 'DEBIAN/postinst'), 'utf8'), /chmod 4755 \/opt\/code-flow\/chrome-sandbox/);
  const files = join(directory, 'root');
  assert.equal(execFileSync('readlink', [join(files, 'usr/bin/code-flow')], { encoding: 'utf8' }).trim(), '/opt/code-flow/code-flow');
  assert.match(await readFile(join(files, 'usr/share/applications/code-flow.desktop'), 'utf8'), /^Exec=\/opt\/code-flow\/code-flow %U$/m);
  await access(join(files, 'usr/share/icons/hicolor/256x256/apps/code-flow.png'));
  await access(join(files, 'opt/code-flow/chrome-sandbox'));
  await verifyApp(join(files, 'opt/code-flow'));
});
