#!/usr/bin/env node
// Stand-in for the claude / codex / agy CLIs in tests. Emits each vendor's JSONL event
// format (and serves Codex's app-server protocol) with the answers from fake-work.mjs, so
// workflows can be exercised end to end without spending subscription quota.
import { writeFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { sleepMs, work } from "./fake-work.mjs";
import { exerciseTeamTools } from "./fake-team-tools.mjs";

const [vendor, ...args] = process.argv.slice(2);

// Version and sign-in status, in each CLI's real output format.
if (args[0] === "--version") {
  process.stdout.write({ claude: "2.1.300 (Claude Code)\n", codex: "codex-cli 0.162.1\n", agy: "1.3.6\n" }[vendor]);
  process.exit(0);
}

if (vendor === "claude" && args.includes("--input-format") && args.includes("--tools") && args[args.indexOf("--tools") + 1] === "") {
  const {createInterface} = await import("node:readline");
  for await (const line of createInterface({input:process.stdin})) {
    const msg=JSON.parse(line); if(msg.type!=="control_request")continue;
    const models=process.env.FAKE_DISCOVERY_MODELS ? JSON.parse(process.env.FAKE_DISCOVERY_MODELS) : ["sonnet","opus","haiku","fable"].map(value=>({value,resolvedModel:value,displayName:value,supportsEffort:true,supportedEffortLevels:["low","medium","high","xhigh","max"]}));
    process.stdout.write(JSON.stringify({type:"control_response",response:{subtype:"success",request_id:msg.request_id,response:{models:[{...models[0],value:"default"},...models],account:{id:"fixture"}}}})+"\n");
  }
  process.exit(0);
}

// --help lists the flags and subcommands code-flow passes. FAKE_UNKNOWN_FLAG is one this CLI
// doesn't have (an older or newer version): it's left out of --help and rejected when passed.
const unknownFlag = process.env.FAKE_UNKNOWN_FLAG;
if (args.includes("--help")) {
  const sub = args.filter((a) => a !== "--help").join(" ");
  const help = helpText(vendor, sub);
  const drop = (line) =>
    (unknownFlag && new RegExp(`(^|[\\s,])${unknownFlag}(?=$|[\\s,<])`).test(line)) ||
    (process.env.FAKE_NO_APP_SERVER && vendor === "codex" && /^\s+app-server\b/.test(line));
  process.stdout.write(help.split("\n").filter((line) => !drop(line)).join("\n"));
  process.exit(0);
}
if (unknownFlag && args.includes(unknownFlag)) {
  // commander's wording (claude, agy) and clap's (codex)
  process.stderr.write(vendor === "codex" ? `error: unexpected argument '${unknownFlag}' found\n\nUsage: codex exec [OPTIONS] [PROMPT]\n` : `error: unknown option '${unknownFlag}'\n`);
  process.exit(vendor === "codex" ? 2 : 1);
}
if (vendor === "codex" && args[0] === "mcp" && args[1] === "get") {
  process.stdout.write(JSON.stringify({ name: args[2], transport: { type: "stdio", command: "node", args: [] }, enabled_tools: ["read_inbox"] }));
  process.exit(0);
}
if (vendor === "codex" && args[0] === "features" && args[1] === "list") {
  process.stdout.write(process.env.FAKE_IGNORE_DELEGATION_FLAGS ? "multi_agent stable true\nmulti_agent_v2 stable true\n" : "multi_agent stable false\nmulti_agent_v2 stable false\n");
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
  if (process.env.FAKE_SIGNED_OUT === "codex-exit0") {
    process.stdout.write("Not logged in\n");
    process.exit(0);
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
  // FAKE_AGY_MODELS_FAIL: "network" (Google unreachable) or "signed-out".
  if (process.env.FAKE_AGY_MODELS_FAIL === "network") {
    process.stderr.write("Error: request to https://cloudcode-pa.googleapis.com failed: getaddrinfo ENOTFOUND cloudcode-pa.googleapis.com\n");
    process.exit(1);
  }
  if (process.env.FAKE_AGY_MODELS_FAIL === "signed-out") {
    process.stderr.write("Error: not signed in. Run agy to sign in with your Google account.\n");
    process.exit(1);
  }
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

/** FAKE_<name>_VENDOR names this vendor (one, or a comma-separated list). */
const when = (name) => (process.env[`FAKE_${name}_VENDOR`] ?? "").split(",").includes(vendor);
const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A CLI stuck before printing anything (a login prompt, a stalled network).
if (when("SILENT")) {
  await sleepFor(60_000);
  process.exit(0);
}

// Resuming a conversation that's gone, in each CLI's real wording.
const flagValue = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const resumeId = vendor === "claude" ? flagValue("--resume") : vendor === "agy" ? flagValue("--conversation") : args[1] === "resume" ? args.at(-2) : undefined;
if (resumeId && when("INVALID_SESSION")) {
  if (vendor === "agy") {
    process.stdout.write(JSON.stringify({ event: "result", result: { status: "NOT_FOUND", error: `conversation ${resumeId} not found` } }) + "\n");
  } else {
    process.stderr.write(vendor === "claude" ? `No conversation found with session ID: ${resumeId}\n` : `Error: thread/resume: no rollout found for thread id ${resumeId}\n`);
  }
  process.exit(1);
}

// Let tests inspect exactly what code-flow passed to the CLI.
const teamTools = await exerciseTeamTools(args);
if (process.env.FAKE_RECORD_DIR) {
  writeFileSync(`${process.env.FAKE_RECORD_DIR}/${vendor}-${Date.now()}-${randomUUID().slice(0, 6)}.json`,
    JSON.stringify({ vendor, args, prompt, cwd: process.cwd(), token: process.env.CODEFLOW_TOKEN ?? null, teamTools }));
}
const write =
  (vendor === "claude" && (args.includes("acceptEdits") || args.includes("bypassPermissions"))) ||
  (vendor === "codex" && (args.includes('sandbox_mode="workspace-write"') || args.includes('sandbox_mode="danger-full-access"'))) ||
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

// One line far over code-flow's limit (a runaway tool output, FAKE_HUGE_LINE_MB), before the stream.
if (when("HUGE_LINE")) out({ type: "noise", data: "x".repeat(Number(process.env.FAKE_HUGE_LINE_MB ?? 17) * 1024 * 1024) });
// What hooks and MCP servers print to the CLI's stderr: never the CLI's own error.
if (process.env.FAKE_STDERR_NOISE) process.stderr.write(`${process.env.FAKE_STDERR_NOISE}\n`);
// FAKE_DRIFT_VENDOR: a CLI update with events this code-flow doesn't know (Codex: its answer among them).
const drift = when("DRIFT");

if (when("CRASH")) {
  // Some output, then the CLI dies without a result.
  if (vendor === "claude") {
    out({ type: "system", subtype: "init", session_id: session });
    out({ type: "assistant", message: { content: [{ type: "text", text: "Starting on it." }] } });
  } else if (vendor === "codex") {
    out({ type: "thread.started", thread_id: session });
    out({ type: "item.started", item: { id: "i1", type: "command_execution", command: "ls", status: "in_progress" } });
  } else {
    out({ event: "init", conversation_id: session, init: { cwd: process.cwd() } });
    out({ event: "step_update", step_update: { step_type: "agent_response", state: "ACTIVE", text_delta: "Starting on it." } });
  }
  process.stderr.write("fatal: fake crash mid-stream\n");
  process.exitCode = 1;
} else if (vendor === "claude" && process.env.FAKE_CLAUDE_FAIL) {
  // How Claude Code ends a turn that failed: "rejected" (plan usage used up), "auth", or
  // "agent-says-500" (a failed result with no text, after the agent quoted an error from its work).
  const mode = process.env.FAKE_CLAUDE_FAIL;
  out({ type: "system", subtype: "init", session_id: session });
  if (mode === "rejected") {
    const resetsAt = Number(process.env.FAKE_CLAUDE_RESETS_AT ?? 1792092600);
    out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt, rateLimitType: "five_hour", utilization: 1, isUsingOverage: false } });
    const text = "You've hit your limit · resets 5pm (Europe/Stockholm)";
    out({ type: "assistant", message: { content: [{ type: "text", text }] } });
    out({ type: "result", subtype: "success", is_error: true, result: text, session_id: session });
  } else if (mode === "auth") {
    const text = "Invalid API key · Please run /login";
    out({ type: "assistant", message: { content: [{ type: "text", text }] } });
    out({ type: "result", subtype: "success", is_error: true, result: text, session_id: session });
  } else {
    out({ type: "assistant", message: { content: [{ type: "text", text: "The API returned 500 and the request timed out, so I stopped." }] } });
    out({ type: "result", subtype: "error_during_execution", is_error: true, session_id: session });
  }
  process.exitCode = 1;
} else if (vendor === "claude") {
  out({ type: "system", subtype: "init", session_id: session });
  out({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 1792092600 }, seven_day: { utilization: 0.1, resetsAt: 1792350000 } } } });
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "x" } }] } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
  if (drift) {
    out({ type: "future_event", data: 1 });
    out({ type: "future_event", data: 2 });
    out({ type: "stream_event", event: {} }); // known, and ignored on purpose
  }
  out({ type: "assistant", message: { content: [...(drift ? [{ type: "citation" }] : []), { type: "text", text: answer }] } });
  out({ type: "result", subtype: "success", is_error: false, result: answer, structured_output: structured, session_id: session, total_cost_usd: 0.25, usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 500, output_tokens: 40 } });
} else if (vendor === "codex") {
  out({ type: "thread.started", thread_id: session });
  out({ type: "turn.started" });
  out({ type: "item.started", item: { id: "i1", type: "command_execution", command: "ls", status: "in_progress" } });
  out({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "ls", aggregated_output: "a.txt", exit_code: 0 } });
  // Codex reports a reconnect as an `error` event and then carries on: not a failure.
  if (process.env.FAKE_CODEX_WARN) out({ type: "error", message: "Reconnecting... 1/5" });
  out({ type: "item.completed", item: { id: "i2", type: drift ? "agent_reply" : "agent_message", text: answer } });
  out({ type: "turn.completed", usage: { input_tokens: 300, cached_input_tokens: 200, output_tokens: 2 } });
} else if (vendor === "agy" && process.env.FAKE_AGY_DENY) {
  // Real agy 1.3.5 behaviour when a tool needs a permission headless mode cannot grant.
  out({ event: "init", conversation_id: session, init: { cwd: process.cwd() } });
  const tool = { name: "run_command", parameters: { CommandLine: "ls" } };
  out({ event: "step_update", step_update: { conversation_id: session, step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: tool } });
  out({ event: "step_update", step_update: { conversation_id: session, step_index: 2, state: "ERROR", step_type: "tool", tool_name: "run_command", tool_info: { ...tool, error: { type: "TOOL_ERROR", message: "permission check failed" } } } });
  out({ event: "result", result: { conversation_id: session, status: "SUCCESS", response: "", denied_actions: [{ action: "command", display_name: "RunCommand" }] } });
} else if (vendor === "agy" && process.env.FAKE_AGY_STATUS) {
  // A failed turn as agy reports it: a gRPC-style status, and Google's message (FAKE_AGY_ERROR).
  out({ event: "init", conversation_id: session, init: { cwd: process.cwd() } });
  out({ event: "result", result: { conversation_id: session, status: process.env.FAKE_AGY_STATUS, error: { message: process.env.FAKE_AGY_ERROR ?? "" } } });
  process.exitCode = 1;
} else if (vendor === "agy") {
  out({ event: "init", conversation_id: session, init: { cwd: process.cwd() } });
  if (drift) out({ event: "future_event" });
  for (const chunk of answer.match(/[\s\S]{1,10}/g)) {
    out({ event: "step_update", step_update: { step_type: "agent_response", state: "ACTIVE", text_delta: chunk } });
  }
  out({ event: "result", result: { conversation_id: session, status: "SUCCESS", response: answer, structured_output: structured, usage: { input_tokens: 1 } } });
}

