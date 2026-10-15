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
  /** Model id or alias; undefined = the CLI's configured default. */
  model?: string;
  /** Reasoning effort; undefined = the CLI's configured default. */
  effort?: string;
  signal?: AbortSignal;
  /** Hard cap per run. Defaults to 30 minutes. */
  timeoutMs?: number;
  /** Constrain the final answer to this JSON Schema (all three CLIs support it). */
  jsonSchema?: object;
  /**
   * How much an agent may do in write mode: "safe" = edit files only, "standard" = also run
   * common build/test commands, "trusted" = any command (and network, where the CLI sandboxes).
   */
  trust?: "safe" | "standard" | "trusted";
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
  | { kind: "error"; message: string }
  /** Plan usage reported by the CLI (Claude reports its 5-hour and 7-day windows). */
  | { kind: "quota"; status: string; windows: Record<string, { utilization?: number; resetsAt?: number }> };

export interface RunResult {
  ok: boolean;
  /** The agent's final answer for this turn. */
  finalText: string;
  sessionId?: string;
  error?: string;
  /** The schema-constrained answer, when `jsonSchema` was given and the CLI returned one. */
  structured?: unknown;
}

export interface ModelInfo {
  id: string;
  label: string;
  /** Efforts this model supports, when the CLI says; otherwise the adapter's list applies. */
  efforts?: string[];
  defaultEffort?: string;
}

export interface ModelCatalog {
  models: ModelInfo[];
  efforts: string[];
  /** Model the CLI uses when none is chosen, if known. */
  defaultModel?: string;
  defaultEffort?: string;
  /** Free-text model ids are accepted (aliases, full names). */
  allowCustom: boolean;
}

export type AgentSettings = Partial<Record<AgentId, { model?: string; effort?: string }>>;

export interface AgentAdapter {
  id: AgentId;
  displayName: string;
  /** CLI binary name, used for availability checks. */
  binary: string;
  /** True when the CLI is on PATH. Login state is only discovered on first run. */
  available(): Promise<boolean>;
  /** Models and effort levels this CLI offers. */
  catalog(): Promise<ModelCatalog>;
  run(opts: RunOptions, onEvent: (e: AgentEvent) => void): Promise<RunResult>;
}
