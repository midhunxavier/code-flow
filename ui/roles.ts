import type { AgentId } from "./types.js";

export type RoleValue = AgentId | "auto";

/**
 * A role that checks the others' work is fairer filled by a vendor that didn't do that work:
 * a reviewer that isn't the builder or the planner. Adjusts the roles the composer filled from the
 * pattern's defaults; a role you picked yourself (in `saved`) is left alone, and so is one
 * whose comparison involves Auto. `installed` is the agents that can run, in order of preference.
 */
export function independentRoles(
  patternId: string,
  roles: Record<string, RoleValue[]>,
  saved: Record<string, RoleValue[]>,
  installed: AgentId[],
): Record<string, RoleValue[]> {
  const out = { ...roles };
  /** The first installed agent outside `avoid`. */
  const outside = (avoid: RoleValue[]) => installed.find((id) => !avoid.includes(id));
  if (patternId === "fix-review" && !saved.reviewer && !out.builder?.includes("auto")) {
    const other = outside(out.builder ?? []);
    if (out.builder?.includes(out.reviewer?.[0]!) && other) out.reviewer = [other];
  }
  // A reviewer of the planner's vendor would let a wrong plan through; best neither the planner's nor the builder's.
  if (patternId === "pipeline" && !saved.reviewer) {
    const [planner] = out.planner ?? [];
    const [builder] = out.builder ?? [];
    const [reviewer] = out.reviewer ?? [];
    if (planner && planner !== "auto" && reviewer !== "auto" && (reviewer === planner || reviewer === builder)) {
      const other = outside([planner, ...(builder && builder !== "auto" ? [builder] : [])]) ?? outside([planner]);
      if (other) out.reviewer = [other];
    }
  }
  return out;
}
