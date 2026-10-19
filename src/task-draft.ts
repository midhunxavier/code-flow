/** The editable result of a planning turn. No ownership, permissions or executable settings come from the agent. */
export interface TaskDraft { title: string; goal: string; acceptance: string }
export const TASK_DRAFT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["title", "goal", "acceptance"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    goal: { type: "string", minLength: 1, maxLength: 16384 },
    acceptance: { type: "string", minLength: 1, maxLength: 8192 },
  },
};
export function taskDraftProblem(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Expected a task draft object";
  const draft = value as Record<string, unknown>;
  if (Object.keys(draft).some((key) => !["title", "goal", "acceptance"].includes(key))) return "Unexpected task draft field";
  for (const [key, limit] of [["title", 200], ["goal", 16384], ["acceptance", 8192]] as const) {
    const text = draft[key];
    if (typeof text !== "string" || !text.trim() || text.length > limit || text.includes("\0")) return `Draft ${key} must contain 1–${limit} characters`;
  }
}
