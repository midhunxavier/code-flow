// Codex through `codex app-server`: the same events as `codex exec`, per-turn usage on resumed
// threads, and your messages delivered into a turn while it runs. Fake app-server only.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-appserver-home-"));

const { appServerCheck, codexAdapter } = await import("../src/adapters/codex.js");
const { runAppServerTurn } = await import("../src/adapters/codex-app-server.js");
const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
type AgentEvent = import("../src/adapters/types.js").AgentEvent;
type RunOptions = import("../src/adapters/types.js").RunOptions;
type AppServerTurn = import("../src/adapters/codex-app-server.js").AppServerTurn;
type Run = import("../src/engine.js").Run;
type Manager = InstanceType<typeof RunManager>;

let repo: string;
const pipeline = { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] } as Record<string, any>;

before(() => {
  repo = mkdtempSync(join(tmpdir(), "codeflow-appserver-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "steer\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
});

async function turn(prompt: string, extra: Partial<RunOptions> = {}) {
  const events: AgentEvent[] = [];
  const result = await codexAdapter.run({ prompt, cwd: mkdtempSync(join(tmpdir(), "codeflow-appserver-cwd-")), mode: "read", ...extra }, (e) => events.push(e));
  return { result, events };
}
/** One turn straight through the app-server client, for timeouts the adapter doesn't expose. */
async function served(prompt: string, extra: Partial<AppServerTurn> = {}) {
  const messages: any[] = [];
  const started = Date.now();
  const outcome = await runAppServerTurn({
    prompt,
    cwd: mkdtempSync(join(tmpdir(), "codeflow-appserver-cwd-")),
    sandbox: "read-only",
    config: [],
    onMessage: (m) => messages.push(m),
    onText: () => {},
    ...extra,
  });
  return { outcome, failed: messages.find((m) => m.type === "turn.failed"), ms: Date.now() - started };
}
/** Run `fn` with these environment variables set (the fake reads them when it starts). */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
function finished(m: Manager, run: Run): Promise<void> {
  return new Promise((resolve) => {
    const check = () => run.status !== "running" && resolve();
    m.subscribe(run.id, check);
    check();
  });
}
async function until(condition: () => boolean, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const recorded = (dir: string) => readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a turn streams the same events as codex exec, and usage is per turn on a resumed thread", async () => {
  const first = await turn("Look around");
  assert.ok(first.result.ok, first.result.error);
  assert.equal(first.result.finalText, "codex handled the request.");
  const kinds = first.events.map((e) => e.kind);
  assert.deepEqual(kinds.slice(0, 3), ["session", "tool_call", "tool_result"]);
  assert.ok(first.events.some((e) => e.kind === "status" && e.text === "✓ Look around\n○ Answer"), "the plan shows as a todo list");
  assert.ok(first.events.some((e) => e.kind === "thinking" && e.text === "Thinking it over"));
  assert.deepEqual(first.events.find((e) => e.kind === "usage"), { kind: "usage", inputTokens: 100, outputTokens: 2, cacheReadTokens: 200 });

  // The thread's totals now include the first turn; the second turn still reports only its own.
  const second = await turn("And again", { resumeSessionId: first.result.sessionId });
  assert.ok(second.result.ok, second.result.error);
  assert.equal(second.result.sessionId, first.result.sessionId);
  assert.deepEqual(second.events.find((e) => e.kind === "usage"), { kind: "usage", inputTokens: 100, outputTokens: 2, cacheReadTokens: 200 });

  const missing = await turn("Resume nothing", { resumeSessionId: "no-such-thread" });
  assert.equal(missing.result.ok, false);
  assert.match(missing.result.error!, /no rollout found for thread id no-such-thread/);
  assert.equal(missing.result.errorKind, "session_not_found");
  assert.equal(missing.result.sessionId, undefined, "the dead thread isn't handed back for the next follow-up");
});

test("sandbox, model, effort and the output schema go to the thread and the turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codeflow-appserver-record-"));
  process.env.FAKE_RECORD_DIR = dir;
  const schema = { type: "object", properties: { verdict: { enum: ["pass", "fail"] } } };
  try {
    const { result } = await turn('Reply with {"verdict": "pass" | "fail"}', { mode: "write", trust: "trusted", model: "gpt-a", effort: "high", jsonSchema: schema });
    assert.ok(result.ok, result.error);
    assert.deepEqual(result.structured, { verdict: "pass", failures: [] });
  } finally {
    delete process.env.FAKE_RECORD_DIR;
  }
  const [call] = recorded(dir);
  assert.equal(call.transport, "app-server");
  assert.deepEqual(call.args, ["app-server", "-c", "sandbox_workspace_write.network_access=true"]);
  assert.deepEqual([call.thread.sandbox, call.thread.approvalPolicy, call.thread.model], ["workspace-write", "never", "gpt-a"]);
  assert.deepEqual([call.turn.effort, call.turn.outputSchema], ["high", schema]);
});

