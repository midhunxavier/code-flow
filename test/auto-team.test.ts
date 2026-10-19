import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const home = mkdtempSync(join(tmpdir(), "codeflow-auto-test-"));
process.env.CODEFLOW_HOME = home;
process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
const { RunManager, TeamContext } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { flushWrites } = await import("../src/store.js");
const { memoryStore } = await import("../src/memory.js");
const { editableTeamPlan } = await import("../src/workflow-control.js");
type Run = import("../src/engine.js").Run;
const repositories: string[] = [];
after(async () => { await flushWrites(); for (const repo of repositories) rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

function repository() {
  const repo = mkdtempSync(join(tmpdir(), "codeflow-auto-repo-")); repositories.push(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "Empty input is valid.\n");
  mkdirSync(join(repo, ".codeflow")); writeFileSync(join(repo, ".codeflow", "config.json"), JSON.stringify({ prove: false }));
  writeFileSync(join(repo, "sample.test.mjs"), 'import {test} from "node:test"; import assert from "node:assert/strict"; test("baseline",()=>assert.equal(1,1));\n');
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "initial"], { cwd: repo });
  return repo;
}
async function waitFor(run: Run, manager: InstanceType<typeof RunManager>, predicate: () => boolean) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error(`Timed out: ${run.status}, ${run.error}, ${JSON.stringify(run.team)}`)); }, 30_000);
    const inspect = () => { if (predicate()) { clearTimeout(timer); unsubscribe(); resolve(); } };
    const unsubscribe = manager.subscribe(run.id, inspect); inspect();
  });
}
async function start(task: string, extra: Record<string, unknown> = {}) {
  const manager = new RunManager(findPattern);
  const run = await manager.start({ pattern: findPattern("auto-team")!, repo: repository(), task, roles: { coordinator: ["claude"], pool: ["claude", "codex"] }, options: {}, loop: { check: "node --test", maxSteps: 20 }, approvals: { plan: false }, ...extra });
  return { manager, run };
}
async function finish(task: string, extra: Record<string, unknown> = {}) {
  const item = await start(task, extra); await waitFor(item.run, item.manager, () => item.run.status !== "running"); return item;
}

test("Auto team creates independent members, runs dependency waves, and verifies the final head", async () => {
  const { run } = await finish("AUTO-SAME-PROVIDER Implement the sample");
  assert.equal(run.status, "done", run.error);
  assert.equal(run.team?.status, "completed", JSON.stringify(run.team?.gaps));
  assert.equal(run.verdict, "passed");
  assert.equal(run.team?.wave, 2);
  const workers = run.team!.members.filter((m) => m.role === "worker");
  assert.equal(workers.length, 2);
  assert.equal(workers[0]!.provider, workers[1]!.provider);
  const workerSteps = run.steps.filter((s) => s.taskId && s.kind === "agent");
  assert.notEqual(workerSteps[0]?.sessionId, workerSteps[1]?.sessionId);
  assert.deepEqual(workerSteps.map((s) => s.memberId), ["builder", "builder-two"]);
  assert.equal(run.team!.verification!.head, execFileSync("git", ["rev-parse", run.artifacts[0]!.branch], { cwd: run.repo }).toString().trim());
  const files = execFileSync("git", ["ls-tree", "--name-only", run.artifacts[0]!.branch], { cwd: run.repo }).toString();
  assert.match(files, /claude-alpha.txt/); assert.match(files, /claude-beta.txt/);
  assert.equal(run.team!.metrics.coordinatorInvocations, 1);
});

