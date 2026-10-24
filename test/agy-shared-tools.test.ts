import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentMcpConfig } from "../src/adapters/agent-tools.js";
import { prepareAgyNativeTools } from "../src/adapters/agy-tools.js";
import { prepareAgyIsolation, agyManagedOptionsProblem } from "../src/adapters/agy-isolation.js";
import { normalizeAgyStructured, managedAgyToolAllowed } from "../src/adapters/agy.js";
import { createRunPermissions, resolveRunPermissions } from "../src/run-permissions.js";
import { AgentToolBridge } from "../src/agent-tools.js";
import { TeamToolBridge, teamMcpConfig } from "../src/team-tools.js";
const connection = { endpoint: "http://127.0.0.1:12345/v1/agent-tools", token: "a".repeat(43), expiresAt: Date.now() + 600000 };

test("Antigravity MCP is limited to the task capability and exact known tool names", () => {
  const config = agentMcpConfig(connection);
  assert.equal(config.serverUrl, "http://127.0.0.1:12345/v1/agent-mcp");
  assert.equal(config.tools.browser_snapshot?.eager, true);
  for (const endpoint of ["https://example.test/tools", "http://localhost:1/v1/agent-tools", "http://127.0.0.1:1/other"]) assert.throws(() => agentMcpConfig({ ...connection, endpoint }));
  assert.throws(() => agentMcpConfig({ ...connection, expiresAt: 0 }));
  for (const name of ["browser_snapshot", "computer_action", "browser_upload_folder", "browser_downloads"]) {
    assert.equal(managedAgyToolAllowed(`mcp_codeflow_agent_${name}`, "write", true), true);
    assert.equal(managedAgyToolAllowed(`mcp_codeflow_agent_${name}`, "write", false), false);
    assert.equal(managedAgyToolAllowed("call_mcp_tool", "write", true, { ServerName: "codeflow_agent", ToolName: name }), true);
  }
  for (const name of ["run_command", "browser_subagent", "invoke_subagent", "mcp_other_browser_snapshot", "mcp_codeflow_agent_shell"]) assert.equal(managedAgyToolAllowed(name, "write", true), false);
  assert.equal(managedAgyToolAllowed("call_mcp_tool", "write", true, { ServerName: "other", ToolName: "browser_snapshot" }), false);
  assert.equal(managedAgyToolAllowed("write_to_file", "read", true), false);
  if (process.platform === "darwin") {
    const permissions = resolveRunPermissions({ policy: createRunPermissions("standard", false, true), provider: "agy", mode: "write", currentTrust: "standard", currentTools: false });
    assert.equal(permissions.externalTools, "task-scoped");
    const opts = { cwd: "/tmp/fixture", prompt: "test", mode: "write" as const, trust: "standard" as const, permissions, agentTools: connection };
    assert.equal(agyManagedOptionsProblem(opts), undefined);
    assert.ok(agyManagedOptionsProblem({ ...opts, permissions: { ...permissions, required: ["no-external-tools"] } }));
    assert.ok(agyManagedOptionsProblem({ ...opts, permissions: { ...permissions, externalTools: "disabled", implementation: "macos-file-only-v1" } }));
  }
});

