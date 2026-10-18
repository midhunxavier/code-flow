// How the adapters cope with CLIs that misbehave: silence, hangs after the result, crashes, huge
// output, dead sessions, unknown flags, and the errors each CLI reports (typed as errorKind).
// Fake CLIs only (test/fake-bin).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-reliability-home-"));
// The one-shot transport for Codex here; app-server has its own tests (codex-app-server.test.ts).
process.env.CODEFLOW_CODEX_TRANSPORT = "exec";

const { getAdapter, adapters } = await import("../src/adapters/index.js");
const { lineSplitter, startJsonlProcess } = await import("../src/adapters/process.js");
const { classifyError, resetFromText } = await import("../src/adapters/errors.js");
type AgentEvent = import("../src/adapters/types.js").AgentEvent;
type AgentId = import("../src/adapters/types.js").AgentId;
type RunOptions = import("../src/adapters/types.js").RunOptions;

const ALL: AgentId[] = ["claude", "codex", "agy"];
const tmp = (name: string) => mkdtempSync(join(tmpdir(), `codeflow-reliability-${name}-`));

async function turn(agent: AgentId, extra: Partial<RunOptions> = {}, prompt = "Look around") {
  const events: AgentEvent[] = [];
  const started = Date.now();
  const result = await getAdapter(agent).run({ prompt, cwd: tmp("cwd"), mode: "read", ...extra }, (e) => events.push(e));
  return { result, events, ms: Date.now() - started };
}

/** Run `fn` with these environment variables set (the fake CLIs read them when they start). */
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

/** Every agent at once, with `vars` set for all of them. */
function eachAgent(vars: Record<string, string>, extra: Partial<RunOptions> = {}) {
  return withEnv(vars, () => Promise.all(ALL.map((agent) => turn(agent, extra).then((r) => ({ agent, ...r })))));
}

const node = (script: string) => ({ command: process.execPath, args: ["-e", script], cwd: tmpdir() });
const recorded = (dir: string) => readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));

test("lines are split on bytes: a character split across chunks survives, an overlong line is dropped", () => {
  const lines: string[] = [];
  const dropped: number[] = [];
  const split = lineSplitter(10, (l) => lines.push(l), (n) => dropped.push(n));
  const e = Buffer.from("é");
  split.push(Buffer.from("ab"));
  split.push(Buffer.concat([Buffer.from("c\nd"), e.subarray(0, 1)]));
  split.push(Buffer.concat([e.subarray(1), Buffer.from("\n01234567")]));
  split.push(Buffer.from("89ABCDEF"));
  split.push(Buffer.from("\nok\nlast"));
  split.end();
  assert.deepEqual(lines, ["abc", "dé", "ok", "last"]);
  assert.deepEqual(dropped, [16]);
});

test("a process that prints nothing for idleTimeoutMs is stopped as stalled; any output keeps it alive", async () => {
  const silent = await startJsonlProcess({ ...node("setTimeout(() => {}, 30000)"), idleTimeoutMs: 300, onJson: () => {} }).outcome;
  assert.deepEqual([silent.stalled, silent.timedOut], [true, false]);

  // Output every 100 ms for a second, stderr included: never 300 ms of silence.
  const chatty = await startJsonlProcess({
    ...node("let n = 0; const t = setInterval(() => { (n % 2 ? process.stderr : process.stdout).write('.'); if (++n === 10) clearInterval(t); }, 100)"),
    idleTimeoutMs: 300,
    onJson: () => {},
  }).outcome;
  assert.deepEqual([chatty.stalled, chatty.exitCode], [false, 0]);

  // A NaN timeout must not fire at once (setTimeout treats NaN as 1 ms).
  const nan = await startJsonlProcess({ ...node("setTimeout(() => {}, 200)"), timeoutMs: NaN, idleTimeoutMs: NaN, onJson: () => {} }).outcome;
  assert.deepEqual([nan.timedOut, nan.stalled, nan.exitCode], [false, false, 0]);
});

test("stderr is decoded as a stream: a UTF-8 character split across writes isn't garbled", async () => {
  const outcome = await startJsonlProcess({
    ...node("process.stderr.write(Buffer.from([0xc3])); setTimeout(() => process.stderr.write(Buffer.from([0xa9, 0x0a])), 100)"),
    onJson: () => {},
  }).outcome;
  assert.equal(outcome.stderr, "é\n");
});

