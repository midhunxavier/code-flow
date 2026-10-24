import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessTeamRollout, buildTeamEvaluation, intervalDuration, TeamEvaluationStore, type TeamEvaluation } from "../src/team-evaluation.js";
import type { Run } from "../src/engine.js";
import type { TeamState } from "../src/teams.js";

const fixture = (): Run => ({ id: "fixture", pattern: "auto-team", task: "implement utility", baseRef: "base", createdAt: 0, endedAt: 1000, status: "done", verdict: "passed", prove: false,
  facts: { approved: true }, usage: { agentSteps: 3, checks: 1 }, steps: [
    { id: "plan", kind: "agent", role: "coordinator", coordination: true, invocations: 1, mode: "read", title: "Plan", startedAt: 0, endedAt: 100, status: "done" },
    { id: "worker-1", kind: "agent", role: "worker", memberId: "builder", taskId: "build", invocations: 1, mode: "write", title: "Build", startedAt: 100, endedAt: 200, status: "done" },
    { id: "worker-2", kind: "agent", role: "worker", memberId: "builder", taskId: "build", invocations: 1, mode: "write", title: "Build", startedAt: 400, endedAt: 600, status: "done" },
    { id: "check", kind: "check", role: "check", mode: "read", title: "Check", startedAt: 550, endedAt: 700, status: "done" },
  ],
  team: { version: 1, revision: 0, wave: 1, status: "completed", members: [{ id: "builder", role: "worker", provider: "claude" }], requirements: [{ id: "goal", description: "utility" }],
    tasks: [{ id: "build", owner: "builder", dependsOn: [], status: "completed", requirements: ["goal"] }], gaps: [], messages: [
      { id: "peer-q", kind: "question", sender: "builder", recipient: "coordinator", taskId: "build", sourceAttempt: 1, blocking: true, createdAt: 200, answeredAt: 300, status: "answered" },
      { id: "user-q", kind: "question", sender: "builder", recipient: "user", taskId: "build", sourceAttempt: 2, blocking: true, createdAt: 210, answeredAt: 900, status: "answered" },
    ], metrics: { invocations: 3, coordinatorInvocations: 1, questionCount: 2, blockedTurns: 2, revisions: 0 }, verification: { check: "passed", reviewed: true, approved: true, head: "result" },
  } as unknown as TeamState,
} as Run);

test("evaluation keeps unknown usage unknown and measures peer waiting without user waits", () => {
  const report = buildTeamEvaluation(fixture(), { mode: "fake" });
  assert.equal(report.verified, true);
  assert.equal(report.metrics.reportedTokens, undefined);
  assert.equal(report.metrics.reportedApiCostUsd, undefined);
  assert.equal(report.metrics.peerWaitingMs, 100);
  assert.equal(report.metrics.avoidableBarrierEstimateMs, 100);
  assert.equal(report.metrics.peerYieldRate, .5);
  assert.equal(report.metrics.activeWorkMs, 500);
  assert.match(report.limitations.join(" "), /counterfactual/);
  assert.equal(intervalDuration([[0, 10], [5, 20], [30, 40]]), 30);
});

test("worker-turn metrics include member answer and repair turns without counting coordinator or reviewer work", () => {
  const run = fixture();
  const builder = run.team!.members[0]!;
  run.team!.members.push({ ...builder, id: "coordinator", role: "coordinator" }, { ...builder, id: "reviewer", role: "reviewer" });
  const worker = run.steps[1]!;
  run.steps.push(
    { ...worker, id: "answer", memberId: "builder", title: "Answer peer question", mode: "read", taskId: undefined },
    { ...worker, id: "repair", memberId: "builder", title: "Repair integration", taskId: undefined },
    { ...worker, id: "review", memberId: "reviewer", title: "Review task", mode: "read" },
    { ...worker, id: "investigate", memberId: "coordinator", title: "Investigate task", mode: "read" },
    { ...worker, id: "legacy-worker", memberId: "missing-from-old-roster", title: "Legacy task" },
    { ...worker, id: "legacy-review", memberId: undefined, role: "reviewer", title: "Legacy review" },
    { ...worker, id: "legacy-coordinate", memberId: undefined, coordination: true, title: "Legacy coordinator task" },
  );
  const report = buildTeamEvaluation(run);
  assert.equal(report.metrics.workerTurns, 5, "two task turns, answer, repair and legacy task are worker turns");
  assert.equal(report.metrics.peerYieldRate, 1 / 5, "yield frequency uses all actual worker turns as its denominator");
});

test("multi-worker overhead samples require distinct workers that actually ran", () => {
  const run = fixture();
  run.team!.members.push({ ...run.team!.members[0]!, id: "unused-builder" });
  assert.equal(buildTeamEvaluation(run).metrics.multiWorker, false, "an unused roster slot is not a multi-worker execution");
  run.steps.push({ ...run.steps[1]!, id: "other-worker", memberId: "unused-builder" });
  assert.equal(buildTeamEvaluation(run).metrics.multiWorker, true, "distinct same-provider members count when both execute");
});

test("evaluation does not mistake a check pass for coverage, review or fail-to-pass proof", () => {
  const run = fixture();
  run.team!.requirements.push({ id: "missing", description: "unassigned behavior" });
  assert.equal(buildTeamEvaluation(run).verified, false);
  run.team!.requirements.pop(); run.prove = true;
  assert.equal(buildTeamEvaluation(run).verified, false);
  run.facts!.proof = "proven"; run.team!.verification!.reviewed = false;
  assert.equal(buildTeamEvaluation(run).verified, false);
});

