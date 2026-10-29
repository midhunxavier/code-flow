import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const home = mkdtempSync(join(tmpdir(), "codeflow-qa-missions-engine-"));
process.env.CODEFLOW_HOME = home;
process.env.CODEFLOW_PROJECT_TEAMS_ENABLED = "true";
process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { Projects } = await import("../src/projects.js");
const { Automations } = await import("../src/automation.js");
const { ProjectTeams } = await import("../src/project-teams.js");
const { ProjectTeamStore } = await import("../src/project-team-store.js");
const { allowance } = await import("../src/project-team-model.js");
const { flushWrites } = await import("../src/store.js");
const services: InstanceType<typeof ProjectTeams>[] = [], repos: string[] = [];
const managers: InstanceType<typeof RunManager>[] = [];
after(async () => { await Promise.all(services.map((s) => s.stop())); await Promise.all(managers.map((m) => m.shutdown())); await flushWrites(); for (const repo of repos) rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
const mission = (extra = {}) => ({ mission: "Improve the documented input contract", users: "Developers", baseBranch: "main", mode: "build-within-scope", check: "node --test", coordinator: "claude", pool: ["claude", "codex"], schedule: { at: "09:00", days: [1], timezone: "Europe/Stockholm" }, ...extra });
let counter = 0;
async function fixture(extra = {}, overrides: Partial<import("../src/project-teams.js").ProjectTeamsOptions> = {}) {
  const dir = join(home, `case-${++counter}`); mkdirSync(dir);
  const repo = mkdtempSync(join(tmpdir(), "codeflow-qa-missions-engine-repo-")); repos.push(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString().trim();
  git("init", "-q", "-b", "main"); writeFileSync(join(repo, "README.md"), "Empty input is valid.\n");
  writeFileSync(join(repo, "sample.test.mjs"), 'import {test} from "node:test"; import assert from "node:assert/strict"; test("baseline",()=>assert.equal(1,1));\n');
  mkdirSync(join(repo, ".codeflow")); writeFileSync(join(repo, ".codeflow/config.json"), JSON.stringify({ prove: false }));
  git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "initial");
  const projects = new Projects(join(dir, "projects.json")); await projects.load(); const project = await projects.create({ name: "Product", repos: [repo] });
  const manager = new RunManager(findPattern, projects);
  managers.push(manager);
  const automations = new Automations(manager, async () => { throw new Error("Managed target bypassed the team service"); }, undefined, join(dir, "triggers.json")); await automations.load();
  const build = async (b: Record<string, any>) => ({ ...b, pattern: findPattern(b.pattern)! }) as import("../src/engine.js").StartRunInput;
  const store = new ProjectTeamStore(join(dir, "teams"));
  const service = new ProjectTeams({ manager, projects, automations, build, store, ...overrides }); services.push(service); await service.load(); service.start();
  const draft = await service.create({ operationId: "create", name: "Product team", projectId: project.id, repo, mission: mission(extra) });
  const team = await service.update(draft.id, { operationId: "activate", revision: draft.revision, status: "active" });
  return { dir, repo, git, projects, project, manager, automations, store, service, team, build };
}
async function settled(f: Awaited<ReturnType<typeof fixture>>) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await f.service.reconcile();
    const t = f.store.get(f.team.id), c = t.cycles.at(-1);
    if (c && ["completed", "no-op", "blocked", "failed", "cancelled"].includes(c.status)) return t;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(JSON.stringify({ team: f.store.get(f.team.id), runs: f.manager.list().map((r) => ({ status: r.status, error: r.error, team: r.team })) }));
}

const { missionBrief, missionHref } = await import("../ui/mission-brief.js");
const { RESTORED_TEAM_ERROR } = await import("../src/project-team-model.js");
const task = (operationId: string, revision: number, instructions = "Document empty input") => ({ operationId, revision, title: "Improve the input contract", instructions, acceptance: ["Existing checks pass"], category: "docs" });

test("archiving removes worktrees without invalidating the exact verified result", async () => {
  const f = await fixture();
  await f.service.assignTask(f.team.id, task("task", f.team.revision));
  let t = await settled(f), o = t.opportunities[0]!; assert.equal(o.status, "ready", o.reason);
  const run = f.manager.get(o.result!.runId)!;
  await f.manager.archive(run.id, { cleanup: true });
  assert.ok(run.worktrees.every(tree => !existsSync(tree.path)));
  assert.equal(f.git("rev-parse", o.result!.branch), o.result!.head);
  await f.service.reconcile(); t = f.store.get(t.id); o = t.opportunities[0]!;
  assert.equal(o.status, "ready", o.reason);
  await f.service.decide(t.id, o.id, { operationId: "approve", revision: t.revision, opportunityRevision: o.revision, action: "approve" });
  await f.service.reconcile(); assert.equal(f.store.get(t.id).opportunities[0]!.status, "accepted");
  const merged = await f.manager.merge(run.id, { branch: o.result!.branch, into: "main" }); assert.equal(merged.ok, true);
});

test("releasing a deleted project archives missions while preserving settled history and frees its repository", async () => {
  const f = await fixture(); await f.service.cycle(f.team.id, "cycle");
  const before = await settled(f); await f.manager.removeProject(f.project.id); await f.service.releaseProject(f.project.id);
  for (const cycle of before.cycles) for (const launch of cycle.launches) if (launch.runId) assert.equal(f.manager.get(launch.runId), undefined, "project deletion removes mission runs too");
  const released = f.store.get(before.id); assert.equal(released.status, "archived");
  assert.deepEqual(released.cycles, before.cycles); assert.deepEqual(released.opportunities, before.opportunities);
  assert.deepEqual(allowance(released), allowance(before)); assert.equal(f.automations.get(`t-${before.id}`)!.enabled, false);
  const project = await f.projects.create({ name: "Replacement", repos: [f.repo] });
  const replacement = await f.service.create({ operationId: "replacement", name: "New mission", projectId: project.id, repo: f.repo, mission: mission() });
  assert.equal(replacement.status, "draft");
});

test("old orphaned missions remain visible and can be archived from their repository's new project", async () => {
  const f = await fixture(); await f.manager.removeProject(f.project.id);
  const project = await f.projects.create({ name: "Replacement", repos: [f.repo] });
  assert.equal(f.service.list(project.id)[0]!.id, f.team.id);
  const t = f.store.get(f.team.id); await f.service.update(t.id, { operationId: "release-orphan", revision: t.revision, status: "archived" });
  assert.deepEqual(f.service.list(project.id), []);
});

test("recovery clears transient errors and never overwrites a restored-mission advisory", async () => {
  let allowed = true;
  const f = await fixture({}, { allowed: async () => { if (!allowed) throw new Error("Temporary access problem"); } });
  await f.store.change(f.team.id, undefined, undefined, t => { t.error = RESTORED_TEAM_ERROR; });
  allowed = false; await f.service.reconcile();
  assert.equal(f.store.get(f.team.id).recoveryError, "Temporary access problem"); assert.equal(f.store.get(f.team.id).error, RESTORED_TEAM_ERROR);
  allowed = true; await f.service.reconcile();
  assert.equal(f.store.get(f.team.id).recoveryError, undefined); assert.equal(f.store.get(f.team.id).error, RESTORED_TEAM_ERROR);
  await f.store.change(f.team.id, undefined, undefined, t => { t.error = "Auto team execution is disabled by this host’s configuration"; });
  await f.service.reconcile(); assert.equal(f.store.get(f.team.id).error, undefined);
});

test("mission failures expose the actual no-change and proof failure causes", async () => {
  const f = await fixture(); await f.service.assignTask(f.team.id, task("no-change", f.team.revision, "AUTO-NO-CHANGE"));
  const t = await settled(f); assert.match(t.opportunities[0]!.reason!, /produced no changes/); assert.doesNotMatch(t.opportunities[0]!.reason!, /lacks required checks/);
  const proof = await fixture({ check: "node -e 0" });
  writeFileSync(join(proof.repo, ".codeflow/config.json"), JSON.stringify({ prove: true })); proof.git("add", "."); proof.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "Require proof");
  await proof.service.assignTask(proof.team.id, task("proof", proof.team.revision));
  assert.match((await settled(proof)).opportunities[0]!.reason!, /Fail-to-pass evidence is unproven/);
});

