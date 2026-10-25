import type { TeamInventory, TeamMember, TeamPlan } from "../teams.js";
import type { TeamPolicy } from "./auto-team-model.js";

const mentionsPath = (goal: string, path: string) => new RegExp(`(?<![\\w./-])${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/-])`).test(goal);

/** Ground allocation in the checkout without making the planner explore the repository. */
export function planningPaths(tracked: readonly string[], goal: string) {
  return {
    rootEntries: [...new Set(tracked.map(path => path.includes("/") ? `${path.split("/")[0]}/` : path))].sort().slice(0, 48),
    namedFiles: tracked.filter(path => mentionsPath(goal, path)).slice(0, 32),
  };
}

/** Catch an invented package prefix before a worker spends a turn editing the real file. */
export function misplacedPlanPath(plan: TeamPlan, tracked: readonly string[], goal: string): string | undefined {
  const { namedFiles } = planningPaths(tracked, goal);
  const existing = new Set(tracked);
  for (const task of plan.tasks) for (const path of task.paths) {
    if (existing.has(path) || mentionsPath(goal, path)) continue;
    const actual = namedFiles.find(file => path.endsWith(`/${file}`));
    if (actual) return `Task ${task.id} owns nonexistent ${path}, but the goal names tracked file ${actual}. Use its exact repository-relative path, without adding a package prefix.`;
  }
}

/** Prompt-only projection. Admission and validation always use the complete inventory. */
export function planningInventory(policy: TeamPolicy): TeamInventory {
  const providers = policy.inventory.providers.filter(provider =>
    provider.available && !provider.blockedReason && (provider.id === policy.coordinator || policy.pool.includes(provider.id)),
  ).map(provider => {
    const roles: TeamMember["role"][] = [
      ...(provider.id === policy.coordinator ? ["coordinator" as const] : []),
      ...(policy.pool.includes(provider.id) ? ["worker" as const, "reviewer" as const] : []),
    ];
    const choices = roles.flatMap(role => {
      const settings = provider.settingsByRole?.[role] ?? provider;
      return [settings, ...("variants" in settings ? settings.variants ?? [] : [])];
    });
    // An unpinned role may select any reported model; otherwise retain every pinned variant
    // and its aliases. Never infer a faster model or effort on the user's behalf.
    const models = provider.models?.filter(model => choices.some(choice => !choice.model ||
      choice.model === model.id || model.aliases?.includes(choice.model))).map(model => ({
        ...model,
        // Repeated probe timestamps and zero counters do not inform allocation. Retain
        // documentation/provenance and real observations used to judge model suitability.
        verifiedAt: undefined,
        observations: model.observations?.successes || model.observations?.failures ? model.observations : undefined,
      }));
    return { ...provider, models, settingsByRole: Object.fromEntries(roles.map(role => {
      const settings = provider.settingsByRole?.[role] ?? { model: provider.model, effort: provider.effort };
      // The coordinator is fixed even when the user chose provider defaults. Making the
      // empty wire values explicit avoids an extra turn to repair an invented "default".
      return [role, role === "coordinator" ? { ...settings, model: settings.model ?? "", effort: settings.effort ?? "" } : settings];
    })) };
  });
  return { ...policy.inventory, providers, ranking: policy.inventory.ranking.filter(id => providers.some(provider => provider.id === id)) };
}
