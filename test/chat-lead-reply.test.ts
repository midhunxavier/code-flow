import { test } from "node:test";
import assert from "node:assert/strict";
import { runTitle } from "../src/run-title.js";
import { chatLeadReply } from "../ui/chat-lead-reply.js";

test("lead proposals display readable participants and nested work while preserving unspecified effort", () => {
  assert.equal(runTitle({ id: "lead", task: "CODEFLOW_CHAT_LEAD\nPrivate instructions", pattern: "chat-lead" }), "Conversation lead");
  const reply = chatLeadReply(JSON.stringify({ kind: "proposal", body: "Two independent reviewers inspect the snapshot.", candidate: {
    scope: "review", source: "head", participants: [{ id: "haiku", provider: "claude", model: "claude-haiku-5-5", effort: "high" }, { id: "luna", provider: "codex", model: "gpt-6-luna" }],
    completion: ["Both reports include evidence"], steps: [{ type: "parallel", tasks: [{ type: "task", participant: "haiku", operation: "review_code", instructions: "Inspect the code." }] }, { type: "finish", outcome: "review_complete" }], limits: { maxInvocations: 12, maxMinutes: 30 },
  } }));
  assert.equal(reply?.body, "Two independent reviewers inspect the snapshot.");
  assert.equal(reply?.participants[0]?.effort, "high");
  assert.equal(reply?.participants[1]?.effort, undefined, "the view must not invent high effort");
  assert.equal(reply?.steps[0]?.children[0]?.detail, "Inspect the code.");
  assert.equal(reply?.steps[1]?.title, "Deliver review complete");
  assert.deepEqual([reply?.calls, reply?.minutes], [12, 30]);
});
test("lead answers remain text and malformed historical envelopes do not crash the view", () => {
  assert.equal(chatLeadReply(JSON.stringify({ kind: "answer", body: "A readable answer." }))?.body, "A readable answer.");
  for (const text of ["plain text", "null", "[]", '{"kind":"answer","body":5}', '{"kind":"other","body":"text"}']) assert.equal(chatLeadReply(text), undefined);
  assert.deepEqual(chatLeadReply(JSON.stringify({ kind: "proposal", body: "Partial record", candidate: { participants: [null, {}, 1], steps: [null, { type: "gate" }, { type: "loop", steps: null }], completion: [1, "A criterion"] } }))?.completion, ["A criterion"]);
});