test("full access: a write turn has no sandbox (both transports); a read turn stays read-only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codeflow-appserver-record-"));
  process.env.FAKE_RECORD_DIR = dir;
  try {
    assert.ok((await turn("Write it", { mode: "write", trust: "full" })).result.ok);
    assert.ok((await turn("Look around", { mode: "read", trust: "full" })).result.ok);
    process.env.CODEFLOW_CODEX_TRANSPORT = "exec";
    assert.ok((await turn("Write it with exec", { mode: "write", trust: "full" })).result.ok);
  } finally {
    delete process.env.FAKE_RECORD_DIR;
    delete process.env.CODEFLOW_CODEX_TRANSPORT;
  }
  const calls = recorded(dir);
  const call = (prompt: string) => calls.find((c) => c.prompt.includes(prompt))!;
  assert.equal(call("Write it").thread.sandbox, "danger-full-access");
  assert.deepEqual(call("Write it").args, ["app-server"], "no network override: there's no sandbox to open");
  assert.equal(call("Look around").thread.sandbox, "read-only");
  assert.ok(call("Write it with exec").args.includes('sandbox_mode="danger-full-access"'));
});

test("a message steered into a running turn reaches it; once the turn is over it can't", async () => {
  let steer: ((text: string) => Promise<boolean>) | undefined;
  const changes: boolean[] = [];
  const running = turn("WAIT-FOR-STEER", {
    onSteerable: (s) => {
      steer = s;
      changes.push(!!s);
    },
  });
  await until(() => !!steer);
  const live = steer!;
  assert.equal(await live("## A message from the user\n- Use tabs"), true);
  const { result, events } = await running;
  assert.ok(result.ok, result.error);
  assert.ok(events.some((e) => e.kind === "text" && e.text === "Got your message: Use tabs"), "the agent saw it during the turn");
  assert.deepEqual(changes, [true, false]);
  assert.equal(await live("too late"), false);
});

test("approval requests are declined: runs are headless", async () => {
  const { result, events } = await turn("ASK-APPROVAL");
  assert.ok(result.ok, result.error);
  assert.ok(events.some((e) => e.kind === "tool_result" && e.callId === "i3" && e.isError), "the declined command shows as failed");
  assert.ok(events.some((e) => e.kind === "status" && /asked for approval \(commandExecution\); declined/.test(e.text)));
});

test("interactive command approvals are opt-in, one-shot and keep the original sandbox", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codeflow-approval-record-"));
  const requests: import("../src/adapters/types.js").AgentApprovalRequest[] = [];
  const configured = { mode: "write" as const, onApproval: async (request: import("../src/adapters/types.js").AgentApprovalRequest) => { requests.push(request); return "approve" as const; } };
  assert.ok((await turn("ASK-APPROVAL", configured)).result.ok);
  assert.equal(requests.length, 0, "a callback alone cannot opt a headless run into approval");
  const approved = await withEnv({ FAKE_RECORD_DIR: dir }, () => turn("ASK-APPROVAL", { ...configured, interactiveApprovals: true }));
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.kind, "command");
  assert.equal(requests[0]!.command, "rm -rf build");
  assert.ok(approved.result.ok, approved.result.error);
  assert.ok(approved.events.some((event) => event.kind === "tool_result" && event.callId === "i3" && !event.isError));
  const [record] = recorded(dir);
  assert.equal(record.thread.approvalPolicy, "on-request");
  assert.equal(record.thread.sandbox, "workspace-write");
  assert.ok(approved.events.some((event) => event.kind === "status" && /approved once/.test(event.text)));
});

