import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-maintenance-module-"));
const { compactRunLog, createEncryptedBackup, restoreEncryptedBackup, retainArchivedRuns } = await import("../src/maintenance.js");
const PASSWORD = "test backup password 12345";
const fixture = async (t: { after: (action: () => Promise<unknown>) => void }) => {
  const root = await mkdtemp(join(tmpdir(), "codeflow-maintenance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"); await mkdir(join(home, "runs"), { recursive: true });
  return { root, home };
};

test("encrypted backups round-trip application data while excluding live sessions and links", async (t) => {
  const { root, home } = await fixture(t);
  await writeFile(join(home, "notes.json"), '{"private":"super-secret-note"}');
  await writeFile(join(home, "projects.json"), "[]");
  await writeFile(join(home, "triggers.json"), JSON.stringify([{ id: "t-1", token: "old-webhook-token", enabled: true, nextAt: 123, queued: [{ details: "old event" }] }]));
  await writeFile(join(home, "notifications.json"), JSON.stringify({ version: 1, settings: { slack: { enabled: true, events: ["done"], projects: "all" } }, deliveries: [{ id: "n-1", state: "pending", nextAttemptAt: 123 }], seen: [] }));
  await writeFile(join(home, "remote.json"), '{"controlToken":"old-phone-token"}');
  await writeFile(join(home, "phone-devices.json"), '{"devices":[]}');
  await writeFile(join(home, "shared-accounts.json"), '{"users":[{"password":"credential-hash"}],"sessions":[{"hash":"live-authority"}]}');
  await writeFile(join(home, "connection.json"), '{"token":"team-token"}');
  await mkdir(join(home, "remote-worker-private")); await writeFile(join(home, "remote-worker-private", "request.json"), '{"capability":"must-not-restore-worker-authority"}');
  await writeFile(join(root, "outside.txt"), "not part of code-flow");
  await symlink(join(root, "outside.txt"), join(home, "outside-link"));
  const archive = join(root, "backup.cfb");
  const backup = await createEncryptedBackup({ home, output: archive, password: PASSWORD });
  assert.equal(backup.files, 4);
  assert.ok(backup.omitted.some((path) => path.includes("remote.json")));
  assert.ok(backup.omitted.some((path) => path.includes("remote-worker-private")));
  assert.ok(backup.omitted.some((path) => path.includes("shared-accounts.json")));
  assert.ok(backup.omitted.some((path) => path.includes("symbolic link")));
  assert.equal((await readFile(archive)).includes(Buffer.from("super-secret-note")), false);
  if (process.platform !== "win32") assert.equal((await lstat(archive)).mode & 0o777, 0o600);
  const restored = join(root, "restored");
  const report = await restoreEncryptedBackup({ input: archive, destination: restored, password: PASSWORD });
  assert.equal(report.files, 4);
  assert.equal(report.disabledAutomations, 1);
  const triggers = JSON.parse(await readFile(join(restored, "triggers.json"), "utf8"));
  assert.equal(triggers[0].enabled, false);
  assert.notEqual(triggers[0].token, "old-webhook-token");
  assert.deepEqual(triggers[0].queued, []);
  assert.equal(report.disabledNotifications, 1);
  const notifications = JSON.parse(await readFile(join(restored, "notifications.json"), "utf8"));
  assert.equal(notifications.settings.slack.enabled, false);
  assert.equal(notifications.deliveries[0].state, "cancelled");
  assert.equal(await readFile(join(restored, "notes.json"), "utf8"), '{"private":"super-secret-note"}');
  assert.equal(await lstat(join(restored, "remote.json")).then(() => true, () => false), false);
  assert.equal(await lstat(join(restored, "remote-worker-private")).then(() => true, () => false), false);
  assert.equal(await lstat(join(restored, "shared-accounts.json")).then(() => true, () => false), false);
  assert.equal(await lstat(join(restored, "outside-link")).then(() => true, () => false), false);
  await assert.rejects(restoreEncryptedBackup({ input: archive, destination: restored, password: PASSWORD }), /already exists/);
  await assert.rejects(createEncryptedBackup({ home, output: archive, password: PASSWORD }), /EEXIST/);
  await mkdir(join(home, "..safe"));
  await assert.rejects(createEncryptedBackup({ home, output: join(home, "..safe", "nested.cfb"), password: PASSWORD }), /outside/);
});

test("restoring encrypted backups cancels queued and ambiguous deferred work without losing saved receipts", async (t) => {
  const { root, home } = await fixture(t);
  const { DeferredRuns } = await import("../src/deferred-runs.js");
  const file = join(home, "deferred-runs.json");
  const request = { repo: "/project/fixture", pattern: "solo", task: "Run later", roles: { agent: ["claude"] }, options: {} };
  const queue = new DeferredRuns({ file, ready: async () => ({ ready: true }), launch: async () => ({ runId: "run-existing" }) }); await queue.load();
  await queue.enqueue({ run: request }); await queue.tick();
  await queue.enqueue({ run: request, notBefore: Date.now() + 60_000 });
  await queue.enqueue({ run: request });
  const saved = JSON.parse(await readFile(file, "utf8")); const ambiguous = structuredClone(saved.jobs[0]);
  ambiguous.id = `d-${randomBytes(16).toString("hex").slice(0, 8)}-0000-4000-8000-${randomBytes(6).toString("hex")}`; ambiguous.status = "claimed"; ambiguous.cancelRequested = true; saved.jobs.push(ambiguous); await writeFile(file, JSON.stringify(saved));
  const backup = join(root, "deferred.cfb"); await createEncryptedBackup({ home, output: backup, password: PASSWORD });
  const destination = join(root, "restored-deferred"); const result = await restoreEncryptedBackup({ input: backup, destination, password: PASSWORD });
  assert.equal(result.cancelledDeferredRuns, 3);
  let calls = 0; const restored = new DeferredRuns({ file: join(destination, "deferred-runs.json"), ready: async () => ({ ready: true }), launch: async () => { calls++; return { runId: "unexpected" }; } }); await restored.load(); await restored.tick(true);
  assert.equal(calls, 0); const jobs = await restored.list(); assert.equal(jobs.filter((job) => job.status === "cancelled").length, 3);
  assert.equal(jobs.find((job) => job.status === "started")!.runId, "run-existing");
  assert.ok(jobs.filter((job) => job.status === "cancelled").every((job) => /backup restore/.test(job.reason!)));
});

test("incorrect passwords and tampered archives leave no restored directory", async (t) => {
  const { root, home } = await fixture(t);
  await writeFile(join(home, "memory.json"), "[]");
  const archive = join(root, "backup.cfb");
  await createEncryptedBackup({ home, output: archive, password: PASSWORD });
  const destination = join(root, "destination");
  await assert.rejects(restoreEncryptedBackup({ input: archive, destination, password: "incorrect password 123" }), /authentication failed/);
  const damaged = await readFile(archive); damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 1;
  const corrupt = join(root, "corrupt.cfb"); await writeFile(corrupt, damaged);
  await assert.rejects(restoreEncryptedBackup({ input: corrupt, destination, password: PASSWORD }), /authentication failed/);
  assert.equal(await lstat(destination).then(() => true, () => false), false);
});

function archiveManifest(manifest: unknown) {
  const magic = Buffer.from("CODEFLOW-BACKUP-1\n"); const salt = randomBytes(16); const iv = randomBytes(12);
  const header = Buffer.concat([magic, salt, iv]);
  const cipher = createCipheriv("aes-256-gcm", scryptSync(PASSWORD, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }), iv);
  cipher.setAAD(header);
  const data = Buffer.concat([cipher.update(gzipSync(JSON.stringify(manifest))), cipher.final()]);
  return Buffer.concat([header, cipher.getAuthTag(), data]);
}
test("authenticated malicious backups cannot escape the destination or restore old phone secrets", async (t) => {
  const { root } = await fixture(t);
  const data = Buffer.from("payload");
  const file = { path: "../escape", bytes: data.length, sha256: createHash("sha256").update(data).digest("hex"), data: data.toString("base64") };
  const archive = join(root, "unsafe.cfb");
  await writeFile(archive, archiveManifest({ version: 1, createdAt: 1, omitted: [], files: [file] }));
  await assert.rejects(restoreEncryptedBackup({ input: archive, destination: join(root, "unsafe"), password: PASSWORD }), /unsafe/);
  assert.equal(await lstat(join(root, "escape")).then(() => true, () => false), false);
  await writeFile(archive, archiveManifest({ version: 1, createdAt: 1, omitted: [], files: [{ ...file, path: "remote.json" }, { ...file, path: "phone-devices.json" }, { ...file, path: "shared-accounts.json.old" }, { ...file, path: "remote-worker-private/request.json" }, { ...file, path: "notes.json" }] }));
  const destination = join(root, "clean");
  const restored = await restoreEncryptedBackup({ input: archive, destination, password: PASSWORD });
  assert.equal(restored.files, 1);
  assert.equal(await lstat(join(destination, "phone-devices.json")).then(() => true, () => false), false);
  assert.equal(await lstat(join(destination, "shared-accounts.json.old")).then(() => true, () => false), false);
  assert.equal(await lstat(join(destination, "remote-worker-private")).then(() => true, () => false), false);
});

