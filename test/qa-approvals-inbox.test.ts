// The approval inbox's provider side: Codex 0.164 approvals reach it, requests code-flow declines on
// its own say so, expiries are recorded as expired, and questions keep their header and option notes.
// Fake CLIs only (the app-server fake, and a small stream-json Claude written here).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
const claudeBin = mkdtempSync(join(tmpdir(), "codeflow-qa-approvals-claude-"));
process.env.PATH = `${claudeBin}:${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-qa-approvals-home-"));

const { codexAdapter } = await import("../src/adapters/codex.js");
const { claudeAdapter } = await import("../src/adapters/claude.js");
const { runAppServerTurn } = await import("../src/adapters/codex-app-server.js");
const { ApprovalRegistry, approvalTimeout } = await import("../src/approvals.js");
type AgentEvent = import("../src/adapters/types.js").AgentEvent;
type RunOptions = import("../src/adapters/types.js").RunOptions;
type AgentApprovalRequest = import("../src/adapters/types.js").AgentApprovalRequest;
type AgentQuestion = import("../src/adapters/types.js").AgentQuestion;

/** A stream-json Claude: asks what FAKE_QA_CLAUDE_ASK lists (question, tool), then reports FAKE_QA_CLAUDE_DENIALS. */
before(() => {
  const script = join(claudeBin, "claude");
  writeFileSync(script, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const ask = (process.env.FAKE_QA_CLAUDE_ASK ?? "").split(",").filter(Boolean);
const waiting = new Map();
const request = (id, body) => new Promise((resolve) => { waiting.set(id, resolve); out({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", ...body } }); });
let started = false;
for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (msg.type === "control_response") { appendFileSync(process.env.FAKE_QA_CLAUDE_LOG, JSON.stringify(msg.response) + "\\n"); waiting.get(msg.response.request_id)?.(msg.response); continue; }
  if (msg.type !== "user" || started) continue;
  started = true;
  out({ type: "system", subtype: "init", session_id: "qa-session" });
  void (async () => {
    if (ask.includes("question")) await request("q1", { tool_name: "AskUserQuestion", tool_use_id: "tu-question", input: { questions: [{ question: "Which checks should run?", header: "Checks", multiSelect: true, options: [{ label: "Unit", description: "Fast, no network" }, { label: "Browser" }] }] } });
    if (ask.includes("tool")) await request("a1", JSON.parse(process.env.FAKE_QA_CLAUDE_TOOL || JSON.stringify({ tool_name: "Bash", tool_use_id: "tu-asked", input: { command: "rm -rf build" } })));
    out({ type: "result", subtype: "success", result: "done", session_id: "qa-session", usage: { input_tokens: 1, output_tokens: 1 }, permission_denials: JSON.parse(process.env.FAKE_QA_CLAUDE_DENIALS || "[]") });
  })();
}
`);
  chmodSync(script, 0o755);
});

