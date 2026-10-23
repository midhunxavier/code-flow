import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
const { startWslBackend, PROBE, READY, setupCommand } = require('../../integrations/desktop/wsl.cjs');

async function fixture(t, { kernel = '6.6-microsoft-standard-WSL2', arch = 'x86_64', distro = 'Ubuntu Test', failed = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codeflow wsl ')); t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'wsl')); const archive = Buffer.from('runtime-fixture');
  await writeFile(join(directory, 'wsl/node-linux.tar.gz'), archive);
  const calls = [], input = [], child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.stdin.on('data', data => input.push(String(data)));
  const options = { source: directory, userData: directory, port: 4321, token: 'wsl-private-owner', env: { PATH: '/windows/tools', HOST_API_KEY: 'host-only' },
    config: { arch: 'x64', bundleId: 'a'.repeat(64), nodeSha256: createHash('sha256').update(archive).digest('hex') },
    execCommand: (command, args, options, callback) => {
      calls.push({ command, args, options });
      if (failed) return callback(new Error('WSL unavailable'), Buffer.from('Run wsl --install', 'utf16le'));
      if (args.includes(PROBE)) callback(null, Buffer.from(`CODEFLOW_WSL_INFO\0${distro}\0${kernel}\0${arch}\0/home/user\0`));
      else if (args.includes('wslpath')) callback(null, Buffer.from('/mnt/c/Apps/Code Flow\n'));
      else if (args.some(arg => arg.endsWith('/bootstrap.sh'))) callback(null, Buffer.from('CODEFLOW_WSL_RUNTIME\0/home/user/runtime/node/bin/node\0/home/user/runtime/runner.cjs\0'));
      else callback(null, Buffer.from('CODEFLOW_WSL_PATH=/usr/bin:/bin\n'));
    },
    spawnCommand: (command, args, options) => { calls.push({ command, args, options, spawned: true }); return child; } };
  return { options, calls, child, input, start: () => startWslBackend(options) };
}

test('WSL launches the bundled Linux runtime with existing Linux PATH and private stdin configuration', async t => {
  const f = await fixture(t), backend = await f.start();
  const launched = f.calls.find(call => call.spawned);
  assert.equal(launched.command, 'wsl.exe');
  assert.deepEqual(launched.args.slice(0, 3), ['--distribution', 'Ubuntu Test', '--exec']);
  assert.equal(launched.args.includes('wsl-private-owner'), false);
  const config = JSON.parse(f.input[0]); assert.equal(config.token, 'wsl-private-owner'); assert.equal(config.port, 4321);
  assert.ok(config.path.startsWith('/home/user/runtime/node/bin:/home/user/.local/bin:'));
  assert.equal(config.HOST_API_KEY, undefined);
  const ready = once(backend, 'message');
  f.child.stdout.write(READY + JSON.stringify({ id: backend.id, port: 4321 }) + '\n');
  assert.equal((await ready)[0].url, 'http://localhost:4321/?token=wsl-private-owner');
  backend.disconnect(); assert.equal(f.input.at(-1), 'stop\n');
  backend.kill('SIGKILL'); assert.deepEqual(f.calls.at(-1).args.slice(-2), ['--stop', 'SIGKILL']);
  assert.equal(f.calls.some(call => call.args.includes('--shutdown') || call.args.includes('--terminate')), false);
  assert.match(setupCommand(backend), /^wsl\.exe --distribution 'Ubuntu Test'/);
});

test('WSL1, mismatched architecture, missing distributions and damaged bundled Node fail before launch', async t => {
  for (const [config, expected] of [[{ kernel: '4.4-Microsoft' }, /must use WSL2/], [{ arch: 'aarch64' }, /ARM64 Windows package/], [{ distro: 'docker-desktop' }, /user distribution/], [{ failed: true }, /wsl --install/]]) {
    const f = await fixture(t, config); await assert.rejects(f.start(), expected);
    assert.equal(f.calls.some(call => call.spawned), false);
  }
  const f = await fixture(t); await writeFile(join(f.options.source, 'wsl/node-linux.tar.gz'), 'damaged');
  await assert.rejects(f.start(), /checksum/); assert.equal(f.calls.length, 0);
});
