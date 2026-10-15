import { adapters, isAgentId, type AgentId } from "../adapters/index.js";
import { RejectedError, type Pattern } from "../engine.js";
import { hasConflictMarkers, mergeBranch } from "../git.js";
import { REVIEW_SCHEMA, SUBTASKS_SCHEMA } from "./schemas.js";
import { checkSection, fence, fixUntilGreen, jsonInstruction, preamble, READ_ONLY, section, WRITE } from "./prompts.js";

interface Subtask {
  id: string;
  title: string;
  instructions: string;
  agent?: string;
}

interface Review {
  verdict: "approve" | "changes_requested";
  issues: { severity: string; file: string; problem: string; fix: string }[];
}

/**
 * Supervisor → Workers → Integrate.
 * A supervisor splits the task into independent subtasks and assigns each to a worker
 * (playing to each vendor's strengths). Workers run in parallel in separate worktrees;
 * their branches are merged into an integration branch, and the supervisor resolves any
 * conflicts, reviews the whole result, and fixes what it finds.
 */
export const supervisorPattern: Pattern = {
  id: "supervisor",
  name: "Supervisor → Workers",
  summary: "A supervisor splits the task, workers build pieces in parallel, the supervisor integrates and reviews.",
  description:
    "Use for larger tasks that split cleanly (e.g. backend + frontend + tests). Parallel work is faster but needs integration.",
  roles: [
    {
      id: "supervisor",
      label: "Supervisor",
      description: "Decomposes, assigns, integrates, reviews",
      default: ["claude"],
    },
    {
      id: "workers",
      label: "Workers",
      description: "Each implements assigned subtasks in parallel",
      multiple: true,
      default: ["claude", "codex"],
    },
  ],
  options: [{ id: "maxSubtasks", label: "Max subtasks", type: "number", default: 3, min: 2, max: 6 }],

  async run(ctx) {
    const supervisor = ctx.agent("supervisor");
    const workers = ctx.agents("workers");
    if (workers.length === 0) throw new Error("Assign at least one worker");
    const maxSubtasks = ctx.option("maxSubtasks", 3);
    const roster = workers.map((w) => `"${w}" (${adapters[w].displayName})`).join(", ");

    const integration = await ctx.worktree("integration");
    let decomposed = await ctx.decide<{ subtasks: Subtask[] }>({
      title: "Decompose task",
      schema: SUBTASKS_SCHEMA,
      what: "subtask list",
      validate: (v: { subtasks: Subtask[] }) => (v.subtasks.length ? undefined : "the list is empty"),
      role: "supervisor",
      agent: supervisor,
      mode: "read",
      cwd: integration,
      prompt:
        preamble("supervisor", supervisor, READ_ONLY) +
        section("Task", ctx.task) +
        section(
          "Deliverable",
          `Study the code and split the task into at most ${maxSubtasks} subtasks that can be built in parallel ` +
            "on separate branches with minimal file overlap (they will be merged afterwards). " +
            "Each subtask's instructions must be self-contained: the worker sees only them, not the other subtasks. " +
            `Assign each subtask to one of these workers: ${roster}.`,
        ) +
        jsonInstruction(
          '{"subtasks": [{"id": "short-kebab-id", "title": "...", "instructions": "...", "agent": "claude|codex|agy"}]}',
        ),
    });

    // Checkpoint: approve (or revise, or reject) the split before any worker starts.
    for (let round = 1; ; round++) {
      const answer = await ctx.approve(
        "plan",
        round === 1 ? "Approve the subtasks" : `Approve the revised subtasks (${round})`,
        decomposed.value.subtasks.map((t, i) => `${i + 1}. **${t.title}** → ${t.agent}\n   ${t.instructions}`).join("\n"),
      );
      if (answer.decision === "approve") break;
      if (answer.decision === "reject") throw new RejectedError(`You rejected the subtasks.${answer.note ? ` (${answer.note})` : ""}`);
      decomposed = await ctx.decide<{ subtasks: Subtask[] }>({
        title: `Revise the subtasks (${round})`,
        schema: SUBTASKS_SCHEMA,
        what: "subtask list",
        validate: (v: { subtasks: Subtask[] }) => (v.subtasks.length ? undefined : "the list is empty"),
        role: "supervisor",
        agent: supervisor,
        mode: "read",
        cwd: integration,
        resume: decomposed.outcome.sessionId ? decomposed.outcome : undefined,
        prompt:
          `The user asked for changes to the subtask split:\n${answer.note}\n\nReply with the complete revised subtask list ` +
          `(at most ${maxSubtasks}; workers: ${roster}).` +
          jsonInstruction('{"subtasks": [{"id": "short-kebab-id", "title": "...", "instructions": "...", "agent": "claude|codex|agy"}]}'),
      });
    }

    const plan = decomposed.outcome;
    const subtasks = decomposed.value.subtasks.slice(0, maxSubtasks);

    // Respect the supervisor's assignment when it named a worker on the roster; otherwise round-robin.
    const assigned = subtasks.map((sub, i) => ({
      sub,
      id: slug(sub.id || `part-${i + 1}`, i),
      agent: (isAgentId(sub.agent) && workers.includes(sub.agent) ? sub.agent : workers[i % workers.length]) as AgentId,
    }));
    ctx.log(`Subtasks: ${assigned.map((a) => `${a.id} → ${a.agent}`).join(", ")}`);

    const results = await Promise.all(
      assigned.map(async ({ sub, id, agent }) => {
        const wt = await ctx.worktree(`sub-${id}`);
        const result = await ctx.ask({
          title: `Subtask: ${sub.title}`,
          role: "workers",
          agent,
          mode: "write",
          cwd: wt,
          allowFailure: true,
          prompt:
            preamble("worker", agent, `${WRITE} Other workers are building other parts in parallel; stay within your subtask.`) +
            section("Overall goal (for context only)", ctx.task) +
            section(`Your subtask: ${sub.title}`, sub.instructions) +
            section("Deliverable", "Implement your subtask, run relevant tests, and summarize what you changed."),
        });
        await ctx.commit(wt, `${agent}: ${sub.title}`);
        return { sub, agent, wt, result };
      }),
    );

    // Integrate branches one by one; the supervisor resolves any conflicts.
    for (const r of results) {
      if (!r.result.ok) {
        ctx.log(`Skipping failed subtask "${r.sub.title}"`, "warn");
        continue;
      }
      const merge = await ctx.remember("merge", r.wt.branch, () => mergeBranch(integration, r.wt.branch));
      if (merge.ok) {
        ctx.log(`Merged ${r.wt.branch}`);
        continue;
      }
      ctx.log(`Conflicts merging ${r.wt.branch}: ${merge.conflicts.join(", ")}`, "warn");
      await ctx.ask({
        title: `Resolve conflicts: ${r.sub.title}`,
        role: "supervisor",
        agent: supervisor,
        mode: "write",
        cwd: integration,
        prompt:
          preamble("integrator", supervisor, WRITE) +
          section("Overall goal", ctx.task) +
          section(
            "Situation",
            `A git merge of branch ${r.wt.branch} ("${r.sub.title}") is in progress and has conflicts in:\n` +
              merge.conflicts.map((f) => `- ${f}`).join("\n"),
          ) +
          section(
            "Deliverable",
            "Resolve every conflict so both sides' intent is preserved, remove all conflict markers, and make sure it builds. " +
              "Do not run git merge --abort or commit.",
          ),
      });
      if (await hasConflictMarkers(integration)) throw new Error(`Conflict markers remain after merging ${r.wt.branch}`);
      await ctx.commit(integration, `Merge ${r.wt.branch} (conflicts resolved by ${supervisor})`);
    }

    // The merged result is where parts break each other: check it before reviewing.
    let { check } = await fixUntilGreen(ctx, { agent: supervisor, role: "supervisor", wt: integration, attempts: 2 });

    const diff = await ctx.diff(integration);
    const reviewed = await ctx.decide<Review>({
      title: "Integration review",
      schema: REVIEW_SCHEMA,
      what: "review verdict",
      role: "supervisor",
      agent: supervisor,
      mode: "read",
      cwd: integration,
      resume: plan,
      prompt:
        "All subtasks have been merged into the integration branch. Review the combined result against the overall task: " +
        "missing pieces, inconsistencies between parts, broken integration, failing tests." +
        section("Combined diff", fence(diff, "diff")) +
        (check ? checkSection(check, 3_000) : "") +
        jsonInstruction('{"verdict": "approve" | "changes_requested", "issues": [{"severity": "high|medium|low", "file": "path", "problem": "...", "fix": "..."}]}'),
    });

    const verdict = reviewed.value;
    if (verdict?.verdict === "changes_requested" && verdict.issues?.length) {
      await ctx.ask({
        title: "Fix integration issues",
        role: "supervisor",
        agent: supervisor,
        mode: "write",
        cwd: integration,
        prompt:
          preamble("integrator", supervisor, WRITE) +
          section("Overall goal", ctx.task) +
          section("Issues found in review", fence(JSON.stringify(verdict.issues, null, 2), "json")) +
          section("Deliverable", "Fix these issues, run the tests, and summarize."),
      });
      await ctx.commit(integration, `${supervisor}: fix integration issues`);
      check = (await fixUntilGreen(ctx, { agent: supervisor, role: "supervisor", wt: integration, attempts: 2 })).check;
    }

    await ctx.artifact("Integrated result", integration);
    if (check) ctx.setVerdict(check.ok ? "passed" : "failing");
    return [
      `**Integrated**${check ? (check.ok ? `, and \`${check.command}\` passes` : `, but \`${check.command}\` still fails`) : ""} — branch \`${integration.branch}\``,
      section(
        "Subtasks",
        results
          .map((r) => `- ${r.sub.title} → ${r.agent}: ${r.result.ok ? "done" : `failed (${r.result.error})`}`)
          .join("\n"),
      ),
      section("Integration review", `${verdict.verdict} — ${verdict.issues.length} issues`),
    ].join("\n");
  },
};

function slug(raw: string, i: number): string {
  const s = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return `${i + 1}-${s || "part"}`;
}
