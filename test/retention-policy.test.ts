import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { RetentionPolicy, RetentionPreview } from "../src/retention-policy.js";

const moduleHome = await mkdtemp(join(tmpdir(), "codeflow-retention-module-")); process.env.CODEFLOW_HOME = moduleHome;
const { RetentionPolicyStore, RetentionPolicyConflictError, previewRetention, applyRetention } = await import("../src/retention-policy.js");
const { MemoryStore } = await import("../src/memory.js");
const { DeferredRuns } = await import("../src/deferred-runs.js");
const { RunLogWriter } = await import("../src/run-log.js");
const directories = [moduleHome];
after(() => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))));
const now = Date.now(), old = new Date(now - 100 * 86400000);
const root = fileURLToPath(new URL("..", import.meta.url));
const days = { archivedRuns: 30, attachments: 30, memory: 30, worktrees: 30 };
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-retention-"))); directories.push(directory);
  const home = join(directory, "home"), repo = join(directory, "repo"); await mkdir(join(home, "runs"), { recursive: true }); await mkdir(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main"); await writeFile(join(repo, "README.md"), "Initial fixture\n"); await writeFile(join(repo, ".gitignore"), ".worktrees/\n.env\n"); git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"); await writeFile(join(repo, ".git/info/exclude"), "/.codeflow-context/\n");
  const store = new RetentionPolicyStore(join(home, "retention-policy.json"));
  const policy = await store.set({ days, keepRunIds: [], keepMemoryIds: [] }, 0);
  return { directory, home, repo, git, store, policy };
}
async function age(path: string) { const info = await lstat(path); if (info.isDirectory()) for (const name of await readdir(path)) await age(join(path, name)); if (!info.isSymbolicLink()) await utimes(path, old, old); }
async function writeRun(f: Awaited<ReturnType<typeof fixture>>, id: string, patch: Record<string, any> = {}, workspace = false) {
  const managed = join(f.repo, ".worktrees", id), path = join(managed, "result"), branch = `codeflow/${id}/result`;
  const run = { id, repo: f.repo, project: "p-fixture", status: "done", archived: true, createdAt: +old, endedAt: +old, worktreeDir: managed, context: { paths: [], attachments: [] }, worktrees: [] as { name: string; path: string; branch: string }[], notes: [], followUps: [], watches: {}, ...patch };
  if (workspace) {
    await mkdir(managed, { recursive: true }); f.git("worktree", "add", "-qb", branch, path, "HEAD"); run.worktrees.push({ name: "result", path, branch });
    for (const folder of [join(managed, ".context/attachments"), join(path, ".codeflow-context/attachments")]) { await mkdir(folder, { recursive: true }); await writeFile(join(folder, "upload.txt"), "Staged fixture upload\n"); }
    await age(managed);
  }
  const log = join(f.home, "runs", `${id}.jsonl`); await writeFile(log, JSON.stringify({ type: "run", seq: 1, run }) + "\n"); await utimes(log, old, old);
  return run;
}
async function privateMemory(f: Awaited<ReturnType<typeof fixture>>, runId: string) {
  const store = new MemoryStore(join(f.home, "memory.json"));
  const entry = await store.propose({ scope: "private", repo: f.repo, projectId: "p-fixture", runId, memberId: "worker", title: "PRIVATE TITLE", body: "PRIVATE BODY MUST NOT APPEAR IN MANIFEST" }, { kind: "run", repo: f.repo, projectId: "p-fixture", runId, memberId: "worker", lockedDown: false, sourceTrust: "trusted" });
  const db = new DatabaseSync(store.file);
  try { db.prepare("UPDATE memories SET document=json_set(document, '$.createdAt', ?, '$.updatedAt', ?)").run(+old, +old); }
  finally { db.close(); }
  return { store, entry };
}

