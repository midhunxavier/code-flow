// Stand-in for `codex app-server`: JSON-RPC over stdio (one object per line, no "jsonrpc" field),
// with the methods and notifications code-flow uses (see src/adapters/codex-app-server.ts).
// A turn stays open to `turn/steer` while it runs: a prompt containing WAIT-FOR-STEER keeps a new
// thread's first turn running until a message is steered in (or 20 s pass).
//
// Misbehaviour on request:
//   FAKE_CODEX_SLOW_INIT_MS=<ms>       answer `initialize` only after this long
//   FAKE_CODEX_INIT_CRASH=<message>    print this to stderr and exit 1 when asked to initialize
//   FAKE_CODEX_HANG_METHOD=<method>    never answer this request (e.g. turn/start)
//   FAKE_CODEX_SERVER_REQUEST=<method> ask code-flow this mid-turn; the agent says what came back
//   FAKE_CRASH_VENDOR=codex            die mid-turn, after some output
//   FAKE_HANG_AFTER_RESULT_VENDOR=codex  stay running (and ignore SIGTERM) once stdin closes
//   FAKE_DRIFT_VENDOR=codex            send a notification and an item type code-flow doesn't know (the answer)
//   FAKE_CODEX_RESUME_REJECTS_PARAMS=1 reject thread/resume's parameters (-32602), like an older Codex
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { sleepMs, work } from "./fake-work.mjs";
import { exerciseTeamTools } from "./fake-team-tools.mjs";

class TurnFailure extends Error {
  constructor(message, codexErrorInfo) {
    super(message);
    this.codexErrorInfo = codexErrorInfo ?? null;
  }
}

