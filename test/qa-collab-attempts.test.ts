import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";

/**
 * Team board attempts, from the QA pass: a "Connection lost" attempt can be recovered as soon as its runner is silent for
 * 90 s (not only after the 24 h sweep) while a runner that reported again keeps it; the current attempt never reaches back
 * past a newer outcome to an older paused one; a superseded attempt says why instead of "resume it from here"; attempt
 * endings and instruction decisions reach the people concerned; and only a stale revision carries the code a page reloads on.
 */
const root = mkdtempSync(join(tmpdir(), "codeflow-qa-collab-attempts-")); process.env.CODEFLOW_HOME = join(root, "home");
// Everything from src is imported after CODEFLOW_HOME is set, or the store's default directory (and server.log) would land in ~/.codeflow.
const { CODEFLOW_HOME } = await import("../src/config.js"); assert.equal(CODEFLOW_HOME, process.env.CODEFLOW_HOME, "src/config.js loaded before CODEFLOW_HOME was set");
const { CollabStore, ownerActor, memberActor } = await import("../src/collab/store.js");
const { CollabError, MAX, STALE_REVISION, assignOwner, attemptLostContact, collabErrorBody, currentAttempt, summarize } = await import("../src/collab/model.js");
type MemberRecord = import("../src/collab/store.js").MemberRecord; type CollabActor = import("../src/collab/model.js").CollabActor; type Task = import("../src/collab/model.js").Task; type Attempt = import("../src/collab/model.js").Attempt; type AttemptState = import("../src/collab/model.js").AttemptState; type SharedRole = import("../src/shared-accounts.js").SharedRole;
after(() => rmSync(root, { recursive: true, force: true }));

const BASE = "b".repeat(40), HEAD = "c".repeat(40), HEAD2 = "d".repeat(40);
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const member = (userId: string, role: SharedRole): MemberRecord => ({ userId, username: userId, displayName: userId[0]!.toUpperCase() + userId.slice(1), enabled: true, roles: { "p-1": role } });
let cases = 0;
/** A fresh team directory with a controllable clock (the store's liveness and recovery read it), like test/collab-store.test.ts. */
function fixture() {
  const dir = join(root, `case-${++cases}`); let clock = 1_700_000_000_000;
  const members: MemberRecord[] = [member("alice", "contributor"), member("bob", "contributor"), member("maya", "maintainer"), member("rita", "reviewer")];
  const store = new CollabStore({ dir, members: () => members, projects: () => [{ id: "p-1", name: "App" }], now: () => clock, ownerName: () => "Mx" });
  const actor = (userId: string, via: "browser" | "runner" = "browser", runnerId?: string) => memberActor(members.find((m) => m.userId === userId)!, via, runnerId);
  return { store, actor, tick: (ms: number) => (clock += ms), now: () => clock };
}
type Fixture = ReturnType<typeof fixture>;
const owner = ownerActor("Mx");
async function refuses(run: Promise<unknown>, status: number, pattern: RegExp): Promise<InstanceType<typeof CollabError>> { try { await run; } catch (error) { assert.ok(error instanceof CollabError, `expected a CollabError, got ${String(error)}`); assert.equal(error.status, status, error.message); assert.match(error.message, pattern); return error; } assert.fail(`expected a refusal matching ${pattern}`); }
async function seeded(f: Fixture, extra: Record<string, unknown> = {}) { await f.store.load(); await f.store.setRepositories(owner, "p-1", [{ key: "app", label: "App" }, { key: "docs", label: "Docs" }], 0); return f.store.createTask(owner, { projectId: "p-1", repository: "app", title: "Ship it", goal: "Make it ship", acceptance: "Tests pass", owner: "alice", ...extra }); }
async function runnerFor(f: Fixture, userId: string, name = "laptop") { const { runner, token } = await f.store.registerRunner(userId, name); assert.ok(f.store.authenticateRunner(token)); return { runner, actor: f.actor(userId, "runner", runner.id) as CollabActor }; }
const claim = (f: Fixture, actor: CollabActor, task: Task, runnerId: string) => f.store.claimAttempt(actor, task.id, { attemptId: randomBytes(16).toString("hex"), runnerId, runnerName: "laptop", baseCommit: BASE, revision: task.revision });
const manifest = (data: Buffer, commit = HEAD) => ({ commit, baseCommit: BASE, branch: "codeflow/run/solo", size: data.length, sha256: sha256(data), note: "", requirements: "Ship it", decisions: [], remaining: "", changedFiles: ["src/a.ts"] });
/** A claimed attempt that reported once, so it is running and was last heard now. */
async function running(f: Fixture, actor: CollabActor, task: Task, runnerId: string): Promise<string> { const id = (await claim(f, actor, task, runnerId)).attempts.at(-1)!.id; await f.store.attemptProgress(actor, id, { seq: 1, runStatus: "running" }); return id; }
/** Adds a checkpoint with its bundle to the attempt and returns it. */
async function checkpointed(f: Fixture, actor: CollabActor, attemptId: string, commit = HEAD) { const data = randomBytes(64), checkpoint = await f.store.addCheckpoint(actor, attemptId, manifest(data, commit)); await f.store.storeBundle(actor, checkpoint.id, Readable.from([data]), { size: data.length, sha256: checkpoint.sha256 }); return checkpoint; }

