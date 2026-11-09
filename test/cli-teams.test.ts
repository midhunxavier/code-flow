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
const { installUser, uninstallUser, uninstallProject, hasProjectInstall } = await import("../src/cli-teams/install.js");
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
async function mcpPeer(f: Awaited<ReturnType<typeof setup>>, capabilities: object, launch?: { command: string; args: string[]; env: Record<string, string> }) {
  // Its own user folder: the configuration check must not read this computer's real Claude or Codex settings.
  const user = mkdtempSync(join(tmpdir(), "codeflow-peer-user-")); repos.push(user);
  const child = spawn(launch?.command ?? process.execPath, launch?.args ?? ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../src/cli-teams/cli.ts", import.meta.url)), "mcp", "--project-root", f.repo], { cwd: "/", env: { ...process.env, HOME: user, CLAUDE_CONFIG_DIR: "", CODEX_HOME: join(user, ".codex"), ...launch?.env }, stdio: ["pipe", "pipe", "pipe"] });
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
  const initialized = await request("initialize", { protocolVersion: "2025-11-25", capabilities }).result;
  send({ method: "notifications/initialized" });
  return {
    child, send, prompts, initialized, request,
    call: (name: string, args: object = {}) => request("tools/call", { name: `codeflow_${name}`, arguments: args }),
    async prompt() { for (let i = 0; i < 1000 && !prompts.length; i++) await pause(); assert.ok(prompts.length, "expected native confirmation"); return prompts.shift(); },
    async close() { child.stdin.end(); for (let i = 0; i < 500 && child.exitCode === null; i++) await pause(); if (child.exitCode === null) child.kill("SIGTERM"); for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("MCP fixture closed")); } pending.clear(); },
  };
}
function stub(fn?: typeof adapters.claude.run) {
  const worker: typeof adapters.claude.run = fn ?? (async opts => ({ ok: true, finalText: opts.jsonSchema ? JSON.stringify({ body: "Reviewed with evidence", verdict: "approve", findings: [] }) : "Plan: accessible labels, validation, keyboard focus, and tests." }));
  adapters.claude.run = worker; adapters.codex.run = worker;
}
async function cliOutput(repo: string, args: string[]) {
  const user = mkdtempSync(join(tmpdir(), "codeflow-cli-user-")); repos.push(user); // never this computer's real host settings
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../src/cli-teams/cli.ts", import.meta.url)), ...args, "--project-root", repo], { env: { ...process.env, HOME: user, CLAUDE_CONFIG_DIR: "", CODEX_HOME: join(user, ".codex") }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = ""; child.stdout.on("data", c => out += c); child.stderr.on("data", c => err += c);
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  try { const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); }); assert.equal(code, 0, err); return out; }
  finally { clearTimeout(timer); }
}

test("CLI UX e2e: MCP connection, native planning approval, continuation, result and confirmed checkout handoff", async () => {
  const f = await setup();
  let releaseReviews!: () => void;
  const reviews = new Promise<void>(resolve => { releaseReviews = resolve; });
  stub(async opts => {
    if (opts.jsonSchema) await reviews;
    if (opts.mode === "write") writeFileSync(join(opts.cwd, "app.mjs"), "export const value = 2;\n");
    return { ok: true, finalText: opts.jsonSchema ? JSON.stringify({ body: "Exact target reviewed", verdict: "approve", findings: [] }) : "Plan: set value to 2 and run the unchanged test." };
  });
  const transport = await startCliTeamsTransport(f.service), peer = await mcpPeer(f, { elicitation: { form: {} } });
  const call = async (name: string, args: object = {}) => {
    const reply = await peer.call(name, args).result;
    assert.equal(reply.structuredContent.ok, true, JSON.stringify(reply.structuredContent));
    assert.equal(reply.content[0].text.startsWith('{"protocolVersion"'), false, "human text is not a duplicated protocol object");
    return reply.structuredContent.data;
  };
  const approve = async (name: string, args: object, accepted = true) => {
    const requested = peer.call(name, args), form = await peer.prompt();
    assert.equal(form.params.requestedSchema.properties.approve.default, true);
    peer.send({ id: form.id, result: { action: "accept", content: { approve: accepted } } });
    return requested.result;
  };
  try {
    const connection = await call("list_providers"); assert.equal(connection.connection.live, true); assert.equal(connection.connection.compatible, true);
    assert.equal(connection.connection.configuration.state, "update_available", connection.connection.configuration.message);
    const p = await call("propose_run", { operationId: "ux-plan", task: "Plan the value fix", candidate: planning() });
    assert.match(p.summary, /^Task: Plan the value fix\nWhat it does: Plan only\. Your files are not changed\.\nTeam:\n/); assert.match(p.summary, /Limit: up to 18 agent calls · 120 minutes$/); assert.doesNotMatch(p.summary, /hash|lifetime|transport/i);
    const started = await approve("start_run", { operationId: "ux-start", proposalId: p.proposalId, expectedRevision: p.revision, proposalHash: p.proposalHash });
    const plan = f.manager.get(started.structuredContent.data.runId)!;
    assert.match(started.content[0].text, /Continue in this turn/);
    let follow = await call("get_run", started.structuredContent.data.follow);
    const excerpts: string[] = [];
    const bothReviewing = () => ["author", "peer"].every(participant => follow.progress.active.some((step: { participant: string }) => step.participant === participant));
    for (let i = 0; i < 20; i++) {
      excerpts.push(...follow.follow.updates.map((update: { excerpt: string }) => update.excerpt));
      if (excerpts.some(excerpt => excerpt.includes("Plan: set value to 2")) && bothReviewing()) break;
      follow = await call("get_run", { ...follow.follow.next, waitMs: 250 });
    }
    assert.equal(follow.runtimeStatus, "running");
    assert.match(excerpts.join("\n"), /Plan: set value to 2/);
    assert.ok(bothReviewing());
    const unchanged = await call("get_run", { ...follow.follow.next, waitMs: 10 });
    assert.equal(unchanged.follow.changed, false);
    assert.deepEqual(unchanged.follow.updates, []);
    releaseReviews();
    await finished(plan);
    const final = await peer.call("get_run", follow.follow.next).result;
    const finalData = final.structuredContent.data;
    assert.equal(finalData.follow.next, undefined);
    assert.match(final.content[0].text, /present the result in this turn/);
    const deliverable = await call("get_artifact", { runId: plan.id, artifactId: finalData.result.id, sha256: finalData.result.sha256 });
    assert.match(deliverable.body, /Plan: set value to 2/);
    assert.equal(finalData.follow.resultPage.body, deliverable.body);
    assert.ok(final.content[0].text.includes(deliverable.body));
    const planStatus = await call("get_run", { runId: plan.id });
    assert.equal(planStatus.progress.phase, "completed"); assert.equal(planStatus.continuation.context.reuseRunId, plan.id);
    const proposed = await call("propose_run", { operationId: "ux-build", task: "Implement that plan", candidate: building(), context: planStatus.continuation.context });
    const built = await approve("start_run", { operationId: "ux-build-start", proposalId: proposed.proposalId, expectedRevision: proposed.revision, proposalHash: proposed.proposalHash });
    const run = f.manager.get(built.structuredContent.data.runId)!; await finished(run);
    const status = await call("get_run", { runId: run.id });
    assert.equal(status.outcome, "verified_changes", run.error); assert.equal(status.handoff.check.passed, true); assert.equal(status.handoff.reviewCount, 1);
    const result = await call("get_artifact", { runId: run.id, artifactId: status.result.id, sha256: status.result.sha256 }); assert.match(result.body, /Required checks passed/);
    const preview = await call("preview_handoff", { runId: run.id, maxBytes: 256 });
    assert.equal(preview.ready, true, preview.reason);
    let diff = preview.diff, cursor = preview.nextCursor;
    while (cursor !== undefined) { const page = await call("preview_handoff", { runId: run.id, cursor, previewHash: preview.previewHash, maxBytes: 256 }); diff += page.diff; cursor = page.nextCursor; }
    assert.match(diff, /\+export const value = 2/);
    const terminal = JSON.parse(await cliOutput(f.repo, ["diff", run.id, "--json"]));
    assert.equal(terminal.diff, diff); assert.equal(terminal.previewHash, preview.previewHash);
    assert.match(await cliOutput(f.repo, ["result", run.id]), /Check: passed/);
    assert.equal(JSON.parse(await cliOutput(f.repo, ["doctor", "--json"])).connection.live, true);
    const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.repo, encoding: "utf8" });
    const args = { operationId: "ux-apply", runId: run.id, previewHash: preview.previewHash };
    const declined = await approve("apply_handoff", args, false); assert.equal(declined.structuredContent.error.code, "acceptance_declined");
    assert.equal(readFileSync(join(f.repo, "app.mjs"), "utf8"), "export const value = 1;\n");
    const applied = await approve("apply_handoff", args); assert.equal(applied.structuredContent.data.applied, true, JSON.stringify(applied));
    assert.equal((await call("apply_handoff", args)).applied, true, "same operation reconciles without another confirmation");
    assert.equal((await call("apply_handoff", { ...args, operationId: "ux-apply-again" })).applied, true, "same exact effect is not applied twice under a new operation");
    assert.equal(peer.prompts.length, 0);
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.repo, encoding: "utf8" }), before);
    assert.equal(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: f.repo, encoding: "utf8" }).trim(), "app.mjs");
    const checkEnv = { ...process.env }; delete checkEnv.NODE_TEST_CONTEXT;
    assert.match(execFileSync(process.execPath, ["--test", "--test-reporter=tap", "app.test.mjs"], { cwd: f.repo, encoding: "utf8", env: checkEnv }), /pass 1/);
  } finally { releaseReviews(); await peer.close(); await transport.close(); }
});

