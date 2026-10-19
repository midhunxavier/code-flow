// Opt-in acceptance test: starts a real ACP CLI using its configured account/model.
// No mocks, installations, or changes to the user's code-flow settings.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acpPresets, acpPresetConnection } from "../src/adapters/acp-presets.ts";
import { commandExists } from "../src/adapters/process.ts";
import { approveLiveAcpRequest } from "./acp-live-approval.ts";

const args = process.argv.slice(2);
const usage = "Usage: npm run test:acp:live -- [--agent opencode|kilo|cline]\nUses the CLI's saved authentication and consumes real model usage.\nOverride its executable with CODEFLOW_LIVE_OPENCODE, CODEFLOW_LIVE_KILO or CODEFLOW_LIVE_CLINE; optionally set CODEFLOW_LIVE_MODEL.";
if (args.length === 1 && args[0] === "--help") { console.log(usage); process.exit(0); }
if (args.length && (args.length !== 2 || args[0] !== "--agent")) throw new Error(usage);
const preset = acpPresets.find((item) => item.key === (args[1] ?? "opencode"));
if (!preset) throw new Error(usage);
const connection = acpPresetConnection(preset);
connection.command = process.env[`CODEFLOW_LIVE_${preset.key.toUpperCase()}`] ?? connection.command;
if (!await commandExists(connection.command)) throw new Error(`${preset.name} executable not found: ${connection.command}. Install with ${preset.install}, then sign in with ${preset.login}.`);
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "codeflow-acp-live-"));
const repo = join(directory, "repo"), home = join(directory, "home");
const token = randomBytes(24).toString("hex"), headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const model = process.env.CODEFLOW_LIVE_MODEL;
const delay = (ms) => new Promise((accept) => setTimeout(accept, ms));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const port = await new Promise((accept) => { const listener = createServer().listen(0, "127.0.0.1", () => { const port = listener.address().port; listener.close(() => accept(port)); }); });
const base = `http://127.0.0.1:${port}`;
let server, runId, streamAbort, streamTask;
const liveEvents = [], approved = [];
const startedAt = new Date().toISOString();
async function api(path, body, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
  const value = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(value)}`);
  return value;
}
async function startServer() {
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: root, env: { ...process.env, PORT: String(port), CODEFLOW_HOME: home, CODEFLOW_TOKEN: token,
      CODEFLOW_EXTENSIONS_FILE: "", CODEFLOW_EXTENSIONS_JSON: "", CODEFLOW_STEP_TIMEOUT_MIN: "3", CODEFLOW_STEP_IDLE_MIN: "2" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (data) => appendFileSync(join(directory, "server.log"), data));
  server.stderr.on("data", (data) => appendFileSync(join(directory, "server.log"), data));
  for (let index = 0; index < 150; index++) {
    if (server.exitCode !== null) throw new Error(`Server exited; see ${directory}/server.log`);
    if (await fetch(base + "/api/acp-connections", { headers }).then((response) => response.ok, () => false)) return;
    await delay(100);
  }
  throw new Error("Server did not become ready");
}
async function stopServer() {
  streamAbort?.abort();
  try { await streamTask; }
  finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      const timer = setTimeout(() => server.kill("SIGKILL"), 10_000); timer.unref();
      await exited; clearTimeout(timer);
    }
  }
}
function watchRun() {
  streamAbort = new AbortController();
  streamTask = (async () => {
    const response = await fetch(`${base}/api/runs/${runId}/events`, { headers, signal: streamAbort.signal });
    assert.ok(response.ok, "Run event stream opened");
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
        if (data) liveEvents.push(JSON.parse(data));
      }
    }
  })().catch((error) => { if (!streamAbort.signal.aborted) throw error; });
  // Attach a handler immediately; still rethrow any stream failure when awaiting shutdown.
  void streamTask.catch(() => {});
}
async function completed(agentTurns) {
  const deadline = Date.now() + 240_000;
  let previous = "";
  while (Date.now() < deadline) {
    const run = await api(`/api/runs/${runId}`);
    const status = `${run.status}: ${run.steps.map((step) => `${step.title} (${step.status})`).join(", ")}`;
    if (status !== previous) { console.log(status); previous = status; }
    for (const request of await api(`/api/approvals?run=${runId}`)) {
      if (request.status !== "pending") continue;
      assert.ok(approveLiveAcpRequest(request, run.worktrees, connection.id), `Unexpected approval requires inspection: ${JSON.stringify(request)}`);
      await api(`/api/approvals/${request.id}`, { decision: "approve" }); approved.push(request.id);
    }
    if (run.status !== "running" && run.steps.filter((step) => step.agent === connection.id).length >= agentTurns) {
      writeFileSync(join(directory, `run-${agentTurns}.json`), JSON.stringify(run, null, 2));
      assert.equal(run.status, "done", run.error);
      for (const step of run.steps.filter((step) => step.agent === connection.id)) assert.equal(step.status, "done", step.error);
      assert.equal(run.verdict, "passed", "code-flow's check must pass");
      return run;
    }
    await delay(500);
  }
  throw new Error(`Real ${connection.name} run did not finish within four minutes`);
}

try {
  console.log(`Live ${connection.name} acceptance evidence: ${directory}`);
  mkdirSync(repo); mkdirSync(home);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Code Flow Live Test"); git(repo, "config", "user.email", "live-test@example.invalid");
  writeFileSync(join(repo, "slugify.mjs"), "export function slugify(value) { return value; }\n");
  const tests = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from './slugify.mjs';\nfor (const [input, expected] of [['Hello World', 'hello-world'], ['  Space \\t Test  ', 'space-test'], ['Hello, ACP!!!', 'hello-acp'], ['', '']]) test(JSON.stringify(input), () => assert.equal(slugify(input), expected));\n`;
  writeFileSync(join(repo, "slugify.test.mjs"), tests);
  git(repo, "add", "."); git(repo, "commit", "-qm", "Failing slugify acceptance tests");
  const baseline = spawnSync(process.execPath, ["--test"], { cwd: repo, encoding: "utf8" });
  assert.equal(baseline.status, 1, "Baseline must fail before the agent's change");
  writeFileSync(join(directory, "baseline.txt"), baseline.stdout + baseline.stderr);
  await startServer();
  const probe = await api("/api/acp-connections/check", { connection });
  console.log(`Connected: ${probe.agent} ${probe.version}; model ${model ?? probe.catalog.defaultModel}; resume ${probe.sessionResume}`);
  assert.equal(probe.protocolVersion, 1); assert.equal(probe.sessionResume, true);
  const settings = await api("/api/acp-connections");
  await api("/api/acp-connections", { revision: settings.revision, connection });
  const phrase = `orbit-marble-${randomBytes(8).toString("hex")}`;
  const created = await api("/api/runs", {
    pattern: "solo", repo, roles: { agent: [connection.id] }, trust: "full", approvals: { tools: true },
    agentSettings: { [connection.id]: { model: model ?? probe.catalog.defaultModel } },
    task: `Implement slugify(value) in slugify.mjs: lowercase ASCII text, replace each run of non-alphanumeric characters with a hyphen, trim leading/trailing hyphens. Change only slugify.mjs; do not change tests. Run node --test. Remember the verification phrase ${phrase} in this conversation for a later reply; don't put it in files or your answer yet.`,
    loop: { setup: "", check: "node --test", copy: [] }, options: {},
  });
  runId = created.id; watchRun();
  const first = await completed(1), tree = first.worktrees[0];
  assert.ok(tree, "Code-flow created an isolated worktree");
  assert.equal(readFileSync(join(tree.path, "slugify.test.mjs"), "utf8"), tests, "Agent left the tests intact");
  assert.equal(git(tree.path, "rev-list", "--count", "main..HEAD"), "1", "Code-flow committed the edit");
  assert.equal(git(tree.path, "status", "--porcelain"), "");
  const firstStep = first.steps.find((step) => step.agent === connection.id);
  assert.ok(firstStep.sessionId); assert.ok(firstStep.finalText);
  assert.ok(liveEvents.some((event) => event.type === "agent" && event.stepId === firstStep.id && event.event.kind === "text"), "Assistant text reached the live SSE stream");
  assert.ok(liveEvents.some((event) => event.type === "agent" && event.stepId === firstStep.id && event.event.kind === "tool_call"), "Tool calls reached the live SSE stream");
  console.log("Initial turn passed: streamed text/tools, real edit, unchanged tests, passing check, clean commit.");
  // A fresh server also proves settings/run persistence and session/load across processes.
  await stopServer(); await startServer();
  assert.deepEqual((await api("/api/acp-connections")).connections, [connection]);
  watchRun();
  await api(`/api/runs/${runId}/followups`, { kind: "reply", worktree: tree.name, agent: connection.id,
    message: "Write session-proof.txt containing only the verification phrase I asked you to remember in our previous turn, followed by a newline. Do not change any other files. Run node --test, then briefly confirm." });
  const second = await completed(2), steps = second.steps.filter((step) => step.agent === connection.id);
  assert.equal(steps[1].sessionId, firstStep.sessionId, `Follow-up reused the real ${connection.name} session`);
  assert.equal(readFileSync(join(tree.path, "session-proof.txt"), "utf8"), `${phrase}\n`, "Restored session remembered prior conversation");
  assert.equal(readFileSync(join(tree.path, "slugify.test.mjs"), "utf8"), tests);
  assert.equal(git(tree.path, "rev-list", "--count", "main..HEAD"), "2");
  assert.equal(git(tree.path, "status", "--porcelain"), "");
  execFileSync(process.execPath, ["--test"], { cwd: tree.path, stdio: "pipe" });
  assert.equal(git(repo, "rev-list", "--count", "HEAD"), "1", "Original branch is unchanged");
  const receipt = { passed: true, startedAt, finishedAt: new Date().toISOString(), connection, agent: probe.agent, version: probe.version, model: model ?? probe.catalog.defaultModel, runId,
    sessionId: firstStep.sessionId, turns: 2, commits: git(tree.path, "log", "--format=%h %s", "main..HEAD").split("\n"),
    checks: second.steps.filter((step) => step.kind === "check").map((step) => ({ title: step.title, status: step.status })),
    liveEventCount: liveEvents.length, approvals: approved.length, worktree: tree.path };
  writeFileSync(join(directory, "receipt.json"), JSON.stringify(receipt, null, 2));
  writeFileSync(join(directory, "events.json"), JSON.stringify(liveEvents, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await stopServer();
  console.log(`Evidence retained in ${directory}`);
}
