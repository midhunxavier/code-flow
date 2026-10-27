// QA regressions for the composer's Permissions control: the label, Run details and the start request
// agree on one policy (repo trust, Docker, remote, Safe, Antigravity), defaults avoid a provider the
// chosen approvals can't run, and the server names approvals when Antigravity refuses them.
import test from "node:test";
import assert from "node:assert/strict";
import type { PatternInfo } from "../ui/types.js";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "window", { configurable: true, value: { innerWidth: 1440, addEventListener() {} } });
Object.defineProperty(globalThis, "location", { configurable: true, value: { hostname: "localhost", hash: "", origin: "http://localhost" } });
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
const { permissionLabel, toolApprovalState } = await import("../ui/composer-permissions.js");
const state = await import("../ui/state.js");
const { AGY_APPROVALS_PROBLEM, AGY_MANAGED_PERMISSION_PROBLEM, createRunPermissions, resolveRunPermissions } = await import("../src/run-permissions.js");

const pattern = (id: string, roles: string[]) => ({ id, name: id, roles: roles.map((role) => ({ id: role.toLowerCase(), label: role, default: [] })), options: [] }) as unknown as PatternInfo;
const solo = pattern("solo", ["Agent"]);
const fixReview = pattern("fix-review", ["Builder", "Reviewer"]);

test("the Permissions label never says Ask for approval for a level other than the one it sends", () => {
  assert.equal(permissionLabel({ trust: "standard", tools: true }), "Ask for approval");
  assert.equal(permissionLabel({ trust: "standard", tools: false }), "Approve for me");
  assert.equal(permissionLabel({ trust: "trusted", tools: false }), "Trusted");
  assert.equal(permissionLabel({ trust: "safe", tools: false }), "Safe");
  assert.equal(permissionLabel({ trust: "trusted", tools: true }), "Trusted · ask for approval", "t02-4: trusted shell access stays visible");
  assert.equal(permissionLabel({ trust: "full", tools: true }, true), "Ask for approval", "ACP agents ask at Full access");
});

test("a repository's Trusted default is shown and sent without approvals unless they are chosen (t02-4)", () => {
  const trusted = toolApprovalState({ trust: "trusted", p: solo, roles: { agent: ["claude"] } });
  assert.deepEqual(trusted, { tools: false, source: "Application default", conflict: "" });
  assert.equal(toolApprovalState({ trust: "standard", p: solo, roles: { agent: ["claude"] } }).tools, true, "a Claude conversation at Standard asks by default");
  assert.equal(toolApprovalState({ trust: "full", p: solo, roles: { agent: ["codex"] } }).tools, false);
  assert.equal(toolApprovalState({ choice: true, trust: "trusted", p: solo, roles: { agent: ["claude"] } }).tools, true, "an explicit choice is kept and labelled with both");
});

test("Run details and the request use the value the control shows (t02-6, t03-6, S02-3, t21-1)", () => {
  const fresh = toolApprovalState({ trust: "standard", p: solo, roles: { agent: ["claude"] } });
  assert.deepEqual(fresh, { tools: true, source: "Default for Claude and Codex conversations", conflict: "" });
  assert.deepEqual(toolApprovalState({ choice: true, trust: "safe", p: solo, roles: { agent: ["claude"] } }), { tools: false, source: "Safe permissions", conflict: "" });
  assert.deepEqual(toolApprovalState({ trust: "standard", p: solo, roles: { agent: ["claude"] }, container: true }), { tools: false, source: "Unavailable with Docker isolation", conflict: "" });
  assert.equal(toolApprovalState({ choice: true, trust: "standard", p: solo, roles: { agent: ["codex"] }, remote: true }).source, "Unavailable on a remote worker");
  assert.equal(toolApprovalState({ choice: true, trust: "safe", p: solo, roles: { agent: ["codex"] }, external: true }).source, "External source · Safe permissions");
  assert.deepEqual(toolApprovalState({ choice: false, trust: "standard", p: solo, roles: { agent: ["claude"] } }), { tools: false, source: "Explicit choice", conflict: "" });
});

