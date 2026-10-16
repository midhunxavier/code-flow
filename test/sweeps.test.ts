import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-sweep-home-"));
const stateFile = join(mkdtempSync(join(tmpdir(), "codeflow-sweep-state-")), "state.json");
process.env.FAKE_GH_STATE = stateFile;

const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { listSweep, runSweep, nextSweepItems, coveringRun, sourceKeys } = await import("../src/sweeps.js");
const { ciState, loadSource, sourcePrompt } = await import("../src/github.js");
const { Automations, readWebhook } = await import("../src/automation.js");
const { repoRoot } = await import("../src/git.js");
type Run = import("../src/engine.js").Run;
type SweepRequestItem = import("../src/sweeps.js").SweepRequestItem;

let repo: string;
let origin: string;
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd }).toString().trim();
const git = (...args: string[]) => sh(repo, ...args);
const manager = new RunManager(findPattern);
const team = { planner: ["claude" as const], builder: ["codex" as const], reviewer: ["claude" as const] };
const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
const setState = (fn: (s: any) => void) => {
  const s = state();
  fn(s);
  writeFileSync(stateFile, JSON.stringify(s));
};

const advisory = (n: number, name: string, severity: string, range: string, fixed: string | null, summary: string) => ({
  number: n,
  state: "open",
  html_url: `https://github.com/o/r/security/dependabot/${n}`,
  dependency: { package: { ecosystem: "npm", name }, manifest_path: "package.json" },
  security_advisory: { ghsa_id: `GHSA-${n}`, cve_id: `CVE-2026-${n}`, summary, description: `${summary}. Details for ${name}.`, severity },
  security_vulnerability: { package: { ecosystem: "npm", name }, vulnerable_version_range: range, first_patched_version: fixed ? { identifier: fixed } : null },
});

