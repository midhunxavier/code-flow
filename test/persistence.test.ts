import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-persist-home-"));

const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { flushWrites, RUNS_DIR } = await import("../src/store.js");
type Run = import("../src/engine.js").Run;
type Manager = InstanceType<typeof RunManager>;

let repo: string;
const pipelineRoles = { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] } as Record<string, any>;

before(() => {
  repo = mkdtempSync(join(tmpdir(), "codeflow-persist-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q");
  writeFileSync(join(repo, "README.md"), "persist\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
});

const start = (m: Manager, pattern: string, roles: Record<string, any>, extra: Record<string, unknown> = {}) =>
  m.start({ pattern: findPattern(pattern)!, task: "Persist me", repo, roles, options: {}, ...extra });

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
    await new Promise((r) => setTimeout(r, 25));
  }
}

const agentSteps = (run: Run) => run.steps.filter((s) => s.kind === "agent").map((s) => `${s.title}:${s.status}`);

test("runs are rebuilt from disk by a new process", async () => {
  const a = new RunManager(findPattern);
  const run = await start(a, "pipeline", pipelineRoles);
  await finished(a, run);
  await flushWrites();

  const b = new RunManager(findPattern);
  await b.load();
  const loaded = b.get(run.id)!;
  assert.equal(loaded.status, "done");
  assert.equal(loaded.seen, false, "a finished run needs you until you look at it");
  assert.deepEqual(agentSteps(loaded), agentSteps(run));
  assert.deepEqual(loaded.artifacts.map((x) => x.branch), run.artifacts.map((x) => x.branch));
  assert.ok((await b.events(run.id)).length > 10, "history is served from the log");
});

test("shutdown interrupts a run; a new process resumes it without redoing finished steps", async () => {
  process.env.FAKE_SLEEP_VENDOR = "codex";
  process.env.FAKE_SLEEP_MS = "5000";
  const a = new RunManager(findPattern);
  const run = await start(a, "pipeline", pipelineRoles);
  await until(() => run.steps.some((s) => s.title === "Implement plan" && s.status === "running"));
  await a.shutdown();
  delete process.env.FAKE_SLEEP_VENDOR;
  delete process.env.FAKE_SLEEP_MS;
  assert.equal(run.status, "interrupted");

  const b = new RunManager(findPattern);
  await b.load();
  const loaded = b.get(run.id)!;
  assert.equal(loaded.status, "interrupted");
  await b.resume(run.id);
  await finished(b, loaded);
  assert.equal(loaded.status, "done", loaded.error);
  assert.equal(loaded.resumes, 1);
  assert.deepEqual(agentSteps(loaded), [
    "Plan:done", // replayed from the journal, not run again
    "Implement plan:interrupted",
    "Implement plan:done",
    "Review (round 1):done",
  ]);
});

test("a run that crashed (no clean shutdown) loads as interrupted", async () => {
  process.env.FAKE_SLEEP_VENDOR = "codex";
  process.env.FAKE_SLEEP_MS = "5000";
  const a = new RunManager(findPattern);
  const run = await start(a, "pipeline", pipelineRoles);
  await until(() => run.steps.some((s) => s.title === "Implement plan" && s.status === "running"));
  await flushWrites();

  // A second process sees the run as still "running" in the log, i.e. its server died.
  const b = new RunManager(findPattern);
  await b.load();
  const loaded = b.get(run.id)!;
  assert.equal(loaded.status, "interrupted");
  assert.equal(loaded.steps.find((s) => s.title === "Implement plan")!.status, "interrupted");

  a.cancel(run.id); // tidy up the first "process"
  await finished(a, run);
  delete process.env.FAKE_SLEEP_VENDOR;
  delete process.env.FAKE_SLEEP_MS;
});

test("parallel race steps replay; only the unfinished judge runs again", async () => {
  process.env.FAKE_SLEEP_VENDOR = "agy";
  process.env.FAKE_SLEEP_MS = "5000";
  const a = new RunManager(findPattern);
  const run = await start(a, "race", { contestants: ["claude", "codex"], judge: ["agy"] });
  await until(() => run.steps.some((s) => s.title === "Judge candidates" && s.status === "running"));
  await a.shutdown();
  delete process.env.FAKE_SLEEP_VENDOR;
  delete process.env.FAKE_SLEEP_MS;

  const b = new RunManager(findPattern);
  await b.load();
  const loaded = b.get(run.id)!;
  await b.resume(run.id);
  await finished(b, loaded);
  assert.equal(loaded.status, "done", loaded.error);
  const steps = agentSteps(loaded);
  assert.equal(steps.filter((s) => s.startsWith("Candidate A")).length, 1);
  assert.equal(steps.filter((s) => s.startsWith("Candidate B")).length, 1);
  assert.deepEqual(steps.filter((s) => s.startsWith("Judge")), ["Judge candidates:interrupted", "Judge candidates:done"]);
});

test("a run stopped at its step limit resumes with a fresh budget", async () => {
  const m = new RunManager(findPattern);
  const run = await start(m, "pipeline", pipelineRoles, { loop: { maxSteps: 2 } });
  await finished(m, run);
  assert.equal(run.status, "stopped");
  assert.ok(run.artifacts.some((x) => x.label === "Work so far: build"));

  await m.resume(run.id);
  await finished(m, run);
  assert.equal(run.status, "done", run.error);
  assert.ok(!run.artifacts.some((x) => x.label.startsWith("Work so far")), "replaced by the real result");
  assert.deepEqual(agentSteps(run), ["Plan:done", "Implement plan:done", "Review (round 1):done"]);
});

test("seen and archived flags survive a restart; you can't archive a running run", async () => {
  const a = new RunManager(findPattern);
  const run = await start(a, "pipeline", pipelineRoles);
  assert.throws(() => a.setArchived(run.id, true), /Stop the run/);
  await finished(a, run);
  a.setSeen(run.id);
  a.setArchived(run.id, true);
  await flushWrites();

  const b = new RunManager(findPattern);
  await b.load();
  assert.deepEqual([b.get(run.id)!.seen, b.get(run.id)!.archived], [true, true]);
});

test("logs written before persistence existed still load", async () => {
  mkdirSync(RUNS_DIR, { recursive: true });
  const legacy = [
    { seq: 1, ts: 1, runId: "legacy-1", type: "run", run: { id: "legacy-1", pattern: "pipeline", task: "old", repo, baseRef: "abc", roles: {}, options: {}, status: "running", createdAt: 1, artifacts: [] } },
    { seq: 2, ts: 2, runId: "legacy-1", type: "step", step: { id: "s1", title: "Plan", role: "planner", agent: "claude", mode: "read", status: "running", startedAt: 2 } },
  ];
  writeFileSync(join(RUNS_DIR, "legacy-1.jsonl"), legacy.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const m = new RunManager(findPattern);
  await m.load();
  const run = m.get("legacy-1")!;
  assert.equal(run.status, "interrupted");
  assert.equal(run.steps[0]!.kind, "agent");
  assert.equal(run.steps[0]!.status, "interrupted");
  assert.deepEqual([run.loop.maxSteps, run.usage.agentSteps, run.worktrees.length], [40, 0, 0]);
});
