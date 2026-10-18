// Live updates without running out of connections: one stream per window carrying every topic it
// watches (src/stream.ts), and what a window is sent to show a run (only its latest snapshots;
// src/run-log.ts). Agents are the fake CLIs.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-stream-home-"));

const { StreamHub, TopicError, cursorSeq } = await import("../src/stream.js");
const { replayEvents } = await import("../src/run-log.js");
const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
type RunEvent = import("../src/engine.js").RunEvent;
type Run = import("../src/engine.js").Run;
type Deliver = import("../src/stream.js").Deliver;

const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------- the hub
function hubWith() {
  const live = new Map<string, Deliver>();
  const stopped: string[] = [];
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  const hub = new StreamHub({
    feed(name, after, deliver) {
      deliver({ type: "hello", name, after });
      live.set(`feed:${name}`, deliver);
      return () => stopped.push(`feed:${name}`);
    },
    async slow(name, _after, deliver) {
      await slow;
      deliver({ type: "hello" });
      return () => stopped.push(`slow:${name}`);
    },
    gone(name) {
      throw new TopicError(404, `${name} is gone`);
    },
  });
  const sent: any[] = [];
  const client = hub.open((m) => sent.push(m), [{ id: 1, topic: "feed:a", after: "e:3" }]);
  return { hub, client, sent, live, stopped, release };
}

test("a stream says hello with its id, then sends each topic's events tagged with the subscription", async () => {
  const { hub, client, sent, live } = hubWith();
  await tick();
  assert.deepEqual(sent.slice(0, 2), [
    { s: 0, d: { type: "hello", client } },
    { s: 1, d: { type: "hello", name: "a", after: "e:3" } },
  ]);
  live.get("feed:a")!({ n: 1 });
  assert.deepEqual(sent.at(-1), { s: 1, d: { n: 1 } });
  assert.deepEqual(hub.stats, { streams: 1, subscriptions: 1 });
});

test("subscribing and unsubscribing while the stream is open; a dropped topic stops and sends nothing more", async () => {
  const { hub, client, sent, live, stopped } = hubWith();
  assert.equal(hub.update(client, { subscribe: [{ id: 2, topic: "feed:b" }] }), true);
  await tick();
  assert.deepEqual(sent.at(-1), { s: 2, d: { type: "hello", name: "b", after: undefined } });
  const deliverA = live.get("feed:a")!;
  hub.update(client, { unsubscribe: [1] });
  assert.deepEqual(stopped, ["feed:a"]);
  const before = sent.length;
  deliverA({ late: true });
  assert.equal(sent.length, before, "nothing for a subscription that's gone");
  // The same id again is a no-op while it's subscribed; ids aren't reused by windows anyway.
  hub.update(client, { subscribe: [{ id: 2, topic: "feed:c" }] });
  await tick();
  assert.equal(sent.length, before);
  assert.equal(hub.update("no-such-stream", { subscribe: [] }), false);
});

test("a topic that can't be watched says why and is dropped; so does one that isn't a topic", async () => {
  const { hub, client, sent } = hubWith();
  hub.update(client, { subscribe: [{ id: 5, topic: "gone:x" }, { id: 6, topic: "nothing:y" }, { id: 7, topic: "constructor" }, { id: 0, topic: "feed:z" }, { id: 8, topic: "feed:z", after: 3 }] });
  await tick();
  assert.deepEqual(sent.find((m) => m.s === 5), { s: 5, d: { type: "error", status: 404, message: "x is gone" } });
  assert.equal(sent.find((m) => m.s === 6)?.d.status, 404);
  assert.equal(sent.find((m) => m.s === 7)?.d.status, 404, "not a property of the sources object");
  assert.equal(sent.find((m) => m.s === 8)?.d.status, 400);
  assert.equal(sent.some((m) => m.s === 0 && m.d.type !== "hello"), false, "id 0 is the stream's own");
  assert.deepEqual(hub.stats, { streams: 1, subscriptions: 1 });
});

