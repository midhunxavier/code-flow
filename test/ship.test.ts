import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-ship-home-"));

const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { removeWorktrees } = await import("../src/ship.js");
type Run = import("../src/engine.js").Run;
type Manager = InstanceType<typeof RunManager>;

let repo: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString();
const commitAs = ["-c", "user.name=t", "-c", "user.email=t@t"];
const pipelineRoles = { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] } as Record<string, any>;
const manager: Manager = new RunManager(findPattern);

before(() => {
  repo = mkdtempSync(join(tmpdir(), "codeflow-ship-repo-"));
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "ship\n");
  git("add", ".");
  git(...commitAs, "commit", "-qm", "init");
});

function finished(run: Run): Promise<void> {
  return new Promise((resolve) => {
    const check = () => run.status !== "running" && resolve();
    manager.subscribe(run.id, check);
    check();
  });
}
async function runPattern(pattern: string, roles: Record<string, any>, extra: Record<string, unknown> = {}) {
  const run = await manager.start({ checkpointOnFinish: pattern === "solo", pattern: findPattern(pattern)!, task: "Ship it", repo, roles, options: {}, ...extra });
  await finished(run);
  return run;
}
const logs = async (r: Run) => (await manager.events(r.id)).map((e) => (e.type === "log" ? e.text : "")).join("\n");
const agentTitles = (r: Run) => r.steps.filter((s) => s.kind === "agent").map((s) => s.title);
/** The CLI calls the fake agents recorded in `dir` (FAKE_RECORD_DIR). */
const recorded = (dir: string) => readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { args: string[]; prompt: string });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function untilBuildWorktree(run: Run) {
  for (let i = 0; i < 200 && !run.worktrees.some((w) => w.name === "build"); i++) await pause(50);
}

test("an unreadable review verdict fails the run instead of approving", async () => {
  process.env.FAKE_GARBLE_VENDOR = "claude";
  try {
    const run = await runPattern("pipeline", { planner: ["codex"], builder: ["codex"], reviewer: ["claude"] });
    assert.equal(run.status, "failed");
    assert.match(run.error!, /Review \(round 1\) \(claude\) did not return a valid review verdict, even after a retry/);
    assert.deepEqual(agentTitles(run).slice(-2), ["Review (round 1)", "Review (round 1) (retry)"]);
  } finally {
    delete process.env.FAKE_GARBLE_VENDOR;
  }
});

test("a garbled answer gets one retry, which can succeed", async () => {
  process.env.FAKE_GARBLE_VENDOR = "claude";
  process.env.FAKE_GARBLE_ONCE = "1";
  try {
    const run = await runPattern("pipeline", { planner: ["codex"], builder: ["codex"], reviewer: ["claude"] });
    assert.equal(run.status, "done", run.error);
    assert.match(await logs(run), /Review \(round 1\): no valid review verdict \(no JSON answer\); asking again/);
  } finally {
    delete process.env.FAKE_GARBLE_VENDOR;
    delete process.env.FAKE_GARBLE_ONCE;
  }
});

test("judging: a panel votes; a judge that also competes gets a warning", async () => {
  const panel = await runPattern("race", { contestants: ["claude", "codex"], judge: ["codex", "claude"] });
  assert.equal(panel.status, "done", panel.error);
  assert.deepEqual(agentTitles(panel).filter((t) => t.startsWith("Judge")).sort(), ["Judge 1", "Judge 2"]);
  assert.match(await logs(panel), /Votes: B=2/);
  assert.match(await logs(panel), /claude both competes and judges/);
  assert.match(panel.summary!, /Winner: Candidate B — codex/);
});

