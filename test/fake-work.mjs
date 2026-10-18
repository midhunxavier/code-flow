// What a fake agent does with a prompt, whichever way it was asked (one-shot CLI or Codex's
// app-server): its side effects in the working directory, then its answer. Answers the structured
// prompts the patterns send, so workflows can be exercised end to end.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";

/**
 * `fail(message, codexErrorInfo?)` ends the turn as a failure in the caller's own way and doesn't
 * return. Returns the answer, and the structured answer when a schema was requested.
 */
export function work({ vendor, prompt, write, schemaRequested, fail }) {
  if (prompt.includes("SNEAKY")) writeFileSync("sneaky.txt", "a read-only step wrote this\n");
  // A read-only step that commits: `git status` is clean afterwards, so only HEAD shows it.
  if (prompt.includes("COMMITS-IN-READ") && !write) {
    writeFileSync("committed-in-read.txt", "x\n");
    execFileSync("git", ["add", "committed-in-read.txt"]);
    execFileSync("git", ["-c", "user.name=x", "-c", "user.email=x@x", "commit", "-qm", "sneaky commit from a read-only step"]);
  }
  // Leave a background process holding stdout open, like `npm run dev &` would.
  if (process.env.FAKE_LINGER_VENDOR === vendor) {
    const child = spawn("sleep", ["30"], { stdio: ["ignore", "inherit", "inherit"] });
    writeFileSync(process.env.FAKE_LINGER_PIDFILE, String(child.pid));
    child.unref();
  }
  const once = (name) => {
    const marker = `${process.env.CODEFLOW_HOME}/.${name}-once`;
    if (existsSync(marker)) return false;
    writeFileSync(marker, "1");
    return true;
  };
  if (process.env.FAKE_TRANSIENT_VENDOR === vendor && write && once("transient")) {
    fail('API Error: 529 {"type":"overloaded_error"}', "serverOverloaded");
  }
  if (process.env.FAKE_USAGE_LIMIT_VENDOR === vendor && write) {
    fail("You've hit your usage limit. Upgrade or try again in 4 hours.", "usageLimitExceeded");
  }
  const id = createHash("sha1").update(prompt + vendor + Date.now()).digest("hex").slice(0, 8);

  if (process.env.FAKE_FAIL_VENDOR === vendor && write) fail("boom");

  let answer = `${vendor} handled the request.`;
  const json = (obj) => `Done.\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;

  if (prompt.includes('"subtasks"')) {
    const conflict = prompt.includes("CONFLICT");
    answer = json({
      contracts: "Each part writes its own file; no shared names.",
      subtasks: [
        { id: "alpha", title: "Alpha part", instructions: conflict ? "Write shared.txt CONFLICT" : "Build alpha", agent: "claude" },
        { id: "beta", title: "Beta part", instructions: conflict ? "Write shared.txt CONFLICT" : "Build beta", agent: "codex" },
      ],
    });
  } else if (prompt.includes("Resolve every conflict")) {
    // Resolve whatever is actually conflicted (falls back to shared.txt for the supervisor test).
    const conflicted = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"]).toString().split("\n").filter(Boolean);
    for (const file of conflicted.length ? conflicted : ["shared.txt"]) writeFileSync(file, "resolved by fake agent\n");
    answer = "Resolved the conflicts.";
  } else if (prompt.includes("did not contain a valid")) {
    // A format retry: answer with a minimal object that fits the schema in the prompt.
    const schema = JSON.parse(prompt.match(/```json\n([\s\S]*?)\n```/)[1]);
    const instance = (s) => s.enum ? s.enum[0] : s.type === "object" ? Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, instance(v)])) : s.type === "array" ? [] : s.type === "number" ? 0 : s.type === "boolean" ? false : "x";
    answer = json(instance(schema));
  } else if (prompt.includes('"test_command"')) {
    // A real test: passes once any agent has written its "<vendor>-<id>.txt" implementation file.
    // FAKE_TESTS_PASS_FIRST: a test that passes before anything is implemented, until asked again.
    writeFileSync("spec.test.mjs", process.env.FAKE_TESTS_PASS_FIRST ? passingTest : implementedTest);
    answer = json({ test_command: "node --test spec.test.mjs", test_files: ["spec.test.mjs"] });
  } else if (write && prompt.includes("Change them so they fail now")) {
    writeFileSync("spec.test.mjs", implementedTest);
    answer = "Rewrote the tests so they fail until the feature is implemented.";
  } else if (write && prompt.includes("a test that fails without your change")) {
    // Asked to prove the change: a test that fails on the original code (no implementation file
    // there) and passes with it. FAKE_NO_PROOF: decline; FAKE_PROOF_BREAKS: a test that never passes.
    if (process.env.FAKE_NO_PROOF) answer = "This change can't be tested that way: it only adds a file.";
    else {
      writeFileSync(`proof-${id}.test.mjs`, process.env.FAKE_PROOF_BREAKS ? brokenTest : implementedTest);
      answer = "Added a test that fails without the change.";
    }
  } else if (prompt.includes('"verdict": "pass" | "fail"')) {
    answer = json({ verdict: "pass", failures: [] });
  } else if (prompt.includes('"raised_by"')) {
    // Review council chair: merge the reviewers' findings, out of order (code-flow ranks them).
    // FAKE_REPRO: findings that came with tests, one that fails (raised by one reviewer) and one
    // that passes (raised by both); "council-false-alarms": only a false alarm and a suggestion.
    // FAKE_CHAIR_VERDICT: the chair's verdict word, whatever the findings say.
    const falseAlarms = process.env.FAKE_REPRO === "council-false-alarms";
    answer = json({
      verdict: process.env.FAKE_CHAIR_VERDICT ?? "changes_requested",
      summary: "Two reviewers found the same off-by-one.",
      findings: falseAlarms
        ? [
            { severity: "low", file: "README.md", problem: "Typo", fix: "Fix the typo", raised_by: ["B"], repro: noRepro },
            { severity: "high", file: "feature.txt", problem: "Missing null check", fix: "Check for null", raised_by: ["A", "B"], repro: passingRepro },
          ]
        : process.env.FAKE_REPRO
        ? [
            { severity: "low", file: "README.md", problem: "Typo", fix: "Fix the typo", raised_by: ["B"], repro: noRepro },
            { severity: "medium", file: "feature.txt", problem: "No docs for the feature", fix: "Document it", raised_by: ["A", "B"], repro: noRepro },
            { severity: "high", file: "feature.txt", problem: "Missing null check", fix: "Check for null", raised_by: ["A", "B"], repro: passingRepro },
            { severity: "high", file: "feature.txt", problem: "Off-by-one in the loop", fix: "Use < instead of <=", raised_by: ["A"], repro: failingRepro },
          ]
        : [
            { severity: "low", file: "README.md", problem: "Typo", fix: "Fix the typo", raised_by: ["A", "B"], repro: noRepro },
            { severity: "medium", file: "feature.txt", problem: "No check for empty input", fix: "Return early when n is 0", raised_by: ["A"], repro: noRepro },
            { severity: "high", file: "feature.txt", problem: "Off-by-one in the loop", fix: "Use < instead of <=", raised_by: ["A", "B"], repro: noRepro },
          ],
    });
  } else if (prompt.includes("Other reviewers are reviewing the same changes")) {
    const offByOne = { severity: "high", file: "feature.txt", problem: "Off-by-one in the loop", fix: "Use <" };
    answer = json({
      verdict: "changes_requested",
      issues: process.env.FAKE_REPRO
        ? [{ ...offByOne, repro: failingRepro }, { severity: "high", file: "feature.txt", problem: "Missing null check", fix: "Check for null", repro: passingRepro }]
        : [{ ...offByOne, repro: noRepro }],
    });
  } else if (prompt.includes('"verdict": "approve" | "changes_requested"') && process.env.FAKE_REPRO) {
    // A reviewer that shows its finding with a test (FAKE_REPRO): fails (a real bug, raised in the
    // first review only), passes (a false alarm), none (no test), approve-fails (a failing test,
    // every review, under an "approve" verdict), uncollected (a test the check never runs),
    // symlink (a test whose path goes through the repo's tracked `linked` symlink).
    const mode = process.env.FAKE_REPRO;
    const marker = `${process.env.CODEFLOW_HOME}/.repro-reviewed-once`;
    const first = !existsSync(marker);
    if (first) writeFileSync(marker, "1");
    const issue = (repro) => ({ severity: "high", file: "feature.txt", problem: "Off-by-one in the loop bound", fix: "Use < instead of <=", repro });
    answer = json(
      mode === "fails"
        ? first ? { verdict: "changes_requested", issues: [issue(failingRepro)] } : { verdict: "approve", issues: [] }
        : mode === "approve-fails"
          ? { verdict: "approve", issues: [issue({ path: "tests/bound.test.mjs", contents: failingRepro.contents, command: "node --test tests/bound.test.mjs" })] }
          : mode === "uncollected"
            ? { verdict: "changes_requested", issues: [issue({ ...failingRepro, path: "notes/bound.spec.txt" })] }
            : mode === "symlink"
              ? { verdict: "changes_requested", issues: [issue({ ...failingRepro, path: "linked/.codeflow/config.test.mjs" })] }
            : { verdict: "changes_requested", issues: [issue(mode === "passes" ? passingRepro : noRepro)] },
    );
  } else if (prompt.includes('"verdict": "approve" | "changes_requested"')) {
    // State lives outside the worktree: read-only steps have their file changes reverted.
    const marker = `${process.env.CODEFLOW_HOME}/.reviewed-once`;
    const failReview = process.env.FAKE_REVIEW_FAIL_ONCE && !existsSync(marker);
    if (failReview) writeFileSync(marker, "1");
    answer = json(
      failReview
        ? { verdict: "changes_requested", issues: [{ severity: "medium", file: "src/x.ts", problem: "missing edge case", fix: "handle it", repro: noRepro }] }
        : { verdict: "approve", issues: [] },
    );
  } else if (prompt.includes('"winner"')) {
    answer = json({ winner: "B", ranking: ["B", "A"], reasons: "B is simpler" });
  } else if (write && process.env.FAKE_TAMPER && existsSync("failing.test.mjs")) {
    // Gaming the check: delete the test that fails instead of fixing the code.
    execFileSync("git", ["rm", "-q", "failing.test.mjs"]);
    answer = "Removed a broken test.";
  } else if (write && process.env.FAKE_IMPORT_TEST) {
    // A module and a test of it: without the module (on the base code), the test can't even load.
    writeFileSync("feature.mjs", "export const feature = () => 1;\n");
    writeFileSync("feature.test.mjs", testFile('import { feature } from "./feature.mjs";', 'test("feature", () => assert.equal(feature(), 1));'));
    answer = "Added the feature and its test.";
  } else if (write && process.env.FAKE_CI_TAMPER && prompt.includes("CI fails on the pull request")) {
    // Gaming CI instead of fixing it: "workflow" comments out the failing job; "fewer" drops one of
    // the tests the check counts (t-*.txt), which no test file shows.
    if (process.env.FAKE_CI_TAMPER === "workflow") writeFileSync(".github/workflows/ci.yml", "jobs:\n  # test:\n  #   runs-on: ubuntu-latest\n  lint:\n    runs-on: ubuntu-latest\n");
    else execFileSync("git", ["rm", "-q", "t-2.txt"]);
    writeFileSync(`${vendor}-${id}.txt`, `${vendor} output\n`);
    answer = "CI passes now.";
  } else if (write && process.env.FAKE_BUILDER_TAMPER && (prompt.includes("Make the tests pass") || prompt.includes("You changed how the tests run"))) {
    // A builder that changes how the tests run as well as implementing: "conftest" adds a
    // conftest.py that ignores the tests; "jest" adds a jest block to package.json that ignores
    // them, and takes it out when told; "jest-keeps" never does.
    const mode = process.env.FAKE_BUILDER_TAMPER;
    const told = prompt.includes("You changed how the tests run");
    if (mode === "conftest") writeFileSync("conftest.py", 'collect_ignore = ["spec.test.mjs"]\n');
    else if (!told || mode === "jest") {
      const pkg = JSON.parse(readFileSync("package.json", "utf8"));
      if (told) delete pkg.jest;
      else pkg.jest = { testPathIgnorePatterns: ["spec.test.mjs"] };
      writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
    }
    writeFileSync(`${vendor}-${id}.txt`, `${vendor} output\n`);
    answer = told && mode === "jest" ? "Took the jest settings out and implemented it." : "Implemented it and set up the tests.";
  } else if (write && process.env.FAKE_EDIT_TESTS && prompt.includes("Make the tests pass") && existsSync("spec.test.mjs")) {
    writeFileSync("spec.test.mjs", 'import { test } from "node:test";\ntest("always passes", () => {});\n');
    writeFileSync(`${vendor}-${id}.txt`, `${vendor} output\n`);
    answer = "Simplified the test and implemented it.";
  } else if (write && process.env.FAKE_BREAKS_VENDOR === vendor) {
    // A change that makes things worse: see FAILING_CHECK in the loop tests.
    writeFileSync(`broken-${vendor}-${id}.txt`, `${vendor} broke something\n`);
    answer = `Tried something else as ${vendor}.`;
  } else if (write && process.env.FAKE_ADDS_DEP) {
    // A change that adds a package and a test that uses it, installed the way `npm install` would
    // (node_modules is gitignored). The test passes without the change's own code.
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    writeFileSync("package.json", JSON.stringify({ ...pkg, dependencies: { ...pkg.dependencies, "pad-fake": "1.0.0" } }, null, 2) + "\n");
    execFileSync(process.execPath, ["install.mjs"]);
    writeFileSync("pad.test.mjs", 'import { test } from "node:test";\nimport assert from "node:assert";\nimport pad from "pad-fake";\ntest("pads", () => assert.equal(pad("a", 3), "  a"));\n');
    writeFileSync(`${vendor}-${id}.txt`, `${vendor} output\n`);
    answer = `Added pad-fake and a test for it as ${vendor}.`;
  } else if (write && process.env.FAKE_NOOP_VENDOR === vendor) {
    answer = `${vendor} looked around but changed nothing.\nIt would need network access to go further.`;
  } else if (write) {
    if (prompt.includes("CONFLICT")) writeFileSync("shared.txt", `written by ${vendor} ${id}\n`);
    else writeFileSync(`${vendor}-${id}.txt`, `${vendor} output\n`);
    answer = `Implemented changes as ${vendor}.`;
  }

  // Schema-constrained output, the way each real CLI returns it (see the adapters).
  const garbleMarker = `${process.env.CODEFLOW_HOME}/.garbled-once`;
  const garbled =
    schemaRequested &&
    process.env.FAKE_GARBLE_VENDOR === vendor &&
    (!process.env.FAKE_GARBLE_ONCE || (!existsSync(garbleMarker) && (writeFileSync(garbleMarker, "1"), true)));
  if (garbled) answer = "Looks fine to me overall.";
  const fenced = answer.match(/```json\n([\s\S]*?)\n```/);
  const structured = schemaRequested && !garbled && fenced ? JSON.parse(fenced[1]) : undefined;
  if (vendor === "codex" && structured) answer = JSON.stringify(structured);
  return { answer, structured };
}

const testFile = (...body) => ['import { test } from "node:test";', 'import assert from "node:assert";', 'import { readdirSync } from "node:fs";', ...body].join("\n") + "\n";
/** Passes once any agent has written its "<vendor>-<id>.txt" implementation file. */
const implementedTest = testFile('test("feature is implemented", () => assert.ok(readdirSync(".").some((f) => /^(claude|codex|agy)-.*\\.txt$/.test(f))));');
const passingTest = testFile('test("feature is implemented", () => assert.ok(readdirSync(".").length > 0));');
const brokenTest = testFile('test("feature is implemented", () => assert.fail("never passes"));');
/** Reviewers' repros: no test; a test that fails on any code (the bug is there); one that passes (a false alarm). */
const noRepro = { path: "", contents: "", command: "" };
const failingRepro = { path: "bound.test.mjs", contents: testFile('test("loop bound", () => assert.equal([1, 2, 3].length, 4, "off by one: the loop runs once too often"));'), command: "" };
const passingRepro = { path: "null.test.mjs", contents: testFile('test("null check", () => assert.ok(true));'), command: "" };

/** FAKE_SLEEP_MS for this vendor (FAKE_SLEEP_VENDOR unset = every vendor), else 0. */
export function sleepMs(vendor) {
  return process.env.FAKE_SLEEP_MS && (!process.env.FAKE_SLEEP_VENDOR || process.env.FAKE_SLEEP_VENDOR === vendor) ? Number(process.env.FAKE_SLEEP_MS) : 0;
}
