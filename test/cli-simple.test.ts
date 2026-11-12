import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const home = mkdtempSync(join(tmpdir(), "codeflow-cli-simple-"));
process.env.CODEFLOW_HOME = home;
process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
process.env.CODEFLOW_RETRY_DELAYS_MS = "0";
delete process.env.CODEFLOW_TOOLS; delete process.env.CODEFLOW_HOST_PROVIDER; delete process.env.CLAUDECODE;
const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { adapters } = await import("../src/adapters/index.js");
const { CliTeamsService } = await import("../src/cli-teams/service.js");
const { CLI_TOOLS, HOST_TOOLS } = await import("../src/cli-teams/tools.js");
const { validateCandidate } = await import("../src/cli-teams/model.js");
const { composeRecipe, hostProvider } = await import("../src/cli-teams/recipes.js");
const { SIMPLE_TOOLS, advertisedTools, proposeRecipe, runStatus, previewApply, simpleCall, formatStatusResult, RESULTS_DIR } = await import("../src/cli-teams/simple.js");
const { summarizeMetrics, readMetrics, METRICS_FILE } = await import("../src/cli-teams/metrics.js");
const { flushWrites } = await import("../src/store.js");
const { startCliTeamsTransport } = await import("../src/cli-teams/transport.js");

const managers: InstanceType<typeof RunManager>[] = [], folders: string[] = [];
const original = { claude: adapters.claude.run, codex: adapters.codex.run };
const pause = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
after(async () => { adapters.claude.run = original.claude; adapters.codex.run = original.codex; for (const manager of managers) await manager.shutdown(); await flushWrites(); for (const folder of folders) rmSync(folder, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
function repo() {
  const p = mkdtempSync(join(tmpdir(), "codeflow-simple-repo-")); folders.push(p);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: p });
  writeFileSync(join(p, "app.mjs"), "export const value = 1;\n");
  writeFileSync(join(p, "app.test.mjs"), "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from './app.mjs'; test('value',()=>assert.equal(value,2));\n");
  execFileSync("git", ["add", "."], { cwd: p });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "initial"], { cwd: p }); return p;
}
let operation = 0;
async function setup() {
  const manager = new RunManager(findPattern); managers.push(manager);
  const service = new CliTeamsService(manager); await service.load();
  const root = repo(), connection = await service.connect(root);
  const call = (name: string, args: any = {}) => service.call(connection, name, args) as Promise<any>;
  return { manager, service, connection, call, repo: root };
}
/** Fake providers: a writer fixes the value, a reviewer approves, anything else returns a plan. */
function stub(seen: { provider: string; mode: string }[] = []) {
  for (const provider of ["claude", "codex"] as const) adapters[provider].run = async opts => {
    seen.push({ provider, mode: opts.mode });
    if (opts.mode === "write") writeFileSync(join(opts.cwd, "app.mjs"), "export const value = 2;\n");
    return { ok: true, finalText: opts.jsonSchema ? JSON.stringify({ body: "Reviewed app.mjs line 1", verdict: "approve", findings: [] }) : "Plan: set value to 2 and run the test." };
  };
  return seen;
}
async function approveAndStart(f: Awaited<ReturnType<typeof setup>>, proposal: any) {
  await f.service.accept(f.connection, proposal.proposalId, proposal.revision, proposal.proposalHash);
  return (await f.call("codeflow_start_run", { operationId: `start-${++operation}`, proposalId: proposal.proposalId, expectedRevision: proposal.revision, proposalHash: proposal.proposalHash })).runId as string;
}
async function finished(call: (name: string, args?: any) => Promise<any>, runId: string) {
  for (let i = 0; i < 60; i++) { const status = await runStatus(call, { runId, waitSeconds: 2 }); if (status.state !== "working") return status; }
  throw new Error("The run did not settle");
}

