import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-auto-home-"));

const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { Automations, nextFire, describeSchedule, readWebhook, resumeSchedule, stillDue, validateSchedule } = await import("../src/automation.js");
const { changeRemote, isOwnAddress, loadRemote, renderRemote, saveRemote } = await import("../src/remote.js");
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

test("schedules survive restarts: a missed time fires once within an hour, else it's skipped, and never on a day left out", () => {
  const at = (day: number, h: number, m = 0) => new Date(2026, 9, 12 + day, h, m).getTime(); // day 0 = Mon 12 Oct 2026
  const weekdays = { at: "07:00", days: [1, 2, 3, 4, 5] };
  // Restarted at 07:20 on Monday: that morning's 07:00 still fires (once, on the next tick).
  assert.equal(resumeSchedule(weekdays, at(0, 7), at(0, 7, 20)), at(0, 7));
  // Back at 09:00: too late, so the next one is Tuesday's.
  assert.equal(resumeSchedule(weekdays, at(0, 7), at(0, 9)), at(1, 7));
  // Friday's 07:00 missed by a weekend asleep: next is Monday, not "now, on a Sunday".
  assert.equal(new Date(resumeSchedule(weekdays, at(4, 7), at(6, 12))).getDay(), 1);
  // Monday's 23:30, fired 40 minutes late: it's past midnight, but the time was due on a Monday.
  const mondayNights = { at: "23:30", days: [1] };
  assert.equal(stillDue(mondayNights, at(0, 23, 30), at(1, 0, 10)), true);
  assert.equal(stillDue(mondayNights, at(0, 23, 30), at(0, 23, 50)), true);
  assert.equal(stillDue(mondayNights, at(0, 23, 30), at(1, 1, 0)), false, "more than an hour late");
  // The day clocks spring forward shifts 02:30 to 03:30; the next day is 02:30 again.
  const nightly = { at: "02:30" };
  const fired = [nextFire(nightly, at(0, 12))];
  for (let i = 0; i < 200; i++) fired.push(nextFire(nightly, fired.at(-1)!));
  assert.ok(fired.filter((t) => new Date(t).getHours() !== 2).length <= 1, "at most the one day 02:30 doesn't exist");
  // An hourly automation keeps its next time across restarts instead of starting the hour again.
  assert.equal(resumeSchedule({ every: 60 }, at(0, 10), at(0, 9, 40)), at(0, 10));
  assert.equal(resumeSchedule({ every: 60 }, undefined, at(0, 9)), at(0, 10));
  // A saved time further off than the schedule ever waits (the clock went back) starts over.
  assert.equal(resumeSchedule({ every: 60 }, at(3, 9), at(0, 9)), at(0, 10));
});

test("a schedule's next time is saved and honoured on load; a time slept through is skipped, not fired late", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "codeflow-triggers-")), "triggers.json");
  const started: string[] = [];
  const make = () =>
    new Automations(manager, async (body, extra) => {
      started.push(extra.trigger.via);
      return manager.start({ pattern: findPattern(body.pattern)!, task: body.task, repo: body.repo, roles: body.roles, options: {}, trigger: extra.trigger });
    }, undefined, file);
  const first = make();
  await first.load();
  const t = await first.create({ name: "Hourly", enabled: true, schedule: { every: 60 }, webhook: false, isolate: false, run: { repo, pattern: "pipeline", task: "Hourly chore", roles: team } });
  // Restart 20 minutes later: same next time, not an hour from now.
  const second = make();
  await second.load(t.nextAt! - 40 * 60_000);
  assert.equal(second.get(t.id)!.nextAt, t.nextAt);
  // The computer slept through it by three hours: the tick moves on without firing.
  await second.tick(t.nextAt! + 3 * 3_600_000);
  assert.deepEqual(started, []);
  assert.equal(second.get(t.id)!.nextAt, t.nextAt! + 3 * 3_600_000 + 60 * 60_000);
  // Ten minutes late (code-flow was restarting): it fires.
  const due = second.get(t.id)!.nextAt!;
  await second.tick(due + 10 * 60_000);
  assert.deepEqual(started, ["schedule"]);
  await idle(manager.get(second.get(t.id)!.lastRunId!)!);
  // Renaming it doesn't move its next time.
  const next = second.get(t.id)!.nextAt;
  await second.update(t.id, { name: "Hourly (renamed)" });
  assert.equal(second.get(t.id)!.nextAt, next);
});

