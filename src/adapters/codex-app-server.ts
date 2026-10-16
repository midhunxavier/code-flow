import { classifyError } from "./errors.js";
import { startJsonlProcess, stderrTail, stringify, truncate, type ProcessOutcome } from "./process.js";
import type { ErrorKind } from "./types.js";

/**
 * One Codex turn through `codex app-server`: JSON-RPC over stdio (one JSON object per line, no
 * "jsonrpc" field). Unlike `codex exec`, the turn stays open to input while it runs, so a message
 * you send reaches the agent mid-turn (`turn/steer`) instead of waiting for its next turn.
 *
 * Notifications are translated into the events `codex exec --json` prints, so the adapter has
 * one handler for both transports. Protocol: `codex app-server generate-ts` (codex-cli 0.162).
 */

export interface AppServerTurn {
  prompt: string;
  cwd: string;
  sandbox: "read-only" | "workspace-write";
  /** Continue this thread (a `codex exec` session id works too: both share Codex's rollouts). */
  resumeThreadId?: string;
  model?: string;
  effort?: string;
  outputSchema?: object;
  /** `-c key=value` overrides for the server, e.g. network access in the workspace sandbox. */
  config: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  /** How long the server may take to answer `initialize`, and any other request. */
  initTimeoutMs?: number;
  requestTimeoutMs?: number;
  /**
   * Events in `codex exec --json` form. A `turn.failed` or `error` may carry `kind`, the
   * ErrorKind Codex's own error info gives it.
   */
  onMessage: (msg: any) => void;
  onText: (line: string) => void;
  onSteerable?: (steer: ((text: string) => Promise<boolean>) | undefined) => void;
}

/** The installed Codex can't serve this (no app-server, or a protocol this client doesn't speak). */
export interface Unavailable {
  unavailable: string;
}

const CLIENT_INFO = { name: "code_flow", title: "code-flow", version: "0.1.0" };
/** Streaming deltas code-flow doesn't show: only completed items are turned into events. */
const QUIET = [
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "turn/diff/updated",
];
const INIT_TIMEOUT_MS = 20_000;
/** Every other request (thread/start, thread/resume, turn/start, turn/steer): no answer is a failure. */
const REQUEST_TIMEOUT_MS = 2 * 60_000;
/** On cancel: how long an interrupted turn gets to end (and Codex to record it) before the server is stopped. */
const INTERRUPT_MS = 3_000;
/** After the turn: how long the server gets to close the thread and exit before it's stopped. */
const SHUTDOWN_MS = 5_000;

