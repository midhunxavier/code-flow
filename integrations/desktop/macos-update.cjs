// Preview builds cannot use Squirrel.Mac. Stage a verified release beside the
// installed bundle, then let an independent helper replace it after app exit.
const fs = require('node:fs/promises');
const { constants, createWriteStream } = require('node:fs');
const { createHash } = require('node:crypto');
const { dirname, join, basename } = require('node:path');
const { execFile, fork } = require('node:child_process');
const { promisify } = require('node:util');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const command = promisify(execFile);
const BUNDLE_ID = 'io.github.midhunxavier.code-flow';
const MAX_DOWNLOAD = 1536 * 1024 * 1024;

async function downloadAsset(candidate, target, onProgress, fetchRelease = fetch) {
  const checksumResponse = await fetchRelease(candidate.checksumUrl, { signal: AbortSignal.timeout(15000) });
  if (!checksumResponse.ok) throw new Error('Could not fetch the update checksum.');
  let checksumText = '';
  for await (const chunk of checksumResponse.body) {
    checksumText += Buffer.from(chunk).toString('utf8');
    if (checksumText.length > 1024) throw new Error('Invalid update checksum.');
  }
  const checksum = /^([a-f\d]{64})\s+\*?([^\r\n]+)\s*$/i.exec(checksumText.trim());
  if (!checksum || checksum[2] !== basename(new URL(candidate.downloadUrl).pathname)) throw new Error('Invalid update checksum.');
  if (!Number.isSafeInteger(candidate.size) || candidate.size <= 0 || candidate.size > MAX_DOWNLOAD) throw new Error('Invalid update size.');
  const response = await fetchRelease(candidate.downloadUrl, { signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error('Could not download the update.');
  const hash = createHash('sha256');
  let received = 0, lastPercent = -1;
  const verify = new Transform({ transform(chunk, _encoding, callback) {
    received += chunk.length;
    if (received > candidate.size) return callback(new Error('Update exceeds its published size.'));
    hash.update(chunk);
    const percent = Math.floor(received * 100 / candidate.size);
    if (percent !== lastPercent) { lastPercent = percent; onProgress?.(percent); }
    callback(null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), verify, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
  if (received !== candidate.size || hash.digest('hex') !== checksum[1].toLowerCase()) throw new Error('The update checksum does not match.');
}

async function verifyBundle(bundle, version, arch, installed, run = command) {
  if (!(await fs.lstat(bundle)).isDirectory()) throw new Error('The update is not an application bundle.');
  const plist = join(bundle, 'Contents/Info.plist');
  const field = async name => (await run('/usr/bin/plutil', ['-extract', name, 'raw', '-o', '-', plist])).stdout.trim();
  if (await field('CFBundleIdentifier') !== BUNDLE_ID || await field('CFBundleShortVersionString') !== version || await field('CFBundleExecutable') !== 'Code Flow') throw new Error('The update is for a different application or version.');
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  await run('/usr/bin/lipo', [join(bundle, 'Contents/MacOS/Code Flow'), '-verify_arch', arch === 'x64' ? 'x86_64' : arch]);
  // Preserve publisher identity if this installation has a Developer ID.
  const team = async path => (await run('/usr/bin/codesign', ['-dv', '--verbose=4', path])).stderr.match(/^TeamIdentifier=(.+)$/m)?.[1];
  const installedTeam = await team(installed);
  if (installedTeam && installedTeam !== 'not set' && await team(bundle) !== installedTeam) throw new Error('The update publisher does not match this installation.');
}

async function replaceBundle({ appPath, staged, backup }, launch = path => command('/usr/bin/open', ['-n', path])) {
  // All renames are on the installation volume. Never remove the old copy until
  // the replacement has been accepted by Launch Services.
  await fs.rename(appPath, backup);
  try {
    await fs.rename(staged, appPath);
    await launch(appPath);
  } catch (error) {
    // Move a failed replacement aside before restoring the working version.
    if (await fs.lstat(appPath).catch(() => undefined)) await fs.rename(appPath, staged);
    await fs.rename(backup, appPath);
    throw error;
  }
}

async function waitForExit(pid, { alive = id => { try { process.kill(id, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }, timeout = 60000, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const deadline = Date.now() + timeout;
  while (alive(pid)) {
    if (Date.now() >= deadline) throw new Error('Code Flow did not exit; the update was not installed.');
    await pause(200);
  }
}

class MacUpdateInstaller {
  constructor({ appPath, cachePath, nodePath, arch, fetch: fetchRelease = fetch, run = command }) {
    this.options = { appPath, cachePath, nodePath, arch, fetchRelease, run };
  }
  async supported() {
    const { appPath } = this.options;
    try {
      if (!appPath.endsWith('.app') || appPath.startsWith('/Volumes/') || appPath.includes('/AppTranslocation/')) return false;
      if (await fs.realpath(appPath) !== appPath) return false;
      await fs.access(dirname(appPath), constants.W_OK);
      return true;
    } catch { return false; }
  }
  async prepare(candidate, onProgress) {
    await this.dispose();
    this.controller = new AbortController();
    this.pending = this.stage(candidate, onProgress, this.controller.signal);
    try { await this.pending; }
    finally { this.pending = undefined; this.controller = undefined; }
  }
  async stage(candidate, onProgress, signal) {
    if (!await this.supported()) throw new Error('Move Code Flow to a writable Applications folder before updating.');
    const { appPath, cachePath, nodePath, arch } = this.options;
    const fetchRelease = (url, options) => this.options.fetchRelease(url, { ...options, signal: AbortSignal.any([signal, options.signal]) });
    const run = (command, args, options) => this.options.run(command, args, { ...options, signal });
    await fs.mkdir(cachePath, { recursive: true, mode: 0o700 });
    const work = await fs.mkdtemp(join(cachePath, 'download-'));
    let stageRoot, mounted = false;
    const mount = join(work, 'mount');
    try {
      const dmg = join(work, 'update.dmg');
      await downloadAsset(candidate, dmg, onProgress, fetchRelease);
      onProgress?.(100);
      await fs.mkdir(mount);
      // A cancelled hdiutil process may already have mounted the image.
      mounted = true;
      await run('/usr/bin/hdiutil', ['attach', dmg, '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount], { timeout: 120000 });
      stageRoot = await fs.mkdtemp(join(dirname(appPath), '.code-flow-update-'));
      const staged = join(stageRoot, 'Code Flow.app');
      await run('/usr/bin/ditto', [join(mount, 'Code Flow.app'), staged], { timeout: 300000 });
      await verifyBundle(staged, candidate.version, arch, appPath, run);
      await run('/usr/bin/hdiutil', ['detach', mount], { timeout: 30000 });
      mounted = false;
      // The helper runtime must survive replacement of the running app bundle.
      await fs.copyFile(nodePath, join(work, 'node'));
      await fs.chmod(join(work, 'node'), 0o700);
      await fs.copyFile(__filename, join(work, 'installer.cjs'));
      this.prepared = { work, stageRoot, staged, appPath, backup: join(stageRoot, 'Previous.app') };
      await fs.rm(dmg);
    } catch (error) {
      if (mounted) await this.options.run('/usr/bin/hdiutil', ['detach', mount], { timeout: 30000 }).catch(() => {});
      if (stageRoot) await fs.rm(stageRoot, { recursive: true, force: true });
      await fs.rm(work, { recursive: true, force: true });
      throw error;
    }
  }
  async install() {
    if (!this.prepared) throw new Error('Download the update first.');
    const prepared = this.prepared;
    const config = { ...prepared, parentPid: process.pid, resultPath: join(this.options.cachePath, 'last-result.json') };
    const configPath = join(prepared.work, 'install.json');
    await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const child = fork(join(prepared.work, 'installer.cjs'), [configPath], { execPath: join(prepared.work, 'node'), detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    await new Promise((resolve, reject) => {
      const finish = error => { clearTimeout(timer); child.removeListener('error', failed); child.removeListener('exit', exited); child.removeListener('message', ready); if (error) { child.kill(); reject(error); } else resolve(); };
      const failed = error => finish(error);
      const exited = () => finish(new Error('The update helper could not start.'));
      const ready = message => { if (message === 'ready') finish(); };
      const timer = setTimeout(() => finish(new Error('The update helper did not respond.')), 10000);
      child.once('error', failed); child.once('exit', exited); child.on('message', ready);
    });
    child.disconnect(); child.unref();
    this.prepared = undefined;
  }
  async dispose() {
    this.controller?.abort();
    await this.pending?.catch(() => {});
    if (!this.prepared) return;
    const { work, stageRoot } = this.prepared;
    this.prepared = undefined;
    await fs.rm(stageRoot, { recursive: true, force: true });
    await fs.rm(work, { recursive: true, force: true });
  }
}

async function runHelper(config) {
  let parentExited = false;
  try {
    process.send?.('ready');
    await waitForExit(config.parentPid);
    parentExited = true;
    await replaceBundle(config, async path => {
      await fs.writeFile(config.resultPath, JSON.stringify({ ok: true }), { mode: 0o600 });
      await command('/usr/bin/open', ['-n', path]);
    });
    await fs.rm(config.stageRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(config.work, { recursive: true, force: true }).catch(() => {});
  } catch (error) {
    // Keep the backup and staging directory on failure for recovery. Never
    // delete either copy after an unsuccessful swap or rollback.
    await fs.writeFile(config.resultPath, JSON.stringify({ ok: false, message: error.message, recoveryPath: config.stageRoot }), { mode: 0o600 }).catch(() => {});
    if (parentExited) await command('/usr/bin/open', ['-n', config.appPath]).catch(() => {});
  }
}

if (require.main === module) {
  fs.readFile(process.argv[2], 'utf8').then(JSON.parse).then(runHelper).catch(() => { process.exitCode = 1; });
}
module.exports = { MacUpdateInstaller, downloadAsset, verifyBundle, replaceBundle, waitForExit };
