import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const home = mkdtempSync(join(tmpdir(), "codeflow-standing-"));
process.env.CODEFLOW_HOME = home;
process.env.CODEFLOW_PROJECT_TEAMS_ENABLED = "true";
process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { Projects } = await import("../src/projects.js");
const { Automations } = await import("../src/automation.js");
const { ProjectTeams } = await import("../src/project-teams.js");
const { ProjectTeamStore } = await import("../src/project-team-store.js");
const { validateMission, validateReport, allowance, digest, disableRestoredProjectTeam } = await import("../src/project-team-model.js");
const { assertProjectTeamChanges } = await import("../src/project-team-policy.js");
const { flushWrites } = await import("../src/store.js");
const { AgentTeamDefinitions } = await import("../src/agent-team-definitions.js");
type Team = import("../src/project-team-model.js").ProjectTeam;
const persisted = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const services: InstanceType<typeof ProjectTeams>[] = [], repos: string[] = [];
const managers: InstanceType<typeof RunManager>[] = [];
after(async () => { await Promise.all(services.map((s) => s.stop())); await Promise.all(managers.map((m) => m.shutdown())); await flushWrites(); for (const repo of repos) rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
const mission = (extra = {}) => ({ mission: "Improve the documented input contract", users: "Developers", baseBranch: "main", mode: "build-within-scope", check: "node --test", coordinator: "claude", pool: ["claude", "codex"], schedule: { at: "09:00", days: [1], timezone: "Europe/Stockholm" }, ...extra });
let counter = 0;
async function fixture(extra = {}, overrides: Partial<import("../src/project-teams.js").ProjectTeamsOptions> = {}) {
  const dir = join(home, `case-${++counter}`); mkdirSync(dir);
  const repo = mkdtempSync(join(tmpdir(), "codeflow-standing-repo-")); repos.push(repo);
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
  return { dir, repo, git, projects, project, manager, automations, store, service, team };
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

test("mission validation rejects ACP, unvalidated plugins, unsafe paths and unverified automatic builds", () => {
  assert.throws(() => validateMission(mission({ coordinator: "acp:one" })), /ACP/);
  assert.throws(() => validateMission(mission({ pool: ["plugin:test"] })), /validated/);
  assert.throws(() => validateMission(mission({ paths: ["../outside"] })), /paths/);
  assert.throws(() => validateMission(mission({ check: "" })), /verification/);
  assert.throws(() => validateMission(mission({ baseBranch: "HEAD" })), /branch/);
  assert.throws(() => validateMission(mission({ schedule: { at: "09:00" } })), /zone/);
  assert.throws(() => validateReport({ version: 1, summary: "Empty", candidates: [], injected: true }), /fields/);
});

test("complete cycle uses existing Auto teams, preserves read-only discovery, verifies and approves exact HEAD", async () => {
  const f = await fixture(); const base = f.git("rev-parse", "main");
  const admitted = await f.service.cycle(f.team.id, "first");
  assert.equal(admitted.cycles[0]!.launches.length, 1);
  const t = await settled(f); assert.equal(t.cycles[0]!.status, "completed", JSON.stringify({ cycle: t.cycles[0], runs: f.manager.list().map((r) => ({ error: r.error, status: r.status, team: r.team })) }));
  assert.equal(t.cycles[0]!.launches.length, 2); assert.equal(t.opportunities.length, 1);
  const o = t.opportunities[0]!; assert.equal(o.status, "ready", o.reason);
  const discovery = f.manager.get(t.cycles[0]!.launches[0]!.runId!)!;
  assert.equal(discovery.projectDiscovery?.approved, true); assert.equal(discovery.projectDiscovery?.head, base);
  assert.ok(discovery.steps.filter((s) => s.kind === "agent").every((s) => s.mode === "read"));
  assert.equal(f.git("rev-parse", "main"), base, "A cycle must not merge itself");
  const child = f.manager.get(o.result!.runId)!;
  await assert.rejects(f.manager.deleteRun(discovery.id), /Standing project teams retain run history/);
  await assert.rejects(f.manager.deleteRun(child.id), /Standing project teams retain run history/);
  await f.manager.archive(child.id, { cleanup: false });
  assert.equal(f.manager.get(child.id)?.archived, true);
  await assert.rejects(f.manager.deleteRun(child.id), /Archive this run instead/);
  assert.equal(f.store.get(f.team.id).opportunities[0]?.status, "ready", "archiving preserves the result awaiting approval");
  await assert.rejects(f.manager.resume(child.id), /project team/);
  await assert.rejects(f.manager.merge(child.id, { branch: o.result!.branch, into: "main" }), /Approve/);
  const accepted = await f.service.decide(t.id, o.id, { operationId: "approve", revision: t.revision, opportunityRevision: o.revision, action: "approve" });
  assert.equal(accepted.opportunities[0]!.status, "accepted"); assert.equal(f.git("rev-parse", "main"), base);
  const replay = await f.service.cycle(t.id, "first"); assert.equal(replay.cycles.length, 1);
  const merged = await f.manager.merge(child.id, { branch: o.result!.branch, into: "main" }); assert.equal(merged.ok, true);
  await f.service.reconcile(); assert.equal(f.store.get(t.id).opportunities[0]!.status, "shipped");
});

test("empty discovery is a durable no-op and unchanged inputs do not spend another budget", async () => {
  const f = await fixture({ mission: "PT-EMPTY inspect the repository" }); await f.service.cycle(f.team.id, "empty");
  const t = await settled(f); assert.equal(t.cycles[0]!.status, "no-op", t.cycles[0]!.reason); assert.equal(t.opportunities.length, 0);
  const next = await f.service.cycle(t.id, "unchanged"); assert.equal(next.cycles.at(-1)!.status, "no-op"); assert.equal(next.cycles.at(-1)!.launches.length, 0);
});

test("invented evidence and high risk reports remain proposals without implementation", async () => {
  for (const marker of ["PT-INVENTED", "PT-HIGH-RISK"]) {
    const f = await fixture({ mission: `${marker} Improve documentation` }); await f.service.cycle(f.team.id, "inspect"); const t = await settled(f);
    assert.equal(t.cycles[0]!.status, "completed", t.cycles[0]!.reason); assert.equal(t.cycles[0]!.launches.length, 1);
    assert.equal(t.opportunities[0]!.status, "proposed"); assert.ok(t.cycles[0]!.selection!.reasons[0]!.reason !== "Eligible within the mission and scope");
  }
});

test("claim-before-dispatch fails closed, restart does not replay unknown launches or refund their budget", async () => {
  const f = await fixture({}, { persist: async () => { throw new Error("simulated disk failure before dispatch"); } });
  const t = await f.service.cycle(f.team.id, "crash"); assert.equal(t.cycles[0]!.status, "unknown");
  assert.equal(f.manager.get(f.manager.list()[0]!.id)!.steps.length, 0); assert.equal(allowance(t).calls, 40);
  await f.service.stop();
  const manager = new RunManager(findPattern, f.projects);
  const recovered = new ProjectTeams({ manager, projects: f.projects, automations: f.automations, store: new ProjectTeamStore(f.store.directory), build: async () => { throw new Error("No replay permitted"); } }); services.push(recovered); await recovered.load(); recovered.start(); await recovered.reconcile();
  const after = recovered.store.get(t.id); assert.equal(after.cycles[0]!.status, "unknown"); assert.equal(allowance(after).calls, 40); assert.equal(manager.list().length, 0);
});

test("operation IDs, revisions, one repository ownership and weekly reservations are enforced", async () => {
  const f = await fixture({ budget: { weeklyCalls: 4 } });
  const blocked = await f.service.cycle(f.team.id, "budget"); assert.equal(blocked.cycles[0]!.status, "blocked"); assert.equal(blocked.cycles[0]!.launches.length, 0);
  await assert.rejects(f.service.update(f.team.id, { operationId: "stale", revision: 1, status: "paused" }), /Reload/);
  await assert.rejects(f.service.create({ operationId: "different", projectId: f.project.id, repo: f.repo, name: "Duplicate", mission: mission() }), /already has/);
  await assert.rejects(f.service.update(f.team.id, { operationId: "activate", revision: blocked.revision, status: "paused" }), /reused/);
  assert.equal((await f.automations.dryRun(`t-${f.team.id}`)).ready, false);
  await assert.rejects(f.automations.update(`t-${f.team.id}`, { enabled: false }), /standing project team/);
});

test("scope catches committed renames, binary/untracked changes and line growth", async () => {
  const f = await fixture(); const baseRef = f.git("rev-parse", "HEAD");
  const run = { baseRef, loop: {}, projectTeam: { phase: "implementation", scope: { paths: ["README.md"], excludedPaths: [], maxFiles: 1, maxLines: 2 }, verificationHash: digest(null) } as unknown as import("../src/project-team-model.js").ProjectTeamRun };
  writeFileSync(join(f.repo, "outside.txt"), "x"); await assert.rejects(assertProjectTeamChanges(f.repo, run), /outside/); rmSync(join(f.repo, "outside.txt"));
  writeFileSync(join(f.repo, "README.md"), "a\nb\nc\nd\n"); await assert.rejects(assertProjectTeamChanges(f.repo, run), /line limit/);
  f.git("checkout", "--", "README.md"); f.git("mv", "README.md", "other.md"); f.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "rename");
  await assert.rejects(assertProjectTeamChanges(f.repo, run), /outside/);
});

test("store rejects corrupt records without overwriting and restored teams remain paused", async () => {
  const f = await fixture(); const restored = disableRestoredProjectTeam(f.team); assert.equal(restored.status, "paused"); assert.match(restored.error!, /Restored/);
  const file = join(f.store.directory, `${f.team.id}.json`); writeFileSync(file, '{broken');
  const damaged = new ProjectTeamStore(f.store.directory); await damaged.load(); assert.equal(damaged.faults.size, 1); assert.throws(() => damaged.get(f.team.id), /unavailable/); assert.equal(readFileSync(file, "utf8"), '{broken');
});

test("scheduled occurrence is stable across repeated fires and ordinary triggers remain ordinary", async () => {
  const f = await fixture({ mission: "PT-EMPTY inspect" }); const trigger = f.automations.get(`t-${f.team.id}`)!;
  const first = await f.automations.fire(trigger.id, { via: "schedule", occurrence: "schedule:12345" }); assert.ok(first.run);
  await settled(f); await f.automations.fire(trigger.id, { via: "schedule", occurrence: "schedule:12345" });
  assert.equal(f.store.get(f.team.id).cycles.length, 1);
  assert.equal(f.store.get(f.team.id).cycles[0]!.operationId, "schedule:12345");
});

test("stale verified HEAD invalidates approval and owner revision uses a new bounded whole team", async () => {
  const f = await fixture(); await f.service.cycle(f.team.id, "first"); let t = await settled(f); let o = t.opportunities[0]!;
  const originalRun = o.result!.runId;
  const note = "Add a clearer example for the documented case. ".repeat(30), acceptance = [...o.acceptance];
  t = await f.service.decide(t.id, o.id, { operationId: "revise", revision: t.revision, opportunityRevision: o.revision, action: "revise", note });
  t = await settled(f); o = t.opportunities[0]!; assert.equal(o.status, "ready", t.cycles.at(-1)!.reason); assert.notEqual(o.result!.runId, originalRun);
  assert.equal(JSON.parse(t.cycles.at(-1)!.context).ownerRevision, note.trim());
  assert.deepEqual(o.acceptance, acceptance, "Revision feedback must preserve every original acceptance criterion");
  const changed = f.manager.get(o.result!.runId)!; const worktree = changed.worktrees.find((w) => w.branch === o.result!.branch)!;
  writeFileSync(join(worktree.path, "later.txt"), "changed after review\n"); execFileSync("git", ["add", "."], { cwd: worktree.path }); execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "unreviewed"], { cwd: worktree.path });
  await assert.rejects(f.service.decide(t.id, o.id, { operationId: "approve-stale", revision: t.revision, opportunityRevision: o.revision, action: "approve" }), /changed/);
  await f.service.reconcile(); assert.equal(f.store.get(t.id).opportunities[0]!.status, "blocked");
});