test("interactive approvals decline unsupported scope and mismatched requests before presenting them", async () => {
  let callbacks = 0;
  const opts = { mode: "write" as const, interactiveApprovals: true, onApproval: async () => { callbacks++; return "approve" as const; } };
  const overrides = [
    { sandboxPermissions: "require_escalated" }, { sandbox_permissions: "require_escalated" },
    { sandboxPermissions: "unknown-grant" }, { sandbox_permissions: { network: true } },
    { threadId: "another-thread" }, { turnId: "another-turn" }, { kind: "writeStdin" },
    { cwd: tmpdir() }, { networkApprovalContext: { host: "example.com", protocol: "https" } },
    { additionalPermissions: { network: { enabled: true } } }, { environmentId: "remote-environment" },
  ];
  for (const override of overrides) {
    const denied = await withEnv({ FAKE_CODEX_APPROVAL_OVERRIDES: JSON.stringify(override) }, () => turn("ASK-APPROVAL", opts));
    assert.ok(denied.result.ok, denied.result.error);
    assert.ok(denied.events.some((event) => event.kind === "tool_result" && event.callId === "i3" && event.isError));
  }
  await turn("ASK-APPROVAL", { ...opts, mode: "read" });
  assert.equal(callbacks, 0);
});

test("file approval previews include rename targets and refuse grants or paths outside the worktree", async () => {
  const requests: import("../src/adapters/types.js").AgentApprovalRequest[] = [];
  const opts = { mode: "write" as const, interactiveApprovals: true, onApproval: async (request: import("../src/adapters/types.js").AgentApprovalRequest) => { requests.push(request); return "approve" as const; } };
  const changes = [{ path: "original.ts", kind: { type: "update", move_path: "renamed.ts" }, diff: "rename" }];
  const accepted = await withEnv({ FAKE_CODEX_FILE_CHANGES: JSON.stringify(changes) }, () => turn("ASK-FILE-APPROVAL", opts));
  assert.ok(accepted.result.ok, accepted.result.error);
  assert.deepEqual(requests[0]!.paths, ["original.ts", "renamed.ts"]);
  assert.ok(accepted.events.some((event) => event.kind === "tool_result" && event.callId === "patch-approval" && !event.isError));
  const outside = await withEnv({ FAKE_CODEX_FILE_CHANGES: JSON.stringify([{ ...changes[0], kind: { type: "update", move_path: "../outside.ts" } }]) }, () => turn("ASK-FILE-APPROVAL", opts));
  const sessionGrant = await withEnv({ FAKE_CODEX_APPROVAL_OVERRIDES: JSON.stringify({ grantRoot: "/" }) }, () => turn("ASK-FILE-APPROVAL", opts));
  assert.equal(requests.length, 1, "unsafe file requests never enter the inbox");
  for (const denied of [outside, sessionGrant]) assert.ok(denied.events.some((event) => event.kind === "tool_result" && event.callId === "patch-approval" && event.isError));
});

test("waiting for a user's approval pauses the idle watchdog and resumes when answered", async () => {
  const approved = await turn("ASK-APPROVAL", {
    mode: "write", interactiveApprovals: true, idleTimeoutMs: 1200,
    onApproval: async () => { await new Promise((resolve) => setTimeout(resolve, 1800)); return "approve"; },
  });
  assert.ok(approved.result.ok, approved.result.error);
  assert.ok(approved.events.some((event) => event.kind === "tool_result" && event.callId === "i3" && !event.isError));
});

