import { adapters, AGENT_IDS, type AgentId } from "./adapters/index.js";

/**
 * "Auto" in a role: pick an agent for it when the run starts, steering away from plans that
 * are close to their usage limit. Claude reports how much of each window is used; any CLI
 * that hit a rate limit is "limited" until its window resets (or for an hour if unknown).
 */

export type Quota = Partial<Record<AgentId, { status: string; windows: Record<string, { utilization?: number; resetsAt?: number }>; at: number }>>;

/** Preferred order when every plan has room. */
const PREFERENCE: AgentId[] = ["claude", "codex", "agy"];
const NEARLY_FULL = 0.9;
const LIMITED_FOR_MS = 60 * 60_000;

/** Why an agent shouldn't get new work right now, or undefined if it has room. */
export function exhausted(agent: AgentId, quota: Quota, now = Date.now()): string | undefined {
  const q = quota[agent];
  if (!q) return undefined;
  const live = Object.entries(q.windows).filter(([, w]) => !w.resetsAt || w.resetsAt > now);
  if (q.status === "limited" || q.status === "rejected") {
    const resets = live.map(([, w]) => w.resetsAt).filter((t): t is number => !!t);
    if (resets.length ? Math.max(...resets) > now : now - q.at < LIMITED_FOR_MS) return "hit its usage limit";
  }
  for (const [name, w] of live) {
    if ((w.utilization ?? 0) >= NEARLY_FULL) return `is at ${Math.round((w.utilization ?? 0) * 100)}% of its ${name.replace(/_/g, "-")} limit`;
  }
  return undefined;
}

/**
 * Replace every "auto" in `roles` with a concrete agent. Within a role, auto picks differ from
 * each other and from agents already chosen there (a race needs different contestants).
 */
export function resolveAuto(
  roles: Record<string, string[]>,
  quota: Quota,
  installed: Set<AgentId>,
): { roles: Record<string, AgentId[]>; notes: string[] } {
  const notes: string[] = [];
  const out: Record<string, AgentId[]> = {};
  const candidates = PREFERENCE.filter((a) => installed.has(a));
  const roomy = candidates.filter((a) => !exhausted(a, quota));
  const skipped = candidates.filter((a) => exhausted(a, quota));
  for (const [role, list] of Object.entries(roles)) {
    const chosen = list.filter((a): a is AgentId => (AGENT_IDS as readonly string[]).includes(a));
    for (const value of list) {
      if (value !== "auto") continue;
      const pick = roomy.find((a) => !chosen.includes(a)) ?? candidates.find((a) => !chosen.includes(a));
      if (!pick) continue; // nobody left; the role's own validation reports it
      chosen.push(pick);
      const why = skipped.length && skipped[0] !== pick ? ` (${adapters[skipped[0]!].displayName} ${exhausted(skipped[0]!, quota)})` : "";
      notes.push(`Auto picked ${adapters[pick].displayName} for ${role}${why}`);
    }
    out[role] = [...new Set(chosen)];
  }
  return { roles: out, notes };
}
