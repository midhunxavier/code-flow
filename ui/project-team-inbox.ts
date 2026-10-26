import type { ProjectTeam } from "../src/project-team-model.js";

/** Statuses that need the owner, each with how the compact inbox names it. One list, so the card and its counts agree. */
const ACTIONABLE = [["ready", "verified draft", "verified drafts"], ["proposed", "proposal", "proposals"], ["blocked", "needs attention", "need attention"]] as const;
const relaunch = (team: ProjectTeam) => team.cycles.at(-1)?.status === "unknown";

export const projectTeamNeedsOwner = (team: ProjectTeam) => team.status !== "archived" && (team.opportunities.some((o) => ACTIONABLE.some(([status]) => status === o.status)) || relaunch(team));

/** "1 verified draft · 2 need attention"; statuses with nothing waiting are left out. */
export function projectTeamInboxSummary(team: ProjectTeam): string {
  const parts = ACTIONABLE.flatMap(([status, one, many]) => { const n = team.opportunities.filter((o) => o.status === status).length; return n ? [`${n} ${n === 1 ? one : many}`] : []; });
  if (relaunch(team)) parts.push(parts.length ? "launch needs reconciliation" : "Launch needs reconciliation");
  return parts.join(" · ");
}
