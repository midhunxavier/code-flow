import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const scratch = mkdtempSync(join(tmpdir(), "cf-qa-pr-watch-"));
process.env.CODEFLOW_HOME = join(scratch, "data");
process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
process.env.FAKE_GH_STATE = join(scratch, "gh.json");
writeFileSync(join(scratch, "bash"), '#!/bin/sh\nexec /bin/bash --noprofile --norc\n', { mode: 0o755 });
process.env.SHELL = join(scratch, "bash"); process.env.BASH_ENV = ""; process.env.ENV = "";
const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { adapters } = await import("../src/adapters/index.js");
const { PrWatcher } = await import("../src/watch.js");
const { unpublishedWatchIssues } = await import("../src/watch-integrity.js");
const { visualEvidenceFiles, wantsVisualEvidence } = await import("../src/visual-evidence.js");
type Run = import("../src/engine.js").Run;
const managers: InstanceType<typeof RunManager>[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const state = () => JSON.parse(readFileSync(process.env.FAKE_GH_STATE!, "utf8"));
const change = (fn: (s: any) => void) => { const s = state(); fn(s); writeFileSync(process.env.FAKE_GH_STATE!, JSON.stringify(s)); };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function idle(run: Run) { for (let i = 0; i < 1000 && run.status === "running"; i++) await pause(10); assert.equal(run.status, "done", run.error); }
let behavior = (_cwd: string) => {};
adapters.codex.run = async options => { behavior(options.cwd); return { ok: true, finalText: "Fixture completed" }; };
async function fixture(check?: string, checkpointOnFinish = false) {
  const dir = mkdtempSync(join(scratch, "case-")), repo = join(dir, "repo"), origin = join(dir, "origin.git"); mkdirSync(repo); mkdirSync(origin);
  git(origin, "init", "-q", "--bare", "-b", "main"); git(repo, "init", "-q", "-b", "main");
  mkdirSync(join(repo, ".github/workflows"), { recursive: true }); mkdirSync(join(repo, ".codeflow"));
  writeFileSync(join(repo, ".github/workflows/ci.yml"), "run: npm test\n"); writeFileSync(join(repo, "README.md"), "Fixture\n"); writeFileSync(join(repo, ".codeflow/config.json"), '{"prove":false}');
  writeFileSync(join(repo, "t-1.txt"), "one"); writeFileSync(join(repo, "t-2.txt"), "two");
  git(repo, "add", "."); git(repo, "commit", "-qm", "baseline"); git(repo, "remote", "add", "origin", origin); git(origin, "fetch", "-q", repo, "main:refs/heads/main", "main:refs/heads/feature"); git(repo, "fetch", "-q", "origin");
  const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(process.env.FAKE_GH_STATE!, JSON.stringify({ prs: { 1: { number: 1, title: "Fixture", url: "https://github.com/o/r/pull/1", headRefName: "feature", baseRefName: "main", author: { login: "me" }, state: "OPEN", comments: [], failOn: [] } } }));
  const manager = new RunManager(findPattern); managers.push(manager); behavior = () => {};
  const run = await manager.start({ pattern: findPattern("solo")!, repo, task: "Inspect fixture", checkpointOnFinish, roles: { agent: ["codex"] }, options: {}, loop: { check }, trust: "standard" }); await idle(run);
  const tree = run.worktrees[0]!, branch = tree.branch;
  run.prs[branch] = "https://github.com/o/r/pull/1";
  run.source = { kind: "pr", number: 1, title: "Fixture", url: run.prs[branch], body: "", headRefName: "feature", baseRefName: "main", isCrossRepository: false };
  return { manager, run, repo, origin, base, branch, tree };
}
after(async () => { for (const manager of managers) await manager.shutdown(); });

test("watch limits reject invalid values without replacing a watch; omitted remains three", async () => {
  const { manager, run, branch } = await fixture(); const watch = manager.watchPr(run.id, { branch, agent: "codex" }); assert.equal(watch.maxFixes, 3);
  for (const maxFixes of [0, -1, 25, 2.5, NaN, Infinity, null, "", "2"]) {
    assert.throws(() => manager.watchPr(run.id, { branch, agent: "codex", maxFixes: maxFixes as number }), /integer from 1 to 10/); assert.equal(run.watches[branch], watch);
  }
  for (const maxFixes of [1, 10]) assert.equal(manager.watchPr(run.id, { branch, agent: "codex", maxFixes }).maxFixes, maxFixes);
});

test("earlier blocked CI changes cannot ride an honest follow-up or Watch again", async () => {
  const { manager, run, repo, origin, base, branch, tree } = await fixture(); manager.watchPr(run.id, { branch, agent: "codex" });
  const turn = async () => { manager.updateWatch(run.id, branch, { state: "fixing" }); await manager.followUp(run.id, { kind: "ci-fix", worktree: tree.name, agent: "codex", message: "Fix CI", push: "feature", watch: branch }); await idle(run); return run.followUps.at(-1)!; };
  behavior = cwd => writeFileSync(join(cwd, ".github/workflows/ci.yml"), "run: echo skip tests\n");
  const first = await turn(); assert.equal(first.pushed, undefined); assert.match(first.pushError!, /review/); assert.equal(git(origin, "rev-parse", "feature"), base);
  manager.watchPr(run.id, { branch, agent: "codex" }); behavior = cwd => writeFileSync(join(cwd, "README.md"), "Honest documentation fix\n");
  const second = await turn(); assert.equal(second.integrity, undefined, "current turn itself is honest"); assert.equal(second.pushed, undefined); assert.match(second.pushError!, /ci.yml/); assert.equal(git(origin, "rev-parse", "feature"), base);
  manager.watchPr(run.id, { branch, agent: "codex" }); await new PrWatcher(manager).poll(); assert.equal(run.watches[branch]!.state, "needs-you"); assert.match(run.watches[branch]!.detail, /Unpublished commits/);
  writeFileSync(join(tree.path, ".github/workflows/ci.yml"), "run: npm test\n"); git(tree.path, "add", "."); git(tree.path, "commit", "-qm", "restore CI");
  assert.deepEqual(await unpublishedWatchIssues(repo, branch, "feature"), []);
  const missing = await unpublishedWatchIssues(repo, branch, "missing"); assert.equal(missing[0]!.kind, "unverified");
});

test("a prior test-count reduction stays blocked even when no test-named file changed", async () => {
  const check = "node -e \"console.log('# pass '+require('fs').readdirSync('.').filter(n=>/^t-/.test(n)).length)\"";
  const { manager, run, origin, base, branch, tree } = await fixture(check);
  const before = Number(execFileSync(process.execPath, ["-e", "console.log(require('fs').readdirSync('.').filter(n=>/^t-/.test(n)).length)"], { cwd: tree.path, encoding: "utf8" }).trim());
  assert.equal(before, 2); run.testCounts = { [branch]: { first: { head: base, tests: before }, last: { head: base, tests: before } } };
  manager.watchPr(run.id, { branch, agent: "codex" });
  const turn = async () => { manager.updateWatch(run.id, branch, { state: "fixing" }); await manager.followUp(run.id, { kind: "ci-fix", worktree: tree.name, agent: "codex", message: "Fix CI", push: "feature", watch: branch }); await idle(run); return run.followUps.at(-1)!; };
  behavior = cwd => rmSync(join(cwd, "t-2.txt")); const first = await turn(); assert.ok(first.integrity?.some(issue => issue.kind === "fewer-tests"));
  manager.watchPr(run.id, { branch, agent: "codex" }); behavior = cwd => writeFileSync(join(cwd, "README.md"), "Honest follow-up\n");
  const second = await turn(); assert.equal(second.integrity, undefined); assert.equal(second.pushed, undefined); assert.match(second.pushError!, /fewer|2.*1|1.*2/); assert.equal(git(origin, "rev-parse", "feature"), base);
  manager.watchPr(run.id, { branch, agent: "codex" }); await new PrWatcher(manager).poll(); assert.equal(run.watches[branch]!.state, "needs-you");
});

test("poll failures survive watcher restart, recover, and do not revive manual needs-you or Stop", async () => {
  const { manager, run, branch } = await fixture(); manager.watchPr(run.id, { branch, agent: "codex" });
  const watcher = new PrWatcher(manager, 1000), now = Date.now(); change(s => s.failAll = "offline fixture");
  await watcher.poll(now); await watcher.poll(now + 1000); await watcher.poll(now + 3000);
  assert.equal(run.watches[branch]!.state, "needs-you"); assert.equal(run.watches[branch]!.pollFailures, 3); await watcher.stop();
  change(s => delete s.failAll); const restarted = new PrWatcher(manager, 1000); await restarted.poll(now + 7000);
  assert.equal(run.watches[branch]!.state, "green"); assert.equal(run.watches[branch]!.pollFailures, undefined);
  manager.updateWatch(run.id, branch, { state: "needs-you", detail: "Couldn't check the PR 3 times in a row: legacy offline", lastPolled: now });
  await new PrWatcher(manager, 1000).poll(now + 10000); assert.equal(run.watches[branch]!.state, "green", "legacy persisted failure detail recovers too");
  manager.updateWatch(run.id, branch, { state: "needs-you", detail: "Review blocked changes" }); await new PrWatcher(manager, 1000).poll(now + 10000); assert.equal(run.watches[branch]!.detail, "Review blocked changes");
  manager.updateWatch(run.id, branch, { pollFailures: 3 }); manager.unwatchPr(run.id, branch); await new PrWatcher(manager, 1000).poll(now + 20000); assert.equal(run.watches[branch]!.state, "stopped"); assert.equal(run.watches[branch]!.pollFailures, undefined);
});

test("inline comments have truthful logs and only allowed authors trigger located follow-ups", async () => {
  const { manager, run, branch } = await fixture(); const watch = manager.watchPr(run.id, { branch, agent: "codex", allow: ["bob"] });
  change(s => s.prs[1].inlineComments = ["bob", "mallory"].map((login, i) => ({ id: i + 1, user: { login }, body: `finding ${login}`, created_at: new Date(watch.startedAt + 1000).toISOString(), path: "README.md", line: null, original_line: 3, side: "RIGHT" })));
  const calls: any[] = []; manager.followUp = (async (_id, input) => { calls.push(input); return run; });
  await new PrWatcher(manager).poll(); assert.equal(calls.length, 1); assert.match(calls[0].message, /README.md:3 \(right side\) \[outdated diff\]/); assert.match(calls[0].message, /Thread: review-thread:1/); assert.doesNotMatch(calls[0].message, /finding mallory/);
  const log = (await manager.events(run.id)).filter(e => e.type === "log").map(e => e.type === "log" ? e.text : "").join("\n"); assert.match(log, /inline review comments reach/); assert.doesNotMatch(log, /aren't read yet/);
  manager.watchPr(run.id, { branch, agent: "codex" }); change(s => s.prs[1].inlineComments = Array.from({ length: 1000 }, (_, i) => ({ id: i, user: { login: "me" }, body: "bounded", created_at: new Date().toISOString() })));
  await new PrWatcher(manager).poll(); assert.match(run.watches[branch]!.detail, /1,000 inline/); assert.equal(calls.length, 1);
});

test("Stop during a poll cannot launch a fix, and rearm bypasses an old quiet timer", async () => {
  const { manager, run, branch } = await fixture(); let calls = 0;
  manager.followUp = async () => { calls++; return run; };
  let watch = manager.watchPr(run.id, { branch, agent: "codex" });
  change(s => s.prs[1].comments = [{ id: "late", author: { login: "me" }, body: "fix this", createdAt: new Date(watch.startedAt + 100).toISOString() }]);
  const log = manager.log.bind(manager); manager.log = (id, text, level) => { log(id, text, level); manager.unwatchPr(id, branch); };
  await new PrWatcher(manager, 1000).poll(); assert.equal(calls, 0); assert.equal(run.watches[branch]!.state, "stopped");
  manager.log = log; change(s => s.prs[1].comments = []); manager.watchPr(run.id, { branch, agent: "codex" });
  const watcher = new PrWatcher(manager, 1000), now = Date.now(); await watcher.poll(now); await watcher.poll(now + 1000); await watcher.poll(now + 3000);
  manager.unwatchPr(run.id, branch); watch = manager.watchPr(run.id, { branch, agent: "codex" }); await watcher.poll(now + 3001); assert.equal(watch.state, "green", "old quiet backoff cannot delay a new watch");
});

test("external merge reads persist one merge, close the watch and forbid rearm; closed PRs reopen", async () => {
  // Delivery operates on a materialized result, not an unchanged conversational turn.
  const { manager, run, branch } = await fixture(undefined, true); assert.ok(run.artifacts.some(artifact => artifact.branch === branch)); manager.watchPr(run.id, { branch, agent: "codex" }); change(s => s.prs[1].state = "CLOSED");
  await new PrWatcher(manager).poll(); assert.equal(run.watches[branch]!.state, "closed"); assert.equal(run.merges.length, 0);
  change(s => s.prs[1].state = "OPEN"); manager.watchPr(run.id, { branch, agent: "codex" }); await new PrWatcher(manager).poll(); assert.equal(run.watches[branch]!.state, "green");
  change(s => s.prs[1].state = "MERGED"); await new PrWatcher(manager).poll(); await manager.prMergeInfo(run.id, branch); await manager.resultDelivery(run.id, branch);
  assert.equal(run.merges.length, 1); assert.equal(run.merges[0]!.pr, run.prs[branch]); assert.equal(run.watches[branch]!.state, "closed"); assert.throws(() => manager.watchPr(run.id, { branch, agent: "codex" }), /merged/);
  await manager.shutdown(); const restored = new RunManager(findPattern); managers.push(restored); await restored.load(); assert.equal(restored.get(run.id)!.merges.length, 1);
});

const review = (markdown: string): NonNullable<Run["review"]> => ({ verdict: "approve", summary: markdown, findings: [], reviewers: [], markdown });
test("review posting is idempotent for simultaneous and later requests and retryable after failure", async () => {
  const { manager, run } = await fixture(); run.review = review("Council review A");
  assert.deepEqual(await Promise.all([manager.postReview(run.id), manager.postReview(run.id)]), [run.source!.url, run.source!.url]); await manager.postReview(run.id); assert.equal(state().prs[1].comments.length, 1);
  run.review = review("Council review B"); change(s => s.commentError = true); await assert.rejects(manager.postReview(run.id), /permission denied/); assert.equal(run.review.postedTo, undefined);
  change(s => delete s.commentError); await manager.postReview(run.id); assert.equal(state().prs[1].comments.length, 2);
});

test("a new council result is never marked posted by an older in-flight review", async () => {
  const { manager, run } = await fixture(); const old = review("Old review"); run.review = old; const posting = manager.postReview(run.id); run.review = review("New review"); await assert.rejects(manager.postReview(run.id), /previous review is still being posted/); await posting;
  assert.equal(old.postedTo, run.source!.url); assert.equal(run.review.postedTo, undefined); assert.match(state().prs[1].comments[0].body, /Old review/); await manager.postReview(run.id); assert.match(state().prs[1].comments[1].body, /New review/);
});

test("evidence fingerprints follow included blobs and source pushes only comment on changed evidence", async () => {
  const { manager, run, repo, base, branch, tree } = await fixture(); const dir = join(tree.path, ".codeflow/evidence"); mkdirSync(dir, { recursive: true });
  const commit = (message: string) => { git(tree.path, "add", "."); git(tree.path, "commit", "-qm", message); };
  writeFileSync(join(dir, "screen.png"), "fake png fixture"); writeFileSync(join(dir, "README.md"), "Capture steps\n"); commit("capture");
  const first = await visualEvidenceFiles(repo, base, branch); await manager.pushToPr(run.id, { branch }); assert.equal(state().prs[1].comments.length, 1);
  writeFileSync(join(tree.path, "README.md"), "Unrelated source update\n"); commit("source"); const next = await visualEvidenceFiles(repo, base, branch); assert.notEqual(first.head, next.head); assert.equal(first.fingerprint, next.fingerprint); run.visualEvidencePosted![branch] = first.head; await manager.pushToPr(run.id, { branch }); assert.equal(state().prs[1].comments.length, 1);
  writeFileSync(join(dir, "README.md"), "Updated capture results\n"); commit("evidence changed"); change(s => s.commentError = true); assert.match((await manager.pushToPr(run.id, { branch })).warning!, /could not be added/); change(s => delete s.commentError); await manager.pushToPr(run.id, { branch }); assert.equal(state().prs[1].comments.length, 2);
  await manager.pullRequest(run.id, { branch, into: "main" }); assert.equal(state().prs[1].comments.length, 2, "existing PR publish is deduplicated too");
});

test("visual guidance requires a capture request, not product media vocabulary", () => {
  for (const prompt of ["Fix video player controls", "Add video upload endpoint", "Add video support", "Fix screenshot button crash", "Fix screenshot export endpoint", "Include video player controls", "Show the flow diagram"]) assert.equal(wantsVisualEvidence(prompt), false, prompt);
  for (const prompt of ["Attach a short video of this flow to the PR", "Add screenshots of the new dialog to the PR", "Test this flow and attach screenshots and a screen recording", "Add visual evidence", "Record the browser flow", "Take a screenshot of the page"]) assert.equal(wantsVisualEvidence(prompt), true, prompt);
});
