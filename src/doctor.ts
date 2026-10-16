import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapters, agentCatalog, AGENT_IDS, type AgentId } from "./adapters/index.js";
import { childEnv } from "./env.js";
import { gitAtLeast, gitVersion } from "./git.js";

/**
 * Health check per CLI: installed, version, signed in, the flags code-flow passes, and the
 * latest quota signal. Each check uses the CLI's own commands; nothing reads credential files.
 */
export interface HealthEntry {
  id: AgentId;
  name: string;
  installed: boolean;
  path?: string;
  version?: string;
  /** null: couldn't tell (agy unreachable, an unexpected answer). */
  signedIn: boolean | null;
  account?: string;
  quota?: { status: string; windows: Record<string, { utilization?: number; resetsAt?: number }>; at: number };
  fix?: string;
  /**
   * Whether this CLI's --help lists every flag and subcommand code-flow passes it: false means
   * steps that use the missing ones will fail with an unknown option. Undefined: not checked.
   */
  compatible?: boolean;
  /** The flags and subcommands code-flow needs that this CLI doesn't list. */
  missing?: string[];
  /** Problems worth knowing that don't make the CLI unusable (and the incompatibility, worded). */
  warnings?: string[];
}

/**
 * What code-flow passes each CLI (see the adapters), probed in `--help`. `when` says what fails
 * without it; `optional` ones only lose a feature.
 */
interface Need {
  name: string;
  when: string;
  optional?: boolean;
}
const NEEDS: Record<AgentId, { args: string[]; needs: Need[] }[]> = {
  claude: [
    {
      args: ["--help"],
      needs: [
        { name: "--print", when: "every step" },
        { name: "--output-format", when: "every step" },
        { name: "--verbose", when: "every step" },
        { name: "--permission-mode", when: "every step" },
        { name: "--allowedTools", when: "every step" },
        { name: "--disallowedTools", when: "read-only steps" },
        { name: "--resume", when: "follow-ups and retries in the same conversation" },
        { name: "--json-schema", when: "structured answers (plans, reviews, verdicts)" },
        { name: "--model", when: "steps with a model chosen" },
        { name: "--effort", when: "steps with an effort chosen" },
      ],
    },
  ],
  codex: [
    {
      args: ["--help"],
      needs: [
        { name: "exec", when: "every step without app-server" },
        { name: "app-server", when: "messages delivered mid-turn (code-flow uses codex exec instead)", optional: true },
      ],
    },
    {
      args: ["exec", "--help"],
      needs: [
        { name: "--json", when: "every exec step" },
        { name: "--skip-git-repo-check", when: "every exec step" },
        { name: "--config", when: "every exec step (sandbox mode)" },
        { name: "--cd", when: "every exec step" },
        { name: "resume", when: "follow-ups in the same conversation" },
        { name: "--output-schema", when: "structured answers (plans, reviews, verdicts)" },
        { name: "--model", when: "steps with a model chosen" },
      ],
    },
  ],
  agy: [
    {
      args: ["--help"],
      needs: [
        { name: "--input-format", when: "every step" },
        { name: "--output-format", when: "every step" },
        { name: "--print-timeout", when: "every step" },
        { name: "--sandbox", when: "every step" },
        { name: "--dangerously-skip-permissions", when: "every step (unless CODEFLOW_AGY_SKIP_PERMISSIONS=0)" },
        { name: "--conversation", when: "follow-ups in the same conversation" },
        { name: "--json-schema", when: "structured answers (plans, reviews, verdicts)" },
        { name: "--model", when: "steps with a model chosen" },
        { name: "--effort", when: "steps with an effort chosen" },
      ],
    },
  ],
};

const UPDATE: Record<AgentId, string> = {
  claude: "Update Claude Code: `claude update` (or npm install -g @anthropic-ai/claude-code).",
  codex: "Update Codex: npm install -g @openai/codex.",
  agy: "Update Antigravity CLI (antigravity.google).",
};

/** Merging a run's changes uses `git merge-tree --write-tree`, new in git 2.38. */
const GIT_MIN: [number, number] = [2, 38];

export interface GitHealth {
  installed: boolean;
  version?: string;
  /** At least 2.38. */
  ok: boolean;
  warning?: string;
}

export async function doctor(quota: Partial<Record<AgentId, HealthEntry["quota"]>>): Promise<HealthEntry[]> {
  return Promise.all(AGENT_IDS.map((id) => check(id, quota[id])));
}

