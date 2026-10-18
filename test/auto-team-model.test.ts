import { test } from "node:test";
import assert from "node:assert/strict";
import { outcomeProblem, ownsPath, planProblem, readyTasks, revisionProblem, type TaskOutcome, type TeamPolicy, type TeamRevision } from "../src/patterns/auto-team-model.js";
import type { TeamPlan, TeamState } from "../src/teams.js";

const policy: TeamPolicy = { coordinator: "claude", pool: ["claude", "codex"], inventory: { at: 0, ranking: ["claude", "codex"], providers: [{ id: "claude", available: true, quotaKnown: false }, { id: "codex", available: true, quotaKnown: false }] }, maxMembers: 4, maxTasks: 12, differentProviderReview: false };
function plan(): TeamPlan {
  return { rationale: "Small team", requirements: [{ id: "goal", description: "Build the feature" }], contracts: [], members: [
    { id: "coordinator", name: "Lead", role: "coordinator", provider: "claude", model: "", effort: "", reason: "Plan" },
    { id: "builder", name: "Builder", role: "worker", provider: "claude", model: "", effort: "", reason: "Build" },
    { id: "reviewer", name: "Reviewer", role: "reviewer", provider: "codex", model: "", effort: "", reason: "Independent review" },
  ], tasks: [{ id: "api", title: "API", instructions: "Build API", kind: "implementation", owner: "builder", dependsOn: [], requirements: ["goal"], acceptance: ["Tests pass"], paths: ["src/api"], status: "pending" }] };
}
function state(): TeamState { return { ...plan(), version: 1, revision: 0, wave: 1, status: "running", invocationLimit: 20, coordinationLimit: 4, maxWaves: 4, maxRepairs: 2, messages: [], contextManifests: [], metrics: { invocations: 1, coordinatorInvocations: 1, questionCount: 0, blockedTurns: 0, revisions: 0 }, gaps: [] }; }
const revision = (): TeamRevision => ({ reason: "Adjust", addTasks: [], addMembers: [], retireMembers: [], reassignments: [], retryTasks: [], contracts: [], answers: [] });

test("team composition rejects identity collisions, cycles, orphan requirements, and reviewer authorship", () => {
  assert.equal(planProblem(plan(), policy), undefined);
  let p = plan(); p.members[1]!.id = "coordinator"; assert.match(planProblem(p, policy)!, /unique/);
  p = plan(); p.tasks[0]!.dependsOn = ["api"]; assert.match(planProblem(p, policy)!, /dependency/);
  p = plan(); p.requirements.push({ id: "forgotten", description: "Must ship" }); assert.match(planProblem(p, policy)!, /every requirement/);
  p = plan(); p.tasks[0]!.owner = "reviewer"; assert.match(planProblem(p, policy)!, /non-reviewer/);
});

test("same-provider identities are allowed but exhausted providers and invented settings are rejected", () => {
  const p = plan(); p.members.push({ ...p.members[1]!, id: "second", name: "Second", reason: "Independent file ownership" });
  assert.equal(planProblem(p, policy), undefined);
  const limited = structuredClone(policy); limited.inventory.providers[0]!.blockedReason = "quota exhausted";
  assert.match(planProblem(p, limited)!, /exhausted/);
  p.members[1]!.model = "invented-model"; assert.match(planProblem(p, policy)!, /settings/);
  const pinned = structuredClone(policy); pinned.inventory.providers[0]!.settingsByRole = { worker: { model: "pinned" } };
  p.members[1]!.model = "pinned"; p.members[3]!.model = "pinned"; assert.equal(planProblem(p, pinned), undefined);
  const choices = structuredClone(policy); choices.inventory.providers[0]!.models = [{ id: "small" }, { id: "large", efforts: ["high"] }];
  p.members[1]!.model = "small"; p.members[3]!.model = "large"; p.members[3]!.effort = "high";
  assert.equal(planProblem(p, choices), undefined, "same-provider workers can independently select supplied model settings when unpinned");
});