test("CLI UX: task delta excludes prior user changes and application receipts survive restart", async () => {
  const f = await setup();
  writeFileSync(join(f.repo, "notes.txt"), "original\n"); execFileSync("git", ["add", "."], { cwd: f.repo }); execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "notes"], { cwd: f.repo });
  writeFileSync(join(f.repo, "notes.txt"), "user baseline change\n");
  stub(async opts => { if (opts.mode === "write") writeFileSync(join(opts.cwd, "app.mjs"), "export const value = 2;\n"); return { ok: true, finalText: opts.jsonSchema ? JSON.stringify({ body: "Reviewed", verdict: "approve", findings: [] }) : "Implemented" }; });
  const candidate = building(); candidate.source = "working_changes";
  const run = await start(f, candidate); await finished(run);
  const continuation = await f.call("propose_run", { task: "Review these changes", candidate: { scope: "review", participants: [{ id: "reviewer", provider: "claude" }], completion: ["Review the preserved changes"], steps: [{ id: "snapshot", type: "task", operation: "capture_snapshot" }, { id: "review", type: "task", operation: "review_code", participant: "reviewer", instructions: "Review", inputs: ["snapshot"] }, { id: "result", type: "finish", outcome: "review_complete", inputs: ["review"] }] }, context: { reuseRunId: run.id } });
  assert.equal(f.service.workspaceProposals().find(p => p.id === continuation.proposalId)!.context.continueRunId, run.id);
  writeFileSync(join(f.repo, "notes.txt"), "original\n");
  const p = await f.call("preview_handoff", { runId: run.id }); assert.equal(p.ready, true, p.reason); assert.doesNotMatch(p.diff, /notes.txt|user baseline/);
  await f.service.acceptHandoff(f.connection, run.id, p.previewHash);
  const args = { operationId: "durable-apply", runId: run.id, previewHash: p.previewHash };
  const applied = await f.service.call(f.connection, "codeflow_apply_handoff", args) as any; assert.equal(applied.applied, true);
  const recovered = new CliTeamsService(f.manager); await recovered.load(); const connection = await recovered.connect(f.repo);
  assert.equal((await recovered.call(connection, "codeflow_apply_handoff", { ...args, operationId: "recovered-apply" }) as any).applied, true);
  assert.equal(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: f.repo, encoding: "utf8" }).trim(), "app.mjs");
  assert.equal(readFileSync(join(f.repo, "notes.txt"), "utf8"), "original\n");
});

test("CLI UX: interrupted application is fenced before any duplicate checkout write", async () => {
  const f = await setup(); stub(async opts => { if (opts.mode === "write") writeFileSync(join(opts.cwd, "app.mjs"), "export const value = 2;\n"); return { ok: true, finalText: opts.jsonSchema ? JSON.stringify({ body: "Reviewed", verdict: "approve", findings: [] }) : "Implemented" }; });
  const run = await start(f, building()); await finished(run);
  const p = await f.call("preview_handoff", { runId: run.id });
  await journalEntry("cli-teams-control", `handoff-effect:${f.connection.repo}:${run.id}:${p.previewHash}`, { state: "applying", previewHash: p.previewHash });
  const recovered = new CliTeamsService(f.manager); await recovered.load(); const connection = await recovered.connect(f.repo);
  await assert.rejects(recovered.call(connection, "codeflow_apply_handoff", { operationId: "recover-uncertain", runId: run.id, previewHash: p.previewHash }), /will not be replayed/);
  assert.equal(readFileSync(join(f.repo, "app.mjs"), "utf8"), "export const value = 1;\n");
});

