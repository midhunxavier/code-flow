import type { TaskTeamConfig } from "../src/task-team.js";
import type { TeamTemplate } from "../src/team-templates.js";

export const TEAM_APPROVAL_PROBLEM = "Antigravity does not support Ask for approval. Choose Claude or Codex, or change permissions before enabling Antigravity.";
export function teamApprovalProblem(config: TaskTeamConfig | undefined, approvals: boolean): string {
  return config?.enabled && approvals && (config.coordinator === "agy" || config.providers.includes("agy")) ? TEAM_APPROVAL_PROBLEM : "";
}

/** A chat team stores one model/effort pair per provider. Preserve independent fields across roles. */
export function templateTeamSettings(current: TaskTeamConfig["settings"], preferences: TeamTemplate["preferences"]) {
  const settings = structuredClone(current), conflicts = new Set<string>();
  for (const layer of [preferences?.agentSettings, preferences?.roleSettings.pool, preferences?.roleSettings.coordinator]) {
    for (const [provider, value] of Object.entries(layer ?? {})) {
      const id = provider as keyof typeof settings;
      for (const field of ["model", "effort"] as const) {
        if (value[field] === undefined) continue;
        if (settings[id]?.[field] !== undefined && settings[id]?.[field] !== value[field]) conflicts.add(`${provider} ${field}`);
        settings[id] = { ...settings[id], [field]: value[field] };
      }
    }
  }
  return { settings, conflicts: [...conflicts] };
}

export type ConflictVersion = { exists: boolean; binary?: boolean; text: string; mode?: string; object?: string };
export type ConflictFile = { path: string; base: ConflictVersion; current: ConflictVersion; team: ConflictVersion };
export type ConflictChoices = Record<string, { choice: "current" | "team" | "edited"; text?: string }>;
export function carryConflictChoices(before: ConflictFile[], choices: ConflictChoices, after: ConflictFile[]) {
  const kept: ConflictChoices = {}, cleared: string[] = [];
  for (const [path, choice] of Object.entries(choices)) {
    const previous = before.find(file => file.path === path), next = after.find(file => file.path === path);
    const unchanged = previous && next && (["base", "current", "team"] as const).every(key => {
      const a = previous[key], b = next[key];
      return a.exists === b.exists && !!a.binary === !!b.binary && a.mode === b.mode && a.object === b.object && a.text === b.text;
    });
    if (unchanged) kept[path] = choice; else cleared.push(path);
  }
  return { choices: kept, cleared };
}
