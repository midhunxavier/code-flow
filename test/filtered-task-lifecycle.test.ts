import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilteredTasks, type FilteredTaskRuntime } from "../src/filtered-tasks.js";
import { ProjectFilePolicies } from "../src/filesystem-policy.js";
import { FILTERED_WORKSPACE_LIMITS } from "../src/filtered-task-limits.js";

const image = "sha256:" + "a".repeat(64);
function gate() { let resolve!: () => void; const promise = new Promise<void>((done) => resolve = done); return { promise, resolve }; }
async function until(check: () => boolean) { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw new Error("Lifecycle fixture timed out"); await new Promise((done) => setTimeout(done, 10)); } }
async function fixture(work: (context: { repo: string; make: (runtime: FilteredTaskRuntime) => FilteredTasks; blockNextAuthorization: (entered: ReturnType<typeof gate>, release: ReturnType<typeof gate>, skip?: number) => void }) => Promise<void>) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "cf-filtered-lifecycle-"))), repo = join(home, "repo"), store = new ProjectFilePolicies(home), services: FilteredTasks[] = []; let authorizationGate: { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate>; remaining: number } | undefined;
  await mkdir(repo); await writeFile(join(repo, "allowed.txt"), "baseline\n"); execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo }); execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@test", "commit", "-qm", "base"], { cwd: repo }); await store.set("project", { revision: 0, read: { allow: ["."], deny: [] }, write: { allow: ["allowed.txt"], deny: [] } });
  const make = (runtime: FilteredTaskRuntime) => { const service = new FilteredTasks({ home, runtime, authorize: async () => { const pending = authorizationGate; if (pending && pending.remaining-- === 0) { authorizationGate = undefined; pending.entered.resolve(); await pending.release.promise; } return [await store.get("project")]; }, withRepository: async (_repo, operation) => operation() }); services.push(service); return service; };
  try { await work({ repo, make, blockNextAuthorization: (entered, release, skip = 0) => authorizationGate = { entered, release, remaining: skip } }); } finally { await Promise.allSettled(services.map((service) => service.close())); await rm(home, { recursive: true, force: true }); }
}
const input = (repo: string) => ({ project: "project", repo, task: "Change allowed file", agent: "claude", image: "fixture:prepared", network: false });
const runtime = (run: FilteredTaskRuntime["run"], pinImage: FilteredTaskRuntime["pinImage"] = async () => image): FilteredTaskRuntime => ({ pinImage, run, stop: async () => undefined });

test("cancelling a published preparing task prevents later dispatch after image inspection resumes", async () => fixture(async ({ repo, make }) => {
  const entered = gate(), release = gate(); let calls = 0;
  const service = make(runtime(async () => { calls++; return { ok: true, finalText: "must not run" }; }, async () => { entered.resolve(); await release.promise; return image; })); await service.load();
  const creating = service.create(input(repo)); await entered.promise; const job = service.list()[0]!; assert.equal(job.status, "preparing");
  const cancelling = service.cancel(job.id, job.revision); release.resolve(); const outcomes = await Promise.allSettled([creating, cancelling]); assert.equal(outcomes[1]!.status, "fulfilled"); assert.equal(calls, 0); assert.equal(service.get(job.id).status, "cancelled"); assert.equal(service.active(), false);
}));

for (const mutation of ["working content", "staged mode"] as const) test(`import rechecks late ${mutation} changes after its durable importing receipt`, async () => fixture(async ({ repo, make, blockNextAuthorization }) => {
  const service = make(runtime(async (_job, workspace) => { await writeFile(join(workspace, "allowed.txt"), "changed\n"); return { ok: true, finalText: "ready" }; })); await service.load(); const created = await service.create(input(repo)); await until(() => service.get(created.id).status === "completed"); const job = service.get(created.id);
  const entered = gate(), release = gate(); blockNextAuthorization(entered, release, 3); const importing = service.import(job.id, { revision: job.revision, expectedHead: job.sourceHead, resultHash: job.resultHash }); await entered.promise; assert.equal(service.get(job.id).status, "importing", "the gate exercises the final source check after durable import intent");
  if (mutation === "working content") await writeFile(join(repo, "allowed.txt"), "concurrent late edit\n"); else execFileSync("git", ["update-index", "--chmod=+x", "allowed.txt"], { cwd: repo });
  release.resolve(); await assert.rejects(importing, /contents changed|mode\/index changed/); assert.equal(execFileSync("git", ["branch", "--list", `codeflow/${job.id}`], { cwd: repo, encoding: "utf8" }).trim(), ""); assert.equal(service.get(job.id).status, "unknown", "durable intent remains explicitly unresolved until receipt inspection"); const resolved = await service.reconcile(job.id, service.get(job.id).revision); assert.equal(resolved.status, "completed");
}));

test("shutdown tracks preparing work, prevents a late provider launch and rejects subsequent create", async () => fixture(async ({ repo, make }) => {
  const entered = gate(), release = gate(); let calls = 0;
  const service = make(runtime(async () => { calls++; return { ok: true, finalText: "must not run" }; }, async () => { entered.resolve(); await release.promise; return image; })); await service.load();
  const creating = service.create(input(repo)); await entered.promise; let closed = false; const closing = service.close().then(() => closed = true); await new Promise((done) => setTimeout(done, 20)); assert.equal(closed, false, "shutdown waits for the already claimed preparation"); release.resolve(); await Promise.allSettled([creating, closing]); assert.equal(calls, 0); assert.equal(service.active(), false); await assert.rejects(service.create(input(repo)), /closed|shutting|unavailable/i);
}));

