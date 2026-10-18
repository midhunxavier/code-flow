import "./check-node.mjs";
import { build } from "esbuild";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Keep source-relative helper paths intact; the host needs no npm install or source checkout.
const root = fileURLToPath(new URL("..", import.meta.url));
export async function buildHost() {
  const result = await build({ absWorkingDir: root, entryPoints: ["src/server.ts"], bundle: true, platform: "node", format: "esm", target: "node20", minify: true, write: false, logLevel: "warning",
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; import { fileURLToPath as __fileURLToPath } from "node:url"; import { dirname as __dirnameOf } from "node:path"; const __filename = __fileURLToPath(import.meta.url); const __dirname = __dirnameOf(__filename); const require = __createRequire(import.meta.url);' } });
  const files = { "src/server.mjs": result.outputFiles[0].text };
  for (const path of ["public/index.html", "package.json", "src/preview-overlay.js", "src/team-tool-client.mjs", "scripts/pty.py"]) files[path] = await readFile(resolve(root, path), "utf8");
  const worker = await build({ absWorkingDir: root, entryPoints: ["src/code-intelligence-worker.mjs"], bundle: true, platform: "node", format: "esm", target: "node20", minify: true, write: false,
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; import { fileURLToPath as __fileURLToPath } from "node:url"; import { dirname as __dirnameOf } from "node:path"; const __filename = __fileURLToPath(import.meta.url); const __dirname = __dirnameOf(__filename); const require = __createRequire(import.meta.url);' } });
  files["src/code-intelligence-worker.mjs"] = worker.outputFiles[0].text;
  // esbuild moves adapters/team-tools.ts into src/server.mjs.
  files["team-tool-client.mjs"] = files["src/team-tool-client.mjs"];
  const version = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  await mkdir(resolve(root, "dist"), { recursive: true });
  const temporary = resolve(root, `dist/remote-host.${randomBytes(8).toString("hex")}.tmp`);
  await writeFile(temporary, JSON.stringify({ protocol: 1, version, files }));
  await rename(temporary, resolve(root, "dist/remote-host.json"));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildHost();
