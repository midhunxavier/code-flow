import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const enabled = process.env.CODEFLOW_TEST_TEAM_RECOVERY === "1";
const home = mkdtempSync(join(tmpdir(), "cf-recovery-live-"));
process.env.CODEFLOW_HOME = join(home, "state");
const settings = { claude: { model: "haiku" }, codex: { model: "gpt-6-luna", effort: "medium" }, agy: { model: "gemini-3.8-flash-low" } };
function repository(name: string) {
  const repo = join(home, name); mkdirSync(join(repo, ".codeflow"), { recursive: true });
  writeFileSync(join(repo, ".codeflow/config.json"), '{"prove":false}'); writeFileSync(join(repo, "README.md"), "Disposable local acceptance fixture. Only requested text files are needed.\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo }); execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=f@f", "commit", "-qm", "Fixture"], { cwd: repo }); return repo;
}
async function until(fn: () => boolean, timeout = 600000) { const end = Date.now() + timeout; while (!fn()) { if (Date.now() > end) throw new Error("Live recovery timed out"); await new Promise(resolve => setTimeout(resolve, 100)); } }

test("real isolated Antigravity side chat retains follow-up constraints without changing the workspace", { skip: !enabled, timeout: 600000 }, async () => {
  const { RunManager } = await import("../../src/engine.js"), { findPattern } = await import("../../src/patterns/index.js");
  const manager = new RunManager(findPattern); let parent: any, side: any;
  try {
    parent = await manager.start({ pattern: findPattern("solo")!, repo: repository("side-context"), task: "Remember the user token maple-611. Reply Ready without tools.", roles: { agent: ["claude"] }, options: {}, agentSettings: settings });
    await until(() => parent.status !== "running"); assert.equal(parent.status, "done", parent.error);
    side = await manager.startProviderChat(parent.id, { agent: "agy", kind: "side", settings: settings.agy, message: "Read README.md and the conversation context. State the user token and what the README says. Remember a new constraint: every answer in this side chat must include the word marigold. Do not change any files." });
    await until(() => side.status !== "running"); assert.equal(side.status, "done", side.error); assert.match(side.summary, /maple-611/i); assert.match(side.summary, /marigold/i);
    await manager.followUp(side.id, { kind: "reply", worktree: "solo", agent: "agy", message: "What word must you include in every answer, and what was the original user token? Answer briefly without tools." });
    await until(() => side.status !== "running"); assert.equal(side.status, "done", side.error); assert.match(side.followUps.at(-1).result, /marigold/i); assert.match(side.followUps.at(-1).result, /maple-611/i);
    assert.ok(side.steps.filter((step: any) => step.kind === "agent").every((step: any) => step.permissions.mode === "read" && step.permissions.isolation === "os-sandbox"));
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: parent.worktrees[0].path }).toString().trim(), "");
    console.log("Real Antigravity side chat and portable follow-up history passed with enforced read-only isolation");
  } finally { if (side) writeFileSync(join(home, "side-context.json"), JSON.stringify(side, null, 2)); await manager.shutdown(); }
});

