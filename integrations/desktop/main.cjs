const { app, BrowserWindow, Menu, dialog, shell, screen } = require('electron');
const { fork, execFile } = require('node:child_process');
const { createServer } = require('node:net');
const { randomBytes } = require('node:crypto');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const { join } = require('node:path');
const { homedir } = require('node:os');

app.setName('Code Flow');
// Separate desktop UI preferences from the backend's existing ~/.codeflow history.
if (process.env.CODEFLOW_DESKTOP_DATA) app.setPath('userData', process.env.CODEFLOW_DESKTOP_DATA);
const runtime = join(__dirname, 'backend');
const node = join(__dirname, 'node/bin/node');
const home = process.env.CODEFLOW_HOME || join(homedir(), '.codeflow');
let backend, window, origin, ownerURL, quitting = false, exitApproved = false, checkingQuit = false, ready;
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
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false, safeDialogs: true, spellcheck: true } });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { if (origin && new URL(url).origin !== origin) { event.preventDefault(); external(url); } });
  window.webContents.on('render-process-gone', async (_event, details) => {
    if (quitting || !window || window.isDestroyed()) return;
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
  await mkdir(home, { recursive: true });
  const port = process.env.PORT || await freePort();
  origin = `http://localhost:${port}`;
  const path = await loginPath();
  if (quitting) return;
  backend = fork(join(runtime, 'src/server.js'), [], { execPath: node, cwd: runtime,
    env: { ...process.env, PATH: path, PORT: String(port), HOST: '127.0.0.1', CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, CODEFLOW_LAUNCHER: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let diagnostics = '';
  const redact = data => {
    const safe = String(data).replaceAll(token, '[redacted]').replace(/([?&]token=)[^\s]+/g, '$1[redacted]');
    diagnostics = (diagnostics + safe).slice(-8000);
  };
  backend.stdout.on('data', redact); backend.stderr.on('data', redact);
  ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The local service did not start within 60 seconds.')), 60000);
    backend.once('error', error => { clearTimeout(timer); reject(error); });
    backend.on('message', message => {
      if (message?.type !== 'codeflow-ready' || typeof message.url !== 'string') return;
      const url = new URL(message.url);
      if (url.origin !== origin) return;
      ownerURL = message.url; clearTimeout(timer); resolve();
    });
    backend.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`The local service stopped (${code ?? signal}).\n${diagnostics}`)); });
  });
  backend.on('exit', () => {
    backend = undefined;
    if (quitting || !ownerURL) return;
    void dialog.showMessageBox(window, { type: 'error', message: 'Code Flow’s local service stopped', detail: 'Saved work is preserved. Reopen Code Flow to reconnect and resume unfinished work.\n\n' + diagnostics, buttons: ['Quit'], noLink: true }).then(() => { exitApproved = true; app.quit(); });
  });
  await ready;
}
async function quit() {
  if (quitting || checkingQuit) return;
  checkingQuit = true;
  if (!exitApproved && origin && backend) {
    try {
      const response = await fetch(`${origin}/api/runs`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error("Could not inspect running agents");
      const runs = await response.json();
      if (!Array.isArray(runs)) throw new Error("Invalid running-agent response");
      if (runs.some(run => run.status === 'running')) {
        const answer = await dialog.showMessageBox(window, { type: 'question', message: 'Agents are still working', detail: 'Keep Code Flow running to let them finish. Quitting saves their progress so you can resume later.', buttons: ['Keep running', 'Quit and save progress'], defaultId: 0, cancelId: 0, noLink: true });
        if (answer.response !== 1) { checkingQuit = false; return; }
      }
    } catch {
      if (backend) {
        const answer = await dialog.showMessageBox(window, { type: 'question', message: 'Could not check whether agents are working', detail: 'Keep Code Flow running, or quit and save progress for later.', buttons: ['Keep running', 'Quit and save progress'], defaultId: 0, cancelId: 0, noLink: true });
        if (answer.response !== 1) { checkingQuit = false; return; }
      }
    }
  }
  quitting = true; checkingQuit = false;
  if (backend) {
    const child = backend;
    await new Promise(resolve => { const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(); }, 12000); child.once('exit', () => { clearTimeout(timer); resolve(); }); if (child.connected) child.disconnect(); else child.kill('SIGTERM'); });
  }
  app.quit();
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
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Code Flow', submenu: [{ role: 'about' }, { type: 'separator' }, { label: 'Show Code Flow', accelerator: 'CmdOrCtrl+1', click: () => { void ready?.then(createWindow); } }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' }, { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] }, { role: 'windowMenu' },
      { role: 'help', submenu: [{ label: 'Code Flow documentation', click: () => external('https://midhunxavier.github.io/code-flow/') }] },
    ]));
    await startBackend(); await createWindow();
  }).catch(async error => { await dialog.showMessageBox({ type: 'error', message: 'Code Flow could not start', detail: String(error.message).replaceAll(token, '[redacted]'), buttons: ['Quit'] }); exitApproved = true; void quit(); });
}