test("an interrupted discovery stays fully charged but becomes deletable after settlement", async () => {
  const f = await fixture({ mode: "propose" }); process.env.FAKE_SLEEP_MS = "3000";
  let run: import("../src/engine.js").Run;
  try {
    const t = await f.service.cycle(f.team.id, "interrupt"); run = f.manager.get(t.cycles[0]!.launches[0]!.runId!)!;
    for (let i = 0; i < 100 && !run.steps.some(s => s.kind === "agent" && s.status === "running"); i++) await new Promise(r => setTimeout(r, 30));
    assert.ok(run.steps.some(s => s.kind === "agent" && s.status === "running"));
    await f.service.stop(); await f.manager.shutdown();
  } finally { delete process.env.FAKE_SLEEP_MS; }
  const manager = new RunManager(findPattern, f.projects); managers.push(manager); await manager.load();
  assert.equal(manager.get(run!.id)!.status, "interrupted");
  const automations = new Automations(manager, async () => { throw new Error("Unexpected launch"); }, undefined, join(f.dir, "triggers.json")); await automations.load();
  const service = new ProjectTeams({ manager, projects: f.projects, automations, build: f.build, store: f.store }); services.push(service); await service.load(); service.start();
  await service.reconcile(); const t = f.store.get(f.team.id), launch = t.cycles[0]!.launches[0]!;
  assert.equal(t.cycles[0]!.status, "blocked"); assert.match(t.cycles[0]!.reason!, /interrupted because Code Flow stopped/);
  assert.equal(launch.state, "settled"); assert.equal(launch.usedCalls, launch.calls); assert.equal(launch.usage, undefined);
  const budget = allowance(t); await manager.deleteRun(run!.id); assert.equal(manager.get(run!.id), undefined); assert.deepEqual(allowance(f.store.get(t.id)), budget);
});