test("discovery uses the newest twenty eligible local runs", async () => {
  const f = await fixture({ budget: { weeklyCalls: 4 } });
  const runs = Array.from({ length: 25 }, (_, index) => ({ id: `recent-${index}`, repo: f.team.repo, project: f.project.id, status: "done", task: `Local task ${index}` }));
  f.manager.list = () => runs as import("../src/engine.js").RunSummary[];
  const t = await f.service.cycle(f.team.id, "context");
  assert.deepEqual(JSON.parse(t.cycles[0]!.context).recentRuns.map((r: { id: string }) => r.id), runs.slice(0, 20).map((r) => r.id));
});

test("archived teams retain immutable history after decisions and project removal", async () => {
  const f = await fixture({ mode: "propose" }); await f.service.cycle(f.team.id, "first");
  let t = await settled(f); const o = t.opportunities[0]!;
  t = await f.service.update(t.id, { operationId: "archive", revision: t.revision, status: "archived" });
  await assert.rejects(f.service.decide(t.id, o.id, { operationId: "reject-archived", revision: t.revision, opportunityRevision: o.revision, action: "reject" }), /Archived/);
  await assert.rejects(f.service.stopCycle(t.id, { operationId: "stop-archived", revision: t.revision }), /Archived/);
  await f.projects.remove(f.project.id); await f.service.reconcile();
  assert.deepEqual(f.store.get(t.id), t);
  assert.equal(f.automations.get(`t-${t.id}`)!.enabled, false);
});

