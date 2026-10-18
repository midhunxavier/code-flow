import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const home = await mkdtemp(join(tmpdir(), "codeflow-auto-memory-home-"));
const repo = await realpath(await mkdtemp(join(tmpdir(), "codeflow-auto-memory-repo-")));
const records = await mkdtemp(join(tmpdir(), "codeflow-auto-memory-calls-"));
process.env.CODEFLOW_HOME = home;
process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
process.env.FAKE_RECORD_DIR = records;

const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { Projects } = await import("../src/projects.js");
const { memoryStore } = await import("../src/memory.js");
const { flushWrites } = await import("../src/store.js");
const manager = new RunManager(findPattern, new Projects());

after(async () => {
  await manager.shutdown();
  await flushWrites();
  await Promise.all([home, repo, records].map((path) => rm(path, { recursive: true, force: true })));
});

test("Auto planning and work reuse accepted project knowledge without unapproved or cross-project content", async () => {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  await mkdir(join(repo, ".codeflow"));
  await writeFile(join(repo, ".codeflow", "config.json"), JSON.stringify({ prove: false }));
  await writeFile(join(repo, "README.md"), "Empty input is valid.\n");
  await writeFile(join(repo, "sample.test.mjs"), 'import {test} from "node:test"; import assert from "node:assert/strict"; test("baseline",()=>assert.equal(1,1));\n');
  git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "initial");
  const projects = manager.projects!;
  await projects.load();
  const project = await projects.create({ name: "Current project", repos: [repo] });
  const otherProject = await projects.create({ name: "Other project, same repository", repos: [repo] });
  const accepted = await memoryStore.propose({ scope: "project", repo, projectId: project.id, title: "Approved API convention", body: "MEMORY_REUSE_ACCEPTED_GUIDANCE: retain explicit API compatibility." }, { kind: "user", repo, projectId: project.id });
  const pending = await memoryStore.propose({ scope: "project", repo, projectId: project.id, title: "Pending external suggestion", body: "MEMORY_UNTRUSTED_PENDING: this was not approved." }, { kind: "run", repo, projectId: project.id, runId: "prior-untrusted-run", lockedDown: true, sourceTrust: "untrusted" });
  const elsewhere = await memoryStore.propose({ scope: "project", repo, projectId: otherProject.id, title: "Other project's rule", body: "MEMORY_OTHER_PROJECT: keep this in its own project." }, { kind: "user", repo, projectId: otherProject.id });
  const run = await manager.start({
    pattern: findPattern("auto-team")!, repo, project: project.id, task: "Implement the sample",
    roles: { coordinator: ["claude"], pool: ["claude", "codex"] }, options: {},
    loop: { check: "node --test", maxSteps: 20 }, approvals: { plan: false },
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { unsubscribe(); reject(new Error(`Auto memory fixture timed out: ${run.status}: ${run.error ?? ""}`)); }, 30_000);
    const inspect = () => { if (run.endedAt) { clearTimeout(timeout); unsubscribe(); resolve(); } };
    const unsubscribe = manager.subscribe(run.id, inspect);
    inspect();
  });
  assert.equal(run.status, "done", run.error);
  assert.equal(run.team?.status, "completed", run.team?.gaps.join("; "));
  assert.equal(run.verdict, "passed");
  const calls = await Promise.all((await readdir(records)).map(async (file) => JSON.parse(await readFile(join(records, file), "utf8")) as { prompt: string }));
  const plan = calls.find((call) => call.prompt.includes("AUTO_TEAM_PLAN"));
  const worker = calls.find((call) => call.prompt.includes("AUTO_TEAM_TASK"));
  assert.ok(plan && worker, "actual fake-adapter planning and worker invocations must be captured");
  assert.match(plan.prompt, /MEMORY_REUSE_ACCEPTED_GUIDANCE/);
  assert.match(worker.prompt, /MEMORY_REUSE_ACCEPTED_GUIDANCE/);
  for (const { prompt } of calls) assert.doesNotMatch(prompt, /MEMORY_UNTRUSTED_PENDING|MEMORY_OTHER_PROJECT/);
  assert.ok(run.memoryManifest?.included.some((ref) => ref.id === accepted.id && ref.revision === accepted.revision));
  assert.ok(run.memoryManifest?.omitted.some((ref) => ref.id === pending.id && ref.reason === "unaccepted proposal"));
  assert.ok(!run.memoryManifest?.included.some((ref) => ref.id === pending.id || ref.id === elsewhere.id));
  assert.ok(!run.memoryManifest?.omitted.some((ref) => ref.id === elsewhere.id), "another project's IDs are not exposed in the context inspector");
  assert.ok(run.team!.contextManifests.some((manifest) => manifest.memoryIds.includes(`${accepted.id}@${accepted.revision}`)));
  assert.ok(run.steps.some((step) => step.taskId && step.contextManifest?.memoryIds.includes(`${accepted.id}@${accepted.revision}`)), "the executed worker step records its exact included revision");
});

test("shutdown flushes pending local and remote quota updates before workspace cleanup", async () => {
  manager.recordQuota("claude", "limited", { session: { utilization: 1, resetsAt: 12345 } });
  manager.recordQuota("codex", "limited", { session: { utilization: 1, resetsAt: 67890 } }, "remote-fixture");
  await manager.shutdown();
  assert.deepEqual(JSON.parse(await readFile(join(home, "quota.json"), "utf8")), manager.quota);
  assert.deepEqual(JSON.parse(await readFile(join(home, "remote-quota.json"), "utf8")), { "remote-fixture": manager.quotaForWorker("remote-fixture") });
});