test("a running attempt whose runner went silent for 90 s can be recovered by the task owner or a maintainer, without waiting for the 24 h sweep", async () => {
  const f = fixture(), task = await seeded(f), alice = await runnerFor(f, "alice"), desk = await runnerFor(f, "alice", "desk");
  const id = await running(f, alice.actor, task, alice.runner.id);
  let current = await f.store.task(owner, task.id); const recovery = () => ({ revision: current.revision, reason: "Shut the laptop down; no agent is running", confirmedStopped: true });
  f.tick(60_000);
  const live = await refuses(f.store.recoverAttempt(f.actor("maya"), id, recovery()), 409, /^Runner laptop is connected and reports this attempt as running; recovery is only for an attempt whose runner lost contact/);
  assert.equal(live.code, undefined, "a rule of the board, not a stale revision: the page shows it instead of reloading");
  f.tick(MAX.heartbeatLiveMs - 60_000);
  current = await f.store.task(owner, task.id); assert.equal(current.attempts[0]!.state, "running", "silence alone changes nothing on the board"); assert.equal(attemptLostContact(current.attempts[0]!, f.now()), true);
  await refuses(f.store.recoverAttempt(f.actor("bob"), id, recovery()), 403, /Only the task owner or a project maintainer/);
  await refuses(f.store.recoverAttempt(f.actor("maya"), id, { ...recovery(), confirmedStopped: false }), 400, /Confirm/);
  current = await f.store.recoverAttempt(f.actor("maya"), id, recovery());
  assert.equal(current.attempts[0]!.state, "superseded"); assert.equal(current.attempts[0]!.reason, "Shut the laptop down; no agent is running"); assert.equal(current.attempts[0]!.endedAt, f.now());
  assert.equal(current.audit.at(-1)!.action, "attempt-recovered"); assert.equal(current.audit.at(-1)!.by.userId, "maya");
  // The old runner is fenced: everything it sends is refused, which makes it stop its agent (runner.hubEnded).
  await refuses(f.store.heartbeat(alice.actor, id), 409, /superseded/); await refuses(f.store.attemptProgress(alice.actor, id, { seq: 2, runStatus: "running" }), 409, /superseded/); await refuses(f.store.addCheckpoint(alice.actor, id, manifest(Buffer.from("late"))), 409, /superseded/);
  current = await claim(f, desk.actor, current, desk.runner.id); assert.deepEqual(current.attempts.map((attempt) => attempt.state), ["superseded", "claimed"], "the task is released for a new attempt");
});

