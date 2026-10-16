#!/usr/bin/env node
// Stand-in for the claude / codex / agy CLIs in tests. Emits each vendor's JSONL event
// format (and serves Codex's app-server protocol) with the answers from fake-work.mjs, so
// workflows can be exercised end to end without spending subscription quota.
import { writeFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { sleepMs, work } from "./fake-work.mjs";

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

// Codex's JSON-RPC server: a turn that stays open to your messages while it runs.
if (vendor === "codex" && args[0] === "app-server") {
  await (await import("./fake-codex-app-server.mjs")).serve(args); // exits when stdin closes
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
const schemaRequested = args.includes("--json-schema") || args.includes("--output-schema");
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
const { answer, structured } = work({ vendor, prompt, write, schemaRequested, fail });

const pause = sleepMs(vendor);
if (pause) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause);

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
