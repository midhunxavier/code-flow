// Run logs on disk: snapshots after the first are written as patches (src/run-log.ts), read back as
// the snapshots they were, with full ones at each run's end and now and then; logs from before
// that are compacted once loaded, and still read the same. Agents are the fake CLIs.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-runlog-home-"));

const { RunLogWriter, decodeRunLog, compactRunLog } = await import("../src/run-log.js");
const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { flushWrites, RUNS_DIR } = await import("../src/store.js");
type RunEvent = import("../src/engine.js").RunEvent;
type Run = import("../src/engine.js").Run;

const BIG = "An issue's text, pasted CI logs, the repository's conventions. ".repeat(300);
const SUMMARY = "The team planned, built and reviewed it; the check passes. ".repeat(10);
let seq = 0;
const snapshot = (run: Record<string, unknown>): RunEvent => ({ seq: ++seq, ts: seq, runId: "r1", type: "run", run: { id: "r1", ...run } }) as unknown as RunEvent;
const lines = (events: RunEvent[], writer = new RunLogWriter()) => events.map((e) => JSON.parse(JSON.stringify(writer.encode(e))));

test("snapshots written as patches read back exactly as they were: fields set, removed, added, strings and lists changed at the end", () => {
  const followUp = (id: string, status: string) => ({ id, message: `reply ${id}`, status, ...(status === "done" ? { result: "Done." } : {}) });
  const events = [
    snapshot({ status: "running", task: "Fix it", body: BIG, summary: undefined, followUps: [], usage: { agentSteps: 0 } }),
    snapshot({ status: "running", task: "Fix it", body: BIG, followUps: [], usage: { agentSteps: 1 }, error: "transient" }),
    snapshot({ status: "running", task: "Fix it", body: BIG, followUps: [followUp("f1", "done")], usage: { agentSteps: 2 }, summary: `${SUMMARY}\n\n## Follow-ups\n- f1` }),
    snapshot({ status: "running", task: "Fix it", body: BIG, followUps: [followUp("f1", "done"), followUp("f2", "pending")], usage: { agentSteps: 3 }, summary: `${SUMMARY}\n\n## Follow-ups\n- f1\n- f2 😀 done` }),
    // A string that changes between an emoji's two halves, and a list that loses its last item.
    snapshot({ status: "running", task: "Fix it", body: BIG, followUps: [followUp("f1", "done")], usage: { agentSteps: 3 }, summary: `${SUMMARY}\n\n## Follow-ups\n- f1\n- f2 😁 done` }),
  ];
  const written = lines(events);
  assert.equal(written[0].type, "run");
  assert.ok(written.slice(1).every((l) => l.type === "run-patch"), "every later snapshot is a patch");
  assert.ok(written.slice(1).every((l) => !JSON.stringify(l).includes(BIG.slice(0, 200))), "the big field isn't written again");
  assert.deepEqual(written[1].unset, undefined);
  assert.deepEqual(written[2].unset, ["error"]);
  assert.deepEqual(written[3].tail?.followUps, [1, [followUp("f2", "pending")]], "a list with an item added: just the item");
  assert.equal(written[3].tail?.summary?.[1], "\n- f2 😀 done", "a string with a line added: just the line");
  assert.deepEqual(written[4].tail?.followUps, [1, []]);
  assert.deepEqual(decodeRunLog(written), JSON.parse(JSON.stringify(events)));
});

test("full snapshots: the first, at the end of each time the run runs, and after many patches or once they add up", () => {
  const writer = new RunLogWriter();
  const kinds = (events: RunEvent[]) => events.map((e) => (writer.encode(e) as { type: string }).type);
  assert.deepEqual(kinds([snapshot({ status: "running", body: BIG, n: 0 }), snapshot({ status: "running", body: BIG, n: 1 }), snapshot({ status: "done", body: BIG, n: 2 }), snapshot({ status: "done", body: BIG, seen: true })]), ["run", "run-patch", "run", "run-patch"]);
  assert.deepEqual(kinds([snapshot({ status: "running", body: BIG, n: 3 }), snapshot({ status: "done", body: BIG, n: 4 })]), ["run-patch", "run"], "a follow-up's run: a patch to start, a full one at its end");
  const many = Array.from({ length: 101 }, (_, i) => snapshot({ status: "done", body: BIG, n: i, seen: true }));
  assert.deepEqual(kinds(many).slice(-2), ["run-patch", "run"], "a full one after 100 patches in a row");
  // Patches as big as the snapshot itself: a full one instead.
  const grow = new RunLogWriter();
  const big = [snapshot({ status: "done", log: "a" }), snapshot({ status: "done", log: "x".repeat(400) }), snapshot({ status: "done", log: "y".repeat(400) })];
  assert.deepEqual(big.map((e) => (grow.encode(e) as { type: string }).type), ["run", "run-patch", "run"]);
});

test("a patch whose snapshot was lost is skipped until the next full one; other lines pass through", () => {
  const writer = new RunLogWriter();
  const [first, second, third] = [snapshot({ status: "running", a: 1 }), snapshot({ status: "running", a: 2 }), snapshot({ status: "done", a: 3 })];
  const log = { seq: 99, ts: 99, runId: "r1", type: "log", level: "info", text: "hi" };
  const written = [writer.encode(first), writer.encode(second), log, writer.encode(third)];
  const decoded = decodeRunLog(written.slice(1));
  assert.deepEqual(decoded.map((e) => e.seq), [99, third.seq]);
});

