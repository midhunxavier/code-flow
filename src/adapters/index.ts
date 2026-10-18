import type { AgentAdapter, AgentId, AgentSettings, ModelCatalog } from "./types.js";
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
  return typeof value === "string" && Object.hasOwn(adapters, value);
}
export function getAdapter(id: AgentId): AgentAdapter {
  if (!Object.hasOwn(adapters, id) || !adapters[id]) throw new Error(`Provider ${id} is unavailable; restore its pinned extension or choose an installed provider`);
  return adapters[id]!;
}

/** Registration is startup-only and atomic across a plugin's provider set. Built-ins cannot be replaced. */
export function registerProviderAdapters(providers: AgentAdapter[]) {
  const ids = providers.map((provider) => provider.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => !id.startsWith("plugin:") || Object.hasOwn(adapters, id))) throw new Error("Provider IDs must be unique and cannot replace installed adapters");
  for (const provider of providers) { adapters[provider.id] = Object.freeze({ ...provider }); AGENT_IDS.push(provider.id); }
}

const CATALOG_TTL_MS = 10 * 60_000;
const catalogCache = new Map<AgentId, { at: number; value: Promise<ModelCatalog> }>();

/** Model catalog per CLI, cached because listing can take a few seconds (agy fetches it). */
export function agentCatalog(id: AgentId): Promise<ModelCatalog> {
  const cached = catalogCache.get(id);
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.value;
  const value = getAdapter(id).catalog();
  catalogCache.set(id, { at: Date.now(), value });
  value.catch(() => catalogCache.delete(id));
  return value;
}

// Values end up as CLI arguments: must not look like a flag or carry quotes.
const MODEL_RE = /^[A-Za-z0-9][\w.:/[\]@-]{0,99}$/;
const EFFORT_RE = /^[a-z]{2,12}$/;

export function validateAgentSettings(input: unknown): AgentSettings {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, any>;
  const settings: AgentSettings = {};
  for (const id of AGENT_IDS) {
    const model = typeof raw[id]?.model === "string" ? raw[id].model.trim() : "";
    const effort = typeof raw[id]?.effort === "string" ? raw[id].effort.trim() : "";
    if (model && !MODEL_RE.test(model)) throw new Error(`Invalid model name for ${getAdapter(id).displayName}: "${model}"`);
    if (effort && !EFFORT_RE.test(effort)) throw new Error(`Invalid effort for ${getAdapter(id).displayName}: "${effort}"`);
    if (model || effort) settings[id] = { ...(model && { model }), ...(effort && { effort }) };
  }
  return settings;
}

export async function agentAvailability() {
  return Promise.all(
    AGENT_IDS.map(async (id) => ({
      id,
      displayName: getAdapter(id).displayName,
      binary: getAdapter(id).binary,
      available: await getAdapter(id).available(),
    })),
  );
}
