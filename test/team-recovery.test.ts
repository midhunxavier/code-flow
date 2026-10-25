import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "cf-team-recovery-"));
process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { getAdapter } = await import("../src/adapters/index.js");
const { steeringTargets } = await import("../src/team-steering.js");
const { agentToolBridge } = await import("../src/agent-tools.js");
const { AgentComputer } = await import("../src/agent-computer.js");
const { loadJournal } = await import("../src/store.js");
function repository() {
  const repo = mkdtempSync(join(tmpdir(), "cf-recovery-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo }); mkdirSync(join(repo, ".codeflow"));
  writeFileSync(join(repo, ".codeflow/config.json"), '{"prove":false}'); writeFileSync(join(repo, "README.md"), "Fixture\n");
  execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-qm", "Fixture"], { cwd: repo }); return repo;
}
async function until(fn: () => boolean) { const deadline = Date.now() + 45000; while (!fn()) { if (Date.now() > deadline) throw new Error("Recovery timed out"); await new Promise(resolve => setTimeout(resolve, 20)); } }
test("steering distinguishes targets from protected siblings and invalidates dependents", () => {
  const tasks = ["api", "docs", "client"].map(id => ({ id, title: `Update ${id}`, paths: [`${id}.txt`], owner: id, dependsOn: id === "client" ? ["api"] : [] })) as import("../src/teams.js").TeamTask[];
  assert.deepEqual(steeringTargets("Update api.txt; leave docs.txt alone.", tasks, []), ["api", "client"]);
  assert.deepEqual(steeringTargets("Update api.txt, don't change docs.txt.", tasks, []), ["api", "client"]);
  assert.deepEqual(steeringTargets("Do not touch docs.txt, update api.txt instead.", tasks, []), ["api", "client"]);
  assert.deepEqual(steeringTargets("Leave docs.txt alone.", tasks, []), ["docs"]);
  assert.deepEqual(steeringTargets("Why are you changing the API? Keep it unchanged.", tasks, []), ["api", "client"]);
});
test("selective correction cancels only its worker; siblings finish once in the same execution", { timeout: 60000 }, async () => {
  const release = join(process.env.CODEFLOW_HOME!, "release-slow"); process.env.FAKE_AUTO_SLOW_RELEASE = release;
  const manager = new RunManager(findPattern);
  try {
    const parent = await manager.start({ pattern: findPattern("solo")!, repo: repository(), task: "AUTO-EVENT Implement the sample", roles: { agent: ["claude"] }, options: {}, taskTeam: { enabled: true, preset: "adaptive", coordinator: "claude", providers: ["claude", "codex"], settings: {}, maxMembers: 4, maxCalls: 24, maxMinutes: 5, approvePlan: false } });
    await until(() => !!parent.teamTurns?.length);
    const child = manager.get(parent.teamTurns![0]!.executionId)!;
    await until(() => child.steps.some(step => step.taskId === "slow" && step.status === "running") && child.steps.some(step => step.taskId === "beta"));
    const question = await manager.addTeamNote(parent.id, "Please explain the current result.");
    await until(() => !!question.deliveredTo && parent.steps.some(step => step.id === question.deliveredTo!.stepId && step.status === "done"));
    assert.equal(child.status, "running", "the lead answers before delegation finishes");
    assert.equal(parent.steps.find(step => step.id === question.deliveredTo!.stepId)!.mode, "read");
    const note = await manager.addTeamNote(parent.id, "Update the slow assignment: preserve the revised wording.");
    assert.deepEqual(note.teamDelivery?.taskIds, ["slow"]);
    await until(() => child.steps.filter(step => step.taskId === "slow").length === 2 || parent.status !== "running");
    writeFileSync(release, "continue"); await until(() => parent.status !== "running");
    assert.equal(parent.status, "done", parent.error); assert.equal(child.status, "done", child.error);
    assert.equal(parent.teamTurns![0]!.executionId, child.id); assert.equal(parent.teamTurns![0]!.priorExecutions, undefined);
    assert.equal(child.steps.filter(step => step.taskId === "alpha").length, 1); assert.equal(child.steps.filter(step => step.taskId === "beta").length, 1);
    assert.equal(child.steps.find(step => step.taskId === "slow")!.status, "cancelled");
    assert.equal(child.team!.tasks.find(task => task.id === "slow")!.attempts, 2);
    assert.equal(note.teamDelivery?.state, "applied");
    assert.deepEqual(steeringTargets("Revise alpha", child.team!.tasks, child.team!.members), ["alpha", "beta"]);
    assert.ok(readFileSync(join(parent.worktrees[0]!.path, "claude-slow.txt"), "utf8"));
  } finally { writeFileSync(release, "continue"); delete process.env.FAKE_AUTO_SLOW_RELEASE; await manager.shutdown(); }
});

for (const role of ["coordinator", "reviewer"] as const) test(`${role} provider failure uses another allowed provider without repeating completed work`, { timeout: 60000 }, async () => {
  const adapter = getAdapter(role === "coordinator" ? "claude" : "codex"), original = adapter.run;
  let failed = false;
  adapter.run = async (options, emit) => {
    if (!failed && (role === "coordinator" ? options.prompt.includes("AUTO_TEAM_PLAN") : options.prompt.includes("You have not authored this work"))) { failed = true; return { ok: false, finalText: "", errorKind: "usage_limit", error: "Synthetic provider exhaustion" }; }
    return original.call(adapter, options, emit);
  };
  const manager = new RunManager(findPattern);
  try {
    const run = await manager.start({ pattern: findPattern("auto-team")!, repo: repository(), task: "AUTO-MINIMAL Implement the sample", roles: { coordinator: ["claude"], pool: ["claude", "codex"] }, options: { eventDriven: true }, approvals: { plan: false }, loop: { maxSteps: 20, maxMinutes: 5 } });
    await until(() => run.status !== "running");
    assert.ok(failed); assert.equal(run.status, "done", run.error);
    assert.ok(run.team!.providerChanges?.some(change => change.role === role && change.from !== change.to));
    assert.equal(run.steps.filter(step => step.taskId === "alpha" && step.title.startsWith("Auto task")).length, 1);
    assert.equal(run.team!.tasks[0]!.status, "completed");
    assert.ok(run.team!.providerChanges!.every(change => ["claude", "codex"].includes(change.to)));
    assert.ok(run.steps.filter(step => step.mode === "read").every(step => step.permissions?.mode === "read"));
  } finally { adapter.run = original; await manager.shutdown(); }
});

test("restart after a selective correction reuses completed sibling work and the same execution", { timeout: 90000 }, async () => {
  const release = join(process.env.CODEFLOW_HOME!, "restart-release"); process.env.FAKE_AUTO_SLOW_RELEASE = release;
  const manager = new RunManager(findPattern); let restored: InstanceType<typeof RunManager> | undefined;
  try {
    const parent = await manager.start({ pattern: findPattern("solo")!, repo: repository(), task: "AUTO-EVENT Implement the sample", roles: { agent: ["claude"] }, options: {}, taskTeam: { enabled: true, preset: "adaptive", coordinator: "claude", providers: ["claude", "codex"], settings: {}, maxMembers: 4, maxCalls: 28, maxMinutes: 5, approvePlan: false } });
    await until(() => !!parent.teamTurns?.length);
    const child = manager.get(parent.teamTurns![0]!.executionId)!;
    await until(() => child.team?.tasks.find(task => task.id === "beta")?.status === "submitted" && child.steps.some(step => step.taskId === "slow" && step.status === "running"));
    await manager.addTeamNote(parent.id, "Update only the slow assignment: preserve the revised wording after restart.");
    await until(() => child.steps.filter(step => step.taskId === "slow").length === 2);
    await manager.shutdown();
    restored = new RunManager(findPattern); await restored.load(); writeFileSync(release, "continue");
    const resumed = await restored.resume(parent.id); await until(() => resumed.status !== "running");
    assert.equal(resumed.status, "done", resumed.error);
    assert.equal(resumed.teamTurns![0]!.executionId, child.id);
    const recovered = restored.get(child.id)!;
    assert.equal(recovered.status, "done", recovered.error);
    assert.equal(recovered.steps.filter(step => step.taskId === "alpha").length, 1);
    assert.equal(recovered.steps.filter(step => step.taskId === "beta").length, 1);
    assert.equal(recovered.team!.tasks.find(task => task.id === "slow")!.userCorrections?.length, 1);
    assert.equal(recovered.team!.tasks.find(task => task.id === "slow")!.steeringVersion, 1);
  } finally { writeFileSync(release, "continue"); delete process.env.FAKE_AUTO_SLOW_RELEASE; await manager.shutdown(); await restored?.shutdown(); }
});

test("strict independent-provider review stops safely when no allowed replacement remains", { timeout: 60000 }, async () => {
  const adapter = getAdapter("codex"), original = adapter.run; let failed = false;
  adapter.run = async (options, emit) => {
    if (options.prompt.includes("You have not authored this work")) { failed = true; return { ok: false, finalText: "", errorKind: "usage_limit", error: "Synthetic reviewer exhaustion" }; }
    return original.call(adapter, options, emit);
  };
  const manager = new RunManager(findPattern);
  try {
    const run = await manager.start({ pattern: findPattern("auto-team")!, repo: repository(), task: "AUTO-MINIMAL Implement the sample", roles: { coordinator: ["claude"], pool: ["claude", "codex"] }, options: { eventDriven: true, differentProviderReview: true }, approvals: { plan: false }, loop: { maxSteps: 20, maxMinutes: 5 } });
    await until(() => run.status !== "running");
    assert.ok(failed); assert.equal(run.status, "failed"); assert.match(run.error!, /No eligible replacement/);
    assert.equal(run.team!.tasks[0]!.status, "submitted");
    assert.ok(!run.team!.providerChanges?.some(change => change.role === "reviewer"));
    assert.ok(!run.steps.some(step => step.agent === "agy"));
  } finally { adapter.run = original; await manager.shutdown(); }
});

test("Resume re-probes a recovered reviewer after restart without replaying completed work", { timeout: 90000 }, async () => {
  const adapter = getAdapter("codex"), original = adapter.run; let reviews = 0;
  adapter.run = async (options, emit) => {
    if (options.prompt.includes("You have not authored this work") && ++reviews === 1) return { ok: false, finalText: "", errorKind: "usage_limit", error: "Synthetic reviewer exhaustion" };
    return original.call(adapter, options, emit);
  };
  const manager = new RunManager(findPattern); let restored: InstanceType<typeof RunManager> | undefined;
  try {
    const run = await manager.start({ pattern: findPattern("auto-team")!, repo: repository(), task: "AUTO-MINIMAL Implement the sample", roles: { coordinator: ["claude"], pool: ["claude", "codex"] }, options: { eventDriven: true, differentProviderReview: true }, approvals: { plan: false }, loop: { maxSteps: 20, maxMinutes: 5 } });
    await until(() => run.status !== "running"); assert.equal(run.status, "failed", run.error);
    await manager.shutdown(); restored = new RunManager(findPattern); await restored.load();
    const resumed = await restored.resume(run.id); await until(() => resumed.status !== "running");
    assert.equal(resumed.status, "done", resumed.error); assert.equal(reviews, 2);
    assert.equal(resumed.steps.filter(step => step.title.startsWith("Auto task")).length, 1);
    assert.equal(resumed.steps.filter(step => step.title.toLowerCase().includes("plan") && step.status === "done").length, 1);
    assert.ok(!resumed.team!.providerChanges?.some(change => change.role === "reviewer"));
  } finally { adapter.run = original; await manager.shutdown(); await restored?.shutdown(); }
});

test("a completed team hands its final answer to an allowed provider with portable context", { timeout: 60000 }, async () => {
  const claude = getAdapter("claude"), codex = getAdapter("codex"), original = claude.run, originalCodex = codex.run;
  let finalAttempts = 0, handoff = false;
  claude.run = async (options, emit) => {
    if (options.prompt.includes("## Code Flow team execution receipt")) { finalAttempts++; return { ok: false, finalText: "", errorKind: "usage_limit", error: "Synthetic lead exhaustion" }; }
    return original.call(claude, options, emit);
  };
  codex.run = async (options, emit) => {
    if (options.prompt.includes("## Code Flow team execution receipt")) { handoff = true; assert.ok(!options.resumeSessionId); assert.match(options.prompt, /Remember pineapple/); }
    return originalCodex.call(codex, options, emit);
  };
  const manager = new RunManager(findPattern);
  try {
    const parent = await manager.start({ pattern: findPattern("solo")!, repo: repository(), task: "Remember pineapple", roles: { agent: ["claude"] }, options: {} });
    await until(() => parent.status !== "running");
    await manager.configureTaskTeam(parent.id, { enabled: true, preset: "adaptive", coordinator: "claude", providers: ["claude", "codex"], settings: {}, maxMembers: 3, maxCalls: 20, maxMinutes: 5, approvePlan: false });
    await manager.followUp(parent.id, { kind: "reply", agent: "claude", worktree: "solo", message: "AUTO-MINIMAL Implement the sample" });
    await until(() => parent.status !== "running");
    assert.equal(parent.status, "done", parent.error); assert.ok(handoff); assert.equal(finalAttempts, 1);
    assert.equal(parent.followUps.at(-1)!.agent, "codex"); assert.equal(parent.conversationAgent, "codex");
    assert.equal(parent.teamTurns!.length, 1); assert.equal(manager.get(parent.teamTurns![0]!.executionId)!.status, "done");
    assert.equal(parent.steps.at(-1)!.agent, "codex");
    await manager.configureTaskTeam(parent.id, { ...parent.taskTeam!, enabled: false });
    await manager.followUp(parent.id, { kind: "reply", agent: "codex", worktree: "solo", message: "What did I ask you to remember?" });
    await until(() => parent.status !== "running"); assert.equal(parent.status, "done", parent.error);
    assert.equal(parent.teamTurns!.length, 1);
  } finally { claude.run = original; codex.run = originalCodex; await manager.shutdown(); }
});

test("Resume team in the parent chat refreshes the receipt and answer without a new execution", { timeout: 90000 }, async () => {
  const adapters = [getAdapter("claude"), getAdapter("codex")], originals = adapters.map(adapter => adapter.run); let unavailable = true;
  adapters.forEach((adapter, i) => { adapter.run = async (options, emit) => unavailable && options.prompt.includes("You have not authored this work") ? { ok: false, finalText: "", errorKind: "usage_limit", error: "Synthetic review outage" } : originals[i]!.call(adapter, options, emit); });
  const manager = new RunManager(findPattern);
  try {
    const parent = await manager.start({ pattern: findPattern("solo")!, repo: repository(), task: "AUTO-MINIMAL Implement the sample", roles: { agent: ["claude"] }, options: {}, taskTeam: { enabled: true, preset: "adaptive", coordinator: "claude", providers: ["claude", "codex"], settings: {}, maxMembers: 3, maxCalls: 20, maxMinutes: 5, approvePlan: false } });
    await until(() => parent.status !== "running");
    const child = manager.get(parent.teamTurns![0]!.executionId)!; assert.equal(child.status, "failed", child.error);
    const savedTurn = structuredClone(parent.teamTurns![0]), savedPatternDone = parent.patternDone;
    const resume = manager.resume.bind(manager);
    manager.resume = async () => { throw new Error("Synthetic repository admission failure"); };
    await assert.rejects(manager.resumeTaskTeam(parent.id, child.id), /admission failure/);
    assert.deepEqual(JSON.parse(JSON.stringify(parent.teamTurns![0])), JSON.parse(JSON.stringify(savedTurn)), "a refused Resume preserves the saved result and retry controls");
    assert.equal(parent.patternDone, savedPatternDone);
    manager.resume = resume;
    unavailable = false; await manager.resumeTaskTeam(parent.id, child.id); await until(() => parent.status !== "running");
    assert.equal(parent.status, "done", parent.error); assert.equal(child.status, "done", child.error);
    assert.equal(parent.teamTurns!.length, 1); assert.equal(parent.teamTurns![0]!.executionId, child.id);
    assert.equal(child.steps.filter(step => step.title.startsWith("Auto task")).length, 1);
    assert.match(parent.teamTurns![0]!.report!, /: done/);
  } finally { adapters.forEach((adapter, i) => { adapter.run = originals[i]!; }); await manager.shutdown(); }
});

test("all final-answer providers can recover on Resume without repeating the completed team", { timeout: 90000 }, async () => {
  const adapters = [getAdapter("claude"), getAdapter("codex")], originals = adapters.map(adapter => adapter.run); let unavailable = true;
  adapters.forEach((adapter, i) => { adapter.run = async (options, emit) => unavailable && options.prompt.includes("## Code Flow team execution receipt") ? { ok: false, finalText: "", errorKind: "usage_limit", error: "Synthetic answer outage" } : originals[i]!.call(adapter, options, emit); });
  const manager = new RunManager(findPattern);
  try {
    const parent = await manager.start({ pattern: findPattern("solo")!, repo: repository(), task: "AUTO-MINIMAL Implement the sample", roles: { agent: ["claude"] }, options: {}, taskTeam: { enabled: true, preset: "adaptive", coordinator: "claude", providers: ["claude", "codex"], settings: {}, maxMembers: 3, maxCalls: 20, maxMinutes: 5, approvePlan: false } });
    await until(() => parent.status !== "running"); assert.equal(parent.status, "failed");
    const child = manager.get(parent.teamTurns![0]!.executionId)!; assert.equal(child.status, "done", child.error); const steps = child.steps.length;
    unavailable = false; await manager.resume(parent.id); await until(() => parent.status !== "running");
    assert.equal(parent.status, "done", parent.error); assert.equal(child.steps.length, steps); assert.equal(parent.teamTurns!.length, 1);
  } finally { adapters.forEach((adapter, i) => { adapter.run = originals[i]!; }); await manager.shutdown(); }
});

test("Resume restores shared-action receipts from the journal before retrying an interrupted provider", { timeout: 60000 }, async () => {
  const adapter = getAdapter("claude"), original = adapter.run, originalComputer = (agentToolBridge as any).computer;
  const manager = new RunManager(findPattern); let restored: InstanceType<typeof RunManager> | undefined;
  let runId = "", calls = 0, effects = 0, action: Record<string, unknown>;
  (agentToolBridge as any).computer = new AgentComputer(async input => {
    if ((input as { action?: string }).action === "type") {
      const entries = [...(await loadJournal(runId, { strict: true })).values()] as any[];
      assert.ok(entries.some(value => value?.receipt?.id === "external-once" && value.receipt.state === "started"), "intent is durable before the external action");
      effects++;
    }
    return { data: "test", width: 1000, height: 600, pointWidth: 1000, pointHeight: 600, app: "Fixture" };
  });
  adapter.run = async options => {
    calls++; assert.ok(options.agentTools);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const response = await fetch(options.agentTools!.endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${options.agentTools!.token}` }, body: JSON.stringify({ name, arguments: args }) });
      assert.equal(response.status, 200); return await response.json() as any;
    };
    const screenshot = JSON.parse((await call("computer_screenshot")).content[0].text).screenshot;
    if (calls === 1) action = { action: "type", screenshot, text: "once", operationId: "external-once" };
    const result = await call("computer_action", action);
    if (calls === 1) return { ok: false, finalText: "", errorKind: "cli_incompatible", error: "Synthetic provider interruption after the action" };
    assert.match(result.content[0].text, /already completed/);
    return { ok: true, finalText: "Recovered without repeating the action" };
  };
  try {
    const run = await manager.start({ pattern: findPattern("solo")!, repo: repository(), task: "Exercise the shared action", roles: { agent: ["claude"] }, options: {}, trust: "full" }); runId = run.id;
    await until(() => run.status !== "running"); assert.equal(run.status, "failed", run.error); assert.equal(effects, 1);
    await manager.shutdown(); restored = new RunManager(findPattern); await restored.load();
    for (const step of restored.get(run.id)!.steps) step.sharedToolActions = undefined; // Simulate an event checkpoint lagging behind its durable journal.
    const resumed = await restored.resume(run.id); await until(() => resumed.status !== "running");
    assert.equal(resumed.status, "done", resumed.error); assert.equal(calls, 2); assert.equal(effects, 1);
    assert.ok(resumed.steps.some(step => step.sharedToolActions?.some(receipt => receipt.id === "external-once" && receipt.state === "completed")));
    const codex = getAdapter("codex"), originalCodex = codex.run;
    codex.run = adapter.run;
    try {
      const tab = await restored.startProviderChat(run.id, { agent: "codex", message: "Continue the same task" });
      await until(() => tab.status !== "running");
      assert.equal(tab.status, "done", tab.error); assert.equal(effects, 1);
      assert.equal((await restored.taskActionHistory(tab)).find(action => action.id === "external-once")?.state, "completed");
    } finally { codex.run = originalCodex; }
  } finally { adapter.run = original; await manager.shutdown(); await restored?.shutdown(); (agentToolBridge as any).computer = originalComputer; }
});


test("Stop wins over a pending Team question, and Resume preserves the unanswered question", { timeout: 90000 }, async () => {
  const manager = new RunManager(findPattern);
  try {
    const parent = await manager.start({ pattern: findPattern("solo")!, repo: repository(), task: "AUTO-USER-QUESTION Implement the sample", roles: { agent: ["claude"] }, options: {}, taskTeam: { enabled: true, preset: "adaptive", coordinator: "claude", providers: ["claude"], settings: {}, maxMembers: 3, maxCalls: 24, maxMinutes: 5, approvePlan: false } });
    await until(() => !!parent.teamTurns?.length);
    const child = manager.get(parent.teamTurns![0]!.executionId)!;
    await until(() => !!child.team?.awaitingRequestId);
    const requestId = child.team!.awaitingRequestId;
    const note = await manager.addTeamNote(parent.id, "Stop the team and wait.");
    await until(() => parent.status !== "running");
    assert.equal(parent.status, "cancelled"); assert.equal(child.status, "cancelled"); assert.equal(note.control, "stop");
    assert.ok(!child.team!.messages.some(message => message.requestId === requestId && message.kind === "reply"));
    assert.equal(child.team!.tasks[0]!.attempts, 1);
    await manager.resumeTaskTeam(parent.id, child.id);
    await until(() => !!child.team?.awaitingRequestId && child.status === "running");
    await manager.addTeamNote(parent.id, "Use the requested fixture value.");
    await until(() => parent.status !== "running");
    assert.equal(child.status, "done", child.error); assert.equal(parent.status, "done", parent.error);
    assert.ok(!child.team!.messages.some(message => message.kind === "reply" && message.body.includes("Stop the team")));
  } finally { await manager.shutdown(); }
});

test("Resume applies a newly selected provider and model without replaying completed work", { timeout: 90000 }, async () => {
  const claude = getAdapter("claude"), codex = getAdapter("codex"), originals = [claude.run, codex.run];
  let selected = false;
  claude.run = async (options, emit) => options.prompt.includes("You have not authored this work") ? { ok: false, finalText: "", errorKind: "cli_incompatible", error: "Reviewer needs replacement" } : originals[0]!.call(claude, options, emit);
  codex.run = async (options, emit) => {
    if (options.prompt.includes("You have not authored this work")) { selected = true; assert.equal(options.model, "gpt-a"); assert.equal(options.effort, "low"); assert.equal(options.resumeSessionId, undefined); }
    return originals[1]!.call(codex, options, emit);
  };
  let manager = new RunManager(findPattern);
  try {
    const parent = await manager.start({ pattern: findPattern("solo")!, repo: repository(), task: "AUTO-MINIMAL Implement the sample", roles: { agent: ["claude"] }, options: {}, taskTeam: { enabled: true, preset: "adaptive", coordinator: "claude", providers: ["claude"], settings: {}, maxMembers: 3, maxCalls: 20, maxMinutes: 5, approvePlan: false } });
    await until(() => parent.status !== "running");
    const child = manager.get(parent.teamTurns![0]!.executionId)!; assert.equal(child.status, "failed");
    await manager.configureTaskTeam(parent.id, { ...parent.taskTeam!, providers: ["codex"], settings: { codex: { model: "gpt-a", effort: "low" } } });
    await manager.shutdown(); manager = new RunManager(findPattern); await manager.load();
    const resumed = await manager.resumeTaskTeam(parent.id, child.id); await until(() => resumed.status !== "running");
    const recovered = manager.get(child.id)!;
    assert.equal(recovered.status, "done", recovered.error); assert.equal(resumed.status, "done", resumed.error); assert.ok(selected);
    assert.equal(recovered.steps.filter(step => step.title.startsWith("Auto task")).length, 1);
    assert.deepEqual(recovered.roles.pool, ["claude"], "historical plan inputs remain immutable");
    assert.deepEqual(recovered.teamResumeConfig?.config.providers, ["codex"]);
    assert.equal(resumed.steps.at(-1)!.mode, "read"); assert.equal(resumed.steps.at(-1)!.permissions?.mode, "read");
  } finally { claude.run = originals[0]!; codex.run = originals[1]!; await manager.shutdown(); }
});

test("final explanation cannot modify verified files or navigate the shared browser", { timeout: 60000 }, async () => {
  const adapter = getAdapter("claude"), original = adapter.run; let frozen = false;
  adapter.run = async (options, emit) => {
    if (options.prompt.includes("## Code Flow team execution receipt")) {
      assert.equal(options.mode, "read"); assert.equal(options.resumeSessionId, undefined);
      assert.equal(options.agentTools, undefined, "the saved-result explanation does not need a browser/computer bridge");
      assert.match(options.prompt, /host-observed evidence/);
      writeFileSync(join(options.cwd, "README.md"), "must be reverted\n"); frozen = true;
      return { ok: true, finalText: "Team result explained." };
    }
    return original.call(adapter, options, emit);
  };
  const manager = new RunManager(findPattern);
  try {
    const parent = await manager.start({ pattern: findPattern("solo")!, repo: repository(), task: "AUTO-MINIMAL Implement the sample", roles: { agent: ["claude"] }, options: {}, taskTeam: { enabled: true, preset: "adaptive", coordinator: "claude", providers: ["claude", "codex"], settings: {}, maxMembers: 3, maxCalls: 20, maxMinutes: 5, approvePlan: false } });
    await until(() => parent.status !== "running"); assert.equal(parent.status, "done", parent.error); assert.ok(frozen);
    assert.equal(readFileSync(join(parent.worktrees[0]!.path, "README.md"), "utf8"), "Fixture\n");
    const turn = parent.teamTurns![0]!;
    turn.reviewStale = true;
    parent.task = "Reply Ready. Do not use tools."; // A completed, turn-local acknowledgement must not replace the delegated review task.
    await manager.refreshTaskTeamReview(parent.id, turn.executionId);
    assert.equal(turn.reviewStale, false, turn.resolutionReview?.error);
    assert.equal(turn.resolutionReview?.approved, true);
    const review = manager.get(turn.resolutionReview!.executionId)!;
    assert.equal(review.steps[0]!.mode, "read");
    assert.ok(review.task.startsWith(`Current delegated task to review:\n${manager.get(turn.executionId)!.task}`));
    assert.ok(review.task.indexOf("Earlier conversation (historical context") < review.task.indexOf("Reply Ready. Do not use tools."));
  } finally { adapter.run = original; await manager.shutdown(); }
});
