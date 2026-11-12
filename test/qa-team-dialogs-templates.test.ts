import { test } from "node:test";
import assert from "node:assert/strict";
import { carryConflictChoices, templateTeamSettings, teamApprovalProblem, type ConflictFile } from "../ui/task-team-choices.js";

test("comparison refresh preserves choices only for identical versions including binary identities and modes", () => {
  const version = { exists: true, text: "original", object: "a", mode: "100644" };
  const file: ConflictFile = { path: "first", base: version, current: version, team: version };
  const files = [file, { ...file, path: "second" }, { ...file, path: "removed" }];
  const choices = { first: { choice: "edited" as const, text: "my resolution" }, second: { choice: "team" as const }, removed: { choice: "current" as const } };
  const changed = { ...files[1]!, current: { ...version, mode: "100755" } };
  assert.deepEqual(carryConflictChoices(files, choices, [changed, structuredClone(file)]), { choices: { first: choices.first }, cleared: ["second", "removed"] });
  const binary = { ...file, current: { ...version, binary: true, text: "" } };
  assert.deepEqual(carryConflictChoices([binary], { first: choices.first }, [{ ...binary, current: { ...binary.current, object: "b" } }]).choices, {});
  assert.equal(choices.first.text, "my resolution", "the helper never mutates the caller's recoverable edit");
});

test("template settings merge independent model and effort fields and disclose overlapping values", () => {
  const preferences = { roles: {}, options: {}, agentSettings: {}, roleSettings: { pool: { codex: { model: "gpt-b" } }, coordinator: { codex: { effort: "low" } } } };
  assert.deepEqual(templateTeamSettings({}, preferences), { settings: { codex: { model: "gpt-b", effort: "low" } }, conflicts: [] });
  const conflicting = { ...preferences, roleSettings: { ...preferences.roleSettings, coordinator: { codex: { model: "gpt-a", effort: "low", variants: [{ model: "ignored" }] } } } };
  assert.deepEqual(templateTeamSettings({}, conflicting), { settings: { codex: { model: "gpt-a", effort: "low" } }, conflicts: ["codex model"] });
  assert.equal(teamApprovalProblem({ enabled: true, coordinator: "claude", providers: ["agy"] } as any, true).includes("Ask for approval"), true);
  assert.equal(teamApprovalProblem({ enabled: false, coordinator: "agy", providers: [] } as any, true), "");
});
