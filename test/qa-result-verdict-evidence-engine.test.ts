// QA regressions, engine level with the fake CLIs: each race candidate's check is kept and the
// winner is published first; an AI team's evidence reaches the chat that applied its result
// cleanly, and leaves it when the files change; busy and finished runs refuse with conflicts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "cf-qa-verdict-engine-"));
process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
process.env.CODEFLOW_RETRY_DELAYS_MS = "0";

const { RunManager, RunConflictError } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { validateTaskTeam } = await import("../src/task-team.js");
const { checksLabel } = await import("../src/run-status.js");
const { localDeliveryProblem } = await import("../src/result-delivery.js");
const { agentReviewLabel } = await import("../ui/run-experience.js");
type Run = import("../src/engine.js").Run;
type TeamContext = import("../src/engine.js").TeamContext;

const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo }).toString().trim();
function repository() { const repo = mkdtempSync(join(tmpdir(), "cf-qa-verdict-repo-")); git(repo, "init", "-q", "-b", "main"); writeFileSync(join(repo, "README.md"), "Original\n"); mkdirSync(join(repo, ".codeflow")); writeFileSync(join(repo, ".codeflow/config.json"), JSON.stringify({ prove: false })); git(repo, "add", "."); git(repo, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-qm", "base"); return repo; }
async function until(fn: () => boolean, ms = 30000) { const start = Date.now(); while (!fn()) { if (Date.now() - start > ms) throw new Error("Timed out"); await new Promise(r => setTimeout(r, 30)); } }
async function done(run: Run) { await until(() => run.status !== "running"); assert.equal(run.status, "done", run.error); }
const config = validateTaskTeam({ enabled: true, preset: "adaptive", coordinator: "claude", providers: ["codex"], settings: {}, maxMembers: 3, maxCalls: 12, maxMinutes: 5, approvePlan: false });
const race = { contestants: ["claude", "codex"], judge: ["claude"] } as Record<string, any>;

test("a race keeps each candidate's check and publishes the judge's winner first (t07-5)", { timeout: 90000 }, async () => {
  const manager = new RunManager(findPattern);
  try {
    // Both pass; the fake judge picks B.
    const judged = await manager.start({ pattern: findPattern("race")!, repo: repository(), task: "Race me", roles: race, options: {}, loop: { check: "true" } });
    await done(judged);
    const [a, b] = ["candidate-a", "candidate-b"].map(name => judged.worktrees.find(tree => tree.name === name)!.branch);
    assert.equal(judged.artifacts[0]!.branch, b, "the winner is the primary result");
    assert.equal(judged.branchChecks?.[a!]?.ok, true); assert.equal(judged.branchChecks?.[b!]?.ok, true);
    assert.equal(checksLabel(judged, false, a), "Passed"); assert.equal(checksLabel(judged, false, b), "Passed");
    assert.equal(agentReviewLabel(judged, b), "Not recorded", "the winner is not 'Not recorded for this branch'");
    // A passes, B fails and finishes last: A wins without a judge.
    const split = await manager.start({ pattern: findPattern("race")!, repo: repository(), task: "Race me again", roles: race, options: {}, loop: { check: 'case "$(git rev-parse --abbrev-ref HEAD)" in *candidate-a) exit 0;; *) sleep 1; exit 1;; esac' } });
    await done(split);
    const [winner, loser] = ["candidate-a", "candidate-b"].map(name => split.worktrees.find(tree => tree.name === name)!.branch);
    assert.equal(split.lastCheck?.worktree, "candidate-b", "the loser's check finished last");
    assert.equal(split.verdict, "passed");
    assert.equal(split.artifacts[0]!.branch, winner);
    assert.equal(split.branchChecks?.[winner!]?.ok, true); assert.equal(split.branchChecks?.[loser!]?.ok, false);
    assert.match(split.branchChecks![winner!]!.head!, /^[0-9a-f]{40}$/);
    assert.equal(checksLabel(split, false, winner), "Passed");
    assert.equal(checksLabel(split, false, loser), "Failed");
    assert.match(localDeliveryProblem(split, loser!) ?? "", /checks need attention/);
    assert.equal(localDeliveryProblem(split, winner!), undefined);
  } finally { await manager.shutdown(); }
});

test("a cleanly applied team result carries the team's check and review, and loses them when the files change (t10-7, t11-4)", { timeout: 90000 }, async () => {
  const team = { ...findPattern("auto-team")!, run: async (ctx: TeamContext) => {
    const wt = await ctx.worktree("integration");
    writeFileSync(join(wt.path, "result.txt"), "Team result\n"); await ctx.commit(wt, "Team result");
    await ctx.check(wt, "Auto team check");
    ctx.setFindings(wt, { reviewer: "codex", round: 1, verdict: "approve", findings: [], head: await ctx.head(wt), at: Date.now() });
    await ctx.artifact("Auto team result", wt);
    return "Independent review approved it, and the configured check passed.";
  } };
  const manager = new RunManager(id => id === "auto-team" ? team : findPattern(id));
  try {
    const chat = await manager.start({ pattern: findPattern("solo")!, repo: repository(), roles: { agent: ["claude"] }, options: {}, task: "Remember the task", trust: "standard" }); await done(chat);
    chat.loop.check = "test -f result.txt";
    await manager.configureTaskTeam(chat.id, config);
    await manager.followUp(chat.id, { kind: "reply", agent: "claude", worktree: "solo", message: "Implement the result" }); await done(chat);
    const turn = chat.teamTurns![0]!, branch = chat.worktrees[0]!.branch;
    assert.equal(turn.state, "applied"); assert.equal(turn.reconciliation, undefined);
    assert.deepEqual({ ...turn.teamEvidence?.check, at: 0 }, { ok: true, command: "test -f result.txt", at: 0 });
    assert.deepEqual(turn.teamEvidence?.review, { approved: true });
    assert.equal(chat.lastCheck?.worktree, "solo"); assert.equal(chat.verdict, "passed");
    assert.equal(checksLabel(chat, false, branch), "Passed");
    assert.equal(agentReviewLabel(chat, branch), "Approved");
    // A direct turn (Team off) that writes a file: the evidence no longer describes the workspace.
    await manager.configureTaskTeam(chat.id, { ...config, enabled: false });
    await manager.followUp(chat.id, { kind: "reply", agent: "claude", worktree: "solo", message: "Add a small note yourself" }); await done(chat);
    assert.equal(turn.teamEvidence, undefined);
    assert.equal(chat.lastCheck, undefined); assert.equal(chat.verdict, undefined);
    assert.equal(checksLabel(chat, false, branch), "Not verified");
    assert.equal(agentReviewLabel(chat, branch), "Not recorded");
  } finally { await manager.shutdown(); }
});

test("a side chat that changes a chat's files after a team result drops the team's review, but keeps its own check", { timeout: 90000 }, async () => {
  const team = { ...findPattern("auto-team")!, run: async (ctx: TeamContext) => {
    const wt = await ctx.worktree("integration");
    writeFileSync(join(wt.path, "result.txt"), "Team result\n"); await ctx.commit(wt, "Team result");
    await ctx.check(wt, "Auto team check");
    ctx.setFindings(wt, { reviewer: "codex", round: 1, verdict: "approve", findings: [], head: await ctx.head(wt), at: Date.now() });
    await ctx.artifact("Auto team result", wt);
    return "Independent review approved it, and the configured check passed.";
  } };
  const manager = new RunManager(id => id === "auto-team" ? team : findPattern(id));
  try {
    const chat = await manager.start({ pattern: findPattern("solo")!, repo: repository(), roles: { agent: ["claude"] }, options: {}, task: "Remember the task", trust: "standard" }); await done(chat);
    chat.loop.check = "test -f result.txt";
    await manager.configureTaskTeam(chat.id, config);
    await manager.followUp(chat.id, { kind: "reply", agent: "claude", worktree: "solo", message: "Implement the result" }); await done(chat);
    const turn = chat.teamTurns![0]!, branch = chat.worktrees[0]!.branch, teamCheck = chat.lastCheck!;
    assert.equal(agentReviewLabel(chat, branch), "Approved");
    await manager.followUp(chat.id, { kind: "side", side: { chat: "edit", mode: "change", title: "Change a file" }, worktree: "solo", agent: "codex", message: "Add a note file" }); await done(chat);
    assert.equal(chat.followUps.at(-1)!.status, "done", chat.followUps.at(-1)!.result);
    assert.equal(turn.teamEvidence, undefined, "the team's evidence no longer describes the files");
    assert.equal(agentReviewLabel(chat, branch), "Not recorded");
    assert.notEqual(chat.lastCheck?.at, teamCheck.at, "the side chat's own check is the one shown");
    assert.equal(checksLabel(chat, false, branch), chat.lastCheck?.ok ? "Passed" : "Failed");
  } finally { await manager.shutdown(); }
});

test("a blocked team's failing check is not hidden behind 'Not verified' on the chat (t06-6)", { timeout: 90000 }, async () => {
  const team = { ...findPattern("auto-team")!, run: async (ctx: TeamContext) => {
    const wt = await ctx.worktree("integration");
    writeFileSync(join(wt.path, "claude-alpha.txt"), "alpha\n"); await ctx.commit(wt, "Team result");
    const check = await ctx.check(wt, "Auto team check");
    assert.equal(check?.ok, false);
    ctx.setVerdict("failing");
    await ctx.artifact("Auto team result", wt);
    throw new Error("The configured check fails on the final result");
  } };
  const manager = new RunManager(id => id === "auto-team" ? team : findPattern(id));
  try {
    const chat = await manager.start({ pattern: findPattern("solo")!, repo: repository(), roles: { agent: ["claude"] }, options: {}, task: "Remember the task", trust: "standard" }); await done(chat);
    chat.loop.check = "echo nope; false";
    await manager.configureTaskTeam(chat.id, config);
    await manager.followUp(chat.id, { kind: "reply", agent: "claude", worktree: "solo", message: "Implement the result" }); await done(chat);
    const turn = chat.teamTurns![0]!, branch = chat.worktrees[0]!.branch;
    assert.notEqual(turn.executionStatus, "done");
    assert.equal(turn.state, "applied", "the preserved work is in the workspace");
    assert.equal(turn.teamEvidence?.check?.ok, false);
    assert.equal(chat.verdict, "failing");
    assert.equal(checksLabel(chat, false, branch), "Failed");
  } finally { await manager.shutdown(); }
});

test("resuming a finished run with nothing queued, or a busy one, is a conflict (t07-11, S15-8)", { timeout: 60000 }, async () => {
  const manager = new RunManager(findPattern);
  try {
    const run = await manager.start({ pattern: findPattern("solo")!, repo: repository(), roles: { agent: ["claude"] }, options: {}, task: "Answer briefly", trust: "standard" }); await done(run);
    manager.setSeen(run.id, true);
    const before = { seen: run.seen, endedAt: run.endedAt, resumes: run.resumes, archived: run.archived };
    assert.throws(() => manager.assertResumable(run.id), (error: Error) => error instanceof RunConflictError && /already finished/.test(error.message));
    assert.deepEqual({ seen: run.seen, endedAt: run.endedAt, resumes: run.resumes, archived: run.archived }, before, "a refused resume changes nothing");
    // A reply still continues it, through the same resume.
    await manager.followUp(run.id, { kind: "reply", agent: "claude", worktree: "solo", message: "One more thing" });
    await assert.rejects(manager.resume(run.id), (error: Error) => error instanceof RunConflictError && /already running/.test(error.message));
    await assert.rejects(manager.archive(run.id, { cleanup: false }), (error: Error) => error instanceof RunConflictError);
    await done(run);
    assert.equal(run.followUps.at(-1)!.status, "done");
  } finally { await manager.shutdown(); }
});
