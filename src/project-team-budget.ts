import type { ProjectTeam, ProjectTeamMission } from "./project-team-model.js";

/** One table for the mission validator and the editor's inputs, so the form never offers a value the server refuses. */
export const PROJECT_TEAM_BUDGET_RANGES = {
  discoveryCalls: { min: 8, max: 40, default: 8, label: "discovery calls" },
  discoveryMinutes: { min: 1, max: 60, default: 15, label: "discovery minutes" },
  buildCalls: { min: 4, max: 80, default: 16, label: "build calls" },
  buildMinutes: { min: 1, max: 120, default: 45, label: "build minutes" },
  weeklyCalls: { min: 4, max: 500, default: 48, label: "weekly calls" },
  weeklyMinutes: { min: 1, max: 1440, default: 120, label: "weekly minutes" },
} as const satisfies Record<keyof ProjectTeamMission["budget"], { min: number; max: number; default: number; label: string }>;
export const defaultProjectTeamBudget = (): ProjectTeamMission["budget"] => Object.fromEntries(Object.entries(PROJECT_TEAM_BUDGET_RANGES).map(([field, range]) => [field, range.default])) as ProjectTeamMission["budget"];

/** Unknown launches retain their full allocation until an exact terminal receipt exists. */
export function projectTeamUsage(team: ProjectTeam, now = Date.now()) {
  const week = 7 * 24 * 60 * 60_000;
  return team.cycles.flatMap(c => c.launches).reduce((total, launch) => {
    const usage = launch.usage;
    if (usage ? usage.endedAt <= now - week : launch.state === "settled" && launch.at <= now - week) return total;
    total.calls += usage?.calls ?? (launch.state === "settled" ? launch.usedCalls ?? launch.calls : launch.calls);
    total.minutes += usage ? Math.ceil(usage.durationMs / 60_000) : launch.minutes;
    if (!usage) { total.reservedCalls += launch.calls; total.reservedMinutes += launch.minutes; }
    return total;
  }, { calls: 0, minutes: 0, reservedCalls: 0, reservedMinutes: 0 });
}

export function allowance(team: ProjectTeam, now = Date.now()) {
  const used = projectTeamUsage(team, now);
  return { calls: team.mission.budget.weeklyCalls - used.calls, minutes: team.mission.budget.weeklyMinutes - used.minutes };
}
