import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chatHandoffContext, portableConversation } from "../src/chat-handoff.js";
import { prepareContext } from "../src/context.js";
import type { Run } from "../src/engine.js";

test("thirty provider handoffs retain one transcript and original attachments", async () => {
  const root = await mkdtemp(join(tmpdir(), "cf-portable-history-"));
  let run = { id: "chat-0", worktreeDir: join(root, "0"), task: "Keep all user constraints", status: "done", context: { paths: [], attachments: [] }, followUps: [], notes: [], steps: [] } as unknown as Run;
  await mkdir(run.worktreeDir);
  run.context = await prepareContext(root, "HEAD", { attachments: [{ name: "requirements.txt", data: Buffer.from("Keep keyboard support").toString("base64") }] }, join(run.worktreeDir, ".context"));
  for (let i = 1; i <= 30; i++) {
    const input = await chatHandoffContext(run, "fixture", true);
    assert.equal(input.attachments?.length, 2);
    const dir = join(root, String(i)); await mkdir(dir);
    run = { ...run, id: `chat-${i}`, task: `Keep constraint ${i}`, worktreeDir: dir, context: await prepareContext(root, "HEAD", input, join(dir, ".context")) };
  }
  const result = await chatHandoffContext(run, "fixture", true);
  const text = Buffer.from(result.attachments![0]!.data, "base64").toString("utf8");
  assert.match(text, /Keep all user constraints/); assert.match(text, /Keep constraint 30/);
  assert.equal((text.match(/## Original user request/g) ?? []).length, 31);
  assert.equal(Buffer.from(result.attachments![1]!.data, "base64").toString(), "Keep keyboard support");
});

test("long portable prompts are bounded while the full attributed history stays readable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cf-bounded-history-")), workspace = join(dir, "workspace"); await mkdir(workspace);
  const run = { id: "bounded", worktreeDir: dir, task: "Retain the original constraint", status: "done", context: { paths: [], attachments: [] }, followUps: [], notes: [{ at: 1, text: "Do not change the contract", status: "delivered" }], steps: [{ kind: "agent", startedAt: 2, endedAt: 3, agent: "agy", status: "done", finalText: "historical output\n".repeat(6000) }] } as unknown as Run;
  const prompt = await portableConversation(run, workspace);
  assert.ok(prompt.length < 48000); assert.match(prompt, /Read it before acting/);
  const full = await readFile(join(workspace, ".codeflow-context/messages/portable-conversation.md"), "utf8");
  assert.match(full, /Do not change the contract/); assert.ok(full.length > 90000);
});
