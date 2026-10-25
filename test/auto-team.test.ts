import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const home = mkdtempSync(join(tmpdir(), "codeflow-auto-test-"));
process.env.CODEFLOW_HOME = home;
process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
const { RunManager, TeamContext } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { flushWrites } = await import("../src/store.js");
const { memoryStore } = await import("../src/memory.js");
const { editableTeamPlan } = await import("../src/workflow-control.js");
type Run = import("../src/engine.js").Run;
type TeamPlan = import("../src/teams.js").TeamPlan;
const repositories: string[] = [];
after(async () => { await flushWrites(); for (const repo of repositories) rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

function repository() {
  const repo = mkdtempSync(join(tmpdir(), "codeflow-auto-repo-")); repositories.push(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "Empty input is valid.\n");
  mkdirSync(join(repo, ".codeflow")); writeFileSync(join(repo, ".codeflow", "config.json"), JSON.stringify({ prove: false }));
  writeFileSync(join(repo, "sample.test.mjs"), 'import {test} from "node:test"; import assert from "node:assert/strict"; test("baseline",()=>assert.equal(1,1));\n');
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "initial"], { cwd: repo });
  return repo;
}
async function waitFor(run: Run, manager: InstanceType<typeof RunManager>, predicate: () => boolean) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error(`Timed out: ${run.status}, ${run.error}, ${JSON.stringify(run.team)}`)); }, 30_000);
    const inspect = () => { if (predicate()) { clearTimeout(timer); unsubscribe(); resolve(); } };
    const unsubscribe = manager.subscribe(run.id, inspect); inspect();
  });
}
async function start(task: string, extra: Record<string, unknown> = {}) {
  const manager = new RunManager(findPattern);
  const run = await manager.start({ pattern: findPattern("auto-team")!, repo: repository(), task, roles: { coordinator: ["claude"], pool: ["claude", "codex"] }, options: {}, loop: { check: "node --test", maxSteps: 20 }, approvals: { plan: false }, ...extra });
  return { manager, run };
}
async function finish(task: string, extra: Record<string, unknown> = {}) {
  const item = await start(task, extra); await waitFor(item.run, item.manager, () => item.run.status !== "running"); return item;
}

test("Auto composes a pinned template and workers inherit the run policy across providers", async () => {
  const { teamTemplateStore } = await import("../src/team-template-store.js");
  const template: import("../src/team-templates.js").TeamTemplate = { schemaVersion: 1, id: "engine-template", version: 1, name: "Implementation", description: "Reusable implementation", scope: "personal", autoEnabled: false, parameters: ["task"], roles: ["builder"], task: "{{task}}", criteria: [], contracts: ["Preserve existing behavior"], tasks: [{ id: "change", title: "Implement", role: "builder", kind: "implementation", instructions: "Implement {{task}}", dependsOn: [], paths: ["*"], acceptance: ["Behavior is tested"] }] };
  await teamTemplateStore.save(template, 0);
  const { manager, run } = await start("AUTO-USE-TEMPLATE Implement the sample", { teamTemplate: { template, inputs: { task: "sample" } }, approvals: { plan: true }, trust: "standard" });
  await waitFor(run, manager, () => !!run.awaiting || run.status !== "running");
  assert.equal(run.team?.tasks[0]?.id, "reuse-change", run.error);
  await teamTemplateStore.save({ ...template, version: 2, tasks: [{ ...template.tasks[0]!, instructions: "Changed after launch" }] }, 1);
  manager.cancel(run.id);
  await waitFor(run, manager, () => run.status !== "running");
  await manager.resume(run.id);
  await waitFor(run, manager, () => !!run.awaiting || run.status !== "running");
  assert.equal(run.teamTemplate?.template.version, 1);
  assert.match(run.team!.tasks[0]!.instructions, /Implement sample/);
  assert.ok(!run.team!.tasks[0]!.instructions.includes("Changed after launch"));
  await manager.answer(run.id, { decision: "approve" });
  await waitFor(run, manager, () => run.status !== "running");
  assert.equal(run.status, "done", run.error);
  const calls = run.steps.filter(s => s.kind === "agent");
  assert.ok(calls.some(s => s.agent === "claude") && calls.some(s => s.agent === "codex"));
  assert.ok(calls.every(s => s.permissions?.trust === "standard" && s.permissions.nativeDelegation === false));
  assert.ok(calls.some(s => s.mode === "write") && calls.some(s => s.mode === "read"));
});

test("initial and revised plans stay compact without live tools; execution retains tools and review", async () => {
  const { adapters } = await import("../src/adapters/index.js");
  const originals = { claude: adapters.claude.run, codex: adapters.codex.run };
  const plans: import("../src/adapters/types.js").RunOptions[] = [];
  const workers: import("../src/adapters/types.js").RunOptions[] = [];
  const reviews: import("../src/adapters/types.js").RunOptions[] = [];
  for (const id of ["claude", "codex"] as const) adapters[id].run = async (opts, emit) => {
    if (opts.prompt.includes("AUTO_TEAM_PLAN")) plans.push(opts);
    if (opts.prompt.includes("AUTO_TEAM_TASK")) workers.push(opts);
    if (opts.prompt.includes("AUTO_TEAM_REVIEW")) reviews.push(opts);
    return originals[id](opts, emit);
  };
  let item: Awaited<ReturnType<typeof start>> | undefined;
  try {
    item = await start("Implement the sample", { options: { eventDriven: true }, approvals: { plan: true }, trust: "standard" });
    const { run, manager } = item;
    await waitFor(run, manager, () => !!run.awaiting || run.status !== "running");
    assert.ok(run.awaiting, run.error);
    assert.equal(workers.length, 0);
    await manager.answer(run.id, { decision: "revise", note: "Keep the scope small." });
    await waitFor(run, manager, () => plans.length === 2 && !!run.awaiting || run.status !== "running");
    assert.ok(run.awaiting, run.error);
    for (const plan of plans) {
      assert.equal(plan.mode, "read");
      assert.equal(plan.agentTools, undefined);
      assert.equal(plan.teamTools, undefined);
      assert.ok(plan.jsonSchema);
      assert.ok(plan.prompt.length < 12000, `small fixture plan expanded to ${plan.prompt.length} bytes`);
      assert.ok(!plan.prompt.includes(JSON.stringify(plan.jsonSchema)), "native schema is not duplicated in the prompt");
    }
    await manager.answer(run.id, { decision: "approve" });
    await waitFor(run, manager, () => run.status !== "running");
    assert.equal(run.status, "done", run.error);
    assert.equal(run.verdict, "passed");
    assert.ok(workers.length);
    assert.ok(workers.every(worker => worker.agentTools && worker.teamTools));
    for (const worker of workers) {
      assert.ok(worker.jsonSchema);
      assert.ok(!worker.prompt.includes(JSON.stringify(worker.jsonSchema)), "worker schema is delivered natively, not duplicated");
      assert.ok(worker.prompt.length < 6500, `simple worker context grew to ${worker.prompt.length} bytes`);
    }
    assert.ok(reviews.length);
    for (const review of reviews) {
      assert.equal(review.mode, "read"); assert.ok(review.jsonSchema);
      assert.match(review.prompt, /Combined diff/);
      assert.match(review.prompt, /run by code-flow/);
      assert.match(review.prompt, /high and medium issues block/);
      assert.match(review.prompt, /Missing required work blocks approval even if tests pass/);
    }
    assert.ok(run.steps.some(step => step.memberId === "verifier" && step.mode === "read"));
  } finally {
    if (item) await item.manager.shutdown();
    for (const id of ["claude", "codex"] as const) adapters[id].run = originals[id];
  }
});

