import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The patterns load the engine: keep anything it writes out of ~/.codeflow.
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-roles-"));
const { independentRoles } = await import("../ui/roles.js");
const { findPattern } = await import("../src/patterns/index.js");

const ALL = ["claude", "codex", "agy"] as const;
const defaults = (id: string) => Object.fromEntries(findPattern(id)!.roles.map((r) => [r.id, [...r.default]]));

test("pipeline: the reviewer defaults to a vendor other than the planner's", () => {
  // The pattern's own defaults already split the three roles across vendors.
  const pipeline = defaults("pipeline");
  assert.notEqual(pipeline.reviewer![0], pipeline.planner![0]);
  assert.deepEqual(independentRoles("pipeline", pipeline, {}, [...ALL]).reviewer, ["agy"]);

  // Without Antigravity the composer falls back to the first installed agent, the planner's vendor: another is picked.
  const fallback = { planner: ["claude" as const], builder: ["codex" as const], reviewer: ["claude" as const] };
  assert.deepEqual(independentRoles("pipeline", fallback, {}, ["claude", "codex"]).reviewer, ["codex"], "not the planner, even if it's the builder");
  // With a third vendor, neither the planner's nor the builder's.
  assert.deepEqual(independentRoles("pipeline", { ...fallback, reviewer: ["codex"] }, {}, [...ALL]).reviewer, ["agy"]);
  // Your own pick, and Auto, are left alone.
  assert.deepEqual(independentRoles("pipeline", fallback, { reviewer: ["claude"] }, [...ALL]).reviewer, ["claude"]);
  assert.deepEqual(independentRoles("pipeline", { ...fallback, planner: ["auto"] }, {}, [...ALL]).reviewer, ["claude"]);
  // Only one agent installed: nobody else to ask.
  assert.deepEqual(independentRoles("pipeline", fallback, {}, ["claude"]).reviewer, ["claude"]);
});

test("debate: the synthesizer defaults to a vendor that isn't debating", () => {
  const debate = defaults("debate");
  assert.ok(!debate.debaters!.includes(debate.synthesizer![0]!), "the pattern's default synthesizer isn't a debater");
  const roles = { debaters: ["claude" as const, "codex" as const], synthesizer: ["claude" as const] };
  assert.deepEqual(independentRoles("debate", roles, {}, [...ALL]).synthesizer, ["agy"]);
  assert.deepEqual(independentRoles("debate", roles, {}, ["claude", "codex"]).synthesizer, ["claude"], "every vendor debates: the log warns instead");
  assert.deepEqual(independentRoles("debate", roles, { synthesizer: ["claude"] }, [...ALL]).synthesizer, ["claude"]);
});

test("race and supervisor keep their independent judge and reviewer", () => {
  assert.deepEqual(independentRoles("race", { contestants: ["agy", "claude"], judge: ["agy"] }, {}, [...ALL]).judge, ["codex"]);
  assert.deepEqual(independentRoles("race", { contestants: ["auto", "claude"], judge: ["agy"] }, {}, [...ALL]).judge, ["agy"]);
  assert.deepEqual(independentRoles("supervisor", { supervisor: ["claude"], workers: ["claude"], reviewer: ["claude"] }, {}, [...ALL]).reviewer, ["codex"]);
  assert.deepEqual(independentRoles("supervisor", { supervisor: ["claude"], workers: ["claude"], reviewer: [] }, {}, [...ALL]).reviewer, ["codex"]);
});
