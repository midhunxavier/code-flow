// QA regressions for schedules: interval limits said the right way round and never clamped, a
// schedule is either an interval or a time, zones saved by their current names, stale edits
// refused, missed times judged when code-flow comes back and recorded where you look, and the
// editor's draft keeping a schedule's "server local time" instead of the browser's zone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-qa-schedule-home-"));
const { Automations, AutomationConflictError, describeSchedule, nextFire, validateSchedule } = await import("../src/automation.js");
const { canonicalTimeZone } = await import("../src/schedule-rules.js");
const { draftProblem, draftSchedule, formatNextRun, sameSchedule, scheduleDraft } = await import("../ui/schedule-draft.js");
type Run = import("../src/engine.js").Run;
type RunManager = import("../src/engine.js").RunManager;

const HOUR = 3_600_000, MINUTE = 60_000;
const run = { repo: "/tmp/qa-schedule-repo", pattern: "solo", task: "Scheduled QA task", roles: { agent: ["claude"] } };
const manager = { get: () => undefined, subscribeAll: () => () => {} } as unknown as RunManager;

/** Automations over a triggers.json holding these entries, recording the runs it starts. */
function fixture(entries: Record<string, unknown>[]) {
  const file = join(mkdtempSync(join(tmpdir(), "codeflow-qa-schedule-")), "triggers.json");
  writeFileSync(file, JSON.stringify(entries));
  const started: string[] = [];
  const make = () => new Automations(manager, async (_body, extra) => { started.push(extra.trigger.via); return { id: `run-${started.length}`, status: "done" } as Run; }, undefined, file);
  return { file, started, make };
}
const saved = (id: string, schedule: unknown, nextAt?: number) => ({ id, token: "t".repeat(48), name: id, enabled: true, run, schedule, webhook: false, isolate: false, createdAt: 1, nextAt });

test("intervals are 5 to 10080 whole minutes, said the right way round, and never clamped; a schedule is an interval or a time", () => {
  assert.throws(() => validateSchedule({ every: 3 }), /Runs must be at least 5 minutes apart/);
  assert.throws(() => validateSchedule({ every: 20_000 }), /at most 10080 minutes \(7 days\)/);
  assert.throws(() => validateSchedule({ every: "x" }), /whole number of minutes/);
  assert.throws(() => validateSchedule({ every: 7.5 }), /whole number of minutes/);
  assert.throws(() => validateSchedule({ every: null }), /whole number of minutes/);
  assert.throws(() => validateSchedule({ every: 10, at: "07:00" }), /either every \(minutes\) or at \(HH:MM\), not both/);
  assert.throws(() => validateSchedule({ every: 10, at: "nonsense", days: ["bad"] }), /not both/);
  assert.throws(() => validateSchedule({ every: 10, timezone: "UTC" }), /only to a schedule at a time of day/);
  assert.deepEqual(validateSchedule({ every: 5 }), { every: 5 });
  assert.deepEqual(validateSchedule({ every: 10_080 }), { every: 10_080 });
  assert.deepEqual(validateSchedule({ every: "60" }), { every: 60 }, "a number sent as text still reads");
});

test("time zones are saved by their current IANA names, with the letter case fixed", () => {
  for (const [typed, stored] of [["asia/kolkata", "Asia/Kolkata"], ["Asia/Kolkata", "Asia/Kolkata"], ["Asia/Calcutta", "Asia/Kolkata"], ["Europe/Kyiv", "Europe/Kyiv"], ["europe/kiev", "Europe/Kyiv"], ["Asia/Ho_Chi_Minh", "Asia/Ho_Chi_Minh"], ["europe/stockholm", "Europe/Stockholm"], [" UTC ", "UTC"]]) {
    assert.equal((validateSchedule({ at: "07:00", timezone: typed }) as { timezone?: string }).timezone, stored, typed);
  }
  assert.throws(() => validateSchedule({ at: "07:00", timezone: "Mars/Olympus" }), /IANA/);
  assert.throws(() => canonicalTimeZone("Not/AZone"));
  const after = Date.parse("2026-10-25T21:08:00Z");
  assert.equal(nextFire({ at: "07:00", timezone: "Asia/Kolkata" }, after), nextFire({ at: "07:00", timezone: "Asia/Calcutta" }, after), "the same zone fires at the same time");
  assert.equal(describeSchedule(validateSchedule({ at: "07:00", timezone: "asia/kolkata" })), "every day at 07:00 (Asia/Kolkata)");
});

