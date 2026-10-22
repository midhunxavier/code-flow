import type { ProjectTeam } from "./project-team-model.js";

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
