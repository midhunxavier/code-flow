import { packager } from '@electron/packager';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { prepareWslDesktop } from './prepare-desktop-wsl.mjs';

const arch = process.argv[2] ?? 'x64';
if (!['x64', 'arm64'].includes(arch)) throw new Error('Choose x64 or arm64.');
const { root, desktop, pkg } = await prepareWslDesktop(arch);
// ICO supports an embedded PNG; use the shared brand mark without platform-specific tooling.
const png = await readFile(join(desktop, 'icon.png')), header = Buffer.alloc(22);
header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4); header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
const icon = join(root, 'dist/windows.ico'); await writeFile(icon, Buffer.concat([header, png]));
const built = await packager({ dir: desktop, out: join(root, 'output/windows/electron'), name: 'Code Flow', executableName: 'Code Flow',
  appVersion: pkg.version, platform: 'win32', arch, icon, electronVersion: pkg.devDependencies.electron, overwrite: true, asar: false, prune: false,
  win32metadata: { CompanyName: 'Code Flow contributors', FileDescription: 'Code Flow', ProductName: 'Code Flow' } });
const staging = join(root, 'output/windows', arch);
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await cp(built[0], join(staging, 'Code Flow'), { recursive: true });
await writeFile(join(staging, 'Code Flow', 'Read me.txt'), `Code Flow ${pkg.version} — Windows WSL2 preview\n\nExtract the entire ZIP and open Code Flow.exe. An initialized WSL2 distribution such as Ubuntu is required. To install it, run wsl --install in PowerShell, restart if prompted, and complete Linux user setup. Docker Desktop is not required.\n\nNode.js and npm are bundled. Install Git and your coding agent CLIs inside WSL and sign in there. Code Flow reuses those WSL logins. Use Code Flow > Set up agents to copy a WSL terminal command with the bundled Node runtime available. Repositories appear with Linux paths in the app; keep them in your WSL home for best performance.\n\nClosing the window keeps agents running; use Code Flow > Quit to save progress and stop this app's backend. Settings and history persist inside WSL under ~/.codeflow-desktop. Other WSL programs stay running.\n\nThis is an unsigned portable preview. Windows may show an unknown-publisher prompt. Real WSL2 desktop startup and provider authentication still require manual Windows acceptance testing.\n\nHelp: https://midhunxavier.github.io/code-flow/\n`);
const releases = join(root, 'output/releases');
await mkdir(releases, { recursive: true });
const filename = `code-flow-${pkg.version}-windows-${arch}-unsigned.zip`, archive = join(releases, filename);
await rm(archive, { force: true });
if (process.platform === 'win32') {
  // Paths travel through environment variables, never through PowerShell source interpolation.
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Compress-Archive -LiteralPath $env:CODEFLOW_ZIP_SOURCE -DestinationPath $env:CODEFLOW_ZIP_TARGET -CompressionLevel Optimal'],
    { env: { ...process.env, CODEFLOW_ZIP_SOURCE: join(staging, 'Code Flow'), CODEFLOW_ZIP_TARGET: archive }, stdio: 'inherit' });
} else execFileSync('zip', ['-q', '-r', archive, 'Code Flow'], { cwd: staging, stdio: 'inherit' });
const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(`${archive}.sha256`, `${sha256}  ${filename}\n`);
console.log(`Built ${archive} (unsigned portable WSL2 preview)`);
