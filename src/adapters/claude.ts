import { discoverModels } from "./model-discovery.js";
import { managedPermissionProblem } from "./managed-permissions.js";
import { prepareAgentTools } from "./agent-tools.js";
import { AGENT_TOOL_ALLOWLIST } from "../agent-tools.js";
import { ClaudeStream } from "./claude-stream.js";
import type { AgentAdapter, AgentEvent, ErrorKind, ModelCatalog, RunOptions, RunResult } from "./types.js";
import { classifyError, cliErrorLine, resetFromText } from "./errors.js";
import { commandExists, describeFailure, processErrorKind, startJsonlProcess, stderrTail, stringify, truncate, unknownEvents } from "./process.js";
import { adapterTeamCapabilities, prepareTeamTools, TEAM_NESTED_DENYLIST, TEAM_TOOL_ALLOWLIST } from "./team-tools.js";

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

/**
 * Options that make the read-only git commands above write or read anywhere: `--output=<file>`
 * sends git diff, log or show's output to any path (`git log -1 --format=%B --output=$HOME/.zshrc`),
 * and git takes it abbreviated too (`--outp=`); `--no-index` diffs any two files on disk, in the
 * repository or not. Claude Code applies deny rules before allow rules, wherever in the command
 * the option appears (quoted included: the rule has no space before it).
 */
const GIT_READ_DENY = ["Bash(git *--out*)", "Bash(git *--no-index*)"];

/** Stream-json progress types that carry no transcript or control content. */
const IGNORED_TYPES = new Set(["stream_event", "tool_progress", "tool_use_summary", "auth_status", "keep_alive", "control_request", "control_response", "control_cancel_request"]);
/** Assistant content blocks code-flow knowingly ignores. */
const IGNORED_BLOCKS = new Set(["redacted_thinking"]);

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
  "Bash(uv *)",
  "Bash(poetry *)",
  "Bash(cargo *)",
  "Bash(go *)",
  "Bash(make *)",
  "Bash(mkdir *)",
];

function writeTools(trust: RunOptions["trust"] = "standard"): string[] {
  if (trust === "safe") return READ_TOOLS; // edits come from acceptEdits; no shell beyond read-only git
  if (trust === "trusted") return [...READ_TOOLS, "Bash"];
  const env = process.env.CODEFLOW_CLAUDE_WRITE_TOOLS;
  return env ? env.split(",").map((t) => t.trim()).filter(Boolean) : DEFAULT_WRITE_TOOLS;
}