// The result is out, but the CLI doesn't exit (a hook or MCP server that hangs on shutdown),
// and it ignores SIGTERM.
if (when("HANG_AFTER_RESULT")) {
  process.on("SIGTERM", () => {});
  setTimeout(() => {}, 60_000);
}

function helpText(vendor, sub) {
  if (vendor === "claude") {
    return `Usage: claude [options] [command] [prompt]

Options:
  -p, --print                                       Print response and exit (useful for pipes)
  --output-format <format>                          Output format (only works with --print)
  --verbose                                         Override verbose mode setting from config
  -r, --resume [value]                              Resume a conversation by session ID
  --model <model>                                   Model for the current session
  --effort <level>                                  Effort level for the current session
  --json-schema <schema>                            JSON Schema for structured output validation
  --permission-mode <mode>                          Permission mode to use for the session
  --allowedTools, --allowed-tools <tools...>        Tools to allow
  --settings <file-or-json>                        Per-turn settings
  --disallowedTools, --disallowed-tools <tools...>  Tools to deny
  --mcp-config <configs...>                        Per-turn MCP configuration
  --no-chrome                                     Disable browser integration
  --strict-mcp-config                             Use only the supplied MCP configuration
  -v, --version                                     Output the version number
  -h, --help                                        Display help for command
`;
  }
  if (vendor === "codex" && sub === "exec") {
    return `Run Codex non-interactively

Usage: codex exec [OPTIONS] [PROMPT]
       codex exec [OPTIONS] <COMMAND> [ARGS]

Commands:
  resume  Resume a previous session by id or pick the most recent with --last
  help    Print this message or the help of the given subcommand(s)

Options:
  -c, --config <key=value>    Override a configuration value
  -m, --model <MODEL>         Model the agent should use
  -C, --cd <DIR>              Tell the agent to use the specified directory as its working root
      --skip-git-repo-check   Allow running Codex outside a Git repository
      --output-schema <FILE>  Path to a JSON Schema file describing the model's final response shape
      --json                  Print events to stdout as JSONL
  -h, --help                  Print help
`;
  }
  if (vendor === "codex") {
    return `Codex CLI

Usage: codex [OPTIONS] [PROMPT]
       codex [OPTIONS] <COMMAND> [ARGS]

Commands:
  exec        Run Codex non-interactively [aliases: e]
  login       Manage login
  app-server  [experimental] Run the app server or related tooling
  debug       Internal debugging commands
  help        Print this message or the help of the given subcommand(s)

Options:
  -c, --config <key=value>  Override a configuration value
  -h, --help                Print help
  -V, --version             Print version
`;
  }
  return `Usage: agy [options] [prompt]

Options:
  -p, --print                     Print the response and exit
  --input-format <format>         Input format: text or stream-json
  --output-format <format>        Output format: text, json or stream-json
  --print-timeout <duration>      How long a print-mode run may take
  --sandbox                       Confine writes to the working directory
  --conversation <id>             Continue a conversation
  --model <model>                 Model to use
  --effort <level>                Reasoning effort
  --json-schema <schema>          JSON Schema for the final answer
  --dangerously-skip-permissions  Allow every tool without asking
  -h, --help                      Show help
`;
}