test("approval expiry, turn cancellation, and server resolution invalidate late responses", async () => {
  let timedOutSignal: AbortSignal | undefined;
  const expired = await served("ASK-APPROVAL", {
    sandbox: "workspace-write", interactiveApprovals: true, approvalTimeoutMs: 60,
    onApproval: async (_request, signal) => { timedOutSignal = signal; return new Promise(() => {}); },
  });
  assert.ok(!("unavailable" in expired.outcome));
  assert.equal(timedOutSignal?.aborted, true);
  assert.equal(expired.failed, undefined, "a declined request does not itself fail the turn");

  const controller = new AbortController();
  let cancelSignal: AbortSignal | undefined;
  const running = turn("ASK-APPROVAL", {
    mode: "write", interactiveApprovals: true, signal: controller.signal,
    onApproval: async (_request, signal) => { cancelSignal = signal; return new Promise(() => {}); },
  });
  await until(() => !!cancelSignal);
  controller.abort();
  assert.equal((await running).result.errorKind, "cancelled");
  assert.equal(cancelSignal!.aborted, true);

  let resolvedSignal: AbortSignal | undefined;
  const resolved = await withEnv({ FAKE_CODEX_APPROVAL_RESOLVE_MS: "30" }, () => turn("ASK-APPROVAL", {
    mode: "write", interactiveApprovals: true,
    onApproval: async (_request, signal) => { resolvedSignal = signal; await new Promise((resolve) => setTimeout(resolve, 100)); return "approve"; },
  }));
  assert.ok(resolved.result.ok, resolved.result.error);
  assert.equal(resolvedSignal?.aborted, true);
  assert.ok(resolved.events.some((event) => event.kind === "tool_result" && event.callId === "i3" && event.isError));
  assert.ok(!resolved.events.some((event) => event.kind === "status" && /approved once/.test(event.text)));
});

test("hard process timeouts still cancel a pending approval", async () => {
  let approvalSignal: AbortSignal | undefined;
  const timed = await turn("ASK-APPROVAL", {
    mode: "write", interactiveApprovals: true, timeoutMs: 3000, idleTimeoutMs: 1200,
    onApproval: async (_request, signal) => { approvalSignal = signal; return new Promise(() => {}); },
  });
  assert.equal(timed.result.errorKind, "timeout");
  assert.equal(approvalSignal?.aborted, true);
});

test("cancelling a turn stops the server and everything it started", async () => {
  const pidfile = join(mkdtempSync(join(tmpdir(), "codeflow-appserver-pid-")), "linger.pid");
  process.env.FAKE_LINGER_VENDOR = "codex";
  process.env.FAKE_LINGER_PIDFILE = pidfile;
  process.env.FAKE_SLEEP_VENDOR = "codex";
  process.env.FAKE_SLEEP_MS = "20000";
  const controller = new AbortController();
  let steerable = false;
  try {
    const running = turn("Take your time", { signal: controller.signal, onSteerable: (s) => (steerable ||= !!s) });
    await until(() => steerable && existsSync(pidfile)); // mid-turn, with the background process running
    controller.abort();
    const { result } = await running;
    assert.equal(result.ok, false);
    assert.match(result.error!, /codex was cancelled/);
  } finally {
    delete process.env.FAKE_LINGER_VENDOR;
    delete process.env.FAKE_LINGER_PIDFILE;
    delete process.env.FAKE_SLEEP_VENDOR;
    delete process.env.FAKE_SLEEP_MS;
  }
  const pid = Number(readFileSync(pidfile, "utf8"));
  await until(() => !alive(pid), 8_000);
});

test("cancelling interrupts the turn first, so Codex records it before the server is stopped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codeflow-appserver-record-"));
  const controller = new AbortController();
  let steerable = false;
  const { result, ms } = await withEnv({ FAKE_RECORD_DIR: dir, FAKE_SLEEP_VENDOR: "codex", FAKE_SLEEP_MS: "20000" }, async () => {
    const running = turn("Take your time", { signal: controller.signal, onSteerable: (s) => (steerable ||= !!s) });
    await until(() => steerable);
    const cancelled = Date.now();
    controller.abort();
    return { ...(await running), ms: Date.now() - cancelled };
  });
  assert.equal(result.errorKind, "cancelled", result.error);
  assert.equal(recorded(dir)[0].interrupted, true);
  assert.ok(ms < 2_500, `the interrupted turn ended at once (${ms} ms)`);
});

