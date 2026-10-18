import { test } from "node:test";
import assert from "node:assert/strict";
import { Slots } from "../src/slots.js";

test("queued priorities are evaluated at dispatch and equal priorities alternate projects", async () => {
  const slots = new Slots(1);
  const release = await slots.acquire(undefined, { group: "a" });
  const order: string[] = [];
  let priority = -1;
  const a = slots.acquire(undefined, { group: "a" }).then((release) => { order.push("a"); release(); });
  const b = slots.acquire(undefined, { group: "b" }).then((release) => { order.push("b"); release(); });
  const urgent = slots.acquire(undefined, { priority: () => priority, group: "c" }).then((release) => { order.push("urgent"); release(); });
  priority = 10;
  release();
  await Promise.all([a, b, urgent]);
  assert.equal(order[0], "urgent");
  assert.equal(slots.busy, 0);
  const first = await slots.acquire(undefined, { group: "a" });
  const fair: string[] = [];
  const same = slots.acquire(undefined, { group: "a" }).then((release) => { fair.push("a"); release(); });
  const other = slots.acquire(undefined, { group: "b" }).then((release) => { fair.push("b"); release(); });
  first(); await Promise.all([same, other]);
  assert.deepEqual(fair, ["b", "a"]);
});

test("cancelling queued prioritized work does not leak a slot", async () => {
  const slots = new Slots(1);
  const release = await slots.acquire();
  const controller = new AbortController();
  const queued = slots.acquire(controller.signal, { priority: 10, group: "cancelled" });
  controller.abort();
  await assert.rejects(queued, /aborted/);
  release();
  assert.equal(slots.queued, 0);
  assert.equal(slots.busy, 0);
});
