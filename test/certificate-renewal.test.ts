import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CertificateRenewal, RENEW_BEFORE } from "../src/certificate-renewal.js";
import type { CertificateInfo } from "../src/remote-tls.js";

test("renewal schedules before expiry, retries across restarts, redacts errors and skips imported certificates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "renewal-test-"));
  try {
    let now = Date.now(), calls = 0;
    const file = join(dir, "state.json");
    let renewal = new CertificateRenewal(file, () => now);
    const info: CertificateInfo = { hostname: "host.example.ts.net", source: "tailscale", expiresAt: now + RENEW_BEFORE + 1000 };
    const fail = async () => { calls++; throw new Error("SECRET_PRIVATE_KEY"); };
    await renewal.tick(info, fail); assert.equal(calls, 0);
    now += 1000;
    await renewal.tick(info, fail); assert.equal(calls, 1);
    assert.equal(renewal.status(info)?.nextAttempt, now + 3600_000);
    assert.doesNotMatch(JSON.stringify(renewal.status(info)), /SECRET/);
    renewal = new CertificateRenewal(file, () => now); await renewal.load();
    await renewal.tick(info, fail); assert.equal(calls, 1);
    now += 3600_000; await renewal.tick(info, fail); assert.equal(calls, 2);
    assert.equal(renewal.status(info)?.nextAttempt, now + 2 * 3600_000);
    now += 2 * 3600_000;
    const renewed = { ...info, expiresAt: now + 90 * 86400_000 };
    await renewal.tick(info, async () => { calls++; return renewed; });
    assert.equal(renewal.status(renewed)?.lastSuccess, now);
    assert.equal(renewal.status(renewed)?.nextAttempt, renewed.expiresAt - RENEW_BEFORE);
    assert.equal(renewal.status(renewed)?.error, undefined);
    await renewal.tick({ ...info, source: "import" }, fail); assert.equal(calls, 3);
    assert.equal(renewal.status({ ...info, source: "import" }), undefined);
    // Offline past expiry and a replaced identity must not inherit the previous identity's schedule.
    await renewal.tick({ ...info, hostname: "new.example.ts.net", expiresAt: now - 1000 }, fail);
    assert.equal(calls, 4);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("overlapping scheduler ticks issue only one certificate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "renewal-overlap-"));
  try {
    const renewal = new CertificateRenewal(join(dir, "state.json"));
    const info: CertificateInfo = { hostname: "host.example.ts.net", source: "tailscale", expiresAt: Date.now() + 1000 };
    let calls = 0;
    await Promise.all([1, 2, 3].map(() => renewal.tick(info, async () => { calls++; return { ...info, expiresAt: Date.now() + 90 * 86400_000 }; })));
    assert.equal(calls, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
