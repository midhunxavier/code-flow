import type { AgentAdapter, AgentId } from "./types.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { agyAdapter } from "./agy.js";

export * from "./types.js";

export const adapters: Record<AgentId, AgentAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  agy: agyAdapter,
};

export const AGENT_IDS = Object.keys(adapters) as AgentId[];

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && value in adapters;
}

export async function agentAvailability() {
  return Promise.all(
    AGENT_IDS.map(async (id) => ({
      id,
      displayName: adapters[id].displayName,
      binary: adapters[id].binary,
      available: await adapters[id].available(),
    })),
  );
}
