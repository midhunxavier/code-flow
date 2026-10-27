import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { classifyError, cliErrorLine } from "./errors.js";

import { startJsonlProcess, stderrTail, stringify, truncate, type ProcessOutcome } from "./process.js";
import type { AgentApprovalRequest, AgentQuestion, ApprovalDecision, ErrorKind } from "./types.js";
import type { AgentContainer } from "../agent-container.js";
import { approvalTimeout, isApprovalTimeout } from "../approvals.js";

/**
 * One Codex turn through `codex app-server`: JSON-RPC over stdio (one JSON object per line, no
 * "jsonrpc" field). Unlike `codex exec`, the turn stays open to input while it runs, so a message
 * you send reaches the agent mid-turn (`turn/steer`) instead of waiting for its next turn.
 *
 * Notifications are translated into the events `codex exec --json` prints, so the adapter has
 * one handler for both transports. Protocol: `codex app-server generate-ts` (codex-cli 0.162;
 * approvals and questions also as codex-cli 0.164 sends them).
 */

export interface AppServerTurn {
  prompt: string;
  cwd: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  /** Continue this thread (a `codex exec` session id works too: both share Codex's rollouts). */
  resumeThreadId?: string;
  forkThreadId?: string;
  model?: string;
  effort?: string;
  outputSchema?: object;
  questionProtocol?: "structured";
  /** `-c key=value` overrides for the server, e.g. network access in the workspace sandbox. */
  config: string[];
  /** Applied again to thread/start and thread/resume, including shared-daemon transports. */
  threadConfig?: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  isPaused?: () => boolean;
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
  interactiveApprovals?: boolean;
  onApproval?: (request: AgentApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision>;
  onQuestion?: (questions: AgentQuestion[], signal: AbortSignal) => Promise<Record<string, string> | undefined>;
  /** Upper bounded independently of the process timeout. Defaults to two minutes. */
  approvalTimeoutMs?: number;
  /** How long a question waits for an answer, at most ten minutes (the default). */
  questionTimeoutMs?: number;
  agentContainer?: AgentContainer;
}

/** The installed Codex can't serve this (no app-server, or a protocol this client doesn't speak). */
export interface Unavailable {
  unavailable: string;
}

const CLIENT_INFO = { name: "code_flow", title: "code-flow", version: "0.1.0" };
/** Notifications without a presentation yet. Text and tool output remain subscribed. */
const QUIET = [
  "item/plan/delta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "turn/diff/updated",
];
/**
 * Notifications code-flow knowingly leaves alone: thread and account bookkeeping, progress it
 * doesn't show, warnings Codex also logs. Any other method is counted as unknown (a protocol
 * change worth knowing about), along with the QUIET ones in case the server sends them anyway.
 */
const IGNORED = new Set([
  ...QUIET,
  "thread/started",
  "thread/closed",
  "thread/status/changed",
  "thread/name/updated",
  "thread/archived",
  "thread/unarchived",
  "thread/compacted",
  "account/updated",
  "account/rateLimits/updated",
  "account/login/completed",
  "mcpServer/oauthLogin/completed",
  "mcpServer/startupStatus/updated",
  "item/mcpToolCall/progress",
  "item/commandExecution/terminalInteraction",
  "rawResponseItem/completed",
  "serverRequest/resolved",
  "model/rerouted",
  "deprecationNotice",
  "configWarning",
  "windows/worldWritableWarning",
  "fuzzyFileSearch/sessionUpdated",
  "fuzzyFileSearch/sessionCompleted",
  "sessionConfigured",
  "authStatusChange",
  "loginChatGptComplete",
]);
/** Thread items with nothing to show: your own messages, compaction markers, review-mode markers, plan-mode text. */
const IGNORED_ITEMS = new Set(["userMessage", "contextCompaction", "enteredReviewMode", "exitedReviewMode", "imageView", "plan"]);
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
  const approvalRequests = new Map<string, { controller: AbortController; replyAllowed: boolean }>();
  const approvalItems = new Map<string, any>();
  /**
   * The environments the thread reports for this turn's worktree. codex-cli 0.164 names one on every
   * command approval ("local" for the thread's own machine); a command bound for any other runs elsewhere.
   * Undefined when the thread reports none (an older Codex): then only "local" is this machine.
   */
  let localEnvironments: Set<string> | undefined;
  const localEnvironment = (id: unknown) => id === undefined || id === null || typeof id === "string" && (localEnvironments ? localEnvironments.has(id) : id === "local");

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
    isPaused: turn.isPaused,
    interactive: true,
    agentContainer: turn.agentContainer ? { config: turn.agentContainer, mode: turn.sandbox === "read-only" ? "read" : "write" } : undefined,
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
    abortApprovals(false);
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
    // A shared transport may publish other sessions; never mix their output into this turn.
    if (params.threadId && threadId && params.threadId !== threadId) return;
    if (params.turnId && turnId && params.turnId !== turnId) return;
    switch (method) {
      case "item/agentMessage/delta":
      case "item/reasoning/summaryTextDelta":
      case "item/commandExecution/outputDelta":
        if (typeof params.delta === "string" && typeof params.itemId === "string") {
          turn.onMessage({ type: "item.delta", item: { id: params.itemId, type: method === "item/agentMessage/delta" ? "agent_message" : method === "item/reasoning/summaryTextDelta" ? "reasoning" : "command_execution", text: params.delta } });
        }
        break;
      case "turn/started":
        turnId ??= params.turn?.id;
        break;

      case "item/started":
      case "item/completed": {
        if (method === "item/started" && params.item?.id && params.threadId === threadId && params.turnId === turnId) {
          if (approvalItems.size < 256) approvalItems.set(params.item.id, params.item);
        }
        if (method === "item/completed") approvalItems.delete(params.item?.id);
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
          abortApprovals(false);
          proc.resultSeen(); // the server gets a grace period to exit, not the whole step timeout
          completed?.(params.turn ?? {});
        }
        break;

      case "serverRequest/resolved": {
        if (params.threadId !== threadId) break;
        const approval = approvalRequests.get(String(params.requestId));
        if (approval) { approval.replyAllowed = false; approval.controller.abort(); }
        break;
      }
      default:
        // Counted by the adapter; v1's raw event stream (codex/event/…) is its own protocol.
        if (!IGNORED.has(method) && !method.startsWith("codex/event/")) turn.onMessage({ type: "unrecognized", name: method });

    }
  }

  /**
   * Only explicit interactive runs can approve known, fully displayed one-shot actions.
   * Policy amendments, session grants and unknown methods never reach the approval callback.
   */
  function answerServerRequest(msg: any) {
    const method = String(msg.method);
    const reply = (result: unknown) => proc.send({ id: msg.id, result });
    const declined = "declined — code-flow runs Codex without approval prompts";
    const questionGuidance = turn.questionProtocol === "structured"
      ? "Return a needs_info outcome with an addressed question and checkpoint; code-flow can supply the answer on your next turn."
      : "It runs Codex headless.";
    switch (method) {
      case "item/tool/requestUserInput":
        if (turn.onQuestion && msg.params?.threadId === threadId && msg.params?.turnId === turnId && Array.isArray(msg.params.questions)) void answerQuestion(msg);
        else {
          turn.onText(`Codex asked for input (${method})${requestDetail(msg.params)}; native input unavailable. ${questionGuidance}`);
          reply({ answers: {} });
        }
        break;
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        if (turn.interactiveApprovals && turn.onApproval) void answerApproval(msg);
        else {
          turn.onText(`Codex asked for approval (${method.split("/")[1]}); ${declined}`);
          reply({ decision: "decline" });
        }
        break;
      case "execCommandApproval":
      case "applyPatchApproval":
        turn.onText(`Codex asked for approval (${method}); ${declined}`);
        reply({ decision: { denied: { rejection: "code-flow runs Codex without approval prompts" } } });
        break;
      case "item/permissions/requestApproval":
        turn.onText(`Codex asked for ${method}${requestDetail(msg.params)}; additional permissions declined`);
        reply({ permissions: {}, scope: "turn" });
        break;
      default: {
        const detail = requestDetail(msg.params);
        if (/approval|permission/i.test(method)) {
          turn.onText(`Codex asked for ${method}${detail}; ${declined}`);
          reply({ decision: "decline" });
        } else if (/elicitation/i.test(method)) {
          turn.onText(`Codex asked for input (${method})${detail}; native input declined. ${questionGuidance}`);
          reply({ action: "decline", content: null });
        } else {
          turn.onText(`Codex asked code-flow for ${method}${detail}; native request unsupported. ${questionGuidance}`);
          proc.send({ id: msg.id, error: { code: -32601, message: `code-flow doesn't handle ${method}. ${questionGuidance}` } });
        }
      }
    }
  }

  async function answerApproval(msg: any): Promise<void> {
    const id = String(msg.id);
    const duplicate = approvalRequests.get(id);
    if (duplicate) { duplicate.controller.abort(); return; }
    const params = msg.params ?? {};
    const item = approvalItems.get(params.itemId);
    const thisTurn = !!threadId && !!turnId && params.threadId === threadId && params.turnId === turnId && !turnEnded && !exit && !turn.signal?.aborted;
    const action = !thisTurn ? "it isn't for this turn" : approvalRequests.size >= 32 ? "too many requests are already waiting" : approvalAction(msg, item, turn.cwd, turn.sandbox, localEnvironment);
    if (typeof action === "string") {
      // Codex reads a plain decline as yours: say in the thread, and to Codex, that code-flow declined it unasked.
      const command = typeof (params.command ?? item?.command) === "string" ? String(params.command ?? item?.command).trim().replace(/\s+/g, " ") : "";
      const what = msg.method === "item/fileChange/requestApproval" ? "to change files" : command ? `to run \`${command.length > 160 ? `${command.slice(0, 160)}…` : command}\`` : "to run a command";
      turn.onText(`code-flow declined Codex's request ${what} without asking you: ${action}`);
      proc.send({ id: msg.id, result: { decision: "decline" } });
      if (thisTurn) void steer(`code-flow declined your approval request ${what} on its own, because ${action}. The user was not asked and did not reject it. Continue without it, and say in your answer what you couldn't do.`);
      return;
    }
    const approval = { controller: new AbortController(), replyAllowed: true };
    approvalRequests.set(id, approval);
    proc.pauseIdle(true);
    const timeout = Number.isFinite(turn.approvalTimeoutMs) && turn.approvalTimeoutMs! > 0 ? Math.min(10 * 60_000, turn.approvalTimeoutMs!) : 2 * 60_000;
    const timer = setTimeout(() => approval.controller.abort(approvalTimeout()), timeout);
    turn.onText(`Codex is waiting for approval of this ${action.kind === "command" ? "command" : "file change"}`);
    let decision: ApprovalDecision = "decline";
    try {
      const cancelled = new Promise<ApprovalDecision>((resolve) => approval.controller.signal.addEventListener("abort", () => resolve("decline"), { once: true }));
      decision = await Promise.race([Promise.resolve().then(() => turn.onApproval!(action, approval.controller.signal)), cancelled]);
    } catch (error) {
      turn.onText(`Codex approval declined: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
      approvalRequests.delete(id);
      proc.pauseIdle(approvalRequests.size > 0);
    }
    // Cancellation, completion, timeout or server resolution invalidates even a late accept.
    if (approval.replyAllowed && !exit && !turnEnded) {
      const accepted = decision === "approve" && !approval.controller.signal.aborted && !turn.signal?.aborted;
      proc.send({ id: msg.id, result: { decision: accepted ? "accept" : "decline" } });
      const what = action.kind === "command" ? "command" : "file change";
      turn.onText(!accepted && isApprovalTimeout(approval.controller.signal.reason) ? `Codex ${what} request expired: nobody answered within ${waited(timeout)}, so it was declined` : `Codex ${what} ${accepted ? "approved once" : "declined"}`);
    }
    approval.controller.abort();
  }

  async function answerQuestion(msg: any): Promise<void> {
    const id = String(msg.id);
    if (approvalRequests.has(id) || approvalRequests.size >= 32 || turnEnded || exit) { proc.send({ id: msg.id, result: { answers: {} } }); return; }
    const approval = { controller: new AbortController(), replyAllowed: true };
    approvalRequests.set(id, approval); proc.pauseIdle(true);
    const timeout = Number.isFinite(turn.questionTimeoutMs) && turn.questionTimeoutMs! > 0 ? Math.min(10 * 60_000, turn.questionTimeoutMs!) : 10 * 60_000;
    const timer = setTimeout(() => approval.controller.abort(approvalTimeout()), timeout);
    let answers: Record<string, string> | undefined;
    try {
      const questions = msg.params.questions.map(codexQuestion);
      answers = await Promise.race([turn.onQuestion!(questions, approval.controller.signal), new Promise<undefined>(resolve => approval.controller.signal.addEventListener("abort", () => resolve(undefined), { once: true }))]);
    } catch { /* A failed UI request returns an empty answer, never a guessed response. */ }
    finally { clearTimeout(timer); approvalRequests.delete(id); proc.pauseIdle(approvalRequests.size > 0); }
    if (approval.replyAllowed && !exit && !turnEnded) {
      proc.send({ id: msg.id, result: { answers: Object.fromEntries(Object.entries(answers ?? {}).map(([key, value]) => [key, { answers: [value] }])) } });
      if (!answers && isApprovalTimeout(approval.controller.signal.reason)) turn.onText(`Codex's question expired: nobody answered within ${waited(timeout)}, so Codex continues without an answer`);
    }
    approval.controller.abort();
  }

  function abortApprovals(replyAllowed: boolean): void {
    for (const approval of approvalRequests.values()) {
      approval.replyAllowed = replyAllowed;
      approval.controller.abort();
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
    abortApprovals(true);
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
      const kind = err instanceof RpcTimeout ? "transient" : classifyError(cliErrorLine(outcome.stderr));
      turn.onMessage({ type: "turn.failed", error: { message, kind: kind === "other" && !/ENOENT|EACCES/.test(tail) ? "transient" : kind } });
      return outcome;
    }
    proc.send({ method: "initialized" });

    const threadParams = { cwd: turn.cwd, sandbox: turn.sandbox, approvalPolicy: turn.interactiveApprovals && turn.onApproval ? "on-request" : "never", model: turn.model, ...(turn.threadConfig ? { config: turn.threadConfig } : {}) };
    let thread: any;
    try {
      thread = turn.forkThreadId
        ? await request("thread/fork", { threadId: turn.forkThreadId, ...threadParams })
        : turn.resumeThreadId
        ? await request("thread/resume", { threadId: turn.resumeThreadId, excludeTurns: true, ...threadParams })
        : await request("thread/start", threadParams);
    } catch (err) {
      // The thread is gone (Codex: "no rollout found for thread id …"): resuming it again won't help.
      if ((turn.resumeThreadId || turn.forkThreadId) && err instanceof RpcError && /no rollout found|thread[^\n]{0,20}not found|invalid thread id/i.test(err.message)) {
        throw new TurnError(err.message, "session_not_found");
      }
      // A resume whose parameters this Codex rejects (-32602: an older one without `excludeTurns`,
      // say) would fail the same way every time; `codex exec resume` continues the thread instead.
      if (unsupported(err) || (turn.resumeThreadId && err instanceof RpcError && err.code === -32602)) {
        proc.kill();
        await exited;
        return { unavailable: (err as Error).message };
      }
      throw err;
    }
    threadId = thread?.thread?.id ?? turn.resumeThreadId;
    const environments = thread?.thread?.environments;
    if (Array.isArray(environments)) {
      localEnvironments = new Set(environments.slice(0, 32)
        .filter((env: any) => typeof env?.environmentId === "string" && env.environmentId.length <= 240 && typeof env.cwd === "string" && isAbsolute(env.cwd) && workspacePath(turn.cwd, env.cwd))
        .map((env: any) => env.environmentId as string));
    }
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
    abortApprovals(false);
    if (steerable) turn.onSteerable?.(undefined);
    turn.signal?.removeEventListener("abort", cancel);
  }
}