test("after resultSeen, a process that doesn't exit is stopped and the outcome resolves anyway", async () => {
  const started = Date.now();
  const proc = startJsonlProcess({
    ...node("process.on('SIGTERM', () => {}); console.log(JSON.stringify({ type: 'result' })); setTimeout(() => {}, 30000)"),
    resultGraceMs: 300,
    timeoutMs: 20_000,
    onJson: (msg) => msg.type === "result" && proc.resultSeen(),
  });
  const outcome = await proc.outcome;
  assert.deepEqual([outcome.resultSeen, outcome.killedAfterResult, outcome.timedOut], [true, true, false]);
  assert.ok(Date.now() - started < 5_000);
});

test("a CLI that prints nothing is stopped as stalled, not left to the step timeout", async () => {
  for (const { agent, result, ms } of await eachAgent({ FAKE_SILENT_VENDOR: ALL.join(",") }, { idleTimeoutMs: 500 })) {
    assert.equal(result.ok, false, agent);
    assert.equal(result.errorKind, "stalled", `${agent}: ${result.error}`);
    assert.match(result.error!, /printed nothing for 1 s and was stopped/);
    assert.ok(ms < 5_000, `${agent} took ${ms} ms`);
  }
});

test("a CLI that hangs after its final result (and ignores SIGTERM) still finishes the turn with that result", async () => {
  // Each waits out the 10 s grace period, so all three run at once.
  for (const { agent, result, ms } of await eachAgent({ FAKE_HANG_AFTER_RESULT_VENDOR: ALL.join(",") })) {
    assert.ok(result.ok, `${agent}: ${result.error}`);
    // agy's fake always runs as a writer (it gets --dangerously-skip-permissions)
    assert.equal(result.finalText, agent === "agy" ? "Implemented changes as agy." : `${agent} handled the request.`);
    assert.ok(result.sessionId, agent);
    assert.ok(ms < 20_000, `${agent} took ${ms} ms`);
  }
});

test("a crash mid-stream fails the turn with the CLI's own error, not the agent's partial text", async () => {
  for (const { agent, result } of await eachAgent({ FAKE_CRASH_VENDOR: ALL.join(",") })) {
    assert.equal(result.ok, false, agent);
    assert.equal(result.errorKind, "other", `${agent}: ${result.error}`);
    assert.match(result.error!, /fake crash mid-stream/, agent);
    assert.doesNotMatch(result.error!, /Starting on it/, agent);
  }
});

test("resuming a conversation that's gone: session_not_found, and the dead id isn't handed back", async () => {
  for (const { agent, result } of await eachAgent({ FAKE_INVALID_SESSION_VENDOR: ALL.join(",") }, { resumeSessionId: "dead-session-id" })) {
    assert.equal(result.ok, false, agent);
    assert.equal(result.errorKind, "session_not_found", `${agent}: ${result.error}`);
    assert.equal(result.sessionId, undefined, agent);
  }
  // A resume that works confirms its session in the turn.
  const ok = await turn("claude", { resumeSessionId: "earlier-session" });
  assert.ok(ok.result.ok, ok.result.error);
  assert.ok(ok.result.sessionId && ok.result.sessionId !== "earlier-session");
});

test("a flag the installed CLI doesn't know reads as cli_incompatible", async () => {
  const schema = { type: "object", properties: { verdict: { enum: ["pass", "fail"] } } };
  const claude = await withEnv({ FAKE_UNKNOWN_FLAG: "--json-schema" }, () => turn("claude", { jsonSchema: schema }));
  assert.equal(claude.result.errorKind, "cli_incompatible", claude.result.error);
  assert.match(claude.result.error!, /unknown option '--json-schema'/);
  const codex = await withEnv({ FAKE_UNKNOWN_FLAG: "--output-schema" }, () => turn("codex", { jsonSchema: schema }));
  assert.equal(codex.result.errorKind, "cli_incompatible", codex.result.error);
});

test("a stdout line over 16 MB is skipped with a notice; the turn carries on", async () => {
  const { result, events } = await withEnv({ FAKE_HUGE_LINE_VENDOR: "claude" }, () => turn("claude"));
  assert.ok(result.ok, result.error);
  assert.equal(result.finalText, "claude handled the request.");
  assert.ok(events.some((e) => e.kind === "status" && /skipped a 17 MB line of claude output/.test(e.text)));
});

