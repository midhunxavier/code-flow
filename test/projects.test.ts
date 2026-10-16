import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-projects-home-"));

const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { Projects, projectOf } = await import("../src/projects.js");
const { Automations } = await import("../src/automation.js");
const { renderRemote } = await import("../src/remote.js");
const { flushWrites } = await import("../src/store.js");
type Run = import("../src/engine.js").Run;
type Manager = InstanceType<typeof RunManager>;

const roles = { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] } as Record<string, any>;
let root: string;
let api: string;
let web: string;

/** A git repo with one commit, under `root`; its path as git reports it (macOS tmp is a symlink). */
function makeRepo(...path: string[]): string {
  const dir = join(root, ...path);
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q");
  writeFileSync(join(dir, "README.md"), "projects\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir }).toString().trim();
}

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "codeflow-projects-repos-")));
  api = makeRepo("api");
  web = makeRepo("web");
});

const fresh = () => new Projects(join(mkdtempSync(join(tmpdir(), "codeflow-projects-file-")), "projects.json"));

function finished(m: Manager, run: Run): Promise<Run> {
  return new Promise((resolve) => {
    const check = () => run.status !== "running" && run.endedAt !== undefined && resolve(run);
    m.subscribe(run.id, check);
    check();
  });
}

const start = (m: Manager, repo: string, extra: Record<string, unknown> = {}) =>
  m.start({ pattern: findPattern("pipeline")!, task: "Group me", repo, roles, options: {}, ...extra }).then((run) => finished(m, run));

test("a run belongs to the project it recorded; runs from before projects, to the first project with their repo", () => {
  const list = [
    { id: "p-a", name: "A", repos: ["/r/one"], createdAt: 1 },
    { id: "p-b", name: "B", repos: ["/r/one", "/r/two"], createdAt: 2 },
  ];
  assert.equal(projectOf({ repo: "/r/one" }, list), "p-a", "no project recorded: the first project holding the repo");
  assert.equal(projectOf({ repo: "/r/two" }, list), "p-b");
  assert.equal(projectOf({ repo: "/r/one", project: "p-b" }, list), "p-b", "a recorded project wins over the repo");
  assert.equal(projectOf({ repo: "/r/one", project: "p-gone" }, list), undefined, "a deleted project leaves the run in none");
  assert.equal(projectOf({ repo: "/r/three" }, list), undefined);
});

test("the first load makes a project per repo that has runs; later loads never bring a deleted one back", async () => {
  const projects = fresh();
  const runs = [
    { repo: web, createdAt: 30 },
    { repo: api, createdAt: 10 },
    { repo: api, createdAt: 20 },
  ];
  await projects.load(runs);
  assert.deepEqual(
    projects.list().map((p) => [p.name, p.repos, p.createdAt]),
    [
      ["api", [api], 10],
      ["web", [web], 30],
    ],
    "oldest repo first, named after the folder",
  );
  await projects.remove(projects.forRepo(web)!.id);

  const again = new Projects((projects as any).file);
  await again.load(runs);
  assert.deepEqual(again.list().map((p) => p.name), ["api"], "seeding only happens the first time");
});

test("placing runs: a new project for a new repo (once, even when runs start together), the one asked for, or the parent's", async () => {
  const projects = fresh();
  await projects.load();
  const [a, b] = await Promise.all([projects.place(api), projects.place(api)]);
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.project.id, b.project.id, "two runs starting in a new repo share one new project");
  assert.equal(projects.list().length, 1);

  const suite = await projects.create({ name: "  Suite ", repos: [] });
  assert.equal(suite.name, "Suite");
  const into = await projects.place(web, { requested: suite.id });
  assert.equal(into.project.id, suite.id);
  assert.equal(into.added, true, "the run's repo joins the project it was started in");
  assert.deepEqual(projects.get(suite.id)!.repos, [web]);

  // A reply continues in its parent's project, even though the repo's first project is another one.
  await projects.place(api, { requested: suite.id });
  assert.equal(projects.forRepo(api)!.name, "api");
  assert.equal((await projects.place(api, { parent: suite.id })).project.id, suite.id);
  assert.equal((await projects.place(api)).project.name, "api", "with nothing asked for, the repo's first project");

  await assert.rejects(projects.place(api, { requested: "p-missing" }), /no longer exists/);
  assert.equal((await projects.place(api, { requested: "p-missing", lenient: true })).project.name, "api", "an automation falls back to the repo's project");
});

