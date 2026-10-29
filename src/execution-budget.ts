/** Shared defaults for new runs; saved runs keep their explicitly allocated limits. */
export const DEFAULT_EXECUTION_BUDGET = { maxSteps: 500, maxMinutes: 720 };

/** Admission ceiling for a single allocation, shared by every entry point. */
export const MAX_EXECUTION_BUDGET = { maxSteps: 1000, maxMinutes: 1440 };

export const EXECUTION_BUDGET_PRESETS = [
  { id: "standard", label: "Standard", maxSteps: 200, maxMinutes: 240 },
  { id: "extended", label: "Extended", ...DEFAULT_EXECUTION_BUDGET },
  { id: "long", label: "Long", ...MAX_EXECUTION_BUDGET },
] as const;

export function budgetDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60), remaining = minutes % 60;
  if (!hours) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  return `${hours} ${hours === 1 ? "hour" : "hours"}${remaining ? ` ${remaining} min` : ""}`;
}

/** Allow coordination and retries to use half the budget, reserving the rest for workers and review. */
export function coordinatorInvocationLimit(invocations: number): number {
  return Math.max(1, Math.floor(invocations / 2));
}
