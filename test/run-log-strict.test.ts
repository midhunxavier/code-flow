import { test } from "node:test";
import assert from "node:assert/strict";
import { StrictRunLogReader } from "../src/run-log.js";

const full = (seq?: number) => ({ type: "run", runId: "r1", ...(seq === undefined ? {} : { seq }), run: { id: "r1", status: "done", summary: "Review", merges: [{ commit: "receipt" }] } });
const patch = (changes: Record<string, unknown> = {}) => ({ type: "run-patch", runId: "r1", seq: 2, base: 1, ...changes });

test("strict run logs decode valid list/string tails and legacy full snapshots without sequence or envelope identity", () => {
  const reader = new StrictRunLogReader("r1"); reader.decode(full(1));
  const event = reader.decode(patch({ tail: { summary: [6, "ed"], merges: [1, [{ commit: "next" }]] }, set: { archived: true } }));
  assert.equal(event?.type, "run"); if (event?.type !== "run") throw new Error("Expected reconstructed snapshot");
  assert.equal(event.run.summary, "Reviewed"); assert.deepEqual(event.run.merges, [{ commit: "receipt" }, { commit: "next" }]); assert.equal(event.run.archived, true);
  assert.doesNotThrow(() => new StrictRunLogReader("r1").decode({ type: "run", run: full().run }));
  const legacy = new StrictRunLogReader("r1"); legacy.decode(full()); assert.throws(() => legacy.decode(patch()), /base/);
});

test("invalid patch tails cannot retain an older receipt and only a new full snapshot restores the base", () => {
  for (const tail of [{ merges: [99, []] }, { merges: [-1, []] }, { merges: [0.5, []] }, { merges: [0, "wrong"] }, { summary: [99, "wrong"] }, { summary: [0, []] }, { missing: [0, []] }, { merges: [0, [], "extra"] }]) {
    const reader = new StrictRunLogReader("r1"); reader.decode(full(1)); assert.throws(() => reader.decode(patch({ tail })), /tail/);
    assert.throws(() => reader.decode(patch({ seq: 3, base: 1, set: { archived: true } })), /base/);
    reader.decode(full(4)); assert.doesNotThrow(() => reader.decode(patch({ seq: 5, base: 4, unset: ["summary"] })));
  }
});

test("strict patches reject identity changes, overlapping fields, malformed shapes and inconsistent sequence/base", () => {
  for (const invalid of [
    { set: [] }, { tail: [] }, { unset: "merges" }, { unset: ["merges", "merges"] }, { unset: ["id"] }, { set: { id: "other" } },
    { set: { archived: true }, unset: ["archived"] }, { set: { merges: [] }, tail: { merges: [0, []] } },
    { set: JSON.parse('{"__proto__":{"archived":true}}') }, { set: { constructor: "bad" } }, { unset: ["prototype"] },
    { seq: 1 }, { seq: 2.5 }, { base: 99 }, { runId: "other" }, { unexpected: true },
  ]) {
    const reader = new StrictRunLogReader("r1"); reader.decode(full(1)); assert.throws(() => reader.decode(patch(invalid)));
  }
  assert.throws(() => new StrictRunLogReader("r1").decode({ ...full(1), runId: "other" }), /mismatched/);
  assert.throws(() => new StrictRunLogReader("r1").decode({ ...full(1), run: { id: "other" } }), /mismatched/);
});
