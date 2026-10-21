import { discoverModels } from "./model-discovery.js";
import { managedPermissionProblem } from "./managed-permissions.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { codexTransport } from "../config.js";
import { logWarn } from "../log.js";
import type { AgentAdapter, AgentEvent, ErrorKind, ModelCatalog, ModelInfo, RunOptions, RunResult } from "./types.js";
import { runAppServerTurn } from "./codex-app-server.js";
import { classifyError, cliErrorLine, resetFromText } from "./errors.js";
import { captureOutput, commandExists, describeFailure, processErrorKind, startJsonlProcess, stringify, truncate, unknownEvents, type ProcessOutcome } from "./process.js";
import { adapterTeamCapabilities, prepareTeamTools } from "./team-tools.js";

/**
 * Codex, through `codex app-server` (JSON-RPC over stdio) when the installed Codex has it, so a
 * message you send reaches a turn while it runs; otherwise through `codex exec --json`, one
 * process per turn (CODEFLOW_CODEX_TRANSPORT picks one explicitly). Both report the same
 * thread/turn/item events, handled once below.
 * Uses whatever login the local `codex` binary already has (ChatGPT plan or API key).
 * Codex's own sandbox enforces the access mode: read-only or workspace-write (or no sandbox
 * at all, danger-full-access, when the run has full access).
 */

/**
 * Set when "auto" found that this Codex can't serve app-server turns (no such subcommand, or a
 * protocol this client doesn't speak): turns use exec until it's checked again, RECHECK_MS later,
 * so upgrading Codex doesn't need a restart. A slow or failed start doesn't count.
 */
export const appServerCheck: { missing?: { reason: string; at: number } } = {};
const RECHECK_MS = 10 * 60_000;

