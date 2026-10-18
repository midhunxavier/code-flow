/**
 * The contract every coding-agent CLI is wrapped in.
 *
 * Adapters only ever spawn the vendor's official, unmodified CLI binary and let it
 * use its own cached login. They never read, copy or forward OAuth tokens — that is
 * what keeps subscription use within each vendor's terms.
 */

export type BuiltinAgentId = "claude" | "codex" | "agy";
export type AgentId = BuiltinAgentId | `plugin:${string}`;

/**
 * read  — may inspect files and run read-only commands, must not modify the tree.
 * write — may edit files and run commands inside `cwd` (always a disposable worktree).
 */
export type AccessMode = "read" | "write";

export type ApprovalDecision = "approve" | "decline";
/** A single concrete action. Approvals never authorize a session or amend a policy. */
export interface AgentApprovalRequest {
  id: string;
  kind: "command" | "file-change";
  command?: string;
  paths?: string[];
  reason?: string;
  cwd?: string;
}

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
  /** Stop the CLI (error kind "stalled") when it prints nothing for this long. */
  idleTimeoutMs?: number;
  /** Constrain the final answer to this JSON Schema (all three CLIs support it). */
  jsonSchema?: object;
  /** Auto members ask through their structured outcome, with answers on a later turn. */
  questionProtocol?: "structured";
  /** Ephemeral, server-derived member capability; never serialize with the Run or prompt. */
  teamTools?: import("../team-tools.js").TeamToolConnection;
  /**
   * How much an agent may do in write mode: "safe" = edit files only, "standard" = also run
   * common build/test commands, "trusted" = any command (and network, where the CLI sandboxes),
   * "full" = any command with no sandbox at all.
   */
  trust?: "safe" | "standard" | "trusted" | "full";
  /** Explicit interactive-run opt-in; headless/automated runs keep declining native prompts. */
  interactiveApprovals?: boolean;
  /** Server-owned callback. Abort means the request can no longer be approved. */
  onApproval?: (request: AgentApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision>;
  /** Run the official CLI inside an explicitly prepared image, with no host credentials. */
  agentContainer?: import("../agent-container.js").AgentContainer;
  /**
   * Adapters whose CLI takes more input while a turn runs (Codex app-server) call this once the
   * turn can be steered, with a function that adds a user message to it (resolving false when
   * the turn no longer takes input), and again with undefined when the turn ends.
   */
  onSteerable?: (steer: ((text: string) => Promise<boolean>) | undefined) => void;
}

/** Normalized event stream — the UI and workflow engine only ever see these. */
export type AgentEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; callId: string; name: string; input: string }
  | { kind: "tool_result"; callId: string; output: string; isError: boolean }
  /** Tokens a turn used; cached input is counted separately (it's much cheaper). costUsd: Claude's API-equivalent figure. */
  | { kind: "usage"; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; costUsd?: number }
  | { kind: "status"; text: string }
  | { kind: "error"; message: string }
  /** Plan usage reported by the CLI (Claude reports its 5-hour and 7-day windows). */
  | { kind: "quota"; status: string; windows: Record<string, { utilization?: number; resetsAt?: number }> };

/**
 * Why a turn failed, from the CLI's own signals where it gives them (exit status, structured
 * error events), so the engine never has to guess from text the agent may have written itself.
 * - usage_limit: the plan's usage is used up; `resetsAt` says until when, if the CLI said
 * - rate_limit / transient: worth another try in a minute (429, overloaded, network)
 * - auth: signed out or the login expired; retrying won't help until you sign in
 * - session_not_found: the conversation to resume is gone; start a fresh one
 * - cli_incompatible: the installed CLI rejected a flag or protocol code-flow uses
 * - stalled: no output for too long; the CLI was stopped
 * - timeout / cancelled: the step's time ran out, or you stopped it
 */
export type ErrorKind =
  | "usage_limit"
  | "rate_limit"
  | "transient"
  | "auth"
  | "session_not_found"
  | "cli_incompatible"
  | "stalled"
  | "timeout"
  | "cancelled"
  | "other";

export interface RunResult {
  ok: boolean;
  /** The agent's final answer for this turn. */
  finalText: string;
  /** The conversation this turn ran in. Never a session that failed to resume. */
  sessionId?: string;
  error?: string;
  /** Set when `ok` is false. */
  errorKind?: ErrorKind;
  /** For a usage limit: when it resets (ms since epoch), if the CLI said. */
  resetsAt?: number;
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
