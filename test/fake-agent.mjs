#!/usr/bin/env node
// Stand-in for the claude / codex / agy CLIs in tests. Emits each vendor's JSONL event
// format and answers the structured prompts the patterns send, so workflows can be
// exercised end to end without spending subscription quota.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

const [vendor, ...args] = process.argv.slice(2);

// Version and sign-in status, in each CLI's real output format.
if (args[0] === "--version") {
  process.stdout.write({ claude: "2.1.300 (Claude Code)\n", codex: "codex-cli 0.162.1\n", agy: "1.3.6\n" }[vendor]);
  process.exit(0);
}
if (vendor === "claude" && args[0] === "auth" && args[1] === "status") {
  process.stdout.write(JSON.stringify({ loggedIn: process.env.FAKE_SIGNED_OUT !== "claude", authMethod: "claude.ai" }));
  process.exit(0);
}
if (vendor === "codex" && args[0] === "login" && args[1] === "status") {
  if (process.env.FAKE_SIGNED_OUT === "codex") {
    process.stderr.write("Not logged in\n");
    process.exit(1);
  }
  process.stdout.write("Logged in using ChatGPT\n");
  process.exit(0);
}

// Model listings, in each CLI's real output format.
if (vendor === "codex" && args[0] === "debug" && args[1] === "models") {
  const levels = (...efforts) => efforts.map((effort) => ({ effort, description: effort }));
  process.stdout.write(JSON.stringify({
    models: [
      { slug: "gpt-b", display_name: "GPT-B", visibility: "list", priority: 2, default_reasoning_level: "medium", supported_reasoning_levels: levels("low", "medium") },
      { slug: "gpt-a", display_name: "GPT-A", visibility: "list", priority: 1, default_reasoning_level: "low", supported_reasoning_levels: levels("low", "medium", "high", "ultra") },
      { slug: "hidden", display_name: "Hidden", visibility: "hide", priority: 0, supported_reasoning_levels: [] },
    ],
  }));
  process.exit(0);
}
if (vendor === "agy" && args[0] === "models") {
  process.stdout.write("Fetching available models...\nmodel-one\tModel One (High)\nmodel-two\tModel Two\n");
  process.exit(0);
}

// Prompts arrive on stdin, as the real CLIs receive them from code-flow.
const stdin = readFileSync(0, "utf8");
const prompt = vendor === "agy" ? JSON.parse(stdin.split("\n")[0]).message.content : stdin;

// Let tests inspect exactly what code-flow passed to the CLI.
if (process.env.FAKE_RECORD_DIR) {
  writeFileSync(`${process.env.FAKE_RECORD_DIR}/${vendor}-${Date.now()}-${randomUUID().slice(0, 6)}.json`,
    JSON.stringify({ vendor, args, prompt, cwd: process.cwd() }));
}
const write =
  (vendor === "claude" && args.includes("acceptEdits")) ||
  (vendor === "codex" && args.includes('sandbox_mode="workspace-write"')) ||
  // agy has no read-only flag; code-flow enforces read-only by reverting changes.
  (vendor === "agy" && args.includes("--dangerously-skip-permissions"));

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
  process.stderr.write("API Error: 529 {\"type\":\"overloaded_error\"}\n");
  process.exit(1);
}
if (process.env.FAKE_USAGE_LIMIT_VENDOR === vendor && write) {
  process.stderr.write("You've hit your usage limit. Upgrade or try again in 4 hours.\n");
  process.exit(1);
}
const id = createHash("sha1").update(prompt + vendor + Date.now()).digest("hex").slice(0, 8);

