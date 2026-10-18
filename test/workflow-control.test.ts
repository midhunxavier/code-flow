import test from "node:test";
import assert from "node:assert/strict";
import { editableTeamPlan, summarizeTeamPlan, teamPlanPolicy, TeamPlanEditError, validateTeamPlanEdit } from "../src/workflow-control.js";
import { analyzeRunTiming, analyzeWorkflow } from "../src/run-analysis.js";
import type { TeamState, TeamTask } from "../src/teams.js";
import type { Step } from "../src/engine.js";

const teamFixture = (): TeamState => ({
  version: 1, revision: 2, status: "awaiting_approval", wave: 0, invocationLimit: 20, coordinationLimit: 4, maxWaves: 4, maxRepairs: 2,
  requirements: [{ id: "goal", description: "Implement the requested behavior" }],
  members: [
    { id: "coordinator", name: "Planner", role: "coordinator", provider: "claude", model: "", effort: "", reason: "Plans the work" },
    { id: "worker", name: "Builder", role: "worker", provider: "claude", model: "", effort: "", reason: "Builds the change" },
    { id: "reviewer", name: "Reviewer", role: "reviewer", provider: "codex", model: "", effort: "", reason: "Reviews independently" },
  ],
  tasks: [
    { id: "inspect", title: "Inspect current behavior", owner: "coordinator", kind: "investigation", instructions: "Inspect the existing implementation and publish evidence.", dependsOn: [], requirements: ["goal"], acceptance: ["Current behavior is documented"], paths: [], status: "pending", attempts: 0 },
    { id: "build", title: "Implement behavior", owner: "worker", kind: "implementation", instructions: "Implement the behavior and its tests.", dependsOn: ["inspect"], dependencyTypes: { inspect: "knowledge" }, requirements: ["goal"], acceptance: ["Behavior passes tests"], paths: ["src"], status: "pending", attempts: 0 },
  ],
  contracts: ["Preserve API compatibility"], rationale: "Inspect, implement, then independently review.",
  inventory: { at: 1, ranking: ["claude", "codex"], providers: [{ id: "claude", available: true, quotaKnown: false }, { id: "codex", available: true, quotaKnown: false }] },
  metrics: { invocations: 1, coordinatorInvocations: 1, questionCount: 0, blockedTurns: 0, revisions: 0 }, messages: [], contextManifests: [], gaps: [],
});
const input = { roles: { coordinator: ["claude"], pool: ["claude", "codex"] } as Record<string, Array<"claude" | "codex">>, options: { maxMembers: 4, maxTasks: 6, differentProviderReview: true } };
const policy = () => teamPlanPolicy(teamFixture(), input);

test("pending plan editing preserves member identity, requirements and runtime-independent task fields", () => {
  const team = teamFixture();
  const draft = editableTeamPlan(team);
  draft.tasks[1]!.title = "Implement with focused tests";
  draft.contracts.push("Keep the public response shape");
  const plan = validateTeamPlanEdit(draft, team, policy());
  assert.equal(plan.tasks[1]!.title, "Implement with focused tests");
  assert.deepEqual(plan.members, team.members);
  assert.deepEqual(plan.requirements, team.requirements);
  assert.notEqual(plan.members, team.members);
  assert.equal(plan.tasks[1]!.status, "pending");
  assert.equal(plan.tasks[1]!.attempts, 0);
  assert.equal("sessionId" in draft.tasks[0]!, false);
  assert.match(summarizeTeamPlan({ ...team, ...plan }), /Implement with focused tests/);
});

test("plan editing rejects stale revisions and any execution that has already started", () => {
  const team = teamFixture(); const draft = editableTeamPlan(team);
  for (const changed of [{ ...team, revision: 3 }, { ...team, status: "running" as const }, { ...team, tasks: [{ ...team.tasks[0]!, attempts: 1 }, team.tasks[1]!] }]) {
    assert.throws(() => validateTeamPlanEdit(draft, changed, policy()), (error) => error instanceof TeamPlanEditError && error.status === 409);
  }
});

test("plan editing rejects runtime injection, identity changes and unbounded input before validation", () => {
  const team = teamFixture(); const draft = editableTeamPlan(team);
  assert.throws(() => validateTeamPlanEdit({ ...draft, members: [] }, team, policy()), /Members and requirements stay fixed/);
  assert.throws(() => validateTeamPlanEdit({ ...draft, tasks: [{ ...draft.tasks[0], status: "completed" }] }, team, policy()), /runtime fields/);
  assert.throws(() => validateTeamPlanEdit({ ...draft, contracts: Array.from({ length: 25 }, (_, i) => `Contract ${i}`) }, team, policy()), /at most 24/);
  assert.throws(() => validateTeamPlanEdit({ ...draft, tasks: Array.from({ length: 7 }, (_, i) => ({ ...draft.tasks[1], id: `task-${i}` })) }, team, policy()), /between 1 and 6/);
  assert.throws(() => validateTeamPlanEdit({ ...draft, rationale: "bad\0text" }, team, policy()), /Rationale/);
});

