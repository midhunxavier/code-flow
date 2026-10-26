import type { PatternInfo } from "./types.js";
import type { RoleValue } from "./roles.js";

type Trust = "safe" | "standard" | "trusted" | "full";
export type PermissionChoice = { trust: Trust; tools: boolean };

const LEVELS: Record<Trust, string> = { safe: "Safe", standard: "Approve for me", trusted: "Trusted", full: "Full access" };

/** Providers that can put tool requests in the approval inbox. Auto resolves to one of them when approvals are on. */
export const canAskForApproval = (id: string): boolean => id === "auto" || id === "claude" || id === "codex";

/** "Ask for approval" is Standard with approvals (Full in legacy ACP snapshots). */
export const asksForApproval = ({ trust, tools }: PermissionChoice, acp = false): boolean => tools && (trust === "standard" || acp && trust === "full");

/** The Permissions control's name for a choice. Approvals at another level name both, so neither is hidden. */
export function permissionLabel(choice: PermissionChoice, acp = false): string {
  if (!choice.tools) return LEVELS[choice.trust];
  return asksForApproval(choice, acp) ? "Ask for approval" : `${LEVELS[choice.trust]} · ask for approval`;
}

/**
 * Whether a new run asks for tool approvals, worked out once for the Permissions control, Run details
 * and the start request. `choice` is an explicit pick (the menu, a restored draft or run, the browser
 * preference); without one, a Claude or Codex conversation at Standard asks. Where nothing in the run
 * can ask, the choice is kept but not sent. `conflict` names the roles a mixed team gives to
 * Antigravity, which can't ask: Start explains it instead of the server refusing the run.
 */
export function toolApprovalState({ choice, trust, p, roles, remote = false, container = false, external = false }: {
  choice?: boolean; trust: Trust; p?: PatternInfo; roles: Record<string, RoleValue[]>; remote?: boolean; container?: boolean; external?: boolean;
}): { tools: boolean; source: string; conflict: string } {
  // An Auto team's coordinator starts the run; it chooses pool members that fit the run's permissions.
  const providers = (p?.id === "auto-team" ? roles.coordinator ?? [] : Object.values(roles).flat());
  const unavailable = external ? "External source · Safe permissions"
    : remote ? "Unavailable on a remote worker"
    : container ? "Unavailable with Docker isolation"
    : trust === "safe" ? "Safe permissions"
    : providers.length && !providers.some(canAskForApproval) ? providers.includes("agy") ? "Antigravity can't ask for approval" : "The selected provider can't ask for approval"
    : "";
  const solo = p?.id === "solo" ? roles.agent?.[0] : undefined;
  const wanted = choice ?? (trust === "standard" && (solo === "claude" || solo === "codex"));
  const tools = !unavailable && wanted;
  const source = unavailable || (choice !== undefined ? "Explicit choice" : wanted ? "Default for Claude and Codex conversations" : "Application default");
  const blocked = tools && p ? p.roles.filter((role) => (p.id !== "auto-team" || role.id === "coordinator") && roles[role.id]?.includes("agy")).map((role) => role.label) : [];
  return { tools, source, conflict: blocked.length ? `Antigravity can't ask for approval. Choose another option in Permissions, or pick Claude or Codex for ${blocked.join(", ")}.` : "" };
}
