import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TEAM_TOOLS, type TeamToolConnection } from "../team-tools.js";
import { captureOutput } from "./process.js";
import type { AgentId } from "./types.js";

export type CapabilityStatus = "tested" | "unsupported" | "unknown";
export interface AdapterTeamCapabilities {
  provider: AgentId;
  version?: string;
  structuredOutput: CapabilityStatus;
  sessionResume: CapabilityStatus;
  liveInput: CapabilityStatus;
  scopedTools: CapabilityStatus;
  sandbox: CapabilityStatus;
  nestedAgentControl: CapabilityStatus;
  nestedUsage: CapabilityStatus;
  evidence: string[];
}

const CACHE_MS = 10 * 60_000;
/**
 * An unknown result (a CLI missing or not signed in, an older Codex refusing `mcp get`, a probe that
 * timed out) is kept too, for less long: a CLI installed meanwhile is picked up within minutes, and an
 * installation that stays unknown pays the serial probe stages once per window, not once per turn.
 */
const UNKNOWN_CACHE_MS = 2 * 60_000;
const cache = new Map<string, { at: number; ttl: number; value: Promise<AdapterTeamCapabilities> }>();
/** Protocol fixtures establish our contract; installed help/config probes establish availability. */
export function adapterTeamCapabilities(provider: AgentId): Promise<AdapterTeamCapabilities> {
  const key = `${provider}:${process.env.PATH}:${process.env.FAKE_UNKNOWN_FLAG ?? ""}`;
  const saved = cache.get(key);
  if (saved && Date.now() - saved.at < saved.ttl) return saved.value;
  const entry = { at: Date.now(), ttl: CACHE_MS, value: probe(provider) };
  cache.set(key, entry);
  void entry.value.then((capabilities) => { if (capabilities.scopedTools === "unknown") entry.ttl = UNKNOWN_CACHE_MS; }, () => cache.delete(key));
  return entry.value;
}