const log = (id: string, status: string, archived: boolean) => JSON.stringify({ seq: 1, type: "run", run: { id, status, archived } }) + "\n";
test("legacy age-only retention reports candidates but cannot bypass exact-plan deletion protections", async (t) => {
  const { home } = await fixture(t);
  const now = Date.now(); const old = new Date(now - 100 * 86400000);
  for (const [id, status, archived] of [["old", "done", true], ["active", "running", true], ["resume", "interrupted", true], ["kept", "done", false], ["recent", "done", true]] as const) {
    const path = join(home, "runs", `${id}.jsonl`); await writeFile(path, log(id, status, archived));
    if (id !== "recent") await utimes(path, old, old);
  }
  await writeFile(join(home, "runs", "old.journal.jsonl"), '{"key":"done","value":true}\n');
  await writeFile(join(home, "runs", "old.checkpoint.json"), "{}");
  await writeFile(join(home, "memory.json"), "knowledge");
  const preview = await retainArchivedRuns({ home, days: 90, now });
  assert.deepEqual(preview.candidates.map((item) => item.id), ["old"]);
  assert.equal(preview.deletedFiles, 0);
  assert.equal(await lstat(join(home, "runs", "old.jsonl")).then(() => true, () => false), true);
  assert.match(preview.nextStep, /pins or provenance/);
  await assert.rejects(retainArchivedRuns({ home, days: 90, now, apply: true }), /Age-only retention cannot delete data/);
  for (const suffix of [".jsonl", ".journal.jsonl", ".checkpoint.json"]) assert.equal(await lstat(join(home, "runs", "old" + suffix)).then(() => true, () => false), true);
  assert.equal(await readFile(join(home, "memory.json"), "utf8"), "knowledge");
  assert.equal(await lstat(join(home, "runs", "resume.jsonl")).then(() => true, () => false), true);
});