test("compacting an old log: the same events in fewer bytes, its last snapshot a full one for an older code-flow", () => {
  const events = [snapshot({ status: "running", body: BIG, n: 0 }), snapshot({ status: "running", body: BIG, n: 1 }), snapshot({ status: "running", body: BIG, n: 2 }), snapshot({ status: "done", body: BIG, n: 3, seen: false }), snapshot({ status: "done", body: BIG, n: 3, seen: true })];
  const compacted = compactRunLog(events);
  assert.deepEqual(compacted.map((l) => l.type), ["run", "run-patch", "run-patch", "run-patch", "run"], "only the first and the last whole");
  assert.deepEqual(decodeRunLog(JSON.parse(JSON.stringify(compacted))), JSON.parse(JSON.stringify(events)));
  assert.ok(JSON.stringify(compacted).length < JSON.stringify(events).length * 0.7);
});

// ---------------------------------------------------------------- the engine
let repo: string;
before(() => {
  repo = mkdtempSync(join(tmpdir(), "codeflow-runlog-repo-"));
  const sh = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  sh("init", "-q", "-b", "main");
  writeFileSync(join(repo, "AGENTS.md"), `# Conventions\n${"Keep functions small. ".repeat(250)}\n`);
  sh("add", ".");
  sh("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
});

function idle(manager: InstanceType<typeof RunManager>, run: Run): Promise<Run> {
  return new Promise((resolve) => {
    const check = () => run.status !== "running" && resolve(run);
    manager.subscribe(run.id, check);
    check();
  });
}
const rawLines = (id: string) => readFileSync(join(RUNS_DIR, `${id}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("a run's log holds patches; its events and a reload see whole snapshots", async () => {
  const manager = new RunManager(findPattern);
  const run = await manager.start({ pattern: findPattern("pipeline")!, task: "Patch my log", repo, roles: { planner: ["claude"], builder: ["claude"], reviewer: ["codex"] }, options: {} });
  await idle(manager, run);
  await manager.followUp(run.id, { kind: "reply", worktree: "build", agent: "claude", message: "One more thing" });
  await idle(manager, run);
  manager.setSeen(run.id, true);
  await flushWrites();
  const raw = rawLines(run.id);
  assert.ok(raw.some((l) => l.type === "run-patch"), "patches on disk");
  assert.ok(raw.filter((l) => l.type === "run").length < raw.filter((l) => l.type === "run-patch").length, "fewer full snapshots than patches");
  const events = await manager.events(run.id);
  assert.ok(events.every((e) => (e.type as string) !== "run-patch"));
  const last = events.filter((e) => e.type === "run").at(-1);
  assert.deepEqual(last?.type === "run" && last.run, JSON.parse(JSON.stringify(manager.list().find((r) => r.id === run.id))), "the last snapshot is the run as it is");

  const reloaded = new RunManager(findPattern);
  await reloaded.load();
  assert.deepEqual(JSON.parse(JSON.stringify(reloaded.list().find((r) => r.id === run.id))), JSON.parse(JSON.stringify(manager.list().find((r) => r.id === run.id))));
});

test("loading compacts a log from before patches: smaller, and it reads back the same; one with little to gain is left alone", async () => {
  const manager = new RunManager(findPattern);
  const run = await manager.start({ pattern: findPattern("pipeline")!, task: `Compact me\n\n${BIG}`, repo, roles: { planner: ["claude"], builder: ["claude"], reviewer: ["codex"] }, options: {} });
  await idle(manager, run);
  for (const message of ["Also this", "And that"]) {
    await manager.followUp(run.id, { kind: "reply", worktree: "build", agent: "claude", message });
    await idle(manager, run);
  }
  const events = await manager.events(run.id);
  // The log as an older code-flow wrote it: every snapshot whole. And a small one.
  const file = join(RUNS_DIR, `${run.id}.jsonl`);
  writeFileSync(file, events.map((e) => `${JSON.stringify(e)}\n`).join(""));
  const was = statSync(file).size;
  const finished = events.filter((e) => e.type === "run").at(-1)!;
  const small = [finished, finished].map((e, i) => ({ ...e, runId: "small-1", seq: 100_000 + i, ...(e.type === "run" ? { run: { ...e.run, id: "small-1", task: "small" } } : {}) }));
  writeFileSync(join(RUNS_DIR, "small-1.jsonl"), small.map((e) => `${JSON.stringify(e)}\n`).join(""));
  const smallBefore = readFileSync(join(RUNS_DIR, "small-1.jsonl"), "utf8");

  const loaded = new RunManager(findPattern);
  await loaded.load();
  for (let i = 0; i < 100 && statSync(file).size === was; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(statSync(file).size < was * 0.6, `compacted: ${was} → ${statSync(file).size} bytes`);
  assert.deepEqual(await loaded.events(run.id), JSON.parse(JSON.stringify(events)), "the same events");
  const raw = rawLines(run.id);
  const lastRun = raw.filter((l) => l.type === "run" || l.type === "run-patch").at(-1);
  assert.equal(lastRun.type, "run", "an older code-flow reads the run as it is");
  assert.equal(readFileSync(join(RUNS_DIR, "small-1.jsonl"), "utf8"), smallBefore);
});
