/** Shared defaults for new runs; saved runs keep their explicitly allocated limits. */
export const DEFAULT_EXECUTION_BUDGET = { maxSteps: 200, maxMinutes: 240 };

/** Allow coordination and retries to use half the budget, reserving the rest for workers and review. */
export function coordinatorInvocationLimit(invocations: number): number {
  return Math.max(1, Math.floor(invocations / 2));
}
