import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pattern, Run, TeamContext } from "../src/engine.js";
import type { TeamState } from "../src/teams.js";

const home = mkdtempSync(join(tmpdir(), "codeflow-team-engine-"));
process.env.CODEFLOW_HOME = home;
process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
process.env.CODEFLOW_RETRY_DELAYS_MS = "0";
const { RunManager } = await import("../src/engine.js");
const { adapters } = await import("../src/adapters/index.js");
const { RUNS_DIR, journalEntry, loadJournal, flushWrites } = await import("../src/store.js");
const repo = mkdtempSync(join(tmpdir(), "codeflow-team-engine-repo-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
writeFileSync(join(repo, "README.md"), "fixture\n");
execFileSync("git", ["add", "."], { cwd: repo });
execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "initial"], { cwd: repo });
after(async () => { await flushWrites(); rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

function state(limit = 8, coordinationLimit = 2): TeamState {
  return {
    version: 1, revision: 0, wave: 0, status: "running", requirements: [], contracts: [], rationale: "fixture", tasks: [],
    members: ["left", "right"].map((id) => ({ id, name: id, role: "worker", provider: "claude", model: "", effort: "", reason: "fixture" })),
    invocationLimit: limit, coordinationLimit, maxWaves: 4, maxRepairs: 2, messages: [], contextManifests: [], gaps: [],
    metrics: { invocations: 0, coordinatorInvocations: 0, questionCount: 0, blockedTurns: 0, revisions: 0 },
  };
}
function pattern(fn: (ctx: TeamContext) => Promise<string>): Pattern {
  return { id: "auto-team", name: "test", summary: "", description: "", roles: [], options: [], run: fn };
}
async function until(fn: () => boolean) {
  const end = Date.now() + 10_000;
  while (!fn()) { if (Date.now() > end) throw new Error("Timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); }
}
async function finished(run: Run) { await until(() => run.status !== "running"); }
const start = (manager: InstanceType<typeof RunManager>, p: Pattern) => manager.start({ pattern: p, repo, task: "fixture", roles: {}, options: {}, approvals: { plan: false } });

async function stub<T>(run: typeof adapters.claude.run, fn: () => Promise<T>) {
  const saved = adapters.claude.run;
  adapters.claude.run = run;
  try { return await fn(); } finally { adapters.claude.run = saved; }
}

test("journal failure is surfaced without poisoning later writes; strict recovery rejects damaged committed records", async () => {
  mkdirSync(join(RUNS_DIR, "bad.journal.jsonl"), { recursive: true });
  await assert.rejects(journalEntry("bad", "step", 1));
  await journalEntry("healthy", "step", 2);
  assert.equal((await loadJournal("healthy", { strict: true })).get("step"), 2);
  writeFileSync(join(RUNS_DIR, "torn.journal.jsonl"), '{"key":"ok","value":1,"v":2}\n{"key":"incomplete"');
  assert.deepEqual([...await loadJournal("torn", { strict: true })], [["ok", 1]]);
  await journalEntry("torn", "next", 2);
  assert.deepEqual([...await loadJournal("torn", { strict: true })], [["ok", 1], ["next", 2]], "a resumed append discards the torn tail before the second restart");
  writeFileSync(join(RUNS_DIR, "damaged.journal.jsonl"), '{"key":"ok","value":1,"v":2}\nnot-json\n{"key":"later","value":2}\n');
  await assert.rejects(loadJournal("damaged", { strict: true }), /record 2 is damaged/);
});

test("a failed recovery write stops dispatch and is not cached as a completed decision", async () => {
  let calls = 0;
  await stub(async () => { calls++; return { ok: true, finalText: "done" }; }, async () => {
    const p = pattern(async (ctx) => {
      ctx.setTeam(state());
      mkdirSync(join(RUNS_DIR, `${ctx.run.id}.journal.jsonl`));
      await ctx.remember("decision", "must-save", async () => ({ accepted: true }));
      await ctx.ask({ title: "Must not run", role: "worker", agent: "claude", memberId: "left", mode: "read", cwd: await ctx.worktree("work"), prompt: "fixture" });
      return "done";
    });
    const run = await start(new RunManager(), p);
    await finished(run);
    assert.equal(run.status, "failed");
    assert.match(run.error!, /Cannot save the recovery journal/);
    assert.equal(calls, 0);
  });
});

test("same-provider members receive only their addressed notes and retain individual settings and usage", async () => {
  const received: { prompt: string; model?: string }[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await stub(async (opts, event) => {
    received.push({ prompt: opts.prompt, model: opts.model });
    event({ kind: "usage", inputTokens: 3, outputTokens: 2 });
    return { ok: true, finalText: "done", sessionId: `session-${opts.model}` };
  }, async () => {
    const p = pattern(async (ctx) => {
      ctx.setTeam(state());
      const trees = await Promise.all([ctx.worktree("left"), ctx.worktree("right")]);
      await gate;
      await ctx.parallel(["left", "right"], (id, i) => ctx.ask({ title: id, role: "worker", agent: "claude", memberId: id, settings: { model: id }, mode: "read", cwd: trees[i]!, prompt: `assignment ${id}` }));
      return "done";
    });
    const manager = new RunManager();
    const run = await start(manager, p);
    await until(() => !!run.team);
    await manager.addTeamNote(run.id, "only for left", undefined, "left");
    await manager.addTeamNote(run.id, "only for right", undefined, "right");
    assert.throws(() => manager.addNote(run.id, "bad", undefined, "missing"), /Unknown team member/);
    release(); await finished(run);
    assert.equal(run.status, "done", run.error);
    assert.match(received.find((r) => r.model === "left")!.prompt, /only for left/);
    assert.doesNotMatch(received.find((r) => r.model === "left")!.prompt, /only for right/);
    assert.equal(run.usage.byMember?.left?.inputTokens, 3);
    assert.equal(run.usage.byMember?.right?.outputTokens, 2);
    assert.equal(run.team?.metrics.invocations, 2);
  });
});

test("rejected member outcomes count as failures once in both provider and member usage", async () => {
  await stub(async () => ({ ok: true, finalText: "invalid task outcome" }), async () => {
    const p = pattern(async (ctx) => {
      ctx.setTeam(state());
      const outcome = await ctx.ask({ title: "Work", role: "worker", agent: "claude", memberId: "left", mode: "read", cwd: await ctx.worktree("work"), prompt: "fixture" });
      ctx.failStep(outcome, "Missing required evidence");
      ctx.failStep(outcome, "Missing required evidence");
      return "done";
    });
    const run = await start(new RunManager(), p); await finished(run);
    assert.equal(run.status, "done", run.error);
    assert.equal(run.steps[0]!.status, "failed");
    assert.equal(run.usage.byAgent?.claude?.failures, 1);
    assert.equal(run.usage.byMember?.left?.failures, 1);
  });
});

test("coordinator retry cannot exceed actual invocation ceiling", async () => {
  let calls = 0;
  await stub(async () => { calls++; return { ok: false, finalText: "", error: "temporarily unavailable", errorKind: "transient" }; }, async () => {
    const run = await start(new RunManager(), pattern(async (ctx) => {
      ctx.setTeam(state(8, 1));
      await ctx.ask({ title: "Plan", role: "coordinator", agent: "claude", memberId: "left", coordination: true, mode: "read", cwd: await ctx.worktree("plan"), prompt: "plan" });
      return "done";
    }));
    await finished(run);
    assert.equal(run.status, "stopped", run.error);
    assert.equal(calls, 1);
    assert.equal(run.team?.metrics.coordinatorInvocations, 1);
    assert.equal(run.team?.metrics.invocations, 1);
  });
});

test("an actual launch cap does not journal or charge a refused team retry", async () => {
  let calls = 0;
  await stub(async () => { calls++; return { ok: false, finalText: "", error: "temporarily unavailable", errorKind: "transient" }; }, async () => {
    const p = pattern(async (ctx) => {
      ctx.setTeam(state());
      await ctx.ask({ title: "Work", role: "worker", agent: "claude", memberId: "left", mode: "read", cwd: await ctx.worktree("work"), prompt: "fixture" });
      return "done";
    });
    const run = await new RunManager().start({ pattern: p, repo, task: "fixture", roles: {}, options: {}, approvals: { plan: false }, loop: { maxInvocations: 1 } });
    await finished(run);
    assert.equal(run.status, "stopped");
    assert.equal(calls, 1);
    assert.equal(run.team?.metrics.invocations, 1);
    assert.equal([...await loadJournal(run.id, { strict: true })].filter(([key]) => key.startsWith("team-launch:")).length, 1);
  });
});

test("a member cannot resume another member's conversation", async () => {
  let calls = 0;
  await stub(async () => { calls++; return { ok: true, finalText: "done", sessionId: "private" }; }, async () => {
    const run = await start(new RunManager(), pattern(async (ctx) => {
      ctx.setTeam(state());
      const wt = await ctx.worktree("work");
      const prior = await ctx.ask({ title: "Left", role: "worker", agent: "claude", memberId: "left", mode: "read", cwd: wt, prompt: "private" });
      await assert.rejects(ctx.ask({ title: "Right", role: "worker", agent: "claude", memberId: "right", mode: "read", cwd: wt, resume: prior, prompt: "steal" }), /another member's private session/);
      await assert.rejects(ctx.ask({ title: "Unscoped", role: "follow-up", agent: "claude", mode: "read", cwd: wt, resume: prior, prompt: "steal" }), /another member's private session/);
      return "done";
    }));
    await finished(run);
    assert.equal(run.status, "done", run.error);
    assert.equal(calls, 1);
  });
});

test("direct follow-ups start outside private member sessions and then resume their own conversation", async () => {
  const resumed: (string | undefined)[] = [];
  await stub(async (opts) => {
    resumed.push(opts.resumeSessionId);
    return { ok: true, finalText: "done", sessionId: opts.prompt === "private team turn" ? "member-private-session" : "follow-up-session" };
  }, async () => {
    const p = pattern(async (ctx) => {
      ctx.setTeam(state());
      await ctx.ask({ title: "Member turn", role: "worker", agent: "claude", memberId: "left", mode: "read", cwd: await ctx.worktree("integration"), prompt: "private team turn" });
      return "done";
    });
    const manager = new RunManager(() => p);
    const run = await start(manager, p); await finished(run);
    for (const message of ["Explain the result", "Explain it further"]) {
      await manager.followUp(run.id, { kind: "reply", agent: "claude", worktree: "integration", message });
      await finished(run); assert.equal(run.status, "done", run.error);
    }
    assert.deepEqual(resumed, [undefined, undefined, "follow-up-session"]);
  });
});

test("user answers are durable, exact-request addressed and replay without asking twice", async () => {
  let answer = "";
  const p = pattern(async (ctx) => {
    const team = state();
    team.messages.push({ id: "request-1", kind: "question", sender: "left", recipient: "user", taskId: "task", body: "Which format?", blocking: true, evidence: [], status: "open", sourceStepId: "s1", origin: "agent" });
    ctx.setTeam(team);
    answer = await ctx.awaitTeamAnswer("request-1", "Which format?");
    return answer;
  });
  const manager = new RunManager(() => p);
  const run = await start(manager, p);
  await until(() => run.team?.awaitingRequestId === "request-1");
  const note = await manager.answerTeamQuestion(run.id, "request-1", "JSON");
  assert.equal((await loadJournal(run.id, { strict: true })).get("team-user-answer:request-1") && note.text, "JSON");
  await finished(run);
  assert.equal(answer, "JSON");
  run.patternDone = false; // Re-run the workflow, exercising the recorded decision.
  await manager.resume(run.id);
  await finished(run);
  assert.equal(run.status, "done", run.error);
  assert.equal(answer, "JSON");
  assert.equal(run.notes.filter((n) => n.requestId === "request-1").length, 1);
});

async function verifiedTeam() {
  const p = pattern(async (ctx) => {
    const integration = await ctx.worktree("integration");
    await ctx.worktree("worker");
    const team = state();
    team.status = "completed";
    team.verification = { head: await ctx.head(integration), check: "not_required", reviewed: true, approved: true };
    ctx.setTeam(team);
    ctx.setFacts({ approved: true });
    await ctx.artifact("Auto team result", integration);
    return "verified";
  });
  const manager = new RunManager(() => p);
  const run = await start(manager, p);
  await finished(run);
  assert.equal(run.status, "done", run.error);
  return { run, manager };
}

test("direct follow-up invalidates only changed integrated verification and preserves completed pattern state", async () => {
  await stub(async (opts) => {
    if (!opts.prompt.includes("Make no edits")) writeFileSync(join(opts.cwd, "followup.txt"), "changed by follow-up\n");
    return { ok: true, finalText: "done" };
  }, async () => {
    const { manager, run } = await verifiedTeam();
    const original = structuredClone(run.team!.verification);
    await manager.followUp(run.id, { kind: "reply", worktree: "integration", agent: "claude", message: "Make no edits; explain the result." });
    await finished(run);
    assert.deepEqual(run.team!.verification, original, "no-op keeps evidence for the identical commit");
    await manager.followUp(run.id, { kind: "reply", worktree: "worker", agent: "claude", message: "Change the worker branch only." });
    await finished(run);
    assert.deepEqual(run.team!.verification, original, "another branch does not change the integrated result");
    await manager.followUp(run.id, { kind: "reply", worktree: "integration", agent: "claude", message: "Change the integrated result." });
    await finished(run);
    assert.equal(run.status, "done", run.error);
    assert.equal(run.patternDone, true);
    assert.equal(run.team!.status, "completed");
    assert.equal(run.team!.verification!.approved, false);
    assert.equal(run.team!.verification!.reviewed, false);
    assert.equal(run.team!.verification!.check, "unknown");
    assert.notEqual(run.team!.verification!.head, original!.head);
    assert.equal(run.facts?.approved, false);
    assert.match(run.team!.gaps.join(" "), /changed after the team's review/);
  });
});

test("a follow-up that throws after writing still invalidates integrated approval", async () => {
  await stub(async (opts) => {
    writeFileSync(join(opts.cwd, "partial-followup.txt"), "unfinished edit\n");
    throw new Error("fixture failed after writing");
  }, async () => {
    const { manager, run } = await verifiedTeam();
    await manager.followUp(run.id, { kind: "reply", worktree: "integration", agent: "claude", message: "Attempt a change." });
    await finished(run);
    assert.equal(run.followUps.at(-1)?.status, "failed");
    assert.equal(run.team!.verification!.approved, false);
    assert.equal(run.team!.verification!.reviewed, false);
    assert.equal(run.patternDone, true);
    assert.equal(run.team!.status, "completed");
  });
});