test("existing plan validation guards cycles, unsafe paths, coverage and reviewer ownership", () => {
  const team = teamFixture();
  const cases: Array<(draft: ReturnType<typeof editableTeamPlan>) => void> = [
    (draft) => { draft.tasks[0]!.dependsOn = ["build"]; },
    (draft) => { draft.tasks[1]!.paths = ["../outside"]; },
    (draft) => { draft.tasks[1]!.owner = "reviewer"; },
    (draft) => { draft.tasks[1]!.owner = "coordinator"; },
    (draft) => { draft.tasks[1]!.requirements = []; },
    (draft) => { draft.tasks[1]!.dependsOn = ["missing"]; },
    (draft) => { draft.tasks[1]!.dependencyTypes = { missing: "artifact" }; },
  ];
  for (const change of cases) { const draft = editableTeamPlan(team); change(draft); assert.throws(() => validateTeamPlanEdit(draft, team, policy()), TeamPlanEditError); }
  const unavailable = { ...team, inventory: undefined };
  assert.throws(() => teamPlanPolicy(unavailable, input), /inventory is unavailable/);
});

const timedTask = (id: string, dependsOn: string[], start: number, end: number): TeamTask => ({ id, title: id, owner: "worker", kind: "implementation", instructions: "Build", requirements: ["goal"], acceptance: ["Pass"], paths: [id], dependsOn, status: "completed", attempts: 1, startedAt: start, finishedAt: end });
test("workflow graph computes layers and measured critical chain across parallel branches", () => {
  const tasks = [timedTask("a", [], 0, 100), timedTask("b", [], 0, 300), timedTask("c", ["a"], 100, 250), timedTask("d", ["b", "c"], 300, 500), timedTask("e", ["d"], 500, 600)];
  const graph = analyzeWorkflow({ tasks }, { now: 700 });
  assert.deepEqual(graph.layers, [["a", "b"], ["c"], ["d"], ["e"]]);
  assert.deepEqual(graph.criticalPath, ["b", "d", "e"]);
  assert.equal(graph.measuredCriticalPathMs, 600);
  assert.equal(graph.completeTiming, true);
  assert.equal(graph.edges.length, 4);
});

test("workflow timing reports partial observations and handles damaged graphs without inventing estimates", () => {
  const task = timedTask("active", [], 500, 400); task.status = "running";
  const unknown = { ...timedTask("unknown", ["active"], 0, 1), startedAt: undefined, finishedAt: undefined, status: "pending" as const };
  const graph = analyzeWorkflow({ tasks: [task, unknown] }, { now: 800 });
  assert.equal(graph.nodes[0]!.durationMs, 300, "an active retry ignores the previous attempt's end time");
  assert.equal(graph.nodes[1]!.durationMs, undefined);
  assert.equal(graph.completeTiming, false);
  assert.equal(graph.timedTasks, 1);
  task.dependsOn = ["unknown"];
  assert.match(analyzeWorkflow({ tasks: [task, unknown] }).warnings.join(" "), /cycle/);
  task.dependsOn = ["missing"];
  assert.match(analyzeWorkflow({ tasks: [task] }).warnings.join(" "), /missing task/);
});

test("run timing separates cumulative work from elapsed occupancy and explicit waits", () => {
  const team = teamFixture();
  team.waits = [{ requestId: "wait", taskId: "build", memberId: "worker", attempt: 1, status: "resolved", createdAt: 200, resolvedAt: 400, deadlineAt: 500 }];
  const step = (id: string, start: number, end: number, patch: Partial<Step> = {}): Step => ({ id, kind: "agent", title: id, role: "worker", mode: "write", status: "done", startedAt: start, endedAt: end, ...patch });
  const steps = [step("a", 0, 100), step("b", 0, 300), step("c", 100, 250), step("d", 300, 500), step("e", 500, 600), step("coord", 0, 40, { role: "coordinator", coordination: true }), step("checks", 600, 650, { kind: "check" })];
  const timing = analyzeRunTiming({ createdAt: 0, endedAt: 700, status: "done", team }, steps, 700);
  assert.equal(timing.workerMs, 850);
  assert.equal(timing.coordinationMs, 40);
  assert.equal(timing.checksMs, 50);
  assert.equal(timing.occupiedMs, 650);
  assert.equal(timing.unattributedMs, 50);
  assert.equal(timing.waitingMs, 200);
  assert.equal(timing.overlaps, true);
  assert.equal(analyzeRunTiming({ createdAt: 0, endedAt: 700, status: "done" }, [step("invalid", 600, 400)], 700).untimedSteps, 1);
});
