import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pattern, Run, RunEvent } from "../src/engine.js";

const home = mkdtempSync(join(tmpdir(), "cf-cold-storage-home-")); process.env.CODEFLOW_HOME = home;
const { RunManager } = await import("../src/engine.js"), { strip, rebuildRun, RunProjection } = await import("../src/run-projection.js"), { COLD_LIMITS, coldEligible } = await import("../src/run-cold-store.js"), { flushWrites, RUNS_DIR } = await import("../src/store.js"), { computeStats } = await import("../src/stats.js");
const repo = mkdtempSync(join(tmpdir(), "cf-cold-storage-repo-")), managers: InstanceType<typeof RunManager>[] = [];
after(async () => { for (const manager of managers) await manager.shutdown(); await flushWrites(); rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo }); writeFileSync(join(repo, "README.md"), "fixture"); execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], { cwd: repo });
const pattern: Pattern = { id: "fixture", name: "Fixture", summary: "", description: "", roles: [], options: [], run: async () => "Completed fixture" };
const createManager = () => { const manager = new RunManager((id) => id === pattern.id ? pattern : undefined); managers.push(manager); return manager; };
async function finished(run: Run) { while (run.status === "running") await new Promise((done) => setTimeout(done, 10)); }
let original: Run;
async function baseline() { if (original) return original; const manager = createManager(); original = await manager.start({ repo, pattern, task: "Fixture", roles: {}, options: {}, loop: { copy: [], setup: "", check: "" } }); await finished(original); await flushWrites(); return original; }
function save(run: Run, extra: RunEvent[] = []) { const event = { seq: 1, ts: run.createdAt, runId: run.id, type: "run", run: strip(run) }; writeFileSync(join(RUNS_DIR, `${run.id}.jsonl`), [JSON.stringify(event), ...extra.map((event) => JSON.stringify(event)), ...run.steps.map((step) => JSON.stringify({ seq: 3, ts: step.startedAt, runId: run.id, type: "step", step }))].join("\n") + "\n"); }

test("incremental run projection preserves legacy defaults and latest steps without retaining transcript events", () => {
  const events = [{ seq: 1, ts: 0, runId: "legacy", type: "run", run: { id: "legacy", repo, pattern: "fixture", roles: {}, task: "Legacy", status: "done", summary: "Pattern\n\n## Follow-ups\nLater", createdAt: 0 } }, { seq: 2, ts: 0, runId: "legacy", type: "step", step: { id: "s1", status: "running", startedAt: 0 } }, { seq: 3, ts: 1, runId: "legacy", type: "step", step: { id: "s1", status: "done", startedAt: 0, endedAt: 1 } }] as unknown as RunEvent[];
  const projection = new RunProjection(); for (const event of events) projection.apply(event); for (let index = 0; index < 2000; index++) projection.apply({ seq: 4 + index, ts: 1, runId: "legacy", type: "agent", stepId: "s1", event: { kind: "text", text: "discarded transcript" } });
  const restored = projection.finish()!; assert.deepEqual(restored, rebuildRun(events)); assert.equal(restored.steps.length, 1); assert.equal(restored.steps[0]!.kind, "agent"); assert.equal(restored.steps[0]!.status, "done"); assert.equal(restored.patternSummary, "Pattern"); assert.equal(restored.trust, "standard"); assert.equal(restored.loop.maxSteps, 40); assert.equal(projection.seq, 2003);
  const snapshot = strip(restored); restored.roles.changed = ["claude"]; assert.equal(snapshot.roles.changed, undefined);
});

