import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCoordinatedApi, persistCoordinatedReceipt, type CoordinationHost } from "../src/coordinated-api.js";
import type { Run, RunEvent, StartRunInput } from "../src/engine.js";
import { RunLogWriter } from "../src/run-log.js";
import type { DeferredRunRequest } from "../src/deferred-runs.js";
import type { Project } from "../src/projects.js";
import type { VerificationReport } from "../src/verification.js";
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

test("bridge snapshots required real-check configuration and stamps bounded exact launch/dependency receipts", async () => {
  const f = await fixture(), job = await f.completed(); assert.equal(job.status, "ready"); assert.equal(f.inputs.length, 2);
  for (const [index, input] of f.inputs.entries()) { assert.equal(input.trust, "safe"); assert.equal(input.allowUntrusted, false); assert.equal(input.parentRunId, undefined); assert.deepEqual(input.context!.attachments, []); assert.deepEqual(input.loop!.copy, []); assert.deepEqual(input.approvals, {}); assert.equal(input.loop!.setup, "true"); assert.equal(input.loop!.verification!.checks[0]!.required, true); assert.deepEqual(input.coordination, { jobId: job.id, nodeId: job.nodes[index]!.id, claimId: job.nodes[index]!.claimId, attempt: 1 }); await persistCoordinatedReceipt(f.runs.get(job.nodes[index]!.runId!)!, f.records); }
  assert.match(f.inputs[1]!.task, new RegExp(job.nodes[0]!.result!.commit)); assert.match(f.inputs[1]!.task, /not instructions or permission/);
  for (const extra of [{ coordination: { jobId: "forged" } }, { allowUntrusted: true, externalSource: { trusted: true } }, { source: { kind: "pr", number: 1 } }, { context: { paths: [], attachments: [{ data: "eA==" }] } }]) await assert.rejects(f.api.create({ ...f.body(), nodes: f.body().nodes.map((node) => ({ ...node, run: { ...node.run, ...extra } })) }));
});

test("revoked membership blocks creation, dispatch, result acceptance, and shipping without rejoining a project", async () => {
  const f = await fixture(); let job = await f.api.create(f.body()); f.revoke(); await f.api.service.tick(); assert.equal(f.inputs.length, 0); assert.equal((await f.latest()).nodes[0]!.attempts, 0); await assert.rejects(f.api.create(f.body()), /not in project/);
  const g = await fixture(); job = await g.completed(); g.revoke(); await assert.rejects(g.api.service.previewShipping(job.id, job.revision, { api: "main", web: "main" }), /membership changed/); await g.api.service.tick(); assert.equal((await g.latest()).nodes[0]!.status, "blocked"); assert.equal(g.merges.length, 0);
});

test("incorrect verification HEAD or missing required checks never release downstream tasks", async () => {
  for (const mode of ["head", "missing-check", "stale-review", "profile-mutation"] as const) {
    const f = await fixture(); await f.api.create(f.body()); await f.api.service.tick(); const run = [...f.runs.values()][0]!;
    if (mode === "head") run.verification!.head = "f".repeat(40); else if (mode === "missing-check") run.verification!.checks = []; else if (mode === "profile-mutation") run.loop.verification!.checks[0]!.command = "true"; else f.options.manager.reviewCoverage = async () => ({ head: run.verification!.head!, workingChanges: false, files: [], reviewed: [], coverage: { changed: 0, reviewed: 0, percent: 100, unreviewed: [] }, risk: { level: "low", reasons: [], sensitiveFiles: [] }, stale: true, rework: [] });
    await f.api.service.tick(); assert.equal(f.inputs.length, 1); assert.equal((await f.latest()).nodes[0]!.status, mode === "head" || mode === "stale-review" ? "blocked" : "failed"); assert.equal((await f.latest()).nodes[1]!.attempts, 0);
  }
});

test("exact initial and shipping receipt persistence rejects forged metadata, unsafe policy and symlinks", async () => {
  const f = await fixture(); const job = await f.completed(), run = f.runs.get(job.nodes[0]!.runId!)!, file = join(f.records, `${run.id}.jsonl`), saved = await readFile(file, "utf8");
  for (const patch of [{ project: "other" }, { repo: f.repos[1]! }, { baseRef: "f".repeat(40) }, { coordination: { ...run.coordination!, claimId: "other" } }]) await assert.rejects(persistCoordinatedReceipt({ ...run, ...patch }, f.records), /does not match/);
  await assert.rejects(persistCoordinatedReceipt(run, f.records, { branch: run.worktrees[0]!.branch, into: "main", commit: "f".repeat(40) }), /shipping receipt was not saved/);
  const forged = JSON.parse(saved.split("\n")[0]!); forged.run.approvals.tools = true; await writeFile(file, JSON.stringify(forged) + "\n"); await assert.rejects(persistCoordinatedReceipt(run, f.records), /safe execution policy/); await rm(file); const outside = join(f.directory, "outside.jsonl"); await writeFile(outside, saved); await symlink(outside, file); await assert.rejects(persistCoordinatedReceipt(run, f.records)); assert.equal(await readFile(outside, "utf8"), saved);
});

