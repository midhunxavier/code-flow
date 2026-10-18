const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { mkdtemp, writeFile, rm, realpath } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { createServer } = require('node:net');
const { createServer: createHttpServer } = require('node:http');
const vscode = require('vscode');

exports.run = async () => {
  const root = resolve(__dirname, '../../..');
  const node = process.env.CODEFLOW_HOST_TEST_NODE;
  assert.ok(node, 'Run the extension host with scripts/test-vscode.mjs');
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codeflow-editor-host-')));
  const repo = join(directory, 'repo'); let server, proxy;
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    await writeFile(join(repo, 'README.md'), 'Editor integration fixture.\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-qm', 'initial'], { cwd: repo });
    const port = await new Promise((accept) => { const listener = createServer().listen(0, '127.0.0.1', () => { const port = listener.address().port; listener.close(() => accept(port)); }); });
    const origin = `http://127.0.0.1:${port}`, token = 'vscode-extension-host-test-token';
    server = spawn(node, ['--import', 'tsx', 'src/server.ts'], { cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: join(directory, 'home'), CODEFLOW_TOKEN: token, PATH: `${join(root, 'test/fake-bin')}:${process.env.PATH}` }, stdio: 'pipe' });
    let output = ''; server.stdout.on('data', (chunk) => { output += chunk; }); server.stderr.on('data', (chunk) => { output += chunk; });
    for (let count = 0; count < 150; count++) { if (await fetch(origin + '/api/health', { headers: { authorization: `Bearer ${token}` } }).then((response) => response.ok, () => false)) break; if (count === 149 || server.exitCode !== null) throw new Error(output); await new Promise((accept) => setTimeout(accept, 100)); }
    const extension = vscode.extensions.getExtension('codeflow-local.code-flow'); assert.ok(extension, 'Extension discovered by VS Code');
    const api = await extension.activate();
    const commands = await vscode.commands.getCommands();
    for (const name of ['connect', 'disconnect', 'start', 'refresh', 'open', 'cancel', 'worktree']) assert.ok(commands.includes(`codeFlow.${name}`));
    await api.connect(origin, token);
    assert.equal(api.error(), '');
    const client = await api.client();
    const started = await client.start(repo, 'Fix editor integration fixture', ['README.md']);
    let run;
    for (let count = 0; count < 200; count++) { run = await client.request(`/api/v1/runs/${started.id}`); if (run.status !== 'running') break; await new Promise((accept) => setTimeout(accept, 100)); }
    assert.equal(run.status, 'done', run.error); assert.ok(run.worktrees.length); assert.equal(run.trust, 'safe');
    await vscode.commands.executeCommand('codeFlow.refresh');
    assert.ok(api.runs().some((entry) => entry.id === started.id));
    let delay = false, announce, release;
    proxy = createHttpServer(async (req, res) => {
      if (delay && req.url.startsWith('/api/v1/runs?')) { announce?.(); await new Promise((accept) => { release = accept; }); }
      const response = await fetch(origin + req.url, { headers: { authorization: `Bearer ${token}` } });
      res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(await response.text());
    });
    await new Promise((accept) => proxy.listen(0, '127.0.0.1', accept));
    const other = `http://127.0.0.1:${proxy.address().port}`;
    await api.connect(other, token);
    delay = true; const seen = new Promise((accept) => { announce = accept; }); const stale = api.refresh(); await seen;
    await vscode.commands.executeCommand('codeFlow.disconnect');
    release(); await stale; assert.equal(api.runs().length, 0, 'A delayed response cannot repopulate a disconnected view');
    await assert.rejects(api.client(), /Connect/);
    delay = false; await api.connect(other, token);
    delay = true; const nextSeen = new Promise((accept) => { announce = accept; }); const oldOrigin = api.refresh(); await nextSeen;
    await api.connect(origin, token); release(); await oldOrigin;
    assert.ok(api.runs().some((entry) => entry.id === started.id));
    await vscode.commands.executeCommand('codeFlow.disconnect');
    // Forget both fixture endpoint secrets before deleting the isolated profile.
    delay = false; await api.connect(other, token); await vscode.commands.executeCommand('codeFlow.disconnect');
    await writeFile(process.env.CODEFLOW_HOST_TEST_RECEIPT, JSON.stringify({ passed: true, runId: started.id }));
    console.log('Code Flow VS Code extension host acceptance passed: activation, commands, SecretStorage connection, real server/fake-agent start, run refresh, token deletion.');
  } finally {
    proxy?.close();
    if (server?.exitCode === null) { server.kill('SIGTERM'); await new Promise((accept) => { const timer = setTimeout(() => { server.kill('SIGKILL'); accept(); }, 5000); server.once('exit', () => { clearTimeout(timer); accept(); }); }); }
    await rm(directory, { recursive: true, force: true });
  }
};
