import { planProblem, type TeamPolicy } from "./patterns/auto-team-model.js";
import type { AgentId } from "./adapters/types.js";
import type { TeamPlan, TeamState, TeamTask } from "./teams.js";

export type EditableTeamTask = Pick<TeamTask, "id" | "title" | "instructions" | "owner" | "kind" | "dependsOn" | "dependencyTypes" | "requirements" | "acceptance" | "paths">;
export interface PendingTeamPlanEdit { revision: number; tasks: EditableTeamTask[]; contracts: string[]; rationale: string }
export class TeamPlanEditError extends Error {
  constructor(message: string, readonly status: 400 | 409 = 400) { super(message); }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const boundedText = (value: unknown, max: number, empty = false): value is string => typeof value === "string" && value.length <= max && !value.includes("\0") && (empty || !!value.trim());
const identifiers = /^[a-z][a-z0-9-]{0,39}$/;
const clamp = (value: unknown, fallback: number, min: number, max: number) => typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
function strings(value: unknown, count: number, maxLength: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > count || value.some((item) => !boundedText(item, maxLength))) throw new TeamPlanEditError(`${label} must contain at most ${count} bounded, nonempty strings.`);
  if (new Set(value).size !== value.length) throw new TeamPlanEditError(`${label} must not contain duplicates.`);
  return [...value];
}
export function editableTeamPlan(team: TeamState): PendingTeamPlanEdit {
  return { revision: team.revision, rationale: team.rationale, contracts: [...team.contracts], tasks: team.tasks.map(({ id, title, instructions, owner, kind, dependsOn, dependencyTypes, requirements, acceptance, paths }) => ({ id, title, instructions, owner, kind, dependsOn: [...dependsOn], ...(dependencyTypes ? { dependencyTypes: { ...dependencyTypes } } : {}), requirements: [...requirements], acceptance: [...acceptance], paths: [...paths] })) };
}
/** Reuse the original provider inventory and user-selected role/options constraints. */
export function teamPlanPolicy(team: TeamState, input: { roles: Record<string, AgentId[]>; options: Record<string, number | boolean> }): TeamPolicy {
  const coordinator = input.roles.coordinator?.[0];
  if (!coordinator || !team.inventory) throw new TeamPlanEditError("The original provider inventory is unavailable; ask the coordinator for a revised plan instead.");
  return { coordinator, pool: [...(input.roles.pool ?? [])], inventory: structuredClone(team.inventory), maxMembers: clamp(input.options.maxMembers, 4, 2, 6), maxTasks: clamp(input.options.maxTasks, 12, 1, 24), differentProviderReview: input.options.differentProviderReview === true };
}

