import { test } from "node:test";
import assert from "node:assert/strict";
import { afterRunCursor, compareRuns, decodeRunCursor, encodeRunCursor } from "../src/run-history.js";

test("history cursor visits every run once across identical creation times", () => {
  const runs = [{ id: "z", createdAt: 10 }, { id: "a", createdAt: 10 }, { id: "m", createdAt: 10 }, { id: "older", createdAt: 9 }].sort(compareRuns);
  const visited: string[] = [];
  let remaining = runs;
  while (remaining.length) {
    const page = remaining.slice(0, 2);
    visited.push(...page.map((run) => run.id));
    const cursor = decodeRunCursor(encodeRunCursor(page.at(-1)!));
    remaining = runs.filter((run) => afterRunCursor(run, cursor));
  }
  assert.deepEqual(visited, ["z", "m", "a", "older"]);
  assert.equal(new Set(visited).size, runs.length);
});

test("malformed history cursors fail without broadening a query", () => {
  for (const value of ["%", "!", "", "a".repeat(1001), Buffer.from('{"at":-1,"id":"a"}').toString("base64url"), Buffer.from('{"at":1}').toString("base64url")]) assert.throws(() => decodeRunCursor(value), /Invalid history cursor/);
});