test("unsubscribed while it was still starting: it's stopped once it has started; closing the stream stops everything", async () => {
  const { hub, client, sent, stopped, release } = hubWith();
  hub.update(client, { subscribe: [{ id: 3, topic: "slow:s" }] });
  hub.update(client, { unsubscribe: [3] });
  release();
  await tick();
  await tick();
  assert.deepEqual(stopped, ["slow:s"]);
  assert.equal(sent.some((m) => m.s === 3), false);
  hub.close(client);
  assert.deepEqual(stopped, ["slow:s", "feed:a"]);
  assert.deepEqual(hub.stats, { streams: 0, subscriptions: 0 });
  assert.equal(hub.update(client, { subscribe: [] }), false);
});

test("a cursor counts only in the server start it came from", () => {
  assert.equal(cursorSeq("abc:12", "abc"), 12);
  assert.equal(cursorSeq("abc:0", "abc"), 0);
  assert.equal(cursorSeq("old:12", "abc"), undefined);
  assert.equal(cursorSeq("abc:", "abc"), undefined);
  assert.equal(cursorSeq("abc", "abc"), undefined);
  assert.equal(cursorSeq("abc:1.5", "abc"), undefined);
  assert.equal(cursorSeq(undefined, "abc"), undefined);
});

// ---------------------------------------------------------------- what a window is sent
test("replaying a run keeps every agent event and log line but only the latest snapshot of the run and of each step, in order", () => {
  const run = (seq: number, status: string) => ({ seq, ts: seq, runId: "r", type: "run", run: { id: "r", status } }) as unknown as RunEvent;
  const step = (seq: number, id: string, status: string) => ({ seq, ts: seq, runId: "r", type: "step", step: { id, status } }) as unknown as RunEvent;
  const agent = (seq: number, stepId: string) => ({ seq, ts: seq, runId: "r", type: "agent", stepId, event: { kind: "text", text: `t${seq}` } }) as unknown as RunEvent;
  const log = (seq: number) => ({ seq, ts: seq, runId: "r", type: "log", level: "info", text: `l${seq}` }) as unknown as RunEvent;
  const events = [run(1, "running"), step(2, "a", "running"), agent(3, "a"), run(4, "running"), log(5), step(6, "a", "done"), step(7, "b", "running"), agent(8, "b"), run(9, "done"), step(10, "b", "done")];
  assert.deepEqual(
    replayEvents(events).map((e) => e.seq),
    [3, 5, 6, 8, 9, 10],
  );
  assert.deepEqual(replayEvents([]), []);
});

let repo: string;
before(() => {
  repo = mkdtempSync(join(tmpdir(), "codeflow-stream-repo-"));
  const sh = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  sh("init", "-q", "-b", "main");
  // Conventions go in every snapshot of a run, as an issue's text or CI logs do.
  writeFileSync(join(repo, "AGENTS.md"), `# Conventions\n${"Write small, well-named functions. ".repeat(170)}\n`);
  writeFileSync(join(repo, "README.md"), "hi\n");
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

test("replaying a big run sends far fewer bytes than its whole history", async () => {
  const manager = new RunManager(findPattern);
  // A long task (a pasted stack trace, say): in every snapshot too.
  const task = `Fix the crash.\n\n${"at Object.<anonymous> (/app/src/index.js:12:5)\n".repeat(400)}`;
  const run = await manager.start({ pattern: findPattern("pipeline")!, task, repo, roles: { planner: ["claude"], builder: ["claude"], reviewer: ["codex"] }, options: {} });
  await idle(manager, run);
  // A conversation after it: every reply changes the run a few more times.
  for (const message of ["Also add a README section", "And a test for it"]) {
    await manager.followUp(run.id, { kind: "reply", worktree: "build", agent: "claude", message });
    await idle(manager, run);
  }
  const history = await manager.events(run.id);
  const replay = replayEvents(history);
  const bytes = (events: RunEvent[]) => events.reduce((n, e) => n + JSON.stringify(e).length, 0);
  const snapshots = history.filter((e) => e.type === "run").length;
  assert.ok(snapshots >= 8, `the run changed often: ${snapshots} snapshots`);
  assert.equal(replay.filter((e) => e.type === "run").length, 1);
  assert.deepEqual(replay.find((e) => e.type === "run"), history.filter((e) => e.type === "run").at(-1), "the latest snapshot");
  assert.equal(replay.filter((e) => e.type === "agent").length, history.filter((e) => e.type === "agent").length, "every agent event");
  assert.ok(bytes(replay) * 4 < bytes(history), `replay ${bytes(replay)} bytes, history ${bytes(history)} bytes`);
});
