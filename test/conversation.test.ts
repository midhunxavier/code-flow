import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-conv-home-"));

const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
type Run = import("../src/engine.js").Run;
type Manager = InstanceType<typeof RunManager>;

let repo: string;
const pipelineRoles = { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] } as Record<string, any>;

before(() => {
  repo = mkdtempSync(join(tmpdir(), "codeflow-conv-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q");
  writeFileSync(join(repo, "README.md"), "talk\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
});

const start = (m: Manager, pattern: string, roles: Record<string, any>, extra: Record<string, unknown> = {}) =>
  m.start({ pattern: findPattern(pattern)!, task: "Talk to me", repo, roles, options: {}, ...extra });
function finished(m: Manager, run: Run): Promise<void> {
  return new Promise((resolve) => {
    const check = () => run.status !== "running" && resolve();
    m.subscribe(run.id, check);
    check();
  });
}
async function until(condition: () => boolean, timeoutMs = 10_000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}
const agentTitles = (r: Run) => r.steps.filter((s) => s.kind === "agent").map((s) => s.title);

test("approve the plan: the run pauses until you approve", async () => {
  const m = new RunManager(findPattern);
  const run = await start(m, "pipeline", pipelineRoles, { approvals: { plan: true } });
  await until(() => !!run.awaiting);
  assert.equal(run.status, "running");
  assert.equal(run.awaiting!.title, "Approve the plan");
  assert.match(run.awaiting!.content, /claude handled the request/);
  assert.deepEqual(agentTitles(run), ["Plan"], "nothing is built while waiting");
  m.answer(run.id, { decision: "approve" });
  await finished(m, run);
  assert.equal(run.status, "done", run.error);
  assert.equal(run.awaiting, undefined);
  assert.deepEqual(agentTitles(run), ["Plan", "Implement plan", "Review (round 1)"]);
});

test("ask for changes: the planner revises in its own session and asks again", async () => {
  const m = new RunManager(findPattern);
  const run = await start(m, "pipeline", pipelineRoles, { approvals: { plan: true } });
  await until(() => !!run.awaiting);
  assert.throws(() => m.answer(run.id, { decision: "revise" }), /Say what should change/);
  m.answer(run.id, { decision: "revise", note: "Use the existing logger" });
  await until(() => run.awaiting?.title === "Approve the revised plan (2)");
  const revise = run.steps.find((s) => s.title === "Revise the plan (1)")!;
  assert.equal(revise.agent, "claude");
  m.answer(run.id, { decision: "approve" });
  await finished(m, run);
  assert.equal(run.status, "done", run.error);
});

test("reject: the run ends without building", async () => {
  const m = new RunManager(findPattern);
  const run = await start(m, "pipeline", pipelineRoles, { approvals: { plan: true } });
  await until(() => !!run.awaiting);
  m.answer(run.id, { decision: "reject", note: "wrong approach" });
  await finished(m, run);
  assert.equal(run.status, "cancelled");
  assert.match(run.error!, /You rejected the plan\. \(wrong approach\)/);
  assert.deepEqual(agentTitles(run), ["Plan"]);
});

test("the time budget pauses while the run waits for you", async () => {
  const budgetMs = 3_000;
  const m = new RunManager(findPattern);
  const run = await start(m, "pipeline", pipelineRoles, { approvals: { plan: true }, loop: { maxMinutes: budgetMs / 60_000 } });
  await until(() => !!run.awaiting);
  // Wait out more than the whole budget, watching all along that the run is still waiting. The
  // budget leaves the rest of the run (after approving) ample time, even on a busy machine.
  const since = Date.now();
  await until(() => run.status !== "running" || Date.now() - since > budgetMs + 500, budgetMs + 10_000);
  assert.equal(run.status, "running", "still waiting, not stopped at the time limit");
  m.answer(run.id, { decision: "approve" });
  await finished(m, run);
  assert.equal(run.status, "done", run.error);
});

test("a pending checkpoint survives a restart and asks again after resume", async () => {
  const a = new RunManager(findPattern);
  const run = await start(a, "pipeline", pipelineRoles, { approvals: { plan: true } });
  await until(() => !!run.awaiting);
  await a.shutdown();
  assert.equal(run.status, "interrupted");

  const b = new RunManager(findPattern);
  await b.load();
  const loaded = b.get(run.id)!;
  await b.resume(run.id);
  await until(() => !!loaded.awaiting);
  assert.deepEqual(agentTitles(loaded), ["Plan"], "the plan is replayed, not re-planned");
  b.answer(run.id, { decision: "approve" });
  await finished(b, loaded);
  assert.equal(loaded.status, "done", loaded.error);
});

test("notes reach the targeted agent's next turn", async () => {
  const record = mkdtempSync(join(tmpdir(), "codeflow-record-"));
  process.env.FAKE_RECORD_DIR = record;
  process.env.FAKE_SLEEP_VENDOR = "claude";
  process.env.FAKE_SLEEP_MS = "1500";
  try {
    const m = new RunManager(findPattern);
    const run = await start(m, "pipeline", pipelineRoles);
    await until(() => run.steps.some((s) => s.title === "Plan" && s.status === "running"));
    m.addNote(run.id, "Prefer tabs over spaces", "codex");
    m.addNote(run.id, "Keep it small");
    await finished(m, run);
    assert.equal(run.status, "done", run.error);

    const implement = run.steps.find((s) => s.title === "Implement plan")!;
    const review = run.steps.find((s) => s.title === "Review (round 1)")!;
    // The untargeted note goes to whoever is next (Codex, implementing); the Codex note too.
    assert.deepEqual(
      run.notes.map((n) => [n.text, n.status, n.deliveredTo?.stepId]),
      [
        ["Prefer tabs over spaces", "delivered", implement.id],
        ["Keep it small", "delivered", implement.id],
      ],
    );
    const codexPrompt = readdirSync(record)
      .map((f) => JSON.parse(readFileSync(join(record, f), "utf8")))
      .find((c) => c.vendor === "codex").prompt as string;
    assert.match(codexPrompt, /^## A message from the user\n\(Sent while the team was working — take it into account\.\)\n- Prefer tabs over spaces\n- Keep it small/);
    assert.ok(review.status === "done");
    assert.throws(() => m.addNote(run.id, "too late"), /use Reply instead/);
  } finally {
    delete process.env.FAKE_RECORD_DIR;
    delete process.env.FAKE_SLEEP_VENDOR;
    delete process.env.FAKE_SLEEP_MS;
  }
});

test("reply after the run: the agent follows up in its own worktree", async () => {
  const m = new RunManager(findPattern);
  const run = await start(m, "pipeline", pipelineRoles);
  await finished(m, run);
  await m.followUp(run.id, { kind: "reply", worktree: "build", agent: "codex", message: "Also add a README section" });
  await finished(m, run);
  assert.equal(run.status, "done", run.error);
  assert.equal(agentTitles(run).at(-1), "Your reply");
  assert.match(run.summary!, /codex followed up on your reply in build/);
});

test("supervisor and test-first have their own checkpoints", async () => {
  const m = new RunManager(findPattern);
  const sup = await start(m, "supervisor", { supervisor: ["claude"], workers: ["claude", "codex"] }, { approvals: { plan: true } });
  await until(() => !!sup.awaiting);
  assert.equal(sup.awaiting!.title, "Approve the subtasks");
  assert.match(sup.awaiting!.content, /1\. \*\*Alpha part\*\* → claude/);
  m.answer(sup.id, { decision: "revise", note: "merge them into one" });
  await until(() => sup.awaiting?.title === "Approve the revised subtasks (2)");
  m.answer(sup.id, { decision: "approve" });
  await finished(m, sup);
  assert.equal(sup.status, "done", sup.error);

  const tdd = await start(m, "tdd", { tester: ["codex"], builder: ["claude"] }, { approvals: { plan: true } });
  await until(() => !!tdd.awaiting);
  assert.equal(tdd.awaiting!.title, "Approve the tests");
  m.answer(tdd.id, { decision: "reject" });
  await finished(m, tdd);
  assert.equal(tdd.status, "cancelled");
  assert.match(tdd.error!, /You rejected the tests/);
});

test("single agent: one turn, then each reply continues its session on its branch", async () => {
  const record = mkdtempSync(join(tmpdir(), "codeflow-record-"));
  process.env.FAKE_RECORD_DIR = record;
  try {
    const m = new RunManager(findPattern);
    const run = await start(m, "solo", { agent: ["claude"] });
    await finished(m, run);
    assert.equal(run.status, "done", run.error);
    assert.deepEqual(agentTitles(run), ["Your task"]);
    assert.equal(run.artifacts.length, 1);
    assert.match(run.summary!, /Changes on `.*solo`/);

    await m.followUp(run.id, { kind: "reply", worktree: "solo", agent: "claude", message: "Now add a test" });
    await finished(m, run);
    assert.equal(run.status, "done", run.error);
    const reply = run.steps.find((s) => s.title === "Your reply")!;
    assert.equal(run.followUps[0]!.stepId, reply.id, "the reply's turn is linked, so the thread can stream it");
    const calls = readdirSync(record).map((f) => JSON.parse(readFileSync(join(record, f), "utf8")) as { args: string[]; prompt: string });
    const replyCall = calls.find((c) => c.prompt.includes("Now add a test"))!;
    assert.ok(replyCall.args.includes("--resume"), "the reply continues the first turn's session");
  } finally {
    delete process.env.FAKE_RECORD_DIR;
  }
});

test("single agent: a turn that fails ends the turn, not the conversation", async () => {
  process.env.FAKE_FAIL_VENDOR = "claude";
  const m = new RunManager(findPattern);
  const run = await start(m, "solo", { agent: ["claude"] });
  try {
    await finished(m, run);
  } finally {
    delete process.env.FAKE_FAIL_VENDOR;
  }
  assert.equal(run.status, "done", run.error);
  assert.equal(run.steps.find((s) => s.title === "Your task")!.status, "failed");
  assert.match(run.summary!, /Claude Code didn't finish/);

  await m.followUp(run.id, { kind: "reply", worktree: "solo", agent: "claude", message: "Try again" });
  await finished(m, run);
  assert.equal(run.status, "done", run.error);
  assert.equal(run.followUps[0]!.status, "done");
});

test("single agent: messages its turn couldn't take become its next turn", async () => {
  process.env.FAKE_SLEEP_VENDOR = "claude";
  process.env.FAKE_SLEEP_MS = "1500";
  try {
    const m = new RunManager(findPattern);
    const run = await start(m, "solo", { agent: ["claude"] });
    await until(() => run.steps.some((s) => s.title === "Your task" && s.status === "running"));
    m.addNote(run.id, "Also update the README");
    m.addNote(run.id, "And keep it short");
    await finished(m, run);
    assert.equal(run.status, "done", run.error);
    assert.deepEqual(agentTitles(run), ["Your task", "Your reply"]);
    const [f] = run.followUps;
    assert.equal(f!.kind, "reply");
    assert.equal(f!.message, "Also update the README\n\nAnd keep it short");
    assert.equal(f!.status, "done");
    assert.deepEqual(
      run.notes.map((n) => [n.status, n.followUp]),
      [
        ["delivered", f!.id],
        ["delivered", f!.id],
      ],
    );
  } finally {
    delete process.env.FAKE_SLEEP_VENDOR;
    delete process.env.FAKE_SLEEP_MS;
  }
});

test("a team run doesn't turn leftover notes into a turn", async () => {
  process.env.FAKE_SLEEP_VENDOR = "claude";
  process.env.FAKE_SLEEP_MS = "1200";
  try {
    const m = new RunManager(findPattern);
    const run = await start(m, "pipeline", pipelineRoles);
    await until(() => run.steps.some((s) => s.title === "Review (round 1)" && s.status === "running"));
    m.addNote(run.id, "For the reviewer's next turn", "codex");
    await finished(m, run);
    assert.equal(run.status, "done", run.error);
    assert.equal(run.followUps.length, 0);
    assert.equal(run.notes[0]!.status, "queued");
  } finally {
    delete process.env.FAKE_SLEEP_VENDOR;
    delete process.env.FAKE_SLEEP_MS;
  }
});