if (process.env.FAKE_FAIL_VENDOR === vendor && write) {
  process.stderr.write("boom\n");
  process.exit(1);
}

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
  writeFileSync("spec.test.mjs", [
    'import { test } from "node:test";',
    'import assert from "node:assert";',
    'import { readdirSync } from "node:fs";',
    'test("feature is implemented", () => assert.ok(readdirSync(".").some((f) => /^(claude|codex|agy)-.*\\.txt$/.test(f))));',
  ].join("\n") + "\n");
  answer = json({ test_command: "node --test spec.test.mjs", test_files: ["spec.test.mjs"] });
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
  const fail = process.env.FAKE_REVIEW_FAIL_ONCE && !existsSync(marker);
  if (fail) writeFileSync(marker, "1");
  answer = json(fail ? { verdict: "changes_requested", issues: [{ severity: "medium", file: "src/x.ts", problem: "missing edge case", fix: "handle it" }] } : { verdict: "approve", issues: [] });
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
  answer = `${vendor} looked around but changed nothing.`;
} else if (write) {
  if (prompt.includes("CONFLICT")) writeFileSync("shared.txt", `written by ${vendor} ${id}\n`);
  else writeFileSync(`${vendor}-${id}.txt`, `${vendor} output\n`);
  answer = `Implemented changes as ${vendor}.`;
}

// Schema-constrained output, the way each real CLI returns it (see the adapters).
const schemaRequested = args.includes("--json-schema") || args.includes("--output-schema");
const garbleMarker = `${process.env.CODEFLOW_HOME}/.garbled-once`;
const garbled =
  schemaRequested &&
  process.env.FAKE_GARBLE_VENDOR === vendor &&
  (!process.env.FAKE_GARBLE_ONCE || (!existsSync(garbleMarker) && (writeFileSync(garbleMarker, "1"), true)));
if (garbled) answer = "Looks fine to me overall.";
const fenced = answer.match(/```json\n([\s\S]*?)\n```/);
const structured = schemaRequested && !garbled && fenced ? JSON.parse(fenced[1]) : undefined;
if (vendor === "codex" && structured) answer = JSON.stringify(structured);

if (process.env.FAKE_SLEEP_MS && (!process.env.FAKE_SLEEP_VENDOR || process.env.FAKE_SLEEP_VENDOR === vendor)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_SLEEP_MS));

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const session = randomUUID();

if (vendor === "claude") {
  out({ type: "system", subtype: "init", session_id: session });
  out({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 1792092600 }, seven_day: { utilization: 0.1, resetsAt: 1792350000 } } } });
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "x" } }] } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
  out({ type: "assistant", message: { content: [{ type: "text", text: answer }] } });
  out({ type: "result", subtype: "success", is_error: false, result: answer, structured_output: structured, session_id: session, total_cost_usd: 0.25, usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 500, output_tokens: 40 } });
} else if (vendor === "codex") {
  out({ type: "thread.started", thread_id: session });
  out({ type: "turn.started" });
  out({ type: "item.started", item: { id: "i1", type: "command_execution", command: "ls", status: "in_progress" } });
  out({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "ls", aggregated_output: "a.txt", exit_code: 0 } });
  // Codex reports a reconnect as an `error` event and then carries on: not a failure.
  if (process.env.FAKE_CODEX_WARN) out({ type: "error", message: "Reconnecting... 1/5" });
  out({ type: "item.completed", item: { id: "i2", type: "agent_message", text: answer } });
  out({ type: "turn.completed", usage: { input_tokens: 300, cached_input_tokens: 200, output_tokens: 2 } });
} else if (vendor === "agy" && process.env.FAKE_AGY_DENY) {
  // Real agy 1.3.5 behaviour when a tool needs a permission headless mode cannot grant.
  out({ event: "init", conversation_id: session, init: { cwd: process.cwd() } });
  const tool = { name: "run_command", parameters: { CommandLine: "ls" } };
  out({ event: "step_update", step_update: { conversation_id: session, step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: tool } });
  out({ event: "step_update", step_update: { conversation_id: session, step_index: 2, state: "ERROR", step_type: "tool", tool_name: "run_command", tool_info: { ...tool, error: { type: "TOOL_ERROR", message: "permission check failed" } } } });
  out({ event: "result", result: { conversation_id: session, status: "SUCCESS", response: "", denied_actions: [{ action: "command", display_name: "RunCommand" }] } });
} else if (vendor === "agy") {
  out({ event: "init", conversation_id: session, init: { cwd: process.cwd() } });
  for (const chunk of answer.match(/[\s\S]{1,10}/g)) {
    out({ event: "step_update", step_update: { step_type: "agent_response", state: "ACTIVE", text_delta: chunk } });
  }
  out({ event: "result", result: { conversation_id: session, status: "SUCCESS", response: answer, structured_output: structured, usage: { input_tokens: 1 } } });
}
