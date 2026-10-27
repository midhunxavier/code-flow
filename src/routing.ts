import { quotaReason } from "./quota-status.js";
import { getAdapter, adapters, AGENT_IDS, type AgentId } from "./adapters/index.js";

/**
 * "Auto" in a role: pick an agent for it when the run starts, steering away from plans that
 * are close to their usage limit. Claude reports how much of each window is used; any CLI
 * that hit a rate limit is "limited" until its window resets (or for an hour if unknown), and
 * one that failed for being signed out ("signed_out") is passed over for 15 minutes.
 * Among agents with room, the one whose code has passed most often in this repo goes first
 * once there's enough history (see rankAgents); otherwise a fixed preference order.
 */

export type Quota = Partial<Record<AgentId, { status: string; windows: Record<string, { utilization?: number; resetsAt?: number }>; at: number }>>;

/** Preferred order when every plan has room. */
const PREFERENCE: AgentId[] = ["claude", "codex", "agy"];
/** Why an agent should not receive Auto work right now. */
export function exhausted(agent: AgentId, quota: Quota, now = Date.now()): string | undefined {
  return quotaReason(quota[agent], now);
}

/**
 * Replace every "auto" in `roles` with a concrete agent. Within a role, auto picks differ from
 * each other and from agents already chosen there (a race needs different contestants).
 * `independence` names the roles that weigh others' work, and whose (strongest first, see
 * RoleSpec.independentOf): Auto fills such a role from a vendor that didn't do that work, and a
 * role whose work is weighed steers clear of a checker you picked yourself, when another
 * vendor has room. Only then does it settle for the same vendor (the pattern warns).
 */
export function resolveAuto(
  roles: Record<string, string[]>,
  quota: Quota,
  installed: Set<AgentId>,
  rank: { order: AgentId[]; why: Record<string, string> } = { order: [], why: {} },
  independence: Record<string, string[]> = {},
): { roles: Record<string, AgentId[]>; notes: string[] } {
  const notes: string[] = [];
  const out: Record<string, AgentId[]> = {};
  const order = [...new Set([...rank.order, ...PREFERENCE, ...AGENT_IDS])];
  const candidates = order.filter((a) => installed.has(a));
  const roomy = candidates.filter((a) => !exhausted(a, quota));
  const skipped = candidates.filter((a) => exhausted(a, quota));
  const isAgent = (a: string): a is AgentId => (AGENT_IDS as readonly string[]).includes(a);
  const explicit = (role: string) => (roles[role] ?? []).filter(isAgent);
  const filled = (role: string) => out[role] ?? explicit(role);
  /** Whose agents a role's Auto picks avoid, in the order to try: all the work it weighs, then the strongest. */
  const steer = (role: string): { roles: string[]; agents: AgentId[]; yours?: boolean }[] => {
    const weighs = independence[role];
    if (weighs?.length) return [{ roles: weighs, agents: weighs.flatMap(filled) }, { roles: weighs.slice(0, 1), agents: filled(weighs[0]!) }];
    const checkers = Object.keys(roles).filter((checker) => independence[checker]?.[0] === role);
    return [{ roles: checkers, agents: checkers.flatMap(explicit), yours: true }];
  };
  // Roles that weigh others' work go last, so they know who did that work.
  for (const role of Object.keys(roles).sort((a, b) => Number(!!independence[a]?.length) - Number(!!independence[b]?.length))) {
    const list = roles[role]!;
    const chosen = list.filter(isAgent);
    const avoid = steer(role).filter((group) => group.agents.length);
    for (const value of list) {
      if (value !== "auto") continue;
      const free = (a: AgentId) => !chosen.includes(a);
      const first = roomy.find(free);
      let pick: AgentId | undefined;
      let avoided: (typeof avoid)[number] | undefined;
      for (const group of avoid) {
        pick = roomy.find((a) => free(a) && !group.agents.includes(a));
        if (pick) { if (first && group.agents.includes(first)) avoided = group; break; }
      }
      pick ??= first ?? candidates.find(free);
      if (!pick) continue; // nobody left; the role's own validation reports it
      const reasons: string[] = [];
      const pickedFull = exhausted(pick, quota);
      // Everyone is out of room: say so rather than implying the pick has some.
      if (pickedFull) reasons.push(`every agent is out of room; ${getAdapter(pick).displayName} ${pickedFull}`);
      else if (skipped.length) reasons.push(`${getAdapter(skipped[0]!).displayName} ${exhausted(skipped[0]!, quota)}`);
      if (avoided) reasons.push(`independent of the ${avoided.roles.join(" and ")}${avoided.yours ? " you picked" : ""}: ${[...new Set(avoided.agents)].map((a) => getAdapter(a).displayName).join(", ")}`);
      if (rank.why[pick] && rank.order[0] === pick) reasons.push(rank.why[pick]!);
      if (!reasons.length) reasons.push(`${chosen.length ? "next" : "first"} in preference order`);
      chosen.push(pick);
      notes.push(`Auto picked ${getAdapter(pick).displayName} for ${role} (${reasons.join("; ")})`);
    }
    out[role] = [...new Set(chosen)];
  }
  // In the order the roles came: the pattern lists them that way.
  return { roles: Object.fromEntries(Object.keys(roles).map((role) => [role, out[role]!])), notes };
}
