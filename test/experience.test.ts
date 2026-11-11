import { test } from "node:test";
import assert from "node:assert/strict";
import { outcomeMetrics, workflowRecommendations, progressSummary, taskIntent } from "../src/experience.js";
import type { RunSummary } from "../src/engine.js";

const run = (id: string, patch: Partial<RunSummary> = {}): RunSummary => ({ id, repo: "/repo", pattern: "pipeline", intent: "bug", status: "done", verdict: "passed", createdAt: 1000, endedAt: 6000, merges: [], ...patch } as RunSummary);
test("recommendations keep failures in the denominator and exclude different repositories, intents and running work", () => {
  const records = [run("1"), run("2", { status: "failed", verdict: undefined }), run("3", { intent: "feature" }), run("4", { repo: "/other" }), run("5", { intent: undefined }), run("6", { status: "running" }), run("7", { pattern: "solo" })];
  const ranked = workflowRecommendations(records, "/repo", "bug");
  const pipeline = ranked.find(row => row.pattern === "pipeline")!;
  assert.equal(pipeline.completed, 2); assert.equal(pipeline.verified, 1); assert.equal(pipeline.rated, 0);
  assert.deepEqual(pipeline.runIds, ["1", "2"]); assert.ok(pipeline.confidence.low < .5);
  assert.equal(taskIntent("not-an-intent"), undefined);
});
test("metrics distinguish unrated and missing corrections from zero and use only independently verified results", () => {
  const records = [run("1", { outcome: { decision: "accepted", branch: "a", head: "abc", at: 1 }, humanRework: [{ id: "r", branch: "a", head: "abc", minutes: 12, note: "", at: 1 }] }), run("2", { status: "failed", verdict: undefined }), run("3", { verification: { state: "unchecked" } as any })];
  const m = outcomeMetrics(records); assert.equal(m.accepted, 1); assert.equal(m.rated, 1); assert.equal(m.verified, 1); assert.equal(m.reworkSamples, 1); assert.equal(m.medianReworkMinutes, 12); assert.equal(m.medianVerifiedMs, 5000);
  assert.equal(outcomeMetrics([]).medianReworkMinutes, undefined);
});
test("progress puts human blockers ahead of ongoing agent output", () => {
  const value = run("1", { status: "running", awaiting: { kind: "plan", title: "Approve this plan", content: "", at: 1 } });
  assert.match(progressSummary(value, []).title, /decision/);
  assert.match(progressSummary(run("2", { status: "running" }), []).title, /Preparing/);
});
test("cold projections retain verification state and correction samples for outcome metrics", async () => {
  const { coldSummary } = await import("../src/run-cold-store.js");
  const original = run("cold", { followUps: [], artifacts: [], humanRework: [{ id: "r", branch: "a", head: "abc", minutes: 9, note: "private detail", at: 1 }], verification: { version: 1, state: "unchecked", profile: "test", startedAt: 1, endedAt: 2, checks: [], skipped: [] } });
  const archived = coldSummary({ ...original, steps: [] } as import("../src/engine.js").Run);
  assert.deepEqual(outcomeMetrics([archived]), outcomeMetrics([original]));
  assert.equal(archived.humanRework?.[0]?.note, "");
});
test("task priorities affect packing while dependencies and occupied paths remain authoritative", async () => {
  const { readyTasks } = await import("../src/patterns/auto-team-model.js");
  const task = (id: string, owner: string, dependsOn: string[] = []) => ({ id, owner, dependsOn, paths: ["src"], status: "pending" as const, kind: "implementation" as const, instructions: "", title: id, acceptance: [], requirements: [] });
  const tasks = [task("a", "one"), task("b", "two"), task("c", "three", ["b"])];
  assert.deepEqual(readyTasks(tasks).map(task => task.id), ["a"]);
  assert.deepEqual(readyTasks([task("constructor", "one"), task("b", "two")], [], () => true, { b: 10 }).map(task => task.id), ["b"]);
  assert.deepEqual(readyTasks(tasks, [], () => true, { b: 10, c: 10 }).map(task => task.id), ["b"]);
  assert.deepEqual(readyTasks([{ ...tasks[0]!, status: "running" }, ...tasks.slice(1)], [], () => true, { b: 10 }).map(task => task.id), []);
});