export const codexAdapter: AgentAdapter = {
  id: "codex",
  discoverModels: context => discoverModels("codex", context),
  displayName: "Codex",
  binary: "codex",
  available: () => commandExists("codex"),

  async catalog(): Promise<ModelCatalog> {
    const raw = JSON.parse(await captureOutput("codex", ["debug", "models"]));
    const models: ModelInfo[] = (raw.models ?? [])
      .filter((m: any) => m.slug && m.visibility !== "hide")
      .sort((a: any, b: any) => (a.priority ?? 999) - (b.priority ?? 999))
      .map((m: any) => ({
        id: m.slug,
        label: m.display_name ?? m.slug,
        efforts: (m.supported_reasoning_levels ?? []).map((l: any) => l.effort).filter(Boolean),
        defaultEffort: m.default_reasoning_level,
      }));
    const config = await readFile(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml"), "utf8").catch(() => "");
    const efforts = [...new Set(models.flatMap((m) => m.efforts ?? []))];
    return {
      models,
      efforts: efforts.length ? efforts : ["low", "medium", "high"],
      defaultModel: topLevelTomlString(config, "model"),
      defaultEffort: topLevelTomlString(config, "model_reasoning_effort"),
      allowCustom: true,
    };
  },

  async run(opts: RunOptions, onEvent: (e: AgentEvent) => void): Promise<RunResult> {
    const permissionProblem = await managedPermissionProblem("codex", opts);
    if (permissionProblem) return permissionProblem;
    const supportsTools = !opts.agentContainer && opts.teamTools && (await adapterTeamCapabilities("codex")).scopedTools === "tested";
    const teamTools = supportsTools ? await prepareTeamTools(opts.teamTools!) : undefined;
    if (opts.agentContainer) onEvent({ kind: "status", text: `Codex runs in Docker image ${opts.agentContainer.image}. Live team tools are unavailable in containers; use structured outcomes and next-turn replies.` });
    else if (opts.teamTools && !teamTools) onEvent({ kind: "status", text: "This Codex CLI has no verified per-turn team tools; use structured outcomes and next-turn replies." });
    try {
    const sandbox = opts.mode === "read" ? "read-only" : opts.trust === "full" ? "danger-full-access" : "workspace-write";
    // Codex sandboxes writes to the worktree unless the run has full access; "trusted" adds network access.
    const network = opts.permissions && sandbox !== "danger-full-access" ? ["-c", `sandbox_workspace_write.network_access=${opts.permissions.commandNetwork === "allowed"}`] : opts.mode === "write" && opts.trust === "trusted" ? ["-c", "sandbox_workspace_write.network_access=true"] : [];
    const managedSandbox = opts.permissions && sandbox !== "danger-full-access"
      ? ["-c", "sandbox_workspace_write.writable_roots=[]", ...(opts.permissions.required.includes("workspace-writes") ? ["-c", "sandbox_workspace_write.exclude_slash_tmp=true", "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true"] : [])]
      : [];
    const teamConfig = [...(teamTools?.codexConfig ?? []), ...(opts.questionProtocol === "structured" || opts.permissions?.nativeDelegation === false ? ["-c", "agents.enabled=false", "-c", "features.multi_agent=false", "-c", "features.multi_agent_v2.enabled=false", "-c", "features.hooks=false"] : [])];
    const transport = codexTransport();

    // Only a thread Codex confirms in this turn: a resume that failed must not hand back its id.
    let sessionId: string | undefined;
    let finalText = "";
    let turnError: string | undefined;
    /** The kind app-server gave a failure (from Codex's codexErrorInfo), when it gave one. */
    let turnErrorKind: ErrorKind | undefined;
    /** An `error` event isn't fatal by itself (Codex reports retries this way); it explains a failure. */
    let lastError: string | undefined;
    let lastErrorKind: ErrorKind | undefined;
    let completed = false;
    /** Called when the turn's outcome is known, so a CLI that then hangs is stopped (exec only). */
    let resultSeen = () => {};
    const unknown = unknownEvents("codex");
    /** Items already counted as unknown: one item's started, updated and completed events count once. */
    const unknownItems = new Set<string>();
    const unknownItem = (type: string, id?: string) => {
      if (id && unknownItems.has(id)) return;
      if (id) unknownItems.add(id);
      unknown.add(type);
    };

    const handle = (msg: any) => {
      switch (msg.type) {
        case "thread.started":
          if (!msg.thread_id) break;
          sessionId = msg.thread_id;
          onEvent({ kind: "session", sessionId: msg.thread_id });
          break;

        case "turn.started":
          break;

        case "item.started":
        case "item.updated":
        case "item.completed":
          handleItem(msg.type, msg.item, onEvent, (text) => (finalText = text), unknownItem);
          break;

        case "turn.completed": {
          completed = true;
          resultSeen();
          const cached = msg.usage?.cached_input_tokens ?? 0;
          onEvent({
            kind: "usage",
            // Codex counts cached input inside input_tokens.
            inputTokens: msg.usage?.input_tokens !== undefined ? Math.max(0, msg.usage.input_tokens - cached) : undefined,
            outputTokens: msg.usage?.output_tokens,
            cacheReadTokens: cached || undefined,
          });
          break;
        }

        case "turn.failed":
          resultSeen();
          turnError = msg.error?.message ?? lastError ?? "Codex turn failed";
          turnErrorKind = msg.error?.kind ?? (msg.error?.message ? undefined : lastErrorKind);
          break;

        case "error":
          lastError = msg.message ?? stringify(msg);
          lastErrorKind = msg.kind;
          onEvent({ kind: "status", text: `Codex: ${lastError}` });
          break;

        // A notification app-server sent that its client doesn't know (codex-app-server.ts).
        case "unrecognized":
          unknown.add(msg.name);
          break;

        default:
          unknown.add(msg.type);
      }
    };
    const onText = (line: string) => onEvent({ kind: "status", text: line });

    let outcome: ProcessOutcome | undefined;
    let schemaFile: string | undefined;
    const missing = appServerCheck.missing && Date.now() - appServerCheck.missing.at < RECHECK_MS ? appServerCheck.missing : undefined;
    if (transport === "app-server" || (transport === "auto" && !missing)) {
      const served = await runAppServerTurn({
        prompt: opts.prompt,
        cwd: opts.cwd,
        sandbox,
        resumeThreadId: opts.resumeSessionId,
        model: opts.model,
        effort: opts.effort,
        outputSchema: opts.jsonSchema,
        questionProtocol: opts.questionProtocol,
        config: [...network, ...teamConfig, ...managedSandbox],
        threadConfig: { ...teamTools?.codexThreadConfig, ...Object.fromEntries([...network, ...teamConfig.filter((_,i)=>!teamTools || i>=teamTools.codexConfig.length), ...managedSandbox].filter(v=>v!=="-c").map(v=>{const split=v.indexOf("="); return [v.slice(0,split),JSON.parse(v.slice(split+1))];})) },
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
        idleTimeoutMs: opts.idleTimeoutMs,
        onMessage: handle,
        onText,
        onSteerable: opts.onSteerable,
        interactiveApprovals: opts.interactiveApprovals,
        onApproval: opts.onApproval,
        agentContainer: opts.agentContainer,
      });
      if (!("unavailable" in served)) {
        outcome = served;
        appServerCheck.missing = undefined;
      } else if (transport === "app-server") {
        const error = `codex app-server isn't available (${served.unavailable}); unset CODEFLOW_CODEX_TRANSPORT to fall back to codex exec`;
        onEvent({ kind: "error", message: error });
        return { ok: false, finalText, error, errorKind: "cli_incompatible" };
      } else {
        if (!appServerCheck.missing) logWarn("codex app-server isn't available; using codex exec", { reason: served.unavailable });
        appServerCheck.missing = { reason: served.unavailable, at: Date.now() };
        sessionId = undefined;
        onEvent({ kind: "status", text: `codex app-server isn't available (${served.unavailable.split("\n")[0]}); using codex exec — your messages wait for the next turn` });
      }
    }

    if (!outcome) {
      if (opts.permissions?.toolApprovals) return { ok: false, finalText: "", error: "This run requires interactive approvals; Codex exec cannot preserve them. Use an available app-server transport.", errorKind: "cli_incompatible" };
      if (opts.interactiveApprovals) onEvent({ kind: "status", text: "Native tool approvals require Codex app-server; this exec turn remains headless." });
      // `-c sandbox_mode=` works for both `exec` and `exec resume` (resume has no -s flag).
      const common = ["--json", "--skip-git-repo-check", ...(opts.permissions ? ["-c", 'approval_policy="never"'] : []), "-c", `sandbox_mode="${sandbox}"`, ...network, ...teamConfig, ...managedSandbox];
      if (opts.model) common.push("-m", opts.model);
      if (opts.effort) common.push("-c", `model_reasoning_effort="${opts.effort}"`);
      schemaFile = opts.jsonSchema ? await writeSchemaFile(opts.jsonSchema) : undefined;
      if (schemaFile) common.push("--output-schema", schemaFile);
      // "-" reads the prompt from stdin, so its size isn't limited by argv.
      const args = opts.resumeSessionId
        ? ["exec", "resume", ...common, opts.resumeSessionId, "-"]
        : ["exec", ...common, "-C", opts.cwd, "-"];
      const proc = startJsonlProcess({
        command: "codex",
        args,
        input: opts.prompt,
        cwd: opts.cwd,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
        idleTimeoutMs: opts.idleTimeoutMs,
        onText,
        onJson: handle,
        agentContainer: opts.agentContainer ? { config: opts.agentContainer, mode: opts.mode, readOnly: schemaFile ? [schemaFile] : undefined } : undefined,
      });
      resultSeen = () => proc.resultSeen();
      outcome = await proc.outcome;
    }

    if (schemaFile) await rm(dirname(schemaFile), { recursive: true, force: true }).catch(() => undefined);
    const unknownCount = unknown.count;
    const drift = unknown.report();
    if (drift) onEvent({ kind: "status", text: drift });
    // After turn.completed, how the process ended (a hang on shutdown, a non-zero exit) doesn't matter.
    if (!completed || turnError || outcome.aborted) {
      const stopped = processErrorKind(outcome);
      const said = turnError ?? (stopped ? undefined : lastError);
      const error = said ?? describeFailure("codex", outcome);
      // Codex's own error info first, then what it said failed. Only a run that never got going
      // (a resume of a thread that's gone, an unknown flag) is read from stderr, and only Codex's
      // own error line there: hooks and MCP servers print to it too.
      const stderrLine = cliErrorLine(outcome.stderr);
      const fromText = classifyError(said);
      const errorKind: ErrorKind =
        stopped ?? (turnError ? turnErrorKind : lastErrorKind) ?? (turnError || fromText !== "other" ? fromText : classifyError(stderrLine));
      const resetsAt = errorKind === "usage_limit" ? (resetFromText(said) ?? (turnError ? undefined : resetFromText(stderrLine))) : undefined;
      onEvent({ kind: "error", message: error });
      return {
        ok: false,
        finalText,
        sessionId: errorKind === "session_not_found" ? undefined : sessionId,
        error,
        errorKind,
        ...(resetsAt && { resetsAt }),
      };
    }
    // A finished turn with no answer at all is one the agent ended without a word, unless Codex
    // printed things code-flow doesn't know: then its answer was most likely among them (a renamed
    // event or field), and an empty "success" would hand the next step nothing without saying so.
    if (!finalText.trim() && unknownCount) {
      const error = "Codex finished the turn, but code-flow didn't recognise its output, so its answer is missing. Update codex-cli or code-flow.";
      onEvent({ kind: "error", message: error });
      return { ok: false, finalText, sessionId, error, errorKind: "cli_incompatible" };
    }
    let structured: unknown;
    if (opts.jsonSchema) {
      try {
        structured = JSON.parse(finalText);
      } catch {
        // not valid JSON; the caller falls back to extracting it from the text
      }
    }
    return { ok: true, finalText, sessionId, structured };
    } finally { await teamTools?.cleanup(); }
  },
};

async function writeSchemaFile(schema: object): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codeflow-schema-"));
  const file = join(dir, "schema.json");
  await writeFile(file, JSON.stringify(schema));
  return file;
}

