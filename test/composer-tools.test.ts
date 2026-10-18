import test from "node:test";
import assert from "node:assert/strict";
import { fillTemplate, parseComposerLibrary, taskWithCriteria, templateParameters, validatePresetConfig, type ComposerLibrary, type PresetConfig, type TaskTemplate } from "../ui/composer-tools.js";
import { hashFor, parseRouteHash, type Route } from "../ui/navigation.js";
import { patterns } from "../src/patterns/index.js";

const config: PresetConfig = { pattern: "pipeline", roles: { planner: ["claude"], builder: ["codex"], reviewer: ["agy"] }, options: { maxRounds: 3 }, roleSettings: { planner: { claude: { model: "example", effort: "high" } } }, agentSettings: { codex: { model: "other" } }, trust: "standard", limits: { maxMinutes: 60, maxSteps: 40 }, approvePlan: true };
const library = (): ComposerLibrary => ({ schemaVersion: 1, presets: [{ id: "team-1", name: "Backend team", revision: 2, updatedAt: 2000, config: structuredClone(config), history: [{ revision: 1, updatedAt: 1000, config: { ...structuredClone(config), trust: "safe" } }] }], templates: [{ id: "task-1", name: "Component task", pattern: "pipeline", task: "Add tests for {{component}} in {{package}}.", criteria: ["{{component}} rejects invalid input."] }] });

test("deep links round-trip encoded paths and malformed escapes remain recoverable", () => {
  const routes: Route[] = [{ view: "composer" }, { view: "settings", section: "workspace" }, { view: "settings" }, { view: "settings", section: "ssh" }, { view: "run", id: "run / # 1" }, { view: "review", id: "run", branch: "feature/emoji-✓" }, { view: "side", tab: "files", scope: "repo:/tmp/a b" }, { view: "project", id: "project/1" }, { view: "settings", section: "insights", group: "a/b" }, { view: "settings", section: "automations" }];
  for (const route of routes) assert.deepEqual(parseRouteHash(hashFor(route)), route);
  for (const hash of ["#/run/%", "#/project/%E0%A4%A", "#/review/a/b%GG"]) { assert.deepEqual(parseRouteHash(hash), { view: "invalid", hash }); assert.equal(hashFor(parseRouteHash(hash)), hash); }
  assert.deepEqual(parseRouteHash("#/settings/unknown"), { view: "settings", section: "general" });
  assert.deepEqual(parseRouteHash("#/automations"), { view: "settings", section: "automations" });
  assert.equal(hashFor(parseRouteHash("#/automations")), "#/settings/automations");
  assert.deepEqual(parseRouteHash("#/workspace"), { view: "settings", section: "workspace" });
  assert.deepEqual(parseRouteHash("#/insights"), { view: "settings", section: "insights" });
  assert.deepEqual(parseRouteHash("#/insights/a%2Fb"), { view: "settings", section: "insights", group: "a/b" });
  assert.deepEqual(parseRouteHash("#/run/"), { view: "composer" });
});

test("libraries preserve usable configurations and prior team revisions without copying repository commands", () => {
  const value = parseComposerLibrary(library(), patterns);
  assert.equal(value.presets[0]!.revision, 2);
  assert.equal(value.presets[0]!.history[0]!.config.trust, "safe");
  assert.equal(value.presets[0]!.config.roleSettings.planner?.claude?.model, "example");
  assert.equal("setup" in value.presets[0]!.config, false);
  assert.deepEqual(validatePresetConfig(config, patterns), config);
  const ceilings = validatePresetConfig({ ...config, limits: { ...config.limits, maxTokens: 10000, maxCostUsd: 2.5 }, toolApprovals: true }, patterns);
  assert.equal(ceilings.limits.maxTokens, 10000);
  assert.equal(ceilings.limits.maxCostUsd, 2.5);
  assert.equal(ceilings.toolApprovals, true);
});

test("imports reject unknown workflows, invalid permissions, excessive limits and incompatible assignments", () => {
  for (const patch of [{ pattern: "nonexistent" }, { trust: "admin" }, { limits: { maxMinutes: Infinity, maxSteps: 40 } }, { roles: { ...config.roles, reviewer: ["other"] } }, { roles: { ...config.roles, builder: ["codex", "claude"] } }, { options: { unknownOption: true } }, { roleSettings: { nonexistent: {} } }, { agentSettings: { codex: { model: { secret: "oops" } } } }]) assert.throws(() => validatePresetConfig({ ...config, ...patch }, patterns));
  const duplicate = library(); duplicate.templates.push(duplicate.templates[0]!); assert.throws(() => parseComposerLibrary(duplicate, patterns), /Duplicate/);
  const history = library(); history.presets[0]!.history[0]!.revision = 2; assert.throws(() => parseComposerLibrary(history, patterns), /revision/);
  assert.throws(() => parseComposerLibrary({ ...library(), schemaVersion: 2 }, patterns), /version 1/);
});

test("parameterized templates require each input and substitute literal values in task and acceptance", () => {
  const template = library().templates[0]!;
  assert.deepEqual(templateParameters(template), ["component", "package"]);
  assert.throws(() => fillTemplate(template, { component: "API" }), /package/);
  const filled = fillTemplate(template, { component: "$&", package: " core " });
  assert.equal(filled.task, "Add tests for $& in core.");
  assert.deepEqual(filled.criteria, ["$& rejects invalid input."]);
  assert.equal(taskWithCriteria(filled.task, [...filled.criteria, " "]), "Add tests for $& in core.\n\nAcceptance criteria:\n1. $& rejects invalid input.");
  const fixed: TaskTemplate = { id: "fixed", name: "Review", pattern: "pipeline", task: "Review it", criteria: [] };
  assert.deepEqual(fillTemplate(fixed, {}), { task: "Review it", criteria: [] });
});

test("version 1 presets preserve independent context budgets in import/export and history while older presets remain valid", () => {
  const value = library(); value.presets[0]!.config.contextBudget = { maxPromptBytes: 40000, policy: "warn" }; value.presets[0]!.history[0]!.config.contextBudget = { maxPromptBytes: 10000, maxApproximateTokens: 3000, policy: "block" };
  const imported = parseComposerLibrary(JSON.parse(JSON.stringify(value)), patterns);
  assert.deepEqual(imported.presets[0]!.config.contextBudget, value.presets[0]!.config.contextBudget);
  assert.deepEqual(imported.presets[0]!.history[0]!.config.contextBudget, value.presets[0]!.history[0]!.config.contextBudget);
  imported.presets[0]!.config.contextBudget!.maxPromptBytes = 1;
  assert.equal(imported.presets[0]!.history[0]!.config.contextBudget!.maxPromptBytes, 10000, "historical budgets remain independent values");
  assert.equal(parseComposerLibrary(library(), patterns).presets[0]!.config.contextBudget, undefined);
  assert.throws(() => validatePresetConfig({ ...config, contextBudget: { maxPromptBytes: 0, policy: "block" } }, patterns), /ceilings/);
  assert.throws(() => validatePresetConfig({ ...config, contextBudget: { maxPromptBytes: 100, policy: "ignore" } }, patterns), /policy/);
});
