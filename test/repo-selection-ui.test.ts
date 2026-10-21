import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { RepoInfo } from "../ui/types.js";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "window", { configurable: true, value: { innerWidth: 1440, addEventListener() {} } });
Object.defineProperty(globalThis, "location", { configurable: true, value: { hostname: "localhost", hash: "", origin: "http://localhost" } });
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
const state = await import("../ui/state.js");
const { rerunDraft } = await import("../ui/rerun-draft.js");
// Keep these regressions executable on the old composer, which edited signals directly.
const draftState = state as typeof state & { setRunCheck?: (value: string) => void; setRunSetup?: (value: string) => void };
const editCheck = (value: string) => draftState.setRunCheck ? draftState.setRunCheck(value) : (state.checkCmd.value = value);
const editSetup = (value: string) => draftState.setRunSetup ? draftState.setRunSetup(value) : (state.setupCmd.value = value);
const { api, sharedGet, post } = await import("../ui/lib.js");
const requests: Array<{ url: URL; respond: (body: unknown, status?: number) => void; done: boolean }> = [];
globalThis.fetch = ((input: string) => new Promise<Response>((resolve) => {
  const entry = { url: new URL(input, "http://localhost"), done: false, respond: (body: unknown, status = 200) => { entry.done = true; resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })); } };
  requests.push(entry);
})) as typeof fetch;
const info = (repo: string): RepoInfo => ({ repo, current: "main", branches: [], worktreeRoot: `${repo}/worktrees` });
const response = async (path: string, repo: string, body: unknown, status = 200) => {
  for (let attempts = 0; attempts < 20; ++attempts) {
    const request = requests.find((r) => !r.done && r.url.pathname === path && r.url.searchParams.get("repo") === repo);
    if (request) { request.respond(body, status); await new Promise<void>((resolve) => setImmediate(resolve)); return; }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`No pending ${path} request for ${repo}`);
};
beforeEach(() => { values.clear(); requests.length = 0; rerunDraft.value = null; state.repoInfo.value = null; state.repoConfig.value = null; state.checkCmd.value = ""; state.setupCmd.value = ""; });

test("reselecting a retry repository through an alias preserves its pinned draft throughout discovery", async () => {
  state.repoInfo.value = info("/a");
  const retry = { id: "original", repo: "/a", approvals: {}, loop: { remoteWorker: { workerId: "worker", repoMapping: "mapped" } } } as NonNullable<typeof rerunDraft.value>;
  rerunDraft.value = retry;
  state.baseRef.value = "a".repeat(40);
  state.checkCmd.value = "run-only-check";
  state.setupCmd.value = "";
  state.trust.value = "safe";
  state.contextPaths.value = new Map([["spec.txt", { path: "spec.txt", type: "file" }]]);
  const selected = state.setRepo("/alias-a");
  assert.equal(state.repo.value, "/a");
  assert.equal(state.repoChecking.value, true);
  assert.equal(rerunDraft.value, retry);
  await response("/api/branches", "/alias-a", info("/a"));
  assert.equal(await selected, true);
  assert.equal(rerunDraft.value, retry);
  assert.equal(state.baseRef.value, "a".repeat(40), "pinned commits need not appear in the branch list");
  assert.deepEqual([state.checkCmd.value, state.setupCmd.value, state.trust.value], ["run-only-check", "", "safe"]);
  assert.equal(state.contextPaths.value.has("spec.txt"), true);
  assert.equal(requests.some(request => request.url.pathname === "/api/repo-config"), false, "retry commands are not replaced by rediscovery");
});

test("retry metadata survives a failed lookup and clears only after a different repository resolves", async () => {
  state.repoInfo.value = info("/a");
  const retry = { id: "original", repo: "/a", approvals: {}, loop: {} } as NonNullable<typeof rerunDraft.value>;
  rerunDraft.value = retry;
  state.checkCmd.value = "original-check";
  const failed = state.setRepo("/missing");
  await response("/api/branches", "/missing", { error: "Missing folder" }, 400);
  assert.equal(await failed, false);
  assert.equal(rerunDraft.value, retry);
  assert.equal(state.repo.value, "/a");
  assert.equal(state.checkCmd.value, "original-check");
  const changed = state.setRepo("/b");
  assert.equal(rerunDraft.value, retry);
  await response("/api/branches", "/b", info("/b"));
  assert.equal(rerunDraft.value, null);
  await response("/api/repo-config", "/b", { found: true, config: { check: "new-check", setup: "new-setup" } });
  await changed;
  assert.deepEqual([state.repo.value, state.checkCmd.value, state.setupCmd.value], ["/b", "new-check", "new-setup"]);
});

