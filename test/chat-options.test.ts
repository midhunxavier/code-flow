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
    await assert.rejects(manager.followUp(run.id, { kind: "reply", worktree, agent: "claude", message: "Switch provider" }), /current provider/);
    assert.equal(run.followUps.length, 0, "a provider switch is refused before queuing a turn");
    await manager.followUp(run.id, { kind: "reply", worktree, agent: "codex", message: "Next message", settings: { model: "changed", effort: "high" }, trust: "full", tools: false });
    await idle(run);
    assert.equal(calls.at(-1)!.model, "changed"); assert.equal(calls.at(-1)!.effort, "high"); assert.equal(calls.at(-1)!.trust, "full"); assert.equal(calls.at(-1)!.interactiveApprovals, false);
    assert.deepEqual(run.followUps.at(-1)!.settings, { model: "changed", effort: "high" });
    assert.deepEqual(run.agentSettings.codex, { model: "original", effort: "low" });
    await manager.followUp(run.id, { kind: "side", side: { chat: "test", mode: "ask", title: "Read only" }, worktree, agent: "codex", message: "Use defaults", settings: {}, trust: "standard", tools: true });
    await idle(run);
    assert.equal(calls.at(-1)!.model, undefined); assert.equal(calls.at(-1)!.effort, undefined); assert.equal(calls.at(-1)!.interactiveApprovals, false); assert.equal(calls.at(-1)!.mode, "read");
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

test("provider tabs carry visible history into fresh sessions while sharing uncommitted files", async () => {
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
    const snapshot = JSON.stringify(source);
    const checkpoint = git("rev-parse", tree.branch);
    const child = await manager.startProviderChat(source.id, { agent: "claude", settings: { model: "sonnet", effort: "high" }, message: "Check the reasoning" });
    await idle(child);
    assert.equal(JSON.stringify(source), snapshot, "the original conversation stays intact");
    assert.equal(child.parentRunId, source.id);
    assert.equal(child.baseRef, checkpoint);
    assert.deepEqual(child.roles.agent, ["claude"]);
    assert.equal(child.trust, "standard");
    assert.equal(child.worktrees[0]!.path, tree.path);
    assert.equal(readFileSync(join(tree.path, "unsaved.txt"), "utf8"), "Do not lose this");
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
    const fork = await manager.startProviderChat(source.id, { agent: "codex" });
    await idle(fork);
    assert.equal(fork.worktrees[0]!.path, tree.path, "same-provider forks also keep the workspace");
    assert.equal(fork.chatLink?.workspaceId, source.id);
    await manager.archive(child.id, { cleanup: true, deleteBranches: true });
    assert.equal(readFileSync(join(tree.path, "unsaved.txt"), "utf8"), "Do not lose this");
    await assert.rejects(manager.deleteRun(source.id), /shared workspace/);
  } finally { adapters.codex.run = original.codex; adapters.claude.run = original.claude; }
});