test("recipes compose valid candidates and prefer a different provider for the second opinion", () => {
  const installed = ["claude", "codex"] as const;
  const review = composeRecipe({ mode: "review", host: "claude", installed: [...installed] });
  validateCandidate(review.candidate);
  assert.deepEqual(review.roles, [{ role: "reviewer", provider: "codex" }]);
  assert.equal(review.candidate.scope, "review");
  assert.equal(composeRecipe({ mode: "review", host: "codex", installed: [...installed] }).roles[0]!.provider, "claude");

  const two = composeRecipe({ mode: "review", team: [{ provider: "claude", model: "opus" }, { provider: "codex" }], installed: [...installed] });
  validateCandidate(two.candidate);
  assert.equal(two.candidate.participants[0]!.model, "opus");
  assert.equal(two.candidate.steps.find(s => s.type === "parallel")?.type, "parallel");

  const alone = composeRecipe({ mode: "review", host: "claude", installed: ["claude"] });
  assert.equal(alone.roles[0]!.provider, "claude");
  assert.match(alone.notes.join(" "), /not from a different provider/);

  const plan = composeRecipe({ mode: "plan", host: "claude", installed: [...installed] });
  validateCandidate(plan.candidate);
  assert.deepEqual(plan.roles.map(r => `${r.role}:${r.provider}`), ["drafter:claude", "reviewer:codex"]);
  const solo = composeRecipe({ mode: "plan", installed: ["codex"] });
  validateCandidate(solo.candidate);
  assert.equal(solo.candidate.participants.length, 1);
  assert.match(solo.notes.join(" "), /no independent review/);

  const build = composeRecipe({ mode: "implement", host: "claude", installed: [...installed], check: "npm test" });
  validateCandidate(build.candidate);
  assert.deepEqual(build.roles.map(r => `${r.role}:${r.provider}`), ["writer:claude", "reviewer:codex"]);
  assert.equal(build.candidate.check, "npm test");
  const loop = build.candidate.steps[0]!;
  assert.ok(loop.type === "loop" && loop.maxIterations === 2, "one repair pass at most");

  assert.throws(() => composeRecipe({ mode: "implement", installed: [...installed] }), /needs a check command/);
  assert.throws(() => composeRecipe({ mode: "review", installed: [...installed], check: "npm test" }), /never executes project commands/);
  assert.throws(() => composeRecipe({ mode: "review", installed: ["claude"], team: [{ provider: "codex" }] }), /Codex is not installed/);
  assert.throws(() => composeRecipe({ mode: "review", installed: [] }), /No provider CLI/);
  // Antigravity is experimental: not picked while another provider is installed, never the writer.
  assert.equal(composeRecipe({ mode: "review", host: "claude", installed: ["claude", "agy"] }).roles[0]!.provider, "claude");
  assert.equal(composeRecipe({ mode: "review", installed: ["agy"] }).roles[0]!.provider, "agy");
  assert.throws(() => composeRecipe({ mode: "review", installed: ["agy"], agyAvailable: false }), /sandbox is unavailable/);
  assert.throws(() => composeRecipe({ mode: "implement", installed: ["claude", "agy"], team: [{ provider: "agy" }], check: "x" }), /can review here but not write/);

  assert.equal(hostProvider("claude-code", {}), "claude");
  assert.equal(hostProvider("codex-mcp-client", {}), "codex");
  assert.equal(hostProvider("something else", {}), undefined);
  assert.equal(hostProvider(undefined, { CLAUDECODE: "1" }), "claude");
  assert.equal(hostProvider("claude-code", { CODEFLOW_HOST_PROVIDER: "codex" }), "codex");
});

test("the default surface lists six tools; all adds the advanced ones without duplicates", () => {
  const advanced = [...CLI_TOOLS, ...HOST_TOOLS];
  assert.deepEqual(advertisedTools("simple", advanced).map(t => t.name), ["codeflow_run", "codeflow_start_run", "codeflow_status", "codeflow_steer_run", "codeflow_apply", "codeflow_providers"]);
  const all = advertisedTools("all", advanced).map(t => t.name);
  assert.equal(all.length, advanced.length + 4); assert.equal(new Set(all).size, all.length);
  assert.ok(Buffer.byteLength(JSON.stringify(SIMPLE_TOOLS)) < Buffer.byteLength(JSON.stringify(advanced)) / 2, "the default surface costs less than half the context");
});

