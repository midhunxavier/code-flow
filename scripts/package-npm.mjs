// Build a portable, dependency-free runtime. Preserve module locations so workers,
// SSH helpers and other import.meta.url resources resolve exactly as in source.
import "./check-node.mjs";
import { build } from "esbuild";
import { cp, mkdir, readFile, readdir, rm, writeFile, chmod } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = resolve(root, "dist/npm");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root, stdio: "inherit" });
execFileSync(process.execPath, ["scripts/build-host.mjs"], { cwd: root, stdio: "inherit" });
async function sources(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sources(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
    else if (/\.(?:mjs|js)$/.test(entry.name)) await cp(path, path.replace(join(root, "src"), join(output, "src")));
  }
  return files;
}
await build({ entryPoints: await sources(join(root, "src")), outbase: join(root, "src"), outdir: join(output, "src"), platform: "node", format: "esm", target: "node22.13", logLevel: "warning" });
const banner = { js: 'import { createRequire as __createRequire } from "node:module"; import { fileURLToPath as __fileURLToPath } from "node:url"; import { dirname as __dirnameOf } from "node:path"; const __filename = __fileURLToPath(import.meta.url); const __dirname = __dirnameOf(__filename); const require = __createRequire(import.meta.url);' };
for (const [source, target] of [["src/architecture.ts", "src/architecture.js"], ["src/code-intelligence-worker.mjs", "src/code-intelligence-worker.mjs"]])
  await build({ entryPoints: [join(root, source)], outfile: join(output, target), bundle: true,
    plugins: [{ name: "preserve-local-modules", setup(builder) {
      builder.onResolve({ filter: /^\.\.?\// }, (args) => args.importer.startsWith(join(root, "src") + "/") ? { path: args.path, external: true } : undefined);
    } }],
    platform: "node", format: "esm", target: "node22.13", minify: true, banner, logLevel: "warning" });
for (const path of ["bin", "public", "LICENSE", "README.md", "scripts/check-node.mjs", "scripts/codeflow.mjs", "scripts/pty.py", "scripts/computer-use.swift", "dist/remote-host.json"])
  await cp(join(root, path), join(output, path), { recursive: true });
await mkdir(join(output, "licenses"), { recursive: true });
for (const [name, source] of [["typescript.txt", "node_modules/typescript/LICENSE.txt"], ["typescript-notices.txt", "node_modules/typescript/ThirdPartyNoticeText.txt"], ["inter.txt", "ui/fonts/OFL-1.1.txt"], ["preact.txt", "node_modules/preact/LICENSE"], ["signals.txt", "node_modules/@preact/signals/LICENSE"], ["signals-core.txt", "node_modules/@preact/signals-core/LICENSE"], ["xterm.txt", "node_modules/@xterm/xterm/LICENSE"], ["xterm-fit.txt", "node_modules/@xterm/addon-fit/LICENSE"], ["uqr.txt", "node_modules/uqr/LICENSE"]])
  await cp(join(root, source), join(output, "licenses", name));
await writeFile(join(output, "package.json"), JSON.stringify({
  name: pkg.name, version: pkg.version, description: pkg.description, license: pkg.license,
  type: "module", bin: { codeflow: "bin/codeflow.mjs", "code-flow": "bin/codeflow.mjs" },
  engines: pkg.engines, os: ["darwin", "linux"],
  repository: { type: "git", url: "git+https://github.com/midhunxavier/code-flow.git" },
  homepage: "https://midhunxavier.github.io/code-flow/", bugs: "https://github.com/midhunxavier/code-flow/issues",
  publishConfig: { access: "public", tag: "preview" },
  files: ["bin/", "src/", "scripts/", "public/", "dist/remote-host.json", "licenses/"],
}, null, 2) + "\n");
await chmod(join(output, "bin/codeflow.mjs"), 0o755);
console.log(`Built ${pkg.name}@${pkg.version} in dist/npm. Run npm pack ./dist/npm to create the release tarball.`);