test("a change based on an older revision is refused with 409 and changes nothing", async () => {
  const { make, file } = fixture([]);
  const auto = make(); await auto.load();
  const t = await auto.create({ name: "Two tabs", enabled: true, webhook: false, isolate: false, schedule: { at: "03:00", timezone: "Europe/Stockholm" }, run });
  assert.equal(t.revision, 1);
  const first = await auto.update(t.id, { schedule: { at: "04:00", timezone: "Europe/Stockholm" }, revision: 1 });
  assert.equal(first.revision, 2);
  const { nextAt } = auto.get(t.id)!;
  await assert.rejects(() => auto.update(t.id, { schedule: { at: "03:00", timezone: "UTC" }, revision: 1 }), (err: unknown) => err instanceof AutomationConflictError && err.status === 409 && /changed in another window/.test(err.message));
  assert.deepEqual(auto.get(t.id)!.schedule, { at: "04:00", timezone: "Europe/Stockholm" });
  assert.equal(auto.get(t.id)!.nextAt, nextAt);
  assert.equal(auto.get(t.id)!.revision, 2, "a refused change doesn't count");
  // Without a revision (an API caller, or switching it on and off) it applies, and counts.
  assert.equal((await auto.update(t.id, { enabled: false })).revision, 3);
  await auto.stop();
  const reloaded = make(); await reloaded.load();
  assert.equal(reloaded.get(t.id)!.revision, 3, "the revision is saved");
  const legacy = fixture([saved("t-legacy", { at: "07:00", timezone: "Asia/Calcutta" })]).make();
  await legacy.load();
  assert.equal(legacy.get("t-legacy")!.revision, 1, "automations saved before revisions start at 1");
  assert.deepEqual(legacy.get("t-legacy")!.schedule, { at: "07:00", days: undefined, timezone: "Asia/Kolkata" }, "and read their zone by its current name");
  assert.ok(JSON.parse(readFileSync(file, "utf8"))[0].revision === 3);
});

test("a missed time kept when code-flow comes back fires at the first tick, even past the hour by then", async () => {
  const T = Date.parse("2026-10-25T20:00:00Z");
  const { make, started } = fixture([saved("t-edge", { every: 1440 }, T), saved("t-control", { every: 1440 }, T + 10 * MINUTE)]);
  const auto = make();
  await auto.load(T + HOUR - 15_000); // 59m45s late when code-flow is back
  assert.equal(auto.get("t-edge")!.nextAt, T, "kept: it can still fire");
  await auto.tick(T + HOUR + 15_000); // the first tick, 30 s later: 60m15s late by now
  assert.deepEqual(started, ["schedule", "schedule"], "both kept times fire once");
  assert.deepEqual(auto.events("t-edge").map((e) => e.state), ["started"]);
  await auto.stop();
  // The computer slept again for more than an hour after code-flow came back: judged at the tick.
  const slept = fixture([saved("t-slept", { every: 1440 }, T)]);
  const again = slept.make();
  await again.load(T + 50 * MINUTE);
  await again.tick(T + 3 * HOUR);
  assert.deepEqual(slept.started, []);
  assert.equal(again.events("t-slept")[0]!.state, "skipped");
  await again.stop();
});

test("a time skipped while code-flow was closed or asleep is recorded in the event history", async () => {
  const T = Date.parse("2026-10-25T20:00:00Z");
  const { make, started } = fixture([saved("t-closed", { at: "21:00", timezone: "Europe/Stockholm" }, T), saved("t-asleep", { every: 60 }, T + 3 * HOUR)]);
  const auto = make();
  await auto.load(T + 2 * HOUR);
  const [missed] = auto.events("t-closed");
  assert.equal(missed?.via, "schedule"); assert.equal(missed?.state, "skipped");
  assert.match(missed!.reason!, /Missed the .*21:00.* run: code-flow was closed or the computer asleep/);
  assert.ok(auto.get("t-closed")!.nextAt! > T + 2 * HOUR, "the schedule moved on");
  assert.deepEqual(auto.events("t-asleep"), [], "a time still ahead isn't a missed one");
  // Slept through by hours after code-flow started: skipped at the tick, and recorded too.
  await auto.tick(T + 6 * HOUR);
  assert.deepEqual(started, []);
  assert.equal(auto.events("t-asleep")[0]!.state, "skipped");
  await auto.stop();
  const reloaded = make(); await reloaded.load(T + 4 * HOUR);
  assert.equal(reloaded.events("t-closed").filter((e) => e.state === "skipped").length, 1, "the record is saved, and only once");
});