test("CLI UX: continuation resolves pinned settings and rejects changed or foreign plan sources", async () => {
  const f = await setup(); stub(); const run = await start(f); await finished(run);
  const candidate = planning(); delete candidate.participants[0]!.model; delete candidate.participants[0]!.effort;
  const p = await f.call("propose_run", { task: "Refine that plan", candidate, context: { reuseRunId: run.id } });
  assert.equal(p.definition.participants[0].model, run.cliTeam!.definition.participants[0]!.model);
  assert.equal(p.definition.participants[0].effort, "high");
  const saved = f.service.workspaceProposals().find(x => x.id === p.proposalId)!;
  assert.equal(saved.context.artifacts?.length, 1); assert.equal(saved.context.artifacts?.[0]?.runId, run.id);
  const other = await f.service.connect(repo());
  await assert.rejects(f.service.call(other, "codeflow_propose_run", { operationId: "foreign-reuse", task: "Continue", candidate, context: { reuseRunId: run.id } }), /unavailable in this project/);
  writeFileSync(join(f.repo, "new.txt"), "changed source"); execFileSync("git", ["add", "."], { cwd: f.repo }); execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "change"], { cwd: f.repo });
  await assert.rejects(f.call("propose_run", { task: "Implement old plan", candidate: building(), context: { reuseRunId: run.id } }), /context changed since this plan/);
});

test("CLI UX: handoff fences dirty checkout, stale preview, conflicts and missing confirmation", async () => {
  const f = await setup(); stub(async opts => { if (opts.mode === "write") writeFileSync(join(opts.cwd, "app.mjs"), "export const value = 2;\n"); return { ok: true, finalText: opts.jsonSchema ? JSON.stringify({ body: "Reviewed", verdict: "approve", findings: [] }) : "Implemented" }; });
  const run = await start(f, building()); await finished(run);
  const preview = await f.call("preview_handoff", { runId: run.id }); assert.equal(preview.ready, true, preview.reason);
  await assert.rejects(f.call("apply_handoff", { runId: run.id, previewHash: preview.previewHash }), /confirm application/);
  await f.service.acceptHandoff(f.connection, run.id, preview.previewHash);
  writeFileSync(join(f.repo, "app.mjs"), "local changes\n");
  assert.equal((await f.call("preview_handoff", { runId: run.id })).ready, false);
  await assert.rejects(f.call("apply_handoff", { runId: run.id, previewHash: preview.previewHash }), /changed since preview/);
  await assert.rejects(f.call("preview_handoff", { runId: run.id, previewHash: preview.previewHash, cursor: 0 }), /changed while reading/);
  assert.equal(readFileSync(join(f.repo, "app.mjs"), "utf8"), "local changes\n");
  execFileSync("git", ["add", "."], { cwd: f.repo }); execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "conflicting change"], { cwd: f.repo });
  const conflict = await f.call("preview_handoff", { runId: run.id }); assert.equal(conflict.ready, false); assert.match(conflict.reason, /do not apply cleanly/);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: f.repo, encoding: "utf8" }), "", "preflight never leaves conflict files");
  const other = await f.service.connect(repo()); await assert.rejects(f.service.call(other, "codeflow_preview_handoff", { runId: run.id }), /unavailable in this project/);
});

test("CLI UX: engine steps need no invented instructions and attempt limits fit the run", async () => {
  const c = building() as any;
  delete c.steps[1].instructions;
  assert.equal((validateCandidate(c).steps[1] as any).instructions, "Run the configured checks");
  assert.equal(c.steps[1].instructions, undefined, "validation does not mutate caller input");
  delete c.steps[0].instructions;
  assert.throws(() => validateCandidate(c), /agent work requires instructions/);
  const f = await setup(); stub();
  const candidate = planning(); candidate.limits = { maxMinutes: 5 };
  const p = await f.call("propose_run", { task: "Plan", candidate });
  const preview = await f.service.acceptancePreview(f.connection, p.proposalId, p.revision);
  assert.match(preview.preview, /5 minutes per attempt/);
  assert.ok(preview.preview.indexOf("Limits:") < preview.preview.indexOf("Work sequence:"));
  assert.ok(preview.preview.indexOf("Permissions:") < preview.preview.indexOf("Work sequence:"), "native forms show approval boundaries before long step instructions");
});

test("CLI UX: supported attachments cross both transports and validation failures retain request IDs", async () => {
  const f = await setup(); const transport = await startCliTeamsTransport(f.service), peer = await mcpPeer(f, {});
  try {
    for (const size of [60 * 1024, 1024 * 1024]) {
      const response = await peer.call("propose_run", { operationId: `attachment-${size}`, task: "Read the attached specification", candidate: planning(), context: { attachments: [{ name: "spec.txt", data: Buffer.alloc(size, 65).toString("base64") }] } }).result;
      assert.equal(response.structuredContent.ok, true, JSON.stringify(response.structuredContent.error));
    }
    const response = await peer.call("propose_run", { operationId: "oversized-files", task: "Read the specification", candidate: planning(), context: { attachments: Array.from({ length: 5 }, (_, i) => ({ name: `spec-${i}.txt`, data: Buffer.alloc(1024 * 1024, 65).toString("base64") })) } }).result;
    assert.equal(response.structuredContent.ok, false);
    assert.match(response.structuredContent.error.message, /4 MB in total/);
    assert.equal((await peer.call("list_providers").result).structuredContent.ok, true, "connection remains usable after a correlated rejection");
  } finally { await peer.close(); await transport.close(); }
});

test("CLI UX: every artifact and changed-file page remains discoverable with stable result evidence", async () => {
  const f = await setup(); stub(); const run = await start(f); await finished(run);
  const originalResult = Object.values(run.cliTeam!.artifacts).find(a => a.kind === "result")!;
  for (let i = 0; i < 153; i++) run.cliTeam!.artifacts[`extra-${i}`] = { id: `extra-${i}`, sha256: `hash-${i}`, kind: "plan", body: "Additional evidence", data: {} };
  const seen: string[] = []; let cursor: number | undefined = 0;
  do {
    const page = await f.call("get_run", { runId: run.id, artifactCursor: cursor, artifactLimit: 17 });
    seen.push(...page.artifacts.map((a: any) => a.id)); cursor = page.nextArtifactCursor;
    assert.equal(page.result.id, originalResult.id);
    assert.equal(page.evidence.participants.length, 2);
    assert.ok(page.evidence.participants.every((p: any) => p.assignments.some((s: any) => s.invocations > 0)));
  } while (cursor !== undefined);
  assert.deepEqual(seen, Object.keys(run.cliTeam!.artifacts));
  const updates: string[] = [];
  let following = await f.call("get_run", { runId: run.id, follow: true });
  while (following.follow.next) {
    assert.equal(following.follow.next.waitMs, 0);
    assert.equal(following.follow.resultPage, undefined);
    updates.push(...following.follow.updates.map((a: { id: string }) => a.id));
    following = await f.call("get_run", following.follow.next);
  }
  updates.push(...following.follow.updates.map((a: { id: string }) => a.id));
  assert.deepEqual(updates, Object.values(run.cliTeam!.artifacts).filter(a => a.kind !== "result" && a.kind !== "collection").map(a => a.id));
  assert.equal(following.follow.resultPage.body, originalResult.body);
  const files = Array.from({ length: 213 }, (_, i) => ({ path: `file ${i}.ts`, status: "M" }));
  run.cliTeam!.artifacts.files = { id: "files", sha256: "files-hash", kind: "code_snapshot", body: "Snapshot", data: { changedFiles: files, changedFileCount: files.length } };
  const paths: any[] = []; cursor = 0;
  do { const page = await f.call("get_artifact", { runId: run.id, artifactId: "files", sha256: "files-hash", fileCursor: cursor }); paths.push(...page.data.changedFiles); cursor = page.data.nextFileCursor; } while (cursor !== undefined);
  assert.deepEqual(paths, files);
  const resumed = await f.call("control_run", { runId: run.id, action: "resume" });
  assert.equal(resumed.accepted, false); assert.match(resumed.message, /Already completed/);
  assert.ok((await f.call("list_runs")).runs.some((r: any) => r.runId === run.id));
  assert.ok(!(await f.call("list_runs", { unfinishedOnly: true })).runs.some((r: any) => r.runId === run.id));
  const other = await f.service.connect(repo());
  assert.equal((await f.service.call(other, "codeflow_list_runs", {}) as any).total, 0);
});

