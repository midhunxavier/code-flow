// What a fake agent does with a prompt, whichever way it was asked (one-shot CLI or Codex's
// app-server): its side effects in the working directory, then its answer. Answers the structured
// prompts the patterns send, so workflows can be exercised end to end.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  // A read-only step that breaks its worktree: git run there afterwards finds your checkout.
  if (prompt.includes("DELETES-GIT-IN-READ") && !write) {
    writeFileSync("written-in-read.txt", "x\n");
    rmSync(".git");
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

  if (prompt.includes("## Task to improve")) {
    // The composer's Improve: the task restated with a done line. IMPROVE-EMPTY answers with nothing usable.
    const original = prompt.slice(prompt.indexOf("## Task to improve") + "## Task to improve".length).trim();
    const repo = prompt.includes("look around the repository");
    answer = prompt.includes("IMPROVE-EMPTY")
      ? "I'd rather not."
      : json({ prompt: `Goal: ${original}\n\nDone when: the tests pass.`, summary: `Stated the goal and when it's done (${repo ? "repo" : "quick"}, ${vendor}).` });
  } else if (prompt.includes("AUTO_TEAM_PLAN")) {
    const inventoryText = prompt.match(/## Inventory and constraints\n```json\n([\s\S]*?)\n```/);
    const policy = inventoryText ? JSON.parse(inventoryText[1]) : { coordinator: vendor, pool: ["claude", "codex"], inventory: { providers: [] } };
    const eligible = policy.inventory.providers.filter((p) => p.available && !p.blockedReason && (policy.pool.includes(p.id) || p.id === policy.coordinator));
    const builder = eligible.find((p) => p.id === "claude")?.id ?? eligible[0]?.id ?? vendor;
    const reviewer = eligible.find((p) => p.id !== builder)?.id ?? builder;
    const makeMember = (id, role, provider) => { const p = eligible.find((p) => p.id === provider); let settings = p?.settingsByRole?.[role] ?? p; if (prompt.includes("AUTO-MODEL-POOL") && id === "builder-two") settings = settings?.variants?.[0] ?? settings; return { id, name: id, role, provider, model: settings?.model ?? "", effort: settings?.effort ?? "", reason: role === "worker" ? "Own a separate component" : role === "reviewer" ? "Independently verify the result" : "Investigate and coordinate" }; };
    const investigation = prompt.includes("AUTO-INVESTIGATION");
    const same = prompt.includes("AUTO-SAME-PROVIDER") || prompt.includes("AUTO-EVENT");
    const tasks = [{ id: "alpha", title: "Alpha implementation", instructions: "Implement alpha " + (prompt.includes("AUTO-USER-QUESTION") ? "AUTO-USER-QUESTION" : prompt.includes("AUTO-QUESTION") ? "AUTO-QUESTION" : ""), owner: "builder", kind: investigation ? "investigation" : "implementation", dependsOn: [], requirements: ["goal"], acceptance: ["The requested behavior has evidence"], paths: ["*"] }];
    if (same || prompt.includes("AUTO-DEPENDENCIES") || prompt.includes("AUTO-CONTRACT-CHANGE")) tasks.push({ id: "beta", title: "Beta dependent implementation", instructions: "Read alpha's artifact before implementing beta", owner: same ? "builder-two" : "builder", kind: "implementation", dependsOn: ["alpha"], requirements: ["goal"], acceptance: ["Dependent result uses alpha"], paths: ["*"] });
    if (prompt.includes("AUTO-EVENT")) {
      tasks[0].paths = [`${builder}-alpha.txt`];
      tasks[1].owner = "builder"; tasks[1].paths = [`${builder}-beta.txt`];
      tasks.push({ ...tasks[0], id: "slow", title: "Independent slow task", owner: "builder-two", paths: [`${builder}-slow.txt`], instructions: "AUTO-SLOW-TURN" });
    }
    answer = json({ requirements: [{ id: "goal", description: "Implement the requested sample" }], members: [makeMember("coordinator", "coordinator", vendor), makeMember("builder", "worker", builder), ...(same ? [makeMember("builder-two", "worker", builder)] : []), makeMember("verifier", "reviewer", reviewer)], tasks: prompt.includes("AUTO-SUBPLAN") ? [] : tasks.map((task) => ({ ...task, dependencyTypes: [] })), ...(prompt.includes("AUTO-SUBPLAN") ? { subplans: [{ id: "sample", strategy: "investigate-implement", owner: "builder", requirements: ["goal"], acceptance: ["The requested behavior has evidence"], paths: ["*"], dependsOn: [], instructions: "Implement the requested sample" }] } : { subplans: [] }), contracts: ["Each task preserves the accepted dependency artifacts"], rationale: "A small team with independent review" });
  } else if (prompt.includes("AUTO_TEAM_TASK")) {
    const { task, member, attempt } = JSON.parse(prompt.match(/## Assignment JSON\n```json\n([\s\S]*?)\n```/)[1]);
    if (task.instructions.includes("AUTO-SLOW-TURN")) {
      if (process.env.FAKE_AUTO_SLOW_RELEASE) {
        const deadline = Date.now() + 60000;
        while (!existsSync(process.env.FAKE_AUTO_SLOW_RELEASE) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      } else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);
    }
    const needsInfo = attempt === 1 && task.id === "alpha" && /AUTO-(USER-)?QUESTION/.test(task.instructions);
    const failed = prompt.includes("AUTO-FAILURE") || prompt.includes("AUTO-CONTRACT-CHANGE") && task.id === "beta" && attempt === 1 || prompt.includes("AUTO-HANDOVER") && member.id === "builder";
    if (write && !needsInfo && !failed && !prompt.includes("AUTO-NO-CHANGE")) writeFileSync(`${vendor}-${task.id}.txt`, `${task.id} implementation\n`);
    if (write && needsInfo) writeFileSync(`${vendor}-${task.id}-partial.txt`, "partial checkpoint\n");
    answer = json({ taskId: task.id, memberId: member.id, status: failed ? "failed" : needsInfo ? "needs_info" : "submitted", checkpoint: failed ? "The requested work is blocked" : needsInfo ? "Partial work saved; need the input contract" : `Completed ${task.id} with evidence`, handover: `Shared output and next actions for ${task.id}`, artifacts: needsInfo ? [] : [`${vendor}-${task.id}.txt`], unresolvedRequirements: needsInfo || failed ? ["goal"] : [], questions: needsInfo ? [{ id: "input-contract", recipient: task.instructions.includes("AUTO-USER-QUESTION") ? "user" : "coordinator", body: "Should empty input be accepted?", blocking: true }] : [], replies: [], findings: needsInfo || failed ? [] : [{ title: `${task.id} convention`, body: "Preserve empty input behavior in this component", evidence: [`${vendor}-${task.id}.txt`], paths: [] }] });
  } else if (prompt.includes("AUTO_TEAM_ANSWERS")) {
    const questions = JSON.parse(prompt.match(/## Open questions JSON\n```json\n([\s\S]*?)\n```/)[1]);
    answer = json({ replies: questions.map((q) => ({ requestId: q.id, body: "Empty input is valid", evidence: ["README.md input contract"] })), unresolved: [] });
  } else if (prompt.includes("AUTO_TEAM_REVISION")) {
    const state = JSON.parse(prompt.match(/## Current accepted plan and outcomes\n```json\n([\s\S]*?)\n```/)[1]);
    const handover = prompt.includes("AUTO-HANDOVER") && state.members.some((m) => m.id === "builder" && m.status !== "retired");
    answer = json({ reason: "Retry failed work within the existing scope", contractRequirements: prompt.includes("AUTO-CONTRACT-CHANGE") ? ["goal"] : [], addTasks: [], reassignments: handover ? [{ taskId: "alpha", memberId: "replacement" }] : [], retryTasks: state.tasks.filter((t) => t.status === "failed" && t.attempts <= state.maxRepairs).map((t) => t.id), contracts: prompt.includes("AUTO-CONTRACT-CHANGE") ? ["Preserve empty input behavior across both components"] : [], answers: [], addMembers: handover ? [{ ...state.members.find((m) => m.id === "builder"), id: "replacement", name: "Replacement", reason: "Take over the blocked assignment" }] : [], retireMembers: handover ? ["builder"] : [] });
  } else if (prompt.includes('"subtasks"')) {
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
    // "council-false-alarms": the reviewers raise only the false alarm, as the chair reports. A
    // confirmed bug the chair leaves out comes back in (see restoreConfirmed in council.ts).
    const offByOne = { severity: "high", file: "feature.txt", problem: "Off-by-one in the loop", fix: "Use <" };
    const nullCheck = { severity: "high", file: "feature.txt", problem: "Missing null check", fix: "Check for null", repro: passingRepro };
    answer = json({
      verdict: "changes_requested",
      issues:
        process.env.FAKE_REPRO === "council-false-alarms"
          ? [nullCheck]
          : process.env.FAKE_REPRO
            ? [{ ...offByOne, repro: failingRepro }, nullCheck]
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