test("Auto team yields addressed questions and resumes the same task session with the answer", async () => {
  const record = mkdtempSync(join(tmpdir(), "codeflow-auto-resume-")); process.env.FAKE_RECORD_DIR = record;
  try {
  const { run } = await finish("AUTO-QUESTION Implement the sample");
  assert.equal(run.status, "done", run.error);
  assert.equal(run.team?.status, "completed", JSON.stringify(run.team?.gaps));
  const turns = run.steps.filter((s) => s.taskId === "alpha" && s.title.startsWith("Auto task"));
  assert.equal(turns.length, 2);
  const calls = readdirSync(record).map((f) => JSON.parse(readFileSync(join(record, f), "utf8")) as { prompt: string; args: string[] });
  const resumed = calls.find((call) => call.prompt.includes("AUTO_TEAM_TASK") && call.prompt.includes('"attempt": 2'))!;
  assert.ok(resumed.args.includes("--resume")); assert.ok(resumed.args.includes(turns[0]!.sessionId!));
  assert.equal(run.team!.metrics.questionCount, 1);
  assert.equal(run.team!.metrics.blockedTurns, 1);
  assert.equal(run.team!.messages.find((m) => m.kind === "reply")?.status, "delivered");
  assert.equal(run.team!.contextManifests[1]!.messageIds.length, 1);
  } finally { delete process.env.FAKE_RECORD_DIR; rmSync(record, { recursive: true, force: true }); }
});

test("Auto team user questions pause outside a worker slot and route an authenticated reply", async () => {
  const { run, manager } = await start("AUTO-USER-QUESTION Implement the sample");
  await waitFor(run, manager, () => !!run.team?.awaitingRequestId || run.status !== "running");
  assert.equal(run.status, "running", run.error);
  assert.ok(run.team!.awaitingRequestId);
  assert.ok(!run.steps.some((s) => s.status === "running"));
  await manager.answerTeamQuestion(run.id, run.team!.awaitingRequestId!, "Empty input is valid");
  await waitFor(run, manager, () => run.status !== "running");
  assert.equal(run.team!.status, "completed", run.error ?? JSON.stringify(run.team!.gaps));
  const reply = run.team!.messages.find((m) => m.kind === "reply");
  assert.equal(reply?.origin, "user"); assert.equal(reply?.sender, "user");
});

test("Auto team requires plan approval before any writer starts", async () => {
  const { run, manager } = await start("Implement the sample", { approvals: { plan: true } });
  await waitFor(run, manager, () => !!run.awaiting || run.status !== "running");
  assert.equal(run.status, "running", run.error);
  assert.equal(run.steps.filter((s) => s.kind === "agent").length, 1);
  assert.match(run.awaiting!.content, /Requirements/);
  await manager.answer(run.id, { decision: "approve" });
  await waitFor(run, manager, () => run.status !== "running");
  assert.equal(run.team!.status, "completed", run.error ?? JSON.stringify(run.team!.gaps));
});

test("human workflow edits survive cancellation and replay and control the approved dispatch", async () => {
  const { run, manager } = await start("Implement the editable sample", { approvals: { plan: true } });
  await waitFor(run, manager, () => !!run.awaiting || run.status !== "running");
  assert.ok(run.awaiting, run.error);
  const original = editableTeamPlan(run.team!);
  const edit = structuredClone(original);
  edit.tasks[0]!.title = "Human-reviewed implementation";
  edit.tasks[0]!.instructions += " Preserve the approved human instruction.";
  await manager.editTeamPlan(run.id, edit);
  assert.equal(run.team!.revision, original.revision + 1);
  assert.match(run.awaiting!.content, /Human-reviewed implementation/);
  await assert.rejects(manager.editTeamPlan(run.id, original), /plan changed/i);
  const second = editableTeamPlan(run.team!);
  second.contracts.push("Preserve the public API.");
  await manager.editTeamPlan(run.id, second);
  manager.cancel(run.id);
  await waitFor(run, manager, () => run.status !== "running");
  await manager.shutdown();
  await flushWrites();
  const reloaded = new RunManager(findPattern);
  await reloaded.load();
  const resumed = await reloaded.resume(run.id);
  await waitFor(resumed, reloaded, () => !!resumed.awaiting || resumed.status !== "running");
  assert.equal(resumed.team!.tasks[0]!.title, "Human-reviewed implementation");
  assert.equal(resumed.team!.revision, original.revision + 2);
  assert.ok(resumed.team!.contracts.includes("Preserve the public API."));
  assert.equal(resumed.steps.filter((step) => step.kind === "agent").length, 1, "planning was replayed without a second CLI turn");
  reloaded.answer(run.id, { decision: "approve" });
  await waitFor(resumed, reloaded, () => resumed.status !== "running");
  assert.equal(resumed.status, "done", resumed.error);
  assert.ok(resumed.steps.some((step) => step.title.includes("Human-reviewed implementation")), "the edited task was dispatched");
  await assert.rejects(reloaded.editTeamPlan(run.id, second), /not waiting/i);
  await reloaded.shutdown();
});

