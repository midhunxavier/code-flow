const { execFile, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { createInterface } = require('node:readline');

const PROBE = 'printf "CODEFLOW_WSL_INFO\\000%s\\000%s\\000%s\\000%s\\000" "$WSL_DISTRO_NAME" "$(uname -r)" "$(uname -m)" "$HOME"';
const READY = 'CODEFLOW_WSL_READY ';
const identity = directory => createHash('sha256').update(directory).digest('hex').slice(0, 16);
function fields(output, marker, count) {
  const bytes = Buffer.from(output), start = bytes.indexOf(marker + '\0');
  if (start < 0) throw new Error('WSL did not return the expected runtime information.');
  const values = bytes.subarray(start + marker.length + 1).toString('utf8').split('\0').slice(0, count);
  if (values.length !== count || values.some(value => !value || /[\r\n]/.test(value))) throw new Error('WSL returned invalid runtime information.');
  return values;
}
function diagnostic(output) {
  const bytes = Buffer.from(output || '');
  return bytes.toString(bytes[0] === 0xff && bytes[1] === 0xfe || bytes[1] === 0 ? 'utf16le' : 'utf8').replace(/\0/g, '').trim().slice(-6000);
}
function distributionArgs(distro) { return distro ? ['--distribution', distro] : []; }
function powershellQuote(value) { return "'" + value.replaceAll("'", "''") + "'"; }
function shellQuote(value) { return "'" + value.replaceAll("'", "'\\''") + "'"; }
function setupCommand(backend) {
  const script = `export PATH=${shellQuote(backend.nodePath.slice(0, -5))}:"$HOME/.local/bin:$PATH"; exec /bin/bash -i`;
  return `wsl.exe --distribution ${powershellQuote(backend.distro)} --exec /bin/bash -c ${powershellQuote(script)}`;
}

class WslBackend extends EventEmitter {
  constructor({ distro, nodePath, runnerPath, id, port, token, path, env, execute, spawnCommand }) {
    super();
    Object.assign(this, { distro, nodePath, runnerPath, id, execute });
    this.connected = true;
    this.child = spawnCommand('wsl.exe', [...distributionArgs(distro), '--exec', nodePath, runnerPath, id], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.stdout = this.child.stdout; this.stderr = this.child.stderr;
    this.child.once('error', error => this.emit('error', error));
    this.child.once('close', (code, signal) => { this.connected = false; this.emit('exit', code, signal); });
    this.child.stdin.on('error', () => {}); // An exited WSL process reports its error/close separately.
    let announced = false;
    createInterface({ input: this.stdout }).on('line', line => {
      if (!line.startsWith(READY) || announced) return;
      try {
        const message = JSON.parse(line.slice(READY.length));
        if (message.id !== id || message.port !== Number(port)) return;
        announced = true;
        this.emit('message', { type: 'codeflow-ready', url: `http://localhost:${port}/?token=${encodeURIComponent(token)}` });
      } catch {}
    });
    // The owner token travels only over the private stdin pipe, never in wsl.exe arguments.
    this.child.stdin.write(JSON.stringify({ port: Number(port), token, path }) + '\n');
  }
  disconnect() {
    if (!this.connected) return;
    this.connected = false;
    this.child.stdin.end('stop\n');
  }
  kill(signal) {
    void this.execute([...distributionArgs(this.distro), '--exec', this.nodePath, this.runnerPath, this.id, '--stop', signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM'], 10000).catch(() => this.child.kill());
  }
}

async function startWslBackend({ source, config, userData, port, token, signal, env = process.env, execCommand = execFile, spawnCommand = spawn }) {
  if (!['x64', 'arm64'].includes(config.arch) || !/^[a-f0-9]{64}$/.test(config.bundleId) || !/^[a-f0-9]{64}$/.test(config.nodeSha256)) throw new Error('Invalid bundled WSL runtime configuration.');
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid desktop port.');
  const archive = await readFile(join(source, 'wsl/node-linux.tar.gz'));
  if (createHash('sha256').update(archive).digest('hex') !== config.nodeSha256) throw new Error('The bundled Node runtime checksum does not match. Extract a fresh copy of Code Flow.');
  const execute = (args, timeout = 30000) => new Promise((resolve, reject) => {
    execCommand('wsl.exe', args, { env, timeout, signal, windowsHide: true, encoding: 'buffer', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(diagnostic(stderr) || diagnostic(stdout) || error.message));
      else resolve(Buffer.from(stdout || ''));
    });
  });
  let distro, linuxHome;
  try {
    const info = fields(await execute([...distributionArgs(env.CODEFLOW_WSL_DISTRO), '--exec', '/bin/sh', '-c', PROBE]), 'CODEFLOW_WSL_INFO', 4);
    const [name, kernel, arch, home] = info;
    if (/^docker-desktop(?:-data)?$/.test(name)) throw new Error('Select an Ubuntu or Debian user distribution with wsl --set-default.');
    if (!/microsoft.*wsl2/i.test(kernel)) throw new Error('The selected distribution must use WSL2. Check wsl --list --verbose.');
    if ((config.arch === 'x64' ? 'x86_64' : 'aarch64') !== arch) throw new Error(`Choose the ${arch === 'aarch64' ? 'ARM64' : 'x64'} Windows package for this WSL distribution.`);
    distro = name; linuxHome = home;
  } catch (error) { throw new Error(`Code Flow requires an initialized WSL2 distribution. Run wsl --install in PowerShell, complete Linux user setup, then reopen Code Flow.\n\n${error.message}`); }
  const prefix = distributionArgs(distro);
  const linuxSource = diagnostic(await execute([...prefix, '--exec', 'wslpath', '-u', source]));
  if (!linuxSource.startsWith('/') || /[\r\n\0]/.test(linuxSource)) throw new Error('The app folder could not be accessed from WSL. Extract the ZIP to a local Windows drive.');
  const id = identity(userData);
  const [nodePath, runnerPath] = fields(await execute([...prefix, '--exec', '/bin/sh', `${linuxSource}/wsl/bootstrap.sh`, linuxSource, config.bundleId, id, config.arch, config.nodeSha256], 120000), 'CODEFLOW_WSL_RUNTIME', 2);
  const pathProbe = await execute([...prefix, '--exec', '/bin/bash', '-ilc', 'printf "\\nCODEFLOW_WSL_PATH=%s\\n" "$PATH"'], 10000).catch(() => Buffer.alloc(0));
  const loginPath = pathProbe.toString('utf8').match(/(?:^|\n)CODEFLOW_WSL_PATH=([^\r\n]+)/)?.[1];
  const path = [nodePath.slice(0, -5), `${linuxHome}/.local/bin`, `${linuxHome}/.bun/bin`, loginPath || '/usr/local/bin:/usr/bin:/bin'].join(':');
  signal?.throwIfAborted();
  return new WslBackend({ distro, nodePath, runnerPath, id, port, token, path, env, execute, spawnCommand });
}
module.exports = { startWslBackend, fields, diagnostic, identity, setupCommand, PROBE, READY };
