import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { compareVersions, packageName, publishPackage, releaseArtifact, verifyArtifact, waitUntil } from "../../scripts/publish-npm-release.mjs";

const version = "0.1.0-preview.3";
const filename = `midhunxavier-code-flow-${version}.tgz`;
const bytes = Buffer.from("tested release tarball");
const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const sha256 = createHash("sha256").update(bytes).digest("hex");
const metadata = { name: packageName, version, dist: { integrity } };
const artifact = { version, integrity, tarball: "/tmp/release.tgz" };

function fixture({ existing = null, tags = {}, lag = 0, failure } = {}) {
  const commands = [], waits = [];
  let available = existing, readyAfter = lag, readyChecks = 0;
  const dependencies = {
    readPackage: async () => ({ "dist-tags": { ...tags } }),
    readVersion: async () => readyAfter-- > 0 ? null : available,
    runNpm: async (args) => {
      commands.push(args);
      if (args[0] === "publish") {
        if (failure) throw failure;
        available = metadata;
      } else tags[args[3]] = version;
    },
    downloadReady: async () => ++readyChecks > 1,
    wait: (check, description) => waitUntil(check, description, { attempts: 5, pause: async () => waits.push(description), log: () => {} }),
    log: () => {},
  };
  return { dependencies, commands, waits, tags };
}

test("only published releases with the exact tarball and checksum are eligible", () => {
  const release = { tagName: `v${version}`, isDraft: false, assets: [{ name: filename }, { name: `${filename}.sha256` }] };
  assert.deepEqual(releaseArtifact(release, release.tagName), { version, filename });
  assert.throws(() => releaseArtifact({ ...release, isDraft: true }, release.tagName), /before publishing/);
  assert.throws(() => releaseArtifact({ ...release, assets: [] }, release.tagName), /Missing/);
  for (const tag of ["main", "v01.1.0", "v1.0.0;bad", "v1.0.0-preview.01", "v1.0.0\n"]) {
    assert.throws(() => releaseArtifact({ ...release, tagName: tag }, tag));
  }
});

test("artifact inspection rejects tampering and wrong package identity before publishing", () => {
  const input = { bytes, checksum: `${sha256}  ${filename}\n`, manifest: { name: packageName, version }, version, filename, digest: `sha256:${sha256}` };
  assert.equal(verifyArtifact(input), integrity);
  assert.throws(() => verifyArtifact({ ...input, bytes: Buffer.from("modified") }), /checksum/);
  assert.throws(() => verifyArtifact({ ...input, digest: "sha256:wrong" }), /digest/);
  assert.throws(() => verifyArtifact({ ...input, manifest: { name: "wrong", version } }), /name/);
  assert.throws(() => verifyArtifact({ ...input, manifest: { name: packageName, version: "0.1.0-preview.2" } }), /version/);
  assert.throws(() => verifyArtifact({ ...input, manifest: { ...input.manifest, scripts: { postinstall: "unexpected" } } }), /scripts/);
});

test("publishes once, waits for scanning and downloads, then advances both tags", async () => {
  const f = fixture({ tags: { latest: "0.1.0-preview.1", preview: "0.1.0-preview.1" }, lag: 3 });
  assert.equal(await publishPackage(artifact, f.dependencies), true);
  assert.equal(f.commands.filter((args) => args[0] === "publish").length, 1);
  assert.deepEqual(f.tags, { latest: version, preview: version });
  assert.ok(f.waits.length >= 3, "both metadata and tarball availability are awaited");
});

test("retrying an identical published version repairs tags without republishing", async () => {
  const f = fixture({ existing: metadata, tags: { preview: version, latest: "0.1.0-preview.1" } });
  assert.equal(await publishPackage(artifact, f.dependencies), true);
  assert.deepEqual(f.commands.map((args) => args.slice(0, 2)), [["dist-tag", "add"], ["dist-tag", "add"]]);
  assert.deepEqual(f.tags, { preview: version, latest: version });
});

test("refuses to bless a previously published version with different contents", async () => {
  const f = fixture({ existing: { ...metadata, dist: { integrity: "wrong" } } });
  await assert.rejects(publishPackage(artifact, f.dependencies), /different bytes/);
  assert.equal(f.commands.length, 0);
});

test("older releases and an intervening newer publication cannot move channels backward", async () => {
  const f = fixture({ tags: { latest: "0.1.0-preview.10", preview: version } });
  assert.equal(await publishPackage(artifact, f.dependencies), false);
  assert.equal(f.commands.length, 0);
  const g = fixture({ existing: metadata });
  g.dependencies.downloadReady = async () => { g.tags.latest = "0.2.0"; return true; };
  assert.equal(await publishPackage(artifact, g.dependencies), false);
  assert.equal(g.commands.length, 0);
  assert.equal(compareVersions("0.1.0-preview.10", version), 1);
  assert.equal(compareVersions("0.1.0", version), 1);
  assert.equal(compareVersions("0.2.0-preview.1", "0.1.0"), 1);
});

test("a conflicting retry waits for matching metadata, but auth failures stop immediately", async () => {
  const f = fixture({ failure: Object.assign(new Error("conflict"), { stderr: "npm error code E409" }) });
  let reads = 0;
  f.dependencies.readVersion = async () => ++reads > 2 ? metadata : null;
  assert.equal(await publishPackage(artifact, f.dependencies), true);
  const g = fixture({ failure: Object.assign(new Error("auth failed"), { stderr: "npm error code E401" }) });
  await assert.rejects(publishPackage(artifact, g.dependencies), /auth failed/);
  assert.equal(g.commands.length, 1);
  assert.equal(g.waits.length, 0);
});

test("availability waiting is bounded and does not hide verification failures", async () => {
  await assert.rejects(waitUntil(async () => null, "scan", { attempts: 2, pause: async () => {}, log: () => {} }), /Timed out/);
  await assert.rejects(waitUntil(async () => { throw new Error("wrong checksum"); }, "download"), /wrong checksum/);
});
