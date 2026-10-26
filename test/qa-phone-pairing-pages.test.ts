import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhoneSessions } from "../src/phone-sessions.js";
import { deviceLabel } from "../src/phone-device-label.js";
import { HttpError } from "../src/http.js";
import { requestLogPath } from "../src/log.js";
import { renderRemote } from "../src/remote.js";
import type { Run, RunManager } from "../src/engine.js";

test("phone labels distinguish browser and device without retaining arbitrary user-agent text", () => {
  for (const [ua, expected] of [
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Version/18.0 Mobile/15E148 Safari/604.1", "iPhone · Safari"],
    ["Mozilla/5.0 (iPhone) CriOS/130.0 Mobile/15E148 Safari/604.1", "iPhone · Chrome"],
    ["Mozilla/5.0 (iPhone) FxiOS/130.0 Safari/604.1", "iPhone · Firefox"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1", "iPad · Safari"],
    ["Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Safari/537.36", "Android · Chrome"],
    ["Mozilla/5.0 (Windows NT 10.0) Chrome/130 Safari/537.36 Edg/130", "Windows · Edge"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari/604.1", "Mac · Safari"],
    ["", "Phone"], ["<script>garbage\n</script>", "Phone"],
  ]) assert.equal(deviceLabel(ua!), expected);
});

test("the device limit is a recoverable 409, concurrent pair attempts cannot exceed it, and revoke frees a slot", async () => {
  const home = await mkdtemp(join(tmpdir(), "codeflow-qa-phone-limit-"));
  try {
    const sessions = new PhoneSessions(join(home, "devices.json"));
    const results = await Promise.allSettled(Array.from({ length: 35 }, () => sessions.pair("iPhone · Safari", "generation")));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 32);
    for (const result of results) if (result.status === "rejected") assert.ok(result.reason instanceof HttpError && result.reason.status === 409);
    assert.equal(sessions.list("generation").length, 32);
    await sessions.revoke(sessions.list("generation")[0]!.id, "generation");
    await sessions.pair("Replacement", "generation");
    assert.equal(sessions.list("generation").length, 32);
    await sessions.pair("New generation", "rotated");
    assert.equal(sessions.list("rotated").length, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("old raw user-agent labels are readable without rewriting stored credentials", async () => {
  const home = await mkdtemp(join(tmpdir(), "codeflow-qa-phone-legacy-"));
  try {
    const file = join(home, "devices.json"), sessions = new PhoneSessions(file);
    const paired = await sessions.pair("Mozilla/5.0 (iPhone) Version/18 Mobile/15 Safari/604", "generation");
    const bytes = await readFile(file, "utf8"), restored = new PhoneSessions(file); await restored.load();
    assert.equal(restored.list("generation")[0]?.label, "iPhone · Safari");
    assert.equal(restored.valid(paired.token, "generation"), true);
    assert.equal(await readFile(file, "utf8"), bytes);
    await writeFile(file, "broken"); const corrupt = new PhoneSessions(file);
    await assert.rejects(corrupt.load(), error => error instanceof HttpError && error.status === 503);
    assert.throws(() => corrupt.list("generation"), error => error instanceof HttpError && error.status === 503);
    assert.equal(await readFile(file, "utf8"), "broken");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("request logs redact phone link secrets and drop query parameters", () => {
  for (const prefix of ["/r/", "/%72/"]) assert.equal(requestLogPath(`${prefix}private-capability/run/abc?token=owner`), `${prefix}[redacted]/run/abc`);
  assert.equal(requestLogPath("/api/runs?token=owner"), "/api/runs");
});

test("read-only refresh instructions match the actual page behavior", () => {
  const run = { id: "qa-done", task: "Done fixture", repo: "/scratch", pattern: "solo", status: "done", createdAt: Date.now(), steps: [], artifacts: [], worktrees: [] } as unknown as Run;
  const manager = { list: () => [run], get: () => run } as unknown as RunManager;
  const home = renderRemote(manager, [], "/r/fixture", "")!;
  assert.match(home, /http-equiv="refresh"/); assert.match(home, /refreshes every 15 s/);
  const done = renderRemote(manager, [], "/r/fixture", "/run/qa-done")!;
  assert.doesNotMatch(done, /http-equiv="refresh"|refreshes every/); assert.match(done, /refresh this page for updates/);
  run.status = "running";
  const running = renderRemote(manager, [], "/r/fixture", "/run/qa-done")!;
  assert.match(running, /http-equiv="refresh"/); assert.match(running, /refreshes every 15 s/);
});
