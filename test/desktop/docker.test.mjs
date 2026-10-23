import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { startDockerBackend, launchArguments, identity, READY } = require('../../integrations/desktop/docker.cjs');

async function fixture(t, { owner, os = 'linux', endpoint = 'unix:///var/run/docker.sock', installed = true, buildFailure = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codeflow docker '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [], child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const options = { workspace: directory, userData: directory, port: 4319, token: 'private-owner-token', image: 'code-flow-desktop:fixture', context: '/bundled context', env: { PATH: '/tools', PRIVATE_API_KEY: 'host-only' },
    execCommand: (_command, args, _options, callback) => {
      calls.push(args);
      const command = args.slice(0, 2).join(' ');
      if (command === 'context inspect') callback(null, JSON.stringify(endpoint));
      else if (args[0] === 'info') callback(null, os);
      else if (args[0] === 'inspect') owner === undefined ? callback(new Error('missing')) : callback(null, owner === true ? identity(directory) : owner);
      else if (command === 'image inspect' && !installed) callback(new Error('missing'));
      else if (args[0] === 'build' && buildFailure) callback(new Error('build failed'), '', 'Cannot download agent tools');
      else callback(null, '');
    },
    spawnCommand: (command, args, options) => { calls.push({ command, args, options }); return child; } };
  return { options, calls, child, start: () => startDockerBackend(options) };
}

test('Docker desktop publishes only localhost and mounts one folder plus persistent home without host credentials or socket', () => {
  const args = launchArguments({ workspace: join(tmpdir(), 'My projects'), port: 4319, image: 'code-flow-desktop:preview.3', id: '0123456789abcdef' });
  assert.ok(args.includes('127.0.0.1:4319:4319'));
  assert.ok(args.includes('PORT=4319'));
  assert.ok(args.includes(`type=volume,source=codeflow-desktop-home-0123456789abcdef-${identity(join(tmpdir(), 'My projects'))},target=/home/node`));
  assert.equal(args.filter(arg => arg.startsWith('type=bind')).length, 1);
  assert.deepEqual(args.slice(-3), ['--env', 'CODEFLOW_TOKEN', 'code-flow-desktop:preview.3']);
  assert.equal(args.some(arg => /docker\.sock|PRIVATE_API_KEY|--privileged|--network=host/.test(arg)), false);
  assert.throws(() => launchArguments({ workspace: '/projects,other', port: 4319, image: 'code-flow-desktop:fixture', id: '0123456789abcdef' }), /commas/);
  const other = launchArguments({ workspace: join(tmpdir(), 'Different projects'), port: 4319, image: 'code-flow-desktop:preview.3', id: '0123456789abcdef' });
  assert.notEqual(args.find(arg => arg.startsWith('type=volume')), other.find(arg => arg.startsWith('type=volume')), 'changing the folder cannot reassign saved repository paths to different host files');
});

test('Docker startup builds missing image, translates readiness, and stops the daemon-owned container', async t => {
  const f = await fixture(t, { installed: false });
  const backend = await f.start();
  assert.ok(f.calls.some(args => Array.isArray(args) && args[0] === 'build' && args.at(-1) === '/bundled context'));
  const launched = f.calls.find(call => call.command === 'docker');
  assert.equal(launched.options.windowsHide, true);
  assert.equal(launched.options.env.CODEFLOW_TOKEN, 'private-owner-token');
  assert.equal(launched.args.includes('host-only'), false);
  const message = once(backend, 'message');
  f.child.stdout.write(`${READY.slice(0, 10)}`); f.child.stdout.write(`${READY.slice(10)}\n`);
  assert.equal((await message)[0].url, 'http://localhost:4319/?token=private-owner-token');
  backend.disconnect();
  assert.deepEqual(f.calls.at(-1), ['stop', '--time', '15', backend.name]);
  backend.kill('SIGKILL');
  assert.deepEqual(f.calls.at(-1), ['kill', '--signal', 'KILL', backend.name]);
});

test('crash recovery removes only the current installation’s labeled container', async t => {
  const owned = await fixture(t, { owner: true });
  const backend = await owned.start();
  assert.ok(owned.calls.some(args => Array.isArray(args) && args.join(' ') === `rm --force ${backend.name}`));
  const other = await fixture(t, { owner: 'somebody-else' });
  await assert.rejects(other.start(), /another application/);
  assert.equal(other.calls.some(args => args[0] === 'rm'), false);
});

test('remote daemons, Windows container mode and failed image builds never launch a backend', async t => {
  for (const [configuration, expected] of [[{ endpoint: 'tcp://remote:2376' }, /local Docker Desktop/], [{ os: 'windows' }, /Linux containers/], [{ installed: false, buildFailure: true }, /Cannot download/]]) {
    const f = await fixture(t, configuration);
    await assert.rejects(f.start(), expected);
    assert.equal(f.calls.some(call => call.command === 'docker'), false);
  }
  const f = await fixture(t);
  f.options.env.DOCKER_HOST = 'tcp://remote:2376';
  await assert.rejects(f.start(), /local Docker Desktop/);
  const context = await fixture(t, { endpoint: 'ssh://remote' });
  context.options.env.DOCKER_CONTEXT = 'remote'; context.options.env.DOCKER_HOST = 'unix:///var/run/docker.sock';
  await assert.rejects(context.start(), /local Docker Desktop/);
});
