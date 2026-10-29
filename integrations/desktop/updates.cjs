const { EventEmitter } = require('node:events');

const RELEASES = 'https://github.com/midhunxavier/code-flow/releases';
const API = 'https://api.github.com/repos/midhunxavier/code-flow/releases?per_page=100';

// The published channels are stable and preview.N. Ignore unrelated tags/channels.
function versionParts(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.(0|[1-9]\d*))?$/.exec(version);
  return match && [BigInt(match[1]), BigInt(match[2]), BigInt(match[3]), match[4] === undefined ? null : BigInt(match[4])];
}
function compareVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  if (!left || !right) throw new Error('Unsupported release version');
  for (let i = 0; i < 4; i++) {
    if (left[i] === right[i]) continue;
    if (left[i] === null) return 1;
    if (right[i] === null) return -1;
    return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}
function selectRelease(releases, currentVersion, arch, nativeUpdates, platform = 'darwin', previewInstaller = false) {
  if (!Array.isArray(releases)) throw new Error('Invalid release response');
  const current = versionParts(currentVersion);
  if (!current) throw new Error('Unsupported installed version');
  const candidates = [];
  for (const release of releases) {
    const version = typeof release?.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : '';
    const parts = versionParts(version);
    if (!parts || release.draft || compareVersions(version, currentVersion) <= 0) continue;
    if (current[3] === null && (release.prerelease || parts[3] !== null)) continue;
    const base = `${RELEASES}/download/${release.tag_name}/`;
    const asset = name => release.assets?.find(item => item.name === name && item.browser_download_url === base + name && item.size > 0);
    if (platform === 'win32') {
      const installer = asset(`code-flow-${version}-windows-${arch}-unsigned.zip`);
      if (installer) candidates.push({ version, releaseUrl: `${RELEASES}/tag/${release.tag_name}`, downloadUrl: installer.browser_download_url, canInstall: false });
      continue;
    }
    const name = `code-flow-${version}-macos-${arch}`;
    const signed = asset(`${name}.dmg`);
    const installer = signed || (!nativeUpdates && asset(`${name}-unnotarized.dmg`));
    if (!installer) continue;
    const manifest = asset(`releases-${arch}.json`);
    const zip = asset(`${name}.zip`);
    const checksum = asset(`${installer.name}.sha256`);
    const native = Boolean(nativeUpdates && signed && manifest && zip);
    const preview = Boolean(!nativeUpdates && previewInstaller && checksum);
    candidates.push({ version, releaseUrl: `${RELEASES}/tag/${release.tag_name}`, downloadUrl: installer.browser_download_url,
      canInstall: native || preview, feedUrl: manifest?.browser_download_url,
      ...(preview ? { installer: 'preview', checksumUrl: checksum.browser_download_url, size: installer.size } : {}) });
  }
  return candidates.sort((a, b) => compareVersions(b.version, a.version))[0];
}

