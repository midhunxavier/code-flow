import type { ChatEvent } from "../src/conversational/chat-model.js";
import type { TaskSnapshot } from "../src/conversational/service.js";

/** An old result always reads its recorded run and artifact hashes, never a newer execution. */
export function chatResultExecution(event: ChatEvent, current?: TaskSnapshot["execution"]) {
  if (!event.runId) return undefined;
  const artifacts = event.evidence?.length ? event.evidence : event.artifact ? [event.artifact] : current?.id === event.runId ? current.artifacts : undefined;
  return artifacts ? { id: event.runId, artifacts } : undefined;
}
