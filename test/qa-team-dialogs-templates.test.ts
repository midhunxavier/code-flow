import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { carryConflictChoices, templateTeamSettings, teamApprovalProblem, type ConflictFile } from "../ui/task-team-choices.js";
import { TeamTemplateStore } from "../src/team-template-store.js";
import { AgentTeamDefinitions } from "../src/agent-team-definitions.js";
import { ProjectTeamConflict } from "../src/project-team-store.js";

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

test("migration reports each dropped setting, persists the explanation and stays idempotent", async () => {
  const home = await mkdtemp(join(tmpdir(), "qa-team52-migration-"));
  try {
    const store = new TeamTemplateStore(home);
    const library = { schemaVersion: 1, templates: [{ id: "plain", name: "Plain template", pattern: "solo", task: "{{task}}", criteria: [] }], presets: [{ id: "checks", name: "Checked build", config: { pattern: "race", roles: { contestants: ["claude", "codex"] }, check: "npm test", setup: "npm ci", baseRef: "main", contextBudget: { maxTokens: 4000 }, limits: { maxSteps: 12 } }, runOptions: { verification: "thorough", container: { enabled: true, image: "qa/image" } } }] };
    const result = await store.migrate(library);
    assert.equal(result.imported, 2);
    const notice = result.notes.find(note => note.startsWith("Checked build:"))!;
    for (const label of ["verification command", "setup command", "starting branch", "context budget", "execution limits", "thorough verification profile", "Docker isolation"]) assert.ok(notice.includes(label), label);
    assert.equal(result.notes.some(note => note.startsWith("Plain template:")), false);
    assert.equal((await store.list()).templates.find(t => t.name === "Checked build")?.description, notice);
    assert.deepEqual(await store.migrate(library), { imported: 0, notes: result.notes });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("the 101st reusable-team save explains the limit without changing history or rejecting an operation replay", async () => {
  const home = await mkdtemp(join(tmpdir(), "qa-team52-limit-"));
  try {
    const definitions = new AgentTeamDefinitions(home); await definitions.load();
    const configuration = { coordinator: "claude" as const, pool: ["claude" as const], agentSettings: {}, roleSettings: {} };
    let definition = await definitions.save({ operationId: "version-1", name: "Team 1", configuration });
    for (let revision = 2; revision <= 100; revision++) definition = await definitions.save({ id: definition.id, revision: definition.revision, operationId: `version-${revision}`, name: `Team ${revision}`, configuration });
    const bytes = await readFile(join(home, `${definition.id}.json`), "utf8");
    await assert.rejects(definitions.save({ id: definition.id, revision: 100, operationId: "version-101", name: "Team 101", configuration }), error => error instanceof ProjectTeamConflict && /100-version limit.*Create a new/.test(error.message));
    assert.equal(await readFile(join(home, `${definition.id}.json`), "utf8"), bytes);
    assert.equal((await definitions.save({ id: definition.id, revision: 99, operationId: "version-100", name: "Team 100", configuration })).revision, 100);
    const reloaded = new AgentTeamDefinitions(home); await reloaded.load();
    assert.equal(reloaded.get(definition.id).revision, 100); assert.equal(reloaded.faults.size, 0);
  } finally { await rm(home, { recursive: true, force: true }); }
});
