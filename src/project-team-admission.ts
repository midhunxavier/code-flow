import type { CycleStatus, ProjectOpportunity, ProjectTeam, ProjectTeamMission, ProjectTeamRun } from "./project-team-model.js";
import { allowance } from "./project-team-budget.js";
import { sensitiveContextPath } from "./sensitive-paths.js";

// Free of Node imports: the server admits work with these rules and the mission card uses the
// same ones to explain a disabled control before the owner fills in a form.
export const PT_LIMITS = { bytes: 16 * 1024 * 1024, cycles: 100, opportunities: 200, decisions: 2000, operations: 2000, open: 12, pending: 2 };
export const ACTIVE_CYCLES: CycleStatus[] = ["requested", "discovering", "selecting", "building", "unknown"];
export const safePath = (p: string) => p === "*" || p.length <= 500 && !p.startsWith("-") && !p.includes("\\") && !p.includes(":") && !/[\x00-\x1f]/.test(p) && !p.split("/").some((part) => !part || part === "." || part === ".." || part === ".git" || part.includes("*"));
export const containsPath = (scope: string, path: string) => scope === "*" || path === scope || path.startsWith(`${scope}/`);
export function pathPermitted(scope: ProjectTeamRun["scope"], path: string) { return safePath(path) && !sensitiveContextPath(path) && scope.paths.some((p) => containsPath(p, path)) && !scope.excludedPaths.some((p) => containsPath(p, path)); }
export const CHECK_REQUIRED = "Configure a required verification check";
export function candidateProblem(c: ProjectOpportunity, mission: ProjectTeamMission): string | undefined {
  if (c.origin !== "owner" && !c.evidenceVerified) return "Evidence could not be verified at the pinned commit";
  if (!mission.categories.includes(c.category)) return "Outside allowed categories";
  if (c.risk !== "low" || c.confidence < 2 || c.alignment < 2) return "Needs an owner decision about risk, evidence or mission alignment";
  if (c.kind === "hypothesis" && c.category !== "experiment") return "Product benefit needs evidence before automatic implementation";
  if (c.paths.some((p) => !pathPermitted(mission, p))) return "Outside allowed paths";
  if (!mission.verification?.checks.some((c) => c.required)) return CHECK_REQUIRED;
}
export const activeCycle = (t: ProjectTeam) => t.cycles.find((c) => ACTIVE_CYCLES.includes(c.status));
export const pendingResults = (t: ProjectTeam) => t.opportunities.filter((o) => ["ready", "accepted", "implementing"].includes(o.status)).length;
export const openOpportunities = (t: ProjectTeam) => t.opportunities.filter((o) => !["shipped", "rejected", "expired"].includes(o.status)).length;

/** The first reason an owner task would be refused, in the order the server checks it. */
export function taskAdmissionProblem(t: ProjectTeam, now = Date.now()): string | undefined {
  if (t.status !== "active") return "Activate this mission before giving it a task";
  if (activeCycle(t)) return "Finish or stop the active cycle before giving the team a task";
  if (pendingResults(t) >= PT_LIMITS.pending || openOpportunities(t) >= PT_LIMITS.open) return "Review pending work before assigning another task";
  if (!t.mission.verification?.checks.some((c) => c.required)) return CHECK_REQUIRED;
  const available = allowance(t, now);
  if (available.calls < t.mission.budget.buildCalls || available.minutes < t.mission.budget.buildMinutes) return "Insufficient rolling weekly allowance for this entire phase";
}

/** Why Build proposal or Request revision would be refused; the base-branch check needs Git and stays on the server. */
export function buildRefusal(t: ProjectTeam, o: ProjectOpportunity): string | undefined {
  if (activeCycle(t) || t.status !== "active" || pendingResults(t) >= PT_LIMITS.pending && !o.result) return "Activate the team and finish active or pending work before building";
  const problem = candidateProblem(o, t.mission);
  // An owner task carries the owner's own authority, so it is the way to build work outside automatic policy.
  if (!problem || problem === CHECK_REQUIRED) return problem;
  return `${problem}. Update the mission to allow it${o.origin === "owner" ? "" : ", or give the team a task instead"}.`;
}