class DesktopUpdates extends EventEmitter {
  constructor({ version, arch, enabled, nativeUpdates, platform = 'darwin', autoUpdater, fetch: fetchRelease = (...args) => fetch(...args), openExternal, restart, previewInstaller }) {
    super();
    this.options = { version, arch, enabled, nativeUpdates, platform, autoUpdater, fetchRelease, openExternal, restart, previewInstaller };
    this.state = { currentVersion: version, phase: enabled ? 'idle' : 'unsupported',
      message: enabled ? 'Check for a newer version of Code Flow.' : 'Updates are available in the installed desktop app.' };
    this.nativeBusy = false;
    autoUpdater.on('error', () => {
      if (!this.nativeBusy) return;
      this.nativeBusy = false;
      this.set({ phase: 'error', message: 'The update could not be downloaded or verified. Try again, or download the installer.' });
    });
    autoUpdater.on('update-downloaded', () => {
      if (!this.nativeBusy) return;
      this.nativeBusy = false;
      this.set({ phase: 'downloaded', message: 'Your update is ready. Restart Code Flow to install it.' });
    });
    autoUpdater.on('update-not-available', () => {
      if (!this.nativeBusy) return;
      this.nativeBusy = false;
      this.set({ phase: 'error', message: 'This update is no longer available. Check for updates again.' });
    });
  }
  set(change) { this.state = { ...this.state, ...change }; this.emit('change', this.state); return this.state; }
  async check() {
    if (!this.options.enabled || this.nativeBusy || ['checking', 'downloaded', 'installing'].includes(this.state.phase)) return this.state;
    this.candidate = undefined;
    this.set({ phase: 'checking', version: undefined, releaseUrl: undefined, downloadUrl: undefined, canInstall: false, message: 'Checking for updates…' });
    try {
      const response = await this.options.fetchRelease(API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Code-Flow-Desktop' }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const previewInstaller = await this.options.previewInstaller?.supported();
      this.candidate = selectRelease(await response.json(), this.options.version, this.options.arch, this.options.nativeUpdates, this.options.platform, previewInstaller);
      const checkedAt = new Date().toISOString();
      if (!this.candidate) return this.set({ phase: 'up-to-date', checkedAt, message: 'You’re up to date.' });
      const { feedUrl, installer, checksumUrl, size, ...release } = this.candidate;
      return this.set({ ...release, phase: 'available', checkedAt,
        message: release.canInstall ? `Code Flow ${release.version} is available.` : this.options.platform === 'win32' ? `Code Flow ${release.version} is available. Download the ZIP, quit Code Flow, then extract and open the new copy.` : `Code Flow ${release.version} is available. Download the installer, then quit Code Flow and replace it in Applications.` });
    } catch {
      return this.set({ phase: 'error', message: 'Could not check for updates. Check your internet connection and try again.' });
    }
  }
  async download() {
    if (!this.candidate || !['available', 'error'].includes(this.state.phase) || this.nativeBusy) return this.state;
    if (!this.candidate.canInstall) return this.openInstaller();
    this.nativeBusy = true;
    this.set({ phase: 'downloading', progress: undefined, message: 'Downloading and verifying your update. You can keep working.' });
    if (this.candidate.installer === 'preview') {
      try {
        await this.options.previewInstaller.prepare(this.candidate, progress => this.set({ progress,
          message: progress === 100 ? 'Verifying and preparing your update…' : `Downloading update… ${progress}%` }));
        return this.set({ phase: 'downloaded', progress: undefined, message: 'Your update is ready. Restart Code Flow to install it.' });
      } catch {
        return this.set({ phase: 'error', progress: undefined, message: 'The update could not be downloaded or verified. Try again, or download the installer.' });
      } finally { this.nativeBusy = false; }
    }
    try {
      this.options.autoUpdater.setFeedURL({ url: this.candidate.feedUrl, serverType: 'json' });
      this.options.autoUpdater.checkForUpdates();
    } catch (error) { this.options.autoUpdater.emit('error', error); }
    return this.state;
  }
  async backgroundCheck() {
    await this.check();
    if (this.state.phase === 'available' && this.candidate?.canInstall) await this.download();
    return this.state;
  }
  async quitAndInstall() {
    if (this.candidate?.installer === 'preview') {
      await this.options.previewInstaller.install();
      return false; // The helper waits for a normal app quit before replacing it.
    }
    this.options.autoUpdater.quitAndInstall();
    return true;
  }
  async dispose() { await this.options.previewInstaller?.dispose(); }
  async openInstaller() {
    if (this.candidate) {
      try { await this.options.openExternal(this.candidate.downloadUrl); }
      catch { this.set({ phase: 'error', message: 'Could not open the installer. Try again.' }); }
    }
    return this.state;
  }
  async install() {
    if (this.state.phase !== 'downloaded') return this.state;
    this.set({ phase: 'installing', message: 'Preparing to restart…' });
    try {
      const restarted = await this.options.restart();
      if (!restarted) this.set({ phase: 'downloaded', message: 'Your update is ready whenever you’re ready to restart.' });
    } catch {
      this.set({ phase: 'downloaded', message: 'Could not restart. Try again when your agents have finished.' });
    }
    return this.state;
  }
}

function trustedSender(event, window, origin) {
  try { return Boolean(window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && new URL(event.senderFrame.url).origin === origin); }
  catch { return false; }
}
module.exports = { DesktopUpdates, selectRelease, compareVersions, trustedSender };