test("failed checks cannot become ready and repeat scheduled failures require changed input", async () => {
  const f = await fixture({ check: "node -e 'process.exit(1)'" }); await f.service.cycle(f.team.id, "first"); const t = await settled(f);
  assert.equal(t.opportunities[0]!.status, "blocked"); assert.equal(t.cycles[0]!.status, "blocked");
  const retry = await f.service.cycle(t.id, "schedule:next"); assert.equal(retry.cycles.at(-1)!.status, "skipped"); assert.equal(retry.cycles.at(-1)!.launches.length, 0);
});

test("pause prevents the implementation stage and removed project membership cancels ownership", async () => {
  const f = await fixture(); const launched = await f.service.cycle(f.team.id, "first");
  await f.service.update(f.team.id, { operationId: "pause", revision: launched.revision, status: "paused" });
  const t = await settled(f); assert.equal(t.cycles[0]!.launches.length, 1); assert.equal(t.opportunities[0]!.status, "proposed");
  await f.projects.remove(f.project.id); await f.service.reconcile(); assert.match(f.store.get(t.id).error!, /project/);
  await assert.rejects(f.service.cycle(t.id, "after-removal"), /project/);
});

test("deferred and rejected work retain feedback; deferred expiry permits rediscovery", async () => {
  const f = await fixture({ mode: "propose" }); await f.service.cycle(f.team.id, "first"); let t = await settled(f), o = t.opportunities[0]!;
  t = await f.service.decide(t.id, o.id, { operationId: "later", revision: t.revision, opportunityRevision: o.revision, action: "defer", note: "Wait for the next documentation release", deferUntil: Date.now() + 10000 });
  await f.service.cycle(t.id, "deferred"); t = await settled(f); assert.equal(t.opportunities.length, 1); assert.equal(t.opportunities[0]!.status, "deferred");
  await f.store.change(t.id, undefined, undefined, (t) => { t.opportunities[0]!.deferUntil = Date.now() - 1; });
  await f.service.cycle(t.id, "expired"); t = await settled(f); assert.equal(t.opportunities.length, 2); assert.equal(t.opportunities[0]!.status, "expired"); o = t.opportunities[1]!;
  t = await f.service.decide(t.id, o.id, { operationId: "reject", revision: t.revision, opportunityRevision: o.revision, action: "reject", note: "Not useful to our users" });
  await f.service.cycle(t.id, "after-rejection"); t = await settled(f); assert.equal(t.opportunities.length, 2); assert.match(t.cycles.at(-1)!.context, /Not useful to our users/);
});

test("corrupted usage and duplicate repository ownership fail closed on load", async () => {
  const f = await fixture({ mission: "PT-EMPTY inspect" }); await f.service.cycle(f.team.id, "first"); const t = await settled(f);
  const corrupt = structuredClone(t); corrupt.cycles[0]!.launches[0]!.usedCalls = -100;
  writeFileSync(join(f.store.directory, `${t.id}.json`), JSON.stringify(corrupt));
  const check = new ProjectTeamStore(f.store.directory); await check.load(); assert.match(check.faults.get(t.id)!, /reservation|usage/);
  writeFileSync(join(f.store.directory, `${t.id}.json`), JSON.stringify(t)); const duplicate = { ...t, id: `pt-${"a".repeat(24)}` };
  writeFileSync(join(f.store.directory, `${duplicate.id}.json`), JSON.stringify(duplicate)); await check.load(); assert.equal(check.faults.size, 2); assert.equal(check.list().length, 0);
});

