// A chat's thread and a team's status, without a browser: where a team turn's correction bubbles,
// question card and Team activity sit once more messages follow, the words a team's state is
// shown in, the reply box's starting budget, and the resume text of a stopped run. The thread is
// bundled the way build-ui does it and walked as elements, without rendering components.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { defaultFollowupCalls, followupMinimumCalls, providerChangeText, teamStatusLabel, wholeMinutes } from "../ui/team-state.js";
import { nextRunAction } from "../ui/run-experience.js";
import type { RunSummary } from "../ui/types.js";

const ui = fileURLToPath(new URL("../ui", import.meta.url));
let m: any;

before(async () => {
  const storage = new Map<string, string>();
  Object.assign(globalThis, {
    window: globalThis,
    innerWidth: 1400,
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, String(v)), removeItem: (k: string) => storage.delete(k) },
    location: { hostname: "localhost", hash: "", origin: "http://localhost", pathname: "/" },
  });
  const out = await esbuild.build({
    stdin: { contents: [`export { ChatThread, teamSteps } from "./run.tsx";`, `export { runs } from "./state.ts";`].join("\n"), resolveDir: ui, loader: "ts" },
    bundle: true, write: false, format: "esm", target: "es2022", jsx: "automatic", jsxImportSource: "preact",
    loader: { ".png": "dataurl", ".svg": "dataurl" }, logLevel: "error",
  });
  const file = join(mkdtempSync(join(tmpdir(), "codeflow-qa-chat-thread-")), "ui.mjs");
  writeFileSync(file, out.outputFiles[0]!.text);
  m = await import(pathToFileURL(file).href);
});

const step = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: "agent", title: "Your task", role: "agent", agent: "claude", mode: "write", worktree: "solo", status: "done", startedAt: 1100, endedAt: 1500, ...extra });
const reply = (id: string, message: string, at: number, extra: Record<string, unknown> = {}) => ({ id, kind: "reply", agent: "claude", worktree: "solo", message, status: "pending", at, ...extra });
const chat = (extra: Record<string, unknown> = {}) => ({
  id: "chat", status: "done", createdAt: 1000, task: "AUTO-EVENT Implement part A", roles: { agent: ["claude"] }, followUps: [], notes: [], teamTurns: [],
  worktrees: [{ name: "solo", branch: "codeflow/chat/claude", path: "/tmp/chat" }], ...extra,
});
const stopNote = (id: string, text: string, at: number, executionId: string) => ({ id, text, at, status: "delivered", control: "stop", teamDelivery: { executionId, state: "not_applied" } });
const runData = (steps: any[]) => ({ steps: new Map(steps.map((s) => [s.id, s])), events: new Map(), built: new Map(), logs: [], seen: new Set(), runSeq: 0, stepSeq: new Map(), epoch: "" });
const named = (node: any, name: string) => typeof node.type === "function" && new RegExp(`^${name}\\d*$`).test(node.type.name);

/** The thread's keyed items, and what it shows, in document order. */
function thread(run: any, steps: any[]) {
  const tree = m.ChatThread({ run, steps: m.teamSteps(run, steps), data: runData(steps) });
  const items: any[] = tree.props.children.find(Array.isArray) ?? [];
  const shown: string[] = [];
  const walk = (node: any) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object" || !("props" in node)) return;
    if (node.props.class === "team-question-history") shown.push(`correction:${node.key}`);
    if (named(node, "RunMessage")) shown.push(`message:${node.props.text}`);
    if (named(node, "TaskTeamActivity")) shown.push(`activity:${node.props.turns.map((turn: any) => turn.key).join(",")}`);
    if (named(node, "TeamQuestionCard")) shown.push(`question:${node.props.run.id}`);
    if (named(node, "TurnBody")) shown.push(`answer:${node.props.step.id}`);
    walk(node.props.children);
  };
  walk(tree);
  return { keys: items.map((item) => item.key), shown };
}

