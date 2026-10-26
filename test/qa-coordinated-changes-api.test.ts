import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCoordinatedApi, persistCoordinatedReceipt, type CoordinationHost } from "../src/coordinated-api.js";
import type { Run, StartRunInput } from "../src/engine.js";
import { RunLogWriter } from "../src/run-log.js";
import type { DeferredRunRequest } from "../src/deferred-runs.js";
import type { Project } from "../src/projects.js";
import { validateMergeTarget } from "../src/merge-validation.js";
import { HttpError } from "../src/http.js";
import { mergeInto } from "../src/ship.js";

const directories: string[] = []; after(() => Promise.all(directories.map((path) => rm(path, { recursive: true, force: true }))));
const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-coordinated-api-"))); directories.push(directory); const records = join(directory, "runs"); await mkdir(records);
  const repos = [join(directory, "api"), join(directory, "web")]; for (const repo of repos) { await mkdir(join(repo, ".codeflow"), { recursive: true }); git(repo, "init", "-q", "-b", "main"); git(repo, "config", "user.name", "fixture"); git(repo, "config", "user.email", "fixture@test"); await writeFile(join(repo, "README.md"), "Fixture\n"); await writeFile(join(repo, ".codeflow/config.json"), JSON.stringify({ check: "test -f output.txt", setup: "true", copy: [".env"] })); git(repo, "add", "."); git(repo, "commit", "-qm", "initial"); }
  let project: Project | undefined = { id: "project-fixture", name: "Fixture", repos: [...repos], createdAt: Date.now() };
  const runs = new Map<string, Run>(), inputs: StartRunInput[] = [], cancelled: string[] = [], merges: { id: string; input: any }[] = [];
  const writer = new RunLogWriter(); let seq = 0;
  const save = (run: Run) => appendFile(join(records, `${run.id}.jsonl`), JSON.stringify(writer.encode({ type: "run", seq: ++seq, ts: Date.now(), runId: run.id, run: structuredClone(run) })) + "\n");
  const build = async (request: DeferredRunRequest): Promise<StartRunInput> => ({ pattern: { id: "solo" } as StartRunInput["pattern"], task: request.task, repo: request.repo, project: request.project, baseRef: request.baseRef, roles: { agent: ["claude"] }, options: {}, loop: request.loop, trust: "full", allowUntrusted: true, approvals: { plan: true, tools: true }, parentRunId: "must-be-cleared", context: { paths: [], attachments: [{ name: "must-not-inherit", data: "eA==" }] } });
  const report = (input: StartRunInput, head: string, branch: string): Run["verification"] => ({ version: 1, profile: "Coordinated task checks", state: "verified", head, branch, startedAt: Date.now(), endedAt: Date.now(), checks: input.loop!.verification!.checks.map((check) => ({ check, diagnosis: "passed", attempts: [{ ok: true, command: check.command, output: "Fixture host evidence; real engine is covered in browser acceptance", exitCode: 0, timedOut: false, durationMs: 1 }] })), skipped: [] });
  const host = {
    get: (id: string) => runs.get(id), list: () => [...runs.values()], quota: {},
    start: async (input: StartRunInput) => {
      assert.equal(input.requireProjectRepo, true); if (!project?.repos.includes(input.repo)) throw new Error("No explicit project membership"); inputs.push(input); const runId = `run-${input.coordination!.nodeId}-${input.coordination!.attempt}`, branch = `codeflow/${runId}`;
      git(input.repo, "checkout", "-qb", branch, input.baseRef!); await writeFile(join(input.repo, "output.txt"), `Owned output ${runId}\n`); git(input.repo, "add", "output.txt"); git(input.repo, "commit", "-qm", "fixture output"); const head = git(input.repo, "rev-parse", "HEAD"); git(input.repo, "checkout", "-q", "main");
      const run = { id: runId, project: input.project, repo: input.repo, baseRef: input.baseRef, pattern: "solo", task: input.task, coordination: input.coordination, trigger: input.trigger, parentRunId: input.parentRunId, trust: input.trust, loop: input.loop, approvals: input.approvals, status: "done", followUps: [], artifacts: [{ label: "Result", branch, path: input.repo }], worktrees: [{ name: "solo", branch, path: input.repo }], merges: [], verdict: "passed", verification: report(input, head, branch) } as unknown as Run;
      runs.set(run.id, run); await save(run); return run;
    },
    cancel: (id: string) => { cancelled.push(id); const run = runs.get(id); if (run) run.status = "cancelled"; },
    reviewCoverage: async (id: string, branch: string) => ({ head: git(runs.get(id)!.repo, "rev-parse", `refs/heads/${branch}`), files: ["output.txt"], reviewed: [], coverage: { changed: 1, reviewed: 0, percent: 0, unreviewed: ["output.txt"] }, risk: { level: "low", reasons: [], sensitiveFiles: [] }, stale: false, rework: [] }),
    validateMerge: async (id: string, input: { branch: string; into: string }) => { const run = runs.get(id)!, source = git(run.repo, "rev-parse", input.branch), target = git(run.repo, "rev-parse", input.into), tree = git(run.repo, "rev-parse", `${source}^{tree}`); const checked = { branch: input.branch, into: input.into, source, target, tree, at: Date.now(), report: run.verification!, conflicts: [] }; run.mergeValidation = checked; return checked; },
    merge: async (id: string, input: { branch: string; into: string; requireValidation?: boolean }) => { assert.equal(input.requireValidation, true); const run = runs.get(id)!; merges.push({ id, input }); const result = await mergeInto(run.repo, input.branch, input.into, "explicit fixture merge", run.mergeValidation); if (result.ok) { run.merges.push({ branch: input.branch, into: input.into, commit: result.commit, at: Date.now() }); await save(run); } return result; },
    withIdleRepository: async (_repo: string, operation: () => unknown) => operation(),
  } as unknown as CoordinationHost;
  const options = { manager: host, projects: { get: (id: string) => project?.id === id ? structuredClone(project) : undefined }, file: join(directory, "coordinated-changes.json"), directory: records, build, resolveProviders: async () => ({ roles: { agent: ["claude" as const] }, installed: new Set(["claude" as const]) }) };
  const api = createCoordinatedApi(options); await api.service.load();
  const body = () => ({ project: "project-fixture", name: "API and web", nodes: repos.map((repo, index) => ({ id: index ? "web" : "api", dependsOn: index ? ["api"] : [], run: { repo, pattern: "solo", task: "Implement fixture", roles: { agent: ["claude"] }, options: {} } })) });
  const latest = async () => (await api.service.list())[0]!;
  const completed = async () => { await api.create(body()); await api.service.tick(); await api.service.tick(); await api.service.tick(); return latest(); };
  return { directory, records, repos, runs, inputs, cancelled, merges, options, api, body, latest, completed, revoke: () => { if (project) project.repos = [repos[1]!]; }, removeProject: () => { project = undefined; } };
}

