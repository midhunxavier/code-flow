import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../..', import.meta.url));
const arch = process.env.CODEFLOW_WINDOWS_ARCH ?? 'x64';

test('Windows portable package contains a PE executable, Docker runtime, and matching archive checksum', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const bundle = join(root, 'output/windows', arch, 'Code Flow'), resources = join(bundle, 'resources/app');
  assert.equal((await readFile(join(bundle, 'Code Flow.exe'))).subarray(0, 2).toString(), 'MZ');
  const config = JSON.parse(await readFile(join(resources, 'docker-config.json'), 'utf8'));
  assert.match(config.image, new RegExp(`^code-flow-desktop:${pkg.version.replaceAll('.', '\\.')}[-][a-f0-9]{16}$`));
  for (const path of ['docker/Dockerfile', 'docker/runner.cjs', 'docker/backend/src/server.js', 'docker/backend/public/index.html', 'docker.cjs', 'main.cjs', 'preload.cjs', 'starting.html', 'icon.png']) await access(join(resources, path));
  assert.equal(JSON.parse(await readFile(join(resources, 'update-config.json'), 'utf8')).nativeUpdates, false);
  const filename = `code-flow-${pkg.version}-windows-${arch}-unsigned.zip`;
  const bytes = await readFile(join(root, 'output/releases', filename));
  assert.equal(bytes.subarray(0, 2).toString(), 'PK');
  assert.equal((await readFile(join(root, 'output/releases', `${filename}.sha256`), 'utf8')).trim(), `${createHash('sha256').update(bytes).digest('hex')}  ${filename}`);
});