/**
 * Normalize only approval kinds whose effect and complete scope can be shown in the UI. Anything
 * else comes back as why it can't be shown, worded to follow "because".
 */
function approvalAction(msg: any, item: any, cwd: string, sandbox: AppServerTurn["sandbox"], localEnvironment: (id: unknown) => boolean): AgentApprovalRequest | string {
  const params = msg.params ?? {};
  if ([params.sandboxPermissions, params.sandbox_permissions, item?.sandboxPermissions, item?.sandbox_permissions].some(value => value !== undefined && value !== "use_default") || item?.additionalPermissions || params.additionalPermissions) return "it asks for permissions beyond this run's sandbox";
  if (sandbox === "read-only") return "this turn is read-only";
  if (params.grantRoot) return "it asks for a lasting write grant";
  if (params.networkApprovalContext) return "it asks for network access";
  if (params.kind && params.kind !== "command") return "it would send input to a running command";
  if (!localEnvironment(params.environmentId)) return "it would run in another Codex environment";
  // Never a decision that amends Codex's policy: only a one-time accept can be offered.
  if (Array.isArray(params.availableDecisions) && !params.availableDecisions.includes("accept")) return "Codex offers no one-time approval for it";
  const reason = typeof params.reason === "string" ? params.reason.slice(0, 4_000) : undefined;
  const id = String(msg.id);
  if (!id || id.length > 240) return "its request id is invalid";
  if (msg.method === "item/commandExecution/requestApproval") {
    const command = params.command ?? item?.command;
    const requestedCwd = params.cwd ?? item?.cwd ?? cwd;
    if (typeof command !== "string" || !command.trim() || command.length > 16_000 || command.includes("\0") || typeof requestedCwd !== "string" || !isAbsolute(requestedCwd)) return "its command can't be shown in full";
    if (!workspacePath(cwd, requestedCwd)) return "it would run outside this run's worktree";
    return { id, kind: "command", command, cwd: requestedCwd, ...(reason ? { reason } : {}) };
  }
  if (!item || item.type !== "fileChange" || !Array.isArray(item.changes) || !item.changes.length || item.changes.length > 200) return "its file changes can't be shown in full";
  if (item.changes.some((change: any) => !["add", "delete", "update"].includes(change.kind?.type ?? change.kind))) return "its file changes can't be shown in full";
  const paths = item.changes.flatMap((change: any) => [change.path, ...(change.kind?.move_path ? [change.kind.move_path] : [])]);
  if (paths.some((path: unknown) => typeof path !== "string" || !path || path.length > 4_096 || path.includes("\0"))) return "its file changes can't be shown in full";
  if (paths.some((path: string) => !workspacePath(cwd, path))) return "it changes files outside this run's worktree";
  return { id, kind: "file-change", paths, cwd, ...(reason ? { reason } : {}) };
}