test("managed follow-ups journal explicit policy changes and child runs retain required restrictions", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cf-managed-policy-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main"); writeFileSync(join(repo, "README.md"), "Fixture\n"); git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const manager = new RunManager(findPattern), original = adapters.codex.run;
  const calls: RunOptions[] = [];
  adapters.codex.run = async options => { calls.push(options); return { ok: true, finalText: "Answered" }; };
  try {
    const run = await manager.start({ pattern: findPattern("solo")!, repo, task: "Inspect", roles: { agent: ["codex"] }, options: {}, trust: "standard", permissionRequirements: ["no-command-network"] });
    await idle(run);
    assert.equal(run.permissions?.revision, 1);
    assert.equal(calls.at(-1)?.permissions?.nativeDelegation, false);
    const worktree = run.worktrees[0]!.name;
    await assert.rejects(manager.followUp(run.id, { kind: "reply", worktree, agent: "codex", message: "Invalid", trust: "full", settings: { model: "--bad flag" } }), /Invalid model/);
    assert.equal(run.permissions?.revision, 1); assert.equal(run.trust, "standard");
    await assert.rejects(manager.followUp(run.id, { kind: "reply", worktree, agent: "codex", message: "Loosen network", trust: "trusted" }), /network restriction/);
    assert.equal(run.permissions?.revision, 1); assert.equal(run.trust, "standard");
    await manager.followUp(run.id, { kind: "reply", worktree, agent: "codex", message: "Reduce access", trust: "safe" });
    await idle(run);
    assert.equal(run.permissions?.revision, 2); assert.equal(calls.at(-1)?.permissions?.trust, "safe");
    const child = await manager.start({ parentRunId: run.id, pattern: findPattern("solo")!, repo, task: "Child cannot raise authority", roles: { agent: ["codex"] }, options: {}, trust: "full", approvals: { tools: true } });
    await idle(child);
    assert.equal(child.trust, "safe"); assert.equal(child.approvals.tools, false);
    assert.deepEqual(child.permissions?.required, ["no-command-network"]);
    const pending = await Promise.allSettled([
      manager.followUp(run.id, { kind: "reply", worktree, agent: "codex", message: "First", trust: "standard" }),
      manager.followUp(run.id, { kind: "reply", worktree, agent: "codex", message: "Second", trust: "safe" }),
    ]);
    assert.equal(pending.filter(r => r.status === "fulfilled").length, 1, "policy-changing follow-ups are serialized");
    await idle(run);
    await assert.rejects(manager.start({ parentRunId: run.id, pattern: findPattern("solo")!, repo, task: "Continue", roles: { agent: ["claude"] }, options: {}, trust: "standard" }), /network restriction/);
  } finally { adapters.codex.run = original; await manager.shutdown(); }
});

test("side chats answer concurrently; writer tabs queue, cancellation preserves the queue, and side reads never restore a writer's files", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cf-concurrent-chat-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString().trim();
  git("init", "-q", "-b", "main"); writeFileSync(join(repo, "README.md"), "base\n"); git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const original = adapters.codex.run, manager = new RunManager(findPattern);
  let releaseWriter!: () => void, writerStarted!: () => void, sideStarted!: () => void, releaseSide!: () => void;
  const writerReady = new Promise<void>(resolve => writerStarted = resolve), sideReady = new Promise<void>(resolve => sideStarted = resolve);
  const writerGate = new Promise<void>(resolve => releaseWriter = resolve), sideGate = new Promise<void>(resolve => releaseSide = resolve);
  const called: string[] = [];
  adapters.codex.run = async options => {
    called.push(options.prompt);
    if (options.prompt.includes("Hold the main writer")) { writerStarted(); await writerGate; writeFileSync(join(options.cwd, "README.md"), "main's uncommitted work\n"); }
    if (options.prompt.includes("Independent side question")) { assert.equal(options.mode, "read"); sideStarted(); await sideGate; }
    return { ok: true, finalText: "Answered", sessionId: "session-" + called.length };
  };
  try {
    const source = await manager.start({ pattern: findPattern("solo")!, repo, task: "Hold the main writer", roles: { agent: ["codex"] }, options: {} });
    await writerReady;
    await assert.rejects(manager.startProviderChat(source.id, { agent: "agy", kind: "side" }), /Isolated Antigravity requires/);
    const side = await manager.startProviderChat(source.id, { agent: "codex", kind: "side", message: "Independent side question" });
    await sideReady;
    assert.equal(source.status, "running");
    const tab = await manager.startProviderChat(source.id, { agent: "codex", message: "Queued cancelled writer" });
    const last = await manager.startProviderChat(source.id, { agent: "codex", message: "Last writer" });
    manager.cancel(tab.id);
    assert.ok(!called.some(prompt => prompt.includes("Last writer")));
    releaseWriter(); await idle(source);
    releaseSide(); await idle(side); await idle(last);
    assert.ok(!called.some(prompt => prompt.includes("Queued cancelled writer")));
    assert.equal((await import("node:fs")).readFileSync(join(source.worktrees[0]!.path, "README.md"), "utf8"), "main's uncommitted work\n");
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: source.worktrees[0]!.path }).toString().trim(), git("rev-parse", "HEAD"), "Agent turns do not auto-commit");
  } finally { releaseWriter?.(); releaseSide?.(); adapters.codex.run = original; await manager.shutdown(); }
});


