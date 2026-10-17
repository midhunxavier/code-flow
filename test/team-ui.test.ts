import { test } from "node:test";
import assert from "node:assert/strict";
import { automationNeedsAttention, defaultPlanApproval, followupMinimumCalls, memberProgress, requirementProgress, taskBlockers, teamAwaitingAnswer, teamNeedsResume } from "../ui/team-state.js";
import type { TeamState } from "../src/teams.js";
import { reconcileStreamSnapshot } from "../ui/run-stream.js";
import type { RunSummary, Step } from "../ui/types.js";

const fixture = (): TeamState => ({
  version: 1, revision: 1, wave: 1, status: "running", invocationLimit: 20, coordinationLimit: 5, maxWaves: 4, maxRepairs: 2,
  rationale: "Separate implementation and review", contracts: [], gaps: [], contextManifests: [],
  requirements: [{ id: "r1", description: "New behavior is tested" }],
  members: [
    { id: "builder-a", name: "Builder A", role: "worker", provider: "claude", model: "", effort: "", reason: "Owns code" },
    { id: "builder-b", name: "Builder B", role: "worker", provider: "claude", model: "", effort: "", reason: "Owns tests" },
  ],
  tasks: [
    { id: "code", title: "Implement behavior", owner: "builder-a", kind: "implementation", instructions: "Build it", dependsOn: [], requirements: ["r1"], acceptance: ["It works"], paths: [], status: "completed" },
    { id: "tests", title: "Test behavior", owner: "builder-b", kind: "implementation", instructions: "Test it", dependsOn: ["code"], requirements: ["r1"], acceptance: ["Tests pass"], paths: [], status: "needs_info" },
  ],
  messages: [{ id: "q1", kind: "question", sender: "builder-b", recipient: "user", taskId: "tests", body: "Should empty input be valid?", blocking: true, evidence: [], status: "open", sourceStepId: "s1", origin: "agent" }],
  metrics: { invocations: 3, coordinatorInvocations: 1, questionCount: 1, blockedTurns: 1, revisions: 0 },
});

test("Auto defaults to approval while explicit preferences and legacy defaults are respected", () => {
  assert.equal(defaultPlanApproval("auto-team", undefined), true);
  assert.equal(defaultPlanApproval("auto-team", false), false);
  assert.equal(defaultPlanApproval("auto-team", true), true);
  assert.equal(defaultPlanApproval("pipeline", undefined), false);
  assert.equal(defaultPlanApproval("pipeline", true), true);
});

test("follow-up minimums preserve single-call replies while reserving planning and review for rebuilt Auto teams", () => {
  assert.equal(followupMinimumCalls(false, false, "team"), 1);
  assert.equal(followupMinimumCalls(false, false, "claude@worker"), 1);
  assert.equal(followupMinimumCalls(true, false, "claude@worker"), 1);
  assert.equal(followupMinimumCalls(true, false, "team"), 4);
  assert.equal(followupMinimumCalls(true, true, "member:builder"), 4);
});

test("team view distinguishes same-provider members and shows the real blocking recipient", () => {
  const team = fixture();
  assert.equal(memberProgress(team, team.members[0]!), "Finished assignments");
  assert.equal(memberProgress(team, team.members[1]!), "Waiting for information");
  assert.deepEqual(taskBlockers(team, team.tasks[1]!), ["Waiting for your answer: Should empty input be valid?"]);
  team.messages[0]!.status = "answered";
  team.tasks[0]!.status = "submitted";
  assert.deepEqual(taskBlockers(team, team.tasks[1]!), [], "integrated submitted dependency can release its consumer");
  team.tasks[0]!.status = "failed";
  assert.deepEqual(taskBlockers(team, team.tasks[1]!), ["Waiting for Implement behavior"]);
});

test("coverage does not label work verified before complete tasks and applicable review", () => {
  const team = fixture();
  assert.equal(requirementProgress(team, "missing"), "unassigned");
  assert.equal(requirementProgress(team, "r1"), "in_progress");
  team.tasks[1]!.status = "completed";
  assert.equal(requirementProgress(team, "r1"), "awaiting_verification");
  team.verification = { head: "abc", reviewed: true, approved: true, check: "unknown" };
  assert.equal(requirementProgress(team, "r1"), "awaiting_verification");
  team.verification.check = "passed";
  assert.equal(requirementProgress(team, "r1"), "awaiting_verification", "an active or resumed team cannot show old evidence as verified");
  team.status = "completed";
  assert.equal(requirementProgress(team, "r1"), "verified");
  assert.equal(requirementProgress(team, "r1", "running"), "awaiting_verification", "a direct follow-up must not display the original review as current");
  team.gaps = ["Missing contract decision"];
  assert.equal(requirementProgress(team, "r1"), "awaiting_verification");
});

