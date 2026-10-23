import './check-node.mjs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function prepareDockerDesktop() {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  execFileSync(process.execPath, ['scripts/package-npm.mjs'], { cwd: root, stdio: 'inherit' });
  const desktop = join(root, 'dist/windows-desktop');
  await rm(desktop, { recursive: true, force: true });
  await mkdir(join(desktop, 'docker'), { recursive: true });
  await cp(join(root, 'dist/npm'), join(desktop, 'docker/backend'), { recursive: true });
  for (const file of ['Dockerfile', 'runner.cjs']) await cp(join(root, 'integrations/desktop/docker', file), join(desktop, 'docker', file));
  for (const file of ['main.cjs', 'preload.cjs', 'updates.cjs', 'docker.cjs', 'starting.html', 'icon.png']) await cp(join(root, 'integrations/desktop', file), join(desktop, file));
  const hash = createHash('sha256');
  async function digest(directory, prefix = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = join(directory, entry.name), name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await digest(path, name);
      else { hash.update(name); hash.update('\0'); hash.update(await readFile(path)); hash.update('\0'); }
    }
  }
  await digest(join(desktop, 'docker'));
  const image = `code-flow-desktop:${pkg.version}-${hash.digest('hex').slice(0, 16)}`;
  await writeFile(join(desktop, 'docker-config.json'), JSON.stringify({ image }));
  await writeFile(join(desktop, 'update-config.json'), JSON.stringify({ nativeUpdates: false }));
  await writeFile(join(desktop, 'package.json'), JSON.stringify({ name: 'code-flow-desktop', productName: 'Code Flow', version: pkg.version, description: pkg.description, main: 'main.cjs', author: 'Code Flow contributors', license: 'MIT' }, null, 2));
  return { root, desktop, pkg, image };
}
