import { test } from "node:test";
import assert from "node:assert/strict";
import { automationTiming, suggestsSchedule } from "../src/conversational/automation-intent.js";

test("recurring instructions suggest scheduling but questions and ordinary work do not", () => {
  for (const text of ["Review Dependabot PRs daily in the morning", "Fix issues every weekday at 8 am", "Schedule a repository review", "Every 30 minutes inspect CI"]) assert.equal(suggestsSchedule(text), true, text);
  for (const text of ["Fix this regression", "Why does this daily job fail?", "Explain our daily workflow", "Review this PR"]) assert.equal(suggestsSchedule(text), false, text);
});
test("timing suggestions preserve explicit times, weekdays and zones for review", () => {
  assert.deepEqual(automationTiming("Review every weekday at 8:30 am", "Europe/Stockholm"), { timing: "repeat", schedule: { at: "08:30", days: [1,2,3,4,5], timezone: "Europe/Stockholm" } });
  assert.deepEqual(automationTiming("Review daily at 2 pm", "Europe/Stockholm").schedule, { at: "14:00", timezone: "Europe/Stockholm" });
  assert.deepEqual(automationTiming("Review every 2 hours", "UTC").schedule, { every: 120 });
  assert.equal(automationTiming("Check when a webhook arrives", "UTC").timing, "event");
  assert.equal(automationTiming("Review tomorrow", "UTC").timing, "once");
});
