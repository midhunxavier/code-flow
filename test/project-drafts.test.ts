import test from "node:test";
import assert from "node:assert/strict";

const values = new Map<string, string>([["repo", "/shared"], ["draftTask", "legacy ambiguous draft"]]);
Object.assign(globalThis, {
  window: { innerWidth: 1440, addEventListener() {} },
  document: { addEventListener() {}, hidden: false },
  location: { hostname: "localhost", hash: "", origin: "http://localhost", search: "" },
  localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) },
});
globalThis.fetch = (async (input: string) => {
  const url = new URL(input, "http://localhost"), repo = url.searchParams.get("repo");
  return new Response(JSON.stringify(url.pathname === "/api/branches" ? { repo, current: "main", branches: [{ name: "main" }, { name: "feature/a" }], worktreeRoot: `${repo}/worktrees` } : url.pathname === "/api/repo-config" ? { found: true, config: { setup: `setup ${repo}`, check: `test ${repo}` } } : {}), { status: 200 });
}) as typeof fetch;
const state = await import("../ui/state.js");
const { selectedTeamTemplate } = await import("../ui/team-template-state.js");
const { rerunDraft } = await import("../ui/rerun-draft.js");
const a = { id: "a", name: "A", repos: ["/shared", "/a"], createdAt: 0 };
const b = { id: "b", name: "B", repos: ["/shared", "/b"], createdAt: 0 };

test("project drafts survive filters, navigation, attachment restoration and removed membership", async () => {
  state.projects.value = [a, b]; state.projectsLoaded.value = true;
  await state.initializeProjectDrafts();
  assert.equal(state.composerProject.value, "", "ambiguous legacy ownership stays unassigned");
  assert.equal(state.task.value, "legacy ambiguous draft");
  await state.openComposer("a");
  assert.equal(state.patternId.value, "solo", "new project drafts default to the Agent conversation");
  const selection = { template: { schemaVersion: 1 as const, id: "project-template", version: 1, name: "Project template", description: "", scope: "project" as const, project: "a", autoEnabled: false, parameters: ["task"], roles: [], tasks: [], contracts: [], workflow: "solo", task: "{{task}}", criteria: [] }, inputs: { task: "A" } };
  selectedTeamTemplate.value = selection;
  const team: import("../src/task-team.js").TaskTeamConfig = { enabled: true, preset: "build-review", coordinator: "claude", providers: ["codex"], settings: { codex: { model: "gpt-6-luna" } }, maxMembers: 3, maxCalls: 12, maxMinutes: 20, approvePlan: true };
  state.composerRunOptions.value = { taskTeam: team, antigravityExecution: "native", permissionRequirements: [] };
  state.setTask("task A"); state.attachments.value = [{ name: "spec.txt", data: "aGVsbG8=", size: 5 }];
  state.contextPaths.value = new Map([["a.txt", { path: "a.txt", type: "file" }]]);
  state.setCheck("custom check A"); state.baseRef.value = "feature/a";
  state.selectProject("b"); state.route.value = { view: "project", id: "b" };
  assert.equal(state.composerProject.value, "a"); assert.equal(state.task.value, "task A");
  assert.equal(state.repo.value, "/shared");
  assert.deepEqual(selectedTeamTemplate.value, selection, "viewing a project does not change the draft template");
  await state.openComposer("b");
  assert.equal(state.task.value, ""); assert.deepEqual(state.attachments.value, []);
  assert.equal(selectedTeamTemplate.value, null);
  assert.equal(state.composerRunOptions.value.antigravityExecution, undefined);
  assert.equal(state.composerRunOptions.value.taskTeam, undefined, "Team configuration stays with its project draft");
  state.setTask("task B");
  await state.chooseComposerRepository("/b");
  await state.openComposer("a");
  assert.equal(state.task.value, "task A"); assert.deepEqual(state.attachments.value, [{ name: "spec.txt", data: "aGVsbG8=", size: 5 }]);
  assert.equal(state.contextPaths.value.get("a.txt")?.path, "a.txt");
  assert.deepEqual(selectedTeamTemplate.value, selection);
  assert.equal(state.composerRunOptions.value.antigravityExecution, "native");
  assert.deepEqual(state.composerRunOptions.value.taskTeam, team);
  assert.equal(state.checkCmd.value, "custom check A"); assert.equal(state.baseRef.value, "feature/a");
  state.projects.value = [{ ...a, repos: ["/a"] }, b];
  assert.match(state.target.value.problem, /no longer/);
  await Promise.all([state.openComposer("a"), state.openComposer("b")]); assert.equal(state.task.value, "task B"); assert.equal(state.repo.value, "/b");
  await state.openComposer(""); assert.equal(state.task.value, "legacy ambiguous draft");
  state.projects.value = [...state.projects.value, { id: "empty", name: "Empty", repos: [], createdAt: 0 }];
  await state.openComposer("empty"); assert.equal(state.repo.value, ""); assert.equal(state.task.value, "");
  await state.openComposer(""); assert.equal(state.task.value, "legacy ambiguous draft");
  await state.saveComposerDraft();
  assert.ok(values.has("project-draft-v1:legacy-backup"));
});

