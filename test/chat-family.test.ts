import { test } from "node:test";
import assert from "node:assert/strict";
import { groupChatTasks } from "../src/chat-family.js";
import type { RunSummary } from "../src/engine.js";

test("forks and side chats group by workspace while ordinary continuations remain separate tasks", () => {
  const root = { id: "task", pattern: "solo", task: "Original task", createdAt: 1 } as RunSummary;
  const fork = { ...root, id: "fork", task: "Fork request", createdAt: 2, parentRunId: root.id, chatLink: { workspaceId: root.id, sourceId: root.id, kind: "tab" as const } };
  const side = { ...fork, id: "side", createdAt: 3, endedAt: 8, parentRunId: fork.id, chatLink: { ...fork.chatLink, sourceId: fork.id, kind: "side" as const } };
  const independent = { ...root, id: "separate", createdAt: 4, parentRunId: root.id };
  const groups = groupChatTasks([side, independent, fork, root]);
  assert.deepEqual(groups.map(task => task.id), ["task", "separate"]);
  assert.equal(groups[0]!.root, root);
  assert.deepEqual(groups[0]!.chats.map(chat => chat.id), ["task", "fork", "side"]);
  assert.equal(groups[0]!.updatedAt, 8);
  assert.equal(groupChatTasks([side, fork])[0]!.id, "task", "partial pages retain the canonical task identity");
});
