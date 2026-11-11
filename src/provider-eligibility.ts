import { runProviderProblem } from "./run-permissions.js";
import type { AgentId } from "./adapters/types.js";
import type { Trust } from "./repo-config.js";

/** Registration is not permission to use a provider in unattended work. */
export function providerEligibility(id: AgentId, input: { trust: Trust; unattended?: boolean; remote?: boolean; container?: boolean }): string | undefined {
  const unsupported = runProviderProblem(id);
  if (unsupported) return unsupported;
  if (id.startsWith("plugin:") && (input.remote || input.container)) return "Extension providers require local execution";
}
