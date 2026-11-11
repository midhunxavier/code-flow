/** Workflows that no longer run. Stored runs, automations, queued jobs and templates may still name them. */
const RETIRED_PATTERNS: Record<string, string> = {
  loop: "Loop until green",
  race: "Best-of-N race",
  debate: "Debate → Synthesize → Build",
  supervisor: "Supervisor → Workers",
  tdd: "Test-first (adversarial tester)",
};

/** The name a retired workflow had, for labels on what still refers to it; undefined for any other ID. */
export function retiredPatternName(id: unknown): string | undefined {
  return typeof id === "string" && Object.hasOwn(RETIRED_PATTERNS, id) ? RETIRED_PATTERNS[id] : undefined;
}

/** Why a retired workflow cannot start or continue work; undefined for any other ID. */
export function retiredPatternMessage(id: unknown): string | undefined {
  const name = retiredPatternName(id);
  return name ? `The "${name}" workflow is no longer available. Start a new run with Auto team instead.` : undefined;
}
