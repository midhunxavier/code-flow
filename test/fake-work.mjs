// What a fake agent does with a prompt, whichever way it was asked (one-shot CLI or Codex's
// app-server): its side effects in the working directory, then its answer. Answers the structured
// prompts the patterns send, so workflows can be exercised end to end.
import { writeFileSync, existsSync } from "node:fs";
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
    // Review council chair: merge the reviewers' findings.
    answer = json({
      verdict: "changes_requested",
      summary: "Two reviewers found the same off-by-one.",
      findings: [
        { severity: "low", file: "README.md", problem: "Typo", fix: "Fix the typo", raised_by: ["B"] },
        { severity: "high", file: "feature.txt", problem: "Off-by-one in the loop", fix: "Use < instead of <=", raised_by: ["A", "B"] },
      ],
    });
  } else if (prompt.includes("Other reviewers are reviewing the same changes")) {
    answer = json({ verdict: "changes_requested", issues: [{ severity: "high", file: "feature.txt", problem: "Off-by-one in the loop", fix: "Use <" }] });
  } else if (prompt.includes('"verdict": "approve" | "changes_requested"')) {
    // State lives outside the worktree: read-only steps have their file changes reverted.
    const marker = `${process.env.CODEFLOW_HOME}/.reviewed-once`;
    const failReview = process.env.FAKE_REVIEW_FAIL_ONCE && !existsSync(marker);
    if (failReview) writeFileSync(marker, "1");
    answer = json(failReview ? { verdict: "changes_requested", issues: [{ severity: "medium", file: "src/x.ts", problem: "missing edge case", fix: "handle it" }] } : { verdict: "approve", issues: [] });
  } else if (prompt.includes('"winner"')) {
    answer = json({ winner: "B", ranking: ["B", "A"], reasons: "B is simpler" });
  } else if (write && process.env.FAKE_TAMPER && existsSync("failing.test.mjs")) {
    // Gaming the check: delete the test that fails instead of fixing the code.
    execFileSync("git", ["rm", "-q", "failing.test.mjs"]);
    answer = "Removed a broken test.";
  } else if (write && process.env.FAKE_EDIT_TESTS && prompt.includes("Make the tests pass") && existsSync("spec.test.mjs")) {
    writeFileSync("spec.test.mjs", 'import { test } from "node:test";\ntest("always passes", () => {});\n');
    writeFileSync(`${vendor}-${id}.txt`, `${vendor} output\n`);
    answer = "Simplified the test and implemented it.";
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

/** FAKE_SLEEP_MS for this vendor (FAKE_SLEEP_VENDOR unset = every vendor), else 0. */
export function sleepMs(vendor) {
  return process.env.FAKE_SLEEP_MS && (!process.env.FAKE_SLEEP_VENDOR || process.env.FAKE_SLEEP_VENDOR === vendor) ? Number(process.env.FAKE_SLEEP_MS) : 0;
}
