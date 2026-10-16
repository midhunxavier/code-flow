import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { codexTransport } from "../config.js";
import type { AgentAdapter, AgentEvent, ModelCatalog, ModelInfo, RunOptions, RunResult } from "./types.js";
import { runAppServerTurn } from "./codex-app-server.js";
import { captureOutput, commandExists, describeFailure, runJsonlProcess, stringify, truncate, type ProcessOutcome } from "./process.js";

/**
 * Codex, through `codex app-server` (JSON-RPC over stdio) when the installed Codex has it, so a
 * message you send reaches a turn while it runs; otherwise through `codex exec --json`, one
 * process per turn (CODEFLOW_CODEX_TRANSPORT picks one explicitly). Both report the same
 * thread/turn/item events, handled once below.
 * Uses whatever login the local `codex` binary already has (ChatGPT plan or API key).
 * Codex's own sandbox enforces the access mode: read-only or workspace-write (or no sandbox
 * at all, danger-full-access, when the run has full access).
 */

/** Set once "auto" found that this Codex can't serve app-server turns: later turns use exec. */
let appServerMissing: string | undefined;

export const codexAdapter: AgentAdapter = {
  id: "codex",
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
    const sandbox = opts.mode === "read" ? "read-only" : opts.trust === "full" ? "danger-full-access" : "workspace-write";
    // Codex sandboxes writes to the worktree unless the run has full access; "trusted" adds network access.
    const network = opts.mode === "write" && opts.trust === "trusted" ? ["-c", "sandbox_workspace_write.network_access=true"] : [];
    const transport = codexTransport();

    let sessionId = opts.resumeSessionId;
    let finalText = "";
    let turnError: string | undefined;
    /** An `error` event isn't fatal by itself (Codex reports retries this way); it explains a failure. */
    let lastError: string | undefined;
    let completed = false;

    const handle = (msg: any) => {
      switch (msg.type) {
        case "thread.started":
          sessionId = msg.thread_id;
          onEvent({ kind: "session", sessionId: msg.thread_id });
          break;

        case "item.started":
        case "item.updated":
        case "item.completed":
          handleItem(msg.type, msg.item, onEvent, (text) => (finalText = text));
          break;

        case "turn.completed": {
          completed = true;
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
          turnError = msg.error?.message ?? lastError ?? "Codex turn failed";
          break;

        case "error":
          lastError = msg.message ?? stringify(msg);
          onEvent({ kind: "status", text: `Codex: ${lastError}` });
          break;
      }
    };
    const onText = (line: string) => onEvent({ kind: "status", text: line });

    let outcome: ProcessOutcome | undefined;
    let schemaFile: string | undefined;
    if (transport === "app-server" || (transport === "auto" && !appServerMissing)) {
      const served = await runAppServerTurn({
        prompt: opts.prompt,
        cwd: opts.cwd,
        sandbox,
        resumeThreadId: opts.resumeSessionId,
        model: opts.model,
        effort: opts.effort,
        outputSchema: opts.jsonSchema,
        config: network,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
        onMessage: handle,
        onText,
        onSteerable: opts.onSteerable,
      });
      if (!("unavailable" in served)) outcome = served;
      else if (transport === "app-server") {
        const error = `codex app-server isn't available (${served.unavailable}); unset CODEFLOW_CODEX_TRANSPORT to fall back to codex exec`;
        onEvent({ kind: "error", message: error });
        return { ok: false, finalText, sessionId, error };
      } else {
        appServerMissing = served.unavailable;
        onEvent({ kind: "status", text: `codex app-server isn't available (${served.unavailable.split("\n")[0]}); using codex exec — your messages wait for the next turn` });
      }
    }

    if (!outcome) {
      // `-c sandbox_mode=` works for both `exec` and `exec resume` (resume has no -s flag).
      const common = ["--json", "--skip-git-repo-check", "-c", `sandbox_mode="${sandbox}"`, ...network];
      if (opts.model) common.push("-m", opts.model);
      if (opts.effort) common.push("-c", `model_reasoning_effort="${opts.effort}"`);
      schemaFile = opts.jsonSchema ? await writeSchemaFile(opts.jsonSchema) : undefined;
      if (schemaFile) common.push("--output-schema", schemaFile);
      // "-" reads the prompt from stdin, so its size isn't limited by argv.
      const args = opts.resumeSessionId
        ? ["exec", "resume", ...common, opts.resumeSessionId, "-"]
        : ["exec", ...common, "-C", opts.cwd, "-"];
      outcome = await runJsonlProcess({
        command: "codex",
        args,
        input: opts.prompt,
        cwd: opts.cwd,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
        onText,
        onJson: handle,
      });
    }

    if (schemaFile) await rm(dirname(schemaFile), { recursive: true, force: true }).catch(() => undefined);
    if (!completed || turnError || outcome.exitCode !== 0) {
      const error = turnError ?? (outcome.aborted || outcome.timedOut ? undefined : lastError) ?? describeFailure("codex", outcome);
      onEvent({ kind: "error", message: error });
      return { ok: false, finalText, sessionId, error };
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
) {
  if (!item) return;
  const done = phase === "item.completed";

  switch (item.type) {
    case "agent_message":
      if (done && item.text) {
        setFinal(item.text);
        onEvent({ kind: "text", text: item.text });
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
        onEvent({ kind: "tool_result", callId: item.id, output: item.status ?? "", isError: item.status === "failed" });
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
  }
}