test("revisioned policies default to keeping all types and conflicts preserve the winning settings", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-retention-policy-"))); directories.push(directory); const file = join(directory, "policy.json");
  const first = new RetentionPolicyStore(file), other = new RetentionPolicyStore(file); const initial = await first.get(); assert.equal(initial.revision, 0); assert.deepEqual(Object.values(initial.days), [null, null, null, null]);
  const saved = await first.set({ days, keepRunIds: ["keep-run"], keepMemoryIds: [] }, 0); await assert.rejects(other.set({ days, keepRunIds: [], keepMemoryIds: [] }, 0), RetentionPolicyConflictError); assert.deepEqual(await other.get(), saved);
  if (process.platform !== "win32") assert.equal((await lstat(file)).mode & 0o777, 0o600);
  for (const invalid of [{ days: { ...days, memory: 0 } }, { days: { ...days, memory: 1.5 } }, { keepRunIds: ["../outside"] }]) await assert.rejects(first.set({ ...saved, ...invalid }, saved.revision));
  await writeFile(file, "corrupt"); await assert.rejects(first.get(), /cannot be read/); await assert.rejects(first.set(saved, saved.revision)); assert.equal(await readFile(file, "utf8"), "corrupt");
});

test("one reviewed offline plan retires each enabled type while preserving branch and provenance tombstone", async () => {
  const f = await fixture(); const run = await writeRun(f, "old", {}, true); const { store, entry } = await privateMemory(f, run.id);
  for (const suffix of [".journal.jsonl", ".checkpoint.json"]) { const path = join(f.home, "runs", run.id + suffix); await writeFile(path, "{}\n"); await utimes(path, old, old); }
  for (const suffix of [".cold-index.json", ".cold-detail.json"]) await writeFile(join(f.home, "runs", run.id + suffix), "{}\n");
  const plan = await previewRetention({ home: f.home, now });
  assert.equal(plan.truncated, false, JSON.stringify(plan.protected)); assert.deepEqual({ ...plan.summary, bytes: 0 }, { archivedRuns: 1, attachments: 1, memory: 1, worktrees: 1, bytes: 0 });
  assert.doesNotMatch(JSON.stringify(plan), /PRIVATE BODY|PRIVATE TITLE/); assert.ok(plan.targets.every((target) => /^[a-f0-9]{64}$/.test(target.fingerprint)));
  const applied = await applyRetention({ home: f.home, plan, now: now + 1000 }); assert.deepEqual(applied.failed, []); assert.equal(applied.applied.length, 4);
  await assert.rejects(access(join(f.home, "runs/old.jsonl")), /ENOENT/); await assert.rejects(access(join(run.worktreeDir, ".context/attachments/upload.txt")), /ENOENT/); await assert.rejects(access(run.worktrees[0]!.path), /ENOENT/);
  for (const suffix of [".cold-index.json", ".cold-detail.json"]) await assert.rejects(access(join(f.home, "runs", run.id + suffix)), /ENOENT/);
  assert.ok(f.git("show-ref", "--verify", `refs/heads/${run.worktrees[0]!.branch}`));
  const stored = await store.maintenanceEntries(); assert.equal(stored[0]!.id, entry.id); assert.equal(stored[0]!.status, "deleted"); assert.doesNotMatch(await readFile(store.file, "utf8"), /PRIVATE BODY|PRIVATE TITLE/);
});

test("active, resumable, unarchived, pinned, watched, child and pending deferred sources stay protected", async () => {
  const f = await fixture();
  for (const [id, patch] of [["active", { status: "running" }], ["paused", { status: "running", pauseRequested: true }], ["resumable", { status: "interrupted" }], ["stopped", { status: "stopped" }], ["unarchived", { archived: false }], ["pinned", { pinned: true }], ["watched", { watches: { result: { state: "watching" } } }], ["source", {}], ["deferred-source", {}], ["policy-pin", {}]] as const) await writeRun(f, id, patch);
  await writeRun(f, "child", { parentRunId: "source", archived: false });
  await f.store.set({ ...f.policy, keepRunIds: ["policy-pin"] }, f.policy.revision);
  const queue = new DeferredRuns({ file: join(f.home, "deferred-runs.json"), ready: async () => ({ ready: false }), launch: async () => ({ runId: "never" }) }); await queue.load(); await queue.enqueue({ run: { repo: f.repo, pattern: "solo", task: "later", roles: {}, options: {}, parentRunId: "deferred-source" } });
  const plan = await previewRetention({ home: f.home, now }); assert.equal(plan.targets.length, 0);
  for (const id of ["active", "paused", "resumable", "stopped", "unarchived", "pinned", "watched", "source", "deferred-source", "policy-pin"]) assert.ok(plan.protected.some((item) => item.kind === "archivedRuns" && item.id === id), id);
});

