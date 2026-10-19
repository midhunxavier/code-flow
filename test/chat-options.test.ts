import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "cf-chat-options-home-"));
process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { adapters } = await import("../src/adapters/index.js");
type Run = import("../src/engine.js").Run;
type RunOptions = import("../src/adapters/types.js").RunOptions;
async function idle(run: Run) {
  const deadline = Date.now() + 15000;
  while (run.status === "running" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(run.status, "done", run.error);
}

test("reply and side chat choices reach the adapter, reset defaults, persist per turn, and preserve permission limits", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cf-chat-options-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main"); writeFileSync(join(repo, "README.md"), "Fixture\n"); git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const manager = new RunManager(findPattern);
  const original = adapters.codex.run;
  const calls: RunOptions[] = [];
  adapters.codex.run = async (options) => { calls.push(options); return { ok: true, finalText: "Answered" }; };
  try {
    const run = await manager.start({ pattern: findPattern("solo")!, repo, task: "Inspect the fixture", roles: { agent: ["codex"] }, options: {}, agentSettings: { codex: { model: "original", effort: "low" } }, trust: "standard" });
    await idle(run);
    const worktree = run.worktrees[0]!.name;
    await assert.rejects(manager.followUp(run.id, { kind: "reply", worktree, agent: "claude", message: "Switch provider" }), /original provider/);
    assert.equal(run.followUps.length, 0, "a provider switch is refused before queuing a turn");
    await manager.followUp(run.id, { kind: "reply", worktree, agent: "codex", message: "Next message", settings: { model: "changed", effort: "high" }, trust: "full", tools: false });
    await idle(run);
    assert.equal(calls.at(-1)!.model, "changed"); assert.equal(calls.at(-1)!.effort, "high"); assert.equal(calls.at(-1)!.trust, "full"); assert.equal(calls.at(-1)!.interactiveApprovals, false);
    assert.deepEqual(run.followUps.at(-1)!.settings, { model: "changed", effort: "high" });
    assert.deepEqual(run.agentSettings.codex, { model: "original", effort: "low" });
    await manager.followUp(run.id, { kind: "side", side: { chat: "test", mode: "ask", title: "Read only" }, worktree, agent: "codex", message: "Use defaults", settings: {}, trust: "standard", tools: true });
    await idle(run);
    assert.equal(calls.at(-1)!.model, undefined); assert.equal(calls.at(-1)!.effort, undefined); assert.equal(calls.at(-1)!.interactiveApprovals, true); assert.equal(calls.at(-1)!.mode, "read");
    const count = run.followUps.length;
    await assert.rejects(manager.followUp(run.id, { worktree, agent: "codex", message: "Invalid", settings: { model: "--bad flag" } }), /Invalid model/);
    run.lockdown = "Untrusted source";
    await assert.rejects(manager.followUp(run.id, { worktree, agent: "codex", message: "Escalate", trust: "full" }), /Safe permissions/);
    await assert.rejects(manager.followUp(run.id, { worktree, agent: "codex", message: "Prompt", trust: "safe", tools: true }), /local interactive/);
    delete run.lockdown;
    run.trigger = { id: "test", name: "Test automation", via: "schedule" };
    await assert.rejects(manager.followUp(run.id, { worktree, agent: "codex", message: "Escalate", trust: "full" }), /cannot use Full access/);
    assert.equal(run.followUps.length, count, "rejected choices never queue a message");
  } finally { adapters.codex.run = original; }
});

test("provider handoff copies visible history and saved files into a fresh session and committed worktree", async () => {
  const { readFileSync, rmSync } = await import("node:fs");
  const repo = mkdtempSync(join(tmpdir(), "cf-handoff-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString().trim();
  git("init", "-q", "-b", "main"); writeFileSync(join(repo, "README.md"), "Committed fixture\n"); git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  writeFileSync(join(repo, "README.md"), "User working copy snapshot\n");
  const manager = new RunManager(findPattern);
  const original = { codex: adapters.codex.run, claude: adapters.claude.run };
  const calls: RunOptions[] = [];
  adapters.codex.run = async () => ({ ok: true, finalText: "Prior answer: keep the interface compact", sessionId: "private-source-session" });
  adapters.claude.run = async (options) => { calls.push(options); return { ok: true, finalText: "Context received" }; };
  try {
    const source = await manager.start({ pattern: findPattern("solo")!, repo, task: "Original user request", roles: { agent: ["codex"] }, options: {}, trust: "standard", context: { paths: [{ path: "README.md" }], attachments: [{ name: "requirements.txt", data: Buffer.from("Keep keyboard support").toString("base64") }] } });
    await idle(source);
    await manager.followUp(source.id, { kind: "reply", worktree: "solo", agent: "codex", message: "Follow-up user constraint" });
    await idle(source);
    await manager.followUp(source.id, { kind: "side", side: { chat: "private", mode: "ask", title: "Side discussion" }, worktree: "solo", agent: "codex", message: "Excluded side question" });
    await idle(source);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const tree = source.worktrees[0]!;
    writeFileSync(join(tree.path, "unsaved.txt"), "Do not lose this");
    await assert.rejects(manager.startProviderChat(source.id, { agent: "claude" }), /uncommitted/);
    rmSync(join(tree.path, "unsaved.txt"));
    await assert.rejects(manager.startProviderChat(source.id, { agent: "codex" }), /another provider/);
    source.approvals.tools = true;
    await assert.rejects(manager.startProviderChat(source.id, { agent: "claude" }), /interactive approvals/);
    source.approvals.tools = false;
    const snapshot = JSON.stringify(source);
    const checkpoint = git("rev-parse", tree.branch);
    const child = await manager.startProviderChat(source.id, { agent: "claude", settings: { model: "sonnet", effort: "high" }, message: "Check the reasoning" });
    await idle(child);
    assert.equal(JSON.stringify(source), snapshot, "the original conversation stays intact");
    assert.equal(child.parentRunId, source.id);
    assert.equal(child.baseRef, checkpoint);
    assert.deepEqual(child.roles.agent, ["claude"]);
    assert.equal(child.trust, "standard");
    assert.notEqual(child.worktrees[0]!.path, tree.path);
    assert.equal(calls[0]!.resumeSessionId, undefined, "provider sessions are never transferred");
    assert.equal(calls[0]!.model, "sonnet"); assert.equal(calls[0]!.effort, "high");
    const saved = child.context.attachments.map((file) => ({ name: file.name, text: readFileSync(join(child.worktrees[0]!.path, file.file), "utf8") }));
    const transcript = saved.find((file) => file.name.startsWith("chat-handoff-"))!.text;
    assert.match(transcript, /Original user request/);
    assert.match(transcript, /Follow-up user constraint/);
    assert.match(transcript, /Prior answer: keep the interface compact/);
    assert.doesNotMatch(transcript, /Excluded side question|private-source-session/);
    assert.ok(saved.some((file) => file.text === "Keep keyboard support"));
    assert.ok(saved.some((file) => file.text === "User working copy snapshot\n"));
    assert.match(child.task, /^Check the reasoning/);
    source.status = "running";
    await assert.rejects(manager.startProviderChat(source.id, { agent: "claude" }), /finish/);
    source.status = "done";
  } finally { adapters.codex.run = original.codex; adapters.claude.run = original.claude; }
});
