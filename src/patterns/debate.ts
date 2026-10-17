import { adapters } from "../adapters/index.js";
import type { Pattern, StepOutcome } from "../engine.js";
import { describeIssues } from "../integrity.js";
import { REVIEW_SCHEMA } from "./schemas.js";
import { checkEvidence, fence, fixUntilGreen, jsonInstruction, LETTERS, planCheckpoint, preamble, proofEvidence, proofLine, proofRule, proveOrAsk, READ_ONLY, section, WRITE } from "./prompts.js";

interface ReviewVerdict {
  verdict: "approve" | "changes_requested";
  issues: { severity: string; file: string; problem: string; fix: string }[];
}

/**
 * Debate → Synthesize → Build.
 * Debaters propose designs independently, then read each other's proposals and revise
 * (critique rounds). Proposals are anonymous ("Proposal A/B/…") to the debaters and the
 * synthesizer, so nobody sides with a vendor by name; the synthesizer defaults to a vendor that
 * isn't debating (the log warns when it is). It merges the final positions into one plan, an
 * optional builder implements it, and an optional reviewer checks the build against the plan,
 * re-reviewing after each round of fixes.
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
    { id: "synthesizer", label: "Synthesizer", description: "Merges the debate into one plan, ideally a vendor that isn't debating", default: ["agy"] },
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
  options: [
    { id: "rounds", label: "Critique rounds", type: "number", default: 1, min: 0, max: 3 },
    { id: "reviewRounds", label: "Max review rounds", type: "number", default: 2, min: 1, max: 5 },
  ],

  async run(ctx) {
    const debaters = ctx.agents("debaters");
    if (debaters.length < 2) throw new Error("A debate needs at least two debaters");
    const rounds = ctx.option("rounds", 1);
    const synthesizer = ctx.agent("synthesizer");
    if (debaters.includes(synthesizer)) ctx.log(`${synthesizer} both debates and synthesizes; a synthesizer from another vendor is fairer`, "warn");
    const designWt = await ctx.worktree("design");
    // Proposals go by letter, never by vendor: debater i's is Proposal A, B, … in every round.
    const label = (i: number) => `Proposal ${LETTERS[i]!}`;

    // Round 0: independent proposals, in parallel (one failing stops the others).
    let positions: StepOutcome[] = await ctx.parallel(debaters, (agent, i) =>
      ctx.ask({
        title: `Proposal — ${adapters[agent].displayName}`,
        role: "debaters",
        agent,
        mode: "read",
        cwd: designWt,
        prompt:
          preamble("debater", agent, `${READ_ONLY} Other agents are proposing designs independently. Yours will be ${label(i)}.`) +
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
      positions = await ctx.parallel(snapshot, (own, i) => {
        const others = snapshot
          .map((p, j) => (j === i ? "" : section(label(j), p.finalText)))
          .join("");
        return ctx.ask({
          title: `Critique round ${round} — ${adapters[own.agent].displayName}`,
          role: "debaters",
          agent: own.agent,
          mode: "read",
          cwd: designWt,
          resume: own,
          prompt:
            `Here are the other agents' current proposals (yours is ${label(i)}).` +
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
            section(`Your proposal so far (${label(i)})`, own.finalText) +
            section("The other agents' current proposals", others) +
            section(
              "Deliverable",
              "Critique them honestly: what is better than yours, what is wrong or risky. Then give your revised proposal. " +
                "Concede points where they are right; hold your ground where you have evidence.",
            ),
        });
      });
    }

    let plan = await ctx.ask({
      title: "Synthesize plan",
      role: "synthesizer",
      agent: synthesizer,
      mode: "read",
      cwd: designWt,
      prompt:
        preamble("synthesizer", synthesizer, `${READ_ONLY} The debaters are anonymous: weigh each proposal on its merits.`) +
        section("Task", ctx.task) +
        positions.map((p, i) => section(`Final position: ${label(i)}`, p.finalText)).join("") +
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
        proofRule(ctx) +
        section("Deliverable", "Implement the plan, run the relevant tests, then summarize the changes."),
    });
    await ctx.commit(buildWt, `${builder}: implement synthesized plan`);
    let fixed = await fixUntilGreen(ctx, { agent: builder, role: "builder", wt: buildWt, session: build, attempts: 2 });
    // Green isn't enough: a test should fail without the change. The builder is asked for one.
    const proved = await proveOrAsk(ctx, { agent: builder, role: "builder", wt: buildWt, check: fixed.check, session: fixed.session ?? build, attempts: 2, ask: true });
    fixed = { check: proved.check, session: proved.session ?? fixed.session };
    let check = fixed.check;

    // The debate settled the design, not the code: a reviewer checks the build against the plan,
    // and checks again after the builder addresses its review.
    const [reviewer] = ctx.agents("reviewer");
    const reviewRounds = ctx.option("reviewRounds", 2);
    let verdict: ReviewVerdict | undefined;
    let review: StepOutcome | undefined;
    let proof = proved.proof;
    let session = fixed.session ?? build;
    let reviewed = 0;
    /** The last review's issues went back to the builder, but nobody has reviewed the fixes. */
    let unreviewed = false;
    for (let round = 1; reviewer && (!check || check.ok) && round <= reviewRounds; round++) {
      const testChanges = await ctx.testChanges(buildWt);
      const decided = await ctx.decide<ReviewVerdict>({
        title: round === 1 ? "Review the build" : `Review the build (round ${round})`,
        schema: REVIEW_SCHEMA,
        what: "review verdict",
        role: "reviewer",
        agent: reviewer,
        mode: "read",
        cwd: buildWt,
        resume: review,
        prompt:
          (review ? "The builder addressed your previous review. Here is the updated diff.\n" : "") +
          preamble("reviewer", reviewer, `${READ_ONLY} You did not write this code; review it critically.`) +
          section("Task", ctx.task) +
          // A reviewer without its earlier session hasn't seen the plan.
          (round === 1 || !review?.sessionId ? section("Agreed plan", plan.finalText) : "") +
          section("Diff against base", fence(await ctx.diff(buildWt), "diff")) +
          checkEvidence(ctx, check) +
          proofEvidence(proof) +
          (testChanges.length ? section("Changes to tests (found by code-flow)", `Request changes unless the task requires them:\n${describeIssues(testChanges)}`) : "") +
          section("Deliverable", "Check that the build does what the plan and task say, and look for bugs, missed edge cases and missing tests. Only request changes for real problems.") +
          jsonInstruction('{"verdict": "approve" | "changes_requested", "issues": [{"severity": "high|medium|low", "file": "path", "problem": "...", "fix": "..."}]}'),
      });
      review = decided.outcome;
      verdict = decided.value;
      reviewed = round;
      unreviewed = false;
      ctx.log(`Review round ${round}: ${verdict.verdict} (${verdict.issues.length} issues)`);
      if (verdict.verdict !== "changes_requested" || !verdict.issues.length) break;
      ctx.learn(verdict.issues);
      if (round === reviewRounds) break;

      session = await ctx.ask({
        title: round === 1 ? "Address review" : `Address review (round ${round})`,
        role: "builder",
        agent: builder,
        mode: "write",
        cwd: buildWt,
        resume: session,
        prompt: `The ${reviewer} reviewer requested changes. Address each issue, re-run tests, and summarize the fixes.\n${fence(JSON.stringify(verdict.issues, null, 2), "json")}`,
      });
      await ctx.commit(buildWt, round === 1 ? `${builder}: address review` : `${builder}: address review round ${round}`);
      unreviewed = true;
      fixed = await fixUntilGreen(ctx, { agent: builder, role: "builder", wt: buildWt, session, attempts: 2 });
      session = fixed.session ?? session;
      check = fixed.check;
      if (check && !check.ok) {
        ctx.log("The check still fails after 2 fix attempts; stopping before the next review", "warn");
        break;
      }
      // The fixes changed the code: the next review sees the proof of what it reviews.
      proof = check?.ok ? await ctx.prove(buildWt) : null;
    }
    const approved = verdict?.verdict === "approve";

    await ctx.artifact("Result", buildWt);
    if (check) ctx.setVerdict(check.ok ? "passed" : "failing");
    if (verdict) ctx.setFacts({ approved, reviewRounds: reviewed });
    ctx.setFacts({ proof: ctx.proofOf(buildWt)?.status });

    return [
      `**Built**${check ? (check.ok ? `, and \`${check.command}\` passes` : `, but \`${check.command}\` still fails`) : ""} on branch \`${buildWt.branch}\``,
      proofLine(ctx.proofOf(buildWt)),
      verdict
        ? `Review by ${reviewer}: ${
            approved
              ? `approved${reviewed > 1 ? ` in round ${reviewed}` : ""}`
              : unreviewed
                ? `${verdict.issues.length} issue(s) sent back to the builder, whose fixes weren't re-reviewed: the check fails since`
                : `not approved after ${reviewed} round${reviewed === 1 ? "" : "s"}`
          }.`
        : "",
      verdict?.issues.length && !approved && !unreviewed ? section("Open review issues", verdict.issues.map((i) => `- ${i.problem}`).join("\n")) : "",
      section("Synthesized plan", plan.finalText),
      section("Builder summary", build.finalText),
    ].join("\n");
  },
};
