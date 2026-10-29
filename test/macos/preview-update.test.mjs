import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const installerModule = require.resolve('../../integrations/desktop/macos-update.cjs');
const { MacUpdateInstaller } = require(installerModule);

test('macOS preview downloads, verifies, replaces after exit and launches a real app bundle', { skip: process.platform !== 'darwin', timeout: 90000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codeflow-real-update-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appPath = join(root, 'Code Flow.app'), source = join(root, 'release'), bundle = join(source, 'Code Flow.app');
  await mkdir(join(bundle, 'Contents/MacOS'), { recursive: true });
  // A real, small Mach-O app records that Launch Services launched the new copy.
  const cSource = join(root, 'main.c');
  await writeFile(cSource, '#include <stdio.h>\n#include <unistd.h>\n#include <libgen.h>\nint main(int argc, char **argv) { char path[4096]; snprintf(path, sizeof(path), "%s/launched", dirname(argv[0])); FILE *f=fopen(path,"w"); if (!f) return 1; fputs("new version",f); fclose(f); return 0; }\n');
  execFileSync('/usr/bin/clang', [cSource, '-o', join(bundle, 'Contents/MacOS/Code Flow')]);
  const plist = version => `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>io.github.midhunxavier.code-flow</string><key>CFBundleExecutable</key><string>Code Flow</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${version}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`;
  await writeFile(join(bundle, 'Contents/Info.plist'), plist('0.1.0-preview.9'));
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', bundle]);
  await cp(bundle, appPath, { recursive: true });
  await writeFile(join(appPath, 'Contents/Info.plist'), plist('0.1.0-preview.8'));
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', appPath]);
  const dmg = join(root, 'update.dmg');
  execFileSync('/usr/bin/hdiutil', ['create', '-srcfolder', source, '-format', 'UDZO', dmg], { stdio: 'pipe' });
  const bytes = await readFile(dmg), digest = createHash('sha256').update(bytes).digest('hex');
  const cachePath = join(root, 'cache');
  const installer = new MacUpdateInstaller({ appPath, cachePath, nodePath: process.execPath, arch: process.arch,
    fetch: async url => new Response(url.endsWith('.sha256') ? `${digest}  update.dmg\n` : bytes) });
  await installer.prepare({ version: '0.1.0-preview.9', downloadUrl: 'https://github.com/example/update.dmg', checksumUrl: 'https://github.com/example/update.dmg.sha256', size: bytes.length });
  assert.match(await readFile(join(appPath, 'Contents/Info.plist'), 'utf8'), /preview\.8/);
  const prepared = installer.prepared;
  const script = join(root, 'parent.cjs');
  await writeFile(script, `const {MacUpdateInstaller}=require(${JSON.stringify(installerModule)}); const installer=new MacUpdateInstaller(${JSON.stringify({ appPath, cachePath })}); installer.prepared=${JSON.stringify(prepared)}; installer.install().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});`);
  const parent = fork(script, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let errors = ''; parent.stderr.on('data', data => { errors += data; });
  assert.equal(await new Promise(resolve => parent.once('exit', resolve)), 0, errors);
  const marker = join(appPath, 'Contents/MacOS/launched');
  let launched = false;
  for (let i = 0; i < 150; i++) {
    if (await readFile(marker, 'utf8').catch(() => '') === 'new version') { launched = true; break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(launched, true, await readFile(join(cachePath, 'last-result.json'), 'utf8').catch(() => 'No helper result'));
  assert.match(await readFile(join(appPath, 'Contents/Info.plist'), 'utf8'), /preview\.9/);
});
