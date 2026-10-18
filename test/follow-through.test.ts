// PR follow-through pushes fixes nobody reviews first: a fix that touches the tests at all — their
// config, a CI workflow, fewer of them running — waits for you instead of going out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-follow-home-"));

const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
type Run = import("../src/engine.js").Run;
type Manager = InstanceType<typeof RunManager>;

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd }).toString().trim();

/** A check that counts each t-*.txt as a passing test, in node --test's words. */
const CHECK = 'n=$(ls t-*.txt | wc -l | tr -d " "); echo "# pass $n"; echo "# fail 0"';

/** A repo with an origin to push to: three "tests" the check counts, and a CI workflow. */
function newRepo() {
  const origin = mkdtempSync(join(tmpdir(), "codeflow-follow-origin-"));
  sh(origin, "init", "-q", "--bare", "-b", "main");
  const repo = mkdtempSync(join(tmpdir(), "codeflow-follow-repo-"));
  sh(repo, "init", "-q", "-b", "main");
  for (const n of [1, 2, 3]) writeFileSync(join(repo, `t-${n}.txt`), `test ${n}\n`);
  mkdirSync(join(repo, ".github/workflows"), { recursive: true });
  writeFileSync(join(repo, ".github/workflows/ci.yml"), "jobs:\n  test:\n    runs-on: ubuntu-latest\n  lint:\n    runs-on: ubuntu-latest\n");
  sh(repo, "add", "-A");
  sh(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  sh(repo, "remote", "add", "origin", origin);
  sh(repo, "push", "-q", "origin", "main");
  return { repo, origin };
}

async function idle(manager: Manager, run: Run) {
  await new Promise<void>((resolve) => {
    const check = () => run.status !== "running" && resolve();
    manager.subscribe(run.id, check);
    check();
  });
  return run;
}

/** A finished run, then the fix a PR watch sends when CI fails on it (as watch.ts does), made the way FAKE_CI_TAMPER says. */
async function fixCi(tamper?: "workflow" | "fewer") {
  const { repo, origin } = newRepo();
  const manager = new RunManager(findPattern);
  const run = await idle(manager, await manager.start({ pattern: findPattern("solo")!, task: "Fix CI", repo, roles: { agent: ["claude"] }, options: {}, loop: { check: CHECK } }));
  assert.equal(run.status, "done", run.error);
  const wt = run.worktrees[0]!;
  if (tamper) process.env.FAKE_CI_TAMPER = tamper;
  try {
    await manager.followUp(run.id, { kind: "ci-fix", worktree: wt.name, agent: "claude", message: "Failing checks:\n- test", push: "feature", watch: wt.branch });
    await idle(manager, run);
  } finally {
    delete process.env.FAKE_CI_TAMPER;
  }
  assert.equal(run.status, "done", run.error);
  const fix = run.followUps.at(-1)!;
  assert.equal(fix.kind, "ci-fix");
  assert.ok(fix.commit, "the fix was committed");
  return { run, fix, branch: wt.branch, pushedTo: () => sh(origin, "branch", "--list", "feature") };
}

test("an honest CI fix is pushed", async () => {
  const { fix, pushedTo } = await fixCi();
  assert.equal(fix.integrity, undefined);
  assert.equal(fix.pushError, undefined);
  assert.ok(fix.pushed);
  assert.match(pushedTo(), /feature/);
});

test("a CI fix that comments out the failing workflow job isn't pushed, though a workflow change is only a medium issue", async () => {
  const { fix, pushedTo } = await fixCi("workflow");
  assert.deepEqual(fix.integrity?.map((i) => `${i.kind}|${i.file}|${i.severity}|${i.detail}`), ["test-config|.github/workflows/ci.yml|medium|CI workflow changed"]);
  assert.equal(fix.checkPassed, true, "the local check passes either way");
  assert.equal(fix.pushed, undefined);
  assert.match(fix.pushError!, /changes tests, their config or CI, and nobody has reviewed that/);
  assert.equal(pushedTo(), "", "nothing reached the PR's branch");
});

test("a CI fix that makes fewer tests run isn't pushed: the follow-up compares with the count the run kept for the branch", async () => {
  const { run, fix, branch, pushedTo } = await fixCi("fewer");
  // Nothing about it looks like a test change but the count: the run's check ran 3 before the fix, 2 after.
  assert.deepEqual(fix.integrity?.map((i) => `${i.kind}|${i.severity}|${i.detail}`), ["fewer-tests|high|3 tests ran before, 2 after"]);
  assert.equal(run.testCounts?.[branch]?.first.tests, 3);
  assert.equal(run.testCounts?.[branch]?.last.tests, 2);
  assert.equal(run.testCounts?.[branch]?.last.head, fix.commit);
  assert.equal(fix.pushed, undefined);
  assert.ok(fix.pushError);
  assert.equal(pushedTo(), "");
});
