import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunSummary } from "../src/engine.js";
import { checksLabel, runPassed, runState, matchesHistoryFilter, needsYou } from "../src/run-status.js";
import { projectReport } from "../src/project-report.js";
import { compareRuns } from "../src/run-history.js";
import { computeStats } from "../src/stats.js";
const run = (patch: Partial<RunSummary> = {}) => ({ id: "run", task: "task", createdAt: 100, status: "done", seen: true, repo: "/repo", pattern: "solo", roles: { worker: ["codex"] }, loop: { check: "test" }, worktrees: [], artifacts: [], usage: { agentSteps: 0, checks: 0 }, ...patch }) as RunSummary;

test("passing filters and reports require passing evidence, not just completion", () => {
  for (const item of [run(), run({ status: "running", verdict: "passed" }), run({ verdict: "passed", checkCantRun: { command: "test", reason: "unavailable" } }), run({ verdict: "passed", verification: { state: "unchecked" } as RunSummary["verification"] })]) {
    assert.equal(runPassed(item), false);
    assert.equal(matchesHistoryFilter(item, { status: "passed" }), false);
    assert.notEqual(runState(item), "done");
  }
  const passed = run({ verification: { state: "verified" } as RunSummary["verification"] });
  assert.equal(checksLabel(passed), "Passed");
  assert.equal(runState(passed), "done");
  assert.equal(matchesHistoryFilter(passed, { status: "passed" }), true);
  assert.equal(matchesHistoryFilter(passed, { agent: "claude" }), false);
  assert.equal(matchesHistoryFilter(passed, { repo: "/another" }), false);
  const failed = run({ verification: { state: "needs-changes" } as RunSummary["verification"] });
  assert.equal(matchesHistoryFilter(failed, { status: "failing" }), true);
  const stats = computeStats([run(), passed, failed, run({ verdict: "passed", checkCantRun: { command: "test", reason: "blocked" } })]);
  assert.equal(stats.patterns[0]!.passed, 1);
  assert.equal(stats.patterns[0]!.failing, 1);
  assert.equal(stats.cohorts[0]!.judged, 2);
});

test("attention and project sections share the same decisions", () => {
  const question = run({ status: "running", team: { awaitingRequestId: "q" } as RunSummary["team"] });
  assert.equal(needsYou(question), true);
  assert.equal(matchesHistoryFilter(question, { section: "running" }), false);
  assert.equal(matchesHistoryFilter(question, { section: "waiting" }), true);
  assert.equal(needsYou(run({ seen: false, archived: true })), false);
  assert.equal(needsYou(run({ seen: false, projectTeam: {} as RunSummary["projectTeam"] })), false);
  assert.equal(needsYou(run({ triage: { state: "pending" } as RunSummary["triage"] })), true);
});

test("project totals cover all authorized history while detail lists stay bounded", () => {
  const all = Array.from({ length: 250 }, (_, index) => run({ id: String(index), createdAt: index, verdict: index === 0 ? "passed" : undefined, archived: index === 1, usage: { agentSteps: 0, checks: 0, costUsd: 2 } })).sort(compareRuns);
  const report = projectReport(all, 1000);
  assert.deepEqual(report.week, { runs: 250, passed: 1, costUsd: 500 });
  assert.equal(report.live, 249); assert.equal(report.archived, 1);
  assert.equal(report.sections.results.total, 249);
  assert.equal(report.sections.results.runs.length, 8);
  assert.ok(report.sections.results.nextCursor);
  assert.equal(projectReport(all.filter(item => item.id !== "0"), 1000).week.passed, 0);
  assert.equal(projectReport(all, 8 * 86_400_000).week.runs, 0);
});