interface Tokens {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

class RpcError extends Error {
  constructor(
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

/** The server didn't answer a request in time. */
class RpcTimeout extends Error {
  constructor(method: string, ms: number) {
    super(`${method} got no answer within ${seconds(ms)}`);
  }
}

/** A failure whose kind is already known (it doesn't need to be read from its text). */
class TurnError extends Error {
  constructor(
    message: string,
    readonly kind: ErrorKind,
  ) {
    super(message);
  }
}

export async function runAppServerTurn(turn: AppServerTurn): Promise<ProcessOutcome | Unavailable> {
  let threadId: string | undefined;
  let turnId: string | undefined;
  let turnStarted = false;
  let turnEnded = false;
  let completed: ((turn: any) => void) | undefined;
  const turnDone = new Promise<any>((resolve) => (completed = resolve));
  /** Thread token totals before this turn's first model call, and the latest. */
  let tokensBefore: Tokens | undefined;
  let tokensNow: Tokens | undefined;

  let nextId = 1;
  const pending = new Map<number, { resolve: (result: any) => void; reject: (err: Error) => void }>();
  let exit: ProcessOutcome | undefined;

  // Cancelling interrupts the turn first (so Codex records it, and a resume picks up from there),
  // then stops the server: the process gets its own signal, aborted only after that.
  const stop = new AbortController();
  const proc = startJsonlProcess({
    command: "codex",
    args: ["app-server", ...turn.config],
    cwd: turn.cwd,
    signal: stop.signal,
    timeoutMs: turn.timeoutMs,
    idleTimeoutMs: turn.idleTimeoutMs,
    interactive: true,
    onText: turn.onText,
    onJson: (msg) => {
      if (msg.method === undefined && msg.id !== undefined) {
        const waiter = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) waiter?.reject(new RpcError(msg.error.code, msg.error.message ?? stringify(msg.error)));
        else waiter?.resolve(msg.result);
      } else if (msg.id !== undefined) {
        answerServerRequest(msg);
      } else {
        onNotification(msg.method, msg.params ?? {});
      }
    },
  });
  const exited = proc.outcome.then((outcome) => {
    exit = outcome;
    for (const waiter of pending.values()) waiter.reject(new Error("codex app-server exited"));
    pending.clear();
    return outcome;
  });

  /** One JSON-RPC request; no answer within `timeoutMs` rejects it (a late answer is ignored). */
  const request = (method: string, params: unknown, timeoutMs = turn.requestTimeoutMs ?? REQUEST_TIMEOUT_MS): Promise<any> =>
    new Promise((resolve, reject) => {
      if (exit) return reject(new Error("codex app-server exited"));
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new RpcTimeout(method, timeoutMs));
      }, timeoutMs);
      pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      if (!proc.send({ id, method, params })) {
        pending.delete(id);
        clearTimeout(timer);
        reject(new Error("codex app-server isn't accepting input"));
      }
    });

  function onNotification(method: string, params: any) {
    switch (method) {
      case "turn/started":
        turnId ??= params.turn?.id;
        break;

      case "item/started":
      case "item/completed": {
        const item = execItem(params.item);
        if (item) turn.onMessage({ type: method === "item/started" ? "item.started" : "item.completed", item });
        break;
      }

      case "turn/plan/updated":
        turn.onMessage({
          type: "item.completed",
          item: { type: "todo_list", items: (params.plan ?? []).map((p: any) => ({ text: p.step, completed: p.status === "completed" })) },
        });
        break;

      case "thread/tokenUsage/updated": {
        // `total` is the whole thread's (a resumed one included), `last` the latest model call:
        // what this turn used is the total now minus the total before its first call.
        if (!turnStarted || (turnId && params.turnId && params.turnId !== turnId)) break;
        const total = tokens(params.tokenUsage?.total);
        tokensBefore ??= minus(total, tokens(params.tokenUsage?.last));
        tokensNow = total;
        break;
      }

      case "error":
        // Reported before Codex retries (willRetry) and before a turn fails; the failure itself
        // arrives with turn/completed.
        turn.onMessage({ type: "error", message: errorText(params.error), kind: errorKind(params.error) });
        break;

      case "turn/completed":
        if (!turnId || !params.turn?.id || params.turn.id === turnId) {
          turnEnded = true;
          proc.resultSeen(); // the server gets a grace period to exit, not the whole step timeout
          completed?.(params.turn ?? {});
        }
        break;
    }
  }

  /**
   * Runs are headless (approvals are off), so anything that asks for a person gets "no", and the
   * run shows what was asked: a request code-flow doesn't know is answered too, never left hanging.
   */
  function answerServerRequest(msg: any) {
    const method = String(msg.method);
    const reply = (result: unknown) => proc.send({ id: msg.id, result });
    const declined = "declined — code-flow runs Codex without approval prompts";
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        turn.onText(`Codex asked for approval (${method.split("/")[1]}); ${declined}`);
        reply({ decision: "decline" });
        break;
      case "execCommandApproval":
      case "applyPatchApproval":
        turn.onText(`Codex asked for approval (${method}); ${declined}`);
        reply({ decision: { denied: { rejection: "code-flow runs Codex without approval prompts" } } });
        break;
      default: {
        const detail = requestDetail(msg.params);
        if (/approval|permission/i.test(method)) {
          turn.onText(`Codex asked for ${method}${detail}; ${declined}`);
          reply({ decision: "decline" });
        } else if (/elicitation/i.test(method)) {
          turn.onText(`Codex asked for input (${method})${detail}; declined — nobody can answer in a headless run`);
          reply({ action: "decline", content: null });
        } else {
          turn.onText(`Codex asked code-flow for ${method}${detail}, which a headless run can't answer; told Codex it isn't supported`);
          proc.send({ id: msg.id, error: { code: -32601, message: `code-flow doesn't handle ${method} (it runs Codex headless)` } });
        }
      }
    }
  }

  const steer = async (text: string): Promise<boolean> => {
    if (!threadId || !turnId || exit) return false;
    try {
      await request("turn/steer", { threadId, expectedTurnId: turnId, input: [textInput(text)] });
      return true;
    } catch {
      return false; // the turn just ended (or this Codex can't steer): it goes to the next turn
    }
  };

  let cancelling = false;
  const cancel = () => {
    if (cancelling) return;
    cancelling = true;
    void (async () => {
      if (threadId && turnId && turnStarted && !turnEnded && !exit) {
        request("turn/interrupt", { threadId, turnId }, INTERRUPT_MS).catch(() => undefined);
        await Promise.race([turnDone, exited, delay(INTERRUPT_MS)]);
      }
      stop.abort();
    })();
  };
  turn.signal?.addEventListener("abort", cancel, { once: true });
  if (turn.signal?.aborted) cancel();

  let steerable = false;
  try {
    try {
      await request(
        "initialize",
        { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: false, requestAttestation: false, optOutNotificationMethods: QUIET } },
        turn.initTimeoutMs ?? INIT_TIMEOUT_MS,
      );
    } catch (err) {
      proc.kill();
      const outcome = await exited;
      if (outcome.aborted || outcome.timedOut || outcome.stalled) return outcome;
      const tail = stderrTail(outcome, 3);
      // Only a Codex that can't serve this falls back to exec: no app-server subcommand, or an
      // initialize it rejects. A slow or failed start (signed out, a crash) fails this turn only.
      if (noAppServer(tail) || err instanceof RpcError) return { unavailable: tail || (err as Error).message };
      const message =
        err instanceof RpcTimeout
          ? `codex app-server didn't answer within ${seconds(turn.initTimeoutMs ?? INIT_TIMEOUT_MS)} of starting`
          : `codex app-server stopped before it was ready${tail ? `: ${tail}` : ""}`;
      // A start that failed for no stated reason is worth another try; a missing binary isn't.
      const kind = err instanceof RpcTimeout ? "transient" : classifyError(tail);
      turn.onMessage({ type: "turn.failed", error: { message, kind: kind === "other" && !/ENOENT|EACCES/.test(tail) ? "transient" : kind } });
      return outcome;
    }
    proc.send({ method: "initialized" });

    const threadParams = { cwd: turn.cwd, sandbox: turn.sandbox, approvalPolicy: "never", model: turn.model };
    let thread: any;
    try {
      thread = turn.resumeThreadId
        ? await request("thread/resume", { threadId: turn.resumeThreadId, excludeTurns: true, ...threadParams })
        : await request("thread/start", threadParams);
    } catch (err) {
      if (unsupported(err)) {
        proc.kill();
        await exited;
        return { unavailable: (err as Error).message };
      }
      // The thread is gone (Codex: "no rollout found for thread id …"): resuming it again won't help.
      if (turn.resumeThreadId && err instanceof RpcError && /no rollout found|thread[^\n]{0,20}not found|invalid thread id/i.test(err.message)) {
        throw new TurnError(err.message, "session_not_found");
      }
      throw err;
    }
    threadId = thread?.thread?.id ?? turn.resumeThreadId;
    turn.onMessage({ type: "thread.started", thread_id: threadId });

    turnStarted = true;
    const started = await request("turn/start", {
      threadId,
      input: [textInput(turn.prompt)],
      effort: turn.effort,
      outputSchema: turn.outputSchema,
    });
    turnId ??= started?.turn?.id;
    turn.onSteerable?.(steer);
    steerable = true;

    const result = await Promise.race([turnDone, exited.then(() => undefined)]);
    // Exited, timed out or stalled mid-turn, or cancelled (the turn interrupted first): the outcome says which.
    if (!result || turn.signal?.aborted) return await exited;
    if (steerable) turn.onSteerable?.(undefined);
    steerable = false;

    if (result.status === "completed") {
      const used = tokensNow ? minus(tokensNow, tokensBefore ?? zero()) : undefined;
      turn.onMessage({
        type: "turn.completed",
        usage: used && { input_tokens: used.inputTokens, cached_input_tokens: used.cachedInputTokens, output_tokens: used.outputTokens },
      });
    } else {
      turn.onMessage({
        type: "turn.failed",
        error: {
          message: result.error ? errorText(result.error) : result.status === "interrupted" ? "Codex turn was interrupted" : undefined,
          kind: errorKind(result.error),
        },
      });
    }

    // Close the thread so its history is written out (resume reads it), then let the server exit.
    await request("thread/unsubscribe", { threadId }, SHUTDOWN_MS).catch(() => undefined);
    proc.endInput();
    const timer = setTimeout(() => proc.kill(), SHUTDOWN_MS);
    const outcome = await exited;
    clearTimeout(timer);
    // The turn finished; how the server went away afterwards doesn't change that.
    return { ...outcome, exitCode: 0 };
  } catch (err) {
    if (!exit) {
      // No answer is worth another try; a thread that's gone isn't.
      const kind = err instanceof TurnError ? err.kind : err instanceof RpcTimeout ? "transient" : undefined;
      turn.onMessage({ type: "turn.failed", error: { message: `Codex: ${(err as Error).message}`, kind } });
    }
    proc.kill();
    return await exited;
  } finally {
    if (steerable) turn.onSteerable?.(undefined);
    turn.signal?.removeEventListener("abort", cancel);
  }
}

