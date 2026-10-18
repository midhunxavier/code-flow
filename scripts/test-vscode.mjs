import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// macOS limits Unix socket paths to 103 bytes; its default temp directory is too long.
const directory = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'cf-vsc-'));
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  const macBinary = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
  const code = process.env.CODEFLOW_VSCODE_BIN || (process.platform === 'darwin' && existsSync(macBinary) ? macBinary : 'code');
  const receipt = join(directory, 'passed.json');
  execFileSync('python3', [join(root, 'scripts/package-vscode.py')], { cwd: root, stdio: 'inherit' });
  const manifest = JSON.parse(await readFile(join(root, 'integrations/vscode/package.json'), 'utf8'));
  const cliCandidate = process.platform === 'darwin' && code === macBinary ? '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code' : join(dirname(code), 'bin/code');
  const cli = existsSync(cliCandidate) ? cliCandidate : code;
  execFileSync(cli, ['--user-data-dir', join(directory, 'profile'), '--extensions-dir', join(directory, 'extensions'), '--install-extension', join(root, 'output/vscode', `code-flow-${manifest.version}.vsix`), '--force'], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VSCODE_IPC_HOOK_CLI: undefined } });
  const installed = (await readdir(join(directory, 'extensions'))).find((name) => name.startsWith(`${manifest.publisher}.${manifest.name}-`));
  if (!installed) throw new Error('The packaged VSIX was not installed in the isolated extension directory');
  const result = await new Promise((accept, reject) => {
    const child = spawn(code, ['--wait', '--user-data-dir', join(directory, 'profile'), '--extensions-dir', join(directory, 'extensions'), '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-updates', '--disable-workspace-trust', `--extensionDevelopmentPath=${join(directory, 'extensions', installed)}`, `--extensionTestsPath=${join(root, 'integrations/vscode/test/extension-host.cjs')}`], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, VSCODE_IPC_HOOK_CLI: undefined, CODEFLOW_HOST_TEST_NODE: process.execPath, CODEFLOW_HOST_TEST_RECEIPT: receipt } });
    const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
    child.once('error', reject); child.once('exit', (code) => { clearTimeout(timer); accept(code); });
  });
  if (result !== 0) throw new Error(`VS Code extension host tests failed (${result})`);
  const passed = JSON.parse(await readFile(receipt, 'utf8'));
  if (passed.passed !== true) throw new Error('VS Code exited without a successful extension host test receipt');
  console.log('VS Code host acceptance receipt verified.');
} finally { await rm(directory, { recursive: true, force: true }); }
