import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserOwnership } from "../src/browser-ownership.js";
const signal = () => new AbortController().signal;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("manual takeover pauses the queue deadline and remains cancellable", async () => {
  const lease = new BrowserOwnership(100, 30), abort = new AbortController(); let ran = false;
  try {
    await lease.takeover();
    const waiting = lease.agent("a", "Claude", signal(), true, async () => { ran = true; });
    await delay(100); assert.equal(ran, false); assert.equal(lease.state().waiting, 1);
    lease.resume(); await waiting; assert.equal(ran, true);
    await lease.takeover(); const stopped = lease.agent("b", "Codex", abort.signal, true, async () => assert.fail());
    abort.abort(); await assert.rejects(stopped, /ended/);
  } finally { lease.close(); }
});

test("browser waiters resume FIFO after release and re-inspect after each handoff", async () => {
  const lease = new BrowserOwnership(1000, 2000), seen: string[] = [];
  try {
    await lease.agent("a", "Claude", signal(), true, async () => seen.push("a"));
    const b = lease.agent("b", "Codex", signal(), true, async () => seen.push("b"));
    const c = lease.agent("c", "Antigravity", signal(), true, async () => seen.push("c"));
    await delay(10); assert.equal(lease.state().waiting, 2);
    lease.release("a"); await b; assert.deepEqual(seen, ["a", "b"]);
    lease.release("b"); await c; lease.release("c");
    await assert.rejects(lease.agent("a", "Claude", signal(), false, async () => seen.push("stale")), /snapshot/);
    assert.deepEqual(seen, ["a", "b", "c"]);
  } finally { lease.close(); }
});

test("user takeover waits for in-flight work, blocks agents and releases them without losing the session", async () => {
  const lease = new BrowserOwnership(1000, 2000);
  let finish!: () => void, running = false, takeover = false, resumed = false;
  try {
    const action = lease.agent("a", "Claude", signal(), true, async () => { running = true; await new Promise<void>(resolve => { finish = resolve; }); });
    while (!running) await delay(1);
    const taking = lease.takeover().then(() => { takeover = true; });
    const waiting = lease.agent("b", "Codex", signal(), true, async () => { resumed = true; });
    await delay(10); assert.equal(takeover, false); finish(); await action; await taking;
    assert.equal(resumed, false); assert.equal(lease.state().user, true);
    await lease.userAction(async () => {}); assert.equal(lease.state().user, true);
    lease.resume(); await waiting; assert.equal(resumed, true);
  } finally { lease.close(); }
});

test("cancelled waiters leave the queue; idle owners release; ordinary user input does not strand agents", async () => {
  const lease = new BrowserOwnership(20, 1000), abort = new AbortController();
  try {
    await lease.agent("a", "Claude", signal(), true, async () => {});
    const pending = lease.agent("b", "Codex", abort.signal, true, async () => assert.fail());
    abort.abort(); await assert.rejects(pending, /ended/); assert.equal(lease.state().waiting, 0);
    await lease.agent("c", "Antigravity", signal(), true, async () => {});
    await lease.userAction(async () => {}); assert.equal(lease.state().user, false);
    await assert.rejects(lease.agent("c", "Antigravity", signal(), false, async () => assert.fail()), /snapshot/);
  } finally { lease.close(); }
});

test("overlapping human requests release together; explicit takeover stays held", async () => {
  const lease = new BrowserOwnership(1000, 2000);
  let finishA!: () => void, finishB!: () => void, resumed = false;
  try {
    const a = lease.userAction(() => new Promise<void>(resolve => { finishA = resolve; }));
    const b = lease.userAction(() => new Promise<void>(resolve => { finishB = resolve; }));
    await delay(1);
    const waiting = lease.agent("a", "Claude", signal(), true, async () => { resumed = true; });
    finishA(); await a; assert.equal(resumed, false); assert.equal(lease.state().user, true);
    finishB(); await b; await waiting; assert.equal(lease.state().user, false);
    const human = lease.userAction(() => new Promise<void>(resolve => { finishA = resolve; })); await delay(1);
    await lease.takeover(); finishA(); await human; assert.equal(lease.state().user, true);
    lease.resume(); assert.equal(lease.state().user, false);
  } finally { lease.close(); }
});
