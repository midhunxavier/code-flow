import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentAdapter, AgentEvent, ModelCatalog, ModelInfo, RunOptions, RunResult } from "./types.js";
import { captureOutput, commandExists, describeFailure, runJsonlProcess, stringify, truncate } from "./process.js";

/**
 * Codex via `codex exec --json` (JSONL thread/turn/item events).
 * Uses whatever login the local `codex` binary already has (ChatGPT plan or API key).
 * Codex's own sandbox enforces the access mode: read-only or workspace-write.
 *
 * `codex app-server` (JSON-RPC) is the richer option for interactive approvals and
 * steering mid-turn; `exec` keeps this MVP simple.
 */

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
    const sandbox = opts.mode === "write" ? "workspace-write" : "read-only";
    // `-c sandbox_mode=` works for both `exec` and `exec resume` (resume has no -s flag).
    const common = ["--json", "--skip-git-repo-check", "-c", `sandbox_mode="${sandbox}"`];
    if (opts.model) common.push("-m", opts.model);
    if (opts.effort) common.push("-c", `model_reasoning_effort="${opts.effort}"`);
    const schemaFile = opts.jsonSchema ? await writeSchemaFile(opts.jsonSchema) : undefined;
    if (schemaFile) common.push("--output-schema", schemaFile);

    // "-" reads the prompt from stdin, so its size isn't limited by argv.
    const args = opts.resumeSessionId
      ? ["exec", "resume", ...common, opts.resumeSessionId, "-"]
      : ["exec", ...common, "-C", opts.cwd, "-"];

    let sessionId = opts.resumeSessionId;
    let finalText = "";
    let turnError: string | undefined;
    let completed = false;

    const outcome = await runJsonlProcess({
      command: "codex",
      args,
      input: opts.prompt,
      cwd: opts.cwd,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      onText: (line) => onEvent({ kind: "status", text: line }),
      onJson: (msg) => {
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

          case "turn.completed":
            completed = true;
            onEvent({
              kind: "usage",
              inputTokens: msg.usage?.input_tokens,
              outputTokens: msg.usage?.output_tokens,
            });
            break;

          case "turn.failed":
            turnError = msg.error?.message ?? "Codex turn failed";
            break;

          case "error":
            turnError = msg.message ?? stringify(msg);
            break;
        }
      },
    });

    if (schemaFile) await rm(dirname(schemaFile), { recursive: true, force: true }).catch(() => undefined);
    if (!completed || turnError || outcome.exitCode !== 0) {
      const error = turnError ?? describeFailure("codex", outcome);
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
          isError: item.exit_code !== 0 && item.exit_code != null,
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
