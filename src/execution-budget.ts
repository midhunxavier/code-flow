/** Shared defaults for new runs; saved runs keep their explicitly allocated limits. */
export const DEFAULT_EXECUTION_BUDGET = { maxSteps: 200, maxMinutes: 240 };

/** Keep most of an Auto team's allowance available for workers and independent review. */
export function coordinatorInvocationLimit(invocations: number): number {
  return Math.max(1, Math.floor(invocations / 4));
}
