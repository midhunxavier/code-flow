// Templates, saved workflows and a project's remembered team prefill one draft. They must not
// rewrite the browser-wide choices in Settings > Agents & models and Settings > Run defaults,
// which every other project's new draft starts from. The UI is bundled the way build-ui does it
// and loaded with a stand-in window, as in ui-review.test.ts.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const ui = fileURLToPath(new URL("../ui", import.meta.url));
const SAVED_MODELS = { claude: { effort: "high" }, codex: { effort: "low" } };
const storage = new Map<string, string>([["pattern", "solo"], ["agentSettings", JSON.stringify(SAVED_MODELS)], ["projectDraftVersion", "1"]]);
const saved = (key: string) => JSON.parse(storage.get(key) ?? "null");
let m: any;

const solo = { id: "solo", name: "Agent", roles: [{ id: "agent", default: ["claude"] }], options: [] };
const pipeline = { id: "pipeline", name: "Plan → Build → Review", roles: [{ id: "planner", default: ["claude"] }, { id: "builder", default: ["codex"] }, { id: "reviewer", default: ["claude"] }], options: [] };
const preset = (agentSettings: object, roleSettings: object = {}) => ({ pattern: "solo", roles: { agent: ["claude"] }, options: {}, agentSettings, roleSettings, trust: "full", limits: { maxMinutes: 5, maxSteps: 3 }, approvePlan: false });

