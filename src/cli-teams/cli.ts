import { formatStatus } from "./presentation.js";
import { catalog } from "./providers.js";
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
  codeflow doctor [--catalog] [--json]
  codeflow mcp [--project-root PATH]
  codeflow approve PROPOSAL_ID --revision NUMBER
  codeflow open PROPOSAL_OR_RUN_ID
  codeflow status [RUN_ID] [--json]
  codeflow result RUN_ID [--json]
  codeflow pause|resume|cancel RUN_ID
  codeflow attach RUN_ID --connection CONNECTION_ID
  codeflow preferences [--provider claude|codex --model ID --effort VALUE] [--preferred-provider claude|codex] [--personal]
  codeflow uninstall --project

Use the codeflow skill in your Claude or Codex conversation to describe a task.
Teams and processes are generated for that task. No presets or saved teams.
Run approval uses your host's native confirmation form when available.
Browser or terminal approval is a fallback. Host reattachment requires an interactive terminal.
Existing bare codeflow and codeflow client commands are unchanged.
`;
export const CLI_COMMANDS = new Set(["open", "init", "doctor", "mcp", "approve", "status", "result", "pause", "resume", "cancel", "attach", "preferences", "uninstall"]);
export async function launchCli(args = process.argv.slice(2)) {
  const command = args.shift();
  if (!command || args.includes("--help")) { console.log(usage); return; }
  const option = (key: string) => { const index = args.indexOf(key); if (index < 0) return undefined; const value = args[index + 1]; if (!value || value.startsWith("--")) throw new Error(`Choose a value for ${key}`); return value; };
  const json = args.includes("--json");
  const valuedOptions = new Set(["--project-root", "--providers", "--revision", "--connection", "--provider", "--model", "--effort", "--preferred-provider"]);
  const positional = args.filter((a, i) => !a.startsWith("--") && !valuedOptions.has(args[i - 1] ?? ""));
  const root = resolve(option("--project-root") ?? process.cwd());
  const providers = async () => {
    const requested = option("--providers");
    if (requested) { const values = requested.split(","); if (!values.length || values.some(p => p !== "claude" && p !== "codex")) throw new Error("Choose --providers claude,codex or one provider"); return [...new Set(values)] as Provider[]; }
    const installed = await Promise.all((["claude", "codex"] as const).map(async p => await getAdapter(p).available() ? p : undefined));
    const chosen = installed.filter((p): p is Provider => !!p); if (!chosen.length) throw new Error("Install Claude Code or Codex, or explicitly choose --providers before connecting it later"); return chosen;
  };
  if (command === "init") {
    const result = await installProject(root, await providers(), args.includes("--dry-run"));
    console.log(json ? JSON.stringify(result, null, 2) : `${result.dryRun ? "Planned setup" : "Code Flow is configured"} for ${result.repo}\n${result.changes.length ? result.changes.map(c => `  ${c.path}`).join("\n") : "No configuration changes needed."}\nReconnect Claude or Codex to load the Code Flow tools and skill. No agent calls were made.`); return;
  }
  if (command === "uninstall") { if (!args.includes("--project")) throw new Error("Use uninstall --project to remove only this project's managed entries"); const result = await uninstallProject(root); console.log(json ? JSON.stringify(result, null, 2) : [`Removed ${result.removed.length} managed file(s); preserved ${result.preserved.length}.`, result.message].join("\n")); return; }
  if (command === "mcp") { await serveMcp(root); return; }
  if (command === "doctor") {
    const repo = await repoRoot(root);
    const installed = await Promise.all((["claude", "codex"] as const).map(async provider => {
      const available = await getAdapter(provider).available();
      let models: { state: string; count?: number; issue?: string } | undefined;
      if (available && args.includes("--catalog")) {
        try { const c = await catalog(provider, true); models = { state: "available", count: c.models.length }; }
        catch (error) { models = { state: "unavailable", issue: error instanceof Error ? error.message : "Catalog unavailable" }; }
      }
      return { provider, installed: available, authentication: "Not verified; catalog discovery is not an execution or permission probe.", catalog: models };
    }));
    const configuration = await installProject(root, installed.filter(p => p.installed).map(p => p.provider), true);
    const result = { repo, providers: installed, node: process.version, pendingFiles: configuration.changes.map(c => c.path), notes: ["No agent inference was performed.", "Project trust, authentication, and tool permissions must be verified in the native CLI."] };
    console.log(json ? JSON.stringify(result, null, 2) : [`Project: ${repo}`, ...installed.map(p => `${p.provider}: ${p.installed ? "CLI found" : "not installed; install this provider before assigning work"}${p.catalog ? ` · catalog ${p.catalog.state}${p.catalog.count !== undefined ? ` (${p.catalog.count} models)` : ""}${p.catalog.issue ? `: ${p.catalog.issue}` : ""}` : ""}`), configuration.changes.length ? "Setup needs updating: run codeflow init, then reconnect your CLI." : "Project setup is current.", "Authentication and execution permissions are not verified. Open each provider CLI and sign in before starting work.", "No agent calls were made. Use --catalog to check model discovery."].join("\n")); return;
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
    console.log(json ? JSON.stringify({ file, preferences: prefs, note: "Settings are validated against the actual catalog when a proposal is created." }, null, 2) : [`Preferences: ${file}`, `Preferred provider: ${prefs.preferredProvider ?? "not set"}`, ...Object.entries(prefs.providers ?? {}).map(([provider, value]) => `${provider}: ${value.model ?? "default model"} · ${value.effort ?? "default"} effort`), "Settings are validated when preparing an approach."].join("\n")); return;
  }
  if (!CLI_COMMANDS.has(command)) throw new Error(usage);
  if ((command === "approve" || command === "attach") && (!process.stdin.isTTY || !process.stdout.isTTY)) fail("acceptance_required", "Use your own interactive terminal; unattended approval is unavailable");
  if (command === "open" && !args[0]) throw new Error("Choose a proposal or run ID");
  const client = await connectRuntime(root);
  try {
    if (command === "open") {
      const result = await client.call("codeflow_open_task", { id: args[0] });
      console.log(`${result.opened ? "Opened in Code Flow" : "Open in Code Flow"}: ${result.workspace.url}`);
      if (!result.opened) console.log("No local browser opened. Use an authenticated browser on this computer; for SSH, forward the displayed port first.");
      return;
    }
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
    const runId = positional[0];
    if (command === "status" && !runId) {
      const recent = await client.call("codeflow_list_runs", { unfinishedOnly: args.includes("--unfinished") });
      console.log(json ? JSON.stringify(recent, null, 2) : recent.runs.length ? recent.runs.map((r: any) => `${r.task} · ${r.outcome ?? r.status}\n  codeflow status ${r.runId}`).join("\n") : "No Code Flow tasks found in this repository."); return;
    }
    if (!runId) throw new Error("Choose a run ID");
    if (["pause", "resume", "cancel"].includes(command)) { const result = await client.call("codeflow_control_run", { operationId: `${command}-${Date.now()}`, runId, action: command }); console.log(json ? JSON.stringify(result, null, 2) : result.message ?? `${command}: ${result.accepted ? "requested" : "not changed"}${result.pending ? "; waiting for the active step" : ""}`); return; }
    const run = await client.call("codeflow_get_run", { runId });
    if (command === "status") { console.log(json ? JSON.stringify(run, null, 2) : formatStatus(run)); return; }
    const result = run.result ?? run.artifacts.filter((a: any) => a.kind === "result").at(-1);
    if (!result) { console.log(json ? JSON.stringify({ ...run, message: "No final result yet." }, null, 2) : `${formatStatus(run)}\nNo final result yet.`); return; }
    let cursor: number | undefined = 0, body = "";
    do { const page: { body: string; nextCursor?: number } = await client.call("codeflow_get_artifact", { runId, artifactId: result.id, sha256: result.sha256, cursor }); if (json) body += page.body; else process.stdout.write(page.body); cursor = page.nextCursor; } while (cursor !== undefined);
    if (json) console.log(JSON.stringify({ ...run, body }, null, 2)); else process.stdout.write("\n");
  } finally { await client.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === (await import("node:url")).fileURLToPath(import.meta.url)) launchCli().catch(error => { console.error(`Code Flow: ${error.message}`); process.exitCode = 1; });