async function codexTurn(prompt: string, extra: Partial<RunOptions> = {}) {
  const events: AgentEvent[] = [];
  const result = await codexAdapter.run({ prompt, cwd: mkdtempSync(join(tmpdir(), "codeflow-qa-approvals-cwd-")), mode: "write", ...extra }, (e) => events.push(e));
  return { result, events };
}
async function claudeTurn(extra: Partial<RunOptions>, env: Record<string, string>) {
  const log = join(mkdtempSync(join(tmpdir(), "codeflow-qa-approvals-log-")), "responses.jsonl");
  writeFileSync(log, "");
  const events: AgentEvent[] = [];
  const result = await withEnv({ ...env, FAKE_QA_CLAUDE_LOG: log }, () => claudeAdapter.run({ prompt: "Go", cwd: mkdtempSync(join(tmpdir(), "codeflow-qa-approvals-cwd-")), mode: "write", interactiveApprovals: true, ...extra }, (e) => events.push(e)));
  return { result, events, responses: readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
}
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
/** What the adapters say when code-flow refuses a request unasked; the thread keeps such lines in view. */
const CODEX_DECLINE = "code-flow declined Codex's request to run `rm -rf build` without asking you: it asks for permissions beyond this run's sandbox";
const CLAUDE_RULED = "Blocked by this run's permission rules, without an approval prompt: Bash (git diff --no-index a.txt b.txt). Full access lifts its shell limits.";
const statusLines = (events: AgentEvent[]) => events.flatMap((e) => e.kind === "status" ? [e.text] : []);
const ran = (events: AgentEvent[], callId = "i3") => events.some((e) => e.kind === "tool_result" && e.callId === callId && !e.isError);

test("codex-cli 0.164 command approvals in the thread's own environment reach the inbox and run once approved", async () => {
  const requests: AgentApprovalRequest[] = [];
  const opts = { interactiveApprovals: true, onApproval: async (request: AgentApprovalRequest) => { requests.push(request); return "approve" as const; } };
  // The fake now behaves like 0.164: environmentId "local", and the thread reports "local" at its cwd.
  const approved = await codexTurn("ASK-APPROVAL", opts);
  assert.ok(approved.result.ok, approved.result.error);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.kind, "command");
  assert.equal(requests[0]!.command, "rm -rf build");
  assert.ok(ran(approved.events), "the approved command runs");
  assert.ok(statusLines(approved.events).some((line) => /approved once/.test(line)));
  // Older shapes still work: no environment named, or a thread that reports none.
  await withEnv({ FAKE_CODEX_APPROVAL_OVERRIDES: JSON.stringify({ environmentId: null }) }, () => codexTurn("ASK-APPROVAL", opts));
  await withEnv({ FAKE_CODEX_THREAD_ENVIRONMENTS: "null" }, () => codexTurn("ASK-APPROVAL", opts));
  assert.equal(requests.length, 3);
});

test("a command bound for another environment, or one Codex can't approve once, is declined without a prompt", async () => {
  let callbacks = 0;
  const opts = { interactiveApprovals: true, onApproval: async () => { callbacks++; return "approve" as const; } };
  const cases: Record<string, string>[] = [
    { FAKE_CODEX_APPROVAL_OVERRIDES: JSON.stringify({ environmentId: "remote-environment" }) },
    // "local" is only this worktree's environment when the thread says so.
    { FAKE_CODEX_THREAD_ENVIRONMENTS: JSON.stringify([{ environmentId: "local", cwd: tmpdir(), runtimeWorkspaceRoots: [tmpdir()] }]) },
    { FAKE_CODEX_THREAD_ENVIRONMENTS: "null", FAKE_CODEX_APPROVAL_OVERRIDES: JSON.stringify({ environmentId: "devbox" }) },
    { FAKE_CODEX_APPROVAL_OVERRIDES: JSON.stringify({ availableDecisions: [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ["rm"] } }, "cancel"] }) },
  ];
  for (const env of cases) {
    const denied = await withEnv(env, () => codexTurn("ASK-APPROVAL", opts));
    assert.ok(denied.result.ok, denied.result.error);
    assert.ok(!ran(denied.events), JSON.stringify(env));
  }
  assert.equal(callbacks, 0);
});

