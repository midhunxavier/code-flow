import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// AI team engine controls: control words, the budget across corrections, per-teammate pins,
// pinned reruns, plan-edit paths, race labels and Auto's independent roles.
const home = mkdtempSync(join(tmpdir(), "cf-qa-team-engine-control-"));
process.env.CODEFLOW_HOME = home;
process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { taskTeamControl, taskTeamRoute, taskTeamRoleSettings, validateTaskTeam } = await import("../src/task-team.js");
const { editableTeamPlan, teamPlanPolicy, TeamPlanEditError, validateTeamPlanEdit } = await import("../src/workflow-control.js");
const { resolveAuto } = await import("../src/routing.js");
const { loadJournal, flushWrites } = await import("../src/store.js");
type Run = import("../src/engine.js").Run;
type AgentId = import("../src/adapters/types.js").AgentId;

const repositories: string[] = [];
after(async () => { await flushWrites(); for (const repo of repositories) rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
function repository(config: Record<string, unknown> = { prove: false }) {
  const repo = mkdtempSync(join(tmpdir(), "cf-qa-tec-repo-")); repositories.push(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString().trim();
  git("init", "-q", "-b", "main"); mkdirSync(join(repo, ".codeflow")); writeFileSync(join(repo, ".codeflow/config.json"), JSON.stringify(config));
  writeFileSync(join(repo, "README.md"), "Fixture\n"); writeFileSync(join(repo, "baseline.test.mjs"), "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('baseline', () => assert.equal(1, 1));\n");
  git("add", "."); git("-c", "user.name=T", "-c", "user.email=t@t", "commit", "-qm", "Fixture");
  return repo;
}
async function until(fn: () => boolean, ms = 45_000) { const deadline = Date.now() + ms; while (!fn()) { if (Date.now() > deadline) throw new Error("Timed out"); await new Promise(resolve => setTimeout(resolve, 25)); } }
async function done(run: Run) { await until(() => run.status !== "running"); assert.equal(run.status, "done", run.error); }

test("t11-1/S04-5: only a whole message is a control; a control word followed by an instruction is steering", () => {
  for (const request of ["Stop", "Stop.", "Stop!", "Please cancel the team.", "Stop the team and wait.", "Pause", "Could you wait for now?", "Pause please", "Wait a moment", "Hold on.", "Stop now!", "Cancel the run please"]) assert.ok(taskTeamControl(request), request);
  assert.equal(taskTeamControl("Wait a moment"), "pause");
  assert.equal(taskTeamControl("Cancel the run please"), "stop");
  for (const request of ["Wait. Also add tests", "Hold on. Use the revised wording for the slow task.", "Stop. Use Codex instead", "Stop. Use the blue variant", "Stop and add tests", "Stop and use Codex for the API file instead", "Pause for now and then switch to codex", "Wait! The port is 8123"]) {
    assert.equal(taskTeamControl(request), undefined, request);
    assert.equal(taskTeamRoute(request, true), "team", request);
  }
  for (const request of ["Do not stop the team", "Stop changing api.txt", "Keep docs.txt unchanged"]) assert.equal(taskTeamControl(request), undefined, request);
});

test("t11-1: 'Wait. Also add tests' while the team works reaches its tasks instead of cancelling the run", { timeout: 90_000 }, async () => {
  const release = join(home, "release-slow-wait"); process.env.FAKE_AUTO_SLOW_RELEASE = release;
  const manager = new RunManager(findPattern);
  try {
    const parent = await manager.start({ pattern: findPattern("solo")!, repo: repository(), task: "AUTO-EVENT Implement the sample", roles: { agent: ["claude"] }, options: {}, taskTeam: validateTaskTeam({ enabled: true, preset: "adaptive", coordinator: "claude", providers: ["claude", "codex"], settings: {}, maxMembers: 4, maxCalls: 24, maxMinutes: 5, approvePlan: false }) });
    await until(() => !!parent.teamTurns?.length);
    const child = manager.get(parent.teamTurns![0]!.executionId)!;
    await until(() => child.steps.some(step => step.taskId === "slow" && step.status === "running"));
    const note = await manager.addTeamNote(parent.id, "Wait. Also add tests");
    assert.equal(note.control, undefined, "the instruction is not a bare control");
    assert.ok(note.teamDelivery && note.teamDelivery.state !== "not_applied", JSON.stringify(note.teamDelivery));
    assert.equal(parent.status, "running", "the chat run is not cancelled");
    writeFileSync(release, "continue");
    await done(parent);
    const executions = [child.id, ...(parent.teamTurns![0]!.priorExecutions ?? []), parent.teamTurns![0]!.executionId].map(id => manager.get(id)!);
    assert.ok(executions.some(execution => execution.task.includes("Also add tests") || execution.team?.tasks.some(task => task.userCorrections?.some(text => text.includes("Also add tests")))), "the instruction reached the team");
    assert.equal(note.teamDelivery!.state, "applied");
  } finally { writeFileSync(release, "continue"); delete process.env.FAKE_AUTO_SLOW_RELEASE; await manager.shutdown(); }
});

test("S04-5: in a plain chat 'Wait. Also add tests' is delivered to the agent, and the run is not cancelled", { timeout: 60_000 }, async () => {
  const record = mkdtempSync(join(tmpdir(), "cf-qa-tec-record-"));
  process.env.FAKE_SLEEP_MS = "1500"; process.env.FAKE_SLEEP_VENDOR = "codex"; process.env.FAKE_RECORD_DIR = record;
  const manager = new RunManager(findPattern);
  try {
    const run = await manager.start({ pattern: findPattern("solo")!, repo: repository(), task: "Update the README with a short usage section", roles: { agent: ["codex"] }, options: {} });
    await until(() => run.steps.some(step => step.kind === "agent" && step.status === "running"));
    const note = await manager.addTeamNote(run.id, "Wait. Also add tests for the usage example");
    assert.equal(note.control, undefined);
    assert.equal(run.status, "running");
    await done(run);
    const prompts = readdirSync(record).map(file => JSON.parse(readFileSync(join(record, file), "utf8")) as { prompt: string });
    assert.ok(note.deliveredTo?.midTurn || prompts.some(entry => entry.prompt.includes("Also add tests for the usage example")), "the instruction reached the agent");
  } finally { delete process.env.FAKE_SLEEP_MS; delete process.env.FAKE_SLEEP_VENDOR; delete process.env.FAKE_RECORD_DIR; await manager.shutdown(); }
});

test("t10-11: a correction sent while the plan awaits approval isn't charged for the wait", { timeout: 60_000 }, async () => {
  let launched = 0, first: Run | undefined;
  const team = { ...findPattern("auto-team")!, run: async (ctx: import("../src/engine.js").TeamContext) => {
    launched++;
    if (launched === 1) { first = ctx.run; await ctx.approve("plan", "Approve Auto team", "A plan"); ctx.checkCancelled(); }
    return "Revised plan independently checked";
  } };
  const manager = new RunManager(id => id === "auto-team" ? team : findPattern(id));
  try {
    const run = await manager.start({ pattern: findPattern("solo")!, repo: repository(), roles: { agent: ["claude"] }, options: {}, task: "Implement the epsilon feature.", taskTeam: validateTaskTeam({ enabled: true, preset: "adaptive", coordinator: "claude", providers: ["codex"], settings: {}, maxMembers: 3, maxCalls: 12, maxMinutes: 2, approvePlan: true }) });
    await until(() => first?.awaiting?.kind === "plan");
    // The user took 90 s to look at the plan: wall-clock time, not time the team worked.
    first!.createdAt -= 90_000;
    const note = await manager.addTeamNote(run.id, "Keep README.md unchanged.");
    await done(run);
    assert.equal(launched, 2, run.teamTurns?.[0]?.report);
    assert.equal(note.teamDelivery!.state, "applied");
    assert.doesNotMatch(run.teamTurns![0]!.report ?? "", /time limit/);
    const second = manager.get(run.teamTurns![0]!.executionId)!;
    assert.notEqual(second.id, first!.id);
    assert.ok(second.loop.maxMinutes > 1.9, `the replacement keeps the unused budget: ${second.loop.maxMinutes}`);
    assert.ok((first!.clockUsedMs ?? Infinity) < 30_000, `only active time is recorded: ${first!.clockUsedMs}`);
  } finally { await manager.shutdown(); }
});

test("t10-11: the run records only the time its clock ran", { timeout: 30_000 }, async () => {
  const paused = { ...findPattern("solo")!, id: "qa-paused-clock", run: async (ctx: import("../src/engine.js").TeamContext) => {
    ctx.pauseClock(); await new Promise(resolve => setTimeout(resolve, 600)); ctx.resumeClock();
    return "done";
  } };
  const manager = new RunManager(id => id === "qa-paused-clock" ? paused : findPattern(id));
  try {
    const started = Date.now();
    const run = await manager.start({ pattern: paused, repo: repository(), roles: { agent: ["claude"] }, options: {}, task: "Wait for me" });
    await done(run);
    assert.ok(Date.now() - started >= 600);
    assert.ok(run.clockUsedMs !== undefined && run.clockUsedMs < 400, `the paused interval is excluded: ${run.clockUsedMs}`);
  } finally { await manager.shutdown(); }
});

test("t11-6: AI team setup's per-teammate model and effort pin the workers and reviewers", { timeout: 90_000 }, async () => {
  assert.deepEqual(taskTeamRoleSettings({ providers: ["claude", "codex"], settings: { claude: { model: "haiku" }, codex: { model: "gpt-b", effort: "medium" } } }), { pool: { claude: { model: "haiku" }, codex: { model: "gpt-b", effort: "medium" } } });
  assert.deepEqual(taskTeamRoleSettings({ providers: ["claude"], settings: { codex: { model: "gpt-b" } } }), {}, "Default leaves the team to choose");
  const settings = { claude: { model: "haiku" }, codex: { model: "gpt-b", effort: "medium" } };
  const manager = new RunManager(findPattern);
  try {
    const parent = await manager.start({ pattern: findPattern("solo")!, repo: repository(), task: "AUTO-MINIMAL implement the requested result", roles: { agent: ["claude"] }, options: {}, taskTeam: validateTaskTeam({ enabled: true, preset: "adaptive", coordinator: "claude", providers: ["claude", "codex"], settings, maxMembers: 3, maxCalls: 16, maxMinutes: 5, approvePlan: false }) });
    await done(parent);
    const child = manager.get(parent.teamTurns![0]!.executionId)!;
    assert.equal(child.status, "done", child.error);
    assert.deepEqual(child.roleSettings.pool, settings);
    const journal = await loadJournal(child.id);
    const inventory = [...journal].find(([key]) => key.startsWith("team-inventory:plan"))?.[1] as import("../src/teams.js").TeamInventory;
    const codex = inventory.providers.find(provider => provider.id === "codex")!, claude = inventory.providers.find(provider => provider.id === "claude")!;
    assert.deepEqual(codex.settingsByRole?.worker, settings.codex); assert.deepEqual(codex.settingsByRole?.reviewer, settings.codex);
    assert.deepEqual(claude.settingsByRole?.worker, settings.claude);
    const agentSteps = child.steps.filter(step => step.kind === "agent" && step.memberId && step.memberId !== "coordinator");
    assert.ok(agentSteps.length, "teammates ran");
    for (const step of agentSteps) {
      const pin = settings[step.agent as "claude" | "codex"];
      assert.equal(step.settings?.model, pin.model, `${step.title} keeps ${step.agent}'s model`);
      if ("effort" in pin) assert.equal(step.settings?.effort, pin.effort, `${step.title} keeps ${step.agent}'s effort`);
    }
  } finally { await manager.shutdown(); }
});

test("t10-14: asking a pinned rerun for changes is refused with 409 and the rerun keeps waiting", { timeout: 90_000 }, async () => {
  const manager = new RunManager(findPattern);
  try {
    const source = await manager.start({ repo: repository(), pattern: findPattern("auto-team")!, task: "AUTO-SAME-PROVIDER Implement the sample", roles: { coordinator: ["claude"], pool: ["claude", "codex"] }, options: {}, loop: { check: "node --test", maxSteps: 20 }, approvals: { plan: false } });
    await done(source); source.approvals.plan = true;
    const child = await manager.rerunTeamTasks(source.id, { expectedHead: source.team!.verification!.head, taskIds: ["beta"], budget: { maxSteps: 12, maxInvocations: 12, maxMinutes: 2 } });
    await until(() => !!child.awaiting);
    assert.throws(() => manager.answer(child.id, { decision: "revise", note: "change something" }), (error: Error & { status?: number }) => error instanceof TeamPlanEditError && error.status === 409 && /keeps its pinned task graph/.test(error.message));
    assert.equal(child.status, "running"); assert.equal(child.awaiting?.title, "Approve selected task rerun");
    manager.answer(child.id, { decision: "approve" });
    await done(child);
    assert.equal(child.team?.status, "completed", JSON.stringify(child.team?.gaps));
  } finally { await manager.shutdown(); }
});

test("t10-2: plan edits accept a trailing-slash directory like coordinator plans, and name the missing field", () => {
  const team: import("../src/teams.js").TeamState = {
    version: 1, revision: 0, status: "awaiting_approval", wave: 0, invocationLimit: 20, coordinationLimit: 4, maxWaves: 4, maxRepairs: 2,
    requirements: [{ id: "goal", description: "Implement the requested behavior" }],
    members: [
      { id: "coordinator", name: "Planner", role: "coordinator", provider: "claude", model: "", effort: "", reason: "Plans the work" },
      { id: "worker", name: "Builder", role: "worker", provider: "claude", model: "", effort: "", reason: "Builds the change" },
      { id: "reviewer", name: "Reviewer", role: "reviewer", provider: "codex", model: "", effort: "", reason: "Reviews independently" },
    ],
    tasks: [{ id: "build", title: "Implement behavior", owner: "worker", kind: "implementation", instructions: "Implement the behavior.", dependsOn: [], requirements: ["goal"], acceptance: ["Behavior passes tests"], paths: ["src"], status: "pending", attempts: 0 }],
    contracts: [], rationale: "Build, then review.",
    inventory: { at: 1, ranking: ["claude", "codex"], providers: [{ id: "claude", available: true, quotaKnown: false }, { id: "codex", available: true, quotaKnown: false }] },
    metrics: { invocations: 1, coordinatorInvocations: 1, questionCount: 0, blockedTurns: 0, revisions: 0 }, messages: [], contextManifests: [], gaps: [],
  };
  const policy = teamPlanPolicy(team, { roles: { coordinator: ["claude"], pool: ["claude", "codex"] }, options: { maxMembers: 4, maxTasks: 6 } });
  const draft = editableTeamPlan(team);
  draft.tasks[0]!.paths = ["docs/"];
  assert.deepEqual(validateTeamPlanEdit(draft, team, policy).tasks[0]!.paths, ["docs"]);
  draft.tasks[0]!.paths = ["docs", "docs/"];
  assert.deepEqual(validateTeamPlanEdit(draft, team, policy).tasks[0]!.paths, ["docs"]);
  for (const path of ["/", "../x/", "src/.git/", "src//", "*/", "src/**/"]) {
    draft.tasks[0]!.paths = [path];
    assert.throws(() => validateTeamPlanEdit(draft, team, policy), (error: Error) => error instanceof TeamPlanEditError && /invalid path:/.test(error.message), path);
  }
  draft.tasks[0]!.paths = ["docs"];
  draft.tasks.push({ id: "task-two", title: "Document it", owner: "worker", kind: "implementation", instructions: "", dependsOn: [], requirements: ["goal"], acceptance: ["Documented"], paths: ["docs/"] });
  assert.throws(() => validateTeamPlanEdit(draft, team, policy), /^Error: Task 2 needs instructions\.$|Task 2 needs instructions\./);
  draft.tasks[1]!.title = "";
  assert.throws(() => validateTeamPlanEdit(draft, team, policy), /Task 2 needs a title and instructions\./);
});

test("t10-4: a race names each candidate's model when one provider runs several", { timeout: 60_000 }, async () => {
  const manager = new RunManager(findPattern);
  try {
    const race = await manager.start({ pattern: findPattern("race")!, task: "Do the thing", repo: repository({}), roles: { contestants: ["claude", "codex"], judge: ["codex"] }, options: {}, roleSettings: { contestants: { claude: { model: "first", effort: "high", variants: [{ model: "second" }] } } } });
    await done(race);
    // The fake judge picks B: claude's second model.
    assert.match(race.summary!, /Winner: Candidate B — claude · second\*\*/);
    assert.match(race.summary!, /- A: claude · first \(high\) — completed/);
    assert.match(race.summary!, /- B: claude · second — completed/);
    assert.match(race.summary!, /- C: codex — completed/);
    assert.deepEqual(race.artifacts.map(artifact => artifact.label), ["Candidate B (claude · second)", "Candidate A (claude · first (high))", "Candidate C (codex)"]);
    const plain = await manager.start({ pattern: findPattern("race")!, task: "Do the thing", repo: repository({}), roles: { contestants: ["claude", "codex"], judge: ["codex"] }, options: {} });
    await done(plain);
    assert.match(plain.summary!, /Winner: Candidate B — codex\*\*/, "a provider running one model is named as before");
  } finally { await manager.shutdown(); }
});

test("t10-9: Auto fills a reviewer from a vendor other than the Auto planner's when one has room", () => {
  const independence = { reviewer: ["planner", "builder"] };
  const two = new Set<AgentId>(["claude", "codex"]), three = new Set<AgentId>(["claude", "codex", "agy"]);
  const picked = resolveAuto({ planner: ["auto"], builder: ["codex"], reviewer: ["auto"] }, {}, two, undefined, independence);
  assert.deepEqual(picked.roles, { planner: ["claude"], builder: ["codex"], reviewer: ["codex"] });
  assert.match(picked.notes.find(note => note.includes("reviewer"))!, /Auto picked Codex for reviewer \(independent of the planner: Claude Code\)/);
  assert.match(picked.notes.find(note => note.includes("planner"))!, /Auto picked Claude Code for planner \(first in preference order\)/, "every pick says why");
  assert.deepEqual(resolveAuto({ planner: ["auto"], builder: ["codex"], reviewer: ["auto"] }, {}, three, undefined, independence).roles.reviewer, ["agy"], "neither the planner's nor the builder's vendor");
  const ranked = resolveAuto({ planner: ["auto"], builder: ["auto"], reviewer: ["auto"] }, {}, two, { order: ["codex"], why: { codex: "4 of 4 runs passed in this repo" } }, independence);
  assert.notEqual(ranked.roles.reviewer![0], ranked.roles.planner![0], "a track record doesn't make one vendor plan, build and review");
  assert.deepEqual(resolveAuto({ planner: ["auto"], builder: ["codex"], reviewer: ["auto"] }, {}, new Set<AgentId>(["claude"]), undefined, independence).roles.reviewer, ["claude"], "one vendor installed: the pattern warns instead");
  const limited = resolveAuto({ planner: ["auto"], builder: ["codex"], reviewer: ["auto"] }, { codex: { status: "limited", windows: {}, at: Date.now() } }, two, undefined, independence);
  assert.deepEqual(limited.roles.reviewer, ["claude"]);
  assert.match(limited.notes.find(note => note.includes("reviewer"))!, /Codex hit its usage limit/);
  // An Auto planner steers clear of a reviewer you picked yourself; explicit picks are kept.
  const yours = resolveAuto({ planner: ["auto"], builder: ["codex"], reviewer: ["claude"] }, {}, two, undefined, independence);
  assert.deepEqual(yours.roles, { planner: ["codex"], builder: ["codex"], reviewer: ["claude"] });
  assert.match(yours.notes[0]!, /independent of the reviewer you picked: Claude Code/);
  // Without independence the picks are unchanged.
  assert.deepEqual(resolveAuto({ planner: ["auto"], builder: ["codex"], reviewer: ["auto"] }, {}, two).roles.reviewer, ["claude"]);
  assert.deepEqual(resolveAuto({ contestants: ["auto", "auto"], judge: ["auto"] }, {}, three, undefined, { judge: ["contestants"] }).roles, { contestants: ["claude", "codex"], judge: ["agy"] });
  assert.deepEqual(findPattern("pipeline")!.roles.find(role => role.id === "reviewer")!.independentOf, ["planner", "builder"]);
});

test("t11-5: a finished team's reply box offers its result first; a worker branch is marked as outside it", async () => {
  const { replyTargets } = await import("../ui/run-experience.js");
  const step = (agent: AgentId, worktree: string, mode: "write" | "read" = "write") => ({ kind: "agent", agent, worktree, mode }) as import("../ui/types.js").Step;
  const team = { pattern: "auto-team", roles: { coordinator: ["claude"], pool: ["claude", "codex"] }, team: { members: [{ id: "coordinator", role: "coordinator", provider: "claude" }] }, artifacts: [{ label: "Auto team result", branch: "codeflow/r/integration" }], worktrees: [{ name: "integration", branch: "codeflow/r/integration" }, { name: "auto-alpha", branch: "codeflow/r/auto-alpha" }, { name: "auto-beta", branch: "codeflow/r/auto-beta" }] } as unknown as import("../ui/types.js").RunSummary;
  assert.deepEqual(replyTargets(team, [step("claude", "auto-alpha"), step("codex", "auto-beta"), step("codex", "integration", "read")]), [
    { agent: "claude", worktree: "integration", delivered: true },
    { agent: "claude", worktree: "auto-alpha", delivered: false },
    { agent: "codex", worktree: "auto-beta", delivered: false },
  ]);
  // A repair in the result is that agent's to continue.
  assert.deepEqual(replyTargets(team, [step("claude", "auto-alpha"), step("codex", "integration")])[0], { agent: "codex", worktree: "integration", delivered: true });
  const pipeline = { pattern: "pipeline", roles: {}, artifacts: [{ label: "Result", branch: "b" }], worktrees: [{ name: "build", branch: "b" }] } as unknown as import("../ui/types.js").RunSummary;
  assert.deepEqual(replyTargets(pipeline, [step("claude", "build", "read"), step("codex", "build")]), [{ agent: "codex", worktree: "build", delivered: true }], "other runs keep their writers");
});

test("t11-5: a direct reply to the team's result clears its approval; one on a worker branch says it isn't in the result", { timeout: 120_000 }, async () => {
  const manager = new RunManager(findPattern);
  try {
    const run = await manager.start({ repo: repository(), pattern: findPattern("auto-team")!, task: "AUTO-SAME-PROVIDER Implement the sample", roles: { coordinator: ["claude"], pool: ["claude", "codex"] }, options: {}, loop: { check: "node --test", maxSteps: 20 }, approvals: { plan: false } });
    await done(run);
    assert.equal(run.team!.verification!.approved, true);
    const worker = run.worktrees.find(tree => tree.name !== "integration" && run.steps.some(step => step.worktree === tree.name && step.mode === "write"))!;
    const workerAgent = run.steps.find(step => step.worktree === worker.name && step.mode === "write")!.agent!;
    await manager.followUp(run.id, { kind: "reply", agent: workerAgent, worktree: worker.name, message: "Add a short documentation file for this component.", budget: { maxSteps: 1, maxInvocations: 1, maxMinutes: 5 } });
    await done(run);
    assert.equal(run.team!.verification!.approved, true, "a worker branch isn't the delivered result");
    assert.match(run.summary!, new RegExp(`in ${worker.name} \\(its branch, not the result\\)`));
    const integration = run.worktrees.find(tree => tree.name === "integration")!;
    const before = execFileSync("git", ["rev-parse", integration.branch], { cwd: run.repo }).toString().trim();
    await manager.followUp(run.id, { kind: "reply", agent: "claude", worktree: "integration", message: "Add a short documentation file for the result.", budget: { maxSteps: 1, maxInvocations: 1, maxMinutes: 5 } });
    await done(run);
    assert.notEqual(execFileSync("git", ["rev-parse", integration.branch], { cwd: run.repo }).toString().trim(), before, "the result branch moved");
    assert.equal(run.team!.verification!.approved, false);
    assert.ok(run.team!.gaps.some(gap => /changed after the team's review/.test(gap)));
    assert.equal(run.facts?.approved, false);
    assert.match(run.summary!, /followed up on your reply in integration — /);
  } finally { await manager.shutdown(); }
});

test("t11-6: teammate settings changed before Resume replace the pins for unfinished calls", { timeout: 120_000 }, async () => {
  const release = join(home, "release-slow-resume"); process.env.FAKE_AUTO_SLOW_RELEASE = release;
  const team = { enabled: true, preset: "adaptive", coordinator: "claude", providers: ["claude", "codex"], settings: { codex: { model: "gpt-b", effort: "medium" } }, maxMembers: 4, maxCalls: 28, maxMinutes: 5, approvePlan: false };
  const manager = new RunManager(findPattern); let restored: InstanceType<typeof RunManager> | undefined;
  try {
    const parent = await manager.start({ pattern: findPattern("solo")!, repo: repository(), task: "AUTO-EVENT Implement the sample", roles: { agent: ["claude"] }, options: {}, taskTeam: validateTaskTeam(team) });
    await until(() => !!parent.teamTurns?.length);
    const child = manager.get(parent.teamTurns![0]!.executionId)!;
    await until(() => child.steps.some(step => step.taskId === "slow" && step.status === "running"));
    assert.deepEqual(child.roleSettings.pool, { codex: { model: "gpt-b", effort: "medium" } });
    await manager.shutdown();
    restored = new RunManager(findPattern); await restored.load(); writeFileSync(release, "continue");
    await restored.configureTaskTeam(parent.id, validateTaskTeam({ ...team, settings: { codex: { model: "gpt-b", effort: "low" } } }));
    const resumed = await restored.resume(parent.id); await until(() => resumed.status !== "running");
    assert.equal(resumed.status, "done", resumed.error);
    const recovered = restored.get(child.id)!;
    assert.equal(recovered.status, "done", recovered.error);
    assert.deepEqual(recovered.roleSettings.pool, { codex: { model: "gpt-b", effort: "low" } });
    const review = recovered.steps.filter(step => step.title.startsWith("Auto team independent review")).at(-1)!;
    assert.equal(review.agent, "codex"); assert.deepEqual({ model: review.settings?.model, effort: review.settings?.effort }, { model: "gpt-b", effort: "low" });
  } finally { writeFileSync(release, "continue"); delete process.env.FAKE_AUTO_SLOW_RELEASE; await manager.shutdown(); await restored?.shutdown(); }
});
