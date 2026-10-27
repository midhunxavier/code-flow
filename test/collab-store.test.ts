import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";

const root = mkdtempSync(join(tmpdir(), "codeflow-collab-store-")); process.env.CODEFLOW_HOME = join(root, "home");
// Everything from src is imported after CODEFLOW_HOME is set, or the store's default directory (and server.log) would land in ~/.codeflow.
const { CODEFLOW_HOME } = await import("../src/config.js"); assert.equal(CODEFLOW_HOME, process.env.CODEFLOW_HOME, "src/config.js loaded before CODEFLOW_HOME was set");
const { CollabStore, ownerActor, memberActor, RUNNER_LOCAL } = await import("../src/collab/store.js");
const { CollabError, MAX, RUNNER_TOKEN, busyAttempt, liveAttempt, latestCheckpoint, reviewState } = await import("../src/collab/model.js");
type MemberRecord = import("../src/collab/store.js").MemberRecord; type ChangeEvent = import("../src/collab/store.js").ChangeEvent; type CollabActor = import("../src/collab/model.js").CollabActor; type Task = import("../src/collab/model.js").Task; type SharedRole = import("../src/shared-accounts.js").SharedRole;
after(() => rmSync(root, { recursive: true, force: true }));

const HEX40 = "a".repeat(40), BASE = "b".repeat(40), HEAD = "c".repeat(40);
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const member = (userId: string, role?: SharedRole, extra: Partial<MemberRecord> = {}): MemberRecord => ({ userId, username: userId, displayName: userId[0]!.toUpperCase() + userId.slice(1), enabled: true, roles: role ? { "p-1": role } : {}, ...extra });
let cases = 0;
/** A fresh team directory with a controllable clock, mutable members (so accounts can be disabled mid-test) and two projects; only p-1 has members. */
function fixture() {
  const dir = join(root, `case-${++cases}`); let clock = 1_700_000_000_000;
  const members: MemberRecord[] = [member("alice", "contributor"), member("bob", "contributor"), member("maya", "maintainer"), member("rita", "reviewer"), member("vic", "viewer"), member("zed")];
  const projects = [{ id: "p-1", name: "App" }, { id: "p-2", name: "Other" }], options = { dir, members: () => members, projects: () => projects, now: () => clock, ownerName: () => "Mx" };
  const store = new CollabStore(options), actor = (userId: string, via: "browser" | "runner" = "browser", runnerId?: string) => memberActor(members.find((m) => m.userId === userId)!, via, runnerId);
  return { dir, store, members, projects, actor, tick: (ms = 1000) => (clock += ms), now: () => clock, reopen: () => new CollabStore(options) };
}
type Fixture = ReturnType<typeof fixture>;
const owner = ownerActor("Mx");
async function refuses(run: Promise<unknown>, status: number, pattern: RegExp) { try { await run; } catch (error) { assert.ok(error instanceof CollabError, `expected a CollabError, got ${String(error)}`); assert.equal(error.status, status, error.message); assert.match(error.message, pattern); return; } assert.fail(`expected a refusal matching ${pattern}`); }
/** The usual board: repository key `app` on p-1 and one task owned by alice. */
async function seeded(f: Fixture, extra: Record<string, unknown> = {}) { await f.store.load(); await f.store.setRepositories(owner, "p-1", [{ key: "app", label: "App" }, { key: "docs", label: "Docs" }], 0); return f.store.createTask(owner, { projectId: "p-1", repository: "app", title: "Ship it", goal: "Make it ship", acceptance: "Tests pass", owner: "alice", ...extra }); }
/** alice's runner credential, authenticated the way the server would. */
async function runnerFor(f: Fixture, userId: string, name = "laptop") { const { runner, token } = await f.store.registerRunner(userId, name); const auth = f.store.authenticateRunner(token); assert.deepEqual(auth, { runnerId: runner.id, userId }); return { runner, token, actor: f.actor(userId, "runner", runner.id) }; }
const claim = (f: Fixture, actor: CollabActor, task: Task, runnerId: string, overrides: Record<string, unknown> = {}) => f.store.claimAttempt(actor, task.id, { attemptId: randomBytes(16).toString("hex"), runnerId, runnerName: "laptop", baseCommit: BASE, revision: task.revision, ...overrides } as never);
const manifest = (data: Buffer, overrides: Record<string, unknown> = {}) => ({ commit: HEAD, baseCommit: BASE, branch: "team/t-0123456789abcdef/0123abcd", size: data.length, sha256: sha256(data), note: "", requirements: "Ship it", decisions: [], remaining: "", changedFiles: ["src/a.ts"], ...overrides });
const listing = (dir: string) => readdirSync(dir).sort();

test("removed stakeholders receive no new notifications and old inbox items follow current project access", async () => {
  const f = fixture(), task = await seeded(f, { collaborators: ["bob"], reviewer: "rita" });
  await f.store.comment(owner, task.id, "Before removal @alice @bob @rita");
  for (const id of ["alice", "bob", "rita"]) {
    assert.ok((await f.store.inbox(f.actor(id))).unread > 0);
    f.members.find((member) => member.userId === id)!.roles = { "p-2": "viewer" };
  }
  await f.store.comment(owner, task.id, "Confidential update after removal");
  for (const id of ["alice", "bob", "rita"]) {
    assert.deepEqual(await f.store.inbox(f.actor(id)), { items: [], unread: 0 });
    assert.equal((await f.store.board(f.actor(id))).inboxUnread, 0);
    assert.deepEqual(await f.store.markRead(f.actor(id), "all"), { unread: 0 });
    f.members.find((member) => member.userId === id)!.roles["p-1"] = "contributor";
    const restored = await f.store.inbox(f.actor(id));
    assert.ok(restored.unread > 0, "hidden notifications were not marked read");
    assert.ok(restored.items.every((item) => !item.text.includes("after removal")), "no notification was delivered while access was absent");
  }
  f.projects.splice(0, 1);
  assert.deepEqual(await f.store.inbox(f.actor("alice")), { items: [], unread: 0 }, "deleted projects hide retained notifications too");
  assert.equal((await f.store.board(f.actor("alice"))).inboxUnread, 0);
  await f.store.close();
});

test("project maintainers cannot inspect or revoke account-wide runners belonging to anyone else", async () => {
  const f = fixture(); await seeded(f);
  f.members.find((member) => member.userId === "bob")!.roles = { "p-2": "contributor" };
  const alice = await runnerFor(f, "alice"), bob = await runnerFor(f, "bob"), maya = await runnerFor(f, "maya");
  assert.deepEqual((await f.store.runners(f.actor("maya"))).map((runner) => runner.id), [maya.runner.id]);
  for (const other of [alice, bob]) {
    await refuses(f.store.revokeRunner(f.actor("maya"), other.runner.id), 404, /Runner not found/);
    assert.ok(f.store.authenticateRunner(other.token));
  }
  assert.equal((await f.store.runners(owner)).length, 3);
  await f.store.revokeRunner(f.actor("maya"), maya.runner.id);
  await f.store.revokeRunner(owner, bob.runner.id);
  assert.equal(f.store.authenticateRunner(maya.token), undefined);
  assert.equal(f.store.authenticateRunner(bob.token), undefined);
  await f.store.close();
});

test("unknown attempts retain ownership until reconciliation or an authorized, audited recovery confirms execution stopped", async () => {
  const f = fixture(), task = await seeded(f), first = await runnerFor(f, "alice"), second = await runnerFor(f, "alice", "desktop");
  let current = await claim(f, first.actor, task, first.runner.id);
  const id = current.attempts[0]!.id;
  await f.store.attemptProgress(first.actor, id, { seq: 1, runStatus: "running" });
  f.tick(24 * 60 * 60_000);
  assert.equal((await f.store.prune()).attempts, 1);
  assert.equal((await f.store.prune()).attempts, 0, "an unknown attempt is not repeatedly expired");
  current = await f.store.task(owner, task.id);
  assert.equal(current.attempts[0]!.endedAt, undefined, "silence is not an execution end");
  await refuses(claim(f, second.actor, current, second.runner.id), 409, /Stop the attempt/);
  await refuses(f.store.updateTask(f.actor("maya"), task.id, { owner: "bob" }, current.revision), 409, /Stop the attempt/);
  await refuses(f.store.offerHandoff(f.actor("alice"), task.id, { to: "bob", checkpointId: "a".repeat(32) }, current.revision), 409, /Stop the attempt/);
  await f.store.attemptProgress(first.actor, id, { seq: 2, runStatus: "running" });
  current = await f.store.task(owner, task.id); assert.equal(current.attempts[0]!.state, "running", "the same runner reconciles without a second claim");
  const recovery = { revision: current.revision, reason: "Checked the laptop: the agent was stopped", confirmedStopped: true };
  await refuses(f.store.recoverAttempt(f.actor("alice"), id, recovery), 409, /is connected and reports this attempt as running; recovery is only for an attempt whose runner lost contact/);
  await f.store.revokeRunner(owner, first.runner.id); current = await f.store.task(owner, task.id); recovery.revision = current.revision;
  await refuses(claim(f, second.actor, current, second.runner.id), 409, /Stop the attempt/);
  await refuses(f.store.recoverAttempt(f.actor("bob"), id, recovery), 403, /Only the task owner/);
  await refuses(f.store.recoverAttempt(f.actor("vic"), id, recovery), 403, /Only the task owner/);
  await refuses(f.store.recoverAttempt(f.actor("alice"), id, { ...recovery, confirmedStopped: false }), 400, /Confirm/);
  await refuses(f.store.recoverAttempt(f.actor("alice"), id, { ...recovery, reason: "" }), 400, /recovery reason/i);
  await refuses(f.store.recoverAttempt(f.actor("alice"), id, { ...recovery, revision: current.revision - 1 }), 409, /changed/);
  current = await f.store.recoverAttempt(f.actor("alice"), id, recovery);
  assert.equal(current.attempts[0]!.state, "superseded"); assert.equal(current.audit.at(-1)!.action, "attempt-recovered"); assert.equal(current.audit.at(-1)!.by.userId, "alice");
  await refuses(f.store.attemptProgress(first.actor, id, { seq: 3 }), 409, /superseded/);
  await refuses(f.store.heartbeat(first.actor, id), 409, /superseded/);
  await refuses(f.store.addCheckpoint(first.actor, id, manifest(Buffer.from("late"))), 409, /superseded/);
  current = await claim(f, second.actor, current, second.runner.id);
  assert.deepEqual(current.attempts.map((attempt) => attempt.state), ["superseded", "claimed"]);
  await f.store.close();
});

