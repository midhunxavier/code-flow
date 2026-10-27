import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "cf-task-team-"));
process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
process.env.FAKE_RECORD_DIR = mkdtempSync(join(tmpdir(), "cf-team-invocations-"));
const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { taskCheckpoint, applyTaskTeamResult, validateTaskTeam } = await import("../src/task-team.js");
const { groupChatTasks } = await import("../src/chat-family.js");
type Run = import("../src/engine.js").Run;
const config = validateTaskTeam({ enabled: true, preset: "adaptive", coordinator: "claude", providers: ["codex"], settings: {}, maxMembers: 3, maxCalls: 12, maxMinutes: 5, approvePlan: false });
const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo }).toString().trim();
function repository() { const repo = mkdtempSync(join(tmpdir(), "cf-team-repo-")); git(repo, "init", "-q", "-b", "main"); writeFileSync(join(repo, "README.md"), "Original\n"); git(repo, "add", "."); git(repo, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-qm", "base"); return repo; }
async function until(fn: () => boolean, ms = 30000) { const start = Date.now(); while (!fn()) { if (Date.now() - start > ms) throw new Error("Timed out"); await new Promise(r => setTimeout(r, 30)); } }
async function done(run: Run) { await until(() => run.status !== "running"); assert.equal(run.status, "done", run.error); }

test("private team checkpoints retain staged/unstaged files and apply exactly once without moving HEAD", async () => {
  const repo = repository();
  writeFileSync(join(repo, "README.md"), "Staged\n"); git(repo, "add", "."); writeFileSync(join(repo, "README.md"), "Unstaged\n"); writeFileSync(join(repo, "draft.txt"), "Untracked\n");
  const head = git(repo, "rev-parse", "HEAD"), index = git(repo, "diff", "--cached");
  mkdirSync(join(repo, ".codeflow-context")); writeFileSync(join(repo, ".codeflow-context", "history.txt"), "Portable provider history");
  writeFileSync(join(repo, ".git/info/exclude"), ".codeflow-context/\n");
  const before = await taskCheckpoint(repo, repo);
  assert.doesNotMatch(git(repo, "ls-tree", "-r", before), /codeflow-context/);
  writeFileSync(join(repo, "answer.txt"), "Team result\n"); const after = await taskCheckpoint(repo, repo);
  const { unlinkSync } = await import("node:fs"); unlinkSync(join(repo, "answer.txt"));
  await applyTaskTeamResult(repo, repo, before, after); await applyTaskTeamResult(repo, repo, before, after);
  assert.equal(readFileSync(join(repo, "draft.txt"), "utf8"), "Untracked\n"); assert.equal(readFileSync(join(repo, "answer.txt"), "utf8"), "Team result\n");
  assert.equal(git(repo, "diff", "--cached"), index); assert.equal(git(repo, "rev-parse", "HEAD"), head);
  writeFileSync(join(repo, "README.md"), "User changed it\n");
  await applyTaskTeamResult(repo, repo, before, after);
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "User changed it\n", "unrelated edits are preserved during reconciliation");
});

test("Agent → Team → Agent retains one task, native session and unsaved edits; cancelling the team hands back safely", { timeout: 60000 }, async () => {
  const repo = repository(); let hold = false, started = false;
  const team = { ...findPattern("auto-team")!, run: async (ctx: import("../src/engine.js").TeamContext) => {
    assert.ok(ctx.task.startsWith("Implement the result") || ctx.task.startsWith("Start a longer task"), "team receives the current request, not the lead's provider prompt or original turn");
    const wt = await ctx.worktree("integration");
    assert.equal(readFileSync(join(wt.path, "draft.txt"), "utf8"), "Preserve me\n");
    writeFileSync(join(wt.path, "result.txt"), "Team result\n"); await ctx.commit(wt, "Team result");
    started = true;
    if (hold) await new Promise<void>(resolve => { ctx.signal.addEventListener("abort", () => resolve(), { once: true }); });
    return "The implementation is complete; no automated check was run.";
  } };
  const manager = new RunManager(id => id === "auto-team" ? team : findPattern(id));
  try {
    const run = await manager.start({ pattern: findPattern("solo")!, repo, roles: { agent: ["claude"] }, options: {}, task: "Remember the task", trust: "standard" }); await done(run);
    const session = run.steps[0]!.sessionId, tree = run.worktrees[0]!;
    writeFileSync(join(tree.path, "draft.txt"), "Preserve me\n");
    await manager.configureTaskTeam(run.id, config);
    await assert.rejects(manager.configureTaskTeam(run.id, { ...config, maxCalls: 0 }), /Agent calls.*between 4 and 200/);
    assert.deepEqual(run.taskTeam, config, "invalid settings do not replace the configured team");
    await manager.followUp(run.id, { kind: "reply", agent: "claude", worktree: "solo", message: "Implement the result" }); await done(run);
    assert.equal(readFileSync(join(tree.path, "result.txt"), "utf8"), "Team result\n");
    assert.equal(run.steps.at(-1)!.mode, "read");
    assert.notEqual(run.steps.at(-1)!.sessionId, session);
    assert.equal(groupChatTasks(manager.list()).length, 1);
    assert.equal(groupChatTasks(manager.list())[0]!.chats.length, 1);
    assert.equal(run.teamTurns!.length, 1); assert.equal(run.teamTurns![0]!.state, "applied");
    await manager.configureTaskTeam(run.id, { ...config, enabled: false });
    await manager.followUp(run.id, { kind: "reply", agent: "claude", worktree: "solo", message: "Answer alone" }); await done(run);
    assert.equal(run.teamTurns!.length, 1);
    hold = true; started = false;
    await manager.configureTaskTeam(run.id, config);
    await manager.followUp(run.id, { kind: "reply", agent: "claude", worktree: "solo", message: "Start a longer task" });
    await until(() => started);
    await manager.configureTaskTeam(run.id, { ...config, enabled: false }); await done(run);
    assert.equal(run.teamTurns!.length, 2); assert.match(run.teamTurns![1]!.report!, /turned Team off/);
    assert.ok(run.steps.at(-1)!.sessionId);
    await manager.configureTaskTeam(run.id, config);
    const fork = await manager.startProviderChat(run.id, { agent: "codex" }); await done(fork);
    assert.equal(fork.teamTurns, undefined, "opening a context-only provider tab does not launch a team");
    await manager.configureTaskTeam(fork.id, config);
    assert.equal(run.taskTeam?.enabled, true, "configuration belongs to the task across provider tabs");
    assert.equal(groupChatTasks(manager.list()).length, 1);
    const approvalInput: import("../src/engine.js").StartRunInput = { pattern: findPattern("solo")!, repo, roles: { agent: ["claude"] }, options: {}, task: "A conversation requiring approvals", approvals: { tools: true } };
    const approvalRun = await manager.start(approvalInput); await done(approvalRun);
    await assert.rejects(manager.configureTaskTeam(approvalRun.id, { ...config, providers: ["agy"] }), /interactive approvals/);
    assert.equal(approvalRun.taskTeam, undefined, "incompatible team settings are refused before they replace configuration");
    await assert.rejects(manager.start({ ...approvalInput, taskTeam: { ...config, providers: ["agy"] } }), /interactive approvals/);
  } finally { await manager.shutdown(); }
});

test("restart during delegation preserves its execution identity and can return to Agent without launching another team", { timeout: 60000 }, async () => {
  const repo = repository(); let started = false;
  const team = { ...findPattern("auto-team")!, run: async (ctx: import("../src/engine.js").TeamContext) => {
    const wt = await ctx.worktree("integration");
    writeFileSync(join(wt.path, "recovered.txt"), "Preserved before shutdown\n"); await ctx.commit(wt, "Recovery checkpoint"); started = true;
    await new Promise<void>(resolve => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
    ctx.checkCancelled(); return "Unreachable";
  } };
  const manager = new RunManager(id => id === "auto-team" ? team : findPattern(id));
  const run = await manager.start({ pattern: findPattern("solo")!, repo, roles: { agent: ["claude"] }, options: {}, task: "A durable conversation", taskTeam: config });
  await until(() => started);
  const child = run.teamTurns![0]!.executionId;
  await manager.shutdown(); assert.equal(run.status, "interrupted");
  const restored = new RunManager(findPattern); await restored.load();
  try {
    await restored.configureTaskTeam(run.id, { ...config, enabled: false });
    const resumed = await restored.resume(run.id); await done(resumed);
    assert.equal(resumed.teamTurns!.length, 1); assert.equal(resumed.teamTurns![0]!.executionId, child);
    assert.equal(readFileSync(join(resumed.worktrees[0]!.path, "recovered.txt"), "utf8"), "Preserved before shutdown\n");
    assert.equal(resumed.teamTurns![0]!.state, "applied");
  } finally { await restored.shutdown(); }
});


test("Team availability answers conversation directly but keeps explicit work delegated", async () => {
  const { taskTeamRoute, taskTeamControl, taskTeamQuestionReply } = await import("../src/task-team.js");
  for (const request of ["Please explain the current result.", "Could you summarize it?", "Just rename this variable.", "What changed?", "What happened?", "Is this working?", "Should we keep it?", "Explain this function", "What test failed?", "Explain how to fix it", "Summarize the changes", "Thanks", "How does the browser work?"]) assert.equal(taskTeamRoute(request), "direct", request);
  for (const request of ["Implement the change", "Is it ready? Then can you fix the bug?", "Can you fix this?", "Explain it and fix the bug", "What changed? Then add a regression test.", "Ask the team to explain this", "Use a team to investigate the issue", "Change the name"]) assert.equal(taskTeamRoute(request), "team", request);
  for (const request of ["Why are you changing the API? Keep it unchanged.", "What about keeping the API unchanged?", "Can you stop changing the API?", "Just rename this variable."]) assert.equal(taskTeamRoute(request, true), "team", request);
  for (const request of ["Explain what you changed, but fix api.txt first.", "Why are you changing api.txt? Please use Codex for that file instead."]) assert.equal(taskTeamRoute(request, true), "team", request);
  for (const request of ["Stop", "Please cancel the team.", "Stop the team and wait.", "Pause", "Could you wait for now?"]) {
    assert.ok(taskTeamControl(request), request); assert.equal(taskTeamQuestionReply(request), false);
  }
  for (const request of ["Do not stop the team", "Stop changing api.txt", "Keep docs.txt unchanged"]) assert.equal(taskTeamControl(request), undefined, request);
  for (const request of ["yes", "Use the blue variant", "The port is 8123"]) assert.equal(taskTeamQuestionReply(request), true, request);
  for (const request of ["Fix api.txt", "Why are you changing the API?", "Explain the result, but keep api.txt unchanged"]) assert.equal(taskTeamQuestionReply(request), false, request);
  const manager = new RunManager(findPattern);
  try {
    const run = await manager.start({ pattern: findPattern("solo")!, repo: repository(), roles: { agent: ["claude"] }, options: {}, task: "What changed?", taskTeam: config });
    await done(run); assert.equal(run.teamTurns, undefined); assert.equal(run.taskTeam?.enabled, true);
    await manager.followUp(run.id, { kind: "reply", agent: "claude", worktree: "solo", message: "Explain this function" }); await done(run);
    assert.equal(run.teamTurns, undefined); assert.equal(run.taskTeam?.enabled, true);
  } finally { await manager.shutdown(); }
});

test("a main-chat correction stops the delegated execution, replans in the same task and never applies stale work", { timeout: 60000 }, async () => {
  let launched = 0, first: Run | undefined, firstReady = false;
  const team = { ...findPattern("auto-team")!, run: async (ctx: import("../src/engine.js").TeamContext) => {
    const wt = await ctx.worktree("integration");
    launched++;
    if (launched === 1) {
      first = ctx.run;
      writeFileSync(join(wt.path, "result.txt"), "Original plan\n"); await ctx.commit(wt, "Original partial result"); firstReady = true;
      await new Promise<void>(resolve => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
      ctx.checkCancelled();
    }
    assert.match(ctx.task, /Keep the API unchanged/);
    assert.match(ctx.task, /Latest user corrections/);
    assert.equal(readFileSync(join(wt.path, "result.txt"), "utf8"), "Original plan\n", "compatible partial work is available for revision");
    writeFileSync(join(wt.path, "result.txt"), "Corrected plan\n"); await ctx.commit(wt, "Revised result");
    return "Corrected work independently checked";
  } };
  const manager = new RunManager(id => id === "auto-team" ? team : findPattern(id));
  try {
    const run = await manager.start({ pattern: findPattern("solo")!, repo: repository(), roles: { agent: ["claude"] }, options: {}, task: "Build the result", taskTeam: config });
    await until(() => !!first && first.worktrees.length > 0);
    await until(() => firstReady);
    const note = await manager.addTeamNote(run.id, "Keep the API unchanged. Revise the implementation accordingly.");
    assert.ok(note.teamDelivery);
    await done(run);
    assert.equal(launched, 2); assert.equal(first!.status, "cancelled");
    assert.equal(run.teamTurns!.length, 1); assert.deepEqual(run.teamTurns![0]!.priorExecutions, [first!.id]);
    assert.equal(note.teamDelivery!.state, "applied");
    assert.equal(readFileSync(join(run.worktrees[0]!.path, "result.txt"), "utf8"), "Corrected plan\n");
    assert.equal(groupChatTasks(manager.list()).length, 1); assert.equal(groupChatTasks(manager.list())[0]!.chats.length, 1);
    assert.ok(!run.followUps.length, "corrections are not replayed as an unrelated later message");
  } finally { await manager.shutdown(); }
});

for (const checkCase of ["profile", "changed-files"] as const) test(`resolved changes cannot inherit a stale passing check: ${checkCase}`, { timeout: 60000 }, async () => {
  let parent: Run;
  const team = { ...findPattern("auto-team")!, run: async (ctx: import("../src/engine.js").TeamContext) => {
    const tree = await ctx.worktree("integration"); writeFileSync(join(tree.path, "result.txt"), "Team version\n"); await ctx.commit(tree, "Team result");
    writeFileSync(join(parent.worktrees[0]!.path, "result.txt"), "User version\n"); return "Team changes preserved for review.";
  } };
  const manager = new RunManager(id => id === "auto-team" ? team : findPattern(id));
  try {
    parent = await manager.start({ pattern: findPattern("solo")!, repo: repository(), roles: { agent: ["claude"] }, options: {}, task: "Remember this fixture", trust: "standard" }); await done(parent);
    await manager.configureTaskTeam(parent.id, config);
    await manager.followUp(parent.id, { kind: "reply", agent: "claude", worktree: "solo", message: "Implement the team result" }); await done(parent);
    const turn = parent.teamTurns![0]!, comparison = await manager.taskResolution(parent.id, turn.executionId) as { current: string };
    parent.loop.check = checkCase === "profile" ? "node -e \"console.log('primary passed')\"" : "node -e \"require('fs').writeFileSync('result.txt','changed during check')\"";
    if (checkCase === "profile") parent.loop.verification = { name: "Combined gates", checks: [{ id: "secondary", command: "node -e \"console.log('secondary failed');process.exit(1)\"", kind: "custom", required: true, timeoutMs: 5000 }] };
    await manager.taskResolution(parent.id, turn.executionId, { current: comparison.current, choices: [{ path: "result.txt", choice: "edited", text: "combined\n" }] });
    assert.equal(turn.state, "applied"); assert.equal(turn.resolutionCheck!.ok, false); assert.equal(parent.lastCheck!.ok, false); assert.equal(parent.verification, undefined);
    if (checkCase === "profile") { assert.match(turn.resolutionCheck!.output, /primary passed/); assert.match(turn.resolutionCheck!.output, /secondary failed/); assert.equal(readFileSync(join(parent.worktrees[0]!.path, "result.txt"), "utf8"), "combined\n"); }
    else assert.match(turn.resolutionCheck!.output, /changed during verification/);
  } finally { await manager.shutdown(); }
});
