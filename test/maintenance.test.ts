import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-maintenance-module-"));
const { compactRunLog, createEncryptedBackup, restoreEncryptedBackup, retainArchivedRuns } = await import("../src/maintenance.js");
const { RunLogWriter, decodeRunLog } = await import("../src/run-log.js");
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
  const runnerCredential = `tr-${"a".repeat(43)}`;
  await writeFile(join(home, "team-link.json"), JSON.stringify({ version: 1, url: "https://hub.example.ts.net", runnerId: "r-0123456789abcdef", token: runnerCredential, user: { userId: "u-1", username: "alice", displayName: "Alice" }, machineName: "alice-laptop", mappings: { "p-1": { api: "/repos/api" } } }));
  await writeFile(join(home, "team-link.json.corrupt-2026-10-19T00-00-00-000Z"), `{"token":"${runnerCredential}"`);
  await mkdir(join(home, "team-connections")); await writeFile(join(home, "team-connections", "c-1111111111111111.json"), JSON.stringify({ token: runnerCredential }));
  await mkdir(join(home, "team")); await writeFile(join(home, "team", "board.json"), '{"version":1,"projects":{}}');
  await mkdir(join(home, "team-link", "attempts"), { recursive: true }); await writeFile(join(home, "team-link", "attempts", "0123456789abcdef0123456789abcdef.json"), '{"attemptId":"0123456789abcdef0123456789abcdef","runId":"run-1"}');
  await writeFile(join(home, "acp-connections.json"), '{"connections":[{"command":"must-not-restore-executable"}]}');
  await mkdir(join(home, "extension-cache")); await writeFile(join(home, "extension-cache", "pinned.mjs"), 'throw new Error("must-not-restore-executable-code");');
  await mkdir(join(home, "remote-worker-private")); await writeFile(join(home, "remote-worker-private", "request.json"), '{"capability":"must-not-restore-worker-authority"}');
  await mkdir(join(home, "ssh-host")); await writeFile(join(home, "ssh-host", "runtime.json"), '{"token":"must-not-restore-host-authority"}');
  await writeFile(join(root, "outside.txt"), "not part of code-flow");
  await symlink(join(root, "outside.txt"), join(home, "outside-link"));
  const archive = join(root, "backup.cfb");
  const backup = await createEncryptedBackup({ home, output: archive, password: PASSWORD });
  assert.equal(backup.files, 6);
  assert.ok(backup.omitted.some((path) => path.includes("remote.json")));
  assert.ok(backup.omitted.includes("team-link.json (session or credential material)"), "the runner credential never enters a backup");
  assert.ok(backup.omitted.includes("team-link.json.corrupt-2026-10-19T00-00-00-000Z (session or credential material)"), "a set-aside copy of the link carries the credential too");
  assert.ok(!backup.omitted.some((path) => path.startsWith("team/") || path.startsWith("team-link/")), "the board and the local attempt records hold no credentials and stay in");
  assert.ok(backup.omitted.some((path) => path.includes("team-connections")));
  assert.ok(backup.omitted.some((path) => path.includes("remote-worker-private")));
  assert.ok(backup.omitted.some((path) => path.includes("ssh-host")));
  assert.ok(backup.omitted.some((path) => path.includes("extension-cache")));
  assert.ok(backup.omitted.some((path) => path.includes("acp-connections.json")));
  assert.ok(backup.omitted.some((path) => path.includes("shared-accounts.json")));
  assert.ok(backup.omitted.some((path) => path.includes("symbolic link")));
  assert.equal((await readFile(archive)).includes(Buffer.from("super-secret-note")), false);
  if (process.platform !== "win32") assert.equal((await lstat(archive)).mode & 0o777, 0o600);
  const restored = join(root, "restored");
  const report = await restoreEncryptedBackup({ input: archive, destination: restored, password: PASSWORD });
  assert.equal(report.files, 6);
  assert.equal(await lstat(join(restored, "team-link.json")).then(() => true, () => false), false);
  assert.equal(await lstat(join(restored, "team-link.json.corrupt-2026-10-19T00-00-00-000Z")).then(() => true, () => false), false);
  assert.equal(await readFile(join(restored, "team", "board.json"), "utf8"), '{"version":1,"projects":{}}');
  assert.equal(await lstat(join(restored, "team-link", "attempts", "0123456789abcdef0123456789abcdef.json")).then(() => true, () => false), true);
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
  assert.equal(await lstat(join(restored, "ssh-host")).then(() => true, () => false), false);
  assert.equal(await lstat(join(restored, "extension-cache")).then(() => true, () => false), false);
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

