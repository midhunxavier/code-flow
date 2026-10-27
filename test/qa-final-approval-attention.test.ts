import test from "node:test";
import assert from "node:assert/strict";
import { RunManager, type RunSummary } from "../src/engine.js";
import { approvals, ApprovalRegistry } from "../src/approvals.js";
import { needsYou } from "../src/run-status.js";

const summary = (id: string, patch: Partial<RunSummary> = {}): RunSummary => ({
  id, task: id, repo: "/qa-fixture", project: "allowed", pattern: "solo", createdAt: 1,
  status: "running", seen: true, roles: { agent: ["codex"] }, worktrees: [], artifacts: [],
  merges: [], prs: {}, watches: {}, ...patch,
}) as RunSummary;
const put = (manager: RunManager, run: RunSummary) => (manager as any).runIndex.set(run);
const scope = (run: RunSummary) => run.project;
const allowed = (run: RunSummary) => run.project === "allowed";

test("expired-many attention reads do not clone payloads or recursively emit registry changes", async () => {
  const registry = new ApprovalRegistry(), controller = new AbortController(), requests: Promise<unknown>[] = [];
  let events = 0, depth = 0, maxDepth = 0;
  try {
    for (let i = 0; i < 32; i++) requests.push(registry.request(`expired-${i}`, "step", { id: `request-${i}`, kind: "command", command: "true" }, controller.signal));
    // Model a timer backlog: all deadlines elapsed before the first timer callback runs.
    for (const record of (registry as any).records.values()) record.expiresAt = Date.now() - 1;
    registry.subscribe(() => { events++; maxDepth = Math.max(maxDepth, ++depth); assert.equal(registry.pendingRunIds().size, 0); depth--; });
    assert.equal(registry.pendingRunIds().size, 0); assert.equal(events, 0);
    assert.ok([...(registry as any).records.values()].every((record: any) => record.status === "pending"), "a read cannot mutate request decisions");
    registry.cancelRun("expired-0");
    assert.equal(events, 1); assert.equal(maxDepth, 1);
    registry.close(); await Promise.all(requests);
    assert.equal(events, 32); assert.equal(maxDepth, 1);
  } finally { controller.abort(); registry.close(); await Promise.all(requests); }
});