for (const blockedBy of ["check", "review"] as const) test(`streamlined execution still blocks completion on a failed ${blockedBy}`, async () => {
  const { adapters } = await import("../src/adapters/index.js");
  const original = adapters.codex.run;
  let reviewed = false;
  adapters.codex.run = async (opts, emit) => {
    if (opts.prompt.includes("AUTO_TEAM_REVIEW")) {
      reviewed = true;
      if (blockedBy === "review") return { ok: true, finalText: "", structured: { verdict: "changes_requested", issues: [{ severity: "medium", file: "claude-alpha.txt", problem: "A required behavior is missing", fix: "Complete the requirement", repro: { path: "", contents: "", command: "" } }] } };
    }
    return original(opts, emit);
  };
  let item: Awaited<ReturnType<typeof start>> | undefined;
  try {
    item = await finish("AUTO-MINIMAL Implement the sample", { options: { eventDriven: true, maxWaves: 1, maxRepairs: 0, providerFailover: false }, loop: { check: blockedBy === "check" ? 'node -e "process.exit(1)"' : "node --test", maxSteps: 12 } });
    assert.ok(reviewed, "independent review still runs");
    assert.equal(item.run.status, "stopped", item.run.error);
    assert.equal(item.run.team?.verification?.approved, false);
    assert.equal(item.run.lastCheck?.ok, blockedBy !== "check");
    assert.ok(item.run.team!.gaps.some(gap => blockedBy === "check" ? /configured check fails/.test(gap) : /review has blocking findings/.test(gap)));
  } finally { adapters.codex.run = original; if (item) await item.manager.shutdown(); }
});

test("Auto team creates independent members, runs dependency waves, and verifies the final head", async () => {
  const { run } = await finish("AUTO-SAME-PROVIDER Implement the sample");
  assert.equal(run.status, "done", run.error);
  assert.equal(run.team?.status, "completed", JSON.stringify(run.team?.gaps));
  assert.equal(run.verdict, "passed");
  assert.equal(run.team?.wave, 2);
  const workers = run.team!.members.filter((m) => m.role === "worker");
  assert.equal(workers.length, 2);
  assert.equal(workers[0]!.provider, workers[1]!.provider);
  const workerSteps = run.steps.filter((s) => s.taskId && s.kind === "agent");
  assert.notEqual(workerSteps[0]?.sessionId, workerSteps[1]?.sessionId);
  assert.deepEqual(workerSteps.map((s) => s.memberId), ["builder", "builder-two"]);
  assert.equal(run.modelRouting?.version,1);
  for (const step of workerSteps) { assert.ok(step.modelAssignment?.model); assert.ok(step.modelAssignment!.catalogRevision>0); assert.match(step.modelAssignment!.environment,/^[a-f0-9]{64}$/); }
  const {modelCatalogStore}=await import('../src/model-catalog.js');
  const selected=workerSteps[0]!.modelAssignment!;
  const catalog=await modelCatalogStore.read(selected.provider,selected.environment);
  assert.ok(catalog!.models.find(m=>m.id===selected.model)!.observations.some(o=>o.runId===run.id));
  assert.equal(run.team!.verification!.head, execFileSync("git", ["rev-parse", run.artifacts[0]!.branch], { cwd: run.repo }).toString().trim());
  const files = execFileSync("git", ["ls-tree", "--name-only", run.artifacts[0]!.branch], { cwd: run.repo }).toString();
  assert.match(files, /claude-alpha.txt/); assert.match(files, /claude-beta.txt/);
  assert.equal(run.team!.metrics.coordinatorInvocations, 1);
});

test("Auto accepts directory ownership with trailing separators and replays the recorded plan", async () => {
  const { adapters } = await import("../src/adapters/index.js");
  const { extractJson } = await import("../src/json.js");
  const original = adapters.claude.run;
  let planningCalls = 0;
  adapters.claude.run = async (opts, onEvent) => {
    const result = await original(opts, onEvent);
    if (opts.prompt.includes("AUTO_TEAM_PLAN")) {
      planningCalls++;
      const value = (result.structured ?? extractJson(result.finalText)) as TeamPlan;
      return { ...result, structured: { ...value, tasks: value.tasks.map(task => ({ ...task, paths: ["mqtt-python/src/mqtt_mcp/adapters/", "docs/"] })) } };
    }
    return result;
  };
  let item: Awaited<ReturnType<typeof start>> | undefined;
  try {
    item = await start("Implement the sample", { approvals: { plan: true } });
    const { manager, run } = item;
    const awaiting = async () => {
      await waitFor(run, manager, () => !!run.awaiting || run.status !== "running");
      assert.ok(run.awaiting, run.error);
      assert.ok(run.team!.tasks.length);
      for (const task of run.team!.tasks) assert.deepEqual(task.paths, ["mqtt-python/src/mqtt_mcp/adapters", "docs"]);
      assert.equal(planningCalls, 1, "valid directory notation needs no extra provider turn");
    };
    await awaiting();
    manager.cancel(run.id);
    await waitFor(run, manager, () => run.status !== "running");
    await manager.resume(run.id);
    await awaiting();
  } finally {
    if (item) { item.manager.cancel(item.run.id); await waitFor(item.run, item.manager, () => item!.run.status !== "running"); }
    adapters.claude.run = original;
  }
});