test("shipping invokes an actual local expected-tree merge and manual recovery requires its exact parents/tree", async () => {
  const f = await fixture(); let job = await f.completed(); job = await f.api.service.previewShipping(job.id, job.revision, { api: "main", web: "main" }); job = await f.api.service.shipNode(job.id, "api", job.revision, job.shipping!.id); assert.equal(job.nodes[0]!.status, "shipped"); assert.equal(f.merges.length, 1); assert.equal(job.nodes[1]!.status, "verified"); const commit = job.nodes[0]!.shippedCommit!, checked = job.shipping!.entries[0]!.validation; assert.equal(git(f.repos[0]!, "show", "-s", "--format=%P", commit), `${checked.target} ${checked.source}`);
  const document = JSON.parse(await readFile(f.options.file, "utf8")); document.jobs[0].nodes[0].status = "shipping-unknown"; delete document.jobs[0].nodes[0].shippedCommit; await writeFile(f.options.file, JSON.stringify(document)); job = await f.latest(); await assert.rejects(f.api.service.recoverShipping(job.id, "api", job.revision, checked.target), /does not prove/); job = await f.api.service.recoverShipping(job.id, "api", job.revision, commit); assert.equal(job.nodes[0]!.shippedCommit, commit);
});

test("durable shipping receipts decode patches and reject a broken latest chain until a full snapshot", async () => {
  const f = await fixture(), job = await f.completed(), run = f.runs.get(job.nodes[0]!.runId!)!, file = join(f.records, `${run.id}.jsonl`);
  const shipped = { branch: run.worktrees[0]!.branch, into: "main", commit: "f".repeat(40) }, writer = new RunLogWriter(false);
  const snapshot = (seq: number, merges: Run["merges"]): RunEvent => ({ seq, ts: seq, runId: run.id, type: "run", run: { ...structuredClone(run), merges } });
  const first = writer.encode(snapshot(1, [])), receipt = writer.encode(snapshot(2, [{ ...shipped, at: 2 }])); assert.equal(receipt.type, "run-patch");
  await writeFile(file, [first, receipt].map((event) => JSON.stringify(event)).join("\n") + "\n"); await persistCoordinatedReceipt(run, f.records, shipped);
  await appendFile(file, JSON.stringify({ seq: 3, ts: 3, runId: run.id, type: "run-patch", base: 99, set: { merges: [] } }) + "\n");
  await assert.rejects(persistCoordinatedReceipt(run, f.records, shipped), /shipping receipt was not saved/);
  await appendFile(file, JSON.stringify(snapshot(4, [{ ...shipped, at: 2 }])) + "\n"); await persistCoordinatedReceipt(run, f.records, shipped);
  await appendFile(file, JSON.stringify({ seq: 5, ts: 5, runId: run.id, type: "run-patch", base: 4, tail: { merges: [99, []] } }) + "\n");
  await assert.rejects(persistCoordinatedReceipt(run, f.records, shipped), /shipping receipt was not saved/);
  await appendFile(file, JSON.stringify(snapshot(6, [{ ...shipped, at: 2 }])) + "\n"); await persistCoordinatedReceipt(run, f.records, shipped);
});

test("startup only links exact durable claims and preserves a cancellation requested before the crash", async () => {
  const f = await fixture(); await f.api.create(f.body()); await f.api.service.tick(); const document = JSON.parse(await readFile(f.options.file, "utf8")); document.jobs[0].status = "cancelled"; document.jobs[0].cancelRequested = true; Object.assign(document.jobs[0].nodes[0], { status: "claimed", cancelRequested: true }); delete document.jobs[0].nodes[0].runId; document.jobs[0].nodes[1].status = "cancelled"; document.jobs[0].nodes[1].cancelRequested = true; await writeFile(f.options.file, JSON.stringify(document)); const restarted = createCoordinatedApi(f.options); await restarted.service.load(); await restarted.recover(); await restarted.service.tick(); const job = (await restarted.service.list())[0]!; assert.equal(job.nodes[0]!.status, "cancelled"); assert.equal(job.nodes[0]!.runId, f.inputs[0]!.coordination ? "run-api-1" : undefined); assert.deepEqual(f.cancelled, ["run-api-1"]); assert.equal(f.inputs.length, 1);
});
