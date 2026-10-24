import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TeamToolConnection } from "../team-tools.js";
import { AGENT_TOOLS } from "../agent-tools.js";
/** Native HTTP MCP for clients that cannot launch our stdio helper inside their sandbox. */
export function agentMcpConfig(connection: TeamToolConnection) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/v1\/agent-tools$/.test(connection.endpoint) || !/^[\w-]{43}$/.test(connection.token) || !Number.isFinite(connection.expiresAt) || connection.expiresAt <= Date.now()) throw new Error("Invalid task tool connection");
  return { serverUrl: connection.endpoint.replace(/agent-tools$/, "agent-mcp"), headers: { Authorization: `Bearer ${connection.token}` }, tools: Object.fromEntries(AGENT_TOOLS.map(tool => [tool.name, { eager: true }])) };
}
export async function prepareAgentTools(connection: TeamToolConnection) {
  const dir = await mkdtemp(join(tmpdir(), "codeflow-agent-tools-"));
  try {
    const path = join(dir, "connection.json"), config = join(dir, "mcp.json");
    await writeFile(path, JSON.stringify(connection), { mode: 0o600 });
    const args = [fileURLToPath(new URL("../agent-tool-client.mjs", import.meta.url)), "--connection", path];
    const value = { command: process.execPath, args, enabled_tools: AGENT_TOOLS.map(tool => tool.name), startup_timeout_sec: 10, tool_timeout_sec: 660, tools: Object.fromEntries(AGENT_TOOLS.map(tool => [tool.name, { approval_mode: "approve" }])) };
    await writeFile(config, JSON.stringify({ mcpServers: { codeflow_agent: { type: "stdio", command: process.execPath, args } } }), { mode: 0o600 });
    const toml = `mcp_servers.codeflow_agent={command=${JSON.stringify(process.execPath)},args=${JSON.stringify(args)},enabled_tools=${JSON.stringify(value.enabled_tools)},startup_timeout_sec=10,tool_timeout_sec=660,tools={${AGENT_TOOLS.map(tool => `${tool.name}={approval_mode="approve"}`).join(",")}}}`;
    return { claudeConfig: config, codexConfig: ["-c", toml], codexThreadConfig: { "mcp_servers.codeflow_agent": value }, cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
}