test("a request code-flow declines on its own says so in the thread and tells Codex the user wasn't asked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codeflow-qa-approvals-record-"));
  let callbacks = 0;
  // The turn keeps going after the decline (as a real one does while the model reads it), so the note can land.
  const declined = await withEnv({ FAKE_RECORD_DIR: dir, FAKE_SLEEP_VENDOR: "codex", FAKE_SLEEP_MS: "600", FAKE_CODEX_APPROVAL_OVERRIDES: JSON.stringify({ sandboxPermissions: "require_escalated" }) }, () => codexTurn("ASK-APPROVAL", { interactiveApprovals: true, onApproval: async () => { callbacks++; return "approve"; } }));
  assert.equal(callbacks, 0);
  assert.ok(declined.result.ok, declined.result.error);
  assert.ok(statusLines(declined.events).includes(CODEX_DECLINE), statusLines(declined.events).join("\n"));
  const [record] = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
  assert.equal(record.steers.length, 1);
  assert.match(record.steers[0], /code-flow declined your approval request to run `rm -rf build` on its own, because it asks for permissions beyond this run's sandbox\. The user was not asked and did not reject it\./);
  const outside = await codexTurn("ASK-APPROVAL OUTSIDE-WORKTREE", { interactiveApprovals: true, onApproval: async () => "approve" });
  assert.ok(statusLines(outside.events).some((line) => /without asking you: it would run outside this run's worktree$/.test(line)));
});

test("an approval nobody answers is recorded as expired and the transcript says it expired; a cancel stays cancelled", async () => {
  const registry = new ApprovalRegistry({ defaultTimeoutMs: 400 });
  const lines: string[] = [];
  const outcome = await runAppServerTurn({
    prompt: "ASK-APPROVAL", cwd: mkdtempSync(join(tmpdir(), "codeflow-qa-approvals-cwd-")), sandbox: "workspace-write", config: [],
    interactiveApprovals: true, approvalTimeoutMs: 400,
    onApproval: (request, signal) => registry.request("run", "step", request, signal),
    onMessage: () => {}, onText: (line) => lines.push(line),
  });
  assert.ok(!("unavailable" in outcome));
  const [record] = registry.list("run");
  assert.equal(record!.status, "expired");
  assert.ok(lines.includes("Codex command request expired: nobody answered within 400 ms, so it was declined"), lines.join("\n"));
  assert.ok(!lines.includes("Codex command declined"));

  // Whichever timer fires first, the record says expired; a plain abort is a cancellation.
  const early = new AbortController();
  const expiring = registry.request("run-2", "step", { id: "x", kind: "command", command: "ls" }, early.signal);
  early.abort(approvalTimeout());
  assert.equal(await expiring, "decline");
  const cancelled = new AbortController();
  const stopping = registry.request("run-3", "step", { id: "y", kind: "command", command: "ls" }, cancelled.signal);
  cancelled.abort();
  await stopping;
  assert.deepEqual([registry.list("run-2")[0]!.status, registry.list("run-3")[0]!.status], ["expired", "cancelled"]);
});

test("a Codex question nobody answers expires on the record and in the transcript", async () => {
  const registry = new ApprovalRegistry();
  const lines: string[] = [];
  let questions: AgentQuestion[] = [];
  await runAppServerTurn({
    prompt: "ASK-QUESTION", cwd: mkdtempSync(join(tmpdir(), "codeflow-qa-approvals-cwd-")), sandbox: "workspace-write", config: [],
    questionTimeoutMs: 300,
    onQuestion: (asked, signal) => { questions = asked; return registry.ask("run", "step", asked, signal); },
    onMessage: () => {}, onText: (line) => lines.push(line),
  });
  assert.equal(registry.list("run")[0]!.status, "expired");
  assert.ok(lines.includes("Codex's question expired: nobody answered within 300 ms, so Codex continues without an answer"), lines.join("\n"));
  // The header and each option's description reach the inbox.
  assert.deepEqual(questions, [{ id: "color", question: "Which color should the badge use?", header: "Badge color", options: ["Red", "Blue"], optionDescriptions: ["Warm, stands out on the header", "Cool, matches the link palette"] }]);
  assert.deepEqual(registry.list("run")[0]!.questions, questions);
});

test("the registry keeps only the question fields the inbox shows, and checks them", () => {
  const registry = new ApprovalRegistry();
  const ask = (questions: unknown) => { const controller = new AbortController(); void registry.request("run", "step", { id: String(Math.random()), kind: "question", questions: questions as AgentQuestion[] }, controller.signal); controller.abort(); };
  ask([{ id: "a", question: "Pick", header: "Head", options: ["x", "y"], optionDescriptions: ["X", ""], multiSelect: true, isSecret: true, extra: { nested: 1 } }]);
  assert.deepEqual(registry.list("run").map((r) => r.questions), [[{ id: "a", question: "Pick", header: "Head", options: ["x", "y"], optionDescriptions: ["X", ""], multiSelect: true }]]);
  ask([{ id: "b", question: "Pick", options: ["x", "y"], optionDescriptions: ["only one"] }]);
  ask([{ id: "c", question: "Pick", header: 7 }]);
  ask([{ id: "d", question: "Pick", options: ["x"], multiSelect: "yes" }]);
  assert.equal(registry.list("run").length, 1, "malformed question fields are refused, not shown");
});

test("Claude questions keep their header, option notes and multiple choice; expiries are said, not silent", async () => {
  let asked: AgentQuestion[] = [];
  const answered = await claudeTurn({ onQuestion: async (questions) => { asked = questions; return { "0": "Unit, Browser" }; } }, { FAKE_QA_CLAUDE_ASK: "question" });
  assert.ok(answered.result.ok, answered.result.error);
  assert.deepEqual(asked, [{ id: "0", question: "Which checks should run?", header: "Checks", options: ["Unit", "Browser"], optionDescriptions: ["Fast, no network", ""], multiSelect: true }]);
  assert.deepEqual(answered.responses[0].response.updatedInput.answers, { "Which checks should run?": "Unit, Browser" });

  // An adapter whose own deadline passes aborts as an expiry: the registry records it, the thread says it.
  const registry = new ApprovalRegistry({ defaultTimeoutMs: 10 * 60_000 });
  const realSetTimeout = globalThis.setTimeout;
  // Claude's two-minute deadline, made short for the test.
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => realSetTimeout(fn, ms === 120_000 ? 200 : ms, ...rest)) as typeof setTimeout;
  try {
    const expired = await claudeTurn({ onApproval: (request, signal) => registry.request("run", "step", request, signal) }, { FAKE_QA_CLAUDE_ASK: "tool" });
    assert.ok(expired.result.ok, expired.result.error);
    assert.equal(registry.list("run")[0]!.status, "expired");
    assert.ok(statusLines(expired.events).includes("Claude's request to use Bash expired: nobody answered within 2 minutes, so it was declined"), statusLines(expired.events).join("\n"));
    assert.equal(expired.responses[0].response.message, "The user didn't answer this request in time, so it was declined");
  } finally { globalThis.setTimeout = realSetTimeout; }
});