test("a coordinator provider outside the worker pool cannot be assigned workers or preferred as reviewer", () => {
  const p = plan(); const restricted = { ...policy, pool: ["codex"] as const };
  assert.match(planProblem(p, { ...restricted, pool: [...restricted.pool] })!, /outside the user's/);
  p.members[1]!.provider = "codex";
  assert.equal(planProblem(p, { ...restricted, pool: [...restricted.pool] }), undefined, "same-provider review is allowed when that is the entire authorized pool");
});

test("scheduler serializes same-member and overlapping writers and respects dependency submission", () => {
  const p = plan(); const a = p.tasks[0]!;
  p.tasks.push({ ...a, id: "b", owner: "second", paths: ["src/api/routes.ts"] }, { ...a, id: "c", owner: "third", paths: ["src/ui"] }, { ...a, id: "d", owner: "fourth", dependsOn: ["api"], paths: ["docs"] });
  assert.deepEqual(readyTasks(p.tasks).map((t) => t.id), ["api", "c"]);
  a.status = "needs_info"; assert.deepEqual(readyTasks(p.tasks).map((t) => t.id), ["b", "c"]);
  a.status = "submitted"; assert.deepEqual(readyTasks(p.tasks).map((t) => t.id), ["b", "c", "d"]);
  assert.equal(ownsPath(["src/api"], "src/apiary.ts"), false);
  assert.equal(ownsPath(["src/api"], "src/api/routes.ts"), true);
});

test("revisions add and retire bounded workers with explicit idle task handover", () => {
  const s = state(); s.tasks[0]!.status = "failed"; s.tasks[0]!.attempts = 1;
  const r = revision(); r.addMembers = [{ ...s.members[1]!, id: "replacement" }]; r.retireMembers = ["builder"]; r.reassignments = [{ taskId: "api", memberId: "replacement" }]; r.retryTasks = ["api"];
  assert.equal(revisionProblem(r, s, policy), undefined);
  r.reassignments = []; assert.match(revisionProblem(r, s, policy)!, /handing off/);
  r.retireMembers = ["reviewer"]; assert.match(revisionProblem(r, s, policy)!, /idle worker/);
  r.retireMembers = []; r.addMembers[0]!.role = "reviewer"; assert.match(revisionProblem(r, s, policy)!, /pinned/);
});

test("message validation prevents sender spoofing and user-question answers by agents", () => {
  const s = state(), member = s.members[1]!, task = s.tasks[0]!;
  const outcome: TaskOutcome = { taskId: task.id, memberId: member.id, status: "submitted", checkpoint: "Implemented", handover: "Public implementation summary", artifacts: [], unresolvedRequirements: [], questions: [], replies: [], findings: [] };
  assert.equal(outcomeProblem(outcome, task, member, s), undefined);
  outcome.memberId = "reviewer"; assert.match(outcomeProblem(outcome, task, member, s)!, /match this assignment/); outcome.memberId = member.id;
  s.messages.push({ id: "q", kind: "question", sender: "coordinator", recipient: "user", taskId: task.id, body: "Publish?", blocking: true, evidence: [], status: "open", sourceStepId: "s1", origin: "agent" });
  outcome.replies = [{ requestId: "q", body: "Yes", evidence: ["I think so"] }]; assert.match(outcomeProblem(outcome, task, member, s)!, /replies must/);
  const r = revision(); r.answers = outcome.replies; assert.match(revisionProblem(r, s, policy)!, /non-user/);
});

test("all Auto wire schemas satisfy strict provider object requirements", async () => {
  const schemas = await import("../src/patterns/auto-team-model.js");
  const inspect = (node: Record<string, unknown>, path: string) => {
    if (node.type === "object") {
      assert.equal(node.additionalProperties, false, `${path} must be closed`);
      const properties = node.properties as Record<string, Record<string, unknown>>;
      assert.deepEqual([...(node.required as string[])].sort(), Object.keys(properties).sort(), `${path} must require every property; use empty arrays for optional collections`);
      for (const [key, value] of Object.entries(properties)) inspect(value, `${path}.${key}`);
    }
    if (node.type === "array") inspect(node.items as Record<string, unknown>, `${path}[]`);
  };
  for (const [name, schema] of Object.entries(schemas)) if (name.endsWith("_SCHEMA")) inspect(schema as Record<string, unknown>, name);
});


test("an immediate live reply does not invalidate the requesting turn's yield", () => {
  const s = state(); const task = s.tasks[0]!; task.attempts = 1;
  s.messages.push({ id: "fast-request", kind: "question", sender: "builder", recipient: "coordinator", taskId: task.id, body: "Which interface?", blocking: true, evidence: [], status: "answered", sourceStepId: "worker-step", sourceAttempt: 1, origin: "agent" });
  const outcome: TaskOutcome = { taskId: task.id, memberId: "builder", status: "needs_info", checkpoint: "Partial edits preserved", handover: "Awaiting interface response", artifacts: [], unresolvedRequirements: ["goal"], questions: [], replies: [], findings: [] };
  assert.equal(outcomeProblem(outcome, task, s.members[1]!, s), undefined);
  s.messages[0]!.sourceAttempt = 0;
  assert.match(outcomeProblem(outcome, task, s.members[1]!, s)!, /needs_info/);
});

test("scheduler packs eligible work after excluding occupied members and exhausted attempts", () => {
  const base = plan().tasks[0]!;
  const tasks = [
    { ...base, id: "active", owner: "busy", status: "running" as const },
    { ...base, id: "blocked", owner: "available", paths: ["src/api/routes.ts"] },
    { ...base, id: "runnable", owner: "available", paths: ["src/ui"] },
  ];
  assert.deepEqual(readyTasks(tasks).map((task) => task.id), ["runnable"], "a pending writer blocked by an active task must not hide its owner's other ready work");
  const attempts = [
    { ...base, id: "exhausted", attempts: 4 },
    { ...base, id: "remaining", attempts: 0, paths: ["src/ui"] },
  ];
  assert.deepEqual(readyTasks(attempts, [], (task) => (task.attempts ?? 0) < 4).map((task) => task.id), ["remaining"], "attempt-exhausted candidates must not occupy a member's ready slot");
});

test("workflow revisions validate the resulting bounded contracts before changing state", () => {
  const s = state(); s.contracts = Array.from({ length: 24 }, (_, i) => `Accepted contract ${i}`);
  const r = revision(); r.contracts = ["One contract beyond the approved bound"];
  assert.match(revisionProblem(r, s, policy)!, /bounded plan/);
  assert.equal(s.contracts.length, 24);
  s.contracts.pop(); r.contracts = ["Repeated addition", "Repeated addition"];
  assert.match(revisionProblem(r, s, policy)!, /bounded plan/, "validate the actual appended list even if a patch repeats additions");
  r.contracts = [s.contracts[0]!];
  assert.equal(revisionProblem(r, s, policy), undefined, "repeating an existing contract does not expand the accepted set");
  s.contracts = []; r.contracts = ["x".repeat(8001)];
  assert.match(revisionProblem(r, s, policy)!, /8000/);
  assert.deepEqual(s.contracts, []);
});
