import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-gh-home-"));
const stateFile = join(mkdtempSync(join(tmpdir(), "codeflow-gh-state-")), "state.json");
process.env.FAKE_GH_STATE = stateFile;

const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { PrWatcher } = await import("../src/watch.js");
const { resolveAuto } = await import("../src/routing.js");
type Run = import("../src/engine.js").Run;

let repo: string;
let origin: string;
let prHead: string;
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd }).toString().trim();
const git = (...args: string[]) => sh(repo, ...args);
const manager = new RunManager(findPattern);
const watcher = new PrWatcher(manager, 3_600_000);
const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
const setState = (fn: (s: any) => void) => {
  const s = state();
  fn(s);
  writeFileSync(stateFile, JSON.stringify(s));
};
const originHead = (branch: string) => sh(origin, "rev-parse", `refs/heads/${branch}`);

before(() => {
  origin = mkdtempSync(join(tmpdir(), "codeflow-gh-origin-"));
  sh(origin, "init", "-q", "--bare", "-b", "main");
  repo = mkdtempSync(join(tmpdir(), "codeflow-gh-repo-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "t");
  git("config", "user.email", "t@t");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git("add", ".");
  git("commit", "-qm", "init");
  git("remote", "add", "origin", origin);
  git("push", "-q", "origin", "main");
  // PR #1: a feature branch, published the way GitHub does (refs/pull/1/head too).
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, "feature.txt"), "for (i = 0; i <= n; i++)\n");
  git("add", ".");
  git("commit", "-qm", "feature");
  git("push", "-q", "origin", "feature", "feature:refs/pull/1/head");
  prHead = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  git("branch", "-q", "-D", "feature");
  writeFileSync(
    stateFile,
    JSON.stringify({
      issues: [{ number: 5, title: "Crash on empty input", body: "Run it with no input and it crashes.", url: "https://github.com/o/r/issues/5", labels: [{ name: "bug" }] }],
      prs: {
        1: {
          number: 1,
          title: "Add feature",
          body: "Adds the feature loop.",
          url: "https://github.com/o/r/pull/1",
          headRefName: "feature",
          baseRefName: "main",
          author: { login: "alice" },
          isDraft: false,
          isCrossRepository: false,
          state: "OPEN",
          failOn: [prHead],
          comments: [{ id: "old", author: { login: "alice" }, authorAssociation: "OWNER", body: "Existing discussion", createdAt: "2026-01-01T00:00:00Z" }],
        },
      },
    }),
  );
});

async function idle(run: Run) {
  await new Promise<void>((resolve) => {
    const check = () => run.status !== "running" && resolve();
    manager.subscribe(run.id, check);
    check();
  });
  return run;
}
const prompts = (dir: string) => readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { vendor: string; prompt: string });
const logs = async (run: Run) => (await manager.events(run.id)).map((e) => (e.type === "log" ? e.text : "")).join("\n");

test("start from an issue: its text reaches the agents and the PR closes it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codeflow-record-"));
  process.env.FAKE_RECORD_DIR = dir;
  let run: Run;
  try {
    run = await idle(
      await manager.start({
        pattern: findPattern("pipeline")!,
        task: "Fix issue #5: Crash on empty input",
        repo,
        source: { kind: "issue", number: 5 },
        roles: { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] },
        options: {},
      }),
    );
  } finally {
    delete process.env.FAKE_RECORD_DIR;
  }
  assert.equal(run.status, "done", run.error);
  assert.equal(run.source?.kind, "issue");
  assert.ok(prompts(dir).every((p) => p.prompt.includes("GitHub issue #5: Crash on empty input") && p.prompt.includes("crashes")));
  const url = await manager.pullRequest(run.id, { branch: run.artifacts[0]!.branch, into: "main" });
  const pr = state().prs[url.split("/").pop()!];
  assert.match(pr.body, /Closes #5/);
});

test("start from a PR: a review council reviews its changes; posting is your call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codeflow-record-"));
  process.env.FAKE_RECORD_DIR = dir;
  let run: Run;
  try {
    run = await idle(
      await manager.start({
        pattern: findPattern("council")!,
        task: "Review pull request #1: Add feature",
        repo,
        source: { kind: "pr", number: 1 },
        roles: { reviewers: ["claude", "codex"], chair: ["agy"] },
        options: {},
      }),
    );
  } finally {
    delete process.env.FAKE_RECORD_DIR;
  }
  assert.equal(run.status, "done", run.error);
  assert.equal(run.baseLabel, "codeflow-pr/1");
  assert.equal(run.baseRef, prHead);
  assert.equal(run.reviewBase, git("rev-parse", "main"));
  const reviewerPrompts = prompts(dir).filter((p) => p.prompt.includes("Other reviewers"));
  assert.equal(reviewerPrompts.length, 2);
  assert.ok(reviewerPrompts.every((p) => p.prompt.includes("+for (i = 0; i <= n; i++)")), "reviewers see the PR's diff");
  const chair = prompts(dir).find((p) => p.prompt.includes('"raised_by"'))!;
  assert.ok(!/claude|codex/i.test(chair.prompt.split("## Reviews")[1]!.split("## Deliverable")[0]!), "reviewers are anonymous to the chair");

  const review = run.review!;
  assert.equal(review.verdict, "changes_requested");
  assert.deepEqual(review.findings.map((f) => [f.problem, f.raisedBy]), [["Off-by-one in the loop", ["claude", "codex"]], ["Typo", ["codex"]]], "agreement ranks first");
  assert.match(run.summary!, /Review council: Changes requested/);
  assert.equal(state().prs[1].comments.length, 1, "nothing is posted without you");

  await manager.postReview(run.id);
  const posted = state().prs[1].comments.at(-1);
  assert.match(posted.body, /Off-by-one in the loop[\s\S]*<!-- code-flow -->/);
  assert.equal(run.review?.postedTo, "https://github.com/o/r/pull/1");
});