test("discovery failure reasons retain reviewer rejection and filesystem permission details", { skip: (process.platform === "win32" || process.getuid?.() === 0) && "requires POSIX permission enforcement" }, async () => {
  const rejected = await fixture({ mode: "propose" });
  process.env.FAKE_REVIEW_FAIL_ONCE = "1";
  try {
    await rejected.service.cycle(rejected.team.id, "review-rejected");
    assert.match((await settled(rejected)).cycles[0]!.reason!, /review.*(?:requires changes|blocking findings)/i);
  } finally { delete process.env.FAKE_REVIEW_FAIL_ONCE; }
  const denied = await fixture({ mode: "propose" });
  const worktrees = join(denied.repo, ".worktrees"); mkdirSync(worktrees); chmodSync(worktrees, 0o555);
  try {
    await denied.service.cycle(denied.team.id, "permission-denied");
    assert.match((await settled(denied)).cycles[0]!.reason!, /EACCES.*permission denied/);
  } finally { chmodSync(worktrees, 0o755); }
});

test("disabled hosts disarm mission schedules and previews until re-enabled without catch-up", async () => {
  const f = await fixture({ mode: "propose", schedule: { every: 5 } }); const id = `t-${f.team.id}`;
  assert.equal(f.automations.get(id)!.enabled, true); const due = f.automations.get(id)!.nextAt!;
  await f.service.setEnabled({ enabled: false, revision: 0 });
  assert.equal(f.automations.get(id)!.enabled, false); assert.equal(f.automations.get(id)!.nextAt, undefined);
  assert.deepEqual((await f.service.preview(f.team.id)).nextTimes, []);
  for (let now = due; now < due + 2 * 3600000; now += 30000) await f.automations.tick(now);
  assert.equal(f.store.get(f.team.id).cycles.length, 0); assert.equal(f.automations.events(id).length, 0);
  await f.service.setEnabled({ enabled: true, revision: 1 }); assert.ok(f.automations.get(id)!.nextAt! > Date.now());
  process.env.CODEFLOW_AUTO_TEAM_ENABLED = "false";
  try { await f.service.reconcile(); assert.equal(f.automations.get(id)!.enabled, false); assert.deepEqual((await f.service.preview(f.team.id)).nextTimes, []); }
  finally { delete process.env.CODEFLOW_AUTO_TEAM_ENABLED; }
  await f.service.reconcile(); assert.equal(f.automations.get(id)!.enabled, true);
  const t = f.store.get(f.team.id); await f.service.update(t.id, { operationId: "pause", revision: t.revision, status: "paused" }); assert.deepEqual((await f.service.preview(t.id)).nextTimes, []);
});