async function probe(provider: AgentId): Promise<AdapterTeamCapabilities> {
  if (provider.startsWith("plugin:")) return { provider, structuredOutput: "unknown", sessionResume: "unknown", liveInput: "unsupported", scopedTools: "unsupported", sandbox: "unknown", nestedAgentControl: "unknown", nestedUsage: "unknown", evidence: ["Owner-configured provider plugin. Built-in provider protocol fixtures and sandbox probes do not establish compatibility for this extension."] };
  const [versionResult, helpResult] = await Promise.allSettled([
    captureOutput(provider, ["--version"], 5_000), captureOutput(provider, ["--help"], 5_000),
  ]);
  const version = versionResult.status === "fulfilled" ? versionResult.value.trim().slice(0, 150) : undefined;
  const help = helpResult.status === "fulfilled" ? helpResult.value : "";
  const flags = (...values: string[]) => values.every((value) => help.includes(value));
  const supported = (present: boolean, observed = !!help): CapabilityStatus => present ? "tested" : observed ? "unsupported" : "unknown";
  let structuredOutput = supported(flags("--json-schema"));
  let sessionResume = supported(flags(provider === "agy" ? "--conversation" : "--resume"));
  let nestedAgentControl: CapabilityStatus = provider === "claude" ? supported(flags("--disallowedTools")) : "unknown";
  let scopedTools: CapabilityStatus = "unknown";
  const evidence = ["Adapter protocol and permissions are covered by fake-CLI regression tests; model behavior is evaluated separately."];
  if (provider === "claude") {
    scopedTools = flags("--mcp-config", "--strict-mcp-config", "--allowedTools", "--disallowedTools") ? "tested" : help ? "unsupported" : "unknown";
    evidence.push("Per-turn stdio MCP config and explicit tool allowlist; built-in Agent, Task and team creation are denied for Auto turns.");
  } else if (provider === "codex") {
    const [execHelp, features] = await Promise.allSettled([captureOutput("codex", ["exec", "--help"], 5_000), captureOutput("codex", ["features", "list"], 5_000)]);
    const execFlags = execHelp.status === "fulfilled" ? execHelp.value : "";
    structuredOutput = supported(execFlags.includes("--output-schema"), !!execFlags);
    sessionResume = supported(/\bresume\b/.test(execFlags), !!execFlags);
    nestedAgentControl = features.status === "fulfilled" && /^multi_agent\s/m.test(features.value) && /^multi_agent_v2\s/m.test(features.value) ? "tested" : "unknown";
    try {
      const found = JSON.parse(await captureOutput("codex", ["mcp", "get", "codeflow_capability_probe", "--json", "-c", 'mcp_servers.codeflow_capability_probe={command="node",args=[],enabled_tools=["read_inbox"],tools={read_inbox={approval_mode="approve"}},startup_timeout_sec=5,tool_timeout_sec=10}'], 5_000));
      scopedTools = found.transport?.type === "stdio" && found.enabled_tools?.includes("read_inbox") ? "tested" : "unknown";
    } catch { scopedTools = "unknown"; }
    evidence.push("Per-turn mcp_servers override is checked with codex mcp get; app-server and exec share the same config. Native multi_agent and multi_agent_v2 are disabled for Auto turns.");
  } else {
    scopedTools = help && !help.includes("--mcp-config") ? "unsupported" : "unknown";
    evidence.push("agy exposes persistent MCP management but no verified per-turn config; collaboration uses structured outcomes. Native nested-agent control and usage breakdown are unknown.");
  }
  evidence.push("Provider token events report parent-turn totals; a separate nested-agent token breakdown is not available.");
  return {
    provider, version,
    structuredOutput, sessionResume,
    liveInput: provider === "codex" ? supported(/\bapp-server\b/.test(help)) : "unsupported", scopedTools,
    sandbox: provider === "claude" ? "unsupported" : help ? "tested" : "unknown",
    nestedAgentControl,
    nestedUsage: "unknown", evidence,
  };
}

export const TEAM_MCP_NAME = "codeflow_team";
export const TEAM_TOOL_ALLOWLIST = TEAM_TOOLS.map((tool) => `mcp__${TEAM_MCP_NAME}__${tool.name}`);
export const TEAM_NESTED_DENYLIST = ["Agent", "Task", "TeamCreate", "TeamDelete", "SendMessage"];

/** Temporary capability lives outside the worktree and is removed as soon as the CLI exits. */
export async function prepareTeamTools(connection: TeamToolConnection): Promise<{
  claudeConfig: string;
  codexConfig: string[];
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "codeflow-member-tools-"));
  const credentialPath = join(dir, "connection.json");
  const configPath = join(dir, "mcp.json");
  const clientPath = fileURLToPath(new URL("../team-tool-client.mjs", import.meta.url));
  try {
    await writeFile(credentialPath, JSON.stringify(connection), { mode: 0o600 });
    const args = [clientPath, "--connection", credentialPath];
    await writeFile(configPath, JSON.stringify({ mcpServers: { [TEAM_MCP_NAME]: { type: "stdio", command: process.execPath, args } } }), { mode: 0o600 });
    // JSON string escaping is also valid for these TOML basic string values. No shell is involved.
    // Grant only these bounded local collaboration operations. Source-file/shell approvals
    // and all other MCP servers retain the CLI's existing policy and sandbox.
    const tools = TEAM_TOOLS.map((tool) => `${tool.name}={approval_mode="approve"}`).join(",");
    const config = `mcp_servers.${TEAM_MCP_NAME}={command=${JSON.stringify(process.execPath)},args=${JSON.stringify(args)},enabled_tools=${JSON.stringify(TEAM_TOOLS.map((tool) => tool.name))},tools={${tools}},startup_timeout_sec=5,tool_timeout_sec=10}`;
    return { claudeConfig: configPath, codexConfig: ["-c", config], cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
}
