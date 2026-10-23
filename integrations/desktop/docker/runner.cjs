// Keep IPC private inside the container. Docker logs must never contain the owner token.
const { fork } = require('node:child_process');
const { createInterface } = require('node:readline');
const { join } = require('node:path');
const token = process.env.CODEFLOW_TOKEN;
if (!token) throw new Error('The desktop owner token is missing.');
const child = fork(join(__dirname, 'backend/src/server.js'), [], { cwd: '/workspace', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on('line', line => {
  process.stderr.write(line.replaceAll(token, '[redacted]').replace(/([?&]token=)[^\s]+/g, '$1[redacted]') + '\n');
});
child.on('message', message => {
  if (message?.type === 'codeflow-ready') process.stdout.write('CODEFLOW_DESKTOP_READY\n');
});
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  if (child.connected) child.disconnect(); else child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 12000).unref();
};
process.stdin.resume();
process.stdin.once('end', stop);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, stop);
child.once('error', error => { console.error(error.message.replaceAll(token, '[redacted]')); process.exit(1); });
child.once('exit', (code, signal) => process.exit(code ?? (stopping ? 0 : 1)));
