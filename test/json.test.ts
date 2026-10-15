import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson } from "../src/json.js";

test("takes the last fenced json block", () => {
  const text = 'first\n```json\n{"a":1}\n```\nthen\n```json\n{"verdict":"approve"}\n```';
  assert.deepEqual(extractJson(text), { verdict: "approve" });
});

test("falls back to the last balanced object, ignoring braces in strings", () => {
  const text = 'Here you go: {"winner": "A", "reasons": "uses } and { safely"} — thanks';
  assert.deepEqual(extractJson(text), { winner: "A", reasons: "uses } and { safely" });
});

test("skips an invalid fence and uses an earlier valid one", () => {
  const text = '```json\n{"ok":true}\n```\n```json\n{not json}\n```';
  assert.deepEqual(extractJson(text), { ok: true });
});

test("returns undefined when nothing parses", () => {
  assert.equal(extractJson("no json here"), undefined);
});
