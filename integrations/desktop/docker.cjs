const { execFile, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { isAbsolute } = require('node:path');
const { stat } = require('node:fs/promises');
const { createInterface } = require('node:readline');

const READY = 'CODEFLOW_DESKTOP_READY';
const OWNER_LABEL = 'io.codeflow.desktop.owner';
const identity = directory => createHash('sha256').update(directory).digest('hex').slice(0, 16);

function launchArguments({ workspace, port, image, id }) {
  if (!isAbsolute(workspace) || /[,\r\n\0]/.test(workspace)) throw new Error('Choose an absolute projects folder without commas or line breaks.');
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid desktop port.');
  if (!/^code-flow-desktop:[a-zA-Z0-9_.-]+$/.test(image) || !/^[a-f0-9]{16}$/.test(id)) throw new Error('Invalid desktop image configuration.');
  return ['run', '--rm', '--init', '--interactive', '--pull=never', '--name', `codeflow-desktop-${id}`,
    '--label', `${OWNER_LABEL}=${id}`, '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit', '1024',
    '--publish', `127.0.0.1:${port}:${port}`, '--env', `PORT=${Number(port)}`,
    '--mount', `type=bind,source=${workspace},target=/workspace`,
    '--mount', `type=volume,source=codeflow-desktop-home-${id}-${identity(workspace)},target=/home/node`,
    '--env', 'CODEFLOW_TOKEN', image];
}

class DockerBackend extends EventEmitter {
  constructor({ args, name, token, port, env, spawnCommand = spawn, execute }) {
    super();
    this.name = name; this.connected = true; this.execute = execute;
    this.child = spawnCommand('docker', args, { env: { ...env, CODEFLOW_TOKEN: token }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.stdout = this.child.stdout; this.stderr = this.child.stderr;
    this.child.once('error', error => this.emit('error', error));
    this.child.once('close', (code, signal) => { this.connected = false; this.emit('exit', code, signal); });
    let announced = false;
    createInterface({ input: this.stdout }).on('line', line => {
      if (line !== READY || announced) return;
      announced = true;
      this.emit('message', { type: 'codeflow-ready', url: `http://localhost:${port}/?token=${encodeURIComponent(token)}` });
    });
  }
  disconnect() {
    if (!this.connected) return;
    this.connected = false;
    // Ask the daemon to stop the exact owned container; killing docker.exe alone is insufficient.
    void this.execute(['stop', '--time', '15', this.name], 20000).catch(() => this.kill('SIGKILL'));
  }
  kill(signal) {
    void this.execute(['kill', '--signal', signal === 'SIGKILL' ? 'KILL' : 'TERM', this.name], 5000).catch(() => {});
  }
}

async function startDockerBackend({ workspace, port, token, userData, context, image, signal, env = process.env, execCommand = execFile, spawnCommand = spawn }) {
  const id = identity(userData), name = `codeflow-desktop-${id}`;
  const args = launchArguments({ workspace, port, image, id });
  if (!(await stat(workspace)).isDirectory()) throw new Error('The saved projects folder is unavailable. Choose another folder from the Code Flow menu.');
  const execute = (args, timeout = 15000) => new Promise((resolve, reject) => {
    execCommand('docker', args, { env, timeout, signal, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).slice(-6000)));
      else resolve(String(stdout).trim());
    });
  });
  try {
    const endpoint = env.DOCKER_HOST && !env.DOCKER_CONTEXT ? env.DOCKER_HOST : JSON.parse(await execute(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}']));
    if (!/^(?:unix|npipe):\/\//.test(endpoint)) throw new Error('Use a local Docker Desktop context so the selected projects folder stays on this computer.');
    if (await execute(['info', '--format', '{{.OSType}}']) !== 'linux') throw new Error('Switch Docker Desktop to Linux containers.');
  } catch (error) { throw new Error(`Docker Desktop is required. Start Docker Desktop with Linux containers, then reopen Code Flow.\n\n${error.message}`); }
  // Recover only this desktop installation's container after an interrupted app session.
  const owner = await execute(['inspect', '--format', `{{index .Config.Labels "${OWNER_LABEL}"}}`, name]).catch(() => undefined);
  if (owner !== undefined) {
    if (owner !== id) throw new Error('A container with the Code Flow name belongs to another application. Rename it before continuing.');
    await execute(['rm', '--force', name]);
  }
  const installed = await execute(['image', 'inspect', image]).then(() => true, () => false);
  if (!installed) await execute(['build', '--tag', image, context], 15 * 60 * 1000);
  signal?.throwIfAborted();
  return new DockerBackend({ args, name, token, port, env, spawnCommand, execute });
}

module.exports = { startDockerBackend, launchArguments, identity, READY, OWNER_LABEL };