before(() => {
  origin = mkdtempSync(join(tmpdir(), "codeflow-sweep-origin-"));
  sh(origin, "init", "-q", "--bare", "-b", "main");
  repo = mkdtempSync(join(tmpdir(), "codeflow-sweep-repo-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "t");
  git("config", "user.email", "t@t");
  writeFileSync(join(repo, "package.json"), '{ "name": "app", "dependencies": { "lodash": "4.17.15", "axios": "0.21.0" } }\n');
  git("add", ".");
  git("commit", "-qm", "init");
  git("remote", "add", "origin", origin);
  git("push", "-q", "origin", "main");
  // Dependabot's PR #7 bumps axios; its branch is published the way GitHub does.
  git("checkout", "-q", "-b", "dependabot/npm_and_yarn/axios-1.7.4");
  writeFileSync(join(repo, "package.json"), '{ "name": "app", "dependencies": { "lodash": "4.17.15", "axios": "1.7.4" } }\n');
  git("commit", "-qam", "Bump axios from 0.21.0 to 1.7.4");
  git("push", "-q", "origin", "dependabot/npm_and_yarn/axios-1.7.4", "dependabot/npm_and_yarn/axios-1.7.4:refs/pull/7/head");
  git("checkout", "-q", "main");
  git("branch", "-q", "-D", "dependabot/npm_and_yarn/axios-1.7.4");
  const pr = (number: number, title: string, headRefName: string, extra: object) => ({
    number,
    title,
    body: `Bumps ${title}.`,
    url: `https://github.com/o/r/pull/${number}`,
    headRefName,
    baseRefName: "main",
    author: { login: "app/dependabot" },
    authorAssociation: "NONE",
    isDraft: false,
    isCrossRepository: false,
    state: "OPEN",
    comments: [],
    ...extra,
  });
  writeFileSync(
    stateFile,
    JSON.stringify({
      issues: [
        { number: 11, title: "Login fails with an empty password", body: "Steps: submit an empty password.", url: "https://github.com/o/r/issues/11", labels: [{ name: "bug" }] },
        { number: 12, title: "How do I configure the port?", body: "Question.", url: "https://github.com/o/r/issues/12", labels: [{ name: "question" }] },
        { number: 13, title: "Dates show in UTC", body: "Should be local time.", url: "https://github.com/o/r/issues/13", labels: [] },
      ],
      prs: {
        7: pr(7, "Bump axios from 0.21.0 to 1.7.4", "dependabot/npm_and_yarn/axios-1.7.4", { failOn: "all" }),
        8: pr(8, "Bump eslint from 8.0.0 to 9.0.0", "dependabot/npm_and_yarn/eslint-9.0.0", {}),
        9: pr(9, "Bump vite from 5.0.0 to 5.4.0", "dependabot/npm_and_yarn/vite-5.4.0", { pending: true }),
        10: { ...pr(10, "Add dark mode", "dark-mode", {}), author: { login: "alice" }, authorAssociation: "OWNER" },
      },
      dependabotAlerts: [
        advisory(3, "lodash", "high", "< 4.17.21", "4.17.21", "Command injection in lodash"),
        advisory(4, "lodash", "medium", "< 4.17.19", "4.17.19", "Prototype pollution in lodash"),
        advisory(5, "axios", "high", "< 1.6.0", "1.6.0", "CSRF in axios"),
        advisory(6, "left-pad", "low", "<= 1.3.0", null, "Ancient left-pad"),
      ],
      codeScanningAlerts: [
        {
          number: 21,
          state: "open",
          html_url: "https://github.com/o/r/security/code-scanning/21",
          rule: { id: "js/sql-injection", severity: "error", security_severity_level: "high", description: "Database query built from user-controlled sources", full_description: "Building a SQL query from user input is vulnerable to injection." },
          tool: { name: "CodeQL" },
          most_recent_instance: { location: { path: "src/db.js", start_line: 42 }, message: { text: "This query depends on a user-provided value." } },
        },
        {
          number: 22,
          state: "open",
          html_url: "https://github.com/o/r/security/code-scanning/22",
          rule: { id: "js/unused-local-variable", severity: "note", description: "Unused variable" },
          tool: { name: "CodeQL" },
          most_recent_instance: { location: { path: "src/util.js", start_line: 3 }, message: { text: "Unused variable x." } },
        },
      ],
      secretAlerts: [{ number: 31, state: "open", secret_type: "aws_access_key_id", secret_type_display_name: "AWS Access Key ID", html_url: "https://github.com/o/r/security/secret-scanning/31" }],
    }),
  );
});

async function finished(run: Run) {
  await new Promise<void>((resolve) => {
    // endedAt is set last, after the inbox bookkeeping.
    const check = () => run.status !== "running" && run.endedAt !== undefined && resolve();
    manager.subscribe(run.id, check);
    check();
  });
  return run;
}

test("CI state: any failure fails, anything unfinished is pending, nothing is none", () => {
  assert.equal(ciState([]), "none");
  assert.equal(ciState([{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "SUCCESS" }]), "pass");
  assert.equal(ciState([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "IN_PROGRESS", conclusion: "" }]), "pending");
  assert.equal(ciState([{ status: "IN_PROGRESS" }, { status: "COMPLETED", conclusion: "FAILURE" }]), "fail");
  assert.equal(ciState([{ state: "ERROR" }]), "fail");
});

test("issues sweep: every open issue is listed; questions and the like start unpicked", async () => {
  const list = await listSweep(repo, "issues", []);
  assert.deepEqual(
    list.items.map((i) => [i.key, i.selected]),
    [
      ["issue#11", true],
      ["issue#12", false],
      ["issue#13", true],
    ],
  );
  assert.match(list.items[1]!.note!, /question/);
  // The title is the issue author's: it reaches the agents with the issue's text, not in the task.
  assert.equal(list.items[0]!.task, "Fix issue #11. Add a test that fails without the fix.");
  assert.equal(list.items[0]!.title, "Login fails with an empty password");
  assert.deepEqual(list.items[0]!.source, { kind: "issue", number: 11 });
  assert.deepEqual(list.notices, []);
});

test("sweeps read past GitHub's first page, and say when there were more than they list", async () => {
  const saved = state();
  setState((s) => {
    s.issues = Array.from({ length: 1_005 }, (_, i) => ({ number: 1_000 + i, title: `Issue ${i}`, body: "", url: `https://github.com/o/r/issues/${1_000 + i}`, labels: [] }));
    s.codeScanningAlerts = Array.from({ length: 150 }, (_, i) => ({ number: 500 + i, state: "open", html_url: "", rule: { id: "x", severity: "note" }, most_recent_instance: { location: {} } }));
  });
  try {
    const issues = await listSweep(repo, "issues", []);
    assert.equal(issues.items.length, 1_000);
    assert.match(issues.notices[0]!, /Only the first 1000 open issues are listed/);
    const alerts = await listSweep(repo, "alerts", []);
    assert.equal(alerts.items.filter((i) => i.key.startsWith("code-scanning#")).length, 150, "every page of alerts, not just the first 100");
    assert.deepEqual(alerts.notices, []);
  } finally {
    writeFileSync(stateFile, JSON.stringify(saved));
  }
});

test("Dependabot sweep: only Dependabot's PRs; only failing ones are picked, green ones wait for you", async () => {
  const list = await listSweep(repo, "dependabot", []);
  const by = Object.fromEntries(list.items.map((i) => [i.key, i]));
  assert.deepEqual(Object.keys(by).sort(), ["pr#7", "pr#8", "pr#9"]);
  assert.equal(by["pr#7"]!.selected, true);
  assert.deepEqual(by["pr#7"]!.source, { kind: "pr", number: 7, ciLogs: true });
  assert.match(by["pr#7"]!.task!, /Make CI pass on Dependabot's pull request #7/);
  assert.equal(by["pr#8"]!.selected, false);
  assert.match(by["pr#8"]!.note!, /ready for you to merge/);
  assert.equal(by["pr#9"]!.selected, false);
  assert.match(by["pr#9"]!.note!, /still running/);
});

test("alerts sweep: Dependabot alerts per package, code scanning per alert, secrets only for you", async () => {
  const list = await listSweep(repo, "alerts", []);
  assert.deepEqual(list.notices, []);
  const by = Object.fromEntries(list.items.map((i) => [i.key, i]));
  // Two lodash alerts become one item that upgrades past both; it's keyed by alert number.
  const lodash = by["dependabot#3"]!;
  assert.equal(lodash.title, "lodash (npm)");
  assert.equal(lodash.ref, "2 alerts");
  assert.equal(lodash.severity, "high");
  assert.deepEqual(lodash.source, { kind: "alert", tool: "dependabot", number: 3, numbers: [3, 4] });
  assert.equal(lodash.legacyKey, "dependabot:npm/lodash");
  assert.equal(lodash.selected, true);
  assert.match(lodash.task!, /Fix 2 Dependabot alerts in lodash \(npm\): upgrade it to 4\.17\.21 or later in package\.json/);
  // Dependabot's open PR already upgrades axios; left-pad has no fix yet.
  assert.equal(by["dependabot#5"]!.selected, false);
  assert.match(by["dependabot#5"]!.note!, /Dependabot PR #7 already upgrades it/);
  assert.equal(by["dependabot#6"]!.selected, false);
  assert.match(by["dependabot#6"]!.task!, /Mitigate Dependabot alert #6/);
  // Code scanning: the injection is picked, the style note isn't.
  assert.equal(by["code-scanning#21"]!.selected, true);
  assert.match(by["code-scanning#21"]!.task!, /Fix code scanning alert #21: Database query built from user-controlled sources in src\/db\.js:42/);
  assert.equal(by["code-scanning#22"]!.selected, false);
  // A leaked secret is listed, never picked, and has nothing to hand an agent.
  const secret = by["secret#31"]!;
  assert.equal(secret.manual, true);
  assert.equal(secret.selected, false);
  assert.equal(secret.source, undefined);
  // Most severe first.
  assert.equal(list.items[0]!.severity, "critical");
});

test("alerts sweep: a part GitHub won't list says why, and the rest still lists", async () => {
  setState((s) => (s.alertErrors = ["code-scanning", "secret-scanning"]));
  try {
    const list = await listSweep(repo, "alerts", []);
    assert.ok(list.items.some((i) => i.key === "dependabot#3"));
    assert.ok(!list.items.some((i) => i.key.startsWith("code-scanning") || i.key.startsWith("secret")));
    assert.equal(list.notices.length, 2);
    assert.match(list.notices[0]!, /Code scanning alerts aren't turned on/);
    assert.match(list.notices[1]!, /gh auth refresh -s security_events/);
  } finally {
    setState((s) => delete s.alertErrors);
  }
});

test("an alert's details reach the agents as information, not instructions", async () => {
  const { source } = await loadSource(repo, { kind: "alert", tool: "dependabot", number: 3, numbers: [3, 4] });
  assert.equal(source.trusted, true);
  assert.equal(source.alert?.patched, "4.17.21");
  assert.equal(source.alert?.severity, "high");
  const prompt = sourcePrompt(source);
  assert.match(prompt, /## Dependabot alerts #3, #4: lodash: 2 vulnerabilities/);
  assert.match(prompt, /Package `lodash` \(npm, `package\.json`\), severity high: vulnerable `< 4\.17\.21`, fixed in `4\.17\.21`/);
  assert.match(prompt, /Command injection in lodash/);
  assert.doesNotMatch(prompt, /outside this repository's maintainers/);

  const scan = sourcePrompt((await loadSource(repo, { kind: "alert", tool: "code-scanning", number: 21 })).source);
  assert.match(scan, /## Code scanning alert #21: Database query built from user-controlled sources/);
  assert.match(scan, /Rule `js\/sql-injection` \(high\) at `src\/db\.js:42`/);
  assert.match(scan, /This query depends on a user-provided value/);
});

test("runSweep: one run per item, in your order; covered items are skipped and failures reported", async () => {
  const started: string[] = [];
  const items: SweepRequestItem[] = [
    { key: "issue#11", task: "a", source: { kind: "issue", number: 11 } },
    { key: "issue#13", task: "b", source: { kind: "issue", number: 13 } },
    { key: "issue#11", task: "a", source: { kind: "issue", number: 11 } }, // picked twice: started once
    { key: "pr#7", task: "c", source: { kind: "pr", number: 7, ciLogs: true } },
  ];
  // Runs record the repo's resolved root (on macOS /private/var/…, not /var/…).
  const root = await repoRoot(repo);
  const covering = { id: "r-old", repo: root, archived: false, status: "done", source: { kind: "pr", number: 7 } } as unknown as Run;
  const outcome = await runSweep({
    repo,
    items,
    runs: [covering],
    concurrency: 3,
    start: async (item) => {
      if (item.key === "issue#13") throw new Error("Docker isn't installed");
      started.push(item.key);
      return { id: `r-${item.key}` };
    },
  });
  assert.deepEqual(started, ["issue#11"]);
  assert.deepEqual(outcome.started, [{ key: "issue#11", id: "r-issue#11" }]);
  assert.deepEqual(outcome.failed, [{ key: "issue#13", error: "Docker isn't installed" }]);
  assert.deepEqual(outcome.skipped, [{ key: "pr#7", why: "already has run r-old" }]);
  // A rejected or failed earlier attempt doesn't count as covering it.
  assert.equal(coveringRun([covering], root, { kind: "pr", number: 7 }), covering);
  assert.equal(coveringRun([{ ...covering, triage: { state: "rejected", at: 0 } } as Run], root, { kind: "pr", number: 7 }), undefined);
  assert.equal(coveringRun([{ ...covering, status: "failed" } as Run], root, { kind: "pr", number: 7 }), undefined);
});

test("a sweep's runs wait in the inbox; a Dependabot PR is locked down, and approving its fix pushes it to the PR", async () => {
  const trigger = { id: "s-test", name: "Fix Dependabot PRs", via: "sweep" as const };
  const runs: Run[] = [];
  const dir = mkdtempSync(join(tmpdir(), "codeflow-record-"));
  process.env.FAKE_RECORD_DIR = dir;
  let run: Run;
  try {
    const outcome = await runSweep({
      repo,
      items: [{ key: "pr#7", task: "Make CI pass on Dependabot's pull request #7", source: { kind: "pr", number: 7, ciLogs: true } }],
      runs: manager.list(),
      start: async (item) => {
        const started = await manager.start({ pattern: findPattern("pipeline")!, task: item.task, repo, source: item.source, roles: team, options: {}, approvals: { plan: true }, trigger, loop: { check: "true", copy: [".env"] } });
        runs.push(started);
        return started;
      },
    });
    assert.equal(outcome.started.length, 1);
    run = await finished(runs[0]!);
  } finally {
    delete process.env.FAKE_RECORD_DIR;
  }
  assert.equal(run.status, "done", run.error);
  // Its description quotes upstream release notes and its CI runs the new package's code, so it's
  // treated like an outsider's PR: Safe mode, nothing copied in, checks in Docker without network.
  assert.match(run.lockdown!, /Pull request #7 comes from @app\/dependabot/);
  assert.equal(run.source?.trusted, false);
  assert.equal(run.trust, "safe");
  assert.equal(run.loop.copy, undefined);
  assert.deepEqual(run.loop.container, { image: "node:22", network: false });
  const recorded = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { vendor: string; args: string[]; prompt?: string });
  assert.ok(recorded.some((p) => p.vendor === "docker" && p.args.join(" ").includes("--network none")), "the check ran in a container without network");
  const prompt = recorded.find((p) => p.prompt?.includes("Pull request #7"))!.prompt!;
  assert.match(prompt, /outside this repository's maintainers/);
  assert.match(prompt, /```text\nTitle: Bump axios from 0\.21\.0 to 1\.7\.4\nBranch: dependabot\/npm_and_yarn\/axios-1\.7\.4 into main/, "the title is in the fence, not a heading");
  assert.doesNotMatch(prompt, /## Pull request #7: Bump/);
  assert.match(prompt, /### Logs of the failed jobs\n.*outside this repository's maintainers/);
  // Nobody approves a plan for a sweep.
  assert.deepEqual(run.approvals, {});
  assert.equal(run.source?.ci?.failing.length, 1);
  assert.equal(run.triage?.state, "pending");
  assert.equal(run.trigger?.via, "sweep");

  const before = sh(origin, "rev-parse", "refs/heads/dependabot/npm_and_yarn/axios-1.7.4");
  await manager.triage(run.id, { decision: "approve", pushPr: true });
  assert.equal(run.triage?.state, "approved");
  const after = sh(origin, "rev-parse", "refs/heads/dependabot/npm_and_yarn/axios-1.7.4");
  assert.notEqual(after, before);
  assert.equal(after, sh(repo, "rev-parse", run.artifacts[0]!.branch));
  // The next sweep doesn't start it again while this run stands.
  const again = await listSweep(repo, "dependabot", manager.list());
  assert.equal(again.items.find((i) => i.key === "pr#7")!.existingRun, run.id);
  assert.equal(again.items.find((i) => i.key === "pr#7")!.selected, false);
});

test("a recurring sweep starts runs only for new items, up to its limit", async () => {
  const startedTasks: string[] = [];
  const automations = new Automations(
    manager,
    async (body, extra) => {
      startedTasks.push(body.task);
      return manager.start({ pattern: findPattern("pipeline")!, task: body.task, repo: body.repo, source: body.source, roles: team, options: {}, trigger: extra.trigger });
    },
    (r, kind) => listSweep(r, kind, manager.list()),
  );
  await automations.load();
  const t = await automations.create({
    name: "Nightly issues",
    enabled: true,
    run: { repo, pattern: "pipeline", task: "Fix the GitHub issue below.", roles: team },
    schedule: { at: "07:00" },
    webhook: true,
    isolate: false,
    sweep: { kind: "issues", max: 1 },
  });
  const first = await automations.fire(t.id, { via: "manual" });
  assert.equal(first.runs?.length, 1);
  assert.deepEqual(startedTasks, ["Fix issue #11. Add a test that fails without the fix."]);
  await finished(first.runs![0]!);
  assert.equal(first.runs![0]!.triage?.state, "pending");

  // #11 is handled; #12 is a question (not picked); #13 is next.
  const second = await automations.fire(t.id, { via: "schedule" });
  assert.equal(second.runs?.length, 1);
  assert.match(startedTasks[1]!, /^Fix issue #13/);
  await finished(second.runs![0]!);
  const third = await automations.fire(t.id, { via: "schedule" });
  assert.equal(third.skipped, "nothing new to sweep");
  assert.deepEqual(automations.get(t.id)!.handled, ["issue#11", "issue#13"]);
  // Nothing piles up as text files: every run here was the sweep's.
  assert.ok(readdirSync(join(process.env.CODEFLOW_HOME!, "runs")).length >= 2);
});

test("a webhook-fired sweep follows the sweep's own rules: its kind, its picks, one run per item, at most max an hour", async () => {
  const startedTasks: string[] = [];
  const automations = new Automations(
    manager,
    async (body, extra) => {
      startedTasks.push(body.task);
      await new Promise((r) => setTimeout(r, 50)); // starting a run takes a while: long enough for a second delivery
      return manager.start({ pattern: findPattern("pipeline")!, task: body.task, repo: body.repo, source: body.source, roles: team, options: {}, trigger: extra.trigger });
    },
    (r, kind) => listSweep(r, kind, manager.list()),
  );
  await automations.load();
  const t = await automations.create({
    name: "Hooked issues",
    enabled: true,
    run: { repo, pattern: "pipeline", task: "Fix the GitHub issue below.", roles: team },
    webhook: true,
    isolate: false,
    sweep: { kind: "issues", max: 2 },
  });
  setState((s) =>
    s.issues.push(
      { number: 14, title: "Crash on save", body: "It crashes.", url: "https://github.com/o/r/issues/14", labels: [] },
      { number: 15, title: "Typo in footer", body: "", url: "https://github.com/o/r/issues/15", labels: [] },
      { number: 16, title: "Slow start", body: "", url: "https://github.com/o/r/issues/16", labels: [] },
    ),
  );
  const hook = (source: object) => automations.fire(t.id, { via: "webhook", source: source as never, details: "GitHub: issue opened by @someone" });

  // Not this sweep's kind, or not one its list would pick: nothing starts.
  assert.match((await hook({ kind: "alert", tool: "code-scanning", number: 21 })).skipped!, /issues sweep doesn't start from an alert/);
  assert.match((await hook({ kind: "pr", number: 7 })).skipped!, /doesn't start from a pull request/);
  assert.match((await hook({ kind: "issue", number: 12 })).skipped!, /wouldn't pick it: Labelled “question”/);
  assert.match((await hook({ kind: "issue", number: 99 })).skipped!, /isn't in the sweep's list/);
  // The same issue twice at once (GitHub sends "opened" and "labeled"): one run.
  const [a, b] = await Promise.all([hook({ kind: "issue", number: 14 }), hook({ kind: "issue", number: 14 })]);
  assert.equal([a, b].filter((r) => r.runs?.length).length, 1);
  assert.equal([a, b].find((r) => !r.runs?.length)!.skipped, "nothing new to sweep");
  assert.deepEqual(startedTasks, ["Fix issue #14. Add a test that fails without the fix.\n\n## Details from the webhook\nGitHub: issue opened by @someone"]);
  await finished(a.runs?.[0] ?? b.runs![0]!);
  assert.equal((await hook({ kind: "issue", number: 14 })).skipped, "nothing new to sweep");
  // At most `max` (2) runs from webhooks an hour: an outsider opening many issues can't start many runs.
  const second = await hook({ kind: "issue", number: 15 });
  assert.equal(second.runs?.length, 1);
  await finished(second.runs![0]!);
  const capped = await hook({ kind: "issue", number: 16 });
  assert.match(capped.skipped!, /already started 2 runs from webhooks in the last hour \(at most 2\)/);
  assert.match(automations.get(t.id)!.lastError!, /at most 2/);
  assert.deepEqual(automations.get(t.id)!.handled, ["issue#14", "issue#15"]);
});

test("alerts are remembered by number: a new alert on a swept package is swept, and old package keys don't block it", async () => {
  const automations = new Automations(
    manager,
    (body, extra) => manager.start({ pattern: findPattern("pipeline")!, task: body.task, repo: body.repo, source: body.source, roles: team, options: {}, trigger: extra.trigger }),
    (r, kind) => listSweep(r, kind, manager.list()),
  );
  await automations.load();
  const t = await automations.create({
    name: "Nightly alerts",
    enabled: true,
    run: { repo, pattern: "pipeline", task: "Fix the security alert below.", roles: team },
    webhook: true,
    isolate: false,
    sweep: { kind: "alerts", max: 1 },
    // Saved by an older code-flow, which remembered lodash's alerts by package.
    handled: ["dependabot:npm/lodash", "code-scanning#21"],
  });
  assert.equal((await automations.fire(t.id, { via: "manual" })).skipped, "nothing new to sweep");
  assert.deepEqual(automations.get(t.id)!.handled!.sort(), ["code-scanning#21", "dependabot#3", "dependabot#4"], "the old key became the alerts open then");

  setState((s) => s.dependabotAlerts.push(advisory(9, "lodash", "critical", "< 4.17.22", "4.17.22", "Another lodash hole")));
  try {
    const fired = await automations.fire(t.id, { via: "schedule" });
    assert.equal(fired.runs?.length, 1, fired.skipped);
    const run = await finished(fired.runs![0]!);
    assert.deepEqual(run.source?.alert?.numbers, [3, 4, 9], "one run upgrades past every lodash alert");
    assert.deepEqual(automations.get(t.id)!.handled!.filter((k) => k.startsWith("dependabot")).sort(), ["dependabot#3", "dependabot#4", "dependabot#9"]);
    // The webhook path uses the same keys: alert #9 isn't swept twice.
    assert.equal((await automations.fire(t.id, { via: "webhook", source: { kind: "alert", tool: "dependabot", number: 9 } })).skipped, "nothing new to sweep");
  } finally {
    setState((s) => (s.dependabotAlerts = s.dependabotAlerts.filter((a: { number: number }) => a.number !== 9)));
  }
});

test("webhooks: new Dependabot and code scanning alerts start a run; leaked secrets don't", () => {
  const hook = (event: string, payload: object) => readWebhook({ "x-github-event": event }, payload);
  assert.deepEqual(hook("dependabot_alert", { action: "created", alert: { number: 5 } })?.source, { kind: "alert", tool: "dependabot", number: 5 });
  assert.deepEqual(hook("code_scanning_alert", { action: "appeared_in_branch", alert: { number: 21 } })?.source, { kind: "alert", tool: "code-scanning", number: 21 });
  assert.equal(hook("code_scanning_alert", { action: "closed_by_user", alert: { number: 21 } }), null);
  assert.equal(hook("secret_scanning_alert", { action: "created", alert: { number: 31 } }), null);
  // A plain JSON webhook can name an alert too.
  assert.deepEqual(readWebhook({}, { source: { kind: "alert", tool: "dependabot", number: 3 } })?.source, { kind: "alert", tool: "dependabot", number: 3 });
  assert.equal(readWebhook({}, { source: { kind: "alert", tool: "nope", number: 3 } })?.source, undefined);
});

test("nextSweepItems: picked, not manual, not handled, at most max", () => {
  const list = {
    kind: "alerts" as const,
    notices: [],
    items: [
      { key: "a", ref: "", title: "", detail: "", url: "", selected: true, task: "t", source: { kind: "issue" as const, number: 1 } },
      { key: "b", ref: "", title: "", detail: "", url: "", selected: false, task: "t", source: { kind: "issue" as const, number: 2 } },
      { key: "c", ref: "", title: "", detail: "", url: "", selected: true, manual: true },
      { key: "d", ref: "", title: "", detail: "", url: "", selected: true, task: "t", source: { kind: "issue" as const, number: 4 } },
      { key: "e", ref: "", title: "", detail: "", url: "", selected: true, task: "t", source: { kind: "issue" as const, number: 5 } },
    ],
  };
  assert.deepEqual(nextSweepItems(list, new Set(["issue#1"]), 1).map((i) => i.key), ["d"]);
  assert.deepEqual(nextSweepItems(list, new Set(), 5).map((i) => i.key), ["a", "d", "e"]);
  // An item of several alerts is new while any of them is.
  const alerts = { kind: "alerts" as const, notices: [], items: [{ key: "dependabot#3", ref: "", title: "", detail: "", url: "", selected: true, task: "t", source: { kind: "alert" as const, tool: "dependabot" as const, number: 3, numbers: [3, 4] } }] };
  assert.deepEqual(nextSweepItems(alerts, new Set(["dependabot#3"]), 5).length, 1);
  assert.deepEqual(nextSweepItems(alerts, new Set(["dependabot#3", "dependabot#4"]), 5).length, 0);
  assert.deepEqual(sourceKeys({ kind: "alert", tool: "dependabot", number: 3, numbers: [3, 4] }), ["dependabot#3", "dependabot#4"]);
});

test("coveringRun: an alert is covered only when a standing run covers every alert in it", async () => {
  const root = await repoRoot(repo);
  const run = { id: "r-lodash", repo: root, archived: false, status: "done", source: { kind: "alert", number: 3, alert: { tool: "dependabot", numbers: [3, 4] } } } as unknown as Run;
  assert.equal(coveringRun([run], root, { kind: "alert", tool: "dependabot", number: 3, numbers: [3, 4] }), run);
  assert.equal(coveringRun([run], root, { kind: "alert", tool: "dependabot", number: 3, numbers: [3, 4, 9] }), undefined, "alert #9 is new work");
  assert.equal(coveringRun([run], root, { kind: "alert", tool: "code-scanning", number: 3 }), undefined);
});