test("recovery is decided at commit time: a silent runner that reports again keeps its attempt, and a claim that never reported is recoverable too", async () => {
  const f = fixture(), task = await seeded(f), alice = await runnerFor(f, "alice");
  const id = await running(f, alice.actor, task, alice.runner.id); f.tick(MAX.heartbeatLiveMs + 1000);
  let current = await f.store.task(owner, task.id); const recovery = { revision: current.revision, reason: "Checked", confirmedStopped: true };
  await f.store.heartbeat(alice.actor, id);
  await refuses(f.store.recoverAttempt(f.actor("alice"), id, recovery), 409, /is connected and reports this attempt as running/);
  assert.equal((await f.store.task(owner, task.id)).attempts[0]!.state, "running");
  await f.store.finishAttempt(alice.actor, id, { state: "paused", reason: "Stopped on this computer; resume it from here to continue" });
  current = await f.store.task(owner, task.id);
  await refuses(f.store.recoverAttempt(f.actor("alice"), id, { ...recovery, revision: current.revision }), 409, /^This attempt is paused; only an attempt whose runner lost contact can be recovered/);
  // A claim whose run never started (the computer died between claiming and reporting) is silent the same way.
  const other = await f.store.createTask(owner, { projectId: "p-1", repository: "app", title: "Second", owner: "alice" }), claimed = await claim(f, alice.actor, other, alice.runner.id), claimedId = claimed.attempts[0]!.id;
  await refuses(f.store.recoverAttempt(f.actor("maya"), claimedId, { revision: claimed.revision, reason: "Checked", confirmedStopped: true }), 409, /reports this attempt as claimed/);
  f.tick(MAX.heartbeatLiveMs);
  assert.equal((await f.store.recoverAttempt(f.actor("maya"), claimedId, { revision: claimed.revision, reason: "Checked", confirmedStopped: true })).attempts[0]!.state, "superseded");
});

const attempt = (state: AttemptState, extra: Partial<Attempt> = {}): Attempt => ({ id: randomBytes(16).toString("hex"), taskId: "t-0123456789abcdef", runnerId: "local", runnerName: "laptop", user: { userId: "alice", displayName: "Alice" }, state, baseCommit: BASE, createdAt: 1, lastSeq: 1, lastHeartbeatAt: 1, progress: { updatedAt: 1 }, ...extra });
const bare = (attempts: Attempt[], extra: Partial<Task> = {}): Task => ({ id: "t-0123456789abcdef", projectId: "p-1", repository: "app", title: "Ship it", goal: "", acceptance: "", status: "working", owner: { userId: "alice", displayName: "Alice" }, collaborators: [], dependsOn: [], labels: [], revision: 1, createdAt: 1, updatedAt: 1, createdBy: { userId: "owner", displayName: "Mx" }, attempts, checkpoints: [], decisions: [], discussion: [], instructions: [], reviews: [], handoffs: [], audit: [], ...extra });

test("the current attempt never reaches back past a newer outcome to an older paused attempt, so the card shows the newer one", () => {
  const paused = attempt("paused"), finished = attempt("finished");
  const task = bare([paused, finished]);
  assert.equal(currentAttempt(task), undefined, "a paused attempt behind a newer finished one is history");
  assert.equal(summarize(task).attempt, undefined, "the board card reports no current attempt over the newer finished one");
  for (const later of ["failed", "stopped", "finished"] as const) assert.equal(currentAttempt(bare([attempt("paused"), attempt(later)])), undefined, later);
  assert.equal(currentAttempt(bare([paused, attempt("superseded")]))?.id, paused.id, "a recovered (superseded) attempt after it does not hide a paused one");
  const newer = attempt("paused"); assert.equal(currentAttempt(bare([paused, finished, newer]))?.id, newer.id, "the latest paused attempt is current");
  const lost = attempt("unknown"); assert.equal(currentAttempt(bare([finished, lost]))?.id, lost.id, "unknown still counts");
  const busy = attempt("running"); assert.equal(currentAttempt(bare([busy, finished]))?.id, busy.id, "a busy attempt always wins");
});

