/** Applies to code-flow's explicit invocation input, not the provider's hidden conversation. */
export interface ContextBudget { maxPromptBytes?: number; maxApproximateTokens?: number; policy: "warn" | "block" }
export function validateContextBudget(value: unknown): ContextBudget | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Context budget must be an object.");
  const budget = value as Record<string, unknown>;
  if (Object.keys(budget).some((key) => !["maxPromptBytes", "maxApproximateTokens", "policy"].includes(key))) throw new Error("Unknown context budget field.");
  const integer = (number: unknown, max: number) => Number.isSafeInteger(number) && Number(number) >= 1 && Number(number) <= max;
  if (budget.maxPromptBytes !== undefined && !integer(budget.maxPromptBytes, 64 * 1024 * 1024) || budget.maxApproximateTokens !== undefined && !integer(budget.maxApproximateTokens, 16 * 1024 * 1024)) throw new Error("Context ceilings must be positive bounded integers.");
  if (budget.maxPromptBytes === undefined && budget.maxApproximateTokens === undefined) throw new Error("Choose at least one context ceiling.");
  if (budget.policy !== undefined && budget.policy !== "warn" && budget.policy !== "block") throw new Error("Context budget policy must be warn or block.");
  return { ...(budget.maxPromptBytes !== undefined ? { maxPromptBytes: budget.maxPromptBytes as number } : {}), ...(budget.maxApproximateTokens !== undefined ? { maxApproximateTokens: budget.maxApproximateTokens as number } : {}), policy: budget.policy as ContextBudget["policy"] ?? "warn" };
}
