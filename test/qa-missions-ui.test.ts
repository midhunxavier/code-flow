import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const home = mkdtempSync(join(tmpdir(), "codeflow-qa-missions-"));
process.env.CODEFLOW_HOME = home;
process.env.CODEFLOW_PROJECT_TEAMS_ENABLED = "true";
process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { Projects } = await import("../src/projects.js");
const { Automations } = await import("../src/automation.js");
const { ProjectTeams } = await import("../src/project-teams.js");
const { ProjectTeamStore } = await import("../src/project-team-store.js");
const { validateMission } = await import("../src/project-team-model.js");
const { PROJECT_TEAM_BUDGET_RANGES, defaultProjectTeamBudget } = await import("../src/project-team-budget.js");
const { buildRefusal, taskAdmissionProblem } = await import("../src/project-team-admission.js");
const { repositoryIdentity } = await import("../src/repository-identity.js");
const { projectTeamInboxSummary, projectTeamNeedsOwner } = await import("../ui/project-team-inbox.js");
const { flushWrites } = await import("../src/store.js");
type Team = import("../src/project-team-model.js").ProjectTeam;
const services: InstanceType<typeof ProjectTeams>[] = [], managers: InstanceType<typeof RunManager>[] = [], repos: string[] = [];
after(async () => { await Promise.all(services.map((s) => s.stop())); await Promise.all(managers.map((m) => m.shutdown())); await flushWrites(); for (const repo of repos) rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
const mission = (extra = {}) => ({ mission: "Improve the documented input contract", users: "Developers", baseBranch: "main", mode: "build-within-scope", check: "node --test", coordinator: "claude", pool: ["claude", "codex"], schedule: { at: "09:00", days: [1], timezone: "Europe/Stockholm" }, ...extra });
function repository() {
  const repo = mkdtempSync(join(tmpdir(), "codeflow-qa-missions-repo-")); repos.push(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString().trim();
  git("init", "-q", "-b", "main"); writeFileSync(join(repo, "README.md"), "Empty input is valid.\n");
  writeFileSync(join(repo, "sample.test.mjs"), 'import {test} from "node:test"; import assert from "node:assert/strict"; test("baseline",()=>assert.equal(1,1));\n');
  mkdirSync(join(repo, ".codeflow")); writeFileSync(join(repo, ".codeflow/config.json"), JSON.stringify({ prove: false }));
  git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "initial");
  return { repo: realpathSync(repo), git };
}
let counter = 0;
async function fixture(extra = {}) {
  const dir = join(home, `case-${++counter}`); mkdirSync(dir);
  const { repo, git } = repository();
  const projects = new Projects(join(dir, "projects.json")); await projects.load(); const project = await projects.create({ name: "Product", repos: [repo] });
  const manager = new RunManager(findPattern, projects); managers.push(manager);
  const automations = new Automations(manager, async () => { throw new Error("Managed target bypassed the team service"); }, undefined, join(dir, "triggers.json")); await automations.load();
  const build = async (b: Record<string, any>) => ({ ...b, pattern: findPattern(b.pattern)! }) as import("../src/engine.js").StartRunInput;
  const store = new ProjectTeamStore(join(dir, "teams"));
  const service = new ProjectTeams({ manager, projects, automations, build, store }); services.push(service); await service.load(); service.start();
  const draft = await service.create({ operationId: "create", name: "Product team", projectId: project.id, repo, mission: mission(extra) });
  const team = await service.update(draft.id, { operationId: "activate", revision: draft.revision, status: "active" });
  return { dir, repo, git, projects, project, manager, store, service, team };
}
async function settled(f: Awaited<ReturnType<typeof fixture>>) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await f.service.reconcile();
    const t = f.store.get(f.team.id), c = t.cycles.at(-1);
    if (c && ["completed", "no-op", "blocked", "failed", "cancelled"].includes(c.status)) return t;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(JSON.stringify(f.store.get(f.team.id).cycles.at(-1)));
}
const task = (operationId: string, revision: number) => ({ operationId, revision, title: "Clarify the input contract", instructions: "Document that empty input is valid.", acceptance: ["The input contract is clear and existing checks pass"], category: "docs" });
const synthetic = (opportunities: string[], extra: Partial<Team> = {}) => ({ status: "active", cycles: [], opportunities: opportunities.map((status) => ({ status })), mission: { budget: defaultProjectTeamBudget(), verification: { checks: [{ required: true }] } }, ...extra }) as unknown as Team;

test("every budget input range is the range the mission validator enforces", () => {
  assert.deepEqual(validateMission(mission()).budget, defaultProjectTeamBudget());
  for (const [field, range] of Object.entries(PROJECT_TEAM_BUDGET_RANGES)) {
    for (const value of [range.min, range.max]) assert.equal(validateMission(mission({ budget: { [field]: value } })).budget[field as keyof ReturnType<typeof defaultProjectTeamBudget>], value);
    for (const value of [range.min - 1, range.max + 1]) assert.throws(() => validateMission(mission({ budget: { [field]: value } })), new RegExp(`Invalid ${range.label}: use ${range.min}–${range.max}`));
  }
});

test("the inbox card counts blocked work and uses singular wording", () => {
  assert.equal(projectTeamInboxSummary(synthetic(["blocked"])), "1 needs attention");
  assert.equal(projectTeamNeedsOwner(synthetic(["blocked"])), true);
  assert.equal(projectTeamInboxSummary(synthetic(["ready", "blocked", "blocked"])), "1 verified draft · 2 need attention");
  assert.equal(projectTeamInboxSummary(synthetic(["proposed", "proposed", "rejected"])), "2 proposals");
  assert.equal(projectTeamInboxSummary(synthetic([], { cycles: [{ status: "unknown" }] } as Partial<Team>)), "Launch needs reconciliation");
  assert.equal(projectTeamInboxSummary(synthetic(["ready"], { cycles: [{ status: "unknown" }] } as Partial<Team>)), "1 verified draft · launch needs reconciliation");
  assert.equal(projectTeamNeedsOwner(synthetic(["rejected", "shipped"])), false);
  assert.equal(projectTeamNeedsOwner(synthetic(["blocked"], { status: "archived" })), false);
});

test("task admission explains each refusal in the order the server checks it", () => {
  assert.match(taskAdmissionProblem(synthetic([], { status: "draft" }))!, /Activate this mission/);
  assert.match(taskAdmissionProblem(synthetic([], { cycles: [{ status: "building" }] } as Partial<Team>))!, /active cycle/);
  assert.match(taskAdmissionProblem(synthetic(["ready", "accepted"]))!, /Review pending work/);
  assert.match(taskAdmissionProblem(synthetic(Array(12).fill("proposed")))!, /Review pending work/);
  assert.equal(taskAdmissionProblem({ ...synthetic([]), mission: { ...synthetic([]).mission, verification: undefined } } as Team), "Configure a required verification check");
  assert.equal(taskAdmissionProblem(synthetic(["blocked", "rejected"])), undefined);
});

test("assignTask refuses with exactly the reason the card shows: no check, and two pending results", async () => {
  const proposals = await fixture({ mode: "propose", check: "" });
  const expected = taskAdmissionProblem(proposals.team)!;
  await assert.rejects(proposals.service.assignTask(proposals.team.id, task("no-check", proposals.team.revision)), (error: Error) => error.message === expected);
  const f = await fixture();
  for (const id of ["first", "second"]) { await f.service.assignTask(f.team.id, task(id, f.store.get(f.team.id).revision)); await settled(f); }
  const t = f.store.get(f.team.id); assert.deepEqual(t.opportunities.map((o) => o.status), ["ready", "ready"], t.cycles.map((c) => c.reason).join("; "));
  const reason = taskAdmissionProblem(t)!; assert.match(reason, /Review pending work/);
  await assert.rejects(f.service.assignTask(t.id, task("third", t.revision)), (error: Error) => error.message === reason);
  assert.equal(f.store.get(t.id).cycles.length, 2, "a refused task spends nothing");
});

test("a blocked owner task rebuilds on the moved base; discovered work explains why it cannot be built", async () => {
  const f = await fixture();
  let t = await f.service.assignTask(f.team.id, task("stopped-task", f.team.revision));
  const deadline = Date.now() + 20000;
  while (f.store.get(t.id).cycles[0]!.launches[0]?.state !== "running" && Date.now() < deadline) { await f.service.reconcile(); await new Promise((r) => setTimeout(r, 50)); }
  await f.service.reconcile(); t = f.store.get(t.id);
  t = await f.service.stopCycle(t.id, { operationId: "stop-task", revision: t.revision });
  let o = t.opportunities[0]!; assert.equal(o.status, "blocked");
  writeFileSync(join(f.repo, "later.md"), "Later work\n"); f.git("add", "."); f.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "later");
  const head = f.git("rev-parse", "main"); assert.notEqual(o.baseCommit, head);
  assert.equal(buildRefusal(t, o), undefined, "the card offers the rebuild");
  t = await f.service.decide(t.id, o.id, { operationId: "rebuild-task", revision: t.revision, opportunityRevision: o.revision, action: "build" });
  o = t.opportunities[0]!; assert.equal(o.baseCommit, head); assert.equal(t.cycles.at(-1)!.baseCommit, head);
  assert.ok(["building", "selecting"].includes(t.cycles.at(-1)!.status), t.cycles.at(-1)!.reason);
  await settled(f);

  const risky = await fixture({ mission: "PT-HIGH-RISK Improve documentation" }); await risky.service.cycle(risky.team.id, "inspect");
  t = await settled(risky); o = t.opportunities[0]!; assert.equal(o.status, "proposed"); assert.equal(o.risk, "high");
  const refusal = buildRefusal(t, o)!; assert.match(refusal, /owner decision about risk.*give the team a task instead/);
  await assert.rejects(risky.service.decide(t.id, o.id, { operationId: "build-risky", revision: t.revision, opportunityRevision: o.revision, action: "build" }), (error: Error) => error.message === refusal);

  const proposed = await fixture({ mode: "propose" }); await proposed.service.cycle(proposed.team.id, "inspect");
  t = await settled(proposed); o = t.opportunities[0]!; assert.equal(o.status, "proposed"); assert.equal(buildRefusal(t, o), undefined);
  writeFileSync(join(proposed.repo, "later.md"), "Later work\n"); proposed.git("add", "."); proposed.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "later");
  await assert.rejects(proposed.service.decide(t.id, o.id, { operationId: "build-stale", revision: t.revision, opportunityRevision: o.revision, action: "build" }), /base branch moved after this was discovered/);
});

