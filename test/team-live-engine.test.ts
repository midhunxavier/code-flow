import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pattern, Run, TeamContext } from "../src/engine.js";
import type { TeamState } from "../src/teams.js";
import type { TeamToolConnection } from "../src/team-tools.js";
import { applyMailboxCommand, type TeamMailboxCommand, type TeamMailboxAuthority } from "../src/team-mailbox.js";

const home = mkdtempSync(join(tmpdir(), "codeflow-team-live-"));
process.env.CODEFLOW_HOME = home;
process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
const { RunManager } = await import("../src/engine.js");
const { adapters } = await import("../src/adapters/index.js");
const { RUNS_DIR, loadJournal, flushWrites } = await import("../src/store.js");
const { memoryStore } = await import("../src/memory.js");
const { Projects } = await import("../src/projects.js");
const repo = mkdtempSync(join(tmpdir(), "codeflow-team-live-repo-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
writeFileSync(join(repo, "README.md"), "fixture\n");
execFileSync("git", ["add", "."], { cwd: repo });
execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "initial"], { cwd: repo });
after(async () => { await flushWrites(); rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

function state(): TeamState {
  return {
    version: 1, revision: 0, wave: 0, status: "running", requirements: [], contracts: [], rationale: "fixture",
    members: ["left", "right"].map((id) => ({ id, name: id, role: "worker", provider: "claude", model: "", effort: "", reason: "fixture", status: "working" })),
    tasks: ["left", "right"].map((id) => ({ id, owner: id, title: id, instructions: "inspect", kind: "investigation", dependsOn: [], requirements: [], acceptance: [], paths: [], status: "running", attempts: 1 })),
    invocationLimit: 8, coordinationLimit: 2, maxWaves: 4, maxRepairs: 2, messages: [], contextManifests: [], gaps: [],
    metrics: { invocations: 0, coordinatorInvocations: 0, questionCount: 0, blockedTurns: 0, revisions: 0 },
  };
}
function pattern(fn: (ctx: TeamContext) => Promise<string>): Pattern { return { id: "auto-team", name: "test", summary: "", description: "", roles: [], options: [], run: fn }; }
async function finished(run: Run) {
  const end = Date.now() + 15_000;
  while (run.status === "running") { if (Date.now() > end) throw new Error("Timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); }
}
async function tool(connection: TeamToolConnection, name: string, args: Record<string, unknown>) {
  const response = await fetch(connection.endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ name, arguments: args }) });
  return { status: response.status, body: await response.json() as any };
}
async function stub<T>(run: typeof adapters.claude.run, fn: () => Promise<T>) {
  const saved = adapters.claude.run; adapters.claude.run = run;
  try { return await fn(); } finally { adapters.claude.run = saved; }
}

test("live messages and next-turn messages share durable IDs; replay does not redispatch or double-deliver", async () => {
  let requestId = ""; let calls = 0; let oldCapability: TeamToolConnection | undefined;
  await stub(async (opts) => {
    calls++;
    assert.ok(opts.teamTools);
    if (opts.prompt.includes("sender-left")) {
      oldCapability = opts.teamTools;
      const args = { operationId: "ask-interface", recipient: "right", body: "Which interface?" };
      const question = await tool(opts.teamTools, "ask_member", args);
      assert.equal(question.status, 200, JSON.stringify(question.body));
      requestId = question.body.result.requestId;
      assert.deepEqual(await tool(opts.teamTools, "ask_member", args), question, "duplicate command returns its original receipt");
      const durable = await loadJournal(opts.teamTools.endpoint.split("/runs/")[1]!.split("/")[0]!, { strict: true });
      assert.equal([...durable].filter(([key]) => key.startsWith("team-command:")).length, 1);
    } else {
      assert.equal((await tool(oldCapability!, "read_inbox", {})).status, 403, "the prior turn's secret was revoked");
      const inbox = await tool(opts.teamTools, "read_inbox", {});
      assert.equal(inbox.body.result.messages.length, 1);
      assert.equal(inbox.body.result.messages[0].id, requestId);
      assert.equal(inbox.body.result.messages[0].origin, "agent");
      const reply = await tool(opts.teamTools, "reply_request", { operationId: "answer", requestId, body: "Use JSON", evidence: ["README.md"] });
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
    }
    return { ok: true, finalText: "done" };
  }, async () => {
    const p = pattern(async (ctx) => {
      const team = state(); ctx.setTeam(team);
      await ctx.drainTeamCommands(team, "before");
      for (const id of ["left", "right"]) {
        await ctx.ask({ title: id, role: "worker", agent: "claude", memberId: id, taskId: id, mode: "read", cwd: await ctx.worktree(id), prompt: id === "left" ? "sender-left" : "recipient-right" });
        await ctx.drainTeamCommands(team, `after-${id}`);
      }
      assert.equal(team.messages.length, 2);
      assert.equal(team.messages[0]!.status, "answered");
      assert.equal(team.messages[1]!.requestId, team.messages[0]!.id);
      return "done";
    });
    const manager = new RunManager(() => p);
    const run = await manager.start({ pattern: p, repo, task: "fixture", roles: {}, options: {}, approvals: { plan: false } });
    await finished(run); assert.equal(run.status, "done", run.error);
    const messages = structuredClone(run.team!.messages);
    run.patternDone = false;
    await manager.resume(run.id); await finished(run);
    assert.equal(run.status, "done", run.error);
    assert.equal(calls, 2, "recorded CLI turns replay without model calls");
    assert.deepEqual(run.team!.messages, messages);
    assert.equal(run.team!.commandReceipts!.length, 2);
  });
});

test("live memory uses server identity, preserves private provenance, and keeps team/project writes proposed", async () => {
  const projects = new Projects(); await projects.load();
  const project = await projects.create({ name: "Live memory", repos: [repo] });
  let leftPrivate = ""; let teamProposal = ""; let projectProposal = "";
  let currentTeam: TeamState;
  await stub(async (opts) => {
    assert.ok(opts.teamTools);
    if (opts.prompt.includes("writer-left")) {
      const team = await tool(opts.teamTools, "write_memory", { operationId: "team-note", scope: "team", title: "Interface", body: "Use the documented parser." });
      assert.equal(team.status, 200, JSON.stringify(team.body)); teamProposal = team.body.result.id;
      assert.equal(team.body.result.status, "proposed");
      const proposal = await tool(opts.teamTools, "propose_project_memory", { operationId: "project-note", title: "Parser convention", body: "Review this reusable lesson." });
      assert.equal(proposal.status, 200, JSON.stringify(proposal.body)); projectProposal = proposal.body.result.id;
      assert.equal(proposal.body.result.status, "proposed");
      const privateNote = await tool(opts.teamTools, "write_memory", { operationId: "private-note", scope: "private", title: "Private scratch", body: "private-material-sentinel" });
      assert.equal(privateNote.status, 200, JSON.stringify(privateNote.body)); leftPrivate = privateNote.body.result.id;
      const privateRead = await tool(opts.teamTools, "read_memory", { scope: "private" });
      assert.equal(privateRead.body.result.entries[0].id, leftPrivate);
      const retriedTeamWrite = await tool(opts.teamTools, "write_memory", { operationId: "team-note", scope: "team", title: "Interface", body: "Use the documented parser." });
      assert.equal(retriedTeamWrite.status, 200, JSON.stringify(retriedTeamWrite.body));
      assert.equal(retriedTeamWrite.body.result.id, teamProposal, "later reads do not change the causal provenance of an acknowledged write");
      const exportPrivate = await tool(opts.teamTools, "propose_project_memory", { operationId: "private-export", title: "Private copy", body: "private-material-sentinel" });
      assert.equal(exportPrivate.status, 400); assert.match(exportPrivate.body.error, /private/i);
      currentTeam.tasks[0]!.owner = "right";
      assert.equal((await tool(opts.teamTools, "read_memory", { scope: "private" })).status, 403, "reassignment revokes access during the same process");
      currentTeam.tasks[0]!.owner = "left";
      const members = currentTeam.members;
      currentTeam.members = members.map((member) => member.id === "left" ? { ...member, status: "retired" } : member);
      assert.equal((await tool(opts.teamTools, "read_memory", { scope: "private" })).status, 403, "identity is checked against the latest member projection");
      currentTeam.members = members;
    } else {
      const privateRead = await tool(opts.teamTools, "read_memory", { scope: "private" });
      assert.deepEqual(privateRead.body.result.entries, []);
      const teamRead = await tool(opts.teamTools, "read_memory", { scope: "team" });
      assert.deepEqual(teamRead.body.result.entries, []);
      assert.ok(teamRead.body.result.proposals.some((entry: any) => entry.id === teamProposal));
      const spoof = await tool(opts.teamTools, "read_memory", { scope: "private", memberId: "left" });
      assert.equal(spoof.status, 400);
      const projectRead = await tool(opts.teamTools, "read_memory", { scope: "project" });
      assert.deepEqual(projectRead.body.result.entries, [], "unaccepted project knowledge is excluded");
    }
    return { ok: true, finalText: "done" };
  }, async () => {
    const p = pattern(async (ctx) => {
      const team = state(); currentTeam = team; ctx.setTeam(team);
      await ctx.projectMemory("left", "left");
      for (const id of ["left", "right"]) {
        await ctx.ask({ title: id, role: "worker", agent: "claude", memberId: id, taskId: id, mode: "read", cwd: await ctx.worktree(id), prompt: id === "left" ? "writer-left" : "reader-right" });
        await ctx.drainTeamCommands(team, `after-${id}`);
      }
      await ctx.projectMemory("left", "left");
      return "done";
    });
    const manager = new RunManager(() => p, projects);
    const run = await manager.start({ pattern: p, repo, project: project.id, task: "fixture", roles: {}, options: {}, approvals: { plan: false } });
    await finished(run); assert.equal(run.status, "done", run.error);
    const entries = await memoryStore.list({ repo: run.repo, projectId: project.id, runId: run.id, memberId: "left" }, { kind: "user", repo: run.repo, projectId: project.id, runId: run.id });
    assert.equal(entries.find((entry) => entry.id === leftPrivate)?.memberId, "left");
    assert.equal(entries.find((entry) => entry.id === projectProposal)?.acceptedBy, undefined);
    const journal = await loadJournal(run.id, { strict: true });
    assert.equal([...journal.keys()].filter((key) => key.startsWith("team-project-memory:left|left#")).length, 2, "live callbacks do not consume pattern occurrence counters");
    assert.ok([...journal.keys()].some((key) => key.startsWith("team-tool-memory:")));
    assert.equal(readFileSync(join(RUNS_DIR, `${run.id}.journal.jsonl`), "utf8").includes("private-material-sentinel"), false, "live retrieval journaling keeps references only");
    run.patternDone = false; await manager.resume(run.id); await finished(run);
    assert.equal(run.status, "done", run.error);
    assert.equal((await memoryStore.list({ repo: run.repo, projectId: project.id, runId: run.id, memberId: "left" }, { kind: "user", repo: run.repo, projectId: project.id, runId: run.id })).length, entries.length);
  });
});

test("live memory honors assigned paths, search text and the returned-entry limit in its provenance", async () => {
  const projects = new Projects(); await projects.load();
  const project = await projects.create({ name: "Live memory retrieval", repos: [repo] });
  const canonicalRepo = project.repos[0]!;
  const authority = { kind: "user" as const, repo: canonicalRepo, projectId: project.id };
  const defaults = { scope: "project" as const, repo: canonicalRepo, projectId: project.id, paths: ["src"], applicability: { kind: "repository" as const } };
  await memoryStore.propose({ ...defaults, title: "Default fixture", body: "Default fixture instructions." }, authority);
  const target = await memoryStore.propose({ ...defaults, title: "Quasar indexing", body: "Quasar has a dedicated index." }, authority);
  await stub(async (opts) => {
    const read = await tool(opts.teamTools!, "read_memory", { scope: "project", query: "quasar", limit: 1 });
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.deepEqual(read.body.result.entries.map((entry: any) => entry.id), [target.id]);
    assert.deepEqual(read.body.result.manifest.included.map((ref: any) => ref.id), [target.id], "unseen entries must not enter provenance");
    const saved = await tool(opts.teamTools!, "write_memory", { operationId: "path-note", scope: "private", title: "Progress", body: "Scoped progress", paths: ["src"] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const privateRead = await tool(opts.teamTools!, "read_memory", { scope: "private" });
    assert.deepEqual(privateRead.body.result.entries.map((entry: any) => entry.id), [saved.body.result.id]);
    return { ok: true, finalText: "done" };
  }, async () => {
    const p = pattern(async (ctx) => {
      const team = state(); team.tasks[0]!.paths = ["src/index.ts"]; ctx.setTeam(team);
      await ctx.ask({ title: "Read memory", role: "worker", agent: "claude", memberId: "left", taskId: "left", mode: "read", cwd: await ctx.worktree("left"), prompt: "Read scoped memory" });
      await ctx.drainTeamCommands(team, "after-memory");
      return "done";
    });
    const manager = new RunManager(() => p, projects);
    const run = await manager.start({ pattern: p, repo, project: project.id, task: "default fixture", roles: {}, options: {}, approvals: { plan: false } });
    await finished(run); assert.equal(run.status, "done", run.error);
    assert.deepEqual(run.memoryManifest!.included.map((ref) => ref.id), [target.id]);
  });
});

test("agent steering is addressed, journaled before delivery, distinct from user notes, and never repeated on replay", async () => {
  // "late": the CLI answers only after the steering deadline. The receipt is unknown first, the answer
  // settles it later, and the message is never counted as refused in between.
  for (const mode of ["accepted", "refused", "late"] as const) {
    const accepted = mode !== "refused";
    let ready!: () => void; const receiverReady = new Promise<void>((resolve) => { ready = resolve; });
    let release!: () => void; const senderDone = new Promise<void>((resolve) => { release = resolve; });
    const steers: string[] = []; let calls = 0;
    let lateAnswer: Promise<boolean> | undefined;
    const savedClaude = adapters.claude.run; const savedCodex = adapters.codex.run;
    adapters.codex.run = async (opts) => {
      calls++;
      const runId = opts.teamTools!.endpoint.split("/runs/")[1]!.split("/")[0]!;
      opts.onSteerable?.(async (text) => {
        const journal = await loadJournal(runId, { strict: true });
        assert.ok([...journal.keys()].some((key) => key.startsWith("team-command:")), "message is durable before transport");
        assert.ok([...journal.keys()].some((key) => key.startsWith("team-steering:") && key.endsWith(":intent")), "intent is durable before steering");
        steers.push(text);
        if (mode !== "late") return accepted;
        lateAnswer = new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 3_000));
        return lateAnswer;
      });
      ready(); await senderDone;
      if (mode === "late") {
        // The turn ends only once the late answer is journaled, so the final drain can settle it.
        await lateAnswer;
        const end = Date.now() + 5_000;
        while (![...(await loadJournal(runId, { strict: true })).keys()].some((key) => key.endsWith(":settled"))) {
          if (Date.now() > end) throw new Error("The late steering answer was not journaled");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      opts.onSteerable?.(undefined);
      return { ok: true, finalText: "receiver done" };
    };
    adapters.claude.run = async (opts) => {
      calls++; await receiverReady;
      try {
        const result = await tool(opts.teamTools!, "send_message", { operationId: "live-fact", recipient: "right", body: "Contract is ready; this is not user permission." });
        assert.equal(result.status, 200, JSON.stringify(result.body));
      } finally { release(); }
      return { ok: true, finalText: "sender done" };
    };
    try {
      const p = pattern(async (ctx) => {
        const team = state(); team.members[1]!.provider = "codex"; ctx.setTeam(team);
        const trees = await Promise.all([ctx.worktree("left"), ctx.worktree("right")]);
        await ctx.drainTeamCommands(team, "before");
        await ctx.parallel(["left", "right"], (id, i) => ctx.ask({ title: id, role: "worker", agent: id === "left" ? "claude" : "codex", memberId: id, taskId: id, mode: "read", cwd: trees[i]!, prompt: id }));
        await ctx.drainTeamCommands(team, "after");
        return "done";
      });
      const manager = new RunManager(() => p);
      const run = await manager.start({ pattern: p, repo, task: "fixture", roles: {}, options: {}, approvals: { plan: false } });
      await finished(run); assert.equal(run.status, "done", run.error);
      assert.equal(steers.length, 1); assert.match(steers[0]!, /^Agent-origin team message/);
      const payload = JSON.parse(steers[0]!.split("\n").slice(1).join("\n"));
      assert.equal(payload.origin, "agent"); assert.equal(payload.recipient, "right"); assert.equal(payload.sender, "left");
      assert.equal(payload.id, run.team!.messages[0]!.id);
      assert.equal(run.team!.messages[0]!.delivery?.status, accepted ? "steered" : "queued");
      const journal = await loadJournal(run.id, { strict: true });
      const receipt = [...journal.entries()].find(([key]) => key.startsWith("team-steering:") && key.endsWith(":receipt"))?.[1] as { accepted: boolean | "unknown" } | undefined;
      assert.equal(receipt?.accepted, mode === "late" ? "unknown" : accepted, "a deadline that passes records an unknown outcome, never a refusal");
      if (mode === "late") assert.equal(([...journal.entries()].find(([key]) => key.endsWith(":settled"))?.[1] as { accepted: boolean }).accepted, true, "the late answer is journaled and settles the outcome");
      assert.equal(run.notes.length, 0, "agent data never becomes a user note");
      run.patternDone = false; await manager.resume(run.id); await finished(run);
      assert.equal(run.status, "done", run.error);
      assert.equal(steers.length, 1, "physical steering is not replayed"); assert.equal(calls, 2);
      assert.equal(run.team!.messages[0]!.delivery?.status, accepted ? "steered" : "queued");
    } finally { release(); adapters.claude.run = savedClaude; adapters.codex.run = savedCodex; }
  }
});

test("a durable stale command stays rejected after reassignment makes its sender eligible, including overlay and replay", async () => {
  let calls = 0;
  const command: TeamMailboxCommand = { type: "send_message", operationId: "stale-before-reassignment", recipient: "right", body: "This rejected command must never appear" };
  const authority: TeamMailboxAuthority = { memberId: "left", taskId: "left", attempt: 1, stepId: "old-turn", origin: "agent" };
  await stub(async (opts) => {
    calls++;
    const inbox = await tool(opts.teamTools!, "read_inbox", {});
    assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
    assert.deepEqual(inbox.body.result.messages, [], "pending command overlay honors its recorded rejection");
    return { ok: true, finalText: "done" };
  }, async () => {
    const p = pattern(async (ctx) => {
      const team = state(); team.tasks[0]!.owner = "right"; ctx.setTeam(team);
      const recorded = await ctx.remember("team-command", "stale-before-reassignment", async () => {
        const { receipt } = applyMailboxCommand(team, command, authority, 100);
        assert.equal(receipt.status, "stale");
        return { command, authority, at: 100, receipt };
      });
      team.tasks[0]!.owner = "left";
      assert.equal(applyMailboxCommand(team, command, authority, 101).receipt.status, "accepted", "the changed assignment would otherwise make this command valid");
      await ctx.ask({ title: "Read pending inbox", role: "worker", agent: "claude", memberId: "right", taskId: "right", mode: "read", cwd: await ctx.worktree("right"), prompt: "Read only the right member's inbox." });
      await ctx.drainTeamCommands(team, "after-reassignment");
      assert.deepEqual(team.messages, []);
      assert.deepEqual(team.commandReceipts, [recorded.receipt], "the original stale receipt remains authoritative");
      return "done";
    });
    const manager = new RunManager(() => p);
    const run = await manager.start({ pattern: p, repo, task: "fixture", roles: {}, options: {}, approvals: { plan: false } });
    await finished(run); assert.equal(run.status, "done", run.error);
    run.patternDone = false; await manager.resume(run.id); await finished(run);
    assert.equal(run.status, "done", run.error);
    assert.equal(calls, 1); assert.deepEqual(run.team!.messages, []);
    assert.equal(run.team!.commandReceipts![0]!.status, "stale");
  });
});
