// Publish the already-tested GitHub release artifact using npm trusted publishing.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const packageName = "@midhunxavier/code-flow";
const repository = "midhunxavier/code-flow";
const registry = "https://registry.npmjs.org";
const channels = ["preview", "latest"];
const exec = promisify(execFile);
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.(0|[1-9]\d*))?$/;

function versionParts(version) {
  const match = versionPattern.exec(version);
  assert.ok(match && match[0] === version, `Unsupported release version: ${version}`);
  return match.slice(1).map((part) => part === undefined ? null : BigInt(part));
}

export function compareVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  for (let i = 0; i < 4; i++) {
    if (left[i] === right[i]) continue;
    if (left[i] === null) return 1; // Stable follows previews of the same version.
    if (right[i] === null) return -1;
    return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

export function releaseArtifact(release, tag) {
  assert.ok(tag?.startsWith("v"), "A v-prefixed release tag is required.");
  const version = tag.slice(1);
  versionParts(version);
  assert.equal(release.tagName, tag, "The GitHub release tag does not match.");
  assert.equal(release.isDraft, false, "Publish the GitHub release before publishing npm.");
  const filename = `midhunxavier-code-flow-${version}.tgz`;
  for (const name of [filename, `${filename}.sha256`]) {
    assert.equal(release.assets.filter((asset) => asset.name === name).length, 1, `Missing or ambiguous release asset: ${name}`);
  }
  return { version, filename };
}

export function verifyArtifact({ bytes, checksum, manifest, version, filename, digest }) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(checksum.trim(), `${sha256}  ${filename}`, "Release tarball checksum does not match.");
  if (digest) assert.equal(digest, `sha256:${sha256}`, "GitHub's asset digest does not match.");
  assert.equal(manifest.name, packageName, "Unexpected npm package name.");
  assert.equal(manifest.version, version, "Package version does not match the release tag.");
  assert.ok(!manifest.private, "The release package must be publishable.");
  assert.ok(!manifest.scripts, "The release package must not run lifecycle scripts.");
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

export function verifyRegistryVersion(metadata, version, integrity) {
  assert.equal(metadata.name, packageName);
  assert.equal(metadata.version, version);
  assert.equal(metadata.dist?.integrity, integrity, "npm already contains different bytes for this version. Refusing to change tags.");
}

async function registryJSON(path) {
  const response = await fetch(`${registry}/${path}?verify=${Date.now()}`, {
    headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`npm registry returned ${response.status} for ${path}`);
  return response.json();
}

export async function waitUntil(check, description, { attempts = 41, pause = () => new Promise((done) => setTimeout(done, 30_000)), log = console.log } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await check();
    if (result) return result;
    if (attempt + 1 < attempts) {
      log(`Waiting for ${description} (${attempt + 1}/${attempts}).`);
      await pause();
    }
  }
  throw new Error(`Timed out waiting for ${description}. Rerun this workflow after npm processing completes.`);
}

// Dependencies are injected so retry, conflict and tag-ordering behavior is tested without publishing.
export async function publishPackage({ version, integrity, tarball }, { readPackage, readVersion, runNpm, wait = waitUntil, downloadReady, log = console.log }) {
  const tags = (await readPackage())?.["dist-tags"] ?? {};
  if (channels.some((tag) => tags[tag] && compareVersions(tags[tag], version) > 0)) {
    log(`Skipping ${version}: a channel already points to a newer version.`);
    return false;
  }
  let existing = await readVersion();
  if (existing) verifyRegistryVersion(existing, version, integrity);
  else {
    try {
      // Provenance must describe a build; this job only republishes a prebuilt artifact.
      await runNpm(["publish", tarball, "--tag", "preview", "--access", "public", "--ignore-scripts", "--provenance=false"]);
    } catch (error) {
      // An interrupted run may have uploaded successfully while npm is still scanning it.
      if (!/\b(?:EPUBLISHCONFLICT|E409)\b/.test(error.stderr ?? "")) throw error;
      log("This version was already submitted; waiting to verify its bytes before proceeding.");
    }
    existing = await wait(readVersion, `${packageName}@${version} to pass npm processing`);
    verifyRegistryVersion(existing, version, integrity);
  }
  await wait(() => downloadReady(existing), "the verified npm tarball to become downloadable", { attempts: 11 });
  // Check again after scanning in case another publisher moved a channel meanwhile.
  const current = (await readPackage())?.["dist-tags"] ?? {};
  if (channels.some((tag) => current[tag] && compareVersions(current[tag], version) > 0)) {
    log(`Published ${version}, but leaving channels on a newer release.`);
    return false;
  }
  // Reassert even unchanged tags: a manual retry also verifies OIDC tag-write permission.
  for (const tag of channels) await runNpm(["dist-tag", "add", `${packageName}@${version}`, tag]);
  await wait(async () => {
    const published = await readPackage();
    return channels.every((tag) => published?.["dist-tags"]?.[tag] === version);
  }, "latest and preview to resolve to the release", { attempts: 11 });
  log(`Verified ${packageName}@${version}: latest and preview both updated.`);
  return true;
}

async function main() {
  const tag = process.env.RELEASE_TAG;
  assert.ok(tag?.startsWith("v"), "Set RELEASE_TAG to a published app release.");
  versionParts(tag.slice(1)); // Validate before passing external input to commands.
  const directory = await mkdtemp(join(tmpdir(), "codeflow-npm-publish-"));
  try {
    const { stdout } = await exec("gh", ["release", "view", tag, "--repo", repository, "--json", "tagName,isDraft,assets"], { timeout: 60_000 });
    const release = JSON.parse(stdout);
    const { filename, version } = releaseArtifact(release, tag);
    await exec("gh", ["release", "download", tag, "--repo", repository, "--dir", directory, "--pattern", filename, "--pattern", `${filename}.sha256`], { timeout: 120_000 });
    const tarball = join(directory, filename);
    const { stdout: manifestJSON } = await exec("tar", ["-xOzf", tarball, "package/package.json"], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const integrity = verifyArtifact({
      bytes: await readFile(tarball), checksum: await readFile(`${tarball}.sha256`, "utf8"),
      manifest: JSON.parse(manifestJSON), version, filename,
      digest: release.assets.find((asset) => asset.name === filename).digest,
    });
    const verify = await publishPackage({ version, integrity, tarball }, {
      readPackage: () => registryJSON(encodeURIComponent(packageName)),
      readVersion: () => registryJSON(`${encodeURIComponent(packageName)}/${version}`),
      runNpm: async (args) => {
        const result = await exec("npm", [...args, "--registry", registry, "--loglevel=warn"], { cwd: directory, timeout: 180_000 });
        if (result.stdout) console.log(result.stdout.trim());
      },
      downloadReady: async (metadata) => {
        const url = new URL(metadata.dist.tarball);
        assert.equal(url.origin, registry, "Unexpected tarball registry.");
        const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (response.status === 404) return false;
        if (!response.ok) throw new Error(`npm tarball returned ${response.status}`);
        const actual = `sha512-${createHash("sha512").update(Buffer.from(await response.arrayBuffer())).digest("base64")}`;
        assert.equal(actual, integrity, "Downloaded npm tarball differs from the release.");
        return true;
      },
    });
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\nverify=${verify}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
      verify ? `Published and verified **${packageName}@${version}**. Both \`latest\` and \`preview\` point to this release.\n`
        : `Skipped channel changes for **${version}** because a newer version is already tagged.\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.stderr || error.message); process.exitCode = 1; });
}