test("t11-2: a stopped first team turn keeps its correction and Team activity after a later message", () => {
  const run = chat({
    status: "cancelled",
    followUps: [reply("f1", "AUTO-EVENT Implement part B", 3000)],
    notes: [stopNote("n1", "Stop. Also keep the README unchanged", 2000, "x1"), stopNote("n2", "stop", 4000, "x2")],
    teamTurns: [{ key: "agent|claude|solo|Your task#1", executionId: "x1", report: "stopped" }, { key: "follow-up|claude|solo|follow-up f1#1", executionId: "x2" }],
  });
  // The lead never answered the stopped first turn: there's no step for it.
  assert.deepEqual(thread(run, []).shown, [
    "correction:n1", "activity:agent|claude|solo|Your task#1",
    "message:AUTO-EVENT Implement part B", "correction:n2", "activity:follow-up|claude|solo|follow-up f1#1",
  ]);
});

test("t11-2: a turn whose lead answered after a newer message still sits where its message was sent", () => {
  const run = chat({
    followUps: [reply("f1", "part B", 3000, { status: "done", stepId: "s1", result: "ok" }), reply("f2", "part C", 5000)],
    teamTurns: [{ key: "follow-up|claude|solo|follow-up f1#1", executionId: "x2", report: "done" }, { key: "follow-up|claude|solo|follow-up f2#1", executionId: "x3" }],
  });
  // Resuming for part C first finished part B's interrupted turn.
  const steps = [step("s1", { role: "follow-up", title: "Follow-up", startedAt: 5050, teamResponseFor: "follow-up|claude|solo|follow-up f1#1" })];
  const { keys, shown } = thread(run, steps);
  assert.deepEqual(keys, ["s1", "f2"]);
  assert.deepEqual(shown.filter((item) => item.startsWith("message:")), ["message:part B", "message:part C"]);

  // The task's own answer, when the lead gave it only on resume, still comes before the reply.
  const late = chat({ followUps: [reply("f1", "part B", 3000)], teamTurns: [{ key: "agent|claude|solo|Your task#1", executionId: "x1", report: "done" }] });
  const opening = thread(late, [step("s1", { startedAt: 5050, teamResponseFor: "agent|claude|solo|Your task#1" })]);
  assert.deepEqual(opening.keys, ["s1", "f1"]);
  assert.deepEqual(opening.shown.filter((item) => item.startsWith("activity:")), ["activity:agent|claude|solo|Your task#1", "activity:"]);
});

test("t11-3: a question to the lead keeps the team's question card and Team activity under the task", () => {
  const execution = { id: "x1", status: "running", team: { status: "blocked", awaitingRequestId: "q1", members: [], tasks: [], messages: [{ id: "q1", kind: "question", sender: "builder", recipient: "user", body: "Should empty input be accepted?", status: "open", evidence: [] }] } };
  m.runs.value = new Map([["x1", execution]]);
  try {
    const turn = { key: "agent|claude|solo|Your task#1", executionId: "x1" };
    const run = chat({ status: "running", task: "AUTO-USER-QUESTION Implement the sample", teamTurns: [turn] });
    const question = step("s1", { role: "follow-up", title: "Your question", leadQuestion: true, mode: "read", startedAt: 2000 });
    const asked = thread(run, [question]);
    assert.deepEqual(asked.shown, ["question:x1", `activity:${turn.key}`, "answer:s1"], "the card and progress stay above the lead's quick answer");

    // A reply's turn that just started (its follow-up link not yet in the snapshot) doesn't stand in for the task's.
    const starting = thread(run, [question, step("s2", { role: "follow-up", title: "Follow-up", status: "running", startedAt: 2500 })]);
    assert.equal(starting.shown.filter((item) => item.startsWith("activity:")).length, 1);
    assert.equal(starting.shown[0], "question:x1");

    // Once the lead answers the task itself, the team's progress moves into that turn, once.
    execution.status = "done";
    const answered = thread({ ...run, status: "done", teamTurns: [{ ...turn, report: "done" }] }, [question, step("s3", { startedAt: 3000, teamResponseFor: turn.key })]);
    assert.deepEqual(answered.keys, ["s3", "s1"]);
    assert.equal(answered.shown.filter((item) => item.startsWith("activity:")).length, 1);
  } finally { m.runs.value = new Map(); }
});