/** App-server items (camelCase) in the shape `codex exec --json` reports them. */
function execItem(item: any): any {
  switch (item?.type) {
    case "agentMessage":
      return { id: item.id, type: "agent_message", text: item.text };
    case "reasoning":
      return { id: item.id, type: "reasoning", text: (item.summary?.length ? item.summary : (item.content ?? [])).join("\n\n") };
    case "commandExecution":
      return {
        id: item.id,
        type: "command_execution",
        command: item.command,
        aggregated_output: item.aggregatedOutput ?? "",
        exit_code: item.exitCode,
        status: item.status === "inProgress" ? "in_progress" : item.status,
      };
    case "fileChange":
      return {
        id: item.id,
        type: "file_change",
        changes: (item.changes ?? []).map((c: any) => ({ path: c.path, kind: c.kind?.type ?? c.kind })),
        status: item.status === "inProgress" ? "in_progress" : item.status,
      };
    case "mcpToolCall":
      return { id: item.id, type: "mcp_tool_call", server: item.server, tool: item.tool, arguments: item.arguments, result: item.result, error: item.error, status: item.status };
    case "webSearch":
      return { id: item.id, type: "web_search", query: item.query };
    default:
      return undefined; // your own messages, compaction markers, …
  }
}

function textInput(text: string) {
  return { type: "text", text, text_elements: [] };
}