test("live broker questions and commands count once per authorized family and publish resolution without a durable run event", async () => {
  const manager = new RunManager(), controller = new AbortController(), requests: Promise<unknown>[] = [];
  const received: RunSummary[] = [], stop = manager.subscribeAll(run => received.push(run));
  const root = summary("approval-root"), fork = summary("approval-fork", { createdAt: 2, chatLink: { kind: "tab", workspaceId: root.id, sourceId: root.id } });
  const side = summary("approval-side", { createdAt: 3, chatLink: { kind: "side", workspaceId: root.id, sourceId: fork.id } });
  const hidden = summary("approval-hidden", { project: "private", chatLink: { kind: "side", workspaceId: root.id, sourceId: root.id } });
  try {
    for (const run of [root, fork, side, hidden]) {
      put(manager, run);
      requests.push(approvals.request(run.id, "step", run === root
        ? { id: run.id, kind: "question", questions: [{ id: "q", question: "Choose a color" }] }
        : { id: run.id, kind: "command", command: "true" }, controller.signal));
    }
    const counts = manager.projectCounts(scope, ["allowed"], allowed);
    assert.equal(counts[""]!.waiting, 3); assert.equal(counts[""]!.attentionTasks, 1);
    assert.equal(counts.allowed!.waiting, 3); assert.equal(counts.private, undefined);
    const pages: string[] = []; let cursor: string | undefined;
    do {
      const page = manager.page({ status: "attention", limit: 1, cursor, predicate: allowed });
      assert.equal(page.total, 3); assert.ok(page.related.every(allowed));
      assert.ok([...page.runs, ...page.related].every(run => run.approvalPending));
      pages.push(...page.runs.map(run => run.id)); cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(pages, [side.id, fork.id, root.id]);
    assert.deepEqual(manager.projectReport(allowed).sections.waiting.runs.map(run => run.id), pages);
    assert.equal(manager.page({ section: "running", predicate: allowed }).total, 0);
    assert.equal(manager.attentionSnapshot([], allowed).runs.filter(run => run.approvalPending).length, 3);
    assert.equal(manager.attentionPage({ predicate: allowed }).runs.filter(run => run.approvalPending).length, 3);
    assert.equal((manager as any).runIndex.get(root.id).approvalPending, undefined, "derived request state must not enter durable index snapshots");
    const revision = manager.historyRevision;
    const request = approvals.list(root.id).find(record => record.status === "pending")!;
    assert.ok(approvals.respond(request.id, "approve", { runId: root.id }, { q: "blue" }));
    assert.ok(manager.historyRevision > revision);
    assert.equal(received.filter(run => run.id === root.id).at(-1)?.approvalPending, false);
    assert.equal(manager.projectCounts(scope, [], allowed)[""]!.waiting, 2);
    approvals.cancelRun(fork.id); approvals.cancelRun(side.id);
    assert.equal(manager.projectCounts(scope, [], allowed)[""]!.attentionTasks, 0);
    assert.equal(manager.page({ status: "attention", predicate: allowed }).total, 0);
    assert.equal(manager.page({ section: "running", predicate: allowed }).total, 3);
    assert.equal(manager.projectCounts(scope, [], () => true)[""]!.attentionTasks, 1, "hidden live request stays visible only to an authorized caller");
  } finally { stop(); controller.abort(); await Promise.all(requests); await manager.shutdown(); }
});

test("unloaded attention crosses the hundred-run page boundary without leaking denied requests", async () => {
  const manager = new RunManager(), controller = new AbortController(), requests: Promise<unknown>[] = [];
  try {
    for (let i = 0; i < 107; i++) {
      const run = summary(`approval-page-${i}`, { createdAt: i + 1, project: i < 105 ? "allowed" : "private" });
      put(manager, run); requests.push(approvals.request(run.id, "step", { id: run.id, kind: "command", command: "true" }, controller.signal));
    }
    const counts = manager.projectCounts(scope, [], allowed);
    assert.equal(counts[""]!.waiting, 105); assert.equal(counts[""]!.attentionTasks, 105);
    const first = manager.page({ status: "attention", limit: 100, predicate: allowed });
    const last = manager.page({ status: "attention", limit: 100, predicate: allowed, cursor: first.nextCursor });
    assert.equal(first.total, 105); assert.equal(last.total, 105); assert.equal(last.nextCursor, undefined);
    assert.equal(new Set([...first.runs, ...last.runs].map(run => run.id)).size, 105);
    assert.ok([...first.runs, ...last.runs].every(allowed));
    const report = manager.projectReport(allowed);
    assert.equal(report.sections.waiting.total, 105); assert.equal(report.sections.waiting.runs.length, 100);
    assert.equal(manager.page({ section: "waiting", cursor: report.sections.waiting.nextCursor, predicate: allowed }).runs.length, 5);
  } finally { controller.abort(); await Promise.all(requests); await manager.shutdown(); }
});

test("stopped, archived, resolved and stale restored flags cannot manufacture live approval attention", async () => {
  const manager = new RunManager(), controller = new AbortController(), requests: Promise<unknown>[] = [];
  try {
    for (const run of [summary("approval-stopped", { status: "stopped" }), summary("approval-archived", { archived: true }), summary("approval-restored", { approvalPending: true })]) {
      put(manager, run);
      if (run.id !== "approval-restored") requests.push(approvals.request(run.id, "step", { id: run.id, kind: "command", command: "true" }, controller.signal));
    }
    assert.equal(manager.projectCounts(scope, [], allowed)[""]!.waiting, 0);
    assert.equal(manager.page({ status: "attention" }).total, 0);
    assert.ok(manager.list().every(run => !run.approvalPending && !needsYou(run)));
    assert.equal(needsYou(summary("stopped-wire", { status: "stopped", approvalPending: true })), false);
    assert.equal(needsYou(summary("archived-wire", { archived: true, approvalPending: true })), false);
  } finally { controller.abort(); await Promise.all(requests); await manager.shutdown(); }
});
