import { test } from "node:test";
import assert from "node:assert/strict";
const values = new Map<string, string>([["projectDraftVersion", "1"], ["composerProject", "a"], ["repo", "/a"], ["limits", '{"maxMinutes":-5,"maxSteps":1001}']]);
Object.assign(globalThis, { window: { innerWidth: 1440, addEventListener() {} }, document: { addEventListener() {}, hidden: false }, location: { hostname: "localhost", hash: "#/insights", origin: "http://localhost", search: "" }, localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
globalThis.fetch = (async (input: string) => { const url = new URL(input, "http://localhost"), repo = url.searchParams.get("repo"); return new Response(JSON.stringify(url.pathname === "/api/branches" ? { repo, current: "main", branches: [{ name: "main", kind: "local" }], worktreeRoot: `${repo}/worktrees` } : url.pathname === "/api/repo-config" ? { found: true, config: {} } : url.pathname === "/api/check" ? { command: null } : url.pathname === "/api/verification/profile" ? { id: url.searchParams.get("preset"), checks: [{ command: `fixture-${url.searchParams.get("preset")}`, required: true }] } : {})); }) as typeof fetch;
const state = await import("../ui/state.js");
const { composerRunBody } = await import("../ui/composer-body.js");
const { comparisonDraft, comparisonDraftProblem } = await import("../ui/workflow-ui.js");
const currentDraft = () => comparisonDraft.value;
const { saveProjectDefaults } = await import("../ui/project-defaults.js");
const pattern = { id: "solo", name: "Agent", summary: "", description: "", roles: [{ id: "agent", label: "Agent", description: "", default: ["claude" as const] }], options: [] };
state.patterns.value = [pattern]; state.agents.value = [{ id: "claude", displayName: "Claude", binary: "claude", available: true }];
state.projects.value = [{ id: "a", name: "A", repos: ["/a"], createdAt: 0 }, { id: "b", name: "B", repos: ["/b"], createdAt: 0 }]; state.projectsLoaded.value = true;
const wait = () => new Promise(resolve => setTimeout(resolve, 50));
test("stale stored run limits are safe on load", () => { assert.deepEqual(state.limits.value, { maxMinutes: 720, maxSteps: 500 }); });
test("acceptance editing keeps every character, including an empty 101st line", () => {
  const text = [...Array(100).fill("x".repeat(2001)), ""]; state.setAcceptanceCriteria(text); assert.deepEqual(state.acceptanceCriteria.value, text); assert.deepEqual(JSON.parse(values.get("draftAcceptance")!), text); state.setAcceptanceCriteria([]);
});
test("comparison reads restored global drafts without Composer mounting and invalidates while switching", async () => {
  await state.initializeProjectDrafts(); await state.openComposer("a"); state.setTask("Project A task"); await state.saveComposerDraft(); assert.equal(currentDraft()?.task, "Project A task");
  state.composerLoading.value = true; assert.equal(comparisonDraft.value, null); state.composerLoading.value = false;
  await state.openComposer("b"); state.setTask("Project B task"); await state.saveComposerDraft(); assert.equal(currentDraft()?.task, "Project B task"); assert.equal(currentDraft()?.repo, "/b");
  await state.openComposer("a"); assert.equal(currentDraft()?.task, "Project A task"); assert.equal(currentDraft()?.repo, "/a");
});
test("disabled AI teams are omitted while enabled local team settings remain", () => {
  const team = { enabled: false, coordinator: "claude" as const, providers: ["claude" as const], preset: "adaptive" as const, settings: {}, maxMembers: 4, maxCalls: 20, maxMinutes: 30, approvePlan: false };
  state.composerRunOptions.value = { taskTeam: team }; assert.equal(composerRunBody(pattern).taskTeam, undefined);
  state.composerRunOptions.value = { taskTeam: { ...team, enabled: true } }; assert.equal(composerRunBody(pattern).taskTeam.enabled, true);
  assert.equal(composerRunBody({ ...pattern, id: "pipeline" }).taskTeam, undefined);
  state.composerRunOptions.value = {};
});
test("a direct Insights draft honors project verification defaults after async loading", async () => {
  saveProjectDefaults("/a", { verification: "lightweight", container: { enabled: false, image: "", authVolume: "" } });
  assert.equal(comparisonDraft.value, null); assert.match(comparisonDraftProblem.value, /Loading/); await wait(); assert.equal(currentDraft()?.loop.verification.checks[0].command, "fixture-lightweight");
});

test("comparison follows changed project defaults instead of a cached default profile", async () => {
  state.composerRunOptions.value = { verificationProfile: { id: "old", checks: [{ command: "stale-check", required: true }] } as any };
  saveProjectDefaults("/a", { verification: "standard", container: { enabled: false, image: "", authVolume: "" } }); await wait(); assert.equal(currentDraft()?.loop.verification.checks[0].command, "fixture-standard");
  saveProjectDefaults("/a", { verification: "", container: { enabled: false, image: "", authVolume: "" } }); assert.equal(currentDraft()?.loop.verification, undefined);
  state.composerRunOptions.value = { verification: "restored", verificationProfile: { id: "kept", checks: [{ command: "explicit-restored", required: true }] } as any }; assert.equal(currentDraft()?.loop.verification.checks[0].command, "explicit-restored");
});