test("startup keeps archived full state on disk, stable history/count/search/provenance and exact analytics survive bounded detail hydration", async () => {
  const base = await baseline(), originals: Run[] = [];
  for (let index = 0; index < 12; index++) {
    const run: Run = { ...structuredClone(base), id: `cold-${String(index).padStart(2, "0")}`, createdAt: 1000, endedAt: 2000, archived: true, seen: true, task: index === 0 ? "x".repeat(10_000) + " unique-deep-search" : `Archived ${index}`, conventions: "a".repeat(5 * 1024 * 1024), parentRunId: index ? "cold-00" : undefined, source: { kind: "issue", number: index, url: "https://github.com/fixture/repo/issues/1", title: "Source", body: "untrusted words", trusted: false }, inheritedSourceTrust: "untrusted", trust: "safe", lockdown: "Source is untrusted", usage: { agentSteps: 2, checks: 1, inputTokens: 10, outputTokens: 5, byAgent: { claude: { steps: 2, writeSteps: 1, failures: 0, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, costUsd: 0.1, ms: 20 } } }, verdict: "passed", review: { verdict: "approve", summary: "Detailed review", markdown: "Review prose", reviewers: [], findings: [{ severity: "low", raisedBy: ["claude", "codex"], file: "README.md", problem: "Detailed issue", fix: "Detailed fix" }] }, steps: [] };
    originals.push(run); save(run);
  }
  const manager = createManager(); await manager.load(); assert.equal(manager.inspectStorage().cold.records, 12); assert.equal(manager.inspectStorage().cold.cached, 0); assert.equal(manager.list().length, 13);
  const pageOne = manager.page({ limit: 7 }), pageTwo = manager.page({ limit: 7, cursor: pageOne.nextCursor }); assert.equal(new Set([...pageOne.runs, ...pageTwo.runs].map((run) => run.id)).size, 13); assert.equal(pageOne.total, 13);
  const summary = manager.list().find((run) => run.id === "cold-00")!; assert.equal(summary.cold, true); assert.equal(summary.detailAvailable, true); assert.equal(summary.conventions, undefined); assert.equal(summary.source!.trusted, false); assert.equal(summary.inheritedSourceTrust, "untrusted"); assert.equal(summary.lockdown, "Source is untrusted"); assert.equal(manager.page({ query: "unique-deep-search" }).runs[0]!.id, "cold-00");
  assert.deepEqual(computeStats(manager.list().filter((run) => run.id.startsWith("cold-"))), computeStats(originals.map(strip)));
  for (const run of originals) { const detail = manager.get(run.id)!; assert.equal(detail.conventions, run.conventions); assert.equal(detail.source!.body, "untrusted words"); assert.equal(detail.parentRunId, run.parentRunId); }
  const storage = manager.inspectStorage(); assert.ok(storage.cold.cached <= COLD_LIMITS.cacheEntries); assert.ok(storage.cold.bytes <= COLD_LIMITS.cacheBytes); assert.ok(storage.cold.cached < 8, "byte budget evicts before the entry cap"); assert.equal(storage.hot, 1);
  const detached = manager.get("cold-00")!; detached.conventions = "caller mutation"; assert.equal(manager.get("cold-00")!.conventions, originals[0]!.conventions);
  const restarted = createManager(); await restarted.load(); assert.equal(restarted.inspectStorage().cold.records, 12); assert.equal(restarted.inspectStorage().cold.cached, 0);
  restarted.setArchived("cold-00", false); await flushWrites(); assert.equal(restarted.get("cold-00")!.archived, false); assert.equal(restarted.get("cold-00")!.conventions, originals[0]!.conventions); assert.equal(restarted.inspectStorage().cold.records, 11);
  const resumed = await restarted.resume("cold-00"); await finished(resumed); assert.equal(resumed.status, "done", resumed.error); assert.equal(resumed.conventions, originals[0]!.conventions); assert.equal(resumed.inheritedSourceTrust, "untrusted"); assert.equal(restarted.get(resumed.id), resumed, "resumable mutations use the promoted live object");
});