const team = (status: string, extra: Record<string, unknown> = {}) => ({ status, ...extra }) as RunSummary["team"];
test("t11-14 / t11-8 / t10-12: a team's state reads in words and agrees with how its run ended", () => {
  assert.equal(teamStatusLabel({ status: "running", team: team("awaiting_approval") }), "Plan ready for approval");
  assert.equal(teamStatusLabel({ status: "running", team: team("blocked", { awaitingRequestId: "q" }) }), "Waiting for your answer");
  assert.equal(teamStatusLabel({ status: "running", team: team("running") }), "Working");
  assert.equal(teamStatusLabel({ status: "done", team: team("completed") }), "Finished");
  // A stop records no team state of its own: the team still says the step it was on.
  assert.equal(teamStatusLabel({ status: "cancelled", team: team("running") }), "Stopped");
  assert.equal(teamStatusLabel({ status: "cancelled", team: team("awaiting_approval") }), "Stopped");
  assert.equal(teamStatusLabel({ status: "cancelled", supersededBy: "next", team: team("running") }), "Stopped · goal revised");
  assert.equal(teamStatusLabel({ status: "stopped", team: team("blocked") }), "Unresolved work");
  assert.equal(teamStatusLabel({ status: "stopped", team: team("running") }), "Paused");
  assert.equal(teamStatusLabel({ status: "failed", team: team("verifying") }), "Failed");
  for (const status of ["planning", "awaiting_approval", "running", "blocked", "verifying", "completed"]) for (const runStatus of ["running", "done", "cancelled", "stopped", "failed", "interrupted"]) {
    assert.doesNotMatch(teamStatusLabel({ status: runStatus, team: team(status) }), /_|^(running|blocked|completed|planning|verifying)$/);
  }
});

test("t10-12: a stopped run's resume text is punctuated, titled like its status, and its minutes are whole", () => {
  const stopped = { status: "cancelled", loop: {}, artifacts: [], worktrees: [] } as unknown as RunSummary;
  assert.equal(nextRunAction(stopped)?.title, "Stopped by you");
  assert.equal(nextRunAction(stopped)?.detail, "Execution stopped before completion. Recorded results are reused when you resume with a fresh budget.");
  // Older runs recorded the scheduler's abort text, without a full stop.
  assert.equal(nextRunAction({ ...stopped, error: "Event scheduler stopped" })?.detail, "Event scheduler stopped. Recorded results are reused when you resume with a fresh budget.");
  assert.equal(nextRunAction({ ...stopped, status: "failed", error: "The agent turn failed!" })?.detail, "The agent turn failed! Recorded results are reused when you resume with a fresh budget.");
  assert.equal(wholeMinutes(29.771883333333335), 29);
  assert.equal(wholeMinutes(240), 240);
  assert.equal(wholeMinutes(0.4), 1);
});

test("t11-9: the reply budget starts valid for the chosen target after a one-call direct reply", () => {
  const afterDirectReply = { maxSteps: 1, maxInvocations: 1, maxMinutes: 240 };
  assert.equal(defaultFollowupCalls(afterDirectReply, followupMinimumCalls(true, false, "team")), 4, "a rebuilt team needs planning and review calls");
  assert.equal(defaultFollowupCalls(afterDirectReply, followupMinimumCalls(true, false, "claude@auto-alpha")), 1, "the direct reply keeps its own allocation");
  assert.equal(defaultFollowupCalls({ maxSteps: 12, maxInvocations: 12 }, 4), 12);
  assert.equal(defaultFollowupCalls({ maxSteps: 20 }, 4), 20);
  assert.equal(defaultFollowupCalls({ maxSteps: 500 }, 4), 500);
});

test("t11-10: provider changes read the same wherever Team activity shows them", () => {
  const name = (id: string) => ({ claude: "Claude", codex: "Codex" })[id] ?? id;
  assert.equal(providerChangeText({ memberId: "builder", role: "worker", from: "claude", to: "codex", reason: "usage_limit", at: 1 }, name), "Assignment continued with Codex after Claude became unavailable.");
  assert.equal(providerChangeText({ memberId: "verifier", role: "reviewer", from: "codex", to: "claude", reason: "usage_limit", at: 1 }, name), "Review continued with Claude after Codex became unavailable.");
  assert.equal(providerChangeText({ memberId: "coordinator", role: "coordinator", from: "claude", to: "codex", reason: "usage_limit", at: 1 }, name), "Coordination continued with Codex after Claude became unavailable.");
});
