import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { CollabStore, memberActor, ownerActor, type MemberRecord } from "../src/collab/store.js";
import { reviewState, pushBounded, type Task } from "../src/collab/model.js";
const owner = ownerActor(), BASE = "a".repeat(40), HEAD = "b".repeat(40), data = Buffer.from("fixture bundle");
const manifest = { commit: HEAD, baseCommit: BASE, branch: "team/qa/branch", size: data.length, sha256: createHash("sha256").update(data).digest("hex"), note: "", requirements: "QA", decisions: [], remaining: "", changedFiles: ["test.txt"] };
async function fixture() {
  const members: MemberRecord[] = ["alice", "bob", "maya", "rita"].map(userId => ({ userId, username: userId, displayName: userId, enabled: true, roles: { "p-1": userId === "maya" ? "maintainer" : userId === "rita" ? "reviewer" : "contributor" } }));
  const store = new CollabStore({ dir: await mkdtemp(join(tmpdir(), "qa-collab-permissions-")), members: () => members, projects: () => [{ id: "p-1", name: "QA" }] }); await store.load(); await store.setRepositories(owner, "p-1", [{ key: "app", label: "App" }], 0);
  const actor = (id: string, runnerId?: string) => memberActor(members.find(member => member.userId === id)!, runnerId ? "runner" : "browser", runnerId);
  const task = await store.createTask(owner, { projectId: "p-1", repository: "app", title: "Permission QA", goal: "QA", owner: "alice" });
  return { store, members, actor, task };
}
const refused = (status: number, message: RegExp) => (error: any) => error.status === status && message.test(error.message);

test("demoted task owners and their runner cannot decide, receive or publish instructions/work", async () => {
  for (const role of ["viewer", "reviewer"] as const) {
    const f = await fixture(); try {
      const { runner } = await f.store.registerRunner("alice", "QA runner"); let current = await f.store.claimAttempt(f.actor("alice", runner.id), f.task.id, { attemptId: randomBytes(16).toString("hex"), runnerId: runner.id, runnerName: "QA runner", baseCommit: BASE, revision: f.task.revision }); const attempt = current.attempts[0]!;
      current = await f.store.proposeInstruction(f.actor("alice"), f.task.id, "Approved instruction"); const approved = current.instructions[0]!;
      current = await f.store.proposeInstruction(f.actor("maya"), f.task.id, "Proposed instruction"); const proposed = current.instructions[1]!;
      const checkpoint = await f.store.addCheckpoint(f.actor("alice", runner.id), attempt.id, manifest);
      f.members[0]!.roles["p-1"] = role;
      for (const who of [f.actor("alice"), f.actor("alice", runner.id)]) for (const action of ["approve", "decline"] as const) await assert.rejects(f.store.decideInstruction(who, f.task.id, proposed.id, action), refused(403, /contributor|task owner/));
      const actor = f.actor("alice", runner.id);
      await assert.rejects(f.store.heartbeat(actor, attempt.id), refused(403, /contributor/));
      await assert.rejects(f.store.attemptProgress(actor, attempt.id, { seq: 1, runStatus: "running" }), refused(403, /contributor/));
      await assert.rejects(f.store.finishAttempt(actor, attempt.id, { state: "finished" }), refused(403, /contributor/));
      await assert.rejects(f.store.markInstructionDelivered(actor, f.task.id, approved.id, attempt.id), refused(403, /contributor/));
      await assert.rejects(f.store.addCheckpoint(actor, attempt.id, manifest), refused(403, /contributor/));
      await assert.rejects(f.store.storeBundle(actor, checkpoint.id, Readable.from(data), { size: data.length, sha256: manifest.sha256 }), refused(403, /contributor/));
      current = await f.store.decideInstruction(f.actor("maya"), f.task.id, proposed.id, "approve"); assert.equal(current.instructions[1]!.state, "approved");
      await f.store.revokeRunner(owner, runner.id); current = await f.store.task(owner, f.task.id); await f.store.recoverAttempt(f.actor("maya"), attempt.id, { revision: current.revision, reason: "QA runner stopped", confirmedStopped: true });
    } finally { await f.store.close(); }
  }
});

