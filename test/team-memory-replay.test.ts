import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run, RunManager } from "../src/engine.js";

const home = await mkdtemp(join(tmpdir(), "codeflow-memory-replay-home-"));
process.env.CODEFLOW_HOME = home;
const { TeamContext, RunManager: Manager } = await import("../src/engine.js");
const { memoryStore } = await import("../src/memory.js");
const { Projects } = await import("../src/projects.js");
const { flushWrites, loadJournal, RUNS_DIR } = await import("../src/store.js");
const { recordFindings } = await import("../src/learnings.js");
const repo = await realpath(await mkdtemp(join(tmpdir(), "codeflow-memory-replay-repo-")));
after(async () => { await flushWrites(); await rm(home, { recursive: true, force: true }); await rm(repo, { recursive: true, force: true }); });

test("replayed memory selection keeps recorded references, excludes newer bodies, and makes pre-journal writes idempotent", async () => {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  await writeFile(join(repo, "README.md"), "fixture\n");
  git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "initial");
  const projects = new Projects(join(home, "projects.json"));
  await projects.load();
  const project = await projects.create({ name: "Replay", repos: [repo] });
  const run = { id: "replay-memory", repo, project: project.id, task: "Task contract", baseRef: git("rev-parse", "HEAD"), baseLabel: "main", worktrees: [] } as unknown as Run;
  const manager = { projects, emitRun: () => undefined } as unknown as RunManager;
  const authority = { kind: "run" as const, repo, projectId: project.id, runId: run.id, memberId: "coordinator", lockedDown: false, sourceTrust: "trusted" as const };
  const a = await memoryStore.propose({ scope: "project", repo, projectId: project.id, title: "Original source", body: "PRIVATE TEST BODY ORIGINAL" }, { ...authority, sourceTrust: "untrusted" });
  const original = await memoryStore.accept(a.id, a.revision, { kind: "user" });
  const b = await memoryStore.propose({ scope: "project", repo, projectId: project.id, title: "Later worker context", body: "PRIVATE TEST BODY B", paths: ["src/b"] }, { kind: "user" });
  const first = new TeamContext(run, new AbortController(), manager);
  const planning = await first.projectMemory("coordinator");
  assert.deepEqual(planning.entries.map((entry) => entry.id), [original.id]);
  const contractInput = { scope: "team" as const, repo, projectId: project.id, runId: run.id, title: "Contract", body: "Derived original contract", operationId: "contract:0", derivedFrom: run.memoryManifest!.included.map(({ id, revision }) => ({ id, revision })) };
  const persistedBeforeJournal = await memoryStore.propose(contractInput, authority);
  // A later turn has another context, so the last saved run projection includes future refs.
  await first.projectMemory("builder", "task-b", ["src/b"]);
  assert.ok(run.memoryManifest!.included.some((ref) => ref.id === b.id));
  await memoryStore.revise(original.id, original.revision, { body: "PRIVATE TEST BODY REVISED" }, { kind: "user" });
  const newer = await memoryStore.propose({ scope: "project", repo, projectId: project.id, title: "New knowledge after crash", body: "PRIVATE TEST BODY NEW" }, { kind: "user" });
  const journal = await loadJournal(run.id, { strict: true });
  const replay = new TeamContext(run, new AbortController(), manager, journal);
  const repeated = await replay.projectMemory("coordinator");
  assert.equal(repeated.entries.length, 0, "do not inject updated or newly-created knowledge into a replayed turn");
  assert.ok(repeated.manifest.omitted.some((ref) => ref.id === original.id && ref.reason.includes("stale")));
  assert.deepEqual(run.memoryManifest!.included.map(({ id, revision }) => ({ id, revision })), [{ id: original.id, revision: original.revision }], "reset and reconstruct the projection without future worker references");
  const replayedWrite = await memoryStore.propose({ ...contractInput, derivedFrom: run.memoryManifest!.included.map(({ id, revision }) => ({ id, revision })) }, authority);
  assert.equal(replayedWrite.id, persistedBeforeJournal.id, "crash after durable write but before journaling does not duplicate or conflict");
  const repeatedWorker = await replay.projectMemory("builder", "task-b", ["src/b"]);
  assert.deepEqual(repeatedWorker.entries.map((entry) => entry.id), [b.id]);
  assert.ok(!run.memoryManifest!.included.some((ref) => ref.id === newer.id));
  const next = await replay.projectMemory("builder", "new-task");
  assert.ok(next.entries.some((entry) => entry.id === newer.id), "a genuinely new turn selects current context");
  const derived = await memoryStore.propose({ ...contractInput, operationId: "next-contract", derivedFrom: [{ id: original.id, revision: original.revision }] }, authority);
  assert.ok(derived.origins.some((source) => source.trust === "untrusted"), "older references retain the conservative provenance union after source edits");
  assert.doesNotMatch(await readFile(join(RUNS_DIR, `${run.id}.journal.jsonl`), "utf8"), /PRIVATE TEST BODY/);
});

test("Auto excludes legacy unknown-origin lessons at start and replay while preserving repository conventions and manual patterns", async () => {
  const poison = "LEGACY UNKNOWN ORIGIN INSTRUCTION";
  await recordFindings(repo, "old-untrusted-run-1", [{ severity: "high", problem: poison }]);
  await recordFindings(repo, "old-untrusted-run-2", [{ severity: "high", problem: poison }]);
  const manager = new Manager();
  const start = async (id: string) => {
    const run = await manager.start({ pattern: { id, name: "Memory test", summary: "", description: "", roles: [], options: [], run: async (ctx) => ctx.task }, repo, task: "Current user goal", roles: {}, options: {} });
    for (let i = 0; i < 100 && !run.endedAt; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(run.status, "done", run.error);
    return run;
  };
  const auto = await start("auto-team");
  assert.equal(auto.lessons, undefined);
  assert.doesNotMatch(auto.summary!, /LEGACY UNKNOWN/);
  const manual = await start("memory-manual-fixture");
  assert.match(manual.summary!, /LEGACY UNKNOWN/);
  // Old on-disk Auto snapshots may still carry lessons. Defense also belongs at prompt time.
  auto.lessons = [poison];
  auto.conventions = "TRUSTED REPOSITORY CONVENTION";
  const context = new TeamContext(auto, new AbortController(), manager);
  assert.doesNotMatch(context.task, /LEGACY UNKNOWN/);
  assert.match(context.task, /TRUSTED REPOSITORY CONVENTION/);
});
