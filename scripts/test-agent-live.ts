/** Explicit opt-in smoke test using the user's real Claude/Codex subscriptions in disposable worktrees. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
if (process.env.CODEFLOW_TEST_LIVE_AGENTS !== "1") throw new Error("Set CODEFLOW_TEST_LIVE_AGENTS=1 to run the real provider smoke test");
const fixture = await mkdtemp(join(tmpdir(), "codeflow-agent-parity-"));
process.env.CODEFLOW_HOME = join(fixture, "state");
process.env.CODEFLOW_STEP_TIMEOUT_MIN = "5";
process.env.CODEFLOW_STEP_IDLE_SEC = "90";
const repo = join(fixture, "repo"); await (await import("node:fs/promises")).mkdir(repo);
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString().trim();
git("init", "-q", "-b", "main"); await writeFile(join(repo, "README.md"), "Isolated real-provider smoke test\n"); git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "Fixture");
const page = createServer((_req, response) => { response.setHeader("content-type", "text/html"); response.end(`<title>Codeflow browser test</title><h1>Browser test</h1><label>Name <input aria-label="Name"></label><button onclick="document.querySelector('output').textContent='Hello '+document.querySelector('input').value">Greet</button><output></output>`); });
await new Promise<void>(resolve => page.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(page.address() as { port: number }).port}`;
const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const manager = new RunManager(findPattern);
type Run = import("../src/engine.js").Run;
async function done(run: Run) {
  const deadline = Date.now() + 7 * 60_000;
  while (run.status === "running" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
  if (run.status === "running") { manager.cancel(run.id); throw new Error("Live smoke test timed out"); }
  await writeFile(join(fixture, `${run.id}.json`), JSON.stringify({ run, events: await manager.events(run.id) }, null, 2));
  assert.equal(run.status, "done", run.error); return run;
}
manager.subscribeAll(run => { if (run.status !== "running") console.log(run.roles.agent?.[0], run.id, run.status); });
const evidence: unknown[] = [];
try {
  for (const provider of ["claude", "codex"] as const) {
    const run = await manager.start({ pattern: findPattern("solo")!, repo, roles: { agent: [provider] }, options: {}, trust: "standard", loop: { maxMinutes: 5, maxSteps: 8 }, task: `Remember the token cobalt-731 for later. Use the codeflow_agent browser tools to open ${url}, fill Name with Codeflow, click Greet, and take a browser screenshot. Inspect the response. Write proof.txt containing exactly Hello Codeflow followed by a newline using your file tools. Do not use shell HTTP clients or commit. Finish with the browser response and the token.` });
    const unsubscribe = manager.subscribe(run.id, event => { if (event.type === "agent" && event.event.kind === "tool_call") console.log(provider, "tool", event.event.name); });
    await done(run); unsubscribe();
    const first = run.steps.find(step => step.kind === "agent")!;
    assert.ok(first.sessionId, "The provider confirmed a session");
    assert.equal(await readFile(join(run.worktrees[0]!.path, "proof.txt"), "utf8"), "Hello Codeflow\n");
    const events = await manager.events(run.id);
    assert.ok(events.some(event => event.type === "agent" && event.event.kind === "text" && event.event.delta), "Real streaming deltas reached the engine");
    assert.ok(events.some(event => event.type === "agent" && event.event.kind === "tool_call" && event.event.name.includes("browser_navigate")), "Provider used the common browser tools");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: run.worktrees[0]!.path }).toString().trim();
    assert.equal(head, git("rev-parse", "HEAD"), "No automatic commit");
    await manager.followUp(run.id, { kind: "reply", agent: provider, worktree: "solo", message: "What token did I give you earlier? Read proof.txt and answer with the token and file content. Do not change files." });
    await done(run);
    const last = run.steps.filter(step => step.kind === "agent").at(-1)!;
    assert.equal(last.sessionId, first.sessionId, "Continued the native session");
    assert.match(last.finalText ?? "", /cobalt-731/); assert.match(last.finalText ?? "", /Hello Codeflow/);
    const child = await manager.startProviderChat(run.id, { agent: provider === "claude" ? "codex" : "claude", message: "Read the carried conversation context and proof.txt. What was the remembered token and browser greeting? Answer only; do not change files." });
    await done(child); assert.match(child.summary ?? "", /cobalt-731/); assert.match(child.summary ?? "", /Hello Codeflow/);
    assert.equal(child.worktrees[0]!.path, run.worktrees[0]!.path);
    const fork = await manager.startProviderChat(run.id, { agent: provider, message: "In this fork, reply with the remembered token only. Do not use tools." });
    await done(fork); assert.match(fork.summary ?? "", /cobalt-731/);
    assert.notEqual(fork.steps.find(step => step.kind === "agent")?.sessionId, first.sessionId, "Native fork has an independent session");
    evidence.push({ nativeFork: fork.id, provider, run: run.id, session: first.sessionId, handoff: child.id, streamed: true, browser: true, continued: true, context: true });
    console.log(provider, "PASS: streaming, browser, edit, resume, cross-provider context");
  }
} finally { await manager.shutdown(); await new Promise<void>(resolve => page.close(() => resolve())); await writeFile(join(fixture, "evidence.json"), JSON.stringify(evidence, null, 2)); console.log("Evidence:", fixture); }