test("restart imports an exact persisted completed child without relaunching", async () => {
  const f = await fixture({ mission: "PT-EMPTY inspect" }); const t = await f.service.cycle(f.team.id, "first"); const launch = t.cycles[0]!.launches[0]!;
  const run = f.manager.get(launch.runId!)!;
  while (!run.endedAt) await new Promise((r) => setTimeout(r, 50));
  await f.service.stop(); await flushWrites();
  // Crash after the child completed but before its result was projected into the aggregate.
  await f.store.change(t.id, undefined, undefined, (team) => { const c = team.cycles[0]!; c.status = "discovering"; c.endedAt = undefined; c.report = undefined; c.selection = undefined; c.launches[0]!.state = "running"; c.launches[0]!.usedCalls = undefined; });
  const nextManager = new RunManager(findPattern, f.projects); managers.push(nextManager); await nextManager.load();
  const next = new ProjectTeams({ manager: nextManager, projects: f.projects, automations: f.automations, store: new ProjectTeamStore(f.store.directory), build: async () => { throw new Error("Completed claim must not be replayed"); } }); services.push(next); await next.load(); next.start(); await next.reconcile();
  const recovered = next.store.get(t.id); assert.equal(recovered.cycles.length, 1); assert.equal(recovered.cycles[0]!.status, "no-op"); assert.equal(recovered.cycles[0]!.launches.length, 1);
});

test("publishing a managed result pushes the approved SHA without squash-base rewriting", async () => {
  const f = await fixture(); await f.service.cycle(f.team.id, "first"); let t = await settled(f); const o = t.opportunities[0]!;
  const remote = join(f.dir, "origin.git"); execFileSync("git", ["init", "--bare", "-q", "-b", "main", remote]); f.git("remote", "add", "origin", remote); f.git("push", "-q", "origin", "main");
  const state = join(f.dir, "github.json"); writeFileSync(state, JSON.stringify({ issues: {}, prs: {} })); process.env.FAKE_GH_STATE = state;
  try {
    t = await f.service.decide(t.id, o.id, { operationId: "approve", revision: t.revision, opportunityRevision: o.revision, action: "approve" });
    const url = await f.manager.pullRequest(o.result!.runId, { branch: o.result!.branch, into: "main" }); assert.match(url, /pull/);
    const published = execFileSync("git", ["--git-dir", remote, "rev-parse", `refs/heads/${o.result!.branch}`], { encoding: "utf8" }).trim(); assert.equal(published, o.result!.head);
    const stateAfter = JSON.parse(readFileSync(state, "utf8")); assert.doesNotMatch(Object.values(stateAfter.prs).map((p: any) => p.body).join("\n"), /project_evidence|Historical evidence/);
    await f.service.reconcile(); assert.equal(f.store.get(t.id).opportunities[0]!.status, "accepted", "A PR is not shipped");
    t = await f.service.update(t.id, { operationId: "archive-published", revision: f.store.get(t.id).revision, status: "archived" });
    await assert.rejects(f.manager.pullRequest(o.result!.runId, { branch: o.result!.branch, into: "main" }), /Archived/);
    await f.service.reconcile(); assert.deepEqual(f.store.get(t.id), t);
  } finally { delete process.env.FAKE_GH_STATE; }
});

test("managed PR merges require a current approval after publication", async (t) => {
  for (const change of ["reject", "mission", "archive", "none"] as const) await t.test(change, async () => {
    const f = await fixture(); await f.service.cycle(f.team.id, "first"); let team = await settled(f); const o = team.opportunities[0]!;
    const remote = join(f.dir, "origin.git"); execFileSync("git", ["init", "--bare", "-q", "-b", "main", remote]); f.git("remote", "add", "origin", remote); f.git("push", "-q", "origin", "main");
    const state = join(f.dir, "github.json"); writeFileSync(state, JSON.stringify({ issues: {}, prs: {} })); process.env.FAKE_GH_STATE = state;
    try {
      team = await f.service.decide(team.id, o.id, { operationId: "approve", revision: team.revision, opportunityRevision: o.revision, action: "approve" });
      const url = await f.manager.pullRequest(o.result!.runId, { branch: o.result!.branch, into: "main" });
      const number = url.split("/").pop()!;
      if (change === "reject") team = await f.service.decide(team.id, o.id, { operationId: "reject", revision: team.revision, opportunityRevision: team.opportunities[0]!.revision, action: "reject", note: "Do not ship this" });
      if (change === "mission") team = await f.service.update(team.id, { operationId: "change-mission", revision: team.revision, mission: mission({ mission: "Prioritize another problem" }) });
      if (change === "archive") team = await f.service.update(team.id, { operationId: "archive", revision: team.revision, status: "archived" });
      const input = { branch: o.result!.branch, method: "squash" as const };
      if (change === "none") {
        assert.equal((await f.manager.mergePr(o.result!.runId, input)).merged, true);
        assert.equal(JSON.parse(readFileSync(state, "utf8")).prs[number].state, "MERGED");
        await f.service.reconcile(); assert.equal(f.store.get(team.id).opportunities[0]!.status, "shipped");
      } else {
        await assert.rejects(f.manager.mergePr(o.result!.runId, input), change === "archive" ? /Archived/ : /Approve this exact result/);
        assert.equal(JSON.parse(readFileSync(state, "utf8")).prs[number].state, "OPEN", "revoked approval must leave the remote PR open");
        assert.equal(f.manager.get(o.result!.runId)!.merges.length, 0);
      }
    } finally { delete process.env.FAKE_GH_STATE; }
  });
});

test("a terminal child without durable usage evidence retains its full reservation", async () => {
  const f = await fixture({}, { persistUsage: async () => undefined }); const t = await f.service.cycle(f.team.id, "cancelled-child"), launch = t.cycles[0]!.launches[0]!;
  f.manager.cancel(launch.runId!); const result = await settled(f);
  assert.equal(result.cycles[0]!.status, "blocked"); assert.equal(result.cycles[0]!.launches[0]!.usedCalls, launch.calls);
  assert.equal(allowance(result).calls, result.mission.budget.weeklyCalls - launch.calls);
});