test("an archived mission says it is read-only instead of asking to activate it", async () => {
  const f = await fixture({ mode: "propose" });
  const t = await f.service.update(f.team.id, { operationId: "archive", revision: f.team.revision, status: "archived" });
  await assert.rejects(f.service.cycle(t.id, "after-archive"), (error: Error) => /archived and read-only/.test(error.message) && !/Activate this team/.test(error.message));
  const preview = await f.service.preview(t.id);
  assert.ok(preview.warnings.some((w) => /archived and read-only/.test(w))); assert.ok(!preview.warnings.includes("Activate this team before starting a cycle"));
});

test("repository owners include other projects and linked worktrees", async () => {
  const f = await fixture(), linked = join(f.dir, "linked");
  f.git("worktree", "add", "--detach", linked, "main");
  const other = await f.projects.create({ name: "Other", repos: [f.repo, realpathSync(linked)] });
  const owners = await f.service.repositoryOwners(other.id);
  assert.deepEqual(owners[f.repo], { name: "Product team", projectId: f.project.id });
  assert.deepEqual(owners[realpathSync(linked)], { name: "Product team", projectId: f.project.id });
});

test("held history blocks only its own repository; an unreadable record blocks every creation and names its file", async () => {
  const f = await fixture(); await f.service.stop();
  const file = join(f.store.directory, `${f.team.id}.json`), saved = JSON.parse(readFileSync(file, "utf8")) as Team;
  writeFileSync(file, JSON.stringify({ ...saved, repositoryId: "0".repeat(64) }));
  const held = new ProjectTeamStore(f.store.directory); await held.load();
  assert.deepEqual(held.faultDetails()[f.team.id], { kind: "ownership", file, name: "Product team", repo: f.repo, projectId: f.project.id });
  assert.equal(held.creationProblem(), undefined);
  const other = repository(), next = (id: string, repo: string): Team => ({ ...structuredClone(saved), id, repo, repositoryId: undefined, revision: 1, operations: [{ id, hash: "a".repeat(64), at: 1 }] });
  const created = await held.create(next(`pt-${"1".repeat(24)}`, other.repo));
  assert.equal(created.repositoryId, await repositoryIdentity(other.repo), "an unrelated repository gets its mission");
  await assert.rejects(held.create(next(`pt-${"2".repeat(24)}`, f.repo)), /needs repair before another can be created/);
  writeFileSync(join(f.store.directory, `pt-${"3".repeat(24)}.json`), "{broken");
  writeFileSync(join(f.store.directory, "settings.json"), "{\"version\":1,\"enab");
  const damaged = new ProjectTeamStore(f.store.directory); await damaged.load();
  assert.deepEqual(damaged.faultDetails()[`pt-${"3".repeat(24)}`], { kind: "record", file: join(f.store.directory, `pt-${"3".repeat(24)}.json`) });
  assert.deepEqual(damaged.faultDetails().settings, { kind: "settings", file: join(f.store.directory, "settings.json") });
  assert.equal(damaged.configuration(true).source, "unavailable");
  assert.match(damaged.creationProblem()!, /Repair damaged team records/);
  await assert.rejects(damaged.create(next(`pt-${"4".repeat(24)}`, repository().repo)), /Repair damaged team records/);
});

test("repository ownership rejects a different volume even if the path and inode match", async () => {
  const f = await fixture(); await f.service.stop();
  const common = realpathSync(join(f.repo, ".git")), info = lstatSync(common, { bigint: true });
  const differentVolume = createHash("sha256").update(JSON.stringify({ common, device: String(info.dev + 3n), inode: String(info.ino) })).digest("hex");
  const file = join(f.store.directory, `${f.team.id}.json`), saved = JSON.parse(readFileSync(file, "utf8")) as Team;
  writeFileSync(file, JSON.stringify({ ...saved, repositoryId: differentVolume }));
  const loaded = new ProjectTeamStore(f.store.directory); await loaded.load();
  assert.match(loaded.faults.get(f.team.id)!, /Repository metadata was replaced/);
  assert.equal(loaded.list().length, 0);
  assert.equal(loaded.deletionHistory(f.team.id).repositoryId, differentVolume);
});