test("encrypted restore disables coordinated dispatch while retaining exact unknown launch receipts", async (t) => {
  const { root, home } = await fixture(t); const { CoordinatedChanges } = await import("../src/repo-coordination.js");
  const canonical = await realpath(root), repos = [join(canonical, "api"), join(canonical, "web")]; for (const repo of repos) { await mkdir(repo); execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo }); }
  const file = join(home, "coordinated-changes.json"), options = { file, pin: async (run: { repo: string }) => ({ repo: run.repo, commit: "a".repeat(40) }), launch: async () => ({ runId: "unexpected" }), validateResult: async () => ({ status: "running" as const }), previewShipping: async () => { throw new Error("unexpected shipping"); }, ship: async () => { throw new Error("unexpected shipping"); } };
  const coordinator = new CoordinatedChanges(options); await coordinator.load(); await coordinator.create({ project: "p-fixture", name: "Pending recovery", nodes: repos.map((repo, index) => ({ id: `repo${index}`, dependsOn: index ? ["repo0"] : [], run: { repo, pattern: "solo", task: "Pending repository work", roles: { agent: ["claude"] }, options: {} } })) });
  const saved = JSON.parse(await readFile(file, "utf8")); Object.assign(saved.jobs[0].nodes[0], { status: "claimed", claimId: "crashed-owned-claim", claimedAt: Date.now(), attempts: 1, dependencies: [] }); await writeFile(file, JSON.stringify(saved));
  const backup = join(root, "coordinated.cfb"); await createEncryptedBackup({ home, output: backup, password: PASSWORD }); const destination = join(root, "restored-coordination"); const report = await restoreEncryptedBackup({ input: backup, destination, password: PASSWORD }); assert.equal(report.cancelledCoordinatedChanges, 1);
  let launches = 0; const restored = new CoordinatedChanges({ ...options, file: join(destination, "coordinated-changes.json"), launch: async () => { launches++; return { runId: "unexpected" }; } }); await restored.load(); await restored.tick(); assert.equal(launches, 0); const job = (await restored.list())[0]!; assert.equal(job.status, "cancelled"); assert.equal(job.nodes[0]!.status, "unknown"); assert.equal(job.nodes[0]!.claimId, "crashed-owned-claim"); assert.equal(job.nodes[1]!.status, "cancelled");
});

