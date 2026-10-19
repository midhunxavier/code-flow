// Sent as fixed code over SSH; only our release payload arrives on stdin. No shell interpolation
// of server paths, repository names, credentials or user-supplied commands.
import { mkdir, readFile, writeFile, rename, open, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const marker = 'CODEFLOW_SSH_READY ';
const teamServer = process.argv.includes('--team-server');
const service = teamServer && process.argv.includes('--service');
const root = join(homedir(), '.codeflow', teamServer ? 'team-server' : 'ssh-host');
const stateFile = join(root, 'runtime.json');
// A previous boot's lock or recycled PID cannot block startup after reboot.
const bootId = teamServer && process.platform === 'linux' ? await readFile('/proc/sys/kernel/random/boot_id', 'utf8').then(value => value.trim()).catch(() => undefined) : undefined;
const lock = join(root, bootId ? `bootstrap.${bootId}.lock` : 'bootstrap.lock');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = async state => {
  if (!state || state.protocol !== 1 || !Number.isInteger(state.port) || !/^[a-f0-9]{64}$/.test(state.token ?? '')) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/api/${teamServer ? 'team-host-runtime' : 'ssh-runtime'}`, { headers: { authorization: `Bearer ${state.token}` }, signal: AbortSignal.timeout(2500) });
    const info = await res.json();
    return res.ok && info.instance === state.instance;
  } catch { return false; }
};
let locked = false, serviceExit, serviceChild;
try {
  if (+process.versions.node.split('.')[0] < 22 || (+process.versions.node.split('.')[0] === 22 && +process.versions.node.split('.')[1] < 13)) throw new Error('Remote projects require Node.js 22.13 or newer on the SSH login PATH.');
  process.stdin.setEncoding('utf8');
  let input = service ? await readFile(join(root, 'service-package.json'), 'utf8') : '';
  if (!service) for await (const chunk of process.stdin) { input += chunk; if (input.length > 32 * 1024 * 1024) throw new Error('Host package exceeds 32 MiB'); }
  if (input.length > 32 * 1024 * 1024) throw new Error('Host package exceeds 32 MiB');
  const payload = JSON.parse(input);
  if (payload.protocol !== 1 || !/^[a-f0-9]{64}$/.test(payload.version) || createHash('sha256').update(JSON.stringify(payload.files)).digest('hex') !== payload.version) throw new Error('Invalid host package');
  if (teamServer && (!Number.isInteger(payload.remotePort) || payload.remotePort < 1 || payload.remotePort > 65535)) throw new Error('Choose a team port from 1 to 65535');
  await mkdir(root, { recursive: true, mode: 0o700 });
  // Atomic launch serialization. A stale bootstrap lock fails explicitly rather than racing two servers.
  for (let i = 0; i < 100; i++) {
    try { await mkdir(lock, { mode: 0o700 }); locked = true; break; }
    catch (err) { if (err.code !== 'EEXIST') throw err; await wait(200); }
  }
  if (!locked) throw new Error(`Another host setup is running. If it crashed, remove ${lock} and reconnect.`);
  let previous; try { previous = JSON.parse(await readFile(stateFile, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (await alive(previous)) {
    if (!service) process.stdout.write(marker + JSON.stringify(previous) + '\n');
  } else {
    if (previous?.pid && !(bootId && previous.bootId && previous.bootId !== bootId)) {
      let exists = false; try { process.kill(previous.pid, 0); exists = true; } catch (err) { if (err.code === 'EPERM') exists = true; }
      if (exists) throw new Error('The remote backend is still running but unavailable. Inspect its host.log before restarting; active work has not been stopped.');
    }
    const release = join(root, 'releases', payload.version);
    for (const [path, content] of Object.entries(payload.files)) {
      if (!/^[\w./-]+$/.test(path) || path.startsWith('/') || path.split('/').includes('..') || typeof content !== 'string') throw new Error('Invalid package file');
      const target = join(release, path); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { mode: 0o600 });
    }
    const port = await new Promise((resolve, reject) => { const s = createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    const state = { protocol: 1, version: payload.version, port, token: randomBytes(32).toString('hex'), instance: randomBytes(16).toString('hex'), pid: 0, ...(teamServer ? { remotePort: payload.remotePort, ...(bootId ? { bootId } : {}) } : {}) };
    if (teamServer && !service && typeof payload.serviceBootstrap === 'string') {
      // Installed together with this release. Boot uses exactly its version and network port.
      for (const [name, content] of [['service-bootstrap.mjs', payload.serviceBootstrap], ['service-package.json', input]]) {
        const target = join(root, name), temp = target + '.tmp';
        await writeFile(temp, content, { mode: 0o600 }); await rename(temp, target);
      }
    }
    const log = await open(join(root, 'host.log'), 'a', 0o600);
    const env = { ...process.env, PORT: String(port), CODEFLOW_HOME: join(root, 'state'), CODEFLOW_TOKEN: state.token };
    if (teamServer) {
      // Team hosting is explicit and isolated from the SSH workspace and login environment.
      for (const name of Object.keys(env)) if (name.startsWith('CODEFLOW_')) delete env[name];
      Object.assign(env, { CODEFLOW_HOME: join(root, 'state'), CODEFLOW_TOKEN: state.token, CODEFLOW_TEAM_HOST: state.instance, CODEFLOW_REMOTE_PORT: String(payload.remotePort) });
    } else env.CODEFLOW_SSH_HOST = state.instance;
    const child = spawn(process.execPath, [join(release, 'src/server.mjs')], { cwd: homedir(), detached: !service, stdio: ['ignore', log.fd, log.fd], env });
    if (service) {
      serviceChild = child;
      // systemd tracks this foreground supervisor; KillMode=mixed sends TERM here first.
      for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill(signal));
      serviceExit = new Promise(resolve => child.once('exit', (code) => resolve(code ?? 1)));
    }
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    state.pid = child.pid; if (!service) child.unref(); await log.close();
    if (!state.pid) throw new Error('Could not start the remote backend');
    // Persist before waiting so a lost SSH channel cannot launch a second backend on reconnect.
    const temp = stateFile + '.tmp'; await writeFile(temp, JSON.stringify(state), { mode: 0o600 }); await rename(temp, stateFile);
    let ready = false;
    for (let i = 0; i < 120; i++) { if (await alive(state)) { ready = true; break; } await wait(250); }
    if (!ready) throw new Error(`Remote backend did not become ready. Inspect ${join(root, 'host.log')} and reconnect.`);
    if (!service) process.stdout.write(marker + JSON.stringify(state) + '\n');
  }
} catch (err) { if (serviceChild) serviceChild.kill("SIGTERM"); console.error(err.message); process.exitCode = 1; }
finally { if (locked) await rm(lock, { recursive: true, force: true }); }

// Release the bootstrap lock before waiting for the service's lifetime.
if (serviceExit && !process.exitCode) process.exitCode = await serviceExit;
