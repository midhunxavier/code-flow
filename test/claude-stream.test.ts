import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeStream } from "../src/adapters/claude-stream.js";
import type { AgentEvent } from "../src/adapters/types.js";
test("Claude partial events and completed blocks share IDs and retain interrupted text", () => {
  const events: AgentEvent[] = [], stream = new ClaudeStream(event => events.push(event));
  stream.partial({ type: "message_start", message: { id: "m1" } });
  stream.partial({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  stream.partial({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "A partial reply" } });
  assert.equal(stream.lastText, "A partial reply");
  stream.complete({ id: "m1", content: [{ type: "text", text: "A partial reply." }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "README.md" } }] });
  const texts = events.filter(event => event.kind === "text");
  assert.ok(texts.every(event => event.messageId === "m1:0"));
  assert.equal(texts[1]!.delta, true); assert.equal(texts.at(-1)!.delta, undefined);
  assert.equal(stream.lastText, "A partial reply.");
});
