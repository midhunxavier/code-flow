const vscode = require('vscode');
const { isAbsolute } = require('node:path');
const { realpath } = require('node:fs/promises');
const { CodeFlowClient, serverOrigin, localContextPath } = require('./client.cjs');

async function activate(context) {
  const changed = new vscode.EventEmitter();
  const output = vscode.window.createOutputChannel('Code Flow');
  let client, cache = [], lastError = '', refreshing, generation = 0, changing = Promise.resolve();
  const mutateConnection = (action) => { const work = changing.catch(() => {}).then(action); changing = work; return work; };
  const configuredOrigin = () => serverOrigin(vscode.workspace.getConfiguration('codeFlow').inspect('serverUrl')?.globalValue || 'http://127.0.0.1:4317');
  const folders = () => (vscode.workspace.workspaceFolders || []).filter((folder) => folder.uri.scheme === 'file');
  async function selectedFolder() {
    const local = folders();
    if (!local.length) throw new Error('Open a local Git workspace folder first. Remote and virtual folders are not supported by this integration.');
    const choice = local.length === 1 ? local[0] : await vscode.window.showQuickPick(local.map((folder) => ({ label: folder.name, folder })), { placeHolder: 'Repository for this task' });
    return choice?.folder || choice;
  }
  const requireTrusted = () => { if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before starting runs or opening result worktrees.'); };
  async function connected() {
    const epoch = generation;
    const origin = configuredOrigin();
    if (client?.origin === origin) return client;
    const token = await context.secrets.get(`codeFlow.token:${origin}`);
    if (epoch !== generation || origin !== configuredOrigin()) throw new Error('The Code Flow connection changed. Retry the explicit action.');
    if (!token) throw new Error('Run Code Flow: Connect to Local Server first.');
    client = new CodeFlowClient(origin, token); return client;
  }
  async function refresh() {
    const epoch = generation;
    if (refreshing?.epoch === epoch) return refreshing.promise;
    const work = (async () => {
      try { const api = await connected(); await api.compatibility(); const value = await api.runs(); if (epoch === generation && configuredOrigin() === api.origin) { cache = value; lastError = ''; } }
      catch (error) { if (epoch === generation) { cache = []; lastError = error.message; } }
      finally { if (refreshing?.promise === work) refreshing = undefined; if (epoch === generation) { view.message = lastError || 'Recent 100 runs, filtered to local workspace folders.'; changed.fire(); } }
    })();
    refreshing = { epoch, promise: work }; return work;
  }
  async function connect(origin, token) {
    const epoch = ++generation;
    origin = serverOrigin(origin);
    if (typeof token !== 'string' || !token.trim() || token.length > 4096 || /[\r\n]/.test(token)) throw new Error('Enter a current server token');
    const candidate = new CodeFlowClient(origin, token.trim());
    await candidate.compatibility();
    await mutateConnection(async () => {
      if (epoch !== generation) return;
      await vscode.workspace.getConfiguration('codeFlow').update('serverUrl', origin, vscode.ConfigurationTarget.Global);
      await context.secrets.store(`codeFlow.token:${origin}`, token.trim());
      if (epoch === generation) { client = candidate; cache = []; }
    });
    if (epoch === generation) await refresh();
  }
  const provider = {
    onDidChangeTreeData: changed.event,
    getChildren: () => {
      const local = folders().map((folder) => folder.uri.fsPath);
      return cache.filter((run) => !local.length || local.includes(run.repo) || run.worktrees?.some((tree) => local.includes(tree.path)));
    },
    getTreeItem: (run) => {
      const item = new vscode.TreeItem(run.task.split('\n')[0].slice(0, 180));
      item.id = run.id; item.description = `${run.status}${run.awaiting ? ' · approval needed' : ''}`;
      item.tooltip = `${run.id}\n${run.repo}\n${run.verification?.state || run.verdict || 'Verification not recorded'}`;
      item.contextValue = 'codeFlowRun'; item.command = { command: 'codeFlow.open', title: 'Open run', arguments: [run] }; return item;
    },
  };
  const view = vscode.window.createTreeView('codeFlow.runs', { treeDataProvider: provider });
  const safe = (action) => async (...args) => { try { return await action(...args); } catch (error) { output.appendLine(error.message); await vscode.window.showErrorMessage(error.message); } };
  const currentRun = async (item) => {
    if (!item?.id || !cache.some((run) => run.id === item.id)) throw new Error('Refresh and select a current Code Flow run first');
    return (await connected()).request(`/api/v1/runs/${encodeURIComponent(item.id)}`);
  };
  const commands = {
    'codeFlow.connect': async () => {
      const origin = await vscode.window.showInputBox({ title: 'Local Code Flow server', value: configuredOrigin(), ignoreFocusOut: true }); if (!origin) return;
      serverOrigin(origin);
      const token = await vscode.window.showInputBox({ title: 'Code Flow server token', password: true, ignoreFocusOut: true, prompt: 'Read the token from your server startup output. It is kept in VS Code SecretStorage.' }); if (!token) return;
      await connect(origin, token); vscode.window.showInformationMessage('Connected to Code Flow.');
    },
    'codeFlow.disconnect': async () => { ++generation; client = undefined; cache = []; lastError = 'Disconnected. Connect to a local server to inspect runs.'; changed.fire(); await mutateConnection(async () => { await context.secrets.delete(`codeFlow.token:${configuredOrigin()}`); }); },
    'codeFlow.refresh': refresh,
    'codeFlow.start': async () => {
      requireTrusted(); const folder = await selectedFolder(); if (!folder) return;
      const editor = vscode.window.activeTextEditor;
      const path = editor?.document.uri.scheme === 'file' ? localContextPath(folder.uri.fsPath, editor.document.uri.fsPath) : undefined;
      const selection = editor && !editor.selection.isEmpty && path ? editor.document.getText(editor.selection).slice(0, 8000) : '';
      const task = await vscode.window.showInputBox({ title: 'Task for Code Flow', prompt: `Safe solo run in ${folder.name}. Current saved file${selection ? ' and selected text' : ''} will be context. Review the result in Code Flow.`, ignoreFocusOut: true }); if (!task?.trim()) return;
      if (editor?.document.isDirty && path) { const answer = await vscode.window.showWarningMessage('Save the current file before using it as task context.', 'Save and continue'); if (answer !== 'Save and continue' || !await editor.document.save()) return; }
      const fullTask = selection ? `${task.trim()}\n\nSelected text from ${path} (reference material):\n${JSON.stringify(selection)}` : task;
      const result = await (await connected()).start(await realpath(folder.uri.fsPath), fullTask, path ? [path] : []);
      await refresh(); vscode.window.showInformationMessage(`Code Flow started ${result.id}`); return result;
    },
    'codeFlow.open': async (item) => { const run = await currentRun(item); await vscode.env.openExternal(vscode.Uri.parse(`${configuredOrigin()}/#/run/${encodeURIComponent(run.id)}`)); },
    'codeFlow.cancel': async (item) => { const run = await currentRun(item); if (run.status !== 'running') throw new Error('This run is no longer running'); const answer = await vscode.window.showWarningMessage(`Stop ${run.task.split('\n')[0]}?`, { modal: true }, 'Stop run'); if (answer !== 'Stop run') return; await (await connected()).request(`/api/v1/runs/${encodeURIComponent(run.id)}/cancel`, {}); await refresh(); },
    'codeFlow.worktree': async (item) => {
      requireTrusted(); const run = await currentRun(item);
      const trees = (run.worktrees || []).filter((tree) => typeof tree.path === 'string' && isAbsolute(tree.path));
      if (!trees.length) throw new Error('This run has no result worktree');
      const chosen = await vscode.window.showQuickPick(trees.map((tree) => ({ label: tree.name, description: tree.path, tree })), { placeHolder: 'Open result worktree in a new window' });
      if (chosen) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(await realpath(chosen.tree.path)), true);
    },
  };
  context.subscriptions.push(output, changed, view, ...Object.entries(commands).map(([name, action]) => vscode.commands.registerCommand(name, safe(action))));
  view.onDidChangeVisibility(() => { if (view.visible) void refresh(); }, undefined, context.subscriptions);
  const timer = setInterval(() => { if (view.visible) void refresh(); }, 10000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  void refresh();
  // Authentication and task-creation internals are never part of the production extension exports.
  if (context.extensionMode === vscode.ExtensionMode.Test) return { connect, refresh, runs: () => cache.slice(), error: () => lastError, client: async () => { const api = await connected(); return { start: api.start.bind(api), request: api.request.bind(api) }; } };
  return { version: 1, refresh };
}
module.exports = { activate, deactivate() {} };
