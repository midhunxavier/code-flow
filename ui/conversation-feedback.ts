import type { Health } from "./state.js";
import type { AgentId, RunSummary, Step } from "./types.js";

/** Prepared requests can be clicked repeatedly without duplicating the user's draft. */
export function appendDraftText(current: string, additions: string[]): string {
  let result = current;
  for (const addition of additions) {
    const text = addition.trim();
    if (text && !result.includes(text)) result = [result.trimEnd(), text].filter(Boolean).join("\n\n");
  }
  return result;
}

/** Old stored turns may contain the provider's error as their purported answer. */
export function conversationAnswer(text: string | undefined, error: string | undefined): string | undefined {
  const answer = text?.trim();
  return answer && error && (error.trim() === answer || error.trim().endsWith(`(${answer})`)) ? undefined : text;
}

export function recoveryMessage(run: Pick<RunSummary, "error" | "stopReason">, steps: Step[]): string {
  const message = run.error ?? run.stopReason;
  const shown = steps.filter(step => (step.kind ?? "agent") === "agent" && !step.sideOf).at(-1)?.error;
  return message && message !== shown ? message : "Work is saved. Resume when you're ready.";
}

/** This machine's diagnostics cannot describe a worker or container's credentials. */
export function replySignInIssue(run: Pick<RunSummary, "loop">, agent: AgentId | undefined, diagnostics: readonly Health[] | null): Health | undefined {
  if (!agent || run.loop.remoteWorker || run.loop.agentContainer) return;
  return diagnostics?.find(item => item.id === agent && item.installed && item.signedIn === false);
}
