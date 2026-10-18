import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PhoneSessions } from "../src/phone-sessions.js";

test("phones have independently revocable persisted hash-only sessions", async () => {
  const folder = await mkdtemp(join(tmpdir(), "codeflow-phones-"));
  try {
    const file = join(folder, "devices.json");
    const sessions = new PhoneSessions(file);
    const first = await sessions.pair("First phone", "generation");
    const second = await sessions.pair("Second phone", "generation");
    assert.equal(sessions.valid(first.token, "generation"), true);
    assert.equal(sessions.valid(first.token, "other-generation"), false);
    assert.equal(sessions.valid(first.token, "generation", first.device.expiresAt), false);
    assert.doesNotMatch(await readFile(file, "utf8"), new RegExp(first.token));
    const restarted = new PhoneSessions(file); await restarted.load();
    assert.equal(restarted.valid(first.token, "generation"), true);
    await restarted.revoke(first.device.id, "generation");
    assert.equal(restarted.valid(first.token, "generation"), false);
    assert.equal(restarted.valid(second.token, "generation"), true);
    assert.equal(restarted.list("generation").length, 1);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("malformed phone session storage fails closed without overwriting the source", async () => {
  const folder = await mkdtemp(join(tmpdir(), "codeflow-phones-corrupt-"));
  try {
    const file = join(folder, "devices.json"); await writeFile(file, "broken");
    const sessions = new PhoneSessions(file);
    await assert.rejects(sessions.pair("phone", "generation"), /cannot be read/);
    assert.equal(await readFile(file, "utf8"), "broken");
    assert.equal(sessions.valid("anything", "generation"), false);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
