import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { git } from "./git.js";
import { digest, pathPermitted, type ProjectTeamRun } from "./project-team-model.js";
import type { TeamPlan } from "./teams.js";
import type { TeamRevision } from "./patterns/auto-team-model.js";

export function managedPlanProblem(plan: Pick<TeamPlan, "tasks">, contract?: ProjectTeamRun): string | undefined {
  if (!contract) return;
  if (contract.phase === "discovery" && plan.tasks.some((t) => t.kind !== "investigation" || t.owner === "coordinator")) return "Project discovery permits investigation tasks only";
  if (contract.phase === "implementation" && plan.tasks.some((t) => t.kind === "implementation" && t.paths.some((p) => !pathPermitted(contract.scope, p)))) return "Task ownership exceeds the saved project-team scope";
}
export const managedRevisionProblem = (revision: TeamRevision, contract?: ProjectTeamRun) => managedPlanProblem({ tasks: revision.addTasks }, contract);

/** Covers committed, staged, unstaged, untracked and both sides of renames. */
export async function assertProjectTeamChanges(at: string, run: { baseRef: string; projectTeam?: ProjectTeamRun; loop: { verification?: unknown } }) {
  const c = run.projectTeam; if (!c) return;
  if (digest(run.loop.verification ?? null) !== c.verificationHash) throw new Error("The managed verification profile changed");
  const commands = [["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", run.baseRef, "--"], ["ls-files", "--others", "--exclude-standard", "-z"], ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--numstat", run.baseRef, "--"]];
  const results = await Promise.all(commands.map((args) => git(args, at)));
  if (results.some((r) => r.code !== 0)) throw new Error("Cannot establish the managed result's changed files");
  const untracked = results[1]!.stdout.split("\0").filter(Boolean);
  const files = [...new Set([...results[0]!.stdout.split("\0"), ...untracked].filter(Boolean))];
  if (c.phase === "discovery" && files.length) throw new Error("Discovery produced source changes");
  if (files.some((p) => !pathPermitted(c.scope, p))) throw new Error(`Changes outside the project-team scope: ${files.filter((p) => !pathPermitted(c.scope, p)).join(", ")}`);
  if (files.length > c.scope.maxFiles) throw new Error("Change exceeds the saved file limit");
  let lines = 0;
  for (const line of results[2]!.stdout.split("\n").filter(Boolean)) {
    const [a, d] = line.split("\t"); if (!/^\d+$/.test(a ?? "") || !/^\d+$/.test(d ?? "")) throw new Error("Binary changes require an owner-directed task"); lines += Number(a) + Number(d);
  }
  for (const path of untracked) {
    const file = join(at, path), stat = await lstat(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Untracked file cannot be admitted within the project-team limits");
    const bytes = await readFile(file); if (bytes.includes(0)) throw new Error("Binary changes require an owner-directed task"); lines += bytes.toString().split("\n").length;
  }
  if (lines > c.scope.maxLines) throw new Error("Change exceeds the saved line limit");
}