test("names: unique, taken from the folder (with its parent when two repos share a name); repos are checked", async () => {
  const projects = fresh();
  await projects.load();
  const other = makeRepo("other", "api");
  await projects.place(api);
  const second = await projects.place(other);
  assert.equal(second.project.name, "api (other)");
  await assert.rejects(projects.create({ name: "API" }), /already a project called/);
  await assert.rejects(projects.create({ name: " " }), /Name the project/);
  await assert.rejects(projects.create({ name: "x".repeat(61) }), /under 60/);
  await assert.rejects(projects.create({ name: "Rel", repos: ["relative/path"] }), /absolute/);
  await assert.rejects(projects.create({ name: "Nope", repos: [root] }), /isn't a git repository/);

  const p = await projects.create({ name: "Both", repos: [join(web, "."), web] });
  assert.deepEqual(p.repos, [web], "paths are stored as their repo root, once");
  const renamed = await projects.update(p.id, { name: "Front and back", repos: [web, api] });
  assert.deepEqual([renamed.name, renamed.repos], ["Front and back", [web, api]]);
  await assert.rejects(projects.update(p.id, { name: "api" }), /already a project/);
  assert.ok(existsSync((projects as any).file));
  assert.equal(JSON.parse(readFileSync((projects as any).file, "utf8")).length, 3, "saved to projects.json");
});

test("the composer's defaults: the last pattern, and the last team per pattern", async () => {
  const projects = fresh();
  await projects.load();
  const { project } = await projects.place(api);
  await projects.remember(project.id, { pattern: "race", roles: { contestants: ["claude", "codex"], judge: ["auto"] }, agentSettings: { claude: { model: "opus" } } });
  await projects.remember(project.id, { pattern: "pipeline", roles, roleSettings: { builder: { codex: { effort: "high" } } }, agentSettings: {} });
  const d = projects.get(project.id)!.defaults!;
  assert.equal(d.pattern, "pipeline");
  assert.deepEqual(d.teams.race!.roles, { contestants: ["claude", "codex"], judge: ["auto"] }, "the race team is kept for when you pick it again");
  assert.deepEqual(d.teams.pipeline!.roleSettings, { builder: { codex: { effort: "high" } } });
  assert.equal(d.agentSettings, undefined);
});

test("runs record their project: new repo, a reply, moving a run, and an automation whose project was deleted", async () => {
  const projects = fresh();
  await projects.load();
  const manager = new RunManager(findPattern, projects);

  const first = await start(manager, api);
  const apiProject = projects.forRepo(api)!;
  assert.equal(first.project, apiProject.id);
  assert.equal(first.status, "done");

  const suite = await projects.create({ name: "Suite", repos: [api] });
  const inSuite = await start(manager, api, { project: suite.id });
  assert.equal(inSuite.project, suite.id);
  const reply = await start(manager, api, { parentRunId: inSuite.id });
  assert.equal(reply.project, suite.id, "a reply stays in its parent's project");

  // Moving a run takes its repo along.
  const moved = await manager.setProject(first.id, (await projects.create({ name: "Elsewhere" })).id);
  assert.equal(manager.get(first.id)!.project, moved.id);
  assert.deepEqual(projects.get(moved.id)!.repos, [api]);
  await assert.rejects(manager.setProject(first.id, "p-missing"), /Project not found/);

  await assert.rejects(start(manager, web, { project: "p-missing" }), /no longer exists/);

  const automations = new Automations(manager, (body, extra) =>
    manager.start({ pattern: findPattern(body.pattern)!, task: body.task, repo: body.repo, project: body.project, roles: body.roles, options: {}, trigger: extra.trigger }),
  );
  await automations.load();
  const doomed = await projects.create({ name: "Doomed", repos: [web] });
  const t = await automations.create({ name: "Nightly", enabled: true, webhook: false, isolate: false, schedule: { every: 60 }, run: { repo: web, project: doomed.id, pattern: "pipeline", task: "Nightly", roles } });
  await projects.remove(doomed.id);
  const fired = await automations.fire(t.id, { via: "manual" });
  const run = await finished(manager, fired.run!);
  assert.equal(run.status, "done", "the automation still runs");
  assert.equal(projects.get(run.project!)!.name, "web", "in the repo's own project, new since its old one was deleted");
  await automations.remove(t.id);

  // The project survives a restart: it's in the run's log.
  await flushWrites();
  const later = new RunManager(findPattern, projects);
  await later.load();
  assert.equal(later.get(inSuite.id)!.project, suite.id);
  assert.equal(later.get(first.id)!.project, moved.id, "the move was saved too");
});

test("runs from before projects stay put when their project gives up the repo, or is deleted", async () => {
  // Runs started without projects record none, like runs from before projects existed.
  const before = new RunManager(findPattern);
  const oldApi = await start(before, api);
  const oldWeb = await start(before, web);
  assert.equal(oldApi.project, undefined);
  await flushWrites();

  const projects = fresh();
  await projects.load([oldApi, oldWeb]);
  const manager = new RunManager(findPattern, projects);
  await manager.load();
  const seededApi = projects.forRepo(api)!;
  const seededWeb = projects.forRepo(web)!;
  // Later projects that also hold the repos: without a recorded project, the runs would move there.
  await projects.create({ name: "Also api", repos: [api] });
  await projects.create({ name: "Also web", repos: [web] });
  const of = (id: string) => projectOf(manager.get(id)!, projects.list());
  assert.equal(of(oldApi.id), seededApi.id, "no project recorded: the first project holding the repo");

  await manager.updateProject(seededApi.id, { repos: [] });
  assert.equal(manager.get(oldApi.id)!.project, seededApi.id, "recorded before the repo left");
  assert.equal(of(oldApi.id), seededApi.id, "still in its project");

  await manager.removeProject(seededWeb.id);
  assert.equal(of(oldWeb.id), undefined, "in no project, not in “Also web”");
  await flushWrites();
  const again = new RunManager(findPattern, projects);
  await again.load();
  assert.equal(again.get(oldApi.id)!.project, seededApi.id, "recorded in the run's log");
});

test("phone view: runs under their project's name, projects that need you first, runs in none last", async () => {
  const projects = fresh();
  await projects.load();
  const manager = new RunManager(findPattern, projects);
  const side = await projects.create({ name: "<Side>", repos: [] });
  const sideRun = await start(manager, web, { project: side.id, task: "Side work" });
  const apiRun = await start(manager, api, { task: "Api work" }); // newer, but seen: it needs nobody
  manager.setSeen(apiRun.id);
  const lonely = makeRepo("lonely");
  const loneRun = await start(manager, lonely, { task: "Lone work" });
  await manager.removeProject(projects.forRepo(lonely)!.id);

  const html = renderRemote(manager, projects.list(), "/r/tok", "/")!;
  const sections = html.split("<section>").slice(1);
  const heading = (s: string) => s.match(/<h2 class="project">(.*?)<\/h2>/)?.[1];
  assert.deepEqual(sections.map(heading), ["&lt;Side&gt;", "api", "No project"], "escaped, needing you first, no project last");
  const [inSide, inApi, inNone] = sections;
  assert.ok(inSide!.includes(`/run/${sideRun.id}`) && inSide!.includes("<h3>Needs you (1)</h3>"));
  assert.ok(inApi!.includes(`/run/${apiRun.id}`) && inApi!.includes("<h3>Recent (1)</h3>"));
  assert.ok(inNone!.includes(`/run/${loneRun.id}`));
  assert.ok(!inSide!.includes(apiRun.id) && !inApi!.includes(sideRun.id), "each run under its own project only");

  assert.match(renderRemote(manager, projects.list(), "/r/tok", `/run/${sideRun.id}`)!, /&lt;Side&gt; · web · started/, "a run's page names its project");
});

test("generated names stay unique within the length limit", async () => {
  const projects = fresh();
  await projects.load();
  const long = "a-very-long-repository-name-that-goes-on-and-on-past-the-limit-x";
  const one = (await projects.place(makeRepo("one", long))).project.name;
  const two = (await projects.place(makeRepo("two", long))).project.name;
  const three = (await projects.place(makeRepo("three", "two", long))).project.name;
  assert.equal(new Set([one, two, three].map((n) => n.toLowerCase())).size, 3, `${one} | ${two} | ${three}`);
  for (const name of [one, two, three]) assert.ok(name.length <= 60, name);
  assert.match(two, / \(two\)$/, "the parent folder tells them apart");
  assert.match(three, / 2$/, "numbered when the parent is taken too");
});

test("a change that can't be saved fails and is undone, so nothing reports done that a restart would lose", async () => {
  const notAFolder = join(mkdtempSync(join(tmpdir(), "codeflow-projects-ro-")), "file");
  writeFileSync(notAFolder, "");
  const projects = new Projects(join(notAFolder, "projects.json"));
  await projects.load([{ repo: api, createdAt: 1 }]); // seeding still works in memory
  assert.equal(projects.list().length, 1);
  await assert.rejects(projects.create({ name: "Lost" }), /couldn't save projects/);
  await assert.rejects(projects.place(web), /couldn't save projects/);
  await assert.rejects(projects.update(projects.forRepo(api)!.id, { name: "Renamed" }), /couldn't save projects/);
  assert.deepEqual(projects.list().map((p) => [p.name, p.repos]), [["api", [api]]], "every failed change was undone");
  assert.equal((await projects.place(api)).project.name, "api", "placing in an existing project needs no save");
  await projects.remember(projects.forRepo(api)!.id, { pattern: "pipeline", roles }); // logged, never thrown

  const manager = new RunManager(findPattern, projects);
  await assert.rejects(start(manager, web), /couldn't save projects/, "the run doesn't start in a project that wouldn't survive a restart");
});