export async function serve(args) {
  // An older Codex without the app-server subcommand.
  if (process.env.FAKE_NO_APP_SERVER) {
    process.stderr.write("error: unrecognized subcommand 'app-server'\n\nUsage: codex [OPTIONS] [PROMPT]\n");
    process.exit(2);
  }
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  const notify = (method, params) => out({ method, params });
  const fail = (message, codexErrorInfo) => {
    throw new TurnFailure(message, codexErrorInfo);
  };
  // Threads persist across processes like Codex's rollouts, so resume works in a new server.
  const threadsDir = join(process.env.CODEFLOW_HOME ?? ".", ".fake-codex-threads");
  mkdirSync(threadsDir, { recursive: true });
  const threadFile = (id) => join(threadsDir, `${id}.json`);

  let initialized = false;
  /** { id, params, totals, fresh } */
  let thread;
  /** { id, steers: string[], wake?: () => void, interrupted?: boolean } */
  let active;
  let record;
  let nextServerRequest = 1;
  const serverRequests = new Map();
  /** A request to code-flow: resolves with its result, or `{ error }` when it answered with one. */
  const ask = (method, params) =>
    new Promise((resolve) => {
      const id = `srv-${nextServerRequest++}`;
      serverRequests.set(id, resolve);
      out({ id, method, params });
      if (process.env.FAKE_CODEX_APPROVAL_RESOLVE_MS && method.endsWith("/requestApproval")) {
        setTimeout(() => {
          notify("serverRequest/resolved", { threadId: thread?.id, requestId: id });
          serverRequests.get(id)?.({ decision: "decline" });
          serverRequests.delete(id);
        }, Number(process.env.FAKE_CODEX_APPROVAL_RESOLVE_MS));
      }
    });

  const threadInfo = () => ({ id: thread.id, sessionId: thread.id, preview: "", ephemeral: false, modelProvider: "openai", model: thread.params.model ?? "gpt-a", cwd: thread.params.cwd ?? process.cwd(), status: { type: "idle" }, turns: [] });
  const startThread = (params, existing) => {
    thread = { id: existing?.id ?? randomUUID(), params, totals: existing?.totals ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }, fresh: !existing };
    writeFileSync(threadFile(thread.id), JSON.stringify({ id: thread.id, totals: thread.totals }));
    setImmediate(() => notify("thread/started", { thread: threadInfo() }));
    return { thread: threadInfo(), model: thread.params.model ?? "gpt-a", modelProvider: "openai", cwd: thread.params.cwd, approvalPolicy: params.approvalPolicy ?? "on-request", sandbox: { type: params.sandbox === "workspace-write" ? "workspaceWrite" : params.sandbox === "danger-full-access" ? "dangerFullAccess" : "readOnly" } };
  };
  const writeRecord = () => {
    if (record) writeFileSync(record.file, JSON.stringify(record.body));
  };

  /** One model call's tokens: the thread total grows by `last`. */
  const spend = (turnId, last) => {
    for (const key of Object.keys(thread.totals)) thread.totals[key] += last[key];
    writeFileSync(threadFile(thread.id), JSON.stringify({ id: thread.id, totals: thread.totals }));
    const breakdown = (t) => ({ totalTokens: t.inputTokens + t.outputTokens, inputTokens: t.inputTokens, cachedInputTokens: t.cachedInputTokens, cacheWriteInputTokens: 0, outputTokens: t.outputTokens, reasoningOutputTokens: 0 });
    notify("thread/tokenUsage/updated", { threadId: thread.id, turnId, tokenUsage: { total: breakdown(thread.totals), last: breakdown(last), modelContextWindow: 200000 } });
  };

  async function runTurn(turn, params) {
    const prompt = params.input.filter((i) => i.type === "text").map((i) => i.text).join("\n");
    const teamTools = await exerciseTeamTools(args);
    if (process.env.FAKE_RECORD_DIR) {
      record = {
        file: `${process.env.FAKE_RECORD_DIR}/codex-${Date.now()}-${randomUUID().slice(0, 6)}.json`,
        body: { vendor: "codex", transport: "app-server", args, prompt, cwd: process.cwd(), thread: thread.params, turn: { ...params, input: undefined }, steers: [], teamTools },
      };
      writeRecord();
    }
    const base = { threadId: thread.id, turnId: turn.id };
    const item = (it) => {
      notify("item/started", { ...base, item: it, startedAtMs: Date.now() });
      notify("item/completed", { ...base, item: it, completedAtMs: Date.now() });
    };
    notify("turn/started", { threadId: thread.id, turn: { ...turn, status: "inProgress" } });
    item({ type: "userMessage", id: randomUUID(), clientId: null, content: params.input });
    try {
      const write = thread.params.sandbox === "workspace-write" || thread.params.sandbox === "danger-full-access";
      const { answer } = work({ vendor: "codex", prompt, write, schemaRequested: !!params.outputSchema, fail });
      const ls = { type: "commandExecution", id: "i1", command: "ls", cwd: process.cwd(), processId: null, source: "agent", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null, status: "inProgress" };
      notify("item/started", { ...base, item: ls, startedAtMs: Date.now() });
      notify("item/completed", { ...base, item: { ...ls, status: "completed", aggregatedOutput: "a.txt", exitCode: 0, durationMs: 3 }, completedAtMs: Date.now() });
      if (prompt.includes("ASK-APPROVAL")) {
        const cmd = { ...ls, id: "i3", command: "rm -rf build" };
        notify("item/started", { ...base, item: cmd, startedAtMs: Date.now() });
        const { decision } = await ask("item/commandExecution/requestApproval", { ...base, itemId: "i3", command: cmd.command, cwd: process.cwd(), reason: "outside the sandbox", ...JSON.parse(process.env.FAKE_CODEX_APPROVAL_OVERRIDES || "{}") });
        const ran = decision === "accept" || decision === "acceptForSession";
        notify("item/completed", { ...base, item: { ...cmd, status: ran ? "completed" : "declined", exitCode: ran ? 0 : null, aggregatedOutput: "" }, completedAtMs: Date.now() });
      }
      if (prompt.includes("ASK-FILE-APPROVAL")) {
        const changes = JSON.parse(process.env.FAKE_CODEX_FILE_CHANGES || JSON.stringify([{ path: "approved.txt", kind: { type: "add" }, diff: "+approved" }]));
        const patch = { type: "fileChange", id: "patch-approval", changes, status: "inProgress" };
        notify("item/started", { ...base, item: patch, startedAtMs: Date.now() });
        const { decision } = await ask("item/fileChange/requestApproval", { ...base, itemId: patch.id, reason: "Review this patch", ...JSON.parse(process.env.FAKE_CODEX_APPROVAL_OVERRIDES || "{}") });
        notify("item/completed", { ...base, item: { ...patch, status: decision === "accept" ? "completed" : "declined" }, completedAtMs: Date.now() });
      }
      if (process.env.FAKE_CODEX_SERVER_REQUEST) {
        const method = process.env.FAKE_CODEX_SERVER_REQUEST;
        const answer = await ask(method, { ...base, itemId: "i4", reason: "wants to reach the network", ...JSON.parse(process.env.FAKE_CODEX_SERVER_REQUEST_PARAMS || "{}") });
        item({ type: "agentMessage", id: "i4", text: `${method} got ${JSON.stringify(answer)}`, phase: "commentary", memoryCitation: null, delivery: null, questions: null });
      }
      if (forCodex("CRASH")) {
        process.stderr.write("thread 'main' panicked: fake crash mid-turn\n");
        process.exit(1);
      }
      notify("turn/plan/updated", { ...base, explanation: null, plan: [{ step: "Look around", status: "completed" }, { step: "Answer", status: "inProgress" }] });
      // Codex reports a reconnect as an `error` it will retry, then carries on: not a failure.
      if (process.env.FAKE_CODEX_WARN) notify("error", { ...base, willRetry: true, error: { message: "Reconnecting... 1/5", codexErrorInfo: null, additionalDetails: null } });
      spend(turn.id, { inputTokens: 120, cachedInputTokens: 80, outputTokens: 1 });

      const pause = sleepMs("codex");
      const waitForSteer = prompt.includes("WAIT-FOR-STEER") && thread.fresh && !active.steers.length;
      if (pause || waitForSteer) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, waitForSteer ? 20_000 : pause);
          active.wake = () => {
            // A steered message ends the wait, and an interrupt ends any wait; otherwise a plain
            // sleep runs its course.
            if (waitForSteer || active?.interrupted) {
              clearTimeout(timer);
              setTimeout(resolve, active?.interrupted ? 0 : 300);
            }
          };
        });
      }
      if (active.interrupted) {
        notify("turn/completed", { threadId: thread.id, turn: { ...turn, status: "interrupted", error: null } });
        return;
      }
      spend(turn.id, { inputTokens: 180, cachedInputTokens: 120, outputTokens: 1 });
      item({ type: "reasoning", id: "r1", summary: ["Thinking it over"], content: [] });
      // FAKE_DRIFT_VENDOR=codex: a newer protocol, with the answer in an item type code-flow doesn't know.
      if (forCodex("DRIFT")) notify("turn/insights/updated", { ...base });
      item({ type: forCodex("DRIFT") ? "agentReply" : "agentMessage", id: "i2", text: answer, phase: "final_answer", memoryCitation: null, delivery: null, questions: null });
      notify("turn/completed", { threadId: thread.id, turn: { ...turn, status: "completed", error: null, completedAt: Math.floor(Date.now() / 1000) } });
    } catch (err) {
      if (!(err instanceof TurnFailure)) throw err;
      const error = { message: err.message, codexErrorInfo: err.codexErrorInfo, additionalDetails: null, misalignment: null };
      notify("error", { ...base, willRetry: false, error });
      notify("turn/completed", { threadId: thread.id, turn: { ...turn, status: "failed", error } });
    } finally {
      active = undefined;
      thread.fresh = false;
    }
  }

  const handlers = {
    initialize: () => {
      if (process.env.FAKE_CODEX_INIT_CRASH) {
        process.stderr.write(`${process.env.FAKE_CODEX_INIT_CRASH}\n`);
        process.exit(1);
      }
      if (initialized) throw rpcError(-32600, "Already initialized");
      initialized = true;
      return { userAgent: "codex_cli_rs/0.162.1 (fake)", codexHome: join(process.env.CODEFLOW_HOME ?? ".", ".codex"), platformFamily: "unix", platformOs: "macos" };
    },
    "thread/start": (params) => startThread(params),
    "thread/resume": (params) => {
      // An older Codex whose thread/resume doesn't take every parameter code-flow sends.
      if (process.env.FAKE_CODEX_RESUME_REJECTS_PARAMS) throw rpcError(-32602, "Invalid request: unknown field `excludeTurns`");
      if (!existsSync(threadFile(params.threadId))) throw rpcError(-32600, `no rollout found for thread id ${params.threadId}`);
      return startThread(params, JSON.parse(readFileSync(threadFile(params.threadId), "utf8")));
    },
    "turn/start": (params) => {
      if (!thread || params.threadId !== thread.id) throw rpcError(-32600, `thread not found: ${params.threadId}`);
      if (active) throw rpcError(-32600, "a turn is already running");
      const turn = { id: randomUUID(), rootTurnId: null, items: [], itemsView: "full", status: "inProgress", error: null, startedAt: Math.floor(Date.now() / 1000), completedAt: null, durationMs: null };
      active = { id: turn.id, steers: [] };
      // Answer first, like the real server: the turn then runs while requests keep coming in.
      setImmediate(() => runTurn(turn, params));
      return { turn };
    },
    "turn/steer": (params) => {
      if (!active) throw rpcError(-32600, "no active turn to steer");
      if (params.expectedTurnId !== active.id) throw rpcError(-32600, `expected active turn id ${params.expectedTurnId} but found ${active.id}`);
      const text = params.input.filter((i) => i.type === "text").map((i) => i.text).join("\n");
      active.steers.push(text);
      if (record) {
        record.body.steers.push(text);
        writeRecord();
      }
      const base = { threadId: thread.id, turnId: active.id };
      const userMessage = { type: "userMessage", id: randomUUID(), clientId: null, content: params.input };
      notify("item/started", { ...base, item: userMessage, startedAtMs: Date.now() });
      notify("item/completed", { ...base, item: userMessage, completedAtMs: Date.now() });
      const ack = { type: "agentMessage", id: randomUUID(), text: `Got your message: ${text.split("\n").at(-1).replace(/^- /, "")}`, phase: "commentary", memoryCitation: null, delivery: null, questions: null };
      notify("item/completed", { ...base, item: ack, completedAtMs: Date.now() });
      active.wake?.();
      return { turnId: active.id };
    },
    "turn/interrupt": (params) => {
      if (active && params.turnId === active.id) {
        active.interrupted = true;
        if (record) {
          record.body.interrupted = true;
          writeRecord();
        }
        active.wake?.();
      }
      return {};
    },
    "thread/unsubscribe": () => {
      setImmediate(() => notify("thread/closed", { threadId: thread?.id }));
      return { status: "unsubscribed" };
    },
  };

  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (msg.method === undefined) {
      // A response to one of our requests (an approval).
      serverRequests.get(msg.id)?.(msg.result ?? (msg.error ? { error: msg.error } : {}));
      serverRequests.delete(msg.id);
      return;
    }
    if (msg.id === undefined) return; // notifications: `initialized`
    if (msg.method === process.env.FAKE_CODEX_HANG_METHOD) return; // never answered
    const answer = () => {
      try {
        if (!initialized && msg.method !== "initialize") throw rpcError(-32600, "Not initialized");
        const handler = handlers[msg.method];
        if (!handler) throw rpcError(-32601, `Method not found: ${msg.method}`);
        out({ id: msg.id, result: handler(msg.params ?? {}) });
      } catch (err) {
        out({ id: msg.id, error: { code: err.code ?? -32603, message: err.message } });
      }
    };
    const slow = msg.method === "initialize" ? Number(process.env.FAKE_CODEX_SLOW_INIT_MS ?? 0) : 0;
    if (slow) setTimeout(answer, slow);
    else answer();
  });
  // Like the real server: stdin closing ends it (after what it already wrote is flushed).
  await new Promise((resolve) => lines.on("close", resolve));
  if (forCodex("HANG_AFTER_RESULT")) {
    process.on("SIGTERM", () => {});
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
  process.stdout.write("", () => process.exit(0));
  await new Promise(() => {});
}

function rpcError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** FAKE_<name>_VENDOR names codex (alone, or in a comma-separated list). */
function forCodex(name) {
  return (process.env[`FAKE_${name}_VENDOR`] ?? "").split(",").includes("codex");
}
