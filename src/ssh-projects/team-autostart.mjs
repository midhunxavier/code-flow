// Fixed application code sent over SSH. User input selects only a named lifecycle action.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const unit = 'codeflow-team-server.service';
const marker = '# Managed by Code Flow team server setup';
const execute = promisify(execFile);
const quoteUnit = (value, command = false) => {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('The service path contains unsupported control characters');
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => command ? '$$' : '$') + '"';
};
export function serviceUnit(root, node, path) {
  return `${marker}
[Unit]
Description=Code Flow team server
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=${quoteUnit(node, true)} ${quoteUnit(join(root, 'service-bootstrap.mjs'), true)} --team-server --service
WorkingDirectory=${quoteUnit(root)}
Environment=${quoteUnit('PATH=' + path)}
Restart=on-failure
RestartSec=10s
KillMode=mixed
TimeoutStopSec=45s
UMask=0077

[Install]
WantedBy=default.target
`;
}

export async function configureAutostart(action, options = {}) {
  if (!['status', 'enable', 'disable'].includes(action)) throw new Error('Unknown automatic startup action');
  const home = options.home ?? homedir(), platform = options.platform ?? process.platform;
  const uid = String(options.uid ?? process.getuid?.());
  const root = join(home, '.codeflow', 'team-server');
  const path = options.path ?? process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  const node = options.node ?? process.execPath;
  const run = options.run ?? (async (file, args) => {
    const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
    return (await execute(file, args, { timeout: 10000, maxBuffer: 16384, env: { ...process.env, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtime}/bus` } })).stdout.trim();
  });
  if (platform !== 'linux') return { supported: false, enabled: false, message: 'Automatic startup currently supports Linux servers with systemd. This server can still be started from setup.' };
  const systemctl = (...args) => run('systemctl', ['--user', '--no-ask-password', ...args]);
  try { await systemctl('show-environment'); }
  catch { return { supported: false, enabled: false, message: 'The systemd user service manager is unavailable. Ask the server administrator to enable systemd user services for this SSH account, then reconnect and check again.' }; }
  const unitPath = join(home, '.config', 'systemd', 'user', unit);
  const existing = await readFile(unitPath, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return ''; });
  if (existing && !existing.startsWith(marker + '\n')) throw new Error('A service named codeflow-team-server.service already exists and is not managed by Code Flow. Ask the administrator to resolve the name conflict.');
  let prepared = false;
  try { await readFile(join(root, 'service-bootstrap.mjs')); await readFile(join(root, 'service-package.json')); prepared = true; } catch { /* older installation */ }
  let linger = await run('loginctl', ['show-user', uid, '--property=Linger', '--value']).then(value => value.trim() === 'yes', () => false);
  if (action === 'enable') {
    if (!prepared) throw new Error('Stop the team server and set it up again with this Code Flow version before enabling automatic startup. Saved projects and accounts will be kept.');
    if (!linger) {
      await run('loginctl', ['--no-ask-password', 'enable-linger', uid]).catch(() => undefined);
      linger = await run('loginctl', ['show-user', uid, '--property=Linger', '--value']).then(value => value.trim() === 'yes', () => false);
      if (!linger) return { supported: true, enabled: false, unitEnabled: !!existing && await systemctl("is-enabled", unit).then(value => value.trim() === "enabled", () => false), message: 'An administrator must allow this account’s services to start before login. Run the command on the remote server, then enable automatic startup again.', command: `sudo loginctl enable-linger ${uid}` };
    }
    await mkdir(join(home, '.config', 'systemd', 'user'), { recursive: true, mode: 0o700 });
    const temporary = unitPath + '.tmp';
    await writeFile(temporary, serviceUnit(root, node, path), { mode: 0o600 });
    await rename(temporary, unitPath);
    await systemctl('daemon-reload');
    // Enable for the next boot. Do not interrupt or duplicate the already-running server.
    await systemctl('enable', unit);
  } else if (action === 'disable' && existing) {
    await systemctl('disable', unit);
    // Linger is shared by all of the account's services; leave it in place.
  }
  const installed = !!existing || action === 'enable';
  const unitEnabled = installed && await systemctl('is-enabled', unit).then(value => value.trim() === 'enabled', () => false);
  const enabled = !!unitEnabled && linger && prepared;
  return { supported: true, enabled, unitEnabled: !!unitEnabled, linger, message: enabled
    ? 'Automatic startup is enabled and verified. The team server will start after reboot, without an SSH login.'
    : unitEnabled ? 'The service is enabled, but startup before login is not ready. Enable automatic startup again to repair its configuration.'
    : 'Automatic startup is off. The current team server keeps running; enable this to start it after reboot.' };
}

export async function main() {
  try {
    let text = ''; process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) { text += chunk; if (text.length > 8192) throw new Error('Automatic startup request is too large'); }
    const body = JSON.parse(text);
    const result = await configureAutostart(body.action);
    process.stdout.write('CODEFLOW_AUTOSTART ' + JSON.stringify(result) + '\n');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