test("patch snapshots determine the latest archived state, pins and parent provenance before retention planning", async () => {
  const f = await fixture();
  for (const [id, initial, changed] of [
    ["archive-later", { archived: false }, { archived: true }],
    ["unarchive-later", {}, { archived: false }],
    ["pin-later", {}, { pinned: true }],
    ["parent-source", {}, {}],
    ["child", { archived: false }, { parentRunId: "parent-source" }],
  ] as const) {
    const run = await writeRun(f, id, initial), writer = new RunLogWriter(false);
    const events = [run, { ...run, ...changed }].map((snapshot, index) => writer.encode({ type: "run", seq: index + 1, ts: +old, runId: id, run: snapshot as any }));
    assert.equal(events[1]!.type, "run-patch");
    const file = join(f.home, "runs", id + ".jsonl"); await writeFile(file, events.map((event) => JSON.stringify(event)).join("\n") + "\n"); await utimes(file, old, old);
  }
  const plan = await previewRetention({ home: f.home, now });
  assert.equal(plan.truncated, false); assert.deepEqual(plan.targets.map((target) => target.runId), ["archive-later"]);
  for (const id of ["unarchive-later", "pin-later", "parent-source", "child"]) assert.ok(plan.protected.some((item) => item.kind === "archivedRuns" && item.id === id), id);
  assert.match(plan.protected.find((item) => item.id === "parent-source")!.reason, /Source of retained child/);
});

test("broken, foreign and malformed patch chains protect cleanup sources even before a later full snapshot", async () => {
  const f = await fixture();
  for (const [id, patch] of [
    ["missing-base", { base: 99, set: { archived: true } }],
    ["foreign-patch", { base: 1, runId: "another-run", set: { archived: true } }],
    ["invalid-tail", { base: 1, tail: { followUps: [99, []] } }],
  ] as const) {
    const run = await writeRun(f, id), file = join(f.home, "runs", id + ".jsonl");
    await writeFile(file, [{ type: "run", seq: 1, run }, { type: "run-patch", seq: 2, runId: id, ...patch }, { type: "run", seq: 3, run }].map((event) => JSON.stringify(event)).join("\n") + "\n"); await utimes(file, old, old);
  }
  const plan = await previewRetention({ home: f.home, now }); assert.equal(plan.truncated, true); assert.equal(plan.targets.length, 0);
  for (const id of ["missing-base", "foreign-patch", "invalid-tail"]) assert.ok(plan.protected.some((item) => item.id === id), id);
  await assert.rejects(applyRetention({ home: f.home, plan, now: now + 1000 }), /changed|truncated|incomplete/i);
  for (const id of ["missing-base", "foreign-patch", "invalid-tail"]) await access(join(f.home, "runs", id + ".jsonl"));
});

test("project guidance and any live derived reference protect memory bodies and source transcripts", async () => {
  const f = await fixture(); await writeRun(f, "source", {}, true); const { store, entry } = await privateMemory(f, "source");
  const project = await store.propose({ scope: "project", repo: f.repo, projectId: "p-fixture", title: "Published guidance", body: "Approved guidance", derivedFrom: [{ id: entry.id, revision: entry.revision }] }, { kind: "user", repo: f.repo, projectId: "p-fixture" });
  const plan = await previewRetention({ home: f.home, now }); assert.equal(plan.targets.length, 0);
  assert.match(plan.protected.find((item) => item.kind === "memory" && item.id === entry.id)!.reason, /Provenance source/); assert.match(plan.protected.find((item) => item.kind === "memory" && item.id === project.id)!.reason, /never bulk-deleted/);
  await assert.rejects(store.retireMaintenance([{ id: entry.id, revision: entry.revision }]), /provenance source/); await assert.rejects(store.retireMaintenance([{ id: project.id, revision: project.revision }]), /project guidance/);
});

