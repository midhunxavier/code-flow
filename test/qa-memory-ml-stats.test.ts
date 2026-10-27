import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeProjectMemory } from "../src/memory-analysis.js";
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
test("curated onboarding withholds contradictions and exact duplicates, retaining eligible first copy", async () => {
  const repo = await mkdtemp(join(tmpdir(), "qa-memory-analysis-"));
  const entry = (id: string, body: string, extra = {}): MemoryEntry => ({ id, title: id, body, repo, projectId: "p", revision: 1, scope: "project", status: "accepted", acceptedBy: "user", tags: [], paths: [], applicability: { kind: "repository" }, derivedFrom: [], sourceRefs: [], origins: [{ kind: "user", trust: "trusted", private: false, lockedDown: false }], createdAt: 1, updatedAt: 2, ...extra });
  try {
    const result = await analyzeProjectMemory({ repo, projectId: "p", entries: [entry("Guest A", "Always permit guest requests"), entry("Guest B", "Never allow guest requests"), entry("A rejected duplicate", "Use the broker fixture from conftest for every integration test.", { status: "proposed" }), entry("Dup A", "Use the broker fixture from conftest for every integration test."), entry("Dup B", "Use the broker fixture from conftest for every integration test."), entry("Safe", "Read the project guide before starting.")] });
    assert.deepEqual(result.onboarding.sourceRefs.map(r => r.id), ["Dup A", "Safe"]);
    assert.doesNotMatch(result.onboarding.body, /guest requests/); assert.equal(result.onboarding.body.match(/Use the broker fixture/g)?.length, 1);
    assert.equal(result.onboarding.reasons.filter(r => /contradiction/.test(r.reason)).length, 2); assert.match(result.onboarding.reasons.find(r => r.id === "Dup B")!.reason, /Dup A/);
  } finally { await rm(repo, { recursive: true, force: true }); }
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
test("ML docs identify the saved Settings choice as deployment control", async () => {
  const docs = await readFile(new URL("../docs/model-training.md", import.meta.url), "utf8");
  assert.doesNotMatch(docs, /Removing `CODEFLOW_ML_ENABLED` blocks/); assert.match(docs, /Disable model training.*blocks deployment/);
});
