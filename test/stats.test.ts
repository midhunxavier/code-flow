import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStats, confidenceInterval, rankAgents } from "../src/stats.js";
import type { RunSummary } from "../src/engine.js";

function run(writers: string[], passed = true, pattern = "pipeline"): RunSummary {
  return { repo: "/repo", pattern, status: "done", verdict: passed ? "passed" : "failing", createdAt: 1, endedAt: 2, roles: {}, artifacts: [],
    usage: { agentSteps: writers.length, checks: 1, byAgent: Object.fromEntries(writers.map((id) => [id, { steps: 1, failures: 0, writeSteps: 1, ms: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, costUsd: 0 }])) },
  } as unknown as RunSummary;
}

test("shared successful outcomes are visible but never credited to individual provider routing", () => {
  const shared = Array.from({ length: 10 }, () => run(["codex", "claude"]));
  const stats = computeStats(shared);
  assert.equal(stats.agents[0]!.judged, 10);
  assert.equal(stats.agents[0]!.sharedJudged, 10);
  assert.equal(stats.agents[0]!.attributedJudged, 0);
  assert.deepEqual(stats.agents[0]!.confidence, { low: 0, high: 1, samples: 0 });
  assert.deepEqual(rankAgents(shared, "/repo").order, []);
  const history = [...shared, ...Array.from({ length: 4 }, () => run(["codex"])), ...Array.from({ length: 4 }, () => run(["claude"], false))];
  const rank = rankAgents(history, "/repo");
  assert.deepEqual(rank.order, ["codex", "claude"]);
  assert.match(rank.why.codex!, /4 of 4.*sole writer.*95%.*10 shared outcomes excluded/);
});

test("provider comparisons can be limited to a task cohort and confidence reflects sample size", () => {
  const history = [...Array.from({ length: 4 }, () => run(["codex"])), ...Array.from({ length: 4 }, () => run(["claude"], false)), ...Array.from({ length: 4 }, () => run(["claude"], true, "race"))];
  assert.deepEqual(rankAgents(history, "/repo", { pattern: "race" }).order, [], "both providers need comparable evidence");
  assert.deepEqual(rankAgents(history, "/repo", { pattern: "pipeline" }).order, ["codex", "claude"]);
  const stats = computeStats(history);
  assert.equal(stats.cohorts.length, 2);
  assert.equal(stats.cohorts[0]!.runs, 8);
  assert.equal(stats.cohorts[0]!.passed, 4);
  assert.ok(confidenceInterval(40, 40).low > confidenceInterval(4, 4).low);
  assert.deepEqual(confidenceInterval(0, 0), { low: 0, high: 1 });
});