test("stopping implementation retains its claim until exact terminal usage can settle", async () => {
  const f = await fixture(); await f.service.cycle(f.team.id, "first");
  const deadline = Date.now() + 20000;
  while (f.store.get(f.team.id).cycles[0]!.launches[1]?.state !== "running" && Date.now() < deadline) { await f.service.reconcile(); await new Promise((r) => setTimeout(r, 50)); }
  // Admission writes the claim before its run receipt. Finish that queued write before using its revision.
  await f.service.reconcile();
  let t = f.store.get(f.team.id); assert.equal(t.cycles[0]!.status, "building");
  t = await f.service.stopCycle(t.id, { operationId: "stop", revision: t.revision });
  assert.equal(t.cycles[0]!.status, "cancelled"); assert.equal(t.opportunities[0]!.status, "blocked");
  const o = t.opportunities[0]!;
  t = await f.service.decide(t.id, o.id, { operationId: "reject-stopped", revision: t.revision, opportunityRevision: o.revision, action: "reject", note: "Stop pursuing this" });
  assert.equal(t.opportunities[0]!.status, "rejected"); assert.ok(["running", "settled"].includes(t.cycles[0]!.launches[1]!.state));
  const run = f.manager.get(t.cycles[0]!.launches[1]!.runId!)!; while (!run.endedAt) await new Promise((r) => setTimeout(r, 50));
  await f.service.reconcile();
  const after = f.store.get(t.id);
  assert.equal(after.cycles[0]!.status, "cancelled");
  assert.equal(after.opportunities[0]!.status, "rejected");
  assert.ok(after.cycles[0]!.launches[1]!.usage, "cancelled cycles also receive a durable usage receipt");
});


test("Standing teams settings persist, reject stale writes and gate dispatch without changing team activation", async () => {
  const f = await fixture({ mode: "propose" });
  assert.equal(f.service.configuration().source, "default");
  await f.service.setEnabled({ enabled: false, revision: 0 });
  assert.equal(f.service.enabled(), false);
  assert.equal(f.store.get(f.team.id).status, "active", "the host switch preserves individual team activation");
  await assert.rejects(f.service.cycle(f.team.id, "disabled-cycle"), /Enable Standing teams/);
  await assert.rejects(f.service.setEnabled({ enabled: true, revision: 0 }), /settings changed/);
  const restored = new ProjectTeamStore(f.store.directory); await restored.load();
  assert.deepEqual(restored.configuration(true), { enabled: false, revision: 1, source: "saved" }, "saved choice overrides the environment default");
  await f.service.setEnabled({ enabled: true, revision: 1 });
  assert.equal(f.service.enabled(), true);
  await f.service.cycle(f.team.id, "active-cycle");
  await assert.rejects(f.service.setEnabled({ enabled: false, revision: 2 }), /Stop active or unresolved/);
  const current = f.store.get(f.team.id);
  await f.service.stopCycle(f.team.id, { operationId: "stop-before-disable", revision: current.revision });
  await f.service.setEnabled({ enabled: false, revision: 2 });
  assert.equal(f.service.enabled(), false);
  writeFileSync(join(f.store.directory, "settings.json"), '{"enabled":"corrupt"}');
  const broken = new ProjectTeamStore(f.store.directory); await broken.load();
  assert.equal(broken.configuration(true).enabled, false);
  assert.equal(broken.configuration(true).source, "unavailable");
  await assert.rejects(broken.setEnabled(true, 0), /Repair/);
});

test("schedule-only edits preserve ready and accepted commits, immutable mission history and budgets", async () => {
  const f = await fixture(); await f.service.cycle(f.team.id, "ready-for-schedule-edit");
  let t = await settled(f); assert.equal(t.opportunities[0]!.status, "ready");
  const baseline = structuredClone(t), budget = allowance(t);
  const schedule = { at: "11:30", days: [2], timezone: "Europe/Stockholm" };
  t = await f.service.update(t.id, { operationId: "schedule-only", revision: t.revision, schedule });
  assert.equal(t.missionRevision, baseline.missionRevision); assert.deepEqual(t.missions, baseline.missions);
  assert.deepEqual(t.cycles, baseline.cycles); assert.deepEqual(t.opportunities, baseline.opportunities); assert.deepEqual(allowance(t), budget);
  assert.deepEqual(f.automations.get(t.triggerId!)!.schedule, schedule);
  const o = t.opportunities[0]!;
  t = await f.service.decide(t.id, o.id, { operationId: "approve-before-reschedule", revision: t.revision, opportunityRevision: o.revision, action: "approve" });
  const accepted = structuredClone(t);
  // Older clients still submit their full mission when only the schedule changes.
  t = await f.service.update(t.id, { operationId: "legacy-schedule-editor", revision: t.revision, mission: { ...t.mission, schedule: { ...schedule, at: "12:00" } } });
  assert.equal(t.opportunities[0]!.status, "accepted"); assert.deepEqual(t.opportunities, accepted.opportunities);
  assert.deepEqual(t.missions, accepted.missions); assert.deepEqual(t.cycles, accepted.cycles); assert.deepEqual(allowance(t), budget);
  const loaded = new ProjectTeamStore(f.store.directory); await loaded.load();
  assert.deepEqual(loaded.get(t.id), persisted(t), "a schedule edit survives restart without rewriting policy or receipts");
});

test("rescheduling an active discovery leaves its allocation and implementation authority intact", async () => {
  const f = await fixture(); let t = await f.service.cycle(f.team.id, "active-reschedule");
  const claim = structuredClone(t.cycles[0]!), budget = allowance(t);
  t = await f.service.update(t.id, { operationId: "reschedule-in-flight", revision: t.revision, schedule: { at: "18:00", timezone: "Europe/Stockholm" } });
  assert.deepEqual(t.cycles[0], claim); assert.deepEqual(allowance(t), budget);
  t = await settled(f); assert.equal(t.cycles[0]!.status, "completed", t.cycles[0]!.reason);
  assert.equal(t.opportunities[0]!.status, "ready");
});