/** A turn error, worded so code-flow's usage-limit and retry checks recognise its kind. */
function errorText(error: any): string {
  const message = [error?.message || "Codex turn failed", error?.additionalDetails].filter(Boolean).join(": ");
  const kind = errorInfoKind(error);
  const hint =
    kind === "usageLimitExceeded" ? "usage limit" :
    kind === "serverOverloaded" ? "overloaded" :
    kind === "rateLimitExceeded" ? "rate limit" :
    kind === "httpConnectionFailed" || kind === "responseStreamConnectionFailed" || kind === "responseStreamDisconnected" ? "connection error" :
    undefined;
  return hint && !message.toLowerCase().includes(hint) ? `${message} (${hint})` : message;
}

/** The variant of Codex's `codexErrorInfo` (a string, or an object keyed by the variant). */
function errorInfoKind(error: any): string | undefined {
  const info = error?.codexErrorInfo;
  return typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : undefined;
}

/** The ErrorKind Codex's own error info gives a failure; undefined when it names none (the text decides). */
function errorKind(error: any): ErrorKind | undefined {
  const kind = errorInfoKind(error);
  const status = kind && typeof error.codexErrorInfo === "object" ? error.codexErrorInfo[kind]?.httpStatusCode : undefined;
  if (status === 401) return "auth";
  if (status === 429) return "rate_limit";
  switch (kind) {
    case "usageLimitExceeded":
      return "usage_limit";
    case "unauthorized":
      return "auth";
    case "rateLimitExceeded":
      return "rate_limit";
    case "serverOverloaded":
    case "internalServerError":
    case "httpConnectionFailed":
    case "responseStreamConnectionFailed":
    case "responseStreamDisconnected":
    case "responseTooManyFailedAttempts":
      return "transient";
    default:
      return undefined;
  }
}

/**
 * The server doesn't speak this protocol version (an older or newer Codex): it has no such
 * method. A parameter value it doesn't know ("unknown variant `xhigh`") isn't that.
 */
function unsupported(err: unknown): boolean {
  return err instanceof RpcError && (err.code === -32601 || /method not found|unknown method|unknown variant `[\w-]+\/[\w/-]+`/i.test(err.message));
}

/** stderr of a Codex whose CLI has no app-server subcommand (or doesn't take its arguments). */
function noAppServer(stderr: string): boolean {
  return /unrecognized subcommand|unexpected argument|wasn't expected|(?:unknown|invalid|no such) (?:sub)?command/i.test(stderr);
}

/** What a server request asked, briefly, for the status line. */
function requestDetail(params: any): string {
  const text = [params?.reason, params?.message, params?.command, params?.prompt].find((v) => typeof v === "string" && v.trim());
  return text ? `: "${truncate(text.trim().replace(/\s+/g, " "), 160)}"` : "";
}

function tokens(t: any): Tokens {
  return { inputTokens: t?.inputTokens ?? 0, cachedInputTokens: t?.cachedInputTokens ?? 0, outputTokens: t?.outputTokens ?? 0 };
}
function minus(a: Tokens, b: Tokens): Tokens {
  return {
    inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
    cachedInputTokens: Math.max(0, a.cachedInputTokens - b.cachedInputTokens),
    outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
  };
}
function zero(): Tokens {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
}

function seconds(ms: number): string {
  return ms < 1_000 ? `${ms} ms` : `${Math.round(ms / 1000)}s`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