test("a slow initialize fails the turn as worth a retry; it isn't taken for a missing app-server", async () => {
  const { outcome, failed, ms } = await withEnv({ FAKE_CODEX_SLOW_INIT_MS: "5000" }, () => served("Look around", { initTimeoutMs: 300 }));
  assert.ok(!("unavailable" in outcome), "no exec fallback for a slow start");
  assert.equal(failed?.error.kind, "transient");
  assert.match(failed?.error.message, /codex app-server didn't answer within 300 ms of starting/);
  assert.ok(ms < 4_000, `${ms} ms`);
});

test("an app-server that fails to start fails that turn only: the next turn uses app-server again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codeflow-appserver-record-"));
  const signedOut = await withEnv({ FAKE_CODEX_INIT_CRASH: "Error: Not logged in. Run `codex login` first." }, () => turn("Look around"));
  assert.equal(signedOut.result.ok, false);
  assert.equal(signedOut.result.errorKind, "auth", signedOut.result.error);
  assert.equal(appServerCheck.missing, undefined);
  const next = await withEnv({ FAKE_RECORD_DIR: dir }, () => turn("Look around"));
  assert.ok(next.result.ok, next.result.error);
  assert.deepEqual(recorded(dir).map((c) => c.transport), ["app-server"]);
});

test("a request the server never answers times out cleanly", async () => {
  for (const method of ["thread/start", "turn/start"]) {
    const { outcome, failed, ms } = await withEnv({ FAKE_CODEX_HANG_METHOD: method }, () => served("Look around", { requestTimeoutMs: 400 }));
    assert.ok(!("unavailable" in outcome));
    assert.equal(failed?.error.kind, "transient", method);
    assert.match(failed?.error.message, new RegExp(`${method} got no answer within 400 ms`));
    assert.ok(ms < 4_000, `${method}: ${ms} ms`);
  }
  // Silent while waiting: the stall watchdog stops it long before the 2-minute request timeout.
  const stalled = await withEnv({ FAKE_CODEX_HANG_METHOD: "turn/start" }, () => turn("Look around", { idleTimeoutMs: 500 }));
  assert.equal(stalled.result.errorKind, "stalled", stalled.result.error);
});