test("real Codex and Antigravity workers accept selective steering; Claude reviews; user resolves concurrent edits", { skip: !enabled, timeout: 900000 }, async () => {
  console.log("Evidence:", home);
  const { RunManager } = await import("../../src/engine.js"), { findPattern } = await import("../../src/patterns/index.js");
  const { getAdapter } = await import("../../src/adapters/index.js");
  const manager = new RunManager(findPattern), adapter = getAdapter("codex"), original = adapter.run;
  let apiToolStarted = false;
  adapter.run = (options, emit) => original.call(adapter, options, event => { if (options.prompt.includes("AUTO_TEAM_TASK") && options.prompt.includes('"id": "api"') && event.kind === "tool_call") apiToolStarted = true; emit(event); });
  let parent: any, child: any;
  try {
    parent = await manager.start({ pattern: findPattern("solo")!, repo: repository("steering"), task: "Reply Ready. Do not use tools.", roles: { agent: ["claude"] }, options: {}, agentSettings: settings }); await until(() => parent.status !== "running"); assert.equal(parent.status, "done", parent.error);
    await manager.configureTaskTeam(parent.id, { enabled: true, preset: "adaptive", coordinator: "claude", providers: ["claude", "codex", "agy"], settings, maxMembers: 4, maxCalls: 26, maxMinutes: 10, approvePlan: false });
    parent.loop.check = "node -e \"const f=require('node:fs'),a=require('node:assert/strict');if(f.existsSync('api.txt'))a.ok(f.readFileSync('api.txt','utf8').includes('corrected api'));if(f.existsSync('notes.txt'))a.equal(f.readFileSync('notes.txt','utf8'),'stable notes\\n')\"";
    const request = "Use a team for this authorized recovery fixture. Plan exactly two independent implementation tasks with these IDs and no dependencies: api (Codex worker, owns only api.txt), notes (Antigravity worker, owns only notes.txt). The independent reviewer must be a separate Claude member. No other implementation tasks. The api task: on attempt 1 only, first use the terminal to sleep for 20 seconds to leave a window for a user correction, then write api.txt with 'initial api' plus newline. On subsequent attempts skip the wait and follow the latest user correction. The notes task writes notes.txt containing exactly 'stable notes' plus newline using its file tools. Before finishing, that Antigravity worker must use codeflow_team.send_message to the coordinator with operationId notes-evidence and body exactly live-antigravity-mailbox-731. These are ordinary prose fixture files; do not add code, tests, packages or commits. Each worker must preserve the other worker's file. Engine checks and final independent review follow submission. Both requested files must exist for final acceptance.";
    await manager.followUp(parent.id, { kind: "reply", agent: "claude", worktree: "solo", message: request });
    await until(() => !!parent.teamTurns?.length || parent.status !== "running"); child = manager.get(parent.teamTurns[0].executionId)!;
    await until(() => apiToolStarted && child.steps.some((step: any) => step.agent === "agy" && step.taskId === "notes") || child.status !== "running");
    assert.equal(child.status, "running", child.error); assert.ok(apiToolStarted);
    const source = parent.worktrees.find((tree: any) => tree.name === "solo").path;
    writeFileSync(join(source, "api.txt"), "my preserved draft\n");
    const correction = await manager.addTeamNote(parent.id, "Why are you changing api.txt? Update api.txt to contain exactly corrected api followed by a newline; leave notes.txt alone.");
    assert.deepEqual(correction.teamDelivery?.taskIds, ["api"]);
    await until(() => parent.status !== "running");
    writeFileSync(join(home, "steering-parent.json"), JSON.stringify(parent, null, 2)); writeFileSync(join(home, "steering-team.json"), JSON.stringify(child, null, 2));
    assert.equal(parent.status, "done", parent.error); assert.equal(child.status, "done", child.error);
    assert.equal(parent.teamTurns[0].executionId, child.id); assert.equal(child.steps.filter((step: any) => step.taskId === "notes" && step.title.startsWith("Auto task")).length, 1);
    assert.equal(child.steps.find((step: any) => step.taskId === "api").status, "cancelled");
    assert.equal(correction.teamDelivery?.state, "applied");
    assert.ok(child.team.messages.some((message: any) => message.body === "live-antigravity-mailbox-731"), "Antigravity sent a real live member message");
    assert.ok(child.steps.some((step: any) => step.agent === "claude" && step.title.includes("independent review")));
    assert.deepEqual(parent.teamTurns[0].reconciliation.conflicts, ["api.txt"]);
    assert.equal(readFileSync(join(source, "api.txt"), "utf8"), "my preserved draft\n");
    const comparison: any = await manager.taskResolution(parent.id, child.id);
    await manager.taskResolution(parent.id, child.id, { current: comparison.current, choices: [{ path: "api.txt", choice: "edited", text: "corrected api\nmy preserved draft\n" }] });
    assert.equal(parent.teamTurns[0].resolutionCheck.ok, true);
    assert.equal(readFileSync(join(source, "api.txt"), "utf8"), "corrected api\nmy preserved draft\n");
    assert.equal(readFileSync(join(source, "notes.txt"), "utf8"), "stable notes\n");
    await manager.refreshTaskTeamReview(parent.id, child.id);
    assert.equal(parent.teamTurns[0].resolutionReview.error, undefined);
    assert.equal(parent.teamTurns[0].reviewStale, false);
    assert.equal(typeof parent.teamTurns[0].resolutionReview.approved, "boolean", "fresh review records its actual verdict without assuming combined edits meet the request");
    assert.equal(readFileSync(join(source, "api.txt"), "utf8"), "corrected api\nmy preserved draft\n");
    console.log("Real selective cancellation, independent worker completion, Claude review, three-way resolution and fresh read-only review passed");
  } finally { if (parent) writeFileSync(join(home, "steering-final.json"), JSON.stringify({ parent, child }, null, 2)); adapter.run = original; await manager.shutdown(); }
});

