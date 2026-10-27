import test from "node:test";
import assert from "node:assert/strict";
import { reserveQaPorts } from "./qa-port-block.js";

test("concurrent fixtures hold disjoint complete blocks, including their phone and second-instance ports", async () => {
  const blocks = await Promise.all(Array.from({ length: 12 }, () => reserveQaPorts(4)));
  try {
    const ports = blocks.flatMap(block => Array.from({ length: 4 }, (_, offset) => block.port + offset));
    assert.equal(new Set(ports).size, ports.length);
    assert.ok(ports.every(port => port !== 4317 && port !== 4318));
    for (const port of ports) await assert.rejects(reserveQaPorts(1, String(port)), { code: "EADDRINUSE" });
  } finally { await Promise.all(blocks.map(block => block.release())); }
});

test("partial handoff leaves the next instance reserved, failed block probes clean up, and release is idempotent", async () => {
  const block = await reserveQaPorts(4);
  try {
    await block.release(0, 2);
    await assert.rejects(reserveQaPorts(4, String(block.port)), { code: "EADDRINUSE" });
    const first = await reserveQaPorts(2, String(block.port));
    await first.release();
    await assert.rejects(reserveQaPorts(1, String(block.port + 3)), { code: "EADDRINUSE" });
    await Promise.all([block.release(), block.release()]);
    const reused = await reserveQaPorts(4, String(block.port));
    await reused.release();
  } finally { await block.release(); }
});

test("explicit overrides validate the entire block before touching live ports", async () => {
  for (const port of ["4316", "4317", "4318", "65535", "0", "", "NaN", "4.5", "-1"])
    await assert.rejects(reserveQaPorts(2, port), /outside live ports/);
  for (const count of [0, -1, 1.5, 33]) await assert.rejects(reserveQaPorts(count), /port count/);
  const block = await reserveQaPorts(2);
  try {
    for (const [offset, count] of [[-1, 1], [1, 2], [0.5, 1], [0, -1]])
      await assert.rejects(block.release(offset, count), /within its reserved block/);
  } finally { await block.release(); }
});