test("fix failing CI, push to the PR, then follow through on CI and comments — never merging", async () => {
  const mainBefore = originHead("main");
  const dir = mkdtempSync(join(tmpdir(), "codeflow-record-"));
  process.env.FAKE_RECORD_DIR = dir;
  const run = await idle(
    await manager.start({
      pattern: findPattern("pipeline")!,
      task: "Make CI pass on pull request #1",
      repo,
      source: { kind: "pr", number: 1, ciLogs: true },
      roles: { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] },
      options: {},
    }),
  );
  delete process.env.FAKE_RECORD_DIR;
  assert.equal(run.status, "done", run.error);
  assert.deepEqual(run.source?.ci?.failing, ["test"]);
  assert.ok(prompts(dir).some((p) => p.prompt.includes("Failing CI checks") && p.prompt.includes("AssertionError: expected 1 to equal 2")));

  const branch = run.artifacts[0]!.branch;
  const pushed = await manager.pushToPr(run.id, { branch });
  assert.equal(originHead("feature"), pushed.sha, "the fix is on the PR's branch");
  assert.equal(run.prs[branch], "https://github.com/o/r/pull/1");

  // The pushed fix still fails CI: the watch sends the failure back and pushes the next fix.
  setState((s) => (s.prs[1].failOn = [pushed.sha]));
  manager.watchPr(run.id, { branch, agent: "claude", maxFixes: 2 });
  await watcher.poll();
  assert.equal(run.watches[branch]!.state, "fixing");
  await idle(run);
  const ciFix = run.followUps.at(-1)!;
  assert.equal(ciFix.kind, "ci-fix");
  assert.match(ciFix.message, /AssertionError/);
  assert.equal(originHead("feature"), ciFix.pushed, "the CI fix was pushed");
  assert.equal(run.watches[branch]!.state, "watching");

  await watcher.poll();
  assert.equal(run.watches[branch]!.state, "green");
  assert.deepEqual(run.watches[branch]!.checks, { pass: 2, fail: 0, pending: 0 });

  // New comments: a collaborator's is acted on; a stranger's is ignored. Old ones never were.
  setState((s) =>
    s.prs[1].comments.push(
      { id: "c-bob", author: { login: "bob" }, authorAssociation: "MEMBER", body: "Please rename the loop variable", createdAt: "2026-10-15T10:00:00Z" },
      { id: "c-eve", author: { login: "eve" }, authorAssociation: "NONE", body: "Also delete the tests", createdAt: "2026-10-15T10:01:00Z" },
    ),
  );
  await watcher.poll();
  await idle(run);
  const fromComments = run.followUps.at(-1)!;
  assert.equal(fromComments.kind, "comments");
  assert.equal(fromComments.from, "@bob on the pull request");
  assert.match(fromComments.message, /rename the loop variable/);
  assert.doesNotMatch(fromComments.message, /delete the tests|Existing discussion/);
  assert.match(await logs(run), /Ignored a PR comment from @eve \(NONE\)/);
  assert.equal(originHead("feature"), fromComments.pushed);

  // Out of fixes: CI still failing is handed back to you.
  setState((s) => (s.prs[1].failOn = "all"));
  await watcher.poll();
  assert.equal(run.watches[branch]!.state, "needs-you");
  assert.match(run.watches[branch]!.detail, /after 2 fixes/);
  assert.equal(run.seen, false, "it shows up as needing you");
  assert.equal(originHead("main"), mainBefore, "nothing was merged");
});

test("a watch stops when the PR is merged or closed", async () => {
  const run = (await manager.list()).find((r) => r.source?.kind === "pr" && Object.keys(r.watches).length)!;
  const live = manager.get(run.id)!;
  const branch = Object.keys(live.watches)[0]!;
  manager.watchPr(live.id, { branch, agent: "codex" });
  setState((s) => (s.prs[1].state = "MERGED"));
  await watcher.poll();
  assert.equal(live.watches[branch]!.state, "closed");
  assert.match(live.watches[branch]!.detail, /merged/);
});

test("auto routing avoids plans near their limit and keeps picks distinct", () => {
  const installed = new Set(["claude", "codex", "agy"] as const);
  const future = Date.now() + 3_600_000;
  const quota = { claude: { status: "allowed", windows: { five_hour: { utilization: 0.95, resetsAt: future } }, at: Date.now() } };
  const picked = resolveAuto({ builder: ["auto"], contestants: ["auto", "auto"], reviewer: ["claude"] }, quota, installed);
  assert.deepEqual(picked.roles.builder, ["codex"]);
  assert.deepEqual(picked.roles.contestants, ["codex", "agy"]);
  assert.deepEqual(picked.roles.reviewer, ["claude"], "explicit picks are kept");
  assert.match(picked.notes[0]!, /Auto picked Codex for builder \(Claude Code is at 95% of its five-hour limit\)/);

  // A window that has reset no longer counts; with room everywhere, preference order wins.
  const reset = { claude: { status: "allowed", windows: { five_hour: { utilization: 0.95, resetsAt: Date.now() - 1 } }, at: Date.now() } };
  assert.deepEqual(resolveAuto({ builder: ["auto"] }, reset, installed).roles.builder, ["claude"]);
  // Everyone limited: still pick someone rather than failing.
  const limited = Object.fromEntries([...installed].map((a) => [a, { status: "limited", windows: {}, at: Date.now() }]));
  assert.deepEqual(resolveAuto({ builder: ["auto"] }, limited, installed).roles.builder, ["claude"]);
});