test("compaction preserves transcript, step and recovery evidence while removing repeated metadata", async (t) => {
  const { home } = await fixture(t);
  const events = [
    { seq: 1, type: "run", run: { id: "compact", status: "running", archived: false } },
    { seq: 2, type: "step", step: { id: "s1", status: "done" } },
    { seq: 3, type: "agent", event: { kind: "text", text: "Complete transcript" } },
    { seq: 4, type: "run", run: { id: "compact", status: "running", archived: false, summary: "x".repeat(10000) } },
    { seq: 5, type: "log", text: "Verification evidence" },
    { seq: 6, type: "run", run: { id: "compact", status: "done", archived: true, summary: "Finished" } },
  ];
  const file = join(home, "runs", "compact.jsonl"); const original = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  await writeFile(file, original);
  const journal = '{"key":"recovery","value":{"ok":true}}\n';
  await writeFile(join(home, "runs", "compact.journal.jsonl"), journal);
  await writeFile(join(home, "runs", "compact.checkpoint.json"), "{}");
  const preview = await compactRunLog({ home, runId: "compact" });
  assert.equal(preview.snapshotsRemoved, 1); assert.ok(preview.savedBytes > 10000);
  assert.equal(await readFile(file, "utf8"), original);
  await compactRunLog({ home, runId: "compact", apply: true });
  assert.deepEqual((await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line).seq), [1, 2, 3, 5, 6]);
  assert.equal(await readFile(join(home, "runs", "compact.journal.jsonl"), "utf8"), journal);
  assert.equal(await lstat(join(home, "runs", "compact.checkpoint.json")).then(() => true, () => false), false);
  await writeFile(join(home, "runs", "running.jsonl"), log("running", "running", false));
  await assert.rejects(compactRunLog({ home, runId: "running", apply: true }), /Resumable/);
});

test("offline maintenance refuses to compete with a live server lock", async (t) => {
  const { root, home } = await fixture(t);
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => { child.kill("SIGKILL"); return Promise.resolve(); });
  await writeFile(join(home, "server.lock"), String(child.pid));
  await assert.rejects(createEncryptedBackup({ home, output: join(root, "backup.cfb"), password: PASSWORD }), /Another code-flow server/);
});

test("retention and compaction reject run-storage symlinks outside the data directory", async (t) => {
  const { root, home } = await fixture(t);
  const outside = join(root, "outside-runs"); await mkdir(outside);
  await writeFile(join(outside, "keep.jsonl"), log("keep", "done", true));
  await rm(join(home, "runs"), { recursive: true });
  await symlink(outside, join(home, "runs"));
  await assert.rejects(retainArchivedRuns({ home, days: 1, apply: true }), /symbolic link/);
  await assert.rejects(compactRunLog({ home, runId: "keep", apply: true }), /symbolic link/);
  assert.equal(await readFile(join(outside, "keep.jsonl"), "utf8"), log("keep", "done", true));
});
