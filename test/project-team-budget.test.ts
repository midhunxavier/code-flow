import { test } from "node:test";
import assert from "node:assert/strict";
import { allowance, projectTeamUsage } from "../src/project-team-budget.js";
import type { ProjectTeam } from "../src/project-team-model.js";

test("terminal receipts charge actual usage without rewriting reservations; unresolved launches stay reserved", () => {
  const now = Date.now(), week = 7 * 86400000;
  const launch = { calls: 8, minutes: 10, at: now - 1000, state: "running" };
  const team = { mission: { budget: { weeklyCalls: 24, weeklyMinutes: 30 } }, cycles: [{ launches: [
    { ...launch, state: "settled", usage: { calls: 3, durationMs: 61000, endedAt: now } },
    { ...launch, at: now - 2 * week, state: "unknown" },
    { ...launch, at: now - 2 * week, state: "settled", usage: { calls: 3, durationMs: 60000, endedAt: now - 2 * week } },
  ] }] } as unknown as ProjectTeam;
  assert.deepEqual(projectTeamUsage(team, now), { calls: 11, minutes: 12, reservedCalls: 8, reservedMinutes: 10 });
  assert.deepEqual(allowance(team, now), { calls: 13, minutes: 18 });
  assert.equal(team.cycles[0]!.launches[0]!.minutes, 10);
  assert.equal(team.cycles[0]!.launches[0]!.calls, 8);
});
