import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { agentMcpConfig } from "./agent-tools.js";
import { teamMcpConfig, type TeamToolConnection } from "../team-tools.js";

/** Native execution keeps the user's configuration, with a private per-turn MCP overlay.
 * No global MCP file is edited. Credentials remain in their existing native locations. */
export async function prepareAgyNativeTools(connection: TeamToolConnection | undefined, sourceHome = homedir(), teamConnection?: TeamToolConnection) {
  const server = connection ? agentMcpConfig(connection) : undefined;
  const team = teamConnection ? teamMcpConfig(teamConnection) : undefined;
  const root = await mkdtemp(join(tmpdir(), "codeflow-agy-tools-")), home = join(root, "home");
  const cleanup = () => rm(root, { recursive: true, force: true });
  const overlay = async (source: string, target: string, except: string[]) => {
    await mkdir(target, { recursive: true, mode: 0o700 });
    const entries = await readdir(source).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    for (const name of entries) if (!except.includes(name)) await symlink(join(source, name), join(target, name));
  };
  const readConfig = async (path: string) => {
    const text = await readFile(path, "utf8").catch(error => { if (error.code === "ENOENT") return "{}"; throw error; });
    if (text.length > 1024 * 1024) throw new Error("Antigravity MCP configuration is too large");
    const config = JSON.parse(text.trim() || "{}");
    if (!config || typeof config !== "object" || Array.isArray(config) || config.mcpServers && (typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers))) throw new Error("Invalid Antigravity MCP configuration");
    return config;
  };
  try {
    await overlay(sourceHome, home, [".gemini"]);
    await overlay(join(sourceHome, ".gemini"), join(home, ".gemini"), ["config", "antigravity-cli"]);
    for (const name of ["config", "antigravity-cli"]) await overlay(join(sourceHome, ".gemini", name), join(home, ".gemini", name), ["mcp_config.json"]);
    const legacy = await readConfig(join(sourceHome, ".gemini", "antigravity-cli", "mcp_config.json"));
    const current = await readConfig(join(sourceHome, ".gemini", "config", "mcp_config.json"));
    const config = { ...legacy, ...current, mcpServers: { ...legacy.mcpServers, ...current.mcpServers, ...(server ? { codeflow_agent: server } : {}), ...(team ? { codeflow_team: team } : {}) } };
    await writeFile(join(home, ".gemini", "config", "mcp_config.json"), JSON.stringify(config), { mode: 0o600 });
    return { home, cleanup };
  } catch { await cleanup(); throw new Error("Could not prepare Antigravity's private task-tool configuration. Check the existing MCP configuration before retrying."); }
}