test("Auto team keeps missing artifacts as gaps even when the integration check passes", async () => {
  const { run } = await finish("AUTO-NO-CHANGE Implement the sample", { options: { maxRepairs: 0 } });
  assert.equal(run.status, "stopped", run.error);
  assert.equal(run.team!.status, "blocked");
  assert.equal(run.facts?.approved, false);
  assert.notEqual(run.verdict, "passed");
  assert.match(run.team!.gaps.join(" "), /no changes|missing|not completed/i);
});

test("Auto team resumes a final-wave user question after replaying the earlier final verification", async () => {
  const { run, manager } = await finish("AUTO-USER-QUESTION Implement the sample", { options: { maxWaves: 1 } });
  assert.equal(run.status, "stopped", run.error);
  assert.equal(run.team!.messages.filter((m) => m.kind === "question").length, 1);
  await manager.resume(run.id);
  await waitFor(run, manager, () => !!run.team?.awaitingRequestId || run.status !== "running");
  assert.equal(run.status, "running", run.error);
  await manager.answerTeamQuestion(run.id, run.team!.awaitingRequestId!, "Empty input is valid");
  await waitFor(run, manager, () => run.status !== "running");
  assert.equal(run.status, "done", run.error);
  assert.equal(run.team!.status, "completed", JSON.stringify(run.team!.gaps));
  assert.equal(run.steps.filter((s) => s.title === "Plan Auto team").length, 1);
  assert.equal(run.steps.filter((s) => s.title.startsWith("Auto task")).length, 2);
  assert.equal(run.steps.filter((s) => s.title.startsWith("Auto team independent review")).length, 2);
});

test("Auto team investigation can finish with evidence without editing files", async () => {
  const { run } = await finish("AUTO-INVESTIGATION Explain the existing contract", { loop: { maxSteps: 20 }, prove: false });
  assert.equal(run.status, "done", run.error);
  assert.equal(run.team!.status, "completed", JSON.stringify(run.team!.gaps));
  assert.equal(run.team!.verification!.check, "not_required");
});

test("Auto team private checkpoints do not enter coordinator revisions or another worker's context", async () => {
  const record = mkdtempSync(join(tmpdir(), "codeflow-auto-prompts-")); process.env.FAKE_RECORD_DIR = record;
  try {
    const { run } = await finish("AUTO-SAME-PROVIDER Implement the sample");
    assert.equal(run.status, "done", run.error);
    const prompts = readdirSync(record).map((f) => JSON.parse(readFileSync(join(record, f), "utf8")) as { prompt: string });
    const beta = prompts.find((p) => p.prompt.includes("AUTO_TEAM_TASK") && p.prompt.includes('"id": "beta"'));
    assert.ok(beta); assert.doesNotMatch(beta.prompt, /Completed alpha with evidence/);
  } finally { delete process.env.FAKE_RECORD_DIR; rmSync(record, { recursive: true, force: true }); }
});