test("triggers.json that can't be read is moved aside and never written over", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codeflow-triggers-"));
  const file = join(dir, "triggers.json");
  const make = () => new Automations(manager, async () => assert.fail("nothing should start"), undefined, file);
  const aside = () => readdirSync(dir).filter((f) => f.startsWith("triggers.json.corrupt-"));

  // Not JSON (a torn write, a bad hand edit): set aside, and the next save starts a fresh file.
  writeFileSync(file, '[{"id": "t-1", "token": "');
  const broken = make();
  await broken.load();
  assert.deepEqual(broken.list(), []);
  assert.equal(aside().length, 1);
  assert.equal(readFileSync(join(dir, aside()[0]!), "utf8"), '[{"id": "t-1", "token": "', "what was there is kept");
  await broken.tick();
  assert.ok(!existsSync(file), "a tick doesn't write an empty list over it");

  // Valid JSON that isn't a list used to crash startup.
  rmSync(join(dir, aside()[0]!));
  writeFileSync(file, '{"not": "a list"}');
  await make().load();
  assert.equal(aside().length, 1);

  // A list with one unusable entry: the good ones load, the file is kept aside first.
  rmSync(join(dir, aside()[0]!));
  const good = { id: "t-good", name: "Good", enabled: true, run: { repo, pattern: "pipeline", task: "x", roles: team }, webhook: true, token: "a".repeat(48), isolate: false, createdAt: 1 };
  const oddSchedule = { ...good, id: "t-odd", name: "Odd schedule", schedule: { at: "7 o'clock" } };
  writeFileSync(file, JSON.stringify([good, { id: "t-bad" }, oddSchedule]));
  const partial = make();
  await partial.load();
  assert.deepEqual(partial.list().map((t) => t.id), ["t-good", "t-odd"]);
  assert.equal(partial.get("t-odd")!.enabled, false, "kept with its secret, but off until its schedule is set again");
  assert.match(partial.get("t-odd")!.lastError!, /schedule couldn't be read/);
  assert.equal(aside().length, 1);
  assert.match(readFileSync(join(dir, aside()[0]!), "utf8"), /t-bad/);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).map((t: { id: string }) => t.id), ["t-good", "t-odd"]);

  // A file that can't be read at all (permissions) is left alone: nothing is saved over it.
  chmodSync(file, 0o000);
  try {
    const locked = make();
    await locked.load();
    assert.deepEqual(locked.list(), []);
    // A new automation couldn't be saved, so it isn't made: its webhook secret would be gone after a restart.
    await assert.rejects(
      locked.create({ name: "New", enabled: true, webhook: true, isolate: false, run: { repo, pattern: "pipeline", task: "x", roles: team } }),
      /Automations can't be changed/,
    );
  } finally {
    chmodSync(file, 0o600);
  }
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).map((t: { id: string }) => t.id), ["t-good", "t-odd"]);
});

test("two fires at once start one run; a webhook while it runs waits and fires once it ends; a replayed delivery is ignored", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "codeflow-triggers-")), "triggers.json");
  const starts: string[] = [];
  const auto = new Automations(manager, async (body, extra) => {
    starts.push(extra.trigger.via);
    await new Promise((r) => setTimeout(r, 100)); // starting a run takes a while
    return manager.start({ pattern: findPattern(body.pattern)!, task: body.task, repo: body.repo, roles: body.roles, options: {}, trigger: extra.trigger });
  }, undefined, file);
  await auto.load();
  auto.start(3_600_000);
  try {
    const t = await auto.create({ name: "Pushes", enabled: true, webhook: true, isolate: false, run: { repo, pattern: "pipeline", task: "On push", roles: team } });
    process.env.FAKE_SLEEP_MS = "500";
    let first: Run;
    try {
      const [a, b] = await Promise.all([auto.fire(t.id, { via: "manual" }), auto.fire(t.id, { via: "manual" })]);
      assert.equal([a, b].filter((r) => r.run).length, 1, "one run, not two");
      assert.match((a.skipped ?? b.skipped)!, /starting a run right now/);
      first = (a.run ?? b.run)!;
      // A push while it runs isn't dropped: it waits. The same push twice waits once.
      assert.deepEqual(auto.accept(t.id, { details: "pushed abc" }, "delivery-1"), { accepted: true });
      assert.deepEqual(auto.accept(t.id, { details: "pushed abc" }, "delivery-2"), { accepted: true });
      // GitHub sending the same delivery again starts nothing.
      assert.match((auto.accept(t.id, { details: "pushed abc" }, "delivery-1") as { ignored: string }).ignored, /already handled/);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(auto.get(t.id)!.queued?.length, 1);
    } finally {
      delete process.env.FAKE_SLEEP_MS;
    }
    await idle(first);
    // When it ends, the waiting event fires.
    for (let i = 0; i < 100 && auto.get(t.id)!.lastRunId === first.id; i++) await new Promise((r) => setTimeout(r, 50));
    const next = manager.get(auto.get(t.id)!.lastRunId!)!;
    assert.notEqual(next.id, first.id);
    assert.equal(next.trigger?.via, "webhook");
    assert.match(next.task, /## Details from the webhook\npushed abc/);
    assert.equal(auto.get(t.id)!.queued, undefined);
    assert.deepEqual(starts, ["manual", "webhook"]);
    assert.deepEqual(auto.get(t.id)!.deliveries, ["delivery-1", "delivery-2"]);
    await idle(next);
  } finally {
    auto.stop();
  }
});