test("retained coordination launch and dependency receipts preserve exact source records", async () => {
  const f = await fixture(); await writeRun(f, "coordinated-source"); const otherRepo = join(f.directory, "other-repo"); await mkdir(otherRepo); execFileSync("git", ["init", "-q", "-b", "main"], { cwd: otherRepo });
  const { CoordinatedChanges } = await import("../src/repo-coordination.js");
  const coordinator = new CoordinatedChanges({ file: join(f.home, "coordinated-changes.json"), pin: async (run) => ({ repo: run.repo, commit: "a".repeat(40) }), launch: async () => ({ runId: "coordinated-source" }), validateResult: async () => ({ status: "running" }), previewShipping: async () => { throw new Error("not used"); }, ship: async () => { throw new Error("not used"); } });
  await coordinator.load(); await coordinator.create({ project: "p-fixture", name: "Keep exact receipts", nodes: [f.repo, otherRepo].map((repo, index) => ({ id: `repo${index}`, dependsOn: index ? ["repo0"] : [], run: { repo, pattern: "solo", task: "Implement coordinated fixture", roles: {}, options: {} } })) }); await coordinator.tick();
  const plan = await previewRetention({ home: f.home, now }); assert.equal(plan.targets.length, 0); assert.ok(plan.protected.some((item) => item.id === "coordinated-source" && /retained coordinated change/.test(item.reason)));
});

test("retained code-host push and creation receipts preserve their exact archived run evidence", async () => {
  const f = await fixture(); await writeRun(f, "code-host-source"); await writeFile(join(f.home, "code-host-operations.json"), JSON.stringify({ version: 1, operations: [{ id: "a".repeat(40), previewId: "b".repeat(40), integration: "fixture", key: "new", kind: "create", status: "unknown", at: 1, runId: "code-host-source", commit: "c".repeat(40), target: "d".repeat(40), sourceBranch: `codeflow/pr/${"e".repeat(20)}`, detail: "Inspect native outcome" }] })); const plan = await previewRetention({ home: f.home, now }); assert.equal(plan.targets.length, 0); assert.ok(plan.protected.some((item) => item.id === "code-host-source" && /code host action receipt/.test(item.reason)));
});

test("any changed policy, file, reference or forged manifest aborts before deleting any target", async () => {
  for (const change of ["policy", "log", "attachment", "child", "forged"] as const) {
    const f = await fixture(); const run = await writeRun(f, "old", {}, true); const plan = await previewRetention({ home: f.home, now });
    if (change === "policy") await f.store.set({ ...f.policy, keepRunIds: ["old"] }, f.policy.revision);
    if (change === "log") { const path = join(f.home, "runs/old.jsonl"); const content = await readFile(path, "utf8"); await writeFile(path, content); await utimes(path, old, old); }
    if (change === "attachment") { const path = join(run.worktreeDir, ".context/attachments/upload.txt"); await writeFile(path, "changed upload"); await utimes(path, old, old); }
    if (change === "child") await writeRun(f, "new-child", { parentRunId: "old", archived: false });
    if (change === "forged") plan.targets[0]!.files = [{ path: join(f.directory, "outside"), bytes: 0, fingerprint: "f".repeat(64) }];
    await assert.rejects(applyRetention({ home: f.home, plan, now: now + 1000 }), /changed after preview/);
    await access(join(f.home, "runs/old.jsonl")); await access(run.worktrees[0]!.path); await access(join(run.worktreeDir, ".context/attachments/upload.txt"));
  }
});