test("late repository lookup cannot undo the most recent repository choice", async () => {
  const a = state.setRepo("/a");
  const b = state.setRepo("/b");
  await response("/api/branches", "/b", info("/b"));
  await response("/api/repo-config", "/b", { found: true, config: { setup: "setup-b", check: "check-b" } });
  await b;
  await response("/api/branches", "/a", info("/a"));
  assert.equal(await a, false);
  assert.equal(state.repo.value, "/b");
  assert.equal(state.checkCmd.value, "check-b");
  assert.equal(values.get("repo"), "/b");
  assert.equal(requests.some((r) => r.url.pathname === "/api/repo-config" && r.url.searchParams.get("repo") === "/a"), false);
});

test("stale configuration cannot overwrite setup, check or trust for the new selection", async () => {
  const a = state.setRepo("/a");
  await response("/api/branches", "/a", info("/a"));
  const b = state.setRepo("/b");
  assert.equal(state.checkCmd.value, "", "old repository commands are cleared immediately");
  await response("/api/branches", "/b", info("/b"));
  await response("/api/repo-config", "/b", { found: true, config: { setup: "setup-b", check: "check-b", trust: "safe" } });
  await b;
  await response("/api/repo-config", "/a", { found: true, config: { setup: "setup-a", check: "check-a", trust: "full" } });
  await a;
  assert.deepEqual([state.repo.value, state.setupCmd.value, state.checkCmd.value, state.trust.value], ["/b", "setup-b", "check-b", "safe"]);
  assert.equal(state.configChecking.value, false);
});

test("stale configuration errors and check-detection responses cannot clear current state", async () => {
  const a = state.setRepo("/a");
  await response("/api/branches", "/a", info("/a"));
  await response("/api/repo-config", "/a", { found: false, config: {} });
  const b = state.setRepo("/b");
  await response("/api/branches", "/b", info("/b"));
  await response("/api/repo-config", "/b", { found: true, config: { setup: "b", check: "b-test" } });
  await b;
  await response("/api/check", "/a", { command: "a-test", setup: "a", source: "a.json" });
  await a;
  assert.deepEqual([state.checkCmd.value, state.setupCmd.value], ["b-test", "b"]);
  assert.equal(state.repoConfig.value?.config.check, "b-test");
  const c = state.setRepo("/c");
  await response("/api/branches", "/c", info("/c"));
  const d = state.setRepo("/d");
  await response("/api/branches", "/d", info("/d"));
  await response("/api/repo-config", "/d", { found: true, config: { setup: "d", check: "d-test" } });
  await d;
  await response("/api/repo-config", "/c", { error: "Unavailable" }, 500);
  await c;
  assert.equal(state.repoConfig.value?.config.check, "d-test");
});

test("manual command edits, including intentional blanks, survive pending configuration and detection", async () => {
  const selected = state.setRepo("/a");
  await response("/api/branches", "/a", info("/a"));
  state.setCheck("custom-test"); state.setSetup("");
  await response("/api/repo-config", "/a", { found: true, config: { setup: "repo-setup", check: "repo-test" } });
  await selected;
  assert.deepEqual([state.checkCmd.value, state.setupCmd.value], ["custom-test", ""]);
  const next = state.setRepo("/b");
  await response("/api/branches", "/b", info("/b"));
  await response("/api/repo-config", "/b", { found: false, config: {} });
  state.setCheck(""); state.setSetup("");
  await response("/api/check", "/b", { command: "detected-test", setup: "detected-setup", source: "package.json" });
  await next;
  assert.deepEqual([state.checkCmd.value, state.setupCmd.value], ["", ""]);
});

test("draft-only command overrides survive late saved defaults and do not change repository preferences", async () => {
  values.set("check:/a", "saved-test");
  values.set("setup:/a", "saved-setup");
  const selected = state.setRepo("/a");
  await response("/api/branches", "/a", info("/a"));
  editCheck("this-run-only");
  editSetup("");
  await response("/api/repo-config", "/a", { found: true, config: { check: "repo-test", setup: "repo-setup" } });
  await selected;
  assert.deepEqual([state.checkCmd.value, state.setupCmd.value], ["this-run-only", ""]);
  assert.deepEqual([values.get("check:/a"), values.get("setup:/a")], ["saved-test", "saved-setup"]);
});

