export type CheckMode = "conversation" | "team" | "managed";
/** Follow the engine's execution contract without changing saved verification choices. */
export function composerCheckMode(pattern: string | undefined, options: { checkpointOnFinish?: boolean; remote?: boolean; team?: boolean; container?: boolean } = {}): CheckMode {
  if (pattern !== "solo" || options.checkpointOnFinish || options.remote) return "managed";
  return options.team && !options.container ? "team" : "conversation";
}
export function checkExplanation(mode: CheckMode, command = ""): string {
  const check = command.trim() ? `“${command.trim()}”` : "the configured check";
  if (mode === "conversation") return `Agent conversations do not run checks automatically. Ask the agent to run ${check}; it is also used for merge validation.`;
  if (mode === "team") return `The AI team runs ${check} when it verifies completed work. Ordinary Agent replies do not run checks automatically.`;
  return `Code Flow runs ${check} when the workflow verifies completed work.`;
}
