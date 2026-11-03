import type { Candidate, Definition } from "./model.js";

/** Keep only public editable participant fields; omit absent settings on in-process calls too. */
export function editableCandidate(definition: Definition): Candidate {
  const { attemptTimeoutMs: _, ...limits } = definition.limits;
  return JSON.parse(JSON.stringify({ ...definition, limits, participants: definition.participants.map(({ id, provider, model, effort, binding }) => ({ id, provider, model, effort, binding })) }));
}
