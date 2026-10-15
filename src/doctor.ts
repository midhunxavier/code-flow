import { execFile } from "node:child_process";
import { adapters, agentCatalog, AGENT_IDS, type AgentId } from "./adapters/index.js";

/**
 * Health check per CLI: installed, version, signed in, and the latest quota signal. Each check
 * uses the CLI's own commands; nothing reads credential files.
 */
export interface HealthEntry {
  id: AgentId;
  name: string;
  installed: boolean;
  path?: string;
  version?: string;
  signedIn: boolean | null;
  account?: string;
  quota?: { status: string; windows: Record<string, { utilization?: number; resetsAt?: number }>; at: number };
  fix?: string;
}

export async function doctor(quota: Partial<Record<AgentId, HealthEntry["quota"]>>): Promise<HealthEntry[]> {
  return Promise.all(AGENT_IDS.map((id) => check(id, quota[id])));
}

async function check(id: AgentId, quota: HealthEntry["quota"]): Promise<HealthEntry> {
  const adapter = adapters[id];
  const entry: HealthEntry = { id, name: adapter.displayName, installed: false, signedIn: null, quota };
  const path = (await capture("which", [adapter.binary])).stdout.trim();
  if (!path) {
    entry.fix = {
      claude: "Install Claude Code: npm install -g @anthropic-ai/claude-code, then run `claude` once and sign in.",
      codex: "Install Codex: npm install -g @openai/codex, then run `codex login`.",
      agy: "Install Antigravity CLI from antigravity.google, then run `agy` once and sign in.",
    }[id];
    return entry;
  }
  entry.installed = true;
  entry.path = path;
  entry.version = (await capture(adapter.binary, ["--version"])).stdout.trim().split("\n")[0];

  if (id === "claude") {
    const res = await capture("claude", ["auth", "status"]);
    try {
      const status = JSON.parse(res.stdout);
      entry.signedIn = !!status.loggedIn;
      entry.account = status.authMethod === "claude.ai" ? "Claude subscription" : status.authMethod;
    } catch {
      entry.signedIn = res.code === 0 ? null : false;
    }
    if (entry.signedIn === false) entry.fix = "Run `claude` in a terminal and sign in with your Claude account.";
  } else if (id === "codex") {
    const res = await capture("codex", ["login", "status"]);
    const text = `${res.stdout}${res.stderr}`.trim();
    entry.signedIn = res.code === 0 && /logged in/i.test(text);
    entry.account = entry.signedIn ? text.replace(/^Logged in using\s*/i, "") : undefined;
    if (!entry.signedIn) entry.fix = "Run `codex login` and sign in with ChatGPT.";
  } else {
    // agy has no status command; listing models only works when signed in.
    try {
      await agentCatalog("agy");
      entry.signedIn = true;
      entry.account = "Google account";
    } catch {
      entry.signedIn = false;
      entry.fix = "Run `agy` in a terminal once and sign in with your Google account.";
    }
  }
  return entry;
}

function capture(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0;
      resolve({ code, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
    });
  });
}