/** `key = "value"` from the top of a TOML file (before the first [table]). */
function topLevelTomlString(toml: string, key: string): string | undefined {
  const top = toml.split(/^\s*\[/m)[0] ?? "";
  return top.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
}

function handleItem(
  phase: string,
  item: any,
  onEvent: (e: AgentEvent) => void,
  setFinal: (text: string) => void,
  unknown: (type: string, id?: string) => void,
) {
  if (!item) return;
  const done = phase === "item.completed";

  switch (item.type) {
    case "agent_message":
      if (done && item.text) {
        setFinal(item.text);
        onEvent({ kind: "text", text: item.text });
      } else if (done && typeof item.text !== "string") {
        unknown("agent_message without text", item.id); // its answer moved to a field code-flow doesn't read
      }
      break;

    case "reasoning":
      if (done && item.text) onEvent({ kind: "thinking", text: item.text });
      break;

    case "command_execution":
      if (phase === "item.started") {
        onEvent({ kind: "tool_call", callId: item.id, name: "shell", input: item.command });
      } else if (done) {
        onEvent({
          kind: "tool_result",
          callId: item.id,
          output: truncate(item.aggregated_output ?? ""),
          isError: (item.exit_code !== 0 && item.exit_code != null) || item.status === "declined",
        });
      }
      break;

    case "file_change":
      if (done) {
        const changes = (item.changes ?? []).map((c: any) => `${c.kind} ${c.path}`).join("\n");
        onEvent({ kind: "tool_call", callId: item.id, name: "file_change", input: changes });
        onEvent({ kind: "tool_result", callId: item.id, output: item.status ?? "", isError: item.status === "failed" || item.status === "declined" });
      }
      break;

    case "mcp_tool_call":
      if (phase === "item.started") {
        onEvent({
          kind: "tool_call",
          callId: item.id,
          name: `${item.server}.${item.tool}`,
          input: truncate(stringify(item.arguments ?? ""), 2_000),
        });
      } else if (done) {
        onEvent({
          kind: "tool_result",
          callId: item.id,
          output: truncate(stringify(item.result ?? item.error ?? "")),
          isError: item.status === "failed",
        });
      }
      break;

    case "web_search":
      if (done) onEvent({ kind: "status", text: `web search: ${item.query ?? ""}` });
      break;

    case "todo_list":
      if (done) {
        const todos = (item.items ?? []).map((t: any) => `${t.completed ? "✓" : "○"} ${t.text}`).join("\n");
        onEvent({ kind: "status", text: todos });
      }
      break;

    case "error":
      if (done) onEvent({ kind: "error", message: item.message ?? "error" });
      break;

    default:
      // app-server marks the items its translation doesn't know ("unrecognized", with their own type).
      unknown(`${item.type === "unrecognized" ? (item.name ?? "(no type)") : item.type} item`, item.id);
  }
}
