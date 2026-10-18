// Fixes from a review of the orchestration core: a resume replays what the pattern saw (not the
// newest commit on disk), Stop reaches a resume that's starting, follow-ups and failed turns are
// journaled for what they are, notes don't wait for a turn that never comes, the council keeps
// confirmed findings, a repro that never ran refutes nothing, slot waits don't use the time
// budget, and archiving is refused while busy and cleans up after itself. Agents are the fake
// CLIs, or an in-test stub where a test needs a specific answer.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-review-home-"));
process.env.CODEFLOW_RETRY_DELAYS_MS = "0";
// One agent at a time across every run, so a test can keep a run waiting for a slot.
process.env.CODEFLOW_MAX_AGENTS = "1";

const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { adapters } = await import("../src/adapters/index.js");
const { loadJournal } = await import("../src/store.js");
type Run = import("../src/engine.js").Run;
type Pattern = import("../src/engine.js").Pattern;
type Manager = InstanceType<typeof RunManager>;
type AgentId = import("../src/adapters/index.js").AgentId;
type RunOptions = import("../src/adapters/index.js").RunOptions;
type RunResult = import("../src/adapters/index.js").RunResult;
type AgentEvent = import("../src/adapters/index.js").AgentEvent;

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd }).toString().trim();
let repo: string;

function newRepo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "codeflow-review-repo-"));
  sh(dir, "init", "-q", "-b", "main");
  for (const [path, body] of Object.entries({ "README.md": "review\n", ...files })) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  sh(dir, "add", "-A");
  sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return dir;
}

before(() => {
  repo = newRepo();
});

function idle(manager: Manager, run: Run): Promise<Run> {
  return new Promise((resolve) => {
    const check = () => run.status !== "running" && resolve(run);
    manager.subscribe(run.id, check);
    check();
  });
}