test("encrypted restore retains code-host receipt facts but turns in-flight remote mutations into unknown non-replaying metadata", async (t) => {
  const { root, home } = await fixture(t), receipt = { id: "a".repeat(40), previewId: "b".repeat(40), integration: "fixture", key: "new", kind: "create", status: "claimed", at: 1, commit: "c".repeat(40), target: "d".repeat(40), sourceBranch: `codeflow/pr/${"e".repeat(20)}`, runId: "owned-source", detail: "Native request may have reached provider" };
  await writeFile(join(home, "code-host-operations.json"), JSON.stringify({ version: 1, operations: [receipt] })); const backup = join(root, "code-host.cfb"); await createEncryptedBackup({ home, output: backup, password: PASSWORD }); const destination = join(root, "restored-code-host"); await restoreEncryptedBackup({ input: backup, destination, password: PASSWORD }); const restored = JSON.parse(await readFile(join(destination, "code-host-operations.json"), "utf8")); assert.equal(restored.operations[0].status, "unknown"); assert.equal(restored.operations[0].runId, receipt.runId); assert.equal(restored.operations[0].sourceBranch, receipt.sourceBranch); assert.match(restored.operations[0].detail, /no automatic replay/);
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
test("authenticated malicious backups cannot escape the destination or restore old phone secrets and runner credentials", async (t) => {
  const { root } = await fixture(t);
  const data = Buffer.from("payload");
  const file = { path: "../escape", bytes: data.length, sha256: createHash("sha256").update(data).digest("hex"), data: data.toString("base64") };
  const archive = join(root, "unsafe.cfb");
  await writeFile(archive, archiveManifest({ version: 1, createdAt: 1, omitted: [], files: [file] }));
  await assert.rejects(restoreEncryptedBackup({ input: archive, destination: join(root, "unsafe"), password: PASSWORD }), /unsafe/);
  assert.equal(await lstat(join(root, "escape")).then(() => true, () => false), false);
  await writeFile(archive, archiveManifest({ version: 1, createdAt: 1, omitted: [], files: [{ ...file, path: "remote.json" }, { ...file, path: "phone-devices.json" }, { ...file, path: "shared-accounts.json.old" }, { ...file, path: "team-link.json" }, { ...file, path: "team-connections/c-1111111111111111.json" }, { ...file, path: "team-link.json.corrupt-2026-10-19T00-00-00-000Z" }, { ...file, path: "remote-worker-private/request.json" }, { ...file, path: "extension-cache/pinned.mjs" }, { ...file, path: "acp-connections.json" }, { ...file, path: "notes.json" }] }));
  const destination = join(root, "clean");
  const restored = await restoreEncryptedBackup({ input: archive, destination, password: PASSWORD });
  assert.equal(restored.files, 1);
  assert.equal(await lstat(join(destination, "phone-devices.json")).then(() => true, () => false), false);
  assert.equal(await lstat(join(destination, "shared-accounts.json.old")).then(() => true, () => false), false);
  assert.equal(await lstat(join(destination, "team-link.json")).then(() => true, () => false), false);
  assert.equal(await lstat(join(destination, "team-connections")).then(() => true, () => false), false);
  assert.equal(await lstat(join(destination, "team-link.json.corrupt-2026-10-19T00-00-00-000Z")).then(() => true, () => false), false);
  assert.ok(restored.omitted.includes("team-link.json (session or credential material excluded from restore)"), "an older archive's runner credential is reported, not restored");
  assert.equal(await lstat(join(destination, "remote-worker-private")).then(() => true, () => false), false);
  assert.equal(await lstat(join(destination, "extension-cache")).then(() => true, () => false), false);
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
  for (const suffix of [".cold-index.json", ".cold-detail.json"]) await writeFile(join(home, "runs", "compact" + suffix), "{}");
  const preview = await compactRunLog({ home, runId: "compact" });
  assert.equal(preview.snapshotsRemoved, 1); assert.ok(preview.savedBytes > 10000);
  assert.equal(await readFile(file, "utf8"), original);
  await compactRunLog({ home, runId: "compact", apply: true });
  assert.deepEqual((await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line).seq), [1, 2, 3, 5, 6]);
  assert.equal(await readFile(join(home, "runs", "compact.journal.jsonl"), "utf8"), journal);
  assert.equal(await lstat(join(home, "runs", "compact.checkpoint.json")).then(() => true, () => false), false);
  for (const suffix of [".cold-index.json", ".cold-detail.json"]) assert.equal(await lstat(join(home, "runs", "compact" + suffix)).then(() => true, () => false), false);
  await writeFile(join(home, "runs", "running.jsonl"), log("running", "running", false));
  await assert.rejects(compactRunLog({ home, runId: "running", apply: true }), /Resumable/);
});

test("patch-aware compaction preserves the latest state and rebases the retained final snapshot", async (t) => {
  const { home } = await fixture(t), writer = new RunLogWriter(false), id = "patch-compact";
  const initial = { id, status: "done", archived: false, summary: "Initial".repeat(5000), followUps: [] };
  const snapshots = [initial, { ...initial, summary: initial.summary + "x".repeat(10000) }, { ...initial, archived: true, pinned: true, summary: "Finished" }];
  const metadata = snapshots.map((run, index) => writer.encode({ type: "run", seq: index * 2 + 1, ts: 1, runId: id, run: run as any }));
  assert.equal(metadata[1]!.type, "run-patch"); assert.equal(metadata[2]!.type, "run-patch");
  const events = [metadata[0], { seq: 2, type: "agent", event: { kind: "text", text: "Retained transcript" } }, metadata[1], { seq: 4, type: "step", step: { id: "step", status: "done" } }, metadata[2], { seq: 6, type: "log", text: "Retained verification evidence" }];
  const file = join(home, "runs", id + ".jsonl"), original = events.map((event) => JSON.stringify(event)).join("\n") + "\n"; await writeFile(file, original);
  const preview = await compactRunLog({ home, runId: id }); assert.equal(preview.snapshotsRemoved, 1); assert.ok(preview.savedBytes > 9000); assert.equal(await readFile(file, "utf8"), original);
  await compactRunLog({ home, runId: id, apply: true });
  const lines = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line)); assert.deepEqual(lines.map((event) => event.seq), [1, 2, 4, 5, 6]);
  assert.equal(lines[3].type, "run"); assert.deepEqual(decodeRunLog(lines).filter((event) => event.type === "run").at(-1)!.run, snapshots[2]);
  assert.equal((await compactRunLog({ home, runId: id, apply: true })).snapshotsRemoved, 0);
});

