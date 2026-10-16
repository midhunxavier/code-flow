import { RejectedError, type Pattern, type StepOutcome } from "../engine.js";
import { isPlainTestCommand, type CheckResult } from "../checks.js";
import { changedFiles, resolveCommit, restorePaths } from "../git.js";
import { isTestFile } from "../integrity.js";
import { TEST_SPEC_SCHEMA, TEST_VERDICT_SCHEMA } from "./schemas.js";
import { checkSection, fence, jsonInstruction, preamble, section, WRITE } from "./prompts.js";

interface TestSpec {
  test_command: string;
  test_files: string[];
}

interface TestVerdict {
  verdict: "pass" | "fail";
  failures?: string[];
}

/**
 * Test-first with an adversarial tester.
 * The tester writes failing tests that pin down the behaviour; a different agent implements
 * until they pass, without touching the tests. The tester then runs the suite, probes for
 * gaps with extra tests, and sends failures back to the builder.
 * Each side stays in its lane: code-flow undoes any change the builder makes to the tests, and
 * any change the tester makes outside them, and tells the agent it did.
 */
export const tddPattern: Pattern = {
  id: "tdd",
  name: "Test-first (adversarial tester)",
  summary: "One agent writes the tests, another makes them pass; the tester keeps probing until it is satisfied.",
  description:
    "Use when behaviour can be specified by tests. Splitting test author and implementer stops an agent from grading its own homework.",
  roles: [
    { id: "tester", label: "Tester", description: "Writes and runs the tests, hunts for gaps", default: ["codex"] },
    { id: "builder", label: "Builder", description: "Makes the tests pass without editing them", default: ["claude"] },
  ],
  options: [{ id: "maxRounds", label: "Max fix rounds", type: "number", default: 3, min: 1, max: 6 }],

  async run(ctx) {
    const tester = ctx.agent("tester");
    const builder = ctx.agent("builder");
    const maxRounds = ctx.option("maxRounds", 3);
    const wt = await ctx.worktree("tdd");

    let written = await ctx.decide<TestSpec>({
      title: "Write failing tests",
      schema: TEST_SPEC_SCHEMA,
      what: "test command",
      role: "tester",
      agent: tester,
      mode: "write",
      cwd: wt,
      prompt:
        preamble("tester", tester, `${WRITE} Write tests only — another agent will implement the feature.`) +
        section("Task", ctx.task) +
        section(
          "Deliverable",
          "Use the project's existing test framework. Write tests that specify the required behaviour, including edge cases " +
            "and error handling. Do not implement the feature. Run the tests to confirm they fail for the right reason.",
        ) +
        jsonInstruction('{"test_command": "command that runs these tests", "test_files": ["path/to/test"]}'),
    });
    // Checkpoint: the tests are the spec — approve them before anyone implements.
    for (let round = 1; ; round++) {
      const answer = await ctx.approve(
        "plan",
        round === 1 ? "Approve the tests" : `Approve the revised tests (${round})`,
        `${written.outcome.finalText}\n\nTest command: \`${written.value.test_command}\`\nFiles: ${written.value.test_files.join(", ") || "(none listed)"}`,
      );
      if (answer.decision === "approve") break;
      if (answer.decision === "reject") throw new RejectedError(`You rejected the tests.${answer.note ? ` (${answer.note})` : ""}`);
      written = await ctx.decide<TestSpec>({
        title: `Revise the tests (${round})`,
        schema: TEST_SPEC_SCHEMA,
        what: "test command",
        role: "tester",
        agent: tester,
        mode: "write",
        cwd: wt,
        resume: written.outcome.sessionId ? written.outcome : undefined,
        prompt:
          `The user asked for changes to your tests:\n${answer.note}\n\nUpdate the tests (still no implementation) and report again.` +
          jsonInstruction('{"test_command": "command that runs these tests", "test_files": ["path/to/test"]}'),
      });
    }
    let testerStep = written.outcome;
    const spec: TestSpec | undefined = written.value;
    const testsCommit = await ctx.commit(wt, `${tester}: failing tests`);
    // Grows as the tester adds edge-case tests; the builder may not touch any of them.
    const testFiles = testsCommit ? await changedFiles(wt.path, wt.base, testsCommit) : spec?.test_files ?? [];

    // Evidence comes from code-flow running the tests itself. An agent-chosen command is only run
    // when it looks like a plain test invocation; the user's configured check always runs.
    const reported = spec?.test_command?.trim();
    const targeted = reported && isPlainTestCommand(reported) ? reported : undefined;
    if (reported && !targeted) ctx.log(`Not running the tester's command \`${reported}\`: it isn't a plain test command`, "warn");
    const evidence = !!targeted || ctx.hasCheck;
    if (!evidence) {
      if (!reported) throw new Error("Tester did not report a test command, and no check command is set");
      ctx.log("No test command code-flow can run; relying on the tester's verdict. Set a check in Settings → Done when.", "warn");
    }
    ctx.log(`Test command: ${reported ?? "(none)"}; test files: ${testFiles.join(", ") || "(none detected)"}`);
    const testCommand = targeted ?? ctx.run.loop.check ?? reported!;

    /** Run the new tests and the full check; returns the first failure, or null when all pass. */
    const runTests = async (title: string): Promise<CheckResult | null> => {
      if (targeted) {
        const result = (await ctx.check(wt, title, targeted))!;
        if (!result.ok) return result;
      }
      if (ctx.hasCheck && ctx.run.loop.check !== targeted) {
        const result = (await ctx.check(wt, `${title}: full check`))!;
        if (!result.ok) return result;
      }
      return null;
    };

    // Red first: new tests that already pass don't specify anything new.
    if (targeted) {
      const red = (await ctx.check(wt, "New tests (should fail)", targeted))!;
      if (red.ok) ctx.log("The new tests already pass before any implementation; they may not test the new behaviour", "warn");
    }

    let builderStep: StepOutcome | undefined;
    let verdict: TestVerdict | undefined;
    let feedback = "";
    let green = false;

    for (let round = 1; round <= maxRounds; round++) {
      // Only the builder's own changes count when checking for edited tests.
      const before = await ctx.remember("head", `before round ${round}`, () => resolveCommit(wt.path));
      builderStep = await ctx.ask({
        title: round === 1 ? "Implement to pass tests" : `Fix failures (round ${round})`,
        role: "builder",
        agent: builder,
        mode: "write",
        cwd: wt,
        resume: builderStep,
        prompt:
          round === 1
            ? preamble("builder", builder, WRITE) +
              section("Task", ctx.task) +
              section("Tests to satisfy", `Run with: \`${testCommand}\`\nTest files:\n${testFiles.map((f) => `- ${f}`).join("\n")}`) +
              section(
                "Rules",
                "Make the tests pass by implementing the feature properly. Do NOT modify, skip or delete the tests. " +
                  "If a test looks wrong, explain why in your summary instead of changing it.",
              )
            : `Not done yet:\n${feedback}\n\nFix the implementation (not the tests), re-run \`${testCommand}\`, and summarize.`,
      });
      await ctx.commit(wt, `${builder}: implementation round ${round}`);

      // The tests are the spec: the builder's changes to them are undone, not just reported.
      const touched = (await changedFiles(wt.path, before)).filter((f) => testFiles.includes(f));
      let tamperNote = "";
      if (touched.length) {
        ctx.log(`Builder modified test files: ${touched.join(", ")}; code-flow put them back`, "warn");
        await ctx.remember("restore-tests", `round ${round}`, () => restorePaths(wt.path, before, touched).then(() => true));
        await ctx.commit(wt, `code-flow: restore tests changed by ${builder} (round ${round})`);
        tamperNote = `\nNote: the builder changed ${touched.join(", ")}; code-flow put those test files back as you wrote them.`;
        feedback = `You changed the test files ${touched.join(", ")}. code-flow put them back: the tests are the spec. Make them pass by changing the implementation.\n\n`;
      } else {
        feedback = "";
      }

      if (evidence) {
        const failing = await runTests(`Tests after round ${round}`);
        if (failing) {
          feedback += checkSection(failing);
          continue; // straight back to the builder; no point probing red code
        }
      }

      const beforeProbe = await ctx.remember("head", `before probe ${round}`, () => resolveCommit(wt.path));
      const probed = await ctx.decide<TestVerdict>({
        title: `Try to break it (round ${round})`,
        schema: TEST_VERDICT_SCHEMA,
        what: "test verdict",
        role: "tester",
        agent: tester,
        mode: "write",
        cwd: wt,
        resume: testerStep,
        prompt:
          `The builder has implemented the feature.${tamperNote}\n` +
          (evidence ? "code-flow ran the tests and they pass. " : `Run \`${testCommand}\`. `) +
          "Now try to break the implementation: add tests for edge cases you missed (add them to the test files; do not change the implementation). " +
          "Report pass only if you found no real gaps." +
          section("Diff since your tests", fence(await ctx.diff(wt, testsCommit ?? wt.base), "diff")) +
          jsonInstruction('{"verdict": "pass" | "fail", "failures": ["what failed and why"]}'),
      });
      await ctx.commit(wt, `${tester}: edge-case tests round ${round}`);
      // The tester probes with tests; changes it makes to the implementation are undone.
      const probeChanges = await changedFiles(wt.path, beforeProbe);
      const outside = probeChanges.filter((f) => !isTestFile(f) && !testFiles.includes(f));
      for (const f of probeChanges) if (!outside.includes(f) && !testFiles.includes(f)) testFiles.push(f);
      if (outside.length) {
        ctx.log(`Tester changed files outside the tests: ${outside.join(", ")}; code-flow undid that`, "warn");
        await ctx.remember("restore-implementation", `round ${round}`, () => restorePaths(wt.path, beforeProbe, outside).then(() => true));
        await ctx.commit(wt, `code-flow: undo ${tester}'s changes outside the tests (round ${round})`);
      }
      testerStep = probed.outcome;
      verdict = probed.value;
      const gaps = (verdict?.failures ?? []).map((f) => `- ${f}`).join("\n");

      if (evidence) {
        const failing = await runTests(`Tests incl. new edge cases (round ${round})`);
        if (!failing && (!verdict || verdict.verdict === "pass")) {
          green = true;
          break;
        }
        feedback = failing ? checkSection(failing) : gaps || testerStep.finalText;
      } else {
        if (!verdict || verdict.verdict === "pass") {
          green = true;
          break;
        }
        feedback = gaps || testerStep.finalText;
      }
      ctx.log(`Round ${round}: not done yet`);
    }

    await ctx.artifact("Result", wt);
    if (evidence) ctx.setVerdict(green ? "passed" : "failing");
    const headline = green
      ? evidence ? "All tests pass (run by code-flow)" : "The tester reports all tests pass"
      : "Tests still failing after the last round";
    return [
      `**${headline}** — branch \`${wt.branch}\``,
      `Test command: \`${testCommand}\``,
      !green && feedback ? section("Still open", feedback) : "",
      builderStep ? section("Builder summary", builderStep.finalText) : "",
    ].join("\n");
  },
};
