import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { RepoInfo } from "../ui/types.js";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "window", { configurable: true, value: { innerWidth: 1440, addEventListener() {} } });
Object.defineProperty(globalThis, "location", { configurable: true, value: { hostname: "localhost", hash: "", origin: "http://localhost" } });
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
const state = await import("../ui/state.js");
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
beforeEach(() => { values.clear(); requests.length = 0; state.repoInfo.value = null; state.repoConfig.value = null; state.checkCmd.value = ""; state.setupCmd.value = ""; });

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