for (const [lead, fallback] of [["claude", "codex"], ["codex", "agy"], ["agy", "claude"]] as const) test(`real ${lead} final-response failure continues with ${fallback} in the same chat`, { skip: !enabled, timeout: 900000 }, async () => {
  const { RunManager } = await import("../../src/engine.js"), { findPattern } = await import("../../src/patterns/index.js"), { getAdapter } = await import("../../src/adapters/index.js");
  const adapter = getAdapter(lead), original = adapter.run; let injected = false;
  adapter.run = async (options, emit) => {
    if (!injected && options.prompt.includes("## Code Flow team execution receipt")) { injected = true; return { ok: false, finalText: "", errorKind: "usage_limit", error: "Injected final-answer outage; real account quotas are unchanged" }; }
    return original.call(adapter, options, emit);
  };
  const manager = new RunManager(findPattern); let run: any;
  try {
    run = await manager.start({ pattern: findPattern("solo")!, repo: repository(`lead-${lead}`), task: "Remember the user token cedar-489. Reply Ready without tools.", roles: { agent: [lead] }, options: {}, agentSettings: settings });
    await until(() => run.status !== "running"); assert.equal(run.status, "done", run.error);
    await manager.configureTaskTeam(run.id, { enabled: true, preset: "adaptive", coordinator: lead, providers: [fallback, lead], settings, maxMembers: 3, maxCalls: 18, maxMinutes: 10, approvePlan: false });
    await manager.followUp(run.id, { kind: "reply", agent: lead, worktree: "solo", message: `Use the team for one tiny text task. Assign one ${fallback} worker to write result.txt containing exactly cedar-489 followed by a newline. Use a separate independent reviewer. No packages, tests or commits; this is plain text. The lead's final response must state the user token and the file result. Preserve other files.` });
    await until(() => run.status !== "running");
    const child = manager.get(run.teamTurns[0].executionId)!;
    assert.equal(child.status, "done", child.error); assert.equal(run.status, "done", run.error);
    assert.equal(run.steps.at(-1).mode, "read"); assert.equal(run.steps.at(-1).permissions.mode, "read");
    assert.ok(injected); assert.equal(run.conversationAgent, fallback); assert.equal(run.followUps.at(-1).agent, fallback);
    assert.equal(child.steps.filter(step => step.title.startsWith("Auto task")).length, 1);
    assert.equal(readFileSync(join(run.worktrees[0].path, "result.txt"), "utf8"), "cedar-489\n");
    assert.match(run.followUps.at(-1).result, /cedar-489/);
    await manager.configureTaskTeam(run.id, { ...run.taskTeam, enabled: false });
    await manager.followUp(run.id, { kind: "reply", agent: fallback, worktree: "solo", message: "What token did I give you? Answer directly, without tools or file changes." });
    await until(() => run.status !== "running"); assert.equal(run.status, "done", run.error); assert.match(run.followUps.at(-1).result, /cedar-489/);
    assert.equal(run.teamTurns.length, 1);
    console.log(`Real ${lead} → ${fallback} final answer and subsequent native conversation passed`);
  } finally { if (run) writeFileSync(join(home, `lead-${lead}.json`), JSON.stringify({ run, child: manager.get(run.teamTurns?.[0]?.executionId) }, null, 2)); adapter.run = original; await manager.shutdown(); }
});