test("workflow display distinguishes knowledge from artifacts and stale evidence", () => {
  const team = fixture(); team.messages = []; const task = team.tasks[1]!; task.dependencyTypes = { code: "artifact" };
  assert.deepEqual(taskBlockers(team, task), ["Waiting for Implement behavior artifacts"]);
  team.tasks[0]!.head = "commit"; team.tasks[0]!.artifacts = ["code.js"];
  assert.deepEqual(taskBlockers(team, task), []);
  team.tasks[0]!.evidenceStale = true;
  assert.deepEqual(taskBlockers(team, task), ["Waiting for Implement behavior to be reverified"]);
  task.dependencyTypes.code = "knowledge";
  team.messages.push({ id: "answer", kind: "reply", sender: "builder-a", recipient: "builder-b", taskId: "tests", body: "Published contract", evidence: ["contract.md"], status: "delivered", blocking: false, origin: "agent", sourceStepId: "s1" });
  assert.deepEqual(taskBlockers(team, task), ["Waiting for Implement behavior to be reverified"]);
  team.tasks[0]!.evidenceStale = false;
  assert.deepEqual(taskBlockers(team, task), []);
});

test("blocked Auto work is resumable without treating a stopped legacy run as a team blocker", () => {
  assert.equal(teamNeedsResume({ status: "stopped", team: { status: "blocked" }, patternDone: false }), true);
  assert.equal(teamNeedsResume({ status: "running", team: { status: "blocked" } }), false, "a live question is answered in place");
  assert.equal(teamNeedsResume({ status: "stopped" }), false);
  assert.equal(teamNeedsResume({ status: "done", team: { status: "completed" }, patternDone: true }), false);
});

test("automation inbox includes live team questions and unresolved work without including unrelated chats", () => {
  assert.equal(automationNeedsAttention({ status: "running", trigger: {}, team: { status: "running", awaitingRequestId: "q1" } }), true);
  assert.equal(automationNeedsAttention({ status: "stopped", trigger: {}, team: { status: "blocked" } }), true);
  assert.equal(automationNeedsAttention({ status: "running", team: { status: "blocked", awaitingRequestId: "q1" } }), false);
  assert.equal(automationNeedsAttention({ status: "done", triage: { state: "pending" } }), true);
  assert.equal(automationNeedsAttention({ status: "done", archived: true, triage: { state: "pending" }, trigger: {} }), false);
  // After a crash the flag may linger on an interrupted run, but nobody can answer until Resume.
  assert.equal(automationNeedsAttention({ status: "interrupted", trigger: {}, team: { status: "running", awaitingRequestId: "q1" } }), false);
  assert.equal(teamAwaitingAnswer({ status: "interrupted", team: { awaitingRequestId: "q1" } }), false);
  assert.equal(teamAwaitingAnswer({ status: "running", team: { awaitingRequestId: "q1" } }), true);
});

test("reconnect replaces stale metadata and lets reused event numbers through without discarding transcripts", () => {
  const before = { id: "s1", status: "running" } as Step;
  const interrupted = { ...before, status: "interrupted" } as Step;
  const history = new Map([["s1", [{ type: "text", text: "Prior output" }]]]);
  const data = { steps: new Map([["s1", before]]), seen: new Set([7, 8, 9]), runSeq: 9, stepSeq: new Map([["s1", 9]]), events: history };
  const next = reconcileStreamSnapshot(data, { run: { id: "run", status: "interrupted" } as RunSummary, steps: [interrupted], seq: 8 });
  assert.equal(next.steps.get("s1")?.status, "interrupted");
  assert.equal(next.runSeq, 8);
  assert.equal(next.stepSeq.get("s1"), 8);
  assert.equal(next.seen.has(9), false, "an unpersisted event number may be reused after restart");
  assert.equal(next.seen.has(7), true, "already consumed persisted events are still deduplicated");
  assert.equal(next.events, history, "transcript history survives reconnect");
});

test("coverage reports a complete, reviewed result without a runnable check as unchecked, never verified", () => {
  const team = fixture();
  team.tasks.forEach((task) => { task.status = "completed"; });
  team.status = "completed";
  team.verification = { head: "abc", reviewed: true, approved: true, check: "unknown" };
  assert.equal(requirementProgress(team, "r1"), "reviewed_unchecked");
  team.verification.check = "not_required";
  assert.equal(requirementProgress(team, "r1"), "verified");
});
