/** Pure admission rules shared by forms and the API. Never silently change a requested budget. */
export type NumberRule = { label: string; min: number; max: number; integer?: boolean };
export const EXECUTION_LIMITS = {
  maxMinutes: { label: "Minutes", min: 1, max: 720, integer: true },
  maxSteps: { label: "Agent steps", min: 1, max: 200, integer: true },
  maxInvocations: { label: "Agent calls", min: 1, max: 200, integer: true },
  maxTokens: { label: "Token budget", min: 1, max: 1_000_000_000, integer: true },
  maxCostUsd: { label: "Cost budget", min: 0.001, max: 1_000_000 },
  checkTimeoutMin: { label: "Check timeout", min: 1, max: 120, integer: true },
} satisfies Record<string, NumberRule>;
export const TASK_TEAM_LIMITS = {
  maxMembers: { label: "Members", min: 3, max: 6, integer: true },
  maxCalls: { label: "Agent calls", min: 4, max: 200, integer: true },
  maxMinutes: { label: "Minutes", min: 1, max: 720, integer: true },
} satisfies Record<string, NumberRule>;
export function numberProblem(value: unknown, rule: NumberRule): string {
  return typeof value !== "number" || !Number.isFinite(value) || value < rule.min || value > rule.max || rule.integer && !Number.isInteger(value)
    ? `${rule.label} must be ${rule.integer ? "a whole number " : ""}between ${rule.min} and ${rule.max}` : "";
}
export function executionLimitsProblem(limits: Record<string, unknown>): string {
  for (const [key, rule] of Object.entries(EXECUTION_LIMITS)) if (limits[key] !== undefined) { const problem = numberProblem(limits[key], rule); if (problem) return problem; }
  return "";
}
export function taskTeamLimitsProblem(limits: Record<string, unknown>): string {
  for (const [key, rule] of Object.entries(TASK_TEAM_LIMITS)) { const problem = numberProblem(limits[key], rule); if (problem) return problem; }
  return "";
}
export function acceptanceCriteriaProblem(criteria: string[]): string {
  if (criteria.length > 100) return "Use at most 100 acceptance criteria. Your text has been kept; shorten it before starting.";
  if (criteria.some(value => value.length > 2000)) return "Each acceptance criterion can contain at most 2000 characters. Your text has been kept; shorten it before starting.";
  return "";
}
export const MAX_COMPARE_RUNS = 9;
export const MAX_COMPARE_REPEAT = 3;