test("creation explains absent projects and repository membership with request status codes", async () => {
  const f = await fixture(); f.revoke();
  await assert.rejects(f.api.create(f.body()), error => error instanceof HttpError && error.status === 400 && /not in project Fixture/.test(error.message));
  f.removeProject(); await assert.rejects(f.api.create(f.body()), error => error instanceof HttpError && error.status === 404 && /Project not found/.test(error.message));
  assert.equal(f.inputs.length, 0);
});

test("moved and deleted result branches identify the affected task and invalidate dependent receipts", async () => {
  for (const removed of [false, true]) {
    const f = await fixture(); const original = await f.completed(), node = original.nodes[0]!;
    if (removed) git(node.run.repo, "branch", "-D", node.result!.branch);
    else { git(node.run.repo, "checkout", "-q", node.result!.branch); await writeFile(join(node.run.repo, "moved.txt"), "changed after verification\n"); git(node.run.repo, "add", "moved.txt"); git(node.run.repo, "commit", "-qm", "moved result"); git(node.run.repo, "checkout", "-q", "main"); }
    await f.api.service.tick(); const job = await f.latest(); assert.deepEqual(job.nodes.map(node => node.status), ["blocked", "blocked"]);
    assert.match(job.nodes[0]!.reason!, removed ? /api.*no longer exists/ : /api.*after it was verified/); assert.doesNotMatch(job.nodes[0]!.reason!, /rev-parse|fatal:|during inspection/);
    assert.match(job.nodes[1]!.reason!, /Dependency api/); assert.equal(f.merges.length, 0);
  }
});

test("local merge validation explains empty, malformed and missing branches without raw Git errors", async () => {
  const f = await fixture(), repo = f.repos[0]!; const profile = { name: "fixture", checks: [{ id: "check", kind: "custom" as const, command: "true", required: true, timeoutMs: 1000 }] };
  for (const [into, expected] of [["", /Choose a target branch/], ["bad..branch", /valid local target branch/], ["develop", /Branch "develop" does not exist in api/]] as const) {
    await assert.rejects(validateMergeTarget(repo, { branch: "main", into, profile }), error => error instanceof Error && expected.test(error.message) && !/rev-parse|fatal:|Needed a single revision/.test(error.message));
  }
  await assert.rejects(validateMergeTarget(repo, { branch: "missing-result", into: "main", profile }), /Branch "missing-result" does not exist/);
  assert.equal(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
});
