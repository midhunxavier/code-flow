import { test } from "node:test";
import assert from "node:assert/strict";
import { chatTimeline } from "../ui/chat-timeline.js";
import { approvesProposal } from "../src/conversational/proposal-reply.js";
import type { ChatEvent } from "../src/conversational/chat-model.js";
const event = (id: string, kind: ChatEvent["kind"], extra: Partial<ChatEvent> = {}): ChatEvent => ({ id, kind, sequence: 1, at: 1, ...extra });
test("legacy task controls follow their explanation without changing the saved events", () => {
  const events = [event("user", "user"), event("task", "task", { taskId: "t" }), event("answer", "answer", { body: "The plan" })];
  assert.deepEqual(chatTimeline(events).map(e => e.id), ["user", "answer", "task"]);
  assert.deepEqual(events.map(e => e.id), ["user", "task", "answer"]);
});
test("one task follows its latest revised explanation and then its start confirmation", () => {
  const events = [event("task", "task", { taskId: "t" }), event("one", "answer", { taskId: "t", proposal: { id: "p", hash: "a", revision: 1 } }), event("change", "user"), event("two", "answer", { taskId: "t", proposal: { id: "p", hash: "b", revision: 2 } })];
  assert.deepEqual(chatTimeline(events).map(e => e.id), ["one", "change", "two", "task"]);
  events.push(event("approve", "user"), event("start", "receipt", { taskId: "t", body: "Started the reviewed approach." }));
  assert.deepEqual(chatTimeline(events).map(e => e.id), ["one", "change", "two", "approve", "start", "task"]);
  assert.deepEqual(chatTimeline(events.slice(3)).map(e => e.kind), ["answer", "user", "receipt", "task"]);
});
test("only standalone confirmations count as approval", () => {
  for (const text of ["go ahead", "Yes, go ahead!", "start planning", "Approved.", "proceed please"]) assert.equal(approvesProposal(text), true, text);
  for (const text of ["go ahead but use another model", "don't start", "can you start?", 'Explain "go ahead"', "yes", "start a new task"]) assert.equal(approvesProposal(text), false, text);
  assert.equal(approvesProposal("start implementation", "plan"), false);
  assert.equal(approvesProposal("start planning", "plan"), true);
});