test("CLI UX: terminal status never offers a dead attach target and expired sessions cannot attach", async () => {
  const f = await setup(); stub(); const c = planning(); c.participants[0] = { id: "author", provider: "claude", binding: "current_session" };
  const run = await start(f, c);
  const terminal = await f.service.connect(f.repo, "terminal"), next = await f.service.connect(f.repo, "mcp");
  const status = await f.service.call(terminal, "codeflow_get_run", { runId: run.id }) as any;
  assert.equal(status.host.attachCommand, undefined); assert.match(status.host.reconnect, /temporary/);
  await assert.rejects(f.service.attach(f.connection, run.id, terminal.id), /live MCP connection/);
  const live = await f.service.call(next, "codeflow_get_run", { runId: run.id }) as any;
  assert.ok(live.host.attachCommand.endsWith(next.id));
  next.expiresAt = Date.now() - 1;
  await assert.rejects(f.service.attach(f.connection, run.id, next.id), /live MCP connection/);
  await f.call("control_run", { runId: run.id, action: "cancel" }); await finished(run);
});

test("CLI UX: missing provider fails preflight before any worker spends allowance", async () => {
  const f = await setup(); stub();
  const proposal = await f.call("propose_run", { task: "Plan", candidate: planning() });
  await f.service.accept(f.connection, proposal.proposalId, proposal.revision, proposal.proposalHash);
  const available = adapters.codex.available;
  adapters.codex.available = async () => false;
  try {
    await assert.rejects(f.call("start_run", { proposalId: proposal.proposalId, expectedRevision: proposal.revision, proposalHash: proposal.proposalHash }), /no workers were launched/);
    assert.equal(f.manager.list().length, 0);
  } finally { adapters.codex.available = available; }
});

