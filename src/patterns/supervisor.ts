import { getAdapter, adapters, isAgentId, type AgentId } from "../adapters/index.js";
import { RejectedError, type Pattern, type ReviewFinding, type StepOutcome } from "../engine.js";
import { changedFiles } from "../git.js";
import { describeIssues } from "../integrity.js";
import { approves, builderReply, checkReview, findingsForBuilder, findingsLine, REVIEW_SHAPE, reproRule, type ReviewVerdict } from "./findings.js";
import { decompositionInstructions, integrateBranch } from "./team-strategies.js";
import { REVIEW_SCHEMA, SUBTASKS_SCHEMA } from "./schemas.js";
import { checkEvidence, fence, fixUntilGreen, jsonInstruction, preamble, proofEvidence, proofLine, proofRule, proveOrAsk, READ_ONLY, section, WRITE } from "./prompts.js";

interface Subtask {
  id: string;
  title: string;
  instructions: string;
  agent?: string;
}

interface Split {
  contracts: string;
  subtasks: Subtask[];
}

const SPLIT_SHAPE =
  '{"contracts": "interfaces, names and data shapes every part must use", "subtasks": [{"id": "short-kebab-id", "title": "...", "instructions": "...", "agent": "claude|codex|agy"}]}';

/**
 * Supervisor → Workers → Integrate.
 * A supervisor splits the task into independent subtasks and assigns each to a worker
 * (playing to each vendor's strengths). Workers run in parallel in separate worktrees;
 * their branches are merged into an integration branch, and the supervisor resolves any
 * conflicts. The combined result is reviewed by a separate reviewer (the supervisor only
 * reviews its own integration when no reviewer is set), code-flow runs the tests the reviewer
 * shows its findings with, the supervisor fixes the ones that block, and the reviewer looks once more.
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
    {
      id: "reviewer",
      label: "Reviewer",
      description: "Reviews the integrated result; leave empty to let the supervisor review its own work",
      optional: true,
      default: ["codex"],
      independentOf: ["supervisor"],
    },
  ],
  options: [{ id: "maxSubtasks", label: "Max subtasks", type: "number", default: 3, min: 2, max: 6 }],

  async run(ctx) {
    const supervisor = ctx.agent("supervisor");
    const workers = ctx.participants("workers");
    if (workers.length === 0) throw new Error("Assign at least one worker");
    const maxSubtasks = ctx.option("maxSubtasks", 3);
    const roster = workers.map((w) => `"${w.identity ?? w.agent}" (${getAdapter(w.agent).displayName}${w.settings.model ? ` / ${w.settings.model}` : ""})`).join(", ");

    const integration = await ctx.worktree("integration");
    let decomposed = await ctx.decide<Split>({
      title: "Decompose task",
      schema: SUBTASKS_SCHEMA,
      what: "subtask list",
      validate: (v: Split) => (v.subtasks.length ? undefined : "the list is empty"),
      role: "supervisor",
      agent: supervisor,
      mode: "read",
      cwd: integration,
      prompt:
        preamble("supervisor", supervisor, READ_ONLY) +
        section("Task", ctx.task) +
        section(
          "Deliverable",
          decompositionInstructions(maxSubtasks, roster),
        ) +
        jsonInstruction(SPLIT_SHAPE),
    });

    // Checkpoint: approve (or revise, or reject) the split before any worker starts.
    for (let round = 1; ; round++) {
      const answer = await ctx.approve(
        "plan",
        round === 1 ? "Approve the subtasks" : `Approve the revised subtasks (${round})`,
        (decomposed.value.contracts?.trim() ? `**Contracts**\n${decomposed.value.contracts.trim()}\n\n` : "") +
          decomposed.value.subtasks.map((t, i) => `${i + 1}. **${t.title}** → ${t.agent}\n   ${t.instructions}`).join("\n"),
      );
      if (answer.decision === "approve") break;
      if (answer.decision === "reject") throw new RejectedError(`You rejected the subtasks.${answer.note ? ` (${answer.note})` : ""}`);
      decomposed = await ctx.decide<Split>({
        title: `Revise the subtasks (${round})`,
        schema: SUBTASKS_SCHEMA,
        what: "subtask list",
        validate: (v: Split) => (v.subtasks.length ? undefined : "the list is empty"),
        role: "supervisor",
        agent: supervisor,
        mode: "read",
        cwd: integration,
        resume: decomposed.outcome.sessionId ? decomposed.outcome : undefined,
        prompt:
          `The user asked for changes to the subtask split:\n${answer.note}\n\nReply with the complete revised subtask list ` +
          `(at most ${maxSubtasks}; workers: ${roster}).` +
          jsonInstruction(SPLIT_SHAPE),
      });
    }

    const plan = decomposed.outcome;
    const subtasks = decomposed.value.subtasks.slice(0, maxSubtasks);
    const extra = decomposed.value.subtasks.slice(maxSubtasks);
    if (extra.length) {
      // More parts than workers to run at once: the rest goes to the last part, not lost.
      const last = subtasks[subtasks.length - 1]!;
      subtasks[subtasks.length - 1] = {
        ...last,
        title: `${last.title} (+${extra.length} more)`,
        instructions: last.instructions + extra.map((t) => section(`Also part of your subtask: ${t.title}`, t.instructions)).join(""),
      };
      ctx.log(
        `The supervisor split the task into ${decomposed.value.subtasks.length} subtasks, more than the ${maxSubtasks} allowed; ` +
          `${extra.map((t) => `"${t.title}"`).join(", ")} ${extra.length === 1 ? "goes" : "go"} to the worker of "${last.title}"`,
        "warn",
      );
    }
    const contracts = decomposed.value.contracts?.trim() ?? "";

    // Respect the supervisor's assignment when it named a worker on the roster; otherwise round-robin.
    const assigned = subtasks.map((sub, i) => ({
      sub,
      id: slug(sub.id || `part-${i + 1}`, i),
      ...(workers.find(w => w.identity === sub.agent) ?? workers.filter(w => w.agent === sub.agent)[i % Math.max(1, workers.filter(w => w.agent === sub.agent).length)] ?? workers[i % workers.length])!,
    }));
    ctx.log(`Subtasks: ${assigned.map((a) => `${a.id} → ${a.agent}`).join(", ")}`);

    // A worker's failed turn is a missing part; anything else failing stops the other workers too.
    const results = await ctx.parallel(assigned, async ({ sub, id, agent, settings }) => {
      const wt = await ctx.worktree(`sub-${id}`);
      const result = await ctx.ask({
        title: `Subtask: ${sub.title}`,
        role: "workers",
        agent, settings,
        mode: "write",
        cwd: wt,
        allowFailure: true,
        prompt:
          preamble("worker", agent, `${WRITE} Other workers are building other parts in parallel; stay within your subtask.`) +
          section("Overall goal (for context only)", ctx.task) +
          proofRule(ctx) +
          (contracts ? section("Contracts every part follows", `Other workers rely on these; don't deviate from them.\n${contracts}`) : "") +
          section(`Your subtask: ${sub.title}`, sub.instructions) +
          section("Deliverable", "Implement your subtask, run relevant tests, and summarize what you changed."),
      });
      await ctx.commit(wt, `${agent}: ${sub.title}`);
      // A turn can end fine without changing anything (blocked, or nothing seemed needed):
      // that part is missing, not done.
      const changed = (await changedFiles(await ctx.gitAt(wt), wt.base)).length > 0;
      if (result.ok && !changed) ctx.failStep(result, `Made no changes: ${firstLine(result.finalText)}`);
      return { sub, agent, wt, result, changed };
    });
    const outcome = (r: (typeof results)[number]) =>
      !r.result.ok ? `failed (${firstLine(r.result.error)})` : r.changed ? "done" : `no changes (${firstLine(r.result.finalText)})`;

    // Whoever integrates and reviews must know which parts never arrived.
    const missing = results.filter((r) => !r.result.ok || !r.changed);
    const gaps = missing.length
      ? section(
          "Subtasks missing from the integration",
          "These parts weren't merged, so their work is missing from the integration branch:\n" +
            missing.map((r) => `- ${r.sub.title} → ${r.agent}: ${outcome(r)}`).join("\n"),
        )
      : "";

    // Integrate branches one by one; the supervisor resolves any conflicts.
    for (const r of results) {
      if (!r.result.ok) {
        ctx.log(`Skipping failed subtask "${r.sub.title}"`, "warn");
        continue;
      }
      if (!r.changed) {
        ctx.log(`Nothing to merge from "${r.sub.title}": ${r.agent} made no changes`, "warn");
        continue;
      }
      const resolved = await integrateBranch(ctx, integration, r.wt.branch, async (conflicts) => {
      ctx.log(`Conflicts merging ${r.wt.branch}: ${conflicts.join(", ")}`, "warn");
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
              conflicts.map((f) => `- ${f}`).join("\n"),
          ) +
          gaps +
          section(
            "Deliverable",
            "Resolve every conflict so both sides' intent is preserved, remove all conflict markers, and make sure it builds. " +
              "Do not run git merge --abort or commit.",
          ),
      });
      }, `Merge ${r.wt.branch} (conflicts resolved by ${supervisor})`);
      if (!resolved) ctx.log(`Merged ${r.wt.branch}`);
    }

    // The merged result is where parts break each other: check it before reviewing.
    const integrated = await fixUntilGreen(ctx, { agent: supervisor, role: "supervisor", wt: integration, attempts: 2, context: gaps });
    // Green isn't enough: a test should fail without the change. The supervisor is asked for one.
    const proved = await proveOrAsk(ctx, { agent: supervisor, role: "supervisor", wt: integration, check: integrated.check, session: integrated.session, attempts: 2, ask: true, context: gaps });
    let check = proved.check;

    // The supervisor split the work and integrated it; someone else should judge the result.
    const [reviewer = supervisor] = ctx.agents("reviewer");
    if (reviewer === supervisor) ctx.log("No separate reviewer: the supervisor reviews its own integration", "warn");
    const review = async (round: number, previous?: StepOutcome, reply?: string) => {
      const diff = await ctx.diff(integration);
      const testChanges = await ctx.testChanges(integration);
      return ctx.decide<ReviewVerdict>({
        title: round === 1 ? "Integration review" : `Integration review (${round})`,
        schema: REVIEW_SCHEMA,
        what: "review verdict",
        role: reviewer === supervisor ? "supervisor" : "reviewer",
        agent: reviewer,
        mode: "read",
        cwd: integration,
        resume: reviewer === supervisor && round === 1 ? plan : previous,
        prompt:
          (round > 1 ? "The supervisor fixed the issues you raised. Review the updated result.\n" + builderReply(reply) : "") +
          (reviewer === supervisor
            ? ""
            : preamble("reviewer", reviewer, `${READ_ONLY} Other agents built this in parallel parts that were then merged; review it critically.`) +
              section("Task", ctx.task) +
              (contracts ? section("Contracts the parts were meant to follow", contracts) : "")) +
          (missing.length ? "The subtasks that produced work have been merged into the integration branch. " : "All subtasks have been merged into the integration branch. ") +
          "Review the combined result against the overall task: missing pieces, inconsistencies between parts, broken integration, failing tests." +
          gaps +
          section("Combined diff", fence(diff, "diff")) +
          checkEvidence(ctx, check, 3_000) +
          proofEvidence(round === 1 ? proved.proof : check?.ok ? await ctx.prove(integration) : null) +
          (testChanges.length ? section("Changes to tests (found by code-flow)", `Raise each as a medium issue unless the task requires it:\n${describeIssues(testChanges)}`) : "") +
          reproRule(ctx) +
          jsonInstruction(REVIEW_SHAPE),
      });
    };
    const label = (round: number) => (round === 1 ? "Integration review" : `Integration review (${round})`);

    let reviewed = await review(1);
    let verdict = reviewed.value;
    // Approval goes by what blocks once code-flow has run the reviewer's tests, not by its verdict word.
    let findings: ReviewFinding[] = await checkReview(ctx, integration, { label: label(1), reviewer, round: 1, review: verdict });
    let unreviewedFix = false;
    if (!approves(findings)) {
      const fix = await ctx.ask({
        title: "Fix integration issues",
        role: "supervisor",
        agent: supervisor,
        mode: "write",
        cwd: integration,
        prompt:
          preamble("integrator", supervisor, WRITE) +
          section("Overall goal", ctx.task) +
          gaps +
          findingsForBuilder(reviewer, findings) +
          section("Deliverable", "Fix what blocks, run the tests, and summarize."),
      });
      await ctx.commit(integration, `${supervisor}: fix integration issues`);
      check = (await fixUntilGreen(ctx, { agent: supervisor, role: "supervisor", wt: integration, attempts: 2, context: gaps })).check;
      // The fix is reviewed too, unless the supervisor would only be checking itself again.
      if (reviewer !== supervisor) {
        reviewed = await review(2, reviewed.outcome, fix.finalText);
        verdict = reviewed.value;
        findings = await checkReview(ctx, integration, { label: label(2), reviewer, round: 2, review: verdict });
      } else unreviewedFix = true;
    }

    await ctx.artifact("Integrated result", integration);
    if (check) ctx.setVerdict(check.ok ? "passed" : "failing");
    ctx.setFacts({ approved: approves(findings), proof: ctx.proofOf(integration)?.status });
    return [
      `**Integrated**${check ? (check.ok ? `, and \`${check.command}\` passes` : `, but \`${check.command}\` still fails`) : ""} — branch \`${integration.branch}\``,
      proofLine(ctx.proofOf(integration)),
      section(
        "Subtasks",
        results.map((r) => `- ${r.sub.title} → ${r.agent}: ${outcome(r)}`).join("\n"),
      ),
      contracts ? section("Contracts", contracts) : "",
      section(
        "Integration review",
        `${reviewer}: ${approves(findings) ? "approved" : "findings block approval"} — ${findings.length} issues, ${findings.filter((f) => f.blocking).length} blocking` +
          `${unreviewedFix ? ", fixed by the supervisor, not re-reviewed" : ""}` +
          (findingsLine(findings) ? `\n${findingsLine(findings)}` : ""),
      ),
    ].join("\n");
  },
};

/** The first line of an agent's answer or error, as a one-line reason. */
function firstLine(text?: string): string {
  const line = (text ?? "").split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean);
  if (!line) return "no reason given";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

function slug(raw: string, i: number): string {
  const s = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return `${i + 1}-${s || "part"}`;
}
