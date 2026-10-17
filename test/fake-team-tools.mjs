import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

/** Exercise the actual configured MCP process without asking a paid model to choose a tool. */
export async function exerciseTeamTools(args) {
  if (!process.env.FAKE_TEAM_TOOL_CALLS) return undefined;
  let server;
  const configAt = args.indexOf("--mcp-config");
  if (configAt >= 0) server = JSON.parse(readFileSync(args[configAt + 1], "utf8")).mcpServers.codeflow_team;
  else {
    const override = args.find((value) => value.startsWith("mcp_servers.codeflow_team="));
    if (override) {
      const command = override.match(/command=("(?:[^"\\]|\\.)*")/)[1];
      const argv = override.match(/args=(\[(?:[^\]"\\]|"(?:[^"\\]|\\.)*"|\\.)*\])/)[1];
      server = { command: JSON.parse(command), args: JSON.parse(argv) };
    }
  }
  if (!server) return { unavailable: true };
  const child = spawn(server.command, server.args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
  const input = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  input.on("line", (line) => { const message = JSON.parse(line); pending.get(message.id)?.(message); pending.delete(message.id); });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Fake MCP response timed out")); }, 12_000);
    pending.set(id, (response) => { clearTimeout(timer); resolve(response); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    const initialized = await call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fake-agent", version: "1" } });
    const tools = await call("tools/list");
    const results = [];
    for (const command of JSON.parse(process.env.FAKE_TEAM_TOOL_CALLS)) results.push(await call("tools/call", command));
    return { initialized, tools, results };
  } finally { input.close(); child.stdin.end(); child.kill(); }
}
