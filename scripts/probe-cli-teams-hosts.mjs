// Native MCP/skill compatibility probe. No model turns, prompts, or paid inference.
// Run from source: node --import tsx scripts/probe-cli-teams-hosts.mjs
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// These scripts exercise the advanced tools; the default surface lists six simpler ones.
process.env.CODEFLOW_TOOLS ??= "all";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "codeflow-native-mcp-"));
process.env.CODEFLOW_HOME = join(temporary, "state");
const repo = join(temporary, "repo"); await mkdir(repo);
execFileSync("git", ["init", "-q"], { cwd: repo });
await writeFile(join(repo, "README.md"), "Native transport probe. No inference.\n");
execFileSync("git", ["add", "."], { cwd: repo });
execFileSync("git", ["-c", "user.name=Probe", "-c", "user.email=probe@localhost", "commit", "-qm", "fixture"], { cwd: repo });
const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { CliTeamsService } = await import("../src/cli-teams/service.js");
const { startCliTeamsTransport } = await import("../src/cli-teams/transport.js");
const { CLI_TOOLS } = await import("../src/cli-teams/tools.js");
const { acquireLock, flushWrites } = await import("../src/store.js");
const release = await acquireLock(0);
const manager = new RunManager(findPattern), service = new CliTeamsService(manager);
await service.load(); const bridge = await startCliTeamsTransport(service);
// The probe uses your real CLI settings, so it never installs there; its temporary repository carries the skill instead.
const skill = await readFile(join(root, "integrations/cli-teams/SKILL.md"), "utf8");
for (const dir of [".claude/skills/codeflow", ".agents/skills/codeflow"]) { await mkdir(join(repo, dir), { recursive: true }); await writeFile(join(repo, dir, "SKILL.md"), skill); }
const capabilityFile = join(temporary, "mcp-capabilities.jsonl"), proxy = join(temporary, "mcp-proxy.mjs");
const serverArgs = ["--import", import.meta.resolve("tsx"), join(root, "src/cli-teams/cli.ts"), "mcp", "--project-root", repo];
// Observe only handshake capabilities, never credentials or tool arguments/results.
await writeFile(proxy, `import {spawn} from 'node:child_process'; import {appendFileSync} from 'node:fs';
const child=spawn(process.execPath,${JSON.stringify(serverArgs)},{stdio:['pipe','inherit','inherit']});
let buffer=''; process.stdin.on('data',chunk=>{child.stdin.write(chunk);buffer+=chunk;let end;while((end=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let m;try{m=JSON.parse(line)}catch{continue}if(m.method==='initialize')appendFileSync(process.env.CODEFLOW_PROBE_CAPABILITIES_FILE,JSON.stringify({protocol:m.params.protocolVersion,elicitation:m.params.capabilities?.elicitation})+'\\n',{mode:0o600});}});
process.stdin.on('end',()=>child.stdin.end());child.on('exit',code=>process.exit(code??1));`);
const executable = { command: process.execPath, args: [proxy], env: { CODEFLOW_HOME: process.env.CODEFLOW_HOME, CODEFLOW_PROBE_CAPABILITIES_FILE: capabilityFile } };
const nativeFormDeclared = async () => { const line = (await readFile(capabilityFile, "utf8")).trim().split("\n").at(-1), capability = JSON.parse(line).elicitation; return !!capability && (Object.hasOwn(capability, "form") || Object.keys(capability).length === 0); };
const children = [];
function protocol(binary, args, control = false, serverRequest) {
  const child = spawn(binary, args, { cwd: repo, env: process.env, detached: true, stdio: ["pipe", "pipe", "pipe"] }); children.push(child);
  let buffer = "", sequence = 0; const pending = new Map();
  let stderr = ""; child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
  child.once("error", () => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("Native host executable could not start")); } pending.clear(); });
  child.once("exit", code => { const line = stderr.split("\n").find(s => /^(?:Error|error):/.test(s)); const detail = line && !/auth|token|secret|password|bearer/i.test(line) ? `: ${line.slice(0, 400)}` : ""; for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`Native host exited before responding (code ${code})${detail}`)); } pending.clear(); });
  child.stdout.on("data", chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (!control && m.method && m.id !== undefined) { const result = serverRequest?.(m); child.stdin.write(JSON.stringify(result ? { id: m.id, result } : { id: m.id, error: { code: -32601, message: "This read-only probe does not grant permissions" } }) + "\n"); continue; }
      const response = control ? m.type === "control_response" ? m.response : undefined : m;
      const key = response?.request_id ?? response?.id, waiter = pending.get(String(key));
      if (waiter) { pending.delete(String(key)); clearTimeout(waiter.timer); response.error || response.subtype === "error" ? waiter.reject(new Error(`Native host rejected ${waiter.method} (${response.error?.code ?? response.subtype})${[-32600, -32602].includes(response.error?.code) ? `: ${String(response.error.message).slice(0, 400)}` : ""}`)) : waiter.resolve(control ? response.response : response.result); }
    }
  });
  return {
    close() { if (child.exitCode === null) { try { process.kill(-child.pid, "SIGTERM"); } catch {} } },
    notify(method, params) { child.stdin.write(JSON.stringify({ method, params }) + "\n"); },
    request(method, params = {}) { return new Promise((resolve, reject) => {
      const id = String(++sequence), timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native capability request timed out: ${method}`)); }, 60000);
      pending.set(id, { resolve, reject, timer, method });
      child.stdin.write(JSON.stringify(control ? { type: "control_request", request_id: id, request: { subtype: method, ...params } } : { id, method, params }) + "\n");
    }); },
  };
}
const results = [];
try {
  try {
    const version = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
    const config = `mcp_servers.codeflow={command=${JSON.stringify(executable.command)},args=${JSON.stringify(executable.args)},env={CODEFLOW_HOME=${JSON.stringify(process.env.CODEFLOW_HOME)},CODEFLOW_PROBE_CAPABILITIES_FILE=${JSON.stringify(capabilityFile)}},enabled=true,startup_timeout_sec=30,tool_timeout_sec=40}`;
    let nativeConfirmations = 0;
    const codex = protocol("codex", ["app-server", "--listen", "stdio://", "-c", config, "-c", "features.hooks=false"], false, m => {
      if (m.method === "mcpServer/elicitation/request") { nativeConfirmations++; return { action: "decline", content: null }; }
    });
    await codex.request("initialize", { clientInfo: { name: "codeflow_native_probe", version: "1" }, capabilities: { experimentalApi: true } }); codex.notify("initialized", {});
    const threadConfig = { "mcp_servers.codeflow": { ...executable, enabled: true, startup_timeout_sec: 30, tool_timeout_sec: 40 }, "features.hooks": false };
    const thread = await codex.request("thread/start", { cwd: repo, ephemeral: true, sandbox: "read-only", approvalPolicy: "on-request", config: threadConfig });
    let status;
    const deadline = Date.now() + 20000;
    do { status = await codex.request("mcpServerStatus/list", { threadId: thread.thread.id, serverName: "codeflow", detail: "full" }); const entry = status.data?.find(s => s.name === "codeflow"); if (entry && Object.keys(entry.tools ?? {}).length) break; await new Promise(r => setTimeout(r, 500)); } while (Date.now() < deadline);
    const server = status.data?.find(s => s.name === "codeflow");
    const tools = Object.keys(server?.tools ?? {});
    const skills = await codex.request("skills/list", { cwds: [repo], forceReload: true });
    const skillFound = skills.data?.some(entry => entry.skills?.some(s => s.name === "codeflow")) === true;
    const formDeclared = await nativeFormDeclared();
    const call = (tool, args) => codex.request("mcpServer/tool/call", { threadId: thread.thread.id, server: "codeflow", tool: `codeflow_${tool}`, arguments: args });
    const proposal = await call("propose_run", { operationId: "native-probe-propose", task: "Read-only native confirmation probe; do not start work", candidate: { scope: "plan", participants: [{ id: "host", provider: "codex", binding: "current_session" }], completion: ["Return a plan"], steps: [{ id: "draft", type: "task", operation: "propose", participant: "host", instructions: "Write a plan" }, { id: "finish", type: "finish", outcome: "plan_ready", inputs: ["draft"] }] } });
    const p = proposal.structuredContent?.data; if (!p) throw new Error("Native proposal probe failed before confirmation");
    const start = await call("start_run", { operationId: "native-probe-start", proposalId: p.proposalId, expectedRevision: p.revision, proposalHash: p.proposalHash });
    const safelyDeclined = start.structuredContent?.error?.code === "acceptance_declined" && manager.list().length === 0;
    results.push({ host: "codex", version, tools: tools.length, runtimeStatus: server?.runtimeStatus, toolsError: server?.toolsError, skillFound, nativeFormDeclared: formDeclared, nativeConfirmations, safelyDeclined, passed: tools.length === CLI_TOOLS.length && skillFound && formDeclared && nativeConfirmations === 1 && safelyDeclined });
    codex.close();
  } catch (e) { results.push({ host: "codex", passed: false, error: e.message }); }
  try {
    const version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
    const config = join(temporary, "claude-mcp.json"); await writeFile(config, JSON.stringify({ mcpServers: { codeflow: executable } }));
    const claude = protocol("claude", ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--mcp-config", config, "--no-chrome", "--settings", '{"disableAllHooks":true,"disableWorkflows":true,"ultracode":false}'], true);
    const init = await claude.request("initialize");
    let server;
    for (let i = 0; i < 30; i++) { const response = await claude.request("mcp_status"); server = response.mcpServers?.find(s => s.name === "codeflow"); if (server?.status === "connected") break; await new Promise(r => setTimeout(r, 500)); }
    const formDeclared = await nativeFormDeclared();
    results.push({ host: "claude", version, status: server?.status ?? "unknown", tools: server?.tools?.length, skills: init.commands?.some(c => c.name === "codeflow"), nativeFormDeclared: formDeclared, passed: server?.status === "connected" && formDeclared });
  } catch (e) { results.push({ host: "claude", passed: false, error: e.message }); }
  console.log(JSON.stringify({ inferenceCalls: 0, results }, null, 2));
  if (results.some(r => !r.passed)) process.exitCode = 1;
} finally {
  for (const child of children) { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
  await manager.shutdown(); await bridge.close(); await flushWrites(); release();
  await rm(temporary, { recursive: true, force: true });
}