test("requests code-flow doesn't know are answered, and the run shows what Codex asked", async () => {
  const cases: [string, RegExp][] = [
    ["item/permissions/requestApproval", /got \{"permissions":\{\},"scope":"turn"\}/],
    ["mcpServer/elicitation/request", /got \{"action":"decline","content":null\}/],
    ["item/tool/requestUserInput", /got \{"error":\{"code":-32601/],
  ];
  for (const [method, answer] of cases) {
    const { result, events } = await withEnv({ FAKE_CODEX_SERVER_REQUEST: method }, () => turn("Look around"));
    assert.ok(result.ok, result.error);
    assert.ok(events.some((e) => e.kind === "status" && e.text.includes(method) && e.text.includes("wants to reach the network")), `${method} is shown`);
    assert.ok(events.some((e) => e.kind === "text" && answer.test(e.text)), `${method} was answered`);
  }
});

test("Auto members get structured question guidance without granting native permissions", async () => {
  for (const method of ["item/tool/requestUserInput", "mcpServer/elicitation/request"]) {
    const { result, events } = await withEnv({ FAKE_CODEX_SERVER_REQUEST: method }, () => turn("Ask through the team outcome", { questionProtocol: "structured" }));
    assert.ok(result.ok, result.error);
    assert.ok(events.some((event) => event.kind === "status" && event.text.includes("needs_info")));
    assert.ok(events.some((event) => event.kind === "text" && /got \{(?:"error"|"action":"decline")/.test(event.text)));
  }
  const denied = await withEnv({ FAKE_CODEX_SERVER_REQUEST: "item/permissions/requestApproval" }, () => turn("Ask through the team outcome", { questionProtocol: "structured" }));
  assert.ok(denied.events.some((event) => event.kind === "text" && event.text.includes('got {"permissions":{},"scope":"turn"}')));
});

test("app-server: a crash mid-turn fails it; a hang after the turn doesn't", async () => {
  const crashed = await withEnv({ FAKE_CRASH_VENDOR: "codex" }, () => turn("Look around"));
  assert.equal(crashed.result.ok, false);
  assert.equal(crashed.result.errorKind, "other", crashed.result.error);
  assert.match(crashed.result.error!, /fake crash mid-turn/);

  const started = Date.now();
  const hung = await withEnv({ FAKE_HANG_AFTER_RESULT_VENDOR: "codex" }, () => turn("Look around"));
  assert.ok(hung.result.ok, hung.result.error);
  assert.equal(hung.result.finalText, "codex handled the request.");
  assert.ok(Date.now() - started < 20_000);
});

test("a note sent while a Codex step runs is delivered into that step; one for another agent waits for its turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codeflow-appserver-record-"));
  process.env.FAKE_RECORD_DIR = dir;
  const started = Date.now();
  let run: Run;
  let m: Manager;
  try {
    m = new RunManager(findPattern);
    run = await m.start({ pattern: findPattern("pipeline")!, task: "Steer me WAIT-FOR-STEER", repo, roles: pipeline, options: {} });
    await until(() => run.steps.some((s) => s.title === "Implement plan" && s.status === "running"));
    const forCodex = m.addNote(run.id, "Prefer tabs over spaces", "codex");
    const forClaude = m.addNote(run.id, "Check the README too", "claude");
    assert.equal(forClaude.status, "queued", "Claude isn't running: it gets it at its next turn");
    await finished(m, run);
    assert.equal(run.status, "done", run.error);
    assert.equal(forCodex.status, "delivered");
  } finally {
    delete process.env.FAKE_RECORD_DIR;
  }
  assert.ok(Date.now() - started < 15_000, "the turn ended once the message arrived, not after the fake's 20 s wait");

  const implement = run.steps.find((s) => s.title === "Implement plan")!;
  const review = run.steps.find((s) => s.title === "Review (round 1)")!;
  assert.deepEqual(
    run.notes.map((n) => [n.text, n.status, n.deliveredTo]),
    [
      ["Prefer tabs over spaces", "delivered", { stepId: implement.id, agent: "codex", midTurn: true }],
      ["Check the README too", "delivered", { stepId: review.id, agent: "claude" }],
    ],
  );
  const codexCall = recorded(dir).find((c) => c.vendor === "codex")!;
  assert.doesNotMatch(codexCall.prompt, /Prefer tabs/, "it wasn't in the turn's opening prompt");
  assert.equal(codexCall.steers.length, 1);
  assert.match(codexCall.steers[0], /^## A message from the user\n\(Sent while you were working on this — take it into account from here on\.\)\n- Prefer tabs over spaces$/);
  const events = await m!.events(run.id);
  assert.ok(events.some((e) => e.type === "agent" && e.stepId === implement.id && e.event.kind === "status" && e.event.text === "Your message reached this turn: Prefer tabs over spaces"));
  assert.ok(events.some((e) => e.type === "agent" && e.stepId === implement.id && e.event.kind === "text" && e.event.text === "Got your message: Prefer tabs over spaces"));
  assert.ok(events.some((e) => e.type === "log" && e.text === "Message delivered to codex mid-turn: Prefer tabs over spaces"));
});

test("a note a turn could no longer take goes back in the queue for the next turn", async () => {
  process.env.FAKE_SLEEP_VENDOR = "claude";
  process.env.FAKE_SLEEP_MS = "1500";
  try {
    const m = new RunManager(findPattern);
    const run = await m.start({ pattern: findPattern("pipeline")!, task: "Requeue", repo, roles: pipeline, options: {} });
    await until(() => run.steps.some((s) => s.title === "Plan" && s.status === "running"));
    // A Codex turn that ended just as the message arrived.
    let asked = 0;
    m.setSteerer(run, "s-gone", "codex", async () => (asked++, false));
    const note = m.addNote(run.id, "Use the logger");
    assert.deepEqual(note.deliveredTo, { stepId: "s-gone", agent: "codex", midTurn: true }, "tried right away");
    await until(() => note.status === "queued");
    await finished(m, run);
    assert.equal(run.status, "done", run.error);
    assert.equal(asked, 1);
    const implement = run.steps.find((s) => s.title === "Implement plan")!;
    assert.deepEqual(note.deliveredTo, { stepId: implement.id, agent: "codex" }, "the next turn got it in its prompt");
  } finally {
    delete process.env.FAKE_SLEEP_VENDOR;
    delete process.env.FAKE_SLEEP_MS;
  }
});

// Last: "auto" remembers for 10 minutes that app-server is missing.
test("without app-server, Codex falls back to codex exec (unless app-server is required), and checks again later", async () => {
  process.env.FAKE_NO_APP_SERVER = "1";
  const dir = mkdtempSync(join(tmpdir(), "codeflow-appserver-record-"));
  process.env.FAKE_RECORD_DIR = dir;
  try {
    process.env.CODEFLOW_CODEX_TRANSPORT = "app-server";
    const required = await turn("Look around");
    assert.equal(required.result.ok, false);
    assert.match(required.result.error!, /codex app-server isn't available \(error: unrecognized subcommand 'app-server'/);
    assert.equal(required.result.errorKind, "cli_incompatible");

    delete process.env.CODEFLOW_CODEX_TRANSPORT;
    let steerable = false;
    const auto = await turn("Look around", { onSteerable: (s) => (steerable ||= !!s) });
    assert.ok(auto.result.ok, auto.result.error);
    assert.ok(auto.events.some((e) => e.kind === "status" && /app-server isn't available .*; using codex exec/.test(e.text)));
    assert.equal(steerable, false, "exec turns can't take messages mid-turn");
    assert.deepEqual(auto.events.find((e) => e.kind === "usage"), { kind: "usage", inputTokens: 100, outputTokens: 2, cacheReadTokens: 200 });
    assert.deepEqual(recorded(dir).map((c) => c.args[0]), ["exec"]);

    // Remembered for a while: the next turn goes straight to exec, without asking again.
    const again = await turn("Look around");
    assert.ok(again.result.ok, again.result.error);
    assert.ok(!again.events.some((e) => e.kind === "status" && /app-server isn't available/.test(e.text)));

    // Ten minutes later (Codex may have been upgraded), app-server is tried again.
    delete process.env.FAKE_NO_APP_SERVER;
    appServerCheck.missing!.at -= 11 * 60_000;
    const later = await turn("Look around");
    assert.ok(later.result.ok, later.result.error);
    assert.equal(appServerCheck.missing, undefined);
    assert.deepEqual(recorded(dir).map((c) => c.transport ?? c.args[0]).sort(), ["app-server", "exec", "exec"]);
  } finally {
    delete process.env.FAKE_NO_APP_SERVER;
    delete process.env.FAKE_RECORD_DIR;
    delete process.env.CODEFLOW_CODEX_TRANSPORT;
  }
});

test("managed native controls apply to new and resumed thread config, not only process flags", async () => {
  const {createRunPermissions,resolveRunPermissions}=await import('../src/run-permissions.js');
  const dir=mkdtempSync(join(tmpdir(),'codeflow-thread-policy-'));
  const permissions=resolveRunPermissions({policy:createRunPermissions('standard',false,false,['workspace-writes','no-command-network']),provider:'codex',mode:'write',currentTrust:'standard',currentTools:false});
  await withEnv({FAKE_RECORD_DIR:dir,CODEFLOW_CODEX_TRANSPORT:'app-server'},async()=>{
    const first=await turn('Return a short result',{mode:'write',trust:'standard',permissions});assert.equal(first.result.ok,true,first.result.error);
    const resumed=await turn('Return another short result',{mode:'write',trust:'standard',permissions,resumeSessionId:first.result.sessionId});assert.equal(resumed.result.ok,true,resumed.result.error);
  });
  const records=readdirSync(dir).map(f=>JSON.parse(readFileSync(join(dir,f),'utf8')));
  assert.equal(records.length,2);
  for(const record of records){assert.equal(record.thread.config['agents.enabled'],false);assert.equal(record.thread.config['features.multi_agent'],false);assert.equal(record.thread.config['features.multi_agent_v2.enabled'],false);assert.equal(record.thread.config['features.hooks'],false);assert.equal(record.thread.config['sandbox_workspace_write.network_access'],false);assert.equal(record.thread.approvalPolicy,'never')}
});