test("maintenance reads latest archive patches and refuses incomplete or invalid chains without rewriting logs", async (t) => {
  const { home } = await fixture(t), old = new Date(Date.now() - 100 * 86400000);
  for (const [id, before, after] of [["archive-patch", false, true], ["unarchive-patch", true, false]] as const) {
    const writer = new RunLogWriter(false), initial = { id, status: "done", archived: before };
    const events = [initial, { ...initial, archived: after }].map((run, index) => writer.encode({ seq: index + 1, ts: 1, runId: id, type: "run", run: run as any }));
    const file = join(home, "runs", id + ".jsonl"); await writeFile(file, events.map((event) => JSON.stringify(event)).join("\n") + "\n"); await utimes(file, old, old);
  }
  for (const [id, patch] of [["missing", { base: 99, set: { archived: true } }], ["malformed", { base: 1, tail: { merges: [99, []] } }]] as const) {
    const initial = { id, status: "done", archived: true, merges: [] }, file = join(home, "runs", id + ".jsonl");
    const original = [{ seq: 1, type: "run", run: initial }, { seq: 2, type: "run-patch", runId: id, ...patch }].map((event) => JSON.stringify(event)).join("\n") + "\n";
    await writeFile(file, original); await utimes(file, old, old); await assert.rejects(compactRunLog({ home, runId: id, apply: true }), /patch/i); assert.equal(await readFile(file, "utf8"), original);
  }
  const report = await retainArchivedRuns({ home, days: 30 }); assert.deepEqual(report.candidates.map((candidate) => candidate.id), ["archive-patch"]); assert.deepEqual(report.skipped.map((entry) => entry.id).sort(), ["malformed", "missing"]);
});

test("already compact patch logs stay within their original size instead of duplicating common metadata", async (t) => {
  const { home } = await fixture(t), writer = new RunLogWriter(false), id = "compact-enough", initial = { id, status: "done", archived: true, task: "same metadata ".repeat(5000) };
  const events = [initial, { ...initial, summary: "progress" }, { ...initial, summary: "finished" }].map((run, index) => writer.encode({ type: "run", seq: index + 1, ts: 1, runId: id, run: run as any }));
  const file = join(home, "runs", id + ".jsonl"), original = events.map((event) => JSON.stringify(event)).join("\n") + "\n"; await writeFile(file, original);
  const result = await compactRunLog({ home, runId: id, apply: true }); assert.equal(result.savedBytes, 0); assert.equal(result.snapshotsRemoved, 0); assert.equal(await readFile(file, "utf8"), original);
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