before(async () => {
  Object.assign(globalThis, {
    window: globalThis,
    // This stand-in window has no browser message channel; Node's channel would keep the test process alive.
    BroadcastChannel: undefined,
    document: { addEventListener() {}, hidden: false },
    innerWidth: 1400,
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, String(v)), removeItem: (k: string) => storage.delete(k) },
    location: { hostname: "localhost", hash: "", origin: "http://localhost", pathname: "/", search: "" },
    fetch: async (path: string) => {
      const url = new URL(path, "http://localhost"), repo = url.searchParams.get("repo");
      const body = url.pathname === "/api/branches" ? { repo, current: "main", branches: [{ name: "main" }], worktreeRoot: `${repo}/worktrees` } : url.pathname === "/api/repo-config" ? { found: false, config: {} } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const out = await esbuild.build({
    stdin: {
      contents: [
        `export { applyPreset } from "./onboarding.tsx";`,
        `export { agentSettings, composerOrigins, defaultPattern, initializeProjectDrafts, openComposer, patternId, patterns, projects, projectsLoaded, providerDefaults, roleModels, roleSel, setAgentSetting, setProviderDefault, setRoleModel, setRoles } from "./state.ts";`,
      ].join("\n"),
      resolveDir: ui,
      loader: "ts",
    },
    bundle: true, write: false, format: "esm", target: "es2022", jsx: "automatic", jsxImportSource: "preact",
    loader: { ".png": "dataurl", ".svg": "dataurl" }, logLevel: "error",
  });
  const file = join(mkdtempSync(join(tmpdir(), "codeflow-qa-presets-")), "ui.mjs");
  writeFileSync(file, out.outputFiles[0]!.text);
  m = await import(pathToFileURL(file).href);
  m.patterns.value = [solo, pipeline];
});

test("applying a template or saved workflow sets this draft's models and keeps Settings > Agents & models", () => {
  m.applyPreset(preset({}), "Template Saved before any defaults");
  assert.deepEqual(saved("agentSettings"), SAVED_MODELS, "a template saved with Default models doesn't erase the saved provider defaults");
  assert.deepEqual(m.providerDefaults.value, SAVED_MODELS);
  assert.deepEqual(m.agentSettings.value, SAVED_MODELS, "the draft keeps the provider defaults the template didn't record");

  m.applyPreset(preset({ claude: { effort: "medium" } }, { agent: { claude: { model: "opus" } } }), "Template Medium");
  assert.deepEqual(m.agentSettings.value, { claude: { effort: "medium" }, codex: { effort: "low" } }, "the template's models apply to the draft");
  assert.deepEqual(m.roleModels.value.solo, { agent: { claude: { model: "opus" } } });
  assert.equal(m.composerOrigins.value.models, "Template Medium");
  assert.deepEqual(saved("agentSettings"), SAVED_MODELS, "the template's models aren't saved as provider defaults");
  assert.equal(saved("roleModels"), null, "nor as the remembered role models for every new draft");

  // Team templates and sweeps choose models through setAgentSetting: also for this draft only.
  m.setAgentSetting("codex", { model: "gpt-5" });
  assert.equal(m.agentSettings.value.codex.model, "gpt-5");
  assert.deepEqual(saved("agentSettings"), SAVED_MODELS);
  m.agentSettings.value = { ...m.agentSettings.value, codex: { effort: "low" } };

  // Settings edits one provider's saved default; the draft's other template choices aren't saved with it.
  m.setProviderDefault("codex", { effort: "high" });
  assert.deepEqual(saved("agentSettings"), { claude: { effort: "high" }, codex: { effort: "high" } });
  assert.deepEqual(m.agentSettings.value, { claude: { effort: "medium" }, codex: { effort: "high" } }, "the change also reaches the current draft");
  m.setProviderDefault("codex", { effort: "low" });
});

test("a project's remembered team prefills only its own draft and leaves Settings unchanged", async () => {
  const remembered = { id: "p", name: "Remembers", repos: ["/p"], createdAt: 0, defaults: { pattern: "pipeline", teams: { pipeline: { roles: { planner: ["codex"], builder: ["codex"], reviewer: ["codex"] }, roleSettings: { reviewer: { codex: { model: "gpt-5" } } } } }, agentSettings: { claude: { effort: "low" } } } };
  const plain = { id: "q", name: "Plain", repos: ["/q"], createdAt: 0 };
  m.projects.value = [remembered, plain]; m.projectsLoaded.value = true;
  await m.initializeProjectDrafts();

  await m.openComposer("p");
  assert.equal(m.patternId.value, "pipeline", "the project's draft starts from its remembered workflow");
  assert.deepEqual(m.roleSel.value.pipeline, remembered.defaults.teams.pipeline.roles);
  assert.deepEqual(m.agentSettings.value, { claude: { effort: "low" }, codex: { effort: "low" } }, "remembered models layer over the provider defaults");
  assert.deepEqual([m.composerOrigins.value.pattern, m.composerOrigins.value.roles, m.composerOrigins.value.models], ["Project defaults", "Project defaults", "Project defaults"]);
  assert.equal(storage.get("pattern"), "solo", "Settings > Run defaults keeps its default workflow");
  assert.equal(m.defaultPattern.value, "solo");
  assert.deepEqual(saved("agentSettings"), SAVED_MODELS, "Settings > Agents & models keeps the saved effort");
  assert.deepEqual(m.providerDefaults.value, SAVED_MODELS);
  assert.equal(saved("roleSel")?.pipeline, undefined, "the project's team isn't saved for other projects");

  // Changing one role remembers that choice only, not the rest of the project's team.
  m.setRoles("pipeline", "builder", ["claude"]);
  m.setRoleModel("pipeline", "builder", "claude", { effort: "max" });
  assert.deepEqual(saved("roleSel").pipeline, { builder: ["claude"] });
  assert.deepEqual(saved("roleModels").pipeline, { builder: { claude: { effort: "max" } } });

  await m.openComposer("q");
  assert.equal(m.patternId.value, "solo", "a project without a remembered team starts from Settings > Run defaults");
  assert.deepEqual(m.agentSettings.value, SAVED_MODELS);
  assert.notEqual(m.composerOrigins.value.pattern, "Project defaults", "another project's label doesn't carry over");
  assert.notEqual(m.composerOrigins.value.models, "Project defaults");

  await m.openComposer("p");
  assert.equal(m.patternId.value, "pipeline", "the project's own draft is kept");
  assert.deepEqual(m.roleSel.value.pipeline, { ...remembered.defaults.teams.pipeline.roles, builder: ["claude"] });
});