test("Auto team replaces an idle failed worker and hands over its worktree with a fresh member session", async () => {
  const record = mkdtempSync(join(tmpdir(), "codeflow-auto-handover-")); process.env.FAKE_RECORD_DIR = record;
  try {
  const { run } = await finish("AUTO-HANDOVER Implement the sample");
  assert.equal(run.status, "done", run.error);
  assert.equal(run.team!.status, "completed", JSON.stringify(run.team!.gaps));
  assert.equal(run.team!.members.find((m) => m.id === "builder")!.status, "retired");
  assert.equal(run.team!.tasks[0]!.owner, "replacement");
  assert.deepEqual(run.steps.filter((s) => s.title.startsWith("Auto task")).map((s) => s.memberId), ["builder", "replacement"]);
  const prompts = readdirSync(record).map((f) => JSON.parse(readFileSync(join(record, f), "utf8")) as { prompt: string });
  const replacement = prompts.find((p) => p.prompt.includes("AUTO_TEAM_TASK") && p.prompt.includes('"id": "replacement"'))!;
  assert.match(replacement.prompt, /Shared output and next actions for alpha/);
  assert.doesNotMatch(replacement.prompt, /The requested work is blocked/, "the retired member's private checkpoint is not handed over");
  } finally { delete process.env.FAKE_RECORD_DIR; rmSync(record, { recursive: true, force: true }); }
});

test("Auto team restart replays completed planning, work, and questions before a fresh final review", async () => {
  process.env.FAKE_SLEEP_VENDOR = "codex"; process.env.FAKE_SLEEP_MS = "5000";
  const { run, manager } = await start("AUTO-QUESTION Implement the sample");
  try {
    await waitFor(run, manager, () => run.steps.some((s) => s.title.startsWith("Auto team independent review") && s.status === "running") || run.status !== "running");
    assert.equal(run.status, "running", run.error);
    await manager.shutdown();
  } finally { delete process.env.FAKE_SLEEP_VENDOR; delete process.env.FAKE_SLEEP_MS; }
  const resumed = new RunManager(findPattern); await resumed.load();
  const loaded = resumed.get(run.id)!; await resumed.resume(run.id);
  await waitFor(loaded, resumed, () => loaded.status !== "running");
  assert.equal(loaded.status, "done", loaded.error);
  assert.equal(loaded.team!.status, "completed", JSON.stringify(loaded.team!.gaps));
  assert.equal(loaded.steps.filter((s) => s.title === "Plan Auto team").length, 1);
  assert.equal(loaded.steps.filter((s) => s.title.startsWith("Auto task")).length, 2);
  assert.equal(loaded.team!.messages.filter((m) => m.kind === "question").length, 1);
});

test("Auto team restart preserves a final repair commit before re-reviewing it", async () => {
  process.env.FAKE_REVIEW_FAIL_ONCE = "1"; rmSync(join(home, ".reviewed-once"), { force: true });
  const { run, manager } = await start("Implement the sample");
  const unsubscribe = manager.subscribe(run.id, (event) => {
    if (event.type === "step" && event.step.title === "Auto team repair (1)" && event.step.status === "done") {
      process.env.FAKE_SLEEP_VENDOR = "codex"; process.env.FAKE_SLEEP_MS = "5000";
    }
  });
  try {
    await waitFor(run, manager, () => run.steps.some((s) => s.title === "Auto team independent review (2)" && s.status === "running") || run.status !== "running");
    assert.equal(run.status, "running", run.error);
    await manager.shutdown();
  } finally { unsubscribe(); delete process.env.FAKE_REVIEW_FAIL_ONCE; delete process.env.FAKE_SLEEP_VENDOR; delete process.env.FAKE_SLEEP_MS; }
  const branch = run.worktrees.find((w) => w.name === "integration")!.branch;
  const repairedHead = execFileSync("git", ["rev-parse", branch], { cwd: run.repo }).toString().trim();
  const resumed = new RunManager(findPattern); await resumed.load(); const loaded = resumed.get(run.id)!;
  await resumed.resume(run.id); await waitFor(loaded, resumed, () => loaded.status !== "running");
  assert.equal(loaded.status, "done", loaded.error);
  assert.equal(loaded.team!.verification!.head, repairedHead);
  assert.equal(loaded.steps.filter((s) => s.title.startsWith("Auto team repair")).length, 1, "the completed repair is replayed, not authored twice");
  assert.equal(loaded.facts!.approved, true);
});