test("Claude's permission denials say whether a rule blocked the call or the inbox declined it", async () => {
  const denials = JSON.stringify([
    { tool_name: "Bash", tool_use_id: "tu-rule", tool_input: { command: "git diff --no-index a.txt b.txt" } },
    { tool_name: "Bash", tool_use_id: "tu-asked", tool_input: { command: "rm -rf build" } },
  ]);
  const interactive = await claudeTurn({ onApproval: async () => "decline" }, { FAKE_QA_CLAUDE_ASK: "tool", FAKE_QA_CLAUDE_DENIALS: denials });
  const lines = statusLines(interactive.events);
  assert.ok(lines.includes(CLAUDE_RULED), lines.join("\n"));
  assert.ok(lines.includes("Not approved: Bash (rm -rf build)"), lines.join("\n"));
  assert.ok(!lines.some((line) => /headless/.test(line)), "an interactive run isn't headless");
  const headless = await claudeTurn({ interactiveApprovals: false, conversation: true }, { FAKE_QA_CLAUDE_DENIALS: denials });
  assert.ok(statusLines(headless.events).includes("Denied in headless mode: Bash (git diff --no-index a.txt b.txt), Bash (rm -rf build)"), statusLines(headless.events).join("\n"));
});

test("the inbox offers the viewed run first, then the soonest deadline; options toggle; the run says it waits", async () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { innerWidth: 1440, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) } });
  Object.defineProperty(globalThis, "location", { configurable: true, value: { hostname: "localhost", hash: "", origin: "http://localhost", href: "http://localhost/" } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
  const { inboxOrder, pickOption, optionPicked } = await import("../ui/approval-inbox.js");
  const { executionLabel, declinedUnasked } = await import("../ui/run-experience.js");
  const record = (id: string, runId: string, createdAt: number, expiresAt: number) => ({ id, runId, createdAt, expiresAt }) as import("../src/approvals.js").ApprovalRecord;
  const older = record("a", "run-a", 1, 100), newer = record("b", "run-b", 2, 200), mine = record("c", "run-c", 3, 300);
  assert.deepEqual(inboxOrder([mine, newer, older]).map((r) => r.id), ["a", "b", "c"], "a newer request never hides an older one");
  assert.deepEqual(inboxOrder([older, newer, mine], "run-c").map((r) => r.id), ["c", "a", "b"]);
  assert.equal(pickOption("Teal", "Red", false), "Red");
  assert.equal(pickOption("Unit", "Browser", true), "Unit, Browser");
  assert.equal(pickOption("Unit, Browser", "Unit", true), "Browser");
  assert.deepEqual([optionPicked("Unit, Browser", "Browser", true), optionPicked("Red", "Red", false), optionPicked("Redder", "Red", false)], [true, true, false]);
  const running = { status: "running", artifacts: [], worktrees: [], loop: {} } as unknown as import("../ui/types.js").RunSummary;
  assert.equal(executionLabel(running, true), "Waiting for you");
  assert.equal(executionLabel(running), "Running");
  // A finished turn shows what code-flow declined unasked outside "Show work"; ordinary status lines stay folded.
  assert.deepEqual([CODEX_DECLINE, CLAUDE_RULED, "Codex command declined", "Not approved: Bash (rm -rf build)"].map(declinedUnasked), [true, true, false, false]);
});