test("real Codex review resumes after an injected outage and process restart", { skip: !enabled, timeout: 900000 }, async () => {
  const { RunManager } = await import("../../src/engine.js"), { findPattern } = await import("../../src/patterns/index.js"), { getAdapter } = await import("../../src/adapters/index.js");
  const adapter = getAdapter("codex"), original = adapter.run; let attempts = 0;
  adapter.run = async (options, emit) => { if (options.prompt.includes("You have not authored this work") && ++attempts === 1) return { ok: false, finalText: "", errorKind: "usage_limit", error: "Injected reviewer outage" }; return original.call(adapter, options, emit); };
  const manager = new RunManager(findPattern); let restored: InstanceType<typeof RunManager> | undefined, run: any;
  try {
    run = await manager.start({ pattern: findPattern("auto-team")!, repo: repository("resume-review"), task: "One tiny prose task: a Claude worker writes result.txt containing recovered successfully and a newline. A separate Codex reviewer independently checks the exact contents. No packages, code, tests or commits. Preserve all other files.", roles: { coordinator: ["claude"], pool: ["claude", "codex"] }, options: { eventDriven: true, maxMembers: 3, differentProviderReview: true }, agentSettings: settings, approvals: { plan: false }, loop: { maxSteps: 20, maxMinutes: 10 } });
    await until(() => run.status !== "running"); assert.equal(run.status, "failed", run.error); assert.equal(attempts, 1);
    const completed = run.steps.filter((step: any) => step.status === "done").map((step: any) => step.id);
    await manager.shutdown(); restored = new RunManager(findPattern); await restored.load(); run = await restored.resume(run.id);
    await until(() => run.status !== "running"); assert.equal(run.status, "done", run.error); assert.equal(attempts, 2);
    assert.equal(run.steps.filter((step: any) => step.title.startsWith("Auto task")).length, 1);
    assert.ok(completed.every((id: string) => run.steps.some((step: any) => step.id === id && step.status === "done")));
    console.log("Real Codex reviewer recovered after restart; completed Claude work reused");
  } finally { if (run) writeFileSync(join(home, "resume-review.json"), JSON.stringify(run, null, 2)); adapter.run = original; await manager.shutdown(); await restored?.shutdown(); }
});

test("real replacement providers finish after injected coordinator and reviewer outages without repeating implementation", { skip: !enabled, timeout: 900000 }, async () => {
  const { RunManager } = await import("../../src/engine.js"), { findPattern } = await import("../../src/patterns/index.js"), { getAdapter } = await import("../../src/adapters/index.js");
  const claude = getAdapter("claude"), codex = getAdapter("codex"), originalClaude = claude.run, originalCodex = codex.run;
  let planFailure = false, reviewFailure = false;
  claude.run = async (options, emit) => { if (!planFailure && options.prompt.includes("AUTO_TEAM_PLAN")) { planFailure = true; return { ok: false, finalText: "", errorKind: "usage_limit", error: "Injected fixture outage; real account quotas are unchanged" }; } return originalClaude.call(claude, options, emit); };
  codex.run = async (options, emit) => { if (!reviewFailure && options.prompt.includes("You have not authored this work")) { reviewFailure = true; return { ok: false, finalText: "", errorKind: "usage_limit", error: "Injected reviewer outage; real account quotas are unchanged" }; } return originalCodex.call(codex, options, emit); };
  const manager = new RunManager(findPattern); let run: any;
  try {
    run = await manager.start({ pattern: findPattern("auto-team")!, repo: repository("failover"), task: "Create exactly one tiny implementation task assigned to an Antigravity worker: write result.txt containing recovered successfully followed by a newline. Use a distinct independent reviewer member, preferring Codex when eligible. This is a plain text fixture; no code, packages, tests or commits are needed. Codeflow verifies the file through its configured check. Keep the plan minimal and preserve other files.", roles: { coordinator: ["claude"], pool: ["codex", "agy", "claude"] }, options: { eventDriven: true, maxMembers: 3 }, agentSettings: settings, approvals: { plan: false }, loop: { maxSteps: 20, maxMinutes: 10, check: "node -e \"require('node:assert/strict').equal(require('node:fs').readFileSync('result.txt','utf8'),'recovered successfully\\n')\"" } });
    await until(() => run.status !== "running");
    assert.equal(run.status, "done", run.error); assert.ok(planFailure && reviewFailure);
    assert.ok(run.team.providerChanges.some((change: any) => change.role === "coordinator" && change.to === "codex"));
    assert.ok(run.team.providerChanges.some((change: any) => change.role === "reviewer" && change.to === "agy"));
    assert.equal(run.steps.filter((step: any) => step.title.startsWith("Auto task")).length, 1);
    assert.equal(run.lastCheck.ok, true); console.log("Real Codex coordinator replacement and Antigravity reviewer replacement passed; implementation ran once");
  } finally { if (run) writeFileSync(join(home, "failover-run.json"), JSON.stringify(run, null, 2)); claude.run = originalClaude; codex.run = originalCodex; await manager.shutdown(); }
});

