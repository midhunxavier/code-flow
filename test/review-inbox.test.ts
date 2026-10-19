import { test } from "node:test";
import assert from "node:assert/strict";
import { groupReviewRuns, prioritizedReviewRuns, reviewReason } from "../src/review-inbox.js";
import type { RunSummary } from "../src/engine.js";

const run = (id: string, patch: Partial<RunSummary> = {}): RunSummary => ({ id, repo: "/repo", task: `Task ${id}`, status: "done", createdAt: 1, seen: false, archived: false, ...patch } as RunSummary);
test("review inbox includes manual questions and failures while excluding handled and archived items", () => {
  const question = run("question", { awaiting: { kind: "plan", title: "Approve plan?", content: "Plan", at: 1 } as RunSummary["awaiting"] });
  const result = run("result", { triage: { state: "pending" } as RunSummary["triage"] });
  assert.deepEqual(prioritizedReviewRuns([run("done"), run("old-failure", { status: "failed", seen: true }), run("cancel", { status: "cancelled" }), run("archived", { ...result, archived: true }), result, question, run("failure", { status: "failed" })]).map((item) => item.id), ["question", "failure", "result"]);
  assert.equal(reviewReason(run("blocked", { team: { status: "blocked" } as RunSummary["team"] })), "blocked");
});
test("explicit priorities outrank reason, then older waiting items win deterministic ties", () => {
  const triage = { state: "pending" } as RunSummary["triage"];
  const ordered = prioritizedReviewRuns([run("b", { triage, createdAt: 4 }), run("a", { triage, createdAt: 4 }), run("old", { triage, createdAt: 2 }), run("priority", { triage, priority: 10, createdAt: 10 }), run("question", { awaiting: {} as RunSummary["awaiting"], createdAt: 9 })]);
  assert.deepEqual(ordered.map((item) => item.id), ["priority", "question", "old", "a", "b"]);
});
test("manual results and failed checks appear alongside automation results until viewed", () => {
  const artifacts = [{ branch: "result", label: "Result", path: "/result", stat: "1 file changed" }];
  assert.equal(reviewReason(run("manual", { artifacts })), "review");
  assert.equal(reviewReason(run("seen", { artifacts, seen: true })), undefined);
  assert.equal(reviewReason(run("check", { artifacts, verdict: "failing" })), "failed");
  assert.equal(reviewReason(run("environment", { checkCantRun: { command: "test", reason: "missing tool" } })), "blocked");
  assert.equal(reviewReason(run("limit", { status: "stopped" })), "blocked");
  assert.equal(reviewReason(run("active", { status: "running", artifacts, verdict: "failing" })), undefined);
});
test("search/reason filters and grouping preserve the priority order without duplicate runs", () => {
  const items = prioritizedReviewRuns([run("low", { status: "failed", repo: "/a" }), run("high", { status: "failed", repo: "/b", priority: 10 }), run("answer", { awaiting: {} as RunSummary["awaiting"] })], { query: "task", reason: "failed" });
  const groups = groupReviewRuns(items, (item) => ({ id: item.repo, label: item.repo }));
  assert.deepEqual(groups.map((group) => group.id), ["/b", "/a"]);
  assert.deepEqual(groups.flatMap((group) => group.runs.map((item) => item.id)), ["high", "low"]);
  assert.equal(prioritizedReviewRuns(items, { query: "low /a" }).length, 1);
});