test("long decorative question fields are bounded without discarding the user's question", () => {
  const registry = new ApprovalRegistry();
  const controller = new AbortController();
  void registry.request("run", "step", { id: "long", kind: "question", questions: [{ id: "pick", question: "Choose a check", header: "h".repeat(500), options: ["Unit"], optionDescriptions: ["d".repeat(4000)] }] }, controller.signal);
  const question = registry.list("run")[0]?.questions?.[0];
  assert.equal(question?.header?.length, 240);
  assert.equal(question?.optionDescriptions?.[0]?.length, 2000);
  assert.equal(question?.question, "Choose a check");
  controller.abort();
});

test("Claude's unasked refusals stay visible and missing tool-use IDs still match actual inbox decisions", async () => {
  const denied = { tool_name: "Bash", tool_use_id: "tu-asked", tool_input: { command: "rm -rf build" } };
  let calls = 0;
  const read = await claudeTurn({ mode: "read", onApproval: async () => { calls++; return "decline"; } }, { FAKE_QA_CLAUDE_ASK: "tool", FAKE_QA_CLAUDE_DENIALS: JSON.stringify([denied]) });
  assert.equal(calls, 0);
  assert.ok(statusLines(read.events).some(line => /Blocked.*without an approval prompt: Bash/.test(line)));
  assert.ok(!statusLines(read.events).some(line => /Not approved:/.test(line)));
  const huge = { tool_name: "Bash", tool_use_id: "tu-large", input: { command: "x".repeat(17000) } };
  const oversized = await claudeTurn({ onApproval: async () => { calls++; return "decline"; } }, { FAKE_QA_CLAUDE_ASK: "tool", FAKE_QA_CLAUDE_TOOL: JSON.stringify(huge), FAKE_QA_CLAUDE_DENIALS: JSON.stringify([{ ...huge, tool_input: huge.input }]) });
  assert.equal(calls, 0);
  assert.ok(statusLines(oversized.events).some(line => /Blocked.*without an approval prompt: Bash/.test(line)));
  for (const requestHasId of [false, true]) {
    const request = { tool_name: "Bash", ...(requestHasId ? { tool_use_id: "tu-asked" } : {}), input: denied.tool_input };
    const denial = { ...denied, ...(!requestHasId ? {} : { tool_use_id: undefined }) };
    const result = await claudeTurn({ onApproval: async () => "decline" }, { FAKE_QA_CLAUDE_ASK: "tool", FAKE_QA_CLAUDE_TOOL: JSON.stringify(request), FAKE_QA_CLAUDE_DENIALS: JSON.stringify([denial]) });
    assert.ok(statusLines(result.events).includes("Not approved: Bash (rm -rf build)"));
    assert.ok(!statusLines(result.events).some(line => /Blocked/.test(line)));
  }
});