test("dirty, hidden-index, locked and nested workspaces and tracked attachment copies are preserved", async () => {
  for (const mode of ["dirty", "hidden", "locked", "nested", "tracked-attachment"] as const) {
    const f = await fixture(); const run = await writeRun(f, "workspace", {}, true), path = run.worktrees[0]!.path;
    const git = (...args: string[]) => execFileSync("git", args, { cwd: path, encoding: "utf8" }).trim();
    if (mode === "dirty" || mode === "hidden") { if (mode === "hidden") git("update-index", "--assume-unchanged", "README.md"); await writeFile(join(path, "README.md"), "Uncommitted user work\n"); }
    if (mode === "locked") f.git("worktree", "lock", path);
    if (mode === "nested") { await mkdir(join(path, "vendor/.git"), { recursive: true }); }
    if (mode === "tracked-attachment") { git("add", "-f", ".codeflow-context/attachments/upload.txt"); git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "tracked attachment-shaped source"); }
    await age(run.worktreeDir);
    const plan = await previewRetention({ home: f.home, now });
    if (mode !== "tracked-attachment") assert.equal(plan.targets.some((item) => item.kind === "worktrees"), false, mode);
    if (mode === "tracked-attachment") { await f.store.set({ ...f.policy, days: { ...days, worktrees: null } }, f.policy.revision); const copyPlan = await previewRetention({ home: f.home, now }); assert.equal(copyPlan.targets.some((item) => item.kind === "attachments" && item.path === join(path, ".codeflow-context/attachments/upload.txt")), false); }
  }
});

test("symlinked data and changed attachment ancestors cannot escape or be applied", async () => {
  const f = await fixture(); const run = await writeRun(f, "old", {}, true); const plan = await previewRetention({ home: f.home, now });
  const folder = join(run.worktreeDir, ".context/attachments"), outside = join(f.directory, "outside"); await mkdir(outside); await writeFile(join(outside, "keep.txt"), "Do not remove"); await rm(folder, { recursive: true }); await symlink(outside, folder);
  await assert.rejects(applyRetention({ home: f.home, plan, now: now + 1000 }), /changed after preview/); assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "Do not remove");
  const log = join(f.home, "runs/old.jsonl"); await rm(log); await symlink(join(outside, "keep.txt"), log); const invalid = await previewRetention({ home: f.home, now }); assert.equal(invalid.truncated, true); await assert.rejects(applyRetention({ home: f.home, plan: invalid, now: now + 1000 }), /Incomplete/);
});

test("apply rejects an expired preview or live server lock and CLI preview/apply use the reviewed file", async () => {
  const f = await fixture(); await writeRun(f, "old"); const plan = await previewRetention({ home: f.home, now });
  await assert.rejects(applyRetention({ home: f.home, plan, now: now + 25 * 60 * 60_000 }), /last 24 hours/);
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  try { await writeFile(join(f.home, "server.lock"), String(child.pid)); await assert.rejects(applyRetention({ home: f.home, plan, now: now + 1000 }), /Another code-flow server/); }
  finally { child.kill("SIGKILL"); await rm(join(f.home, "server.lock"), { force: true }); }
  const output = join(f.directory, "reviewed.json");
  assert.throws(() => execFileSync(process.execPath, ["--import", "tsx", "scripts/maintenance.ts", "retention", "--days", "30", "--home", f.home, "--apply"], { cwd: root, env: { ...process.env, CODEFLOW_HOME: f.home }, stdio: "pipe" }), /Age-only retention cannot delete data/);
  await access(join(f.home, "runs/old.jsonl"));
  execFileSync(process.execPath, ["--import", "tsx", "scripts/maintenance.ts", "retention-policy", "--home", f.home, "--output", output], { cwd: root, env: { ...process.env, CODEFLOW_HOME: f.home } });
  const saved = JSON.parse(await readFile(output, "utf8")) as RetentionPreview; assert.equal(saved.summary.archivedRuns, 1); await access(join(f.home, "runs/old.jsonl"));
  const result = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "scripts/maintenance.ts", "retention", "--home", f.home, "--plan", output, "--apply"], { cwd: root, env: { ...process.env, CODEFLOW_HOME: f.home }, encoding: "utf8" })); assert.equal(result.failed.length, 0); assert.equal(result.applied.length, 1); await assert.rejects(access(join(f.home, "runs/old.jsonl")), /ENOENT/);
});
