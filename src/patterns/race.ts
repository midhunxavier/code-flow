import type { Pattern } from "../engine.js";
import { extractJson } from "../json.js";
import { fence, jsonInstruction, LETTERS, preamble, READ_ONLY, section, WRITE } from "./prompts.js";

interface JudgeVerdict {
  winner: string;
  ranking?: string[];
  reasons?: string;
}

/**
 * Best-of-N race.
 * Every contestant solves the same task independently in its own worktree, in parallel.
 * A judge compares the anonymized diffs ("Candidate A/B/…") and picks a winner, so it
 * cannot favour its own vendor by name.
 */
export const racePattern: Pattern = {
  id: "race",
  name: "Best-of-N race",
  summary: "All contestants solve the task in parallel; a judge picks the best anonymized diff.",
  description:
    "Use when the solution space is wide or a task is risky: you get several independent attempts and keep the best one.",
  roles: [
    {
      id: "contestants",
      label: "Contestants",
      description: "Each solves the whole task in its own worktree",
      multiple: true,
      default: ["claude", "codex"],
    },
    { id: "judge", label: "Judge", description: "Compares the anonymized results", default: ["claude"] },
  ],
  options: [],

  async run(ctx) {
    const contestants = ctx.agents("contestants");
    if (contestants.length < 2) throw new Error("A race needs at least two contestants");
    const judge = ctx.agent("judge");

    const entries = await Promise.all(
      contestants.map(async (agent, i) => {
        const label = LETTERS[i]!;
        // Worktree and branch names are neutral so the judge sees no vendor names.
        const wt = await ctx.worktree(`candidate-${label.toLowerCase()}`);
        const result = await ctx.ask({
          title: `Candidate ${label}`,
          role: "contestants",
          agent,
          mode: "write",
          cwd: wt,
          allowFailure: true,
          prompt:
            preamble("contestant", agent, `${WRITE} Other agents are solving the same task independently; the best solution is kept.`) +
            section("Task", ctx.task) +
            section("Deliverable", "Implement the task completely, run the relevant tests, then summarize your approach and test results."),
        });
        await ctx.commit(wt, `${agent}: candidate ${label}`);
        return { label, agent, wt, result, diff: result.ok ? await ctx.diff(wt) : "(attempt failed)" };
      }),
    );

    const viable = entries.filter((e) => e.result.ok && e.diff !== "(no changes)");
    if (viable.length === 0) throw new Error("No contestant produced a usable change");
    for (const e of entries) await ctx.artifact(`Candidate ${e.label} (${e.agent})`, e.wt);

    let winner = viable[0]!;
    let verdict: JudgeVerdict | undefined;
    if (viable.length > 1) {
      const judgeWt = await ctx.worktree("judge");
      const judged = await ctx.ask({
        title: "Judge candidates",
        role: "judge",
        agent: judge,
        mode: "read",
        cwd: judgeWt,
        prompt:
          preamble("judge", judge, `${READ_ONLY} You are looking at the original, unmodified code; the candidates' changes are shown as diffs.`) +
          section("Task", ctx.task) +
          viable
            .map((e) => section(`Candidate ${e.label}`, `Author's summary:\n${e.result.finalText}\n\n${fence(e.diff, "diff")}`))
            .join("") +
          section(
            "Deliverable",
            "Compare the candidates on correctness, completeness, test coverage, simplicity and risk. Pick one winner.",
          ) +
          jsonInstruction('{"winner": "A", "ranking": ["A", "B"], "reasons": "..."}'),
      });
      verdict = extractJson<JudgeVerdict>(judged.finalText);
      const picked = viable.find((e) => e.label === verdict?.winner?.trim().toUpperCase());
      if (picked) winner = picked;
      else ctx.log(`Judge verdict unreadable; defaulting to candidate ${winner.label}`, "warn");
    }

    ctx.log(`Winner: candidate ${winner.label} (${winner.agent})`);
    return [
      `**Winner: Candidate ${winner.label} — ${winner.agent}** on branch \`${winner.wt.branch}\``,
      verdict?.reasons ? section("Judge's reasoning", verdict.reasons) : "",
      section(
        "All candidates",
        entries
          .map((e) => `- ${e.label}: ${e.agent} — ${e.result.ok ? "completed" : `failed (${e.result.error})`} — \`${e.wt.branch}\``)
          .join("\n"),
      ),
    ].join("\n");
  },
};