for (const providerFailover of [true, false]) test(`Resume retries an invalid plan with refreshed discovery, provider failover ${providerFailover}`, async () => {
  const { adapters } = await import("../src/adapters/index.js");
  const { extractJson } = await import("../src/json.js");
  const original = adapters.claude.run;
  let planningCalls = 0, repair = false, candidate: TeamPlan | undefined;
  adapters.claude.run = async (opts, onEvent) => {
    const result = await original(opts, onEvent);
    if (opts.prompt.includes("AUTO_TEAM_PLAN") || opts.jsonSchema && (opts.jsonSchema as any).properties?.members) {
      planningCalls++;
      const value = (result.structured ?? extractJson(result.finalText)) as TeamPlan;
      if (value?.tasks?.length) candidate = value;
      assert.ok(candidate);
      return { ...result, structured: repair ? structuredClone(candidate) : { ...candidate, tasks: candidate.tasks.map(task => ({ ...task, paths: ["../outside/"] })) } };
    }
    return result;
  };
  let item: Awaited<ReturnType<typeof start>> | undefined;
  try {
    item = await start("Implement the sample", { options: { providerFailover }, approvals: { plan: true } });
    const { manager, run } = item;
    await waitFor(run, manager, () => run.status !== "running");
    assert.equal(run.status, "failed");
    assert.match(run.error!, /invalid path:.*outside/);
    assert.equal(planningCalls, 2);
    const discoveredAt = run.team!.inventory!.at;
    repair = true;
    await manager.resume(run.id);
    await waitFor(run, manager, () => !!run.awaiting || run.status !== "running");
    assert.ok(run.awaiting, run.error);
    assert.equal(planningCalls, 3, "Resume requests one fresh repair instead of replaying the rejected retry");
    assert.ok(run.team!.inventory!.at > discoveredAt, "failed planning refreshes model availability on Resume");
    assert.ok(run.team!.tasks.every(task => task.paths.every(path => !path.includes(".."))));
  } finally {
    if (item) { item.manager.cancel(item.run.id); await waitFor(item.run, item.manager, () => item!.run.status !== "running"); }
    adapters.claude.run = original;
  }
});

