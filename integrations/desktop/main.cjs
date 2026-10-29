const { app, BrowserWindow, Menu, dialog, shell, screen, autoUpdater, ipcMain, clipboard, Tray } = require('electron');
const { DesktopUpdates, trustedSender } = require('./updates.cjs');
const { fork, execFile } = require('node:child_process');
const { createServer } = require('node:net');
const { randomBytes } = require('node:crypto');
const { readFile, writeFile, mkdir, stat } = require('node:fs/promises');
const { join, isAbsolute, dirname } = require('node:path');
const { homedir } = require('node:os');

app.setName('Code Flow');
if (process.platform === 'win32') app.setAppUserModelId('io.github.midhunxavier.code-flow');
// Separate desktop UI preferences from the backend's existing ~/.codeflow history.
if (process.env.CODEFLOW_DESKTOP_DATA) app.setPath('userData', process.env.CODEFLOW_DESKTOP_DATA);
const runtime = join(__dirname, 'backend');
const node = join(__dirname, 'node/bin/node');
const home = process.env.CODEFLOW_HOME || join(homedir(), '.codeflow');
const dockerDesktop = process.env.CODEFLOW_DESKTOP_DOCKER === '1';
const wslDesktop = process.platform === 'win32' && !dockerDesktop;
let backend, window, startingWindow, startupAbort, tray, origin, ownerURL, updates, quitting = false, exitApproved = false, checkingQuit = false, ready;
const token = process.env.CODEFLOW_TOKEN || randomBytes(32).toString('hex');
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
async function loginPath() {
  if (process.env.CODEFLOW_DESKTOP_TEST === '1') return process.env.PATH;
  const fallback = [join(homedir(), '.local/bin'), join(homedir(), '.bun/bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].filter(Boolean).join(':');
  return new Promise(resolve => execFile(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "\\nCODEFLOW_PATH=%s\\n" "$PATH"'], { timeout: 5000, maxBuffer: 256 * 1024 }, (_error, stdout) => resolve(stdout?.match(/(?:^|\n)CODEFLOW_PATH=([^\n]+)/)?.[1] || fallback)));
}
function external(url) {
  try { const parsed = new URL(url); if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) void shell.openExternal(url); } catch {}
}
async function createWindow() {
  if (ownerURL && !backend) { exitApproved = true; void quit(); return; }
  if (window && !window.isDestroyed()) { window.show(); window.focus(); return window; }
  let bounds = { width: 1360, height: 900 };
  try {
    const saved = JSON.parse(await readFile(join(app.getPath('userData'), 'window.json'), 'utf8'));
    if (Number.isFinite(saved.width) && Number.isFinite(saved.height)) {
      const area = screen.getPrimaryDisplay().workAreaSize;
      bounds = { width: Math.max(800, Math.min(saved.width, area.width)), height: Math.max(600, Math.min(saved.height, area.height)) };
    }
  } catch {}
  window = new BrowserWindow({ ...bounds, minWidth: 800, minHeight: 600, title: 'Code Flow', show: false, backgroundColor: '#181914',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false, safeDialogs: true, spellcheck: true,
      preload: join(__dirname, 'preload.cjs'), additionalArguments: [`--codeflow-origin=${origin}`] } });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { if (origin && new URL(url).origin !== origin) { event.preventDefault(); external(url); } });
  window.webContents.on('will-redirect', (event, url) => { if (origin && new URL(url).origin !== origin) event.preventDefault(); });
  window.webContents.on('render-process-gone', async (_event, details) => {
    if (quitting || !backend || !window || window.isDestroyed()) return;
    const result = await dialog.showMessageBox(window, { type: 'warning', message: 'The window needs to reload', detail: `Your agents are still running in the background. ${details.reason}`, buttons: ['Reload'], noLink: true });
    if (result.response === 0 && !window.isDestroyed()) void window.loadURL(ownerURL);
  });
  window.on('close', event => {
    if (!quitting) { event.preventDefault(); window.hide(); }
    const size = window.getNormalBounds();
    void mkdir(app.getPath('userData'), { recursive: true }).then(() => writeFile(join(app.getPath('userData'), 'window.json'), JSON.stringify({ width: size.width, height: size.height }), { mode: 0o600 }));
  });
  window.once('ready-to-show', () => window?.show());
  if (ownerURL) await window.loadURL(ownerURL);
  return window;
}
async function startBackend() {
  const port = process.env.PORT || await freePort();
  origin = `http://localhost:${port}`;
  if (wslDesktop) {
    startingWindow = new BrowserWindow({ width: 600, height: 320, resizable: false, closable: false, title: 'Starting Code Flow', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    await startingWindow.loadFile(join(__dirname, 'starting.html'));
    startupAbort = new AbortController();
    backend = await require('./wsl.cjs').startWslBackend({ source: __dirname, config: require('./wsl-config.json'), userData: app.getPath('userData'), port, token, signal: startupAbort.signal });
    startupAbort = undefined;
    if (quitting) { backend.disconnect(); return; }
  } else if (dockerDesktop) {
    const workspace = await projectsFolder();
    if (!workspace || quitting) return;
    startingWindow = new BrowserWindow({ width: 600, height: 320, resizable: false, closable: false, title: 'Starting Code Flow', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    await startingWindow.loadFile(join(__dirname, 'starting.html'));
    const { image } = require('./docker-config.json');
    startupAbort = new AbortController();
    backend = await require('./docker.cjs').startDockerBackend({ workspace, port, token, userData: app.getPath('userData'), context: join(__dirname, 'docker'), image, signal: startupAbort.signal });
    startupAbort = undefined;
    if (quitting) { backend.disconnect(); return; }
  } else {
    await mkdir(home, { recursive: true });
    const path = await loginPath();
    if (quitting) return;
    backend = fork(join(runtime, 'src/server.js'), [], { execPath: node, cwd: runtime,
      env: { ...process.env, PATH: path, PORT: String(port), HOST: '127.0.0.1', CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, CODEFLOW_LAUNCHER: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  }
  let diagnostics = '';
  const redact = data => {
    const safe = String(data).replaceAll(token, '[redacted]').replace(/([?&]token=)[^\s]+/g, '$1[redacted]');
    diagnostics = (diagnostics + safe).slice(-8000);
  };
  backend.stdout.on('data', redact); backend.stderr.on('data', redact);
  ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The local service did not start within 60 seconds.')), 60000);
    backend.once('error', error => { clearTimeout(timer); reject(error); });
    backend.on('message', async message => {
      if (message?.type !== 'codeflow-ready' || typeof message.url !== 'string') return;
      const url = new URL(message.url);
      if (url.origin !== origin) return;
      if (dockerDesktop || wslDesktop) {
        try {
          let reachable = false;
          for (let attempt = 0; attempt < 30 && !quitting; attempt++) {
            try {
              const response = await fetch(`${origin}/api/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) });
              if (response.ok) { reachable = true; break; }
            } catch {}
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          if (!reachable) throw new Error('The local service is not reachable. Check that WSL localhost forwarding is enabled, then reopen Code Flow.');
        } catch (error) { clearTimeout(timer); reject(error); return; }
      }
      ownerURL = message.url; diagnostics = ''; clearTimeout(timer); resolve();
    });
    backend.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`The local service stopped (${code ?? signal}).\n${diagnostics}`)); });
  });
  backend.on('exit', (code, signal) => {
    backend = undefined;
    if (quitting || !ownerURL) return;
    void dialog.showMessageBox(window, { type: 'error', message: 'Code Flow’s local service stopped', detail: `${signal ? `The service was stopped by ${signal}.` : `The service exited with code ${code ?? 'unknown'}.`} Saved work is preserved. Reopen Code Flow to reconnect and resume unfinished work.${diagnostics.trim() ? '\n\nLast output from the service:\n' + diagnostics : ''}`, buttons: ['Quit'], noLink: true }).then(() => { exitApproved = true; app.quit(); });
  });
  await ready;
}
async function projectsFolder(change = false) {
  const file = join(app.getPath('userData'), 'docker.json');
  if (!change) {
    if (process.env.CODEFLOW_DESKTOP_WORKSPACE) return process.env.CODEFLOW_DESKTOP_WORKSPACE;
    try { const saved = JSON.parse(await readFile(file, 'utf8')); if (typeof saved.workspace === 'string' && isAbsolute(saved.workspace) && (await stat(saved.workspace)).isDirectory()) return saved.workspace; } catch {}
  }
  const selected = await dialog.showOpenDialog({ title: 'Choose your projects folder', buttonLabel: 'Use this folder', properties: ['openDirectory', 'createDirectory'] });
  if (selected.canceled) { if (!change) { exitApproved = true; void quit(); } return; }
  const workspace = selected.filePaths[0];
  if (!workspace || !isAbsolute(workspace) || /[,\r\n\0]/.test(workspace)) throw new Error('Choose a projects folder without commas or line breaks.');
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(file, JSON.stringify({ workspace }), { mode: 0o600 });
  if (change) await dialog.showMessageBox({ message: 'Projects folder saved', detail: 'Quit and reopen Code Flow to use this folder. It will appear as /workspace inside the app. Each projects folder has its own saved settings and agent logins; returning to a previous folder restores them.', buttons: ['OK'] });
  return workspace;
}
async function agentSetup() {
  if (backend?.distro) {
    const command = require('./wsl.cjs').setupCommand(backend);
    const answer = await dialog.showMessageBox(window, { message: 'Set up agents in WSL', detail: `Code Flow uses ${backend.distro}. Node.js and npm are included; install Git and your agent CLIs in this distribution and sign in there. Existing WSL logins are reused.\n\nPaste this command into PowerShell to open a WSL terminal with the bundled Node runtime:\n\n${command}`, buttons: ['Copy terminal command', 'Done'], noLink: true });
    if (answer.response === 0) clipboard.writeText(command);
    return;
  }
  if (!backend?.name) return;
  const command = `docker exec -it ${backend.name} bash`;
  const answer = await dialog.showMessageBox(window, { message: 'Set up your agents', detail: `Claude Code and Codex are included. Sign in inside the container using the terminal command below, then run each CLI’s login command. Login state stays in the Docker volume. Set your Git name and email in this terminal too.\n\n${command}\n\nYour selected projects folder is /workspace inside Code Flow.`, buttons: ['Copy terminal command', 'Done'], noLink: true });
  if (answer.response === 0) clipboard.writeText(command);
}
function setupTray() {
  if (process.platform !== 'win32') return;
  tray = new Tray(join(__dirname, 'icon.png'));
  tray.setToolTip('Code Flow');
  tray.on('double-click', () => { void ready?.then(createWindow); });
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Code Flow', click: () => { void ready?.then(createWindow); } },
    { label: 'Set up agents…', click: () => { void agentSetup(); } },
    { type: 'separator' }, { label: 'Quit Code Flow', click: () => { void quit(); } },
  ]));
}
async function quit(installUpdate = false) {
  if (quitting || checkingQuit) return false;
  checkingQuit = true;
  if (!exitApproved && origin && backend) {
    try {
      const response = await fetch(`${origin}/api/runs`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error("Could not inspect running agents");
      const runs = await response.json();
      if (!Array.isArray(runs)) throw new Error("Invalid running-agent response");
      if (runs.some(run => run.status === 'running')) {
        const answer = await dialog.showMessageBox(window, { type: 'question', message: 'Agents are still working', detail: 'Keep Code Flow running to let them finish. Quitting saves their progress so you can resume later.', buttons: ['Keep running', installUpdate ? 'Save progress and restart' : 'Quit and save progress'], defaultId: 0, cancelId: 0, noLink: true });
        if (answer.response !== 1) { checkingQuit = false; return false; }
      }
    } catch {
      if (backend) {
        const answer = await dialog.showMessageBox(window, { type: 'question', message: 'Could not check whether agents are working', detail: 'Keep Code Flow running, or quit and save progress for later.', buttons: ['Keep running', installUpdate ? 'Save progress and restart' : 'Quit and save progress'], defaultId: 0, cancelId: 0, noLink: true });
        if (answer.response !== 1) { checkingQuit = false; return false; }
      }
    }
  }
  quitting = true; checkingQuit = false;
  startupAbort?.abort();
  if (backend) {
    const child = backend;
    const stopped = await new Promise(resolve => {
      let timer;
      const finish = stopped => { clearTimeout(timer); child.removeListener('exit', exited); resolve(stopped); };
      const exited = () => finish(true);
      child.once('exit', exited);
      timer = setTimeout(() => {
        timer = setTimeout(() => {
          timer = setTimeout(() => finish(false), 5000);
          child.kill('SIGKILL');
        }, 3000);
        child.kill('SIGTERM');
      }, dockerDesktop || wslDesktop ? 20000 : 12000);
      if (child.connected) child.disconnect(); else child.kill('SIGTERM');
    });
    // A replacement app must not race a still-running backend for its data directory.
    if (!stopped && installUpdate) { quitting = false; return false; }
  }
  if (installUpdate) {
    try {
      if (updates) { if (!await updates.quitAndInstall()) setImmediate(() => app.quit()); }
      else autoUpdater.quitAndInstall();
    }
    catch (error) { quitting = false; throw error; }
  }
  // Electron must finish the outer, prevented before-quit dispatch before retrying.
  else { await updates?.dispose().catch(() => {}); setImmediate(() => app.quit()); }
  return true;
}
async function showUpdates() {
  if (!ready) return;
  await ready;
  if (!backend) return;
  await createWindow();
  await window.loadURL(`${origin}/#/settings/general`);
  await updates.check();
}
function setupUpdates() {
  let nativeUpdates = false;
  try { nativeUpdates = require('./update-config.json').nativeUpdates === true; } catch {}
  const previewInstaller = app.isPackaged && process.platform === 'darwin' && !nativeUpdates && !dockerDesktop
    ? new (require('./macos-update.cjs').MacUpdateInstaller)({ appPath: dirname(dirname(dirname(app.getPath('exe')))),
      cachePath: join(app.getPath('userData'), 'updates'), nodePath: node, arch: process.arch }) : undefined;
  updates = new DesktopUpdates({ version: app.getVersion(), arch: process.arch, platform: process.platform,
    enabled: app.isPackaged && ['darwin', 'win32'].includes(process.platform), nativeUpdates, autoUpdater,
    previewInstaller, openExternal: url => shell.openExternal(url), restart: () => quit(true) });
  for (const [action, handler] of Object.entries({ state: () => updates.state, check: () => updates.check(), download: () => updates.download(), installer: () => updates.openInstaller(), install: () => updates.install() })) {
    ipcMain.handle(`codeflow:updates:${action}`, (event) => {
      if (!trustedSender(event, window, origin)) throw new Error('Desktop updates are only available from the app window.');
      return handler();
    });
  }
  updates.on('change', state => {
    if (window && !window.isDestroyed()) window.webContents.send('codeflow:updates:changed', state);
    const item = Menu.getApplicationMenu()?.getMenuItemById('check-updates');
    if (item) {
      item.label = state.phase === 'downloaded' ? 'Restart to Update…' : state.phase === 'available' ? 'Update Available…' : state.phase === 'checking' ? 'Checking for Updates…' : 'Check for Updates…';
      item.enabled = !['checking', 'downloading', 'installing'].includes(state.phase);
    }
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { void ready?.then(createWindow); });
  app.on('activate', () => { void ready?.then(createWindow); });
  app.on('window-all-closed', () => {}); // Closing a window does not cancel paid agent work.
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void quit(); } });
  process.on('SIGTERM', () => { exitApproved = true; void quit(); });
  process.on('SIGINT', () => { exitApproved = true; void quit(); });
  app.whenReady().then(async () => {
    setupUpdates();
    setupTray();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Code Flow', submenu: [{ role: 'about' }, { id: 'check-updates', label: 'Check for Updates…', click: () => { void showUpdates(); } }, { type: 'separator' }, { id: 'show-window', label: 'Show Code Flow', accelerator: 'CmdOrCtrl+1', click: () => { void ready?.then(createWindow); } },
        ...(dockerDesktop || wslDesktop ? [{ label: 'Set up agents…', click: () => { void agentSetup(); } }] : []),
        ...(dockerDesktop ? [{ label: 'Choose projects folder…', click: () => { void projectsFolder(true).catch(error => dialog.showErrorBox('Projects folder could not be saved', error.message)); } }] : []),
        ...(process.platform === 'darwin' ? [{ role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }] : []), { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' }, { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] }, { role: 'windowMenu' },
      { role: 'help', submenu: [{ label: 'Code Flow documentation', click: () => external('https://midhunxavier.github.io/code-flow/') }] },
    ]));
    await startBackend();
    if (quitting || !ownerURL) return;
    await createWindow(); startingWindow?.destroy(); startingWindow = undefined;
    const updateResult = join(app.getPath('userData'), 'updates/last-result.json');
    try {
      const result = JSON.parse(await readFile(updateResult, 'utf8'));
      if (result.ok === false) await dialog.showMessageBox(window, { type: 'error', message: 'Code Flow could not finish updating',
        detail: `${result.message}\nThe previous app was kept. Recovery files: ${result.recoveryPath}`, buttons: ['OK'] });
      await require('node:fs/promises').rm(updateResult, { force: true });
    } catch {}
    if (process.env.CODEFLOW_DESKTOP_TEST !== '1') {
      setTimeout(() => { void updates.backgroundCheck(); }, 10000).unref();
      setInterval(() => { void updates.backgroundCheck(); }, 6 * 60 * 60 * 1000).unref();
    }
  }).catch(async error => { startingWindow?.destroy(); startingWindow = undefined; if (quitting) return; await dialog.showMessageBox({ type: 'error', message: 'Code Flow could not start', detail: String(error.message).replaceAll(token, '[redacted]'), buttons: ['Quit'] }); exitApproved = true; void quit(); });
}