test("linked worktrees cannot acquire a second assignment and replaced metadata blocks dispatch", async () => {
  const f = await fixture(), linked = join(f.dir, "linked");
  f.git("worktree", "add", "--detach", linked, "main");
  await f.projects.update(f.project.id, { repos: [f.repo, linked] });
  await assert.rejects(f.service.create({ operationId: "linked-assignment", projectId: f.project.id, repo: linked, name: "Alias team", mission: mission() }), /already has.*linked worktrees/);
  const original = readFileSync(join(f.store.directory, `${f.team.id}.json`), "utf8");
  renameSync(join(f.repo, ".git"), join(f.repo, ".git-original"));
  f.git("init", "-q", "-b", "main");
  await assert.rejects(f.service.cycle(f.team.id, "metadata-replaced"), /metadata was replaced/);
  const loaded = new ProjectTeamStore(f.store.directory); await loaded.load();
  assert.match(loaded.faults.get(f.team.id)!, /metadata was replaced/);
  assert.equal(readFileSync(join(f.store.directory, `${f.team.id}.json`), "utf8"), original);
});

test("legacy identity upgrade retains mission IDs, all evidence and exact usage reservations", async () => {
  const f = await fixture({ mission: "PT-EMPTY inspect" }); await f.service.cycle(f.team.id, "legacy-cycle");
  const legacy = await settled(f); delete legacy.repositoryId;
  const path = join(f.store.directory, `${legacy.id}.json`); writeFileSync(path, JSON.stringify(legacy));
  const loaded = new ProjectTeamStore(f.store.directory); await loaded.load();
  const upgraded = loaded.get(legacy.id);
  assert.match(upgraded.repositoryId!, /^[a-f0-9]{64}$/); assert.equal(upgraded.triggerId, legacy.triggerId);
  for (const field of ["missions", "mission", "cycles", "decisions", "opportunities", "operations"] as const) assert.deepEqual(upgraded[field], persisted(legacy[field]));
  assert.deepEqual(allowance(upgraded), allowance(legacy));
  const again = new ProjectTeamStore(f.store.directory); await again.load(); assert.deepEqual(again.get(legacy.id), upgraded, "migration is additive and runs once");
});

test("reusable teams have durable versions and project assignments explicitly pin their configuration", async () => {
  const f = await fixture();
  const definition = await f.service.saveDefinition({ operationId: "save-reusable", name: "Product engineers", sourceTeamId: f.team.id });
  const before = f.store.get(f.team.id);
  let t = await f.service.update(before.id, { operationId: "attach-team", revision: before.revision, definition: { id: definition.id, revision: 1 } });
  assert.equal(t.id, before.id); assert.equal(t.definition!.revision, 1);
  assert.deepEqual(t.cycles, before.cycles); assert.deepEqual(t.missions, before.missions); assert.deepEqual(allowance(t), allowance(before));
  const secondRepo = join(f.dir, "second-repo"); execFileSync("git", ["clone", "-q", f.repo, secondRepo]);
  const secondProject = await f.projects.create({ name: "Second product", repos: [secondRepo] });
  const second = await f.service.create({ operationId: "second-project-assignment", projectId: secondProject.id, repo: secondRepo, name: "Second mission", definition: { id: definition.id, revision: 1 }, scheduleEnabled: false, mission: mission({ mission: "Improve another product" }) });
  assert.equal(second.definition!.id, t.definition!.id); assert.notEqual(second.projectId, t.projectId);
  assert.equal(second.status, "draft"); assert.deepEqual(second.cycles, []); assert.deepEqual(allowance(second), { calls: 48, minutes: 120 });
  const updated = await f.service.saveDefinition({ operationId: "revise-team", revision: 1, name: "Product engineers", configuration: { ...definition.configuration, coordinator: "codex" } }, definition.id);
  assert.equal(updated.revision, 2); assert.equal(f.store.get(t.id).mission.coordinator, "claude"); assert.equal(f.store.get(second.id).definition!.revision, 1);
  await assert.rejects(f.service.saveDefinition({ operationId: "stale-team-version", revision: 1, name: "stale", configuration: definition.configuration }, definition.id), /changed/);
  const persisted = new AgentTeamDefinitions(f.store.directory); await persisted.load();
  assert.deepEqual(persisted.snapshot(definition.id, 1), definition.versions[0]); assert.equal(persisted.get(definition.id).revision, 2);
  t = await f.service.update(t.id, { operationId: "adopt-team-update", revision: t.revision, definition: { id: updated.id, revision: updated.revision } });
  assert.equal(t.mission.coordinator, "codex"); assert.equal(t.definition!.revision, 2); assert.deepEqual(allowance(t), allowance(before));
  assert.equal(f.store.get(second.id).mission.coordinator, "claude", "adoption never mutates other assignments");
});

