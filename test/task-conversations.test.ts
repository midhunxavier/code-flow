import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type { Candidate, Node } from "../src/cli-teams/model.js";
const home = mkdtempSync(join(tmpdir(), "codeflow-web-tasks-"));
process.env.CODEFLOW_HOME = home;
process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
process.env.CODEFLOW_RETRY_DELAYS_MS = "0";
const { RunManager } = await import("../src/engine.js"), { Projects } = await import("../src/projects.js"), { findPattern, patterns } = await import("../src/patterns/index.js"), { CliTeamsService } = await import("../src/cli-teams/service.js"), { TaskConversations } = await import("../src/conversational/service.js"), { adapters } = await import("../src/adapters/index.js"), { flushWrites } = await import("../src/store.js"), { repoRoot } = await import("../src/git.js");
const original = { claude: adapters.claude.run, codex: adapters.codex.run }, managers: InstanceType<typeof RunManager>[] = [], directories: string[] = [];
let sequence = 0;
const { Conversations } = await import("../src/conversational/chats.js");
const pause = (ms = 15) => new Promise(r => setTimeout(r, ms));
after(async () => { adapters.claude.run = original.claude; adapters.codex.run = original.codex; for (const m of managers)
    await m.shutdown(); await flushWrites(); for (const p of directories)
    rmSync(p, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
function plan(): Candidate { return { scope: "plan", participants: [{ id: "planner", provider: "claude", model: "opus", effort: "high" }], completion: ["Return the requested plan"], steps: [{ id: "draft", type: "task", operation: "propose", participant: "planner", instructions: "Write the actual login plan" }, { id: "result", type: "finish", outcome: "plan_ready", inputs: ["draft"] }] }; }
function build(): Candidate { return { scope: "write", participants: [{ id: "builder", provider: "codex" }, { id: "reviewer", provider: "claude" }], check: "node --test app.test.mjs", completion: ["Value is 2 and its test passes"], steps: [{ id: "build", type: "task", operation: "implement", participant: "builder", instructions: "Set value to 2" }, { id: "check", type: "task", operation: "verify", instructions: "Run the test" }, { id: "review", type: "task", operation: "review_code", participant: "reviewer", instructions: "Independently review the change", inputs: ["build"] }, { id: "gate", type: "gate", policy: "verified", target: "build", verification: "check", reviews: ["review"] }, { id: "result", type: "finish", outcome: "verified_changes", inputs: ["build", "check", "review", "gate"] }] }; }

async function chatFixture(mode: "agent" | "team" = "team", candidate = plan()) {
    const f = await fixture(candidate), service = new Conversations(f.manager, f.service, f.service.authorize);
    await service.load();
    let reply: import("../src/conversational/chat-model.js").LeadReply = { kind: "proposal", body: "Review this proposed approach before starting.", candidate, target: "new" };
    let leadCalls = 0;
    const original = adapters.claude.run;
    const stub: typeof original = async (opts, emit) => {
        if (opts.prompt.includes("CODEFLOW_CHAT_LEAD")) { leadCalls++; return { ok: true, finalText: JSON.stringify(reply) }; }
        return original(opts, emit);
    };
    adapters.claude.run = stub; adapters.codex.run = stub;
    const created = await service.create({ operationId: `chat-${++sequence}`, project: f.project.id, repo: f.repo, defaults: { mode, provider: "claude", trust: "standard", tools: false } });
    const read = () => service.get(created.id);
    const act = async (action: string, extra: object = {}, operationId = `chat-op-${++sequence}`) => service.action(created.id, { action, ...extra, operationId, expectedVersion: (await read()).chat.version });
    const settle = async () => { let state = await read(); for (let i = 0; i < 2000 && state.turn; i++) { await pause(); state = await read(); } assert.ok(!state.turn, JSON.stringify(state.turn)); return state; };
    const taskAction = async (taskId: string, action: string, extra: object = {}, operationId?: string) => {
        const task = await f.service.get(taskId);
        return act("task", { taskId, input: { action, expectedVersion: task.task.version, ...extra } }, operationId);
    };
    const start = async (taskId: string) => {
        const task = await f.service.get(taskId), p = task.proposal!;
        await taskAction(taskId, "start", { proposalId: p.id, revision: p.revision, hash: p.hash });
        let state = await read(); for (let i = 0; i < 2000 && state.tasks.find(t => t.task.id === taskId)?.execution?.status === "running"; i++) { await pause(); state = await read(); } return state;
    };
    return { ...f, chats: service, chatId: created.id, read, act, settle, taskAction, startTask: start, setReply: (next: typeof reply) => { reply = next; }, leadCalls: () => leadCalls };
}

test("Agent chats run normally and duplicate replies keep one durable native session", async () => {
    const f = await chatFixture("agent");
    await f.act("send", { message: "Implement the value change" });
    const first = await f.settle();
    assert.equal(first.chat.taskIds.length, 0);
    assert.equal(f.leadCalls(), 0);
    assert.equal(first.chat.agentRuns.length, 1);
    const args = { action: "send", operationId: "same-native-reply", expectedVersion: first.chat.version, message: "Explain what changed" };
    await Promise.all([f.chats.action(f.chatId, args), f.chats.action(f.chatId, args)]);
    const done = await f.settle();
    assert.equal(done.chat.agentRuns.length, 1);
    assert.equal(done.chat.events.filter(e => e.kind === "user").length, 2);
    assert.equal(f.manager.get(done.chat.agentRuns[0]!)!.followUps.length, 1);
    assert.match(readFileSync(join(f.repo, "app.mjs"), "utf8"), /1/);
    const restored = new Conversations(f.manager, f.service, f.service.authorize); await restored.load();
    await restored.action(f.chatId, args);
    assert.equal((await restored.get(f.chatId)).chat.events.filter(e => e.kind === "answer").length, 2);
});

test("Team discussion uses contextual lead replies without creating a task or launching workers", async () => {
    const f = await chatFixture();
    f.setReply({ kind: "answer", body: "OAuth would change the authentication boundary; this is a design discussion." });
    await f.act("send", { message: "What would change if we used OAuth? Include model and effort tradeoffs." });
    const done = await f.settle();
    assert.equal(done.chat.taskIds.length, 0);
    assert.equal(done.leadUsage.calls, 1);
    assert.equal(f.counts().workers, 0);
    assert.match(done.chat.events.at(-1)!.body!, /design discussion/);
});

test("one chat owns several independently approved tasks and chronological durable results", async () => {
    const f = await chatFixture();
    await f.act("send", { message: "Plan a login form. Plan only." });
    const ready = await f.settle(), taskId = ready.chat.taskIds[0]!;
    assert.equal(ready.tasks[0]!.execution, undefined);
    assert.equal(f.counts().workers, 0);
    const first = await f.startTask(taskId);
    assert.equal(first.tasks[0]!.execution?.outcome, "plan_ready");
    assert.ok(first.chat.events.some(e => e.kind === "result" && e.artifact));
    f.setReply({ kind: "proposal", body: "A separate task will implement and verify the agreed behavior.", target: "new", candidate: build() });
    await f.act("send", { message: "Implement the value change now" });
    const next = await f.settle();
    assert.equal(next.chat.taskIds.length, 2);
    assert.equal(next.tasks[0]!.execution?.outcome, "plan_ready");
    const done = await f.startTask(next.chat.taskIds[1]!);
    assert.equal(done.tasks[1]!.execution?.outcome, "verified_changes");
    assert.equal(done.chat.events.filter(e => e.kind === "result").length, 2);
    const results = done.chat.events.filter(e => e.kind === "result");
    assert.ok(results[0]!.sequence < next.chat.events.find(e => e.body === "Implement the value change now")!.sequence);
    const history = await f.chats.list(f.project.id);
    assert.equal(history.filter(c => c.id === f.chatId).length, 1);
    assert.ok(history.find(c => c.id === f.chatId)!.runIds.includes(done.tasks[1]!.execution!.id));
    const restored = new Conversations(f.manager, f.service, f.service.authorize); await restored.load();
    const replay = await restored.get(f.chatId);
    assert.deepEqual(replay.chat.events, done.chat.events);
    assert.equal(replay.chat.taskIds.length, 2);
});

test("mode changes apply to future work and leave accepted models and limits unchanged", async () => {
    const f = await chatFixture();
    await f.act("send", { message: "Plan a login form. Plan only." });
    const ready = await f.settle(), accepted = structuredClone(ready.tasks[0]!.proposal!.definition);
    await f.act("defaults", { defaults: { mode: "agent", provider: "codex", model: "gpt-6-luna", effort: "high", trust: "standard", tools: false } });
    const updated = await f.read();
    assert.equal(updated.chat.defaults.mode, "agent");
    assert.deepEqual(updated.tasks[0]!.proposal!.definition, accepted);
    assert.equal(f.leadCalls(), 1, "Changing mode makes no inference call");
    const done = await f.startTask(updated.chat.taskIds[0]!);
    assert.deepEqual(done.tasks[0]!.proposal!.definition, accepted);
});

test("chat ownership, source freshness and explicit settings prevent unintended execution", async () => {
    const f = await chatFixture();
    await assert.rejects(f.act("task", { taskId: "unowned", input: { action: "start" } }), /another chat/);
    await assert.rejects(f.act("defaults", { defaults: { mode: "team", provider: "claude", model: 1, trust: "standard", tools: false } }), /Invalid model/);
    await f.act("send", { message: "Plan a login form. Plan only." });
    const ready = await f.settle(), task = ready.tasks[0]!, proposal = task.proposal!;
    writeFileSync(join(f.repo, "app.mjs"), "export const value = 3;\n");
    await assert.rejects(f.taskAction(task.task.id, "start", { proposalId: proposal.id, revision: proposal.revision, hash: proposal.hash }), /Repository changed/);
    assert.equal(f.counts().workers, 0);
    await f.projects.remove(f.project.id);
    await assert.rejects(f.read(), /membership changed/);
});

test("a new task inherits completed implementation only inside its owning conversation", async () => {
    const f = await chatFixture("team", build());
    await f.act("send", { message: "Implement the value change" });
    const ready = await f.settle(), built = await f.startTask(ready.chat.taskIds[0]!);
    const parent = built.tasks[0]!.execution!;
    const adapter = adapters.claude.run;
    adapters.claude.run = async (options, emit) => {
        if (options.prompt.includes("CODEFLOW_CHAT_LEAD")) assert.match(readFileSync(join(options.cwd, "app.mjs"), "utf8"), /2/, "The lead reads the retained implementation before proposing its next task");
        return adapter(options, emit);
    };
    const review: Candidate = { scope: "review", participants: [{ id: "reviewer", provider: "claude" }], completion: ["Report findings on the retained code"], steps: [{ id: "snapshot", type: "task", operation: "capture_snapshot", instructions: "Capture the retained changes" }, { id: "review", type: "task", operation: "review_code", participant: "reviewer", instructions: "Review the retained value", inputs: ["snapshot"] }, { id: "finish", type: "finish", outcome: "review_complete", inputs: ["review"] }] };
    f.setReply({ kind: "proposal", body: "Review the completed implementation without another writer.", candidate: review, target: "new" });
    await f.act("send", { message: "Review the completed changes. Review only." });
    const next = await f.settle();
    assert.equal(next.tasks[1]!.proposal!.context.continueRunId, parent.id);
    const done = await f.startTask(next.chat.taskIds[1]!);
    assert.equal(done.tasks[1]!.execution!.outcome, "review_complete");
    assert.match(readFileSync(join(done.tasks[1]!.execution!.worktrees[0]!.path, "app.mjs"), "utf8"), /2/);
    assert.equal(f.counts().writes, 1);
    await assert.rejects(f.service.create({ ...f.request, operationId: "foreign-chat" }, { chatId: "another-chat", continueRunId: parent.id }), /another conversation/);
});

test("an exhausted lead preserves the pending request until a larger total allowance is approved", async () => {
    const f = await chatFixture();
    f.setReply({ kind: "answer", body: "Discussion only; no workers." });
    for (let i = 0; i < 12; i++) { await f.act("send", { message: `Discuss option ${i}` }); await f.settle(); }
    await assert.rejects(f.act("send", { message: "Continue this discussion" }), /allowance is used/);
    const blocked = await f.read();
    assert.match(blocked.turn!.error!, /allowance is used/);
    assert.equal(f.leadCalls(), 12);
    await f.act("allowance", { maxCalls: 24, maxMinutes: 60 });
    const done = await f.settle();
    assert.equal(f.leadCalls(), 13);
    assert.equal(done.chat.events.filter(event => event.kind === "user" && event.body === "Continue this discussion").length, 1);
    assert.equal(f.counts().workers, 0);
});

test("attachment content is stored once, pinned to tasks and excluded from chat journal snapshots", async () => {
    const f = await chatFixture();
    const content = "Design context unique to the chat file";
    await f.act("send", { message: "Plan a login form. Plan only.", attachments: [{ name: "design.txt", data: Buffer.from(content).toString("base64") }] });
    const ready = await f.settle();
    assert.equal(ready.chat.files!.length, 1);
    assert.equal(ready.chat.files![0]!.bytes, content.length);
    assert.ok(!("data" in ready.chat.files![0]!));
    const proposal = f.core.getWebProposal({ repo: f.repo, project: f.project.id, taskId: ready.chat.taskIds[0]!, chatId: f.chatId }, ready.tasks[0]!.proposal!.id);
    assert.equal(Buffer.from(proposal.context.attachments![0]!.data, "base64").toString(), content);
    const journal = readFileSync(join(home, "runs/conversations.journal.jsonl"), "utf8");
    assert.ok(!journal.includes(Buffer.from(content).toString("base64")));
    assert.equal(journal.split("\n").filter(line => line.includes(`event:${f.chatId}:1`)).length, 1);
    await f.act("remove_file", { sha256: ready.chat.files![0]!.sha256 });
    const after = await f.read();
    assert.equal(after.chat.files!.length, 0);
    assert.equal(proposal.context.attachments!.length, 1, "Accepted proposal context remains pinned");
});

test("Agent-to-Team handoff includes uncommitted code and new files while preserving both indexes", async () => {
    const f = await chatFixture("agent");
    await f.act("send", { message: "Implement the value change" });
    const agent = await f.settle(), run = f.manager.get(agent.chat.agentRuns[0]!)!, tree = run.worktrees[0]!.path;
    writeFileSync(join(tree, "new-feature.txt"), "Agent work that must survive the handoff\n");
    const before = execFileSync("git", ["status", "--porcelain=v1"], { cwd: tree, encoding: "utf8" });
    await f.act("defaults", { defaults: { ...agent.chat.defaults, mode: "team" } });
    await f.act("send", { message: "Plan how to review the completed Agent changes. Plan only." });
    const ready = await f.settle();
    assert.equal(ready.tasks[0]!.proposal!.context.sourceRunId, run.id);
    assert.ok(ready.tasks[0]!.proposal!.source.untracked.includes("new-feature.txt"));
    const commit = ready.tasks[0]!.proposal!.source.commit;
    assert.match(execFileSync("git", ["show", `${commit}:app.mjs`], { cwd: f.repo, encoding: "utf8" }), /2/);
    assert.match(execFileSync("git", ["show", `${commit}:new-feature.txt`], { cwd: f.repo, encoding: "utf8" }), /must survive/);
    assert.equal(execFileSync("git", ["status", "--porcelain=v1"], { cwd: tree, encoding: "utf8" }), before);
    assert.match(readFileSync(join(f.repo, "app.mjs"), "utf8"), /1/);
    const done = await f.startTask(ready.chat.taskIds[0]!);
    assert.equal(done.tasks[0]!.execution?.outcome, "plan_ready");
    assert.match(readFileSync(join(done.tasks[0]!.execution!.worktrees[0]!.path, "new-feature.txt"), "utf8"), /must survive/);
});

test("queued messages freeze their settings and provider switches retain prior Agent changes", async () => {
    const f = await chatFixture("agent"), initial = adapters.claude.run;
    let release!: () => void, entered!: () => void, first = true;
    const held = new Promise<void>(resolve => release = resolve), started = new Promise<void>(resolve => entered = resolve);
    adapters.claude.run = async (options, emit) => { if (first && options.mode === "write") { first = false; entered(); await held; } return initial(options, emit); };
    adapters.codex.run = async (options, emit) => { if (options.mode === "write") assert.match(readFileSync(join(options.cwd, "app.mjs"), "utf8"), /2/, "The second provider sees the first provider's implementation"); return initial(options, emit); };
    try {
        await f.act("send", { message: "Implement the value change" }); await started;
        const state = await f.read();
        await f.act("defaults", { defaults: { ...state.chat.defaults, provider: "codex", effort: "high" } });
        await f.act("send", { message: "Check the completed implementation with Codex" });
        const queued = await f.read();
        assert.equal(queued.chat.queue!.length, 1);
        assert.equal(queued.chat.queue![0]!.defaults.provider, "codex");
        await f.act("defaults", { defaults: { ...state.chat.defaults, provider: "claude", effort: "low" } });
        assert.equal((await f.read()).chat.queue![0]!.defaults.effort, "high");
        release(); const done = await f.settle();
        assert.equal(done.chat.agentRuns.length, 2);
        assert.equal(done.chat.queue!.length, 0);
        assert.deepEqual(done.chat.events.filter(event => event.kind === "error").map(event => event.body), []);
        assert.equal(done.chat.events.filter(event => event.kind === "answer").length, 2);
    } finally { release(); }
});
async function fixture(candidate = plan()) {
    const dir = mkdtempSync(join(tmpdir(), "codeflow-web-repo-"));
    directories.push(dir);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    writeFileSync(join(dir, "app.mjs"), "export const value = 1;\n");
    writeFileSync(join(dir, "app.test.mjs"), "import {test} from 'node:test';import assert from 'node:assert/strict';import {value} from './app.mjs';test('value',()=>assert.equal(value,2));\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "fixture"], { cwd: dir });
    const repo = await repoRoot(dir), projects = new Projects(join(home, `projects-${++sequence}.json`));
    await projects.load();
    const project = await projects.create({ name: "Test project", repos: [repo] });
    const manager = new RunManager(findPattern, projects);
    managers.push(manager);
    const core = new CliTeamsService(manager);
    await core.load();
    const authorize = async (p: string, r: string) => { if (!projects.get(p)?.repos.includes(r))
        throw new Error("Project membership changed"); };
    const service = new TaskConversations(manager, core, authorize);
    await service.load();
    let prepared = 0, workers = 0, writes = 0;
    const stub: typeof adapters.claude.run = async (opts) => {
        if (opts.prompt.includes("CODEFLOW_WEB_PREPARATION")) {
            prepared++;
            return { ok: true, finalText: JSON.stringify({ kind: "proposal", candidate }) };
        }
        workers++;
        if (opts.mode === "write") {
            writes++;
            writeFileSync(join(opts.cwd, "app.mjs"), "export const value = 2;\n");
        }
        return { ok: true, finalText: opts.jsonSchema ? JSON.stringify({ body: "Approved supplied target", verdict: "approve", findings: [] }) : "Actual login plan: labels, validation, focus, and tests." };
    };
    adapters.claude.run = stub;
    adapters.codex.run = stub;
    const request = { operationId: `create-${++sequence}`, project: project.id, repo, request: candidate.scope === "write" ? "Implement the value change" : "Plan a login form", source: "working_changes", coordinator: { provider: "claude" } };
    const created = await service.create(request);
    const action = async (action: string, extra: object = {}) => service.action(created.id, { action, operationId: `op-${++sequence}`, expectedVersion: (await service.get(created.id)).task.version, ...extra });
    const settled = async (execution = false) => { let state = await service.get(created.id); for (let i = 0; i < 2000 && (execution ? state.execution?.status === "running" : state.task.preparation.active); i++) {
        await pause();
        state = await service.get(created.id);
    } return state; };
    const prepare = async () => { await action("prepare"); const state = await settled(); assert.ok(state.proposal, state.task.error); return state; };
    const start = async () => { const state = await service.get(created.id), p = state.proposal!; await action("start", { proposalId: p.id, revision: p.revision, hash: p.hash }); return settled(true); };
    return { service, core, manager, projects, project, repo, created, request, action, settled, prepare, start, counts: () => ({ prepared, workers, writes }), scope: { repo, project: project.id, taskId: created.id } };
}
test("preparation is private, bounded, and separate from the actual requested plan", async () => {
    const f = await fixture();
    assert.ok(!patterns.some(p => ["cli-team", "task-prepare"].includes(p.id)));
    await f.projects.remember(f.project.id, { pattern: "solo", roles: { agent: ["codex"] } });
    const defaults = f.projects.get(f.project.id)!.defaults;
    const p = await f.prepare();
    assert.deepEqual(f.counts(), { prepared: 1, workers: 0, writes: 0 });
    assert.equal(p.preparationUsage.calls, 1);
    assert.equal(p.proposal!.definition.limits.maxInvocations, 12);
    const result = await f.start();
    assert.equal(result.execution?.status, "done", result.execution?.error);
    assert.equal(result.execution?.outcome, "plan_ready");
    assert.equal(f.counts().workers, 1);
    assert.match(readFileSync(join(f.repo, "app.mjs"), "utf8"), /1/);
    const artifact = result.execution!.artifacts.find(a => a.kind === "result")!;
    const page = await f.service.artifact(f.created.id, result.execution!.id, artifact.id, artifact.sha256);
    assert.match(page.body, /Actual login plan/);
    assert.deepEqual(f.projects.get(f.project.id)!.defaults, defaults, "conversational tasks must not replace existing workflow defaults");
});
test("same-provider participants retain separate settings and fresh final contexts", async () => {
    const c = plan();
    c.participants.push({ id: "final-reviewer", provider: "claude", model: "opus", effort: "max" });
    c.steps.splice(1, 0, { id: "review", type: "task", operation: "review_plan", participant: "final-reviewer", instructions: "Fresh final review", inputs: ["draft"] }, { id: "gate", type: "gate", policy: "agreement", target: "draft", reviews: ["review"] });
    c.steps[c.steps.length - 1] = { id: "result", type: "finish", outcome: "agreed_plan", inputs: ["draft", "gate"] };
    const f = await fixture(c);
    const state = await f.prepare();
    assert.deepEqual(state.proposal!.definition.participants.map(p => p.effort), ["high", "max"]);
    const result = await f.start();
    assert.equal(result.execution?.outcome, "agreed_plan", result.execution?.error);
    assert.equal(f.counts().workers, 2);
});
test("one web action accepts and starts; retries and lost responses reconcile to one execution", async () => {
    const f = await fixture(), state = await f.prepare(), p = state.proposal!;
    const args = { operationId: "stable-start", expectedVersion: state.task.version, action: "start", proposalId: p.id, revision: p.revision, hash: p.hash };
    await Promise.all([f.service.action(f.created.id, args), f.service.action(f.created.id, args)]);
    const done = await f.settled(true);
    assert.equal(done.task.executions.length, 1);
    assert.equal(f.counts().workers, 1);
    await assert.rejects(f.service.action(f.created.id, { ...args, hash: "changed" }), /different arguments/);
    const reloaded = new TaskConversations(f.manager, f.core, async () => { });
    await reloaded.load();
    const restored = await reloaded.get(f.created.id);
    assert.equal(restored.execution?.id, done.execution!.id);
    assert.equal(restored.task.messages[0]!.body, f.request.request);
});
test("proposal edits preserve immutable history and stale revision/source cannot start", async () => {
    const f = await fixture(), first = await f.prepare();
    const changed = plan();
    changed.participants[0]!.effort = "low";
    await f.action("edit", { candidate: changed });
    const next = await f.service.get(f.created.id);
    assert.equal(next.proposal!.revision, 2);
    assert.match(next.task.changes.join(" "), /Participant/);
    const old = await f.service.approach(f.created.id, first.proposal!.id, 1);
    assert.equal(old.definition.participants[0]!.effort, "high");
    await assert.rejects(f.action("start", { proposalId: first.proposal!.id, revision: 1, hash: first.proposal!.hash }), /current approach/);
    writeFileSync(join(f.repo, "app.mjs"), "export const value = 3;\n");
    await assert.rejects(f.action("start", { proposalId: next.proposal!.id, revision: 2, hash: next.proposal!.hash }), /Repository changed/);
    assert.equal(f.counts().workers, 0);
    await f.action("edit", { candidate: changed });
    const done = await f.start();
    assert.equal(done.execution?.status, "done", done.execution?.error);
    assert.match(readFileSync(join(f.repo, "app.mjs"), "utf8"), /3/);
});
test("preparation retries and revisions share one allowance and extension is explicit", async () => {
    const f = await fixture();
    let calls = 0;
    adapters.claude.run = async () => { calls++; return { ok: true, finalText: "invalid JSON" }; };
    await f.action("prepare");
    const failed = await f.settled();
    assert.ok(failed.task.error);
    assert.equal(failed.preparationUsage.calls, 3);
    assert.equal(calls, 3);
    await assert.rejects(f.action("prepare"), /allowance is used/);
    await f.action("allow_preparation", { maxCalls: 6, maxMinutes: 10 });
    adapters.claude.run = async () => { calls++; return { ok: true, finalText: JSON.stringify({ kind: "proposal", candidate: plan() }) }; };
    const next = await f.prepare();
    assert.equal(next.preparationUsage.calls, 4);
    assert.equal(next.task.preparation.maxCalls, 6);
    assert.equal(calls, 4);
});
test("clarification and requested human checkpoints retain the conversation and block writes", async () => {
    const c = build();
    c.steps.unshift({ id: "design", type: "task", operation: "propose", participant: "reviewer", instructions: "Propose the design before implementation" }, { id: "choice", type: "user_decision", inputs: ["design"], continueOn: "Continue with this design", question: "Approve the proposed design before code editing?", options: ["Continue with this design", "Stop for revision"] });
    const f = await fixture(c);
    const p = await f.prepare();
    await f.action("start", { proposalId: p.proposal!.id, revision: p.proposal!.revision, hash: p.proposal!.hash });
    let waiting = await f.service.get(f.created.id);
    for (let i = 0; i < 300 && !waiting.execution?.questions.length; i++) {
        await pause();
        waiting = await f.service.get(f.created.id);
    }
    assert.equal(f.counts().writes, 0);
    assert.equal(waiting.execution!.questions.length, 1);
    await f.action("message", { message: "Use existing components" });
    const noted = await f.service.get(f.created.id);
    assert.ok(noted.task.messages.some(m => m.noteId));
    await f.action("answer", { questionId: waiting.execution!.questions[0]!.id, message: "Continue with this design" });
    const done = await f.settled(true);
    assert.equal(done.execution?.outcome, "verified_changes", done.execution?.error);
    assert.equal(f.counts().writes, 1);
    assert.ok(done.execution?.notes.some(n => n.status === "delivered"));
});
test("a reviewer-only continuation retains implementation and requires fresh acceptance", async () => {
    const f = await fixture(build());
    await f.prepare();
    const parent = await f.start();
    assert.equal(parent.execution?.outcome, "verified_changes", parent.execution?.error);
    const retained = build();
    retained.participants = [retained.participants[1]!];
    retained.steps[0] = { id: "build", type: "task", operation: "capture_snapshot", instructions: "Capture retained implementation" };
    await f.action("edit", { candidate: retained });
    const preview = await f.service.get(f.created.id);
    assert.equal(preview.task.executions.length, 1);
    assert.equal(preview.proposal!.context.continueRunId, parent.execution!.id);
    const child = await f.start();
    assert.equal(child.execution?.outcome, "verified_changes", child.execution?.error);
    assert.equal(child.task.executions.length, 2);
    assert.equal(f.counts().writes, 1);
    assert.match(readFileSync(join(child.execution!.worktrees[0]!.path, "app.mjs"), "utf8"), /2/);
    assert.match(readFileSync(join(f.repo, "app.mjs"), "utf8"), /1/);
});
test("project scope, managed bindings, and optimistic conversation revisions are enforced", async () => {
    const f = await fixture(), first = await f.prepare();
    const bad = plan();
    bad.participants[0]!.binding = "current_session";
    await assert.rejects(f.action("edit", { candidate: bad }), /browser is not an agent/);
    await assert.rejects(f.service.action(f.created.id, { action: "status", operationId: "stale-tab", expectedVersion: first.task.version }), /another view/);
    await assert.rejects(f.action("start", { request: "Change the scope without a proposal" }), /unsupported fields/);
    await f.projects.remove(f.project.id);
    await assert.rejects(f.service.get(f.created.id), /membership changed/);
    assert.equal(f.counts().workers, 0);
});
test("rejecting a design checkpoint stops before implementation and retains the exact plan", async () => {
    const candidate = build();
    candidate.steps.unshift({ id: "design", type: "task", operation: "propose", participant: "reviewer", instructions: "Propose a design for human review" }, { id: "approval", type: "user_decision", question: "Review this design before editing", options: ["Approve design", "Revise design"], inputs: ["design"], continueOn: "Approve design" });
    const f = await fixture(candidate), p = await f.prepare();
    await f.action("start", { proposalId: p.proposal!.id, revision: p.proposal!.revision, hash: p.proposal!.hash });
    let state = await f.service.get(f.created.id);
    for (let i = 0; i < 300 && !state.execution?.questions.length; i++) {
        await pause();
        state = await f.service.get(f.created.id);
    }
    const question = state.execution!.questions[0]!;
    assert.ok(question.inputs?.length);
    assert.equal(f.counts().writes, 0);
    await f.action("answer", { questionId: question.id, message: "Revise design" });
    const done = await f.settled(true);
    assert.equal(done.execution!.outcome, "blocked");
    assert.equal(f.counts().writes, 0);
    assert.ok(done.execution!.artifacts.some(a => a.kind === "plan"));
});
test("explicit plan-only instructions block a writing proposal until the user changes the request", async () => {
    const f = await fixture(build());
    await f.action("prepare", { request: "Plan the value change. Plan only." });
    const stopped = await f.settled();
    assert.equal(stopped.proposal, undefined);
    assert.match(stopped.task.error!, /planning\/review only/);
    assert.equal(f.counts().workers, 0);
    await f.action("prepare", { request: "Implement the value change now." });
    const revised = await f.settled();
    assert.ok(revised.proposal, revised.task.error);
    assert.equal(revised.task.executions.length, 0);
    const done = await f.start();
    assert.equal(done.execution!.outcome, "verified_changes", done.execution!.error);
});
