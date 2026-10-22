import "./check-node.mjs";
import { packager } from "@electron/packager";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

if (process.platform !== "darwin") throw new Error("Build the DMG on macOS with Xcode Command Line Tools installed.");
const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const arch = process.argv[2] ?? process.arch;
if (!["arm64", "x64"].includes(arch)) throw new Error("Choose arm64 or x64.");
const identity = process.env.CODEFLOW_SIGN_IDENTITY;
const notary = process.env.CODEFLOW_NOTARY_PROFILE;
if (notary && !identity) throw new Error("Notarization requires CODEFLOW_SIGN_IDENTITY.");
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit" });
// Pin the runtime and independently pin each official release checksum.
const nodeVersion = "22.23.4";
const nodeHash = { arm64: "c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428", x64: "efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819" };
const cache = join(root, "output/macos/cache");
await mkdir(cache, { recursive: true });
const archive = join(cache, `node-v${nodeVersion}-darwin-${arch}.tar.gz`);
let bytes = await readFile(archive).catch(() => undefined);
if (!bytes || createHash("sha256").update(bytes).digest("hex") !== nodeHash[arch]) {
  const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-darwin-${arch}.tar.gz`, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Node download failed: HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== nodeHash[arch]) throw new Error("Node runtime checksum mismatch.");
  await writeFile(archive, bytes);
}
// Reuse the exact npm runtime; no npm install or network fetch happens on users' machines.
run(process.execPath, ["scripts/package-npm.mjs"]);
const staging = join(root, "output/macos", arch);
await rm(staging, { recursive: true, force: true });
const desktop = join(root, "dist/desktop");
await rm(desktop, { recursive: true, force: true });
await mkdir(join(desktop, "node"), { recursive: true });
run("tar", ["-xzf", archive, "--strip-components=1", "-C", join(desktop, "node"), `node-v${nodeVersion}-darwin-${arch}/bin/node`, `node-v${nodeVersion}-darwin-${arch}/LICENSE`]);
await cp(join(root, "dist/npm"), join(desktop, "backend"), { recursive: true });
await cp(join(root, "integrations/desktop/main.cjs"), join(desktop, "main.cjs"));
await writeFile(join(desktop, "package.json"), JSON.stringify({ name: "code-flow-desktop", productName: "Code Flow", version: pkg.version, description: pkg.description, main: "main.cjs", author: "Code Flow contributors", license: "MIT" }, null, 2));
const computerHelper = join(desktop, "backend/scripts/computer-use");
run("xcrun", ["swiftc", "-O", "-swift-version", "5", "-target", `${arch === "x64" ? "x86_64" : arch}-apple-macosx13.0`, "scripts/computer-use.swift", "-o", computerHelper]);
const sign = identity ?? "-";
run("codesign", ["--force", "--sign", sign, ...(identity ? ["--timestamp", "--options", "runtime"] : []), computerHelper]);
run("codesign", ["--force", "--sign", sign, ...(identity ? ["--timestamp", "--options", "runtime", "--entitlements", "integrations/macos/node-entitlements.plist"] : []), join(desktop, "node/bin/node")]);
const iconset = join(cache, "CodeFlow.iconset"), icon = join(cache, "CodeFlow.icns");
run("xcrun", ["swift", "integrations/desktop/icon.swift", iconset]);
run("iconutil", ["-c", "icns", iconset, "-o", icon]);
const built = await packager({ dir: desktop, out: join(root, "output/macos/electron"), name: "Code Flow", executableName: "Code Flow", appBundleId: "io.github.midhunxavier.code-flow", appVersion: pkg.version,
  platform: "darwin", arch, icon, electronVersion: pkg.devDependencies.electron, overwrite: true, asar: false, prune: false,
  extendInfo: { LSMinimumSystemVersion: "13.0", NSHighResolutionCapable: true, NSScreenCaptureUsageDescription: "Code Flow uses screen capture for computer tools you ask agents to use.", NSAppleEventsUsageDescription: "Code Flow uses desktop automation when you authorize computer tools." },
  ...(identity ? { osxSign: { identity, optionsForFile: () => ({ hardenedRuntime: true, entitlements: join(root, "integrations/macos/node-entitlements.plist") }) } } : {}),
});
await mkdir(staging, { recursive: true });
await cp(join(built[0], "Code Flow.app"), join(staging, "Code Flow.app"), { recursive: true, verbatimSymlinks: true });
if (!identity) run("codesign", ["--force", "--deep", "--sign", "-", join(staging, "Code Flow.app")]);
run("codesign", ["--verify", "--deep", "--strict", join(staging, "Code Flow.app")]);
await symlink("/Applications", join(staging, "Applications"));
await writeFile(join(staging, "Read me.txt"), `Code Flow ${pkg.version}\n\nDrag Code Flow to Applications, then open it. Code Flow opens in its own desktop window. Closing the window keeps agents running; use Code Flow → Quit to stop the app.\nGit 2.38+, a signed-in coding CLI and Chrome or Edge (for the shared browser) are required. Node is included.\n\n${notary ? "Notarized macOS preview." : "This developer preview is not notarized. macOS may block it; use the npm preview for ordinary installation."}\nSettings and history: ~/.codeflow\nHelp: https://midhunxavier.github.io/code-flow/\n`);
const releases = join(root, "output/releases");
await mkdir(releases, { recursive: true });
const dmg = join(releases, `code-flow-${pkg.version}-macos-${arch}${notary ? "" : "-unnotarized"}.dmg`);
await rm(dmg, { force: true });
run("hdiutil", ["create", "-volname", "Code Flow Preview", "-srcfolder", staging, "-ov", "-format", "UDZO", dmg]);
if (identity) run("codesign", ["--force", "--sign", identity, "--timestamp", dmg]);
if (notary) {
  run("xcrun", ["notarytool", "submit", dmg, "--keychain-profile", notary, "--wait"]);
  run("xcrun", ["stapler", "staple", dmg]);
  run("xcrun", ["stapler", "validate", dmg]);
  run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose", dmg]);
}
const hash = createHash("sha256").update(await readFile(dmg)).digest("hex");
await writeFile(`${dmg}.sha256`, `${hash}  ${dmg.split("/").at(-1)}\n`);
console.log(`Built ${dmg}${notary ? " (notarized)" : " (unnotarized developer preview)"}`);
