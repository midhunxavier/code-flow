import { adapters, type AgentId } from "../adapters/index.js";
import { failureFingerprint, type CheckResult } from "../checks.js";
import type { Pattern, StepOutcome } from "../engine.js";
import { describeIssues, issuesKey } from "../integrity.js";
import { checkSection, preamble, section, WRITE } from "./prompts.js";

/**
 * Loop until green.
 * One agent works on the task; after every turn code-flow runs the check itself and feeds the
 * result back. The loop ends when the check passes — on evidence, not on the agent's word.
 * If the current agent makes no progress (no new commit, or the same failure again) for a
 * few rounds, the next agent in the list takes over with a handover note: a different vendor
 * often gets unstuck where the first one keeps repeating itself.
 * A pass only counts if the tests are still the tests: when the change deletes or skips tests
 * or edits what the check runs, the agent is told to undo that and fix the code instead.
 */
export const loopPattern: Pattern = {
  id: "loop",
  name: "Loop until green",
  summary: "An agent keeps fixing until your check passes; another vendor takes over if it gets stuck.",
  description:
    "Use when “done” is a command you can run: tests, a type check, a build. code-flow runs it after every change, so the loop ends on evidence, not on an agent saying it's done.",
  requiresCheck: true,
  roles: [
    {
      id: "workers",
      label: "Workers",
      description: "Take turns in this order; the next one takes over when the current one is stuck",
      multiple: true,
      default: ["codex", "claude"],
    },
  ],
  options: [
    { id: "maxRounds", label: "Max rounds", type: "number", default: 6, min: 1, max: 30 },
    { id: "stuckAfter", label: "Hand off after stuck rounds", type: "number", default: 2, min: 1, max: 10 },
  ],

  async run(ctx) {
    const workers = ctx.agents("workers");
    if (!workers.length) throw new Error("Pick at least one worker");
    const maxRounds = ctx.option("maxRounds", 6);
    const stuckAfter = ctx.option("stuckAfter", 2);
    const name = (id: AgentId) => adapters[id].displayName;

    const wt = await ctx.worktree("loop");
    const baseline = (await ctx.check(wt, "Baseline check"))!;
    ctx.log(baseline.ok ? "Baseline: the check already passes; the task must keep it passing" : "Baseline: the check fails before any change");

    const sessions = new Map<AgentId, StepOutcome>();
    const history: string[] = [];
    let current = 0;
    let stuck = 0;
    let last: CheckResult = baseline;
    let handover = "";
    let rounds = 0;
    /** Test changes the agent was already told about (it may keep them if the task needs them). */
    let toldAbout = "";
    let tamperNote = "";
    let solvedBy: AgentId | undefined;
    let handoffs = 0;

    for (let round = 1; round <= maxRounds; round++) {
      rounds = round;
      const agent = workers[current]!;
      const session = sessions.get(agent);
      const prompt = session
        ? tamperNote ||
          "The check still fails after your last change." +
            checkSection(last) +
            section("Next", "Find the root cause and fix it in the code — don't weaken or skip tests. Then summarize what you changed.")
        : preamble("worker", agent, `${WRITE} code-flow runs the check below after every turn you take; the loop ends when it passes.`) +
          section("Task", ctx.task) +
          section("Done when", `\`${ctx.run.loop.check}\` passes. Add or update tests for new behaviour, so passing the check proves the task works.`) +
          (handover ? section("Handover", handover) : "") +
          checkSection(last) +
          tamperNote;
      tamperNote = "";

      const turn = await ctx.ask({ title: `Round ${round}`, role: "workers", agent, mode: "write", cwd: wt, resume: session, prompt });
      sessions.set(agent, turn);
      const sha = await ctx.commit(wt, `${agent}: round ${round}`);
      const result = (await ctx.check(wt, `Check after round ${round}`))!;
      history.push(`- Round ${round} (${name(agent)}): ${sha ? "changed code" : "no changes"}, check ${result.ok ? "passed" : "failed"}`);

      const progress = !!sha && (result.ok || failureFingerprint(result) !== failureFingerprint(last));
      last = result;
      if (result.ok) {
        const issues = (await ctx.testChanges(wt)).filter((i) => i.severity === "high");
        if (!issues.length) {
          solvedBy = agent;
          break;
        }
        if (issuesKey(issues) === toldAbout) {
          // Told once and kept them: the task may need it. It's flagged on the result for you.
          ctx.log(`${name(agent)} kept its test changes after being asked to undo them; review them before merging`, "warn");
          solvedBy = agent;
          break;
        }
        toldAbout = issuesKey(issues);
        ctx.log(`The check passes, but only after changes to the tests that could hide the failure:\n${describeIssues(issues)}`, "warn");
        history[history.length - 1] += " — but tests were weakened";
        tamperNote = section(
          "The check passes, but not on evidence",
          "code-flow found these changes to the tests in this branch. They can make the check pass without fixing anything:\n" +
            describeIssues(issues) +
            "\n\nUndo them and fix the code instead. Only if the task itself requires these test changes, keep them and say why in your summary.",
        );
        continue;
      }

      stuck = progress ? 0 : stuck + 1;
      if (stuck >= stuckAfter && workers.length > 1) {
        const next = (current + 1) % workers.length;
        ctx.log(`${name(agent)} made no progress for ${stuck} rounds; handing over to ${name(workers[next]!)}`, "warn");
        handover =
          `${name(agent)} worked on this before you without getting the check to pass. Its commits are on this branch ` +
          `(\`git log\` shows them); keep what's useful, and take a fresh look rather than repeating its approach.\n${history.join("\n")}`;
        sessions.delete(workers[next]!); // start fresh: anything it saw earlier is stale now
        current = next;
        stuck = 0;
        handoffs++;
      }
    }

    await ctx.artifact("Result", wt);
    ctx.setVerdict(last.ok ? "passed" : "failing");
    ctx.setFacts({ solvedBy: last.ok ? solvedBy ?? workers[current] : undefined, handoffs });
    return [
      last.ok
        ? `**Check passes** after ${rounds} round${rounds === 1 ? "" : "s"} — branch \`${wt.branch}\``
        : `**Check still failing** after ${rounds} rounds — branch \`${wt.branch}\` has the latest attempt`,
      section("Rounds", history.join("\n")),
      last.ok ? "" : section("Last failure", "```\n" + last.output.slice(-1_500).trim() + "\n```"),
    ].join("\n");
  },
};
