// Composer drafts and repository configuration: a saved draft keeps only what was chosen for it
// (typed commands and limits, a picked permission, an Edit & run again), and everything else is
// derived again from Settings, .codeflow/config.json and the start branch whenever it opens.
import test from "node:test";
import assert from "node:assert/strict";

const values = new Map<string, string>([["projectDraftVersion", "1"], ["composerProject", "a"], ["repo", "/a"]]);
Object.assign(globalThis, {
  window: { innerWidth: 1440, addEventListener() {} },
  document: { addEventListener() {}, hidden: false },
  location: { hostname: "localhost", hash: "", origin: "http://localhost", search: "" },
  localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) },
});
/** The stand-in server: each repository's config by start branch ("" is the checkout), and its branches. */
const configs = new Map<string, Record<string, unknown>>();
let branches = ["main"];
const asked: URL[] = [];
globalThis.fetch = (async (input: string) => {
  const url = new URL(input, "http://localhost"), repo = url.searchParams.get("repo");
  asked.push(url);
  const body = url.pathname === "/api/branches" ? { repo, current: "main", branches: branches.map((name) => ({ name, kind: "local" })), worktreeRoot: `${repo}/worktrees` }
    : url.pathname === "/api/repo-config" ? { found: true, config: configs.get(`${repo}@${url.searchParams.get("ref") ?? ""}`) ?? {} }
    : url.pathname === "/api/check" ? { command: null } : {};
  return new Response(JSON.stringify(body), { status: 200 });
}) as typeof fetch;
const state = await import("../ui/state.js");
const { rerunDraft } = await import("../ui/rerun-draft.js");
const a = { id: "a", name: "A", repos: ["/a"], createdAt: 0 }, b = { id: "b", name: "B", repos: ["/b"], createdAt: 0 };
/** Until the configuration lookups have answered. */
async function settled() {
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (!state.configChecking.value && !state.repoChecking.value) { await state.checkLoaded(); return; }
  }
  assert.fail("configuration never loaded");
}
const reopen = async (id: string) => { await state.openComposer(id === "a" ? "b" : "a"); await state.openComposer(id); await settled(); };

test("a restored draft follows the current config and Settings unless the command was typed for it", async () => {
  configs.set("/a@", { check: "test v1", setup: "setup v1" });
  state.projects.value = [a, b]; state.projectsLoaded.value = true;
  await state.initializeProjectDrafts();
  await state.openComposer("a"); await settled();
  assert.deepEqual([state.checkCmd.value, state.setupCmd.value], ["test v1", "setup v1"]);
  await state.saveComposerDraft();
  configs.set("/a@", { check: "test v2", setup: "setup v2" });
  await reopen("a");
  assert.deepEqual([state.checkCmd.value, state.setupCmd.value], ["test v2", "setup v2"], "the saved draft doesn't replay the old config");
  assert.equal(state.composerOrigins.value.check, undefined);
  state.setRunCheck("typed override");
  configs.set("/a@", { check: "test v3", setup: "setup v3" });
  await reopen("a");
  assert.equal(state.checkCmd.value, "typed override", "an override typed for this draft stays");
  assert.equal(state.composerOrigins.value.check, "This run override", "and says so in Run details");
  assert.equal(state.setupCmd.value, "setup v3");
  // Settings → Projects saved for another project: its draft takes them when it opens.
  await state.openComposer("b"); await settled(); await state.saveComposerDraft();
  await state.openComposer("a"); await settled();
  values.set("check:/b", "project check"); values.set("setup:/b", "project setup");
  await state.openComposer("b"); await settled();
  assert.deepEqual([state.checkCmd.value, state.setupCmd.value], ["project check", "project setup"]);
  values.delete("check:/b"); values.delete("setup:/b");
});

test("config limits are the draft's limits until Settings or the draft sets its own, and never become the browser's", async () => {
  configs.set("/a@", { check: "true", limits: { maxMinutes: 15, maxSteps: 12, checkTimeoutMin: 7 } });
  await reopen("a");
  assert.deepEqual([state.limits.value.maxMinutes, state.limits.value.maxSteps], [15, 12]);
  assert.equal(values.get("limits"), undefined, "a repository's limits are not saved as this browser's defaults");
  configs.set("/a@", { check: "true", limits: { maxSteps: 900 } });
  await reopen("a");
  assert.deepEqual([state.limits.value.maxMinutes, state.limits.value.maxSteps], [240, 200], "within what the limit fields accept");
  state.setRunLimits({ maxMinutes: 30 });
  await reopen("a");
  assert.equal(state.limits.value.maxMinutes, 30, "limits typed for the draft stay");
  assert.equal(state.composerOrigins.value.limits, "This run override");
  state.setLimits({ maxSteps: 40 });
  assert.deepEqual(JSON.parse(values.get("limits")!), { maxMinutes: 240, maxSteps: 40 }, "Settings saves its own values, not the draft's");
  assert.deepEqual([state.limits.value.maxMinutes, state.limits.value.maxSteps], [30, 40]);
  await state.openComposer("b"); await settled();
  assert.deepEqual([state.limits.value.maxMinutes, state.limits.value.maxSteps], [240, 40], "your saved limits win over a repository's");
  values.delete("limits"); state.limitPreference.value = null;
});

