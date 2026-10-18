import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-conventions-module-"));
const { ConventionsStore, MAX_CONVENTION_REVISIONS, CONVENTIONS_PATH } = await import("../src/conventions.js");
const { readConventions } = await import("../src/learnings.js");
async function fixture(t: { after: (fn: () => unknown) => void }) {
  const folder = await mkdtemp(join(tmpdir(), "codeflow-conventions-")); const home = join(folder, "data"); const repo = join(folder, "repo");
  t.after(() => rm(folder, { recursive: true, force: true })); await mkdir(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main"); await writeFile(join(repo, "README.md"), "fixture\n"); await writeFile(join(repo, "AGENTS.md"), "Keep vendor guidance.\n");
  git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial");
  return { folder, home, repo, git, store: new ConventionsStore(home), guard: { actor: "user" as const, repos: [repo], isIdle: () => true } };
}
const conflict = (error: unknown) => (error as { status?: number }).status === 409;

test("conventions use exact CAS across instances and restore previews create immutable new revisions", async (t) => {
  const { home, store } = await fixture(t); const second = new ConventionsStore(home);
  assert.equal((await store.get("project")).revision, 0);
  const first = await store.save("project", { revision: 0, text: "Use focused tests.", note: "First guidance" });
  assert.equal(first.revision, 1); assert.equal(first.text, "Use focused tests.\n");
  const results = await Promise.allSettled([store.save("project", { revision: 1, text: "Review public APIs." }), second.save("project", { revision: 1, text: "Do not overwrite another edit." })]);
  assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
  const rejected = results.find((entry) => entry.status === "rejected") as PromiseRejectedResult; assert.ok(conflict(rejected.reason));
  const preview = await store.previewRestore("project", 1); assert.equal(preview.text, first.text); assert.equal(preview.revision, 2);
  await assert.rejects(store.restore("project", { ...preview, hash: "0".repeat(64) }), conflict);
  const restored = await store.restore("project", preview); assert.equal(restored.revision, 3); assert.equal(restored.text, first.text);
  assert.equal(restored.history[0]!.restoredFrom, 1); assert.equal((await store.previewRestore("project", 1)).hash, first.hash);
  await assert.rejects(store.restore("project", preview), conflict);
  const files = await readdir(join(home, "conventions"));
  if (process.platform !== "win32") assert.equal((await lstat(join(home, "conventions", files[0]!))).mode & 0o777, 0o600);
});

test("conventions bound retained history and reject invalid text, corruption and symlink storage without replacing it", async (t) => {
  const { home, store, folder } = await fixture(t); let current = await store.get("bounded");
  for (let i = 0; i < MAX_CONVENTION_REVISIONS + 2; i++) current = await store.save("bounded", { revision: current.revision, text: `Revision ${i}` });
  assert.equal(current.history.length, MAX_CONVENTION_REVISIONS); assert.equal(current.history.at(-1)!.revision, 3);
  await assert.rejects(store.previewRestore("bounded", 1), /no longer retained/);
  await assert.rejects(store.save("bounded", { revision: current.revision, text: "🧪".repeat(20000) }), /64 KiB/);
  await assert.rejects(store.save("bounded", { revision: current.revision, text: "bad\0binary" }), /plain text/);
  await assert.rejects(store.save("bounded", { revision: undefined as unknown as number, text: "missing CAS" }), /exact current/);
  const file = join(home, "conventions", (await readdir(join(home, "conventions")))[0]!); const saved = await readFile(file);
  await writeFile(file, "{broken"); await assert.rejects(store.save("bounded", { revision: current.revision, text: "must not erase corruption" }));
  assert.equal(await readFile(file, "utf8"), "{broken"); await writeFile(file, saved);
  assert.equal((await store.save("bounded", { revision: current.revision, text: "Recovered write queue" })).revision, current.revision + 1);
  await rename(join(home, "conventions"), join(folder, "moved")); await symlink(join(folder, "moved"), join(home, "conventions"));
  await assert.rejects(store.save("bounded", { revision: current.revision + 1, text: "no symlink writes" }), /private directory/);
});

test("publishing explicitly writes and stages one file, while only committed guidance enters dispatch", async (t) => {
  const { store, repo, git, guard } = await fixture(t);
  const version = await store.save("project", { revision: 0, text: "Shared project rules take priority." });
  assert.doesNotMatch(await readConventions(repo, "HEAD"), /Shared project/);
  const source = await store.inspectRepository(repo); assert.equal(source.exists, false); assert.equal(source.clean, true);
  const result = await store.publish("project", { repo, revision: version.revision, sourceHash: source.sourceHash, head: source.head }, guard);
  assert.equal(result.staged, true); assert.equal(result.requiresCommit, true); assert.equal(git("rev-parse", "HEAD"), source.head);
  assert.equal(git("diff", "--cached", "--name-only"), CONVENTIONS_PATH); assert.equal(await readFile(join(repo, CONVENTIONS_PATH), "utf8"), version.text);
  assert.doesNotMatch(await readConventions(repo, "HEAD"), /Shared project/);
  git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "publish guidance");
  const context = await readConventions(repo, "HEAD"); assert.match(context, /Shared project/); assert.match(context, /Keep vendor guidance/); assert.ok(context.startsWith(`### ${CONVENTIONS_PATH}`));
});