test("owners and checkpoint authors cannot supply their own independent review", async () => {
  const f = await fixture(); try {
    await assert.rejects(f.store.createTask(owner, { projectId: "p-1", repository: "app", title: "Self", goal: "QA", owner: "alice", reviewer: "alice" }), refused(400, /teammate|task owner/));
    await assert.rejects(f.store.requestReview(f.actor("alice"), f.task.id, "alice", f.task.revision), refused(400, /teammate|task owner/));
    await assert.rejects(f.store.updateTask(owner, f.task.id, { reviewer: "alice" }, f.task.revision), refused(400, /teammate|task owner/));
    const { runner } = await f.store.registerRunner("alice", "QA runner"); let current = await f.store.claimAttempt(f.actor("alice", runner.id), f.task.id, { attemptId: randomBytes(16).toString("hex"), runnerId: runner.id, runnerName: "QA runner", baseCommit: BASE, revision: f.task.revision }); const attempt = current.attempts[0]!;
    const checkpoint = await f.store.addCheckpoint(f.actor("alice", runner.id), attempt.id, manifest); await f.store.finishAttempt(f.actor("alice", runner.id), attempt.id, { state: "finished" }); current = await f.store.task(owner, f.task.id);
    await assert.rejects(f.store.review(f.actor("alice"), f.task.id, { checkpointId: checkpoint.id, verdict: "approve", text: "My work" }, current.revision), refused(403, /own|teammate/));
    current = await f.store.updateTask(owner, f.task.id, { owner: "bob" }, current.revision);
    for (const id of ["alice", "bob"]) await assert.rejects(f.store.review(f.actor(id), f.task.id, { checkpointId: checkpoint.id, verdict: "approve", text: "Self" }, current.revision), refused(403, /own|teammate/));
    current = await f.store.review(f.actor("rita"), f.task.id, { checkpointId: checkpoint.id, verdict: "approve", text: "Independent" }, current.revision); assert.equal(reviewState(current), "approved");
    const legacy = { ...current, reviews: [{ ...current.reviews[0]!, by: { userId: "alice", displayName: "Alice" } }] } as Task; assert.notEqual(reviewState(legacy), "approved");
  } finally { await f.store.close(); }
});

test("permanent per-task history limits give possible next steps and keep the accepted records", async () => {
  const f = await fixture(); try {
    for (let i = 0; i < 100; i++) await f.store.decide(f.actor("alice"), f.task.id, `Decision ${i}`);
    await assert.rejects(f.store.decide(f.actor("alice"), f.task.id, "Overflow"), refused(400, /permanent|follow-up|new task/));
    assert.equal((await f.store.task(owner, f.task.id)).decisions.length, 100);
    for (const label of ["comments", "reviews", "instructions", "attempts", "checkpoints"]) assert.throws(() => pushBounded([1], 2, 1, label), (error: any) => error.status === 400 && /follow-up|new task/.test(error.message) && !/remove some/.test(error.message));
  } finally { await f.store.close(); }
});

test("draft reconciliation rebases unrelated revisions but preserves a conflicting field's original revision", async () => {
  const { refreshTaskDraft } = await import("../ui/task-edit-draft.js");
  const base = { text: "Mine", base: "Original", stamp: "Original", revision: 1 };
  assert.deepEqual(refreshTaskDraft(base, "Theirs", 2), base);
  assert.deepEqual(refreshTaskDraft(base, "Original", 2), { ...base, revision: 2 });
  assert.deepEqual(refreshTaskDraft(base, "Mine", 2), { text: "Mine", base: "Mine", stamp: "Mine", revision: 2 });
  assert.deepEqual(refreshTaskDraft({ ...base, text: "Original" }, "Theirs", 2), { text: "Theirs", base: "Theirs", stamp: "Theirs", revision: 2 });
  const blocked = { text: "My blocker", base: "", stamp: "planned", revision: 1 };
  assert.deepEqual(refreshTaskDraft(blocked, "", 2, "working"), blocked, "a changed status conflicts with an in-progress Mark blocked action");
});
