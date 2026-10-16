import { adapters } from "../adapters/index.js";
import type { Pattern, StepOutcome } from "../engine.js";
import { describeIssues } from "../integrity.js";
import { REVIEW_SCHEMA } from "./schemas.js";
import { checkEvidence, fence, fixUntilGreen, jsonInstruction, planCheckpoint, preamble, READ_ONLY, section, WRITE } from "./prompts.js";

interface ReviewVerdict {
  verdict: "approve" | "changes_requested";
  issues: { severity: string; file: string; problem: string; fix: string }[];
}

/**
 * Debate → Synthesize → Build.
 * Debaters propose designs independently, then read each other's proposals and revise
 * (critique rounds). A synthesizer merges the final positions into one plan, an optional
 * builder implements it, and an optional reviewer checks the build against the plan (one round
 * of fixes).
 */
export const debatePattern: Pattern = {
  id: "debate",
  name: "Debate → Synthesize → Build",
  summary: "Agents propose designs independently, critique each other, then one plan is synthesized and built.",
  description:
    "Use for design-heavy or ambiguous work (architecture, APIs, refactors) where independent perspectives beat a single plan.",
  roles: [
    {
      id: "debaters",
      label: "Debaters",
      description: "Each proposes and defends a design",
      multiple: true,
      default: ["claude", "codex"],
    },
    { id: "synthesizer", label: "Synthesizer", description: "Merges the debate into one plan", default: ["claude"] },
    {
      id: "builder",
      label: "Builder",
      description: "Implements the final plan (leave empty for design only)",
      optional: true,
      default: ["codex"],
    },
    {
      id: "reviewer",
      label: "Reviewer",
      description: "Reviews the build against the agreed plan (optional)",
      optional: true,
      default: ["claude"],
    },
  ],
  options: [{ id: "rounds", label: "Critique rounds", type: "number", default: 1, min: 0, max: 3 }],

  async run(ctx) {
    const debaters = ctx.agents("debaters");
    if (debaters.length < 2) throw new Error("A debate needs at least two debaters");
    const rounds = ctx.option("rounds", 1);
    const designWt = await ctx.worktree("design");

    // Round 0: independent proposals, in parallel (one failing stops the others).
    let positions: StepOutcome[] = await ctx.parallel(debaters, (agent) =>
      ctx.ask({
        title: `Proposal — ${adapters[agent].displayName}`,
        role: "debaters",
        agent,
        mode: "read",
        cwd: designWt,
        prompt:
          preamble("debater", agent, `${READ_ONLY} Other agents are proposing designs independently.`) +
          section("Task", ctx.task) +
          section(
            "Deliverable",
            "Study the codebase and propose a design: approach, key changes, trade-offs, and the risks you see. Under 500 words.",
          ),
      }),
    );

    // Critique rounds: each debater sees the others' latest positions and revises its own.
    for (let round = 1; round <= rounds; round++) {
      const snapshot = positions;
      positions = await ctx.parallel(snapshot, (own) => {
        const others = snapshot
          .filter((p) => p !== own)
          .map((p) => section(`Proposal from ${adapters[p.agent].displayName}`, p.finalText))
          .join("");
        return ctx.ask({
          title: `Critique round ${round} — ${adapters[own.agent].displayName}`,
          role: "debaters",
          agent: own.agent,
          mode: "read",
          cwd: designWt,
          resume: own,
          prompt:
            "Here are the other agents' current proposals." +
            others +
            section(
              "Deliverable",
              "Critique them honestly: what is better than yours, what is wrong or risky. Then give your revised proposal. " +
                "Concede points where they are right; hold your ground where you have evidence.",
            ),
          // Its own conversation gone, a new one needs its earlier proposal too.
          fresh:
            preamble("debater", own.agent, `${READ_ONLY} Other agents are proposing designs too.`) +
            section("Task", ctx.task) +
            section("Your proposal so far", own.finalText) +
            section("The other agents' current proposals", others) +
            section(
              "Deliverable",
              "Critique them honestly: what is better than yours, what is wrong or risky. Then give your revised proposal. " +
                "Concede points where they are right; hold your ground where you have evidence.",
            ),
        });
      });
    }

    const synthesizer = ctx.agent("synthesizer");
    let plan = await ctx.ask({
      title: "Synthesize plan",
      role: "synthesizer",
      agent: synthesizer,
      mode: "read",
      cwd: designWt,
      prompt:
        preamble("synthesizer", synthesizer, READ_ONLY) +
        section("Task", ctx.task) +
        positions.map((p) => section(`Final position — ${adapters[p.agent].displayName}`, p.finalText)).join("") +
        section(
          "Deliverable",
          "Merge these into a single implementation plan. List each point of disagreement and which side you chose and why. " +
            "End with concrete steps and verification commands.",
        ),
    });

    const [builder] = ctx.agents("builder");
    if (!builder) {
      return section("Synthesized plan", plan.finalText);
    }

    plan = await planCheckpoint(ctx, { agent: synthesizer, role: "synthesizer", wt: designWt, plan, what: "plan" });
    const buildWt = await ctx.worktree("build");
    const build = await ctx.ask({
      title: "Implement synthesized plan",
      role: "builder",
      agent: builder,
      mode: "write",
      cwd: buildWt,
      prompt:
        preamble("builder", builder, WRITE) +
        section("Task", ctx.task) +
        section("Agreed plan", plan.finalText) +
        section("Deliverable", "Implement the plan, run the relevant tests, then summarize the changes."),
    });
    await ctx.commit(buildWt, `${builder}: implement synthesized plan`);
    let fixed = await fixUntilGreen(ctx, { agent: builder, role: "builder", wt: buildWt, session: build, attempts: 2 });
    let check = fixed.check;

    // The debate settled the design, not the code: a reviewer checks the build against the plan.
    const [reviewer] = ctx.agents("reviewer");
    let verdict: ReviewVerdict | undefined;
    if (reviewer && (!check || check.ok)) {
      const testChanges = await ctx.testChanges(buildWt);
      verdict = (
        await ctx.decide<ReviewVerdict>({
          title: "Review the build",
          schema: REVIEW_SCHEMA,
          what: "review verdict",
          role: "reviewer",
          agent: reviewer,
          mode: "read",
          cwd: buildWt,
          prompt:
            preamble("reviewer", reviewer, `${READ_ONLY} You did not write this code; review it critically.`) +
            section("Task", ctx.task) +
            section("Agreed plan", plan.finalText) +
            section("Diff against base", fence(await ctx.diff(buildWt), "diff")) +
            checkEvidence(ctx, check) +
            (testChanges.length ? section("Changes to tests (found by code-flow)", `Request changes unless the task requires them:\n${describeIssues(testChanges)}`) : "") +
            section("Deliverable", "Check that the build does what the plan and task say, and look for bugs, missed edge cases and missing tests. Only request changes for real problems.") +
            jsonInstruction('{"verdict": "approve" | "changes_requested", "issues": [{"severity": "high|medium|low", "file": "path", "problem": "...", "fix": "..."}]}'),
        })
      ).value;
      ctx.log(`Review: ${verdict.verdict} (${verdict.issues.length} issues)`);
      if (verdict.verdict === "changes_requested" && verdict.issues.length) {
        ctx.learn(verdict.issues);
        const session = await ctx.ask({
          title: "Address review",
          role: "builder",
          agent: builder,
          mode: "write",
          cwd: buildWt,
          resume: fixed.session ?? build,
          prompt: `The ${reviewer} reviewer requested changes. Address each issue, re-run tests, and summarize the fixes.\n${fence(JSON.stringify(verdict.issues, null, 2), "json")}`,
        });
        await ctx.commit(buildWt, `${builder}: address review`);
        fixed = await fixUntilGreen(ctx, { agent: builder, role: "builder", wt: buildWt, session, attempts: 2 });
        check = fixed.check;
      }
    }

    await ctx.artifact("Result", buildWt);
    if (check) ctx.setVerdict(check.ok ? "passed" : "failing");
    if (verdict) ctx.setFacts({ approved: verdict.verdict === "approve", reviewRounds: 1 });

    return [
      `**Built**${check ? (check.ok ? `, and \`${check.command}\` passes` : `, but \`${check.command}\` still fails`) : ""} on branch \`${buildWt.branch}\``,
      verdict ? `Review by ${reviewer}: ${verdict.verdict === "approve" ? "approved" : `${verdict.issues.length} issue(s) sent back to the builder`}.` : "",
      section("Synthesized plan", plan.finalText),
      section("Builder summary", build.finalText),
    ].join("\n");
  },
};