test("starting a newer attempt fences earlier paused or stopped work, including boards saved before fencing existed", async () => {
  const f = fixture(), task = await seeded(f), alice = await runnerFor(f, "alice");
  const first = await running(f, alice.actor, task, alice.runner.id);
  await f.store.finishAttempt(alice.actor, first, { state: "paused", reason: "resume it from here" });
  let current = await f.store.task(owner, task.id);
  // Validation must complete before any older work is retired.
  await refuses(claim(f, alice.actor, { ...current, revision: current.revision - 1 }, alice.runner.id), 409, /changed; reload/);
  await refuses(f.store.claimAttempt(alice.actor, current.id, { attemptId: randomBytes(16).toString("hex"), runnerId: alice.runner.id, runnerName: "laptop", baseCommit: BASE, revision: current.revision, fromCheckpointId: "f".repeat(32) }), 404, /Checkpoint not found/);
  assert.equal((await f.store.task(owner, task.id)).attempts[0]!.state, "paused", "a refused new claim leaves prior work resumable");
  const second = await running(f, alice.actor, current, alice.runner.id);
  await f.store.finishAttempt(alice.actor, second, { state: "stopped", reason: "limit" });
  current = await f.store.task(owner, task.id);
  const third = await running(f, alice.actor, current, alice.runner.id);
  await f.store.finishAttempt(alice.actor, third, { state: "finished" });
  current = await f.store.task(owner, task.id);
  assert.deepEqual(current.attempts.map(item => item.state), ["superseded", "superseded", "finished"]);
  for (const id of [first, second]) {
    assert.match(current.attempts.find(item => item.id === id)!.reason!, /newer attempt/);
    await refuses(f.store.attemptProgress(alice.actor, id, { seq: 2, runStatus: "running" }), 409, /superseded/);
    await refuses(f.store.heartbeat(alice.actor, id), 409, /superseded/);
    await refuses(f.store.addCheckpoint(alice.actor, id, manifest(Buffer.from("old"))), 409, /superseded/);
  }
  // An installation can already contain the old [paused, finished] shape. Do not trust its missing supersession marker.
  await f.store.close();
  const file = join(f.store.dir, "board.json"), saved = JSON.parse(readFileSync(file, "utf8"));
  saved.tasks.find((item: Task) => item.id === task.id).attempts[0].state = "paused";
  writeFileSync(file, JSON.stringify(saved));
  const reopened = new CollabStore({ dir: f.store.dir, members: () => [member("alice", "contributor")], projects: () => [{ id: "p-1", name: "App" }], now: f.now });
  await reopened.load();
  await refuses(reopened.attemptProgress(alice.actor, first, { seq: 3, runStatus: "running" }), 409, /newer attempt/);
  assert.deepEqual((await reopened.task(owner, task.id)).attempts.map(item => item.state), ["paused", "superseded", "finished"]);
  await reopened.close();
});

