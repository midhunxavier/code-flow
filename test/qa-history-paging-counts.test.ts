import { test } from "node:test";
import assert from "node:assert/strict";
import { projectHistoryCounts } from "../src/project-report.js";
import { matchesHistoryFilter } from "../src/run-status.js";
import type { RunSummary } from "../src/engine.js";

const run = (id: string, patch: Partial<RunSummary> = {}): RunSummary => ({ id, task: id, repo: "/repo", project: "p", pattern: "solo", createdAt: Number(id) || 1, status: "done", seen: true, roles: {}, worktrees: [], merges: [], prs: {}, watches: {}, ...patch }) as RunSummary;

test("complete counts cover unloaded, archived, orphaned and empty projects without counting provider tabs as tasks", () => {
  const list = Array.from({ length: 130 }, (_, index) => run(String(index), { archived: index < 12 }));
  list.push(run("tab", { archived: true, chatLink: { kind: "tab", workspaceId: "0", sourceId: "0" } }));
  list.push(run("live-tab", { chatLink: { kind: "tab", workspaceId: "1", sourceId: "1" } }));
  list.push(run("orphan", { project: undefined, seen: false }));
  const counts = projectHistoryCounts(list, run => run.project, ["p", "empty"]);
  assert.deepEqual([counts.p!.live, counts.p!.archived, counts.p!.archivedTasks], [119, 13, 11]);
  assert.equal(counts.p!.repositories["/repo"], 132);
  assert.equal(counts[""]!.live + counts[""]!.archived, 133);
  assert.equal(counts.none!.waiting, 1); assert.equal(counts.none!.attentionTasks, 1);
  assert.equal(counts.empty!.live, 0);
  const authorized = projectHistoryCounts(list.filter(run => run.project !== "p"), run => run.project);
  assert.equal(authorized[""]!.live, 1); assert.equal(authorized.p, undefined);
});

test("archive filters compose with status and repository filters", () => {
  const live = run("live"), archived = run("archived", { archived: true });
  assert.equal(matchesHistoryFilter(live, { archived: "exclude", repo: "/repo" }), true);
  assert.equal(matchesHistoryFilter(archived, { archived: "exclude" }), false);
  assert.equal(matchesHistoryFilter(live, { archived: "only" }), false);
  assert.equal(matchesHistoryFilter(archived, { archived: "only", repo: "/other" }), false);
  assert.equal(matchesHistoryFilter(archived, { archived: "include" }), true);
});

test("engine pages count and traverse only the chosen archive scope, retaining archived search hints", async () => {
  const { RunManager } = await import("../src/engine.js"), { findPattern } = await import("../src/patterns/index.js");
  const manager = new RunManager(findPattern);
  for (let index = 0; index < 107; index++) (manager as any).runIndex.set(run(String(index), { archived: index < 5 }));
  const first = manager.page({ limit: 100, archived: "exclude" });
  assert.equal(first.total, 102); assert.equal(first.archivedMatches, 5); assert.equal(first.runs.length, 100);
  assert.ok(first.runs.every(run => !run.archived));
  const last = manager.page({ limit: 100, archived: "exclude", cursor: first.nextCursor });
  assert.equal(last.runs.length, 2); assert.equal(last.nextCursor, undefined);
  assert.equal(new Set([...first.runs, ...last.runs].map(run => run.id)).size, 102);
  assert.equal(manager.page({ archived: "only" }).total, 5);
  assert.equal(manager.page({ archived: "include" }).total, 107);
});