/** A wait, for a status line: "2 minutes", "45s". */
function waited(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} minute${Math.round(ms / 60_000) === 1 ? "" : "s"}` : seconds(ms);
}

/** A Codex `item/tool/requestUserInput` question with what the inbox shows of it. */
function codexQuestion(q: any): AgentQuestion {
  const options = Array.isArray(q?.options) ? q.options : undefined;
  const descriptions = options?.map((o: any) => typeof o?.description === "string" ? o.description : "");
  return {
    id: q?.id, question: q?.question,
    ...(typeof q?.header === "string" && q.header ? { header: q.header } : {}),
    ...(options ? { options: options.map((o: any) => o?.label) } : {}),
    ...(descriptions?.some(Boolean) ? { optionDescriptions: descriptions } : {}),
  };
}

/** Resolve the nearest existing ancestor to catch links escaping the workspace. */
function workspacePath(cwd: string, requested: string): boolean {
  try {
    const root = realpathSync(cwd);
    const target = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
    let existing = target;
    while (true) {
      try {
        const info = lstatSync(existing);
        if (info.isSymbolicLink()) return false;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
        const parent = dirname(existing);
        if (parent === existing) return false;
        existing = parent;
      }
    }
    const canonical = resolve(realpathSync(existing), relative(existing, target));
    return canonical === root || canonical.startsWith(root + sep);
  } catch { return false; }
}

/** App-server items (camelCase) in the shape `codex exec --json` reports them. */
function execItem(item: any): any {
  switch (item?.type) {
    case "agentMessage":
      return { id: item.id, type: "agent_message", text: item.text, phase: item.phase };
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
      // An item this client doesn't know is counted by the adapter, not dropped without a word.
      return item?.type && IGNORED_ITEMS.has(item.type) ? undefined : { id: item?.id, type: "unrecognized", name: item?.type };
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