test("publishing rejects stale revisions, changed source hashes, non-project repositories and active work", async (t) => {
  const { store, repo, git, guard } = await fixture(t);
  const version = await store.save("project", { revision: 0, text: "Guidance" }); const source = await store.inspectRepository(repo);
  const input = { repo, revision: version.revision, sourceHash: source.sourceHash, head: source.head };
  await assert.rejects(store.publish("project", input, { ...guard, repos: [] }), (error: unknown) => (error as { status: number }).status === 403);
  await assert.rejects(store.publish("project", input, { ...guard, actor: "agent" as "user" }), /explicit user/);
  await assert.rejects(store.publish("project", input, { ...guard, isIdle: () => false }), /activity/);
  await writeFile(join(repo, ".gitignore"), `${CONVENTIONS_PATH}\n`); git("add", ".gitignore"); git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "ignore private guidance");
  await mkdir(join(repo, ".codeflow")); await writeFile(join(repo, CONVENTIONS_PATH), "Existing ignored text\n"); const ignored = await store.inspectRepository(repo); assert.equal(ignored.clean, true);
  await writeFile(join(repo, CONVENTIONS_PATH), "Concurrent ignored edit\n");
  await assert.rejects(store.publish("project", { ...input, head: ignored.head, sourceHash: ignored.sourceHash }, guard), /guidance or HEAD changed/);
  assert.equal(await readFile(join(repo, CONVENTIONS_PATH), "utf8"), "Concurrent ignored edit\n");
  const latest = await store.inspectRepository(repo); await store.save("project", { revision: version.revision, text: "New private revision" });
  await assert.rejects(store.publish("project", { ...input, head: latest.head, sourceHash: latest.sourceHash }, guard), conflict);
});

test("publication holds the private revision lock until staging finishes and recovers from index failures", async (t) => {
  const { store, repo, git, guard } = await fixture(t); await store.save("project", { revision: 0, text: "Reviewed revision" }); const source = await store.inspectRepository(repo);
  let release!: () => void; let entered!: () => void; const hold = new Promise<void>((resolve) => { release = resolve; }); const started = new Promise<void>((resolve) => { entered = resolve; });
  const publishing = store.publish("project", { repo, revision: 1, sourceHash: source.sourceHash, head: source.head }, { ...guard, isIdle: async () => { entered(); await hold; return true; } });
  await started; const saving = store.save("project", { revision: 1, text: "Later draft" }); release();
  assert.equal((await publishing).revision, 1); assert.equal((await saving).revision, 2); assert.equal(git("show", `:${CONVENTIONS_PATH}`), "Reviewed revision");
  git("reset", "-q", "HEAD", "--", CONVENTIONS_PATH); await rm(join(repo, CONVENTIONS_PATH));
  const clean = await store.inspectRepository(repo); await writeFile(join(repo, ".git", "index.lock"), "held");
  try { await assert.rejects(store.publish("project", { repo, revision: 2, sourceHash: clean.sourceHash, head: clean.head }, guard)); }
  finally { await rm(join(repo, ".git", "index.lock")); }
  assert.equal(await lstat(join(repo, CONVENTIONS_PATH)).then(() => true, () => false), false); assert.equal(git("status", "--porcelain"), "");
});

test("publication refuses directory/file symlinks, .git markers and binary source files", async (t) => {
  const { store, repo, folder } = await fixture(t); const outside = join(folder, "outside"); await mkdir(outside); await writeFile(join(outside, "conventions.md"), "do not alter\n");
  await symlink(outside, join(repo, ".codeflow")); await assert.rejects(store.inspectRepository(repo), /symbolic/);
  await rm(join(repo, ".codeflow")); await mkdir(join(repo, ".codeflow")); await symlink(join(outside, "conventions.md"), join(repo, CONVENTIONS_PATH));
  await assert.rejects(store.inspectRepository(repo), /regular conventions/); assert.equal(await readFile(join(outside, "conventions.md"), "utf8"), "do not alter\n");
  await rm(join(repo, CONVENTIONS_PATH)); await writeFile(join(repo, CONVENTIONS_PATH), Buffer.from([0xff, 0xfe])); await assert.rejects(store.inspectRepository(repo));
  await rename(join(repo, ".git"), join(repo, ".git-real")); await symlink(join(repo, ".git-real"), join(repo, ".git"));
  await assert.rejects(store.inspectRepository(repo), /symbolic .git/);
});