test("startup instructions fit Claude Code's 4,096-character cap and the full guide stays reachable", async () => {
  const { startupInstructions, guideText, GUIDE_SECTIONS } = await import("../src/cli-teams/guide.js");
  // A deep checkout path: the repository is part of the instructions.
  const root = "/Users/someone/" + "nested-folder/".repeat(13) + "project";
  for (const nativeForm of [true, false]) {
    const text = await startupInstructions(root, nativeForm);
    assert.ok(text.length <= 4000, `startup instructions are ${text.length} characters; Claude Code keeps only the first 4,096`);
    assert.ok(text.startsWith(`This connection is bound exclusively to repository ${JSON.stringify(root)}.`));
    assert.match(text, nativeForm ? /native approval/ : /no form elicitation/);
    for (const rule of [/codeflow_get_guide/, /Never answer, supply or simulate approval/, /follow\.next/, /operationId/, /Managed workers must never/, /Do not invent model IDs/]) assert.match(text, rule);
  }
  const skill = readFileSync(new URL("../integrations/cli-teams/SKILL.md", import.meta.url), "utf8");
  const headings = [...skill.matchAll(/^## (.+)$/gm)].map(m => m[1]);
  assert.equal(GUIDE_SECTIONS.length, headings.length, "every skill section has a guide section");
  const all = await guideText("all");
  for (const heading of headings) assert.ok(all.includes(`## ${heading}`), heading);
  for (const section of GUIDE_SECTIONS) { const text = await guideText(section); assert.match(text, /^## /); assert.ok(text.length < all.length); }
  await assert.rejects(guideText("nope" as any), /Unknown guide section/);
});

test("UX01/02/14: strict task-generated contracts expose fourteen tools and leave the web picker unchanged", () => {
  assert.equal(CLI_TOOLS.length, 14); assert.equal(new Set(CLI_TOOLS.map(t => t.name)).size, 14);
  assert.ok(!CLI_TOOLS.some(t => /team|preset/.test(t.name)));
  assert.ok(!patterns.some(p => p.id === "cli-team")); assert.ok(findPattern("cli-team"));
  assert.deepEqual(validateCandidate(planning()), planning());
  assert.throws(() => validateCandidate({ ...planning(), teamRef: "feature" }), /unknown field/);
  assert.throws(() => validateCandidate({ ...planning(), limits: { concurrency: 99 } }), /invalid number/);
  assert.throws(() => validateCandidate({ ...planning(), steps: [{ id: "bad", type: "script", body: "process.exit()" }] }), /Unknown/);
});

test("a repair step fed by a review sees its verdict and findings, not only the review summary", async () => {
  const f = await setup(); let repairPrompt = "";
  stub(async opts => {
    if (opts.jsonSchema) return { ok: true, finalText: JSON.stringify({ body: "Two correctness issues remain.", verdict: "changes_requested", findings: ["FINDING_ONE_MIDNIGHT", "FINDING_TWO_YEAR_ZERO"] }) };
    if (opts.prompt.includes("Assignment (repair)")) repairPrompt = opts.prompt;
    if (opts.mode === "write") writeFileSync(join(opts.cwd, "app.mjs"), "export const value = 2;\n");
    return { ok: true, finalText: "Changed value to 2." };
  });
  const candidate: Candidate = { scope: "write", participants: [{ id: "builder", provider: "claude" }, { id: "reviewer", provider: "codex" }], check: "node --test app.test.mjs", completion: ["value is 2"], steps: [
    { id: "build", type: "task", operation: "implement", participant: "builder", instructions: "Set value to 2" },
    { id: "snap1", type: "task", operation: "capture_snapshot", instructions: "Capture" },
    { id: "review", type: "task", operation: "review_code", participant: "reviewer", instructions: "Review", inputs: ["snap1"] },
    { id: "fix", type: "task", operation: "repair", participant: "builder", instructions: "Fix the issues raised by the review.", inputs: ["review"] },
    { id: "snap2", type: "task", operation: "capture_snapshot", instructions: "Capture" },
    { id: "check", type: "task", operation: "verify", instructions: "Run the check", inputs: ["snap2"] },
    { id: "done", type: "gate", policy: "verified", target: "snap2", reviews: [], verification: "check" },
    { id: "result", type: "finish", outcome: "verified_changes", inputs: ["snap2", "done"] },
  ] };
  const run = await start(f, candidate); await finished(run);
  assert.equal(run.cliTeam!.outcome, "verified_changes", run.error);
  assert.match(repairPrompt, /Verdict: changes requested\nBlocking findings:\n1\. FINDING_ONE_MIDNIGHT\n2\. FINDING_TWO_YEAR_ZERO/);
  const review = Object.values(run.cliTeam!.artifacts).find(a => a.kind === "review")!;
  assert.deepEqual(review.data.findings, ["FINDING_ONE_MIDNIGHT", "FINDING_TWO_YEAR_ZERO"], "the structured findings stay for gates and counts");
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
  const state = await f.call("get_run", { runId: run.id });
  assert.deepEqual(state.evidence.snapshot.changedFiles, [{ status: "M", path: "app.mjs" }]);
  assert.equal(state.evidence.lastDecision.approved, true);
  const snapshot = await f.call("get_artifact", { runId: run.id, artifactId: state.evidence.snapshot.id, sha256: state.evidence.snapshot.sha256 });
  assert.deepEqual(snapshot.data.changedFiles, state.evidence.snapshot.changedFiles);
  const check = Object.values(run.cliTeam!.artifacts).find(a => a.kind === "verification")!;
  const verification = await f.call("get_artifact", { runId: run.id, artifactId: check.id, sha256: check.sha256 });
  assert.equal(verification.data.passed, true);
  assert.equal(verification.data.evidence.output, undefined, "check output remains paginated in body");
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

test("an untracked folder selects the untracked files inside it, and a wrong path lists what exists", async () => {
  const p = repo(); mkdirSync(join(p, "src/lib"), { recursive: true });
  writeFileSync(join(p, "src/main.ts"), "main"); writeFileSync(join(p, "src/lib/util.ts"), "util"); writeFileSync(join(p, "notes.txt"), "notes");
  writeFileSync(join(p, ".gitignore"), "src/lib/ignored.ts\n"); writeFileSync(join(p, "src/lib/ignored.ts"), "ignored");
  const captured = await captureSource(p, "working_changes", ["src/"]);
  assert.deepEqual([...captured.untracked].sort(), ["src/lib/util.ts", "src/main.ts"]);
  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", captured.commit], { cwd: p, encoding: "utf8" });
  assert.match(files, /src\/main\.ts/); assert.match(files, /src\/lib\/util\.ts/); assert.doesNotMatch(files, /notes|ignored/);
  await assert.rejects(captureSource(p, "working_changes", ["docs"]), /Not an untracked, non-ignored file or folder: docs\. Untracked files: .*src\/main\.ts/);
});

test("default limits follow the proposed work", async () => {
  const f = await setup();
  const review = await f.call("propose_run", { task: "Review the README", candidate: { scope: "review", participants: [{ id: "reviewer", provider: "codex" }], completion: ["Findings are reported"], steps: [
    { id: "snapshot", type: "task", operation: "capture_snapshot" }, { id: "review", type: "task", operation: "review_code", participant: "reviewer", instructions: "Review the README", inputs: ["snapshot"] },
    { id: "result", type: "finish", outcome: "review_complete", inputs: ["review"] }] } });
  assert.match(review.summary, /Limit: up to 2 agent calls · 30 minutes$/);
  assert.match(review.headline, /^Review only, no file changes · Codex[^·]* · up to 2 calls, 30 min$/);
  assert.match(review.summary, /What it does: Review only\. Your files are not changed\./);
  // Four parallel reviewers run two at a time: two rounds plus the combining step, not five steps in a row.
  const reviewers = ["luna", "terra", "sonnet", "opus"];
  const parallel = await f.call("propose_run", { task: "Review the README with four reviewers", candidate: { scope: "review", participants: reviewers.map((id, i) => ({ id, provider: i < 2 ? "codex" : "claude" })), completion: ["Findings are combined"], steps: [
    { id: "snapshot", type: "task", operation: "capture_snapshot" },
    { id: "reviews", type: "parallel", tasks: reviewers.map(id => ({ id: `review-${id}`, type: "task", operation: "review_code", participant: id, instructions: "Review the README", inputs: ["snapshot"] })) },
    { id: "combine", type: "task", operation: "synthesize", participant: "sonnet", instructions: "Combine the reviews", inputs: reviewers.map(id => `review-${id}`) },
    { id: "result", type: "finish", outcome: "review_complete", inputs: ["combine", ...reviewers.map(id => `review-${id}`)] }] } });
  assert.match(parallel.summary, /Limit: up to 10 agent calls · 60 minutes$/);
  const pinned = await f.call("propose_run", { task: "Review the README", candidate: { ...planning(), limits: { maxInvocations: 40, maxMinutes: 90 } } });
  assert.match(pinned.summary, /Limit: up to 40 agent calls · 90 minutes$/);
});

function userSetup() {
  const user = mkdtempSync(join(tmpdir(), "codeflow-cli-user-")); repos.push(user);
  const env = { ...process.env, HOME: user, CODEX_HOME: join(user, ".codex"), CLAUDE_CONFIG_DIR: "", CODEFLOW_HOME: "" };
  const fake = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url)), calls: string[][] = [];
  const run = async (command: string, args: string[]) => { calls.push([command, ...args]); execFileSync(process.execPath, [fake, command, ...args], { env, stdio: "pipe" }); };
  const options = { home: join(user, "codeflow-home"), env, run };
  const claudeConfig = () => JSON.parse(readFileSync(join(user, ".claude.json"), "utf8"));
  return { user, env, calls, options, claudeConfig, codexConfig: join(user, ".codex", "config.toml"), claudeSkill: join(user, ".claude/skills/codeflow/SKILL.md"), codexSkill: join(user, ".codex/skills/codeflow/SKILL.md") };
}

test("a failed Claude update restores the working connection, and a setup that already matches is recorded as ours", async () => {
  const u = userSetup();
  await installUser(["claude"], false, u.options);
  const working = u.claudeConfig().mcpServers.codeflow;
  // The replacement registration fails after the old entry was removed.
  const moved = { ...u.options, env: { ...u.env, CODEFLOW_HOME: join(u.user, "elsewhere") }, run: async (command: string, args: string[]) => {
    if (args[1] === "add-json" && args[5]?.includes("elsewhere")) throw new Error("claude mcp add-json failed: timed out");
    await u.options.run(command, args);
  } };
  await assert.rejects(installUser(["claude"], false, moved), /timed out/);
  assert.deepEqual(u.claudeConfig().mcpServers.codeflow, working, "the previous connection is back");
  // An interrupted run left matching settings but no ownership record: setup records it without rewriting anything.
  const manifest = join(u.options.home, "cli-teams-installations", "user.json");
  rmSync(manifest); u.calls.length = 0;
  assert.equal((await installUser(["claude"], false, u.options)).changes.length, 0);
  assert.equal(u.calls.length, 0, "no configuration write was needed");
  assert.ok(existsSync(manifest), "ownership is recorded again");
  await uninstallUser(u.options);
  assert.equal(u.claudeConfig().mcpServers?.codeflow, undefined, "so uninstall can still remove it");
});

test("setup registers one connection per CLI in user settings and writes nothing into repositories", async () => {
  const u = userSetup(), project = repo();
  mkdirSync(join(u.user, ".codex")); writeFileSync(u.codexConfig, 'model = "existing"\n[mcp_servers.other]\ncommand = "other"\n');
  writeFileSync(join(u.user, ".claude.json"), JSON.stringify({ numStartups: 3, mcpServers: { other: { type: "stdio", command: "other", args: [] } } }));
  const dry = await installUser(["claude", "codex"], true, u.options);
  assert.equal(dry.changes.length, 4); assert.equal(u.calls.length, 0); assert.ok(!existsSync(u.claudeSkill));
  await installUser(["claude", "codex"], false, u.options);
  assert.deepEqual(u.claudeConfig().mcpServers.codeflow, { type: "stdio", command: "codeflow", args: ["mcp"] });
  assert.equal(u.claudeConfig().numStartups, 3, "unrelated Claude settings are kept");
  const codex = readFileSync(u.codexConfig, "utf8");
  assert.match(codex, /^model = "existing"\n\[mcp_servers\.other\]/); assert.match(codex, /\[mcp_servers\.codeflow\]\ncommand = "codeflow"\nargs = \["mcp"\]/);
  assert.doesNotMatch(codex + JSON.stringify(u.claudeConfig()), /project-root/, "the connection follows the folder the CLI starts in");
  assert.match(readFileSync(u.claudeSkill, "utf8"), /^---\n[\s\S]*Code Flow/); assert.equal(readFileSync(u.codexSkill, "utf8"), readFileSync(u.claudeSkill, "utf8"));
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: project, encoding: "utf8" }), "", "no repository files");
  assert.equal((await installUser(["claude", "codex"], false, u.options)).changes.length, 0, "a second run changes nothing");
  // Changed settings replace only Code Flow's own Claude entry.
  const moved = { ...u.options, env: { ...u.env, CODEFLOW_HOME: join(u.user, "elsewhere") } }; u.calls.length = 0;
  await installUser(["claude", "codex"], false, moved);
  assert.deepEqual(u.calls.map(c => c[2]), ["remove", "add-json"]); assert.deepEqual(u.claudeConfig().mcpServers.codeflow.env, { CODEFLOW_HOME: join(u.user, "elsewhere") });
  assert.ok(u.claudeConfig().mcpServers.other, "other servers are kept");
  writeFileSync(u.claudeSkill, readFileSync(u.claudeSkill, "utf8") + "\nMy own note\n");
  await assert.rejects(installUser(["claude"], false, u.options), /changed by you/);
  const removed = await uninstallUser(u.options);
  assert.ok(removed.preserved.includes(u.claudeSkill), "edited skill is kept"); assert.ok(!existsSync(u.codexSkill));
  assert.equal(readFileSync(u.codexConfig, "utf8"), 'model = "existing"\n[mcp_servers.other]\ncommand = "other"\n');
  assert.deepEqual(Object.keys(u.claudeConfig().mcpServers), ["other"]);
});

test("setup refuses to replace a codeflow connection the user created and changes nothing", async () => {
  const u = userSetup(); mkdirSync(join(u.user, ".codex"));
  writeFileSync(join(u.user, ".claude.json"), JSON.stringify({ mcpServers: { codeflow: { type: "stdio", command: "my-own" } } }));
  await assert.rejects(installUser(["claude", "codex"], false, u.options), /did not create/);
  assert.ok(!existsSync(u.codexConfig) && !existsSync(u.codexSkill)); assert.equal(u.calls.length, 0);
  writeFileSync(join(u.user, ".claude.json"), "{}"); writeFileSync(u.codexConfig, "invalid = [");
  await assert.rejects(installUser(["claude", "codex"], false, u.options)); assert.ok(!existsSync(u.claudeSkill), "all settings are checked before anything is written");
  // A failed Claude registration rolls back files already written.
  writeFileSync(u.codexConfig, "");
  await assert.rejects(installUser(["claude", "codex"], false, { ...u.options, run: async () => { throw new Error("claude unavailable"); } }), /claude unavailable/);
  assert.equal(readFileSync(u.codexConfig, "utf8"), ""); assert.ok(!existsSync(u.claudeSkill) && !existsSync(u.codexSkill));
});

test("init moves an old in-repository setup out of the repository", async () => {
  const project = repo(), mcp = { command: "/usr/local/bin/node", args: ["/Users/someone/.codeflow/integration-runtime/launcher.mjs", "mcp", "--project-root", project] };
  const text = JSON.stringify({ mcpServers: { codeflow: mcp } }, null, 2) + "\n"; writeFileSync(join(project, ".mcp.json"), text);
  const { realpathSync } = await import("node:fs"); const canonical = realpathSync(project);
  const skill = "---\nname: codeflow\n---\nOld skill\n", preferences = '{\n  "schemaVersion": 1,\n  "preferences": {}\n}\n';
  mkdirSync(join(project, ".claude/skills/codeflow"), { recursive: true }); writeFileSync(join(project, ".claude/skills/codeflow/SKILL.md"), skill);
  mkdirSync(join(project, ".claude/kept")); writeFileSync(join(project, ".claude/kept/note.md"), "mine\n");
  mkdirSync(join(project, ".codeflow")); writeFileSync(join(project, ".codeflow/cli-teams.json"), preferences);
  mkdirSync(join(home, "cli-teams-installations"), { recursive: true });
  writeFileSync(join(home, "cli-teams-installations", `${digest(canonical)}.json`), JSON.stringify({ version: 1, repo: canonical, state: "installed", edits: [{ path: join(canonical, ".mcp.json"), after: text, kind: "json", owned: digest(mcp) }, { path: join(canonical, ".claude/skills/codeflow/SKILL.md"), after: skill, kind: "skill", owned: digest(skill) }, { path: join(canonical, ".codeflow/cli-teams.json"), after: preferences, kind: "preferences", owned: "preferences-preserved" }] }));
  assert.equal(await hasProjectInstall(project), true);
  const user = mkdtempSync(join(tmpdir(), "codeflow-cli-user-")); repos.push(user);
  const out = execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../src/cli-teams/cli.ts", import.meta.url)), "init", "--providers", "codex"], { cwd: project, env: { ...process.env, HOME: user, CODEX_HOME: join(user, ".codex") }, encoding: "utf8" });
  assert.match(out, /Removed the old in-repository setup: \.mcp\.json/); assert.match(out, /Nothing is written into your repositories/);
  assert.ok(!existsSync(join(project, ".mcp.json"))); assert.equal(await hasProjectInstall(project), false);
  assert.ok(!existsSync(join(project, ".claude/skills")) && !existsSync(join(project, ".codeflow")), "empty folders and the untouched default preferences are removed");
  assert.ok(existsSync(join(project, ".claude/kept/note.md")), "a folder with other files is kept");
  assert.match(readFileSync(join(user, ".codex", "config.toml"), "utf8"), /\[mcp_servers\.codeflow\]/);
});

test("outside a Git repository the connection starts and explains instead of failing", async () => {
  const folder = mkdtempSync(join(tmpdir(), "codeflow-not-a-repo-")); repos.push(folder);
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../src/cli-teams/cli.ts", import.meta.url)), "mcp"], { cwd: folder, stdio: ["pipe", "pipe", "pipe"] });
  const replies: any[] = []; let buffer = "";
  child.stdout.on("data", chunk => { buffer += chunk; let end; while ((end = buffer.indexOf("\n")) >= 0) { replies.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); } });
  const ask = async (id: number, method: string, params: object) => { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); for (let i = 0; i < 300 && !replies.some(r => r.id === id); i++) await pause(50); return replies.find(r => r.id === id); };
  try {
    const init = await ask(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {} });
    assert.match(init.result.instructions, /not inside one/);
    assert.equal((await ask(2, "tools/list", {})).result.tools.length, CLI_TOOLS.length + 1);
    const call = await ask(3, "tools/call", { name: "codeflow_list_providers", arguments: {} });
    assert.equal(call.result.isError, true); assert.equal(call.result.structuredContent.error.code, "not_a_repository");
  } finally { child.kill(); }
});

