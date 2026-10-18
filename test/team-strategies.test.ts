import { test } from "node:test";
import assert from "node:assert/strict";
import { coordinatorCheckpoint, expandSubplans, strategyInstances } from "../src/patterns/team-strategies.js";
import { readyTasks } from "../src/patterns/auto-team-model.js";
import type { TeamPlan, TeamState } from "../src/teams.js";

const plan: TeamPlan = { requirements: [{ id: "goal", description: "Ship" }], members: [], tasks: [], contracts: [], rationale: "Reusable", subplans: [{ id: "api", strategy: "investigate-implement", owner: "builder", requirements: ["goal"], acceptance: ["Contract preserved"], paths: ["src/api"], dependsOn: [], instructions: "Implement the API" }] };

test("reusable subplans expand into visible bounded tasks preserving requirements and dependencies", () => {
  const tasks = expandSubplans(plan);
  assert.deepEqual(tasks.map((t) => t.id), ["api-investigate", "api-implement"]);
  assert.deepEqual(tasks[1]!.dependsOn, ["api-investigate"]);
  assert.equal(tasks[1]!.dependencyTypes?.["api-investigate"], "knowledge");
  assert.ok(tasks.every((t) => t.requirements[0] === "goal"));
  assert.deepEqual(strategyInstances(plan.subplans, 3), [{ id: "api", strategy: "investigate-implement", taskIds: ["api-investigate", "api-implement"], revision: 3 }]);
  assert.throws(() => expandSubplans({ ...plan, subplans: [{ ...plan.subplans![0]!, id: "unsafe/id" }] }), /Subplan IDs/);
});

test("typed dependencies distinguish required code from addressed knowledge", () => {
  const tasks = expandSubplans(plan); tasks.forEach((t) => t.status = "pending");
  tasks[0]!.status = "needs_info";
  tasks[1]!.owner = "second";
  const reply = { id: "r", kind: "reply" as const, sender: "builder", recipient: "second", taskId: tasks[1]!.id, requestId: "q", body: "Use the existing interface", blocking: false, evidence: ["src/api.ts:10"], status: "answered" as const, sourceStepId: "s", origin: "agent" as const };
  assert.deepEqual(readyTasks(tasks, [reply]).map((t) => t.id), ["api-implement"]);
  tasks[1]!.dependencyTypes = { "api-investigate": "artifact" };
  assert.deepEqual(readyTasks(tasks, [reply]), []);
  tasks[0]!.status = "submitted"; tasks[0]!.artifacts = ["src/api.ts"];
  assert.deepEqual(readyTasks(tasks, [reply]), []);
  tasks[0]!.head = "accepted-integration-commit";
  assert.equal(readyTasks(tasks, [reply])[0]?.id, "api-implement");
  tasks[0]!.evidenceStale = true;
  assert.deepEqual(readyTasks(tasks, [reply]), [], "changed contracts invalidate artifact evidence before downstream dispatch");
});

test("coordinator checkpoints retain decisions and published handovers without private context", () => {
  const tasks = expandSubplans(plan); tasks[0]!.status = "submitted"; tasks[0]!.artifacts = ["api-report"]; tasks[0]!.checkpoint = "PRIVATE SECRET";
  tasks[1]!.status = "needs_info"; tasks[1]!.handover = "Public handover";
  const input = { ...plan, tasks, version: 1, revision: 2, messages: [{ id: "q", kind: "question", sender: "builder", recipient: "user", body: "Choose behavior", status: "open" }] } as unknown as TeamState;
  const checkpoint = coordinatorCheckpoint(input, "head", 10, 2);
  assert.equal(checkpoint.completed[0]?.id, "api-investigate");
  assert.equal(checkpoint.unfinished[0]?.handover, "Public handover");
  assert.equal(checkpoint.openDecisions[0]?.to, "user");
  assert.equal(checkpoint.remainingCoordination, 2);
  assert.ok(!JSON.stringify(checkpoint).includes("PRIVATE SECRET"));
});
