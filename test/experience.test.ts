import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { outcomeMetrics, workflowRecommendations, progressSummary, taskIntent } from "../src/experience.js";
import { journeyAction, journeyUrl, validateJourney, journeySpec } from "../src/journeys.js";
import { JourneyStore } from "../src/journey-store.js";
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
const draft = { repo: "/repo", title: "Show greeting", url: "http://localhost:3000/hello", width: 800, actions: [{ kind: "fill", selector: "#name", value: 'Ada "quoted"' }, { kind: "click", selector: "#go" }], expected: { selector: "#result", text: "Hello Ada" } };
test("scenarios validate local targets, bounded actions, credentials and executable exports", () => {
  const value = { ...validateJourney(draft), id: "a", createdAt: 1 };
  const spec = journeySpec(value); assert.match(spec, /toBeVisible/); assert.match(spec, /toContainText/); assert.match(spec, /APP_URL/); assert.match(spec, /Ada \\\"quoted\\\"/);
  for (const url of ["https://example.com", "file:///etc/passwd", "http://localhost:3000/?token=secret", "http://user:pass@localhost:3000"]) assert.throws(() => journeyUrl(url));
  assert.throws(() => journeyAction({ kind: "evaluate", value: "alert(1)" }));
  assert.throws(() => journeyAction({ kind: "fill", selector: "#password", value: "secret" }));
  assert.throws(() => validateJourney({ ...draft, actions: Array(31).fill(draft.actions[0]) }));
  assert.throws(() => validateJourney({ ...draft, expected: { selector: "body", text: "" } }));
});
test("scenario storage survives reopen, serializes replay updates and bounds retained evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codeflow-journeys-"));
  try {
    const store = new JourneyStore(directory); const value = await store.create(draft);
    assert.equal((await new JourneyStore(directory).get(value.id)).title, draft.title);
    await Promise.all(Array.from({ length: 6 }, (_, index) => store.record(value.id, { id: String(index), journeyId: value.id, status: "passed", at: index, url: value.url, frames: [] })));
    assert.deepEqual((await store.replays(value.id)).map(row => row.id), ["2", "3", "4", "5"]);
    assert.equal((await store.list("/other")).length, 0);
    await assert.rejects(store.get("../secret"), /Invalid/);
    await store.delete(value.id); assert.equal((await store.list("/repo")).length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("exported regression tests keep double-slash paths on the selected app origin", async () => {
  const journey = { ...validateJourney({ ...draft, url: "http://localhost:3000//other.test/path?q=1#result" }), id: "a", createdAt: 1 };
  let visited = "";
  const page = { setViewportSize() {}, goto(url: string) { visited = url; }, locator() { return { fill() {}, click() {} }; } };
  await runInNewContext(journeySpec(journey).replace(/^import[^\n]*\n/, ""), { URL, process: { env: { APP_URL: "http://localhost:4000" } }, test: (_: string, body: (input: object) => unknown) => body({ page }), expect: () => ({ toBeVisible() {}, toContainText() {} }) });
  assert.equal(visited, "http://localhost:4000//other.test/path?q=1#result");
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
