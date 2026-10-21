import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandTemplateUses, fillTeamTemplate, templateFromPlan, validateTeamTemplate, type TeamTemplate } from "../src/team-templates.js";
import { TeamTemplateStore } from "../src/team-template-store.js";
import type { TeamPlan } from "../src/teams.js";
const template: TeamTemplate = { schemaVersion: 1, id: "implement", version: 1, name: "Feature", description: "Implement a feature", scope: "personal", autoEnabled: true, parameters: ["task"], roles: ["builder"], tasks: [{ id: "inspect", title: "Inspect", role: "builder", kind: "investigation", instructions: "Inspect {{task}}", dependsOn: [], paths: ["src"], acceptance: ["Interfaces identified"] }, { id: "build", title: "Build", role: "builder", kind: "implementation", instructions: "Implement {{task}}", dependsOn: ["inspect"], paths: ["src"], acceptance: ["Tests pass"] }], contracts: ["Preserve API"], task: "{{task}}", criteria: [] };
const plan: TeamPlan = { requirements: [{ id: "goal", description: "Login" }], members: [], tasks: [], contracts: [], rationale: "Reuse", templateUses: [{ id: "auth", templateId: "implement", version: 1, inputs: [{ name: "task", value: "login" }], assignments: [{ role: "builder", memberId: "author" }], dependsOn: [], requirements: ["goal"], instructions: "Support empty inputs" }] };

test("Auto can run without templates and expands reusable tasks with preserved constraints", () => {
  assert.deepEqual(expandTemplateUses({ ...plan, templateUses: [] }, []), { ...plan, templateUses: [] });
  const expanded = expandTemplateUses(plan, [template]);
  assert.deepEqual(expanded.tasks.map(t => t.id), ["auth-inspect", "auth-build"]);
  assert.deepEqual(expanded.tasks[1]!.dependsOn, ["auth-inspect"]);
  assert.deepEqual(expanded.tasks[1]!.acceptance, ["Tests pass"]);
  assert.deepEqual(expanded.contracts, ["Preserve API"]);
  assert.match(expanded.tasks[1]!.instructions, /Implement login.*\n.*\nSupport empty inputs/);
  assert.deepEqual(expanded.tasks[1]!.requirements, ["goal"]);
  assert.throws(() => expandTemplateUses(plan, [{ ...template, version: 2 }]), /pinned catalog/);
  assert.throws(() => expandTemplateUses({ ...plan, templateUses: [...plan.templateUses!, ...plan.templateUses!] }, [template]), /unique/);
});
test("template imports cannot carry authority or invalid dependency/path contracts", () => {
  assert.throws(() => validateTeamTemplate({ ...template, trust: "full" }), /permissions/);
  assert.throws(() => validateTeamTemplate({ ...template, tasks: [{ ...template.tasks[0], dependsOn: ["inspect"] }] }), /cycle/);
  assert.throws(() => validateTeamTemplate({ ...template, tasks: [{ ...template.tasks[0], paths: ["../another-worktree"] }] }), /relative/);
  assert.throws(() => fillTeamTemplate(template, {}), /Enter a value/);
  assert.throws(() => fillTeamTemplate(template, { task: "login", trust: "full" }), /Unknown template input/);
});
test("template store publishes immutable versions, rejects stale writes, and scopes project access", async () => {
  const home = await mkdtemp(join(tmpdir(), "team-templates-"));
  try {
    const store = new TeamTemplateStore(home);
    await store.save(template, 0);
    const edits = await Promise.allSettled([store.save({ ...template, version: 2, name: "A" }, 1), store.save({ ...template, version: 2, name: "B" }, 1)]);
    assert.equal(edits.filter(r => r.status === "fulfilled").length, 1);
    assert.equal((await store.resolve("implement", 1)).name, "Feature");
    await store.save({ ...template, id: "private", scope: "project", project: "alpha" }, 0);
    assert.equal((await store.list("beta")).templates.some(t => t.id === "private"), false);
    await assert.rejects(store.resolve("private", 1, "beta"), /not found/);
    assert.equal((await new TeamTemplateStore(home).resolve("private", 1, "alpha")).project, "alpha");
  } finally { await rm(home, { recursive: true, force: true }); }
});
test("legacy migration is idempotent and drops grants and host authentication bindings", async () => {
  const home = await mkdtemp(join(tmpdir(), "template-migrate-"));
  try {
    const store = new TeamTemplateStore(home);
    const library = { schemaVersion: 1, presets: [], templates: [{ id: "feature", name: "Feature", pattern: "pipeline", task: "Build {{task}}", criteria: [], config: { trust: "full", toolApprovals: true }, runOptions: { container: { enabled: false, authVolume: "private-auth" } } }] };
    assert.equal((await store.migrate(library)).imported, 1);
    assert.equal((await store.migrate(library)).imported, 0);
    const text = JSON.stringify(await store.list());
    assert.ok(!text.includes("private-auth") && !text.includes('"trust"') && !text.includes("toolApprovals"));
  } finally { await rm(home, { recursive: true, force: true }); }
});
test("saving a run retains its reusable graph without session or result state", () => {
  const expanded = expandTemplateUses(plan, [template]);
  Object.assign(expanded.tasks[0]!, { checkpoint: "private", worktree: "/tmp/work", head: "sha", artifacts: ["result"] });
  const saved = templateFromPlan(expanded, { id: "saved", name: "Saved", scope: "personal" });
  const text = JSON.stringify(saved);
  assert.ok(!text.includes("private") && !text.includes("/tmp/work") && !text.includes('"head"') && !text.includes('"artifacts"'));
  assert.equal(saved.autoEnabled, false);
});

test("legacy templates and presets with matching IDs both migrate and retain preferences", async () => {
  const home = await mkdtemp(join(tmpdir(), "template-collision-"));
  try {
    const store = new TeamTemplateStore(home);
    const config = { pattern: "pipeline", roles: { builder: ["codex"] }, options: { reviews: 2 }, agentSettings: { codex: { model: "test", variants: [{ model: "variant" }] } }, trust: "full" };
    const library = { schemaVersion: 1, templates: [{ id: "same", name: "Prompt", pattern: "pipeline", task: "Build {{TASK_NAME}}", criteria: [], config }], presets: [{ id: "same", name: "Settings", config }] };
    assert.equal((await store.migrate(library)).imported, 2);
    assert.equal((await store.migrate(library)).imported, 0);
    const templates = (await store.list()).templates;
    assert.equal(templates[0]!.task, "Build {{task-name}}");
    assert.deepEqual(templates[0]!.preferences?.agentSettings.codex?.variants, [{ model: "variant" }]);
    assert.deepEqual(templates[1]!.preferences?.roles.builder, ["codex"]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("template capture and expansion preserve artifact dependencies and global acceptance criteria", () => {
  const source = { ...template, criteria: ["No API regressions"], tasks: template.tasks.map(t => t.id === "build" ? { ...t, dependencyTypes: { inspect: "artifact" as const } } : t) };
  const expanded = expandTemplateUses(plan, [source]);
  assert.equal(expanded.tasks[1]!.dependencyTypes?.["auth-inspect"], "artifact");
  assert.ok(expanded.contracts.includes("No API regressions"));
  const saved = templateFromPlan(expanded, { id: "captured", name: "Captured", scope: "personal" });
  assert.equal(saved.tasks[1]!.dependencyTypes?.["auth-inspect"], "artifact");
});
