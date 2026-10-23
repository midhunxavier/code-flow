import { packager } from '@electron/packager';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { prepareDockerDesktop } from './prepare-desktop-docker.mjs';

const arch = process.argv[2] ?? 'x64';
if (!['x64', 'arm64'].includes(arch)) throw new Error('Choose x64 or arm64.');
const { root, desktop, pkg } = await prepareDockerDesktop();
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
await writeFile(join(staging, 'Code Flow', 'Read me.txt'), `Code Flow ${pkg.version} — Windows Docker preview\n\nExtract the entire ZIP, start Docker Desktop with Linux containers, and open Code Flow.exe. Select a projects folder; it appears as /workspace inside the app. The first launch builds the bundled Linux runtime and requires internet access.\n\nUse Code Flow > Set up agents to copy a Docker terminal command. Claude Code and Codex are included; sign in with their own login commands inside the container, and set your Git name and email there. Settings and logins persist in a named Docker volume. Closing the window keeps agents running; use Code Flow > Quit to stop the container.\n\nThis is an unsigned portable preview. Windows may show an unknown-publisher prompt. Shared-browser and desktop computer tools, nested Docker runs and host-installed CLIs are not included in this runtime.\n\nHelp: https://midhunxavier.github.io/code-flow/\n`);
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
console.log(`Built ${archive} (unsigned portable Docker preview)`);