test("real Resume changes from unavailable Claude review to the newly selected Codex model", { skip: !enabled, timeout: 900000 }, async () => {
  const { RunManager } = await import("../../src/engine.js"), { findPattern } = await import("../../src/patterns/index.js"), { getAdapter } = await import("../../src/adapters/index.js");
  const claude = getAdapter("claude"), codex = getAdapter("codex"), originalClaude = claude.run, originalCodex = codex.run;
  let selected = false;
  claude.run = async (options, emit) => options.prompt.includes("You have not authored this work") ? { ok: false, finalText: "", errorKind: "cli_incompatible", error: "Injected unavailable reviewer" } : originalClaude.call(claude, options, emit);
  codex.run = async (options, emit) => { if (options.prompt.includes("You have not authored this work")) { selected = true; assert.equal(options.model, settings.codex.model); assert.equal(options.effort, settings.codex.effort); assert.equal(options.resumeSessionId, undefined); } return originalCodex.call(codex, options, emit); };
  let manager = new RunManager(findPattern), run: any;
  try {
    run = await manager.start({ pattern: findPattern("solo")!, repo: repository("resume-new-provider"), task: "Use one implementation worker to write result.txt containing exactly provider recovery plus a newline. Use a separate reviewer member. This is plain prose: do not add packages, tests or commits; preserve other files.", roles: { agent: ["claude"] }, options: {}, agentSettings: settings, taskTeam: { enabled: true, preset: "build-review", coordinator: "claude", providers: ["claude"], settings, maxMembers: 3, maxCalls: 20, maxMinutes: 10, approvePlan: false } });
    await until(() => run.status !== "running");
    const id = run.teamTurns[0].executionId, child = manager.get(id)!; assert.equal(child.status, "failed", child.error);
    await manager.configureTaskTeam(run.id, { ...run.taskTeam, providers: ["codex"], settings });
    await manager.shutdown(); manager = new RunManager(findPattern); await manager.load();
    run = await manager.resumeTaskTeam(run.id, id); await until(() => run.status !== "running");
    const recovered = manager.get(id)!; assert.equal(recovered.status, "done", recovered.error); assert.equal(run.status, "done", run.error); assert.ok(selected);
    assert.equal(recovered.steps.filter(step => step.title.startsWith("Auto task")).length, 1);
    assert.equal(readFileSync(join(run.worktrees[0].path, "result.txt"), "utf8"), "provider recovery\n");
  } finally { if (run) writeFileSync(join(home, "resume-new-provider.json"), JSON.stringify({ run, child: manager.get(run.teamTurns?.[0]?.executionId) }, null, 2)); claude.run = originalClaude; codex.run = originalCodex; await manager.shutdown(); }
});
