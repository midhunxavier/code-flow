import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateRemoteCertificate, loadRemoteCertificate, saveRemoteCertificate } from "../src/remote-tls.js";
import { requestTailscaleCertificate } from "../src/tailscale.js";
import { certificateFixture } from "./remote-tls-fixture.js";

test("saved certificates validate identity, key, validity and permissions without leaking secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cf-tls-test-"));
  try {
    const pair = await certificateFixture(directory);
    const value = { cert: pair.cert, key: pair.key, hostname: pair.hostname, source: pair.source };
    const info = validateRemoteCertificate(value);
    assert.ok(info.expiresAt > Date.now());
    assert.throws(() => validateRemoteCertificate({ ...value, hostname: "wrong.example" }), /does not cover/);
    assert.throws(() => validateRemoteCertificate(value, info.expiresAt + 1), /expired/);
    assert.equal(validateRemoteCertificate(value, info.expiresAt + 1, true).expiresAt, info.expiresAt, "startup can recover the identity for renewal without serving it");
    assert.throws(() => validateRemoteCertificate({ ...value, hostname: "wrong.example" }, info.expiresAt + 1, true), /does not cover/);
    assert.throws(() => validateRemoteCertificate(value, 0), /not valid yet/);
    assert.throws(() => validateRemoteCertificate({ ...value, key: "PRIVATE SENTINEL" }), (error: Error) => !error.message.includes("SENTINEL") && /do not match/.test(error.message));
    const other = await certificateFixture(directory);
    assert.throws(() => validateRemoteCertificate({ ...value, key: other.key }), /do not match/);
    const file = join(directory, "saved.json");
    await saveRemoteCertificate(value, file);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await loadRemoteCertificate(file), value);
    await assert.rejects(saveRemoteCertificate({ ...value, hostname: "wrong.example" }, file));
    assert.deepEqual(await loadRemoteCertificate(file), value, "a rejected replacement preserves the working certificate");
    await writeFile(file, "invalid");
    await assert.rejects(loadRemoteCertificate(file), /invalid or expired/);
    assert.equal(await loadRemoteCertificate(join(directory, "missing")), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Tailscale issuance uses explicit certificate paths, bounds command output and cleans its temporary key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cf-tls-cli-test-"));
  try {
    const pair = await certificateFixture(directory, "host.tail-test.ts.net");
    const command = join(directory, "tailscale"), receipt = join(directory, "receipt");
    await writeFile(command, `#!${process.execPath}\nconst fs = require('node:fs'); const args=process.argv.slice(2); if (args[0]!=='cert' || args.at(-1)!=='host.tail-test.ts.net' || !args.includes('--min-validity=720h') || process.env.TAILSCALE_BE_CLI!=='1') process.exit(2); const cert=args.find(a=>a.startsWith('--cert-file=')).slice(12); const key=args.find(a=>a.startsWith('--key-file=')).slice(11); fs.copyFileSync(${JSON.stringify(pair.certPath)},cert); fs.copyFileSync(${JSON.stringify(pair.keyPath)},key); fs.writeFileSync(${JSON.stringify(receipt)},key);`, { mode: 0o755 });
    const issued = await requestTailscaleCertificate(pair.hostname, [command]);
    assert.equal(issued.source, "tailscale");
    assert.equal(issued.cert, pair.cert);
    await assert.rejects(stat(await readFile(receipt, "utf8")), { code: "ENOENT" });
    await writeFile(command, `#!${process.execPath}\nconsole.error('PRIVATE_SENTINEL'); process.exit(1);`, { mode: 0o755 });
    await assert.rejects(requestTailscaleCertificate(pair.hostname, [command]), (error: Error) => /could not issue/.test(error.message) && !error.message.includes("SENTINEL"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