test("a change of hands supersedes paused and stopped attempts with a reason that says why, never the 'resume it from here' they paused with", async () => {
  const resumeHint = "Stopped on this computer; resume it from here to continue";
  const task = bare([attempt("finished", { reason: "done" }), attempt("paused", { reason: resumeHint }), attempt("stopped", { reason: "The run stopped at a limit; resume it to continue" })]);
  assignOwner(task, { userId: "bob", displayName: "Bob" }, 50);
  assert.deepEqual(task.attempts.map((entry) => entry.state), ["finished", "superseded", "superseded"]);
  assert.equal(task.attempts[0]!.reason, "done", "an ended attempt keeps its own reason");
  for (const entry of task.attempts.slice(1)) { assert.doesNotMatch(entry.reason!, /resume/i); assert.match(entry.reason!, /^Superseded when the task passed to Bob; work continues from the task's latest checkpoint$/); assert.equal(entry.endedAt, 50); }
  const unassigned = bare([attempt("paused", { reason: resumeHint })]); assignOwner(unassigned, undefined, 60); assert.match(unassigned.attempts[0]!.reason!, /^Superseded when the task was unassigned/);
  // Through the store: a maintainer's reassignment, then an accepted hand-over.
  const f = fixture(), stored = await seeded(f), alice = await runnerFor(f, "alice");
  const id = await running(f, alice.actor, stored, alice.runner.id); await f.store.finishAttempt(alice.actor, id, { state: "paused", reason: resumeHint });
  let current = await f.store.updateTask(f.actor("maya"), stored.id, { owner: "maya" }, (await f.store.task(owner, stored.id)).revision);
  assert.equal(current.attempts[0]!.state, "superseded"); assert.equal(current.attempts[0]!.reason, "Superseded when the task passed to Maya; work continues from the task's latest checkpoint");
  current = await f.store.updateTask(f.actor("maya"), stored.id, { owner: "alice" }, current.revision);
  const second = await running(f, alice.actor, current, alice.runner.id), checkpoint = await checkpointed(f, alice.actor, second); await f.store.finishAttempt(alice.actor, second, { state: "paused", reason: resumeHint });
  current = await f.store.task(owner, stored.id); const offered = await f.store.offerHandoff(f.actor("alice"), stored.id, { to: "bob", checkpointId: checkpoint.id }, current.revision);
  const accepted = await f.store.respondHandoff(f.actor("bob"), stored.id, offered.handoff!.id, "accept", offered.revision);
  assert.equal(accepted.attempts[1]!.state, "superseded"); assert.equal(accepted.attempts[1]!.reason, "Superseded when the task passed to Bob; work continues from the task's latest checkpoint");
});

test("attempt endings reach the task's people other than the runner's own user, a reviewer is asked to review a new checkpoint, and proposers learn their instruction's fate", async () => {
  const f = fixture(), task = await seeded(f, { collaborators: ["bob"], reviewer: "rita" }), alice = await runnerFor(f, "alice");
  const kinds = async (userId: string) => (await f.store.inbox(f.actor(userId))).items.map((item) => `${item.kind}: ${item.text}`);
  const before = { bob: (await kinds("bob")).length, rita: (await kinds("rita")).length };
  // Finished with a new checkpoint: collaborators hear the outcome, the reviewer is asked for a review instead, the owner hears nothing of their own runner.
  let id = await running(f, alice.actor, task, alice.runner.id); const first = await checkpointed(f, alice.actor, id); await f.store.finishAttempt(alice.actor, id, { state: "finished", head: HEAD });
  assert.deepEqual((await kinds("bob")).slice(0, -before.bob || undefined), [`attempt-finished: The attempt on laptop finished with checkpoint ${HEAD.slice(0, 12)}`]);
  assert.deepEqual((await kinds("rita")).slice(0, -before.rita || undefined), [`review-requested: New checkpoint ${HEAD.slice(0, 12)} of “Ship it” is ready for your review`]);
  assert.deepEqual((await f.store.inbox(f.actor("alice"))).items.filter((item) => item.kind.startsWith("attempt-")), [], "a runner's own finish is never an inbox item for the same person");
  // Rita approves; the next checkpoint makes that review stale, and her request says so.
  let current = await f.store.task(owner, task.id); await f.store.review(f.actor("rita"), task.id, { checkpointId: first.id, verdict: "approve" }, current.revision);
  current = await f.store.task(owner, task.id); id = await running(f, alice.actor, current, alice.runner.id); await checkpointed(f, alice.actor, id, HEAD2); await f.store.finishAttempt(alice.actor, id, { state: "finished", head: HEAD2 });
  assert.equal((await kinds("rita"))[0], `review-requested: New checkpoint ${HEAD2.slice(0, 12)} of “Ship it” is ready for your review; your earlier review is now stale`);
  // Failed, and lost contact: everyone concerned, the reviewer included, as attempt-failed; a pause (the owner's own Stop) tells nobody.
  current = await f.store.task(owner, task.id); id = await running(f, alice.actor, current, alice.runner.id); await f.store.finishAttempt(alice.actor, id, { state: "failed", reason: "Tests failed" });
  for (const userId of ["bob", "rita"]) assert.equal((await kinds(userId))[0], "attempt-failed: The attempt on laptop failed: Tests failed", userId);
  current = await f.store.task(owner, task.id); id = await running(f, alice.actor, current, alice.runner.id); const counts = { bob: (await kinds("bob")).length, rita: (await kinds("rita")).length };
  await f.store.finishAttempt(alice.actor, id, { state: "paused", reason: "Stopped on this computer; resume it from here to continue" });
  assert.deepEqual({ bob: (await kinds("bob")).length, rita: (await kinds("rita")).length }, counts, "a pause is not an outcome");
  await f.store.attemptProgress(alice.actor, id, { seq: 2, runStatus: "running" }); await f.store.finishAttempt(alice.actor, id, { state: "unknown", reason: "Run r-1 is missing from this computer" });
  assert.equal((await kinds("bob"))[0], "attempt-failed: The attempt on laptop lost contact: Run r-1 is missing from this computer");
  // Instructions: the proposer learns the owner's or a maintainer's decision; the owner's own instructions are approved at once and notify nobody about themselves.
  await f.store.proposeInstruction(f.actor("bob"), task.id, "Please also cover wildcard topics");
  current = await f.store.task(owner, task.id); await f.store.decideInstruction(f.actor("alice"), task.id, current.instructions.at(-1)!.id, "decline");
  assert.equal((await kinds("bob"))[0], "instruction-declined: Alice declined your instruction for the agent on “Ship it”: Please also cover wildcard topics");
  await f.store.proposeInstruction(f.actor("bob"), task.id, "Add a changelog entry");
  current = await f.store.task(owner, task.id); await f.store.decideInstruction(f.actor("maya"), task.id, current.instructions.at(-1)!.id, "approve");
  assert.equal((await kinds("bob"))[0], "instruction-approved: Maya approved your instruction for the agent on “Ship it”: Add a changelog entry");
  const aliceItems = (await kinds("alice")).length; await f.store.proposeInstruction(f.actor("alice"), task.id, "Keep the diff small");
  assert.equal((await kinds("alice")).length, aliceItems, "the owner's own instruction is no inbox item for them");
  // The inbox document with the new kinds reads back after a restart.
  await f.store.close(); const reopened = new CollabStore({ dir: f.store.dir, members: () => [member("bob", "contributor")], projects: () => [{ id: "p-1", name: "App" }], ownerName: () => "Mx" });
  assert.ok((await reopened.inbox(memberActor(member("bob", "contributor"), "browser"))).items.some((item) => item.kind === "instruction-approved"));
});

test("only a stale revision carries the stale-revision code; other 409 refusals keep their own words and no code", async () => {
  const f = fixture(), task = await seeded(f), alice = await runnerFor(f, "alice");
  const stale = await refuses(f.store.updateTask(f.actor("alice"), task.id, { title: "New" }, task.revision - 1), 409, /^Task changed; reload before saving$/);
  assert.equal(stale.code, STALE_REVISION); assert.deepEqual(collabErrorBody(stale), { error: "Task changed; reload before saving", code: STALE_REVISION });
  const board = await refuses(f.store.setRepositories(owner, "p-1", [{ key: "app", label: "App" }], 0), 409, /^Team board changed; reload before saving$/); assert.equal(board.code, STALE_REVISION);
  const revision = (await f.store.board(owner)).revision;
  const inUse = await refuses(f.store.setRepositories(owner, "p-1", [{ key: "docs", label: "Docs" }], revision), 409, /^Task “Ship it” still uses repository app; move it to another repository before removing that key$/);
  assert.equal(inUse.code, undefined); assert.deepEqual(collabErrorBody(inUse), { error: inUse.message });
  const id = await running(f, alice.actor, task, alice.runner.id), checkpoint = await checkpointed(f, alice.actor, id); await f.store.finishAttempt(alice.actor, id, { state: "finished", head: HEAD });
  const current = await f.store.task(owner, task.id); await f.store.offerHandoff(f.actor("alice"), task.id, { to: "bob", checkpointId: checkpoint.id }, current.revision);
  assert.equal((await refuses(f.store.deleteCheckpoint(owner, checkpoint.id), 409, /^Cancel the offered hand-over before deleting its checkpoint$/)).code, undefined);
});