for (const native of [false, true]) test(`Auto routes to ${native ? "native" : "isolated"} Antigravity with recorded catalog provenance and fresh worker turns`, { skip: !native && process.platform !== "darwin" }, async () => {
  const { agyAdapter } = await import("../src/adapters/agy.js");
  const original = { run: agyAdapter.run, discoverModels: agyAdapter.discoverModels, managedAvailability: agyAdapter.managedAvailability };
  const calls: import("../src/adapters/types.js").RunOptions[] = [];
  agyAdapter.managedAvailability = async () => native ? "isolation deliberately unavailable" : undefined;
  agyAdapter.discoverModels = async context => {
    assert.equal(context?.isolatedAgy, native ? undefined : true);
    return { models: [{ id: "agy-isolated-fixture", label: "Fixture" }], defaultModel: "agy-isolated-fixture", efforts: [], allowCustom: false, discovery: { source: "isolated fixture", confidence: "reported", verifiedAt: Date.now() } };
  };
  agyAdapter.run = async opts => {
    calls.push(opts);
    assert.equal(opts.resumeSessionId, undefined);
    assert.equal(opts.permissions?.isolation, native ? "none" : "os-sandbox");
    assert.equal(opts.permissions?.externalTools, native ? "provider-configured" : "task-scoped");
    assert.equal(opts.permissions?.commandNetwork, native ? "allowed" : "denied");
    assert.equal(opts.permissions?.nativeDelegation, native);
    assert.equal(opts.model, "agy-isolated-fixture");
    assert.ok(!opts.effort, "unknown effort support must remain unset");
    const { task, member } = JSON.parse(opts.prompt.match(/## Assignment JSON\n```json\n([\s\S]*?)\n```/)![1]!);
    writeFileSync(join(opts.cwd, `agy-${task.id}.txt`), `${task.id} implementation\n`);
    return { ok: true, finalText: "", structured: { taskId: task.id, memberId: member.id, status: "submitted", checkpoint: `Completed ${task.id}`, handover: `Portable output for ${task.id}`, artifacts: [`agy-${task.id}.txt`], unresolvedRequirements: [], questions: [], replies: [], findings: [] } };
  };
  try {
    const { modelCatalogStore } = await import("../src/model-catalog.js");
    await modelCatalogStore.get("agy", { context: native ? {} : { isolatedAgy: true }, force: true });
    const { run } = await finish("AUTO-AGY-ISOLATED AUTO-DEPENDENCIES Implement the sample", { antigravityExecution: native ? "native" : "isolated", roles: { coordinator: ["claude"], pool: ["agy", "claude"] } });
    assert.equal(run.status, "done", run.error);
    assert.ok(run.steps.filter(s => s.agent === "claude").every(s => s.permissions?.trust === "standard" && s.permissions.nativeDelegation === false));
    assert.equal(calls.length, 2);
    assert.equal(run.team?.members.find(m => m.role === "coordinator")?.provider, "claude");
    const { modelEnvironment } = await import("../src/model-catalog.js");
    const steps = run.steps.filter(s => s.agent === "agy");
    assert.equal(steps.length, 2);
    for (const step of steps) {
      assert.equal(step.sessionId, undefined);
      assert.equal(step.permissions?.implementation, native ? "agy-native-v1" : "macos-task-tools-v2");
      assert.equal(step.modelAssignment?.environment, modelEnvironment(native ? {} : { isolatedAgy: true }));
      assert.ok(step.modelAssignment!.catalogRevision > 0);
    }
  } finally { Object.assign(agyAdapter, original); }
});

for (const native of [false, true]) test(`Antigravity ${native ? "native" : "isolated"} auth recovery preserves pins, policy and checkpoints`, { skip: !native && process.platform !== "darwin" }, async () => {
  const { agyAdapter } = await import("../src/adapters/agy.js");
  const { modelCatalogStore } = await import("../src/model-catalog.js");
  const original = { run: agyAdapter.run, discoverModels: agyAdapter.discoverModels, managedAvailability: agyAdapter.managedAvailability };
  let repaired = false, discoveryFails = false, discoveries = 0;
  const calls: import("../src/adapters/types.js").RunOptions[] = [];
  agyAdapter.managedAvailability = async () => native ? "isolation deliberately unavailable" : undefined;
  agyAdapter.discoverModels = async context => {
    discoveries++;
    assert.equal(context?.isolatedAgy, native ? undefined : true);
    if (discoveryFails) throw new Error("SYNTHETIC_AUTH_DIAGNOSTIC");
    return { models: [{ id: "agy-isolated-fixture", label: "Fixture" }], defaultModel: "agy-isolated-fixture", efforts: [], allowCustom: false, discovery: { source: "isolated fixture", confidence: "reported", verifiedAt: Date.now() } };
  };
  agyAdapter.run = async opts => {
    calls.push(opts);
    assert.equal(opts.resumeSessionId, undefined);
    assert.equal(opts.model, "agy-isolated-fixture");
    assert.ok(!opts.effort);
    const { task, member } = JSON.parse(opts.prompt.match(/## Assignment JSON\n```json\n([\s\S]*?)\n```/)![1]!);
    const artifact = `agy-${task.id}.txt`;
    if (!repaired) {
      writeFileSync(join(opts.cwd, artifact), "Portable partial work\n");
      return { ok: false, finalText: "", errorKind: "auth", error: "Antigravity could not refresh the existing native login. Check or unlock it, then resume." };
    }
    assert.equal(readFileSync(join(opts.cwd, artifact), "utf8"), "Portable partial work\n");
    writeFileSync(join(opts.cwd, artifact), "Completed from checkpoint\n");
    return { ok: true, finalText: "", structured: { taskId: task.id, memberId: member.id, status: "submitted", checkpoint: "Recovered from files", handover: "Portable completed output", artifacts: [artifact], unresolvedRequirements: [], questions: [], replies: [], findings: [] } };
  };
  let manager: InstanceType<typeof RunManager> | undefined;
  try {
    await modelCatalogStore.get("agy", { context: native ? {} : { isolatedAgy: true }, force: true });
    const first = await finish("AUTO-AGY-ISOLATED Implement the sample", { options: { providerFailover: false }, antigravityExecution: native ? "native" : "isolated", roles: { coordinator: ["claude"], pool: ["agy", "claude"] }, roleSettings: { pool: { agy: { model: "agy-isolated-fixture" } } } });
    assert.equal(first.run.status, "stopped", first.run.error);
    assert.equal(first.manager.quota.agy?.status, "signed_out");
    const recorded = JSON.stringify(first.run.steps.filter(s => s.agent === "agy").map(s => [s.permissions, s.modelAssignment]));
    const failedCalls = calls.length;
    assert.equal(failedCalls, 1, "auth failure must not loop native refresh attempts");
    assert.match(first.run.steps.find(s => s.agent === "agy")!.error!, /unlock/);
    await first.manager.shutdown(); await flushWrites();
    manager = new RunManager(findPattern); await manager.load();
    const recovered = manager.get(first.run.id)!;
    discoveryFails = true;
    await assert.rejects(manager.resume(recovered.id), /could not be reverified in the recorded execution mode/);
    assert.equal(calls.length, failedCalls, "a stale cached catalog cannot clear an auth failure");
    assert.equal(manager.quota.agy?.status, "signed_out");
    const previousNetwork = process.env.CODEFLOW_MODEL_NETWORK;
    process.env.CODEFLOW_MODEL_NETWORK = "offline";
    try {
      const beforeOffline = discoveries;
      await assert.rejects(manager.resume(recovered.id), /could not be reverified in the recorded execution mode/);
      assert.equal(discoveries, beforeOffline);
      assert.equal(manager.quota.agy?.status, "signed_out");
      assert.equal(calls.length, failedCalls);
    } finally {
      if (previousNetwork === undefined) delete process.env.CODEFLOW_MODEL_NETWORK;
      else process.env.CODEFLOW_MODEL_NETWORK = previousNetwork;
    }
    discoveryFails = false; repaired = true;
    const before = discoveries;
    await manager.resume(recovered.id);
    await waitFor(recovered, manager, () => recovered.status !== "running");
    assert.ok(discoveries > before, "resume requires fresh discovery after login repair");
    assert.equal(recovered.status, "done", recovered.error);
    assert.equal(manager.quota.agy?.status, "allowed");
    assert.equal(calls.length, failedCalls + 1);
    assert.deepEqual(calls.at(-1)!.permissions, calls[0]!.permissions);
    assert.equal(JSON.stringify(recovered.steps.filter(s => s.agent === "agy").slice(0, failedCalls).map(s => [s.permissions, s.modelAssignment])), recorded);
    assert.ok(recovered.steps.filter(s => s.agent === "agy").every(s => !s.sessionId));
    assert.equal(recovered.steps.filter(s => s.title === "Plan Auto team").length, 1);
  } finally { Object.assign(agyAdapter, original); await manager?.shutdown(); }
});

test("Auto team yields addressed questions and resumes the same task session with the answer", async () => {
  const record = mkdtempSync(join(tmpdir(), "codeflow-auto-resume-")); process.env.FAKE_RECORD_DIR = record;
  try {
  const { run } = await finish("AUTO-QUESTION Implement the sample");
  assert.equal(run.status, "done", run.error);
  assert.equal(run.team?.status, "completed", JSON.stringify(run.team?.gaps));
  const turns = run.steps.filter((s) => s.taskId === "alpha" && s.title.startsWith("Auto task"));
  assert.equal(turns.length, 2);
  const calls = readdirSync(record).map((f) => JSON.parse(readFileSync(join(record, f), "utf8")) as { prompt: string; args: string[] });
  const resumed = calls.find((call) => call.prompt.includes("AUTO_TEAM_TASK") && call.prompt.includes('"attempt": 2'))!;
  assert.ok(resumed.args.includes("--resume")); assert.ok(resumed.args.includes(turns[0]!.sessionId!));
  assert.equal(run.team!.metrics.questionCount, 1);
  assert.equal(run.team!.metrics.blockedTurns, 1);
  assert.equal(run.team!.messages.find((m) => m.kind === "reply")?.status, "delivered");
  assert.equal(run.team!.contextManifests[1]!.messageIds.length, 1);
  } finally { delete process.env.FAKE_RECORD_DIR; rmSync(record, { recursive: true, force: true }); }
});

test("Auto team user questions pause outside a worker slot and route an authenticated reply", async () => {
  const { run, manager } = await start("AUTO-USER-QUESTION Implement the sample");
  await waitFor(run, manager, () => !!run.team?.awaitingRequestId || run.status !== "running");
  assert.equal(run.status, "running", run.error);
  assert.ok(run.team!.awaitingRequestId);
  assert.ok(!run.steps.some((s) => s.status === "running"));
  await manager.answerTeamQuestion(run.id, run.team!.awaitingRequestId!, "Empty input is valid");
  await waitFor(run, manager, () => run.status !== "running");
  assert.equal(run.team!.status, "completed", run.error ?? JSON.stringify(run.team!.gaps));
  const reply = run.team!.messages.find((m) => m.kind === "reply");
  assert.equal(reply?.origin, "user"); assert.equal(reply?.sender, "user");
});

test("Auto team requires plan approval before any writer starts", async () => {
  const { run, manager } = await start("Implement the sample", { approvals: { plan: true } });
  await waitFor(run, manager, () => !!run.awaiting || run.status !== "running");
  assert.equal(run.status, "running", run.error);
  assert.equal(run.steps.filter((s) => s.kind === "agent").length, 1);
  assert.match(run.awaiting!.content, /Requirements/);
  await manager.answer(run.id, { decision: "approve" });
  await waitFor(run, manager, () => run.status !== "running");
  assert.equal(run.team!.status, "completed", run.error ?? JSON.stringify(run.team!.gaps));
});

test("human workflow edits survive cancellation and replay and control the approved dispatch", async () => {
  const { run, manager } = await start("Implement the editable sample", { approvals: { plan: true } });
  await waitFor(run, manager, () => !!run.awaiting || run.status !== "running");
  assert.ok(run.awaiting, run.error);
  const original = editableTeamPlan(run.team!);
  const edit = structuredClone(original);
  edit.tasks[0]!.title = "Human-reviewed implementation";
  edit.tasks[0]!.instructions += " Preserve the approved human instruction.";
  await manager.editTeamPlan(run.id, edit);
  assert.equal(run.team!.revision, original.revision + 1);
  assert.match(run.awaiting!.content, /Human-reviewed implementation/);
  await assert.rejects(manager.editTeamPlan(run.id, original), /plan changed/i);
  const second = editableTeamPlan(run.team!);
  second.contracts.push("Preserve the public API.");
  await manager.editTeamPlan(run.id, second);
  manager.cancel(run.id);
  await waitFor(run, manager, () => run.status !== "running");
  await manager.shutdown();
  await flushWrites();
  const reloaded = new RunManager(findPattern);
  await reloaded.load();
  const resumed = await reloaded.resume(run.id);
  await waitFor(resumed, reloaded, () => !!resumed.awaiting || resumed.status !== "running");
  assert.equal(resumed.team!.tasks[0]!.title, "Human-reviewed implementation");
  assert.equal(resumed.team!.revision, original.revision + 2);
  assert.ok(resumed.team!.contracts.includes("Preserve the public API."));
  assert.equal(resumed.steps.filter((step) => step.kind === "agent").length, 1, "planning was replayed without a second CLI turn");
  reloaded.answer(run.id, { decision: "approve" });
  await waitFor(resumed, reloaded, () => resumed.status !== "running");
  assert.equal(resumed.status, "done", resumed.error);
  assert.ok(resumed.steps.some((step) => step.title.includes("Human-reviewed implementation")), "the edited task was dispatched");
  await assert.rejects(reloaded.editTeamPlan(run.id, second), /not waiting/i);
  await reloaded.shutdown();
});

test("Auto team keeps missing artifacts as gaps even when the integration check passes", async () => {
  const { run } = await finish("AUTO-NO-CHANGE Implement the sample", { options: { maxRepairs: 0 } });
  assert.equal(run.status, "stopped", run.error);
  assert.equal(run.team!.status, "blocked");
  assert.equal(run.facts?.approved, false);
  assert.notEqual(run.verdict, "passed");
  assert.match(run.team!.gaps.join(" "), /no changes|missing|not completed/i);
});

test("Auto team resumes a final-wave user question after replaying the earlier final verification", async () => {
  const { run, manager } = await finish("AUTO-USER-QUESTION Implement the sample", { options: { maxWaves: 1 } });
  assert.equal(run.status, "stopped", run.error);
  assert.equal(run.team!.messages.filter((m) => m.kind === "question").length, 1);
  const originalBudget = { ...run.loop }, earlierUsage = run.usage.agentSteps;
  for (const budget of [{ maxSteps: 201 }, { maxSteps: 3 }, { maxInvocations: 0 }, { maxMinutes: 721 }, { maxMinutes: 0 }]) {
    await assert.rejects(manager.resume(run.id, budget), /budget|at least four/);
    assert.deepEqual(run.loop, originalBudget, "invalid resume budgets cannot alter the saved allocation");
    assert.equal(run.status, "stopped");
  }
  await manager.resume(run.id, { maxSteps: 200, maxInvocations: 200, maxMinutes: 240 });
  await waitFor(run, manager, () => !!run.team?.awaitingRequestId || run.status !== "running");
  assert.equal(run.status, "running", run.error);
  await manager.answerTeamQuestion(run.id, run.team!.awaitingRequestId!, "Empty input is valid");
  await waitFor(run, manager, () => run.status !== "running");
  assert.equal(run.status, "done", run.error);
  assert.equal(run.team!.status, "completed", JSON.stringify(run.team!.gaps));
  assert.equal(run.loop.maxMinutes, 240);
  assert.equal(run.team!.invocationLimit, 200);
  assert.equal(run.team!.coordinationLimit, 50);
  assert.ok(run.usage.agentSteps >= earlierUsage, "extending the allowance preserves lifetime usage");
  assert.equal(run.steps.filter((s) => s.title === "Plan Auto team").length, 1);
  assert.equal(run.steps.filter((s) => s.title.startsWith("Auto task")).length, 2);
  assert.equal(run.steps.filter((s) => s.title.startsWith("Auto team independent review")).length, 2);
});

test("Auto team investigation can finish with evidence without editing files", async () => {
  const { run } = await finish("AUTO-INVESTIGATION Explain the existing contract", { loop: { maxSteps: 20, check: "node --test" }, prove: true });
  assert.equal(run.status, "done", run.error);
  assert.equal(run.team!.status, "completed", JSON.stringify(run.team!.gaps));
  assert.equal(run.team!.verification!.check, "passed");
  assert.equal(run.facts?.approved, true);
  assert.equal(run.facts?.proof, undefined);
  assert.ok(run.steps.some(s => s.title.startsWith("Auto team independent review") && s.status === "done"));
  assert.ok(!run.steps.some(s => s.title.startsWith("Proof:")), "an unchanged investigation must not manufacture failed proof evidence");
});

test("failed integrated checks send their diagnostics to coordination and the repairing worker", async () => {
  const record = mkdtempSync(join(tmpdir(), "codeflow-check-diagnostics-"));
  process.env.FAKE_RECORD_DIR = record;
  try {
    const { run } = await finish("AUTO-MINIMAL Implement the sample", {
      options: { eventDriven: true, maxWaves: 2, maxRepairs: 1 },
      loop: { maxSteps: 16, check: 'node -e "console.error(\'FORMAT_ERROR: remove trailing blank line in tests/security.py\'); process.exit(1)"' },
    });
    const prompts = readdirSync(record).map(file => JSON.parse(readFileSync(join(record, file), "utf8")) as { prompt: string });
    assert.ok(prompts.some(p => p.prompt.includes("AUTO_TEAM_REVISION") && p.prompt.includes("FORMAT_ERROR: remove trailing blank line")), "coordinator must see the actual failure, not guess at the cause");
    assert.ok(prompts.some(p => p.prompt.includes("AUTO_TEAM_TASK") && p.prompt.includes('"attempt": 2') && p.prompt.includes("FORMAT_ERROR: remove trailing blank line")), "the repair turn must retain the same host diagnostics");
    assert.equal(run.status, "stopped");
    assert.equal(run.lastCheck?.ok, false, "passing diagnostics must never bypass a failing check");
  } finally { delete process.env.FAKE_RECORD_DIR; rmSync(record, { recursive: true, force: true }); }
});

test("Auto team private checkpoints do not enter coordinator revisions or another worker's context", async () => {
  const record = mkdtempSync(join(tmpdir(), "codeflow-auto-prompts-")); process.env.FAKE_RECORD_DIR = record;
  try {
    const { run } = await finish("AUTO-SAME-PROVIDER Implement the sample");
    assert.equal(run.status, "done", run.error);
    const prompts = readdirSync(record).map((f) => JSON.parse(readFileSync(join(record, f), "utf8")) as { prompt: string });
    const beta = prompts.find((p) => p.prompt.includes("AUTO_TEAM_TASK") && p.prompt.includes('"id": "beta"'));
    assert.ok(beta); assert.doesNotMatch(beta.prompt, /Completed alpha with evidence/);
  } finally { delete process.env.FAKE_RECORD_DIR; rmSync(record, { recursive: true, force: true }); }
});

test("Auto team replaces an idle failed worker and hands over its worktree with a fresh member session", async () => {
  const record = mkdtempSync(join(tmpdir(), "codeflow-auto-handover-")); process.env.FAKE_RECORD_DIR = record;
  try {
  const { run } = await finish("AUTO-HANDOVER Implement the sample");
  assert.equal(run.status, "done", run.error);
  assert.equal(run.team!.status, "completed", JSON.stringify(run.team!.gaps));
  assert.equal(run.team!.members.find((m) => m.id === "builder")!.status, "retired");
  assert.equal(run.team!.tasks[0]!.owner, "replacement");
  assert.deepEqual(run.steps.filter((s) => s.title.startsWith("Auto task")).map((s) => s.memberId), ["builder", "replacement"]);
  const prompts = readdirSync(record).map((f) => JSON.parse(readFileSync(join(record, f), "utf8")) as { prompt: string });
  const replacement = prompts.find((p) => p.prompt.includes("AUTO_TEAM_TASK") && p.prompt.includes('"id": "replacement"'))!;
  assert.match(replacement.prompt, /Shared output and next actions for alpha/);
  assert.doesNotMatch(replacement.prompt, /The requested work is blocked/, "the retired member's private checkpoint is not handed over");
  } finally { delete process.env.FAKE_RECORD_DIR; rmSync(record, { recursive: true, force: true }); }
});

test("Auto team restart replays completed planning, work, and questions before a fresh final review", async () => {
  process.env.FAKE_SLEEP_VENDOR = "codex"; process.env.FAKE_SLEEP_MS = "5000";
  const { run, manager } = await start("AUTO-QUESTION Implement the sample");
  try {
    await waitFor(run, manager, () => run.steps.some((s) => s.title.startsWith("Auto team independent review") && s.status === "running") || run.status !== "running");
    assert.equal(run.status, "running", run.error);
    await manager.shutdown();
  } finally { delete process.env.FAKE_SLEEP_VENDOR; delete process.env.FAKE_SLEEP_MS; }
  const resumed = new RunManager(findPattern); await resumed.load();
  const loaded = resumed.get(run.id)!; await resumed.resume(run.id);
  await waitFor(loaded, resumed, () => loaded.status !== "running");
  assert.equal(loaded.status, "done", loaded.error);
  assert.equal(loaded.team!.status, "completed", JSON.stringify(loaded.team!.gaps));
  assert.equal(loaded.steps.filter((s) => s.title === "Plan Auto team").length, 1);
  assert.equal(loaded.steps.filter((s) => s.title.startsWith("Auto task")).length, 2);
  assert.equal(loaded.team!.messages.filter((m) => m.kind === "question").length, 1);
});

test("Auto team restart preserves a final repair commit before re-reviewing it", async () => {
  process.env.FAKE_REVIEW_FAIL_ONCE = "1"; rmSync(join(home, ".reviewed-once"), { force: true });
  const { run, manager } = await start("Implement the sample");
  const unsubscribe = manager.subscribe(run.id, (event) => {
    if (event.type === "step" && event.step.title === "Auto team repair (1)" && event.step.status === "done") {
      process.env.FAKE_SLEEP_VENDOR = "codex"; process.env.FAKE_SLEEP_MS = "5000";
    }
  });
  try {
    await waitFor(run, manager, () => run.steps.some((s) => s.title === "Auto team independent review (2)" && s.status === "running") || run.status !== "running");
    assert.equal(run.status, "running", run.error);
    await manager.shutdown();
  } finally { unsubscribe(); delete process.env.FAKE_REVIEW_FAIL_ONCE; delete process.env.FAKE_SLEEP_VENDOR; delete process.env.FAKE_SLEEP_MS; }
  const branch = run.worktrees.find((w) => w.name === "integration")!.branch;
  const repairedHead = execFileSync("git", ["rev-parse", branch], { cwd: run.repo }).toString().trim();
  const resumed = new RunManager(findPattern); await resumed.load(); const loaded = resumed.get(run.id)!;
  await resumed.resume(run.id); await waitFor(loaded, resumed, () => loaded.status !== "running");
  assert.equal(loaded.status, "done", loaded.error);
  assert.equal(loaded.team!.verification!.head, repairedHead);
  assert.equal(loaded.steps.filter((s) => s.title.startsWith("Auto team repair")).length, 1, "the completed repair is replayed, not authored twice");
  assert.equal(loaded.facts!.approved, true);
});

test("Auto team resumes after memory acceptance persisted but its journal acknowledgement did not", async () => {
  const original = memoryStore.accept.bind(memoryStore);
  let interrupted = false;
  memoryStore.accept = async (...args: Parameters<typeof original>) => {
    const result = await original(...args);
    if (!interrupted && args[4]?.endsWith(":accept")) {
      interrupted = true;
      throw new Error("Simulated interruption after durable acceptance, before journal acknowledgement");
    }
    return result;
  };
  let item: Awaited<ReturnType<typeof finish>>;
  try { item = await finish("Implement the sample"); }
  finally { memoryStore.accept = original; }
  assert.ok(interrupted);
  assert.equal(item.run.status, "failed");
  await item.manager.resume(item.run.id);
  await waitFor(item.run, item.manager, () => item.run.status !== "running");
  assert.equal(item.run.status, "done", item.run.error);
  assert.equal(item.run.team!.status, "completed");
  assert.equal(item.run.steps.filter((s) => s.title.startsWith("Auto task")).length, 1, "completed work was not repeated to reconcile memory");
});


test("Auto event scheduler integrates a dependency and starts its successor before an unrelated member finishes", async () => {
  const release = join(home, "slow-task-release");
  process.env.FAKE_AUTO_SLOW_RELEASE = release;
  const safety = setTimeout(() => writeFileSync(release, "release"), 25000);
  let item: Awaited<ReturnType<typeof start>> | undefined;
  try {
    item = await start("AUTO-EVENT Implement the sample", { options: { eventDriven: true } });
    const { run, manager } = item;
    await waitFor(run, manager, () => run.steps.some((step) => step.taskId === "beta" && step.title.startsWith("Auto task")) || run.status !== "running");
    const alpha = run.steps.find((step) => step.taskId === "alpha" && step.title.startsWith("Auto task"))!;
    const beta = run.steps.find((step) => step.taskId === "beta" && step.title.startsWith("Auto task"))!;
    const slow = run.steps.find((step) => step.taskId === "slow" && step.title.startsWith("Auto task"));
    assert.ok(beta, run.error);
    assert.ok(beta.startedAt >= alpha.endedAt!, "the successor waits for its own dependency");
    assert.ok(!slow?.endedAt, "the successor starts while the unrelated worker remains held at its explicit checkpoint");
    writeFileSync(release, "release");
    await waitFor(run, manager, () => run.status !== "running");
    assert.equal(run.status, "done", run.error);
    assert.equal(run.team!.scheduler, "event");
    assert.ok(run.team!.contextManifests.find((manifest) => manifest.taskId === "beta")!.inputHead);
    assert.equal(run.team!.verification!.approved, true);
  } finally {
    clearTimeout(safety); writeFileSync(release, "release"); delete process.env.FAKE_AUTO_SLOW_RELEASE;
    if (item?.run.status === "running") await item.manager.shutdown();
  }
});


test("explicit legacy wave mode retains a barrier and remains available for saved workflows", async () => {
  const { run } = await finish("AUTO-EVENT Implement the sample", { options: { eventDriven: false } });
  assert.equal(run.status, "done", run.error);
  assert.equal(run.team!.scheduler, "waves");
  const beta = run.steps.find((step) => step.taskId === "beta" && step.title.startsWith("Auto task"))!;
  const slow = run.steps.find((step) => step.taskId === "slow" && step.title.startsWith("Auto task"))!;
  assert.ok(beta.startedAt >= slow.endedAt!);
});


test("Auto event recovery preserves accepted completion order while interrupted peers rerun safely", async () => {
  const { run, manager } = await start("AUTO-EVENT Implement the sample", { options: { eventDriven: true } });
  await waitFor(run, manager, () => run.steps.some((step) => step.taskId === "beta" && step.status === "running") || run.status !== "running");
  assert.equal(run.status, "running", run.error);
  await manager.shutdown();
  const resumed = new RunManager(findPattern); await resumed.load(); const loaded = resumed.get(run.id)!;
  await resumed.resume(run.id); await waitFor(loaded, resumed, () => loaded.status !== "running");
  assert.equal(loaded.status, "done", loaded.error);
  assert.equal(loaded.steps.filter((step) => step.title === "Plan Auto team").length, 1);
  assert.equal(loaded.steps.filter((step) => step.taskId === "alpha").length, 1, "completed dependency work must replay without a new CLI call");
  assert.deepEqual(loaded.team!.tasks.map((task) => task.id).sort(), ["alpha", "beta", "slow"]);
  assert.ok(loaded.team!.tasks.every((task) => task.status === "completed"));
  assert.equal(loaded.team!.verification!.approved, true);
});

test("Auto planning expands a reusable subplan into visible approved tasks and independent verification", async () => {
  const { run } = await finish("AUTO-SUBPLAN Implement the sample", { options: { eventDriven: true } });
  assert.equal(run.status, "done", run.error);
  assert.deepEqual(run.team!.tasks.map((task) => task.id), ["sample-investigate", "sample-implement"]);
  assert.equal(run.team!.strategyInstances![0]!.strategy, "investigate-implement");
  assert.equal(run.team!.verification!.approved, true);
});


test("changed contracts invalidate accepted artifact evidence until independent revalidation", async () => {
  const { run } = await finish("AUTO-CONTRACT-CHANGE Implement the sample", { options: { eventDriven: true } });
  assert.equal(run.status, "done", run.error);
  assert.ok(run.steps.some((step) => step.title === "Review revised contracts (1)"));
  assert.equal(run.steps.filter((step) => step.taskId === "alpha" && step.title.startsWith("Auto task")).length, 1, "an accepted task is revalidated without rewriting it");
  assert.equal(run.team!.tasks.find((task) => task.id === "alpha")!.evidenceRevision, 1);
  assert.ok(run.team!.tasks.every((task) => !task.evidenceStale));
  assert.equal(run.team!.verification!.revision, 1);
  assert.equal(run.team!.verification!.approved, true);
});

test("Auto plans and reserves review against the smaller actual invocation ceiling", async () => {
  const { run } = await finish("Implement the sample", { loop: { check: "node --test", maxSteps: 20, maxInvocations: 4 } });
  assert.equal(run.status, "done", run.error);
  assert.equal(run.team!.invocationLimit, 4);
  assert.equal(run.team!.coordinationLimit, 1);
  assert.equal(run.team!.verification!.approved, true);
  assert.ok(run.team!.metrics.invocations <= 4);
});

test("Auto rejects an actual invocation ceiling below four before spending planning quota", async () => {
  const { run } = await finish("Implement the sample", { loop: { check: "node --test", maxSteps: 20, maxInvocations: 3 } });
  assert.equal(run.status, "failed", run.error);
  assert.match(run.error!, /at least four invocations/);
  assert.equal(run.steps.filter((step) => step.kind === "agent").length, 0);
});


test("a resumed event task reconciles its captured input instead of a newer peer commit", async () => {
  const merge = TeamContext.prototype.merge;
  let advanced = false;
  TeamContext.prototype.merge = async function (wt, from) {
    if (!advanced && wt.name === "auto-alpha") {
      advanced = true;
      // Simulate another artifact landing after the scheduler captured this
      // attempt's input but before the yielded worktree reconciles it.
      const integration = this.run.worktrees.find((entry) => entry.name === "integration")!;
      writeFileSync(join(integration.path, "later-peer.txt"), "A later peer artifact\n");
      await this.commit({ ...integration, base: this.run.baseRef }, "Test: concurrent peer artifact");
    }
    return merge.call(this, wt, from);
  };
  try {
    const { run } = await finish("AUTO-QUESTION Implement the sample", { options: { eventDriven: true } });
    assert.equal(run.status, "done", run.error);
    assert.ok(advanced);
    const task = run.worktrees.find((wt) => wt.name === "auto-alpha")!;
    const integration = run.worktrees.find((wt) => wt.name === "integration")!;
    const files = (branch: string) => execFileSync("git", ["ls-tree", "--name-only", branch], { cwd: run.repo }).toString();
    assert.doesNotMatch(files(task.branch), /later-peer\.txt/, "the attempt must not import changes beyond its captured input");
    assert.match(files(integration.branch), /later-peer\.txt/, "the later peer artifact remains on the integrated result");
    assert.equal(run.team!.verification!.approved, true);
  } finally { TeamContext.prototype.merge = merge; }
});

test("Auto team without a runnable check finishes reviewed but unverified, instead of blocking on every Resume", async () => {
  const { run } = await finish("Implement the sample", { loop: { maxSteps: 20 } });
  assert.equal(run.status, "done", run.error);
  assert.equal(run.team!.status, "completed", JSON.stringify(run.team!.gaps));
  assert.deepEqual(run.team!.gaps, []);
  assert.equal(run.team!.verification!.check, "unknown");
  assert.equal(run.team!.verification!.reviewed, true);
  assert.equal(run.team!.verification!.approved, true);
  assert.equal(run.verdict, undefined, "no check ran, so there is no pass/fail verdict");
  assert.ok(run.team!.tasks.every((task) => task.status === "completed"));
  assert.match(run.summary ?? "", /unverified: no runnable check/);
  // Unverified work stays a proposal: nothing is accepted into team knowledge beyond the plan's contracts.
  const entries = await memoryStore.list({ repo: run.repo, runId: run.id, scope: "team" }, { kind: "user", repo: run.repo });
  assert.ok(entries.length > 0);
  assert.ok(entries.filter((entry) => !entry.title.startsWith("Accepted team contract")).every((entry) => entry.status !== "accepted"), JSON.stringify(entries.map((e) => [e.title, e.status])));
});

test("Auto team stops asking the coordinator once a revision changes nothing", async () => {
  // AUTO-FAILURE makes every worker turn fail; the fake coordinator then retries within maxRepairs and finally returns an empty patch.
  const { run } = await finish("AUTO-FAILURE Implement the sample", { options: { maxRepairs: 1 } });
  assert.equal(run.status, "stopped", run.error);
  assert.equal(run.team!.status, "blocked");
  const revisions = run.steps.filter((s) => s.title.startsWith("Revise workflow"));
  assert.ok(revisions.length >= 1 && revisions.length <= 2, `coordinator revisions: ${revisions.length}`);
  assert.ok(run.team!.metrics.coordinatorInvocations < run.team!.coordinationLimit + 1, "a no-op revision must not exhaust the coordination budget");
});


test("Auto team dispatches distinct selected models from one provider without leaking primary effort", async () => {
  const { run } = await finish("AUTO-SAME-PROVIDER AUTO-MODEL-POOL Implement the sample", {
    roleSettings: { pool: { claude: { model: "opus", effort: "high", variants: [{ model: "sonnet" }] } } },
  });
  assert.equal(run.status, "done", run.error);
  const members = run.team!.members.filter(member => member.role === "worker");
  assert.deepEqual(members.map(member => [member.provider, member.model, member.effort]), [["claude", "opus", "high"], ["claude", "sonnet", ""]]);
  const steps = run.steps.filter(step => step.taskId && step.kind === "agent");
  assert.deepEqual(steps.map(step => step.settings), [{ model: "opus", effort: "high" }, { model: "sonnet", effort: "" }]);
  assert.notEqual(steps[0]!.sessionId, steps[1]!.sessionId);
  assert.deepEqual(run.team!.inventory!.providers.find(p => p.id === "claude")!.settingsByRole!.worker!.variants, [{ model: "sonnet" }]);
});


test("Auto team accepts host-observed browser effects without source edits and still reviews them", async () => {
  const { createServer } = await import("node:http");
  const { claudeAdapter } = await import("../src/adapters/claude.js");
  const { codexAdapter } = await import("../src/adapters/codex.js");
  const { agentToolBridge } = await import("../src/agent-tools.js");
  const server = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end('<input aria-label="Name">'); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}/`;
  const originals = [claudeAdapter.run, codexAdapter.run];
  let completeAction = true;
  for (const [i, adapter] of [claudeAdapter, codexAdapter].entries()) adapter.run = async (opts, onEvent) => {
    if (opts.prompt.startsWith("AUTO_TEAM_TASK")) {
      const conn = opts.agentTools!;
      assert.ok(conn, "team workers get a task-scoped bridge");
      const call = async (name: string, args = {}) => {
        const response = await fetch(conn.endpoint, { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${conn.token}` }, body: JSON.stringify({ name, arguments: args }) });
        return await response.json() as any;
      };
      const navigation = await call("browser_navigate", { url, operationId: "open-fixture" });
      assert.equal(navigation.error, undefined, JSON.stringify(navigation));
      await call("browser_snapshot");
      assert.match((await call("browser_type", { ref: "stale", text: "wrong", operationId: "stale-fill" })).error, /stale/);
      if (completeAction) {
        const page = JSON.parse((await call("browser_snapshot")).content[0].text);
        const result = await call("browser_type", { ref: page.snapshot.find((item: any) => item.role === "textbox").ref, text: "Task completed", operationId: "complete-fill" });
        assert.equal(result.error, undefined);
      }
    }
    return originals[i]!(opts, onEvent);
  };
  try {
    const { run } = await finish("AUTO-NO-CHANGE Perform the shared browser interaction", { options: { maxRepairs: 0 } });
    assert.equal(run.status, "done", run.error);
    assert.ok(run.steps.some(step => step.title.includes("independent review") && step.status === "done"));
    const actions = run.steps.flatMap(step => step.sharedToolActions ?? []);
    assert.ok(actions.length > 0);
    assert.ok(actions.some(action => action.name === "browser_type" && action.state === "completed"));
    assert.ok(actions.some(action => action.name === "browser_type" && action.state === "uncertain"), "failed actions remain recoverable without claiming completion");
    assert.ok(!actions.some(action => action.name === "browser_snapshot"), "observations do not become effect evidence");
    assert.ok(run.team!.tasks.every(task => task.attempts === 1), "completed effects must not be replayed for an empty diff");
    completeAction = false;
    const incomplete = (await finish("AUTO-NO-CHANGE Perform the shared browser interaction", { options: { maxRepairs: 0 } })).run;
    assert.ok(incomplete.team!.tasks.some(task => task.status !== "completed"), "navigation and failed actions cannot satisfy a deliverable");
    assert.match(incomplete.team!.gaps.join("\n"), /artifact is missing/);
  } finally {
    claudeAdapter.run = originals[0]!; codexAdapter.run = originals[1]!;
    await agentToolBridge.close(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