/** git itself: code-flow's worktrees, commits and merges all need it, and merges need 2.38+. */
export async function checkGit(): Promise<GitHealth> {
  const v = await gitVersion().catch(() => undefined);
  if (!v) return { installed: false, ok: false, warning: `git wasn't found (or \`git --version\` failed): code-flow needs git ${GIT_MIN.join(".")} or newer.` };
  const version = v.join(".");
  if (await gitAtLeast(...GIT_MIN)) return { installed: true, version, ok: true };
  return {
    installed: true,
    version,
    ok: false,
    warning: `git ${version} is older than ${GIT_MIN.join(".")}: merging a run's changes (git merge-tree --write-tree) will fail. Update git.`,
  };
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
  const [version] = await Promise.all([capture(adapter.binary, ["--version"]), probeFlags(id, entry)]);
  entry.version = (version.stdout.trim() || version.stderr.trim()).split("\n")[0] || undefined;

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
    // "Not logged in" contains "logged in": only a line that starts with it counts.
    entry.signedIn = res.code === 0 && /^\s*logged in\b/im.test(text) && !/not logged in/i.test(text);
    // "Logged in using an API key - sk-…": name the method, not the key.
    entry.account = entry.signedIn ? text.match(/^\s*logged in using\s*(.*)$/im)?.[1]?.split(" - ")[0]?.trim() || "ChatGPT" : undefined;
    if (!entry.signedIn) entry.fix = "Run `codex login` and sign in with ChatGPT.";
  } else {
    // agy has no status command; listing models only works when signed in. A failure that
    // doesn't say it's about sign-in (no network, Google unreachable) means "can't tell".
    try {
      await agentCatalog("agy");
      entry.signedIn = true;
      entry.account = "Google account";
    } catch (err) {
      const message = (err as Error).message;
      if (/not (?:logged|signed) in|log ?in|sign ?in|unauthenticated|unauthori[sz]ed|\b401\b|credentials?/i.test(message) && !/ENOTFOUND|EAI_AGAIN|ECONN|ETIMEDOUT|network|fetch failed|timed out/i.test(message)) {
        entry.signedIn = false;
        entry.fix = "Run `agy` in a terminal once and sign in with your Google account.";
      } else {
        entry.signedIn = null;
        entry.fix = `Couldn't tell whether agy is signed in (listing models failed: ${message.split("\n").slice(-1)[0]!.slice(0, 200)}). Check your network; if you've never signed in, run \`agy\` once in a terminal.`;
      }
    }
  }
  if (entry.compatible === false) entry.fix ??= UPDATE[id];
  return entry;
}

/**
 * Look for every flag and subcommand code-flow passes in the CLI's `--help`, so an upgrade (or
 * an old install) that dropped one shows here instead of as every step failing on an unknown
 * option. Help that can't be read leaves the entry unchecked rather than flagging everything.
 */
async function probeFlags(id: AgentId, entry: HealthEntry): Promise<void> {
  const missing: Need[] = [];
  for (const probe of NEEDS[id]) {
    const help = await helpText(adapters[id].binary, probe.args);
    if (help.trim().length < 40) return; // no usable help: unknown, not incompatible
    for (const need of probe.needs) if (!listed(help, need.name)) missing.push(need);
  }
  const required = missing.filter((n) => !n.optional);
  entry.compatible = required.length === 0;
  if (missing.length) entry.missing = missing.map((n) => n.name);
  const warnings: string[] = [];
  if (required.length) {
    const names = required.map((n) => n.name).join(", ");
    const uses = [...new Set(required.map((n) => n.when))].join("; ");
    warnings.push(`This ${adapters[id].displayName} doesn't list ${names} in its --help. code-flow passes ${required.length === 1 ? "it" : "them"} (${uses}), so those steps will fail with an unknown option. ${UPDATE[id]}`);
  }
  for (const need of missing.filter((n) => n.optional)) warnings.push(`No \`${adapters[id].binary} ${need.name}\`: ${need.when}.`);
  if (warnings.length) entry.warnings = warnings;
}

/** Whether `--help` output lists a flag (`--json-schema <schema>`, `-c, --config`) or a subcommand. */
function listed(help: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return name.startsWith("-")
    ? new RegExp(`(?:^|[\\s,\\[(])${escaped}(?=$|[\\s,=<\\[\\])])`, "m").test(help)
    : new RegExp(`^\\s+${escaped}(?=$|\\s)`, "m").test(help);
}

/**
 * A CLI's `--help`, written to a file rather than a pipe: Claude Code exits before a piped
 * help is fully written (8 or 16 KB of 22), and the flags past the cut would read as missing.
 */
async function helpText(cmd: string, args: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codeflow-help-"));
  const file = join(dir, "help.txt");
  try {
    const fd = openSync(file, "w");
    try {
      await new Promise<void>((resolve) => {
        const child = spawn(cmd, args, { stdio: ["ignore", fd, fd], env: childEnv() });
        const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
        child.on("error", () => resolve());
        child.on("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } finally {
      closeSync(fd);
    }
    return await readFile(file, "utf8");
  } catch {
    return "";
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function capture(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20_000, env: childEnv() }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0;
      resolve({ code, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
    });
  });
}
