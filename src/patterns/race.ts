import type { Pattern } from "../engine.js";
import { describeIssues } from "../integrity.js";
import { JUDGE_SCHEMA } from "./schemas.js";
import { checkSection, fence, jsonInstruction, LETTERS, preamble, proofEvidence, proofLine, proofRule, READ_ONLY, section, WRITE } from "./prompts.js";

interface JudgeVerdict {
  winner: string;
  ranking: string[];
  reasons: string;
}

/**
 * Best-of-N race.
 * Every contestant solves the same task independently in its own worktree, in parallel.
 * A judge compares the anonymized diffs ("Candidate A/B/…") and picks a winner, so it
 * cannot favour its own vendor by name. Nothing the judge can reach names the vendor: not the
 * prompt, not the worktree or branch names, not the commit messages (`git log --all`).
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
    {
      id: "judge",
      label: "Judge",
      description: "Compares the results blind; pick several for a majority vote, ideally vendors that aren't competing",
      multiple: true,
      default: ["agy"],
    },
  ],
  options: [],

  async run(ctx) {
    const contestants = ctx.agents("contestants");
    if (contestants.length < 2) throw new Error("A race needs at least two contestants");
    const judges = ctx.agents("judge");
    if (!judges.length) throw new Error("Pick at least one judge");

    // A contestant's failed turn is part of the race; anything else failing (its worktree, a
    // commit) stops the other contestants too.
    const entries = await ctx.parallel(contestants, async (agent, i) => {
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
          proofRule(ctx) +
          section("Deliverable", "Implement the task completely, run the relevant tests, then summarize your approach and test results."),
      });
      await ctx.commit(wt, `candidate ${label}`);
      const check = result.ok ? await ctx.check(wt, `Check candidate ${label}`) : null;
      const tests = result.ok ? (await ctx.testChanges(wt)).filter((i) => i.severity === "high") : [];
      return { label, agent, wt, result, check, tests, diff: result.ok ? await ctx.diff(wt) : "(attempt failed)" };
    });

    const changed = entries.filter((e) => e.result.ok && e.diff !== "(no changes)");
    if (changed.length === 0) throw new Error("No contestant produced a usable change");
    // Publishing a candidate proves it (fail-to-pass) when its check passes; the judge sees that too.
    for (const e of entries) await ctx.artifact(`Candidate ${e.label} (${e.agent})`, e.wt);
    const proofs = new Map(entries.map((e) => [e.label, ctx.proofOf(e.wt)]));

    // With a check configured, a candidate that fails it can't win if any candidate passes —
    // and one that passes only by weakening tests can't win over one that passes honestly.
    const passing = changed.filter((e) => e.check?.ok);
    const honest = passing.filter((e) => !e.tests.length);
    const viable = ctx.hasCheck && passing.length ? (honest.length ? honest : passing) : changed;
    for (const e of changed.filter((e) => e.tests.length)) {
      ctx.log(`Candidate ${e.label} changed tests in ways that could hide failures${honest.length && e.check?.ok ? ", so it can't win" : ""}:\n${describeIssues(e.tests)}`, "warn");
    }
    if (ctx.hasCheck) {
      ctx.log(passing.length
        ? `Passing the check: ${passing.map((e) => e.label).join(", ")}${passing.length < changed.length ? " (only these can win)" : ""}`
        : "No candidate passes the check; the judge picks the closest one", passing.length ? "info" : "warn");
    }

    let winner = viable[0]!;
    let reasons: string[] = [];
    if (viable.length > 1) {
      const competing = judges.filter((j) => contestants.includes(j));
      if (competing.length) ctx.log(`${competing.join(", ")} both competes and judges; a judge from another vendor is fairer`, "warn");
      const judgeWt = await ctx.worktree("judge");
      // Blind judging: no author summaries (they can name the vendor), and the presentation
      // order is shuffled — deterministically per run, so a resumed run replays the same way.
      const order = seededShuffle(viable, ctx.run.id);
      const labels = viable.map((e) => e.label);
      const votes = await ctx.parallel(judges, (judge, i) =>
        ctx.decide<JudgeVerdict>({
          title: judges.length > 1 ? `Judge ${i + 1}` : "Judge candidates",
          role: "judge",
          agent: judge,
          mode: "read",
          cwd: judgeWt,
          schema: JUDGE_SCHEMA,
          what: "pick",
          validate: (v: JudgeVerdict) =>
            changed.some((e) => e.label === v.winner.trim().toUpperCase()) ? undefined : `winner must be one of ${changed.map((e) => e.label).join(", ")}`,
          prompt:
            preamble("judge", judge, `${READ_ONLY} You are looking at the original, unmodified code; each candidate's changes are shown as a diff.`) +
            section("Task", ctx.task) +
            order
              .map((e) =>
                section(
                  `Candidate ${e.label}`,
                  fence(e.diff, "diff") +
                    (e.check ? checkSection(e.check, 2_000) : "") +
                    proofEvidence(proofs.get(e.label) ?? null) +
                    (e.tests.length ? `\n**Changes to tests found by code-flow:**\n${describeIssues(e.tests)}\n` : ""),
                ),
              )
              .join("") +
            section(
              "Deliverable",
              "Compare the candidates on correctness, completeness, test coverage, simplicity and risk" +
                (ctx.proves ? ", and on whether their tests prove the change (a test that fails without it)" : "") +
                `. Pick one winner from: ${labels.join(", ")}.`,
            ) +
            jsonInstruction('{"winner": "A", "ranking": ["A", "B"], "reasons": "..."}'),
        }),
      );
      // Majority vote among candidates that can win; ties go to the earlier label.
      const tally = new Map<string, number>();
      for (const { value } of votes) {
        const choice = value.winner.trim().toUpperCase();
        if (viable.some((e) => e.label === choice)) tally.set(choice, (tally.get(choice) ?? 0) + 1);
        else ctx.log(`Judge picked candidate ${choice}, but it fails the check${tally.size || votes.length > 1 ? "" : `; using passing candidate ${winner.label}`}`, "warn");
        reasons.push(value.reasons);
      }
      const best = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      if (best) winner = viable.find((e) => e.label === best[0])!;
      if (judges.length > 1) ctx.log(`Votes: ${[...tally.entries()].map(([label, n]) => `${label}=${n}`).join(", ") || "none valid"}`);
    }

    ctx.log(`Winner: candidate ${winner.label} (${winner.agent})`);
    if (ctx.hasCheck) ctx.setVerdict(winner.check?.ok ? "passed" : "failing");
    ctx.setFacts({ winner: winner.agent, entrants: entries.map((e) => e.agent), proof: proofs.get(winner.label)?.status });
    return [
      `**Winner: Candidate ${winner.label} — ${winner.agent}** on branch \`${winner.wt.branch}\``,
      proofLine(proofs.get(winner.label) ?? null),
      reasons.length ? section(reasons.length > 1 ? "Judges' reasoning" : "Judge's reasoning", reasons.join("\n\n")) : "",
      section(
        "All candidates",
        entries
          .map((e) => {
            const status = e.result.ok ? "completed" : `failed (${e.result.error})`;
            const check = e.check ? (e.check.ok ? ", check passes" : ", check fails") : "";
            const proof = proofs.get(e.label)?.status;
            const proven = proof === "proven" ? ", proven" : proof === "unproven" ? ", not proven" : "";
            return `- ${e.label}: ${e.agent} — ${status}${check}${proven} — \`${e.wt.branch}\``;
          })
          .join("\n"),
      ),
    ].join("\n");
  },
};

/** Deterministic shuffle (seeded by the run id) so position bias is broken but replays match. */
function seededShuffle<T>(items: T[], seed: string): T[] {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const random = () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
