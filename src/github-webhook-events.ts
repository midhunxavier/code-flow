/** Browser-safe source of truth for GitHub actions that may start automation work. */
export const GITHUB_RUN_EVENTS: Record<string, readonly string[]> = {
  issues: ["opened"],
  pull_request: ["opened", "synchronize"],
  workflow_run: ["completed"],
  dependabot_alert: ["created", "reopened", "reintroduced"],
  code_scanning_alert: ["created", "reopened", "appeared_in_branch"],
};
export const GITHUB_SWEEP_EVENTS: Record<string, readonly string[]> = {
  ...GITHUB_RUN_EVENTS,
  issues: ["opened", "labeled", "reopened"],
  pull_request: ["opened", "synchronize", "reopened", "ready_for_review", "labeled"],
};
export function acceptsGithubAction(event: string, action: unknown, sweep = false): boolean {
  const events = sweep ? GITHUB_SWEEP_EVENTS : GITHUB_RUN_EVENTS;
  return typeof action === "string" && Object.hasOwn(events, event) && events[event]!.includes(action);
}
export function describeGithubRunEvents(sweep = false): string {
  const events = sweep ? GITHUB_SWEEP_EVENTS : GITHUB_RUN_EVENTS;
  return Object.entries(events).map(([event, actions]) => `${event}: ${actions.join(", ")}${event === "workflow_run" ? " (failure only, with a pull request; includes failure logs)" : ""}`).join("; ") + ". Other events are ignored.";
}