test("Auto team resumes after memory acceptance persisted but its journal acknowledgement did not", async () => {
  const original = memoryStore.accept.bind(memoryStore);
  let interrupted = false;
  memoryStore.accept = async (...args: Parameters<typeof original>) => {
    const result = await original(...args);
    if (!interrupted && args[4]?.endsWith(":accept")) {
      interrupted = true;
      throw new Error("Simulated interruption after durable acceptance, before journal acknowledgement");
    }
    return result;
  };
  let item: Awaited<ReturnType<typeof finish>>;
  try { item = await finish("Implement the sample"); }
  finally { memoryStore.accept = original; }
  assert.ok(interrupted);
  assert.equal(item.run.status, "failed");
  await item.manager.resume(item.run.id);
  await waitFor(item.run, item.manager, () => item.run.status !== "running");
  assert.equal(item.run.status, "done", item.run.error);
  assert.equal(item.run.team!.status, "completed");
  assert.equal(item.run.steps.filter((s) => s.title.startsWith("Auto task")).length, 1, "completed work was not repeated to reconcile memory");
});


test("Auto event scheduler integrates a dependency and starts its successor before an unrelated member finishes", async () => {
  const release = join(home, "slow-task-release");
  process.env.FAKE_AUTO_SLOW_RELEASE = release;
  const safety = setTimeout(() => writeFileSync(release, "release"), 25000);
  let item: Awaited<ReturnType<typeof start>> | undefined;
  try {
    item = await start("AUTO-EVENT Implement the sample", { options: { eventDriven: true } });
    const { run, manager } = item;
    await waitFor(run, manager, () => run.steps.some((step) => step.taskId === "beta" && step.title.startsWith("Auto task")) || run.status !== "running");
    const alpha = run.steps.find((step) => step.taskId === "alpha" && step.title.startsWith("Auto task"))!;
    const beta = run.steps.find((step) => step.taskId === "beta" && step.title.startsWith("Auto task"))!;
    const slow = run.steps.find((step) => step.taskId === "slow" && step.title.startsWith("Auto task"));
    assert.ok(beta, run.error);
    assert.ok(beta.startedAt >= alpha.endedAt!, "the successor waits for its own dependency");
    assert.ok(!slow?.endedAt, "the successor starts while the unrelated worker remains held at its explicit checkpoint");
    writeFileSync(release, "release");
    await waitFor(run, manager, () => run.status !== "running");
    assert.equal(run.status, "done", run.error);
    assert.equal(run.team!.scheduler, "event");
    assert.ok(run.team!.contextManifests.find((manifest) => manifest.taskId === "beta")!.inputHead);
    assert.equal(run.team!.verification!.approved, true);
  } finally {
    clearTimeout(safety); writeFileSync(release, "release"); delete process.env.FAKE_AUTO_SLOW_RELEASE;
    if (item?.run.status === "running") await item.manager.shutdown();
  }
});


test("explicit legacy wave mode retains a barrier and remains available for saved workflows", async () => {
  const { run } = await finish("AUTO-EVENT Implement the sample", { options: { eventDriven: false } });
  assert.equal(run.status, "done", run.error);
  assert.equal(run.team!.scheduler, "waves");
  const beta = run.steps.find((step) => step.taskId === "beta" && step.title.startsWith("Auto task"))!;
  const slow = run.steps.find((step) => step.taskId === "slow" && step.title.startsWith("Auto task"))!;
  assert.ok(beta.startedAt >= slow.endedAt!);
});


