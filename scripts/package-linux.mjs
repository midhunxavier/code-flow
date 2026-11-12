import './check-node.mjs';
import { chmod, cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { packager } from '@electron/packager';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

if (process.platform !== 'linux') throw new Error('Build the Linux packages on Linux with squashfs-tools (mksquashfs) and dpkg-deb installed.');
const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const arch = process.argv[2] ?? process.arch;
if (!['x64', 'arm64'].includes(arch)) throw new Error('Choose x64 or arm64.');
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
for (const tool of ['mksquashfs', 'dpkg-deb', 'tar']) {
  try { execFileSync('sh', ['-c', `command -v ${tool}`], { stdio: 'ignore' }); }
  catch { throw new Error(`${tool} is required. On Debian or Ubuntu: sudo apt-get install squashfs-tools dpkg tar`); }
}

// Pin every download and independently pin each official release checksum.
const nodeVersion = '22.23.4';
const nodeHash = { x64: 'b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406', arm64: 'f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9' };
// Static AppImage type 2 runtime (no libfuse2 needed); release 20251108 of AppImage/type2-runtime.
const runtimeRelease = '20251108';
const runtimeHash = { x64: '2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d', arm64: '00cbdfcf917cc6c0ff6d3347d59e0ca1f7f45a6df1a428a0d6d8a78664d87444' };
const runtimeArch = { x64: 'x86_64', arm64: 'aarch64' }[arch];
const debArch = { x64: 'amd64', arm64: 'arm64' }[arch];
const cache = join(root, 'output/linux/cache');
await mkdir(cache, { recursive: true });
async function pinned(url, file, sha256) {
  const path = join(cache, file);
  let bytes = await readFile(path).catch(() => undefined);
  if (bytes && createHash('sha256').update(bytes).digest('hex') === sha256) return bytes;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  } catch {
    // curl also honors HTTPS_PROXY on build hosts where Node fetch cannot reach the internet directly.
    run('curl', ['--fail', '--silent', '--show-error', '--location', '--retry', '2', '--connect-timeout', '15', '--max-time', '120', '--output', path, url]);
    bytes = await readFile(path);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error(`Checksum mismatch for ${url}`);
  await writeFile(path, bytes);
  return bytes;
}
const nodeName = `node-v${nodeVersion}-linux-${arch}`;
await pinned(`https://nodejs.org/dist/v${nodeVersion}/${nodeName}.tar.gz`, `${nodeName}.tar.gz`, nodeHash[arch]);
const runtime = await pinned(`https://github.com/AppImage/type2-runtime/releases/download/${runtimeRelease}/runtime-${runtimeArch}`, `appimage-runtime-${runtimeRelease}-${runtimeArch}`, runtimeHash[arch]);

// Reuse the exact npm runtime; no npm install or network fetch happens on users' machines.
run(process.execPath, ['scripts/package-npm.mjs']);
const desktop = join(root, 'dist/linux-desktop');
await rm(desktop, { recursive: true, force: true });
await mkdir(join(desktop, 'node'), { recursive: true });
run('tar', ['-xzf', join(cache, `${nodeName}.tar.gz`), '--strip-components=1', '-C', join(desktop, 'node'), `${nodeName}/bin/node`, `${nodeName}/LICENSE`]);
await cp(join(root, 'dist/npm'), join(desktop, 'backend'), { recursive: true });
for (const file of ['main.cjs', 'preload.cjs', 'updates.cjs', 'icon.png']) await cp(join(root, 'integrations/desktop', file), join(desktop, file));
await writeFile(join(desktop, 'update-config.json'), JSON.stringify({ nativeUpdates: false }));
await writeFile(join(desktop, 'package.json'), JSON.stringify({ name: 'code-flow-desktop', productName: 'Code Flow', desktopName: 'code-flow.desktop', version: pkg.version, description: pkg.description, main: 'main.cjs', author: 'Code Flow contributors', license: 'MIT' }, null, 2));
const built = await packager({ dir: desktop, out: join(root, 'output/linux/electron'), name: 'Code Flow', executableName: 'code-flow', appVersion: pkg.version,
  platform: 'linux', arch, electronVersion: pkg.devDependencies.electron, overwrite: true, asar: false, prune: false });
// The packager stages through a private temporary directory; installed files must be readable by every user.
const install = async target => { await cp(built[0], target, { recursive: true, verbatimSymlinks: true }); run('chmod', ['-R', 'u+rwX,go+rX,go-w', target]); };

const staging = join(root, 'output/linux', arch);
await rm(staging, { recursive: true, force: true });
const desktopEntry = exec => `[Desktop Entry]\nType=Application\nName=Code Flow\nComment=Run your coding agent CLIs as a team\nExec=${exec}\nIcon=code-flow\nTerminal=false\nCategories=Development;\nStartupWMClass=Code Flow\n`;
const readme = format => `Code Flow ${pkg.version} — Linux ${format} preview\n\nCode Flow opens in its own desktop window. Closing the window keeps agents running; open Code Flow again to show it, and use Code Flow > Quit to stop the app.\nGit 2.38+, a signed-in coding CLI and Chrome, Chromium or Edge (for the shared browser) are required. Node is included.\n\nThis preview is unsigned.\nSettings and history: ~/.codeflow\nHelp: https://midhunxavier.github.io/code-flow/\n`;

// AppImage: an AppDir squashed and appended to the pinned runtime.
const appDir = join(staging, 'AppDir');
await mkdir(join(appDir, 'usr/lib'), { recursive: true });
await install(join(appDir, 'usr/lib/code-flow'));
await writeFile(join(appDir, 'usr/lib/code-flow/Read me.txt'), readme('AppImage'));
// Chromium's sandbox needs unprivileged user namespaces when its helper cannot be setuid (AppImages
// mount nosuid). Distributions such as Ubuntu 24.04 restrict them; only then fall back to --no-sandbox.
await writeFile(join(appDir, 'AppRun'), `#!/bin/sh
here="$(dirname "$(readlink -f "$0")")"
app="$here/usr/lib/code-flow/code-flow"
if command -v unshare >/dev/null 2>&1 && ! unshare --user --map-root-user true >/dev/null 2>&1; then
  echo "Code Flow: unprivileged user namespaces are unavailable; starting without the Chromium sandbox. Install the .deb package to keep it." >&2
  exec "$app" --no-sandbox "$@"
fi
exec "$app" "$@"
`, { mode: 0o755 });
await writeFile(join(appDir, 'code-flow.desktop'), desktopEntry('code-flow %U'));
await cp(join(root, 'integrations/desktop/icon.png'), join(appDir, 'code-flow.png'));
await symlink('code-flow.png', join(appDir, '.DirIcon'));
const squashfs = join(staging, 'payload.squashfs');
run('mksquashfs', [appDir, squashfs, '-root-owned', '-noappend', '-comp', 'zstd', '-quiet', '-no-progress']);

// Debian package installed under /opt/code-flow with a setuid Chromium sandbox helper.
const debRoot = join(staging, 'deb');
await mkdir(join(debRoot, 'opt'), { recursive: true });
await install(join(debRoot, 'opt/code-flow'));
await writeFile(join(debRoot, 'opt/code-flow/Read me.txt'), readme('Debian package'));
await mkdir(join(debRoot, 'usr/bin'), { recursive: true });
await symlink('/opt/code-flow/code-flow', join(debRoot, 'usr/bin/code-flow'));
await mkdir(join(debRoot, 'usr/share/applications'), { recursive: true });
await writeFile(join(debRoot, 'usr/share/applications/code-flow.desktop'), desktopEntry('/opt/code-flow/code-flow %U'));
await mkdir(join(debRoot, 'usr/share/icons/hicolor/256x256/apps'), { recursive: true });
await cp(join(root, 'integrations/desktop/icon.png'), join(debRoot, 'usr/share/icons/hicolor/256x256/apps/code-flow.png'));
await mkdir(join(debRoot, 'DEBIAN'), { recursive: true });
const installedSize = execFileSync('du', ['-sk', join(debRoot, 'opt'), join(debRoot, 'usr')], { encoding: 'utf8' }).trim().split('\n').reduce((sum, line) => sum + Number(line.split(/\s/)[0]), 0);
// Debian sorts "~" before the final release, so 0.1.0~preview.14 precedes 0.1.0.
const debVersion = pkg.version.replace('-preview.', '~preview.');
await writeFile(join(debRoot, 'DEBIAN/control'), `Package: code-flow
Version: ${debVersion}
Architecture: ${debArch}
Maintainer: Code Flow contributors <https://github.com/midhunxavier/code-flow/issues>
Installed-Size: ${installedSize}
Depends: libgtk-3-0 | libgtk-3-0t64, libnss3, libnotify4, libxss1, libxtst6, libgbm1, libsecret-1-0, libasound2 | libasound2t64, xdg-utils
Suggests: git
Section: devel
Priority: optional
Homepage: https://midhunxavier.github.io/code-flow/
Description: ${pkg.description.replace(/\.$/, '')}
 Code Flow desktop preview with a bundled Node.js runtime. Install Git and
 your coding agent CLIs separately and sign in to them. Settings and history
 are stored in ~/.codeflow. This package is unsigned.
`);
await writeFile(join(debRoot, 'DEBIAN/postinst'), `#!/bin/sh
set -e
chown root:root /opt/code-flow/chrome-sandbox
chmod 4755 /opt/code-flow/chrome-sandbox
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q /usr/share/applications || true; fi
`);
await writeFile(join(debRoot, 'DEBIAN/postrm'), `#!/bin/sh
set -e
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q /usr/share/applications || true; fi
`);
for (const file of ['postinst', 'postrm']) await chmod(join(debRoot, 'DEBIAN', file), 0o755);

const outputs = join(root, 'output/linux');
const base = `code-flow-${pkg.version}-linux-${arch}-unsigned`;
const appImage = join(outputs, `${base}.AppImage`), deb = join(outputs, `${base}.deb`);
for (const file of [appImage, deb]) for (const path of [file, `${file}.sha256`]) await rm(path, { force: true });
await writeFile(appImage, Buffer.concat([runtime, await readFile(squashfs)]), { mode: 0o755 });
await rm(squashfs);
// xz keeps the package installable on Debian releases whose dpkg predates zstd members.
run('dpkg-deb', ['--root-owner-group', '-Zxz', '--build', debRoot, deb]);
for (const file of [appImage, deb]) {
  const hash = createHash('sha256').update(await readFile(file)).digest('hex');
  await writeFile(`${file}.sha256`, `${hash}  ${file.split('/').at(-1)}\n`);
}
console.log(`Built ${appImage} and ${deb} (unsigned Linux preview)`);
