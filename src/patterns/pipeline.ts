import type { CheckResult } from "../checks.js";
import type { Pattern, Proof, ReviewFinding, StepOutcome } from "../engine.js";
import { describeIssues } from "../integrity.js";
import { approves, builderReply, checkReview, findingsForBuilder, findingsLine, findingsSection, REVIEW_SHAPE, reproRule, type ReviewVerdict } from "./findings.js";
import { REVIEW_SCHEMA } from "./schemas.js";
import { checkEvidence, fence, fixUntilGreen, jsonInstruction, planCheckpoint, preamble, proofEvidence, proofLine, proofRule, proveOrAsk, READ_ONLY, section, WRITE } from "./prompts.js";

/**
 * Plan → Build → Review loop.
 * One agent plans, another implements, a third reviews the diff with fresh context. The
 * reviewer defaults to a vendor other than the planner's (the composer suggests one too), and
 * judges the change against the task, with the plan only as context: a reviewer that shares
 * the planner's view would let a wrong plan through. code-flow runs the tests the reviewer shows
 * its findings with, and findings that block (see `blocks`) go back to the builder, which resumes
 * its own session so it keeps its context, and may dispute a finding no test shows.
 */
export const pipelinePattern: Pattern = {
  id: "pipeline",
  name: "Plan → Build → Review",
  summary: "Planner writes a plan, builder implements it, an independent reviewer loops until it approves.",
  description:
    "The default for well-defined features and bug fixes. Cross-vendor review catches mistakes a model misses in its own work.",
  roles: [
    { id: "planner", label: "Planner", description: "Reads the code, writes the implementation plan", default: ["claude"] },
    { id: "builder", label: "Builder", description: "Implements the plan and applies review fixes", default: ["codex"] },
    { id: "reviewer", label: "Reviewer", description: "Reviews the diff against the task, ideally a vendor other than the planner", default: ["agy"] },
  ],
  options: [
    { id: "maxRounds", label: "Max review rounds", type: "number", default: 2, min: 1, max: 5 },
    { id: "checkFixes", label: "Check fix attempts per round", type: "number", default: 2, min: 0, max: 5 },
  ],

  async run(ctx) {
    const planner = ctx.agent("planner");
    const builder = ctx.agent("builder");
    const reviewer = ctx.agent("reviewer");
    const maxRounds = ctx.option("maxRounds", 2);
    if (reviewer === planner) ctx.log(`${planner} both plans and reviews; a reviewer from another vendor is likelier to catch a wrong plan`, "warn");
    const wt = await ctx.worktree("build");

    let plan = await ctx.ask({
      title: "Plan",
      role: "planner",
      agent: planner,
      mode: "read",
      cwd: wt,
      prompt:
        preamble("planner", planner, `${READ_ONLY} Another agent will implement your plan, so be concrete.`) +
        section("Task", ctx.task) +
        section(
          "Deliverable",
          "Explore the relevant code, then write an implementation plan: files to change, the approach, " +
            "edge cases, and how to verify it (tests or commands). Keep it under 400 words. " +
            "Identify focused verification commands; leave their execution to the implementation and verification stages. " +
            "Do not run full build or test suites while planning unless the task explicitly requires a baseline before planning.",
        ),
    });

    plan = await planCheckpoint(ctx, { agent: planner, role: "planner", wt, plan, what: "plan" });

    const build = await ctx.ask({
      title: "Implement plan",
      role: "builder",
      agent: builder,
      mode: "write",
      cwd: wt,
      prompt:
        preamble("builder", builder, WRITE) +
        section("Task", ctx.task) +
        section("Plan from the planner", plan.finalText) +
        proofRule(ctx) +
        section("Deliverable", "Implement the plan, run the relevant tests, then summarize what you changed."),
    });
    await ctx.commit(wt, `${builder}: implement plan`);
    const checkFixes = ctx.option("checkFixes", 2);

    let verdict: ReviewVerdict | undefined;
    let findings: ReviewFinding[] = [];
    let review: StepOutcome | undefined;
    let reply: string | undefined;
    let fixer = build;
    let check: CheckResult | null = null;
    let proof: Proof | null = null;
    let askedForProof = false;
    let reviewRounds = 0;

    for (let round = 1; round <= maxRounds; round++) {
      // Every round starts with code-flow running the check; a reviewer never sees red code.
      const fixed = await fixUntilGreen(ctx, { agent: builder, role: "builder", wt, session: fixer, attempts: checkFixes });
      fixer = fixed.session ?? fixer;
      // Green isn't enough: a test should fail without the change. The builder is asked for one once.
      const proved = await proveOrAsk(ctx, { agent: builder, role: "builder", wt, check: fixed.check, session: fixer, attempts: checkFixes, ask: !askedForProof });
      askedForProof ||= proved.asked;
      check = proved.check;
      proof = proved.proof;
      fixer = proved.session ?? fixer;
      if (check && !check.ok) {
        ctx.log(`The check still fails after ${checkFixes} fix attempts; stopping before review`, "warn");
        break;
      }

      const diff = await ctx.diff(wt);
      // Test changes go to the reviewer: only someone who didn't write them should accept them.
      const testChanges = await ctx.testChanges(wt);
      const decided = await ctx.decide<ReviewVerdict>({
        title: `Review (round ${round})`,
        schema: REVIEW_SCHEMA,
        what: "review verdict",
        role: "reviewer",
        agent: reviewer,
        mode: "read",
        cwd: wt,
        resume: review,
        prompt:
          (review ? "The builder addressed your previous review. Here is the updated diff.\n" : "") +
          builderReply(reply) +
          preamble("reviewer", reviewer, `${READ_ONLY} You did not write this code; review it critically.`) +
          section("Task", ctx.task) +
          // A reviewer without its earlier session hasn't seen the plan.
          (round === 1 || !review?.sessionId ? section("The planner's plan (context, not the spec)", plan.finalText) : "") +
          section("Diff against base", fence(diff, "diff")) +
          checkEvidence(ctx, check) +
          proofEvidence(proof) +
          (testChanges.length
            ? section(
                "Changes to tests (found by code-flow)",
                `These can make the check pass without fixing anything. Raise each as a medium issue unless the task clearly requires it:\n${describeIssues(testChanges)}`,
              )
            : "") +
          section(
            "Deliverable",
            "Judge the change against the task, not against the plan: the plan is one way to do it, and it can be wrong. " +
              "If following it missed or broke something the task asks for, raise that and say what the task needs instead. " +
              "Check correctness, missed requirements, edge cases, tests and security. Only raise real problems, not style preferences.",
          ) +
          reproRule(ctx) +
          jsonInstruction(REVIEW_SHAPE),
      });

      review = decided.outcome;
      verdict = decided.value;
      reviewRounds = round;
      // Approval goes by what blocks once code-flow has run the reviewer's tests, not by its verdict word.
      findings = await checkReview(ctx, wt, { label: `Review round ${round}`, reviewer, round, review: verdict });
      if (approves(findings) || round === maxRounds) break;

      fixer = await ctx.ask({
        title: `Address review (round ${round})`,
        role: "builder",
        agent: builder,
        mode: "write",
        cwd: wt,
        resume: fixer,
        prompt: findingsForBuilder(reviewer, findings),
      });
      reply = fixer.finalText;
      await ctx.commit(wt, `${builder}: address review round ${round}`);
    }

    await ctx.artifact("Result", wt);
    const green = !check || check.ok;
    const approved = green && !!review && approves(findings);
    if (ctx.hasCheck) ctx.setVerdict(green ? "passed" : "failing");
    ctx.setFacts({ reviewRounds, approved, proof: ctx.proofOf(wt)?.status });
    const headline = !green
      ? `Check \`${check!.command}\` still fails after ${checkFixes} fix attempts`
      : approved
        ? ctx.hasCheck ? `Approved, and \`${check!.command}\` passes` : "Approved"
        : "Not approved: findings still block after the last review round";
    return [
      `**${headline}** — branch \`${wt.branch}\``,
      proofLine(ctx.proofOf(wt)),
      review ? findingsLine(findings) : "",
      section("Builder summary", fixer.finalText),
      review && !approved ? findingsSection("Open review findings", findings) : "",
      !green ? section("Last failure", "```\n" + check!.output.slice(-1_500).trim() + "\n```") : "",
    ].join("\n");
  },
};