test("stale or damaged cold projections rebuild from authoritative records and never hide changed source trust", async () => {
  const base = await baseline(), run: Run = { ...structuredClone(base), id: "cold-stale", archived: true, seen: true, conventions: "original conventions", steps: [] }; save(run);
  const manager = createManager(); await manager.load(); assert.equal(manager.get(run.id)!.conventions, "original conventions");
  writeFileSync(join(RUNS_DIR, `${run.id}.cold-detail.json`), "damaged"); assert.equal(manager.get(run.id)!.conventions, "original conventions");
  const next = { ...run, task: "New source snapshot", inheritedSourceTrust: "untrusted" as const, lockdown: "new distrust" }; appendFileSync(join(RUNS_DIR, `${run.id}.jsonl`), JSON.stringify({ seq: 900, ts: Date.now(), runId: run.id, type: "run", run: strip(next) }) + "\n");
  const restored = createManager(); await restored.load(); assert.equal(restored.get(run.id)!.task, next.task); assert.equal(restored.get(run.id)!.inheritedSourceTrust, "untrusted"); assert.equal(restored.page({ query: "new source snapshot" }).runs[0]!.lockdown, "new distrust");
});

test("cold mutation promotion preserves a retained start handle without strongly retaining archived state", async () => {
  const manager = createManager(), run = await manager.start({ repo, pattern, task: "Retained live handle", roles: {}, options: {} }); await finished(run); await manager.archive(run.id); await flushWrites();
  const deadline = Date.now() + 5000; while (!manager.list().find((item) => item.id === run.id)?.cold) { if (Date.now() > deadline) throw new Error("Cold projection did not settle"); await new Promise((done) => setTimeout(done, 10)); }
  manager.setArchived(run.id, false); assert.equal(manager.get(run.id), run); assert.equal(run.archived, false); const resumed = await manager.resume(run.id); assert.equal(resumed, run); await finished(run);
});

test("read-only review coverage hydrates archived details through the bounded cache without mutation promotion", async () => {
  const base = await baseline(), run: Run = { ...structuredClone(base), id: "cold-read-only", archived: true, seen: true, worktrees: [{ name: "result", branch: "main", path: repo }], steps: [] }; save(run);
  const manager = createManager(); await manager.load(); const before = manager.inspectStorage().hot;
  const coverage = await manager.reviewCoverage(run.id, "main"); assert.deepEqual(coverage.files, []); await assert.rejects(manager.prMergeInfo(run.id, "main"), /no pull request/); assert.equal(manager.inspectStorage().hot, before); assert.equal(manager.list().find((item) => item.id === run.id)!.cold, true);
});

test("attention pagination bounds older work after authorization filtering and keeps every running run visible", async () => {
  const base = await baseline(); for (let index = 0; index < 125; index++) save({ ...structuredClone(base), id: `attention-${String(index).padStart(3, "0")}`, createdAt: 5000, status: "failed", archived: false, seen: false, project: index % 2 ? "hidden" : "visible" });
  const manager = createManager(); await manager.load(); const visible = manager.attentionPage({ limit: 10, predicate: (run) => run.project === "visible" }); assert.equal(visible.total, 63); assert.equal(visible.runs.length, 10); assert.equal(visible.truncated, true);
  let cursor: string | undefined, ids: string[] = []; do { const page = manager.attentionPage({ limit: 10, cursor, predicate: (run) => run.project === "visible" }); ids.push(...page.runs.map((run) => run.id)); cursor = page.nextCursor; } while (cursor); assert.equal(ids.length, 63); assert.equal(new Set(ids).size, 63);
  let release!: () => void; const gate = new Promise<void>((done) => release = done), busy: Pattern = { ...pattern, id: "busy", run: async () => { await gate; return "done"; } };
  const running = await manager.start({ repo, pattern: busy, task: "Active", roles: {}, options: {} }); const active = manager.attentionPage({ limit: 1 }); assert.ok(active.runs.some((run) => run.id === running.id)); assert.equal(active.running, 1); assert.equal(active.runs.length, 2); release(); await finished(running);
  assert.equal(coldEligible({ ...structuredClone(base), archived: true, status: "interrupted" }), false); assert.equal(coldEligible({ ...structuredClone(base), archived: true, followUps: [{ status: "pending" }] as Run["followUps"] }), false);
});
