import type { Pattern } from "../engine.js";
import { extractJson } from "../json.js";
import { checkSection, fence, jsonInstruction, LETTERS, preamble, READ_ONLY, section, WRITE } from "./prompts.js";

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
        const check = result.ok ? await ctx.check(wt, `Check candidate ${label}`) : null;
        return { label, agent, wt, result, check, diff: result.ok ? await ctx.diff(wt) : "(attempt failed)" };
      }),
    );

    const changed = entries.filter((e) => e.result.ok && e.diff !== "(no changes)");
    if (changed.length === 0) throw new Error("No contestant produced a usable change");
    for (const e of entries) await ctx.artifact(`Candidate ${e.label} (${e.agent})`, e.wt);

    // With a check configured, a candidate that fails it can't win if any candidate passes.
    const passing = changed.filter((e) => e.check?.ok);
    const viable = ctx.hasCheck && passing.length ? passing : changed;
    if (ctx.hasCheck) {
      ctx.log(passing.length
        ? `Passing the check: ${passing.map((e) => e.label).join(", ")}${passing.length < changed.length ? " (only these can win)" : ""}`
        : "No candidate passes the check; the judge picks the closest one", passing.length ? "info" : "warn");
    }

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
            .map((e) =>
              section(
                `Candidate ${e.label}`,
                `Author's summary:\n${e.result.finalText}\n\n${fence(e.diff, "diff")}` + (e.check ? checkSection(e.check, 2_000) : ""),
              ),
            )
            .join("") +
          section(
            "Deliverable",
            "Compare the candidates on correctness, completeness, test coverage, simplicity and risk. Pick one winner.",
          ) +
          jsonInstruction('{"winner": "A", "ranking": ["A", "B"], "reasons": "..."}'),
      });
      verdict = extractJson<JudgeVerdict>(judged.finalText);
      const choice = verdict?.winner?.trim().toUpperCase();
      const picked = viable.find((e) => e.label === choice);
      if (picked) winner = picked;
      else if (choice && changed.some((e) => e.label === choice)) {
        ctx.log(`Judge picked candidate ${choice}, but it fails the check; using passing candidate ${winner.label}`, "warn");
      } else ctx.log(`Judge verdict unreadable; defaulting to candidate ${winner.label}`, "warn");
    }

    ctx.log(`Winner: candidate ${winner.label} (${winner.agent})`);
    if (ctx.hasCheck) ctx.setVerdict(winner.check?.ok ? "passed" : "failing");
    return [
      `**Winner: Candidate ${winner.label} — ${winner.agent}** on branch \`${winner.wt.branch}\``,
      verdict?.reasons ? section("Judge's reasoning", verdict.reasons) : "",
      section(
        "All candidates",
        entries
          .map((e) => {
            const status = e.result.ok ? "completed" : `failed (${e.result.error})`;
            const check = e.check ? (e.check.ok ? ", check passes" : ", check fails") : "";
            return `- ${e.label}: ${e.agent} — ${status}${check} — \`${e.wt.branch}\``;
          })
          .join("\n"),
      ),
    ].join("\n");
  },
};