test("an MCP session follows the backend across a restart and an expired connection, and reports its version", async () => {
  const f = await setup(); let bridge = await startCliTeamsTransport(f.service);
  const peer = await mcpPeer(f, {});
  try {
    assert.equal(peer.initialized.serverInfo.version, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
    assert.equal((await peer.call("list_runs").result).isError, false);
    // The backend is replaced (as an update hands over): the next call finds the new one and is sent once more.
    await bridge.close(); bridge = await startCliTeamsTransport(f.service);
    const live = () => [...(f.service as any).connections.values()].filter((c: any) => c.kind === "mcp" && c.id !== f.connection.id && c.active && c.expiresAt > Date.now()).map((c: any) => c.id);
    const first = live();
    const after = await peer.call("list_runs").result; assert.equal(after.isError, false, after.content?.[0]?.text);
    assert.equal(live().length, 1); assert.notDeepEqual(live(), first, "the session attached again");
    // The computer slept past the heartbeat: the same backend takes the session back.
    for (const c of (f.service as any).connections.values()) if (c.kind === "mcp" && c.id !== f.connection.id) c.expiresAt = 0;
    const woke = await peer.call("list_runs").result; assert.equal(woke.isError, false, woke.content?.[0]?.text);
    assert.equal(live().length, 1);
  } finally { await peer.close(); await bridge.close(); }
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
    const response = stdout.trim().split("\n").map(s => JSON.parse(s)).find(r => r.id === 2); assert.equal(response.result.tools.length, 15);
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
  let run: Run | undefined;
  stub(async opts => {
    calls++;
    if (!opts.jsonSchema) { drafts++; return { ok: true, finalText: "Durable plan" }; }
    if (opts.prompt.includes("PEER:") && !failed) {
      // A parallel failure cancels unfinished siblings. Exercise replay of a
      // durably completed review, not whichever sibling wins an I/O race.
      const authorSaved = () => Object.values(run?.cliTeam?.artifacts ?? {}).some(a => a.kind === "review" && a.participant === "author");
      for (let i = 0; i < 1000 && !authorSaved(); i++) await pause();
      assert.ok(authorSaved(), "author review must be durable before the peer fails");
      failed = true; return { ok: false, finalText: "", error: "Sign in required", errorKind: "auth" };
    }
    return { ok: true, finalText: JSON.stringify({ body: "Approved", verdict: "approve", findings: [] }) };
  });
  run = await start(f); await finished(run); assert.equal(run.status, "failed", run.error);
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
  const handoff = await f.call("preview_handoff", { runId: child.id });
  assert.equal(handoff.ready, true, handoff.reason); assert.match(handoff.diff, /\+export const value = 2/, "verification continuations retain the earlier implementation in their handoff");
  delete child.cliTeam!.source.handoffBase;
  const legacy = await f.call("preview_handoff", { runId: child.id });
  assert.equal(legacy.previewHash, handoff.previewHash, "older continuations resolve the original baseline from their owned history");
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

test("cancelled task questions remain in history without requesting or accepting answers", async () => {
  const f = await setup(); stub(); const c = planning();
  c.steps.unshift({ id: "choice", type: "user_decision", question: "Proceed?", options: ["Yes", "No"] });
  const run = await start(f, c);
  for (let i = 0; i < 300 && !Object.keys(run.cliTeam!.questions).length; i++) await pause();
  const waiting = await f.call("get_run", { runId: run.id }); const questionId = waiting.questions[0].id;
  await f.call("control_run", { runId: run.id, action: "cancel" }); await finished(run);
  const stopped = await f.call("get_run", { runId: run.id });
  assert.equal(stopped.progress.phase, "cancelled"); assert.deepEqual(stopped.questions, []); assert.deepEqual(stopped.assignments, []);
  assert.equal(stopped.progress.recent.at(-1).status, "interrupted");
  assert.ok(run.cliTeam!.questions[questionId], "Keep historical evidence");
  await assert.rejects(f.call("steer_run", { runId: run.id, questionId, message: "Yes" }), /no longer need answers/);
  assert.equal(run.cliTeam!.questions[questionId].answer, undefined);
});

test("cancelled host assignments do not ask a reconnected CLI to attach", async () => {
  const f = await setup();
  const run = await start(f, { scope: "plan", participants: [{ id: "host", provider: "codex", binding: "current_session" }], completion: ["Return a plan"], steps: [
    { id: "draft", type: "task", operation: "propose", participant: "host", instructions: "Write a plan" },
    { id: "result", type: "finish", outcome: "plan_ready", inputs: ["draft"] },
  ] });
  for (let i = 0; i < 300 && !Object.keys(run.cliTeam!.pending).length; i++) await pause();
  assert.equal((await f.call("get_run", { runId: run.id })).assignments.length, 1);
  await f.call("control_run", { runId: run.id, action: "cancel" }); await finished(run);
  assert.deepEqual((await f.call("get_run", { runId: run.id })).assignments, []);
  const reconnected = await f.service.connect(f.repo, "mcp");
  const status = await f.service.call(reconnected, "codeflow_get_run", { runId: run.id }) as any;
  assert.equal(status.progress.phase, "cancelled"); assert.equal(status.host.attachCommand, undefined);
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

test("an unsettled writer is visibly fenced before resume, including exhausted budgets and legacy receipts", async () => {
  const f = await setup(); let calls = 0;
  stub(async opts => { calls++; return { ok: true, finalText: opts.jsonSchema ? JSON.stringify({ body: "Approved", verdict: "approve", findings: [] }) : "Plan" }; });
  const run = await start(f); await finished(run);
  const priorCalls = calls, step = run.steps.find(s => s.kind === "agent")!;
  run.status = "interrupted"; step.mode = "write";
  const journal = new Map<string, unknown>([["cli-launch:lost", { stepId: step.id, assignment: "workflow/write", usedMs: 0, reservedMs: run.cliTeam!.definition.limits.maxMinutes * 60000 }]]);
  recoverCliAccounting(run, journal);
  assert.equal(run.cliTeam!.recoveryRequired, true, "old receipts use the persisted step mode");
  const status = await f.call("get_run", { runId: run.id });
  assert.equal(status.recovery.requiresReview, true);
  await assert.rejects(f.call("control_run", { runId: run.id, action: "resume" }), /interrupted writer.*preserved worktree/);
  assert.equal(calls, priorCalls); assert.equal(run.status, "interrupted");

  const missingStep = structuredClone(run); missingStep.steps = []; missingStep.cliTeam!.recoveryRequired = false;
  journal.set("cli-launch:lost", { stepId: step.id, mode: "write" });
  recoverCliAccounting(missingStep, journal);
  assert.equal(missingStep.cliTeam!.recoveryRequired, true, "new receipts carry mode even if step projection was lost");
  const settled = structuredClone(missingStep); settled.cliTeam!.recoveryRequired = false;
  journal.set(`cli-settled:${step.id}`, {}); recoverCliAccounting(settled, journal);
  assert.equal(settled.cliTeam!.recoveryRequired, false, "settled writes are not falsely fenced");
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
    let p = proposed.structuredContent.data; assert.equal(p.approvalMethod, "native_form"); assert.match(p.nextAction, /Paste the proposal card above into your reply word for word.*accept inside this session/s);
    const args = () => ({ operationId: `native-start-${p.revision}`, proposalId: p.proposalId, expectedRevision: p.revision, proposalHash: p.proposalHash });
    const denied = peer.call("start_run", args()), first = await peer.prompt();
    assert.match(first.params.message, /^Plan only, no file changes · Claude opus high \+ Codex gpt-a · up to \d+ calls, \d+ min\nAccept starts it\. Decline starts nothing\.\nDetails: run `codeflow open [a-f0-9]{32}` in a terminal\n\nTask: Plan a login form\n/); assert.doesNotMatch(first.params.message, new RegExp(p.proposalHash)); assert.equal(first.params.requestedSchema.properties.approve.default, true); assert.equal(first.params.requestedSchema.required, undefined); assert.equal(launches, 0);
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
    // Pressing Accept is the approval, even when the host sends no field values.
    peer.send({ id: fourth.id, result: { action: "accept" } });
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


test("desktop configs launch the same scoped MCP bridge from an unrelated cwd without project skills", async () => {
  const { configureDesktop, inspectDesktop } = await import("../src/cli-teams/desktop.js");
  const f = await setup(); stub();
  const userHome = await (await import("node:fs/promises")).realpath(mkdtempSync(join(tmpdir(), "codeflow-desktop-hosts-"))); repos.push(userHome);
  const options = { userHome, home, platform: "darwin" as const, codexHome: join(userHome, ".codex") };
  const bridge = await startCliTeamsTransport(f.service);
  try {
    await configureDesktop(f.repo, ["claude-desktop", "codex-app"], "setup", false, options);
    const connections = (await inspectDesktop(f.repo, ["claude-desktop", "codex-app"], options)).connections;
    assert.equal(existsSync(join(f.repo, ".agents")), false);
    assert.equal(existsSync(join(f.repo, ".claude")), false);
    for (const connection of connections) {
      assert.equal(connection.state, "configured");
      const native = connection.host === "codex-app";
      const peer = await mcpPeer(f, native ? { elicitation: { form: {} } } : {}, connection.command);
      try {
        assert.match(peer.initialized.instructions, /bound exclusively to repository/);
        assert.ok(peer.initialized.instructions.includes(JSON.stringify(await (await import("node:fs/promises")).realpath(f.repo))));
        assert.match(peer.initialized.instructions, /codeflow_get_guide/);
        assert.match(peer.initialized.instructions, /Managed workers must never|do not invoke provider CLIs/);
        assert.equal((await peer.request("tools/list", {}).result).tools.length, 15);
        const guide = (await peer.call("get_guide", { section: "candidate" }).result); assert.equal(guide.isError, false); assert.match(guide.content[0].text, /^## Candidate contract/);
        assert.ok(peer.initialized.instructions.length <= 4000, "instructions fit Claude Code's cap");
        const p = (await peer.call("propose_run", { operationId: `desktop-proposal-${connection.host}`, task: "Plan a login form", candidate: planning() }).result).structuredContent.data;
        const args = { operationId: `desktop-start-${connection.host}`, proposalId: p.proposalId, expectedRevision: p.revision, proposalHash: p.proposalHash };
        if (!native) {
          assert.equal((await peer.call("start_run", args).result).structuredContent.error.code, "acceptance_required");
          // The shared owner's human approval boundary, also used by browser acceptance.
          await f.service.accept(f.connection, p.proposalId, p.revision, p.proposalHash);
        }
        const started = peer.call("start_run", args);
        if (native) { const prompt = await peer.prompt(); peer.send({ id: prompt.id, result: { action: "accept", content: { approve: true } } }); }
        const result = await started.result; assert.equal(result.isError, false, JSON.stringify(result));
        const run = f.manager.get(result.structuredContent.data.runId)!; await finished(run);
        assert.equal(run.status, "done", run.error);
        const status = (await peer.call("get_run", { runId: run.id }).result).structuredContent.data;
        const artifact = (await peer.call("get_artifact", { runId: run.id, artifactId: status.result.id, sha256: status.result.sha256 }).result).structuredContent.data;
        assert.match(artifact.body, /Plan/);
        const other = await setup();
        const foreign = await start(other); await finished(foreign);
        assert.equal((await peer.call("get_run", { runId: foreign.id }).result).isError, true, "desktop connection cannot read another repository");
      } finally { await peer.close(); }
    }
  } finally { await bridge.close(); }
});
