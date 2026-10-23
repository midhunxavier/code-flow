const { fork } = require('node:child_process');
const { createInterface } = require('node:readline');
const { readFile, writeFile, mkdir, unlink, stat, readlink, realpath } = require('node:fs/promises');
const { join, dirname } = require('node:path');
const { homedir } = require('node:os');

const id = process.argv[2];
if (!/^[a-f0-9]{16}$/.test(id || '')) throw new Error('Invalid desktop identity.');
const state = join(homedir(), '.codeflow-desktop', id), recordFile = join(state, 'desktop-process.json');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function previous() { try { return JSON.parse(await readFile(recordFile, 'utf8')); } catch { return; } }
async function owned(record) {
  if (!record || !Number.isInteger(record.pid) || record.pid <= 1 || typeof record.runner !== 'string') return false;
  const base = join(homedir(), '.local/share/code-flow/desktop', id, 'versions') + '/';
  if (!record.runner.startsWith(base) || !/^[a-f0-9]{64}\/runner\.cjs$/.test(record.runner.slice(base.length))) return false;
  try {
    const args = (await readFile(`/proc/${record.pid}/cmdline`, 'utf8')).split('\0');
    const entry = args.findIndex((arg, index) => arg === record.runner && args[index + 1] === id);
    const executable = await realpath(join(dirname(record.runner), 'node/bin/node'));
    return entry > 0 && (await stat(`/proc/${record.pid}`)).uid === process.getuid() && await readlink(`/proc/${record.pid}/exe`) === executable;
  } catch { return false; }
}
async function stopPrevious(signal = 'SIGTERM', wait = false) {
  const record = await previous();
  if (!(await owned(record))) return;
  try { process.kill(record.pid, signal); } catch { return; }
  if (!wait) return;
  for (let i = 0; i < 150 && await owned(record); i++) await pause(100);
  if (await owned(record)) { try { process.kill(record.pid, 'SIGKILL'); } catch {} }
}
async function main() {
  if (process.argv[3] === '--stop') {
    if (!['SIGTERM', 'SIGKILL'].includes(process.argv[4])) throw new Error('Invalid stop signal.');
    await stopPrevious(process.argv[4]); return;
  }
  const input = createInterface({ input: process.stdin });
  const config = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The desktop did not send startup configuration.')), 15000);
    input.once('close', () => { clearTimeout(timer); reject(new Error('Desktop connection closed.')); });
    input.once('line', line => { clearTimeout(timer); try { if (line.length > 256 * 1024) throw new Error('Startup configuration is too large.'); resolve(JSON.parse(line)); } catch (error) { reject(error); } });
  });
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || typeof config.token !== 'string' || !config.token || config.token.length > 4096 || typeof config.path !== 'string') throw new Error('Invalid desktop startup configuration.');
  await mkdir(state, { recursive: true, mode: 0o700 });
  await stopPrevious('SIGTERM', true);
  await writeFile(recordFile, JSON.stringify({ pid: process.pid, runner: __filename }), { mode: 0o600 });
  const child = fork(join(__dirname, 'backend/src/server.js'), [], { cwd: homedir(), detached: true,
    env: { ...process.env, PATH: config.path, PORT: String(config.port), CODEFLOW_HOME: join(state, 'state'), CODEFLOW_TOKEN: config.token, CODEFLOW_LAUNCHER: '1', CODEFLOW_DESKTOP_CONTAINER: '' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on('line', line => process.stderr.write(line.replaceAll(config.token, '[redacted]').replace(/([?&]token=)[^\s]+/g, '$1[redacted]') + '\n'));
  child.on('message', message => {
    if (message?.type === 'codeflow-ready') process.stdout.write('CODEFLOW_WSL_READY ' + JSON.stringify({ id, port: config.port }) + '\n');
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (child.connected) child.disconnect(); else child.kill('SIGTERM');
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 12000).unref();
  };
  input.on('line', line => { if (line === 'stop') stop(); });
  input.once('close', stop);
  if (input.closed) stop();
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, stop);
  child.once('error', error => { console.error(error.message.replaceAll(config.token, '[redacted]')); process.exit(1); });
  child.once('exit', async code => {
    if ((await previous())?.pid === process.pid) await unlink(recordFile).catch(() => {});
    process.exit(code ?? (stopping ? 0 : 1));
  });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