test("permissions follow the config until one is picked, and Run details says where they came from", async () => {
  configs.set("/a@", { trust: "safe" });
  await reopen("a");
  assert.equal(state.trust.value, "safe");
  assert.equal(state.composerOrigins.value.trust, undefined);
  configs.set("/a@", {});
  await reopen("a");
  assert.equal(state.trust.value, "standard", "a permission the draft never chose isn't replayed from it");
  state.setTrust("trusted");
  values.set("trust", "full");
  await reopen("a");
  assert.equal(state.trust.value, "trusted", "a permission picked in this draft stays with it");
  assert.equal(state.composerOrigins.value.trust, "This run (remembered)");
  values.delete("trust");
});

test("a deleted start branch isn't restored; a retry's pinned commit is", async () => {
  branches = ["main", "feature/x"];
  await reopen("a");
  state.baseRef.value = "feature/x";
  await settled();
  await state.openComposer("b"); await settled();
  branches = ["main"];
  await state.openComposer("a"); await settled();
  assert.equal(state.baseRef.value, "");
  assert.match(state.baseNotice.value, /“feature\/x” no longer exists/);
  await state.openComposer("b"); await settled();
  assert.equal(state.baseNotice.value, "", "the notice belongs to the draft it was about");
  await state.openComposer("a"); await settled();
  const pinned = "c".repeat(40);
  rerunDraft.value = { id: "r1", repo: "/a", loop: { maxMinutes: 1, maxSteps: 1, checkTimeoutMin: 1 }, approvals: {}, baseRef: pinned, task: "Retry" };
  state.baseRef.value = pinned;
  await state.openComposer("b"); await settled();
  await state.openComposer("a"); await settled();
  assert.equal(state.baseRef.value, pinned, "a retry may start from a commit no branch names");
  state.rememberBase();
  assert.notEqual(values.get("baseRef"), pinned, "but it is never remembered for later drafts");
  rerunDraft.value = null; state.baseRef.value = "";
});

test("choosing a start branch reads its committed config, keeping what was typed", async () => {
  branches = ["main", "alt"];
  configs.set("/a@", { check: "main check", setup: "main setup", limits: { maxSteps: 7 } });
  configs.set("/a@alt", { check: "alt check", setup: "alt setup", limits: { maxSteps: 33 } });
  await reopen("a");
  state.forgetChoices(); // what the earlier tests typed for this draft
  await state.loadCheck();
  asked.length = 0;
  state.baseRef.value = "alt";
  await settled();
  assert.ok(asked.some((url) => url.pathname === "/api/repo-config" && url.searchParams.get("ref") === "alt"));
  assert.deepEqual([state.checkCmd.value, state.setupCmd.value, state.limits.value.maxSteps, state.repoConfig.value?.ref], ["alt check", "alt setup", 33, "alt"]);
  state.setRunSetup("my setup");
  state.baseRef.value = "";
  await settled();
  assert.deepEqual([state.checkCmd.value, state.setupCmd.value, state.limits.value.maxSteps], ["main check", "my setup", 7]);
  state.source.value = { kind: "issue", number: 1, title: "Issue", url: "https://github.com/o/r/issues/1" };
  state.baseRef.value = "alt";
  await settled();
  assert.equal(state.checkCmd.value, "main check", "a run from an issue keeps the checkout's config, as the server does");
  state.source.value = null; state.baseRef.value = "";
  await settled();
});

test("a draft counts as unsent work unless it is an untouched Edit & run again", async () => {
  await reopen("a");
  state.setTask("");
  assert.equal(await state.unsentDraft("a"), null);
  state.setTask("MY UNSENT DRAFT");
  assert.deepEqual(await state.unsentDraft("a"), { task: "MY UNSENT DRAFT" });
  await state.openComposer("b"); await settled();
  assert.deepEqual(await state.unsentDraft("a"), { task: "MY UNSENT DRAFT" }, "a stored draft is read too");
  await state.openComposer("a"); await settled();
  rerunDraft.value = { id: "r1", repo: "/a", loop: { maxMinutes: 1, maxSteps: 1, checkTimeoutMin: 1 }, approvals: {}, task: "Original task" };
  state.setTask("Original task");
  assert.equal(await state.unsentDraft("a"), null, "its run can bring it back");
  state.contextPaths.value = new Map([["README.md", { path: "README.md", type: "file" }]]);
  assert.deepEqual(await state.unsentDraft("a"), { task: "Original task" }, "new context is unsent work even when the retry's task text is unchanged");
  rerunDraft.value = { ...rerunDraft.value!, contextPaths: [{ path: "README.md", type: "file" }] };
  assert.equal(await state.unsentDraft("a"), null, "unchanged original context can still be brought back by the run");
  state.contextPaths.value = new Map();
  assert.deepEqual(await state.unsentDraft("a"), { task: "Original task" }, "removing original context is also an unsent edit");
  state.setTask("Original task, edited");
  assert.deepEqual(await state.unsentDraft("a"), { task: "Original task, edited" });
  rerunDraft.value = null; state.setTask("");
});
