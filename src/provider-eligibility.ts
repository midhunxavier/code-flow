import type { AgentId } from "./adapters/types.js";
import type { Trust } from "./repo-config.js";

/** Registration is not permission to use a provider in unattended work. */
export function providerEligibility(id: AgentId, input: { trust: Trust; unattended?: boolean; projectTeam?: boolean; remote?: boolean; container?: boolean }): string | undefined {
  const trust = input.unattended && input.trust === "full" ? "trusted" : input.trust;
  if (id.startsWith("acp:") && (trust !== "full" || input.unattended || input.remote || input.container)) return "ACP connections are unavailable for scheduled teams; they require local interactive Full access";
  if (input.projectTeam && !["claude", "codex", "agy"].includes(id)) return "This provider has not been validated for unattended project teams";
  if (id.startsWith("plugin:") && (input.remote || input.container)) return "Extension providers require local execution";
}
