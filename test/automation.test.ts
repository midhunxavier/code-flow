import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-auto-home-"));

const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { Automations, nextFire, describeSchedule, readWebhook, validateSchedule } = await import("../src/automation.js");
const { renderRemote } = await import("../src/remote.js");
type Run = import("../src/engine.js").Run;
type AgentId = import("../src/adapters/index.js").AgentId;

let repo: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString().trim();
const manager = new RunManager(findPattern);
const automations = new Automations(manager, (body, extra) =>
  manager.start({
    pattern: findPattern(body.pattern)!,
    task: body.task,
    repo: body.repo,
    roles: body.roles,
    options: {},
    loop: body.loop,
    approvals: { plan: true }, // ignored for automations: nobody is there to approve
    trigger: extra.trigger,
  }),
);
const team: Record<string, AgentId[]> = { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] };

before(async () => {
  repo = mkdtempSync(join(tmpdir(), "codeflow-auto-repo-"));
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "auto\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  await automations.load();
});

async function idle(run: Run) {
  await new Promise<void>((resolve) => {
    // endedAt is set last, after the inbox bookkeeping.
    const check = () => run.status !== "running" && run.endedAt !== undefined && resolve();
    manager.subscribe(run.id, check);
    check();
  });
  return run;
}
const branches = () => git("branch", "--format=%(refname:short)").split("\n").filter(Boolean);

test("schedules: every N minutes, or at a time on chosen days; missed times are skipped", () => {
  const monday9 = new Date(2026, 9, 12, 9, 0, 0).getTime(); // Mon 12 Oct 2026, 09:00
  assert.equal(nextFire({ every: 30 }, monday9), monday9 + 30 * 60_000);
  assert.equal(new Date(nextFire({ at: "07:30" }, monday9)).toString(), new Date(2026, 9, 13, 7, 30).toString(), "07:30 has passed today → tomorrow");
  assert.equal(new Date(nextFire({ at: "07:30", days: [6] }, monday9)).getDay(), 6, "only on Saturdays");
  assert.equal(describeSchedule({ at: "07:30", days: [1, 2, 3, 4, 5] }), "Mon, Tue, Wed, Thu, Fri at 07:30");
  assert.equal(describeSchedule({ every: 120 }), "every 2 h");
  assert.throws(() => validateSchedule({ every: 1 }), /every 5 minutes/);
  assert.throws(() => validateSchedule({ at: "25:00" }), /07:30/);
  assert.deepEqual(validateSchedule({ at: "07:30", days: [0, 1, 2, 3, 4, 5, 6] }), { at: "07:30", days: undefined });
});

test("a scheduled run lands in the inbox; another fire while it runs is skipped; approving never merges", async () => {
  const mainBefore = git("rev-parse", "main");
  const t = await automations.create({ name: "Nightly", enabled: true, schedule: { every: 60 }, webhook: false, isolate: false, run: { repo, pattern: "pipeline", task: "Nightly chore", roles: team } });
  assert.ok(existsSync(join(process.env.CODEFLOW_HOME!, "triggers.json")));

  process.env.FAKE_SLEEP_MS = "400";
  try {
    await automations.tick(t.nextAt! + 1);
    const run = manager.get(automations.get(t.id)!.lastRunId!)!;
    assert.deepEqual(run.trigger, { id: t.id, name: "Nightly", via: "schedule" });
    assert.deepEqual(run.approvals, {}, "automations never pause for approval");
    assert.match((await automations.fire(t.id, { via: "manual" })).skipped!, /still running/);
    await idle(run);
    assert.equal(run.status, "done", run.error);
    assert.equal(run.triage?.state, "pending");
    assert.equal(run.seen, false, "it needs you");
    assert.ok(automations.get(t.id)!.nextAt! > t.nextAt!, "the next fire moved on");

    await manager.triage(run.id, { decision: "approve" });
    assert.equal(run.triage?.state, "approved");
    assert.equal(run.seen, true);
    assert.equal(git("rev-parse", "main"), mainBefore, "nothing was merged");
  } finally {
    delete process.env.FAKE_SLEEP_MS;
  }
});