export const claudeAdapter: AgentAdapter = {
  id: "claude",
  discoverModels: context => discoverModels("claude", context),
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
    const permissionProblem = await managedPermissionProblem("claude", opts);
    if (permissionProblem) return permissionProblem;
    const supportsTools = !opts.agentContainer && opts.teamTools && (await adapterTeamCapabilities("claude")).scopedTools === "tested";
    const teamTools = supportsTools ? await prepareTeamTools(opts.teamTools!) : undefined;
    const agentTools = opts.agentTools && !opts.agentContainer && opts.permissions?.externalTools !== "disabled" ? await prepareAgentTools(opts.agentTools) : undefined;
    if (opts.agentContainer) onEvent({ kind: "status", text: `Claude runs in Docker image ${opts.agentContainer.image}. Live team tools are unavailable in containers; use structured outcomes and next-turn replies.` });
    else if (opts.teamTools && !teamTools) onEvent({ kind: "status", text: "This Claude CLI has no verified per-turn team tools; use structured outcomes and next-turn replies." });
    try {
    // The prompt goes on stdin (no positional argument), so its size isn't limited by argv.
    const interactive = !!(opts.conversation || opts.interactiveApprovals || opts.onQuestion);
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
    if (interactive) args.push("--input-format", "stream-json", "--permission-prompt-tool", "stdio");
    if (opts.permissions && !opts.conversation) args.push("--settings", '{"ultracode":false,"disableWorkflows":true,"disableAllHooks":true}');
    if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
    else if (opts.forkSessionId) args.push("--resume", opts.forkSessionId, "--fork-session");
    if (opts.model) args.push("--model", opts.model);
    if (opts.effort) args.push("--effort", opts.effort);
    if (opts.jsonSchema) args.push("--json-schema", JSON.stringify(opts.jsonSchema));
    if (teamTools) args.push("--mcp-config", teamTools.claudeConfig, "--strict-mcp-config");
    else if (opts.permissions?.externalTools === "disabled") args.push("--mcp-config", '{"mcpServers":{}}', "--strict-mcp-config");
    if (agentTools) args.push("--mcp-config", agentTools.claudeConfig);
    if (opts.permissions?.externalTools === "disabled") args.push("--no-chrome");
    const collaborationTools = [...(teamTools ? TEAM_TOOL_ALLOWLIST : []), ...(agentTools ? AGENT_TOOL_ALLOWLIST : [])];
    // Full access: every tool, without permission checks.
    const full = opts.mode === "write" && opts.trust === "full";
    const allowedTools = full ? [] : [...(opts.mode === "write" ? writeTools(opts.trust) : READ_TOOLS), ...collaborationTools];
    // Where the shell is limited to an allow-list, the git read commands mustn't write (or read) outside it.
    // With "Bash" allowed outright (Trusted) any command runs anyway.
    const limitedShell = !full && !allowedTools.includes("Bash");
    const deniedTools = [...(opts.mode === "read" ? ["Edit", "Write", "NotebookEdit"] : []), ...(opts.questionProtocol === "structured" || opts.permissions?.nativeDelegation === false ? TEAM_NESTED_DENYLIST : []), ...(opts.permissions?.externalTools === "disabled" ? ["WebSearch", "WebFetch"] : [])];
    // The flag takes several values (`<tools...>`); the git rules go in one of their own.
    const denied = [deniedTools.join(","), limitedShell ? GIT_READ_DENY.join(",") : ""].filter(Boolean);
    if (denied.length) args.push("--disallowedTools", ...denied);
    if (full) args.push("--permission-mode", "bypassPermissions");
    else args.push("--permission-mode", opts.mode === "write" ? "acceptEdits" : "default", "--allowedTools", allowedTools.join(","));

    // Only a session the CLI confirms in this turn: a resume that failed must not hand back its id.
    let sessionId: string | undefined;
    let finalText = "";
    let lastAssistantText = "";
    let resultError: string | undefined;
    let sawResult = false;
    let structured: unknown;
    /** The plan refused this turn (rate_limit_event "rejected"), and when it resets if it said. */
    let rejected: { resetsAt?: number } | undefined;
    const unknown = unknownEvents("claude");
    const stream = new ClaudeStream(onEvent);
    const controls = new Map<string, AbortController>();
    const cancelControls = () => { for (const controller of controls.values()) controller.abort(); };
    opts.signal?.addEventListener("abort", cancelControls, { once: true });

    const handleControl = async (msg: any) => {
      const id = msg.request_id;
      if (typeof id !== "string" || controls.has(id)) return;
      const controller = new AbortController();
      controls.set(id, controller);
      const request = msg.request ?? {};
      const isQuestion = request.tool_name === "AskUserQuestion";
      const timer = setTimeout(() => controller.abort(), isQuestion ? 600_000 : 120_000);
      let response: any = { behavior: "deny", message: "This action was not approved. Ask the user in your response if you need help." };
      proc.pauseIdle(true);
      try {
        if (sawResult || opts.signal?.aborted) return;
        const work = async () => {
          if (request.subtype !== "can_use_tool") return;
          const input = request.input ?? {};
          if (isQuestion && opts.onQuestion && Array.isArray(input.questions)) {
            const questions = input.questions.map((q: any, index: number) => ({ id: String(index), question: q.question, options: q.options?.map((o: any) => o.label) }));
            const answers = await opts.onQuestion(questions, controller.signal);
            if (answers) response = { behavior: "allow", updatedInput: { ...input, answers: Object.fromEntries(questions.map((q: any) => [q.question, answers[q.id]])) } };
          } else if (opts.interactiveApprovals && opts.onApproval && typeof request.tool_name === "string") {
            if (opts.mode === "read") return; // A side conversation cannot escalate a denied tool into a write.
            const encoded = JSON.stringify(input);
            if (encoded.length > 16_000) return;
            const decision = await opts.onApproval({ id, kind: "tool", toolName: request.tool_name, input: encoded, cwd: opts.cwd }, controller.signal);
            if (decision === "approve") response = { behavior: "allow", updatedInput: input };
          }
        };
        await Promise.race([work(), new Promise<void>(resolve => controller.signal.addEventListener("abort", () => resolve(), { once: true }))]);
        if (!sawResult && !opts.signal?.aborted) proc.send({ type: "control_response", response: { subtype: "success", request_id: id, response: controller.signal.aborted ? { behavior: "deny", message: "Request expired or was cancelled" } : response } });
      } catch (error) {
        if (!sawResult) proc.send({ type: "control_response", response: { subtype: "error", request_id: id, error: String(error) } });
      } finally { clearTimeout(timer); controller.abort(); controls.delete(id); proc.pauseIdle(controls.size > 0); }
    };

    const proc = startJsonlProcess({
      agentContainer: opts.agentContainer ? { config: opts.agentContainer, mode: opts.mode } : undefined,
      command: "claude",
      args,
      input: interactive ? undefined : opts.prompt,
      interactive,
      cwd: opts.cwd,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      idleTimeoutMs: opts.idleTimeoutMs,
      isPaused: opts.isPaused,
      onText: (line) => onEvent({ kind: "status", text: line }),
      onJson: (msg) => {
        switch (msg.type) {
          case "stream_event":
            stream.partial(msg.event);
            break;
          case "control_request":
            void handleControl(msg);
            break;
          case "control_cancel_request":
            controls.get(msg.request_id)?.abort();
            break;
          case "system":
            if (msg.subtype === "init" && msg.session_id) {
              sessionId = msg.session_id;
              onEvent({ kind: "session", sessionId: msg.session_id });
            }
            break;

          case "assistant":
            stream.complete(msg.message);
            lastAssistantText = stream.lastText;
            for (const block of msg.message?.content ?? []) {
              if (!["text", "thinking", "tool_use"].includes(block.type) && !IGNORED_BLOCKS.has(block.type)) {
                unknown.add(`${block.type} block`);
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

          case "rate_limit_event": {
            const info = msg.rate_limit_info ?? {};
            const windows: Record<string, { utilization?: number; resetsAt?: number }> = {};
            for (const [name, w] of Object.entries((info.unifiedWindows ?? {}) as Record<string, any>)) {
              windows[name] = { utilization: w?.utilization, resetsAt: w?.resetsAt ? w.resetsAt * 1000 : undefined };
            }
            // Older or newer CLIs may report a single window at the top level instead.
            if (!Object.keys(windows).length && (info.utilization !== undefined || info.resetsAt)) {
              windows[info.rateLimitType ?? "limit"] = { utilization: info.utilization, resetsAt: info.resetsAt ? info.resetsAt * 1000 : undefined };
            }
            onEvent({ kind: "quota", status: info.status ?? "unknown", windows });
            if (info.status && info.status !== "allowed") onEvent({ kind: "status", text: `Claude rate limit: ${info.status}` });
            if (info.status === "rejected") {
              // The window that refused it resets last among the full ones; the top level names it directly.
              const full = Object.values(windows).filter((w) => (w.utilization ?? 0) >= 1 && w.resetsAt).map((w) => w.resetsAt!);
              rejected = { resetsAt: info.resetsAt ? info.resetsAt * 1000 : full.length ? Math.max(...full) : undefined };
            }
            break;
          }

          case "result":
            sawResult = true;
            cancelControls();
            if (interactive) proc.endInput();
            proc.resultSeen();
            finalText = typeof msg.result === "string" ? msg.result : lastAssistantText;
            if (msg.session_id) sessionId = msg.session_id;
            if (msg.structured_output !== undefined) structured = msg.structured_output;
            if (msg.is_error || /^error/.test(msg.subtype ?? "")) resultError = resultErrorText(msg);
            onEvent({
              kind: "usage",
              // Writing to the prompt cache is billed as input; reading from it is counted apart.
              inputTokens: (msg.usage?.input_tokens ?? 0) + (msg.usage?.cache_creation_input_tokens ?? 0),
              outputTokens: msg.usage?.output_tokens,
              cacheReadTokens: msg.usage?.cache_read_input_tokens,
              costUsd: msg.total_cost_usd,
            });
            if (Array.isArray(msg.permission_denials) && msg.permission_denials.length) {
              const names = msg.permission_denials.map((d: any) => d.tool_name).join(", ");
              onEvent({ kind: "status", text: `Denied in headless mode: ${names}` });
            }
            break;

          default:
            if (!IGNORED_TYPES.has(msg.type)) unknown.add(msg.type);
        }
      },
    });

    if (interactive) {
      proc.send({ type: "control_request", request_id: "codeflow-init", request: { subtype: "initialize", hooks: {} } });
      proc.send({ type: "user", message: { role: "user", content: opts.prompt } });
    }

    const outcome = await proc.outcome;
    cancelControls();
    opts.signal?.removeEventListener("abort", cancelControls);
    const drift = unknown.report();
    if (drift) onEvent({ kind: "status", text: drift });

    // After a successful result, how the process ended (a hook that hung, a non-zero exit) doesn't matter.
    if (sawResult && !resultError && !outcome.aborted) return { ok: true, finalText, sessionId, structured };

    const tail = stderrTail(outcome);
    const error = resultError
      ? `${resultError}${tail && !resultError.includes(tail) ? `\n${tail}` : ""}`
      : !sawResult && outcome.exitCode === 0
        ? `claude exited without a result${tail ? `: ${tail}` : ""}`
        : describeFailure("claude", outcome);
    // The kind comes from Claude's error (its result, or its own line on stderr), never from the
    // rest of stderr: hooks and MCP servers print there. The plan's refusal makes it a usage limit.
    const own = resultError ?? cliErrorLine(outcome.stderr);
    let errorKind: ErrorKind = processErrorKind(outcome) ?? classifyError(own);
    if (rejected && (errorKind === "other" || errorKind === "rate_limit")) errorKind = "usage_limit";
    const resetsAt = errorKind === "usage_limit" ? (rejected?.resetsAt ?? resetFromText(own)) : undefined;
    onEvent({ kind: "error", message: error });
    return {
      ok: false,
      finalText: finalText || stream.lastText || lastAssistantText,
      sessionId: errorKind === "session_not_found" ? undefined : sessionId,
      error,
      errorKind,
      ...(resetsAt && { resetsAt }),
    };
    } finally { await teamTools?.cleanup(); await agentTools?.cleanup(); }
  },
};

/**
 * What a failed `result` event says went wrong. With `is_error`, `result` is the CLI's error
 * text ("API Error: 529 …"); without a `result`, the subtype (and `errors`) say. Never the
 * agent's last message: an agent quoting an error from its work hasn't failed.
 */
function resultErrorText(msg: any): string {
  if (msg.is_error && typeof msg.result === "string" && msg.result.trim()) return msg.result.trim();
  const errors = Array.isArray(msg.errors) ? msg.errors.filter((e: unknown) => typeof e === "string" && e).join("; ") : "";
  const what =
    msg.subtype === "error_max_turns" ? "Claude stopped at its turn limit" :
    msg.subtype === "error_max_budget_usd" ? "Claude stopped at its budget limit" :
    msg.subtype === "error_during_execution" ? "Claude stopped with an error during execution" :
    `Claude reported an error${msg.subtype && msg.subtype !== "success" ? ` (${msg.subtype})` : ""}`;
  return errors ? `${what}: ${errors}` : what;
}
