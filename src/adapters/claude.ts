import type { AgentAdapter, AgentEvent, ModelCatalog, RunOptions, RunResult } from "./types.js";
import { commandExists, describeFailure, runJsonlProcess, stringify, truncate } from "./process.js";

/**
 * Claude Code via `claude -p --output-format stream-json`.
 * Uses whatever login the local `claude` binary already has (Pro/Max or API key).
 */

const READ_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff *)",
  "Bash(git log *)",
  "Bash(git show *)",
  "Bash(git status *)",
  "Bash(ls *)",
];

// Headless runs cannot answer permission prompts, so anything not pre-allowed is denied.
// Edits are auto-accepted (the cwd is a disposable worktree); shell access is limited to
// common build/test commands. Override with CODEFLOW_CLAUDE_WRITE_TOOLS (comma-separated).
const DEFAULT_WRITE_TOOLS = [
  ...READ_TOOLS,
  "Bash(git add *)",
  "Bash(npm *)",
  "Bash(npx *)",
  "Bash(node *)",
  "Bash(pnpm *)",
  "Bash(yarn *)",
  "Bash(python3 *)",
  "Bash(pytest *)",
  "Bash(cargo *)",
  "Bash(go *)",
  "Bash(make *)",
  "Bash(mkdir *)",
];

function writeTools(): string[] {
  const env = process.env.CODEFLOW_CLAUDE_WRITE_TOOLS;
  return env ? env.split(",").map((t) => t.trim()).filter(Boolean) : DEFAULT_WRITE_TOOLS;
}

export const claudeAdapter: AgentAdapter = {
  id: "claude",
  displayName: "Claude Code",
  binary: "claude",
  available: () => commandExists("claude"),

  // The CLI has no model-listing command; it accepts these aliases (always the latest
  // model of each family) or any full model name.
  async catalog(): Promise<ModelCatalog> {
    return {
      models: [
        { id: "fable", label: "Fable (latest)" },
        { id: "opus", label: "Opus (latest)" },
        { id: "sonnet", label: "Sonnet (latest)" },
        { id: "haiku", label: "Haiku (latest)" },
      ],
      efforts: ["low", "medium", "high", "xhigh", "max"],
      allowCustom: true,
    };
  },

  async run(opts: RunOptions, onEvent: (e: AgentEvent) => void): Promise<RunResult> {
    // The prompt goes right after -p: --allowedTools is variadic and would swallow it.
    const args = ["-p", opts.prompt, "--output-format", "stream-json", "--verbose"];
    if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
    if (opts.model) args.push("--model", opts.model);
    if (opts.effort) args.push("--effort", opts.effort);
    if (opts.jsonSchema) args.push("--json-schema", JSON.stringify(opts.jsonSchema));
    if (opts.mode === "write") {
      args.push("--permission-mode", "acceptEdits", "--allowedTools", writeTools().join(","));
    } else {
      args.push(
        "--permission-mode", "default",
        "--disallowedTools", "Edit,Write,NotebookEdit",
        "--allowedTools", READ_TOOLS.join(","),
      );
    }

    let sessionId = opts.resumeSessionId;
    let finalText = "";
    let lastAssistantText = "";
    let resultError: string | undefined;
    let sawResult = false;
    let structured: unknown;

    const outcome = await runJsonlProcess({
      command: "claude",
      args,
      cwd: opts.cwd,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      onText: (line) => onEvent({ kind: "status", text: line }),
      onJson: (msg) => {
        switch (msg.type) {
          case "system":
            if (msg.subtype === "init" && msg.session_id) {
              sessionId = msg.session_id;
              onEvent({ kind: "session", sessionId: msg.session_id });
            }
            break;

          case "assistant":
            for (const block of msg.message?.content ?? []) {
              if (block.type === "text" && block.text) {
                lastAssistantText = block.text;
                onEvent({ kind: "text", text: block.text });
              } else if (block.type === "thinking" && block.thinking) {
                onEvent({ kind: "thinking", text: block.thinking });
              } else if (block.type === "tool_use") {
                onEvent({
                  kind: "tool_call",
                  callId: block.id,
                  name: block.name,
                  input: truncate(stringify(block.input), 2_000),
                });
              }
            }
            break;

          case "user":
            for (const block of msg.message?.content ?? []) {
              if (block.type !== "tool_result") continue;
              const output = Array.isArray(block.content)
                ? block.content.map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n")
                : stringify(block.content ?? "");
              onEvent({
                kind: "tool_result",
                callId: block.tool_use_id,
                output: truncate(output),
                isError: Boolean(block.is_error),
              });
            }
            break;

          case "rate_limit_event":
            if (msg.rate_limit_info?.status && msg.rate_limit_info.status !== "allowed") {
              onEvent({ kind: "status", text: `Claude rate limit: ${msg.rate_limit_info.status}` });
            }
            break;

          case "result":
            sawResult = true;
            finalText = typeof msg.result === "string" ? msg.result : lastAssistantText;
            if (msg.session_id) sessionId = msg.session_id;
            if (msg.structured_output !== undefined) structured = msg.structured_output;
            if (msg.is_error) resultError = finalText || msg.subtype || "Claude reported an error";
            onEvent({
              kind: "usage",
              inputTokens: msg.usage?.input_tokens,
              outputTokens: msg.usage?.output_tokens,
              costUsd: msg.total_cost_usd,
            });
            if (Array.isArray(msg.permission_denials) && msg.permission_denials.length) {
              const names = msg.permission_denials.map((d: any) => d.tool_name).join(", ");
              onEvent({ kind: "status", text: `Denied in headless mode: ${names}` });
            }
            break;
        }
      },
    });

    if (!sawResult || outcome.exitCode !== 0 || resultError) {
      const error = resultError ?? describeFailure("claude", outcome);
      onEvent({ kind: "error", message: error });
      return { ok: false, finalText: finalText || lastAssistantText, sessionId, error };
    }
    return { ok: true, finalText, sessionId, structured };
  },
};