test("per-file diff of a result branch", async () => {
  const run = await runPattern("pipeline", pipelineRoles);
  const files = await manager.diff(run.id, run.artifacts[0]!.branch);
  assert.equal(files.length, 1);
  assert.match(files[0]!.path, /^codex-.*\.txt$/);
  assert.deepEqual([files[0]!.status, files[0]!.additions, files[0]!.deletions], ["added", 1, 0]);
  assert.match(files[0]!.patch, /^\+codex output$/m);
  await assert.rejects(manager.diff(run.id, "main"), /doesn't belong to this run/);
});

test("the last step's diff is the branch's latest commit only", async () => {
  const run = await runPattern("pipeline", pipelineRoles);
  const branch = run.artifacts[0]!.branch;
  const built = await manager.diff(run.id, branch, true);
  assert.deepEqual(built.map((f) => f.path), (await manager.diff(run.id, branch)).map((f) => f.path), "one commit so far: the build");
  await manager.followUp(run.id, { worktree: "build", agent: "codex", message: "- please also handle empty input" });
  await finished(run);
  const whole = (await manager.diff(run.id, branch)).map((f) => f.path);
  const last = (await manager.diff(run.id, branch, true)).map((f) => f.path);
  assert.equal(whole.length, built.length + last.length, `the follow-up's commit added files of its own: ${whole} vs ${last}`);
  assert.ok(last.length > 0 && last.every((p) => !built.some((f) => f.path === p)), "only what the follow-up changed");
});

test("a side chat on a run: Ask changes nothing; Change edits the run's worktree and continues the chat", async () => {
  const run = await runPattern("pipeline", pipelineRoles);
  const branch = run.artifacts[0]!.branch;
  const head = git("rev-parse", branch).trim();
  const record = mkdtempSync(join(tmpdir(), "codeflow-side-record-"));
  process.env.FAKE_RECORD_DIR = record;
  try {
    await manager.followUp(run.id, { kind: "side", worktree: "build", agent: "claude", message: "What does it do?", side: { chat: "c1", mode: "ask", title: "What does it do?" } });
    await finished(run);
    const ask = run.followUps.at(-1)!;
    assert.equal(ask.status, "done", ask.result);
    assert.equal(git("rev-parse", branch).trim(), head, "Ask committed nothing");
    const askStep = run.steps.find((s) => s.id === ask.stepId)!;
    assert.deepEqual([askStep.mode, askStep.role, askStep.title], ["read", "side chat", "Side chat: What does it do?"]);

    await manager.followUp(run.id, { kind: "side", worktree: "build", agent: "claude", message: "Write it down", side: { chat: "c1", mode: "change", title: "What does it do?" } });
    await finished(run);
    const change = run.followUps.at(-1)!;
    assert.equal(change.status, "done", change.result);
    assert.equal(git("log", "-1", "--format=%s", branch).trim(), `claude: side chat · What does it do? (${change.id})`);
    assert.equal(change.commit, git("rev-parse", branch).trim());
    assert.equal(run.steps.find((s) => s.id === change.stepId)!.mode, "write");
    const calls = readdirSync(record).map((f) => JSON.parse(readFileSync(join(record, f), "utf8")) as { args: string[]; prompt: string });
    const resumed = calls.find((c) => c.prompt.includes("Write it down"))!;
    assert.equal(resumed.args[resumed.args.indexOf("--resume") + 1], askStep.sessionId, "the chat continues its own conversation");
    assert.match(calls.find((c) => c.prompt.includes("What does it do?"))!.prompt, /The task:\nShip it/, "its first turn gets the run's task");
    assert.match(run.summary!, /claude made a change from the side chat "What does it do\?" in build/);
    assert.doesNotMatch(run.summary!, /What does it do\?" in build[\s\S]*What does it do\?" in build/, "the question itself isn't in the summary");
  } finally {
    delete process.env.FAKE_RECORD_DIR;
  }
});

test("files sent with a follow-up go in the worktree's context folder, named in the message, never committed", async () => {
  const run = await runPattern("pipeline", pipelineRoles);
  const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
  await manager.followUp(run.id, { kind: "reply", worktree: "build", agent: "codex", message: "See the screenshot", attachments: [{ name: "pin 1.png", data: png }] });
  await finished(run);
  const f = run.followUps.at(-1)!;
  assert.equal(f.status, "done", f.result);
  assert.equal(f.files?.length, 1);
  assert.match(f.files![0]!, /^\.codeflow-context\/messages\/[a-z0-9]+-pin 1\.png$/);
  assert.match(f.message, /Attached, in this worktree \(not committed\): `\.codeflow-context\/messages\//);
  const wt = run.worktrees.find((w) => w.name === "build")!;
  assert.ok(existsSync(join(wt.path, f.files![0]!)));
  assert.doesNotMatch(git("ls-tree", "-r", "--name-only", run.artifacts[0]!.branch), /codeflow-context/, "not on the branch");
});

test("a reply sent while only a side chat works waits for it, then runs in the team's session", async () => {
  const run = await runPattern("pipeline", pipelineRoles);
  process.env.FAKE_SLEEP_VENDOR = "claude";
  process.env.FAKE_SLEEP_MS = "1200";
  try {
    await manager.followUp(run.id, { kind: "side", worktree: "build", agent: "claude", message: "Take a look", side: { chat: "c-wait", mode: "ask", title: "Take a look" } });
    assert.equal(run.status, "running", "the side chat is working");
    // On main this threw "Follow-ups can be sent once the run has finished".
    await manager.followUp(run.id, { kind: "reply", worktree: "build", agent: "codex", message: "Also handle empty input" });
    assert.equal(run.followUps.at(-1)!.status, "pending", "queued behind the side chat");
    await finished(run);
    assert.equal(run.status, "done", run.error);
    assert.deepEqual(run.followUps.slice(-2).map((f) => [f.kind, f.status]), [["side", "done"], ["reply", "done"]]);
  } finally {
    delete process.env.FAKE_SLEEP_VENDOR;
    delete process.env.FAKE_SLEEP_MS;
  }
});

test("a side chat's turn sent while the team works waits for it", async () => {
  process.env.FAKE_SLEEP_VENDOR = "claude";
  process.env.FAKE_SLEEP_MS = "1500";
  try {
    const run = await manager.start({ pattern: findPattern("pipeline")!, task: "Ship it", repo, roles: pipelineRoles, options: {} });
    for (let i = 0; i < 200 && !run.worktrees.some((w) => w.name === "build"); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(run.status, "running", "the reviewer is still working");
    await manager.followUp(run.id, { kind: "side", worktree: "build", agent: "codex", message: "Any edge cases?", side: { chat: "c2", mode: "ask", title: "Edge cases" } });
    assert.equal(run.followUps.at(-1)!.status, "pending", "queued behind the team");
    await finished(run);
    assert.equal(run.status, "done", run.error);
    assert.equal(run.followUps.at(-1)!.status, "done");
    await assert.rejects(manager.followUp(run.id, { kind: "side", worktree: "build", agent: "codex", message: "x" }), /needs its chat/);
  } finally {
    delete process.env.FAKE_SLEEP_VENDOR;
    delete process.env.FAKE_SLEEP_MS;
  }
});

test("side chat turns queued behind the team get a step budget of their own", async () => {
  process.env.FAKE_SLEEP_VENDOR = "claude";
  process.env.FAKE_SLEEP_MS = "1500";
  try {
    // Plan, build and review take all three steps the run may use.
    const run = await manager.start({ pattern: findPattern("pipeline")!, task: "Ship it", repo, roles: pipelineRoles, options: {}, loop: { maxSteps: 3 } });
    await untilBuildWorktree(run);
    assert.equal(run.status, "running");
    for (const chat of ["c9a", "c9b"]) {
      await manager.followUp(run.id, { kind: "side", worktree: "build", agent: "codex", message: "Any edge cases?", side: { chat, mode: "ask", title: "Edge cases" } });
    }
    await finished(run);
    assert.equal(run.status, "done", run.error);
    assert.deepEqual(run.followUps.map((f) => f.status), ["done", "done"]);
  } finally {
    delete process.env.FAKE_SLEEP_VENDOR;
    delete process.env.FAKE_SLEEP_MS;
  }
});

test("a side chat's turn waiting for a team that's stopped ends, saying why", async () => {
  process.env.FAKE_SLEEP_VENDOR = "claude";
  process.env.FAKE_SLEEP_MS = "1500";
  try {
    const run = await manager.start({ pattern: findPattern("pipeline")!, task: "Ship it", repo, roles: pipelineRoles, options: {} });
    await untilBuildWorktree(run);
    await manager.followUp(run.id, { kind: "side", worktree: "build", agent: "codex", message: "Any edge cases?", side: { chat: "c28", mode: "ask", title: "Edge cases" } });
    assert.ok(manager.cancel(run.id));
    await finished(run);
    assert.equal(run.status, "cancelled");
    const f = run.followUps.at(-1)!;
    assert.equal(f.status, "failed");
    assert.equal(f.result, "The run was cancelled before this turn could finish. Resume the run, then send it again.");
  } finally {
    delete process.env.FAKE_SLEEP_VENDOR;
    delete process.env.FAKE_SLEEP_MS;
  }
});

test("a side Change stopped after its commit: the old proof goes, its steps are the side chat's, and resuming finishes it", async () => {
  // The check passes once there's a change (the fake agents write `*-*.txt`); on the base code, in the
  // proof's checkout, it fails, slowly when asked.
  const check = 'case "$PWD" in *proof-check*) if [ -n "$SLOW_PROOF" ]; then sleep 8; fi;; esac; ls *-*.txt 2>/dev/null | grep -q .';
  const run = await runPattern("solo", { agent: ["claude"] }, { loop: { check } });
  assert.equal(run.status, "done", run.error);
  const branch = run.artifacts[0]!.branch;
  const proof = () => run.proofs?.[branch];
  assert.equal(proof()?.status, "proven");
  process.env.SLOW_PROOF = "1";
  const proving = () => run.steps.find((s) => s.title === "Proof: tests without the change" && s.status === "running");
  try {
    await manager.followUp(run.id, { kind: "side", worktree: "solo", agent: "claude", message: "Change it", side: { chat: "c40", mode: "change", title: "Change it" } });
    for (let i = 0; i < 400 && !proving(); i++) await pause(50);
    const f = run.followUps.at(-1)!;
    assert.ok(proving() && f.commit && f.checkPassed, "committed, checked, and being proven");
    assert.equal(proving()!.sideOf, f.id, "the proof is the side chat's work, not the team's");
    assert.equal(run.steps.find((s) => s.title === `Check after side chat ${f.id}`)?.sideOf, f.id);
    assert.equal(run.steps.find((s) => s.id === f.stepId)?.sideOf, f.id);
    assert.equal(proof(), undefined, "the proof of the code before the change is gone");
    manager.cancel(run.id);
    await finished(run);
    assert.equal(run.status, "cancelled");
    assert.equal(f.status, "pending", "it had started: resuming finishes it, rather than sending it again");
    assert.equal(proof(), undefined);
  } finally {
    delete process.env.SLOW_PROOF;
  }
  await manager.resume(run.id);
  await finished(run);
  const f = run.followUps.at(-1)!;
  assert.equal(run.status, "done", run.error);
  assert.equal(f.status, "done");
  assert.equal(proof()?.head, f.commit, "proven again, at the side chat's commit");
  assert.equal(run.facts?.proof, proof()?.status, "and what Insights counts says the same");
  assert.equal(run.steps.filter((s) => s.sideOf).every((s) => s.sideOf === f.id), true);
  assert.equal(run.steps.filter((s) => !s.sideOf && s.title.includes("side chat")).length, 0, "no side chat step left as the team's");
});

test("side chats and the run's thread keep apart: a reply continues the team's session, and team messages skip side turns", async () => {
  const run = await runPattern("solo", { agent: ["claude"] });
  const team = run.steps.find((s) => s.title === "Your task")!;
  const record = mkdtempSync(join(tmpdir(), "codeflow-side-record-"));
  process.env.FAKE_RECORD_DIR = record;
  try {
    await manager.followUp(run.id, { kind: "side", worktree: "solo", agent: "claude", message: "Where is it handled?", side: { chat: "c6", mode: "ask", title: "Where" } });
    // Typed in the run's own box while the side chat's turn runs: it's for the team.
    const note = manager.addNote(run.id, "also rename foo to bar");
    await finished(run);
    assert.equal(run.status, "done", run.error);
    const side = run.followUps.find((f) => f.side?.chat === "c6")!;
    assert.equal(side.status, "done", side.result);
    assert.doesNotMatch(recorded(record).find((c) => c.prompt.includes("Where is it handled?"))!.prompt, /rename foo/);
    // A chat turns what no turn took into its next turn: a reply to its own agent, in its own session.
    assert.equal(note.status, "delivered");
    const fromNote = run.followUps.find((f) => f.id === note.followUp)!;
    assert.deepEqual([fromNote.kind, fromNote.status, fromNote.worktree], ["reply", "done", "solo"]);
    const resumed = recorded(record).find((c) => c.prompt.includes("also rename foo to bar"))!;
    assert.equal(resumed.args[resumed.args.indexOf("--resume") + 1], team.sessionId, "the team's conversation, not the side chat's");

    await manager.followUp(run.id, { kind: "reply", worktree: "solo", agent: "claude", message: "Now handle empty input" });
    await finished(run);
    const reply = recorded(record).find((c) => c.prompt.includes("Now handle empty input"))!;
    const sideSession = run.steps.find((s) => s.id === side.stepId)!.sessionId;
    assert.notEqual(reply.args[reply.args.indexOf("--resume") + 1], sideSession);
  } finally {
    delete process.env.FAKE_RECORD_DIR;
  }
});

test("a side chat's question keeps the run's verdict and leaves edits you make in the worktree meanwhile", async () => {
  const run = await runPattern("pipeline", pipelineRoles, { loop: { check: "true" } });
  assert.equal(run.verdict, "passed");
  const wt = run.worktrees.find((w) => w.name === "build")!;
  const record = mkdtempSync(join(tmpdir(), "codeflow-side-record-"));
  process.env.FAKE_RECORD_DIR = record;
  process.env.FAKE_SLEEP_VENDOR = "claude";
  process.env.FAKE_SLEEP_MS = "1500";
  try {
    await manager.followUp(run.id, { kind: "side", worktree: "build", agent: "claude", message: "What's in the README?", side: { chat: "c10", mode: "ask", title: "README" } });
    // The agent has its prompt, so code-flow took its snapshot of the worktree: now you edit it.
    for (let i = 0; i < 200 && !readdirSync(record).length; i++) await pause(25);
    assert.equal(run.status, "running");
    writeFileSync(join(wt.path, "README.md"), "ship, with a typo fixed\n");
    writeFileSync(join(wt.path, "notes.md"), "mine\n");
    await finished(run);
    assert.equal(run.followUps.at(-1)!.status, "done", run.followUps.at(-1)!.result);
    assert.equal(readFileSync(join(wt.path, "README.md"), "utf8"), "ship, with a typo fixed\n");
    assert.equal(readFileSync(join(wt.path, "notes.md"), "utf8"), "mine\n");
    assert.match(await logs(run), /Side chat: README \(claude\) is read-only, but build changed while it ran \(edits: "README\.md"; 1 new file: "notes\.md"\)\. Left as it is/);
    assert.equal(run.verdict, "passed", "a question runs no check, so the verdict stands");
  } finally {
    delete process.env.FAKE_RECORD_DIR;
    delete process.env.FAKE_SLEEP_VENDOR;
    delete process.env.FAKE_SLEEP_MS;
  }
});

test("a side chat's question that breaks its worktree's .git fails, saying what changed couldn't be checked", async () => {
  const run = await runPattern("pipeline", pipelineRoles);
  const wt = run.worktrees.find((w) => w.name === "build")!;
  const dotGit = join(wt.path, ".git");
  const original = readFileSync(dotGit, "utf8");
  const record = mkdtempSync(join(tmpdir(), "codeflow-side-record-"));
  process.env.FAKE_RECORD_DIR = record;
  process.env.FAKE_SLEEP_VENDOR = "claude";
  process.env.FAKE_SLEEP_MS = "1500";
  try {
    await manager.followUp(run.id, { kind: "side", worktree: "build", agent: "claude", message: "What's in the README?", side: { chat: "c11", mode: "ask", title: "README" } });
    // The agent has its prompt, so code-flow took its snapshot: now the agent edits a file and deletes `.git`.
    for (let i = 0; i < 200 && !readdirSync(record).length; i++) await pause(25);
    writeFileSync(join(wt.path, "README.md"), "the agent's edit\n");
    rmSync(dotGit);
    await finished(run);
    const f = run.followUps.at(-1)!;
    assert.equal(f.status, "failed", "not done as if nothing changed");
    assert.match(f.result ?? "", /Couldn't check what this read-only step changed \(anything it changed is still there\): .*its \.git is missing/);
    assert.match(await logs(run), /Side chat: README \(claude\) is read-only, but what changed in build while it ran couldn't be checked/);
    assert.equal(readFileSync(join(wt.path, "README.md"), "utf8"), "the agent's edit\n", "left in place, as a question's changes are");
  } finally {
    writeFileSync(dotGit, original);
    delete process.env.FAKE_RECORD_DIR;
    delete process.env.FAKE_SLEEP_VENDOR;
    delete process.env.FAKE_SLEEP_MS;
  }
});

test("a side chat's change that changed nothing isn't reported as a change", async () => {
  const run = await runPattern("pipeline", pipelineRoles);
  const head = git("rev-parse", run.artifacts[0]!.branch).trim();
  process.env.FAKE_NOOP_VENDOR = "claude";
  try {
    await manager.followUp(run.id, { kind: "side", worktree: "build", agent: "claude", message: "Match the header's padding", side: { chat: "c29", mode: "change", title: "Padding" } });
    await finished(run);
    const f = run.followUps.at(-1)!;
    assert.equal(f.status, "done", f.result);
    assert.equal(f.commit, undefined);
    assert.equal(git("rev-parse", run.artifacts[0]!.branch).trim(), head);
    assert.doesNotMatch(run.summary!, /side chat "Padding"/);
  } finally {
    delete process.env.FAKE_NOOP_VENDOR;
  }
});

test("files sent to a run whose worktrees were removed: the worktree is checked out again first, and nothing lands in your checkout", async () => {
  const run = await runPattern("pipeline", pipelineRoles);
  const wt = run.worktrees.find((w) => w.name === "build")!;
  // Hold an already-captured archive projection while followUp awaits its policy lookup.
  // A slow disk must not replace the live run after a mutation has adopted it.
  const cold = (manager as unknown as { coldRuns: import("../src/run-cold-store.js").RunColdStore }).coldRuns, save = cold.save.bind(cold);
  let saveEntered!: () => void, releaseSave!: () => void, policyEntered!: () => void, releasePolicy!: () => void;
  const saving = new Promise<void>((resolve) => saveEntered = resolve), saveGate = new Promise<void>((resolve) => releaseSave = resolve), checking = new Promise<void>((resolve) => policyEntered = resolve), policyGate = new Promise<void>((resolve) => releasePolicy = resolve);
  let saved: boolean | undefined;
  cold.save = async (value, seq) => { const snapshot = structuredClone(value); saveEntered(); await saveGate; saved = await save(snapshot, seq); return saved; };
  try {
    await manager.archive(run.id, { cleanup: true });
    await saving;
    await (await import("../src/store.js")).flushWrites();
    assert.ok(!existsSync(wt.path), "removed; its branch is kept");
    const head = git("rev-parse", "HEAD").trim();
    writeFileSync(join(repo, "mine.txt"), "yours, not committed\n");
    const status = git("status", "--porcelain");
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    manager.setFilesystemPolicyGuard(async () => { policyEntered(); await policyGate; return []; });
    const follow = manager.followUp(run.id, { kind: "reply", worktree: "build", agent: "codex", message: "See the screenshot", attachments: [{ name: "pin.png", data: png }] });
    await checking; releaseSave();
    while (manager.inspectStorage().pending) await pause(1);
    assert.equal(saved, true, "the captured archive projection reached disk");
    releasePolicy(); await follow;
    await finished(run);
    assert.equal(manager.get(run.id), run, "the retained handle is the authoritative live run");
    const f = manager.get(run.id)!.followUps.at(-1)!;
    assert.ok(f, "the accepted attachment follow-up survives the older archive write");
    assert.equal(f.status, "done", f.result);
    assert.ok(existsSync(join(wt.path, ".git")), "a worktree again, not a plain folder");
    assert.ok(existsSync(join(wt.path, f.files![0]!)), "with the file in it");
    assert.equal(git("log", "-1", "--format=%s", wt.branch).trim(), `codex: follow-up to your reply (${f.id})`);
    assert.equal(git("rev-parse", "HEAD").trim(), head, "nothing committed in your checkout");
    assert.equal(git("status", "--porcelain"), status, "and your own changes there are as they were");
  } finally {
    releaseSave(); releasePolicy(); cold.save = save; manager.setFilesystemPolicyGuard(async () => []);
    rmSync(join(repo, "mine.txt"), { force: true });
  }
});

test("a refused archived follow-up stages no files, returns to cold storage and permits a valid retry", async () => {
  const run = await runPattern("pipeline", pipelineRoles);
  const waitForCold = async () => {
    const deadline = Date.now() + 10_000;
    while (!manager.list().find((item) => item.id === run.id)?.cold) { assert.ok(Date.now() < deadline, "the archived run returns to bounded cold storage"); await pause(5); }
  };
  await manager.archive(run.id); await waitForCold();
  await assert.rejects(manager.followUp(run.id, { kind: "reply", worktree: "missing", agent: "codex", message: "Refused", attachments: [{ name: "not-staged.txt", data: Buffer.from("private").toString("base64") }] }), /Unknown worktree/);
  assert.equal(manager.get(run.id)!.archived, true); assert.deepEqual(manager.get(run.id)!.followUps, []);
  assert.equal(existsSync(join(run.worktreeDir, ".context", "messages")), false);
  await waitForCold();
  const retried = await manager.followUp(run.id, { kind: "reply", worktree: "build", agent: "codex", message: "Accepted retry" }); await finished(retried);
  assert.equal(manager.get(run.id)!.followUps.length, 1); assert.equal(manager.get(run.id)!.followUps[0]!.status, "done"); assert.equal(manager.get(run.id)!.archived, false);
});

test("a plain folder at a removed worktree's path: code-flow's own leftovers are cleared, anything else is left for you", async () => {
  const run = await runPattern("pipeline", pipelineRoles);
  const wt = run.worktrees.find((w) => w.name === "build")!;
  await manager.archive(run.id, { cleanup: true });
  // What an older code-flow left when files came with a reply to a removed worktree.
  mkdirSync(join(wt.path, ".codeflow-context", "messages"), { recursive: true });
  writeFileSync(join(wt.path, "notes.txt"), "mine\n");

  await manager.followUp(run.id, { kind: "reply", worktree: "build", agent: "codex", message: "Go on" });
  await finished(run);
  const refused = run.followUps.at(-1)!;
  assert.equal(refused.status, "failed");
  assert.match(refused.result!, /is a folder but not the worktree of build/);
  assert.equal(readFileSync(join(wt.path, "notes.txt"), "utf8"), "mine\n", "left alone");

  rmSync(join(wt.path, "notes.txt"));
  await manager.followUp(run.id, { kind: "reply", worktree: "build", agent: "codex", message: "Go on" });
  await finished(run);
  const f = run.followUps.at(-1)!;
  assert.equal(f.status, "done", f.result);
  assert.ok(existsSync(join(wt.path, ".git")));
  assert.equal(git("log", "-1", "--format=%s", wt.branch).trim(), `codex: follow-up to your reply (${f.id})`);
});

test("review comments go back to the agent as a follow-up in the same run", async () => {
  const run = await runPattern("pipeline", pipelineRoles);
  const before = agentTitles(run);
  await manager.followUp(run.id, { worktree: "build", agent: "codex", message: "- codex-x.txt:1 — please also handle empty input" });
  await finished(run);
  assert.equal(run.status, "done", run.error);
  assert.deepEqual(agentTitles(run), [...before, "Address review comments"], "the pattern replays; only the follow-up runs");
  assert.equal(run.followUps[0]!.status, "done");
  assert.match(run.summary!, /## Follow-ups\n- codex addressed your review comments in build/);
  const followUpStep = run.steps.at(-1)!;
  assert.equal(followUpStep.agent, "codex");
  assert.equal(git("log", "-1", "--format=%s", run.artifacts[0]!.branch).trim(), "codex: address review comments (f1)");
  await assert.rejects(manager.followUp(run.id, { worktree: "nope", agent: "codex", message: "x" }), /Unknown worktree/);
});

test("merge into a branch that isn't checked out uses merge-tree; into the checkout only when clean", async () => {
  const run = await runPattern("pipeline", pipelineRoles);
  const branch = run.artifacts[0]!.branch;
  git("branch", "release", "main");

  const viaRef = await manager.merge(run.id, { branch, into: "release" });
  assert.ok(viaRef.ok && viaRef.method === "ref");
  assert.ok(git("ls-tree", "-r", "--name-only", "release").includes("codex-"));
  assert.equal(git("log", "-1", "--format=%P", "release").trim().split(" ").length, 2, "a real merge commit");
  await assert.rejects(manager.merge(run.id, { branch, into: "release" }), /Nothing to merge: release already has everything on/);

  writeFileSync(join(repo, "README.md"), "dirty\n");
  await assert.rejects(manager.merge(run.id, { branch, into: "main" }), /has uncommitted changes/);
  git("checkout", "--", "README.md");

  const viaCheckout = await manager.merge(run.id, { branch, into: "main", archiveAfter: true });
  assert.ok(viaCheckout.ok && viaCheckout.method === "checkout");
  assert.ok(existsSync(join(repo, readFirstAdded(branch))), "your checkout now has the change");
  assert.equal(run.merges.length, 2);
  assert.equal(run.archived, true, "archived after merging");
  assert.ok(!existsSync(run.worktrees[0]!.path), "its worktrees were removed");
  assert.ok(git("branch", "--list", branch).trim(), "the branch is kept");
});

test("conflicts are reported, and an agent can resolve them in the run's worktree", async () => {
  const run = await runPattern("pipeline", pipelineRoles);
  const branch = run.artifacts[0]!.branch;
  const file = readFirstAdded(branch);
  git("checkout", "-q", "-b", "conflicting", "main");
  writeFileSync(join(repo, file), "someone else's version\n");
  git("add", file);
  git(...commitAs, "commit", "-qm", "conflicting change");
  git("checkout", "-q", "main");

  const outcome = await manager.merge(run.id, { branch, into: "conflicting" });
  assert.ok(!outcome.ok);
  assert.deepEqual(outcome.conflicts, [file]);

  await manager.followUp(run.id, { kind: "resolve-conflicts", worktree: "build", agent: "claude", mergeFrom: "conflicting" });
  await finished(run);
  assert.equal(run.status, "done", run.error);
  assert.equal(git("show", `${branch}:${file}`), "resolved by fake agent\n");
  const retry = await manager.merge(run.id, { branch, into: "conflicting" });
  assert.ok(retry.ok, "merges cleanly once resolved");
});

test("archive can remove worktrees and branches; PRs need a remote", async () => {
  const run = await runPattern("pipeline", pipelineRoles);
  const branch = run.artifacts[0]!.branch;
  await assert.rejects(manager.pullRequest(run.id, { branch, into: "main" }), /no 'origin' remote/);
  const trees = [...run.worktrees];
  const result = await manager.archive(run.id, { cleanup: true, deleteBranches: true });
  assert.equal(result.removed.length, trees.length);
  assert.deepEqual(result.deletedBranches.sort(), trees.map((w) => w.branch).sort());
  assert.equal(git("branch", "--list", branch).trim(), "");
  // Their branches gone, the worktrees are recorded as deleted rather than listed.
  assert.deepEqual(run.worktrees, []);
  assert.deepEqual(run.deletedWorktrees?.map((w) => w.branch).sort(), trees.map((w) => w.branch).sort());
});

test("merging into your checkout: only a real conflict is offered to an agent; anything else says what to do", async () => {
  const run = await runPattern("pipeline", pipelineRoles);
  const branch = run.artifacts[0]!.branch;
  const file = readFirstAdded(branch);
  const merges = () => run.merges.length;
  const before = merges();

  // An untracked file where the merge would write one: git refuses, and that isn't a conflict.
  writeFileSync(join(repo, file), "mine, not committed\n");
  await assert.rejects(manager.merge(run.id, { branch, into: "main" }), new RegExp(`untracked files in your checkout would be overwritten: ${file.replace(/\./g, "\\.")}\\. Move or commit them`));
  rmSync(join(repo, file));

  // Another git holding the index lock.
  writeFileSync(join(repo, ".git", "index.lock"), "");
  try {
    await assert.rejects(manager.merge(run.id, { branch, into: "main" }), /another git process is using this repository/);
  } finally {
    rmSync(join(repo, ".git", "index.lock"));
  }

  // Staged changes are uncommitted changes too.
  writeFileSync(join(repo, "staged.txt"), "staged\n");
  git("add", "staged.txt");
  await assert.rejects(manager.merge(run.id, { branch, into: "main" }), /has uncommitted changes/);
  git("rm", "-q", "--cached", "staged.txt");
  rmSync(join(repo, "staged.txt"));

  // A real conflict: its files are listed, and your checkout is left as it was.
  writeFileSync(join(repo, file), "main's own version\n");
  git("add", file);
  git(...commitAs, "commit", "-qm", "main's version");
  const head = git("rev-parse", "HEAD").trim();
  const outcome = await manager.merge(run.id, { branch, into: "main" });
  assert.ok(!outcome.ok);
  assert.deepEqual(outcome.conflicts, [file]);
  assert.equal(git("rev-parse", "HEAD").trim(), head);
  assert.equal(git("status", "--porcelain").trim(), "", "nothing half-merged is left behind");
  assert.ok(!existsSync(join(repo, ".git", "MERGE_HEAD")));
  assert.equal(merges(), before);
});

test("removing worktrees: a locked one takes --force twice; what can't be removed is reported", async () => {
  const base = mkdtempSync(join(tmpdir(), "codeflow-ship-wt-"));
  const locked = join(base, "locked");
  const held = join(base, "held");
  git("worktree", "add", "-q", "-b", "wt-locked", locked, "main");
  git("worktree", "lock", locked);
  git("worktree", "add", "-q", "-b", "wt-held", held, "main");
  const result = await removeWorktrees(
    repo,
    [
      { path: locked, branch: "wt-locked" },
      // Its folder is gone already, and its branch is checked out somewhere else: it can't be deleted.
      { path: join(base, "gone"), branch: "wt-held" },
    ],
    true,
  );
  assert.deepEqual(result.removed, [locked]);
  assert.deepEqual(result.deletedBranches, ["wt-locked"]);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0]!, /^branch wt-held: .*(checked out|used by worktree)/i);
  git("worktree", "remove", "--force", held);
  git("branch", "-D", "wt-held");
});

function readFirstAdded(branch: string): string {
  return git("diff", "--name-only", `main...${branch}`).trim().split("\n")[0]!;
}