test("a reply does not count as avoidable delay while an artifact dependency is unavailable", () => {
  const run = fixture(); run.team!.tasks[0]!.dependsOn = ["dependency"];
  run.team!.tasks.push({ id: "dependency", finishedAt: 350, dependsOn: [], requirements: [], status: "completed" } as any);
  assert.equal(buildTeamEvaluation(run).metrics.avoidableBarrierEstimateMs, undefined);
});

test("approval and memory feedback measurements use durable answers and exact consumed revisions", () => {
  const run = fixture(); run.memoryManifest = { included: [{ id: "lesson", revision: 2, reason: "matching path" }], omitted: [] };
  const report = buildTeamEvaluation(run, {
    journal: new Map([ ["approval:plan#1", { decision: "revise", note: "Need independent review" }], ["approval:plan#2", { decision: "approve" }] ]),
    memoryEntries: [{ id: "lesson", feedback: [ { runId: "fixture", revision: 2, rating: "useful" }, { runId: "other", revision: 2, rating: "incorrect" }, { runId: "fixture", revision: 1, rating: "stale" } ] }] as any,
  });
  assert.deepEqual(report.metrics.approvals, { approved: 1, revised: 1, rejected: 0, withReason: 1 });
  assert.deepEqual(report.metrics.memoryFeedback, { useful: 1, irrelevant: 0, stale: 0, incorrect: 0 });
});

function report(id: string, pattern: string, mode: "fake" | "real" = "real"): TeamEvaluation {
  const value = buildTeamEvaluation(fixture(), { mode, cliVersions: { claude: "test-version" }, caseId: "case", pairId: id });
  value.id = `evaluation-${id}-${pattern}`; value.pattern = pattern;
  value.metrics = { ...value.metrics, workerTurns: 5, invocations: 8, coordinatorInvocations: 2, coordinatorFraction: .25, multiWorker: true };
  return value;
}

test("rollout evidence separates fake runs and requires matched tasks and revisions", () => {
  const fake = [report("pair", "auto-team", "fake"), report("pair", "supervisor", "fake")];
  assert.equal(assessTeamRollout(fake).eligibleBeta, false);
  const real = [report("pair", "auto-team"), report("pair", "supervisor")];
  assert.equal(assessTeamRollout(real).eligibleBeta, true);
  real[1]!.baseRef = "different-base";
  assert.equal(assessTeamRollout(real).matchedPairs, 0);
  real[1]!.baseRef = "base"; real[0]!.verified = false;
  assert.equal(assessTeamRollout(real).eligibleBeta, false);
});

test("an unrelated verified Auto result cannot qualify a failed matched pair for beta", () => {
  const pair = [report("failed-pair", "auto-team"), report("failed-pair", "supervisor")];
  pair.forEach((value) => { value.verified = false; value.status = "failed"; });
  const unrelated = report("unpaired", "auto-team");
  const assessment = assessTeamRollout([...pair, unrelated]);
  assert.equal(assessment.matchedPairs, 1);
  assert.equal(assessment.verifiedAutoRuns, 1);
  assert.equal(assessment.eligibleBeta, false, "the verified Auto result must itself have a matched comparison");
});

test("default rollout requires a real sample and an explicit durable decision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "team-evaluation-test-"));
  try {
    const store = new TeamEvaluationStore(directory);
    const reports = Array.from({ length: 20 }, (_, i) => [report(`pair-${i}`, "auto-team"), report(`pair-${i}`, "supervisor")]).flat();
    await Promise.all(reports.map((value) => store.record(value)));
    assert.equal((await store.rollout()).stage, "experimental", "recording evidence never changes the default");
    assert.equal(assessTeamRollout(await store.list()).eligibleDefault, true);
    const decision = await store.decide({ stage: "default", rationale: "Synthetic test decision", evaluationIds: reports.map((value) => value.id) });
    assert.equal(decision.stage, "default");
    assert.equal((await new TeamEvaluationStore(directory).rollout(false)).enabled, false);
    await assert.rejects(store.record({ ...reports[0]!, verified: false }), /immutable/);
    await store.record(reports[0]!);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("fake or incomplete reports cannot promote rollout, and a rejected write does not poison later decisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "team-evaluation-test-"));
  try {
    const store = new TeamEvaluationStore(directory); const fake = report("fake", "auto-team", "fake"); await store.record(fake);
    await assert.rejects(store.decide({ stage: "beta", rationale: "Not enough", evaluationIds: [fake.id] }), /verified real/);
    await assert.rejects(store.decide({ stage: "default", rationale: "Not enough", evaluationIds: [fake.id] }), /20 real Auto/);
    assert.equal((await store.decide({ stage: "experimental", rationale: "Keep collecting evidence", evaluationIds: [fake.id] })).stage, "experimental");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("measured documentation proof exemption still requires checks, coverage and independent approval", () => {
  const run = fixture(); run.prove = true;
  run.facts!.proofNotRequired = "documentation-only";
  assert.equal(buildTeamEvaluation(run).verified, true);
  run.team!.verification!.reviewed = false;
  assert.equal(buildTeamEvaluation(run).verified, false);
});