test("draft-only intentional blanks survive check and setup autodetection", async () => {
  const selected = state.setRepo("/a");
  await response("/api/branches", "/a", info("/a"));
  await response("/api/repo-config", "/a", { found: false, config: {} });
  editCheck("");
  editSetup("");
  await response("/api/check", "/a", { command: "detected-test", setup: "detected-setup", source: "package.json" });
  await selected;
  assert.deepEqual([state.checkCmd.value, state.setupCmd.value], ["", ""]);
  assert.deepEqual([values.get("check:/a"), values.get("setup:/a")], [undefined, undefined]);
});

test("request generation rejects an obsolete response when the user returns to the same repository", async () => {
  const first = state.setRepo("/a");
  await response("/api/branches", "/a", info("/a"));
  const current = state.setRepo("/a");
  await response("/api/branches", "/a", info("/a"));
  // First config still has the same repository path, but belongs to the old selection.
  await response("/api/repo-config", "/a", { found: true, config: { setup: "old", check: "old-test" } });
  await first;
  assert.equal(state.checkCmd.value, "");
  assert.equal(state.configChecking.value, true);
  await response("/api/repo-config", "/a", { found: true, config: { setup: "new", check: "new-test" } });
  await current;
  assert.equal(state.checkCmd.value, "new-test");
});

test("only opted-in inventory reads share a request and mutations invalidate sharing", async () => {
  const first = sharedGet("/api/projects"), same = sharedGet("/api/projects");
  assert.equal(first, same); assert.equal(requests.length, 1);
  const mutation = post("/api/projects", { name: "Updated" });
  const fresh = sharedGet("/api/projects");
  assert.notEqual(first, fresh); assert.equal(requests.length, 3);
  requests[1]!.respond({ ok: true }); requests[2]!.respond([{ name: "Updated" }]); requests[0]!.respond([{ name: "Old" }]);
  await Promise.all([first, same, mutation, fresh]);
  const a = api("/api/repo-config?repo=/a"), b = api("/api/repo-config?repo=/a");
  assert.notEqual(a, b); assert.equal(requests.length, 5);
  requests[3]!.respond({}); requests[4]!.respond({}); await Promise.all([a, b]);
});

test("command readiness waits for a fresh detection after a completed repository selection", async () => {
  const selected = state.setRepo("/a");
  await response("/api/branches", "/a", info("/a"));
  await response("/api/repo-config", "/a", { found: true, config: { setup: "initial-setup", check: "initial-check" } });
  await selected;
  const refresh = state.loadCheck();
  assert.equal(state.checkLoaded(), refresh);
  let settled = false;
  void state.checkLoaded().then(() => { settled = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false, "retry restoration must wait for the latest configuration request");
  await response("/api/repo-config", "/a", { found: true, config: { setup: "updated-setup", check: "updated-check" } });
  await state.checkLoaded();
  assert.equal(settled, true);
  assert.equal(state.checkCmd.value, "updated-check");
});

test("default and independent role selection excludes known unhealthy providers while preserving explicit choices", () => {
  state.agents.value = ["claude", "codex", "agy"].map(id => ({ id, displayName: id, binary: id, available: true })) as typeof state.agents.value;
  state.health.value = [
    { id: "claude", name: "Claude Code", installed: true, signedIn: false },
    { id: "codex", name: "Codex", installed: true, signedIn: true, compatible: true },
    { id: "agy", name: "Antigravity", installed: true, signedIn: true, compatible: true },
  ];
  const workflow = { id: "pipeline", roles: [
    { id: "planner", default: ["claude"] }, { id: "builder", default: ["codex"] }, { id: "reviewer", default: ["agy"] },
  ] } as import("../ui/types.js").PatternInfo;
  state.roleSel.value = {};
  assert.equal(Object.values(state.rolesFor(workflow)).flat().includes("claude"), false);
  state.setRoles("pipeline", "planner", ["agy"]);
  assert.equal(Object.values(state.rolesFor(workflow)).flat().includes("claude"), false, "independent review must not pick a signed-out third vendor");
  state.setRoles("pipeline", "reviewer", ["claude"]);
  assert.deepEqual(state.rolesFor(workflow).reviewer, ["claude"], "explicit choices remain visible for reconnection rather than silently switching providers");
  state.roleSel.value = {};
  state.health.value![2]!.compatible = false;
  assert.equal(Object.values(state.rolesFor(workflow)).flat().includes("agy"), false);
  state.health.value = null;
});