test("phone view: read-only HTML with everything escaped", async () => {
  const run = await idle(
    await manager.start({ pattern: findPattern("pipeline")!, task: "<script>alert(1)</script> escape me", repo, roles: team, options: {} }),
  );
  const home = renderRemote(manager, "/r/tok", "/")!;
  assert.match(home, /&lt;script&gt;alert\(1\)&lt;\/script&gt; escape me/);
  assert.doesNotMatch(home, /<script>/);
  assert.match(home, /Needs you|Recent/);
  const detail = renderRemote(manager, "/r/tok", `/run/${run.id}`)!;
  assert.match(detail, /Steps/);
  assert.doesNotMatch(detail, /<form|<button|method="post"/i, "no actions");
  assert.equal(renderRemote(manager, "/r/tok", "/run/nope"), null);
});

test("phone settings: turning anything off makes new secrets; the read-only link never doubles as the sign-in link", () => {
  const on = { enabled: true, lan: true, control: true, token: "a".repeat(48), controlToken: "b".repeat(48) };
  const offControl = changeRemote(on, { control: false });
  assert.equal(offControl.token, on.token, "the read-only link still works");
  assert.notEqual(offControl.controlToken, on.controlToken, "phones are signed out");
  const backOn = changeRemote(offControl, { control: true });
  assert.equal(backOn.controlToken, offControl.controlToken, "turning it back on doesn't revive the old cookies");
  for (const patch of [{ lan: false }, { enabled: false }, { rotate: true }]) {
    const next = changeRemote(on, patch);
    assert.notEqual(next.token, on.token, JSON.stringify(patch));
    assert.notEqual(next.controlToken, on.controlToken, JSON.stringify(patch));
    assert.notEqual(next.token, next.controlToken);
  }
  assert.deepEqual(changeRemote(on, { control: true }), on, "nothing turned off, nothing rotated");
});

test("remote.json: written whole, and one that can't be read is moved aside with phone access off", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codeflow-remote-"));
  const file = join(dir, "remote.json");
  const fresh = await loadRemote(file);
  assert.deepEqual([fresh.enabled, fresh.lan, fresh.control], [false, false, false]);
  assert.notEqual(fresh.token, fresh.controlToken);
  await saveRemote({ ...fresh, enabled: true }, file);
  assert.equal((await loadRemote(file)).enabled, true);
  assert.deepEqual(readdirSync(dir), ["remote.json"], "no temporary file left behind");

  writeFileSync(file, '{"enabled": true, "token": "');
  const reset = await loadRemote(file);
  assert.equal(reset.enabled, false, "starts with phone access off");
  const aside = readdirSync(dir).filter((f) => f.startsWith("remote.json.corrupt-"));
  assert.equal(aside.length, 1);
  assert.equal(readFileSync(join(dir, aside[0]!), "utf8"), '{"enabled": true, "token": "');

  // Saved before full control had its own secret: phones sign in again rather than reuse the read-only one.
  writeFileSync(file, JSON.stringify({ enabled: true, lan: true, control: true, token: "c".repeat(48) }));
  const old = await loadRemote(file);
  assert.equal(old.token, "c".repeat(48));
  assert.notEqual(old.controlToken, old.token);
});

test("this machine's own addresses count as local, whichever one a program connects to", () => {
  assert.equal(isOwnAddress("127.0.0.1"), true);
  assert.equal(isOwnAddress("::ffff:127.0.0.1"), true);
  assert.equal(isOwnAddress("::1"), true);
  assert.equal(isOwnAddress(undefined), true);
  for (const ip of Object.values(networkInterfaces()).flat()) if (ip) assert.equal(isOwnAddress(ip.address), true, ip.address);
  assert.equal(isOwnAddress("203.0.113.7"), false);
});