test("a review recipe runs with another provider and the result lands in a file", async () => {
  const f = await setup(), seen = stub();
  writeFileSync(join(f.repo, "app.mjs"), "export const value = 3;\n");
  const proposal = await proposeRecipe(f.call, { operationId: "review-1", task: "Review my change to app.mjs", mode: "review" }, "claude");
  assert.deepEqual(proposal.recipe.roles, [{ role: "reviewer", provider: "codex" }]);
  assert.match(proposal.summary, /Review only/);
  const runId = await approveAndStart(f, proposal), status = await finished(f.call, runId);
  assert.equal(status.state, "finished"); assert.equal(status.outcome, "review_complete");
  assert.deepEqual(seen, [{ provider: "codex", mode: "read" }]);
  assert.ok(status.resultFile!.startsWith(RESULTS_DIR));
  const text = readFileSync(status.resultFile!, "utf8");
  assert.match(text, /Reviewed app\.mjs line 1/); assert.match(text, /Verdict: approved/); assert.match(text, /SHA-256 [a-f0-9]{64}/);
  assert.match(status.next, /Read .*and present it/);
  assert.equal(status.delivery, undefined, "a review delivers no branch");
  assert.equal(status.usage!.calls, 1);
  assert.match(formatStatusResult(status), /Result file: /);
  // The user's own files and index are untouched.
  assert.equal(readFileSync(join(f.repo, "app.mjs"), "utf8"), "export const value = 3;\n");
  // Asking again reuses the file instead of paging the artifact again.
  const again = await runStatus(async (name, args) => { assert.notEqual(name, "codeflow_get_artifact"); return f.call(name, args); }, { runId });
  assert.equal(again.resultFile, status.resultFile);
  // Two status calls for a newly finished run write the file at the same time without colliding.
  rmSync(status.resultFile!);
  const both = await Promise.all([runStatus(f.call, { runId }), runStatus(f.call, { runId })]);
  assert.deepEqual(both.map(b => b.resultFile), [status.resultFile, status.resultFile]); assert.ok(existsSync(status.resultFile!));
  const listed = await simpleCall(f.call, "codeflow_status", {}, { nativeForm: false });
  assert.equal(listed.runs[0].runId, runId);
});

test("an implement recipe delivers a branch, a merge command and a dry-run diff file", async () => {
  const f = await setup(), seen = stub();
  await assert.rejects(proposeRecipe(f.call, { operationId: "build-0", task: "Set value to 2", mode: "implement" }, "claude"), /needs a check command/);
  const proposal = await proposeRecipe(f.call, { operationId: "build-1", task: "Set value to 2", mode: "implement", check: "node --test app.test.mjs" }, "claude");
  assert.match(proposal.summary, /separate worktree/);
  const runId = await approveAndStart(f, proposal), status = await finished(f.call, runId);
  assert.equal(status.state, "finished", status.message); assert.equal(status.outcome, "verified_changes");
  assert.deepEqual(seen.map(s => `${s.provider}:${s.mode}`), ["claude:write", "codex:read"]);
  assert.ok(status.delivery, "a finished implementation says where the changes are");
  assert.match(status.delivery!.check!, /^passed: node --test/); assert.equal(status.delivery!.reviews, 1);
  assert.equal(status.delivery!.merge, `git merge ${status.delivery!.branch}`);
  assert.equal(readFileSync(join(f.repo, "app.mjs"), "utf8"), "export const value = 1;\n", "nothing reaches the checkout before the user applies it");
  const dry = await simpleCall(f.call, "codeflow_apply", { runId }, { nativeForm: true });
  assert.equal(dry.ready, true); assert.match(readFileSync(dry.diffFile, "utf8"), /\+export const value = 2;/);
  assert.match(dry.next, /Nothing was changed/);
  assert.equal(readFileSync(join(f.repo, "app.mjs"), "utf8"), "export const value = 1;\n");
  assert.equal((await previewApply(f.call, runId, false)).previewHash, dry.previewHash);
  // Applying still needs the user's confirmation; the simple tool cannot supply it.
  await assert.rejects(simpleCall(f.call, "codeflow_apply", { runId, previewHash: dry.previewHash }, { nativeForm: true }), /confirm/i);
  await assert.rejects(simpleCall(f.call, "codeflow_steer_run", { operationId: "x", runId }, { nativeForm: true }), /unknown|action|Unknown/i);
  const paused = await simpleCall(f.call, "codeflow_steer_run", { operationId: "resume-1", runId, action: "resume" }, { nativeForm: true });
  assert.equal(paused.accepted, false, "a finished task does not resume");
});

async function peer(root: string, capabilities: object, env: Record<string, string> = {}) {
  const user = mkdtempSync(join(tmpdir(), "codeflow-simple-user-")); folders.push(user);
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../src/cli-teams/cli.ts", import.meta.url)), "mcp", "--project-root", root], { cwd: "/", env: { ...process.env, HOME: user, CLAUDE_CONFIG_DIR: "", CODEX_HOME: join(user, ".codex"), ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, (value: any) => void>(), prompts: any[] = [];
  let sequence = 0, buffered = "";
  const send = (message: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  child.stdout.on("data", chunk => {
    buffered += chunk; let end: number;
    while ((end = buffered.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffered.slice(0, end)); buffered = buffered.slice(end + 1);
      if (message.method === "elicitation/create") prompts.push(message); else pending.get(message.id)?.(message.result ?? message);
    }
  });
  const request = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 40000); pending.set(id, value => { clearTimeout(timer); resolve(value); }); send({ id, method, params }); });
  const initialized = await request("initialize", { protocolVersion: "2025-11-25", capabilities, clientInfo: { name: "claude-code", version: "9.9.9" } });
  return {
    initialized, send, request, prompts,
    call: (name: string, args: object = {}) => request("tools/call", { name: `codeflow_${name}`, arguments: args }),
    async prompt() { for (let i = 0; i < 1000 && !prompts.length; i++) await pause(); assert.ok(prompts.length, "expected a native confirmation"); return prompts.shift(); },
    async close() { child.stdin.end(); for (let i = 0; i < 500 && child.exitCode === null; i++) await pause(); if (child.exitCode === null) child.kill("SIGTERM"); },
  };
}

