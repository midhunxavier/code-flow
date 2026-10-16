import type { AgentAdapter, AgentEvent, ModelCatalog, RunOptions, RunResult } from "./types.js";
import { captureOutput, commandExists, describeFailure, runJsonlProcess, stringify, truncate } from "./process.js";

/**
 * Google Antigravity CLI via `agy -p --output-format stream-json`.
 * Since 2026-06-18 this, not Gemini CLI, is the CLI that serves Google AI Pro/Ultra plans.
 * Uses the cached login from an interactive `agy` session.
 *
 * Verified against agy 1.3.5. Behaviour that shapes this adapter:
 *  - Headless mode cannot answer approval prompts. A denied tool does not let the agent
 *    carry on: the turn ends with an empty response. So by default every run uses
 *    --dangerously-skip-permissions together with --sandbox, which confines writes to the
 *    cwd (a disposable worktree). Read-only steps are enforced by the engine, which reverts
 *    anything a read step changes. Set CODEFLOW_AGY_SKIP_PERMISSIONS=0 to rely on
 *    permissions.allow in ~/.gemini/antigravity-cli/settings.json instead.
 *    Full access (write steps only) drops --sandbox, so writes aren't confined either.
 *  - Older versions printed nothing when stdout is a pipe; that surfaces as a clear error.
 *  - There is no --cwd flag, so the process is started inside the target directory.
 */

// agy's --sandbox blocks reads of ~/.gitconfig and ~/.config/git/ignore, which makes every
// git command the agent runs fail. Point git at empty global config inside the worktree.
function sandboxGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.excludesFile",
    GIT_CONFIG_VALUE_0: "/dev/null",
  };
}

function skipPermissions(): boolean {
  return process.env.CODEFLOW_AGY_SKIP_PERMISSIONS !== "0";
}

export const agyAdapter: AgentAdapter = {
  id: "agy",
  displayName: "Antigravity CLI",
  binary: "agy",
  available: () => commandExists("agy"),

  async catalog(): Promise<ModelCatalog> {
    // `agy models` prints "<slug>\t<display name>" per model after a "Fetching…" line.
    const out = await captureOutput("agy", ["models"], 45_000);
    const models = out
      .split("\n")
      .map((line) => line.split("\t"))
      .filter((cols) => cols.length >= 2 && cols[0]!.trim())
      .map(([id, label]) => ({ id: id!.trim(), label: label!.trim() }));
    return { models, efforts: ["low", "medium", "high", "xhigh", "max"], allowCustom: true };
  },

  async run(opts: RunOptions, onEvent: (e: AgentEvent) => void): Promise<RunResult> {
    const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
    // Prompt as one stream-json message on stdin (-p would need it as an argument).
    const args = [
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--print-timeout", `${Math.ceil(timeoutMs / 60_000)}m`,
    ];
    const sandboxed = !(opts.mode === "write" && opts.trust === "full");
    if (sandboxed) args.push("--sandbox");
    if (opts.resumeSessionId) args.push("--conversation", opts.resumeSessionId);
    if (opts.model) args.push("--model", opts.model);
    if (opts.effort) args.push("--effort", opts.effort);
    if (opts.jsonSchema) args.push("--json-schema", JSON.stringify(opts.jsonSchema));
    if (skipPermissions()) args.push("--dangerously-skip-permissions");

    let sessionId = opts.resumeSessionId;
    let finalText = "";
    let streamedText = "";
    let resultError: string | undefined;
    let sawResult = false;
    let structured: unknown;
    const openTools = new Set<string>();

    const outcome = await runJsonlProcess({
      command: "agy",
      args,
      input: `${JSON.stringify({ event: "user", message: { content: opts.prompt } })}\n`,
      cwd: opts.cwd,
      env: sandboxed ? sandboxGitEnv() : process.env,
      signal: opts.signal,
      timeoutMs: timeoutMs + 30_000,
      onText: (line) => onEvent({ kind: "status", text: line }),
      onJson: (msg) => {
        switch (msg.event) {
          case "init":
            if (msg.conversation_id) {
              sessionId = msg.conversation_id;
              onEvent({ kind: "session", sessionId: msg.conversation_id });
            }
            break;

          case "step_update": {
            const step = msg.step_update ?? {};
            if (step.text_delta) {
              streamedText += step.text_delta;
              onEvent({ kind: "text", text: step.text_delta });
            }
            if (step.step_type === "tool" && step.tool_name) {
              const callId = `${step.conversation_id ?? ""}:${step.step_index ?? step.tool_name}`;
              if (step.state === "ACTIVE" && !openTools.has(callId)) {
                openTools.add(callId);
                onEvent({
                  kind: "tool_call",
                  callId,
                  name: step.tool_name,
                  input: truncate(stringify(step.tool_info?.parameters ?? ""), 2_000),
                });
              } else if (step.state === "DONE" || step.state === "ERROR") {
                if (!openTools.has(callId)) {
                  onEvent({
                    kind: "tool_call",
                    callId,
                    name: step.tool_name,
                    input: truncate(stringify(step.tool_info?.parameters ?? ""), 2_000),
                  });
                }
                openTools.delete(callId);
                const error = step.tool_info?.error?.message;
                onEvent({
                  kind: "tool_result",
                  callId,
                  output: truncate(error ?? stringify(step.tool_info?.output ?? step.tool_info?.result ?? "done")),
                  isError: step.state === "ERROR",
                });
              }
            }
            break;
          }

          case "result": {
            sawResult = true;
            const result = msg.result ?? {};
            finalText = result.response ?? streamedText;
            if (result.conversation_id) sessionId = result.conversation_id;
            if (result.structured_output !== undefined) structured = result.structured_output;
            if (result.status && result.status !== "SUCCESS") {
              resultError = result.error ?? `agy finished with status ${result.status}`;
            } else if (!finalText.trim() && result.denied_actions?.length) {
              const denied = result.denied_actions.map((d: any) => d.display_name ?? d.action).join(", ");
              resultError = `agy stopped after headless mode denied: ${denied}. Allow it in permissions.allow or enable CODEFLOW_AGY_SKIP_PERMISSIONS.`;
            }
            onEvent({
              kind: "usage",
              inputTokens: result.usage?.input_tokens,
              outputTokens: result.usage?.output_tokens,
              cacheReadTokens: result.usage?.cached_input_tokens ?? result.usage?.cache_read_input_tokens,
            });
            break;
          }
        }
      },
    });

    if (!sawResult && outcome.exitCode === 0 && !outcome.aborted && !outcome.timedOut) {
      resultError =
        "agy exited without a result event. Some agy versions print nothing when stdout is a pipe; " +
        "update agy, and make sure you have logged in once with an interactive `agy` session.";
    }
    if (!sawResult || resultError || outcome.exitCode !== 0) {
      const error = resultError ?? describeFailure("agy", outcome);
      onEvent({ kind: "error", message: error });
      return { ok: false, finalText: finalText || streamedText, sessionId, error };
    }
    return { ok: true, finalText, sessionId, structured };
  },
};
