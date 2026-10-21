import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "codeflow-remote-engine-")); process.env.CODEFLOW_HOME = join(root, "engine-home");
// Everything from src (the fixture loads it too) is imported after CODEFLOW_HOME is set, or runs land in ~/.codeflow.
const { git, remoteWorkerFixture } = await import("./remote-worker-fixture.js"), { CODEFLOW_HOME } = await import("../src/config.js");
assert.equal(CODEFLOW_HOME, process.env.CODEFLOW_HOME, "src/config.js loaded before CODEFLOW_HOME was set");
const { RunManager } = await import("../src/engine.js"), { findPattern } = await import("../src/patterns/index.js"), { adapters } = await import("../src/adapters/index.js"), { flushWrites } = await import("../src/store.js");
type Run = import("../src/engine.js").Run;
const managers: InstanceType<typeof RunManager>[] = [];
after(async () => { for (const manager of managers) await manager.shutdown(); await flushWrites(); rmSync(root, { recursive: true, force: true }); });
async function fixture() { const f = await remoteWorkerFixture(root); mkdirSync(join(f.source, ".codeflow")); writeFileSync(join(f.source, ".codeflow/config.json"), JSON.stringify({ prove: false })); git(f.source, "add", ".codeflow"); git(f.source, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "disable fixture proof"); return f; }
async function finished(run: Run) { const deadline = Date.now() + 25_000; while (run.status === "running") { if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(run)}`); await new Promise((accept) => setTimeout(accept, 25)); } return run; }
const input = (f: Awaited<ReturnType<typeof fixture>>) => ({ repo: f.source, pattern: findPattern("solo")!, task: "WRITE", roles: { agent: ["claude" as const] }, options: {}, trust: "safe" as const, context: { attachments: [{ name: "reference.txt", data: Buffer.from("explicit staged reference").toString("base64") }] }, loop: { remoteWorker: { workerId: "fixture", repoMapping: "project" }, copy: [], check: "true", maxSteps: 4, maxMinutes: 1 } });

test("engine uses worker inventory, imports the exact commit and journals only public receipt metadata", async () => {
  const f = await fixture(), manager = new RunManager(findPattern, undefined, f.workers); managers.push(manager); let hostCalls = 0;
  const hostRun = adapters.claude.run, hostAvailable = adapters.claude.available; adapters.claude.run = async () => { hostCalls++; throw new Error("host fallback forbidden"); }; adapters.claude.available = async () => false;
  try {
    manager.recordQuota("claude", "limited", {}); const run = await finished(await manager.start({ ...input(f), permissionRequirements: ["no-external-tools"] })); assert.equal(run.status, "done", run.error); assert.equal(hostCalls, 0);
    assert.deepEqual(run.permissions?.required, ["no-external-tools"]);
    const remoteArgs = JSON.parse(readFileSync(f.audit, "utf8").trim().split("\n")[0]!).args as string[];
    for (const flag of ["--strict-mcp-config", "--no-chrome", "--disallowedTools"]) assert.ok(remoteArgs.includes(flag), `remote launch missing ${flag}`);
    assert.ok(remoteArgs.some(arg => arg.includes("WebFetch") && arg.includes("Agent"))); assert.equal(manager.quotaForWorker("fixture").claude, undefined); assert.equal(run.lastCheck?.ok, true);
    const step = run.steps.find((step) => step.kind === "agent")!; assert.equal(step.remote?.state, "completed"); assert.equal(step.sessionId, undefined); assert.ok(step.remote?.resultHead); assert.ok(run.summary?.includes("Changes on"));
    const tree = run.worktrees[0]!; assert.equal(git(tree.path, "rev-parse", "HEAD"), step.remote?.resultHead); assert.equal(readFileSync(join(tree.path, "result.txt"), "utf8"), "local exact base\nexplicit staged reference");
    const privateRecord = JSON.parse(readFileSync(join(f.home, "remote-worker-private", `${step.remote!.requestId}.json`), "utf8")); const exported = JSON.stringify({ run, events: await manager.events(run.id) }); assert.equal(exported.includes(privateRecord.capability), false); assert.equal(exported.includes("result.bundle"), false);
    const inspected = await manager.inspectRemoteStep(run.id, step.id); assert.equal(inspected.remote.state, "completed"); assert.equal(JSON.stringify(inspected).includes("artifact"), false);
  } finally { adapters.claude.run = hostRun; adapters.claude.available = hostAvailable; }
});

test("ambiguous execution stops, owner inspection enables receipt recovery and resume never relaunches", async () => {
  const f = await fixture(), manager = new RunManager(findPattern, undefined, f.workers); managers.push(manager); const execute = f.workers.execute.bind(f.workers);
  f.workers.execute = async (...args) => { const result = await execute(...args); if (result.artifact) await f.workers.discardArtifact(result.artifact); return { ...result, artifact: undefined, ok: false, error: "Fixture dropped after durable completion", remote: { ...result.remote, state: "unknown", ambiguous: true } }; };
  const run = await finished(await manager.start(input(f))); assert.equal(run.status, "stopped", run.error); assert.match(run.stopReason!, /ambiguous remote/); await assert.rejects(manager.resume(run.id), /Inspect or cancel/);
  await assert.rejects(manager.withIdleExecution(async () => {}), /unresolved remote receipt/);
  const original = run.steps.find((step) => step.remote)!; await manager.inspectRemoteStep(run.id, original.id); assert.equal(original.remote?.state, "completed");
  await manager.withIdleExecution(async () => {});
  await finished(await manager.resume(run.id)); assert.equal(run.status, "done", run.error); assert.equal(readFileSync(f.audit, "utf8").trim().split("\n").length, 1);
  const recovered = run.steps.filter((step) => step.remote).at(-1)!; assert.equal(recovered.remote?.recovered, true); assert.equal(recovered.invocations ?? 0, 0); assert.ok(run.lastCheck?.ok);
});

test("replayed repeated ask titles keep the unfinished invocation identity rather than reusing an earlier receipt", async () => {
  const f = await fixture(); const pattern: import("../src/engine.js").Pattern = { ...findPattern("solo")!, id: "remote-repeat", async run(ctx) { const wt = await ctx.worktree("repeat"); for (let index = 0; index < 2; index++) { await ctx.ask({ title: "Repeated ask", role: "agent", agent: "claude", mode: "write", cwd: wt, prompt: `WRITE ${index}` }); await ctx.commit(wt, `turn ${index}`); } await ctx.artifact("Result", wt); return "Completed repeated turns"; } };
  const manager = new RunManager((id) => id === pattern.id ? pattern : findPattern(id), undefined, f.workers); managers.push(manager); const execute = f.workers.execute.bind(f.workers); let calls = 0;
  f.workers.execute = async (...args) => { if (++calls === 2) throw new Error("Fixture interrupted before private acceptance"); return execute(...args); };
  const run = await finished(await manager.start({ ...input(f), pattern })); assert.equal(run.status, "failed"); await finished(await manager.resume(run.id)); assert.equal(run.status, "done", run.error); assert.equal(readFileSync(f.audit, "utf8").trim().split("\n").length, 2);
  assert.equal(new Set(run.steps.filter((step) => step.remote).map((step) => step.remote!.requestId)).size, 2);
});

test("remote starts reject unavailable providers, native approvals, host container settings and copied files", async () => {
  const f = await fixture(), manager = new RunManager(findPattern, undefined, f.workers); managers.push(manager);
  await assert.rejects(manager.start({ ...input(f), roles: { agent: ["codex"] } }), /unavailable on the selected remote worker/);
  await assert.rejects(manager.start({ ...input(f), approvals: { tools: true } }), /interactive approvals/);
  await assert.rejects(manager.start({ ...input(f), loop: { ...input(f).loop, agentContainer: { image: "fixture" } } }), /worker-local container/);
  await assert.rejects(manager.start({ ...input(f), loop: { ...input(f).loop, copy: [".env"] } }), /copied workspace files/);
});