/** Accept only user-authored plan fields, before dispatch. Runtime state and identities are pinned. */
export function validateTeamPlanEdit(value: unknown, team: TeamState, policy: TeamPolicy): TeamPlan {
  if (team.status !== "awaiting_approval" || team.tasks.some((task) => (task.status && task.status !== "pending") || (task.attempts ?? 0) > 0 || task.startedAt !== undefined || task.finishedAt !== undefined || task.head || task.artifacts?.length)) throw new TeamPlanEditError("This team has already started work. Edit a new pending plan instead.", 409);
  if (!object(value) || Object.keys(value).some((key) => !["revision", "tasks", "contracts", "rationale"].includes(key))) throw new TeamPlanEditError("Only tasks, contracts and rationale may be edited. Members and requirements stay fixed.");
  if (!Number.isSafeInteger(value.revision) || value.revision !== team.revision) throw new TeamPlanEditError("The plan changed while you were editing. Refresh the plan and merge your edits before saving.", 409);
  if (!Array.isArray(value.tasks) || value.tasks.length < 1 || value.tasks.length > policy.maxTasks) throw new TeamPlanEditError(`Keep between 1 and ${policy.maxTasks} tasks.`);
  const tasks = value.tasks.map((item, index): TeamTask => {
    if (!object(item) || Object.keys(item).some((key) => !["id", "title", "instructions", "owner", "kind", "dependsOn", "dependencyTypes", "requirements", "acceptance", "paths"].includes(key))) throw new TeamPlanEditError(`Task ${index + 1} contains unsupported or runtime fields.`);
    if (typeof item.id !== "string" || !identifiers.test(item.id) || typeof item.owner !== "string" || !identifiers.test(item.owner) || !boundedText(item.title, 180) || !boundedText(item.instructions, 16000) || !["implementation", "investigation"].includes(String(item.kind))) throw new TeamPlanEditError(`Task ${index + 1} needs a valid ID, owner, title, kind and instructions.`);
    const dependsOn = strings(item.dependsOn, policy.maxTasks, 40, `${item.id} dependencies`);
    let dependencyTypes: TeamTask["dependencyTypes"];
    if (item.dependencyTypes !== undefined) {
      if (!object(item.dependencyTypes) || Object.keys(item.dependencyTypes).length > policy.maxTasks || Object.entries(item.dependencyTypes).some(([id, kind]) => !dependsOn.includes(id) || !["completion", "artifact", "knowledge"].includes(String(kind)))) throw new TeamPlanEditError(`${item.id} contains invalid dependency types.`);
      dependencyTypes = { ...item.dependencyTypes } as NonNullable<TeamTask["dependencyTypes"]>;
    }
    return { id: item.id, title: item.title, instructions: item.instructions, owner: item.owner, kind: item.kind as TeamTask["kind"], dependsOn, ...(dependencyTypes ? { dependencyTypes } : {}), requirements: strings(item.requirements, 48, 40, `${item.id} requirements`), acceptance: strings(item.acceptance, 16, 2000, `${item.id} acceptance criteria`), paths: strings(item.paths, 64, 500, `${item.id} paths`), status: "pending", attempts: 0 };
  });
  if (!boundedText(value.rationale, 4000, true)) throw new TeamPlanEditError("Rationale must be text of at most 4,000 characters.");
  const plan: TeamPlan = { requirements: structuredClone(team.requirements), members: structuredClone(team.members), tasks, contracts: strings(value.contracts, 24, 8000, "Shared contracts"), rationale: value.rationale };
  if (team.templateUses?.length) {
    for (const original of team.tasks.filter(task => team.templateUses!.some(use => task.id.startsWith(`${use.id}-`)))) {
      const edited = tasks.find(task => task.id === original.id);
      if (!edited || edited.kind !== original.kind || !original.acceptance.every(item => edited.acceptance.includes(item)) || !original.dependsOn.every(item => edited.dependsOn.includes(item)) || !original.requirements.every(item => edited.requirements.includes(item))) throw new TeamPlanEditError("Template tasks, dependencies and required checks must be preserved. Create a new template version to change its guarantees.");
      if (edited.instructions !== original.instructions && !edited.instructions.startsWith(original.instructions + "\n")) throw new TeamPlanEditError("Template instructions can only be extended. Publish a new template version to replace them.");
      if (edited.paths.some(path => !original.paths.some(base => base === "*" || path === base || path.startsWith(base + "/")))) throw new TeamPlanEditError("Template file ownership cannot be broadened");
      if (original.dependsOn.some(id => (edited.dependencyTypes?.[id] ?? "completion") !== (original.dependencyTypes?.[id] ?? "completion"))) throw new TeamPlanEditError("Preserve template dependency types");
    }
    if (!team.contracts.every(contract => plan.contracts.includes(contract))) throw new TeamPlanEditError("Preserve template contracts");
    plan.templateUses = structuredClone(team.templateUses);
  }
  const problem = planProblem(plan, policy);
  if (problem) throw new TeamPlanEditError(problem);
  return plan;
}

export function summarizeTeamPlan(team: TeamState): string {
  return `${team.rationale}\n\nTeam:\n${team.members.map((member) => `- ${member.name} (${member.id}, ${member.role}) · ${member.provider}`).join("\n")}\n\nRequirements:\n${team.requirements.map((requirement) => `- ${requirement.id}: ${requirement.description}`).join("\n")}\n\nTasks:\n${team.tasks.map((task) => `- ${task.id}: ${task.title} → ${task.owner}; depends on ${task.dependsOn.join(", ") || "nothing"}; paths ${task.paths.join(", ") || "read only"}\n  ${task.instructions}\n  Acceptance: ${task.acceptance.join("; ")}`).join("\n")}\n\nShared contracts:\n${team.contracts.join("\n") || "None"}\n\nLimits: ${team.invocationLimit} calls; ${team.coordinationLimit} coordinator calls; ${team.maxWaves} task attempts/waves; ${team.maxRepairs} repairs.`;
}