test("Agent provider forks preserve the Antigravity executor permission receipt", { skip: process.platform !== "darwin" }, async () => {
  const { agyManagedOptionsProblem } = await import("../src/adapters/agy-isolation.js");
  const { agyNativeOptionsProblem } = await import("../src/adapters/agy.js");
  const repo = mkdtempSync(join(tmpdir(), "cf-agy-agent-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main"); writeFileSync(join(repo, "README.md"), "Fixture\n"); git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const manager = new RunManager(findPattern), original = { agy: adapters.agy.run, codex: adapters.codex.run };
  const calls: RunOptions[] = [];
  adapters.codex.run = async () => ({ ok: true, finalText: "Remember amber-482" });
  adapters.agy.run = async opts => {
    calls.push(opts);
    const problem = opts.permissions?.implementation === "agy-native-v1" ? agyNativeOptionsProblem(opts) : agyManagedOptionsProblem(opts);
    return problem ? { ok: false, finalText: "", error: problem, errorKind: "cli_incompatible" } : { ok: true, finalText: "amber-482" };
  };
  try {
    for (const execution of ["isolated", "native"] as const) {
      const source = await manager.start({ pattern: findPattern("solo")!, repo, task: "Remember amber-482", roles: { agent: ["codex"] }, options: {}, trust: "full", antigravityExecution: execution });
      await idle(source);
      const child = await manager.startProviderChat(source.id, { agent: "agy", message: "Recall the token" });
      await idle(child);
      assert.equal(calls.at(-1)?.permissions?.nativeDelegation, execution === "native");
      await manager.followUp(child.id, { kind: "reply", worktree: "solo", agent: "agy", message: "Repeat the token" });
      await idle(child);
      assert.equal(calls.at(-1)?.permissions?.nativeDelegation, execution === "native");
      const family = manager.page({ limit: 1, query: "Recall the token", predicate: run => run.id === child.id || run.id === source.id });
      assert.deepEqual(family.runs.map(run => run.id), [child.id]);
      assert.deepEqual(family.related.map(run => run.id), [source.id], "filtered pagination still returns the owning task");
      assert.equal(manager.page({ limit: 1, query: "Recall the token", predicate: run => run.id === child.id }).related.length, 0, "related history honors access predicates");
    }
  } finally { adapters.agy.run = original.agy; adapters.codex.run = original.codex; await manager.shutdown(); }
});


test("explicit Agent resume retries a compatibility failure recorded before an adapter repair", async () => {
  const { journalEntry, flushWrites } = await import("../src/store.js");
  const repo = mkdtempSync(join(tmpdir(), "cf-chat-repair-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main"); writeFileSync(join(repo, "README.md"), "Fixture\n"); git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const manager = new RunManager(findPattern), original = adapters.codex.run;
  let calls = 0;
  adapters.codex.run = async () => ++calls === 1 ? { ok: false, finalText: "", errorKind: "cli_incompatible", error: "Previous adapter rejected the receipt" } : { ok: true, finalText: "Recovered with the same task" };
  try {
    const run = await manager.start({ pattern: findPattern("solo")!, repo, task: "Keep this conversation", roles: { agent: ["codex"] }, options: {}, trust: "standard" });
    const deadline = Date.now() + 15000;
    while (run.status === "running" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve,20));
    assert.equal(run.status,"failed");
    const policy = structuredClone(run.permissions);
    // Simulate the stale failed outcome persisted by the previous app version.
    await journalEntry(run.id, "ask:agent|codex|solo|Your task#1", {ok:false,finalText:"",errorKind:"cli_incompatible",error:run.error,agent:"codex",stepId:run.steps[0]!.id,worktree:"solo"});
    await flushWrites(run.id);
    await manager.resume(run.id); await idle(run);
    assert.equal(calls,2, "the repaired adapter really runs again");
    assert.deepEqual(run.permissions,policy, "retry retains the original authority");
    assert.equal(run.steps[0]!.status,"failed", "the historical failure remains visible");
    assert.equal(run.steps.at(-1)!.status,"done");
    assert.equal(run.summary,"Recovered with the same task");
  } finally { adapters.codex.run = original; await manager.shutdown(); }
});
