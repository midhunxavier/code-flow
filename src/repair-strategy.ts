/** Trusted task framing; source titles, descriptions and logs remain separate evidence. */
export function issueRepairTask(reference: string): string {
  return `Fix ${reference}.\n\n` +
    "First confirm the expected behavior and reproduce the reported problem with a focused test. " +
    "Implement the smallest complete change and add a regression test that fails without it. " +
    "For a feature request, use the issue's acceptance criteria; do not invent extra scope. " +
    "If the report is ambiguous, already fixed, or cannot be reproduced, explain the evidence and the specific information needed instead of making speculative edits. " +
    "Keep existing checks and test coverage intact. Summarize the cause, fix and verification; do not close the issue or publish changes yourself.";
}

export function ciRepairTask(reference: string, dependabot = false): string {
  return `Make CI pass on ${reference}.\n\nThe failing checks and their logs are below. ` +
    "Start with the first actionable failure and the relevant workflow, dependency diff and call sites. " +
    "Distinguish a code incompatibility from a flaky test, missing credential, runner or network failure; report external blockers rather than changing unrelated code. " +
    (dependabot ? "Keep the dependency upgrade: adapt the code to the new version; don't pin it back. " : "") +
    "Use focused reproductions while iterating and keep the fix limited to this PR. Don't disable, skip or weaken tests, reduce required checks, or bundle unrelated cleanup. " +
    "Summarize the cause, fix and verification. Do not push, merge or close the PR yourself.";
}