test("over MCP a host needs three calls: run, start with the user's approval, status with a result file", async () => {
  const f = await setup(); stub();
  const transport = await startCliTeamsTransport(f.service), host = await peer(f.repo, { elicitation: { form: {} } });
  try {
    assert.match(host.initialized.instructions, /codeflow_run/); assert.doesNotMatch(host.initialized.instructions, /codeflow_get_guide/);
    assert.ok(host.initialized.instructions.length <= 4000);
    assert.equal((await host.request("tools/list")).tools.length, 6);
    const proposed = await host.call("run", { operationId: "mcp-run-1", task: "Review the repository entry point", mode: "review" });
    assert.equal(proposed.isError, false, proposed.content[0].text);
    const proposal = proposed.structuredContent.data;
    // The client is Claude Code, so the second opinion is Codex.
    assert.deepEqual(proposal.recipe.roles, [{ role: "reviewer", provider: "codex" }]);
    assert.match(proposed.content[0].text, /Chosen team: reviewer: codex/); assert.match(proposed.content[0].text, /Next: .*codeflow_start_run/);
    assert.equal(f.manager.list().length, 0, "nothing runs before approval");
    const starting = host.call("start_run", { operationId: "mcp-start-1", proposalId: proposal.proposalId, expectedRevision: proposal.revision, proposalHash: proposal.proposalHash });
    const form = await host.prompt();
    host.send({ id: form.id, result: { action: "accept", content: { approve: true } } });
    const started = await starting;
    assert.equal(started.isError, false, started.content[0].text);
    const runId = started.structuredContent.data.runId;
    assert.equal(started.structuredContent.data.background.wait, `codeflow wait ${runId}`);
    assert.match(started.content[0].text, /runs in the background/);
    let status: any;
    for (let i = 0; i < 20; i++) { status = await host.call("status", { runId, waitSeconds: 5 }); if (status.structuredContent.data.state !== "working") break; }
    assert.equal(status.structuredContent.data.state, "finished", status.content[0].text);
    assert.ok(existsSync(status.structuredContent.data.resultFile));
    assert.match(status.content[0].text, /Result file: /);
    const providers = await host.call("providers");
    assert.equal(providers.isError, false); assert.match(providers.content[0].text, /codex: CLI found/);
    // An advanced tool stays callable for a host that still has the older skill.
    assert.equal((await host.call("get_run", { runId })).isError, false);
    const declined = await host.call("run", { operationId: "mcp-run-2", task: "x", mode: "implement" });
    assert.equal(declined.isError, true); assert.match(declined.content[0].text, /check command/);
  } finally { await host.close(); await transport.close(); }
  for (let i = 0; i < 100 && !existsSync(METRICS_FILE); i++) await pause();
  const [summary] = summarizeMetrics(await readMetrics());
  assert.equal(summary!.host, "claude-code"); assert.deepEqual(summary!.versions, ["9.9.9"]);
  assert.equal(summary!.proposals, 1); assert.equal(summary!.started, 1); assert.equal(summary!.finished, 1);
  assert.equal(summary!.errors.validation_failed, 1);
  assert.doesNotMatch(readFileSync(METRICS_FILE, "utf8"), /entry point/, "no task text is recorded");
});

test("codeflow tools all lists the advanced tools to a host", async () => {
  const f = await setup(), transport = await startCliTeamsTransport(f.service), host = await peer(f.repo, {}, { CODEFLOW_TOOLS: "all" });
  try {
    assert.match(host.initialized.instructions, /codeflow_get_guide/);
    const names = (await host.request("tools/list")).tools.map((t: any) => t.name);
    assert.equal(names.length, CLI_TOOLS.length + HOST_TOOLS.length + 4);
    assert.ok(names.includes("codeflow_propose_run") && names.includes("codeflow_run"));
  } finally { await host.close(); await transport.close(); }
});