test("the editor keeps a schedule saved without a zone in server local time, and saving it unedited changes nothing", () => {
  const tzless = { at: "08:00" };
  const draft = scheduleDraft(tzless, "America/New_York");
  assert.equal(draft.timezone, "", "not the browser's zone");
  assert.deepEqual(draftSchedule(draft), { at: "08:00", days: undefined });
  assert.equal(sameSchedule(draftSchedule(draft), tzless), true);
  assert.deepEqual(validateSchedule(draftSchedule(draft)), validateSchedule(tzless), "it round-trips unchanged");
  const zoned = scheduleDraft({ at: "08:00", days: [1, 3], timezone: "Europe/Stockholm" }, "America/New_York");
  assert.deepEqual(draftSchedule(zoned), { at: "08:00", days: [1, 3], timezone: "Europe/Stockholm" });
  // Switching an interval or no schedule to a time of day starts in the browser's zone.
  assert.equal(scheduleDraft({ every: 60 }, "America/New_York").timezone, "America/New_York");
  assert.equal(scheduleDraft(undefined, "America/New_York").timezone, "America/New_York");
  assert.equal(sameSchedule({ at: "07:00", timezone: "asia/kolkata" }, { at: "07:00", timezone: "Asia/Kolkata" }), true);
  assert.equal(sameSchedule({ at: "07:00", days: [0, 1, 2, 3, 4, 5, 6] }, { at: "07:00" }), true);
  assert.equal(sameSchedule({ at: "07:00" }, { at: "07:00", timezone: "UTC" }), false);
});

test("the editor says why its fields can't be saved, before they're sent", () => {
  const every = (value: string) => draftProblem({ ...scheduleDraft({ every: 60 }), every: value });
  assert.equal(every(""), "Enter the minutes between runs", "an emptied field stays empty and says so");
  assert.match(every("3")!, /at least 5 minutes apart/);
  assert.match(every("20000")!, /10080 minutes/);
  assert.match(every("1.5")!, /whole number/);
  assert.equal(every("15"), undefined);
  const daily = scheduleDraft({ at: "07:00", timezone: "Europe/Stockholm" });
  assert.match(draftProblem({ ...daily, timezone: "Mars/Olympus" })!, /valid IANA time zone/);
  assert.match(draftProblem({ ...daily, days: [] })!, /at least one valid day/);
  assert.equal(draftProblem({ ...daily, timezone: "" }), undefined, "empty: server local time");
  assert.match(draftProblem({ ...daily, timezone: "" }, true)!, /Choose a time zone/, "required where the schedule needs one");
});

test("the next run shows its date and zone: a week away never reads as today", () => {
  const now = Date.parse("2026-10-25T21:08:00Z"); // a Sunday evening
  const weekly = formatNextRun(Date.parse("2026-11-01T21:08:00Z"), { every: 10_080 }, now, "en-US");
  assert.match(weekly, /Nov 1/); assert.match(weekly, /Sun/);
  const utc = formatNextRun(Date.parse("2026-10-26T06:30:00Z"), { at: "06:30", timezone: "UTC" }, now, "en-US");
  assert.match(utc, /Oct 26/); assert.match(utc, /06:30/); assert.match(utc, /UTC/);
  const la = formatNextRun(Date.parse("2026-10-26T16:15:00Z"), { at: "09:15", timezone: "America/Los_Angeles" }, now, "en-US");
  assert.match(la, /09:15/); assert.match(la, /PDT/);
  assert.match(formatNextRun(Date.parse("2027-01-04T06:30:00Z"), { at: "06:30", timezone: "UTC" }, now, "en-US"), /2027/, "another year says which");
  assert.doesNotMatch(utc, /2026/);
});