test("direct owner tasks use one bounded implementation, independent review, exact approval and idempotent accounting", async () => {
  const f = await fixture();
  const definition = await f.service.saveDefinition({ operationId: "direct-team", name: "Task team", sourceTeamId: f.team.id });
  let t = await f.service.update(f.team.id, { operationId: "manual-assignment", revision: f.team.revision, scheduleEnabled: false, definition: { id: definition.id, revision: 1 } });
  assert.equal(f.automations.get(t.triggerId!)!.enabled, false);
  const request = { operationId: "owner-task", revision: t.revision, title: "Clarify the input contract", instructions: "Document that empty input is valid.", acceptance: ["The input contract is clear and existing checks pass"], category: "docs" };
  const [first, duplicate] = await Promise.all([f.service.assignTask(t.id, request), f.service.assignTask(t.id, request)]);
  assert.equal(first.cycles.length, 1); assert.equal(duplicate.cycles.length, 1);
  assert.deepEqual(first.cycles[0]!.launches.map((l) => l.phase), ["implementation"]);
  assert.equal(allowance(first).calls, 32); assert.equal(allowance(first).minutes, 75);
  await assert.rejects(f.service.cycle(t.id, "schedule:manual-team"), /Recurring discovery is disabled/);
  t = await settled(f);
  const o = t.opportunities[0]!; assert.equal(o.origin, "owner"); assert.equal(o.evidenceVerified, false); assert.deepEqual(o.evidence, []);
  assert.equal(o.status, "ready", t.cycles[0]!.reason); assert.equal(f.manager.list().length, 1, "owner tasks skip discovery");
  const child = f.manager.get(o.result!.runId)!;
  assert.equal(child.project, f.project.id); assert.deepEqual(child.projectTeam!.definition, t.definition); assert.equal(child.team!.verification!.approved, true);
  assert.deepEqual(child.team!.verification!.head, o.result!.head);
  await assert.rejects(f.manager.merge(child.id, { branch: o.result!.branch, into: "main" }), /Approve this exact result/);
  const recordedUsage = allowance(t), loaded = new ProjectTeamStore(f.store.directory); await loaded.load();
  assert.deepEqual(loaded.get(t.id), persisted(t)); assert.deepEqual(allowance(loaded.get(t.id)), recordedUsage);
  const replay = await f.service.assignTask(t.id, request); assert.equal(replay.cycles.length, 1); assert.deepEqual(allowance(replay), recordedUsage);
  await assert.rejects(f.service.assignTask(t.id, { ...request, instructions: "Different task" }), /reused/);
  t = await f.service.decide(t.id, o.id, { operationId: "approve-owner-task", revision: t.revision, opportunityRevision: o.revision, action: "approve" });
  assert.equal(t.opportunities[0]!.status, "accepted");
});

test("owner-task admission rejects missing checks, stale revisions, injected scope and insufficient budget without spending", async () => {
  const f = await fixture({ budget: { weeklyCalls: 4 } });
  const request = { operationId: "insufficient", revision: f.team.revision, title: "Task", instructions: "A task", acceptance: ["Checked"] };
  await assert.rejects(f.service.assignTask(f.team.id, request), /Insufficient rolling/);
  assert.deepEqual(f.store.get(f.team.id), f.team); assert.equal(f.manager.list().length, 0);
  await assert.rejects(f.service.assignTask(f.team.id, { ...request, scope: { paths: ["*"] } }), /Invalid owner task fields/);
  const g = await fixture({ mode: "propose", check: "" });
  await assert.rejects(g.service.assignTask(g.team.id, { ...request, revision: g.team.revision }), /required verification check/);
  const h = await fixture();
  await assert.rejects(h.service.assignTask(h.team.id, { ...request, revision: 1 }), /Reload/);
  assert.deepEqual(h.store.get(h.team.id), h.team); assert.equal(h.manager.list().length, 0);
});

test("reusable team storage preserves corrupt files and failed writes never change existing assignments", async () => {
  const f = await fixture();
  const input = { operationId: "durable-definition", name: "Engineers", sourceTeamId: f.team.id };
  const definition = await f.service.saveDefinition(input);
  assert.deepEqual(await f.service.saveDefinition(input), definition);
  await assert.rejects(f.service.saveDefinition({ ...input, name: "Different" }), /reused/);
  const path = join(f.store.directory, `${definition.id}.json`); writeFileSync(path, "{corrupt");
  const loaded = new AgentTeamDefinitions(f.store.directory); await loaded.load();
  assert.equal(loaded.faults.size, 1);
  await assert.rejects(loaded.save({ operationId: input.operationId, name: input.name, configuration: definition.configuration }), /Repair/);
  assert.equal(readFileSync(path, "utf8"), "{corrupt"); assert.deepEqual(f.store.get(f.team.id), f.team);
});

test("role-specific team models reach the run and definition changes cannot alter an allocated snapshot", async () => {
  const f = await fixture();
  const configuration = { coordinator: "claude", pool: ["claude"], agentSettings: {}, roleSettings: { coordinator: { claude: { model: "opus", effort: "high" } }, pool: { claude: { model: "haiku", effort: "low" } } } };
  const definition = await f.service.saveDefinition({ operationId: "role-model-team", name: "Specialists", configuration });
  let t = await f.service.update(f.team.id, { operationId: "attach-specialists", revision: f.team.revision, definition: { id: definition.id, revision: 1 } });
  t = await f.service.assignTask(t.id, { operationId: "specialist-task", revision: t.revision, title: "Clarify behavior", instructions: "Clarify the documented input behavior.", acceptance: ["Existing checks pass"] });
  const updated = await f.service.saveDefinition({ operationId: "update-specialists", revision: 1, name: "Specialists", configuration: { ...configuration, roleSettings: { coordinator: { claude: { model: "sonnet" } } } } }, definition.id);
  assert.equal(updated.revision, 2);
  await assert.rejects(f.service.update(t.id, { operationId: "adopt-during-task", revision: t.revision, definition: { id: definition.id, revision: 2 } }), /Stop the active cycle/);
  t = await settled(f);
  const run = f.manager.get(t.cycles[0]!.launches[0]!.runId!)!;
  assert.equal(t.opportunities[0]!.status, "ready", JSON.stringify({ reason: t.cycles.at(-1)!.reason, error: run.error, gaps: run.team?.gaps }));
  assert.deepEqual(run.roleSettings, configuration.roleSettings);
  assert.equal(run.team!.members.find((m) => m.role === "coordinator")!.model, "opus");
  assert.equal(run.team!.members.find((m) => m.role === "worker")!.model, "haiku");
  assert.equal(run.projectTeam!.definition!.revision, 1); assert.equal(t.definition!.revision, 1);
  await assert.rejects(f.service.saveDefinition({ operationId: "forged-permissions", name: "Bad", configuration: { ...configuration, trust: "full" } }), /Invalid agent team configuration/);
});

