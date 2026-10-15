/**
 * The contract every coding-agent CLI is wrapped in.
 *
 * Adapters only ever spawn the vendor's official, unmodified CLI binary and let it
 * use its own cached login. They never read, copy or forward OAuth tokens — that is
 * what keeps subscription use within each vendor's terms.
 */

export type AgentId = "claude" | "codex" | "agy";

/**
 * read  — may inspect files and run read-only commands, must not modify the tree.
 * write — may edit files and run commands inside `cwd` (always a disposable worktree).
 */
export type AccessMode = "read" | "write";

export interface RunOptions {
  prompt: string;
  /** Working directory; for write mode this is always an isolated git worktree. */
  cwd: string;
  mode: AccessMode;
  /** Continue a previous conversation of this same agent (keeps its context). */
  resumeSessionId?: string;
  model?: string;
  signal?: AbortSignal;
  /** Hard cap per run. Defaults to 30 minutes. */
  timeoutMs?: number;
}

/** Normalized event stream — the UI and workflow engine only ever see these. */
export type AgentEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; callId: string; name: string; input: string }
  | { kind: "tool_result"; callId: string; output: string; isError: boolean }
  | { kind: "usage"; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { kind: "status"; text: string }
  | { kind: "error"; message: string };

export interface RunResult {
  ok: boolean;
  /** The agent's final answer for this turn. */
  finalText: string;
  sessionId?: string;
  error?: string;
}

export interface AgentAdapter {
  id: AgentId;
  displayName: string;
  /** CLI binary name, used for availability checks. */
  binary: string;
  /** True when the CLI is on PATH. Login state is only discovered on first run. */
  available(): Promise<boolean>;
  run(opts: RunOptions, onEvent: (e: AgentEvent) => void): Promise<RunResult>;
}
