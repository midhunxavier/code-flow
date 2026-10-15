#!/usr/bin/env node
// Stand-in for the claude / codex / agy CLIs in tests. Emits each vendor's JSONL event
// format and answers the structured prompts the patterns send, so workflows can be
// exercised end to end without spending subscription quota.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

const [vendor, ...args] = process.argv.slice(2);

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

const prompt = vendor === "codex" ? args[args.length - 1] : args[args.indexOf("-p") + 1];

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
    subtasks: [
      { id: "alpha", title: "Alpha part", instructions: conflict ? "Write shared.txt CONFLICT" : "Build alpha", agent: "claude" },
      { id: "beta", title: "Beta part", instructions: conflict ? "Write shared.txt CONFLICT" : "Build beta", agent: "codex" },
    ],
  });
} else if (prompt.includes("Resolve every conflict")) {
  writeFileSync("shared.txt", "resolved by fake agent\n");
  answer = "Resolved the conflicts.";
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
} else if (prompt.includes('"verdict": "approve" | "changes_requested"')) {
  // State lives outside the worktree: read-only steps have their file changes reverted.
  const marker = `${process.env.CODEFLOW_HOME}/.reviewed-once`;
  const fail = process.env.FAKE_REVIEW_FAIL_ONCE && !existsSync(marker);
  if (fail) writeFileSync(marker, "1");
  answer = json(fail ? { verdict: "changes_requested", issues: [{ problem: "missing edge case" }] } : { verdict: "approve", issues: [] });
} else if (prompt.includes('"winner"')) {
  answer = json({ winner: "B", ranking: ["B", "A"], reasons: "B is simpler" });
} else if (write && process.env.FAKE_NOOP_VENDOR === vendor) {
  answer = `${vendor} looked around but changed nothing.`;
} else if (write) {
  if (prompt.includes("CONFLICT")) writeFileSync("shared.txt", `written by ${vendor} ${id}\n`);
  else writeFileSync(`${vendor}-${id}.txt`, `${vendor} output\n`);
  answer = `Implemented changes as ${vendor}.`;
}

if (process.env.FAKE_SLEEP_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_SLEEP_MS));

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const session = randomUUID();

if (vendor === "claude") {
  out({ type: "system", subtype: "init", session_id: session });
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "x" } }] } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
  out({ type: "assistant", message: { content: [{ type: "text", text: answer }] } });
  out({ type: "result", subtype: "success", is_error: false, result: answer, session_id: session, usage: { input_tokens: 1, output_tokens: 2 } });
} else if (vendor === "codex") {
  out({ type: "thread.started", thread_id: session });
  out({ type: "turn.started" });
  out({ type: "item.started", item: { id: "i1", type: "command_execution", command: "ls", status: "in_progress" } });
  out({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "ls", aggregated_output: "a.txt", exit_code: 0 } });
  out({ type: "item.completed", item: { id: "i2", type: "agent_message", text: answer } });
  out({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } });
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
  out({ event: "result", result: { conversation_id: session, status: "SUCCESS", response: answer, usage: { input_tokens: 1 } } });
}
