import { readFile, mkdir, writeFile, rename, lstat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { resolve, join, dirname } from "node:path";
import { CODEFLOW_HOME } from "../config.js";
import { getAdapter } from "../adapters/index.js";
import { repoRoot } from "../git.js";
import { connectRuntime, runtimeRequest } from "./client.js";
import { installProject, uninstallProject } from "./install.js";
import { serveMcp } from "./mcp.js";
import { fail, validatePreferences, type Provider } from "./model.js";

const usage = `Code Flow conversational teams

  codeflow init [--providers claude,codex] [--dry-run]
  codeflow doctor
  codeflow mcp [--project-root PATH]
  codeflow approve PROPOSAL_ID --revision NUMBER
  codeflow status RUN_ID
  codeflow result RUN_ID
  codeflow pause|resume|cancel RUN_ID
  codeflow attach RUN_ID --connection CONNECTION_ID
  codeflow preferences [--provider claude|codex --model ID --effort VALUE] [--preferred-provider claude|codex] [--personal]
  codeflow uninstall --project

Use the codeflow skill in your Claude or Codex conversation to describe a task.
Teams and processes are generated for that task. No presets or saved teams.
Run approval uses your host's native confirmation form when available.
Terminal approval is a fallback. Host reattachment requires an interactive terminal.
Existing bare codeflow and codeflow client commands are unchanged.
`;
export const CLI_COMMANDS = new Set(["init", "doctor", "mcp", "approve", "status", "result", "pause", "resume", "cancel", "attach", "preferences", "uninstall"]);
export async function launchCli(args = process.argv.slice(2)) {
  const command = args.shift();
  if (!command || args.includes("--help")) { console.log(usage); return; }
  const option = (key: string) => { const index = args.indexOf(key); if (index < 0) return undefined; const value = args[index + 1]; if (!value || value.startsWith("--")) throw new Error(`Choose a value for ${key}`); return value; };
  const root = resolve(option("--project-root") ?? process.cwd());
  const providers = async () => {
    const requested = option("--providers");
    if (requested) { const values = requested.split(","); if (!values.length || values.some(p => p !== "claude" && p !== "codex")) throw new Error("Choose --providers claude,codex or one provider"); return [...new Set(values)] as Provider[]; }
    const installed = await Promise.all((["claude", "codex"] as const).map(async p => await getAdapter(p).available() ? p : undefined));
    const chosen = installed.filter((p): p is Provider => !!p); if (!chosen.length) throw new Error("Install Claude Code or Codex, or explicitly choose --providers before connecting it later"); return chosen;
  };
  if (command === "init") { console.log(JSON.stringify(await installProject(root, await providers(), args.includes("--dry-run")), null, 2)); return; }
  if (command === "uninstall") { if (!args.includes("--project")) throw new Error("Use uninstall --project to remove only this project's managed entries"); console.log(JSON.stringify(await uninstallProject(root), null, 2)); return; }
  if (command === "mcp") { await serveMcp(root); return; }
  if (command === "doctor") {
    const repo = await repoRoot(root);
    const installed = await Promise.all((["claude", "codex"] as const).map(async provider => ({ provider, installed: await getAdapter(provider).available(), authentication: "not tested; use catalog discovery after signing in" })));
    console.log(JSON.stringify({ repo, providers: installed, node: process.version, configuration: await installProject(root, installed.filter(p => p.installed).map(p => p.provider), true), notes: ["Project trust and MCP consent belong to the native CLI.", "No inference was performed. Run approval uses native MCP form elicitation when the host declares support; terminal confirmation remains a fallback.", "Current-session model/effort are unverified; pinned roles use managed workers."] }, null, 2)); return;
  }
  if (command === "preferences") {
    const file = args.includes("--personal") ? join(CODEFLOW_HOME, "cli-teams-preferences.json") : join(await repoRoot(root), ".codeflow", "cli-teams.json");
    for (const path of [file, ...(args.includes("--personal") ? [] : [dirname(file)])]) if ((await lstat(path).catch(e => { if (e.code === "ENOENT") return undefined; throw e; }))?.isSymbolicLink()) throw new Error("Preference paths must not be symlinks; keep project configuration inside the repository");
    const existing = await readFile(file, "utf8").then(JSON.parse).catch(e => { if (e.code === "ENOENT") return { schemaVersion: 1, preferences: {} }; throw e; });
    const prefs = validatePreferences(existing.preferences ?? existing), provider = option("--provider"), model = option("--model"), effort = option("--effort");
    const preferredProvider = option("--preferred-provider");
    if (provider || model || effort || preferredProvider) {
      if (preferredProvider) { if (!["claude", "codex"].includes(preferredProvider)) throw new Error("Choose --preferred-provider claude or codex"); prefs.preferredProvider = preferredProvider as Provider; }
      if (provider || model || effort) {
        if (provider !== "claude" && provider !== "codex") throw new Error("Choose --provider claude or codex");
        prefs.providers ??= {}; prefs.providers[provider] = { ...prefs.providers[provider], ...(model ? { model } : {}), ...(effort ? { effort } : {}) }; validatePreferences(prefs);
      }
      await mkdir(dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({ schemaVersion: 1, preferences: prefs }, null, 2) + "\n", { mode: 0o600, flag: "wx" }); await rename(temp, file);
    }
    console.log(JSON.stringify({ file, preferences: prefs, note: "Settings are validated against the actual catalog when a proposal is created." }, null, 2)); return;
  }
  if (!CLI_COMMANDS.has(command)) throw new Error(usage);
  if ((command === "approve" || command === "attach") && (!process.stdin.isTTY || !process.stdout.isTTY)) fail("acceptance_required", "Use your own interactive terminal; unattended approval is unavailable");
  const client = await connectRuntime(root);
  try {
    if (command === "approve" || command === "attach") {
      if (!process.stdin.isTTY || !process.stdout.isTTY) fail("acceptance_required", "Use your own interactive terminal; unattended approval is unavailable");
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        if (command === "approve") {
          const proposalId = args[0], revision = Number(option("--revision"));
          if (!proposalId || !Number.isSafeInteger(revision) || revision < 1) throw new Error("Choose a proposal and --revision NUMBER");
          const preview = await runtimeRequest(client.runtime, "/preview", { projectRoot: root, proposalId, revision });
          console.log(preview.preview);
          if ((await prompt.question("\nAccept this exact proposal? Type start: ")).trim() !== "start") { console.log("Not accepted; no work started."); return; }
          await runtimeRequest(client.runtime, "/confirm", { projectRoot: root, proposalId, revision, hash: preview.hash });
          console.log("Accepted. Return to your CLI conversation to start this proposal.");
        } else {
          const runId = args[0], connectionId = option("--connection");
          if (!runId || !connectionId) throw new Error("Choose RUN_ID and --connection from get_run");
          if ((await prompt.question(`Attach host connection ${connectionId} to run ${runId}? Type attach: `)).trim() !== "attach") return;
          console.log(JSON.stringify(await runtimeRequest(client.runtime, "/attach", { projectRoot: root, runId, connectionId })));
        }
      } finally { prompt.close(); }
      return;
    }
    const runId = args[0]; if (!runId) throw new Error("Choose a run ID");
    if (["pause", "resume", "cancel"].includes(command)) { console.log(JSON.stringify(await client.call("codeflow_control_run", { operationId: `${command}-${Date.now()}`, runId, action: command }), null, 2)); return; }
    const run = await client.call("codeflow_get_run", { runId });
    if (command === "status") { console.log(JSON.stringify(run, null, 2)); return; }
    const result = run.artifacts.filter((a: any) => a.kind === "result").at(-1);
    if (!result) { console.log(JSON.stringify({ status: run.status, error: run.error, message: "No final result yet. Use status to inspect preserved partial artifacts." }, null, 2)); return; }
    let cursor: number | undefined = 0;
    do { const page: { body: string; nextCursor?: number } = await client.call("codeflow_get_artifact", { runId, artifactId: result.id, sha256: result.sha256, cursor }); process.stdout.write(page.body); cursor = page.nextCursor; } while (cursor !== undefined);
    process.stdout.write("\n");
  } finally { await client.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === (await import("node:url")).fileURLToPath(import.meta.url)) launchCli().catch(error => { console.error(`Code Flow: ${error.message}`); process.exitCode = 1; });