test("a refused scheduled occurrence uses one event and bounded retry spacing", async () => {
  const f = await fixture({ mode: "propose", schedule: { every: 5 } }); const id = `t-${f.team.id}`, due = f.automations.get(id)!.nextAt!;
  let attempts = 0;
  f.automations.setProjectTeams({ fire: async () => { attempts++; throw new Error("Temporary admission failure"); }, preview: id => f.service.preview(id), tick: async () => {} });
  for (let now = due; now < due + 20 * 60000; now += 30000) await f.automations.tick(now);
  assert.equal(attempts, 4); assert.equal(f.automations.events(id).length, 1);
});

test("missing base branches are rejected before saving and have an actionable preview", async () => {
  const f = await fixture(); const t = f.store.get(f.team.id);
  await assert.rejects(f.service.update(t.id, { operationId: "missing", revision: t.revision, mission: { ...t.mission, baseBranch: "missing" } }), /Base branch "missing" doesn't exist/);
  assert.equal(f.store.get(t.id).mission.baseBranch, "main");
  f.git("branch", "-m", "main", "trunk");
  assert.match((await f.service.preview(t.id)).warnings.join(" "), /Base branch "main" doesn't exist/);
  await assert.rejects(f.service.cycle(t.id, "missing-cycle"), /Base branch "main" doesn't exist/);
});

test("idle stops leave no receipt, retry is idempotent and old cancelled cycles are not cancelled again", async () => {
  const f = await fixture({ mode: "propose" }, { persistUsage: async () => undefined });
  await assert.rejects(f.service.stopCycle(f.team.id, { operationId: "idle", revision: f.team.revision }), (e: any) => e.status === 409 && /nothing to stop/.test(e.message));
  assert.deepEqual(f.store.get(f.team.id), f.team);
  process.env.FAKE_SLEEP_MS = "1000";
  try {
    await f.service.cycle(f.team.id, "cycle"); const t = f.store.get(f.team.id), request = { operationId: "stop", revision: t.revision };
    await f.service.stopCycle(t.id, request); const stopped = await f.service.stopCycle(t.id, request);
    assert.equal(stopped.operations.filter(op => op.id === "stop").length, 1); assert.equal(stopped.cycles[0]!.status, "cancelled");
    const oldRunId = stopped.cycles[0]!.launches[0]!.runId!;
    for (let i = 0; i < 100 && !f.manager.get(oldRunId)!.endedAt; i++) await new Promise(r => setTimeout(r, 20));
    assert.ok(f.manager.get(oldRunId)!.endedAt);
    assert.notEqual(f.store.get(t.id).cycles[0]!.launches[0]!.state, "settled", "older cancelled reservation is unresolved");
    const current = await f.service.cycle(t.id, "new-cycle"), currentRunId = current.cycles.at(-1)!.launches[0]!.runId!;
    const cancelled: string[] = [], cancel = f.manager.cancel.bind(f.manager);
    f.manager.cancel = id => { cancelled.push(id); return cancel(id); };
    try {
      await f.service.stopCycle(t.id, { operationId: "stop-new", revision: current.revision });
      assert.deepEqual(cancelled, [currentRunId]);
    } finally { f.manager.cancel = cancel; }
  } finally { delete process.env.FAKE_SLEEP_MS; }
});

test("mission summaries expose readable fields and tolerate malformed historical task context", () => {
  const brief = missionBrief('Implement a task\nOwner mission and constraints:\n{"mission":"Help developers","paths":"bad-type","users":{"x":1}}\n<project_evidence>\n{"opportunity":{"problem":"Document input","acceptance":["Checks pass",1]}}\n</project_evidence>')!;
  assert.equal(brief.summary, "Implement a task"); assert.equal(brief.problem, "Document input"); assert.deepEqual(brief.acceptance, ["Checks pass"]);
  assert.deepEqual(brief.mission!.paths, []); assert.equal(brief.mission!.users, undefined);
  assert.equal(missionHref({ project: "p-test" }), "#/project/p-test/automation/missions");
});
