import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunSummary } from "../src/engine.js";
import { attentionSnapshot } from "../src/attention-snapshot.js";
import { workingDiffStat } from "../src/git.js";
import { reviewReason } from "../src/review-inbox.js";
const r = (id: string, status: RunSummary["status"] = "done", extra: Partial<RunSummary> = {}) => ({ id, status, createdAt: Number(id.replace(/\D/g, "")) || 1, seen: false, repo: "/fixture", task: id, roles: {}, pattern: "solo", ...extra } as RunSummary);

test("initial attention spends all older slots on distinct review work after 106 recent no-ops", () => {
  const recent = Array.from({ length: 106 }, (_, i) => r(`recent-${i}`));
  const failures = Array.from({ length: 100 }, (_, i) => r(`failed-${i}`, "failed"));
  const page = recent.slice(0, 100), snapshot = attentionSnapshot([...recent, ...failures], new Set(page.map(run => run.id)));
  assert.deepEqual(new Set(snapshot.runs.map(run => run.id)), new Set(failures.map(run => run.id)));
  assert.equal(snapshot.total, 206); assert.equal(snapshot.truncated, true, "six older no-ops still need paging");
  const exact = attentionSnapshot([...page, ...failures], new Set(page.map(run => run.id)));
  assert.equal(exact.truncated, false);
});

test("running items are unbounded, related chats do not waste slots, and review ordering survives", () => {
  const running = Array.from({ length: 110 }, (_, i) => r(`running-${i}`, "running"));
  const visible = r("related", "failed"), failure = r("failure", "failed"), answer = r("answer", "stopped", { awaiting: { kind: "plan", title: "Approve", content: "Plan", at: 1 } });
  const snapshot = attentionSnapshot([...running, visible, failure, answer, r("noop")], new Set([visible.id]), 2);
  assert.equal(snapshot.running, 110); assert.equal(snapshot.runs.length, 112);
  assert.deepEqual(snapshot.runs.slice(110).map(run => run.id), ["answer", "failure"]);
  assert.equal(snapshot.truncated, true); assert.equal(snapshot.runs.some(run => run.id === visible.id), false);
  assert.equal(attentionSnapshot([r("archived", "failed", { archived: true }), r("seen", "done", { seen: true })], new Set()).total, 0);
  assert.throws(() => attentionSnapshot([], new Set(), 101), /snapshot size/);
});

const repo = realpathSync(mkdtempSync(join(tmpdir(), "codeflow-qa-attention-git-")));
after(() => rmSync(repo, { recursive: true, force: true }));
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
test("working review evidence includes tracked and untracked edits, excludes ignored files and clears after revert", async () => {
  git("init", "-q", "-b", "main"); writeFileSync(join(repo, "tracked.txt"), "initial\n"); writeFileSync(join(repo, ".gitignore"), "ignored*\n"); git("add", "."); git("-c", "user.name=QA", "-c", "user.email=qa@test", "commit", "-qm", "base");
  assert.equal(await workingDiffStat(repo, "HEAD"), "");
  writeFileSync(join(repo, "tracked.txt"), "modified\n"); writeFileSync(join(repo, "new\nquoted-雪.txt"), "added\n"); writeFileSync(join(repo, "ignored-secret"), "ignored\n");
  const stat = await workingDiffStat(repo, "HEAD"); assert.match(stat, /tracked.txt/); assert.match(stat, /1 new untracked file$/); assert.doesNotMatch(stat, /ignored|secret/);
  assert.equal(reviewReason(r("changed", "done", { artifacts: [{ label: "Workspace", path: repo, branch: "main", stat }] })), "review");
  git("checkout", "--", "tracked.txt"); rmSync(join(repo, "new\nquoted-雪.txt"));
  assert.equal(await workingDiffStat(repo, "HEAD"), ""); assert.equal(reviewReason(r("clean")), undefined);
});