test("Antigravity live member MCP preserves identities, closed schemas and revocation", async () => {
  const bridge = new TeamToolBridge(), stop = new AbortController();
  const seen: unknown[] = [];
  const grant = await bridge.issue({ identity: { runId: "team", memberId: "worker", attemptId: "attempt" }, signal: stop.signal, handler: async (request, identity) => { seen.push({ request, identity }); return { accepted: true }; } });
  const endpoint = teamMcpConfig(grant.connection).serverUrl;
  const rpc = async (method: string, params: unknown = {}, origin?: string) => { const r = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${grant.connection.token}`, ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); return { status: r.status, body: await r.json() as any }; };
  try {
    assert.match((await rpc("tools/list")).body.error.message, /Initialize/);
    await rpc("initialize", { protocolVersion: "2025-03-26" });
    assert.ok((await rpc("tools/list")).body.result.tools.some((tool: any) => tool.name === "ask_member"));
    assert.equal((await rpc("tools/call", { name: "send_message", arguments: { operationId: "a", recipient: "coordinator", body: "Fixture fact" } })).body.result.isError, undefined);
    assert.equal(seen.length, 1); assert.equal((seen[0] as any).identity.memberId, "worker");
    assert.equal((await rpc("tools/call", { name: "send_message", arguments: { operationId: "a", recipient: "coordinator", body: "Fixture fact", memberId: "other" } })).body.result.isError, true);
    assert.equal((await rpc("tools/list", {}, "http://untrusted.invalid")).status, 403);
    assert.equal(managedAgyToolAllowed("mcp_codeflow_team_send_message", "read", true, {}, true), true);
    assert.equal(managedAgyToolAllowed("mcp_codeflow_team_send_message", "read", true), false);
    stop.abort(); assert.equal((await rpc("tools/list")).status, 403);
  } finally { await bridge.close(); }
});

test("isolated and native profiles register private per-turn tools without editing global settings", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cf-agy-tools-test-")));
  const workspace = join(root, "workspace"), keychains = join(root, "keys"), securityCache = join(root, "cache"), source = join(root, "source");
  for (const path of [workspace, keychains, securityCache, join(source, ".gemini/config")]) await mkdir(path, { recursive: true });
  const securityLock = join(securityCache, "mds.lock"); await writeFile(securityLock, "fixture");
  const original = JSON.stringify({ mcpServers: { original: { command: "fixture" } } });
  await writeFile(join(source, ".gemini/config/mcp_config.json"), original);
  await writeFile(join(source, ".gitconfig"), "fixture");
  const isolated = await prepareAgyIsolation(workspace, "read", { binary: "/bin/bash", keychains, securityCache, securityLock }, connection, true);
  const native = await prepareAgyNativeTools(connection, source);
  try {
    const settings = JSON.parse(await readFile(join(isolated.paths.home, ".gemini/antigravity-cli/settings.json"), "utf8"));
    assert.ok(settings.permissions.allow.includes("mcp(codeflow_agent/browser_snapshot)"));
    for (const denied of ["command(*)", "unsandboxed(*)", "write_file(*)", "read_url(*)"]) assert.ok(settings.permissions.deny.includes(denied));
    assert.ok(settings.permissions.deny.includes(`read_file(${join(isolated.paths.home, ".gemini/config")})`));
    assert.ok(settings.permissions.deny.includes(`read_file(${join(isolated.paths.home, ".gemini/antigravity-cli/settings.json")})`));
    assert.ok(settings.permissions.allow.includes(`read_file(${join(isolated.paths.home, ".gemini/antigravity-cli/brain")})`));
    const config = JSON.parse(await readFile(join(isolated.paths.home, ".gemini/config/mcp_config.json"), "utf8"));
    assert.deepEqual(Object.keys(config.mcpServers), ["codeflow_agent"]);
    const agent = await readFile(join(isolated.paths.home, ".gemini/config/agents/codeflow-isolated.md"), "utf8");
    assert.match(agent, /  - finish/);
    assert.match(agent, /inheritCustomizations: false/); assert.doesNotMatch(agent, /  - (call_mcp_tool|run_command|write_to_file)/);
    const overlay = JSON.parse(await readFile(join(native.home, ".gemini/config/mcp_config.json"), "utf8"));
    assert.ok(overlay.mcpServers.original); assert.ok(overlay.mcpServers.codeflow_agent);
    assert.equal(await realpath(join(native.home, ".gitconfig")), join(source, ".gitconfig"));
  } finally { await isolated.cleanup(); await native.cleanup(); }
  assert.equal(await readFile(join(source, ".gemini/config/mcp_config.json"), "utf8"), original);
  await rm(root, { recursive: true, force: true });
});

test("HTTP MCP uses the same permission checks, lifecycle and call errors as the stdio bridge", async () => {
  const bridge = new AgentToolBridge(), ctl = new AbortController();
  const grant = await bridge.issue({ runId: "agy-mcp", mode: "read", full: false, signal: ctl.signal, active: () => true });
  const endpoint = agentMcpConfig(grant.connection).serverUrl;
  const request = async (body: unknown, origin?: string) => {
    const r = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json; charset=utf-8", Authorization: `Bearer ${grant.connection.token}`, ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, value: r.status === 202 ? undefined : await r.json() as any };
  };
  const rpc = (method: string, params = {}) => request({ jsonrpc: "2.0", id: 1, method, params });
  try {
    assert.match((await rpc("tools/list")).value.error.message, /Initialize/);
    assert.equal((await rpc("initialize", { protocolVersion: "2025-03-26" })).value.result.protocolVersion, "2025-03-26");
    assert.equal((await request({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
    assert.deepEqual((await rpc("resources/list")).value.result, { resources: [] });
    assert.ok((await rpc("tools/list")).value.result.tools.some((tool: any) => tool.name === "browser_upload_folder"));
    for (const [name, args, expected] of [["browser_click", { ref: "e1" }, /read-only/], ["computer_screenshot", {}, /Full access/], ["shell", {}, /Unknown agent tool/]] as const) {
      const result = (await rpc("tools/call", { name, arguments: args })).value.result;
      assert.equal(result.isError, true); assert.match(result.content[0].text, expected);
    }
    assert.equal((await request({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "http://evil.invalid")).status, 403);
    assert.equal((await request(null)).status, 400);
    ctl.abort(); assert.equal((await rpc("tools/list")).status, 403);
  } finally { await bridge.close(); }
});


test("Antigravity structured completion removes only CLI presentation metadata", () => {
  const value = { ready: true, toolAction: "Completing task", toolSummary: "Done", unexpected: "must still fail schema validation" };
  assert.deepEqual(normalizeAgyStructured(value, { properties: { ready: {} } }), { ready: true, unexpected: value.unexpected });
  assert.deepEqual(normalizeAgyStructured(value, { properties: { toolAction: {}, toolSummary: {} } }), value);
  assert.equal(normalizeAgyStructured(value), value);
  assert.equal(managedAgyToolAllowed("list_resources", "read", true), true);
  assert.equal(managedAgyToolAllowed("list_resources", "read", false), false);
});