function cli(root: string, args: string[]) {
  const user = mkdtempSync(join(tmpdir(), "codeflow-simple-cli-")); folders.push(user);
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../src/cli-teams/cli.ts", import.meta.url)), ...args, "--project-root", root], { env: { ...process.env, HOME: user, CLAUDE_CONFIG_DIR: "", CODEX_HOME: join(user, ".codex") }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = ""; child.stdout.on("data", c => out += c); child.stderr.on("data", c => err += c);
  const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
  return new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => { child.on("error", reject); child.on("exit", code => { clearTimeout(timer); resolve({ code, out, err }); }); });
}

test("from a shell without a terminal, codeflow run stops for the user's approval and codeflow wait reports the result file", async () => {
  const f = await setup(); stub();
  const transport = await startCliTeamsTransport(f.service);
  try {
    const asked = await cli(f.repo, ["run", "Review the entry point", "--mode", "review", "--by", "codex", "--json"]);
    assert.equal(asked.code, 3, asked.err);
    const offer = JSON.parse(asked.out);
    assert.equal(offer.started, false); assert.match(offer.approve, /^codeflow approve [a-f0-9]{32} --revision 1$/);
    assert.match(asked.err, /needs the user's approval/);
    assert.equal(f.manager.list().length, 0);
    // An agent's shell cannot approve: the command insists on the user's own terminal.
    const refused = await cli(f.repo, ["approve", offer.proposalId, "--revision", "1"]);
    assert.notEqual(refused.code, 0); assert.match(refused.err, /interactive terminal/);
    // The user approves (here through the owner, standing in for their terminal); wait starts and follows it.
    const waiting = cli(f.repo, ["wait", offer.proposalId, "--revision", "1"]);
    await pause(300);
    const preview = await f.service.acceptancePreview(f.connection, offer.proposalId, 1);
    await f.service.accept(f.connection, offer.proposalId, 1, preview.hash);
    const done = await waiting;
    assert.equal(done.code, 0, done.err + done.out);
    assert.match(done.out, /^Finished · review complete/); assert.match(done.out, /Result file: .*\.md/);
    const again = await cli(f.repo, ["wait", f.manager.list()[0]!.id, "--json"]);
    assert.equal(again.code, 0, again.err); assert.equal(JSON.parse(again.out).state, "finished");
    assert.match((await cli(f.repo, ["snippet"])).out, /codeflow run/);
    assert.match((await cli(f.repo, ["tools"])).out, /six simple/);
  } finally { await transport.close(); }
});

test("metrics summarize the funnel per host", () => {
  const base = { session: "s1", host: "codex-mcp-client", hostVersion: "1.0", ms: 5 };
  const [h] = summarizeMetrics([
    { ...base, at: 1000, tool: "codeflow_run", ok: true, proposalId: "p1" },
    { ...base, at: 2000, tool: "codeflow_start_run", ok: false, code: "acceptance_declined", proposalId: "p1" },
    { ...base, at: 3000, tool: "codeflow_run", ok: true, proposalId: "p2" },
    { ...base, at: 13000, tool: "codeflow_start_run", ok: true, proposalId: "p2", runId: "r2" },
    { ...base, at: 20000, tool: "codeflow_status", ok: true, runId: "r2", state: "working" },
    { ...base, at: 73000, tool: "codeflow_status", ok: true, runId: "r2", state: "finished" },
  ]);
  assert.deepEqual({ proposals: h!.proposals, started: h!.started, declined: h!.declined, finished: h!.finished }, { proposals: 2, started: 1, declined: 1, finished: 1 });
  assert.equal(h!.medianSecondsToApproval, 10); assert.equal(h!.medianSecondsToResult, 60); assert.equal(h!.callsPerStartedTask, 6);
});

test("the Claude Code plugin carries the same skill, connection and version as the release", () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const plugin = JSON.parse(read("integrations/plugins/claude-code/.claude-plugin/plugin.json")), market = JSON.parse(read(".claude-plugin/marketplace.json"));
  assert.equal(plugin.version, JSON.parse(read("package.json")).version, "bump the plugin version with the release");
  assert.equal(read("integrations/plugins/claude-code/skills/codeflow/SKILL.md"), read("integrations/cli-teams/SKILL.md"), "copy integrations/cli-teams/SKILL.md into the plugin");
  assert.deepEqual(JSON.parse(read("integrations/plugins/claude-code/.mcp.json")).mcpServers.codeflow, { command: "codeflow", args: ["mcp"] });
  assert.deepEqual(market.plugins.map((p: any) => [p.name, p.source]), [[plugin.name, "./integrations/plugins/claude-code"]]);
  assert.ok(read("integrations/cli-teams/SKILL.md").length < 2000, "the skill stays short");
});