test("round trip: documents are written atomically with 0600 and reload to the same board, task and inbox", async () => {
  const f = fixture(), created = await seeded(f, { reviewer: "rita", labels: ["backend"], collaborators: ["bob"] });
  assert.match(created.id, /^t-[a-f0-9]{16}$/); assert.equal(created.revision, 1); assert.deepEqual(created.owner, { userId: "alice", displayName: "Alice" }); assert.deepEqual(created.reviewer, { userId: "rita", displayName: "Rita" }); assert.equal(created.audit.length, 1); assert.equal(created.audit[0]!.action, "created");
  const commented = await f.store.comment(f.actor("rita"), created.id, "Looks good @alice, @bob please check @owner too"); assert.equal(commented.revision, 2); assert.deepEqual(commented.discussion[0]!.mentions, ["alice", "bob", "owner"]);
  await f.store.decide(f.actor("alice"), created.id, "Use the new API");
  assert.deepEqual(listing(f.dir), ["board.json", "checkpoints", "inbox.json"], "no temp files survive a write, and runners.json waits for its first runner"); for (const name of ["board.json", "inbox.json"]) assert.equal(statSync(join(f.dir, name)).mode & 0o777, 0o600, name); assert.equal(statSync(join(f.dir, "checkpoints")).mode & 0o777, 0o700);
  const stored = JSON.parse(readFileSync(join(f.dir, "board.json"), "utf8")); assert.equal(stored.version, 1); assert.equal(stored.revision, 4); assert.deepEqual(stored.projects["p-1"].repositories, [{ key: "app", label: "App" }, { key: "docs", label: "Docs" }]);
  const again = f.reopen(); await again.load(); assert.equal(again.available, true);
  assert.deepEqual(await again.task(owner, created.id), await f.store.task(owner, created.id)); assert.deepEqual(await again.board(f.actor("alice")), await f.store.board(f.actor("alice"))); assert.deepEqual(await again.inbox(f.actor("bob")), await f.store.inbox(f.actor("bob")));
  const board = await again.board(f.actor("alice")); assert.equal(board.revision, 4); assert.deepEqual(board.projects.map((p) => p.id), ["p-1"], "alice sees only projects where she holds a role"); assert.equal(board.projects[0]!.role, "contributor");
  assert.deepEqual(board.projects[0]!.members.map((m) => [m.userId, m.role, m.online]), [["owner", "maintainer", true], ["alice", "contributor", false], ["bob", "contributor", false], ["maya", "maintainer", false], ["rita", "reviewer", false], ["vic", "viewer", false]]); assert.equal(board.projects[0]!.members[0]!.displayName, "Mx");
  assert.equal(board.tasks.length, 1); assert.equal(board.tasks[0]!.unreadMentions, 1); assert.equal(board.inboxUnread, 2, "assigned + mention"); assert.deepEqual(board.me, { userId: "alice", displayName: "Alice", via: "browser", roles: { "p-1": "contributor" }, runners: [] });
  const ownerBoard = await again.board(owner); assert.deepEqual(ownerBoard.projects.map((p) => p.id), ["p-1", "p-2"]); assert.deepEqual(ownerBoard.me.roles, { "p-1": "maintainer", "p-2": "maintainer" }); assert.equal(ownerBoard.inboxUnread, 1, "the owner was mentioned");
  await refuses(again.board(f.actor("alice"), "p-2"), 404, /Project not found/); assert.equal((await again.board(owner, "p-2")).tasks.length, 0);
});

