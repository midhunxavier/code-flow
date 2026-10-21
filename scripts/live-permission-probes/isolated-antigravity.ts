import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, writeFile, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { prepareAgyIsolationFixture } from "./agy-isolation-fixture.js";

// Offline only: no prompt, inference, resume, login, credential copying or model routing.
if (process.platform !== "darwin") throw new Error("This experimental probe requires macOS sandbox-exec");
if (process.argv.length !== 3 || !isAbsolute(process.argv[2]!)) throw new Error("Usage: node --import tsx scripts/live-permission-probes/isolated-antigravity.ts /absolute/path/to/agy");
const binary = await realpath(process.argv[2]!);
if (/[\x00-\x1f\x7f]/.test(binary)) throw new Error("Invalid CLI path");
const fixture = await prepareAgyIsolationFixture();
// Read just the executable, never its surrounding provider profile or host home.
const profile = `${await readFile(fixture.profile, "utf8")}\n(allow file-read* file-map-executable (literal ${JSON.stringify(binary)}))\n`;
await writeFile(join(fixture.root, "cli-offline.sb"), profile, { mode: 0o400 });
const exec = promisify(execFile);
const observations = [];
for (const args of [["--version"], ["models"]]) {
  let code: string | number | null = 0, signal: string | null = null, stdout = "", stderr = "";
  try {
    ({ stdout, stderr } = await exec("/usr/bin/sandbox-exec", ["-f", join(fixture.root, "cli-offline.sb"), binary, ...args], { env: fixture.env, cwd: fixture.workspace, timeout: 20000, maxBuffer: 128 * 1024 }));
  } catch (error) {
    const result = error as { code?: string | number; signal?: string; stdout?: string; stderr?: string };
    code = result.code ?? null; signal = result.signal ?? null; stdout = result.stdout ?? ""; stderr = result.stderr ?? "";
  }
  // Do not print raw provider diagnostics, account data, or authentication URLs.
  const needsSignIn = /please sign in|authentication required|not authenticated/i.test(stdout + stderr);
  observations.push({ command: args.join(" "), code, signal, needsSignIn, ...(args[0] === "--version" && /^[\w. +-]{1,100}\s*$/.test(stdout) ? { version: stdout.trim() } : {}) });
}
console.log(JSON.stringify({ root: fixture.root, observations, network: "denied for entire process tree", managedAuto: "blocked", inferenceCompatibility: "unverified", note: "Offline containment experiment only. No host authentication or global settings are imported. Separate authenticated runtime and tool-denial/recovery tests are still required." }, null, 2));
