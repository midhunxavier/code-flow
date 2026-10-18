import type { AgentAdapter, AgentEvent, ErrorKind, ModelCatalog, RunOptions, RunResult } from "./types.js";
import { classifyError, cliErrorLine, resetFromText } from "./errors.js";
import { captureOutput, commandExists, describeFailure, processErrorKind, startJsonlProcess, stringify, truncate, unknownEvents } from "./process.js";
import { STEP_TIMEOUT_MS } from "../config.js";
import { childEnv } from "../env.js";

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
    ...childEnv(),
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
    if (opts.agentContainer) onEvent({ kind: "status", text: `Antigravity runs in Docker image ${opts.agentContainer.image}. Team messages and memory are provided at turn boundaries.` });
    if (opts.teamTools) onEvent({ kind: "status", text: "Antigravity has no verified scoped per-turn tool configuration; team messages and memory are provided at turn boundaries." });
    // A NaN or missing timeout must not become "--print-timeout NaNm".
    const timeoutMs = typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : STEP_TIMEOUT_MS;
    // Prompt as one stream-json message on stdin (-p would need it as an argument).
    const args = [
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--print-timeout", `${Math.max(1, Math.ceil(timeoutMs / 60_000))}m`,
    ];
    const sandboxed = !(opts.mode === "write" && opts.trust === "full");
    if (sandboxed) args.push("--sandbox");
    if (opts.resumeSessionId) args.push("--conversation", opts.resumeSessionId);
    if (opts.model) args.push("--model", opts.model);
    if (opts.effort) args.push("--effort", opts.effort);
    if (opts.jsonSchema) args.push("--json-schema", JSON.stringify(opts.jsonSchema));
    if (skipPermissions()) args.push("--dangerously-skip-permissions");

    // Only a conversation agy confirms in this turn: a resume that failed must not hand back its id.
    let sessionId: string | undefined;
    let finalText = "";
    let streamedText = "";
    let resultError: string | undefined;
    /** What agy's result status says went wrong, when it says. */
    let statusKind: ErrorKind | undefined;
    let sawResult = false;
    let structured: unknown;
    const openTools = new Set<string>();
    const unknown = unknownEvents("agy");
    const unknownSteps = new Set<string>();

    const proc = startJsonlProcess({
      agentContainer: opts.agentContainer ? { config: opts.agentContainer, mode: opts.mode } : undefined,
      command: "agy",
      args,
      input: `${JSON.stringify({ event: "user", message: { content: opts.prompt } })}\n`,
      cwd: opts.cwd,
      // Without the sandbox the agent's commands use your git config, but never code-flow's own secrets.
      env: sandboxed ? sandboxGitEnv() : childEnv(),
      signal: opts.signal,
      timeoutMs: timeoutMs + 30_000,
      idleTimeoutMs: opts.idleTimeoutMs,
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
            if (!step.text_delta && step.step_type !== "tool" && step.step_type !== "agent_response") {
              // A step code-flow shows nothing of; counted once per step, not per update.
              const id = `${step.conversation_id ?? ""}:${step.step_index ?? step.step_type}`;
              if (!unknownSteps.has(id)) {
                unknownSteps.add(id);
                unknown.add(`${step.step_type ?? "(no type)"} step`);
              }
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
            proc.resultSeen();
            const result = msg.result ?? {};
            finalText = result.response ?? streamedText;
            if (result.conversation_id) sessionId = result.conversation_id;
            if (result.structured_output !== undefined) structured = result.structured_output;
            if (result.status && result.status !== "SUCCESS") {
              const detail = typeof result.error === "string" ? result.error : result.error?.message;
              resultError = detail ? `${detail} (agy status ${result.status})` : `agy finished with status ${result.status}`;
              statusKind = agyStatusKind(String(result.status), detail, !!opts.resumeSessionId);
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

          case "user": // the prompt, if agy echoes it
            break;

          default:
            unknown.add(msg.event ?? msg.type);
        }
      },
    });

    const outcome = await proc.outcome;
    const drift = unknown.report();
    if (drift) onEvent({ kind: "status", text: drift });

    // After a successful result, how the process ended (a hang on shutdown, a non-zero exit) doesn't matter.
    if (sawResult && !resultError && !outcome.aborted) return { ok: true, finalText, sessionId, structured };

    const stopped = processErrorKind(outcome);
    if (!sawResult && outcome.exitCode === 0 && !stopped) {
      resultError =
        "agy exited without a result event. Some agy versions print nothing when stdout is a pipe; " +
        "update agy, and make sure you have logged in once with an interactive `agy` session.";
    }
    const error = resultError ?? describeFailure("agy", outcome);
    // agy's status first, then its own error text: its result's, or its own line on stderr, never
    // the rest of stderr (hooks and MCP servers print there too).
    const own = resultError ?? cliErrorLine(outcome.stderr);
    const errorKind: ErrorKind = stopped ?? statusKind ?? classifyError(own);
    const resetsAt = errorKind === "usage_limit" ? resetFromText(own) : undefined;
    onEvent({ kind: "error", message: error });
    return {
      ok: false,
      finalText: finalText || streamedText,
      sessionId: errorKind === "session_not_found" ? undefined : sessionId,
      error,
      errorKind,
      ...(resetsAt && { resetsAt }),
    };
  },
};

/**
 * agy's result status (gRPC-style codes, e.g. RESOURCE_EXHAUSTED) when it names a kind. Google
 * answers a per-minute 429 with RESOURCE_EXHAUSTED too, so that's a rate limit (retried) unless
 * its message says the plan's or the day's quota is used up: a usage limit stops the run and keeps
 * Auto away from agy until it resets.
 */
function agyStatusKind(status: string, detail: string | undefined, resuming: boolean): ErrorKind | undefined {
  if (/RESOURCE_EXHAUSTED|QUOTA/i.test(status)) {
    const text = detail ?? "";
    if (/\bper (?:minute|second|min\b)|\brate\b/i.test(text)) return "rate_limit";
    return /daily|per day|\bplan\b|usage limit|quota (?:exceeded|reached|exhausted)|exceeded (?:your|the) [\w -]{0,30}quota/i.test(text) ? "usage_limit" : "rate_limit";
  }
  if (/RATE/i.test(status)) return "rate_limit";
  if (/UNAUTHENTICATED|AUTH|LOGIN|SIGN_?IN/i.test(status)) return "auth";
  // Only the conversation can be missing when resuming (a missing model is a NOT_FOUND too).
  if (resuming && /NOT_FOUND/i.test(status)) return "session_not_found";
  if (/UNAVAILABLE|INTERNAL|OVERLOAD/i.test(status)) return "transient";
  if (/DEADLINE|TIMEOUT/i.test(status)) return "timeout";
  if (/CANCEL/i.test(status)) return "cancelled";
  return undefined;
}