test("backups retain reusable definitions and mission usage while restore pauses assigned work", async () => {
  const f = await fixture();
  const definition = await f.service.saveDefinition({ operationId: "backup-team", name: "Backup engineers", sourceTeamId: f.team.id });
  let t = await f.service.update(f.team.id, { operationId: "backup-attach", revision: f.team.revision, definition: { id: definition.id, revision: 1 }, scheduleEnabled: false });
  await f.service.assignTask(t.id, { operationId: "backup-task", revision: t.revision, title: "Document behavior", instructions: "Clarify the documented input contract.", acceptance: ["Checks pass"] });
  t = await settled(f); assert.equal(t.opportunities[0]!.status, "ready");
  const { createEncryptedBackup, restoreEncryptedBackup } = await import("../src/maintenance.js");
  const backupHome = join(f.dir, "backup-home"); mkdirSync(join(backupHome, "project-teams"), { recursive: true });
  for (const entry of [t.id, definition.id]) writeFileSync(join(backupHome, "project-teams", `${entry}.json`), readFileSync(join(f.store.directory, `${entry}.json`)));
  const output = join(f.dir, "assignment.cfb"), destination = join(f.dir, "restored");
  await createEncryptedBackup({ home: backupHome, output, password: "team backup password 12345" });
  await restoreEncryptedBackup({ input: output, destination, password: "team backup password 12345" });
  const restored = new ProjectTeamStore(join(destination, "project-teams")); await restored.load();
  const after = restored.get(t.id); assert.equal(after.status, "paused"); assert.equal(after.opportunities[0]!.status, "blocked");
  assert.deepEqual(after.cycles, persisted(t.cycles)); assert.deepEqual(after.missions, persisted(t.missions)); assert.deepEqual(allowance(after), allowance(t));
  const restoredDefinitions = new AgentTeamDefinitions(restored.directory); await restoredDefinitions.load();
  assert.deepEqual(restoredDefinitions.get(definition.id), persisted(definition)); assert.deepEqual(after.definition, persisted(t.definition));
});

test("small documentation tasks submit once, use host checks and review, and release unused budget durably", async () => {
  const f = await fixture({ paths: ["README.md"], budget: { buildCalls: 8, buildMinutes: 10, weeklyCalls: 24, weeklyMinutes: 30 } });
  writeFileSync(join(f.repo, ".codeflow/config.json"), JSON.stringify({ prove: true }));
  f.git("add", ".codeflow/config.json"); f.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "enable proof");
  await f.service.assignTask(f.team.id, { operationId: "small-docs", revision: f.team.revision, title: "Clarify empty input", instructions: "AUTO-DOCS-HANDOFF Add a concise documented example.", acceptance: ["The example is accurate; required checks and independent review pass"], category: "docs" });
  let t = await settled(f);
  for (let attempt = 0; attempt < 20 && !t.cycles[0]!.launches[0]!.usage; attempt++) { await f.service.reconcile(); t = f.store.get(t.id); }
  const run = f.manager.get(t.cycles[0]!.launches[0]!.runId!)!;
  assert.equal(t.opportunities[0]!.status, "ready", JSON.stringify({ reason: t.cycles[0]!.reason, gaps: run.team?.gaps, error: run.error }));
  assert.equal(run.team!.tasks[0]!.attempts, 1);
  assert.equal(run.team!.metrics.invocations, 3, "one plan, one worker and one independent review");
  assert.equal(run.team!.verification!.reviewed, true);
  assert.equal(run.facts!.proofNotRequired, "documentation-only");
  assert.equal(run.proofs?.[t.opportunities[0]!.result!.branch], undefined, "no fabricated executable proof for prose");
  assert.equal(run.usage.checks, 1, "the unchanged final commit reuses the host check");
  const launch = t.cycles[0]!.launches[0]!;
  assert.equal(launch.calls, 8); assert.equal(launch.minutes, 10);
  assert.equal(launch.usage!.calls, 3); assert.ok(launch.usage!.durationMs < 60000);
  assert.deepEqual(allowance(t), { calls: 21, minutes: 29 });
  const reloaded = new ProjectTeamStore(f.store.directory); await reloaded.load();
  assert.deepEqual(allowance(reloaded.get(t.id)), allowance(t));
  const before = persisted(t.cycles); await f.service.reconcile();
  assert.deepEqual(persisted(f.store.get(t.id).cycles), before, "terminal accounting is idempotent");
  const second = await f.service.assignTask(t.id, { operationId: "another-small-task", revision: t.revision, title: "Another small docs task", instructions: "AUTO-DOCS-HANDOFF Document another example.", acceptance: ["The example is clear"], category: "docs" });
  assert.equal(second.cycles.length, 2, "the first small task leaves enough weekly allowance for another task");
});

test("disabling missions still settles a cancelled child without reopening its cycle or changing budgets", async () => {
  const f = await fixture();
  let t = await f.service.assignTask(f.team.id, { operationId: "cancel-before-disable", revision: f.team.revision, title: "Small task", instructions: "Document the contract", acceptance: ["Clear contract"] });
  const launch = t.cycles[0]!.launches[0]!, run = f.manager.get(launch.runId!)!, budget = persisted(t.mission.budget);
  t = await f.service.stopCycle(t.id, { operationId: "cancel-small-task", revision: t.revision });
  await f.service.setEnabled({ enabled: false, revision: 0 });
  while (!run.endedAt) await new Promise(resolve => setTimeout(resolve, 20));
  await f.service.reconcile(); t = f.store.get(t.id);
  assert.equal(t.cycles[0]!.status, "cancelled");
  assert.ok(t.cycles[0]!.launches[0]!.usage);
  assert.deepEqual(t.mission.budget, budget);
  assert.equal(t.cycles[0]!.launches[0]!.calls, launch.calls);
  assert.equal(t.cycles[0]!.launches[0]!.minutes, launch.minutes);
  assert.ok(allowance(t).calls > budget.weeklyCalls - launch.calls);
  const receipt = persisted(t.cycles[0]!.launches[0]!.usage);
  await f.service.reconcile(); assert.deepEqual(f.store.get(t.id).cycles[0]!.launches[0]!.usage, receipt);
});
