import type { CoordinatedChange } from "./repo-coordination.js";

/** Shared policy has no runtime dependency on the filesystem-backed coordinator. */
export const COORDINATION_LIMITS = { nodes: 10, active: 10, retained: 20, attempts: 3, history: 100, fileBytes: 32 * 1024 * 1024, previewMs: 30 * 60_000 };
export function downstreamTasks(job: Pick<CoordinatedChange, "nodes">, nodeId: string): Set<string> {
  const closure = new Set([nodeId]);
  for (let changed = true; changed;) {
    changed = false;
    for (const node of job.nodes) if (!closure.has(node.id) && node.dependsOn.some(id => closure.has(id))) { closure.add(node.id); changed = true; }
  }
  return closure;
}
/** Why a retry cannot make progress, before any results or cancellation state are changed. */
export function coordinationRetryProblem(job: Pick<CoordinatedChange, "nodes">, nodeId: string): string | undefined {
  const node = job.nodes.find(node => node.id === nodeId);
  if (!node) return "Coordinated task not found";
  if (node.attempts >= COORDINATION_LIMITS.attempts) return `This task reached its three-attempt limit (${COORDINATION_LIMITS.attempts}). Create a new coordinated change to try again.`;
  const upstream = new Set(node.dependsOn);
  for (const id of upstream) for (const dependency of job.nodes.find(item => item.id === id)?.dependsOn ?? []) upstream.add(dependency);
  const blocked = job.nodes.find(item => upstream.has(item.id) && !["verified", "shipped", "pending", "waiting", "claimed", "running"].includes(item.status));
  if (blocked) return `Retry ${blocked.id} first; ${nodeId} depends on it and it is ${blocked.status}.`;
  const closure = downstreamTasks(job, nodeId);
  const exhausted = job.nodes.find(item => item.id !== nodeId && closure.has(item.id) && item.attempts >= COORDINATION_LIMITS.attempts);
  if (exhausted) return `A dependent task reached its three-attempt limit (${COORDINATION_LIMITS.attempts}): ${exhausted.id}. Create a new coordinated change to try again.`;
  return undefined;
}
