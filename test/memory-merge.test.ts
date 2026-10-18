import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDraft, mergeMemoryDraft, resolveMemoryMerge, type MemoryDraft } from "../ui/memory-merge.js";

const original = (): MemoryDraft => ({ title: "Build convention", body: "Run npm test", paths: ["src"], applicability: { kind: "repository" } });

test("memory merge incorporates independent remote edits and preserves local edits", () => {
  const base = original();
  const draft = { ...base, body: "Run npm test and inspect output" };
  const latest = { ...base, title: "Testing convention", paths: ["src", "test"] };
  const merged = mergeMemoryDraft(base, draft, latest);
  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(merged.draft, { ...latest, body: draft.body });
  merged.draft.paths.push("new");
  assert.deepEqual(latest.paths, ["src", "test"], "the latest snapshot remains untouched");
});

test("memory merge requires explicit resolution for conflicting fields", () => {
  const base = original();
  const draft = { ...base, title: "My title", body: "My command" };
  const latest = { ...base, title: "Their title", body: "Their command" };
  assert.deepEqual(mergeMemoryDraft(base, draft, latest).conflicts, ["title", "body"]);
  assert.throws(() => resolveMemoryMerge(base, draft, latest, { title: "draft" }), /Choose which body/);
  assert.deepEqual(resolveMemoryMerge(base, draft, latest, { title: "draft", body: "latest" }), { ...base, title: "My title", body: "Their command" });
});

test("matching concurrent edits need no conflict and branch scope is merged atomically", () => {
  const base = original();
  const draft: MemoryDraft = { ...base, body: "Same command", applicability: { kind: "branch", branch: "mine" } };
  const latest: MemoryDraft = { ...base, body: "Same command", applicability: { kind: "branch", branch: "theirs", commit: "abc123" } };
  const merged = mergeMemoryDraft(base, draft, latest);
  assert.deepEqual(merged.conflicts, ["applicability"]);
  assert.deepEqual(resolveMemoryMerge(base, draft, latest, { applicability: "latest" }).applicability, latest.applicability);
  assert.deepEqual(memoryDraft(latest), latest);
});