test("a run that changes nothing is archived on its own, branches and all", async () => {
  const t = await automations.create({ name: "No-op", enabled: true, webhook: false, isolate: false, run: { repo, pattern: "pipeline", task: "Nothing to do", roles: team } });
  process.env.FAKE_NOOP_VENDOR = "codex";
  let run: Run;
  try {
    run = await idle((await automations.fire(t.id, { via: "manual" })).run!);
  } finally {
    delete process.env.FAKE_NOOP_VENDOR;
  }
  assert.equal(run.status, "done", run.error);
  assert.equal(run.triage?.state, "empty");
  assert.equal(run.archived, true);
  assert.equal(run.seen, true);
  assert.ok(!branches().some((b) => b.startsWith(run.branchPrefix)), "its branches are gone");
});

test("revise sends your note to the agent and returns to the inbox; reject archives and deletes", async () => {
  const t = await automations.create({ name: "Revise me", enabled: true, webhook: false, isolate: false, run: { repo, pattern: "pipeline", task: "Add a thing", roles: team } });
  const run = await idle((await automations.fire(t.id, { via: "manual", details: "From a script" })).run!);
  assert.match(run.task, /## Details from the manual\nFrom a script/);
  await assert.rejects(manager.triage(run.id, { decision: "revise" }), /Say what should change/);

  await manager.triage(run.id, { decision: "revise", note: "Also update the docs" });
  await idle(run);
  const reply = run.followUps.at(-1)!;
  assert.deepEqual([reply.kind, reply.agent, reply.message, reply.status], ["reply", "codex", "Also update the docs", "done"]);
  assert.equal(run.triage?.state, "pending", "back in the inbox after the revision");

  await manager.triage(run.id, { decision: "reject", note: "Not needed" });
  assert.equal(run.triage?.state, "rejected");
  assert.equal(run.archived, true);
  assert.ok(!branches().some((b) => b.startsWith(run.branchPrefix)), "rejected work is deleted");
});

test("isolation: checks run in a container that sees only the worktree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codeflow-record-"));
  process.env.FAKE_RECORD_DIR = dir;
  let run: Run;
  try {
    const t = await automations.create({
      name: "Isolated",
      enabled: true,
      webhook: false,
      isolate: true,
      image: "node:22-slim",
      run: { repo, pattern: "pipeline", task: "Isolated", roles: team, loop: { check: 'test "$IN_FAKE_CONTAINER" = 1' } },
    });
    run = await idle((await automations.fire(t.id, { via: "manual" })).run!);
  } finally {
    delete process.env.FAKE_RECORD_DIR;
  }
  assert.equal(run.status, "done", run.error);
  assert.equal(run.verdict, "passed", "the check ran inside the (fake) container");
  const docker = readdirSync(dir).filter((f) => f.startsWith("docker-")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")).args as string[]);
  assert.ok(docker.length >= 1);
  const args = docker[0]!.join(" ");
  const wt = run.worktrees[0]!.path;
  assert.ok(args.includes(`-v ${wt}:${wt} `) && args.includes(`-w ${wt} `), "only the worktree is mounted read-write");
  const gitDir = join(run.repo, ".git");
  assert.ok(args.includes(`-v ${gitDir}:${gitDir}:ro`), "git metadata is read-only");
  assert.ok(args.includes("node:22-slim /bin/sh -c"));
  assert.ok(!args.includes(process.env.HOME!), "your home directory isn't mounted");
});

