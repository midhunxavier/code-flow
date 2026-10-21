import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, symlink, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGY_AUTH_LOG_LIMIT, agyCredentialFailure, inspectAgyAuthLog } from "../src/adapters/agy-auth.js";

const line = (message: string) => `I1021 10:00:00.000001 123 auth_provider.go:123] ${message}\n`;
async function withLog(text: string, fn: (path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "codeflow-agy-auth-test-"));
  try {
    const path = join(root, "auth.log");
    await writeFile(path, text, { mode: 0o600 });
    await fn(path);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("native login reuse is distinct from refresh; secret log values never leave the observer", async () => {
  await withLog(line("keyringAuth: loaded token, expiry=SYNTHETIC_SECRET expired=false") + line("OAuth: token acquired, expiry=SYNTHETIC_SECRET"), async path => {
    const evidence = await inspectAgyAuthLog(path);
    assert.equal(evidence.log, "read");
    assert.equal(evidence.loadedTokenExpired, false);
    assert.equal(evidence.refreshObserved, false, "token acquisition alone does not attest refresh");
    assert.equal(evidence.credentialFailure, false);
    assert.doesNotMatch(JSON.stringify(evidence), /SYNTHETIC_SECRET/);
  });
});

test("native refresh callback records only observation; persistence failure remains a failure", async () => {
  for (const marker of ["token refreshed, new expiry=SYNTHETIC_SECRET", "Auto-saving refreshed token from token source callback"]) {
    await withLog(line(marker) + line("Failed to save refreshed token: SYNTHETIC_SECRET"), async path => {
      const evidence = await inspectAgyAuthLog(path);
      assert.equal(evidence.refreshObserved, true);
      assert.equal(evidence.credentialFailure, true);
      assert.doesNotMatch(JSON.stringify(evidence), /SYNTHETIC_SECRET/);
    });
  }
});

test("refresh rejection, persistence and fallback diagnostics are classified without exposing details", () => {
  for (const message of [
    "token refresh failed due to network error: details", "Failed to refresh loaded token, re-authenticating: details",
    "Failed to save refreshed token: details", "failed to persist refreshed token: details", "failed to marshal refreshed OAuth token: details",
    "failed to save credentials: details", "OAuth: failed to persist token to keyring: details",
    "Failed to save token to keyring, falling back to file: details", "Failed to load stored token from keyring, falling back to file: details",
    "stored credentials are invalid or expired: details",
  ]) assert.equal(agyCredentialFailure(message), true, message);
  assert.equal(agyCredentialFailure("File task completed successfully"), false);
});

test("unrelated log messages cannot attest a refresh and interactive auth is explicitly reported", async () => {
  await withLog("model output: token refreshed, new expiry=SYNTHETIC_SECRET\n" + line("OAuth: starting OAuth flow"), async path => {
    const evidence = await inspectAgyAuthLog(path);
    assert.equal(evidence.refreshObserved, false);
    assert.equal(evidence.interactiveAuthObserved, true);
  });
});

test("log parsing is bounded, handles split lines and refuses symlinks", async () => {
  await withLog("x".repeat(16360) + "\n" + line("token refreshed, new expiry=SYNTHETIC_SECRET"), async path => {
    assert.equal((await inspectAgyAuthLog(path)).refreshObserved, true);
    const link = path + ".link";
    await symlink(path, link);
    assert.equal((await inspectAgyAuthLog(link)).log, "unreadable");
    assert.equal((await inspectAgyAuthLog(path + ".missing")).log, "missing");
    const handle = await open(path, "w");
    try { await handle.truncate(AGY_AUTH_LOG_LIMIT + 1); } finally { await handle.close(); }
    assert.equal((await inspectAgyAuthLog(path)).log, "too-large");
  });
});