test("editable retry identity and execution settings stay with their project draft", async () => {
  state.projects.value = [a, b];
  await state.openComposer("a", { repository: "/shared" });
  const retry = { id: "original", repo: "/shared", loop: { maxMinutes: 30, maxSteps: 12, checkTimeoutMin: 1, check: "retry-check", setup: "retry-setup", remoteWorker: { workerId: "worker", repoMapping: "mapped" } }, approvals: { tools: true } };
  rerunDraft.value = retry;
  state.composerRunOptions.value = { remoteWorker: retry.loop.remoteWorker, toolApprovals: true };
  state.setRunCheck("retry-check");
  await state.openComposer("b", { repository: "/shared" });
  assert.equal(rerunDraft.value, null, "a shared repository cannot carry another project's retry identity");
  assert.equal(state.composerRunOptions.value.remoteWorker, undefined);
  assert.notEqual(state.checkCmd.value, "retry-check");
  await state.openComposer("a");
  assert.deepEqual(rerunDraft.value, retry);
  assert.deepEqual(state.composerRunOptions.value.remoteWorker, retry.loop.remoteWorker);
  assert.equal(state.checkCmd.value, "retry-check");
  await state.chooseComposerRepository("/a");
  assert.equal(rerunDraft.value, null, "changing repository clears the original run identity");
  assert.equal(state.composerRunOptions.value.remoteWorker, undefined);
});

test("project deletion clears inactive and current drafts, including attachments and retry settings", async () => {
  await state.openComposer("b"); state.setTask("Keep B");
  state.attachments.value = [{ name: "keep.txt", data: "a2VlcA==", size: 4 }];
  await state.saveComposerDraft();
  await state.discardProjectDraft("a");
  assert.equal(state.composerProject.value, "b"); assert.equal(state.task.value, "Keep B");
  assert.equal(await state.savedDraftTask("a"), "");
  assert.equal(values.has("project-draft-v1:a"), false);
  state.projects.value = [b];
  await state.openComposer("a");
  assert.equal(state.composerProject.value, "", "old links cannot recreate the deleted draft");
  await state.openComposer("b");
  assert.equal(state.task.value, "Keep B"); assert.equal(state.attachments.value[0]?.name, "keep.txt");
  state.route.value = { view: "project", id: "b" };
  await state.discardProjectDraft("b");
  state.projects.value = [];
  await state.saveComposerDraft();
  assert.equal(state.composerProject.value, "");
  assert.equal(state.target.value.unavailable, false);
  assert.equal(values.has("project-draft-v1:b"), false);
  assert.deepEqual(state.attachments.value, []);
  assert.equal(rerunDraft.value, null);
  assert.deepEqual(state.composerRunOptions.value, {});
  assert.equal(state.task.value, "legacy ambiguous draft", "a separate unassigned draft stays available");
  assert.deepEqual(state.route.value, { view: "projects" });
});

test("project deletion leaves a removed run even when the project inventory disappears first", async () => {
  for (const cached of [true, false]) {
    const project = `deleted-${cached}`, id = `run-${cached}`;
    const run = { id, project, repo: "/deleted", deleted: false } as import("../ui/types.js").RunSummary;
    state.projects.value = [];
    state.runs.value = new Map(cached ? [[id, run]] : []);
    state.route.value = { view: "run", id };
    state.upsertRun({ ...run, deleted: true });
    await state.discardProjectDraft(project);
    assert.deepEqual(state.route.value, { view: "projects" });
    assert.equal(state.deletedRunNotice.value, null, "project deletion does not leave an orphaned run recovery banner");
  }
});
