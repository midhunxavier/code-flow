import type { AgentAdapter, AgentEvent, RunOptions, RunResult } from "./types.js";
import { commandExists, describeFailure, runJsonlProcess, stringify, truncate } from "./process.js";

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

  async run(opts: RunOptions, onEvent: (e: AgentEvent) => void): Promise<RunResult> {
    const sandbox = opts.mode === "write" ? "workspace-write" : "read-only";
    // `-c sandbox_mode=` works for both `exec` and `exec resume` (resume has no -s flag).
    const common = ["--json", "--skip-git-repo-check", "-c", `sandbox_mode="${sandbox}"`];
    if (opts.model) common.push("-m", opts.model);

    const args = opts.resumeSessionId
      ? ["exec", "resume", ...common, opts.resumeSessionId, opts.prompt]
      : ["exec", ...common, "-C", opts.cwd, opts.prompt];

    let sessionId = opts.resumeSessionId;
    let finalText = "";
    let turnError: string | undefined;
    let completed = false;

    const outcome = await runJsonlProcess({
      command: "codex",
      args,
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

    if (!completed || turnError || outcome.exitCode !== 0) {
      const error = turnError ?? describeFailure("codex", outcome);
      onEvent({ kind: "error", message: error });
      return { ok: false, finalText, sessionId, error };
    }
    return { ok: true, finalText, sessionId };
  },
};

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
