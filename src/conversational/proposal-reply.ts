/** Only an unqualified confirmation can accept a displayed proposal. Changes go to the lead. */
export function approvesProposal(message: string, scope?: string): boolean {
  const requested = message.match(/\bstart (planning|implementation|review)\b/i)?.[1]?.toLowerCase();
  if (scope && requested && ({ planning: "plan", implementation: "write", review: "review" }[requested] !== scope)) return false;
  return /^(?:(?:yes|ok|okay)[, ]+)?(?:go ahead|proceed|approved?|start(?: (?:planning|implementation|review|the (?:task|plan|team)))?)(?: please)?[.!]*$/i.test(message.trim());
}
