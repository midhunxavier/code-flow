import type { Pattern, StepOutcome } from "../engine.js";
import { changedFiles, resolveCommit } from "../git.js";
import { extractJson } from "../json.js";
import { fence, jsonInstruction, preamble, section, WRITE } from "./prompts.js";

interface TestSpec {
  test_command: string;
  test_files?: string[];
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

    let testerStep = await ctx.ask({
      title: "Write failing tests",
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
    const spec = extractJson<TestSpec>(testerStep.finalText);
    if (!spec?.test_command) throw new Error("Tester did not report a test command");
    const testsCommit = await ctx.commit(wt, `${tester}: failing tests`);
    const testFiles = testsCommit ? await changedFiles(wt.path, wt.base, testsCommit) : spec.test_files ?? [];
    ctx.log(`Test command: ${spec.test_command}; test files: ${testFiles.join(", ") || "(none detected)"}`);

    let builderStep: StepOutcome | undefined;
    let verdict: TestVerdict | undefined;
    let feedback = "";

    for (let round = 1; round <= maxRounds; round++) {
      // Only the builder's own changes count when checking for edited tests.
      const before = await resolveCommit(wt.path);
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
              section("Tests to satisfy", `Run with: \`${spec.test_command}\`\nTest files:\n${testFiles.map((f) => `- ${f}`).join("\n")}`) +
              section(
                "Rules",
                "Make the tests pass by implementing the feature properly. Do NOT modify, skip or delete the tests. " +
                  "If a test looks wrong, explain why in your summary instead of changing it.",
              )
            : `The tester found these problems:\n${feedback}\n\nFix the implementation (not the tests), re-run \`${spec.test_command}\`, and summarize.`,
      });
      await ctx.commit(wt, `${builder}: implementation round ${round}`);

      const touched = (await changedFiles(wt.path, before)).filter((f) => testFiles.includes(f));
      const tamperNote = touched.length
        ? `\nWARNING: the builder modified test files: ${touched.join(", ")}. Check whether that weakened the tests.`
        : "";
      if (touched.length) ctx.log(`Builder modified test files: ${touched.join(", ")}`, "warn");

      testerStep = await ctx.ask({
        title: `Verify (round ${round})`,
        role: "tester",
        agent: tester,
        mode: "write",
        cwd: wt,
        resume: testerStep,
        prompt:
          `The builder has implemented the feature.${tamperNote}\n` +
          `Run \`${spec.test_command}\`. Then try to break the implementation: add tests for edge cases you missed ` +
          "(add them to the test files; do not change the implementation). Report pass only if everything passes and you found no real gaps." +
          section("Diff since your tests", fence(await ctx.diff(wt, testsCommit ?? wt.base), "diff")) +
          jsonInstruction('{"verdict": "pass" | "fail", "failures": ["what failed and why"]}'),
      });
      await ctx.commit(wt, `${tester}: verification round ${round}`);

      verdict = extractJson<TestVerdict>(testerStep.finalText);
      ctx.log(`Round ${round}: ${verdict?.verdict ?? "no verdict"}`);
      if (!verdict || verdict.verdict === "pass") break;
      feedback = (verdict.failures ?? []).map((f) => `- ${f}`).join("\n") || testerStep.finalText;
    }

    await ctx.artifact("Result", wt);
    const passed = verdict?.verdict === "pass";
    return [
      `**${passed ? "All tests pass" : "Tests still failing after the last round"}** — branch \`${wt.branch}\``,
      `Test command: \`${spec.test_command}\``,
      !passed && verdict?.failures?.length ? section("Remaining failures", verdict.failures.map((f) => `- ${f}`).join("\n")) : "",
      builderStep ? section("Builder summary", builderStep.finalText) : "",
    ].join("\n");
  },
};
