// QA regressions for how a run's result summarises its evidence: a pass that relies on changed
// tests, each race candidate's own check, an AI team's verification carried onto the chat that
// applied it cleanly, and the error codes of conflicts and missing files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "cf-qa-verdict-home-"));

const { checksLabel, checksSummary, executionLabel, agentReviewLabel, integrityFor, nextRunAction, TESTS_CHANGED } = await import("../ui/run-experience.js");
const { needsYou, runPassed } = await import("../src/run-status.js");
const { localDeliveryProblem } = await import("../src/result-delivery.js");
const { TeamTemplateStore, TemplateConflictError } = await import("../src/team-template-store.js");
const { readEditableFile, saveEditableFile, WorkspaceFileMissingError } = await import("../src/workspace.js");
const { roleParticipants } = await import("../src/engine.js");
type RunSummary = import("../ui/types.js").RunSummary;
type TaskTeamTurn = import("../src/task-team.js").TaskTeamTurn;

const run = (patch: Partial<RunSummary> = {}) => ({ id: "r", status: "done", loop: { check: "npm test" }, followUps: [], artifacts: [{ label: "Result", branch: "result", path: "/result", stat: "1 file changed" }], worktrees: [{ name: "build", branch: "result", path: "/result" }], ...patch }) as RunSummary;
const deleted = { kind: "deleted-test" as const, file: "failing.test.mjs", detail: "test file deleted", severity: "high" as const };

test("a pass that relies on a deleted test is not summarised as a clean pass (t07-2)", () => {
  const flagged = run({ verdict: "passed", lastCheck: { ok: true, command: "npm test", worktree: "build", at: 1 }, integrity: { result: [deleted] } });
  assert.equal(checksLabel(flagged, false, "result"), "Passed", "stats and history filters keep the check's own result");
  assert.equal(runPassed(flagged), true);
  assert.equal(checksSummary(flagged, false, "result"), TESTS_CHANGED);
  assert.equal(checksSummary(flagged), TESTS_CHANGED, "without a branch, the primary result is summarised");
  assert.deepEqual(integrityFor(flagged, "result"), [deleted]);
  assert.equal(checksSummary(run({ verdict: "passed", lastCheck: { ok: true, command: "npm test", worktree: "build", at: 1 } }), false, "result"), "Passed");
  assert.equal(checksSummary(run({ verdict: "failing", lastCheck: { ok: false, command: "npm test", worktree: "build", at: 1 }, integrity: { result: [deleted] } }), false, "result"), "Failed", "a failing check stays Failed");
  // A follow-up's own test changes count for its branch, once each.
  const followed = run({ integrity: { result: [deleted] }, followUps: [{ id: "f1", worktree: "build", integrity: [deleted, { kind: "skipped-test", file: "ok.test.mjs", detail: "test skipped", severity: "high" }] }, { id: "f2", worktree: "other", integrity: [{ kind: "weakened-test", file: "x.test.mjs", detail: "fewer assertions", severity: "medium" }] }] as RunSummary["followUps"] });
  assert.deepEqual(integrityFor(followed, "result").map(issue => issue.file), ["failing.test.mjs", "ok.test.mjs"]);
});

