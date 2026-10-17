import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { TeamToolBridge, TEAM_TOOLS, validateTeamToolRequest, type TeamToolConnection } from "../src/team-tools.js";
import { prepareTeamTools } from "../src/adapters/team-tools.js";

const fixture = mkdtempSync(join(tmpdir(), "codeflow-team-tools-test-"));
process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = join(fixture, "home");
process.env.CODEFLOW_TOKEN = "server-token-must-never-reach-agents";
after(() => rmSync(fixture, { recursive: true, force: true }));
const { adapters } = await import("../src/adapters/index.js");
const { adapterTeamCapabilities, TEAM_TOOL_ALLOWLIST } = await import("../src/adapters/team-tools.js");

async function send(connection: TeamToolConnection, body: unknown, extra: Record<string, string> = {}) {
  const response = await fetch(connection.endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${connection.token}`, ...extra }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}

test("member capabilities bind run, member and active attempt; expiry, revocation and user spoofing fail closed", async () => {
  const bridge = new TeamToolBridge();
  const seen: unknown[] = [];
  let active = true;
  const a = await bridge.issue({ identity: { runId: "run-a", memberId: "worker-a", attemptId: "task:1", taskId: "task", attempt: 1 }, isActive: () => active, handler: async (command, identity) => { seen.push(identity); return command.arguments; } });
  const b = await bridge.issue({ identity: { runId: "run-b", memberId: "worker-b", attemptId: "task:1" }, handler: async () => ({}) });
  const command = { name: "send_message", arguments: { operationId: "one", recipient: "worker-b", body: "Build result" } };
  try {
    assert.equal((await send(a.connection, command)).status, 200);
    assert.deepEqual(seen, [{ runId: "run-a", memberId: "worker-a", attemptId: "task:1", taskId: "task", attempt: 1 }]);
    assert.equal((await send({ ...b.connection, token: a.connection.token }, command)).status, 403);
    assert.equal((await send({ ...a.connection, token: "x".repeat(43) }, command)).status, 403);
    assert.equal((await send(a.connection, { ...command, arguments: { ...command.arguments, origin: "user" } })).status, 400);
    assert.equal((await send(a.connection, { ...command, arguments: { ...command.arguments, memberId: "worker-b" } })).status, 400);
    assert.equal((await send(a.connection, command, { origin: "https://untrusted.example" })).status, 403);
    active = false;
    assert.equal((await send(a.connection, command)).status, 403);
    b.revoke();
    assert.equal((await send(b.connection, command)).status, 403);
    const expired = await bridge.issue({ identity: { runId: "run-a", memberId: "worker-a", attemptId: "expired" }, ttlMs: 1, handler: async () => ({}) });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await send(expired.connection, command)).status, 403);
    assert.equal(seen.length, 1);
  } finally { a.revoke(); b.revoke(); await bridge.close(); }
});

test("live command schemas expose prompt-return collaboration without file or authorization powers", () => {
  assert.equal(TEAM_TOOLS.length, 12);
  for (const tool of TEAM_TOOLS) assert.equal(tool.inputSchema.additionalProperties, false);
  assert.match(TEAM_TOOLS.find((tool) => tool.name === "ask_member")!.description, /never waits/);
  assert.throws(() => validateTeamToolRequest({ name: "write_file", arguments: {} }), /Unknown/);
  assert.throws(() => validateTeamToolRequest({ name: "read_memory", arguments: { scope: "private", memberId: "other" } }), /Unexpected/);
  assert.throws(() => validateTeamToolRequest({ name: "write_memory", arguments: { operationId: "1", scope: "project", title: "Policy", body: "Use this" } }), /Invalid/);
  assert.throws(() => validateTeamToolRequest({ name: "read_inbox", arguments: { limit: 500 } }), /Invalid/);
  assert.throws(() => validateTeamToolRequest({ name: "send_message", arguments: { operationId: "1", recipient: "peer" } }), /Missing/);
});

test("temporary tool configuration keeps the capability out of command lines and uses owner-only files", async () => {
  const connection = { endpoint: "http://127.0.0.1:1234/v1/runs/a/members/b/attempts/c", token: "secret", expiresAt: Date.now() + 1_000 };
  const config = await prepareTeamTools(connection);
  const parsed = JSON.parse(readFileSync(config.claudeConfig, "utf8"));
  const credential = parsed.mcpServers.codeflow_team.args.at(-1);
  try {
    assert.equal(statSync(config.claudeConfig).mode & 0o777, 0o600);
    assert.equal(statSync(credential).mode & 0o777, 0o600);
    assert.equal(config.codexConfig.join(" ").includes(connection.token), false);
    assert.equal(readFileSync(config.claudeConfig, "utf8").includes(connection.token), false);
    assert.deepEqual(JSON.parse(readFileSync(credential, "utf8")), connection);
  } finally { await config.cleanup(); }
  assert.equal(existsSync(credential), false);
});

test("malformed JSON-RPC envelopes cannot terminate the scoped MCP client", async () => {
  const config = await prepareTeamTools({ endpoint: "http://127.0.0.1:1234/v1/runs/a/members/b/attempts/c", token: "unused", expiresAt: Date.now() + 10_000 });
  const server = JSON.parse(readFileSync(config.claudeConfig, "utf8")).mcpServers.codeflow_team;
  const child = spawn(server.command, server.args, { stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  const exchange = async (message: unknown) => {
    const next = iterator.next();
    child.stdin.write(`${JSON.stringify(message)}\n`);
    const response = await next;
    assert.equal(response.done, false, "MCP client must stay alive after invalid input");
    return JSON.parse(response.value!) as any;
  };
  try {
    for (const malformed of [null, [], "unexpected", {}, { jsonrpc: "2.0", id: {}, method: "ping" }]) {
      assert.equal((await exchange(malformed)).error.code, -32600);
    }
    assert.equal((await exchange({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })).result.protocolVersion, "2025-03-26");
    assert.deepEqual((await exchange({ jsonrpc: "2.0", id: 2, method: "ping" })).result, {});
  } finally { lines.close(); child.stdin.end(); child.kill(); await config.cleanup(); }
});

test("Claude and both Codex transports call the scoped MCP bridge, keep sandboxes and clean up secrets", async () => {
  const bridge = new TeamToolBridge();
  const commands: unknown[] = [];
  const grant = await bridge.issue({ identity: { runId: "run", memberId: "reader", attemptId: "task:1", taskId: "task", attempt: 1 }, handler: async (command, identity) => { commands.push({ command, identity }); return { accepted: true, operationId: command.arguments.operationId }; } });
  process.env.FAKE_TEAM_TOOL_CALLS = JSON.stringify([{ name: "ask_member", arguments: { operationId: "ask-1", recipient: "peer", body: "Which interface?" } }, { name: "read_memory", arguments: { scope: "private" } }]);
  try {
    for (const [provider, transport] of [["claude", "exec"], ["codex", "exec"], ["codex", "app-server"]] as const) {
      const records = mkdtempSync(join(fixture, `${provider}-${transport}-`));
      process.env.FAKE_RECORD_DIR = records;
      process.env.CODEFLOW_CODEX_TRANSPORT = transport;
      const result = await adapters[provider].run({ prompt: "Inspect only", cwd: fixture, mode: "read", questionProtocol: "structured", teamTools: grant.connection, timeoutMs: 15_000 }, () => {});
      assert.equal(result.ok, true, result.error);
      const record = JSON.parse(readFileSync(join(records, readdirSync(records)[0]!), "utf8"));
      assert.equal(record.teamTools.initialized.result.protocolVersion, "2025-03-26");
      assert.equal(record.teamTools.tools.result.tools.length, 12);
      assert.equal(record.teamTools.results.every((response: any) => !response.result.isError), true);
      assert.equal(JSON.stringify(record).includes(grant.connection.token), false);
      assert.equal(JSON.stringify(record).includes(process.env.CODEFLOW_TOKEN!), false);
      if (provider === "claude") {
        const allow = record.args[record.args.indexOf("--allowedTools") + 1];
        assert.ok(TEAM_TOOL_ALLOWLIST.every((tool) => allow.split(",").includes(tool)));
        assert.ok(record.args.includes("--strict-mcp-config"));
        assert.match(record.args[record.args.indexOf("--disallowedTools") + 1], /Edit,Write,NotebookEdit,Agent,Task/);
        assert.equal(existsSync(record.args[record.args.indexOf("--mcp-config") + 1]), false);
      } else {
        assert.ok(record.args.includes("features.multi_agent=false"));
        assert.ok(record.args.includes("features.multi_agent_v2=false"));
        assert.equal(record.args.some((value: string) => value.includes("network_access=true")), false);
        if (transport === "exec") assert.ok(record.args.includes('sandbox_mode="read-only"'));
        else assert.equal(record.thread.sandbox, "read-only");
      }
    }
    assert.equal(commands.length, 6);
  } finally { delete process.env.FAKE_TEAM_TOOL_CALLS; delete process.env.FAKE_RECORD_DIR; grant.revoke(); await bridge.close(); }
});

test("capability inventory explicitly reports unsupported transports and unknown nested usage", async () => {
  const [claude, codex, agy] = await Promise.all([adapterTeamCapabilities("claude"), adapterTeamCapabilities("codex"), adapterTeamCapabilities("agy")]);
  assert.equal(claude.scopedTools, "tested"); assert.equal(codex.scopedTools, "tested"); assert.equal(agy.scopedTools, "unsupported");
  assert.equal(claude.liveInput, "unsupported"); assert.equal(codex.liveInput, "tested");
  assert.equal(claude.sandbox, "unsupported"); assert.equal(agy.nestedAgentControl, "unknown");
  assert.ok([claude, codex, agy].every((entry) => entry.nestedUsage === "unknown" && entry.version));
});

test("read-only CLI capability probes also withhold the server and inherited member credentials", async () => {
  const { captureOutput } = await import("../src/adapters/process.js");
  process.env.CODEFLOW_TEAM_CAPABILITY = "another-member-secret";
  process.env.CODEFLOW_TEAM_ENDPOINT = "http://127.0.0.1:1234";
  try {
    const result = await captureOutput(process.execPath, ["-e", "console.log(JSON.stringify([process.env.CODEFLOW_TOKEN,process.env.CODEFLOW_TEAM_CAPABILITY,process.env.CODEFLOW_TEAM_ENDPOINT]))"]);
    assert.deepEqual(JSON.parse(result), [null, null, null]);
  } finally { delete process.env.CODEFLOW_TEAM_CAPABILITY; delete process.env.CODEFLOW_TEAM_ENDPOINT; }
});

test("older Claude and unsupported agy keep structured turns working without a live bridge", async () => {
  const bridge = new TeamToolBridge();
  let calls = 0;
  const grant = await bridge.issue({ identity: { runId: "fallback", memberId: "reader", attemptId: "1" }, handler: async () => { calls++; return {}; } });
  try {
    for (const provider of ["claude", "agy"] as const) {
      if (provider === "claude") process.env.FAKE_UNKNOWN_FLAG = "--mcp-config";
      const events: string[] = [];
      const result = await adapters[provider].run({ prompt: "Inspect only", cwd: fixture, mode: "read", questionProtocol: "structured", teamTools: grant.connection, timeoutMs: 15_000 }, (event) => { if (event.kind === "status") events.push(event.text); });
      assert.equal(result.ok, true, result.error);
      assert.ok(events.some((event) => /no verified/.test(event)), "unsupported capability is visible instead of silently promised");
      delete process.env.FAKE_UNKNOWN_FLAG;
    }
    assert.equal(calls, 0);
  } finally { delete process.env.FAKE_UNKNOWN_FLAG; grant.revoke(); await bridge.close(); }
});