test("a corrupt or unexpected document is moved aside and the board starts empty but writable; an unreadable one makes every mutation a 503", async () => {
  const f = fixture(), created = await seeded(f);
  const text = readFileSync(join(f.dir, "board.json"), "utf8"), stored = JSON.parse(text); stored.tasks[0].extra = true; writeFileSync(join(f.dir, "board.json"), JSON.stringify(stored));
  const strict = f.reopen(); await strict.load(); assert.equal(strict.available, true); assert.equal((await strict.board(owner)).tasks.length, 0, "a task with an unknown field is not loaded");
  const aside = listing(f.dir).filter((name) => name.startsWith("board.json.corrupt-")); assert.equal(aside.length, 1); assert.equal(JSON.parse(readFileSync(join(f.dir, aside[0]!), "utf8")).tasks[0].id, created.id, "the original is kept aside, not deleted");
  await strict.setRepositories(owner, "p-1", [{ key: "app", label: "App" }], 0); const fresh = await strict.createTask(owner, { projectId: "p-1", repository: "app", title: "Again" }); assert.notEqual(fresh.id, created.id);
  writeFileSync(join(f.dir, "inbox.json"), "{not json"); const parse = f.reopen(); await parse.load(); assert.equal(parse.available, true); assert.equal(listing(f.dir).filter((name) => name.startsWith("inbox.json.corrupt-")).length, 1); assert.deepEqual(await parse.inbox(f.actor("alice")), { items: [], unread: 0 });
  const log = readFileSync(join(CODEFLOW_HOME, "server.log"), "utf8"); assert.match(log, /board\.json is unusable \(task has an unknown field \\"extra\\"\): moved it to/); assert.match(log, /inbox\.json is unusable \(not valid JSON/);
  const blocked = fixture(); mkdirSync(blocked.dir, { recursive: true }); mkdirSync(join(blocked.dir, "board.json")); await blocked.store.load(); assert.equal(blocked.store.available, false);
  await refuses(blocked.store.createTask(owner, { projectId: "p-1", repository: "app", title: "x" }), 503, /Team storage is unavailable; repair the files in .* then restart code-flow/); await refuses(blocked.store.board(owner), 503, /unavailable/); assert.ok(statSync(join(blocked.dir, "board.json")).isDirectory(), "nothing is written over an unreadable document");
  const linked = fixture(); mkdirSync(linked.dir, { recursive: true }); writeFileSync(join(linked.dir, "real.json"), JSON.stringify({ version: 1, runners: [] })); symlinkSync(join(linked.dir, "real.json"), join(linked.dir, "runners.json")); await linked.store.load(); assert.equal(linked.store.available, false, "symlinked storage is refused (O_NOFOLLOW)");
  await refuses(linked.store.registerRunner("alice", "laptop"), 503, /unavailable/); assert.ok(existsSync(join(linked.dir, "real.json")));
});

test("stale writers get 409 on the task revision and on the board revision; a missing revision is a 400", async () => {
  const f = fixture(), created = await seeded(f);
  const results = await Promise.allSettled([f.store.updateTask(owner, created.id, { title: "First" }, 1), f.store.updateTask(f.actor("maya"), created.id, { title: "Second" }, 1)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1); const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult; assert.ok(lost.reason instanceof CollabError); assert.equal(lost.reason.status, 409); assert.equal(lost.reason.message, "Task changed; reload before saving");
  const task = await f.store.task(owner, created.id); assert.equal(task.revision, 2); assert.ok(["First", "Second"].includes(task.title));
  await refuses(f.store.updateTask(owner, created.id, { title: "Third" }, undefined), 400, /Send the task's current revision/); await refuses(f.store.updateTask(owner, created.id, { title: "Third" }, "2"), 409, /Task changed/); await refuses(f.store.deleteTask(owner, created.id, 1), 409, /Task changed/);
  await refuses(f.store.setRepositories(owner, "p-1", [{ key: "app", label: "App" }], 0), 409, /Team board changed; reload before saving/); const board = await f.store.board(owner); await f.store.setRepositories(owner, "p-1", [{ key: "app", label: "App" }], board.revision);
  await refuses(f.store.setRepositories(owner, "p-1", [{ key: "other", label: "Other" }], board.revision + 1), 409, /Task “(First|Second)” still uses repository app/);
  await refuses(f.store.updateTask(owner, created.id, { title: "x", projectId: "p-2" }, 2), 400, /Tasks cannot move between projects/); await refuses(f.store.updateTask(owner, created.id, { repository: "nope" }, 2), 400, /Choose the repository from this project's keys: app/);
});

test("roles are enforced inside the store: viewers read, reviewers discuss, contributors own and run, maintainers assign and delete", async () => {
  const f = fixture(); await f.store.load(); await f.store.setRepositories(owner, "p-1", [{ key: "app", label: "App" }], 0); const input = { projectId: "p-1", repository: "app", title: "Unowned" };
  await refuses(f.store.createTask(f.actor("vic"), input), 403, /A project contributor role is required to create tasks/); await refuses(f.store.createTask(f.actor("rita"), input), 403, /contributor role is required to create/); await refuses(f.store.createTask(f.actor("zed"), input), 404, /Project not found/); await refuses(f.store.createTask(f.actor("alice"), { ...input, projectId: "p-2" }), 404, /Project not found/);
  await refuses(f.store.createTask(f.actor("alice"), { ...input, owner: "bob" }), 403, /Only a project maintainer may assign a task to someone else/); await refuses(f.store.createTask(f.actor("alice"), { ...input, owner: "vic" }), 400, /The owner needs at least the contributor role/); await refuses(f.store.createTask(f.actor("alice"), { ...input, owner: "zed" }), 400, /Choose the owner from the project's members/); await refuses(f.store.createTask(f.actor("alice"), { ...input, reviewer: "vic" }), 400, /The reviewer needs at least the reviewer role/);
  const mine = await f.store.createTask(f.actor("alice"), { ...input, owner: "alice" }); assert.equal(mine.owner?.userId, "alice"); const task = await f.store.createTask(f.actor("alice"), input); assert.equal(task.owner, undefined);
  await refuses(f.store.setRepositories(f.actor("alice"), "p-1", [{ key: "app", label: "App" }], 2), 403, /A project maintainer role is required to define repositories/);
  await refuses(f.store.task(f.actor("zed"), task.id), 404, /Task not found/); assert.equal((await f.store.task(f.actor("vic"), task.id)).id, task.id); await refuses(f.store.task(owner, "t-ffffffffffffffff"), 404, /Task not found/);
  await refuses(f.store.comment(f.actor("vic"), task.id, "hi"), 403, /A project reviewer role is required to comment/); const commented = await f.store.comment(f.actor("rita"), task.id, "hi"); assert.equal(commented.discussion.length, 1); await refuses(f.store.decide(f.actor("rita"), task.id, "x"), 403, /contributor role is required to add decisions/);
  await refuses(claim(f, f.actor("rita", "runner", "r-0123456789abcdef"), task, "r-0123456789abcdef"), 403, /A project contributor role is required to run tasks/);
  await refuses(f.store.updateTask(f.actor("bob"), task.id, { owner: "alice" }, commented.revision), 403, /Only a project maintainer may assign a task to someone else/); const taken = await f.store.updateTask(f.actor("bob"), task.id, { owner: "bob" }, commented.revision); assert.equal(taken.owner?.userId, "bob"); assert.equal(taken.audit.at(-1)!.detail, "owner");
  await refuses(f.store.updateTask(f.actor("alice"), task.id, { owner: "alice" }, taken.revision), 403, /Only a project maintainer may reassign a task that already has an owner/); await refuses(f.store.updateTask(f.actor("alice"), task.id, { owner: null }, taken.revision), 403, /Only the task owner or a project maintainer may unassign/);
  const reassigned = await f.store.updateTask(f.actor("maya"), task.id, { owner: "alice" }, taken.revision); assert.equal(reassigned.owner?.userId, "alice"); const released = await f.store.updateTask(f.actor("alice"), task.id, { owner: null }, reassigned.revision); assert.equal(released.owner, undefined);
  assert.deepEqual((await f.store.inbox(f.actor("bob"))).items, [], "bob's self-assign is not an inbox item"); assert.deepEqual((await f.store.inbox(f.actor("alice"))).items.map((i) => i.kind), ["assigned"], "alice's own self-assign was not an inbox item, maya's assignment was");
  await refuses(f.store.deleteTask(f.actor("alice"), task.id, released.revision), 403, /A project maintainer role is required to delete tasks/); assert.deepEqual(await f.store.deleteTask(f.actor("maya"), task.id, released.revision), { deleted: true }); await refuses(f.store.task(owner, task.id), 404, /Task not found/);
  await refuses(f.store.updateTask(f.actor("vic"), mine.id, { title: "x" }, mine.revision), 403, /A project contributor role is required to edit tasks/);
  // Asking for a review is a contributor's action (the route table and docs say so; reviewers record reviews, they do not assign them).
  await refuses(f.store.requestReview(f.actor("rita"), mine.id, "rita", mine.revision), 403, /A project contributor role is required to request reviews/); await refuses(f.store.requestReview(f.actor("vic"), mine.id, "rita", mine.revision), 403, /contributor role is required to request reviews/);
  const asked = await f.store.requestReview(f.actor("alice"), mine.id, "rita", mine.revision); assert.deepEqual(asked.reviewer, { userId: "rita", displayName: "Rita" }); assert.equal(asked.discussion.at(-1)!.kind, "review-request"); assert.equal((await f.store.inbox(f.actor("rita"))).items[0]!.kind, "review-requested");
});

test("claims: owner's own machine only, idempotent on the attempt id, refused while another attempt is busy, and the task goes to working", async () => {
  const f = fixture(), task = await seeded(f), alice = await runnerFor(f, "alice"), bob = await runnerFor(f, "bob", "desktop");
  await refuses(claim(f, f.actor("alice"), task, alice.runner.id), 403, /Start attempts from your own code-flow .*not from the browser/); await refuses(claim(f, alice.actor, task, bob.runner.id), 403, /runnerId must be the runner id of the credential/); await refuses(claim(f, bob.actor, task, bob.runner.id), 403, /Only the task owner may start an attempt; take the task first/);
  await refuses(claim(f, owner, task, RUNNER_LOCAL), 403, /Only the task owner/); await refuses(claim(f, alice.actor, task, alice.runner.id, { attemptId: "short" }), 400, /32 lowercase hexadecimal/); await refuses(claim(f, alice.actor, task, alice.runner.id, { baseCommit: "main" }), 400, /full lowercase commit hash/); await refuses(claim(f, alice.actor, task, alice.runner.id, { revision: 7 }), 409, /Task changed/);
  const attemptId = randomBytes(16).toString("hex"), claimed = await claim(f, alice.actor, task, alice.runner.id, { attemptId }); assert.equal(claimed.status, "working"); assert.equal(claimed.revision, 2); assert.equal(claimed.attempts.length, 1);
  assert.deepEqual(claimed.attempts[0], { id: attemptId, taskId: task.id, runnerId: alice.runner.id, runnerName: "laptop", user: { userId: "alice", displayName: "Alice", via: "runner" }, state: "claimed", baseCommit: BASE, createdAt: f.now(), lastSeq: 0, lastHeartbeatAt: f.now(), progress: { updatedAt: f.now() } }); assert.equal(claimed.audit.at(-1)!.action, "attempt-claimed");
  const again = await claim(f, alice.actor, claimed, alice.runner.id, { attemptId, revision: 99 }); assert.deepEqual(again, claimed, "the same attempt id is idempotent, whatever the revision says");
  await refuses(claim(f, alice.actor, claimed, alice.runner.id), 409, /Stop the attempt running on laptop before starting another/); await refuses(f.store.updateTask(f.actor("maya"), task.id, { owner: "bob" }, claimed.revision), 409, /Stop the attempt running on laptop before changing the owner/); await refuses(f.store.updateTask(f.actor("alice"), task.id, { status: "done" }, claimed.revision), 409, /before marking the task done/);
  await refuses(f.store.deleteTask(owner, task.id, claimed.revision), 409, /Stop the attempt running on laptop before deleting the task/);
  const other = await f.store.createTask(owner, { projectId: "p-1", repository: "app", title: "Mine", owner: "owner" }); await refuses(claim(f, owner, other, "r-0123456789abcdef"), 400, /send runnerId "local"/);
  const local = await claim(f, owner, other, RUNNER_LOCAL); assert.equal(local.attempts[0]!.runnerId, "local"); assert.deepEqual(local.attempts[0]!.user, { userId: "owner", displayName: "Mx", via: "local" });
  await refuses(claim(f, alice.actor, claimed, alice.runner.id, { attemptId: local.attempts[0]!.id }), 409, /already belongs to another attempt/);
  // Done is the owner's decision: a claim moves Planned, Blocked or In review to Working but never reopens a finished task on its own.
  const finished = await f.store.createTask(owner, { projectId: "p-1", repository: "app", title: "Shipped", owner: "alice", status: "done" }); await refuses(claim(f, alice.actor, finished, alice.runner.id), 409, /Move the task out of Done before starting an attempt/); assert.equal((await f.store.task(owner, finished.id)).status, "done"); assert.equal((await f.store.task(owner, finished.id)).attempts.length, 0);
  const reopened = await f.store.updateTask(f.actor("alice"), finished.id, { status: "review" }, finished.revision); assert.equal((await claim(f, alice.actor, reopened, alice.runner.id)).status, "working");
});

test("a progress report revives a paused attempt only while it is current and no hand-over is offered", async () => {
  const f = fixture(), task = await seeded(f), alice = await runnerFor(f, "alice"), bob = await runnerFor(f, "bob");
  const a1 = (await claim(f, alice.actor, task, alice.runner.id)).attempts[0]!.id; await f.store.attemptProgress(alice.actor, a1, { seq: 1 }); await f.store.finishAttempt(alice.actor, a1, { state: "paused" });
  let current = await f.store.task(owner, task.id); const a2 = (await claim(f, alice.actor, current, alice.runner.id, { runnerName: "desk" })).attempts[1]!.id;
  // A newer claim permanently supersedes older paused work; even a stale report cannot revive it.
  await refuses(f.store.attemptProgress(alice.actor, a1, { seq: 2 }), 409, /superseded/);
  current = await f.store.task(owner, task.id); assert.deepEqual(current.attempts.map((a) => a.state), ["superseded", "claimed"]); assert.equal(busyAttempt(current)!.id, a2);
  await refuses(f.store.attemptProgress(alice.actor, a1, { seq: 1 }), 409, /superseded/);
  await f.store.attemptProgress(alice.actor, a2, { seq: 1 }); await f.store.finishAttempt(alice.actor, a2, { state: "paused" });
  // An offered hand-over holds the current paused attempt: whoever accepts gets the task, nobody resumes under it.
  const data = Buffer.from("bundle"), checkpoint = await f.store.addCheckpoint(alice.actor, a2, manifest(data)); await f.store.storeBundle(alice.actor, checkpoint.id, Readable.from([data]), { size: data.length, sha256: checkpoint.sha256 });
  current = await f.store.task(owner, task.id); const offered = await f.store.offerHandoff(f.actor("alice"), task.id, { to: "bob", checkpointId: checkpoint.id }, current.revision);
  await refuses(f.store.attemptProgress(alice.actor, a2, { seq: 2 }), 409, /Accept, decline or cancel the offered hand-over before resuming the attempt/); await refuses(f.store.attemptProgress(alice.actor, a1, { seq: 2 }), 409, /superseded/);
  assert.deepEqual((await f.store.task(owner, task.id)).attempts.map((a) => a.state), ["superseded", "paused"]); assert.equal((await f.store.task(owner, task.id)).handoff?.state, "offered");
  await f.store.respondHandoff(f.actor("alice"), task.id, offered.handoff!.id, "cancel", offered.revision);
  const resumed = await f.store.attemptProgress(alice.actor, a2, { seq: 2 }); assert.equal(resumed.attempt.state, "running", "with nothing busy and nothing offered, the latest paused attempt resumes"); assert.equal(resumed.attempt.endedAt, undefined);
  await refuses(f.store.attemptProgress(alice.actor, a1, { seq: 2 }), 409, /superseded/); await refuses(f.store.attemptProgress(bob.actor, a2, { seq: 2 }), 403, /Only the runner executing this attempt/);
  assert.equal((await f.store.heartbeat(alice.actor, a2)).attempt.state, "running", "a heartbeat never changes an attempt's state");
  const reopened = f.reopen(); await reopened.load(); assert.deepEqual((await reopened.task(owner, task.id)).attempts.map((a) => a.state), ["superseded", "running"], "a revive is a state change and is on disk at once");
});

test("a revive is refused on a Done task, and a change of hands supersedes a stopped attempt like a paused one", async () => {
  const f = fixture(), task = await seeded(f), alice = await runnerFor(f, "alice");
  const a1 = (await claim(f, alice.actor, task, alice.runner.id)).attempts[0]!.id; await f.store.attemptProgress(alice.actor, a1, { seq: 1 }); await f.store.finishAttempt(alice.actor, a1, { state: "stopped", reason: "step budget reached" });
  let current = await f.store.task(owner, task.id); current = await f.store.updateTask(f.actor("alice"), task.id, { status: "done" }, current.revision); assert.equal(current.status, "done", "a stopped attempt is not busy, so the owner may close the task");
  // Done is the owner's decision: a budget-stopped attempt's next report (a stale Resume) must not reopen it, exactly as a claim is refused there.
  await refuses(f.store.attemptProgress(alice.actor, a1, { seq: 2 }), 409, /Move the task out of Done before resuming the attempt/); assert.equal((await f.store.task(owner, task.id)).attempts[0]!.state, "stopped"); assert.equal((await f.store.task(owner, task.id)).status, "done");
  current = await f.store.updateTask(f.actor("alice"), task.id, { status: "working" }, current.revision); assert.equal((await f.store.attemptProgress(alice.actor, a1, { seq: 2 })).attempt.state, "running", "out of Done, the same report resumes the attempt");
  await f.store.finishAttempt(alice.actor, a1, { state: "stopped" }); current = await f.store.task(owner, task.id);
  // A stopped attempt is resumable and would stay a live handle on a task its user no longer owns: reassignment supersedes it as it does a paused one, so the old owner's machine cannot revive it.
  const reassigned = await f.store.updateTask(f.actor("maya"), task.id, { owner: "bob" }, current.revision); assert.equal(reassigned.owner?.userId, "bob"); assert.equal(reassigned.attempts[0]!.state, "superseded");
  await refuses(f.store.attemptProgress(alice.actor, a1, { seq: 3 }), 409, /superseded/); assert.equal((await f.store.task(owner, task.id)).attempts[0]!.state, "superseded");
});

test("bundle uploads leave no temp files: a task deleted mid-upload or a failed rename removes the file, and the next load sweeps what a crash left behind", async () => {
  const f = fixture(), task = await seeded(f), alice = await runnerFor(f, "alice"), attemptId = (await claim(f, alice.actor, task, alice.runner.id)).attempts[0]!.id, dir = join(f.dir, "checkpoints"), data = randomBytes(4096);
  const checkpoint = await f.store.addCheckpoint(alice.actor, attemptId, manifest(data)); await f.store.finishAttempt(alice.actor, attemptId, { state: "paused" });
  // the body streams in while a maintainer deletes the task (allowed: the attempt is paused, as during a hand-over); the queued step then finds no checkpoint, and the temp file goes with the refusal
  let release!: () => void, started!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }), begun = new Promise<void>((resolve) => { started = resolve; });
  async function* slow() { yield data.subarray(0, 1000); started(); await gate; yield data.subarray(1000); }
  const upload = f.store.storeBundle(alice.actor, checkpoint.id, slow(), { size: data.length, sha256: checkpoint.sha256 }); await begun;
  assert.equal(listing(dir).filter((name) => /^[a-f0-9]{32}\.bundle\.[a-f0-9]{12}\.tmp$/.test(name)).length, 1, "the body streams to a temp file beside the bundles");
  const current = await f.store.task(owner, task.id); assert.deepEqual(await f.store.deleteTask(f.actor("maya"), task.id, current.revision), { deleted: true }); release();
  await refuses(upload, 404, /Checkpoint not found/); assert.deepEqual(listing(dir), [], "the refused upload's temp file is removed");
  // a folder squatting on the bundle path makes the rename fail: a 503 without the hub's paths, the checkpoint stays pending, no temp file remains, and the upload lands once the folder is gone
  const other = await f.store.createTask(owner, { projectId: "p-1", repository: "app", title: "Other", owner: "alice" }), otherAttempt = (await claim(f, alice.actor, other, alice.runner.id)).attempts[0]!.id, second = await f.store.addCheckpoint(alice.actor, otherAttempt, manifest(data));
  const squatter = join(dir, `${second.id}.bundle`); mkdirSync(squatter);
  await refuses(f.store.storeBundle(alice.actor, second.id, Readable.from([data]), { size: data.length, sha256: second.sha256 }), 503, /^Team storage could not store the checkpoint bundle; check the team server's checkpoints folder \(see server\.log\), then upload it again$/);
  assert.deepEqual(listing(dir), [`${second.id}.bundle`], "nothing beside the squatter"); assert.equal((await f.store.task(owner, other.id)).checkpoints[0]!.bundle, "pending"); assert.match(readFileSync(join(CODEFLOW_HOME, "server.log"), "utf8"), /could not be moved into place/);
  rmSync(squatter, { recursive: true }); assert.equal((await f.store.storeBundle(alice.actor, second.id, Readable.from([data]), { size: data.length, sha256: second.sha256 })).bundle, "available"); assert.ok(readFileSync(squatter).equals(data));
  // a crash leaves files behind: temp files of interrupted uploads and bundles the board never saw become available; the next load removes them and keeps the referenced bundle and whatever it does not recognise
  const orphan = `${randomBytes(16).toString("hex")}.bundle`, partial = `${second.id}.bundle.${randomBytes(6).toString("hex")}.tmp`; writeFileSync(join(dir, orphan), "orphan"); writeFileSync(join(dir, partial), "partial"); writeFileSync(join(dir, "notes.txt"), "keep");
  const swept = f.reopen(); await swept.load(); assert.deepEqual(listing(dir), ["notes.txt", `${second.id}.bundle`].sort()); assert.ok(readFileSync(squatter).equals(data)); assert.match(readFileSync(join(CODEFLOW_HOME, "server.log"), "utf8"), /Removed 2 stale checkpoint file\(s\)/);
  assert.deepEqual(await swept.bundlePath(f.actor("bob"), second.id), { path: squatter, checkpoint: (await swept.task(owner, other.id)).checkpoints[0] });
  // a board set aside as corrupt may be repaired by hand, so its bundles are kept; temp files still go
  writeFileSync(join(dir, orphan), "orphan"); writeFileSync(join(dir, partial), "partial"); writeFileSync(join(f.dir, "board.json"), "{not json");
  const degraded = f.reopen(); await degraded.load(); assert.equal(degraded.available, true); assert.equal((await degraded.board(owner)).tasks.length, 0); assert.deepEqual(listing(dir), ["notes.txt", orphan, `${second.id}.bundle`].sort());
});

test("telemetry is write-behind: heartbeats and progress on a running attempt rewrite nothing, ride along with the next durable change, never stall it, and are flushed on close", async () => {
  const f = fixture(); mkdirSync(f.dir, { recursive: true }); const now = f.now(), who = { userId: "owner", displayName: "Mx" }, goal = "g".repeat(16 * 1024), acceptance = "a".repeat(8 * 1024);
  const tasks = Array.from({ length: 300 }, (_, i) => ({ id: `t-${i.toString(16).padStart(16, "0")}`, projectId: "p-1", repository: "app", title: `Task ${i}`, goal, acceptance, status: "planned", owner: { userId: "alice", displayName: "Alice" }, collaborators: [], dependsOn: [], labels: [], revision: 1, createdAt: now, updatedAt: now, createdBy: who, attempts: [], checkpoints: [], decisions: [], discussion: [], instructions: [], reviews: [], handoffs: [], audit: [{ at: now, by: who, action: "created" }] }));
  writeFileSync(join(f.dir, "board.json"), JSON.stringify({ version: 1, revision: 1, projects: { "p-1": { repositories: [{ key: "app", label: "App" }] } }, tasks })); const file = join(f.dir, "board.json"); assert.ok(statSync(file).size > 7 * 1024 * 1024, "a board big enough for a full rewrite to cost tens of milliseconds");
  await f.store.load(); const alice = await runnerFor(f, "alice"), attemptId = (await claim(f, alice.actor, await f.store.task(owner, tasks[0]!.id), alice.runner.id)).attempts[0]!.id, onDisk = () => JSON.parse(readFileSync(file, "utf8")).tasks[0].attempts[0];
  const events: ChangeEvent[] = []; f.store.onChange((event) => events.push(event));
  f.tick(1000); assert.equal((await f.store.attemptProgress(alice.actor, attemptId, { seq: 1, runId: "run-1" })).attempt.state, "running"); assert.equal(onDisk().state, "running", "the first report moves claimed to running and is written at once");
  f.tick(1000); const beats = Array.from({ length: 100 }, () => f.store.heartbeat(alice.actor, attemptId)), reports = Array.from({ length: 20 }, (_, i) => f.store.attemptProgress(alice.actor, attemptId, { seq: 2 + i, stage: `step ${i}` }));
  const started = performance.now(), commented = await f.store.comment(f.actor("maya"), tasks[1]!.id, "please answer"), waited = performance.now() - started; await Promise.all([...beats, ...reports]);
  assert.equal(commented.discussion.length, 1); assert.ok(waited < 1500, `a comment queued behind 120 telemetry calls on a ${Math.round(statSync(file).size / 1024 / 1024)} MiB board waited ${Math.round(waited)} ms`);
  const carried = onDisk(); assert.equal(carried.lastHeartbeatAt, f.now()); assert.equal(carried.progress.stage, "step 19"); assert.equal(carried.lastSeq, 21, "the comment's write carried the telemetry along");
  assert.ok(events.filter((event) => event.kind === "task" && event.taskId === tasks[0]!.id).length >= 2, "listeners hear telemetry at once");
  f.tick(1000); await f.store.heartbeat(alice.actor, attemptId); assert.equal((await f.store.attemptProgress(alice.actor, attemptId, { seq: 22, stage: "idle" })).attempt.progress.stage, "idle");
  const stale = onDisk(); assert.equal(stale.lastHeartbeatAt, f.now() - 1000, "telemetry alone rewrites nothing"); assert.equal(stale.progress.stage, "step 19"); assert.equal((await f.store.task(owner, tasks[0]!.id)).attempts[0]!.progress.stage, "idle", "but it is what the board shows"); assert.equal((await f.store.board(owner)).tasks[0]!.attempt?.lastHeartbeatAt, f.now());
  await f.store.close(); const flushed = onDisk(); assert.equal(flushed.progress.stage, "idle"); assert.equal(flushed.lastHeartbeatAt, f.now(), "close flushes what the write-behind still held");
  f.tick(1000); await f.store.finishAttempt(alice.actor, attemptId, { state: "paused" }); assert.equal(onDisk().state, "paused", "a stop is written at once");
  const reopened = f.reopen(); await reopened.load(); assert.equal((await reopened.task(owner, tasks[0]!.id)).attempts[0]!.progress.stage, "idle");
});

test("the 16 MiB board limit names what frees space: deleting a checkpoint keeps its manifest, deleting a task shrinks the board", async () => {
  const f = fixture(); mkdirSync(f.dir, { recursive: true }); const now = f.now(), who = { userId: "owner", displayName: "Mx" }, limit = 16 * 1024 * 1024;
  const comment = (i: number, text: string) => ({ id: `c-${i.toString(16).padStart(16, "0")}`, by: who, text, mentions: [], at: now, kind: "comment" });
  const tasks = Array.from({ length: MAX.tasks }, (_, i) => ({ id: `t-${i.toString(16).padStart(16, "0")}`, projectId: "p-1", repository: "app", title: `Task ${i}`, goal: "g".repeat(16 * 1024), acceptance: "a".repeat(8 * 1024), status: "planned", collaborators: [], dependsOn: [], labels: [], revision: 1, createdAt: now, updatedAt: now, createdBy: who, attempts: [], checkpoints: [], decisions: [], discussion: [] as ReturnType<typeof comment>[], instructions: [], reviews: [], handoffs: [], audit: [{ at: now, by: who, action: "created" }] }));
  const document = { version: 1, revision: 1, projects: { "p-1": { repositories: [{ key: "app", label: "App" }] } }, tasks }, target = limit - 1500;
  // Fill the discussions until the document sits 1500 bytes under the limit, so the board loads but one more 4000-character comment cannot be written.
  for (let i = 0; Buffer.byteLength(JSON.stringify(document)) < target - 4200; i++) tasks[i % tasks.length]!.discussion.push(comment(i, "x".repeat(4000)));
  const last = comment(99_999, ""); tasks[0]!.discussion.push(last); last.text = "y".repeat(target - Buffer.byteLength(JSON.stringify(document)));
  const size = Buffer.byteLength(JSON.stringify(document)); assert.equal(size, target); writeFileSync(join(f.dir, "board.json"), JSON.stringify(document));
  await f.store.load(); assert.equal(f.store.available, true); assert.equal((await f.store.board(owner)).tasks.length, MAX.tasks);
  await refuses(f.store.comment(f.actor("rita"), tasks[1]!.id, "z".repeat(4000)), 413, /^The team board has reached its 16 MiB storage limit; delete finished tasks first$/);
  assert.equal(statSync(join(f.dir, "board.json")).size, size, "a refused write leaves the file as it was"); assert.equal((await f.store.task(owner, tasks[1]!.id)).discussion.length, tasks[1]!.discussion.length, "and the board as it was");
  assert.deepEqual(await f.store.deleteTask(owner, tasks[2]!.id, 1), { deleted: true }); assert.ok(statSync(join(f.dir, "board.json")).size < size - 20_000, "deleting a task is what makes room");
  assert.equal((await f.store.comment(f.actor("rita"), tasks[1]!.id, "z".repeat(4000))).discussion.at(-1)!.text.length, 4000);
});

test("progress is ordered by seq and never bumps revisions, heartbeats keep the attempt live, and finishing is idempotent and terminal", async () => {
  const f = fixture(), task = await seeded(f), alice = await runnerFor(f, "alice"), bob = await runnerFor(f, "bob"), claimed = await claim(f, alice.actor, task, alice.runner.id), attemptId = claimed.attempts[0]!.id;
  await refuses(f.store.attemptProgress(bob.actor, attemptId, { seq: 1 }), 403, /Only the runner executing this attempt may report on it/); await refuses(f.store.attemptProgress(f.actor("alice"), attemptId, { seq: 1 }), 403, /Only the runner/); await refuses(f.store.attemptProgress(alice.actor, "0".repeat(32), { seq: 1 }), 404, /Attempt not found/);
  await refuses(f.store.attemptProgress(alice.actor, attemptId, { seq: 0 }), 400, /positive whole number/); await refuses(f.store.attemptProgress(alice.actor, attemptId, { seq: 1, bogus: true }), 400, /Unknown progress field/);
  f.tick(5000); const first = await f.store.attemptProgress(alice.actor, attemptId, { seq: 1, runId: "run-1", stage: "builder", steps: { done: 1, total: 3 }, changedFiles: ["a.ts"] }); assert.equal(first.attempt.state, "running"); assert.equal(first.attempt.startedAt, f.now()); assert.equal(first.attempt.lastSeq, 1); assert.equal(first.attempt.runId, "run-1"); assert.deepEqual(first.attempt.progress, { updatedAt: f.now(), stage: "builder", steps: { done: 1, total: 3 }, changedFiles: ["a.ts"] });
  const stale = await f.store.attemptProgress(alice.actor, attemptId, { seq: 1, stage: "ignored" }); assert.equal(stale.attempt.progress.stage, "builder", "a duplicate seq is a no-op");
  await f.store.attemptProgress(alice.actor, attemptId, { seq: 3, stage: "reviewer", head: HEAD }); const older = await f.store.attemptProgress(alice.actor, attemptId, { seq: 2, stage: "late" }); assert.equal(older.attempt.progress.stage, "reviewer"); assert.equal(older.attempt.lastSeq, 3); assert.equal(older.attempt.head, HEAD);
  const after = await f.store.task(owner, task.id); assert.equal(after.revision, claimed.revision, "progress does not bump the task revision"); assert.equal((await f.store.board(owner)).revision, 3, "nor the board revision (repositories, create, claim)"); assert.equal(after.audit.length, claimed.audit.length);
  assert.ok(liveAttempt(after, f.now())); f.tick(MAX.heartbeatLiveMs); assert.equal(liveAttempt(after, f.now()), undefined, "no heartbeat for 90 s means not live");
  const beat = await f.store.heartbeat(alice.actor, attemptId); assert.equal(beat.attempt.lastHeartbeatAt, f.now()); assert.deepEqual(beat.instructions, []); assert.ok(liveAttempt(await f.store.task(owner, task.id), f.now())); await refuses(f.store.heartbeat(bob.actor, attemptId), 403, /Only the runner/);
  const summary = (await f.store.board(f.actor("vic"))).tasks[0]!; assert.equal(summary.attempt?.state, "running"); assert.equal(summary.attempt?.lastHeartbeatAt, f.now()); assert.equal(summary.attempt?.progress.stage, "reviewer");
  await refuses(f.store.finishAttempt(alice.actor, attemptId, { state: "done" } as never), 400, /Choose the final state/); await refuses(f.store.finishAttempt(bob.actor, attemptId, { state: "finished" }), 403, /Only the runner/);
  const paused = await f.store.finishAttempt(alice.actor, attemptId, { state: "paused", reason: "laptop lid closed" }); assert.equal(paused.attempt.state, "paused"); assert.equal(paused.attempt.endedAt, f.now()); assert.equal(paused.attempt.reason, "laptop lid closed"); assert.equal((await f.store.task(owner, task.id)).revision, claimed.revision + 1, "finishing bumps the revision");
  const resumed = await f.store.attemptProgress(alice.actor, attemptId, { seq: 4, stage: "builder" }); assert.equal(resumed.attempt.state, "running", "a paused attempt resumes with its next report"); assert.equal(resumed.attempt.endedAt, undefined);
  const finished = await f.store.finishAttempt(alice.actor, attemptId, { state: "finished", head: HEAD, summary: "All green" }); assert.equal(finished.attempt.state, "finished"); assert.equal(finished.attempt.progress.summary, "All green"); assert.equal(finished.attempt.head, HEAD);
  assert.deepEqual(await f.store.finishAttempt(alice.actor, attemptId, { state: "finished" }), finished, "a retried finish is idempotent"); await refuses(f.store.finishAttempt(alice.actor, attemptId, { state: "failed" }), 409, /already ended as finished/); await refuses(f.store.attemptProgress(alice.actor, attemptId, { seq: 5 }), 409, /already ended as finished; start a new attempt/); await refuses(f.store.heartbeat(alice.actor, attemptId), 409, /already ended/);
  const done = await f.store.task(owner, task.id); assert.equal(done.status, "working", "finishing keeps the status"); assert.deepEqual(done.audit.slice(-2).map((a) => a.action), ["attempt-paused", "attempt-finished"]);
  assert.deepEqual((await f.store.inbox(f.actor("alice"))).items.filter((i) => i.kind.startsWith("attempt-")), [], "a runner's own finish is never an inbox item for the same person");
});

test("checkpoints: bounded manifests, bundles verified by size and digest while streaming, downloads for contributors, deletion by maintainers, reviews attached to checkpoints", async () => {
  const f = fixture(), task = await seeded(f), alice = await runnerFor(f, "alice"), claimed = await claim(f, alice.actor, task, alice.runner.id), attemptId = claimed.attempts[0]!.id, data = randomBytes(2048);
  await refuses(f.store.addCheckpoint(alice.actor, attemptId, manifest(data, { size: MAX.bundle + 1 })), 400, /between 1 byte and 64 MiB/); await refuses(f.store.addCheckpoint(alice.actor, attemptId, manifest(data, { sha256: "nope" })), 400, /64 lowercase hex/); await refuses(f.store.addCheckpoint(f.actor("alice"), attemptId, manifest(data)), 403, /Only the runner executing/);
  const checkpoint = await f.store.addCheckpoint(alice.actor, attemptId, manifest(data, { note: "halfway", testResults: { ok: true, command: "npm test", at: f.now() } })); assert.equal(checkpoint.bundle, "pending"); assert.equal(checkpoint.ref, `refs/codeflow/team/${checkpoint.id}`); assert.equal(checkpoint.size, 2048); assert.deepEqual(checkpoint.createdBy, { userId: "alice", displayName: "Alice", via: "runner" });
  const withCheckpoint = await f.store.task(owner, task.id); assert.equal(withCheckpoint.attempts[0]!.checkpointId, checkpoint.id); assert.equal(withCheckpoint.attempts[0]!.head, HEAD); assert.equal(withCheckpoint.revision, claimed.revision + 1); assert.equal((await f.store.board(owner)).tasks[0]!.checkpoint?.id, checkpoint.id);
  await refuses(f.store.bundlePath(f.actor("bob"), checkpoint.id), 404, /Checkpoint bundle is not available/);
  await refuses(f.store.storeBundle(alice.actor, checkpoint.id, Readable.from([data]), { size: data.length, sha256: sha256(Buffer.from("other")) }), 400, /must match the checkpoint manifest/);
  await refuses(f.store.storeBundle(alice.actor, checkpoint.id, Readable.from([randomBytes(2048)]), { size: 2048, sha256: checkpoint.sha256 }), 400, /does not match the checkpoint's size or sha256 digest/);
  await refuses(f.store.storeBundle(alice.actor, checkpoint.id, Readable.from([data, Buffer.from("x")]), { size: 2048, sha256: checkpoint.sha256 }), 400, /larger than the checkpoint manifest says/);
  await refuses(f.store.storeBundle(alice.actor, checkpoint.id, Readable.from([data.subarray(0, 100)]), { size: 2048, sha256: checkpoint.sha256 }), 400, /does not match/);
  await refuses(f.store.storeBundle(f.actor("bob", "runner", "r-0123456789abcdef"), checkpoint.id, Readable.from([data]), { size: 2048, sha256: checkpoint.sha256 }), 403, /Only the runner executing/);
  assert.deepEqual(listing(join(f.dir, "checkpoints")), [], "failed uploads leave no temp files");
  const stored = await f.store.storeBundle(alice.actor, checkpoint.id, Readable.from([data.subarray(0, 1000), data.subarray(1000)]), { size: 2048, sha256: checkpoint.sha256 }); assert.equal(stored.bundle, "available");
  const file = join(f.dir, "checkpoints", `${checkpoint.id}.bundle`); assert.deepEqual(listing(join(f.dir, "checkpoints")), [`${checkpoint.id}.bundle`]); assert.equal(statSync(file).mode & 0o777, 0o600); assert.ok(readFileSync(file).equals(data));
  await refuses(f.store.storeBundle(alice.actor, checkpoint.id, Readable.from([data]), { size: 2048, sha256: checkpoint.sha256 }), 409, /already uploaded/);
  assert.deepEqual(await f.store.bundlePath(f.actor("bob"), checkpoint.id), { path: file, checkpoint: stored }); await refuses(f.store.bundlePath(f.actor("rita"), checkpoint.id), 403, /A project contributor role is required to download checkpoint bundles/); await refuses(f.store.bundlePath(f.actor("zed"), checkpoint.id), 404, /Checkpoint not found/);
  const current = await f.store.task(owner, task.id); await refuses(f.store.review(f.actor("vic"), task.id, { checkpointId: checkpoint.id, verdict: "approve", text: "" }, current.revision), 403, /A project reviewer role is required to record reviews/);
  await refuses(f.store.review(f.actor("rita"), task.id, { checkpointId: "0".repeat(32), verdict: "approve" }, current.revision), 404, /Checkpoint not found/); await refuses(f.store.review(f.actor("rita"), task.id, { checkpointId: checkpoint.id, verdict: "maybe" } as never, current.revision), 400, /Choose a verdict/);
  const reviewed = await f.store.review(f.actor("rita"), task.id, { checkpointId: checkpoint.id, verdict: "approve", text: "Ship it @alice" }, current.revision); assert.equal(reviewed.reviews[0]!.stale, false); assert.equal(reviewed.reviews[0]!.commit, HEAD); assert.equal(reviewState(reviewed), "approved"); assert.equal((await f.store.board(owner)).tasks[0]!.reviewState, "approved");
  assert.deepEqual((await f.store.inbox(f.actor("alice"))).items.slice(0, 2).map((i) => i.kind), ["review-recorded", "mention"]);
  await f.store.addCheckpoint(alice.actor, attemptId, manifest(randomBytes(10), { commit: "d".repeat(40) })); const afterSecond = await f.store.task(owner, task.id); assert.equal(afterSecond.reviews[0]!.stale, true, "a newer checkpoint makes earlier reviews stale"); assert.equal(reviewState(afterSecond), "none"); assert.equal(latestCheckpoint(afterSecond)!.commit, "d".repeat(40));
  const late = await f.store.review(f.actor("rita"), task.id, { checkpointId: checkpoint.id, verdict: "request-changes" }, afterSecond.revision); assert.equal(late.reviews[1]!.stale, true, "reviewing an older checkpoint is stale at once"); assert.equal(reviewState(late), "none");
  await refuses(f.store.deleteCheckpoint(f.actor("alice"), checkpoint.id), 403, /A project maintainer role is required to delete checkpoints/); const deleted = await f.store.deleteCheckpoint(f.actor("maya"), checkpoint.id); assert.equal(deleted.bundle, "deleted"); assert.equal(existsSync(file), false); assert.deepEqual(await f.store.deleteCheckpoint(f.actor("maya"), checkpoint.id), deleted, "idempotent");
  await refuses(f.store.bundlePath(f.actor("bob"), checkpoint.id), 404, /not available/); assert.equal((await f.store.task(owner, task.id)).checkpoints.length, 2, "the manifest stays for the reviews that reference it");
});

test("a manifest may name its checkpoint: the id becomes the checkpoint's id and ref, a duplicate anywhere on the board is a 409, a malformed one a 400, and a manifest without one gets a generated id", async () => {
  const f = fixture(), task = await seeded(f), alice = await runnerFor(f, "alice"), claimed = await claim(f, alice.actor, task, alice.runner.id), attemptId = claimed.attempts[0]!.id, id = randomBytes(16).toString("hex");
  const named = await f.store.addCheckpoint(alice.actor, attemptId, manifest(Buffer.from("one"), { id })); assert.equal(named.id, id); assert.equal(named.ref, `refs/codeflow/team/${id}`); assert.equal((await f.store.task(owner, task.id)).attempts[0]!.checkpointId, id);
  await refuses(f.store.addCheckpoint(alice.actor, attemptId, manifest(Buffer.from("two"), { id, commit: "d".repeat(40) })), 409, /A checkpoint with this id already exists/);
  const other = await f.store.createTask(owner, { projectId: "p-1", repository: "app", title: "Other", owner: "alice" }), otherAttempt = (await claim(f, alice.actor, other, alice.runner.id)).attempts[0]!.id;
  await refuses(f.store.addCheckpoint(alice.actor, otherAttempt, manifest(Buffer.from("three"), { id })), 409, /already exists/); await refuses(f.store.addCheckpoint(alice.actor, otherAttempt, manifest(Buffer.from("three"), { id: "short" })), 400, /Send the checkpoint id as 32 lowercase hexadecimal characters/);
  const generated = await f.store.addCheckpoint(alice.actor, otherAttempt, manifest(Buffer.from("three"))); assert.match(generated.id, /^[a-f0-9]{32}$/); assert.notEqual(generated.id, id); assert.equal(generated.ref, `refs/codeflow/team/${generated.id}`);
  assert.equal((await f.store.task(owner, task.id)).checkpoints.length, 1, "a refused duplicate changes nothing"); assert.equal((await f.store.task(owner, other.id)).checkpoints.length, 1);
  const reopened = f.reopen(); await reopened.load(); assert.equal((await reopened.task(owner, task.id)).checkpoints[0]!.id, id, "the id the runner chose is what the board stores");
});

test("at most 200 bundles stay on disk: the oldest bundle of a done task is evicted, otherwise the upload fails with 507", async () => {
  const f = fixture(); await seeded(f); const alice = await runnerFor(f, "alice"), tasks: Task[] = [];
  for (let i = 0; i < 5; i++) tasks.push(await f.store.createTask(owner, { projectId: "p-1", repository: "app", title: `T${i}`, owner: "alice" }));
  const attempts: string[] = []; for (const task of tasks) attempts.push((await claim(f, alice.actor, task, alice.runner.id)).attempts[0]!.id);
  const upload = async (attemptId: string, data: Buffer) => { const checkpoint = await f.store.addCheckpoint(alice.actor, attemptId, manifest(data)); f.tick(10); return f.store.storeBundle(alice.actor, checkpoint.id, Readable.from([data]), { size: data.length, sha256: checkpoint.sha256 }); };
  for (let i = 0; i < MAX.bundlesOnDisk; i++) await upload(attempts[i % 5]!, Buffer.from(`bundle-${i}`));
  assert.equal(listing(join(f.dir, "checkpoints")).length, MAX.bundlesOnDisk);
  await refuses(upload(attempts[0]!, Buffer.from("one more")), 507, /Team checkpoint storage is full; delete checkpoints of finished tasks first/); assert.equal(listing(join(f.dir, "checkpoints")).length, MAX.bundlesOnDisk, "the refused upload leaves nothing behind");
  await f.store.finishAttempt(alice.actor, attempts[0]!, { state: "finished" }); const t0 = await f.store.task(owner, tasks[0]!.id); await f.store.updateTask(f.actor("alice"), t0.id, { status: "done" }, t0.revision);
  const stored = await upload(attempts[1]!, Buffer.from("after done")); assert.equal(stored.bundle, "available"); assert.equal(listing(join(f.dir, "checkpoints")).length, MAX.bundlesOnDisk);
  const evictedFrom = await f.store.task(owner, tasks[0]!.id), oldest = evictedFrom.checkpoints[0]!; assert.equal(oldest.bundle, "deleted"); assert.equal(existsSync(join(f.dir, "checkpoints", `${oldest.id}.bundle`)), false); assert.equal(evictedFrom.checkpoints[1]!.bundle, "available"); assert.equal(evictedFrom.audit.at(-1)!.action, "bundle-evicted");
});

test("hand-over: offered by the owner at an available checkpoint to a contributor; accept moves the task and supersedes paused attempts; decline and cancel leave the owner", async () => {
  const f = fixture(), task = await seeded(f), alice = await runnerFor(f, "alice"), bob = await runnerFor(f, "bob"), claimed = await claim(f, alice.actor, task, alice.runner.id), attemptId = claimed.attempts[0]!.id, data = Buffer.from("bundle");
  const checkpoint = await f.store.addCheckpoint(alice.actor, attemptId, manifest(data)); let current = await f.store.task(owner, task.id);
  await refuses(f.store.offerHandoff(f.actor("alice"), task.id, { to: "bob", checkpointId: checkpoint.id, note: "" }, current.revision), 409, /Stop the attempt running on laptop before handing the task over/);
  await f.store.finishAttempt(alice.actor, attemptId, { state: "paused" }); current = await f.store.task(owner, task.id);
  await refuses(f.store.offerHandoff(f.actor("alice"), task.id, { to: "bob", checkpointId: checkpoint.id }, current.revision), 409, /bundle is not on the hub/);
  await f.store.storeBundle(alice.actor, checkpoint.id, Readable.from([data]), { size: data.length, sha256: checkpoint.sha256 }); current = await f.store.task(owner, task.id);
  await refuses(f.store.offerHandoff(f.actor("bob"), task.id, { to: "bob", checkpointId: checkpoint.id }, current.revision), 403, /Only the task owner or a project maintainer may hand the task over/);
  await refuses(f.store.offerHandoff(f.actor("alice"), task.id, { to: "rita", checkpointId: checkpoint.id }, current.revision), 400, /The teammate needs at least the contributor role/); await refuses(f.store.offerHandoff(f.actor("alice"), task.id, { to: "alice", checkpointId: checkpoint.id }, current.revision), 400, /other than the task's current owner/); await refuses(f.store.offerHandoff(f.actor("alice"), task.id, { to: "bob", checkpointId: "0".repeat(32) }, current.revision), 404, /Checkpoint not found/);
  await refuses(f.store.offerHandoff(f.actor("alice"), task.id, { to: "bob", checkpointId: checkpoint.id }, current.revision - 1), 409, /Task changed/);
  let offered = await f.store.offerHandoff(f.actor("alice"), task.id, { to: "bob", checkpointId: checkpoint.id, note: "Take it from here @maya" }, current.revision); assert.equal(offered.handoff?.state, "offered"); assert.deepEqual(offered.handoff?.to, { userId: "bob", displayName: "Bob" }); assert.equal(offered.owner?.userId, "alice"); assert.equal(offered.discussion.at(-1)!.kind, "system");
  assert.deepEqual((await f.store.inbox(f.actor("bob"))).items.map((i) => i.kind), ["handoff-offered"]); assert.deepEqual((await f.store.inbox(f.actor("maya"))).items.map((i) => i.kind), ["mention"]); assert.equal((await f.store.board(f.actor("bob"))).tasks[0]!.handoff?.state, "offered");
  await refuses(f.store.offerHandoff(f.actor("alice"), task.id, { to: "bob", checkpointId: checkpoint.id }, offered.revision), 409, /already offered/); await refuses(claim(f, alice.actor, offered, alice.runner.id), 409, /Accept, decline or cancel the offered hand-over before starting an attempt/); await refuses(f.store.updateTask(f.actor("alice"), task.id, { status: "done" }, offered.revision), 409, /before marking the task done/);
  await refuses(f.store.deleteCheckpoint(f.actor("maya"), checkpoint.id), 409, /Cancel the offered hand-over before deleting its checkpoint/);
  await refuses(f.store.respondHandoff(f.actor("maya"), task.id, offered.handoff!.id, "accept", offered.revision), 403, /Only the teammate the task was offered to may accept or decline/); await refuses(f.store.respondHandoff(f.actor("bob"), task.id, offered.handoff!.id, "cancel", offered.revision), 403, /Only the teammate who offered the hand-over or a project maintainer may cancel/);
  await refuses(f.store.respondHandoff(f.actor("bob"), task.id, "h-0000000000000000", "accept", offered.revision), 404, /Hand-over not found/); await refuses(f.store.respondHandoff(f.actor("bob"), task.id, offered.handoff!.id, "accept", 1), 409, /Task changed/);
  const declined = await f.store.respondHandoff(f.actor("bob"), task.id, offered.handoff!.id, "decline", offered.revision); assert.equal(declined.handoff, undefined); assert.equal(declined.owner?.userId, "alice"); assert.equal(declined.handoffs[0]!.state, "declined"); assert.equal(declined.attempts[0]!.state, "paused", "a declined hand-over leaves the paused attempt resumable");
  assert.equal((await f.store.inbox(f.actor("alice"))).items[0]!.kind, "handoff-declined"); await refuses(f.store.respondHandoff(f.actor("bob"), task.id, offered.handoff!.id, "accept", declined.revision), 409, /already declined/);
  offered = await f.store.offerHandoff(f.actor("alice"), task.id, { to: "bob", checkpointId: checkpoint.id }, declined.revision); const cancelled = await f.store.respondHandoff(f.actor("alice"), task.id, offered.handoff!.id, "cancel", offered.revision); assert.equal(cancelled.owner?.userId, "alice"); assert.equal(cancelled.handoffs.at(-1)!.state, "cancelled"); assert.equal((await f.store.inbox(f.actor("bob"))).items[0]!.kind, "handoff-cancelled");
  offered = await f.store.offerHandoff(f.actor("maya"), task.id, { to: "bob", checkpointId: checkpoint.id }, cancelled.revision); const byMaintainer = await f.store.respondHandoff(f.actor("maya"), task.id, offered.handoff!.id, "cancel", offered.revision); assert.equal(byMaintainer.handoffs.length, 3);
  offered = await f.store.offerHandoff(f.actor("alice"), task.id, { to: "owner", checkpointId: checkpoint.id }, byMaintainer.revision); assert.deepEqual(offered.handoff?.to, { userId: "owner", displayName: "Mx" }); const back = await f.store.respondHandoff(owner, task.id, offered.handoff!.id, "decline", offered.revision); assert.equal(back.owner?.userId, "alice");
  offered = await f.store.offerHandoff(f.actor("alice"), task.id, { to: "bob", checkpointId: checkpoint.id }, back.revision);
  const accepted = await f.store.respondHandoff(bob.actor, task.id, offered.handoff!.id, "accept", offered.revision); assert.deepEqual(accepted.owner, { userId: "bob", displayName: "Bob" }); assert.equal(accepted.handoff, undefined); assert.equal(accepted.handoffs.at(-1)!.state, "accepted"); assert.equal(accepted.attempts[0]!.state, "superseded"); assert.equal(accepted.status, "working", "accepting keeps the status");
  assert.equal((await f.store.inbox(f.actor("alice"))).items[0]!.kind, "handoff-accepted");
  await refuses(f.store.attemptProgress(alice.actor, attemptId, { seq: 9 }), 409, /was superseded by a change of owner/); await refuses(f.store.addCheckpoint(alice.actor, attemptId, manifest(data)), 409, /superseded/);
  const resumed = await claim(f, bob.actor, accepted, bob.runner.id, { fromCheckpointId: checkpoint.id }); assert.equal(resumed.attempts.at(-1)!.fromCheckpointId, checkpoint.id); assert.equal(resumed.attempts.length, 2); await refuses(claim(f, alice.actor, resumed, alice.runner.id), 403, /Only the task owner/);
  await refuses(claim(f, bob.actor, resumed, bob.runner.id, { fromCheckpointId: "0".repeat(32) }), 409, /Stop the attempt running/);
});

test("inbox read state is personal, mentions reach project members and @owner, and markRead validates its ids", async () => {
  const f = fixture(), task = await seeded(f); await f.store.comment(f.actor("rita"), task.id, "ping @alice and @bob and @owner and @nobody");
  const alice = await f.store.inbox(f.actor("alice")), bob = await f.store.inbox(f.actor("bob")); assert.equal(alice.unread, 2, "assigned + mention"); assert.equal(bob.unread, 1); assert.equal(alice.items[0]!.kind, "mention"); assert.equal(alice.items[0]!.text, "Rita mentioned you: ping @alice and @bob and @owner and @nobody"); assert.equal((await f.store.inbox(owner)).unread, 1);
  assert.deepEqual(await f.store.markRead(f.actor("alice"), "all"), { unread: 0 }); assert.equal((await f.store.inbox(f.actor("bob"))).unread, 1, "alice's read state is hers alone"); assert.equal((await f.store.board(f.actor("bob"))).tasks[0]!.unreadMentions, 1); assert.equal((await f.store.board(f.actor("alice"))).tasks[0]!.unreadMentions, 0);
  await refuses(f.store.markRead(f.actor("bob"), ["nope"]), 400, /Send the inbox item ids to mark read as a list/); await refuses(f.store.markRead(f.actor("bob"), "some" as never), 400, /or "all"/);
  assert.deepEqual(await f.store.markRead(f.actor("bob"), [alice.items[0]!.id]), { unread: 1 }, "marking someone else's item does nothing"); assert.deepEqual(await f.store.markRead(f.actor("bob"), [bob.items[0]!.id]), { unread: 0 });
  const read = await f.store.inbox(f.actor("bob")); assert.equal(read.items[0]!.readAt, f.now()); assert.deepEqual((await f.store.inbox(f.actor("bob"), f.now())).items, [], "after= filters by time"); await refuses(f.store.inbox(f.actor("bob"), "soon"), 400, /Unix time/);
  const reopened = f.reopen(); await reopened.load(); assert.equal((await reopened.inbox(f.actor("bob"))).items[0]!.readAt, f.now(), "read state persists");
  await refuses(f.store.comment(f.actor("rita"), task.id, "x".repeat(4001)), 400, /Keep the comment within 4000 characters/);
});

test("runner tokens are stored only as sha256; revoked runners, disabled accounts and non-contributors are refused; lastSeen is throttled; revoking orphans the attempt", async () => {
  const f = fixture(), task = await seeded(f), { runner, token } = await f.store.registerRunner("alice", "laptop", "100.64.0.7"); assert.match(token, RUNNER_TOKEN); assert.match(runner.id, /^r-[a-f0-9]{16}$/); assert.equal(runner.online, true);
  const stored = readFileSync(join(f.dir, "runners.json"), "utf8"); assert.equal(stored.includes(token.slice(3)), false, "the token never reaches disk"); assert.equal(JSON.parse(stored).runners[0].tokenHash, sha256(Buffer.from(token))); assert.equal(JSON.parse(stored).runners[0].lastAddress, "100.64.0.7"); assert.equal(statSync(join(f.dir, "runners.json")).mode & 0o777, 0o600);
  assert.deepEqual(f.store.authenticateRunner(token), { runnerId: runner.id, userId: "alice" }); assert.equal(f.store.authenticateRunner(`tr-${"a".repeat(43)}`), undefined); assert.equal(f.store.authenticateRunner(token.slice(0, -1) + (token.endsWith("a") ? "b" : "a")), undefined); assert.equal(f.store.authenticateRunner("not a token"), undefined);
  f.tick(5000); f.store.authenticateRunner(token); assert.equal((await f.store.runners(f.actor("alice")))[0]!.lastSeenAt, f.now() - 5000, "lastSeen moves at most every 10 s"); f.tick(6000); f.store.authenticateRunner(token); assert.equal((await f.store.runners(f.actor("alice")))[0]!.lastSeenAt, f.now());
  await f.store.comment(f.actor("rita"), task.id, "flush"); assert.equal(JSON.parse(readFileSync(join(f.dir, "runners.json"), "utf8")).runners[0].lastSeenAt, f.now(), "the touch rides along with the next mutation");
  assert.equal((await f.store.board(owner)).projects[0]!.members.find((m) => m.userId === "alice")!.online, true); f.tick(MAX.heartbeatLiveMs); assert.equal((await f.store.board(owner)).projects[0]!.members.find((m) => m.userId === "alice")!.online, false);
  const reopened = f.reopen(); await reopened.load(); assert.deepEqual(reopened.authenticateRunner(token), { runnerId: runner.id, userId: "alice" }, "hashes verify after a reload");
  await refuses(f.store.registerRunner("vic", "tablet"), 403, /A contributor role in at least one project is required to link a runner/); await refuses(f.store.registerRunner("nobody", "x"), 403, /contributor role/); await refuses(f.store.registerRunner("alice", ""), 400, /Enter a runner name/);
  const bob = await f.store.registerRunner("bob", "desktop"); assert.deepEqual((await f.store.runners(f.actor("alice"))).map((r) => r.id), [runner.id], "members see their own runners"); assert.deepEqual((await f.store.runners(owner)).map((r) => r.id), [runner.id, bob.runner.id]); assert.equal((await f.store.runners(f.actor("maya"))).length, 0, "project maintainers only see their own runners"); assert.deepEqual((await f.store.board(f.actor("bob"))).me.runners.map((r) => r.id), [bob.runner.id]);
  await refuses(f.store.revokeRunner(f.actor("alice"), bob.runner.id), 404, /Runner not found/); const revoked = await f.store.revokeRunner(f.actor("bob"), bob.runner.id); assert.equal(revoked.revokedAt, f.now()); assert.equal(revoked.online, false); assert.equal(f.store.authenticateRunner(bob.token), undefined, "a revoked token is refused");
  assert.deepEqual(await f.store.revokeRunner(f.actor("bob"), bob.runner.id), revoked, "revoking twice is idempotent");
  f.members.find((m) => m.userId === "alice")!.enabled = false; assert.equal(f.store.authenticateRunner(token), undefined, "a disabled account's runner is refused"); f.members.find((m) => m.userId === "alice")!.enabled = true; assert.ok(f.store.authenticateRunner(token));
  for (let i = 0; i < MAX.runnersPerUser - 1; i++) await f.store.registerRunner("alice", `extra-${i}`); await refuses(f.store.registerRunner("alice", "too-many"), 409, /At most 8 runners may be linked per account/);
  const claimed = await claim(f, f.actor("alice", "runner", runner.id), await f.store.task(owner, task.id), runner.id); assert.equal(claimed.attempts[0]!.state, "claimed");
  const byHubOwner = await f.store.revokeRunner(owner, runner.id); assert.equal(byHubOwner.revokedAt, f.now()); const orphaned = await f.store.task(owner, task.id); assert.equal(orphaned.attempts[0]!.state, "unknown"); assert.match(orphaned.attempts[0]!.reason!, /revoked while this attempt was active/); assert.equal(orphaned.revision, claimed.revision + 1);
  const byOwner = await f.store.revokeRunner(owner, (await f.store.runners(owner)).find((r) => r.revokedAt === undefined)!.id); assert.ok(byOwner.revokedAt);
});

test("bounds: a 500-task board loads, the 501st task is refused, and the audit trail keeps its last 200 entries", async () => {
  const f = fixture(); mkdirSync(f.dir, { recursive: true }); const now = f.now(), who = { userId: "owner", displayName: "Mx" };
  const tasks = Array.from({ length: MAX.tasks }, (_, i) => ({ id: `t-${i.toString(16).padStart(16, "0")}`, projectId: "p-1", repository: "app", title: `Task ${i}`, goal: "", acceptance: "", status: "planned", collaborators: [], dependsOn: [], labels: [], revision: 1, createdAt: now, updatedAt: now, createdBy: who, attempts: [], checkpoints: [], decisions: [], discussion: [], instructions: [], reviews: [], handoffs: [], audit: [{ at: now, by: who, action: "created" }] }));
  writeFileSync(join(f.dir, "board.json"), JSON.stringify({ version: 1, revision: 1, projects: { "p-1": { repositories: [{ key: "app", label: "App" }] } }, tasks }));
  await f.store.load(); assert.equal(f.store.available, true); assert.equal((await f.store.board(owner)).tasks.length, MAX.tasks);
  await refuses(f.store.createTask(owner, { projectId: "p-1", repository: "app", title: "501" }), 400, /At most 500 tasks can be kept here/);
  const first = await f.store.task(owner, tasks[0]!.id); let revision = first.revision; for (let i = 0; i < MAX.audit + 10; i++) revision = (await f.store.updateTask(owner, first.id, { title: `Title ${i}` }, revision)).revision;
  const trimmed = await f.store.task(owner, first.id); assert.equal(trimmed.audit.length, MAX.audit); assert.equal(trimmed.audit.at(-1)!.action, "updated"); assert.equal(trimmed.audit[0]!.detail, "title", "the oldest entries (created) were dropped"); assert.equal(trimmed.revision, MAX.audit + 11);
  await refuses(f.store.updateTask(owner, first.id, { title: "x".repeat(201) }, revision), 400, /Keep the title within 200 characters/); await refuses(f.store.updateTask(owner, first.id, { title: "ok", extra: 1 }, revision), 400, /Unknown task field "extra"/);
});

test("change events: listeners fire after the durable write, the ring replays by cursor, and foreign or stale cursors ask for a resync", async () => {
  const f = fixture(), events: ChangeEvent[] = []; await f.store.load(); const off = f.store.onChange((event) => { assert.ok(existsSync(join(f.dir, "board.json")), "the write is durable before listeners hear of it"); events.push(event); });
  assert.deepEqual(f.store.eventsSince(), { epoch: f.store.epoch, seq: 0, events: [], resync: false }); assert.match(f.store.epoch, /^[a-f0-9]{16}$/);
  await f.store.setRepositories(owner, "p-1", [{ key: "app", label: "App" }], 0); const task = await f.store.createTask(owner, { projectId: "p-1", repository: "app", title: "T", owner: "alice" });
  assert.deepEqual(events, [{ seq: 1, kind: "board", projectId: "p-1" }, { seq: 2, kind: "task", taskId: task.id, projectId: "p-1" }, { seq: 3, kind: "board", projectId: "p-1" }, { seq: 4, kind: "inbox", userIds: ["alice"] }]);
  assert.deepEqual(f.store.eventsSince(`${f.store.epoch}:2`).events.map((e) => e.seq), [3, 4]); assert.deepEqual(f.store.eventsSince(`${f.store.epoch}:4`), { epoch: f.store.epoch, seq: 4, events: [], resync: false });
  assert.equal(f.store.eventsSince(`${"0".repeat(16)}:2`).resync, true); assert.equal(f.store.eventsSince(`${f.store.epoch}:9`).resync, true); assert.equal(f.store.eventsSince("garbage").resync, true);
  off(); await f.store.comment(f.actor("rita"), task.id, "quiet"); assert.equal(events.length, 4, "unsubscribed"); assert.deepEqual(f.store.eventsSince(`${f.store.epoch}:4`).events.map((e) => e.kind), ["task", "inbox"]);
  const other = f.reopen(); await other.load(); assert.notEqual(other.epoch, f.store.epoch); assert.equal(other.eventsSince(`${f.store.epoch}:4`).resync, true);
});

test("instructions: the owner's are approved at once, others wait for the owner or a maintainer, and delivery is recorded by the attempt's runner", async () => {
  const f = fixture(), task = await seeded(f), alice = await runnerFor(f, "alice"), bob = await runnerFor(f, "bob"), claimed = await claim(f, alice.actor, task, alice.runner.id), attemptId = claimed.attempts[0]!.id;
  await refuses(f.store.proposeInstruction(f.actor("rita"), task.id, "do x"), 403, /A project contributor role is required to send instructions to the agent/);
  const own = await f.store.proposeInstruction(f.actor("alice"), task.id, "Add tests"); assert.equal(own.instructions[0]!.state, "approved"); assert.deepEqual(own.instructions[0]!.decidedBy, { userId: "alice", displayName: "Alice", via: "browser" });
  const proposed = await f.store.proposeInstruction(f.actor("bob"), task.id, "Also docs @alice"); assert.equal(proposed.instructions[1]!.state, "proposed"); assert.deepEqual((await f.store.inbox(f.actor("alice"))).items.slice(0, 2).map((i) => i.kind), ["instruction-proposed", "mention"]);
  const beat = await f.store.heartbeat(alice.actor, attemptId); assert.deepEqual(beat.instructions.map((i) => i.text), ["Add tests"], "only approved, undelivered instructions travel to the runner");
  await refuses(f.store.decideInstruction(f.actor("bob"), task.id, proposed.instructions[1]!.id, "approve"), 403, /Only the task owner or a project maintainer may approve or decline instructions/); await refuses(f.store.decideInstruction(f.actor("alice"), task.id, "i-0000000000000000", "approve"), 404, /Instruction not found/);
  const approved = await f.store.decideInstruction(f.actor("maya"), task.id, proposed.instructions[1]!.id, "approve"); assert.equal(approved.instructions[1]!.state, "approved"); assert.equal(approved.instructions[1]!.decidedBy?.userId, "maya"); await refuses(f.store.decideInstruction(f.actor("alice"), task.id, proposed.instructions[1]!.id, "decline"), 409, /already approved/);
  assert.equal((await f.store.heartbeat(alice.actor, attemptId)).instructions.length, 2);
  await refuses(f.store.markInstructionDelivered(bob.actor, task.id, own.instructions[0]!.id, attemptId), 403, /Only the runner executing this attempt/); const delivered = await f.store.markInstructionDelivered(alice.actor, task.id, own.instructions[0]!.id, attemptId); assert.equal(delivered.instructions[0]!.state, "delivered"); assert.equal(delivered.instructions[0]!.attemptId, attemptId);
  assert.deepEqual(await f.store.markInstructionDelivered(alice.actor, task.id, own.instructions[0]!.id, attemptId), delivered, "idempotent"); assert.deepEqual((await f.store.heartbeat(alice.actor, attemptId)).instructions.map((i) => i.text), ["Also docs @alice"]);
  const declined = await f.store.proposeInstruction(f.actor("bob"), task.id, "Rewrite everything"); const no = await f.store.decideInstruction(f.actor("alice"), task.id, declined.instructions[2]!.id, "decline"); assert.equal(no.instructions[2]!.state, "declined"); await refuses(f.store.markInstructionDelivered(alice.actor, task.id, no.instructions[2]!.id, attemptId), 409, /Only approved instructions can be delivered; this one is declined/);
});

test("status rules: blocked needs a blocker and notifies the people on the task, leaving blocked clears it, deletion cleans dependencies and inbox items, prune orphans silent attempts", async () => {
  const f = fixture(), task = await seeded(f, { collaborators: ["bob"], reviewer: "rita" });
  await refuses(f.store.updateTask(f.actor("alice"), task.id, { status: "blocked" }, task.revision), 400, /Describe what blocks the task before marking it blocked/);
  const blocked = await f.store.updateTask(f.actor("alice"), task.id, { status: "blocked", blocker: "Waiting for credentials" }, task.revision); assert.equal(blocked.status, "blocked"); assert.equal(blocked.blocker, "Waiting for credentials");
  assert.equal((await f.store.inbox(f.actor("bob"))).items[0]!.kind, "blocked"); assert.equal((await f.store.inbox(f.actor("rita"))).items[0]!.kind, "blocked"); assert.equal((await f.store.inbox(f.actor("alice"))).items.filter((i) => i.kind === "blocked").length, 0, "the actor is not notified");
  const reworded = await f.store.updateTask(f.actor("alice"), task.id, { blocker: "Still waiting" }, blocked.revision); assert.equal(reworded.blocker, "Still waiting"); assert.equal(reworded.status, "blocked");
  const working = await f.store.updateTask(f.actor("alice"), task.id, { status: "working" }, reworded.revision); assert.equal(working.blocker, undefined, "leaving blocked clears the blocker"); assert.equal((await f.store.board(owner)).tasks[0]!.blocker, undefined);
  await refuses(f.store.updateTask(f.actor("alice"), task.id, { dependsOn: ["t-ffffffffffffffff"] }, working.revision), 400, /Choose the tasks this one depends on from the board/); await refuses(f.store.updateTask(f.actor("alice"), task.id, { dependsOn: [task.id] }, working.revision), 400, /depends on/);
  const other = await f.store.createTask(f.actor("bob"), { projectId: "p-1", repository: "docs", title: "Docs", dependsOn: [task.id] }); assert.deepEqual(other.dependsOn, [task.id]);
  const done = await f.store.updateTask(f.actor("alice"), task.id, { status: "done" }, working.revision); assert.equal(done.status, "done"); assert.deepEqual(done.audit.at(-1), { at: f.now(), by: { userId: "alice", displayName: "Alice" }, action: "updated", detail: "status" });
  assert.deepEqual(await f.store.deleteTask(f.actor("maya"), task.id, done.revision), { deleted: true }); assert.deepEqual((await f.store.task(owner, other.id)).dependsOn, [], "a deleted task leaves no dangling dependency"); assert.equal((await f.store.inbox(f.actor("bob"))).items.filter((i) => i.taskId === task.id).length, 0, "its inbox items go with it");
  const renamed = await f.store.setOwnerName(owner, "Midhun"); assert.deepEqual(renamed, { ownerName: "Midhun" }); assert.equal(f.store.ownerName, "Midhun"); await refuses(f.store.setOwnerName(f.actor("maya"), "x"), 403, /Only the hub owner/); assert.equal((await f.store.board(f.actor("alice"))).projects[0]!.members[0]!.displayName, "Midhun");
  assert.deepEqual(await f.store.prune(f.now()), { runners: 0, inbox: 0, attempts: 0 });
  const stale = await f.store.createTask(owner, { projectId: "p-1", repository: "docs", title: "Stale", owner: "alice" }), alice = await runnerFor(f, "alice"); await claim(f, alice.actor, stale, alice.runner.id); f.tick(24 * 60 * 60_000);
  assert.equal((await f.store.prune(f.now())).attempts, 1); const orphaned = await f.store.task(owner, stale.id); assert.equal(orphaned.attempts[0]!.state, "unknown"); assert.match(orphaned.attempts[0]!.reason!, /No heartbeat for 24 hours/); assert.equal(orphaned.audit.at(-1)!.by.displayName, "Midhun");
});
