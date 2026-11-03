import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Candidate, Node } from "../src/cli-teams/model.js";
import type { Run } from "../src/engine.js";

const home = mkdtempSync(join(tmpdir(), "codeflow-cli-team-"));
process.env.CODEFLOW_HOME = home;
process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
process.env.CODEFLOW_RETRY_DELAYS_MS = "0";
const { RunManager } = await import("../src/engine.js");
const { findPattern, patterns } = await import("../src/patterns/index.js");
const { adapters } = await import("../src/adapters/index.js");
const { CliTeamsService } = await import("../src/cli-teams/service.js");
const { CLI_TOOLS } = await import("../src/cli-teams/tools.js");
const { validateCandidate, digest } = await import("../src/cli-teams/model.js");
const { installProject, uninstallProject } = await import("../src/cli-teams/install.js");
const { captureSource } = await import("../src/cli-teams/snapshots.js");
const { flushWrites, journalEntry } = await import("../src/store.js");
const { startCliTeamsTransport } = await import("../src/cli-teams/transport.js");
const { recoverCliAccounting } = await import("../src/cli-teams/accounting.js");
const managers: InstanceType<typeof RunManager>[] = [], repos: string[] = [];
const original = { claude: adapters.claude.run, codex: adapters.codex.run };
const pause = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
after(async () => { adapters.claude.run = original.claude; adapters.codex.run = original.codex; for (const manager of managers) await manager.shutdown(); await flushWrites(); for (const repo of repos) rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
function repo() {
  const p = mkdtempSync(join(tmpdir(), "codeflow-cli-repo-")); repos.push(p);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: p });
  writeFileSync(join(p, "app.mjs"), "export const value = 1;\n");
  writeFileSync(join(p, "app.test.mjs"), "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from './app.mjs'; test('value',()=>assert.equal(value,2));\n");
  execFileSync("git", ["add", "."], { cwd: p });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "initial"], { cwd: p }); return p;
}
function planning(final = false): Candidate {
  const steps: Node[] = [
    { id: "draft", type: "task", operation: "propose", participant: "author", instructions: "DRAFT: propose or revise the login plan" },
    { id: "reviews", type: "parallel", tasks: [
      { id: "author-vote", type: "task", operation: "review_plan", participant: "author", instructions: "AUTHOR: endorse this exact plan if sound", inputs: ["draft"] },
      { id: "peer-vote", type: "task", operation: "review_plan", participant: "peer", instructions: "PEER: independently review this plan", inputs: ["draft"] },
    ] },
    { id: "agreement", type: "gate", policy: "agreement", target: "draft", reviews: ["author-vote", "peer-vote"] },
  ];
  if (final) steps.push({ id: "final-review", type: "task", operation: "review_plan", participant: "final", instructions: "FINAL: independent final review", inputs: ["draft"] }, { id: "final-gate", type: "gate", policy: "agreement", target: "draft", reviews: ["final-review"] });
  return { scope: "plan", participants: [{ id: "author", provider: "claude", model: "opus", effort: "high" }, { id: "peer", provider: "codex" }, ...(final ? [{ id: "final", provider: "claude" as const, model: "opus", effort: "max" }] : [])], completion: ["Both agents accept the same login plan"], steps: [{ id: "converge", type: "loop", maxIterations: 3, steps }, { id: "deliver", type: "finish", outcome: "agreed_plan", inputs: ["draft", "agreement", ...(final ? ["final-gate"] : [])] }] };
}
function building(): Candidate {
  return { scope: "write", participants: [{ id: "builder", provider: "codex" }, { id: "reviewer", provider: "claude" }], check: "node --test app.test.mjs", completion: ["value is 2 and its regression test passes"], steps: [
    { id: "build", type: "task", operation: "implement", participant: "builder", instructions: "Set value to 2" },
    { id: "check", type: "task", operation: "verify", instructions: "Run regression test" },
    { id: "review", type: "task", operation: "review_code", participant: "reviewer", instructions: "Review implementation and tests", inputs: ["build"] },
    { id: "gate", type: "gate", policy: "verified", target: "build", reviews: ["review"], verification: "check" },
    { id: "result", type: "finish", outcome: "verified_changes", inputs: ["build", "gate", "check", "review"] },
  ] };
}
let operation = 0;
async function setup(p = repo()) {
  const manager = new RunManager(findPattern); managers.push(manager);
  const service = new CliTeamsService(manager); await service.load();
  const connection = await service.connect(p);
  const call = (name: string, args: object = {}) => service.call(connection, `codeflow_${name}`, { ...args, ...(CLI_TOOLS.find(t => t.name === `codeflow_${name}`)?.annotations.readOnlyHint ? {} : { operationId: `test-${++operation}` }) }) as Promise<any>;
  return { manager, service, connection, call, repo: p };
}
async function start(f: Awaited<ReturnType<typeof setup>>, candidate = planning()) {
  const proposal = await f.call("propose_run", { task: "Design a login form", candidate });
  await f.service.accept(f.connection, proposal.proposalId, proposal.revision, proposal.proposalHash);
  const { runId } = await f.call("start_run", { proposalId: proposal.proposalId, expectedRevision: proposal.revision, proposalHash: proposal.proposalHash });
  return f.manager.get(runId)!;
}
async function finished(run: Run) { for (let i = 0; i < 1500 && run.status === "running"; i++) await pause(); assert.notEqual(run.status, "running", run.error); }
async function mcpPeer(f: Awaited<ReturnType<typeof setup>>, capabilities: object) {
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../src/cli-teams/cli.ts", import.meta.url)), "mcp", "--project-root", f.repo], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>(), prompts: any[] = [];
  let sequence = 0, buffered = "";
  const send = (message: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  child.stdout.on("data", chunk => {
    buffered += chunk; let end: number;
    while ((end = buffered.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffered.slice(0, end)); buffered = buffered.slice(end + 1);
      if (message.method === "elicitation/create") { prompts.push(message); continue; }
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); clearTimeout(waiter.timer); message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result); }
    }
  });
  const request = (method: string, params: object) => {
    const id = ++sequence;
    return { id, result: new Promise<any>((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timed out`)); }, 15000); pending.set(id, { resolve, reject, timer }); send({ id, method, params }); }) };
  };
  await request("initialize", { protocolVersion: "2025-11-25", capabilities }).result;
  return {
    child, send, prompts,
    call: (name: string, args: object = {}) => request("tools/call", { name: `codeflow_${name}`, arguments: args }),
    async prompt() { for (let i = 0; i < 1000 && !prompts.length; i++) await pause(); assert.ok(prompts.length, "expected native confirmation"); return prompts.shift(); },
    async close() { child.stdin.end(); for (let i = 0; i < 500 && child.exitCode === null; i++) await pause(); if (child.exitCode === null) child.kill("SIGTERM"); for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("MCP fixture closed")); } pending.clear(); },
  };
}
function stub(fn?: typeof adapters.claude.run) {
  const worker: typeof adapters.claude.run = fn ?? (async opts => ({ ok: true, finalText: opts.jsonSchema ? JSON.stringify({ body: "Reviewed with evidence", verdict: "approve", findings: [] }) : "Plan: accessible labels, validation, keyboard focus, and tests." }));
  adapters.claude.run = worker; adapters.codex.run = worker;
}

test("UX01/02/14: strict task-generated contracts expose ten tools and leave the web picker unchanged", () => {
  assert.equal(CLI_TOOLS.length, 10); assert.equal(new Set(CLI_TOOLS.map(t => t.name)).size, 10);
  assert.ok(!CLI_TOOLS.some(t => /team|preset/.test(t.name)));
  assert.ok(!patterns.some(p => p.id === "cli-team")); assert.ok(findPattern("cli-team"));
  assert.deepEqual(validateCandidate(planning()), planning());
  assert.throws(() => validateCandidate({ ...planning(), teamRef: "feature" }), /unknown field/);
  assert.throws(() => validateCandidate({ ...planning(), limits: { concurrency: 99 } }), /invalid number/);
  assert.throws(() => validateCandidate({ ...planning(), steps: [{ id: "bad", type: "script", body: "process.exit()" }] }), /Unknown/);
});

test("structured blocking findings reach the next author and the final result contains one canonical plan", async () => {
  const f = await setup(); let drafts = 0;
  stub(async opts => {
    if (!opts.jsonSchema) {
      drafts++;
      if (drafts > 1) assert.match(opts.prompt, /BLOCKER_ONLY_IN_STRUCTURED_FINDINGS/);
      return { ok: true, finalText: `Canonical plan revision ${drafts}` };
    }
    const rejected = drafts === 1 && opts.prompt.includes("PEER:");
    return { ok: true, finalText: JSON.stringify({ body: "Review details remain in the evidence record.", verdict: rejected ? "changes_requested" : "approve", findings: rejected ? ["BLOCKER_ONLY_IN_STRUCTURED_FINDINGS"] : [] }) };
  });
  const run = await start(f); await finished(run);
  assert.equal(run.cliTeam!.outcome, "agreed_plan", run.error);
  assert.equal(drafts, 2);
  const result = Object.values(run.cliTeam!.artifacts).find(a => a.kind === "result")!;
  assert.equal(result.body, "Canonical plan revision 2");
  assert.ok(result.data.primary);
  assert.ok(Array.isArray(result.data.artifacts));
  assert.doesNotMatch(result.body, /Review details|Canonical plan revision 1/);
});

test("working-copy snapshots include staged additions and deletions without changing the user's index", async () => {
  const path = repo();
  writeFileSync(join(path, "new-file.txt"), "new staged implementation\n");
  execFileSync("git", ["add", "new-file.txt"], { cwd: path });
  execFileSync("git", ["rm", "--cached", "app.mjs"], { cwd: path });
  const index = readFileSync(join(path, ".git/index")), status = execFileSync("git", ["status", "--porcelain=v1"], { cwd: path, encoding: "utf8" });
  const source = await captureSource(path, "working_changes");
  assert.match(execFileSync("git", ["show", `${source.commit}:new-file.txt`], { cwd: path, encoding: "utf8" }), /new staged implementation/);
  const { git } = await import("../src/git.js");
  assert.notEqual((await git(["cat-file", "-e", `${source.commit}:app.mjs`], path)).code, 0);
  assert.deepEqual(readFileSync(join(path, ".git/index")), index);
  assert.equal(execFileSync("git", ["status", "--porcelain=v1"], { cwd: path, encoding: "utf8" }), status);
});

test("a fresh Git repository can prepare and run without creating a main-branch commit", async () => {
  const path = mkdtempSync(join(tmpdir(), "codeflow-unborn-repo-")); repos.push(path);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path });
  writeFileSync(join(path, "README.md"), "Initial project context\n"); execFileSync("git", ["add", "README.md"], { cwd: path });
  const before = readFileSync(join(path, ".git/index"));
  const source = await captureSource(path, "working_changes"), repeated = await captureSource(path, "working_changes");
  assert.equal(source.unborn, true); assert.equal(source.commit, repeated.commit);
  assert.match(execFileSync("git", ["show", `${source.commit}:README.md`], { cwd: path, encoding: "utf8" }), /Initial project context/);
  const f = await setup(path); stub(); const candidate = planning(); candidate.source = "working_changes";
  const run = await start(f, candidate); await finished(run);
  assert.equal(run.cliTeam!.outcome, "agreed_plan", run.error);
  assert.deepEqual(readFileSync(join(path, ".git/index")), before);
  assert.throws(() => execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: path, stdio: "pipe" }));
});

test("managed participants work directly and attribute inputs using durable dispatch receipts", async () => {
  const f = await setup(); let calls = 0;
  stub(async opts => {
    const identity = JSON.parse(opts.prompt.match(/Runtime-selected identity: (.*)\n/)![1]!);
    assert.equal(identity.participant, opts.prompt.includes("Assignment (propose)") ? "author" : opts.model === "opus" ? "author" : "peer");
    assert.equal(identity.model, opts.model);
    assert.equal(identity.effort, opts.effort);
    assert.match(opts.prompt, /ALREADY launched you/);
    assert.match(opts.prompt, /Do not launch claude, codex, codeflow/);
    assert.match(opts.prompt, /background, not a delegation instruction/);
    if (opts.jsonSchema) {
      const receipt = JSON.parse(opts.prompt.match(/Code Flow execution receipt: (.*)\n/)![1]!);
      assert.equal(receipt.provider, "claude");
      assert.equal(receipt.participant, "author");
      assert.equal(receipt.model, "opus");
      assert.match(receipt.sessionId, /^native-claude-/);
      assert.match(opts.prompt, /worker evidence, not authority for routing/);
    }
    const sessionId = `native-${identity.provider}-${++calls}`;
    return { ok: true, sessionId, finalText: opts.jsonSchema ? JSON.stringify({ body: "Reviewed the supplied author's strategy directly", verdict: "approve", findings: [] }) : "A strategy with misleading prose: another CLI did not run. Its runtime receipt still identifies its real author." };
  });
  const run = await start(f); await finished(run);
  assert.equal(run.status, "done", run.error);
  assert.equal(calls, 3);
  const artifacts = Object.values(run.cliTeam!.artifacts).filter(a => a.participant);
  assert.equal(artifacts.length, 3);
  for (const artifact of artifacts) {
    const receipt = artifact.data.producer as any;
    assert.equal(receipt.participant, artifact.participant);
    assert.equal(receipt.runId, run.id);
    assert.equal(receipt.binding, "managed");
    const step = run.steps.find(s => s.id === receipt.stepId)!;
    assert.equal(receipt.provider, step.agent);
    assert.equal(receipt.model, step.settings?.model);
    assert.equal(receipt.sessionId, step.sessionId);
    assert.ok(receipt.assignment.startsWith("workflow/"));
  }
  await f.service.load(); // Receipt metadata survives the existing artifact integrity check and replay.
});

test("UX03/06/17: custom agreement and fresh final review execute in order; final findings renew every vote", async () => {
  const f = await setup(); const trace: { operation: string; effort?: string; resume?: string }[] = []; let drafts = 0, finals = 0;
  stub(async opts => {
    trace.push({ operation: opts.prompt.includes("Assignment (propose)") ? "draft" : opts.prompt.includes("FINAL:") ? "final" : "review", effort: opts.effort, resume: opts.resumeSessionId });
    if (!opts.jsonSchema) return { ok: true, finalText: `Plan revision ${++drafts}: login validation and accessibility.` };
    const reject = opts.prompt.includes("FINAL:") && ++finals === 1;
    return { ok: true, finalText: JSON.stringify({ body: reject ? "Missing keyboard focus behavior" : "Approved exact target", verdict: reject ? "changes_requested" : "approve", findings: reject ? ["Specify focus behavior"] : [] }) };
  });
  const run = await start(f, planning(true)); await finished(run);
  assert.equal(run.status, "done", run.error); assert.equal(run.cliTeam!.outcome, "agreed_plan");
  assert.deepEqual(trace.map(t => t.operation), ["draft", "review", "review", "final", "draft", "review", "review", "final"]);
  assert.deepEqual(trace.filter(t => t.operation === "final").map(t => t.effort), ["max", "max"]);
  assert.ok(trace.every(t => !t.resume)); assert.ok(run.summary?.includes("revision 2"));
});

test("UX04/05: unsupported pins block before launch; project preferences resolve explicitly", async () => {
  const f = await setup(); let launched = 0; stub(async () => { launched++; return { ok: true, finalText: "unused" }; });
  const bad = planning(); bad.participants[0]!.effort = "imaginary";
  await assert.rejects(f.call("propose_run", { task: "plan", candidate: bad }), /does not advertise/);
  assert.equal(launched, 0);
  mkdirSync(join(f.repo, ".codeflow")); writeFileSync(join(f.repo, ".codeflow/cli-teams.json"), JSON.stringify({ preferences: { providers: { claude: { model: "sonnet", effort: "low" } } } }));
  const proposal = await f.call("propose_run", { task: "plan", candidate: planning() });
  assert.equal(proposal.definition.participants[0].model, "opus"); assert.equal(proposal.definition.participants[0].effort, "high"); assert.equal(proposal.definition.participants[0].provenance.model, "task");
  const host = planning(); host.participants[0] = { id: "author", provider: "claude", binding: "current_session" };
  const hostProposal = await f.call("propose_run", { task: "Plan with this conversation and a managed peer", candidate: host });
  assert.equal(hostProposal.definition.participants[0].model, undefined, "managed preferences cannot pin the host conversation");
  assert.match(hostProposal.preview, /host-reported, unverified/);
  host.participants[0]!.effort = "high";
  await assert.rejects(f.call("propose_run", { task: "plan", candidate: host }), /current session.*cannot be verified/);
  delete host.participants[0]!.effort; host.participants[1]!.binding = "current_session";
  assert.throws(() => validateCandidate(host), /only one participant/);
});

test("UX07: nonconverging reviewers stop with usable artifacts and no unreviewed revision", async () => {
  const f = await setup(); let drafts = 0;
  stub(async opts => ({ ok: true, finalText: opts.jsonSchema ? JSON.stringify({ body: "Validation is underspecified", verdict: "changes_requested", findings: ["Specify empty inputs"] }) : `Draft ${++drafts}` }));
  const run = await start(f); await finished(run);
  assert.equal(run.status, "stopped"); assert.equal(drafts, 3); assert.equal(run.cliTeam!.outcome, "stopped_limit");
  const results = Object.values(run.cliTeam!.artifacts).filter(a => a.kind === "result"); assert.equal(results.length, 1); assert.match(results[0]!.body, /underspecified/);
  await assert.rejects(f.call("control_run", { runId: run.id, action: "resume" }), /new proposal/);
});

test("UX08: edited proposals invalidate acceptance; starts are idempotent without another run", async () => {
  const f = await setup(); stub();
  const first = await f.call("propose_run", { task: "plan", candidate: planning() });
  await assert.rejects(f.call("start_run", { proposalId: first.proposalId, expectedRevision: first.revision, proposalHash: first.proposalHash }), /Accept this proposal/);
  await f.service.accept(f.connection, first.proposalId, first.revision, first.proposalHash);
  const next = await f.call("propose_run", { task: "revised plan", candidate: planning(), proposalId: first.proposalId, expectedRevision: first.revision });
  await assert.rejects(f.call("start_run", { proposalId: first.proposalId, expectedRevision: first.revision, proposalHash: first.proposalHash }), /changed/);
  await assert.rejects(f.call("start_run", { proposalId: next.proposalId, expectedRevision: next.revision, proposalHash: next.proposalHash }), /Accept/);
  await f.service.accept(f.connection, next.proposalId, next.revision, next.proposalHash);
  const args = { operationId: "stable-start", proposalId: next.proposalId, expectedRevision: next.revision, proposalHash: next.proposalHash };
  const started = await f.service.call(f.connection, "codeflow_start_run", args);
  assert.deepEqual(await f.service.call(f.connection, "codeflow_start_run", args), started);
  await assert.rejects(f.service.call(f.connection, "codeflow_start_run", { ...args, proposalHash: "changed" }), /different arguments/);
  assert.equal(f.manager.list().length, 1); await finished(f.manager.get((started as any).runId)!);
});

test("UX09: implementation uses one owned writer, actual command evidence, and independent review", async () => {
  const f = await setup();
  stub(async opts => { if (opts.mode === "write") writeFileSync(join(opts.cwd, "app.mjs"), "export const value = 2;\n"); return { ok: true, finalText: opts.jsonSchema ? JSON.stringify({ body: "Diff and tests meet the task", verdict: "approve", findings: [] }) : "Implemented value 2" }; });
  const c: Candidate = { scope: "write", participants: [{ id: "builder", provider: "codex" }, { id: "reviewer", provider: "claude" }], check: "node --test app.test.mjs", completion: ["value is 2 and its regression test passes"], steps: [
    { id: "build", type: "task", operation: "implement", participant: "builder", instructions: "Set value to 2" },
    { id: "check", type: "task", operation: "verify", instructions: "Run regression test" },
    { id: "review", type: "task", operation: "review_code", participant: "reviewer", instructions: "Review implementation and tests", inputs: ["build"] },
    { id: "gate", type: "gate", policy: "verified", target: "build", reviews: ["review"], verification: "check" },
    { id: "result", type: "finish", outcome: "verified_changes", inputs: ["build", "gate", "check", "review"] },
  ] };
  const run = await start(f, c); await finished(run); assert.equal(run.status, "done", run.error); assert.equal(run.cliTeam!.outcome, "verified_changes");
  assert.match(readFileSync(join(f.repo, "app.mjs"), "utf8"), /1/); assert.match(readFileSync(join(run.worktrees[0]!.path, "app.mjs"), "utf8"), /2/);
  assert.ok(run.steps.some(s => s.kind === "check" && s.status === "done"));
});

test("UX11/12: host assignment fencing, disconnect/attach, and exact-target submission", async () => {
  const f = await setup(); stub(); const c = planning(); c.participants[1] = { id: "peer", provider: "codex", binding: "current_session" };
  const run = await start(f, c);
  for (let i = 0; i < 500 && !Object.keys(run.cliTeam!.pending).length; i++) await pause();
  const ready = await f.call("get_run", { runId: run.id }); assert.equal(ready.status, "waiting_host");
  const assignment = ready.assignments[0]; assert.ok(assignment);
  const claim = await f.call("claim_step", { runId: run.id, stepId: assignment.id, attemptId: assignment.attemptId });
  f.service.disconnect(f.connection);
  const connection = await f.service.connect(f.repo);
  await assert.rejects(f.service.call(connection, "codeflow_submit_step", { operationId: "host-stale", runId: run.id, stepId: assignment.id, attemptId: assignment.attemptId, claimToken: claim.claimToken, output: { body: "Reviewed", verdict: "approve", findings: [] } }), /not available/);
  await f.service.attach(connection, run.id, connection.id);
  const newClaim: any = await f.service.call(connection, "codeflow_claim_step", { operationId: "new-host-claim", runId: run.id, stepId: assignment.id, attemptId: assignment.attemptId });
  await f.service.call(connection, "codeflow_submit_step", { operationId: "new-host-submit", runId: run.id, stepId: assignment.id, attemptId: assignment.attemptId, claimToken: newClaim.claimToken, output: { body: "Reviewed exact plan", verdict: "approve", findings: [] } });
  await finished(run); assert.equal(run.status, "done", run.error);
});

test("UX13: result pagination preserves multi-byte content and exact artifact hashes", async () => {
  const f = await setup(); const content = "Login 🔑 accessibility\n".repeat(2000);
  stub(async opts => ({ ok: true, finalText: opts.jsonSchema ? JSON.stringify({ body: "Approved", verdict: "approve", findings: [] }) : content }));
  const run = await start(f); await finished(run); assert.equal(run.status, "done", run.error);
  const result = Object.values(run.cliTeam!.artifacts).find(a => a.kind === "result")!; let cursor: number | undefined = 0, full = "";
  do { const page: any = await f.call("get_artifact", { runId: run.id, artifactId: result.id, sha256: result.sha256, cursor, maxBytes: 257 }); full += page.body; cursor = page.nextCursor; } while (cursor !== undefined);
  assert.equal(full, result.body); assert.ok(full.includes(content));
  await assert.rejects(f.call("get_artifact", { runId: run.id, artifactId: result.id, sha256: "wrong" }), /exact artifact/);
});

test("UX16: dirty source capture preserves index bytes and includes only selected untracked files", async () => {
  const p = repo(); writeFileSync(join(p, "app.mjs"), "export const value = 3;\n"); execFileSync("git", ["add", "app.mjs"], { cwd: p }); writeFileSync(join(p, "app.mjs"), "export const value = 4;\n");
  writeFileSync(join(p, "selected.txt"), "include me"); writeFileSync(join(p, "private.txt"), "exclude me");
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: p }), index = readFileSync(join(p, ".git/index"));
  const captured = await captureSource(p, "working_changes", ["selected.txt"]);
  assert.deepEqual(readFileSync(join(p, ".git/index")), index); assert.deepEqual(execFileSync("git", ["status", "--porcelain"], { cwd: p }), status);
  const files = execFileSync("git", ["ls-tree", "--name-only", captured.commit], { cwd: p, encoding: "utf8" }); assert.match(files, /selected/); assert.doesNotMatch(files, /private/);
  assert.match(execFileSync("git", ["show", `${captured.commit}:app.mjs`], { cwd: p, encoding: "utf8" }), /4/);
});

test("installer is transactional, idempotent, and preserves unrelated/user-edited configuration", async () => {
  const p = repo(); mkdirSync(join(p, ".codex")); writeFileSync(join(p, ".codex/config.toml"), 'model = "existing"\n[mcp_servers.other]\ncommand = "other"\n'); writeFileSync(join(p, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "other" } } }));
  const dry = await installProject(p, ["claude", "codex"], true); assert.ok(dry.changes.length); assert.ok(!existsSync(join(p, ".agents")));
  await installProject(p, ["claude", "codex"]); assert.equal((await installProject(p, ["claude", "codex"])).changes.length, 0);
  const skill = join(p, ".agents/skills/codeflow/SKILL.md"); writeFileSync(skill, readFileSync(skill, "utf8") + "\nUser customization\n");
  const removed = await uninstallProject(p); assert.ok(removed.preserved.includes(".agents/skills/codeflow/SKILL.md")); assert.ok(existsSync(join(p, ".codeflow/cli-teams.json")));
  assert.equal(readFileSync(join(p, ".codex/config.toml"), "utf8"), 'model = "existing"\n[mcp_servers.other]\ncommand = "other"\n'); assert.deepEqual(JSON.parse(readFileSync(join(p, ".mcp.json"), "utf8")), { mcpServers: { other: { command: "other" } } });
  const broken = repo(); mkdirSync(join(broken, ".codex")); writeFileSync(join(broken, ".codex/config.toml"), "invalid = [");
  await assert.rejects(installProject(broken, ["claude", "codex"])); assert.ok(!existsSync(join(broken, ".mcp.json")), "all files validated before mutation");
});

test("project-scoped loopback and stdio MCP negotiate and deny owner-tool expansion", async () => {
  const f = await setup(); const bridge = await startCliTeamsTransport(f.service);
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../src/cli-teams/cli.ts", import.meta.url)), "mcp", "--project-root", f.repo], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  try {
    let stdout = "", stderr = ""; child.stdout.on("data", c => stdout += c); child.stderr.on("data", c => stderr += c);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }) + "\n");
    for (let i = 0; i < 200 && !stdout.includes('"id":1'); i++) await pause();
    assert.match(stdout, /2025-03-26/, stderr);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    for (let i = 0; i < 200 && !stdout.includes('"id":2'); i++) await pause();
    const response = stdout.trim().split("\n").map(s => JSON.parse(s)).find(r => r.id === 2); assert.equal(response.result.tools.length, 10);
    const denied = await fetch(`${bridge.descriptor.endpoint}/call`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.invalid", authorization: `Bearer ${bridge.descriptor.bootstrap}` }, body: "{}" }); assert.equal(denied.status, 403);
  } finally { child.stdin.end(); await new Promise<void>(resolve => { child.once("exit", () => resolve()); setTimeout(() => { child.kill(); resolve(); }, 3000).unref(); }); await bridge.close(); }
});

test("native adapter transports execute a generated mixed-provider process without model quota", async () => {
  const f = await setup(); adapters.claude.run = original.claude; adapters.codex.run = original.codex;
  const proposal = await f.call("propose_run", { task: "CODEFLOW_CONVERSATIONAL_TEST: plan a login form", candidate: planning() });
  await f.service.accept(f.connection, proposal.proposalId, proposal.revision, proposal.proposalHash);
  const { runId } = await f.call("start_run", { proposalId: proposal.proposalId, expectedRevision: proposal.revision, proposalHash: proposal.proposalHash });
  const run = f.manager.get(runId)!; await finished(run);
  assert.equal(run.status, "done", run.error); assert.match(run.summary!, /Fixture login plan/);
  assert.ok(run.steps.some(s => s.agent === "claude")); assert.ok(run.steps.some(s => s.agent === "codex"));
});

test("durable replay resumes failed review without redispatching completed work or resetting lifetime calls", async () => {
  const f = await setup(); let drafts = 0, failed = false, calls = 0;
  stub(async opts => {
    calls++;
    if (!opts.jsonSchema) { drafts++; return { ok: true, finalText: "Durable plan" }; }
    if (opts.prompt.includes("PEER:") && !failed) { failed = true; return { ok: false, finalText: "", error: "Sign in required", errorKind: "auth" }; }
    return { ok: true, finalText: JSON.stringify({ body: "Approved", verdict: "approve", findings: [] }) };
  });
  const run = await start(f); await finished(run); assert.equal(run.status, "failed", run.error);
  const firstCalls = calls; await f.call("control_run", { runId: run.id, action: "resume" }); await finished(run);
  assert.equal(run.status, "done", run.error); assert.equal(drafts, 1); assert.equal(calls, firstCalls + 1);
  assert.equal(run.cliTeam!.managedInvocations, calls);
  const reload = new CliTeamsService(f.manager); await reload.load();
  assert.equal(run.cliTeam!.managedInvocations, calls); assert.ok(Object.values(run.cliTeam!.artifacts).some(a => a.kind === "result"));
});

test("exact-target graph typing and authority are rejected before worker dispatch", async () => {
  const c = planning(); const loop = c.steps[0]!; assert.equal(loop.type, "loop");
  if (loop.type !== "loop") return;
  const review = loop.steps[1]!; assert.equal(review.type, "parallel");
  if (review.type !== "parallel") return;
  review.tasks[0]!.inputs = ["reviews"];
  assert.throws(() => validateCandidate(c), /earlier|wrong artifact/);
  const write = planning(); write.scope = "plan"; write.steps = [{ id: "write", type: "task", operation: "implement", participant: "author", instructions: "write" }, write.steps.at(-1)!];
  assert.throws(() => validateCandidate(write), /write scope/);
});

test("UX10: implementing a prior plan requires fresh acceptance and rejects stale source reuse", async () => {
  const f = await setup(); stub(); const plan = await start(f); await finished(plan);
  const artifact = Object.values(plan.cliTeam!.artifacts).find(a => a.kind === "plan")!;
  const request = { task: "Implement this login plan", candidate: building(), context: { artifacts: [{ runId: plan.id, artifactId: artifact.id, sha256: artifact.sha256 }] } };
  const proposal = await f.call("propose_run", request);
  await assert.rejects(f.call("start_run", { proposalId: proposal.proposalId, expectedRevision: proposal.revision, proposalHash: proposal.proposalHash }), /Accept/);
  let sawPlan = false;
  stub(async opts => { if (opts.mode === "write") { sawPlan = opts.prompt.includes(artifact.body); writeFileSync(join(opts.cwd, "app.mjs"), "export const value = 2;\n"); } return { ok: true, finalText: opts.jsonSchema ? JSON.stringify({ body: "Approved", verdict: "approve", findings: [] }) : "Implemented" }; });
  await f.service.accept(f.connection, proposal.proposalId, proposal.revision, proposal.proposalHash);
  const { runId } = await f.call("start_run", { proposalId: proposal.proposalId, expectedRevision: proposal.revision, proposalHash: proposal.proposalHash });
  await finished(f.manager.get(runId)!); assert.equal(f.manager.get(runId)!.status, "done", f.manager.get(runId)!.error); assert.ok(sawPlan);
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-qm", "source changed"], { cwd: f.repo });
  await assert.rejects(f.call("propose_run", request), /context changed/);
});

test("material steering continues from preserved changes rather than the original checkout", async () => {
  const f = await setup();
  stub(async opts => { if (opts.mode === "write") writeFileSync(join(opts.cwd, "app.mjs"), "export const value = 2;\n"); return { ok: true, finalText: opts.jsonSchema ? JSON.stringify({ body: "Approved", verdict: "approve", findings: [] }) : "Implemented" }; });
  const parent = await start(f, building()); await finished(parent); assert.equal(parent.status, "done", parent.error);
  const candidate = building(); candidate.participants = [candidate.participants[1]!];
  candidate.steps[0] = { id: "build", type: "task", operation: "capture_snapshot", instructions: "Capture the retained implementation" };
  const proposal = await f.call("steer_run", { runId: parent.id, message: "Keep the implementation; review and verify it without another writer", candidate });
  assert.match(proposal.preview, /Verification only: no code editing assignment/);
  let retained = false, childCalls = 0;
  stub(async opts => { childCalls++; assert.equal(opts.mode, "read"); retained = readFileSync(join(opts.cwd, "app.mjs"), "utf8").includes("2"); return { ok: true, finalText: JSON.stringify({ body: "Approved retained changes", verdict: "approve", findings: [] }) }; });
  await f.service.accept(f.connection, proposal.proposalId, proposal.revision, proposal.proposalHash);
  const { runId } = await f.call("start_run", { proposalId: proposal.proposalId, expectedRevision: proposal.revision, proposalHash: proposal.proposalHash });
  const child = f.manager.get(runId)!; await finished(child); assert.equal(child.status, "done", child.error); assert.ok(retained); assert.equal(childCalls, 1); assert.equal(child.parentRunId, parent.id);
  assert.match(readFileSync(join(f.repo, "app.mjs"), "utf8"), /1/);
});

test("failed checks and mutations during a check cannot be overruled by approving reviewers", async () => {
  for (const command of ['node -e "process.exit(1)"', 'node -e "require(\'fs\').writeFileSync(\'app.mjs\',\'changed after snapshot\')"']) {
    const f = await setup(); stub(async opts => { if (opts.mode === "write") writeFileSync(join(opts.cwd, "app.mjs"), "export const value = 2;\n"); return { ok: true, finalText: opts.jsonSchema ? JSON.stringify({ body: "Approved", verdict: "approve", findings: [] }) : "Implemented" }; });
    const c = building(); c.check = command;
    const run = await start(f, c); await finished(run); assert.notEqual(run.status, "done"); assert.notEqual(run.cliTeam!.outcome, "verified_changes");
    assert.match(run.cliTeam!.detail ?? run.error!, command.includes("exit") ? /check did not pass/ : /Code changed/);
  }
});

test("lifetime call ceilings survive failed-step resume and no extra draft is admitted", async () => {
  const f = await setup(); let calls = 0;
  stub(async opts => { calls++; return opts.prompt.includes("PEER:") ? { ok: false, finalText: "", error: "Sign in", errorKind: "auth" } : { ok: true, finalText: opts.jsonSchema ? JSON.stringify({ body: "Approved", verdict: "approve", findings: [] }) : "Plan" }; });
  const c = planning(); c.limits = { maxInvocations: 3 };
  const run = await start(f, c); await finished(run); assert.equal(calls, 3);
  await f.call("control_run", { runId: run.id, action: "resume" }); await finished(run); assert.equal(calls, 3); assert.equal(run.status, "stopped");
});

test("interrupted writers preserve their work and require reconciliation before another launch", async () => {
  const f = await setup(); let launches = 0;
  stub(async opts => { launches++; if (opts.mode === "write") writeFileSync(join(opts.cwd, "app.mjs"), "partial edit preserved\n"); return { ok: false, finalText: "", error: "Authentication interrupted", errorKind: "auth" }; });
  const run = await start(f, building()); await finished(run); assert.equal(launches, 1);
  await f.call("control_run", { runId: run.id, action: "resume" }); await finished(run);
  assert.equal(launches, 1); assert.match(run.error!, /preserved worktree/); assert.match(readFileSync(join(run.worktrees[0]!.path, "app.mjs"), "utf8"), /partial edit/);
});

test("user decisions wait without an agent slot and retain typed answers", async () => {
  const f = await setup(); stub(); const c = planning(); c.steps.unshift({ id: "choice", type: "user_decision", question: "Which login layout?", options: ["Existing layout", "Compact layout"] });
  const run = await start(f, c); for (let i = 0; i < 300 && !Object.keys(run.cliTeam!.questions).length; i++) await pause();
  const state = await f.call("get_run", { runId: run.id }); assert.equal(state.status, "waiting_user"); assert.equal(run.steps.filter(s => s.kind === "agent").length, 0);
  await f.call("steer_run", { runId: run.id, questionId: state.questions[0].id, message: "Existing layout" }); await finished(run); assert.equal(run.status, "done", run.error);
  assert.ok(Object.values(run.cliTeam!.artifacts).some(a => a.kind === "decision" && a.data.answer === "Existing layout"));
});

test("noninteractive approval fails without starting another local owner", () => {
  assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL("../bin/codeflow.mjs", import.meta.url)), "approve", "fixture", "--revision", "1"], { cwd: repo(), env: process.env, stdio: "pipe" }), /interactive terminal/);
});

test("a simple plan uses one participant and never claims unrequested agreement", async () => {
  const f = await setup(); let calls = 0; stub(async () => { calls++; return { ok: true, finalText: "Simple login plan" }; });
  const c: Candidate = { scope: "plan", participants: [{ id: "planner", provider: "claude" }], completion: ["Return a plan"], steps: [
    { id: "plan", type: "task", participant: "planner", operation: "propose", instructions: "Write the plan" },
    { id: "result", type: "finish", outcome: "plan_ready", inputs: ["plan"] },
  ] };
  const run = await start(f, c); await finished(run); assert.equal(run.status, "done", run.error); assert.equal(calls, 1); assert.equal(run.cliTeam!.outcome, "plan_ready");
  assert.doesNotMatch(run.summary!, /agreed|approved/);
});

test("checks-only implementation can use one worker when independent review was not requested", async () => {
  const f = await setup(); let calls = 0; stub(async opts => { calls++; writeFileSync(join(opts.cwd, "app.mjs"), "export const value = 2;\n"); return { ok: true, finalText: "Implemented" }; });
  const c = building(); c.participants = [c.participants[0]!]; c.steps = c.steps.filter(s => s.id !== "review");
  const gate = c.steps.find(s => s.type === "gate")!; if (gate.type === "gate") gate.reviews = [];
  const finish = c.steps.at(-1)!; if (finish.type === "finish") finish.inputs = ["build", "check", "gate"];
  const proposal = await f.call("propose_run", { task: "Make this small change and check it; no review needed", candidate: c }); assert.match(proposal.preview, /No independent review/);
  await f.service.accept(f.connection, proposal.proposalId, proposal.revision, proposal.proposalHash);
  const { runId } = await f.call("start_run", { proposalId: proposal.proposalId, expectedRevision: proposal.revision, proposalHash: proposal.proposalHash });
  const run = f.manager.get(runId)!; await finished(run); assert.equal(run.status, "done", run.error); assert.equal(calls, 1);
});

test("transport and schema repair share the same assignment attempt ceiling", async () => {
  const f = await setup(); let calls = 0;
  stub(async opts => { calls++; return { ok: true, finalText: opts.jsonSchema ? "not a valid review" : "A complete plan" }; });
  const c = planning(); c.limits = { maxAttempts: 1 };
  const run = await start(f, c); await finished(run); assert.notEqual(run.status, "done");
  assert.ok(Object.values(run.cliTeam!.nodeInvocations!).every(n => n <= 1)); assert.equal(run.cliTeam!.managedInvocations, calls);
  assert.match(run.stopReason!, /assignment attempt limit/);
  await assert.rejects(f.call("control_run", { runId: run.id, action: "resume" }), /new proposal/);
});

test("crash recovery preserves time/call ceilings and bounds overlapping unsettled reservations", async () => {
  const f = await setup(); stub(); const run = await start(f); await finished(run);
  const recovered = structuredClone(run); recovered.clockUsedMs = 100;
  const journal = new Map<string, unknown>([
    ["cli-clock", 500],
    ["cli-launch:first", { stepId: "first", assignment: "workflow/first", usedMs: 100, reservedMs: 1000 }],
    ["cli-launch:parallel", { stepId: "parallel", assignment: "workflow/parallel", usedMs: 200, reservedMs: 1000 }],
  ]);
  recoverCliAccounting(recovered, journal);
  assert.equal(recovered.cliTeam!.managedInvocations, 2); assert.equal(recovered.clockUsedMs, 1200, "parallel wall-time reservations must not be summed");
  assert.equal(recovered.cliTeam!.recoveryTimeChargeMs, 700);
  assert.deepEqual(recovered.cliTeam!.nodeInvocations, { "workflow/first": 1, "workflow/parallel": 1 });
  const settled = structuredClone(run); settled.clockUsedMs = 100;
  journal.set("cli-settled:first", {}); journal.set("cli-settled:parallel", {});
  recoverCliAccounting(settled, journal); assert.equal(settled.clockUsedMs, 500, "durably settled turns use observed time");
});

test("an early rejected gate skips later work and retries the declared process without missing-input errors", async () => {
  const f = await setup(); let planReviews = 0, builds = 0;
  stub(async opts => {
    if (opts.mode === "write") { builds++; writeFileSync(join(opts.cwd, "app.mjs"), "export const value = 2;\n"); }
    if (!opts.jsonSchema) return { ok: true, finalText: opts.mode === "write" ? "Implemented" : "Login plan" };
    const reject = opts.prompt.includes("PLAN-REVIEW:") && ++planReviews === 1;
    return { ok: true, finalText: JSON.stringify({ body: reject ? "Specify focus behavior" : "Approved", verdict: reject ? "changes_requested" : "approve", findings: reject ? ["Missing focus behavior"] : [] }) };
  });
  const c = building();
  const planningSteps: Node[] = [
    { id: "plan", type: "task", operation: "propose", participant: "reviewer", instructions: "Plan the change" },
    { id: "plan-review", type: "task", operation: "review_plan", participant: "builder", instructions: "PLAN-REVIEW: review the plan", inputs: ["plan"] },
    { id: "plan-gate", type: "gate", policy: "agreement", target: "plan", reviews: ["plan-review"] },
  ];
  const finish = c.steps.pop()!;
  c.steps = [{ id: "cycle", type: "loop", maxIterations: 3, steps: [...planningSteps, ...c.steps] }, finish];
  const run = await start(f, c); await finished(run); assert.equal(run.status, "done", run.error); assert.equal(builds, 1); assert.equal(planReviews, 2);
  await assert.rejects(f.manager.resume(run.id), /CLI\/MCP proposal/, "web mutation routes must not bypass the accepted CLI definition");
});

test("native MCP confirmation binds human approval to the exact revision and starts once without a TTY", async () => {
  const f = await setup(); let launches = 0; stub(async opts => { launches++; return { ok: true, finalText: opts.jsonSchema ? JSON.stringify({ body: "Approved", verdict: "approve", findings: [] }) : "Login plan" }; });
  const bridge = await startCliTeamsTransport(f.service), peer = await mcpPeer(f, { elicitation: { form: {} } });
  try {
    const proposed = await peer.call("propose_run", { operationId: "native-proposal", task: "Plan a login form", candidate: planning() }).result;
    let p = proposed.structuredContent.data; assert.equal(p.approvalMethod, "native_form"); assert.match(p.nextAction, /no separate terminal/);
    const args = () => ({ operationId: `native-start-${p.revision}`, proposalId: p.proposalId, expectedRevision: p.revision, proposalHash: p.proposalHash });
    const denied = peer.call("start_run", args()), first = await peer.prompt();
    assert.match(first.params.message, new RegExp(p.proposalHash)); assert.equal(first.params.requestedSchema.properties.approve.default, false); assert.equal(launches, 0);
    peer.send({ id: first.id, result: { action: "accept", content: { approve: false } } });
    assert.equal((await denied.result).structuredContent.error.code, "acceptance_declined"); assert.equal(f.manager.list().length, 0);
    const stale = peer.call("start_run", args()), second = await peer.prompt();
    const revised = await f.call("propose_run", { proposalId: p.proposalId, expectedRevision: p.revision, task: "Revise the login plan", candidate: planning() });
    peer.send({ id: second.id, result: { action: "accept", content: { approve: true } } });
    assert.equal((await stale.result).structuredContent.error.code, "acceptance_stale"); assert.equal(f.manager.list().length, 0); p = revised;
    const cancelled = peer.call("start_run", args()), third = await peer.prompt();
    peer.send({ method: "notifications/cancelled", params: { requestId: cancelled.id } });
    assert.equal((await cancelled.result).structuredContent.error.code, "acceptance_cancelled");
    peer.send({ id: third.id, result: { action: "accept", content: { approve: true } } });
    const forged = await peer.call("start_run", { ...args(), approved: true }).result;
    assert.equal(forged.structuredContent.error.code, "validation_failed"); assert.equal(f.manager.list().length, 0);
    const accepted = peer.call("start_run", args()), fourth = await peer.prompt();
    peer.send({ id: fourth.id, result: { action: "accept", content: { approve: true } } });
    const started = await accepted.result; assert.equal(started.isError, false, JSON.stringify(started));
    assert.deepEqual(await peer.call("start_run", args()).result, started); assert.equal(peer.prompts.length, 0);
    const run = f.manager.get(started.structuredContent.data.runId)!; await finished(run); assert.equal(run.status, "done", run.error); assert.equal(launches, 3);
  } finally { await peer.close(); await bridge.close(); }
});

test("unsupported native hosts keep the terminal fallback; closing a pending form never approves work", async () => {
  const f = await setup(); stub(); const bridge = await startCliTeamsTransport(f.service);
  try {
    for (const capabilities of [{}, { elicitation: { url: {} } }, { elicitation: {} }]) {
      const peer = await mcpPeer(f, capabilities);
      try {
        const response = await peer.call("propose_run", { operationId: `cap-proposal-${++operation}`, task: "Plan a login form", candidate: planning() }).result;
        const p = response.structuredContent.data, native = "elicitation" in capabilities && !Object.hasOwn(capabilities.elicitation!, "url");
        assert.equal(p.approvalMethod, native ? "native_form" : "terminal");
        const start = peer.call("start_run", { operationId: `cap-start-${++operation}`, proposalId: p.proposalId, expectedRevision: p.revision, proposalHash: p.proposalHash });
        if (native) { await peer.prompt(); peer.child.stdin.end(); assert.equal((await start.result).structuredContent.error.code, "acceptance_cancelled"); }
        else { assert.equal((await start.result).structuredContent.error.code, "acceptance_required"); assert.equal(peer.prompts.length, 0); }
        assert.equal(f.manager.list().length, 0);
      } finally { await peer.close(); }
    }
  } finally { await bridge.close(); }
});
