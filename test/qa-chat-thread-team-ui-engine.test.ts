// How a stopped team run ends, with fake agents: a stop or a revised goal while the team waits for
// your answer records no internal abort text as the run's error, and a correction's replacement
// team keeps its precise remaining allowance while the UI offers whole-minute input values.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const home = mkdtempSync(join(tmpdir(), "codeflow-qa-team-stop-"));
process.env.CODEFLOW_HOME = home;
process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { validateTaskTeam } = await import("../src/task-team.js");
const { flushWrites } = await import("../src/store.js");
const { teamStatusLabel } = await import("../src/run-status.js");
const { wholeMinutes } = await import("../ui/team-state.js");
type Run = import("../src/engine.js").Run;
const repositories: string[] = [];
after(async () => { await flushWrites(); for (const repo of repositories) rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

function repository() {
  const repo = mkdtempSync(join(tmpdir(), "codeflow-qa-team-stop-repo-")); repositories.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "Empty input is valid.\n");
  mkdirSync(join(repo, ".codeflow")); writeFileSync(join(repo, ".codeflow", "config.json"), JSON.stringify({ prove: false }));
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "initial"], { cwd: repo });
  return repo;
}
async function until(ready: () => boolean, what: string, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (!ready()) { if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`); await new Promise((resolve) => setTimeout(resolve, 20)); }
}
async function waitingForAnswer(manager: InstanceType<typeof RunManager>) {
  const run = await manager.start({ pattern: findPattern("auto-team")!, repo: repository(), task: "AUTO-USER-QUESTION AUTO-SAME-PROVIDER implement the sample", roles: { coordinator: ["claude"], pool: ["claude", "codex"] }, options: {}, loop: { maxSteps: 20, maxMinutes: 30 }, approvals: { plan: false } });
  await until(() => !!run.team?.awaitingRequestId || run.status !== "running", "the team's question");
  assert.equal(run.status, "running", run.error);
  assert.equal(run.options.eventDriven, true, "the event scheduler's idle runners are waiting");
  return run;
}

test("t11-8 / t10-12: stopping a team that waits for your answer ends it as stopped, not with the scheduler's abort error", { timeout: 60_000 }, async () => {
  const manager = new RunManager(findPattern);
  try {
    const run = await waitingForAnswer(manager);
    manager.cancel(run.id);
    await until(() => run.status !== "running", "the stop");
    assert.equal(run.status, "cancelled");
    assert.equal(run.error, undefined, "a stop is how the run ended, not an error to show");
    assert.equal(teamStatusLabel(run), "Stopped");
  } finally { await manager.shutdown(); }
});

test("t11-8: revising the goal leaves the original run stopped by the revision, with no error", { timeout: 60_000 }, async () => {
  const manager = new RunManager(findPattern);
  try {
    const original = await waitingForAnswer(manager);
    const revised = await manager.reviseGoal(original.id, { message: "Change the goal: reject empty input and document it.", budget: { maxSteps: 12, maxInvocations: 12, maxMinutes: 5 } });
    assert.equal(original.status, "cancelled");
    assert.equal(original.supersededBy, revised.id);
    assert.equal(original.error, undefined);
    assert.equal(teamStatusLabel(original), "Stopped · goal revised");
    manager.cancel(revised.id);
    await until(() => revised.status !== "running", "the revised run to stop");
  } finally { await manager.shutdown(); }
});

test("t10-12: a correction keeps its remaining time without rounding away nearly a minute", { timeout: 60_000 }, async () => {
  let launched = 0, first: Run | undefined, replacement: Run | undefined;
  const team = { ...findPattern("auto-team")!, run: async (ctx: import("../src/engine.js").TeamContext) => {
    await ctx.worktree("integration");
    launched++;
    if (launched === 1) {
      first = ctx.run;
      await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
      ctx.checkCancelled();
    }
    replacement = ctx.run;
    return "Corrected work";
  } };
  const manager = new RunManager((id) => id === "auto-team" ? team : findPattern(id));
  try {
    const config = validateTaskTeam({ enabled: true, preset: "adaptive", coordinator: "claude", providers: ["codex"], settings: {}, maxMembers: 3, maxCalls: 12, maxMinutes: 30, approvePlan: false });
    const run = await manager.start({ pattern: findPattern("solo")!, repo: repository(), roles: { agent: ["claude"] }, options: {}, task: "Build the result", taskTeam: config });
    await until(() => !!first && first.worktrees.length > 0, "the first team");
    // Let part of a minute pass, so the remainder isn't whole.
    first!.createdAt -= 13_500;
    // Newer engines retain active clock usage separately from approval waits.
    (first! as Run & { clockUsedMs?: number }).clockUsedMs = 13_500;
    await manager.addTeamNote(run.id, "Keep README.md unchanged.");
    await until(() => run.status !== "running", "the corrected turn");
    assert.equal(launched, 2);
    assert.equal(first!.status, "cancelled");
    assert.equal(first!.error, undefined, "a correction's replan isn't an error of the stopped team");
    assert.ok(replacement!.loop.maxMinutes > 29.5 && replacement!.loop.maxMinutes < 29.9, `precise remaining minutes, got ${replacement!.loop.maxMinutes}`);
    assert.equal(wholeMinutes(replacement!.loop.maxMinutes), 29, "resume inputs normalize only their displayed value");
  } finally { await manager.shutdown(); }
});
