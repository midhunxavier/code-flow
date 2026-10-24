import './check-node.mjs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const nodeVersion = '22.23.4';
const nodeHashes = { x64: 'b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406', arm64: 'f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9' };
export async function prepareWslDesktop(arch) {
  if (!nodeHashes[arch]) throw new Error('Choose x64 or arm64.');
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const cache = join(root, 'output/windows/cache'); await mkdir(cache, { recursive: true });
  const filename = `node-v${nodeVersion}-linux-${arch}.tar.gz`, archive = join(cache, filename);
  let bytes = await readFile(archive).catch(() => undefined);
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== nodeHashes[arch]) {
    const url = `https://nodejs.org/dist/v${nodeVersion}/${filename}`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
    } catch {
      // curl also honors HTTPS_PROXY on build hosts where Node 22 fetch cannot reach the internet directly.
      execFileSync(process.platform === 'win32' ? 'curl.exe' : 'curl', ['--fail', '--silent', '--show-error', '--location', '--retry', '2', '--connect-timeout', '15', '--max-time', '120', '--output', archive, url], { stdio: 'inherit' });
      bytes = await readFile(archive);
    }
    if (createHash('sha256').update(bytes).digest('hex') !== nodeHashes[arch]) throw new Error('Node runtime checksum mismatch.');
    await writeFile(archive, bytes);
  }
  execFileSync(process.execPath, ['scripts/package-npm.mjs'], { cwd: root, stdio: 'inherit' });
  const desktop = join(root, 'dist/windows-desktop');
  await rm(desktop, { recursive: true, force: true }); await mkdir(join(desktop, 'wsl'), { recursive: true });
  await cp(join(root, 'dist/npm'), join(desktop, 'backend'), { recursive: true });
  for (const file of ['main.cjs', 'preload.cjs', 'updates.cjs', 'wsl.cjs', 'icon.png']) await cp(join(root, 'integrations/desktop', file), join(desktop, file));
  await cp(join(root, 'integrations/desktop/starting-wsl.html'), join(desktop, 'starting.html'));
  for (const file of ['bootstrap.sh', 'runner.cjs']) await writeFile(join(desktop, 'wsl', file), (await readFile(join(root, 'integrations/desktop/wsl', file), 'utf8')).replace(/\r\n?/g, '\n'));
  await writeFile(join(desktop, 'wsl/node-linux.tar.gz'), bytes);
  const hash = createHash('sha256');
  async function digest(directory, prefix = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = join(directory, entry.name), name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await digest(path, name);
      else { hash.update(name); hash.update('\0'); hash.update(await readFile(path)); hash.update('\0'); }
    }
  }
  await digest(join(desktop, 'backend'), '/backend'); await digest(join(desktop, 'wsl'), '/wsl');
  const config = { arch, nodeVersion, nodeSha256: nodeHashes[arch], bundleId: hash.digest('hex') };
  await writeFile(join(desktop, 'wsl-config.json'), JSON.stringify(config));
  await writeFile(join(desktop, 'update-config.json'), JSON.stringify({ nativeUpdates: false }));
  await writeFile(join(desktop, 'package.json'), JSON.stringify({ name: 'code-flow-desktop', productName: 'Code Flow', version: pkg.version, description: pkg.description, main: 'main.cjs', author: 'Code Flow contributors', license: 'MIT' }, null, 2));
  return { root, desktop, pkg, config };
}
