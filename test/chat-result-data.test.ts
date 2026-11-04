import { test } from "node:test";
import assert from "node:assert/strict";
import { chatResultExecution } from "../ui/chat-result-data.js";
import type { ChatEvent } from "../src/conversational/chat-model.js";
import type { TaskSnapshot } from "../src/conversational/service.js";
const result: ChatEvent = { id: "result-old", kind: "result", taskId: "task", runId: "old", at: 1, sequence: 5 };
const oldArtifact = { id: "final-old", sha256: "old-hash", kind: "result" as const };
const current = { id: "new", artifacts: [{ ...oldArtifact, id: "final-new", sha256: "new-hash" }] } as NonNullable<TaskSnapshot["execution"]>;
test("a historical chat result retains its exact run and artifact hashes", () => {
  assert.deepEqual(chatResultExecution({ ...result, evidence: [oldArtifact] }, current), { id: "old", artifacts: [oldArtifact] });
  assert.deepEqual(chatResultExecution({ ...result, artifact: { ...oldArtifact, data: {} } }, current)?.artifacts[0]?.id, "final-old");
});
test("legacy results only reuse metadata from the matching execution", () => {
  assert.equal(chatResultExecution(result, current), undefined);
  assert.equal(chatResultExecution({ ...result, runId: "new" }, current)?.artifacts[0]?.sha256, "new-hash");
});
