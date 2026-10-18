import { test } from "node:test";
import assert from "node:assert/strict";
import { EventPool, withEventPool } from "../src/team-scheduler.js";
import type { TeamContext } from "../src/engine.js";

function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
function context(journal = new Map<string, unknown>()): TeamContext {
  return { signal: new AbortController().signal, remember: async (kind: string, identity: string, fn: () => Promise<unknown>) => {
    const key = `${kind}:${identity}`; if (journal.has(key)) return journal.get(key); const value = await fn(); journal.set(key, value); return value;
  }, parallel: async (items: unknown[], fn: (item: unknown) => Promise<unknown>) => Promise.all(items.map(fn)) } as unknown as TeamContext;
}

test("event scheduling starts a dependent while an unrelated turn is still running", async () => {
  const journal = new Map<string, unknown>(); const slow = deferred<string>(); const trace: string[] = [];
  const result = await withEventPool<string, string[]>(context(journal), 2, async (pool) => {
    pool.submit("slow", async () => { trace.push("slow:start"); const value = await slow.promise; trace.push("slow:end"); return value; });
    pool.submit("fast", async () => { trace.push("fast:end"); return "fast"; });
    assert.deepEqual(await pool.next("1"), ["fast"]);
    pool.submit("dependent", async () => { trace.push("dependent:start"); return "dependent"; });
    assert.deepEqual(await pool.next("2"), ["dependent"]);
    assert.equal(trace.includes("slow:end"), false);
    slow.resolve("slow"); assert.deepEqual(await pool.next("3"), ["slow"]);
    return trace;
  });
  assert.ok(result.indexOf("dependent:start") < result.indexOf("slow:end"));
  assert.deepEqual(journal.get("team-completion:1"), ["fast"]);
});

test("recovery applies recorded completion order even if replay promises resolve in another order", async () => {
  const journal = new Map<string, unknown>([["team-completion:1", ["fast"]], ["team-completion:2", ["slow"]]]);
  const pool = new EventPool<string>(context(journal));
  pool.submit("slow", async () => "slow"); pool.submit("fast", async () => "fast");
  const signal = new AbortController().signal;
  const a = await pool.take(signal); a!.resolve(await a!.work());
  const b = await pool.take(signal); b!.resolve(await b!.work());
  assert.deepEqual(await pool.next("1"), ["fast"]); assert.deepEqual(await pool.next("2"), ["slow"]);
  pool.close(); assert.equal(pool.size, 0);
});

test("mismatched persisted completion IDs fail closed rather than losing a task", async () => {
  const pool = new EventPool<string>(context(new Map([["team-completion:1", ["missing"]]])));
  pool.submit("actual", async () => "actual");
  await assert.rejects(pool.next("1"), /does not match/); pool.close();
});


test("a request deadline wakes the event driver without waiting for an active vendor turn", async () => {
  const journal = new Map<string, unknown>(); const ctx = context(journal); const pool = new EventPool<string>(ctx);
  pool.submit("slow", async () => "slow");
  assert.deepEqual(await pool.next("deadline", Date.now() + 5), []);
  assert.equal(pool.size, 1);
  assert.deepEqual(journal.get("team-completion:deadline"), []);
  const job = await pool.take(ctx.signal); job!.resolve(await job!.work());
  assert.deepEqual(await pool.next("finished"), ["slow"]); pool.close();
});

for (const replay of [false, true]) test(`cancellation releases a ${replay ? "replayed" : "live"} completion wait even when its queued runner never starts`, async () => {
  const journal = new Map<string, unknown>(replay ? [["team-completion:batch", ["queued"]]] : []);
  const controller = new AbortController();
  const ctx = { ...context(journal), signal: controller.signal } as TeamContext;
  const pool = new EventPool<string>(ctx);
  pool.submit("queued", async () => "unused");
  const pending = pool.next("batch");
  // Let replay enter its recorded-outcome wait before cancelling.
  await Promise.resolve(); await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, /scheduler stopped/);
  if (!replay) assert.equal(journal.has("team-completion:batch"), false, "cancelled completion is not committed");
  pool.close();
});
