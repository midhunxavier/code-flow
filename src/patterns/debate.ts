import { adapters } from "../adapters/index.js";
import type { Pattern, StepOutcome } from "../engine.js";
import { fixUntilGreen, planCheckpoint, preamble, READ_ONLY, section, WRITE } from "./prompts.js";

/**
 * Debate → Synthesize → Build.
 * Debaters propose designs independently, then read each other's proposals and revise
 * (critique rounds). A synthesizer merges the final positions into one plan, and an
 * optional builder implements it.
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
  ],
  options: [{ id: "rounds", label: "Critique rounds", type: "number", default: 1, min: 0, max: 3 }],

  async run(ctx) {
    const debaters = ctx.agents("debaters");
    if (debaters.length < 2) throw new Error("A debate needs at least two debaters");
    const rounds = ctx.option("rounds", 1);
    const designWt = await ctx.worktree("design");

    // Round 0: independent proposals, in parallel.
    let positions: StepOutcome[] = await Promise.all(
      debaters.map((agent) =>
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
      ),
    );

    // Critique rounds: each debater sees the others' latest positions and revises its own.
    for (let round = 1; round <= rounds; round++) {
      const snapshot = positions;
      positions = await Promise.all(
        snapshot.map((own) => {
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
          });
        }),
      );
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
    const { check } = await fixUntilGreen(ctx, { agent: builder, role: "builder", wt: buildWt, session: build, attempts: 2 });
    await ctx.artifact("Result", buildWt);
    if (check) ctx.setVerdict(check.ok ? "passed" : "failing");

    return [
      `**Built**${check ? (check.ok ? `, and \`${check.command}\` passes` : `, but \`${check.command}\` still fails`) : ""} on branch \`${buildWt.branch}\``,
      section("Synthesized plan", plan.finalText),
      section("Builder summary", build.finalText),
    ].join("\n");
  },
};