test("Auto event recovery preserves accepted completion order while interrupted peers rerun safely", async () => {
  const { run, manager } = await start("AUTO-EVENT Implement the sample", { options: { eventDriven: true } });
  await waitFor(run, manager, () => run.steps.some((step) => step.taskId === "beta" && step.status === "running") || run.status !== "running");
  assert.equal(run.status, "running", run.error);
  await manager.shutdown();
  const resumed = new RunManager(findPattern); await resumed.load(); const loaded = resumed.get(run.id)!;
  await resumed.resume(run.id); await waitFor(loaded, resumed, () => loaded.status !== "running");
  assert.equal(loaded.status, "done", loaded.error);
  assert.equal(loaded.steps.filter((step) => step.title === "Plan Auto team").length, 1);
  assert.equal(loaded.steps.filter((step) => step.taskId === "alpha").length, 1, "completed dependency work must replay without a new CLI call");
  assert.deepEqual(loaded.team!.tasks.map((task) => task.id).sort(), ["alpha", "beta", "slow"]);
  assert.ok(loaded.team!.tasks.every((task) => task.status === "completed"));
  assert.equal(loaded.team!.verification!.approved, true);
});

test("Auto planning expands a reusable subplan into visible approved tasks and independent verification", async () => {
  const { run } = await finish("AUTO-SUBPLAN Implement the sample", { options: { eventDriven: true } });
  assert.equal(run.status, "done", run.error);
  assert.deepEqual(run.team!.tasks.map((task) => task.id), ["sample-investigate", "sample-implement"]);
  assert.equal(run.team!.strategyInstances![0]!.strategy, "investigate-implement");
  assert.equal(run.team!.verification!.approved, true);
});


test("changed contracts invalidate accepted artifact evidence until independent revalidation", async () => {
  const { run } = await finish("AUTO-CONTRACT-CHANGE Implement the sample", { options: { eventDriven: true } });
  assert.equal(run.status, "done", run.error);
  assert.ok(run.steps.some((step) => step.title === "Review revised contracts (1)"));
  assert.equal(run.steps.filter((step) => step.taskId === "alpha" && step.title.startsWith("Auto task")).length, 1, "an accepted task is revalidated without rewriting it");
  assert.equal(run.team!.tasks.find((task) => task.id === "alpha")!.evidenceRevision, 1);
  assert.ok(run.team!.tasks.every((task) => !task.evidenceStale));
  assert.equal(run.team!.verification!.revision, 1);
  assert.equal(run.team!.verification!.approved, true);
});

test("Auto plans and reserves review against the smaller actual invocation ceiling", async () => {
  const { run } = await finish("Implement the sample", { loop: { check: "node --test", maxSteps: 20, maxInvocations: 4 } });
  assert.equal(run.status, "done", run.error);
  assert.equal(run.team!.invocationLimit, 4);
  assert.equal(run.team!.coordinationLimit, 1);
  assert.equal(run.team!.verification!.approved, true);
  assert.ok(run.team!.metrics.invocations <= 4);
});

test("Auto rejects an actual invocation ceiling below four before spending planning quota", async () => {
  const { run } = await finish("Implement the sample", { loop: { check: "node --test", maxSteps: 20, maxInvocations: 3 } });
  assert.equal(run.status, "failed", run.error);
  assert.match(run.error!, /at least four invocations/);
  assert.equal(run.steps.filter((step) => step.kind === "agent").length, 0);
});