async function until(cond: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const logs = async (m: Manager, run: Run) => (await m.events(run.id)).map((e) => (e.type === "log" ? e.text : "")).join("\n");

type Stub = (opts: RunOptions, onEvent: (e: AgentEvent) => void) => Promise<RunResult>;

/** Replace these agents' adapters with `stub` while `fn` runs. */
async function withStub<T>(agents: AgentId[], stub: Stub, fn: () => Promise<T>): Promise<T> {
  const saved = agents.map((a) => adapters[a].run);
  for (const a of agents) adapters[a].run = stub;
  try {
    return await fn();
  } finally {
    agents.forEach((a, i) => (adapters[a].run = saved[i]!));
  }
}

const answer = (text: string): RunResult => ({ ok: true, finalText: text, sessionId: `session-${Math.random().toString(36).slice(2)}` });
const json = (value: object): RunResult => ({ ...answer(`Done.\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``), structured: value });
const stopped = (signal?: AbortSignal) =>
  new Promise<RunResult>((resolve) => {
    const end = () => resolve({ ok: false, finalText: "", error: "Cancelled", errorKind: "cancelled" });
    if (signal?.aborted) end();
    else signal?.addEventListener("abort", end, { once: true });
  });

const testFile = (body: string) => `import { test } from "node:test";\nimport assert from "node:assert";\nimport { existsSync } from "node:fs";\n${body}\n`;

// ---------------------------------------------------------------- replay reads the replayed commit
/**
 * Test-first, played by a stub: the tester's tests pass once impl.txt exists; its first probe
 * finds a gap (no edge.txt), which the builder's second round fills. A builder round after that
 * leaves a file named for it, so a run that goes round again shows in its tree.
 */
function testFirst(control: { holdSecondProbe: boolean }): Stub {
  const fixes = new Map<string, number>();
  return async (opts) => {
    const at = (file: string) => join(opts.cwd, file);
    if (opts.prompt.includes('"test_command"')) {
      writeFileSync(at("spec.test.mjs"), testFile('test("implemented", () => assert.ok(existsSync("impl.txt")));'));
      return json({ test_command: "node --test spec.test.mjs", test_files: ["spec.test.mjs"] });
    }
    if (opts.prompt.includes('"verdict": "pass" | "fail"')) {
      if (!existsSync(at("edge.txt"))) return json({ verdict: "fail", failures: ["empty input isn't handled"] });
      if (control.holdSecondProbe) return stopped(opts.signal);
      return json({ verdict: "pass", failures: [] });
    }
    if (opts.prompt.includes("Tests to satisfy")) {
      writeFileSync(at("impl.txt"), "v1\n");
      return answer("Implemented it.");
    }
    if (opts.prompt.includes("Not done yet")) {
      const n = (fixes.get(opts.cwd) ?? 0) + 1;
      fixes.set(opts.cwd, n);
      if (n === 1) {
        writeFileSync(at("impl.txt"), "v2\n");
        writeFileSync(at("edge.txt"), "empty input handled\n");
      } else writeFileSync(at(`fix-${n}.txt`), "another round\n");
      return answer("Handled empty input.");
    }
    return answer("Nothing to do.");
  };
}

const tddRoles = { tester: ["codex"], builder: ["claude"] } as Record<string, any>;
const tree = (branch: string) => sh(repo, "rev-parse", `${branch}^{tree}`);

test("a Test-first run stopped in its second round and resumed ends with the tree an uninterrupted run has", async () => {
  const manager = new RunManager(findPattern);
  const start = () => manager.start({ pattern: findPattern("tdd")!, task: "Handle input", repo, roles: tddRoles, options: {} });
  const control = { holdSecondProbe: false };
  await withStub(["claude", "codex"], testFirst(control), async () => {
    const straight = await idle(manager, await start());
    assert.equal(straight.status, "done", straight.error);
    const expected = tree(straight.worktrees[0]!.branch);
    assert.deepEqual(sh(repo, "ls-tree", "--name-only", expected).split("\n").sort(), ["README.md", "edge.txt", "impl.txt", "spec.test.mjs"]);

    control.holdSecondProbe = true;
    const run = await start();
    await until(() => run.steps.some((s) => s.title === "Try to break it (round 2)" && s.status === "running"));
    manager.cancel(run.id);
    await idle(manager, run);
    assert.equal(run.status, "cancelled");

    control.holdSecondProbe = false;
    await manager.resume(run.id);
    await idle(manager, run);
    assert.equal(run.status, "done", run.error);
    const branch = run.worktrees[0]!.branch;
    assert.equal(tree(branch), expected, "the builder's second round is kept, and no round runs again");
    assert.doesNotMatch(sh(repo, "log", "--format=%s", branch), /code-flow: (undo|restore)/, "nothing was undone on replay");
    const live = run.steps.filter((s) => s.kind === "agent").map((s) => `${s.title}:${s.status}`);
    assert.deepEqual(live.slice(-2), ["Try to break it (round 2):cancelled", "Try to break it (round 2):done"], "only the probe that was stopped ran again");
  });
});

// ---------------------------------------------------------------- a pattern of one turn, for the tests below
/** One write turn on the task, then a commit. Not a chat: notes no turn takes aren't its next turn. */
const oneTurn: Pattern = {
  id: "one-turn",
  name: "One turn",
  summary: "",
  description: "",
  roles: [{ id: "agent", label: "Agent", description: "", default: ["claude"] }],
  options: [],
  async run(ctx) {
    const wt = await ctx.worktree("work");
    await ctx.ask({ title: "Work", role: "agent", agent: ctx.agent("agent"), mode: "write", cwd: wt, prompt: ctx.task });
    await ctx.commit(wt, "work");
    await ctx.artifact("Result", wt);
    return "Done.";
  },
};
const withOneTurn = (id: string) => (id === oneTurn.id ? oneTurn : findPattern(id));
const pipeline = { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] } as Record<string, any>;

/** A turn whose prompt says HOLD keeps its slot until `release()` (or the run stops); other prompts end at once. */
function holding() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const stub: Stub = async (opts) => {
    if (!opts.prompt.includes("HOLD")) return answer("Done.");
    // A real CLI is a child process, which keeps the event loop alive; the run's own timers don't.
    const alive = setInterval(() => {}, 1_000);
    const ended = await Promise.race([gate.then(() => false), stopped(opts.signal).then(() => true)]).finally(() => clearInterval(alive));
    if (ended) return { ok: false, finalText: "", error: "Cancelled", errorKind: "cancelled" };
    writeFileSync(join(opts.cwd, "held.txt"), "done\n");
    return answer("Done after holding.");
  };
  return { stub, release };
}

// ---------------------------------------------------------------- Stop while a resume starts
test("Stop pressed while a resume reads the run's log and journal: the run doesn't start", async () => {
  const manager = new RunManager(findPattern);
  const run = await withStub(["codex"], async () => ({ ok: false, finalText: "", error: "boom", errorKind: "other" }), async () =>
    idle(manager, await manager.start({ pattern: findPattern("pipeline")!, task: "Stop me", repo, roles: pipeline, options: {} })),
  );
  assert.equal(run.status, "failed");
  const steps = run.steps.length;
  const events = manager.events.bind(manager);
  let said: boolean | undefined;
  manager.events = async (id: string) => {
    said = manager.cancel(id);
    return events(id);
  };
  try {
    await manager.resume(run.id);
  } finally {
    manager.events = events;
  }
  assert.equal(said, true, "Stop said yes");
  assert.equal(run.status, "failed", "and the run stayed as it was");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(run.steps.length, steps, "no step ran");
  await manager.resume(run.id);
  await idle(manager, run);
  assert.equal(run.status, "done", "a later Resume still runs it");
});

// ---------------------------------------------------------------- follow-up journal keys
test("a second conflict resolution with the same branch is committed, not replayed from the first", async () => {
  const dir = newRepo({ "shared.txt": "base\n" });
  const g = (...args: string[]) => sh(dir, ...args);
  const manager = new RunManager(findPattern);
  const run = await idle(manager, await manager.start({ pattern: findPattern("solo")!, task: "Edit shared.txt CONFLICT", repo: dir, roles: { agent: ["claude"] }, options: {} }));
  assert.equal(run.status, "done", run.error);
  const wt = run.worktrees[0]!;
  g("branch", "theirs", "main");
  const theirs = (text: string) => {
    g("checkout", "-q", "theirs");
    writeFileSync(join(dir, "shared.txt"), text);
    g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", text.trim());
    g("checkout", "-q", "main");
    return g("rev-parse", "theirs");
  };
  const resolve = async () => {
    await manager.followUp(run.id, { kind: "resolve-conflicts", worktree: wt.name, agent: "claude", mergeFrom: "theirs" });
    await idle(manager, run);
    return run.followUps.at(-1)!;
  };
  const first = theirs("theirs, once\n");
  const f1 = await resolve();
  assert.equal(f1.status, "done", f1.result);
  assert.equal(g("log", "-1", "--format=%P", wt.branch).split(" ")[1], first);
  const second = theirs("theirs, twice\n");
  const f2 = await resolve();
  assert.equal(f2.status, "done", f2.result);
  assert.notEqual(f2.commit, f1.commit, "a commit of its own");
  assert.equal(g("log", "-1", "--format=%P", wt.branch).split(" ")[1], second, "the second merge is on the branch");
  assert.throws(() => execFileSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: wt.path, stdio: "ignore" }), "no merge is left half done");
  assert.equal(g("log", "-1", "--format=%s", wt.branch), `Merge theirs (conflicts resolved by claude, ${f2.id})`);
});

// ---------------------------------------------------------------- failed turns that aren't results
const race = { contestants: ["claude", "codex"], judge: ["agy"] } as Record<string, any>;
const realCodex = adapters.codex.run.bind(adapters.codex);

test("a contestant whose CLI was signed out isn't journaled as failed; one out of plan usage stops the race for a resume", async () => {
  const manager = new RunManager(findPattern);
  const signedOut = await withStub(["codex"], async () => ({ ok: false, finalText: "", error: "Not logged in", errorKind: "auth" }), async () =>
    idle(manager, await manager.start({ pattern: findPattern("race")!, task: "Race me", repo, roles: race, options: {} })),
  );
  assert.equal(signedOut.status, "done", signedOut.error);
  const keys = [...(await loadJournal(signedOut.id)).keys()];
  assert.ok(keys.includes("ask:contestants|claude|candidate-a|Candidate A#1"), keys.join(", "));
  assert.ok(!keys.some((k) => k.startsWith("ask:contestants|codex|")), "a resume gives it its turn again");

  let limited = true;
  const run = await withStub(["codex"], async (opts, onEvent) => (limited ? { ok: false, finalText: "", error: "Plan exhausted", errorKind: "usage_limit" } : realCodex(opts, onEvent)), async () => {
    const r = await idle(manager, await manager.start({ pattern: findPattern("race")!, task: "Race me again", repo, roles: race, options: {} }));
    assert.equal(r.status, "stopped", "stopped, not judged with one candidate fewer");
    assert.match(r.stopReason!, /usage limit of Codex/);
    assert.ok(!r.steps.some((s) => s.title.startsWith("Judge")));
    limited = false;
    await manager.resume(r.id);
    return idle(manager, r);
  });
  assert.equal(run.status, "done", run.error);
  assert.ok(run.steps.some((s) => s.title === "Candidate B" && s.status === "done"), "B had its turn after the resume");
  assert.ok(run.steps.some((s) => s.title === "Judge candidates" && s.status === "done"), "and both were judged");
});

// ---------------------------------------------------------------- notes after the last turn
test("a note no turn took when a team run finishes is marked undelivered, and a later reply doesn't get it", async () => {
  const manager = new RunManager(withOneTurn);
  const { stub, release } = holding();
  const prompts: string[] = [];
  await withStub(["claude"], async (opts, onEvent) => (prompts.push(opts.prompt), stub(opts, onEvent)), async () => {
    const run = await manager.start({ pattern: oneTurn, task: "HOLD while I write", repo, roles: { agent: ["claude"] }, options: {} });
    await until(() => run.steps.some((s) => s.title === "Work" && s.status === "running"));
    manager.addNote(run.id, "Use tabs");
    release();
    await idle(manager, run);
    assert.equal(run.status, "done", run.error);
    assert.equal(run.notes[0]!.status, "undelivered");
    assert.match(await logs(manager, run), /Your message didn't reach an agent: the run finished before another turn could take it\. Reply to send it: “Use tabs”/);

    await manager.followUp(run.id, { kind: "reply", worktree: "work", agent: "claude", message: "One more thing" });
    await idle(manager, run);
    assert.equal(run.followUps.at(-1)!.status, "done", run.followUps.at(-1)!.result);
    assert.match(prompts.at(-1)!, /One more thing/);
    assert.doesNotMatch(prompts.at(-1)!, /Use tabs/, "it isn't handed to the next turn as if just sent");
  });
});

// ---------------------------------------------------------------- the council keeps confirmed findings
const failing = (name: string) => testFile(`test("${name}", () => assert.fail("the bug is there"));`);
const passing = (name: string) => testFile(`test("${name}", () => assert.ok(true));`);

test("council: a finding a test confirms comes back when the chair drops it, and goes back up when the chair rates it lower", async () => {
  const x = { severity: "high", file: "x.txt", problem: "X overflows", fix: "Bound it", repro: { path: "x.test.mjs", contents: failing("x"), command: "node --test x.test.mjs" } };
  const y = { severity: "medium", file: "y.txt", problem: "Y leaks", fix: "Close it", repro: { path: "y.test.mjs", contents: failing("y"), command: "node --test y.test.mjs" } };
  const none = { path: "", contents: "", command: "" };
  const reviewer: Stub = async () => json({ verdict: "changes_requested", issues: [x, y] });
  const quiet: Stub = async () => json({ verdict: "approve", issues: [] });
  const chair: Stub = async () =>
    json({
      verdict: "approve",
      summary: "Minor things only.",
      findings: [
        { ...y, severity: "low", raised_by: ["A"] },
        { severity: "low", file: "README.md", problem: "Typo", fix: "Fix it", raised_by: ["B"], repro: none },
      ],
    });
  const manager = new RunManager(findPattern);
  const run = await withStub(["claude"], reviewer, () =>
    withStub(["codex"], quiet, () =>
      withStub(["agy"], chair, async () =>
        idle(manager, await manager.start({ pattern: findPattern("council")!, task: "Review it", repo, roles: { reviewers: ["claude", "codex"], chair: ["agy"] }, options: {} })),
      ),
    ),
  );
  assert.equal(run.status, "done", run.error);
  const review = run.review!;
  assert.equal(review.verdict, "changes_requested", "the confirmed findings block, whatever the chair said");
  assert.deepEqual(
    review.findings.map((f) => [f.severity, f.problem, f.check?.status, f.restored ?? ""]),
    [
      ["high", "X overflows", "confirmed", "from Reviewer A, whose test confirms it: the chair left it out"],
      ["medium", "Y leaks", "confirmed", "from Reviewer A, whose test confirms it: the chair rated it low"],
      ["low", "Typo", "unconfirmed", ""],
    ],
  );
  assert.deepEqual(review.findings[0]!.raisedBy, ["claude"]);
  assert.match(review.markdown, /\*Restored by code-flow:\* from Reviewer A, whose test confirms it: the chair left it out/);
  assert.match(await logs(manager, run), /The chair left out or rated lower 2 findings a test confirms; code-flow put them back as raised/);
});

test("council: findings that share a test are still different findings", async () => {
  // One test (a plain test command would do the same) shows three bugs in three files: the chair
  // keeps Reviewer A's first; A's second and B's aren't that finding, so they come back.
  const shared = { path: "shared.test.mjs", contents: failing("shared"), command: "node --test shared.test.mjs" };
  const x = { severity: "high", file: "x.txt", problem: "X overflows", fix: "Bound it", repro: shared };
  const y = { severity: "high", file: "y.txt", problem: "Y leaks", fix: "Close it", repro: shared };
  const z = { severity: "high", file: "z.txt", problem: "Z races", fix: "Lock it", repro: shared };
  const chair: Stub = async () => json({ verdict: "changes_requested", summary: "One bug.", findings: [{ ...x, raised_by: ["A"] }] });
  const manager = new RunManager(findPattern);
  const run = await withStub(["claude"], async () => json({ verdict: "changes_requested", issues: [x, y] }), () =>
    withStub(["codex"], async () => json({ verdict: "changes_requested", issues: [z] }), () =>
      withStub(["agy"], chair, async () =>
        idle(manager, await manager.start({ pattern: findPattern("council")!, task: "Review it", repo, roles: { reviewers: ["claude", "codex"], chair: ["agy"] }, options: {} })),
      ),
    ),
  );
  assert.equal(run.status, "done", run.error);
  assert.deepEqual(
    run.review!.findings.map((f) => [f.problem, f.check?.status, f.restored ?? ""]).sort(),
    [
      ["X overflows", "confirmed", ""],
      ["Y leaks", "confirmed", "from Reviewer A, whose test confirms it: the chair left it out"],
      ["Z races", "confirmed", "from Reviewer B, whose test confirms it: the chair left it out"],
    ],
  );
});

// ---------------------------------------------------------------- a repro that never ran
test("a reviewer's own command that never ran its test couldn't tell; one that ran it refutes or confirms", async () => {
  const dir = newRepo({
    "other.test.mjs": passing("other"),
    "quiet.mjs": "// runs no tests and says nothing\n",
    "package.json": JSON.stringify({ name: "fixture", private: true, scripts: { test: "node quiet.mjs" } }),
  });
  const cases = {
    elsewhere: { path: "bound.test.mjs", contents: failing("bound"), command: "node --test other.test.mjs" },
    silent: { path: "bound.test.mjs", contents: failing("bound"), command: "npm test" },
    named: { path: "bound.test.mjs", contents: passing("bound"), command: "node --test bound.test.mjs" },
    discovered: { path: "bound.test.mjs", contents: passing("bound"), command: "node --test" },
    fails: { path: "bound.test.mjs", contents: failing("bound"), command: "node --test bound.test.mjs" },
  };
  const found: Record<string, { status: string; detail: string }> = {};
  const probe: Pattern = {
    ...oneTurn,
    id: "repro-probe",
    async run(ctx) {
      const wt = await ctx.worktree("work");
      for (const [name, repro] of Object.entries(cases)) found[name] = await ctx.reproduce(wt, repro, `Repro: ${name}`);
      return "Done.";
    },
  };
  const manager = new RunManager(findPattern);
  const run = await idle(manager, await manager.start({ pattern: probe, task: "Check repros", repo: dir, roles: { agent: ["claude"] }, options: {} }));
  assert.equal(run.status, "done", run.error);
  assert.equal(found.elsewhere!.status, "unverified", found.elsewhere!.detail);
  assert.match(found.elsewhere!.detail, /`node --test other\.test\.mjs` ran 1 tests with it, as many as without, so it didn't run bound\.test\.mjs/);
  assert.equal(found.silent!.status, "unverified", found.silent!.detail);
  assert.match(found.silent!.detail, /doesn't say how many tests it ran, and its output doesn't mention bound\.test\.mjs/);
  assert.equal(found.named!.status, "refuted", "it names the test, and a test ran");
  assert.equal(found.discovered!.status, "refuted", "one more test ran with it than without");
  assert.equal(found.fails!.status, "confirmed");
  assert.ok(run.steps.some((s) => s.title === "Repro: elsewhere (without the test)" && s.status === "done"));
});

// ---------------------------------------------------------------- slot waits and the time budget
test("waiting for an agent slot doesn't use a run's time budget; a turn that takes too long still stops it", async () => {
  const manager = new RunManager(withOneTurn);
  const { stub, release } = holding();
  await withStub(["claude"], stub, async () => {
    const busy = await manager.start({ pattern: oneTurn, task: "HOLD the only slot", repo, roles: { agent: ["claude"] }, options: {} });
    await until(() => busy.steps.some((s) => s.title === "Work" && s.status === "running"));
    // 1.2 s of budget, behind a run that holds the only slot for longer than that.
    const queued = await manager.start({ pattern: oneTurn, task: "Quick", repo, roles: { agent: ["claude"] }, options: {}, loop: { maxMinutes: 0.02 } });
    await until(() => queued.steps.some((s) => s.title === "Work"));
    await new Promise((r) => setTimeout(r, 2_000));
    assert.equal(queued.status, "running", "still waiting, not stopped at its time limit");
    release();
    await idle(manager, busy);
    await idle(manager, queued);
    assert.equal(queued.status, "done", queued.error);
    assert.match(JSON.stringify(await manager.events(queued.id)), /Waiting for a free agent slot/);
  });
  const slow = holding();
  await withStub(["claude"], slow.stub, async () => {
    const run = await idle(manager, await manager.start({ pattern: oneTurn, task: "HOLD past the limit", repo, roles: { agent: ["claude"] }, options: {}, loop: { maxMinutes: 0.02 } }));
    assert.equal(run.status, "stopped");
    assert.match(run.stopReason!, /time limit/);
  });
});

// ---------------------------------------------------------------- archive and pull requests while busy
test("archiving and opening a pull request are refused while a turn works on the run", async () => {
  const manager = new RunManager(withOneTurn);
  const { stub, release } = holding();
  await withStub(["claude"], stub, async () => {
    const run = await manager.start({ pattern: oneTurn, task: "HOLD while you click", repo, roles: { agent: ["claude"] }, options: {} });
    await until(() => run.worktrees.length > 0 && run.steps.some((s) => s.title === "Work" && s.status === "running"));
    const branch = run.worktrees[0]!.branch;
    await assert.rejects(manager.pullRequest(run.id, { branch, into: "main" }), /Wait for the run to finish before opening a pull request/);
    await assert.rejects(manager.archive(run.id, { cleanup: true }), /Stop the run before archiving it/);
    assert.ok(existsSync(run.worktrees[0]!.path), "its worktree is still there");
    release();
    await idle(manager, run);
    assert.equal(run.status, "done", run.error);
  });
});

// ---------------------------------------------------------------- archive cleans up the run's folder
test("archive removes the run's folder once its worktrees are gone, keeps staged context while branches are kept, and deletes the PR head it fetched", async () => {
  const manager = new RunManager(withOneTurn);
  const attachments = [{ name: "notes.txt", data: Buffer.from("context\n").toString("base64") }];
  const start = (extra: Record<string, unknown> = {}) => manager.start({ pattern: oneTurn, task: "Tidy", repo, roles: { agent: ["claude"] }, options: {}, ...extra });
  const registered = () => sh(repo, "worktree", "list", "--porcelain");

  // Branches kept: a scratch checkout left behind goes, the staged context stays for a resume or a reply.
  const kept = await idle(manager, await start({ context: { attachments } }));
  assert.equal(kept.status, "done", kept.error);
  sh(repo, "worktree", "add", "-q", "--detach", join(kept.worktreeDir, ".repro-check"), kept.baseRef);
  await manager.archive(kept.id, { cleanup: true });
  assert.deepEqual(readdirSync(kept.worktreeDir), [".context"]);
  assert.ok(!registered().includes(".repro-check"), "unregistered from git, not just deleted");
  await manager.followUp(kept.id, { kind: "reply", worktree: "work", agent: "claude", message: "Go on" });
  await idle(manager, kept);
  assert.equal(kept.followUps.at(-1)!.status, "done", kept.followUps.at(-1)!.result);
  assert.ok(existsSync(join(kept.worktrees[0]!.path, ".codeflow-context", "attachments", "notes.txt")), "the context came back with the worktree");

  // Nothing staged, or the branches deleted too: the folder goes.
  const plain = await idle(manager, await start());
  await manager.archive(plain.id, { cleanup: true });
  assert.ok(!existsSync(plain.worktreeDir));
  await manager.archive(kept.id, { cleanup: true, deleteBranches: true });
  assert.ok(!existsSync(kept.worktreeDir));

  // The pull request's head, fetched as codeflow-pr/<n>: deleted with the last run that started from it.
  sh(repo, "branch", "codeflow-pr/7", "main");
  const fromPr = async () => {
    const r = await idle(manager, await start({ baseRef: "codeflow-pr/7" }));
    r.source = { kind: "pr", number: 7, url: "https://github.com/o/r/pull/7", title: "PR", body: "" };
    return r;
  };
  const a = await fromPr();
  const b = await fromPr();
  await manager.archive(a.id, { cleanup: true });
  assert.ok(sh(repo, "branch", "--list", "codeflow-pr/7"), "another run still started from it");
  await manager.archive(b.id, { cleanup: true });
  assert.equal(sh(repo, "branch", "--list", "codeflow-pr/7"), "");
  assert.match(await logs(manager, b), /deleted codeflow-pr\/7 \(fetched for the run\)/);
  assert.ok(sh(repo, "branch", "--list", b.worktrees[0]!.branch), "its result branch is kept");
});
