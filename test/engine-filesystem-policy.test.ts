import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Pattern, Run } from "../src/engine.js";
import type { FilePolicySnapshot } from "../src/filesystem-policy.js";

const home = mkdtempSync(join(tmpdir(), "cf-engine-policy-home-")); process.env.CODEFLOW_HOME = home;
const { RunManager } = await import("../src/engine.js"), { adapters } = await import("../src/adapters/index.js"), { flushWrites } = await import("../src/store.js");
const repos: string[] = [], managers: InstanceType<typeof RunManager>[] = [];
after(async () => { for (const manager of managers) await manager.shutdown(); await flushWrites(); for (const repo of repos) rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
const policy = (restricted: boolean): FilePolicySnapshot => ({ version: 1, projectId: "fixture", revision: restricted ? 1 : 0, hash: restricted ? "restricted" : "default", updatedAt: 0, read: { allow: ["."], deny: restricted ? ["private"] : [] }, write: { allow: ["."], deny: [] } });
function repo() { const path = mkdtempSync(join(tmpdir(), "cf-engine-policy-repo-")); repos.push(path); execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path }); mkdirSync(join(path, ".codeflow")); writeFileSync(join(path, ".codeflow/config.json"), JSON.stringify({ prove: false })); writeFileSync(join(path, "README.md"), "fixture"); execFileSync("git", ["add", "."], { cwd: path }); execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], { cwd: path }); return path; }
function manager(pattern: Pattern) { const value = new RunManager((id) => id === pattern.id ? pattern : undefined); managers.push(value); return value; }
function latch() { let resolve!: () => void; const promise = new Promise<void>((done) => resolve = done); return { promise, resolve }; }
async function finished(run: Run) { const deadline = Date.now() + 10_000; while (run.status === "running") { if (Date.now() > deadline) throw new Error("Fixture timed out"); await new Promise((done) => setTimeout(done, 10)); } return run; }

test("restrictive filesystem policy rejects full-trust native, remote and setup/check startup before execution", async () => {
  const path = repo(), marker = join(path, "MUST_NOT_RUN"); let workflowCalls = 0;
  const pattern: Pattern = { id: "fixture", name: "Fixture", summary: "", description: "", roles: [], options: [], run: async () => { workflowCalls++; return "forbidden"; } };
  const value = manager(pattern); value.setFilesystemPolicyGuard(async () => [policy(true)]);
  const input = { repo: path, pattern, task: "policy fixture", roles: { agent: ["claude" as const] }, options: {}, trust: "full" as const, loop: { setup: `touch '${marker}'`, check: `touch '${marker}'`, copy: [] } };
  await assert.rejects(value.start(input), /cannot enforce/);
  await assert.rejects(value.start({ ...input, loop: { ...input.loop, remoteWorker: { workerId: "unprobed", repoMapping: "fixture" } } }), /cannot enforce/);
  assert.equal(workflowCalls, 0); assert.equal(value.list().length, 0); assert.equal(existsSync(marker), false);
});

test("fresh restrictions are rechecked at native agent and host check dispatch; pinned restrictions survive relaxation", async () => {
  const nativeRun = adapters.claude.run; let invocations = 0; adapters.claude.run = async () => { invocations++; throw new Error("must not dispatch"); };
  try {
    for (const surface of ["agent", "check"] as const) {
      const path = repo(), entered = latch(), release = latch(), marker = join(path, "MUST_NOT_RUN"); let restrictive = false;
      const pattern: Pattern = { id: `fixture-${surface}`, name: "Fixture", summary: "", description: "", roles: [], options: [], run: async (ctx) => { const tree = await ctx.worktree("fixture"); entered.resolve(); await release.promise; if (surface === "agent") await ctx.ask({ title: "Blocked native turn", role: "agent", agent: "claude", cwd: tree, mode: "write", prompt: "must not execute" }); else await ctx.check(tree); return "forbidden"; } };
      const value = manager(pattern); value.setFilesystemPolicyGuard(async () => [policy(restrictive)]);
      const run = await value.start({ repo: path, pattern, task: "policy fixture", roles: { agent: ["claude"] }, options: {}, loop: { copy: [], check: `touch '${marker}'`, maxSteps: 5 } });
      await entered.promise; assert.deepEqual(run.filePolicies, [policy(false)]); restrictive = true; release.resolve(); await finished(run);
      assert.equal(run.status, "failed"); assert.match(run.error!, /cannot enforce/); assert.equal(invocations, 0); assert.equal(existsSync(marker), false);
      restrictive = false; run.filePolicies = [policy(true)]; await assert.rejects(value.resume(run.id), /cannot enforce/);
    }
  } finally { adapters.claude.run = nativeRun; }
});