test("Claude: a rejected rate_limit_event is a usage limit with its reset time", async () => {
  const { result } = await withEnv({ FAKE_CLAUDE_FAIL: "rejected", FAKE_CLAUDE_RESETS_AT: "1792092600" }, () => turn("claude"));
  assert.equal(result.ok, false);
  assert.equal(result.errorKind, "usage_limit", result.error);
  assert.equal(result.resetsAt, 1792092600_000);
  assert.ok(result.sessionId, "the session was confirmed; a later turn can resume it");
});

test("Claude: the agent's own words never become the error; sign-in problems read as auth", async () => {
  const quoted = await withEnv({ FAKE_CLAUDE_FAIL: "agent-says-500" }, () => turn("claude"));
  assert.equal(quoted.result.ok, false);
  assert.doesNotMatch(quoted.result.error!, /500|timed out/, "an error the agent quoted from its work isn't a transient failure");
  assert.match(quoted.result.error!, /error during execution/);
  assert.equal(quoted.result.errorKind, "other");
  assert.equal(quoted.result.finalText, "The API returned 500 and the request timed out, so I stopped.");

  const auth = await withEnv({ FAKE_CLAUDE_FAIL: "auth" }, () => turn("claude"));
  assert.equal(auth.result.errorKind, "auth", auth.result.error);
});

test("Codex: usage limits carry a reset time; a passing failure reads as transient", async () => {
  const before = Date.now();
  const limited = await withEnv({ FAKE_USAGE_LIMIT_VENDOR: "codex" }, () => turn("codex", { mode: "write" }));
  assert.equal(limited.result.errorKind, "usage_limit", limited.result.error);
  assert.ok(limited.result.resetsAt! >= before + 4 * 3_600_000 && limited.result.resetsAt! <= Date.now() + 4 * 3_600_000);

  const overloaded = await withEnv({ FAKE_TRANSIENT_VENDOR: "codex" }, () => turn("codex", { mode: "write" }));
  assert.equal(overloaded.result.errorKind, "transient", overloaded.result.error);
});

test("agy gets a valid --print-timeout, whatever timeoutMs it's given", async () => {
  const dir = tmp("record");
  await withEnv({ FAKE_RECORD_DIR: dir }, async () => {
    await turn("agy", { timeoutMs: NaN });
    await turn("agy", { timeoutMs: 90_000 });
  });
  const timeouts = recorded(dir).map((c) => c.args[c.args.indexOf("--print-timeout") + 1]).sort();
  assert.deepEqual(timeouts, ["2m", "30m"]);
});

test("error kinds and reset times are read from each CLI's own wording", () => {
  const cases: [string, string][] = [
    ["No conversation found with session ID: abc", "session_not_found"],
    ["Error: thread/resume: no rollout found for thread id abc", "session_not_found"],
    ["error: unknown option '--effort'", "cli_incompatible"],
    ["error: unexpected argument '--output-schema' found", "cli_incompatible"],
    ["Invalid API key · Please run /login", "auth"],
    ['API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}', "auth"],
    ["Claude AI usage limit reached|1792092600", "usage_limit"],
    ["You've hit your usage limit. Upgrade to Pro or try again in 4 hours 21 minutes.", "usage_limit"],
    ["5-hour limit reached ∙ resets 3pm", "usage_limit"],
    ["Rate limit reached for requests per min. Please try again in 1.5s.", "rate_limit"],
    ["API Error: 429 Too Many Requests", "rate_limit"],
    ['API Error: 529 {"type":"overloaded_error"}', "transient"],
    ["stream disconnected before completion: error sending request", "transient"],
    ["getaddrinfo ENOTFOUND api.anthropic.com", "transient"],
    ["boom", "other"],
  ];
  for (const [text, kind] of cases) assert.equal(classifyError(text), kind, text);

  const now = 1_000_000;
  assert.equal(resetFromText("Claude AI usage limit reached|1792092600", now), 1792092600_000);
  assert.equal(resetFromText("try again in 4 hours 21 minutes.", now), now + 4 * 3_600_000 + 21 * 60_000);
  assert.equal(resetFromText("try again in 2 days", now), now + 2 * 86_400_000);
  assert.equal(resetFromText("resets 3pm", now), undefined);
});
