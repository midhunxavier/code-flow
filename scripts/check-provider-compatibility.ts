import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const execute = promisify(execFile), [provider, requestedVersion, output = "output/provider-compatibility.json"] = process.argv.slice(2);
async function readBoundedResponse(response: Response, maximum: number) {
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) { size += chunk.byteLength; if (size > maximum) throw new Error("Official download exceeds its response bound"); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
if (!["claude", "codex", "agy"].includes(provider ?? "") || !/^(?:\d+\.\d+\.\d+|current)$/.test(requestedVersion ?? "") || provider !== "agy" && requestedVersion === "current" || provider === "agy" && requestedVersion !== "current") throw new Error("Usage: check-provider-compatibility.ts claude|codex VERSION [report.json], or agy current [report.json]");
const directory = await mkdtemp(join(tmpdir(), "cf-provider-contract-"));
try {
  const isolatedHome = join(directory, "home"); await mkdir(isolatedHome);
  // No account secrets or the user's provider configuration enter these probes.
  const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: isolatedHome, USERPROFILE: isolatedHome, TMPDIR: directory, LANG: "C.UTF-8", CI: "1", AGY_CLI_DISABLE_AUTO_UPDATE: "true", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  let binaryDirectory: string;
  if (provider !== "agy") {
    const name = provider === "claude" ? "@anthropic-ai/claude-code" : "@openai/codex";
    const userConfig = join(directory, "npm-user.ini"), globalConfig = join(directory, "npm-global.ini");
    await writeFile(userConfig, "", { mode: 0o600 }); await writeFile(globalConfig, "", { mode: 0o600 });
    // The official Claude package's installer selects its native executable. No project package is installed.
    await execute("npm", ["install", "--prefix", directory, "--no-audit", "--no-fund", "--save-exact", "--registry=https://registry.npmjs.org", `--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`, `${name}@${requestedVersion}`], { cwd: directory, env: environment, timeout: 180_000, maxBuffer: 2 * 1024 * 1024 });
    binaryDirectory = join(directory, "node_modules", ".bin");
  } else {
    if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) throw new Error("The continuous agy probe targets official Linux x64/arm64 builds");
    const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
    const platform = `linux_${process.arch === "x64" ? "amd64" : "arm64"}${report.header?.glibcVersionRuntime ? "" : "_musl"}`;
    const manifestUrl = `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${platform}.json`;
    const manifestResponse = await fetch(manifestUrl, { redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (!manifestResponse.ok) throw new Error(`Official agy manifest HTTP ${manifestResponse.status}`);
    const raw = (await readBoundedResponse(manifestResponse, 64 * 1024)).toString("utf8");
    const manifest = JSON.parse(raw), url = new URL(manifest.url);
    if (url.protocol !== "https:" || url.username || url.password || typeof manifest.sha512 !== "string" || !/^(?:[a-fA-F0-9]{128}|[A-Za-z0-9+/]{86}==)$/.test(manifest.sha512)) throw new Error("Invalid official agy download manifest");
    const payload = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(120_000) }); if (!payload.ok) throw new Error(`Official agy download HTTP ${payload.status}`);
    const data = await readBoundedResponse(payload, 256 * 1024 * 1024), checksum = createHash("sha512").update(data).digest(/^[a-fA-F0-9]{128}$/.test(manifest.sha512) ? "hex" : "base64"); if (checksum !== manifest.sha512) throw new Error("Official agy checksum does not match");
    binaryDirectory = join(directory, "bin"); await mkdir(binaryDirectory);
    if (url.pathname.endsWith(".tar.gz")) {
      const archive = join(directory, "agy.tar.gz"); await writeFile(archive, data);
      const listed = await execute("tar", ["-tvzf", archive, "antigravity"], { env: environment, timeout: 20_000, maxBuffer: 1024 * 1024 });
      if (!listed.stdout.startsWith("-") || listed.stdout.trim().split("\n").length !== 1) throw new Error("Official agy executable must be one regular archive entry");
      await execute("tar", ["-xzf", archive, "-C", binaryDirectory, "antigravity"], { env: environment, timeout: 20_000, maxBuffer: 1024 * 1024 });
      await rename(join(binaryDirectory, "antigravity"), join(binaryDirectory, "agy"));
    } else await writeFile(join(binaryDirectory, "agy"), data);
    await chmod(join(binaryDirectory, "agy"), 0o700);
  }
  const binary = join(binaryDirectory, provider!);
  if (!(await stat(binary)).isFile()) throw new Error("The official package did not install its expected executable");
  await access(binary, constants.X_OK);
  // Runtime dependencies may use PATH; the provider itself is always the installed absolute executable.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, environment, { PATH: `${binaryDirectory}:${environment.PATH}`, CODEFLOW_HOME: join(directory, "state") });
  const { probeProviderContract, providerVersionMatches } = await import("../src/doctor.js");
  const report = { schema: 1, requested: requestedVersion, checkedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch, node: process.version, ...(await probeProviderContract(provider as "claude" | "codex" | "agy", binary)) };
  const target = resolve(output); await mkdir(resolve(target, ".."), { recursive: true }); await writeFile(target, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report) + "\n");
  if (!report.installed || report.compatible !== true || requestedVersion !== "current" && !providerVersionMatches(report.version, requestedVersion!)) process.exitCode = 1;
} catch (error) {
  const { redactText } = await import("../src/privacy.js");
  const report = { schema: 1, requested: requestedVersion, checkedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch, node: process.version, id: provider, installed: false, compatible: null, missing: [], warnings: [], scope: "version-and-help-only", error: redactText((error as Error).message.slice(0, 1500)) };
  const target = resolve(output); await mkdir(resolve(target, ".."), { recursive: true }); await writeFile(target, JSON.stringify(report, null, 2) + "\n");
  process.stderr.write(JSON.stringify(report) + "\n"); process.exitCode = 1;
} finally { await rm(directory, { recursive: true, force: true }); }