test("every race candidate keeps its own check; the verdict belongs to the winner, listed first (t07-5)", () => {
  const worktrees = [{ name: "candidate-a", branch: "cf/candidate-a", path: "/a" }, { name: "candidate-b", branch: "cf/candidate-b", path: "/b" }] as RunSummary["worktrees"];
  const artifact = (name: string) => ({ label: `Candidate ${name}`, branch: `cf/candidate-${name.toLowerCase()}`, path: "/x", stat: "1 file changed" });
  // Both passed; A's check finished last. The winner is B.
  const bothPass = run({ pattern: "race", verdict: "passed", worktrees, artifacts: [artifact("B"), artifact("A")], lastCheck: { ok: true, command: "true", worktree: "candidate-a", at: 2 }, branchChecks: { "cf/candidate-a": { ok: true, command: "true", at: 2 }, "cf/candidate-b": { ok: true, command: "true", at: 1 } } });
  assert.equal(checksLabel(bothPass, false, "cf/candidate-b"), "Passed", "the winner is not 'Not verified for this branch'");
  assert.equal(checksLabel(bothPass, false, "cf/candidate-a"), "Passed");
  // The losing candidate's failing check finished last; the run passed with A.
  const loserLast = run({ pattern: "race", verdict: "passed", worktrees, artifacts: [artifact("A"), artifact("B")], lastCheck: { ok: false, command: "check", worktree: "candidate-b", at: 2 }, branchChecks: { "cf/candidate-a": { ok: true, command: "check", at: 1 }, "cf/candidate-b": { ok: false, command: "check", at: 2 } } });
  assert.equal(checksLabel(loserLast, false, "cf/candidate-a"), "Passed");
  assert.equal(checksLabel(loserLast, false, "cf/candidate-b"), "Failed", "the winner's verdict never labels another branch");
  assert.match(localDeliveryProblem(loserLast, "cf/candidate-b") ?? "", /checks need attention/);
  assert.equal(localDeliveryProblem(loserLast, "cf/candidate-a"), undefined);
  assert.equal(nextRunAction(loserLast)?.branch, "cf/candidate-a", "the next action is about the winner");
  // Runs saved before per-branch checks keep the old, conservative answer.
  assert.equal(checksLabel(run({ verdict: "passed", worktrees, lastCheck: { ok: true, command: "true", worktree: "candidate-a", at: 1 } }), false, "cf/candidate-b"), "Not verified for this branch");
  // A primary result whose verdict was withheld (Loop with changed tests) is not credited from its check.
  assert.equal(checksLabel(run({ branchChecks: { result: { ok: true, command: "npm test", at: 1 } } }), false, "result"), "Not verified");
});

test("a cleanly applied team result shows the team's check and review; without that evidence nothing is borrowed (t10-7, t11-4, t06-6)", () => {
  const solo = { worktrees: [{ name: "solo", branch: "cf/chat/solo", path: "/chat" }] as RunSummary["worktrees"], artifacts: [{ label: "Workspace", branch: "cf/chat/solo", path: "/chat", stat: "1 file changed" }] };
  const turn = (patch: Partial<TaskTeamTurn>) => ({ key: "k", executionId: "child", baseline: "b", state: "applied", executionStatus: "done", ...patch }) as TaskTeamTurn;
  const verified = run({ pattern: "solo", ...solo, verdict: "passed", lastCheck: { ok: true, command: "npm test", worktree: "solo", at: 1 }, teamTurns: [turn({ teamEvidence: { tree: "t", check: { ok: true, command: "npm test", at: 1 }, review: { approved: true } } })] });
  assert.equal(checksLabel(verified, false, "cf/chat/solo"), "Passed");
  assert.equal(agentReviewLabel(verified, "cf/chat/solo"), "Approved");
  assert.equal(executionLabel(verified), "Finished");
  assert.equal(nextRunAction(verified)?.title, "Ready for your review");
  // A later refresh of the combined review, or a stale one, outranks the team's.
  assert.equal(agentReviewLabel(run({ ...verified, teamTurns: [turn({ reviewStale: true, teamEvidence: verified.teamTurns![0]!.teamEvidence })] }), "cf/chat/solo"), "Outdated");
  assert.equal(agentReviewLabel(run({ ...verified, teamTurns: [turn({ resolutionReview: { executionId: "r", checkpoint: "c", approved: false }, teamEvidence: verified.teamTurns![0]!.teamEvidence })] }), "cf/chat/solo"), "Changes requested");
  // A blocked team whose final check failed: the failure travels with the applied files.
  const failing = run({ pattern: "solo", ...solo, verdict: "failing", lastCheck: { ok: false, command: "echo nope; false", worktree: "solo", at: 1 }, teamTurns: [turn({ executionStatus: "stopped", teamEvidence: { tree: "t", check: { ok: false, command: "echo nope; false", at: 1 }, review: { approved: false } } })] });
  assert.equal(checksLabel(failing, false, "cf/chat/solo"), "Failed");
  assert.equal(agentReviewLabel(failing, "cf/chat/solo"), "Changes requested");
  assert.equal(executionLabel(failing), "Waiting for you");
  assert.match(localDeliveryProblem(failing, "cf/chat/solo") ?? "", /checks need attention/);
  // A done execution with a failing check needs you too, not only a stopped one.
  const doneFailing = run({ ...failing, teamTurns: [turn({ teamEvidence: { tree: "t", check: { ok: false, command: "false", at: 1 } } })] });
  assert.equal(executionLabel(doneFailing), "Waiting for you");
  assert.equal(needsYou({ ...doneFailing, seen: true, notes: [], watches: {} } as RunSummary), true);
  assert.match(localDeliveryProblem(run({ ...verified, teamTurns: [turn({ teamEvidence: { tree: "t", review: { approved: false } } })] }), "cf/chat/solo") ?? "", /review needs attention/);
  // Without evidence (expired, or a plain chat) nothing is borrowed.
  const plain = run({ pattern: "solo", ...solo, teamTurns: [turn({})] });
  assert.equal(checksLabel(plain, false, "cf/chat/solo"), "Not verified");
  assert.equal(agentReviewLabel(plain, "cf/chat/solo"), "Not recorded");
});

