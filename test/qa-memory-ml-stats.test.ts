import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeMemoryManifests, type MemoryEntry } from "../src/memory.js";
import { confidenceInterval, rankAgents } from "../src/stats.js";
import { workflowRecommendations } from "../src/experience.js";
import { ConventionsStore } from "../src/conventions.js";
import { renderVerificationReport } from "../src/verification.js";
Object.assign(globalThis, { window: {}, location: { hash: "#/", search: "" } });
const { completeSentence, plural } = await import("../ui/lib.js");
const ref = (id: string, revision = 1, reason = "matching text") => ({ id, revision, reason });
test("run manifest unions provenance and excludes conflicting omissions in either replay order", () => {
  const planning = { included: [], omitted: [ref("source", 1, "outside task paths"), ref("source", 2)] };
  const worker = { included: [ref("source")], omitted: [] };
  for (const inputs of [[planning, worker], [worker, planning]]) {
    const merged = mergeMemoryManifests(...inputs);
    assert.deepEqual(merged.included, [ref("source")]); assert.deepEqual(merged.omitted, [ref("source", 2)]);
    assert.deepEqual(mergeMemoryManifests(merged, ...inputs), merged);
  }
});
test("Wilson endpoints are exact and all-failing workflows and agents use sample tie-break", () => {
  for (let n = 1; n <= 100; n++) { assert.equal(confidenceInterval(0, n).low, 0); assert.equal(confidenceInterval(n, n).high, 1); }
  const rows = (id: string, count: number, pattern: string) => Array.from({ length: count }, (_, i) => ({ id: id + i, repo: "/repo", pattern, status: "done", verdict: "failing", createdAt: 1, endedAt: 2, roles: {}, artifacts: [], merges: [], usage: { agentSteps: 1, checks: 1, byAgent: { [id]: { steps: 1, failures: 0, writeSteps: 1, ms: 1 } } } } as any));
  const runs = [...rows("claude", 3, "solo"), ...rows("codex", 4, "fix-review")];
  assert.deepEqual(rankAgents(runs, "/repo").order, ["codex", "claude"]);
  assert.deepEqual(workflowRecommendations(runs.map(r => ({ ...r, verdict: undefined })), "/repo").map(r => r.pattern), ["fix-review", "solo"]);
});
test("messages form complete sentences and empty verification evidence reports exit code", () => {
  for (const message of ["Policy path invalid", "Policy path invalid.", " Policy path invalid. "]) assert.equal(completeSentence(message), "Policy path invalid.");
  assert.equal(completeSentence("Retry?"), "Retry?"); assert.equal(plural(1, "attempt"), "1 attempt");
  const text = renderVerificationReport({ state: "failing", profile: "Test", startedAt: 0, endedAt: 1, checks: [{ check: { id: "silent", required: true }, diagnosis: "failed", attempts: [{ ok: false, exitCode: 1, output: "" }] }], skipped: [] } as any);
  assert.match(text, /Exit 1; no output/); assert.doesNotMatch(text, /```\n\n```/);
});
test("stale save restore and publication name the actual blocked action", async () => {
  const home = await mkdtemp(join(tmpdir(), "qa-conventions-")); const store = new ConventionsStore(home);
  try {
    await store.save("p", { revision: 0, text: "first" }); const preview = await store.previewRestore("p", 1); await store.save("p", { revision: 1, text: "second" });
    await assert.rejects(store.restore("p", preview), /Nothing was restored; preview the revision again/);
    await assert.rejects(store.save("p", { revision: 1, text: "draft" }), /Your draft was not saved/);
    await assert.rejects(store.publish("p", { repo: home, revision: 1, sourceHash: null, head: "a".repeat(40) }, { repos: [home], actor: "user", isIdle: () => true }), /Nothing was published/);
    assert.equal((await store.get("p")).text, "second\n");
  } finally { await rm(home, { recursive: true, force: true }); }
});
