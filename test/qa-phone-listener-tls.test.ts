import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const home = mkdtempSync("/private/tmp/cf-qa-phone-tls-unit-"); process.env.CODEFLOW_HOME = join(home, "data");
const { inspectEnvironmentCertificate, certificateCoversHost, certificateTimeInvalid, validateRemoteCertificate } = await import("../src/remote-tls.js");
let cert: string, key: string;
before(() => {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(home, "key.pem"), "-out", join(home, "cert.pem"), "-days", "2", "-subj", "/CN=phone.example.test", "-addext", "subjectAltName=DNS:phone.example.test,DNS:*.tail-test.ts.net,IP:127.0.0.1,IP:::1"], { stdio: "ignore" });
  cert = readFileSync(join(home, "cert.pem"), "utf8"); key = readFileSync(join(home, "key.pem"), "utf8");
});
after(() => rmSync(home, { recursive: true, force: true }));
test("environment certificate metadata validates its key and exposes only usable names", () => {
  const info = inspectEnvironmentCertificate(Buffer.from(cert), Buffer.from(key)); assert.ok(info.expiresAt > Date.now()); assert.ok(info.validFrom <= Date.now()); assert.deepEqual(info.hostnames, ["phone.example.test", "127.0.0.1", "0:0:0:0:0:0:0:1"]);
  assert.equal(certificateCoversHost(info.certificate, "phone.example.test"), true); assert.equal(certificateCoversHost(info.certificate, "host.tail-test.ts.net"), true); assert.equal(certificateCoversHost(info.certificate, "wrong.example.test"), false); assert.equal(certificateCoversHost(info.certificate, "127.0.0.1"), true); assert.equal(certificateCoversHost(info.certificate, "127.0.0.2"), false);
});
test("validity is checked at use time, including both boundary instants", () => {
  const info = inspectEnvironmentCertificate(cert, key); assert.equal(certificateTimeInvalid(info, info.validFrom - 1), true); assert.equal(certificateTimeInvalid(info, info.validFrom), false); assert.equal(certificateTimeInvalid(info, info.expiresAt - 1), false); assert.equal(certificateTimeInvalid(info, info.expiresAt), true);
});
test("invalid and mismatched key material fails without exposing private contents", () => {
  for (const pair of [["NOT A CERTIFICATE", key], [cert, "PRIVATE-SENTINEL"], [cert, "x".repeat(33 * 1024)]]) assert.throws(() => inspectEnvironmentCertificate(pair[0]!, pair[1]!), (error: Error) => !error.message.includes("PRIVATE-SENTINEL") && !error.message.includes("BEGIN PRIVATE"));
  execFileSync("openssl", ["genrsa", "-out", join(home, "wrong-key.pem"), "2048"], { stdio: "ignore" }); assert.throws(() => inspectEnvironmentCertificate(cert, readFileSync(join(home, "wrong-key.pem"))), /do not match/);
});
test("saved certificates preserve exact hostname validation and recovery-only expired loading", () => {
  const input = { cert, key, hostname: "phone.example.test", source: "import" as const }, info = inspectEnvironmentCertificate(cert, key); assert.equal(validateRemoteCertificate(input).expiresAt, info.expiresAt); assert.throws(() => validateRemoteCertificate({ ...input, hostname: "wrong.example.test" }), /does not cover/); assert.throws(() => validateRemoteCertificate(input, info.expiresAt), /expired/); assert.equal(validateRemoteCertificate(input, info.expiresAt, true).expiresAt, info.expiresAt); assert.throws(() => validateRemoteCertificate(input, info.validFrom - 1, true), /not valid yet/);
});