test("a resumed event task reconciles its captured input instead of a newer peer commit", async () => {
  const merge = TeamContext.prototype.merge;
  let advanced = false;
  TeamContext.prototype.merge = async function (wt, from) {
    if (!advanced && wt.name === "auto-alpha") {
      advanced = true;
      // Simulate another artifact landing after the scheduler captured this
      // attempt's input but before the yielded worktree reconciles it.
      const integration = this.run.worktrees.find((entry) => entry.name === "integration")!;
      writeFileSync(join(integration.path, "later-peer.txt"), "A later peer artifact\n");
      await this.commit({ ...integration, base: this.run.baseRef }, "Test: concurrent peer artifact");
    }
    return merge.call(this, wt, from);
  };
  try {
    const { run } = await finish("AUTO-QUESTION Implement the sample", { options: { eventDriven: true } });
    assert.equal(run.status, "done", run.error);
    assert.ok(advanced);
    const task = run.worktrees.find((wt) => wt.name === "auto-alpha")!;
    const integration = run.worktrees.find((wt) => wt.name === "integration")!;
    const files = (branch: string) => execFileSync("git", ["ls-tree", "--name-only", branch], { cwd: run.repo }).toString();
    assert.doesNotMatch(files(task.branch), /later-peer\.txt/, "the attempt must not import changes beyond its captured input");
    assert.match(files(integration.branch), /later-peer\.txt/, "the later peer artifact remains on the integrated result");
    assert.equal(run.team!.verification!.approved, true);
  } finally { TeamContext.prototype.merge = merge; }
});

test("Auto team without a runnable check finishes reviewed but unverified, instead of blocking on every Resume", async () => {
  const { run } = await finish("Implement the sample", { loop: { maxSteps: 20 } });
  assert.equal(run.status, "done", run.error);
  assert.equal(run.team!.status, "completed", JSON.stringify(run.team!.gaps));
  assert.deepEqual(run.team!.gaps, []);
  assert.equal(run.team!.verification!.check, "unknown");
  assert.equal(run.team!.verification!.reviewed, true);
  assert.equal(run.team!.verification!.approved, true);
  assert.equal(run.verdict, undefined, "no check ran, so there is no pass/fail verdict");
  assert.ok(run.team!.tasks.every((task) => task.status === "completed"));
  assert.match(run.summary ?? "", /unverified: no runnable check/);
  // Unverified work stays a proposal: nothing is accepted into team knowledge beyond the plan's contracts.
  const entries = await memoryStore.list({ repo: run.repo, runId: run.id, scope: "team" }, { kind: "user", repo: run.repo });
  assert.ok(entries.length > 0);
  assert.ok(entries.filter((entry) => !entry.title.startsWith("Accepted team contract")).every((entry) => entry.status !== "accepted"), JSON.stringify(entries.map((e) => [e.title, e.status])));
});

test("Auto team stops asking the coordinator once a revision changes nothing", async () => {
  // AUTO-FAILURE makes every worker turn fail; the fake coordinator then retries within maxRepairs and finally returns an empty patch.
  const { run } = await finish("AUTO-FAILURE Implement the sample", { options: { maxRepairs: 1 } });
  assert.equal(run.status, "stopped", run.error);
  assert.equal(run.team!.status, "blocked");
  const revisions = run.steps.filter((s) => s.title.startsWith("Revise workflow"));
  assert.ok(revisions.length >= 1 && revisions.length <= 2, `coordinator revisions: ${revisions.length}`);
  assert.ok(run.team!.metrics.coordinatorInvocations < run.team!.coordinationLimit + 1, "a no-op revision must not exhaust the coordination budget");
});


test("Auto team dispatches distinct selected models from one provider without leaking primary effort", async () => {
  const { run } = await finish("AUTO-SAME-PROVIDER AUTO-MODEL-POOL Implement the sample", {
    roleSettings: { pool: { claude: { model: "opus", effort: "high", variants: [{ model: "sonnet" }] } } },
  });
  assert.equal(run.status, "done", run.error);
  const members = run.team!.members.filter(member => member.role === "worker");
  assert.deepEqual(members.map(member => [member.provider, member.model, member.effort]), [["claude", "opus", "high"], ["claude", "sonnet", ""]]);
  const steps = run.steps.filter(step => step.taskId && step.kind === "agent");
  assert.deepEqual(steps.map(step => step.settings), [{ model: "opus", effort: "high" }, { model: "sonnet", effort: "" }]);
  assert.notEqual(steps[0]!.sessionId, steps[1]!.sessionId);
  assert.deepEqual(run.team!.inventory!.providers.find(p => p.id === "claude")!.settingsByRole!.worker!.variants, [{ model: "sonnet" }]);
});