test("import claims exclude cancellation and shutdown settles preparation before refusing a late publication", async () => fixture(async ({ repo, make, blockNextAuthorization }) => {
  const service = make(runtime(async (_job, workspace) => { await writeFile(join(workspace, "allowed.txt"), "changed\n"); return { ok: true, finalText: "ready" }; })); await service.load(); const created = await service.create(input(repo)); await until(() => service.get(created.id).status === "completed"); const job = service.get(created.id);
  const entered = gate(), release = gate(); blockNextAuthorization(entered, release); const importing = service.import(job.id, { revision: job.revision, expectedHead: job.sourceHead, resultHash: job.resultHash }); await entered.promise;
  await assert.rejects(service.cancel(job.id, service.get(job.id).revision), /import/i); let closed = false; const closing = service.close().then(() => closed = true); await new Promise((done) => setTimeout(done, 20)); assert.equal(closed, false, "shutdown waits for claimed preparation rather than returning before a late import"); release.resolve(); await assert.rejects(importing, /stopped before publication/); await closing; assert.equal(service.get(job.id).status, "completed"); assert.equal(execFileSync("git", ["branch", "--list", `codeflow/${job.id}`], { cwd: repo, encoding: "utf8" }).trim(), ""); assert.equal(closed, true);
}));

test("a live workspace excess aborts the provider and confirms daemon absence before becoming terminal", async () => fixture(async ({ repo, make }) => {
  let stopped = 0, observedAbort = false;
  const service = make({ pinImage: async () => image, stop: async () => { stopped++; }, run: async (_job, workspace, signal) => {
    const file = await open(join(workspace, "large-output"), "wx"); try { await file.truncate(FILTERED_WORKSPACE_LIMITS.logicalBytes + 1); } finally { await file.close(); }
    if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); observedAbort = signal.aborted; return { ok: false, finalText: "", error: "aborted fixture" };
  } }); await service.load(); const created = await service.create(input(repo)); await until(() => service.get(created.id).containerStopped && service.get(created.id).status !== "running"); const done = service.get(created.id); assert.equal(observedAbort, true); assert.ok(stopped > 0); assert.match(done.error!, /workspace bytes exceed/); assert.equal(done.status, "cancelled"); assert.equal(service.active(), false);
}));

test("a changed immutable image receipt refuses provider dispatch", async () => fixture(async ({ repo, make }) => {
  let pins = 0, runs = 0;
  const service = make(runtime(async () => { runs++; return { ok: true, finalText: "must not execute" }; }, async () => ++pins === 1 ? image : "sha256:" + "b".repeat(64))); await service.load(); const created = await service.create(input(repo)); await until(() => service.get(created.id).status === "failed"); assert.equal(runs, 0); assert.match(service.get(created.id).error!, /Pinned Docker image changed/); assert.equal(service.active(), false);
}));

test("preview bounds aggregate empty directories even after live monitoring has stopped", async () => fixture(async ({ repo, make }) => {
  let exportRoot = "";
  const service = make(runtime(async (_job, workspace) => { exportRoot = workspace; await writeFile(join(workspace, "allowed.txt"), "changed\n"); return { ok: true, finalText: "ready" }; })); await service.load(); const created = await service.create(input(repo)); await until(() => service.get(created.id).status === "completed");
  for (let parent = 0; parent < 70; parent++) { const directory = join(exportRoot, `empty-${parent}`); await mkdir(directory); await Promise.all(Array.from({ length: 30 }, (_, child) => mkdir(join(directory, `child-${child}`)))); }
  await assert.rejects(service.preview(created.id), /entry count|entry bound|inspection.*deadline/);
}));

test("host Git hooks, fsmonitor, clean filters and inherited Git overrides never execute during export and import", async () => fixture(async ({ repo, make }) => {
  const marker = join(repo, ".git", "HOST_EXECUTION_MARKER"), script = join(repo, ".git", "host-execution.sh"); await writeFile(script, `#!/bin/sh\ntouch '${marker.replace(/'/g, "'\\''")}'\nprintf '\\0'\n`, { mode: 0o700 }); await writeFile(join(repo, ".gitattributes"), "allowed.txt filter=host-fixture\n"); execFileSync("git", ["add", ".gitattributes"], { cwd: repo }); execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@test", "commit", "-qm", "filter attribute"], { cwd: repo });
  execFileSync("git", ["config", "core.fsmonitor", script], { cwd: repo }); execFileSync("git", ["config", "filter.host-fixture.clean", script], { cwd: repo }); execFileSync("git", ["config", "filter.host-fixture.required", "true"], { cwd: repo }); const hooks = join(repo, ".git", "host-hooks"); await mkdir(hooks); await writeFile(join(hooks, "post-index-change"), `#!/bin/sh\ntouch '${marker.replace(/'/g, "'\\''")}'\n`, { mode: 0o700 }); execFileSync("git", ["config", "core.hooksPath", hooks], { cwd: repo });
  const saved = { GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
  process.env.GIT_CONFIG_COUNT = "1"; process.env.GIT_CONFIG_KEY_0 = "core.fsmonitor"; process.env.GIT_CONFIG_VALUE_0 = script; process.env.GIT_INDEX_FILE = join(repo, ".git", "environment-injected-index");
  try {
    const service = make(runtime(async (_job, workspace) => { await writeFile(join(workspace, "allowed.txt"), "changed\n"); return { ok: true, finalText: "ready" }; })); await service.load(); const created = await service.create(input(repo)); await until(() => service.get(created.id).status === "completed"); const done = service.get(created.id); assert.equal((await service.import(done.id, { revision: done.revision, expectedHead: done.sourceHead, resultHash: done.resultHash })).status, "imported"); assert.equal(await readFile(marker).catch(() => undefined), undefined); assert.equal(await readFile(process.env.GIT_INDEX_FILE!).catch(() => undefined), undefined);
  } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}));
