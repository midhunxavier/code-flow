// A run's log that stops saving (a full disk, a permissions change) is written again once storage
// works: what was held, then a full snapshot, so a finished run doesn't reload interrupted and the
// "not saved" status clears. Its own process and home: it makes the runs folder read-only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "cf-qa-wt-unsaved-home-"));

const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { flushWrites, RUNS_DIR } = await import("../src/store.js");
const { PersistenceTracker } = await import("../src/persistence-status.js");
type Run = import("../src/engine.js").Run;
type Manager = InstanceType<typeof RunManager>;

let repo: string;
before(() => {
  repo = mkdtempSync(join(tmpdir(), "cf-qa-wt-unsaved-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q");
  writeFileSync(join(repo, "README.md"), "unsaved\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
});
// Never leave a read-only folder behind, whatever failed.
after(() => { try { chmodSync(RUNS_DIR, 0o755); } catch { /* gone */ } });

function finished(m: Manager, run: Run): Promise<void> {
  return new Promise((resolve) => {
    const check = () => run.status !== "running" && resolve();
    m.subscribe(run.id, check);
    check();
  });
}

async function until(condition: () => boolean, timeoutMs = 15_000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("a failed save keeps the friendly message, never the raw error with its path", async () => {
  const tracker = new PersistenceTracker();
  tracker.failure("r", 3, "Run changes have not been saved.");
  tracker.track("r", 3, Promise.reject(new Error("EACCES: permission denied, open '/abs/path/runs/r.jsonl'")), "Run changes have not been saved.");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(tracker.get("r"), { state: "error", seq: 3, error: "Run changes have not been saved." });
  tracker.track("r", 4, Promise.resolve());
  await new Promise((r) => setImmediate(r));
  assert.equal(tracker.get("r").state, "saved", "a later save clears it");
});

test("a run whose log stopped saving is written again once storage works, and reloads finished", async () => {
  process.env.FAKE_SLEEP_VENDOR = "claude";
  process.env.FAKE_SLEEP_MS = "1500";
  const m = new RunManager(findPattern);
  let run: Run;
  const file = () => join(RUNS_DIR, `${run.id}.jsonl`);
  try {
    run = await m.start({ pattern: findPattern("solo")!, repo, task: "Persistence test", roles: { agent: ["claude"] }, options: {}, trust: "standard" });
    await until(() => run.steps.some((s) => s.status === "running"));
    await flushWrites();
    // Storage fails mid-run: the run finishes, but nothing of it reaches the disk.
    chmodSync(file(), 0o444);
    chmodSync(RUNS_DIR, 0o555);
    await finished(m, run);
    assert.equal(run.status, "done", run.error);
    await until(() => m.persistence.get(run.id).state === "error");
    const failure = m.persistence.get(run.id).error!;
    assert.match(failure, /have not been saved/);
    assert.ok(!failure.includes(RUNS_DIR) && !/EACCES/.test(failure), "no raw error or private path for the page");
    // Still failing after the first retry: it's tried again, not given up.
    await new Promise((r) => setTimeout(r, 2_500));
    assert.equal(m.persistence.get(run.id).state, "error");
    const before = readFileSync(file(), "utf8");

    chmodSync(RUNS_DIR, 0o755);
    chmodSync(file(), 0o644);
    await until(() => m.persistence.get(run.id).state === "saved", 20_000);
    const lines = readFileSync(file(), "utf8").slice(before.length).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(lines.some((l) => l.type === "step" && l.step.status === "done"), "what happened while it failed was written too");
    const last = lines.at(-1);
    assert.equal(last.type, "run", "a full snapshot, not a patch on one that never reached the disk");
    assert.equal(last.run.status, "done");
    assert.equal(last.run.worktrees.length, 1);
  } finally {
    delete process.env.FAKE_SLEEP_VENDOR;
    delete process.env.FAKE_SLEEP_MS;
    try { chmodSync(RUNS_DIR, 0o755); } catch { /* restored above */ }
  }

  // As after a restart: finished, with its summary and worktree, not "Interrupted".
  await flushWrites();
  const reloaded = new RunManager(findPattern);
  await reloaded.load();
  const loaded = reloaded.get(run.id)!;
  assert.equal(loaded.status, "done");
  assert.equal(loaded.summary, run.summary);
  assert.deepEqual(loaded.worktrees.map((w) => w.name), ["solo"]);
  assert.ok(loaded.steps.every((s) => s.status !== "interrupted"), "its steps reload as they ended");
});
