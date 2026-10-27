import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planProblem, TEAM_PLAN_SCHEMA, type TeamPolicy } from "../src/patterns/auto-team-model.js";
import { shapeProblem } from "../src/json.js";
import type { TeamPlan } from "../src/teams.js";

// Captured from a real, explicitly bounded Haiku plan for a synthetic repository.
const saved = JSON.parse(readFileSync(new URL("./fixtures/qa-real-haiku-plan.json", import.meta.url), "utf8"));
function fixture() {
  const plan: TeamPlan = structuredClone(saved);
  const policy: TeamPolicy = {
    coordinator: "claude", pool: ["claude"], maxMembers: 3, maxTasks: 12, differentProviderReview: false,
    inventory: { at: 0, ranking: ["claude"], providers: [{
      id: "claude", available: true, quotaKnown: true, model: "haiku", effort: "low",
      models: [{ id: "claude-haiku-5-5", aliases: ["haiku"], efforts: ["low", "medium"] }, { id: "other", aliases: ["other-alias"], efforts: ["low", "high"] }],
      catalog: { revision: 1, environment: "fixture", defaultModel: "claude-haiku-5-5", state: "current" },
    }] },
  };
  return { plan, policy, provider: policy.inventory.providers[0]! };
}

test("saved real plan accepts the reported canonical identity for a pinned alias", () => {
  const { plan, policy } = fixture();
  assert.equal(shapeProblem(TEAM_PLAN_SCHEMA, saved), undefined);
  assert.equal(planProblem(plan, policy), undefined);
});

test("a canonical worker pin also admits its reported alias without rewriting the coordinator", () => {
  const { plan, policy, provider } = fixture();
  provider.settingsByRole = { worker: { model: "claude-haiku-5-5", effort: "low" } };
  plan.members.find(member => member.role === "worker")!.model = "haiku";
  assert.equal(planProblem(plan, policy), undefined);
  plan.members[0]!.model = "claude-haiku-5-5";
  assert.match(planProblem(plan, policy)!, /coordinator model settings.*unchanged/i);
});

test("known but unselected, unreported, and unsupported-effort choices remain rejected", () => {
  for (const [model, effort, reason] of [["other", "low", /preserve supplied model/], ["", "low", /preserve supplied model/], ["invented", "low", /availability.*unknown/], ["claude-haiku-5-5", "high", /unsupported effort/]] as const) {
    const { plan, policy } = fixture();
    Object.assign(plan.members.find(member => member.role === "worker")!, { model, effort });
    assert.match(planProblem(plan, policy)!, reason);
  }
});

test("reported alias identity preserves every variant's model and effort pair", () => {
  const { plan, policy, provider } = fixture();
  provider.settingsByRole = { worker: { model: "haiku", effort: "low", variants: [{ model: "other-alias", effort: "high" }] } };
  const worker = plan.members.find(member => member.role === "worker")!;
  assert.equal(planProblem(plan, policy), undefined);
  Object.assign(worker, { model: "other", effort: "high" });
  assert.equal(planProblem(plan, policy), undefined);
  worker.effort = "low";
  assert.match(planProblem(plan, policy)!, /preserve supplied effort/);
  Object.assign(worker, { model: "haiku", effort: "medium" });
  assert.match(planProblem(plan, policy)!, /preserve supplied effort/);
});

test("empty variant pins retain default-only meaning and unreported aliases do not broaden pins", () => {
  const { plan, policy, provider } = fixture();
  provider.settingsByRole = { worker: { model: "", effort: "low", variants: [{ model: "other", effort: "high" }] } };
  const worker = plan.members.find(member => member.role === "worker")!;
  assert.match(planProblem(plan, policy)!, /preserve supplied model/);
  worker.model = "";
  assert.equal(planProblem(plan, policy), undefined);
  provider.settingsByRole.worker = { model: "haiku", effort: "low" };
  worker.model = "claude-haiku-5-5";
  provider.models![0]!.aliases = [];
  provider.settingsByRole.coordinator = { model: "claude-haiku-5-5", effort: "low" };
  plan.members[0]!.model = "claude-haiku-5-5";
  assert.match(planProblem(plan, policy)!, /preserve supplied model/);
});
