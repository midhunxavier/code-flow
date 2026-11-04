import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

/** Desktop connections share Codex's global config. Mask them for this process
 * only; the project-local `codeflow` entry and unrelated servers are preserved. */
export function projectOnlyCodexArgs(inventory: unknown, args: string[]) {
  if (!Array.isArray(inventory) || inventory.some(s => typeof s?.name !== "string")) throw new Error("Cannot verify Codex MCP configuration; run codex mcp list --json to repair it");
  const desktop = [...new Set(inventory.map(s => s.name as string).filter(name => /^codeflow-[A-Za-z0-9_-]+$/.test(name)))];
  return [...desktop.flatMap(name => ["-c", `mcp_servers.${name}.enabled=false`]), ...args];
}

export async function launchTerminal(provider: string | undefined, args: string[]) {
  if (provider !== "claude" && provider !== "codex") throw new Error("Use codeflow terminal claude|codex -- [provider arguments]");
  let forwarded = args[0] === "--" ? args.slice(1) : args;
  if (provider === "codex") {
    const { stdout } = await promisify(execFile)("codex", ["mcp", "list", "--json"], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    forwarded = projectOnlyCodexArgs(JSON.parse(stdout), forwarded);
  }
  // Inherit the terminal, cwd, authentication and provider permissions. No
  // persistent config edits, backend restart, or automatic project installation.
  const child = spawn(provider, forwarded, { stdio: "inherit" });
  const handlers = (["SIGINT", "SIGTERM"] as const).map(signal => {
    const handler = () => { child.kill(signal); }; process.on(signal, handler); return [signal, handler] as const;
  });
  try {
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject); child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 143)));
    });
  } finally { for (const [signal, handler] of handlers) process.off(signal, handler); }
}
