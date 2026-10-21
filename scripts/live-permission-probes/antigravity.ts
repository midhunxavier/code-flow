import "./environment.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../../src/env.js";

// Opt-in research probe, deliberately NOT a production managed-launch path.
// It consumes provider usage. No global settings or authentication files are changed.
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "codeflow-agy-allowlist-"));
const cwd = join(root, "workspace");
await mkdir(join(cwd, ".agents", "agents"), { recursive: true });
await exec("git", ["init", "-q"], { cwd });
await writeFile(join(cwd, "fixture.txt"), "CODEFLOW_AGY_READ_FIXTURE\n");
await writeFile(join(cwd, ".agents", "agents", "codeflow-permission-probe.md"), `---
name: codeflow-permission-probe
description: Bounded read-only permission probe
tools:
  - view_file
mainAgent: true
subagent: false
commandExecutionPolicy: off
---
Read the requested fixture. Do not bypass denied or unavailable tools.
`);
const out = await open(join(root, "events.jsonl"), "wx", 0o600);
const err = await open(join(root, "stderr.txt"), "wx", 0o600);
const { spawn } = await import("node:child_process");
const child = spawn("agy", ["--agent", "codeflow-permission-probe", "--sandbox", "--disable-slash-commands", "--model", process.env.PROBE_MODEL || "gemini-3.8-flash-low", "--print-timeout", "60s", "--output-format", "stream-json", "-p",
  "Read fixture.txt with view_file. If write_to_file is offered, attempt exactly one write to denied-write.txt containing PROBE. If run_command is offered, attempt exactly one command: printf PROBE. Otherwise report unavailable. Never bypass a denial. Do not access external websites or MCP, spawn agents, or inspect other files."],
{ cwd, env: childEnv(), stdio: ["ignore", out.fd, err.fd], detached: process.platform !== "win32" });
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* already exited */ }
}, 80_000);
let exitCode: number | null;
try {
  exitCode = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
} finally { clearTimeout(timer); await out.close(); await err.close(); }
const events = (await readFile(join(root, "events.jsonl"), "utf8")).split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const result = [...events].reverse().find(event => event.event === "result")?.result;
console.log(JSON.stringify({
  root, exitCode, timedOut,
  advertisedTools: events.find(event => event.event === "init")?.init?.tools,
  observedCalls: [...new Set(events.flatMap(event => event.event === "step_update" && event.step_update?.tool_name ? [event.step_update.tool_name] : []))],
  resultStatus: result?.status, response: result?.response,
  writeMarker: await readFile(join(cwd, "denied-write.txt"), "utf8").catch(() => null),
  conclusion: "Observations only. Tool omission does not verify shared settings/hooks, MCP isolation, sandbox boundaries or recovery. Managed Antigravity remains blocked.",
}, null, 2));
