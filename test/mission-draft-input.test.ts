import { test } from "node:test";
import assert from "node:assert/strict";
import { missionDraftInput } from "../ui/mission-draft-input.js";
const draft = { name: "Owner edited name", mission: "Improve device connection", users: "Engineers", priorities: ["Clear feedback"], exclusions: ["No hardware changes"], questions: ["Which step?", "How often?"] };

test("mission refinement preserves edited prose and all answered questions, omitting blank answers", () => {
  const input = missionDraftInput(draft, { "Earlier question": " Earlier reply ", "Which step?": "Authentication", "How often?": "  " });
  const context = JSON.parse(input.split("Mission drafting context:\n")[1]!);
  assert.deepEqual(context.draft, draft);
  assert.deepEqual(context.clarifications, [{ question: "Earlier question", answer: "Earlier reply" }, { question: "Which step?", answer: "Authentication" }]);
  assert.match(input, /Do not ask questions that these answers already resolve/);
});

test("mission answers remain JSON data and oversized requests fail before dispatch", () => {
  const input = missionDraftInput(draft, { 'Question "quoted"': 'Reply\nwith "quotes" and JSON {"check":"x"}' });
  const context = JSON.parse(input.split("Mission drafting context:\n")[1]!);
  assert.equal(context.clarifications[0].answer, 'Reply\nwith "quotes" and JSON {"check":"x"}');
  assert.equal(context.draft.check, undefined);
  assert.throws(() => missionDraftInput(draft, { Question: "x".repeat(20_000) }), /too long/);
});
