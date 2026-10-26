import { RejectedError, type Pattern, type StepOutcome } from "../engine.js";
import { isPlainTestCommand, type CheckResult } from "../checks.js";
import { changedFiles, resolveCommit, restorePaths } from "../git.js";
import { changesRunner, describeIssues, isPlainSource, isRunnerConfig, isTestFile, type IntegrityIssue } from "../integrity.js";
import { TEST_SPEC_SCHEMA, TEST_VERDICT_SCHEMA } from "./schemas.js";
import { checkSection, fence, jsonInstruction, preamble, proofLine, section, WRITE } from "./prompts.js";

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
 * Each side stays in its lane: code-flow undoes any change the builder makes to the tests (and to
 * the test runner's own config), and any change the tester makes outside them, and tells the agent
 * it did. What can't be put back file by file (the runner's settings in package.json or
 * pyproject.toml, a skip, fewer tests running) goes back to the builder, and a pass doesn't count
 * until it's undone.
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
    let testsCommit = await ctx.commit(wt, `${tester}: failing tests`);
    // Grows as the tester adds edge-case tests; the builder may not touch any of them: tests,
    // fixtures, snapshots, test config (and whatever the tester named). Only a plain source file
    // the tester added, a stub for the tests to import, is the builder's to fill in.
    const named = (spec?.test_files ?? []).map((f) => f.replace(/^\.\//, ""));
    const testsIn = async (commit: string | null) => (commit ? (await changedFiles(await ctx.gitAt(wt), wt.base, commit)).filter((f) => !isPlainSource(f) || named.includes(f)) : named);
    let testFiles = await testsIn(testsCommit);

    // Evidence comes from code-flow running the tests itself. An agent-chosen command is only run
    // when it looks like a plain test invocation; the user's configured check always runs.
    const reported = spec?.test_command?.trim();
    const targeted = reported && isPlainTestCommand(reported) ? reported : undefined;
    if (reported && !targeted) ctx.log(`Not running the tester's command \`${reported}\`: it isn't a plain test command`, "warn");
    // A check that turns out not to run here stops counting as evidence — the tester's command
    // too, when it is the run's check.
    const runsTargeted = () => !!targeted && !(targeted === ctx.run.loop.check && ctx.run.checkCantRun);
    const evidence = () => runsTargeted() || ctx.hasCheck;
    if (!evidence()) {
      if (!reported) throw new Error("Tester did not report a test command, and no check command is set");
      ctx.log("No test command code-flow can run; relying on the tester's verdict. Set a check in Settings → Done when.", "warn");
    }
    ctx.log(`Test command: ${reported ?? "(none)"}; test files: ${testFiles.join(", ") || "(none detected)"}`);
    const testCommand = targeted ?? ctx.run.loop.check ?? reported!;

    /** Run the new tests and the full check; returns the first failure, or null when all pass. */
    // null from a check means it can't run here (code-flow has said so in the log): no evidence
    // either way, not a pass and not a failure.
    const runTests = async (title: string): Promise<CheckResult | null> => {
      if (runsTargeted()) {
        const result = await ctx.check(wt, title, targeted);
        if (result && !result.ok) return result;
      }
      if (ctx.hasCheck && ctx.run.loop.check !== targeted) {
        const result = await ctx.check(wt, `${title}: full check`);
        if (result && !result.ok) return result;
      }
      return null;
    };

    // Red first: tests that pass before anything is implemented don't specify anything new. This
    // is the first half of a fail-to-pass proof, so the tester gets one chance to fix it.
    const redCommand = runsTargeted() ? targeted : ctx.hasCheck ? ctx.run.loop.check : undefined;
    if (redCommand) {
      let red = await ctx.checkBeforeImplementation(wt, "New tests (should fail)", redCommand);
      if (red?.ok && ctx.run.prove !== false) {
        ctx.log("The new tests already pass before any implementation; asking the tester for tests that fail first", "warn");
        testerStep = await ctx.ask({
          title: "Make the tests fail first",
          role: "tester",
          agent: tester,
          mode: "write",
          cwd: wt,
          resume: testerStep,
          prompt:
            `code-flow ran \`${redCommand}\` before anyone implemented the feature, and it passes: your tests don't pin down anything the code doesn't already do.\n` +
            "Change them so they fail now, for the missing behaviour, and pass once it's implemented. Write tests only." +
            checkSection(red),
        });
        const revised = await ctx.commit(wt, `${tester}: tests that fail first`);
        if (revised) {
          testsCommit = revised;
          testFiles = await testsIn(revised);
          red = await ctx.checkBeforeImplementation(wt, "Revised tests (should fail)", redCommand);
        }
      }
      if (red?.ok) ctx.log("The new tests already pass before any implementation; they may not test the new behaviour", "warn");
    }

    let builderStep: StepOutcome | undefined;
    let verdict: TestVerdict | undefined;
    let feedback = "";
    let green = false;
    /** How the builder changed the way the tests run, when the tests passed with it and it wasn't undone. */
    let unresolved: IntegrityIssue[] = [];
    /**
     * The commit before the round where the builder's changes to how the tests run began, while
     * they stand. Every commit since is the builder's (or code-flow's): such a round goes straight
     * back to it, without the tester's probe.
     */
    let tamperedSince: string | undefined;

    for (let round = 1; round <= maxRounds; round++) {
      // Only the builder's own changes count when checking for edited tests.
      const before = await ctx.remember("head", `before round ${round}`, async () => resolveCommit(await ctx.gitAt(wt)));
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

      // The tests are the spec: the builder's changes to them are undone, not just reported. So
      // are its changes to the test runner's own config, a new conftest.py or vitest.config too:
      // those can make the tests pass as surely as editing them.
      const touched = (await ctx.changedFiles(wt, before)).filter((f) => testFiles.includes(f) || isRunnerConfig(f));
      let tamperNote = "";
      if (touched.length) {
        ctx.log(`Builder modified test files: ${touched.join(", ")}; code-flow put them back`, "warn");
        await ctx.remember("restore-tests", `round ${round}`, () => restorePaths(ctx.run.repo, wt, before, touched).then(() => true));
        await ctx.commit(wt, `code-flow: restore tests changed by ${builder} (round ${round})`);
        tamperNote = `\nNote: the builder changed ${touched.join(", ")}; code-flow put those test files back as you wrote them.`;
        feedback = `You changed the test files ${touched.join(", ")}. code-flow put them back: the tests are the spec. Make them pass by changing the implementation.\n\n`;
      } else {
        feedback = "";
      }

      const failing = evidence() ? await runTests(`Tests after round ${round}`) : null;
      // What can't simply be put back: the runner's settings in package.json or pyproject.toml, the
      // check's script, skips, fewer tests running. Until the builder undoes it, a pass isn't one.
      // From where they began, so one the builder leaves in place is found again.
      const issues = await ctx.testChanges(wt, tamperedSince ?? before);
      const tampered = issues.filter((i) => i.severity === "high" || changesRunner(i));
      tamperedSince = tampered.length ? tamperedSince ?? before : undefined;
      unresolved = failing ? [] : tampered;
      const other = issues.filter((i) => !tampered.includes(i));
      if (other.length) tamperNote += `\nNote: the builder also changed these, which the tests read; check they don't hide anything:\n${describeIssues(other)}`;
      if (tampered.length) {
        ctx.log(`Builder changed how the tests run:\n${describeIssues(tampered)}`, "warn");
        feedback +=
          section(
            "You changed how the tests run",
            `code-flow found these in your changes. They can make the tests pass without implementing anything:\n${describeIssues(tampered)}\n\n` +
              "Undo them: the tests and how they run are the spec. Make the tests pass by changing the implementation.",
          ) + "\n";
      }
      if (failing) feedback += checkSection(failing);
      if (failing || tampered.length) continue; // straight back to the builder; no point probing red code

      const beforeProbe = await ctx.remember("head", `before probe ${round}`, async () => resolveCommit(await ctx.gitAt(wt)));
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
          (evidence() ? "code-flow ran the tests and they pass. " : `Run \`${testCommand}\`. `) +
          "Now try to break the implementation: add tests for edge cases you missed (add them to the test files; do not change the implementation). " +
          "Report pass only if you found no real gaps." +
          section("Diff since your tests", fence(await ctx.diff(wt, testsCommit ?? wt.base), "diff")) +
          jsonInstruction('{"verdict": "pass" | "fail", "failures": ["what failed and why"]}'),
      });
      await ctx.commit(wt, `${tester}: edge-case tests round ${round}`);
      // The tester probes with tests; changes it makes to the implementation are undone.
      const probeChanges = await ctx.changedFiles(wt, beforeProbe);
      const outside = probeChanges.filter((f) => !isTestFile(f) && !testFiles.includes(f));
      for (const f of probeChanges) if (!outside.includes(f) && !testFiles.includes(f)) testFiles.push(f);
      if (outside.length) {
        ctx.log(`Tester changed files outside the tests: ${outside.join(", ")}; code-flow undid that`, "warn");
        await ctx.remember("restore-implementation", `round ${round}`, () => restorePaths(ctx.run.repo, wt, beforeProbe, outside).then(() => true));
        await ctx.commit(wt, `code-flow: undo ${tester}'s changes outside the tests (round ${round})`);
      }
      testerStep = probed.outcome;
      verdict = probed.value;
      const gaps = (verdict?.failures ?? []).map((f) => `- ${f}`).join("\n");

      if (evidence()) {
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
    // Tests that pass only the way the builder changed them to run say nothing either way: no verdict.
    if (evidence() && !unresolved.length) ctx.setVerdict(green ? "passed" : "failing");
    ctx.setFacts({ proof: ctx.proofOf(wt)?.status });
    const headline = green
      ? evidence() ? "All tests pass (run by code-flow)" : "The tester reports all tests pass"
      : unresolved.length
        ? "The tests pass only with the builder's changes to how they run"
        : "Tests still failing after the last round";
    return [
      `**${headline}** — branch \`${wt.branch}\``,
      `Test command: \`${testCommand}\``,
      green ? proofLine(ctx.proofOf(wt)) : "",
      !green && feedback ? section("Still open", feedback) : "",
      builderStep ? section("Builder summary", builderStep.finalText) : "",
    ].join("\n");
  },
};
