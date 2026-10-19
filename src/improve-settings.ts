import type { ModelCatalog } from "./adapters/types.js";

export const IMPROVE_AGENTS = ["claude", "codex", "agy"] as const;
export type ImproveAgent = typeof IMPROVE_AGENTS[number];
export type ImproveMode = "quick" | "repo";
export type ImproveChoice = { model?: string; effort?: string };
export type ImproveSettings = {
  agent: "auto" | ImproveAgent;
  defaultMode: ImproveMode;
  providers: Partial<Record<ImproveAgent, Partial<Record<ImproveMode, ImproveChoice>>>>;
};
export const IMPROVE_NAMES = { auto: "Auto", claude: "Claude Code", codex: "Codex", agy: "Antigravity" };
export function defaultImproveChoice(agent: ImproveAgent, mode: ImproveMode): ImproveChoice {
  return agent === "claude" ? { model: mode === "quick" ? "haiku" : "sonnet", effort: mode === "quick" ? undefined : "low" } : { effort: "low" };
}
export function improveEfforts(agent: ImproveAgent, model: string | undefined, catalog?: ModelCatalog): string[] {
  if (agent === "claude" && /haiku/i.test(model ?? "")) return [];
  return catalog?.models.find(item => item.id === (model || catalog.defaultModel))?.efforts ?? catalog?.efforts ?? [];
}
/** Strict at the API boundary; local preferences recover to defaults if storage is corrupt. */
export function parseImproveSettings(value: unknown): ImproveSettings {
  const input = value as Partial<ImproveSettings> | undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid prompt improvement settings");
  if (input.agent !== "auto" && !IMPROVE_AGENTS.includes(input.agent as ImproveAgent)) throw new Error("Choose Auto, Claude Code, Codex or Antigravity for prompt improvement");
  if (input.defaultMode !== "quick" && input.defaultMode !== "repo") throw new Error("Choose Quick or Repo as the default improvement mode");
  const providers: ImproveSettings["providers"] = {};
  if (input.providers !== undefined && (!input.providers || typeof input.providers !== "object" || Array.isArray(input.providers))) throw new Error("Invalid prompt improvement provider settings");
  for (const agent of IMPROVE_AGENTS) for (const mode of ["quick", "repo"] as const) {
    const choice = input.providers?.[agent]?.[mode];
    if (choice === undefined) continue;
    if (!choice || typeof choice !== "object" || Array.isArray(choice)) throw new Error("Invalid prompt improvement model settings");
    const clean: ImproveChoice = {};
    for (const key of ["model", "effort"] as const) {
      const val = choice[key];
      if (val === undefined) continue;
      if (typeof val !== "string" || val.length > 200 || /[\x00-\x1f\x7f]/.test(val)) throw new Error(`Invalid prompt improvement ${key}`);
      clean[key] = val.trim();
    }
    (providers[agent] ??= {})[mode] = clean;
  }
  return { agent: input.agent!, defaultMode: input.defaultMode, providers };
}
