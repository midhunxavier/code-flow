import type { Pattern, StepOutcome } from "../engine.js";
import { extractJson } from "../json.js";
import { fence, jsonInstruction, preamble, READ_ONLY, section, WRITE } from "./prompts.js";

interface ReviewVerdict {
  verdict: "approve" | "changes_requested";
  issues?: { severity?: string; file?: string; problem: string; fix?: string }[];
}

/**
 * Plan → Build → Review loop.
 * One agent plans, another implements, a third (ideally a different vendor) reviews the
 * diff with fresh context. Requested changes go back to the builder, which resumes its own
 * session so it keeps its context.
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
    { id: "reviewer", label: "Reviewer", description: "Reviews the diff with fresh eyes", default: ["claude"] },
  ],
  options: [{ id: "maxRounds", label: "Max review rounds", type: "number", default: 2, min: 1, max: 5 }],

  async run(ctx) {
    const planner = ctx.agent("planner");
    const builder = ctx.agent("builder");
    const reviewer = ctx.agent("reviewer");
    const maxRounds = ctx.option("maxRounds", 2);
    const wt = await ctx.worktree("build");

    const plan = await ctx.ask({
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
            "edge cases, and how to verify it (tests or commands). Keep it under 400 words.",
        ),
    });

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
        section("Deliverable", "Implement the plan, run the relevant tests, then summarize what you changed."),
    });
    await ctx.commit(wt, `${builder}: implement plan`);

    let verdict: ReviewVerdict | undefined;
    let review: StepOutcome | undefined;
    let fixer = build;

    for (let round = 1; round <= maxRounds; round++) {
      const diff = await ctx.diff(wt);
      review = await ctx.ask({
        title: `Review (round ${round})`,
        role: "reviewer",
        agent: reviewer,
        mode: "read",
        cwd: wt,
        resume: review,
        prompt:
          (review ? "The builder addressed your previous review. Here is the updated diff.\n" : "") +
          preamble("reviewer", reviewer, `${READ_ONLY} You did not write this code; review it critically.`) +
          section("Task", ctx.task) +
          (round === 1 ? section("Plan", plan.finalText) : "") +
          section("Diff against base", fence(diff, "diff")) +
          section(
            "Deliverable",
            "Check correctness, missed requirements, edge cases, tests and security. Only request changes for real problems, not style preferences.",
          ) +
          jsonInstruction(
            '{"verdict": "approve" | "changes_requested", "issues": [{"severity": "high|medium|low", "file": "path", "problem": "...", "fix": "..."}]}',
          ),
      });

      verdict = extractJson<ReviewVerdict>(review.finalText);
      if (!verdict) {
        ctx.log("Reviewer did not return a parseable verdict; treating it as approval.", "warn");
        break;
      }
      ctx.log(`Review round ${round}: ${verdict.verdict} (${verdict.issues?.length ?? 0} issues)`);
      if (verdict.verdict === "approve" || round === maxRounds) break;

      fixer = await ctx.ask({
        title: `Address review (round ${round})`,
        role: "builder",
        agent: builder,
        mode: "write",
        cwd: wt,
        resume: fixer,
        prompt:
          `The ${reviewer} reviewer requested changes. Address each issue, re-run tests, and summarize the fixes.\n` +
          fence(JSON.stringify(verdict.issues ?? [], null, 2), "json"),
      });
      await ctx.commit(wt, `${builder}: address review round ${round}`);
    }

    await ctx.artifact("Result", wt);
    const approved = !verdict || verdict.verdict === "approve";
    return [
      `**${approved ? "Approved" : "Not approved after the last review round"}** — branch \`${wt.branch}\``,
      section("Builder summary", fixer.finalText),
      verdict?.issues?.length && !approved
        ? section("Open review issues", verdict.issues.map((i) => `- ${i.problem}`).join("\n"))
        : "",
    ].join("\n");
  },
};
