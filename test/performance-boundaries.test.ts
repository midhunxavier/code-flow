import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { WorkQueue } from "../src/work-queue.js";
import { createSseWriter, streamHealth } from "../src/sse-writer.js";
import { TranscriptCache } from "../ui/transcript-cache.js";
import type { RunEvent } from "../src/engine.js";
import { PersistenceTracker } from "../src/persistence-status.js";
import { pollVisible } from "../ui/polling.js";

const gate = () => { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; };
test("disk queues preserve run ordering while unrelated runs progress and failures recover", async () => {
  const queue = new WorkQueue(2), blocked = gate(), order: string[] = [];
  const first = queue.run("a", async () => { order.push("a1"); await blocked.promise; throw new Error("disk failed"); });
  const rejection = assert.rejects(first, /disk failed/);
  const second = queue.run("a", async () => { order.push("a2"); });
  await queue.run("b", async () => { order.push("b"); });
  await queue.flush("b"); assert.deepEqual(order, ["a1", "b"]);
  blocked.release(); await Promise.all([rejection, second]); await queue.flush();
  assert.deepEqual(order, ["a1", "b", "a2"]); assert.equal(queue.stats.pending, 0);
});
test("disk concurrency is capped even when many keys become ready together", async () => {
  const queue = new WorkQueue(3), blocked = gate(); let active = 0, peak = 0;
  const jobs = Array.from({ length: 30 }, (_, i) => queue.run(String(i), async () => { peak = Math.max(peak, ++active); await blocked.promise; active--; }));
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(peak, 3);
  blocked.release(); await Promise.all(jobs); assert.equal(peak, 3);
});

class SlowResponse extends EventEmitter {
  destroyed = false; writableEnded = false; writableLength = 0; blocked = true; output: string[] = [];
  write(chunk: string) { this.output.push(chunk); this.writableLength += Buffer.byteLength(chunk); return !this.blocked; }
  destroy() { this.destroyed = true; this.emit("close"); return this; }
  drain() { this.writableLength = 0; this.blocked = false; this.emit("drain"); }
}
test("SSE waits for drain in order and releases buffers when a client closes", () => {
  const response = new SlowResponse(), baseline = streamHealth.queuedBytes;
  const writer = createSseWriter(response as unknown as ServerResponse, { maxBytes: 100 });
  writer.write("one"); writer.write("two"); writer.write("three");
  assert.deepEqual(response.output, ["one"]); assert.equal(streamHealth.queuedBytes, baseline + 8);
  response.drain(); assert.deepEqual(response.output, ["one", "two", "three"]);
  response.destroy(); assert.equal(streamHealth.queuedBytes, baseline);
});
test("SSE disconnects on byte budget before the stall timeout, including oversized single frames", () => {
  const response = new SlowResponse(), baseline = streamHealth.queuedBytes;
  const writer = createSseWriter(response as unknown as ServerResponse, { maxBytes: 10 });
  writer.write("12345"); writer.write("67890"); writer.write("x");
  assert.equal(response.destroyed, true); assert.equal(streamHealth.queuedBytes, baseline);
  writer.write("late"); assert.deepEqual(response.output, ["12345"]);
  const huge = new SlowResponse(); createSseWriter(huge as unknown as ServerResponse, { maxBytes: 10 }).write("x".repeat(11));
  assert.equal(huge.destroyed, true); assert.equal(huge.output.length, 0);
});
test("browser transcript memory stays bounded across a long stream", () => {
  const cache = new TranscriptCache(20_000, 100);
  for (let seq = 1; seq < 10_000; seq++) {
    cache.add({ type: "agent", runId: "r", stepId: "s", seq, ts: seq, event: { kind: "text", text: "x".repeat(100) } } as RunEvent);
    assert.ok(cache.bytes <= cache.maxBytes); assert.ok(cache.records.size <= cache.maxEvents);
  }
  assert.ok(cache.records.has(9999)); cache.deleteStep("s"); assert.equal(cache.bytes, 0);
});

test("durability status cannot report an older save over a newer pending write or failure", async () => {
  const tracker = new PersistenceTracker(), older = gate(), newer = gate();
  tracker.track("run", 1, older.promise); tracker.track("run", 2, newer.promise);
  older.release(); await older.promise; assert.equal(tracker.get("run").state, "saving");
  newer.release(); await newer.promise; assert.deepEqual(tracker.get("run"), { state: "saved", seq: 2 });
  tracker.track("run", 3, Promise.reject(new Error("disk full"))); await Promise.resolve();
  assert.equal(tracker.get("run").state, "error"); assert.match(tracker.get("run").error!, /disk full/);
});

test("polling never overlaps slow work, pauses while hidden and stops on cleanup", async (t) => {
  const document = Object.assign(new EventTarget(), { hidden: false });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const blocked = gate(); let calls = 0;
  const stop = pollVisible(async () => { calls++; await blocked.promise; }, 100);
  try {
    assert.equal(calls, 1); t.mock.timers.tick(1000); assert.equal(calls, 1);
    document.hidden = true; document.dispatchEvent(new Event("visibilitychange"));
    blocked.release(); await blocked.promise; await Promise.resolve();
    t.mock.timers.tick(1000); assert.equal(calls, 1);
    document.hidden = false; document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(calls, 2); await Promise.resolve(); await Promise.resolve();
    t.mock.timers.tick(100); assert.equal(calls, 3);
    stop(); await Promise.resolve(); t.mock.timers.tick(1000); assert.equal(calls, 3);
    document.dispatchEvent(new Event("visibilitychange")); assert.equal(calls, 3);
  } finally {
    stop(); t.mock.timers.reset();
    if (previous) Object.defineProperty(globalThis, "document", previous); else Reflect.deleteProperty(globalThis, "document");
  }
});