test("race and debate roles count participants the way the patterns do", () => {
  const base = { roleSettings: {}, agentSettings: {} } as Parameters<typeof roleParticipants>[0];
  assert.equal(roleParticipants({ ...base, roles: { contestants: ["codex"] } }, "contestants").length, 1);
  assert.equal(roleParticipants({ ...base, roles: { contestants: ["codex", "claude"] } }, "contestants").length, 2);
  const variants = { ...base, roles: { contestants: ["codex"] }, roleSettings: { contestants: { codex: { model: "a", variants: [{ model: "b" }] } } } } as Parameters<typeof roleParticipants>[0];
  assert.equal(roleParticipants(variants, "contestants").length, 2, "model variants of one agent are separate contestants");
  const duplicate = { ...base, roles: { contestants: ["codex"] }, roleSettings: { contestants: { codex: { model: "a", variants: [{ model: "a" }] } } } } as Parameters<typeof roleParticipants>[0];
  assert.equal(roleParticipants(duplicate, "contestants").length, 1, "a variant identical to the base is not another contestant");
});

test("a stale template version is a conflict; a malformed one is a bad request (t11-12)", async () => {
  const home = mkdtempSync(join(tmpdir(), "cf-qa-templates-"));
  const template = { schemaVersion: 1, id: "qa", version: 1, name: "QA", description: "QA", scope: "personal", autoEnabled: true, parameters: ["task"], roles: ["builder"], tasks: [{ id: "build", title: "Build", role: "builder", kind: "implementation", instructions: "Do {{task}}", dependsOn: [], paths: ["src"], acceptance: ["Done"] }], contracts: [], task: "{{task}}", criteria: [] };
  try {
    const store = new TeamTemplateStore(home);
    await store.save(template, 0);
    await assert.rejects(store.save({ ...template, version: 2 }, 0), (error: Error) => error instanceof TemplateConflictError && /reload/.test(error.message));
    await assert.rejects(store.save({ ...template, version: 3 }, 1), (error: Error) => !(error instanceof TemplateConflictError) && /version 2/.test(error.message));
    await assert.rejects(store.save({ ...template, version: 2 }, 1.5), (error: Error) => !(error instanceof TemplateConflictError));
    assert.equal((await store.save({ ...template, version: 2 }, 1)).version, 2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a missing workspace file is 'not found' without the absolute path (t08-14)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cf-qa-ws-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "hello\n"); mkdirSync(join(repo, "src"));
  execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  try {
    for (const path of ["does/not/exist.ts", "nope.txt", "README.md/x", "src/missing.ts"]) {
      await assert.rejects(readEditableFile(repo, path), (error: Error) => error instanceof WorkspaceFileMissingError && error.message === "File not found" && !error.message.includes(repo) && !/ENOENT|ENOTDIR|lstat/.test(error.message), path);
    }
    const loaded = await readEditableFile(repo, "README.md");
    rmSync(join(repo, "README.md"));
    await assert.rejects(saveEditableFile(repo, "README.md", "edited\n", loaded.hash), (error: Error) => error instanceof WorkspaceFileMissingError && /no longer exists/.test(error.message) && !error.message.includes(repo));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