test("webhooks: bearer token or GitHub signature; GitHub events map to issues and PRs", async () => {
  const t = await automations.create({ name: "Hook", enabled: true, webhook: true, isolate: false, run: { repo, pattern: "pipeline", task: "Hooked", roles: team } });
  const body = Buffer.from(JSON.stringify({ details: "hi" }));
  assert.equal(automations.authorize(t.id, { authorization: `Bearer ${t.token}` }, body).id, t.id);
  const signature = `sha256=${createHmac("sha256", t.token).update(body).digest("hex")}`;
  assert.equal(automations.authorize(t.id, { "x-hub-signature-256": signature }, body).id, t.id);
  assert.throws(() => automations.authorize(t.id, { authorization: "Bearer nope" }, body), /Bad token/);
  assert.throws(() => automations.authorize(t.id, { "x-hub-signature-256": signature }, Buffer.from("tampered")), /Bad token/);
  const scheduleOnly = await automations.create({ name: "No hook", enabled: true, webhook: false, isolate: false, schedule: { every: 60 }, run: { repo, pattern: "pipeline", task: "x", roles: team } });
  assert.throws(() => automations.authorize(scheduleOnly.id, { authorization: `Bearer ${scheduleOnly.token}` }, body), /Not found/);

  assert.deepEqual(readWebhook({}, { details: "Deploy failed", source: { kind: "pr", number: "4" } }), { details: "Deploy failed", source: { kind: "pr", number: 4, ciLogs: false } });
  assert.deepEqual(readWebhook({ "x-github-event": "issues" }, { action: "opened", issue: { number: 9 }, sender: { login: "bob" } })?.source, { kind: "issue", number: 9 });
  assert.deepEqual(readWebhook({ "x-github-event": "workflow_run" }, { action: "completed", workflow_run: { name: "CI", conclusion: "failure", pull_requests: [{ number: 3 }] } })?.source, { kind: "pr", number: 3, ciLogs: true });
  assert.equal(readWebhook({ "x-github-event": "workflow_run" }, { action: "completed", workflow_run: { conclusion: "success", pull_requests: [] } }), null);
  assert.equal(readWebhook({ "x-github-event": "push" }, {}), null);
});

test("editing an automation keeps the project it was saved in, through a restart and into its runs", async () => {
  const t = await automations.create({ name: "In a project", enabled: true, webhook: true, isolate: false, schedule: { every: 60 }, run: { repo, project: "p-saved", pattern: "pipeline", task: "Scoped", roles: team } });
  await automations.update(t.id, { name: "Renamed", enabled: false, webhook: false, isolate: true, image: "node:22-slim", schedule: { at: "07:00" }, rotateToken: true });
  await automations.update(t.id, { enabled: true, schedule: undefined });
  assert.equal(automations.get(t.id)!.run.project, "p-saved");

  let started: Record<string, any> | undefined;
  const reloaded = new Automations(manager, async (body) => {
    started = body;
    return { id: "r-stub" } as Run;
  });
  await reloaded.load();
  assert.equal(reloaded.get(t.id)!.name, "Renamed");
  assert.equal(reloaded.get(t.id)!.run.project, "p-saved", "saved in triggers.json");
  await reloaded.fire(t.id, { via: "manual" });
  assert.equal(started?.project, "p-saved", "its run is asked to start in that project");
});

test("phone view: read-only HTML with everything escaped", async () => {
  const run = await idle(
    await manager.start({ pattern: findPattern("pipeline")!, task: "<script>alert(1)</script> escape me", repo, roles: team, options: {} }),
  );
  const home = renderRemote(manager, [], "/r/tok", "/")!;
  assert.match(home, /&lt;script&gt;alert\(1\)&lt;\/script&gt; escape me/);
  assert.doesNotMatch(home, /<script>/);
  assert.match(home, /<h2>(Needs you|Recent)/);
  assert.doesNotMatch(home, /class="project"/, "no projects: nothing to group by");
  const detail = renderRemote(manager, [], "/r/tok", `/run/${run.id}`)!;
  assert.match(detail, /Steps/);
  assert.doesNotMatch(detail, /<form|<button|method="post"/i, "no actions");
  assert.equal(renderRemote(manager, [], "/r/tok", "/run/nope"), null);
});
