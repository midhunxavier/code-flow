import { test } from "node:test";
import assert from "node:assert/strict";
import { afterRunCursor, compareRuns, decodeRunCursor, encodeRunCursor, historyOffset, RunIndex } from "../src/run-history.js";
import type { RunSummary } from "../src/engine.js";

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

test("indexed history preserves order through updates, searches full text and finds cursor boundaries", () => {
  const index = new RunIndex();
  const make = (id: string, createdAt: number, task: string) => ({ id, createdAt, task, repo: "/repo", worktrees: [{ path: `/work/${id}` }], pattern: "solo" }) as RunSummary;
  index.set(make("a", 10, "a")); index.set(make("z", 10, "z")); index.set(make("b", 9, "b"));
  const ordered = index.values(); index.set(make("a", 10, "updated full search"));
  assert.equal(index.values(), ordered, "an ordinary status update does not sort the whole index again");
  assert.equal(index.matches("a", ["full", "search"]), true);
  assert.deepEqual(index.related("/work/a").map((run) => run.id), ["a"]);
  assert.equal(historyOffset(ordered, { at: 10, id: "z" }), 1);
  assert.equal(historyOffset(ordered, undefined, 10), 2);
  assert.equal(historyOffset(ordered, { at: 10, id: "a" }, 9), 3);
  index.delete("a"); assert.equal(index.related("/work/a").length, 0);
  assert.deepEqual(index.values().map((run) => run.id), ["z", "b"]);
});

test("malformed history cursors fail without broadening a query", () => {
  for (const value of ["%", "!", "", "a".repeat(1001), Buffer.from('{"at":-1,"id":"a"}').toString("base64url"), Buffer.from('{"at":1}').toString("base64url")]) assert.throws(() => decodeRunCursor(value), /Invalid history cursor/);
});