test("Antigravity: alone it runs without approvals; beside providers that ask, Start explains the conflict (t10-8, t20-13)", () => {
  assert.deepEqual(toolApprovalState({ choice: true, trust: "standard", p: fixReview, roles: { builder: ["agy"], reviewer: ["agy"] } }), { tools: false, source: "Antigravity can't ask for approval", conflict: "" });
  assert.deepEqual(toolApprovalState({ choice: true, trust: "standard", p: solo, roles: { agent: ["agy"] } }).tools, false);
  const mixed = toolApprovalState({ choice: true, trust: "standard", p: fixReview, roles: { builder: ["codex"], reviewer: ["agy"] } });
  assert.equal(mixed.tools, true);
  assert.match(mixed.conflict, /^Antigravity can't ask for approval\..*Claude or Codex for Reviewer\.$/);
  assert.equal(toolApprovalState({ choice: false, trust: "standard", p: fixReview, roles: { builder: ["codex"], reviewer: ["agy"] } }).conflict, "");
  assert.equal(toolApprovalState({ trust: "standard", p: fixReview, roles: { builder: ["codex"], reviewer: ["agy"] } }).tools, false, "templates don't ask unless chosen");
});

test("default reviewer, judge and synthesizer avoid Antigravity after an explicit Ask for approval (t10-8)", () => {
  state.agents.value = ["claude", "codex", "agy"].map((id) => ({ id, displayName: id, binary: id, available: true })) as typeof state.agents.value;
  state.health.value = ["claude", "codex", "agy"].map((id) => ({ id: id as "claude", name: id, installed: true, signedIn: true, compatible: true, managedCompatible: true }));
  state.roleSel.value = {};
  state.trust.value = "standard";
  const workflows = {
    pipeline: { id: "pipeline", roles: [{ id: "planner", default: ["claude"] }, { id: "builder", default: ["codex"] }, { id: "reviewer", default: ["codex"] }] },
    race: { id: "race", roles: [{ id: "contestants", multiple: true, default: ["claude", "codex"] }, { id: "judge", default: ["claude"] }] },
    debate: { id: "debate", roles: [{ id: "debaters", multiple: true, default: ["claude", "codex"] }, { id: "synthesizer", default: ["claude"] }] },
  } as unknown as Record<string, PatternInfo>;
  const independent = { pipeline: "reviewer", race: "judge", debate: "synthesizer" } as const;
  for (const [id, role] of Object.entries(independent)) {
    state.composerRunOptions.value = {};
    assert.deepEqual(state.rolesFor(workflows[id])[role], ["agy"], `${id}: a third vendor checks the work by default`);
    state.composerRunOptions.value = { toolApprovals: true };
    assert.notDeepEqual(state.rolesFor(workflows[id])[role], ["agy"], `${id}: Antigravity can't ask for approval`);
    state.composerRunOptions.value = { toolApprovals: true, container: { enabled: true, image: "img", authVolume: "" } };
    assert.equal(Object.values(state.rolesFor(workflows[id])).flat().includes("agy"), true, `${id}: approvals unavailable in Docker don't narrow the defaults`);
  }
  state.composerRunOptions.value = { toolApprovals: true };
  state.setRoles("pipeline", "reviewer", ["agy"]);
  assert.deepEqual(state.rolesFor(workflows.pipeline!).reviewer, ["agy"], "an explicit pick stays visible; Start explains the conflict");
  state.roleSel.value = {}; state.composerRunOptions.value = {}; state.health.value = null;
});

test("the server names approvals when Antigravity refuses them, and keeps the executor message for remote runs (t10-8, t20-13)", () => {
  const policy = createRunPermissions("standard", true, false);
  assert.throws(() => resolveRunPermissions({ policy, provider: "agy", mode: "write", currentTrust: "standard", currentTools: true }), (error: Error) => {
    if (process.platform !== "darwin") return /macOS executor/.test(error.message);
    assert.equal(error.message, AGY_APPROVALS_PROBLEM);
    assert.match(error.message, /interactive approvals/);
    assert.doesNotMatch(error.message, /Keychain|macOS executor/);
    return true;
  });
  assert.throws(() => resolveRunPermissions({ policy: createRunPermissions("standard", false, false), provider: "agy", mode: "write", currentTrust: "standard", currentTools: false, remote: true }), new RegExp(AGY_MANAGED_PERMISSION_PROBLEM.slice(0, 40)));
});
