import { test } from "node:test";
import assert from "node:assert/strict";
import { misplacedPlanPath, planningInventory, planningPaths } from "../src/patterns/auto-team-planning.js";
import type { TeamPlan } from "../src/teams.js";
import type { TeamPolicy } from "../src/patterns/auto-team-model.js";

test("planning grounds explicitly named tests at the repository root and rejects invented package prefixes", () => {
  const tracked = ["README.md", "packages/python/src/security.py", "tests/unit/test_security.py"];
  const goal = "Fix startup and add regression coverage in tests/unit/test_security.py.";
  assert.deepEqual(planningPaths(tracked, goal), { rootEntries: ["README.md", "packages/", "tests/"], namedFiles: ["tests/unit/test_security.py"] });
  const plan = { tasks: [{ id: "fix", paths: ["packages/python/tests/unit/test_security.py"] }] } as TeamPlan;
  assert.match(misplacedPlanPath(plan, tracked, goal)!, /nonexistent.*exact repository-relative/);
  plan.tasks[0]!.paths = ["packages/python/src", "tests/unit/test_security.py"];
  assert.equal(misplacedPlanPath(plan, tracked, goal), undefined);
});

test("planning permits intentional new files and does not match path suffixes or filename prefixes", () => {
  const tracked = ["tests/a.test.ts", "tests/aXtest.ts"];
  const goal = "Use tests/a.test.ts as reference and create new/tests/a.test.ts.";
  const plan = { tasks: [{ id: "copy", paths: ["new/tests/a.test.ts"] }] } as TeamPlan;
  assert.equal(misplacedPlanPath(plan, tracked, goal), undefined);
  assert.deepEqual(planningPaths(tracked, "Read new/tests/a.test.ts and tests/a.test.tsx").namedFiles, []);
  assert.deepEqual(planningPaths(tracked, "Read `tests/a.test.ts`").namedFiles, ["tests/a.test.ts"]);
});

function policy(): TeamPolicy {
  return {
    coordinator: "agy", pool: ["claude"], maxMembers: 4, maxTasks: 12, differentProviderReview: false,
    inventory: { at: 10, ranking: ["codex", "claude", "agy"], providers: [
      { id: "agy", available: true, quotaKnown: false, model: "flash-high", settingsByRole: { coordinator: { model: "flash-high" }, worker: {} }, models: [{ id: "flash-high" }, { id: "flash-low" }] },
      { id: "claude", available: true, quotaKnown: false,
        settingsByRole: { worker: { model: "haiku", effort: "high", variants: [{ model: "sonnet", effort: "low" }] }, reviewer: { model: "opus", effort: "max" } },
        models: [
          { id: "haiku-exact", aliases: ["haiku"], efforts: ["low", "high"], source: "CLI", verifiedAt: 10, observations: { successes: 2, failures: 1 } },
          { id: "sonnet", efforts: ["low", "high"] }, { id: "opus", efforts: ["max"] }, { id: "unused-model" },
        ] },
      { id: "codex", available: true, quotaKnown: false, models: [{ id: "outside-pool" }] },
    ] },
  };
}

test("planning only carries selectable providers/models while preserving role pins, aliases and variants", () => {
  const original = policy(), snapshot = structuredClone(original);
  const result = planningInventory(original);
  assert.deepEqual(result.providers.map(p => p.id), ["agy", "claude"]);
  assert.deepEqual(result.ranking, ["claude", "agy"]);
  assert.deepEqual(result.providers[0]!.models?.map(m => m.id), ["flash-high"], "coordinator-only provider keeps its selected high model");
  assert.deepEqual(result.providers[0]!.settingsByRole?.coordinator, { model: "flash-high", effort: "" }, "provider defaults have explicit empty wire values");
  const worker = result.providers[1]!;
  assert.deepEqual(worker.models?.map(m => m.id), ["haiku-exact", "sonnet", "opus"]);
  assert.deepEqual(worker.settingsByRole, original.inventory.providers[1]!.settingsByRole);
  assert.deepEqual(worker.models![0]!.aliases, ["haiku"]);
  assert.deepEqual(worker.models![0]!.efforts, ["low", "high"]);
  assert.deepEqual(worker.models![0]!.observations, { successes: 2, failures: 1 });
  assert.equal(worker.models![0]!.source, "CLI");
  assert.deepEqual(original, snapshot, "full validation/audit inventory stays intact");
});

test("unpinned worker or reviewer retains the complete eligible model choice", () => {
  for (const role of ["worker", "reviewer"] as const) {
    const p = policy();
    p.inventory.providers[1]!.settingsByRole![role] = {};
    const result = planningInventory(p);
    assert.deepEqual(result.providers[1]!.models?.map(m => m.id), p.inventory.providers[1]!.models?.map(m => m.id));
  }
});

test("blocked and unavailable providers never enter the planning catalog", () => {
  const p = policy(); p.pool.push("codex");
  p.inventory.providers[1]!.blockedReason = "Quota exhausted";
  p.inventory.providers[2]!.available = false;
  assert.deepEqual(planningInventory(p).providers.map(p => p.id), ["agy"]);
});
