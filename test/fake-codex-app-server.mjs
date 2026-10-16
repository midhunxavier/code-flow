// Stand-in for `codex app-server`: JSON-RPC over stdio (one object per line, no "jsonrpc" field),
// with the methods and notifications code-flow uses (see src/adapters/codex-app-server.ts).
// A turn stays open to `turn/steer` while it runs: a prompt containing WAIT-FOR-STEER keeps a new
// thread's first turn running until a message is steered in (or 20 s pass).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { sleepMs, work } from "./fake-work.mjs";

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
  const ask = (method, params) =>
    new Promise((resolve) => {
      const id = `srv-${nextServerRequest++}`;
      serverRequests.set(id, resolve);
      out({ id, method, params });
    });

  const threadInfo = () => ({ id: thread.id, sessionId: thread.id, preview: "", ephemeral: false, modelProvider: "openai", model: thread.params.model ?? "gpt-a", cwd: thread.params.cwd ?? process.cwd(), status: { type: "idle" }, turns: [] });
  const startThread = (params, existing) => {
    thread = { id: existing?.id ?? randomUUID(), params, totals: existing?.totals ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }, fresh: !existing };
    writeFileSync(threadFile(thread.id), JSON.stringify({ id: thread.id, totals: thread.totals }));
    setImmediate(() => notify("thread/started", { thread: threadInfo() }));
    return { thread: threadInfo(), model: thread.params.model ?? "gpt-a", modelProvider: "openai", cwd: thread.params.cwd, approvalPolicy: params.approvalPolicy ?? "on-request", sandbox: { type: params.sandbox === "workspace-write" ? "workspaceWrite" : "readOnly" } };
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
    if (process.env.FAKE_RECORD_DIR) {
      record = {
        file: `${process.env.FAKE_RECORD_DIR}/codex-${Date.now()}-${randomUUID().slice(0, 6)}.json`,
        body: { vendor: "codex", transport: "app-server", args, prompt, cwd: process.cwd(), thread: thread.params, turn: { ...params, input: undefined }, steers: [] },
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
      const write = thread.params.sandbox === "workspace-write";
      const { answer } = work({ vendor: "codex", prompt, write, schemaRequested: !!params.outputSchema, fail });
      const ls = { type: "commandExecution", id: "i1", command: "ls", cwd: process.cwd(), processId: null, source: "agent", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null, status: "inProgress" };
      notify("item/started", { ...base, item: ls, startedAtMs: Date.now() });
      notify("item/completed", { ...base, item: { ...ls, status: "completed", aggregatedOutput: "a.txt", exitCode: 0, durationMs: 3 }, completedAtMs: Date.now() });
      if (prompt.includes("ASK-APPROVAL")) {
        const cmd = { ...ls, id: "i3", command: "rm -rf build" };
        notify("item/started", { ...base, item: cmd, startedAtMs: Date.now() });
        const { decision } = await ask("item/commandExecution/requestApproval", { ...base, itemId: "i3", command: cmd.command, cwd: process.cwd(), reason: "outside the sandbox" });
        const ran = decision === "accept" || decision === "acceptForSession";
        notify("item/completed", { ...base, item: { ...cmd, status: ran ? "completed" : "declined", exitCode: ran ? 0 : null, aggregatedOutput: "" }, completedAtMs: Date.now() });
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
            // A steered message ends the wait; a plain sleep runs its course.
            if (waitForSteer) {
              clearTimeout(timer);
              setTimeout(resolve, 300);
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
      item({ type: "agentMessage", id: "i2", text: answer, phase: "final_answer", memoryCitation: null, delivery: null, questions: null });
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
      if (initialized) throw rpcError(-32600, "Already initialized");
      initialized = true;
      return { userAgent: "codex_cli_rs/0.162.1 (fake)", codexHome: join(process.env.CODEFLOW_HOME ?? ".", ".codex"), platformFamily: "unix", platformOs: "macos" };
    },
    "thread/start": (params) => startThread(params),
    "thread/resume": (params) => {
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
      serverRequests.get(msg.id)?.(msg.result ?? {});
      serverRequests.delete(msg.id);
      return;
    }
    if (msg.id === undefined) return; // notifications: `initialized`
    try {
      if (!initialized && msg.method !== "initialize") throw rpcError(-32600, "Not initialized");
      const handler = handlers[msg.method];
      if (!handler) throw rpcError(-32601, `Method not found: ${msg.method}`);
      out({ id: msg.id, result: handler(msg.params ?? {}) });
    } catch (err) {
      out({ id: msg.id, error: { code: err.code ?? -32603, message: err.message } });
    }
  });
  // Like the real server: stdin closing ends it (after what it already wrote is flushed).
  await new Promise((resolve) => lines.on("close", resolve));
  process.stdout.write("", () => process.exit(0));
  await new Promise(() => {});
}

function rpcError(code, message) {
  return Object.assign(new Error(message), { code });
}
